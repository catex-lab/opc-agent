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
| `@tencent-ai/agent-sdk` | MIT（外层） | 腾讯 CodeBuddy Agent SDK。npm 元数据声明 MIT；包内未随附 LICENSE 文件。**其内嵌的 CodeBuddy CLI（`cli/`）随安装包分发**，同目录 `LICENSE` 文件为 MIT 全文，2026-11-23 核实后清单与关于页均按 MIT 标注 —— 见下文「安装包里内嵌的第三方 CLI」 |
| `@anthropic-ai/claude-agent-sdk` | **非开源**（`All rights reserved`） | Claude Code 的官方 SDK。`package.json` 写 `SEE LICENSE IN README.md`，实际 `LICENSE.md` 是「© Anthropic PBC. All rights reserved.」+ 指向商业条款。其平台二进制（`claude-agent-sdk-win32-x64`，内含 `claude.exe`）**不再随安装包分发**，改为首次使用该 Agent 时从 npm 镜像下载（`<dataDir>/vendor/claude/`），见「非开源许可」 |
| `@openai/codex-sdk` | Apache-2.0 | Codex 的官方 SDK，依赖 `@openai/codex` 及其平台二进制（`codex-win32-x64`）。Apache-2.0 允许再分发，署名义务已在清单里履行。平台二进制**不再随安装包分发**，改为按需下载到 `<dataDir>/vendor/codex/` |
| `express` | MIT | 内联后端的 HTTP 框架 |
| `node-pty` | MIT | 终端 PTY |
| `uuid` | MIT | UUID 生成 |
| `typescript` | Apache-2.0 | 运行时需要（`tsx` 执行与类型检查都会用到） |

开发依赖（React / Vite / TDesign / lucide 等）不进安装包，由使用者 `npm install` 自行获取。

## 非开源许可（需注意）

| 包 | 许可 | 是否随安装包分发 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` 0.3.316 | **`© Anthropic PBC. All rights reserved.`** —— `package.json` 的 `license` 字段写的是 `SEE LICENSE IN README.md`，但包内 `LICENSE.md` 的正文就是这一句，并指向 <https://code.claude.com/docs/en/legal-and-compliance> 的商业条款 | **否**（SDK 本体约 4.8MB，2026-11-23 起改用户自装，见下） |
| `@anthropic-ai/claude-agent-sdk-win32-x64` 0.3.316 | 同上 | **否**（`claude.exe` 约 320MB，2026-11-19 起改为按需下载，见下） |

**这是当前唯一一个非开源组件，也是本项目对外分发时最需要自己判断的一处。**

事实部分：Claude Code 的 SDK 与 CLI 由 Anthropic 以「保留所有权利」发布，通过 npm 分发。
`npm install` 时由使用者自己从 npm 取得，属于 Anthropic 发布链条内。

**当前选择（2026-11-23 起）：本体与平台二进制都不随包，真正脱离分发链。**

- 平台二进制（`claude.exe`）：`electron-builder.yml` 的 `files` 排除
  `@anthropic-ai/claude-agent-sdk-win32-x64/**`，由 `vendorComponents.ts` 从 npm 镜像取。
- **SDK 本体**（约 4.8MB）：`files` 排除 `@anthropic-ai/claude-agent-sdk/**`，
  提示用户自己运行 `npm install -g @anthropic-ai/claude-agent-sdk`。应用全程不碰副本、
  不代下载，只在运行时由 `server/agents/claudeSdkLocator.ts` 定位用户已装的那一份。
  探测顺序：`OPC_CLAUDE_SDK_PATH` 环境变量 → `npm root -g` → 常见本地 node_modules；
  找到后按 file:// 绝对路径 import。未安装时 `probe()` 如实报「未安装」并给出安装命令，
  不会假装就绪（有闸门钉住这条，防假绿）。

代价：用户首次用 Claude Agent 前需自己装一次 SDK（一条命令，几秒钟）。收益：应用不再
再分发任何专有副本，法律地位干净。

若你 fork 后准备公开分发二进制，建议先读一遍上面那条商业条款再决定。

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
| name / version | `@tencent-ai/codebuddy-code` 2.184.0 |
| license 字段 | `SEE LICENSE IN README.md` |
| README.md 里有许可条款吗 | **没有**（28 行纯安装说明） |
| 实际许可文件 | **`cli/LICENSE.txt` —— 标准 MIT 全文，Copyright 2023 Tencent Cloud** |

**2026-11-23 核实更正**：此前本文件与许可清单都写「条款无法查证」，那是**错的**。
真相是元数据字段指向 README，而 README 只是安装说明；真正的许可正文在同目录的
`LICENSE.txt`，内容是标准 MIT（"Permission is hereby granted, free of charge..."）。
`cli/**` 在 `asarUnpack` 里，这份 LICENSE.txt **随包分发**。外层 `@tencent-ai/agent-sdk`
也是 MIT。**结论：这一项是 MIT 组件，署名齐全，可以随包，不构成合规风险。**

顺带修了生成器 `gen-third-party.mjs`：此前它只读 package.json 的 license 字段，
误把该组件标成 `SEE LICENSE IN README.md`；现在遇到「字段指向的文件无许可正文」时
会回退扫描同目录 LICENSE* 文件、从正文推断真实许可（本例推断为 MIT），并在清单里
如实注明这个偏差来源。

**随包现状**：`asarUnpack` 把 `cli/**` 放到 `app.asar.unpacked`（它要 spawn 同目录的
vendor 可执行文件，asar 内路径 spawn 不了），`bootstrap.cjs` 按
「包内 → PATH → 常见目录」的顺序探测并注入 `CODEBUDDY_CODE_PATH`。代价是安装包 +约 109MB。
历史上（2026-10-30）曾因「条款无法查证」把它排除过一天，实测打包版 WorkBuddy 恒为
「未安装」（本机 PATH 与常见目录都没有 `codebuddy`），开发态却正常 —— 典型的
「dev 能用、装完不能用」。既然已确认是 MIT，这个排除理由不再成立。

## 字体与图标

界面不打包字体文件。图标归属见 [TRADEMARKS.md](./TRADEMARKS.md)。
