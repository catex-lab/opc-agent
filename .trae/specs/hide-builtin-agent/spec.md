# 规格：从 Agent 列表移除内置 Agent（可恢复）

## 1. 目标与用户故事

**需求原文**：增加一个删除内置 Agent 的功能，用户可以在 Agent 列表中删除；删除后收进列表上方加号里的「获取 Agent」中。

**用户故事**
1. 作为用户，我在通讯录 Agent 列表里右键某个内置 Agent，选择「从列表移除」，二次确认后它从列表消失。
2. 作为用户，我点右上角 `+` → `获取 Agent`，在弹窗顶部「已从列表移除」分组里看到它，点「重新添加」后它回到 Agent 列表。
3. 作为用户，我从内置 Agent 的资料页也能找到「从列表移除」，并明确知道可以从「+ → 获取 Agent」恢复。

**非目标**
- 不删除安装包内的 Agent 定义，不卸载本机 CLI，不清理凭据、Logo、会话记录。
- 不阻止已存在会话/群聊继续使用该 Agent（只影响名册展示）。
- 不影响自建 Agent（`custom-*`、`customcli-*`）既有的「删除」链路。

## 2. 交互与文案

### 2.1 列表入口（主）
`src/components/ContactsPanel.tsx` 的 `ContactRow` 右键菜单，在「修改备注 / 查看资料」之后追加：

- 分隔线（`divider: true`）
- 文案：`从列表移除`
- 图标：`Trash2`，`danger: true`
- 仅当 `!agent.custom` 时出现（内置条目）

点击后弹 `ConfirmDialog`：
- 标题/确认按钮：`从列表移除`
- 正文：`移除「{name}」？它只是从 Agent 列表隐藏，可在「+ → 获取 Agent」里重新添加。`
- 确认后调用 `onHideAgent(agent.id)`，关闭确认框；失败用 `MessagePlugin.warning` 提示（由 App 层处理）。

### 2.2 资料页入口（次）
`src/components/AgentDetailPanel.tsx` 在既有「删除这个自建 Agent」同区域，为内置 Agent 渲染：

- 两段式确认（与自建删除一致：先出现确认条，再点「确认移除」）
- 按钮：`从列表移除这个 Agent`
- 确认条说明：`移除后可在「+ → 获取 Agent」中重新添加`
- 条件：`!agent.custom && onHideBuiltin`

### 2.3 恢复入口
`src/components/GetAgentsDialog.tsx` 顶部（现有安装分组之前）新增独立分组：

- 分组标题：`已从列表移除` + `{n} 条` + `· 点「重新添加」放回 Agent 列表`
- 每行：头像 + 名称 + 状态词 + 右侧「重新添加」按钮（`RotateCcw` 图标）
- 行容器 `data-get-agents-hidden-row={id}`，按钮 `data-get-agents-restore={id}`
- 仅当 `hiddenAgents.length > 0` 时渲染

### 2.4 列表被清空时的空态
当 `visibleAgents.length === 0`、无搜索词、且 `hiddenAgents.length > 0` 时，`ContactsPanel` 的空态改为：

- 标题：`所有 Agent 都已从列表移除`
- 说明：`到「+ → 获取 Agent」里把它们加回来`
- 操作按钮：`获取 Agent`（打开 GetAgentsDialog）

## 3. 后端设计

### 3.1 新增存储模块 `server/agents/hiddenAgents.ts`

- 存储文件：`path.join(dataDirPath, 'hidden-agents.json')`
- 结构：`string[]`（被隐藏的内置 agent id）
- 读取：容错 JSON；只保留满足 `/^[a-z0-9][a-z0-9-]{0,63}$/` 且不以 `custom-` / `customcli-` 开头的 id；去重；读失败返回 `[]`
- 写入：`mkdirSync(dataDirPath, {recursive:true})` → 写 `*.tmp-<pid>-<ts>` → `renameSync`；写失败只告警，内存态仍生效（与 `avatar-store.ts` 一致）
- 导出：
  - `loadHiddenAgentIds(): string[]`
  - `isBuiltinAgentHidden(id: string): boolean`
  - `hideBuiltinAgent(id: string): boolean`（非法/自建 id 返回 false）
  - `showBuiltinAgent(id: string): void`
