import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateCatalog, runHook } from './catalog-check.mjs';

const good = () => ({ title: 'Hooks', category: 'Claude Code', url: 'hooks-guide.html' });
test('valid catalogue and intentionally empty catalogue', () => {
  assert.deepEqual(validateCatalog([good()]), []);
  assert.deepEqual(validateCatalog([]), []);
});
for (const key of ['title', 'category', 'url']) {
  test(`missing ${key}`, () => {
    const item = good(); delete item[key];
    assert.ok(validateCatalog([item]).some(s => s.includes(`.${key}`)));
  });
}
test('invalid root and invalid item', () => {
  assert.ok(validateCatalog(null).length);
  assert.ok(validateCatalog({}).length);
  assert.ok(validateCatalog([null, []]).length === 2);
});
test('whitespace, numeric fields and duplicate URL', () => {
  assert.ok(validateCatalog([{ ...good(), category: '  ' }]).length);
  assert.ok(validateCatalog([{ ...good(), title: 123 }]).length);
  assert.ok(validateCatalog([good(), good()]).some(s => s.includes('重复')));
});
for (const url of ['../secret.html', 'https://example.com/a.html', 'a%2fb.html', 'a.html?q=1', '中文.html']) {
  test(`rejects unsupported basename: ${url}`, () => {
    assert.ok(validateCatalog([{ ...good(), url }]).length);
  });
}
test('hook routing, results, read errors and file remains unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-hook-'));
  try {
    const file = join(root, 'catalog.json');
    const event = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file } };
    assert.equal(runHook(event, root).decision, 'block');
    writeFileSync(file, JSON.stringify([good()]));
    assert.equal(runHook(event, root), null);
    writeFileSync(file, JSON.stringify([{ ...good(), category: '' }]));
    const before = readFileSync(file, 'utf8');
    assert.match(runHook(event, root).reason, /category/);
    assert.equal(runHook({ ...event, tool_name: 'Bash' }, root), null);
    assert.equal(runHook({ ...event, hook_event_name: 'PreToolUse' }, root), null);
    assert.equal(runHook({ ...event, tool_input: { file_path: join(root, 'other.json') } }, root), null);
    assert.throws(() => runHook(event, ''), /缺少/);
    const script = fileURLToPath(new URL('./catalog-check.mjs', import.meta.url));
    const cli = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /category/);
    const hook = spawnSync(process.execPath, [script, '--hook'], {
      encoding: 'utf8', input: JSON.stringify(event), env: { ...process.env, CLAUDE_PROJECT_DIR: root }
    });
    assert.equal(hook.status, 0);
    assert.equal(JSON.parse(hook.stdout).decision, 'block');
    assert.equal(readFileSync(file, 'utf8'), before);
    const malformed = spawnSync(process.execPath, [script, '--hook'], { encoding: 'utf8', input: '{' });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /检查器错误/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
