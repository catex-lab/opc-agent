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
| `@tencent-ai/agent-sdk` | MIT | 腾讯 CodeBuddy Agent SDK。**注意**：npm 元数据声明 MIT，但包内未随附 LICENSE 文件；它还内嵌了一整套 CodeBuddy CLI（许可声明缺失），见下文「安装包里内嵌的第三方 CLI」 |
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

因此它们被放在 `devDependencies`，**不会被打进安装包** —— 源码仓库可以自由分发，
但发布的安装包里不含这两个包。代价是打包版里 Qoder 走 **CLI 通道**（`qodercli`），
功能正常；只有「只读（plan）模式」需要 SDK 通道，打包版会明确报错而**不会**静默
降级到没有沙箱的 CLI（见 `server/agents/adapters/qoder-sdk.ts` 的降级分支）。

自己从源码构建时 `npm install` 会装上它们，SDK 通道与 plan 模式都可用 ——
**这仍然受 Qoder 服务条款约束，请自行确认你的使用方式符合其条款。**

条款侧的事实（2026-04-29 版全文读过，不是猜的）：通篇**没有出现 "SDK" 或 "CLI"**，
所以不存在针对再分发的专门条款；但 **4.2** 的授权是
`non-transferable, non-sublicensable`（不可转让、不可再许可），**3.2.12** 禁止
「用其服务或输出去开发功能相似的产品」。本项目**不分发**这两个包，因此不涉及再许可；
剩下的只是「我们调用它」这一层 —— 条款既未明示允许也未明示禁止。要一个确定答案的话，
写 <contact@qoder.com>。

## 安装包里内嵌的第三方 CLI

`@tencent-ai/agent-sdk` 不只是一个 SDK —— 它内部塞了整套 **CodeBuddy CLI**
（`cli/`，SDK 运行时会把它当子进程拉起来，路径解析写死在 `lib/utils/cli-resolver.js`）。
这个子包有自己的 `package.json`：

| 字段 | 值 |
|---|---|
| name / version | `@tencent-ai/codebuddy-code` 2.167.0 |
| license | `SEE LICENSE IN README.md` |
| 包里真的有 `README.md` 吗 | **没有** |

也就是说：外层包在 npm 元数据里声明 MIT，内嵌的 CLI 子包自述「许可见 README.md」，
而那个 README 并没有随包发布 —— **许可条款无法从包内查证**。

本项目没有改动它的任何文件，只是原样打包（`electron-builder.yml` 的 `asarUnpack`
把它解出来，因为它要作为子进程执行）。这条如实记在
[THIRD-PARTY-LICENSES.txt](./THIRD-PARTY-LICENSES.txt) 的「内嵌子包」段。

在意这一点的话，有两个办法：

1. 向腾讯（CodeBuddy）索取该子包的许可说明；
2. 不打包内置 CLI —— SDK 支持 `CODEBUDDY_CODE_PATH` 环境变量，且**优先级高于**
   内置 CLI（解析顺序：环境变量 → 内置 `cli/` → monorepo 开发路径）。指向本机
   已装的 `codebuddy` 即可，代价是安装包不再开箱即用。

## 字体与图标

界面不打包字体文件。图标归属见 [TRADEMARKS.md](./TRADEMARKS.md)。
