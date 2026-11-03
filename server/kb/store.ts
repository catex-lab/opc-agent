/**
 * 知识库存储层（P1）。
 *
 * 独立 `data/kb.sqlite`，不复用 `chat.db`：索引是派生数据，删掉重建不影响
 * 聊天记录；`chat.db` 也不因为检索功能多出 FTS 表与触发器。
 *
 * 所有写操作走事务；外部内容表 `kb_chunks_fts` 由触发器同步，避免应用层
 * 忘记删 FTS 行导致「原文没了但还能搜到」。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDirPath } from '../paths.js';
import { KB_VECTOR_PROVIDER_ID } from './embedding.js';

export const KB_DB_FILENAME = 'kb.sqlite';

/** 连续失败达到此阈值即自动停索引（下一次成功会清零）。 */
export const KB_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 索引体积治理阈值（P3）。
 *
 * 实测口径（2026-11-04，本机真实库）：206 片 / 2.2MB（含 FTS 与 128 维向量）。
 * 按「一片 ≈ 10KB（正文 + FTS + 512B 向量）」估算：
 *   - 5 万片 ≈ 500MB，是默认的 chunk 上限；
 *   - 512MB 是硬上限，超过后自动从最旧的切片开始清理；
 *   - 时间清理默认关闭（`KB_RETENTION_DAYS = 0`），避免误删用户历史。
 * 两个上限都按「先删最旧」执行，不做按会话的隐式删除；按会话清理只走显式
 * `pruneKnowledgeBase({ sessionIds })`。
 */
export const KB_MAX_CHUNKS = 50_000;
export const KB_MAX_DB_BYTES = 512 * 1024 * 1024;
export const KB_RETENTION_DAYS = 0;

/** 自动治理的最小间隔：每小时最多检查一次，避免每条消息都统计体积。 */
const KB_LIMIT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface KbChunkRow {
  id: string;
  event_hash: string;
  content_hash: string;
  session_id: string;
  message_ids: string;
  agent_id: string | null;
  author_agent_id: string | null;
  workspace_key: string | null;
  project_id: string | null;
  role: string;
  source_kind: 'direct' | 'group';
  visibility: 'normal' | 'source_only';
  is_excluded: number;
  summary: string;
  content: string;
  token_count: number;
  time_start: string;
  time_end: string;
  redacted_count: number;
  indexed_at: string;
}

export interface KbSessionState {
  session_id: string;
  index_enabled: number;
  source_kind: string;
  visibility: string;
  last_indexed_at: string | null;
  last_message_at: string | null;
  last_error: string | null;
  /** 连续失败次数；成功一次即归零，达到阈值后 index_enabled 会被置 0。 */
  consecutive_failures: number;
  /** 停用原因：null = 未停用。用于界面区分「你手动关闭」与「连续失败自动停」。 */
  disabled_reason: KbDisabledReason | null;
}

export type KbDisabledReason = 'user' | 'auto_failure';

export interface KbScopePolicy {
  /** 本项目范围是否已被用户显式开启 */
  allowProject: boolean;
  /** 全部范围是否已被用户显式开启 */
  allowAll: boolean;
}

export interface KbStats {
  dbPath: string;
  sizeBytes: number;
  chunkCount: number;
  sessionCount: number;
  disabledSessionCount: number;
  /** 按停用原因拆分，供界面区分文案与恢复入口。 */
  disabledByReason: { user: number; autoFailure: number };
  /** 有 last_error 但仍启用（尚未达到自动停阈值）的会话数。 */
  failedSessionCount: number;
  /** 当前 provider 的向量条数；为 0 时检索自动降级到纯 BM25。 */
  vectorCount: number;
  limits: { maxBytes: number; maxChunks: number; retentionDays: number };
  lastBackfillAt: string | null;
  scopePolicy: KbScopePolicy;
}

let db: DatabaseSync | null = null;

export function kbDbPath(): string {
  return path.join(dataDirPath, KB_DB_FILENAME);
}

