import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildSite } from '../scripts/build-site.mjs'

const template = await readFile(new URL('../index.html', import.meta.url), 'utf8')

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
