# OPC Agent 开发指南

面向要改这个仓库的人。**本文档会滞后，代码不会** —— 冲突时以代码为准，改完顺手回来订正这里。

## 〇、代码里的 `A107` / `A151` 是什么

源码注释、脚本名、闸门输出里到处是这种编号（全仓约 980 处）。它们是**本项目开发过程中的工作项编号**，不是 GitHub issue，也不指向任何公开看板 —— 你在 issue 列表里搜不到。

每个编号对应一次完整的「需求 → 实现 → 验证」闭环，绝大多数能在 `scripts/` 里找到同名闸门（`A151` → `scripts/verify-a151-model-source.mjs`）。所以读到一条带编号的注释时：

- **想知道它当时要求什么**：看同名脚本的文件头注释，那里通常抄了原始需求与实测证据。
- **想知道它现在还算不算数**：跑那条 `npm run verify:a151`。绿了才算约束仍然成立。
- **改到了它管的东西**：先跑闸门再改代码。这些注释记录的是「踩过一次的坑」，不是风格偏好。

保留编号而不改写成自然语言，是因为删掉出处后，那些约束就变成没有依据的断言，下一个人只能靠猜。

## 一、三层结构

```
electron/  ──►  主进程（窗口 / 托盘 / CDP / 终端 / 更新）
   │              构建产物：dist-electron/bootstrap.cjs
   │
   ├─ server/  ──►  后端（Express），构建时**内联**进主进程，不开独立端口对外
   │                打包后整份代码在 dist-electron/main.cjs 里
   │
   └─ src/     ──►  渲染进程（React），构建产物 dist/
```

为什么后端内联：桌面应用不该额外起一个用户能访问的 HTTP 服务。开发态 `npm run dev` 才分开跑（前端 5173，后端 3000，vite 代理转发）。

`shared/` 是前后端共用层：类型、事件协议、权限枚举。**改协议先改这里**，两边都会立刻报错，这是刻意的。

## 二、关键模块

### 后端 `server/`

| 文件 | 职责 |
|---|---|
| `index.ts` | 路由注册与启动 |
| `db.ts` | SQLite 建表、迁移、CRUD。**所有 schema 变更都在这里** |
| `run-hub.ts` | 运行中枢：管理所有在跑的 turn，负责停止与续传 |
| `turn-runner.ts` | 单轮执行：调 Agent、转发事件、落库 |
| `orchestrator.ts` | 多 Agent 编排（群聊分派） |
| `agents/registry.ts` | Agent 注册表，实例化 16 条定义 |
| `agents/definitions.ts` | **16 条 Agent 接入定义**（命令名、参数、能力） |
| `agents/probe.ts` | 在 `PATH` 与约定目录里找可执行文件 |
| `agents/accountProbe.ts` | 账号与权益：**只读**本机各 Agent 自己的登录态（ZCode 的加密信封不解、Codex 只解 `id_token` 的 payload），不代登录、不外发 |
| `agents/sdkRuntime.ts` | SDK 通道公共件：动态 `import` + 缺包时的可读提示（缺包只让该 Agent 显示「未安装」） |
| `agents/adapters/*-sdk.ts` | 官方 SDK 适配器（WorkBuddy / Claude / Codex）：SDK 自带平台二进制，不依赖 `PATH` |
| `avatar-store.ts` / `avatar-file.ts` | 头像与 Agent Logo 的本地图片仓库：内容哈希命名、服务端嗅探文件头校验 |
| `agents/permission-gate.ts` | 权限判定，越权拦截 |
| `preferences.ts` | 偏好读写（主题、栏宽等） |
| `memory.ts` | 四层记忆读写 |
| `file-evidence.ts` | 验证闭环：真的去跑命令再回报 |

### 前端 `src/`

| 文件 | 职责 |
|---|---|
| `hooks/useChat.ts` | 对话核心。**并发控制在这里**，见下文 |
| `hooks/useSessions.ts` | 会话列表与当前会话 |
| `hooks/useAgents.ts` | Agent 列表与状态 |
| `hooks/useTheme.ts` | 明暗主题，设 `root.style.colorScheme` |
| `index.css` | 设计令牌与全局样式。**几何只在这一处定义** |
| `components/` | 界面组件 |

### 主进程 `electron/`

`main.ts` 建窗口与 IPC，`cdp.ts` 做浏览器调试附着，`terminal.ts` 包 `node-pty`，`preload.cjs` 暴露受限 API，`close-policy.ts` 决定关闭窗口是退出 / 收进托盘 / 先问（与设置页读同一份偏好）。

## 三、数据库

`node:sqlite`（Node 22 内置），**不是 better-sqlite3**。数据库文件默认 `./data/chat.db`，可用 `OPC_DATA_DIR` 覆盖。

表：`sessions` / `messages` / `verifications` / `projects` / `project_tasks` / `agent_capabilities` / `agent_capability_probes`。

加字段的固定四步，漏一步就会「刷新后回默认」：

