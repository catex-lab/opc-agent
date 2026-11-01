/**
 * 扩展库的读写层。
 *
 * ## 两条不变量（改这个文件前先读）
 *
 * 1. **`content_hash` 与 `body_hash` 是两件事**。
 *    - `content_hash`：**源文件**的指纹，用来发现「用户在自己的客户端里改了」
 *    - `body_hash`：**本地正文**的指纹，用来判断「我们这边改过没有」
 *    合成一个字段的话，「源变了」和「我改过」就分不开，冲突处理只能瞎猜。
 *
 * 2. **`locally_modified = 1` 时，导入流程绝不覆盖正文**。
 *    这是用户明确要的可编辑功能的底线：他改过的内容，不能被一次重新扫描抹掉。
 *
 * ## 只读用户文件
 *
 * 本文件只写 `data/chat.db`。**不碰任何 `~/.<agent>/` 下的东西** —— 见 PLAN-EXTENSIONS.md §2.1。
 */

import crypto from 'node:crypto';
import db from '../db.js';
import type { MountMode } from './targets.js';

export type ExtensionKind = 'skill' | 'mcp';

export interface ExtensionItem {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string | null;
  description: string | null;
  body: string | null;
  configJson: string | null;
  contentHash: string;
  bodyHash: string;
  revision: number;
  locallyModified: boolean;
  blocked: boolean;
  blockedReason: string | null;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ExtensionSource {
  agentId: string;
  path: string;
  contentHash: string;
  seenAt: string | null;
}

export interface ExtensionTarget {
  agentId: string;
  mode: MountMode;
  status: string;
  present: boolean;
  detail: string | null;
  checkedAt: string | null;
}

export interface ImportPayload {
  kind: ExtensionKind;
  name: string;
  title: string | null;
  description: string | null;
  /** 技能正文（已过安全扫描）；被拦截时传 null */
  body: string | null;
  configJson: string | null;
  contentHash: string;
  blocked: boolean;
  blockedReason: string | null;
  agentId: string;
  sourcePath: string;
}

export type ImportOutcome = 'added' | 'unchanged' | 'updated' | 'conflict' | 'replaced';

/** sha256，够用且无依赖。空串也有确定值，不要返回 '' 让调用方判空。 */
export function hashOf(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToItem(r: Record<string, unknown>): ExtensionItem {
  return {
    id: String(r.id),
    kind: String(r.kind) as ExtensionKind,
    name: String(r.name),
    title: r.title == null ? null : String(r.title),
    description: r.description == null ? null : String(r.description),
    body: r.body == null ? null : String(r.body),
    configJson: r.config_json == null ? null : String(r.config_json),
    contentHash: String(r.content_hash ?? ''),
    bodyHash: String(r.body_hash ?? ''),
    revision: Number(r.revision ?? 1),
    locallyModified: Number(r.locally_modified ?? 0) === 1,
    blocked: Number(r.blocked ?? 0) === 1,
    blockedReason: r.blocked_reason == null ? null : String(r.blocked_reason),
    enabled: Number(r.enabled ?? 1) === 1,
    createdAt: r.created_at == null ? null : String(r.created_at),
    updatedAt: r.updated_at == null ? null : String(r.updated_at),
  };
}

export function findItem(kind: ExtensionKind, name: string): ExtensionItem | undefined {
  const row = db
    .prepare('SELECT * FROM extension_item WHERE kind = ? AND name = ?')
    .get(kind, name) as Record<string, unknown> | undefined;
  return row ? rowToItem(row) : undefined;
}

export function findItemById(id: string): ExtensionItem | undefined {
  const row = db.prepare('SELECT * FROM extension_item WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToItem(row) : undefined;
}

export function listItems(kind?: ExtensionKind): ExtensionItem[] {
  const rows = (kind
    ? db.prepare('SELECT * FROM extension_item WHERE kind = ? ORDER BY name').all(kind)
    : db.prepare('SELECT * FROM extension_item ORDER BY kind, name').all()) as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToItem);
}

export function listSources(itemId: string): ExtensionSource[] {
  const rows = db
    .prepare('SELECT agent_id, path, content_hash, seen_at FROM extension_source WHERE item_id = ? ORDER BY agent_id')
    .all(itemId) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    agentId: String(r.agent_id),
    path: String(r.path),
    contentHash: String(r.content_hash ?? ''),
    seenAt: r.seen_at == null ? null : String(r.seen_at),
  }));
}