- 进程内缓存 + 每次写后同步更新；不引入数据库。

### 3.2 名册接口 `server/routes/agent-roster.ts`

新增私有 helper：

```ts
function splitHidden<T extends { id: string }>(all: T[]): { agents: T[]; hiddenAgents: T[] }
```

按 `loadHiddenAgentIds()` 分区。

改动点：
- `GET /api/agents`（普通与 `?refresh=1` 两条分支）
- `POST /api/agents/probe`

三者响应统一为：
```json
{ "agents": [...], "hiddenAgents": [...], "comingSoon": [...] }
```
两个数组都过 `withObservedCapabilities()`。

新增路由（注册在本文件内、`/api/agents/:agentId` 之前；本文件本来就在 index.ts 中先于 custom-agents 注册）：

- `POST /api/agents/:agentId/hide`
  - `isValidAgentId` 校验 → 400
  - `registry.hasAgent` → 404
  - `registry.get(id)?.custom === true` → 400 `自建 Agent 请使用删除`
  - `hideBuiltinAgent(id)` → `{ ok: true, id }`
- `POST /api/agents/:agentId/show`
  - 同样的 id 校验与存在性校验
  - `showBuiltinAgent(id)` → `{ ok: true, id }`（幂等）

**明确不做**：不从 `registry` 注销、不停探测、不清理状态。隐藏只影响名册下发，恢复后状态仍然是热的。

## 4. 前端设计

### 4.1 `src/hooks/useAgentRegistry.ts`

- 新增 state：`hiddenAgents: RegisteredAgent[]`
- `load()` / `probe()` 中读取 `data.hiddenAgents`（非数组时 `[]`）
- 新增：
  ```ts
  hideAgent(agentId: string): Promise<boolean>
  showAgent(agentId: string): Promise<boolean>
  ```
  `POST /api/agents/{id}/hide|show`，失败返回 false；成功 `await load()` 后返回 true
- 返回值新增 `hiddenAgents`、`hideAgent`、`showAgent`

### 4.2 `src/components/ContactsPanel.tsx`

- Props 新增：
  - `hiddenAgents?: RegisteredAgent[]`
  - `onHideAgent?: (agentId: string) => void`
  - `onShowAgent?: (agentId: string) => void`
- `ContactRow` 新增可选 `onHide`；右键菜单追加「从列表移除」
- 新增 state `hideTarget: RegisteredAgent | null` + `ConfirmDialog`
- 透传 `hiddenAgents` / `onShowAgent` 给 `GetAgentsDialog`
- 空态按 2.4 处理
- 自定义条目仍走既有 `onRemove`，不重复出现「从列表移除」

### 4.3 `src/components/GetAgentsDialog.tsx`

- Props 新增 `hiddenAgents?: RegisteredAgent[]`、`onRestore?: (agentId: string) => void`
- 渲染 2.3 的「已从列表移除」分组
- 计数 `已就绪 x / agents.length` 不变（隐藏条目不计入）

### 4.4 `src/components/AgentDetailPanel.tsx`

- Props 新增 `onHideBuiltin?: (agentId: string) => void`
- 新增 `confirmHide` 状态与 2.2 的两段式确认块
- 与 `canDelete`（自建）互斥：`agent.custom` 只走删除，内置只走移除

### 4.5 `src/App.tsx`

- `ContactsPanel` 增加：
  ```tsx
  hiddenAgents={registry.hiddenAgents}
  onHideAgent={handleHideBuiltinAgent}
  onShowAgent={handleShowBuiltinAgent}
  ```
- 新增 `handleHideBuiltinAgent`：调用 `registry.hideAgent`；失败 `MessagePlugin.warning`；成功后 `setDetailAgentId(null)`（若正停在该资料页）
- 新增 `handleShowBuiltinAgent`：调用 `registry.showAgent`，失败提示
- `AgentDetailPanel` 增加 `onHideBuiltin={handleHideBuiltinAgent}`

### 4.6 i18n

`src/i18n/zh.ts` 与 `src/i18n/en.ts` 同步新增（`MessageKey` 由 zh 推导，en 必须齐全）：

