import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stageKnowledge, buildSite } from './stage-knowledge.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const special = "docs/中文 space/引号 ' $() ; # %.html";
const originalArticle = Buffer.from('<!doctype html>\r\n<h1>中文 original</h1>\n');
const originalImage = Buffer.from([0, 1, 2, 10, 13, 127, 128, 255]);
const stableDate = '2026-09-20T08:09:10+08:00';
function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: stableDate, GIT_COMMITTER_DATE: stableDate } }).trim();
}
async function put(root, filename, data) {
  await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  await writeFile(path.join(root, filename), data);
}
async function fixture(t, { manifest = true } = {}) {
  const temp = await mkdtemp(path.join(base, 'fixture-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'repository');
  await mkdir(source);
  git(source, 'init', '-q');
  git(source, 'config', 'user.name', 'Staging Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  await put(source, 'index.html', '<!doctype html><title>Home</title>');
  await put(source, special, originalArticle);
  await put(source, 'docs/Zebra.html', '<p>Second article</p>');
  await put(source, 'assets/picture.png', originalImage);
  await put(source, 'README.md', 'Private operational notes excluded by whitelist');
  await put(source, '.env', 'NOT_A_REAL_CREDENTIAL=fixture');
  await put(source, 'private/secret.html', 'Excluded private fixture');
  await put(source, 'docs/.DS_Store', 'metadata');
  await put(source, 'docs/.private/hidden.html', 'hidden document');
  await put(source, 'assets/.cache/file.bin', 'hidden asset');
  await symlink('../private/secret.html', path.join(source, 'docs/linked.html'));
  await symlink('../private', path.join(source, 'assets/linked-directory'));
  if (manifest) await put(source, 'docs/directory.json', '{"sha":"stale","private":"must be regenerated"}');
  git(source, 'add', '--', 'index.html', 'docs', 'assets', 'README.md', '.env', 'private');
  git(source, 'commit', '-qm', 'Fixture snapshot');
  const commit = git(source, 'rev-parse', 'HEAD');
  return { temp, source, commit };
}
async function walk(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const filename = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, filename));
    else files.push(filename);
  }
  return files.sort();
}