export function listTargets(itemId: string): ExtensionTarget[] {
  const rows = db
    .prepare('SELECT agent_id, mode, status, present, detail, checked_at FROM extension_target WHERE item_id = ? ORDER BY agent_id')
    .all(itemId) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    agentId: String(r.agent_id),
    mode: String(r.mode) as MountMode,
    status: String(r.status ?? 'unknown'),
    present: Number(r.present ?? 0) === 1,
    detail: r.detail == null ? null : String(r.detail),
    checkedAt: r.checked_at == null ? null : String(r.checked_at),
  }));
}

/** 一个来源的 upsert（同一 Agent 同一路径只有一行） */
function upsertSource(itemId: string, agentId: string, sourcePath: string, contentHash: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO extension_source (id, item_id, agent_id, path, content_hash, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, agent_id, path)
     DO UPDATE SET content_hash = excluded.content_hash, seen_at = excluded.seen_at`
  ).run(crypto.randomUUID(), itemId, agentId, sourcePath, contentHash, at);
}

/** 本次扫描没见到的来源要清掉，否则「N 处重复」会永远显示旧数字 */
export function pruneSources(itemId: string, seenPaths: readonly string[]): void {
  const keep = new Set(seenPaths);
  for (const s of listSources(itemId)) {
    if (!keep.has(s.path)) {
      db.prepare('DELETE FROM extension_source WHERE item_id = ? AND agent_id = ? AND path = ?').run(
        itemId,
        s.agentId,
        s.path
      );
    }
  }
}

export function upsertTarget(
  itemId: string,
  agentId: string,
  mode: MountMode,
  present: boolean,
  detail: string | null
): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO extension_target (id, item_id, agent_id, mode, status, present, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, agent_id)
     DO UPDATE SET mode = excluded.mode, present = excluded.present,
                   detail = excluded.detail, checked_at = excluded.checked_at,
                   status = excluded.status`
  ).run(
    crypto.randomUUID(),
    itemId,
    agentId,
    mode,
    present ? 'active' : 'pending',
    present ? 1 : 0,
    detail,
    at
  );
}

/**
 * 导入一条。
 *
 * 判定表（PLAN-EXTENSIONS.md §7.1）：
 *
 * | 库内 | 源 hash | locally_modified | 结果 |
 * |---|---|---|---|
 * | 无 | — | — | added |
 * | 有 | 相同 | 任意 | unchanged（只更新 seen_at） |
 * | 有 | 不同 | 0 | updated（源更新，直接跟上） |
 * | 有 | 不同 | 1 | **conflict**（本地改过，绝不覆盖） |
 */
