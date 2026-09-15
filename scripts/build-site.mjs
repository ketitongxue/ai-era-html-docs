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

function renderIndex(template, tree) {
  if (template.split(startMarker).length !== 2 || template.split(endMarker).length !== 2) {
    throw new Error('index.html must contain exactly one pair of document directory markers')
  }
  const start = template.indexOf(startMarker) + startMarker.length
  const end = template.indexOf(endMarker)
  if (end < start) throw new Error('Document directory markers are out of order')
  const links = tree.map(({ path: documentPath }) => {
    const href = './' + documentPath.split('/').map(encodeURIComponent).join('/')
    const title = documentPath.slice(5).replace(/\.html?$/i, '')
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
  const files = git(rootDir, ['ls-tree', '-rz', '--full-tree', sha]).split('\0').filter(Boolean).map(entry => {
    const [metadata, ...rest] = entry.split('\t')
    const [mode, type, object] = metadata.split(' ')
    return { mode, type, object, path: rest.join('\t') }
  }).filter(isPublicFile)
  for (const file of files) {
    if (/[\\\u0000-\u001f\u007f]/u.test(file.path)) {
      throw new Error(`Public file path contains a backslash or control character: ${JSON.stringify(file.path)}`)
    }
  }
  const tree = files.filter(file => file.path.startsWith('docs/') && /\.html?$/i.test(file.path))
    .map(file => ({ path: file.path, type: 'blob', mode: '100644' }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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
  return { outputDir, directory }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outputDir, directory } = await buildSite()
  console.log(`Built ${directory.tree.length} documents from ${directory.sha} into ${outputDir}`)
}
