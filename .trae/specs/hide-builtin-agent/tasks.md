# 任务清单：从 Agent 列表移除内置 Agent（可恢复）

按顺序执行，每步完成后勾选。

## T1 后端存储
- [x] 新增 `server/agents/hiddenAgents.ts`
  - `hidden-agents.json`（`dataDirPath`）
  - `loadHiddenAgentIds` / `isBuiltinAgentHidden` / `hideBuiltinAgent` / `showBuiltinAgent`
  - 原子写（tmp + renameSync）、坏文件容错、去重、拒绝 `custom-*` / `customcli-*`
- [x] 验证：临时目录内 hide → 落盘 → show → 清空

## T2 名册接口
- [x] `server/routes/agent-roster.ts` 新增 `splitHidden()` helper
- [x] `GET /api/agents`（普通 + refresh）、`POST /api/agents/probe` 返回 `hiddenAgents`
- [x] 新增 `POST /api/agents/:agentId/hide` 与 `/show`
  - 400 非法 id / 自建 id；404 未知 id；成功 `{ ok:true, id }`
- [x] 确认路由位于 `/api/agents/:agentId` 之前（本文件先注册，无需移动）

## T3 前端状态
- [x] `src/hooks/useAgentRegistry.ts`
  - state `hiddenAgents`
  - `load()` / `probe()` 读取 `data.hiddenAgents`
  - `hideAgent()` / `showAgent()`：POST + `await load()`，失败返回 false

## T4 列表与恢复 UI
- [x] `ContactsPanel`：props（`hiddenAgents` / `onHideAgent` / `onShowAgent`）
- [x] `ContactRow`：内置条目右键菜单追加「从列表移除」（divider + danger + Trash2）
- [x] `ContactsPanel`：移除确认 `ConfirmDialog`
- [x] `ContactsPanel`：透传 `hiddenAgents` / `onShowAgent` 给 `GetAgentsDialog`
- [x] `ContactsPanel`：全部隐藏时的空态（标题/说明/「获取 Agent」按钮）
- [x] `GetAgentsDialog`：顶部「已从列表移除」分组 + 「重新添加」按钮
  - `data-get-agents-hidden-row` / `data-get-agents-restore`

## T5 资料页入口
- [x] `AgentDetailPanel`：props `onHideBuiltin`
- [x] 内置条目两段式确认块「从列表移除这个 Agent」
- [x] 与自建「删除」互斥

## T6 接线
- [x] `App.tsx`：传入 `hiddenAgents` / `onHideAgent` / `onShowAgent`
- [x] `App.tsx`：`handleHideBuiltinAgent`（失败 warning、成功后关闭资料页）
- [x] `App.tsx`：`handleShowBuiltinAgent`
- [x] `App.tsx`：`AgentDetailPanel` 传 `onHideBuiltin`

## T7 文案
- [x] `src/i18n/zh.ts` 新增 8 个 `contacts.*` key
- [x] `src/i18n/en.ts` 同 key 英文文案（`Record<MessageKey,string>` 必须齐全）

## T8 闸门
- [x] 新增 `scripts/verify-hidden-agents.ts`（存储往返 + 非法 id + 坏文件 + 文本契约）
- [x] `package.json` 增加 `verify:hidden-agents` 并追加到 `verify:ui`
- [x] `npx tsc -b` 通过
- [x] 运行 `npm run verify:hidden-agents` 通过

## T9 手工验收
- [x] 右键移除 → 行消失
- [x] `+` → 获取 Agent → 重新添加 → 行恢复
- [x] 资料页移除入口可用
- [x] 重启后隐藏状态保持
- [x] 自建 Agent 删除链路不受影响