export function importOne(p: ImportPayload): { outcome: ImportOutcome; itemId: string } {
  const existing = findItem(p.kind, p.name);
  const at = nowIso();

  if (!existing) {
    const id = crypto.randomUUID();
    const bodyHash = hashOf(p.body ?? '');
    db.prepare(
      `INSERT INTO extension_item
         (id, kind, name, title, description, body, config_json, content_hash, body_hash,
          revision, locally_modified, blocked, blocked_reason, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 1, ?, ?)`
    ).run(
      id,
      p.kind,
      p.name,
      p.title,
      p.description,
      p.body,
      p.configJson,
      p.contentHash,
      bodyHash,
      p.blocked ? 1 : 0,
      p.blockedReason,
      at,
      at
    );
    upsertSource(id, p.agentId, p.sourcePath, p.contentHash);
    return { outcome: 'added', itemId: id };
  }

  // 源没变：只刷新 seen_at（由 upsertSource 做），正文一律不动
  if (existing.contentHash === p.contentHash) {
    upsertSource(existing.id, p.agentId, p.sourcePath, p.contentHash);
    return { outcome: 'unchanged', itemId: existing.id };
  }

  // 源变了，但用户改过 ⇒ 冲突，等用户三选一。**绝不自动覆盖。**
  if (existing.locallyModified) {
    upsertSource(existing.id, p.agentId, p.sourcePath, p.contentHash);
    return { outcome: 'conflict', itemId: existing.id };
  }

  // 源变了，本地没改过 ⇒ 跟上
  const bodyHash = hashOf(p.body ?? '');
  db.prepare(
    `UPDATE extension_item
        SET title = ?, description = ?, body = ?, config_json = ?,
            content_hash = ?, body_hash = ?, revision = revision + 1,
            blocked = ?, blocked_reason = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    p.title,
    p.description,
    p.body,
    p.configJson,
    p.contentHash,
    bodyHash,
    p.blocked ? 1 : 0,
    p.blockedReason,
    at,
    existing.id
  );
  upsertSource(existing.id, p.agentId, p.sourcePath, p.contentHash);
  return { outcome: 'updated', itemId: existing.id };
}

/**
 * 用户手改副本。
 *
 * 只动 `body / title / description / config_json`，**不动 `content_hash`** ——
 * 那个字段记的是「源长什么样」，本地编辑不该改写它，否则下次扫描会以为源没变。
 */
export function updateLocal(
  kind: ExtensionKind,
  name: string,
  patch: { body?: string; title?: string; description?: string; configJson?: string }
): ExtensionItem | undefined {
  const existing = findItem(kind, name);
  if (!existing) return undefined;
  const body = patch.body ?? existing.body ?? '';
  const at = nowIso();
  db.prepare(
    `UPDATE extension_item
        SET body = ?, title = ?, description = ?, config_json = ?,
            body_hash = ?, locally_modified = 1, revision = revision + 1, updated_at = ?
      WHERE kind = ? AND name = ?`
  ).run(
    patch.body ?? existing.body,
    patch.title ?? existing.title,
    patch.description ?? existing.description,
    patch.configJson ?? existing.configJson,
    hashOf(body),
    at,
    kind,
    name
  );
  return findItem(kind, name);
}

/** 删 OPC 副本。**只删库里的行，不碰源文件。** */
export function deleteItem(kind: ExtensionKind, name: string): boolean {
  const existing = findItem(kind, name);
  if (!existing) return false;
  db.prepare('DELETE FROM extension_source WHERE item_id = ?').run(existing.id);
  db.prepare('DELETE FROM extension_target WHERE item_id = ?').run(existing.id);
  db.prepare('DELETE FROM extension_item WHERE id = ?').run(existing.id);
  return true;
}

/** 冲突三选一：用源的覆盖（把 locally_modified 清掉） */
export function acceptSource(kind: ExtensionKind, name: string): boolean {
  const existing = findItem(kind, name);
  if (!existing) return false;
  db.prepare('UPDATE extension_item SET locally_modified = 0, updated_at = ? WHERE id = ?').run(
    nowIso(),
    existing.id
  );
  return true;
}

export interface ExtensionStats {
  skillCount: number;
  mcpCount: number;
  blockedCount: number;
  conflictCount: number;
  duplicateCount: number;
}

export function stats(): ExtensionStats {
  const items = listItems();
  let blockedCount = 0;
  let duplicateCount = 0;
  for (const it of items) {
    if (it.blocked) blockedCount += 1;
    if (listSources(it.id).length > 1) duplicateCount += 1;
  }
  return {
    skillCount: items.filter(i => i.kind === 'skill').length,
    mcpCount: items.filter(i => i.kind === 'mcp').length,
    blockedCount,
    duplicateCount,
    // 冲突是「源变了 + 本地改过」，需要拿源再比一次才知道；导入时由 import 流程统计，
    // 这里只给 0，避免把「有本地修改」误报成冲突。
    conflictCount: 0,
  };
}
