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

### 知识库（跨 Agent 检索）

- 索引独立 `data/kb.sqlite`；用户的「不索引会话」与「逐 Agent 工具开关」共用 `data/kb-optout.json`（跨重建保留，读取兼容老版的字符串数组格式）。
- **首轮自动注入**：会话第一轮按 workspace 范围取 top-4 注入 prompt，与工具开关无关。
- **`kb.search` 工具默认关闭**，按 `agentId` 逐个在知识库面板「Agent 主动检索」里开启。默认关闭的理由是**隐私与 token 成本**：主动检索意味着 Agent 自己去翻历史对话，必须由用户显式授权；常开还会让普通问答背上额外的上下文预算。
- 开启后每个 Agent **每轮最多 2 次**。轮次键取该会话最新一条用户消息 id —— 用户发下一条即重置，CLI/SDK 进程跨轮复用也不会带账。
- 工具只接受 `query / scope / topK`；`sessionId` 与 Agent 标识由宿主注入。project/all 范围仍由服务端 `policy.allow_*` 收口，**打开开关不会绕过范围策略**。

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
npm run verify:ui      # 主链，串行跑 98 段
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

### 更新产物（本地复现 CI）

应用内更新走「只替换 `resources/app.asar`」，资产由同一套脚本生成，本地与
`.github/workflows/release-update.yml` 的产物一致：

```bash
npm run update:keygen -- --out .tmp/update-signing-key.json   # 只做一次；公钥写进 electron/updater/config.ts
npm run build && npm run build:electron
node scripts/build-installer.mjs --dir                        # 产出 release/win-unpacked/
npm run update:build -- --version 1.1.0 --notes-file release-notes.md \
  --key .tmp/update-signing-key.json
```

产物在 `release/update/`：`app-<版本>.asar`、`OPC-Agent-<版本>-x64-full.zip`、
已签名的 `latest.json`。CI 把清单签名私钥放在 Secret `OPC_UPDATE_PRIVATE_KEY`
（base64 PKCS#8），本地则用 `.tmp/` 下的密钥文件 —— `.tmp/` 已被 gitignore，
私钥不要提交。闸门：`npm run verify:a171-update`。

### 更新状态文件的生命周期与清理口径

一次更新在系统 temp 的 `opc-agent-update/` 与 `resources/` 下最多留下这些文件：

| 文件 | 何时出现 | 谁写 | 何时必须消失 |
| --- | --- | --- | --- |
| `<asset>.download` / `.part` | 下载中 / 下载完成 | 主进程 | 交接成功、交接失败、重新下载、用户忽略 |
| `apply-job.json`、`update-swap.cjs` | 点「退出并重启」时 | 主进程 | helper 结束（成功 / 失败 / 回滚） |
| `app.asar.bak` | 旧 asar 被换下时 | helper | 健康确认、自动回滚、失败还原、用户忽略 |
| `health.json` | 新版本窗口加载成功 | 主进程 `confirmHealthy()` | helper 读到后自删；下次启动兜底清理 |
| `apply-state.json` | 每次交接 | helper / 主进程 | 成功即删；失败记录在「当前版本 ≥ 记录版本」时删；用户点「忽略」时删 |

判定与清理各自只有一个出处：

- `electron/updater/boot-outcome.ts` —— 版本比较与「展示 / 已消解 / 忽略」的纯判定；
- `electron/updater/apply-artifacts.ts` —— 唯一删除口径，含暂存包、状态文件、交接脚本、`.bak`、健康文件。

`verify:a176-update-swap` 用临时目录直接调用这两个模块，不只看源码里有没有那行字。

三条纪律：

1. `apply-state.json` 是**唯一**允许短暂常驻的文件，且只允许在「记录版本 > 当前版本」期间存在。用户手动装了完整包、或重试成功过一次，启动时就必须静默清掉，不能再红字常驻。
2. 失败不等于留证据：除 `apply-state.json` 外的中间产物一律清掉，避免下次更新误用旧补丁或旧 `.bak`。
3. 清理一律「尽力而为」：被占用的文件记为失败、留给下次启动再试，清理异常绝不能改变更新结论。

### 轮换更新签名密钥

```bash
npm run update:keygen -- --force    # 覆盖 .tmp/update-signing-key.json，终端只打印公钥与指纹
```

1. 把输出的公钥替换进 `electron/updater/config.ts` 的 `UPDATE_PUBLIC_KEY_BASE64`。
2. 打开 `.tmp/update-signing-key.json`（已被 gitignore），把 `privateKey` 的值存进
   GitHub → Settings → Secrets and variables → Actions → `OPC_UPDATE_PRIVATE_KEY`
   （PKCS#8 DER base64，单行，不加引号）。
3. 推一个 tag `vX.Y.Z`（必须与 `package.json` 版本一致）触发 `release-update`；
   在 Actions 日志里确认「生成并签名更新清单」成功、Release 资产里有 `latest.json`，
   再把安装后的客户端打开确认更新卡片验签通过 —— 这同时证明 Actions 确实读到了 Secret。
4. 确认测试 release 正常后，删除本地私钥文件（密钥已在 Secrets 里）。

⚠️ 旧客户端只认旧公钥：换密钥等于切断自动更新，必须发一次「带新公钥」的版本；
否则老版本会一直停在「签名不匹配」。

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

### 界面三条硬规则（改相关组件前先读）

这三条是 1.0.4 定稿、并且已经进 `verify:ui` 的验收口径。判据写死在这里，改布局时按判据回归，不要只靠肉眼。