function createSchema(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS kb_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_sessions (
      session_id      TEXT PRIMARY KEY,
      index_enabled   INTEGER NOT NULL DEFAULT 1,
      source_kind     TEXT NOT NULL DEFAULT 'direct',
      visibility      TEXT NOT NULL DEFAULT 'normal',
      last_indexed_at TEXT,
      last_message_at TEXT,
      last_error      TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      -- 停用原因：NULL = 未停用；'user' = 用户手动关闭；'auto_failure' = 连续失败自动停
      disabled_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id              TEXT PRIMARY KEY,
      event_hash      TEXT NOT NULL UNIQUE,
      content_hash    TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      message_ids     TEXT NOT NULL,
      agent_id        TEXT,
      author_agent_id TEXT,
      workspace_key   TEXT,
      project_id      TEXT,
      role            TEXT NOT NULL,
      source_kind     TEXT NOT NULL,
      visibility      TEXT NOT NULL,
      is_excluded     INTEGER NOT NULL DEFAULT 0,
      summary         TEXT NOT NULL,
      content         TEXT NOT NULL,
      token_count     INTEGER NOT NULL,
      time_start      TEXT NOT NULL,
      time_end        TEXT NOT NULL,
      redacted_count  INTEGER NOT NULL DEFAULT 0,
      indexed_at      TEXT NOT NULL,
      UNIQUE(session_id, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_kb_chunks_session
      ON kb_chunks(session_id, time_end);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_workspace
      ON kb_chunks(workspace_key, time_end);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_project
      ON kb_chunks(project_id, time_end);

    -- P3 向量层：按 chunk 存，不参与 FTS。provider 用于换模型后灰度回填。
    CREATE TABLE IF NOT EXISTS kb_vectors (
      chunk_id   TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_vectors_provider
      ON kb_vectors(provider);

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      content,
      summary,
      content='kb_chunks',
      content_rowid='rowid',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, content, summary)
      VALUES (new.rowid, new.content, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, summary)
      VALUES ('delete', old.rowid, old.content, old.summary);
      DELETE FROM kb_vectors WHERE chunk_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, summary)
      VALUES ('delete', old.rowid, old.content, old.summary);
      INSERT INTO kb_chunks_fts(rowid, content, summary)
      VALUES (new.rowid, new.content, new.summary);
    END;
  `);
}

function ensureSchemaColumns(conn: DatabaseSync): void {
  try {
    const info = conn.prepare('PRAGMA table_info(kb_sessions)').all() as Array<{ name: string }>;
    if (!info.some(col => col.name === 'consecutive_failures')) {
      conn.exec(
        'ALTER TABLE kb_sessions ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!info.some(col => col.name === 'disabled_reason')) {
      conn.exec('ALTER TABLE kb_sessions ADD COLUMN disabled_reason TEXT');
    }
  } catch (err) {
    console.warn('[KB] 迁移 kb_sessions 失败计数/停用原因列失败（已跳过）:', err);
  }

  // P3：已有库里的 kb_chunks_ad 触发器没有「删向量」这一步。
  // `CREATE TRIGGER IF NOT EXISTS` 不会更新已存在的触发器，必须重建。
  try {
    conn.exec(`
      DROP TRIGGER IF EXISTS kb_chunks_ad;
      CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, summary)
        VALUES ('delete', old.rowid, old.content, old.summary);
        DELETE FROM kb_vectors WHERE chunk_id = old.id;
      END;
    `);
  } catch (err) {
    console.warn('[KB] 重建 kb_chunks_ad 触发器失败（向量清理可能滞后）:', err);
  }
}

function quarantine(paths: string[]): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.renameSync(file, `${file}.corrupt-${stamp}`);
    } catch {
      /* 隔离失败不阻断重建；原文件仍在，交给用户处理 */
    }
  }
}

function openKbDb(): DatabaseSync {
  fs.mkdirSync(dataDirPath, { recursive: true });
  const dbPath = kbDbPath();

  try {
    const conn = new DatabaseSync(dbPath);
    conn.exec('PRAGMA journal_mode = WAL');
    conn.exec('PRAGMA foreign_keys = ON');
    const check = conn.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    if (check?.integrity_check !== 'ok') throw new Error('integrity_check 未通过');
    createSchema(conn);
    ensureSchemaColumns(conn);
    return conn;
  } catch (err) {
    // 只隔离索引库自己的文件；chat.db 与用户数据不动。
    quarantine([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
    console.warn('[KB] 索引库不可用，已隔离并重建:', err);
    const conn = new DatabaseSync(dbPath);
    conn.exec('PRAGMA journal_mode = WAL');
    createSchema(conn);
    ensureSchemaColumns(conn);
    return conn;
  }
}

export function getKbDb(): DatabaseSync {
  if (!db) db = openKbDb();
  return db;
}

export function closeKbDb(): void {
  try {
    db?.close();
  } catch {
    /* 关闭失败不影响退出 */
  }
  db = null;
}

export function inKbTransaction<T>(fn: () => T): T {
  const conn = getKbDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

export function getMeta(key: string): string | null {
  const row = getKbDb().prepare('SELECT value FROM kb_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getKbDb()
    .prepare('INSERT INTO kb_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getScopePolicy(): KbScopePolicy {
  return {
    allowProject: getMeta('policy.allow_project') === '1',
    allowAll: getMeta('policy.allow_all') === '1',
  };
}

export function setScopePolicy(patch: Partial<KbScopePolicy>): KbScopePolicy {
  if (patch.allowProject !== undefined) {
    setMeta('policy.allow_project', patch.allowProject ? '1' : '0');
  }
  if (patch.allowAll !== undefined) {
    setMeta('policy.allow_all', patch.allowAll ? '1' : '0');
  }
  return getScopePolicy();
}

export function getSessionState(sessionId: string): KbSessionState | undefined {
  return getKbDb()
    .prepare('SELECT * FROM kb_sessions WHERE session_id = ?')
    .get(sessionId) as unknown as KbSessionState | undefined;
}

export function listSessionStates(): KbSessionState[] {
  return getKbDb().prepare('SELECT * FROM kb_sessions').all() as unknown as KbSessionState[];
}

export function setSessionIndexEnabled(
  sessionId: string,
  enabled: boolean,
  meta?: { sourceKind: string; visibility: string }
): KbSessionState {
  const now = new Date().toISOString();
  getKbDb()
    .prepare(`
      INSERT INTO kb_sessions(
        session_id, index_enabled, source_kind, visibility, last_indexed_at,
        disabled_reason
      )
      VALUES(?, ?, ?, ?, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        index_enabled = excluded.index_enabled,
        source_kind   = excluded.source_kind,
        visibility    = excluded.visibility,
        disabled_reason = excluded.disabled_reason,
        -- 重新开启（恢复入口）时把失败计数与错误一并清掉；关闭时保留现场
        consecutive_failures = CASE
          WHEN excluded.index_enabled = 1 THEN 0
          ELSE kb_sessions.consecutive_failures
        END,
        last_error = CASE
          WHEN excluded.index_enabled = 1 THEN NULL
          ELSE kb_sessions.last_error
        END
    `)
    .run(
      sessionId,
      enabled ? 1 : 0,
      meta?.sourceKind ?? 'direct',
      meta?.visibility ?? 'normal',
      // 关闭一律记为「用户手动关闭」；自动停索引由 markSessionError 单独写
      enabled ? null : 'user'
    );
  return getSessionState(sessionId) as KbSessionState;
}

export function markSessionIndexed(
  sessionId: string,
  fields: {
    sourceKind: string;
    visibility: string;
    lastMessageAt: string | null;
    error?: string | null;
  }
): void {
  const now = new Date().toISOString();
  getKbDb()
    .prepare(`
      INSERT INTO kb_sessions(
        session_id, index_enabled, source_kind, visibility,
        last_indexed_at, last_message_at, last_error
      )
      VALUES(?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        source_kind     = excluded.source_kind,
        visibility      = excluded.visibility,
        last_indexed_at = excluded.last_indexed_at,
        last_message_at = excluded.last_message_at,
        last_error      = excluded.last_error,
        -- 成功一次即清零连续失败计数，并把停用原因清空（已恢复正常索引）
        consecutive_failures = 0,
        disabled_reason = NULL
    `)
    .run(
      sessionId,
      fields.sourceKind,
      fields.visibility,
      now,
      fields.lastMessageAt,
      fields.error ?? null
    );
}

/**
 * 记录一次索引失败。连续失败达到 `KB_MAX_CONSECUTIVE_FAILURES` 时自动停索引
 * （`index_enabled=0`），并把原因留在 `last_error`；成功一次由
 * `markSessionIndexed` 清零。恢复入口见 `setSessionIndexEnabled(true)`。
 */
export function markSessionError(
  sessionId: string,
  error: string,
  meta?: { sourceKind?: string; visibility?: string }
): { failures: number; disabled: boolean } {
  const safe = error.slice(0, 300);
  const now = new Date().toISOString();
  getKbDb()
    .prepare(`
      INSERT INTO kb_sessions(
        session_id, index_enabled, source_kind, visibility,
        last_indexed_at, last_error, consecutive_failures, disabled_reason
      )
      VALUES(?, 1, ?, ?, ?, ?, 1, NULL)
      ON CONFLICT(session_id) DO UPDATE SET
        consecutive_failures = kb_sessions.consecutive_failures + 1,
        index_enabled = CASE
          WHEN kb_sessions.consecutive_failures + 1 >= ? THEN 0
          ELSE kb_sessions.index_enabled
        END,
        disabled_reason = CASE
          WHEN kb_sessions.consecutive_failures + 1 >= ? THEN 'auto_failure'
          ELSE kb_sessions.disabled_reason
        END,
        last_error = excluded.last_error,
        last_indexed_at = excluded.last_indexed_at
    `)
    .run(
      sessionId,
      meta?.sourceKind ?? 'direct',
      meta?.visibility ?? 'normal',
      now,
      safe,
      KB_MAX_CONSECUTIVE_FAILURES,
      KB_MAX_CONSECUTIVE_FAILURES
    );

  const state = getSessionState(sessionId);
  const failures = Number(state?.consecutive_failures ?? 1);
  return {
    failures,
    disabled: state ? state.index_enabled === 0 : false,
  };
}

export function insertChunk(row: KbChunkRow): boolean {
  const result = getKbDb()
    .prepare(`
      INSERT OR IGNORE INTO kb_chunks(
        id, event_hash, content_hash, session_id, message_ids,
        agent_id, author_agent_id, workspace_key, project_id,
        role, source_kind, visibility, is_excluded,
        summary, content, token_count, time_start, time_end,
        redacted_count, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.id,
      row.event_hash,
      row.content_hash,
      row.session_id,
      row.message_ids,
      row.agent_id,
      row.author_agent_id,
      row.workspace_key,
      row.project_id,
      row.role,
      row.source_kind,
      row.visibility,
      row.is_excluded,
      row.summary,
      row.content,
      row.token_count,
      row.time_start,
      row.time_end,
      row.redacted_count,
      row.indexed_at
    );
  return Number(result.changes) > 0;
}

export function getLastChunk(sessionId: string): { id: string; message_ids: string; time_end: string } | undefined {
  return getKbDb()
    .prepare(
      'SELECT id, message_ids, time_end FROM kb_chunks WHERE session_id = ? ORDER BY time_end DESC, rowid DESC LIMIT 1'
    )
    .get(sessionId) as unknown as { id: string; message_ids: string; time_end: string } | undefined;
}

export function deleteSessionChunks(sessionId: string): number {
  const result = getKbDb().prepare('DELETE FROM kb_chunks WHERE session_id = ?').run(sessionId);
  return Number(result.changes);
}

export function deleteAllChunks(): number {
  const result = getKbDb().prepare('DELETE FROM kb_chunks').run();
  return Number(result.changes);
}

export function deleteSessionState(sessionId: string): void {
  getKbDb().prepare('DELETE FROM kb_sessions WHERE session_id = ?').run(sessionId);
  getKbDb().prepare('DELETE FROM kb_chunks WHERE session_id = ?').run(sessionId);
}

export function countChunks(sessionId?: string): number {
  const row = sessionId
    ? (getKbDb()
        .prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE session_id = ?')
        .get(sessionId) as { n: number })
    : (getKbDb().prepare('SELECT COUNT(*) AS n FROM kb_chunks').get() as { n: number });
  return Number(row?.n ?? 0);
}

/* ══════════════ 向量层（P3） ══════════════ */

export function upsertChunkVector(
  chunkId: string,
  vec: Buffer,
  provider: string = KB_VECTOR_PROVIDER_ID,
  dim = vec.byteLength / 4
): void {
  getKbDb()
    .prepare(`
      INSERT INTO kb_vectors(chunk_id, provider, dim, vec, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        provider = excluded.provider,
        dim = excluded.dim,
        vec = excluded.vec,
        updated_at = excluded.updated_at
    `)
    .run(chunkId, provider, dim, vec, new Date().toISOString());
}

export function countChunkVectors(provider: string = KB_VECTOR_PROVIDER_ID): number {
  const row = getKbDb()
    .prepare('SELECT COUNT(*) AS n FROM kb_vectors WHERE provider = ?')
    .get(provider) as { n: number };
  return Number(row?.n ?? 0);
}

export function deleteAllChunkVectors(): number {
  const result = getKbDb().prepare('DELETE FROM kb_vectors').run();
  return Number(result.changes);
}

/** 找出还没有当前 provider 向量的切片，供启动时增量回填。 */
export function listChunksMissingVector(
  provider: string = KB_VECTOR_PROVIDER_ID,
  limit = 500
): Array<{ id: string; content: string; summary: string }> {
  return getKbDb()
    .prepare(`
      SELECT c.id, c.content, c.summary
      FROM kb_chunks c
      LEFT JOIN kb_vectors v ON v.chunk_id = c.id AND v.provider = ?
      WHERE v.chunk_id IS NULL
      ORDER BY c.time_end DESC
      LIMIT ?
    `)
    .all(provider, limit) as unknown as Array<{ id: string; content: string; summary: string }>;
}

/* ══════════════ 体积治理（P3） ══════════════ */

export interface PruneOptions {
  /** 按会话清理：删掉这些会话的切片与会话状态（用户显式选择） */
  sessionIds?: string[];
  /** 按时间清理：删掉早于 N 天的切片（0/缺省 = 不按时间清理） */
  olderThanDays?: number;
  /** 按大小清理：超过该字节数就删最旧的切片（缺省取 KB_MAX_DB_BYTES） */
  maxBytes?: number;
  /** 按条数清理：超过该片数就删最旧的切片（缺省取 KB_MAX_CHUNKS） */
  maxChunks?: number;
  dryRun?: boolean;
}

export interface PruneResult {
  deletedChunks: number;
  deletedSessions: number;
  beforeBytes: number;
  afterBytes: number;
  chunkCount: number;
  vectorCount: number;
  vacuumed: boolean;
}

function dbSizeBytes(): number {
  let size = 0;
  try {
    size = fs.statSync(kbDbPath()).size;
  } catch {
    size = 0;
  }
  // WAL 里的数据还没并进主文件，估算体积时一并算上。
  try {
    size += fs.statSync(`${kbDbPath()}-wal`).size;
  } catch {
    /* 没有 WAL 文件 */
  }
  return size;
}

/**
 * 索引体积清理。
 *
 * 三种口径互不冲突，按顺序执行：
 *   1. `sessionIds` —— 显式按会话；
 *   2. `olderThanDays` —— 按时间；
 *   3. `maxBytes` / `maxChunks` —— 按大小/条数，从最旧的切片开始删。
 *
 * 删除走 `DELETE FROM kb_chunks`，FTS 与向量由触发器同步清理。
 * 有实际删除时才 VACUUM（需要先 checkpoint，且不能在事务里做）。
 */
export function pruneKnowledgeBase(options: PruneOptions = {}): PruneResult {
  const beforeBytes = dbSizeBytes();
  const beforeChunks = countChunks();
  let planned = 0;
  let plannedSessions = 0;

  const sessionIds = [...new Set((options.sessionIds ?? []).filter(Boolean))];
  if (sessionIds.length) {
    for (const sessionId of sessionIds) {
      planned += countChunks(sessionId);
      if (getSessionState(sessionId)) plannedSessions += 1;
    }
  }

  const days = Number(options.olderThanDays ?? 0);
  if (Number.isFinite(days) && days > 0) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const row = getKbDb()
      .prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE time_end < ?')
      .get(cutoff) as { n: number };
    planned += Number(row?.n ?? 0);
  }

  const maxBytes = Number(options.maxBytes ?? KB_MAX_DB_BYTES);
  const maxChunks = Number(options.maxChunks ?? KB_MAX_CHUNKS);
  const projectedChunks = Math.max(0, beforeChunks - planned);
  const avgBytes = beforeChunks > 0 ? beforeBytes / beforeChunks : 0;
  const byBytes = maxBytes > 0 && avgBytes > 0
    ? Math.ceil(Math.max(0, beforeBytes - maxBytes) / avgBytes)
    : 0;
  const byCount = maxChunks > 0 ? Math.max(0, projectedChunks - maxChunks) : 0;
  const sizeDeletes = Math.max(byBytes, byCount);

  if (options.dryRun) {
    return {
      deletedChunks: planned + sizeDeletes,
      deletedSessions: plannedSessions,
      beforeBytes,
      afterBytes: beforeBytes,
      chunkCount: beforeChunks,
      vectorCount: countChunkVectors(),
      vacuumed: false,
    };
  }

  let deletedChunks = 0;
  let deletedSessions = 0;

  if (sessionIds.length || (Number.isFinite(days) && days > 0)) {
    deletedChunks += inKbTransaction(() => {
      let removed = 0;
      for (const sessionId of sessionIds) {
        removed += deleteSessionChunks(sessionId);
        if (getSessionState(sessionId)) {
          deleteSessionState(sessionId);
          deletedSessions += 1;
        }
      }
      if (Number.isFinite(days) && days > 0) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const result = getKbDb().prepare('DELETE FROM kb_chunks WHERE time_end < ?').run(cutoff);
        removed += Number(result.changes);
      }
      return removed;
    });
  }

  if (sizeDeletes > 0) {
    deletedChunks += inKbTransaction(() => {
      const result = getKbDb()
        .prepare(`
          DELETE FROM kb_chunks WHERE id IN (
            SELECT id FROM kb_chunks ORDER BY time_end ASC, rowid ASC LIMIT ?
          )
        `)
        .run(sizeDeletes);
      return Number(result.changes);
    });
  }

  let vacuumed = false;
  if (deletedChunks > 0) {
    try {
      getKbDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
      getKbDb().exec('VACUUM');
      vacuumed = true;
    } catch (err) {
      console.warn('[KB] VACUUM 失败（不影响已删除的数据）:', err);
    }
  }

  const result: PruneResult = {
    deletedChunks,
    deletedSessions,
    beforeBytes,
    afterBytes: dbSizeBytes(),
    chunkCount: countChunks(),
    vectorCount: countChunkVectors(),
    vacuumed,
  };
  console.log(
    `[KB] 体积清理：删除 ${result.deletedChunks} 片 / ${result.deletedSessions} 会话，` +
      `${(beforeBytes / 1024 / 1024).toFixed(1)}MB → ${(result.afterBytes / 1024 / 1024).toFixed(1)}MB`
  );
  return result;
}

