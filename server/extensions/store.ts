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
import { distributableTargetCount, type MountMode } from './targets.js';

export type ExtensionKind = 'skill' | 'mcp';

/**
 * 事务包裹：node:sqlite 的 DatabaseSync 在当前 @types/node 里没有 `.transaction()`
 * 方法（db.ts 里也是手写 `BEGIN/COMMIT`），所以这里直接 exec 两段 SQL。
 * 所有写多张表的操作都应该走这里，否则异常会留下半套数据（importOne 插了 item
 * 但 source 没登记、deleteItem 删了 item 但 source 还在等）。
 */
function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface ExtensionItem {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string | null;
  description: string | null;
  body: string | null;
  /** 归一化前的原文；只在「做过归一化」时非空，用于一键回滚（A166 / P1） */
  bodyOriginal: string | null;
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
    bodyOriginal: r.body_original == null ? null : String(r.body_original),
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

/**
 * 单独登记一个来源，**不改正文**。
 *
 * 为什么不用 `importOne`：`importOne` 拿传入的 `contentHash` 跟库里的指纹比，
 * 不同就当作「源变了」并覆盖正文。而副本来源（同一条 `(kind, name)` 在第二个
 * Agent 里的那份）**永远不该改正文** —— 正文以主来源为准，副本只是「这条在
 * 别处也有」的证据。以前这里是靠「把主来源的指纹冒充副本指纹」蒙混过去的，
 * 副作用是 `extension_source.content_hash` 记的根本不是它自己的指纹，
 * 差异检测也就看不出「主来源没变、副本变了」（A168 / P4 遗留缺陷）。
 *
 * 返回 false 表示条目还没进库（正常流程里主来源已经先 importOne 过了）。
 */
export function registerSource(
  kind: ExtensionKind,
  name: string,
  agentId: string,
  sourcePath: string,
  contentHash: string
): boolean {
  const item = findItem(kind, name);
  if (!item) return false;
  upsertSource(item.id, agentId, sourcePath, contentHash);
  return true;
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
    // 新增：插 item + 登记 source，必须同事务（插了 item 但 source 没登记会导致
    // 这条永远显示「没有来源」，重扫也不能自动修复）。
    return tx(() => {
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
      return { outcome: 'added' as const, itemId: id };
    });
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

  // 源变了，本地没改过 ⇒ 跟上。UPDATE + upsertSource 同事务。
  return tx(() => {
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
    return { outcome: 'updated' as const, itemId: existing.id };
  });
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

/**
 * 应用归一化后的正文（A166 / P1）。
 *
 * 与 `updateLocal` 的区别：这条**把归一化前的原文留到 `body_original`**，
 * 于是「接受」是可逆的。
 *
 * `COALESCE(body_original, ?)` 而不是直接赋值：只有第一次归一化才写原文。
 * 否则「归一化 → 回滚 → 再归一化」第二次会把原文写成**归一化后**的文本，
 * 回滚就再也回不到原样了（这是不可逆的数据损坏，不是显示问题）。
 *
 * 同时置 `locally_modified = 1`：正文确实被我们改过，重新导入不该悄悄覆盖。
 */
export function applyNormalized(
  kind: ExtensionKind,
  name: string,
  newBody: string
): ExtensionItem | undefined {
  const existing = findItem(kind, name);
  if (!existing) return undefined;
  const at = nowIso();
  db.prepare(
    `UPDATE extension_item
        SET body = ?, body_original = COALESCE(body_original, ?),
            body_hash = ?, locally_modified = 1, revision = revision + 1, updated_at = ?
      WHERE kind = ? AND name = ?`
  ).run(newBody, existing.body, hashOf(newBody), at, kind, name);
  return findItem(kind, name);
}

/**
 * 回滚到归一化前的原文。
 *
 * **不清 `locally_modified`**：原文也可能与源不同（用户可能先手改过再归一化），
 * 没有证据说「现在这份等于源」。宁可让它继续算「本地改过」，也不要让一次
 * 重新导入把用户的内容覆盖掉 —— 覆盖是不可逆的，多一个「本地改过」标记只是
 * 多一次冲突提示。
 */
export function revertNormalized(kind: ExtensionKind, name: string): ExtensionItem | undefined {
  const existing = findItem(kind, name);
  if (!existing) return undefined;
  if (existing.bodyOriginal == null) return existing;
  const at = nowIso();
  db.prepare(
    `UPDATE extension_item
        SET body = ?, body_original = NULL, body_hash = ?,
            revision = revision + 1, updated_at = ?
      WHERE kind = ? AND name = ?`
  ).run(existing.bodyOriginal, hashOf(existing.bodyOriginal), at, kind, name);
  return findItem(kind, name);
}

/** 删 OPC 副本。**只删库里的行，不碰源文件。** 三张表 DELETE 同事务。 */
export function deleteItem(kind: ExtensionKind, name: string): boolean {
  const existing = findItem(kind, name);
  if (!existing) return false;
  tx(() => {
    db.prepare('DELETE FROM extension_source WHERE item_id = ?').run(existing.id);
    db.prepare('DELETE FROM extension_target WHERE item_id = ?').run(existing.id);
    db.prepare('DELETE FROM extension_item WHERE id = ?').run(existing.id);
  });
  return true;
}

/** 冲突三选一：用源的覆盖（把 locally_modified 清掉）。
 *
 * 接受之后调 `refreshItem` 才会真正把正文换成源的样子 —— **调用顺序很重要**：
 * 必须先 refresh（确认源还在磁盘上、能正常读回），再清标志。否则 refresh 失败
 * 时，用户本地编辑已经丢了。index.ts 的路由已经按这个顺序调：先 acceptSource
 * 再 refreshItem —— 但如果 refreshItem 在 importOne 阶段碰到 `locally_modified=1`
 * 会直接返回 conflict，所以 acceptSource **必须先清标志**。
 *
 * 解：acceptSource 调了之后，后续 refreshItem 的 importOne 就不会因 locally_modified
 * 挡下来。如果 refreshItem 还是 missing，那说明源真的没了；此时 locally_modified
 * 已经是 0，但内容还是之前那份（refresh 失败不会动正文）。总比「源没了但本地
 * 内容先被清再被覆盖」好。
 */
export function acceptSource(kind: ExtensionKind, name: string): boolean {
  const existing = findItem(kind, name);
  if (!existing) return false;
  db.prepare('UPDATE extension_item SET locally_modified = 0, updated_at = ? WHERE id = ?').run(
    nowIso(),
    existing.id
  );
  return true;
}

/** 单条开关：让这条扩展参与分发/注入（enabled=true）还是彻底跳过（false）。 */
export function toggleEnabled(kind: ExtensionKind, name: string, enabled: boolean): ExtensionItem | undefined {
  const existing = findItem(kind, name);
  if (!existing) return undefined;
  db.prepare('UPDATE extension_item SET enabled = ?, updated_at = ? WHERE kind = ? AND name = ?').run(
    enabled ? 1 : 0,
    nowIso(),
    kind,
    name
  );
  return findItem(kind, name);
}

/** kind 级整批开关的结果：改了几条、因无可分发跳过几条。 */
export interface KindToggleResult {
  /** 真的被改写的条数（已处于目标值的不算） */
  changed: number;
  /** 因为没有分发目标而被跳过的条数 */
  skipped: number;
}

/**
 * kind 级整批开关：**只作用于有分发目标的条目**。
 *
 * 为什么不能一把 UPDATE 全改：`enabled` 对「无可分发」的条目没有任何效果
 * （没有任何 Agent 会收到它），批量把它写成 1 只会留下一堆看着开着、
 * 实际无效的死配置；写成 0 又会被误读成「用户主动关了一条」。
 * 所以这类条目**保持原值**，只把跳过的数量回报给界面去解释。
 *
 * 已处于目标值的可分发条目也不重复写入（`updated_at` 不因一次无效点击而变）。
 */
export function toggleKindEnabled(kind: ExtensionKind, enabled: boolean): KindToggleResult {
  const at = nowIso();
  const items = listItems().filter(it => it.kind === kind);
  const update = db.prepare('UPDATE extension_item SET enabled = ?, updated_at = ? WHERE id = ?');
  let changed = 0;
  let skipped = 0;
  for (const it of items) {
    const targetCount = distributableTargetCount({
      kind: it.kind,
      presentAgentIds: listSources(it.id).map(s => s.agentId),
    });
    if (targetCount === 0) {
      skipped += 1;
      continue;
    }
    if (it.enabled === enabled) continue;
    update.run(enabled ? 1 : 0, at, it.id);
    changed += 1;
  }
  return { changed, skipped };
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