test('stages the exact selected commit while preserving binary and UTF-8 bytes despite newer and dirty changes', async t => {
  const { temp, source, commit } = await fixture(t);
  await put(source, special, 'New committed article');
  git(source, 'add', '--', special);
  git(source, 'commit', '-qm', 'Newer revision');
  await put(source, special, 'Uncommitted article');
  await put(source, 'assets/picture.png', Buffer.from('Uncommitted image'));
  await put(source, 'docs/unpublished.html', 'Untracked draft');
  const before = git(source, 'status', '--porcelain=v1', '-uall');
  const output = path.join(temp, 'site');
  const inventoryFile = path.join(temp, 'inventory.json');
  const inventory = await stageKnowledge({ source, output, revision: commit, inventoryFile });
  assert.deepEqual(await readFile(path.join(output, special)), originalArticle);
  assert.deepEqual(await readFile(path.join(output, 'assets/picture.png')), originalImage);
  assert.equal(inventory.revision, commit);
  assert.equal(inventory.fileCount, 5);
  assert.equal(inventory.articleCount, 2);
  assert.equal(git(source, 'status', '--porcelain=v1', '-uall'), before);
  assert.deepEqual(await readFile(path.join(source, special)), Buffer.from('Uncommitted article'));
  assert.deepEqual(JSON.parse(await readFile(inventoryFile, 'utf8')), inventory);
  for (const file of inventory.files) {
    const bytes = await readFile(path.join(output, file.path));
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(inventory.bytes, inventory.files.reduce((total, file) => total + file.bytes, 0));
});

test('excludes hidden files, private paths, untracked files, file symlinks and directory symlinks', async t => {
  const { temp, source } = await fixture(t);
  await put(source, 'docs/untracked.html', 'never published');
  await put(source, 'assets/untracked.png', 'never published');
  const output = path.join(temp, 'site');
  const inventory = await stageKnowledge({ source, output });
  const expected = ['index.html', special, 'docs/Zebra.html', 'docs/directory.json', 'assets/picture.png'].sort();
  assert.deepEqual(await walk(output), expected);
  assert.deepEqual(inventory.files.map(file => file.path), expected);
  assert.ok(inventory.files.every(file => !file.path.includes('linked')));
});

test('regenerates deterministic sorted manifest with selected full SHA and commit time, never wall clock or stale SHA', async t => {
  const { temp, source, commit } = await fixture(t);
  const first = await stageKnowledge({ source, output: path.join(temp, 'first') });
  const second = await stageKnowledge({ source, output: path.join(temp, 'second') });
  const one = await readFile(path.join(first.output, 'docs/directory.json'));
  const two = await readFile(path.join(second.output, 'docs/directory.json'));
  assert.deepEqual(one, two);
  const manifest = JSON.parse(one);
  assert.deepEqual(manifest, {
    schemaVersion: 1, sha: commit, generatedAt: '2026-09-20T00:09:10.000Z',
    tree: ['docs/Zebra.html', special].map(filename => ({ path: filename, type: 'blob', mode: '100644' })),
    truncated: false,
  });
  assert.deepEqual(first.files, second.files);
  assert.equal(first.files.filter(file => file.generated).length, 1);
});

test('creates the manifest even when the selected commit has none', async t => {
  const { temp, source, commit } = await fixture(t, { manifest: false });
  const inventory = await stageKnowledge({ source, output: path.join(temp, 'site') });
  const manifest = JSON.parse(await readFile(path.join(inventory.output, 'docs/directory.json')));
  assert.equal(manifest.sha, commit);
  assert.equal(inventory.fileCount, 5);
});

test('normalizes executable articles to the public manifest mode and supports htm paths', async t => {
  const { temp, source } = await fixture(t);
  await put(source, 'docs/Legacy.htm', '<p>Legacy article</p>');
  git(source, 'add', '--', 'docs/Legacy.htm');
  git(source, 'update-index', '--chmod=+x', 'docs/Legacy.htm');
  git(source, 'commit', '-qm', 'Executable article fixture');
  const inventory = await stageKnowledge({ source, output: path.join(temp, 'site') });
  const manifest = JSON.parse(await readFile(path.join(inventory.output, 'docs/directory.json')));
  assert.equal(manifest.tree.find(entry => entry.path === 'docs/Legacy.htm').mode, '100644');
  assert.equal(manifest.tree.length, 3);
});

test('fails before publishing filenames that the directory reader cannot accept', async t => {
  const { temp, source } = await fixture(t);
  await put(source, 'docs/invalid\nname.html', '<p>Invalid filename</p>');
  git(source, 'add', '--', 'docs');
  git(source, 'commit', '-qm', 'Control character fixture');
  const output = path.join(temp, 'site');
  await assert.rejects(stageKnowledge({ source, output }), /control characters/);
  await assert.rejects(access(output), { code: 'ENOENT' });
});

test('refuses writes inside the repository, replacement of existing output, and inventory inside staged site', async t => {
  const { temp, source } = await fixture(t);
  await assert.rejects(stageKnowledge({ source, output: path.join(source, 'stage') }), /outside the source repository/);
  const existing = path.join(temp, 'existing');
  await mkdir(existing);
  await put(existing, 'retain.txt', 'retained');
  await assert.rejects(stageKnowledge({ source, output: existing }), /must not already exist/);
  assert.equal(await readFile(path.join(existing, 'retain.txt'), 'utf8'), 'retained');
  await assert.rejects(stageKnowledge({ source, output: path.join(temp, 'site'), inventoryFile: path.join(source, 'inventory.json') }), /outside the source repository/);
  await assert.rejects(stageKnowledge({ source, output: path.join(temp, 'site'), inventoryFile: path.join(temp, 'site') }), /outside the source repository and staged site/);
});

test('invalid revisions fail without creating a staging artifact or modifying the source', async t => {
  const { temp, source } = await fixture(t);
  const before = git(source, 'status', '--porcelain=v1', '-uall');
  const output = path.join(temp, 'site');
  await assert.rejects(stageKnowledge({ source, output, revision: '--help' }), /git rev-parse failed/);
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.deepEqual((await readdir(temp)).sort(), ['repository']);
  assert.equal(git(source, 'status', '--porcelain=v1', '-uall'), before);
});


test('buildSite can repeatably rebuild only an ignored, untracked top-level _site', async t => {
  const { source, commit } = await fixture(t);
  await assert.rejects(buildSite({ repoDir: source }), /excluded by .gitignore/);
  await put(source, '.gitignore', '_site/\n');
  const first = await buildSite({ repoDir: source });
  await put(first.output, 'obsolete.html', 'removed during the next build');
  const second = await buildSite({ repoDir: source });
  assert.deepEqual(first.files, second.files);
  assert.equal(second.revision, commit);
  assert.equal(second.fileCount, 5);
  await assert.rejects(access(path.join(second.output, 'obsolete.html')), { code: 'ENOENT' });
  await assert.rejects(buildSite({ repoDir: source, revision: 'does-not-exist' }), /git rev-parse failed/);
  assert.equal((await walk(second.output)).length, 5, 'failed build preserves existing site');
  git(source, 'add', '-f', '--', '_site/index.html');
  await assert.rejects(buildSite({ repoDir: source }), /must not contain Git-tracked files/);
  assert.equal((await walk(second.output)).length, 5, 'tracking guard preserves existing site');
});
