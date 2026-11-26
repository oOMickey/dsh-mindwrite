# 参与贡献 · Contributing

欢迎提交缺陷、功能建议和修复。较大的功能或界面调整，请先开 Issue 说明写作场景和预期结果。For a substantial feature or UI change, open an issue first so we can discuss the workflow. [Issues](https://github.com/oOMickey/dsh-mindwrite/issues/new/choose)

报告缺陷请附宿主和插件版本、操作系统、复现步骤、预期与实际结果。请用与工作无关的占位文字复现，例如「示例章节」「示例正文」，不要上传真实或仿真的公文内容。截图和日志中请遮住用户名、路径和凭据。Use unrelated placeholders such as “Example chapter” and “Example text.” Keep real or simulated official documents out of reports and attachments. Redact usernames, file paths and credentials from screenshots and logs.

## 开发与检查 / Development

使用 Node.js 24（至少 24.9.0）和 npm 11。本版验证环境为 Node.js 24.22.1 与 npm 11.19.1。Run these commands from the repository root before sending a pull request.

```sh
npm ci
npm run format:check
npm run typecheck
npm run build
npm pack
```

自动化测试在维护者本地运行，暂不随公开仓库提供。Maintainers run the automated tests locally. The public repository currently includes the build and type checks.

构建同时生成第三方声明和 `dist/bundled-dependencies.json`。直接打入成品的包从本地依赖读取许可证。docx 的上游发行入口已包含多层依赖，其版权文本保存在 `scripts/bundled-licenses.json` 中，可离线构建。

When updating docx, rebuild its tagged source with its lockfile. Compare the ESM entry with the one in the published npm archive and list the Rollup modules that contributed code. Check nested browser bundles against their own lockfiles. Update the inventory with the full upstream texts and their sources, then update its SHA-256 in `scripts/licenses.mjs`. The digest covers the UTF-8 output of `JSON.stringify` on the parsed inventory.

## 隔离试装 / Test the package locally

在 POSIX shell 中新建独立的 DSH Web 配置，再试装 0.8.5 安装包。In a POSIX shell, initialize a fresh Web profile and install the archive.

```sh
export DSH_HOME="$(mktemp -d)"
npm exec -- dsh --profile web --dump-config
npm exec -- dsh plugin --profile web add "$PWD/dsh-mindwrite-0.8.5.tgz"
npm exec -- dsh --profile web --dump-config
npm exec -- dsh web --no-open
```

在 Web 界面启用插件并重新加载，绑定一个可写工作区，从右侧边栏打开「导图写作」，检查空稿的四个起步按钮。Enable and reload, attach a writable workspace, and open Mindwrite from the right sidebar, and check the four starting actions.
