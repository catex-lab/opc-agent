# 第三方依赖许可

本项目的**自身源码**采用 [MIT 许可](./LICENSE)。下面这些第三方包**不在** MIT 范围内，
各自适用自己的条款。

## 完整清单

随安装包分发的第三方组件（`dependencies` 的完整生产依赖树 + Electron 运行时）逐个列出，
见 [THIRD-PARTY-LICENSES.txt](./THIRD-PARTY-LICENSES.txt) —— 每个组件带许可类型与版权行。

该文件由 `node scripts/gen-third-party.mjs` 从 `node_modules` 生成，**不要手工编辑**：
依赖变动后重跑即可，`--check` 模式可校验是否过期。数量与分布以清单文件为准。

## 安装包里怎么看

「设置 → 关于与隐私 → 第三方许可」列出了随包分发的主要组件及其许可与版权人。

这一块不是装饰。MIT 与 Apache-2.0 都要求「分发副本时保留版权与许可声明」，
而 `electron-builder.yml` 为了减小包体，把依赖里的 `LICENSE` 文件全排除了
（`!**/{...,LICENSE,LICENSE.md}`）—— 声明不能跟着一起消失，所以补在应用内。

## 直接依赖一览

| 包 | 许可 | 说明 |
|---|---|---|
| `electron` | MIT | 桌面壳。运行时内含 Chromium 及其依赖，完整声明见 Electron 发行包内的 `LICENSES.chromium.html` |
| `@tencent-ai/agent-sdk` | MIT（外层） | 腾讯 CodeBuddy Agent SDK。npm 元数据声明 MIT；包内未随附 LICENSE 文件。**其内嵌的 CodeBuddy CLI（`cli/`）随安装包分发**，许可条款无法从包内查证 —— 见下文「安装包里内嵌的第三方 CLI」 |
| `@anthropic-ai/claude-agent-sdk` | **非开源**（`All rights reserved`） | Claude Code 的官方 SDK。`package.json` 写 `SEE LICENSE IN README.md`，实际 `LICENSE.md` 是「© Anthropic PBC. All rights reserved.」+ 指向商业条款。**其平台二进制（`claude-agent-sdk-win32-x64`，内含 `claude.exe`）随安装包分发**，见「非开源许可」 |
| `@openai/codex-sdk` | Apache-2.0 | Codex 的官方 SDK，依赖 `@openai/codex` 及其平台二进制（`codex-win32-x64`）。Apache-2.0 允许再分发，署名义务已在清单里履行 |
| `express` | MIT | 内联后端的 HTTP 框架 |
| `node-pty` | MIT | 终端 PTY |
| `uuid` | MIT | UUID 生成 |
| `typescript` | Apache-2.0 | 运行时需要（`tsx` 执行与类型检查都会用到） |

开发依赖（React / Vite / TDesign / lucide 等）不进安装包，由使用者 `npm install` 自行获取。

## 非开源许可（需注意）

| 包 | 许可 | 是否随安装包分发 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` 0.3.316 | **`© Anthropic PBC. All rights reserved.`** —— `package.json` 的 `license` 字段写的是 `SEE LICENSE IN README.md`，但包内 `LICENSE.md` 的正文就是这一句，并指向 <https://code.claude.com/docs/en/legal-and-compliance> 的商业条款 | **是**（SDK 本体约 4.8MB） |
| `@anthropic-ai/claude-agent-sdk-win32-x64` 0.3.316 | 同上 | **是**（内含 `claude.exe`，约 320MB） |

**这是当前唯一一个非开源组件，也是本项目对外分发时最需要自己判断的一处。**

事实部分：Claude Code 的 SDK 与 CLI 由 Anthropic 以「保留所有权利」发布，通过 npm 分发。
`npm install` 时由使用者自己从 npm 取得，属于 Anthropic 发布链条内；
本项目把它连同 `claude.exe` 一起打进自己的安装包，等于**再分发其副本**。

因此有两条路线，代码两条都支持，区别只在打包配置：

- **当前选择（2026-10-31）**：随包分发，开箱即用。`package.json` 的 `dependencies` 里有它，
  `electron-builder.yml` 未排除，`verify:a156-claude-sdk` 断言平台二进制可被解析到。
- **保守选择**：从 `files` 里排除 `node_modules/@anthropic-ai/claude-agent-sdk*/**`，
  改为运行时由用户自行安装（`npm i @anthropic-ai/claude-agent-sdk` 或装 Claude Code CLI）。
  适配器已经按「动态 import + 缺失时给出安装提示」写，排除后表现为「未安装」而不是崩溃。

若你 fork 后准备公开分发二进制，建议先读一遍上面那条商业条款再决定走哪条。

### 已移除：Qoder SDK 通道（2026-10-30）

`@qoder-ai/qoder-agent-sdk` 与 `@qodercn-ai/qodercn-agent-sdk` 使用
**Qoder Product Service Terms**，不是开源许可。因条款未明示允许第三方客户端集成其 SDK，
本项目已**完全移除**这两个包与对应适配器，Qoder 只走 **CLI 通道**
（`qodercli` / `qoderclicn`），由用户自行安装，我们不分发其 SDK。

条款侧的事实（2026-04-29 版全文读过，不是猜的）：通篇**没有出现 "SDK" 或 "CLI"**，
所以不存在针对再分发的专门条款；但 **4.2** 的授权是
`non-transferable, non-sublicensable`（不可转让、不可再许可），**3.2.12** 禁止
「用其服务或输出去开发功能相似的产品」。本项目**不分发**这两个包，因此不涉及再许可。

## 安装包里内嵌的第三方 CLI

`@tencent-ai/agent-sdk` 内部带了整套 **CodeBuddy CLI**（`cli/`，SDK 运行时会
把它当子进程拉起来）。这个子包有自己的 `package.json`：

| 字段 | 值 |
|---|---|
| name / version | `@tencent-ai/codebuddy-code` 2.167.0 |
| license | `SEE LICENSE IN README.md` |
| 包里真的有 `README.md` 吗 | **没有** |

也就是说：外层包在 npm 元数据里声明 MIT，内嵌的 CLI 子包自述「许可见 README.md」，
而那个 README 并没有随包发布 —— **许可条款无法从包内查证**。

**2026-10-31 现状：随安装包分发。** `electron-builder.yml` 把它从安装包里**排除过一天**
（理由就是上面那句「条款无法查证」），但实测后果是：打包版里 WorkBuddy 恒为「未安装」
（本机 PATH 与常见目录都没有 `codebuddy`），而开发态因为 `node_modules` 里有这份 `cli/`
所以正常 —— 典型的「dev 能用、装完不能用」。

于是改回随包分发：`asarUnpack` 把 `cli/**` 放到 `app.asar.unpacked`（它要 spawn 同目录的
vendor 可执行文件，asar 内路径 spawn 不了），`bootstrap.cjs` 按
「包内 → PATH → 常见目录」的顺序探测并注入 `CODEBUDDY_CODE_PATH`。代价是安装包 +约 109MB。

**残余风险（fork 者需自己判断）**：这份 `cli/` 的许可条款**无法从包内查证**，
再分发它同样属于「分发第三方副本」。保守做法与上面 Claude SDK 相同 ——
从 `files` 里排除 `node_modules/@tencent-ai/agent-sdk/cli/**`，让用户自己装 `codebuddy` CLI；
排除后 WorkBuddy 显示「未安装」并给安装提示，不会崩溃。

## 字体与图标

界面不打包字体文件。图标归属见 [TRADEMARKS.md](./TRADEMARKS.md)。