| key | zh | en |
| --- | --- | --- |
| `contacts.hideAgent` | 从列表移除 | Remove from list |
| `contacts.hideAgentConfirmTitle` | 从列表移除 | Remove from list |
| `contacts.hideAgentConfirm` | 移除「{name}」？它只是从 Agent 列表隐藏，可在「+ → 获取 Agent」里重新添加。 | Remove "{name}"? It is only hidden from the agent list and can be re-added via "+ → Get agents". |
| `contacts.hideAgentFromDetail` | 从列表移除这个 Agent | Remove this agent from the list |
| `contacts.hideAgentFromDetailConfirm` | 移除后可在「+ → 获取 Agent」中重新添加 | You can re-add it via "+ → Get agents" |
| `contacts.confirmHide` | 确认移除 | Confirm removal |
| `contacts.allHidden` | 所有 Agent 都已从列表移除 | All agents are removed from the list |
| `contacts.allHiddenDesc` | 到「+ → 获取 Agent」里把它们加回来 | Re-add them via "+ → Get agents" |

`GetAgentsDialog` 现有文案全部为中文硬编码，新分组沿用同样方式（不新增 i18n key）。

## 5. 边界与一致性

- 同一 id 重复 hide 幂等；show 未隐藏的 id 也幂等。
- 手改坏 `hidden-agents.json` 只丢掉坏条目，不影响应用启动。
- `RETIRED_AGENT_IDS`（如 `trae`）本来就不在名册里，隐藏列表里的残留 id 在渲染时自然被过滤。
- 隐藏的内置 Agent 若仍被某个群聊/会话引用，聊天功能不受影响（只按 id 取 provider）。
- 新装版本不会自动隐藏任何条目（文件不存在 = 空数组）。

## 6. 验证

### 6.1 离线闸门（新增 `scripts/verify-hidden-agents.ts`，tsx）

设置临时 `OPC_DATA_DIR` 后动态 import `server/agents/hiddenAgents.ts`，断言：

1. 初始为空数组。
2. `hideBuiltinAgent('doubao')` → `true`，`loadHiddenAgentIds()` 含 `doubao`，文件已落盘。
3. 重复 hide 不产生重复项。
4. `showBuiltinAgent('doubao')` 后为空。
5. `hideBuiltinAgent('custom-abc')` / `customcli-abc` → `false` 且不写入。
6. 手工写入 `["doubao","doubao","BAD ID","custom-x",123]` 后加载结果为 `["doubao"]`。
7. 文本契约：`server/routes/agent-roster.ts` 含 `hiddenAgents` 分区与 `/hide`、`/show` 路由；`src/components/ContactsPanel.tsx` 含 `contacts.hideAgent`；`src/components/GetAgentsDialog.tsx` 含 `data-get-agents-restore`。

`package.json` 增加 `verify:hidden-agents`，并追加到 `verify:ui` 链尾。

### 6.2 类型与构建

- `npx tsc -b`
- `npm run build`（verify:ui 自带）

### 6.3 手工验收

1. 打开通讯录 → 右键任一内置 Agent → 「从列表移除」→ 确认 → 该行消失。
2. `+` → 「获取 Agent」→ 顶部「已从列表移除」出现该 Agent → 「重新添加」→ 关闭弹窗后列表恢复。
3. 打开某内置 Agent 资料页 → 「从列表移除这个 Agent」→ 确认 → 返回列表且该行消失。
4. 重启应用后隐藏状态仍在；重新添加后也持久。
5. 自建 Agent 的右键「移除」与资料页「删除这个自建 Agent」行为不变。

## 7. 涉及文件清单

| 文件 | 操作 |
| --- | --- |
| `server/agents/hiddenAgents.ts` | 新增 |
| `server/routes/agent-roster.ts` | 修改 |
| `src/hooks/useAgentRegistry.ts` | 修改 |
| `src/components/ContactsPanel.tsx` | 修改 |
| `src/components/GetAgentsDialog.tsx` | 修改 |
| `src/components/AgentDetailPanel.tsx` | 修改 |
| `src/App.tsx` | 修改 |
| `src/i18n/zh.ts` / `src/i18n/en.ts` | 修改 |
| `scripts/verify-hidden-agents.ts` | 新增 |
| `package.json` | 修改（verify 脚本） |

## 8. 待批准

请确认以上交互位置（列表右键 + 资料页）与「只隐藏、不卸载」的语义，批准后开始实现。