/**
 * 自动治理入口：每小时最多检查一次；只处理「超过硬上限」的情况，
 * 从最旧的切片开始删。时间清理默认不启用，必须显式调用 `pruneKnowledgeBase`。
 */
export function enforceKbLimits(now = new Date()): PruneResult | null {
  const last = getMeta('limits.last_check_at');
  if (last) {
    const elapsed = now.getTime() - new Date(last).getTime();
    if (elapsed >= 0 && elapsed < KB_LIMIT_CHECK_INTERVAL_MS) return null;
  }
  const stats = getStats();
  setMeta('limits.last_check_at', now.toISOString());
  if (stats.sizeBytes <= KB_MAX_DB_BYTES && stats.chunkCount <= KB_MAX_CHUNKS) return null;
  const result = pruneKnowledgeBase({
    maxBytes: KB_MAX_DB_BYTES,
    maxChunks: KB_MAX_CHUNKS,
    olderThanDays: KB_RETENTION_DAYS || undefined,
  });
  setMeta('limits.last_prune_at', now.toISOString());
  return result;
}

export function getStats(): KbStats {
  const dbPath = kbDbPath();
  const sessions = listSessionStates();
  const disabled = sessions.filter(s => s.index_enabled === 0);
  return {
    dbPath,
    // 主文件 + WAL：只看主文件会在 WAL 未 checkpoint 时低报真实占用。
    sizeBytes: dbSizeBytes(),
    chunkCount: countChunks(),
    sessionCount: sessions.length,
    disabledSessionCount: disabled.length,
    disabledByReason: {
      user: disabled.filter(s => s.disabled_reason === 'user').length,
      autoFailure: disabled.filter(s => s.disabled_reason === 'auto_failure').length,
    },
    failedSessionCount: sessions.filter(s => s.index_enabled !== 0 && s.last_error).length,
    vectorCount: countChunkVectors(),
    limits: {
      maxBytes: KB_MAX_DB_BYTES,
      maxChunks: KB_MAX_CHUNKS,
      retentionDays: KB_RETENTION_DAYS,
    },
    lastBackfillAt: getMeta('last_backfill_at'),
    scopePolicy: getScopePolicy(),
  };
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * 整库重建（保留文件，不删用户文件）。
 *
 * 先删触发器和虚拟表，再删普通表，最后重新建 schema。调用方负责回填。
 */
export function resetSchema(): void {
  const conn = getKbDb();
  conn.exec(`
    DROP TRIGGER IF EXISTS kb_chunks_ai;
    DROP TRIGGER IF EXISTS kb_chunks_ad;
    DROP TRIGGER IF EXISTS kb_chunks_au;
    DROP TABLE IF EXISTS kb_vectors;
    DROP TABLE IF EXISTS kb_chunks_fts;
    DROP TABLE IF EXISTS kb_chunks;
    DROP TABLE IF EXISTS kb_sessions;
    DROP TABLE IF EXISTS kb_meta;
  `);
  createSchema(conn);
}
