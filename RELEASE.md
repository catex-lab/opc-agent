# 发版清单（release checklist）

> 建立于 2026-11-26。原因：之前 tag push 能绕过 CI 直接发版，且没有书面的撤回预案。
> 现在 release workflow 内置了 CI 六步门禁；本文件补上**人工发版前动作**与撤回步骤。

## 为什么有两层

- **CI 六步**（密钥扫描 / `tsc -b` / runhub / uiux-tokens / model-catalog / 更新链路）：
  跑在 CI 与 release workflow 里，保证「clone 下来能编译、核心逻辑对」。
- **`verify:ui` 整链**：**故意不进 CI** —— 它要本机 Chrome 与各 Agent CLI，
  CI runner 上红的是环境不是代码。它是**人工发版前动作**，必须在开发机上跑到 `FULL_EXIT=0`。
  段数会随版本增长，别记数字：`node -e "console.log(require('./package.json').scripts['verify:ui'].split('&&').length)"`。

只过 CI 不过整链就发版 = 拿用户当验收环境，不允许。

## 发版前（人工，按顺序）

1. **工作树干净**：`git status --short` 无输出；`git diff --check` 0。
2. **整链全绿**：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run verify:ui`，确认日志末尾 `FULL_EXIT=0`。
   单段红灯不许靠「单跑就绿」放行——那正是环境抖动的信号，要重跑整链。
3. **版本号四处同版**：`package.json`、`package-lock.json`（顶层 + `packages[""]`）、
   `src/config.ts`、`release-notes/*` 的 `<version>` 必须一致。
4. **CHANGELOG 写好**：本版变化逐条列，别漏（历史教训：DSH 接入 / 模型路由漏记）。
5. **包名与许可**：`gen:third-party` 重跑过（依赖变动时），`verify:license-bundle` 绿。
6. **真包验证**：本地 `verify:package` 与 `verify:exe-icon` 显式传产物路径（不传会打印「跳过」= 假绿）。
7. **关掉在跑的 `OPC Agent.exe`**：单实例锁会让打包拿到被占用的文件。

## 发版（tag 触发）

```bash
# 只 add/commit，停下报 sha 等指令；不擅自 push（协作红线）
git tag vX.Y.Z <sha>
git push origin main          # 先合回 main（tag 可打功能分支，但发完必须合回）
git push origin vX.Y.Z        # tag push 触发 release-update.yml 自动出三件套
```

Release 三件套：`app-<version>.asar`、`OPC-Agent-<version>-x64-full.zip`、`latest.json`（已签名）。
`releases/latest` 必须指向本次 Release——客户端固定读这个地址。

## 发版后

1. 确认 GitHub Release 页面三个附件都在、`latest.json` 的 `version` 正确。
2. 本地装一遍新包，走一遍真实升级（验证更新链而不是只看文件）。
3. `CHANGELOG.md` 与 tag 对齐；功能分支已合回 `main`。

## 撤回预案

发现严重问题时的顺序：

1. **先阻断新用户**：在 Release 页面把有问题的版本标为 pre-release/草稿，
   `latest.json` 回滚到上一个好版本（**重新签名**，私钥在仓库 Secrets `OPC_UPDATE_PRIVATE_KEY`）。
   客户端只读 `releases/latest/download/latest.json`，这一步能立刻止住自动更新。
2. **保留证据**：不要删 Release 附件和 tag——用户可能在报这个问题，删了就无法对账。
3. **修 + 发补丁版**：不复用坏版本号（本地 setup.exe 与线上 tag 会冲突）。走上面的完整清单发 `vX.Y.Z+1`。
4. **必要时 git 层回退**：`git revert <sha>` 生成新提交（**不** `reset --hard`、不 force push），
   再走一遍清单。历史 sha 全部保留，便于追溯。

## 已知限制（不再是待办）

- **安装包未做代码签名**：2026-11-26 决定不购买证书。Windows SmartScreen 会提示「未知发布者」，
  macOS 首次打开需右键 → 打开。更新清单 `latest.json` 仍签名验签，与安装包签名无关。
