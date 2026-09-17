import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootFiles = new Set(['.nojekyll', 'CNAME', 'robots.txt', 'favicon.ico', 'favicon.svg'])
const startMarker = '<!-- DOCUMENT_DIRECTORY_START -->'
const endMarker = '<!-- DOCUMENT_DIRECTORY_END -->'

function git(rootDir, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: rootDir, encoding, maxBuffer: 256 * 1024 * 1024 })
}

function isPublicFile(file) {
  if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) return false
  if (rootFiles.has(file.path)) return true
  if (!file.path.startsWith('docs/') && !file.path.startsWith('assets/')) return false
  if (file.path === 'docs/directory.json') return false
  return !file.path.split('/').some(segment => segment.startsWith('.'))
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function pathKey(value) {
  // Reject aliases that would overwrite files on case-insensitive or Unicode-
  // normalizing filesystems while preserving distinct full-width filenames.
  return value.normalize('NFC').toUpperCase().toLowerCase()
}

function validateArticlePath(value) {
  if (typeof value !== 'string' || !value.startsWith('docs/') || !/\.html?$/i.test(value)
    || /[\\\p{Cc}]/u.test(value)
    || value.split('/').some(segment => !segment || segment.startsWith('.'))) {
    throw new Error(`Invalid article rename path: ${JSON.stringify(value)}`)
  }
}

function readArticleRenames(rootDir, committedFiles, publicFiles, tree) {
  const manifestFile = committedFiles.find(file => file.path === 'article-renames.json')
  if (!manifestFile) return []
  if (manifestFile.type !== 'blob' || !['100644', '100755'].includes(manifestFile.mode)) {
    throw new Error('article-renames.json must be a committed regular file')
  }
  let manifest
  try {
    manifest = JSON.parse(git(rootDir, ['cat-file', 'blob', manifestFile.object]))
  } catch (cause) {
    throw new Error('Invalid article-renames.json JSON', { cause })
  }
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.renames)) {
    throw new Error('Invalid article-renames.json schema')
  }
  const canonicalPaths = new Set(tree.map(file => file.path))
  const occupied = new Set([...publicFiles.map(file => file.path), 'index.html', 'docs/directory.json'].map(pathKey))
  const aliases = new Set()
  for (const entry of manifest.renames) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid article rename entry')
    const { oldPath, newPath } = entry
    validateArticlePath(oldPath)
    validateArticlePath(newPath)
    if (!canonicalPaths.has(newPath)) {
      throw new Error(`Article rename target is not a canonical document: ${newPath}`)
    }
    const oldKey = pathKey(oldPath)
    for (const used of [...occupied, ...aliases]) {
      if (oldKey === used || oldKey.startsWith(used + '/') || used.startsWith(oldKey + '/')) {
        throw new Error(`Article rename path conflicts with a published file or another redirect: ${oldPath}`)
      }
    }
    aliases.add(oldKey)
  }
  return manifest.renames
}

function renderArticleRedirect({ oldPath, newPath }) {
  const href = './' + path.posix.relative(path.posix.dirname(oldPath), newPath).split('/').map(encodeURIComponent).join('/')
  const escapedHref = escapeHtml(href)
  const scriptHref = JSON.stringify(href).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <noscript><meta http-equiv="refresh" content="0; url=${escapedHref}"></noscript>
  <link rel="canonical" href="${escapedHref}">
  <title>文章已更名</title>
  <script>
    const destination = new URL(${scriptHref}, window.location.href);
    destination.search = window.location.search;
    destination.hash = window.location.hash;
    window.location.replace(destination.href);
  </script>
</head>
<body><p>文章已更名，<a href="${escapedHref}">继续阅读</a>。</p></body>
</html>
`
}

function renderIndex(template, tree) {
  if (template.split(startMarker).length !== 2 || template.split(endMarker).length !== 2) {
    throw new Error('index.html must contain exactly one pair of document directory markers')
  }
  const start = template.indexOf(startMarker) + startMarker.length
  const end = template.indexOf(endMarker)
  if (end < start) throw new Error('Document directory markers are out of order')
  const links = tree.map(({ path: documentPath }) => {
    const href = './' + documentPath.split('/').map(encodeURIComponent).join('/')
    const title = path.posix.basename(documentPath).replace(/\.html?$/i, '')
    return `      <li><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></li>`
  })
  const status = tree.length ? `共 ${tree.length} 篇文档` : '目前还没有文档，内容正在准备中。'
  return template.slice(0, start) + `\n    <p id="status">${status}</p>\n    <ul id="documents">\n${links.join('\n')}\n    </ul>\n    ` + template.slice(end)
}

export async function buildSite({ rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), revision = 'HEAD' } = {}) {
  const outputDir = path.join(rootDir, '_site')
  const sha = git(rootDir, ['rev-parse', '--verify', `${revision}^{commit}`]).trim()
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('The content revision must resolve to a 40-character commit SHA')
  const generatedAt = new Date(git(rootDir, ['show', '-s', '--format=%cI', sha]).trim()).toISOString()
  const committedFiles = git(rootDir, ['ls-tree', '-rz', '--full-tree', sha]).split('\0').filter(Boolean).map(entry => {
    const [metadata, ...rest] = entry.split('\t')
    const [mode, type, object] = metadata.split(' ')
    return { mode, type, object, path: rest.join('\t') }
  })
  const files = committedFiles.filter(isPublicFile)
  for (const file of files) {
    if (/[\\\u0000-\u001f\u007f]/u.test(file.path)) {
      throw new Error(`Public file path contains a backslash or control character: ${JSON.stringify(file.path)}`)
    }
  }
  const tree = files.filter(file => file.path.startsWith('docs/') && /\.html?$/i.test(file.path))
    .map(file => ({ path: file.path, type: 'blob', mode: '100644' }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const renames = readArticleRenames(rootDir, committedFiles, files, tree)
  const directory = { schemaVersion: 1, sha, generatedAt, truncated: false, tree }
  const templatePath = path.join(rootDir, 'index.html')
  if (!(await lstat(templatePath)).isFile()) throw new Error('index.html must be a regular template file')
  const index = renderIndex(await readFile(templatePath, 'utf8'), tree)

  // Read committed blobs directly. Untracked files, dirty files and filesystem
  // symlinks cannot change the published content or escape its commit identity.
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(path.join(outputDir, 'docs'), { recursive: true })
  for (const file of files) {
    const destination = path.join(outputDir, file.path)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, git(rootDir, ['cat-file', 'blob', file.object], null))
  }
  await writeFile(path.join(outputDir, 'index.html'), index)
  await writeFile(path.join(outputDir, 'docs', 'directory.json'), JSON.stringify(directory, null, 2) + '\n')
  // Redirects exist only in the deployment artifact. Neither the Git tree nor
  // the public directory includes duplicate articles at their former URLs.
  for (const entry of renames) {
    const destination = path.join(outputDir, entry.oldPath)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, renderArticleRedirect(entry))
  }
  return { outputDir, directory, redirectCount: renames.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outputDir, directory } = await buildSite()
  console.log(`Built ${directory.tree.length} documents from ${directory.sha} into ${outputDir}`)
}
