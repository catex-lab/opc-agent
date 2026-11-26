/**
 * B1：删除回收站（软删除）。
 *
 * ## 为什么删除要留一手
 *
 * 「删除会话」「删除聊天记录」是两个**不可撤销**的动作，而界面上它们和
 * 「收起面板」长得一样容易点错。用户拍板的方案是：删除前把原行序列化进
 * `trash` 表，保留 30 天（`OPC_TRASH_RETENTION_DAYS` 可调），期间能恢复。
 *
 * ## 为什么存 JSON 快照而不是「软删除标记」
 *
 * 标记方案（`deleted_at IS NOT NULL`）要改 **每一条** 读路径 —— 列表、详情、
 * 消息、检索、知识库回填……漏一处就是「删了还看得见」。而快照方案对读路径
 * 零侵入：删除就是真删，恢复时按快照重新 INSERT。
 *
 * 代价：快照占空间。所以有保留期与清理（`purgeExpired()`），且只在删除时
 * 写一次 —— 不是每轮对话都写。
 *
 * ## 恢复的边界
 *
 * 恢复是「尽力而为」：如果同一个 id 已经被新建（极端情况：删除后立刻重建了
 * 同名会话），`INSERT` 会撞主键 —— 这时**不覆盖**新数据，直接报冲突。
 * 宁可让用户看到「恢复失败」，也不能静默把新会话冲掉。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 默认保留天数。30 天足够覆盖「手滑删了、过几天才想起来」。 */
export const DEFAULT_RETENTION_DAYS = 30;

/** 读保留期配置。非法值回落默认，不让一个写错的 env 把回收站关掉。 */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPC_TRASH_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  // 0 = 立即可清（等于关闭回收站），是合法用法
  return Math.floor(n);
}

export type TrashKind = 'session' | 'messages';

export interface TrashRow {
  id: string;
  kind: TrashKind;
  /** session 会话 id（messages 也带上，便于按会话查） */
  session_id: string;
  label: string;
  payload: string;
  deleted_at: string;
  expires_at: string;
}

/** 建表。放在 db.ts 的建表块里调用，保持「所有 DDL 在一处」的既有约定。 */
export function createTrashTable(db: DatabaseSync): void {
  db.exec(`
    -- B1：删除回收站。payload 是删除前的原始行（JSON），恢复时原样写回。
    CREATE TABLE IF NOT EXISTS trash (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      -- 给界面看的标题（会话标题 / 「N 条消息」），不必二次解析 payload
      label      TEXT NOT NULL DEFAULT '',
      payload    TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trash_expires ON trash(expires_at);
    CREATE INDEX IF NOT EXISTS idx_trash_session ON trash(session_id);
  `);
}

function expiresAtFrom(deletedAt: Date, days: number): string {
  return new Date(deletedAt.getTime() + days * 86_400_000).toISOString();
}

/**
 * 把一批即将被删的行写进回收站。
 *
 * 同一个会话被反复删除/恢复时会产生多条记录 —— 这是对的：每条记录对应
 * 一次删除动作，恢复哪一次由用户选。
 */
export function put(
  db: DatabaseSync,
  entry: { kind: TrashKind; sessionId: string; label: string; payload: unknown },
  now = new Date(),
  days = retentionDays()
): string {
  const id = `${entry.kind}-${entry.sessionId}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO trash (id, kind, session_id, label, payload, deleted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.kind,
    entry.sessionId,
    entry.label,
    JSON.stringify(entry.payload),
    now.toISOString(),
    expiresAtFrom(now, days)
  );
  return id;
}

/** 列出未过期的回收站条目（新 → 旧）。 */
export function list(db: DatabaseSync, now = new Date()): TrashRow[] {
  return db
    .prepare('SELECT * FROM trash WHERE expires_at > ? ORDER BY deleted_at DESC')
    .all(now.toISOString()) as unknown as TrashRow[];
}

/**
 * 按 id 取一条，**连过期的一起返回**。
 *
 * 刻意不过滤过期：恢复路径需要区分「不存在」与「已过期」——前者是 404，
 * 后者应当明确告诉用户「已超过保留期」，两者的处置完全不同。让调用方自己判
 * `expires_at`，而不是在这里把它抹成 `undefined`（那样只会得到一句含糊的 404）。
 * 判断用 `isExpired()`，别各自拿字符串比大小。
 */
export function get(db: DatabaseSync, id: string): TrashRow | undefined {
  return db.prepare('SELECT * FROM trash WHERE id = ?').get(id) as unknown as TrashRow | undefined;
}

/** 该条是否已过保留期。恢复前必须判——过期条目不应该还能被恢复成功。 */
export function isExpired(row: TrashRow, now = new Date()): boolean {
  // expires_at 是 ISO 字符串，可直接字典序比较（同时区同时格式）。
  return !(row.expires_at > now.toISOString());
}

/** 删一条回收站记录（恢复成功后调用）。 */
export function drop(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM trash WHERE id = ?').run(id);
}

/**
 * 清理过期条目，返回清掉几条。
 *
 * 启动时调一次即可 —— 不需要定时器：回收站只在删除时增长，
 * 过期判定放宽到「下次启动」对 30 天量级毫无影响。
 */
export function purgeExpired(db: DatabaseSync, now = new Date()): number {
  const r = db.prepare('DELETE FROM trash WHERE expires_at <= ?').run(now.toISOString());
  return Number(r.changes ?? 0);
}
