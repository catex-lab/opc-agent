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
| `@tencent-ai/agent-sdk` | MIT | 腾讯 CodeBuddy Agent SDK。npm 元数据声明 MIT；包内未随附 LICENSE 文件。**注意**：其内嵌的 CodeBuddy CLI（`cli/`）因许可声明缺失，已从安装包排除，改由用户自行安装 |
| `express` | MIT | 内联后端的 HTTP 框架 |
| `node-pty` | MIT | 终端 PTY |
| `uuid` | MIT | UUID 生成 |
| `typescript` | Apache-2.0 | 运行时需要（`tsx` 执行与类型检查都会用到） |

开发依赖（React / Vite / TDesign / lucide 等）不进安装包，由使用者 `npm install` 自行获取。

## 非开源许可（需注意）

| 包 | 许可 |
|---|---|
| `@qoder-ai/qoder-agent-sdk` | Qoder Product Service Terms（见包内 `LICENSE`） |
| `@qodercn-ai/qodercn-agent-sdk` | Qoder Product Service Terms（见包内 `LICENSE`） |

这两个包是 Qoder 官方 SDK，**不是开源许可**，使用受
<https://qoder.com/product-service> 约束。

**2026-10-30 更新**：因条款未明示允许第三方客户端集成其 SDK，本项目已**完全移除**
Qoder SDK 通道（`adapters/qoder-sdk.ts` 已删除，`definitions.ts` 中的 `sdk` 规格已移除，
`package.json` 中的两个 devDependencies 已删除）。现在 Qoder 只走 **CLI 通道**
（`qodercli` / `qoderclicn`），由用户自行安装，我们不分发其 SDK。

条款侧的事实（2026-04-29 版全文读过，不是猜的）：通篇**没有出现 "SDK" 或 "CLI"**，
所以不存在针对再分发的专门条款；但 **4.2** 的授权是
`non-transferable, non-sublicensable`（不可转让、不可再许可），**3.2.12** 禁止
「用其服务或输出去开发功能相似的产品」。本项目**不分发**这两个包，因此不涉及再许可。

## 安装包里内嵌的第三方 CLI

`@tencent-ai/agent-sdk` 内部曾经塞了整套 **CodeBuddy CLI**（`cli/`，SDK 运行时会
把它当子进程拉起来）。这个子包有自己的 `package.json`：

| 字段 | 值 |
|---|---|
| name / version | `@tencent-ai/codebuddy-code` 2.167.0 |
| license | `SEE LICENSE IN README.md` |
| 包里真的有 `README.md` 吗 | **没有** |

也就是说：外层包在 npm 元数据里声明 MIT，内嵌的 CLI 子包自述「许可见 README.md」，
而那个 README 并没有随包发布 —— **许可条款无法从包内查证**。

**2026-10-30 已解决**：`electron-builder.yml` 已把 `node_modules/@tencent-ai/agent-sdk/cli/**`
从安装包排除；`bootstrap.cjs` 会在启动时探测本机 `codebuddy` 并注入
`CODEBUDDY_CODE_PATH`（SDK 优先读取该环境变量）。未检测到 CLI 时，WorkBuddy 的
探测状态会显示「未安装」并给出安装提示，而不是崩溃。

## 字体与图标

界面不打包字体文件。图标归属见 [TRADEMARKS.md](./TRADEMARKS.md)。
