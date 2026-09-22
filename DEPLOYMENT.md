# 知识库的 Cloudflare 发布

公开阅读入口是 `https://knowledge.juzxailab.com/`，由 `ai-era-knowledge` Worker 的 Static Assets 提供。GitHub 保存源码；读者加载目录、HTML 和图片时不需要连接 GitHub。原 GitHub Pages 地址可继续保留。

## 发布内容

构建只读取指定 Git 提交中的 `index.html`、`docs/` 和 `assets/`。隐藏文件、符号链接、未提交或未跟踪的文件不进入发布产物。文章和图片保留原始字节及相对路径，`docs/directory.json` 按该提交重新生成，包含提交 SHA 和提交时间。

`_site/` 是可重新生成的发布目录；不要手工在其中维护文件。`deploy/_headers` 和 `deploy/_redirects` 是 Cloudflare 响应配置，构建时复制进去。仓库根目录、脚本、README 和本地配置不会整体发布。

## 本地检查

使用 Node.js 22：

```sh
npm ci
npm test
npm run build
npx wrangler deploy --dry-run
npx wrangler dev
```

因为内容取自 Git 提交，预览新文章前需要先将本次公开内容提交到分支；本地尚未提交的正文不会被误发布。构建可以重复执行。

## 自动部署与手动部署

在 Cloudflare Workers Builds 将 `ketitongxue/ai-era-html-docs` 的 `main` 分支连接到 `ai-era-knowledge`。构建命令使用 `npm test && npm run build`，部署命令使用 `npx wrangler deploy`，根目录为 `/`。Cloudflare 管理部署凭据，不在仓库保存密钥。

连接完成后，合并或推送到 `main` 会触发独立的知识库部署，不需要重新部署主站。文章、图片和目录随同一次静态资源部署一起生效。

如果设置页提示项目已与 Git 帐户断开，先在 **设置 → 构建 → Git 存储库 → 管理** 中重新授权 Cloudflare Workers and Pages，并确认 GitHub App 的仓库访问权限包含 `ketitongxue/ai-era-html-docs`。恢复连接后，再推送一次 `main` 提交确认构建记录出现新的提交 SHA。

已登录 Wrangler 的维护者也可执行 `npm run deploy`。发布后检查 Cloudflare 构建状态、线上目录 SHA，以及新文章和图片；GitHub Pages 发布成功不代表 Cloudflare 已部署成功。

## 路由与回滚

保留 `.html` URL；根路径在 Cloudflare 内部映射到 `/index.html`。不存在的文件返回 404。目录禁止浏览器缓存，其他资源每次重新验证，避免旧图片或正文被长期保留。

主站通过 `/api/knowledge/tree` 获取此站的 `docs/directory.json`，文章在独立域名 iframe 中打开；不要改成与管理后台同源的任意 HTML 执行环境。

出现发布问题时，在 Cloudflare 回滚 `ai-era-knowledge` 到前一版本，让正文、图片和目录一起恢复；然后修复源码重新发布。验收应包含屏蔽 `github.com`、`github.io`、`githubusercontent.com` 后打开目录、文章、图片和文章内相对链接。引用 GitHub 项目的外链仍需要读者自身能访问对应网站。
