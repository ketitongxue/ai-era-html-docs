import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Original teaching example: validates metadata, not article quality or permissions.
export function validateCatalog(data) {
  if (!Array.isArray(data)) return ['根节点必须是数组'];
  const errors = [];
  const seen = new Set();
  data.forEach((item, i) => {
    const at = `items[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} 必须是对象`);
      return;
    }
    for (const key of ['title', 'category', 'url']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) {
        errors.push(`${at}.${key} 必须是非空字符串`);
      }
    }
    if (typeof item.url === 'string') {
      // This demo deliberately allows one ASCII basename only, not arbitrary URLs.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(item.url)) {
        errors.push(`${at}.url 必须是小写英文/数字/连字符组成的 HTML 文件名`);
      }
      if (seen.has(item.url)) errors.push(`${at}.url 重复`);
      seen.add(item.url);
    }
  });
  return errors;
}

function checkFile(file) {
  try {
    return validateCatalog(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return ['catalog.json 不可读取或不是有效 JSON；请单独检查文件'];
  }
}

export function runHook(event, root) {
  if (event?.hook_event_name !== 'PostToolUse' ||
      !['Write', 'Edit'].includes(event.tool_name)) return null;
  if (!root || typeof event.tool_input?.file_path !== 'string') {
    throw new Error('缺少项目根目录或文件路径，检查器未完成');
  }
  const target = resolve(root, 'catalog.json');
  if (resolve(root, event.tool_input.file_path) !== target) return null;
  const errors = checkFile(target);
  return errors.length ? {
    decision: 'block',
    reason: `目录检查失败（文件已经写入，并未回滚）：\n${errors.join('\n')}`
  } : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--hook') {
      const output = runHook(JSON.parse(readFileSync(0, 'utf8')), process.env.CLAUDE_PROJECT_DIR);
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } else {
      if (!process.argv[2]) throw new Error('用法：node catalog-check.mjs catalog.json');
      const errors = checkFile(resolve(process.argv[2]));
      if (errors.length) {
        process.stderr.write(`${errors.join('\n')}\n`);
        process.exitCode = 1;
      } else process.stdout.write('目录检查通过\n');
    }
  } catch (error) {
    process.stderr.write(`检查器错误：${error.message}\n`);
    process.exitCode = 1;
  }
}
