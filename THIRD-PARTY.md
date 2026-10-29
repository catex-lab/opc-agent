# 第三方依赖许可

本项目的**自身源码**采用 [MIT 许可](./LICENSE)。下表是它依赖的第三方包及其许可，
这些包**不在** MIT 范围内，各自适用自己的条款。

版本以 `package.json` 声明为准；下表按许可类型归类，不逐个列全（完整清单随时可由
`npm ls` 或 `node_modules/*/package.json` 得到）。

## 宽松开源许可（与本项目兼容）

| 许可 | 数量 | 代表包 |
|---|---|---|
| MIT | 27 | `electron`、`react`、`express`、`vite`、`tdesign-react`、`@tencent-ai/agent-sdk`、`node-pty` |
| Apache-2.0 | 3 | `typescript`、`less`、`playwright-core` |
| ISC | 1 | `lucide-react` |

这三类许可都允许商用、修改与再分发，保留各自的版权与许可声明即可。本项目不分发它们的源码副本
（依赖由使用者通过 `npm install` 自行获取），因此不额外附带许可全文。

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

自己从源码构建时 `npm install` 会装上它们，SDK 通道与 plan 模式都可用。

## 字体与图标

界面不打包字体文件。图标归属见 [TRADEMARKS.md](./TRADEMARKS.md)。
