/**
 * 持久授权表（2026-11-12 变体 A「该 Agent 永久」）。
 *
 * ## 语义边界（先读这个再动这文件）
 *
 * - 授权键是 **agentId + toolName**：粒度到工具，不带入参。rm -rf 这类
 *   高危载荷的拦截在 `server/agents/permission-gate.ts`（门禁），它在
 *   查表的**前面** —— 授权省的是「问用户」这一步，不是安全检查。
 * - 「本会话始终允许」**不进这张表**：那档的语义仍是适配器内存（SDK）或
 *   上游 harness（ACP），应用重启后失效。设置页如实只列持久档，不假装
 *   能列出会话级。
 * - 写入只有两个口：`POST /api/permission-response`（带 persistAgent 的
 *   allow 答复）与 DELETE 路由的撤销。agentId / toolName 都取自服务端
 *   待答复元数据（`server/agents/permissionMeta.ts`），前端传的不算数。
 *
 * ## 查表缓存
 *
 * `hasAgentGrant` 在每次工具调用都会走到（每条消息可能多次），node:sqlite
 * 虽是进程内查询，也不必每次都打。这里用失效式缓存：读过的 (agent, tool)
 * 结果留在内存，本模块内的任何写入（add / remove）整体清空。缓存不跨进程，
 * 直接改库的外部方（没有这种方）本来就不在契约里。
 */

import db from './db.js';

export interface DbPermissionGrant {
  id: number;
  agent_id: string;
  tool_name: string;
  created_at: string;
}

// 与 db.ts 的建表先例同风格：CREATE TABLE IF NOT EXISTS 的增量，可重复执行。
// 不放进 db.ts 的大 exec 块里，是为了让这张新表的生命周期跟自己的模块走
// （db.ts 是并行改动最频繁的共享文件，能不碰就不碰）。
db.exec(`
  -- 持久授权：「该 Agent 永久」。UNIQUE 保证同一 (agent, tool) 只有一行，
  -- 重复授权刷新 created_at（用户最近一次的表态才是现状）。
  CREATE TABLE IF NOT EXISTS permission_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(agent_id, tool_name)
  );
`);

function cleanKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ============= 查询 =============

/** 全部持久授权，最近授权的在前（设置页直接用这个顺序） */
export function listGrants(): DbPermissionGrant[] {
  return db
    .prepare('SELECT * FROM permission_grants ORDER BY created_at DESC, id DESC')
    .all() as unknown as DbPermissionGrant[];
}

// ============= 缓存 =============

const grantCache = new Map<string, boolean>();

function cacheKey(agentId: string, toolName: string): string {
  return `${agentId}\u0000${toolName}`;
}

function invalidateGrantCache(): void {
  grantCache.clear();
}

/**
 * 这个 Agent 的这个工具是否已有持久授权。命中即自动放行（各适配器在发出
 * permission_request 之前查）。
 *
 * 键为空（agentId / toolName 缺失）一律返回 false：查不到键的授权检查等于
 * 没查，宁可多问一次，不做乐观兜底。
 */
export function hasAgentGrant(agentId: unknown, toolName: unknown): boolean {
  const a = cleanKey(agentId);
  const t = cleanKey(toolName);
  if (!a || !t) return false;
  const key = cacheKey(a, t);
  const cached = grantCache.get(key);
  if (cached !== undefined) return cached;
  const row = db
    .prepare('SELECT 1 FROM permission_grants WHERE agent_id = ? AND tool_name = ?')
    .get(a, t);
  const has = row !== undefined;
  grantCache.set(key, has);
  return has;
}

// ============= 写入 =============

/**
 * 落一条授权。已存在则刷新授权时间（重复授权 = 用户再次确认，不是第二行）。
 */
export function addGrant(agentId: unknown, toolName: unknown): boolean {
  const a = cleanKey(agentId);
  const t = cleanKey(toolName);
  if (!a || !t) return false;
  db.prepare(
    `INSERT INTO permission_grants (agent_id, tool_name, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_id, tool_name) DO UPDATE SET created_at = excluded.created_at`
  ).run(a, t, new Date().toISOString());
  invalidateGrantCache();
  return true;
}

/** 撤销。返回是否真的删了一行（没删过返回 false，设置页据此提示）。 */
export function removeGrant(agentId: unknown, toolName: unknown): boolean {
  const a = cleanKey(agentId);
  const t = cleanKey(toolName);
  if (!a || !t) return false;
  const r = db
    .prepare('DELETE FROM permission_grants WHERE agent_id = ? AND tool_name = ?')
    .run(a, t);
  invalidateGrantCache();
  return Number(r.changes) > 0;
}

/** 测试钩子：直接改库（夹具）之后清缓存，避免读到过期结论 */
export function __resetGrantCacheForTests(): void {
  invalidateGrantCache();
}
