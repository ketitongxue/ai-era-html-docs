# AI 纪元 · HTML 知识库

这里收录 Claude Code、Agent 系统设计与 AI 实践文章。阅读入口：[知识库](https://ketitongxue.github.io/ai-era-html-docs/)。

## 上传文档

1. 打开本仓库的 `docs` 目录，点击 **Add file → Upload files**。
2. 上传 `.html` 或 `.htm` 文档，文件名使用文章 `<title>`（去掉 ` | AI 纪元` 后缀）。图片、CSS、JS 等资源请一起上传，并保持原有相对目录关系。
3. 点击 **Commit changes**，提交到 `main`。
4. 在 **Actions → Publish knowledge library** 查看发布结果。成功后，新增、删除或改名的文章会同时反映在知识库入口和静态目录中。

可按主题建子目录，例如 `docs/agent/入门.html` 和 `docs/agent/images/流程.png`。文档内使用 `images/流程.png` 等相对路径，避免 `/images/...` 根路径或本机文件路径。目录按照文件路径排序，显示文件名中的文章标题，保留 HTML 原始样式和交互。

本仓库及发布的文档公开可见，请勿上传私人资料。正常上传文章无需安装依赖或手工维护目录。

## 按文章标题命名

文件名与文章标题保持一致。标题中的 `/`、`\\`、`:`、`*`、`?`、`"`、`<`、`>`、`|` 转换为全角字符；同目录同标题的不同文章保留原文件名作为括号后缀。目录层级不变，图片与附件仍放在原位置。

本地批量整理使用 Python 3，先检查报告，再应用改名：

```sh
python3 scripts/rename-articles-by-title.py --report /tmp/article-title-renames.json
python3 scripts/rename-articles-by-title.py --apply --report /tmp/article-title-renames.json
```

脚本只处理 Git 已跟踪的文章；新增文件需先按路径 `git add -- docs/主题/文章.html`。它会同步更新仓库内指向这些文章的链接，遇到目标文件冲突时停止。应用后按报告逐一暂存新旧路径，再运行 `python3 scripts/rename-articles-by-title.py --check`。新文章发布前也使用同一规则检查，避免再次出现大量同名条目。

改名后以新 URL 为正式地址。`article-renames.json` 保存已发布文章的新旧路径对应关系；构建仅在 `_site/` 中生成旧 URL 跳转页，保留查询参数和页面锚点。跳转页不进入源码 `docs/`、JSON 目录或首页列表，因此不会重复收录文章。以后再次改名时需同步维护此映射，使所有旧路径直接指向最终文件。

## 目录与发布机制

GitHub Pages 使用 **GitHub Actions** 作为发布源。`main` 更新时，工作流从该次提交读取 `docs/` 中的 HTML 文档及 `docs/`、`assets/` 下的公开配套文件，一次构建并部署：

- `index.html`：包含真实文章链接，关闭 JavaScript 也能阅读目录；访客打开入口时无需请求 GitHub API。
- `docs/directory.json`：供主站读取的同批目录，包含 `schemaVersion`、内容提交 `sha`、该提交的 UTC 时间 `generatedAt`、`truncated: false` 和文章 `tree`。
- 原始文章、图片、样式、脚本与教学附件：保留路径和文件内容。

生成结果只进入 `_site/` 发布产物，不提交回仓库。源码 `index.html` 是目录模板。根目录的构建脚本、测试、Git 数据和隐藏杂项不会发布；文档引用的公开教学脚本和测试附件会保留。符号链接不发布。PR 执行测试和构建，只有 `main` 的推送或手动工作流运行会部署。

维护发布设施时，使用 Node.js 24 运行：

```sh
python3 -m unittest discover -s tests -p 'test_rename_articles_by_title.py'
python3 scripts/rename-articles-by-title.py --check
node --test tests/build-site.test.mjs
node scripts/build-site.mjs
```

本地构建读取 **HEAD 已提交的文章与资源**，并使用工作区的入口模板。未提交的文章修改不会进入产物；`sha` 对应的始终是文章内容提交。预览 `_site/index.html` 可检查目录和相对链接。
