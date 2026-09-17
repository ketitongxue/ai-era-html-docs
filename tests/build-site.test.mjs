import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildSite } from '../scripts/build-site.mjs'

const template = await readFile(new URL('../index.html', import.meta.url), 'utf8')

test('article title migration tools and committed filenames pass the publishing checks', () => {
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const options = { cwd: rootDir, encoding: 'utf8', stdio: 'pipe' }
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_rename_articles_by_title.py'], options)
  execFileSync('python3', ['scripts/rename-articles-by-title.py', '--check'], options)
})

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-build-test-'))
  t.after(() => rm(rootDir, { recursive: true, force: true }))
  function git(...args) {
    return execFileSync('git', [
      '-c', 'user.name=Directory test', '-c', 'user.email=directory-test@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.excludesFile=/dev/null', ...args,
    ], {
      cwd: rootDir, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-15T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-15T10:00:00Z' },
    }).trim()
  }
  async function put(name, content) {
    const target = path.join(rootDir, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  function commit() {
    git('add', '--all')
    git('commit', '--quiet', '-m', 'Fixture content')
    return git('rev-parse', 'HEAD')
  }
  async function build(expectedPaths) {
    const result = await buildSite({ rootDir })
    const json = await readFile(path.join(result.outputDir, 'docs/directory.json'), 'utf8')
    const index = await readFile(path.join(result.outputDir, 'index.html'), 'utf8')
    const data = JSON.parse(json)
    assert.deepEqual(data, result.directory)
    assert.equal(data.schemaVersion, 1)
    assert.equal(data.sha, git('rev-parse', 'HEAD'))
    assert.equal(data.generatedAt, '2026-09-15T10:00:00.000Z')
    assert.equal(data.truncated, false)
    assert.deepEqual(data.tree.map(item => item.path).sort(), [...expectedPaths].sort())
    assert.ok(data.tree.every(item => item.type === 'blob' && item.mode === '100644'))
    const linkedPaths = [...index.matchAll(/<li><a href="\.\/([^"]+)">/g)]
      .map(match => decodeURIComponent(match[1].replaceAll('&#39;', "'")))
    assert.deepEqual(linkedPaths, data.tree.map(item => item.path))
    assert.doesNotMatch(index, /api\.github\.com|fetch\(|<script\b/)
    return { ...result, json, index }
  }
  git('init', '--quiet')
  await put('index.html', template)
  await put('.gitignore', '_site/\n')
  await put('.nojekyll', '')
  return { rootDir, put, git, commit, build }
}

test('new, renamed, deleted and empty article sets update HTML and JSON together', async t => {
  const f = await fixture(t)
  await f.put('docs/第一篇.html', '<h1>第一篇</h1>')
  f.commit()
  const first = await f.build(['docs/第一篇.html'])
  assert.match(first.index, /共 1 篇文档/)

  await f.put('docs/专题/第二篇.htm', '<h1>第二篇</h1>')
  f.commit()
  const added = await f.build(['docs/第一篇.html', 'docs/专题/第二篇.htm'])
  assert.notEqual(first.directory.sha, added.directory.sha)

  await rename(path.join(f.rootDir, 'docs/第一篇.html'), path.join(f.rootDir, 'docs/改名后.HTML'))
  f.commit()
  await f.build(['docs/改名后.HTML', 'docs/专题/第二篇.htm'])
  await assert.rejects(readFile(path.join(f.rootDir, '_site/docs/第一篇.html')), { code: 'ENOENT' })

  await rm(path.join(f.rootDir, 'docs/专题/第二篇.htm'))
  f.commit()
  await f.build(['docs/改名后.HTML'])
  await assert.rejects(readFile(path.join(f.rootDir, '_site/docs/专题/第二篇.htm')), { code: 'ENOENT' })

  await rm(path.join(f.rootDir, 'docs/改名后.HTML'))
  f.commit()
  const empty = await f.build([])
  assert.match(empty.index, /目前还没有文档，内容正在准备中。/)
})

test('special characters in article titles are escaped and URLs round-trip', async t => {
  const f = await fixture(t)
  const title = 'docs/学习 & "<tag>" #?\'%.HTML'
  await f.put(title, '<p>article</p>')
  f.commit()
  const result = await f.build([title])
  assert.ok(result.index.includes('学习 &amp; &quot;&lt;tag&gt;&quot; #?&#39;%'))
  assert.ok(result.index.includes('%23%3F&#39;%25.HTML'))
  assert.doesNotMatch(result.index, /<tag>/)
  assert.equal(await readFile(path.join(result.outputDir, title), 'utf8'), '<p>article</p>')
})

test('only committed public files are copied, resources stay byte-identical, and links cannot escape', async t => {
  const f = await fixture(t)
  const article = '<link rel="stylesheet" href="../assets/style.css"><img src="images/picture.png">'
  const picture = Buffer.from([0, 1, 2, 128, 255])
  await f.put('docs/article.html', article)
  await f.put('assets/style.css', 'body { color: red }')
  await f.put('docs/images/picture.png', picture)
  await f.put('docs/assets/example.test.mjs', 'export const teachingAttachment = true\n')
  for (const name of ['scripts/private.mjs', 'tests/private.test.mjs', 'README.md', '.DS_Store', 'docs/.DS_Store', 'docs/.hidden/private.html']) {
    await f.put(name, 'not a public resource')
  }
  await f.put('docs/directory.json', '{"outdated":true}')
  await symlink(os.tmpdir(), path.join(f.rootDir, 'docs/external-directory'))
  await symlink(path.join(f.rootDir, 'README.md'), path.join(f.rootDir, 'docs/external.html'))
  f.commit()
  await f.put('docs/untracked.html', '<p>not committed</p>')
  await f.put('docs/article.html', '<p>dirty contents</p>')
  await f.put('_site/stale.html', '<p>old deployment</p>')
  const built = await f.build(['docs/article.html'])
  assert.equal(await readFile(path.join(built.outputDir, 'docs/article.html'), 'utf8'), article)
  assert.equal(await readFile(path.join(built.outputDir, 'assets/style.css'), 'utf8'), 'body { color: red }')
  assert.deepEqual(await readFile(path.join(built.outputDir, 'docs/images/picture.png')), picture)
  assert.equal(await readFile(path.join(built.outputDir, 'docs/assets/example.test.mjs'), 'utf8'), 'export const teachingAttachment = true\n')
  assert.equal(await readFile(path.join(built.outputDir, '.nojekyll'), 'utf8'), '')
  for (const name of ['scripts/private.mjs', 'tests/private.test.mjs', 'README.md', '.git/config', '.DS_Store', 'docs/.DS_Store', 'docs/.hidden/private.html', 'docs/external-directory', 'docs/external.html', 'docs/untracked.html', 'stale.html']) {
    await assert.rejects(readFile(path.join(built.outputDir, name)), { code: 'ENOENT' }, name)
  }
  const rebuilt = await f.build(['docs/article.html'])
  assert.equal(rebuilt.json, built.json)
  assert.equal(rebuilt.index, built.index)
})

test('missing or duplicated template markers fail the build', async t => {
  const f = await fixture(t)
  f.commit()
  await f.put('index.html', template.replace('<!-- DOCUMENT_DIRECTORY_START -->', ''))
  await assert.rejects(buildSite({ rootDir: f.rootDir }), /exactly one pair/)
  await f.put('index.html', template + '<!-- DOCUMENT_DIRECTORY_START -->')
  await assert.rejects(buildSite({ rootDir: f.rootDir }), /exactly one pair/)
})

test('paths unsupported by the main-site directory consumer cannot be published', async t => {
  for (const filename of ['docs/back\\slash.html', 'docs/line\nbreak.html', 'docs/tab\tname.htm']) {
    await t.test(JSON.stringify(filename), async child => {
      const f = await fixture(child)
      await f.put(filename, '<p>invalid path</p>')
      f.commit()
      await assert.rejects(buildSite({ rootDir: f.rootDir }), /backslash or control character/)
    })
  }
})

test('renamed articles retain old URLs without entering the directory twice', async t => {
  const f = await fixture(t)
  const oldPath = 'docs/旧目录/旧文章.html'
  const newPath = 'docs/新目录/新标题 & #?\'%.html'
  const article = '<h1>新标题</h1>'
  await f.put(oldPath, article)
  f.commit()
  await mkdir(path.dirname(path.join(f.rootDir, newPath)), { recursive: true })
  await rename(path.join(f.rootDir, oldPath), path.join(f.rootDir, newPath))
  await f.put('article-renames.json', JSON.stringify({ schemaVersion: 1, renames: [{ oldPath, newPath }] }))
  f.commit()

  const built = await f.build([newPath])
  assert.equal(built.redirectCount, 1)
  assert.match(built.index, /共 1 篇文档/)
  assert.doesNotMatch(built.index, /旧文章|旧目录|新目录\//)
  assert.equal(await readFile(path.join(built.outputDir, newPath), 'utf8'), article)
  await assert.rejects(readFile(path.join(built.outputDir, 'article-renames.json')), { code: 'ENOENT' })
  const redirect = await readFile(path.join(built.outputDir, oldPath), 'utf8')
  const href = './' + path.posix.relative(path.posix.dirname(oldPath), newPath).split('/').map(encodeURIComponent).join('/')
  const escapedHref = href.replaceAll("'", '&#39;')
  assert.ok(redirect.includes(`<link rel="canonical" href="${escapedHref}">`))
  assert.ok(redirect.includes(`<noscript><meta http-equiv="refresh" content="0; url=${escapedHref}"></noscript>`))
  assert.ok(redirect.includes(`<a href="${escapedHref}">继续阅读</a>`))
  assert.match(redirect, /<meta name="robots" content="noindex">/)

  const script = redirect.match(/<script>([\s\S]*?)<\/script>/)[1]
  const oldUrl = new URL('https://ketitongxue.github.io/ai-era-html-docs/' + oldPath.split('/').map(encodeURIComponent).join('/') + '?source=old%20link&lang=zh#标题')
  let replacedUrl
  runInNewContext(script, {
    URL,
    window: { location: { href: oldUrl.href, search: oldUrl.search, hash: oldUrl.hash, replace(value) { replacedUrl = value } } },
  })
  const expected = new URL(href, oldUrl)
  expected.search = oldUrl.search
  expected.hash = oldUrl.hash
  assert.equal(replacedUrl, expected.href)
  assert.equal(decodeURIComponent(new URL(replacedUrl).pathname), '/ai-era-html-docs/' + newPath)
})

test('redirect manifests are read only from the selected committed revision', async t => {
  const f = await fixture(t)
  await f.put('docs/new.html', '<p>new</p>')
  const withoutManifest = f.commit()
  const manifest = { schemaVersion: 1, renames: [{ oldPath: 'docs/old.html', newPath: 'docs/new.html' }] }
  await f.put('article-renames.json', JSON.stringify(manifest))
  const untracked = await f.build(['docs/new.html'])
  assert.equal(untracked.redirectCount, 0)
  await assert.rejects(readFile(path.join(untracked.outputDir, 'docs/old.html')), { code: 'ENOENT' })

  f.commit()
  await f.put('article-renames.json', 'invalid dirty manifest')
  const committed = await f.build(['docs/new.html'])
  assert.equal(committed.redirectCount, 1)
  assert.match(await readFile(path.join(committed.outputDir, 'docs/old.html'), 'utf8'), /文章已更名/)
  const historical = await buildSite({ rootDir: f.rootDir, revision: withoutManifest })
  assert.equal(historical.directory.sha, withoutManifest)
  assert.equal(historical.redirectCount, 0)
  await assert.rejects(readFile(path.join(historical.outputDir, 'docs/old.html')), { code: 'ENOENT' })
})

test('full-width filename replacements remain distinct from old ASCII filenames', async t => {
  const f = await fixture(t)
  const oldPath = 'docs/05 | Etcd集群.html'
  const newPath = 'docs/05 ｜ Etcd集群.html'
  await f.put(newPath, '<p>canonical article</p>')
  await f.put('article-renames.json', JSON.stringify({ schemaVersion: 1, renames: [{ oldPath, newPath }] }))
  f.commit()
  const built = await f.build([newPath])
  assert.equal(built.redirectCount, 1)
  assert.equal(await readFile(path.join(built.outputDir, newPath), 'utf8'), '<p>canonical article</p>')
  assert.match(await readFile(path.join(built.outputDir, oldPath), 'utf8'), /文章已更名/)
})

test('invalid redirects fail before replacing an existing build', async t => {
  const valid = { oldPath: 'docs/old.html', newPath: 'docs/new.html' }
  const cases = [
    ['malformed JSON', '{', /Invalid article-renames.json JSON/],
    ['wrong schema', JSON.stringify({ schemaVersion: 2, renames: [] }), /schema/],
    ['non-array map', JSON.stringify({ schemaVersion: 1, renames: {} }), /schema/],
    ['null entry', [null], /entry/],
    ['missing target', [{ ...valid, newPath: 'docs/missing.html' }], /not a canonical document/],
    ['case-mismatched target', [{ ...valid, newPath: 'docs/NEW.html' }], /not a canonical document/],
    ['self redirect', [{ oldPath: valid.newPath, newPath: valid.newPath }], /conflicts/],
    ['existing article', [{ ...valid, oldPath: 'docs/keep.html' }], /conflicts/],
    ['existing resource parent', [{ ...valid, oldPath: 'docs/image.png/old.html' }], /conflicts/],
    ['existing resource child', [{ ...valid, oldPath: 'docs/folder.html' }], /conflicts/],
    ['generated directory parent', [{ ...valid, oldPath: 'docs/directory.json/old.html' }], /conflicts/],
    ['duplicate alias', [valid, valid], /conflicts/],
    ['case duplicate alias', [valid, { ...valid, oldPath: 'docs/OLD.HTML' }], /conflicts/],
    ['Unicode duplicate alias', [{ ...valid, oldPath: 'docs/Café.html' }, { ...valid, oldPath: 'docs/Cafe\u0301.html' }], /conflicts/],
    ['Unicode existing resource', [{ ...valid, oldPath: 'docs/Cafe\u0301.png/old.html' }], /conflicts/],
    ['alias parent conflict', [valid, { ...valid, oldPath: 'docs/old.html/nested.html' }], /conflicts/],
    ['redirect chain', [{ oldPath: 'docs/start.html', newPath: 'docs/old.html' }, valid], /not a canonical document/],
    ['redirect cycle', [{ oldPath: 'docs/a.html', newPath: 'docs/b.html' }, { oldPath: 'docs/b.html', newPath: 'docs/a.html' }], /not a canonical document/],
  ]
  for (const invalidPath of [undefined, 42, '/docs/old.html', 'assets/old.html', 'docs/../old.html', 'docs/./old.html', 'docs//old.html', 'docs/.hidden/old.html', 'docs/old.txt', 'docs/back\\slash.html', 'docs/line\nbreak.html', 'docs/control\u0085.html']) {
    cases.push([`invalid old path ${JSON.stringify(invalidPath)}`, [{ ...valid, oldPath: invalidPath }], /Invalid article rename path/])
    cases.push([`invalid new path ${JSON.stringify(invalidPath)}`, [{ ...valid, newPath: invalidPath }], /Invalid article rename path/])
  }
  for (const [name, input, error] of cases) {
    await t.test(name, async child => {
      const f = await fixture(child)
      await f.put('docs/new.html', '<p>new</p>')
      await f.put('docs/keep.html', '<p>keep</p>')
      await f.put('docs/image.png', 'image bytes')
      await f.put('docs/Café.png', 'image bytes')
      await f.put('docs/folder.html/image.png', 'image bytes')
      await f.put('article-renames.json', typeof input === 'string' ? input : JSON.stringify({ schemaVersion: 1, renames: input }))
      f.commit()
      await f.put('_site/previous-build.txt', 'preserve until validated')
      await assert.rejects(buildSite({ rootDir: f.rootDir }), error)
      assert.equal(await readFile(path.join(f.rootDir, '_site/previous-build.txt'), 'utf8'), 'preserve until validated')
    })
  }
})

test('a committed symlink cannot supply a redirect manifest', async t => {
  const f = await fixture(t)
  await f.put('docs/new.html', '<p>new</p>')
  await f.put('actual-map.json', JSON.stringify({ schemaVersion: 1, renames: [] }))
  await symlink('actual-map.json', path.join(f.rootDir, 'article-renames.json'))
  f.commit()
  await assert.rejects(buildSite({ rootDir: f.rootDir }), /must be a committed regular file/)
})