1. **会话头按“这一行”的宽度降级，不按窗口。** 容器查询挂在 `.chat-row`（`container-type: inline-size`，ChatHeader/GroupChatHeader 通过 `PanelHeader` 的 `rowClassName` 挂载），三档为全宽档（验收宽度 1280）、`@container chat-row (max-width: 1024px)`、`@container chat-row (max-width: 900px)`。
   - 判据：`.chat-row h1 { min-width: 6em }`（约 96px）在任何档位都不得被覆盖；名字允许截断，但不得小于 6 个汉字宽。
   - 1024 档：知识库入口只留单色图标（隐藏 `.kb-chip-label`，保留 `aria-label`/`title`），工作区 chip 隐藏展开箭头。
   - 900 档：工作区目录名再收到 `5em`。
   - 断点必须继续写在 `.chat-row` 容器查询里；退回 `@media` 按窗口宽度算会把“右侧面板展开后这一行变窄”判错。
2. **过程流一轮结束只留一条摘要。** 轮次真实结束（收到 `run_end`）后，思考、工具调用与旁白合并成一张摘要卡并自动收起；点开才显示步骤与旁白。
   - 判据：没有真实结束事件的步骤显示「结果未回传」，不得按“下一条事件即完成”猜成绿色完成态。
   - 写入、删除、权限、报错四类关键步骤在展开态常驻：不自动折叠，也不能被手动收起。权限步骤目前由浮层承担；一旦接入轨迹，必须按同一规则常驻。
   - 用户手动展开后，后续事件不得再次自动折叠（除非是新的一轮）。
3. **扩展矩阵用三列固定网格。** `.ext-matrix-row` 唯一模板为 `grid-template-columns: minmax(0, 1fr) 80px 120px`（`column-gap: 12px`，`padding-left: 34px`），两条 lane 共用这个模板；lane 外层 `xl`（≥1280）才分两列，窄宽降单列，不压窄通道/状态列。
   - 判据：同一列相对 lane 左缘的 x 必须一致；组头与条目左边界对齐；`.ext-matrix-channel` / `.ext-matrix-status` 必须 `white-space: nowrap`。
   - 列定义只出现在 `src/index.css` 一处；组件里不得再写第二份列宽。

### 解释性文案 InfoHint 使用口径（2026-11-04 收口）

**当前状态：`HintTip` 已清零并删除；本轮 16 处常驻说明收敛为 `InfoHint`（另含扩展页既有 3 处，仓库合计 19 处调用）。** 全局只允许一套 tooltip 组件，不得再引入第二种实现。

可执行判据：

1. **默认收起。** 仅解释“这个设置/字段是什么意思、行为如何”的普通说明，一律改为 `InfoHint`（16px 细线 ⓘ、24px 点击区），不再占正文版面。单段说明用 `text`，术语表用 `items`；同一个控件只挂 1 枚图标。
2. **以下场景必须常驻，禁止图标化。**
   - 隐私/合规声明（数据是否上传、本地存储范围、授权口径）；
   - 安全语义（如 `deny` 优先级、全放行模式的边界）；
   - 破坏性操作（删除会话/项目/副本、重建索引、清空切片的不可恢复说明与确认）；
   - 操作前成本/风险（例如未验证模型会消耗 token）；
   - 失败/错误原因、空态与首次使用引导。
3. **可访问性。** 每枚图标必须有可读 `aria-label`（由 `label` 提供）；Tab 可达、`Esc` 关闭、点外关闭；凡“不看就不能正确操作”的内容按第 2 条常驻，不得只依赖 hover。
4. **视觉走令牌。** 默认 `--td-text-color-placeholder`，仅 `warn` 态用 `--td-warning-color`；禁止硬编码十六进制。浅色/深色都要回归。
5. **不动版面。** 图标只挂在现有标题/标签行内，不新增行、不改栅格与容器查询断点。改动涉及会话头 `.chat-row` 三档或扩展矩阵三列时，必须同时回归 §九 前三条硬规则的判据。
6. **验收入口。** 外观页图标契约由 `verify:a37` 覆盖（选择器为 `[data-info-hint]` / `[data-info-hint-panel]`）；迁移时只能同步更新闸门选择器，不得放宽断言强度。

## 十、数据不进版本库

`data/` 整个目录被 `.gitignore` 挡住：`chat.db`（真实对话）、`agent-credentials.json`（API Key）、`permission-rules.json`、`images/`。

新增任何写磁盘的功能，先确认落点在 `data/` 下或用户明确指定的路径，**不要**顺手写进仓库目录。

## 十一、发版：说明必须是人写的

GitHub Release 的正文由 CI 生成，来源按优先级取：

1. `release-notes/<tag>.md`（例如 `release-notes/v1.0.4.md`）—— 想单独控制某一版说明就放这个文件；
2. 仓库根部的 `CHANGELOG.md` —— 按 `## [<version>]` 段落自动抽取，日常只需要改这里。

发版三步：

1. 更新 `CHANGELOG.md`（或新建 `release-notes/<tag>.md`），写清用户能感知的变化；
2. `npm version <x.y.z> --no-git-tag-version` 提交后，打 annotated tag 并推送；
3. CI 的 `release-update` 会自动把说明写进 Release 正文。

**反例**：不要只写「版本升到 1.0.4」当说明。`release-update` 在两者都缺失时会退回提交
标题，一旦标题只是版本号、或正文不足两行，工作流会直接失败并提示补 CHANGELOG —— 这是
刻意设计的红灯，不要用改标题的方式绕过去。

