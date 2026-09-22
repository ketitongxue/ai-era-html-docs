#!/usr/bin/env node
/** Stage committed public knowledge files without changing the source repository. */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function git(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`);
  return result.stdout;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function newDestination(value, label, allowExistingDirectory = false) {
  const absolute = path.resolve(value);
  const parent = await realpath(path.dirname(absolute));
  const resolved = path.join(parent, path.basename(absolute));
  try {
    const stat = await lstat(resolved);
    if (!allowExistingDirectory || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must not already exist: ${resolved}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolved;
}

function publicPath(filename) {
  if (/[\u0000-\u001f\u007f]/.test(filename)) throw new Error('Public filenames must not contain control characters');
  const segments = filename.split('/');
  if (segments.some(segment => !segment || segment === '..' || segment.startsWith('.') || segment.includes('\\'))) return false;
  return filename === 'index.html' || filename.startsWith('docs/') || filename.startsWith('assets/');
}

function entriesAt(source, revision) {
  const bytes = git(source, ['ls-tree', '-r', '-z', '--full-tree', revision, '--', 'index.html', 'docs', 'assets']);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Public paths must use valid UTF-8 filenames');
  return text.split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const filename = record.slice(tab + 1);
    if (tab < 0) throw new Error('Malformed git ls-tree output');
    return { mode, type, oid, path: filename };
  }).filter(entry => entry.type === 'blob' && /^(100644|100755)$/.test(entry.mode) && publicPath(entry.path))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function copyBlob(source, entry, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const digest = createHash('sha256');
  let bytes = 0;
  let stderr = '';
  const child = spawn('git', ['-C', source, 'cat-file', 'blob', entry.oid], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { if (stderr.length < 4096) stderr += data.toString(); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`git cat-file failed for ${entry.path}: ${stderr.trim()}`)));
  });
  const counter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; digest.update(chunk); callback(null, chunk); } });
  try {
    await Promise.all([completion, pipeline(child.stdout, counter, createWriteStream(destination, { flags: 'wx', mode: 0o644 }))]);
  } catch (error) {
    child.kill();
    throw error;
  }
  return { path: entry.path, bytes, sha256: digest.digest('hex'), gitBlob: entry.oid, generated: false };
}

/** output and inventoryFile must be new paths whose parents already exist. */
export async function stageKnowledge({ source, output, revision = 'HEAD', inventoryFile, repositorySite = false } = {}) {
  if (!source || !output) throw new Error('source and output are required');
  const sourceRoot = await realpath(git(await realpath(source), ['rev-parse', '--show-toplevel']).toString('utf8').trim());
  const outputRoot = await newDestination(output, 'Output', repositorySite);
  const inRepository = inside(sourceRoot, outputRoot);
  if (inside(outputRoot, sourceRoot) || (inRepository && (!repositorySite || path.relative(sourceRoot, outputRoot) !== '_site'))) throw new Error('Output must be outside the source repository, except explicitly enabled _site');
  if (repositorySite && !inRepository) throw new Error('Repeatable repository output is limited to the top-level _site directory');
  const inventoryPath = inventoryFile ? await newDestination(inventoryFile, 'Inventory') : null;
  if (inventoryPath && (inside(sourceRoot, inventoryPath) || inside(outputRoot, inventoryPath))) throw new Error('Inventory must be outside the source repository and staged site');
  const commit = git(sourceRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).toString('utf8').trim();
  if (repositorySite) {
    const ignored = spawnSync('git', ['-C', sourceRoot, 'check-ignore', '--quiet', '--no-index', '_site/']);
    if (ignored.status !== 0) throw new Error('Repository _site must be excluded by .gitignore before building');
    if (git(sourceRoot, ['ls-files', '-z', '--', '_site']).length || git(sourceRoot, ['ls-tree', '-r', '-z', commit, '--', '_site']).length) throw new Error('Repository _site must not contain Git-tracked files');
  }
  const timestamp = git(sourceRoot, ['show', '-s', '--format=%cI', commit]).toString('utf8').trim();
  const generatedAt = new Date(timestamp).toISOString();
  const entries = entriesAt(sourceRoot, commit);
  if (!entries.some(entry => entry.path === 'index.html')) throw new Error('Revision must contain a regular public index.html');
  const articles = entries.filter(entry => entry.path.startsWith('docs/') && /\.html?$/i.test(entry.path));
  if (!articles.length) throw new Error('Revision must contain at least one regular docs/**/*.html article');
  const manifest = {
    schemaVersion: 1, sha: commit, generatedAt,
    tree: articles.map(entry => ({ path: entry.path, type: 'blob', mode: '100644' })),
    truncated: false,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const temporary = await mkdtemp(path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}-staging-`));
  let installed = false;
  try {
    const files = [];
    for (const entry of entries) {
      if (entry.path === 'docs/directory.json') continue;
      files.push(await copyBlob(sourceRoot, entry, path.join(temporary, entry.path)));
    }
    await mkdir(path.join(temporary, 'docs'), { recursive: true });
    await writeFile(path.join(temporary, 'docs/directory.json'), manifestBytes, { flag: 'wx' });
    files.push({ path: 'docs/directory.json', bytes: manifestBytes.length, sha256: createHash('sha256').update(manifestBytes).digest('hex'), gitBlob: null, generated: true });
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const inventory = { schemaVersion: 1, source: sourceRoot, revision: commit, generatedAt, output: outputRoot, articleCount: articles.length, fileCount: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0), files };
    // All reads use resolved Git object IDs. A changing or dirty worktree never enters the stage.
    if (repositorySite) await rm(outputRoot, { recursive: true, force: true });
    await rename(temporary, outputRoot);
    installed = true;
    if (inventoryPath) await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
    return inventory;
  } catch (error) {
    // Only remove the fresh directory created by this invocation.
    await rm(installed ? outputRoot : temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function buildSite({ repoDir = process.cwd(), outDir, revision = 'HEAD', inventoryFile } = {}) {
  const root = await realpath(git(await realpath(repoDir), ['rev-parse', '--show-toplevel']).toString('utf8').trim());
  const output = path.resolve(outDir ?? path.join(root, '_site'));
  return stageKnowledge({ source: root, output, revision, inventoryFile, repositorySite: output === path.join(root, '_site') });
}

function parseArgs(args) {
  const options = {};
  const names = { '--source': 'source', '--output': 'output', '--revision': 'revision', '--inventory': 'inventoryFile' };
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]];
    if (!name || args[i + 1] === undefined || args[i + 1].startsWith('--') || options[name] !== undefined) throw new Error('Usage: node stage-knowledge.mjs --source REPO --output NEW_DIR [--revision REF] [--inventory NEW_JSON]');
    options[name] = args[i + 1];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await buildSite({ repoDir: args.source, outDir: args.output, revision: args.revision, inventoryFile: args.inventoryFile });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Knowledge staging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
