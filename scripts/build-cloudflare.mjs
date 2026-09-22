import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { buildSite } from './stage-knowledge.mjs'

const result = await buildSite()
for (const file of ['_headers', '_redirects']) {
  await copyFile(new URL(`../deploy/${file}`, import.meta.url), path.join(result.output, file))
}
console.log(JSON.stringify({
  revision: result.revision,
  generatedAt: result.generatedAt,
  articles: result.articleCount,
  files: result.fileCount,
  bytes: result.bytes,
  output: result.output,
}, null, 2))