1. `db.ts` 建表列 + `ensureColumn` 迁移
2. `updateSession` 里加**逐字段 `if` 分支**（这张表不是泛型拼 SET）
3. 路由 `POST`/`PATCH` 认这个字段，非法值返回 400，**不静默纠正**
4. `useSessions` 把行映射成前端字段（漏一行 = 刷新后回默认）

`updateSession` 的语义：`undefined` = 不动，`null` = 清空。路由侧必须写 `if ('x' in req.body)`，不能用真值判断。

## 四、加一个 Agent

改 `server/agents/definitions.ts`，加一条定义：

```ts
{
  id: 'my-agent',
  name: 'My Agent',
  cli: 'my-agent-cli',        // PATH 里的命令名
  args: [...],
  capabilities: [...],
  binExts: ['.cjs'],          // 可选：非标准扩展名
  extraPaths: ['~/path'],     // 可选：额外查找目录
}
```

`registry.ts` 的构造函数遍历 `AGENT_DEFS` 自动实例化，`probeAll()` 也按 `providers.keys()` 走 —— 所以**加进定义就自动被发现**，不用改别处。

探测是**白名单**，只认写死的命令名。名单外的 CLI 不会被自动发现（刻意的：`PATH` 里同名脚本常是 IDE 的图形启动器，转发链会误判成 CLI）。

## 五、事件协议

一轮对话的流式事件（见 `shared/`）：

```
run_start → block_* (多次) → [permission_request → 用户答复] → run_end
```

断线重连走 `/api/runs/:id/stream?after=<seq>`，按 `seq` 续上，不重放已产出的块。

块模型在 `shared/blocks.ts`。**加一种新块类型要同时改三处**：类型定义、服务端投影（`agents/projector.ts`）、前端渲染。

## 六、并发控制

`useChat.ts` 是**每会话一轮**：`turnsRef: Map<sessionId, Turn>`，`isLoading` 由「当前会话在不在这个 Map 里」派生。

不要退回全局布尔 + 单值句柄 —— 那会让「A 在回复」变成「B 发不出去」，而且停止键会停错人。凡是「正在跑的 X」，都要先问一句**属于谁**。

## 七、验证

不是单元测试，是**在真实界面里断言可观测行为**：Playwright 驱动本机 Chrome 打开真实页面，用真实鼠标坐标点击并用 `elementFromPoint` 自证命中。

```bash
npm run verify:ui      # 主链，串行跑 70+ 段
npm run verify:logo    # 图标资产一致性
npm run verify:package # 打包产物逐字节核对
```

写断言的三条纪律：

1. **否定式必须配肯定式** —— 只钉「这里没有 X」时，「整个删掉」比「改对了」更容易变绿
2. **正则别跑在整块文本上** —— 注释里的字、`-webkit-` 前缀子串都会满足断言。扫源码先剥 `/* */`
3. **修完要做反向探针** —— 把实现退回坏版本重跑，确认新断言真的变红

## 八、打包

```bash
npm run build           # 前端 + 主进程
npm run electron:build  # 出安装包
```

Windows 上两个必须注意的点：

- **`CODEBUDDY_SAFE_DELETE_ENABLED=0`** —— 构建要清 `dist`，默认走回收站会因 shim 超时卡在 `emptyDir`
- **构建放后台跑** —— 前端约 2.5 分钟、打包约 4.5 分钟，前台管道会被 2 分钟超时掐掉

打包前先关掉正在运行的 `OPC Agent.exe`（单实例锁会挡住文件替换）。

### 依赖源（`.npmrc`）

仓库里**提交了一份 `.npmrc`**，把 registry 与 Electron / electron-builder 的二进制源都指到
`registry.npmmirror.com` —— 这是维护者所在网络的现实约束（默认源下 Electron 约 100MB 的
二进制与打包辅助件会 502），不是对使用者的要求。`package-lock.json` 的 `resolved` 也因此
全是镜像地址。

不在中国大陆的贡献者可以：

```bash
npm config set registry https://registry.npmjs.org/   # 或直接删掉 .npmrc
rm -rf node_modules && npm install
```

删掉 `.npmrc` 只影响下载来源，不影响构建产物。

## 九、界面约定

颜色、字号、间距、控件尺寸**先查 `DESIGN-SYSTEM.md`**。表里没有的档位先回去加一条并说明为什么现有档不够，不要就地造 `text-[13.5px]` 或 `bg-[#hex]` —— 有闸门会判红。

按钮几何只在 `index.css` 一处定义（`--tc-btn-height` / `--tc-btn-pad-x`），组件里不写 `px-*` / `py-*` 调尺寸。

暗色适配用 `color-mix(in srgb, var(--td-xxx-color) N%, transparent)`，不要写死 rgba。

## 十、数据不进版本库

`data/` 整个目录被 `.gitignore` 挡住：`chat.db`（真实对话）、`agent-credentials.json`（API Key）、`permission-rules.json`、`images/`。

新增任何写磁盘的功能，先确认落点在 `data/` 下或用户明确指定的路径，**不要**顺手写进仓库目录。
