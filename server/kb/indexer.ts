/**
 * 索引写入（P1）。
 *
 * 接线方式：`db.ts` 在消息提交后通过 `events.ts` 喊一声，本模块挂监听。
 * 索引失败只记告警，不反向影响聊天落库。
 *
 * 群聊规则：入库但 `visibility=source_only`，`agent_id` 置空，发言人写
 * `author_agent_id`。P1 检索只读 normal，所以群聊不会自动/主动进入回答。
 *
 * 「不索引」标记落在 `data/kb-optout.json`，不落在索引库里 —— 索引库损坏
 * 重建时这条隐私选择必须还在，否则敏感会话会被重新索引。
 */

import fs from 'node:fs';
import path from 'node:path';
import * as chatDb from '../db.js';
import { dataDirPath } from '../paths.js';
import { normalizeProjectPath } from '../project-key.js';
import { textOfBlocks } from '../../shared/blocks.js';
import {
  chunkMessages,
  estimateTokens,
  WINDOW_MAX_TOKENS,
  type ChunkWindow,
  type IndexableMessage,
} from './chunk.js';
import { KbRedactionError, assertRedactionClean, redactOrFail } from './redact.js';
import { setKbPersistSink, type KbPersistEvent } from './events.js';
import {
  countChunks,
  deleteAllChunks,
  deleteSessionChunks,
  getKbDb,
  getLastChunk,
  getScopePolicy,
  getSessionState,
  getStats,
  inKbTransaction,
  insertChunk,
  listSessionStates,
  markSessionError,
  markSessionIndexed,
  resetSchema,
  setMeta,
  setSessionIndexEnabled,
  sha256,
  type KbChunkRow,
} from './store.js';

const OPT_OUT_FILE = 'kb-optout.json';

export interface IndexSessionOptions {
  /** 强制重建整段会话（消息编辑/删除后使用） */
  force?: boolean;
  /** 只索引这个时间之后的会话消息（90 天回填） */
  since?: string;
}

export interface IndexSessionResult {
  sessionId: string;
  chunks: number;
  skipped: boolean;
  reason?: 'missing-session' | 'disabled' | 'empty' | 'up-to-date' | 'redaction-failed';
  /** 本次失败是否触发了「连续失败自动停索引」 */
  autoDisabled?: boolean;
}

export interface BackfillResult {
  sessions: number;
  indexedSessions: number;
  skippedSessions: number;
  messages: number;
  chunks: number;
  errors: number;
  since: string | null;
}

let initialized = false;
let bootBackfillStarted = false;

/* ══════════════ 「不索引」清单 ══════════════ */

function optOutPath(): string {
  return path.join(dataDirPath, OPT_OUT_FILE);
}

function readOptOut(): Set<string> {
  let raw: string;
  try {
    raw = fs.readFileSync(optOutPath(), 'utf8');
  } catch (err) {
    // 首次运行没有清单是正常的；读不到/解析不了则是 fail-closed：
    // 不能把损坏的排除清单当成「没有排除项」，否则敏感会话会被重新索引。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw new Error('不索引清单不可读，已停止索引以防误索引');
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
  } catch {
    /* 落到下面统一抛错 */
  }
  throw new Error('不索引清单格式损坏，已停止索引以防误索引');
}

function writeOptOut(next: Set<string>): void {
  fs.mkdirSync(dataDirPath, { recursive: true });
  const tmp = `${optOutPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...next].sort(), null, 2), 'utf8');
  fs.renameSync(tmp, optOutPath());
}

export function isSessionOptedOut(sessionId: string): boolean {
  return readOptOut().has(sessionId);
}

/** 供状态接口使用：排除清单数量（不依赖索引库） */
export function optedOutSessionIds(): string[] {
  return [...readOptOut()];
}

/* ══════════════ 取正文 ══════════════ */

/**
 * 只取对话正文：blocks 里只拼 text 块，忽略 tool / thinking。
 *
 * 老消息没有 blocks 时退回 content。工具调用与验证输出从来不走这里，
 * 所以不会进 FTS。
 */
export function dialogueTextOf(message: chatDb.DbMessage): string {
  if (message.blocks) {
    try {
      const blocks = JSON.parse(message.blocks) as Array<{ type?: string; text?: string }>;
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('\n');
        if (text.trim()) return text;
      }
    } catch {
      /* blocks 坏了就退回 content，不让一条脏数据拖垮整段会话 */
    }
  }
  return String(message.content ?? '');
}

function prepareMessages(messages: readonly chatDb.DbMessage[]): IndexableMessage[] {
  const out: IndexableMessage[] = [];
  for (const message of messages) {
    const raw = dialogueTextOf(message).trim();
    if (!raw) continue;
    // 入库前闸门：清洗 + 残留扫描，失败直接抛，整段会话不写
    const redacted = redactOrFail(raw);
    if (!redacted.text.trim()) continue;
    out.push({
      id: message.id,
      role: message.role,
      text: redacted.text,
      authorAgentId: message.author_agent_id ?? null,
      createdAt: message.created_at,
      redactedCount: redacted.redactedCount,
    });
  }
  return out;
}

/* ══════════════ 切片落库 ══════════════ */

function summaryOf(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 120)}…`;
}

function rowOf(
  session: chatDb.DbSession,
  window: ChunkWindow,
  indexedAt: string,
  projectId: string | null
): KbChunkRow {
  const messages = window.messages;
  const content = messages.map(m => m.text).join('\n\n');
  // 出库前闸门的前置版本：窗口拼起来后再查一次，避免拼接产生新的键值对
  assertRedactionClean(content);

  const first = messages[0];
  const last = messages[messages.length - 1];
  const contentHash = sha256(content.replace(/\s+/g, ' ').trim());
  const part = first.part ?? 0;
  const eventHash = sha256(
    `${session.id}\0${first.id}\0${last.id}\0${part}\0${contentHash}`
  );

  const roles = new Set(messages.map(m => m.role));
  const role = roles.size === 1 ? first.role : 'mixed';
  const authors = new Set(
    messages.map(m => m.authorAgentId).filter((v): v is string => Boolean(v))
  );
  const authorAgentId = authors.size === 1 ? [...authors][0] : null;

  const isGroup = session.kind === 'group';
  const sourceKind = isGroup ? 'group' : 'direct';

  return {
    id: `kb_${eventHash.slice(0, 24)}`,
    event_hash: eventHash,
    content_hash: contentHash,
    session_id: session.id,
    message_ids: JSON.stringify([...new Set(messages.map(m => m.id))]),
    agent_id: isGroup ? null : session.agent_id,
    author_agent_id: authorAgentId,
    workspace_key: normalizeProjectPath(session.cwd ?? '') || null,
    project_id: projectId,
    role,
    source_kind: sourceKind,
    visibility: isGroup ? 'source_only' : 'normal',
    is_excluded: 0,
    summary: summaryOf(content),
    content,
    token_count: estimateTokens(content),
    time_start: first.createdAt,
    time_end: last.createdAt,
    redacted_count: messages.reduce((sum, m) => sum + (m.redactedCount ?? 0), 0),
    indexed_at: indexedAt,
  };
}

function writeWindows(
  session: chatDb.DbSession,
  windows: ChunkWindow[],
  replace: boolean,
  lastMessageAt: string | null
): number {
  const indexedAt = new Date().toISOString();
  const projectId = chatDb.getSessionProject(session.id)?.id ?? null;
  const rows = windows.map(window => rowOf(session, window, indexedAt, projectId));

  return inKbTransaction(() => {
    if (replace) deleteSessionChunks(session.id);
    let inserted = 0;
    for (const row of rows) {
      if (insertChunk(row)) inserted += 1;
    }
    markSessionIndexed(session.id, {
      sourceKind: session.kind === 'group' ? 'group' : 'direct',
      visibility: session.kind === 'group' ? 'source_only' : 'normal',
      lastMessageAt,
      error: null,
    });
    return inserted;
  });
}

/* ══════════════ 单会话索引 ══════════════ */

export function indexSession(
  sessionId: string,
  options: IndexSessionOptions = {}
): IndexSessionResult {
  const session = chatDb.getSession(sessionId);
  if (!session) return { sessionId, chunks: 0, skipped: true, reason: 'missing-session' };

  if (isSessionOptedOut(sessionId)) {
    deleteSessionChunks(sessionId);
    return { sessionId, chunks: 0, skipped: true, reason: 'disabled' };
  }

  // 连续失败触发的自动停索引：不再重试，等用户手动恢复（PATCH indexed=true
  // 或整库重建），避免每个新消息都重复失败、把日志刷满。
  const state = getSessionState(sessionId);
  if (state && state.index_enabled === 0) {
    return { sessionId, chunks: 0, skipped: true, reason: 'disabled' };
  }

  // 索引库里的 kb_sessions.index_enabled 只是镜像；「不索引」以 JSON 清单为准。
  const allMessages = chatDb.getMessagesBySession(sessionId);
  const allPrepared = prepareMessages(allMessages);
  const prepared = options.since
    ? allPrepared.filter(m => m.createdAt >= options.since!)
    : allPrepared;

  if (prepared.length === 0) {
    markSessionIndexed(sessionId, {
      sourceKind: session.kind === 'group' ? 'group' : 'direct',
      visibility: session.kind === 'group' ? 'source_only' : 'normal',
      lastMessageAt: allPrepared.at(-1)?.createdAt ?? null,
    });
    return { sessionId, chunks: 0, skipped: true, reason: 'empty' };
  }

  const lastMessageAt = allPrepared.at(-1)?.createdAt ?? null;

  try {
    if (options.force) {
      return {
        sessionId,
        chunks: writeWindows(session, chunkMessages(prepared), true, lastMessageAt),
        skipped: false,
      };
    }

    if (!options.since) {
      const existing = getLastChunk(sessionId);
      if (existing) {
        const ids = JSON.parse(existing.message_ids) as string[];
        const lastId = ids[ids.length - 1];
        const index = prepared.findIndex(m => m.id === lastId);

        if (index >= 0) {
          if (index === prepared.length - 1) {
            return { sessionId, chunks: 0, skipped: true, reason: 'up-to-date' };
          }
          const previous = prepared[index];
          // 上一条是超长消息的分段时，窗口状态无法可靠续接，整段重建
          if (estimateTokens(previous.text) > WINDOW_MAX_TOKENS) {
            return {
              sessionId,
              chunks: writeWindows(session, chunkMessages(prepared), true, lastMessageAt),
              skipped: false,
            };
          }
          const tail = prepared.slice(index + 1);
          return {
            sessionId,
            chunks: writeWindows(session, chunkMessages(tail, previous), false, lastMessageAt),
            skipped: false,
          };
        }
        // 找不到锚点（消息被删/时间乱序）：整段重建
        return {
          sessionId,
          chunks: writeWindows(session, chunkMessages(prepared), true, lastMessageAt),
          skipped: false,
        };
      }
    }

    return {
      sessionId,
      chunks: writeWindows(session, chunkMessages(prepared), false, lastMessageAt),
      skipped: false,
    };
  } catch (err) {
    const code = err instanceof KbRedactionError ? 'redaction' : 'write';
    const failure = markSessionError(
      sessionId,
      `${code}: ${err instanceof Error ? err.message : String(err)}`,
      {
        sourceKind: session.kind === 'group' ? 'group' : 'direct',
        visibility: session.kind === 'group' ? 'source_only' : 'normal',
      }
    );
    if (err instanceof KbRedactionError) {
      return {
        sessionId,
        chunks: 0,
        skipped: true,
        reason: 'redaction-failed',
        autoDisabled: failure.disabled,
      };
    }
    throw err;
  }
}

/* ══════════════ 回填 / 重建 ══════════════ */

function backfill(options: { since?: string; force?: boolean }): BackfillResult {
  const sessions = chatDb.getAllSessions();
  const result: BackfillResult = {
    sessions: sessions.length,
    indexedSessions: 0,
    skippedSessions: 0,
    messages: 0,
    chunks: 0,
    errors: 0,
    since: options.since ?? null,
  };

  for (const session of sessions) {
    if (isSessionOptedOut(session.id)) {
      deleteSessionChunks(session.id);
      if (!getSessionState(session.id)) {
        setSessionIndexEnabled(session.id, false, {
          sourceKind: session.kind === 'group' ? 'group' : 'direct',
          visibility: session.kind === 'group' ? 'source_only' : 'normal',
        });
      }
      result.skippedSessions += 1;
      continue;
    }

    try {
      const messages = chatDb.getMessagesBySession(session.id);
      const scoped = options.since
        ? messages.filter(m => m.created_at >= options.since!)
        : messages;
      if (scoped.length === 0) {
        result.skippedSessions += 1;
        continue;
      }

      const indexed = indexSession(session.id, {
        force: options.force,
        since: options.since,
      });
      if (indexed.skipped && indexed.reason !== 'up-to-date') {
        result.skippedSessions += 1;
      } else {
        result.indexedSessions += 1;
        result.messages += scoped.length;
        result.chunks += indexed.chunks;
      }
    } catch (err) {
      result.errors += 1;
      console.warn(`[KB] 回填会话 ${session.id} 失败:`, err);
    }
  }

  setMeta('last_backfill_at', new Date().toISOString());
  return result;
}

/** 默认回填窗口：最近 90 天。 */
export function backfillRecent(days = 90): BackfillResult {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return backfill({ since: cutoff });
}

/** 手动全量回填：忽略时间窗口，逐会话重建切片。 */
export function backfillAll(): BackfillResult {
  return backfill({ force: true });
}

/**
 * 整库重建：保留 `kb.sqlite` 文件，先清空 schema 再全量回填。
 * `data/kb-optout.json` 不受影响，所以「不索引」选择不会丢。
 */
export function rebuildKnowledgeBase(): BackfillResult {
  // 重建会清空索引库。用户「手动关闭」属于隐私决定，必须跨重建保留；
  // 「连续失败自动停」则借这次重建重试一遍（重建本身就是恢复入口）。
  const userDisabled = listSessionStates().filter(
    s => s.index_enabled === 0 && s.disabled_reason === 'user'
  );
  resetSchema();
  for (const state of userDisabled) {
    setSessionIndexEnabled(state.session_id, false, {
      sourceKind: state.source_kind,
      visibility: state.visibility,
    });
  }
  attachPersistSink();
  const result = backfillAll();
  setMeta('rebuilt_at', new Date().toISOString());
  return result;
}

/* ══════════════ 会话开关 ══════════════ */

export function setSessionIndexed(sessionId: string, enabled: boolean): IndexSessionResult {
  const session = chatDb.getSession(sessionId);
  if (!session) return { sessionId, chunks: 0, skipped: true, reason: 'missing-session' };

  const optOut = readOptOut();
  if (enabled) optOut.delete(sessionId);
  else optOut.add(sessionId);
  writeOptOut(optOut);

  setSessionIndexEnabled(sessionId, enabled, {
    sourceKind: session.kind === 'group' ? 'group' : 'direct',
    visibility: session.kind === 'group' ? 'source_only' : 'normal',
  });

  if (!enabled) {
    deleteSessionChunks(sessionId);
    return { sessionId, chunks: 0, skipped: true, reason: 'disabled' };
  }

  return indexSession(sessionId, { force: true });
}

/* ══════════════ 事件接线 ══════════════ */

function handlePersistEvent(event: KbPersistEvent): void {
  switch (event.type) {
    case 'messages-upserted':
      indexSession(event.sessionId);
      break;
    case 'message-updated':
    case 'message-deleted':
      indexSession(event.sessionId, { force: true });
      break;
    case 'messages-deleted':
    case 'session-deleted':
      deleteSessionChunks(event.sessionId);
      break;
    case 'all-cleared':
      deleteAllChunks();
      break;
  }
}

function attachPersistSink(): void {
  setKbPersistSink(handlePersistEvent);
}

/**
 * 启动入口。默认后台跑一次最近 90 天回填；测试可 `{ backfill: false }`
 * 后自己控制时序。
 */
export function bootKnowledgeBase(options: { backfill?: boolean } = {}): ReturnType<typeof getStats> {
  getKbDb();
  attachPersistSink();

  if (options.backfill !== false && !bootBackfillStarted) {
    bootBackfillStarted = true;
    setTimeout(() => {
      try {
        const result = backfillRecent(90);
        console.log(
          `[KB] 启动回填完成：${result.indexedSessions}/${result.sessions} 个会话，` +
            `${result.chunks} 片，错误 ${result.errors}`
        );
      } catch (err) {
        console.warn('[KB] 启动回填失败:', err);
      }
    }, 0);
  }

  initialized = true;
  return getStats();
}

export function isKnowledgeBaseReady(): boolean {
  return initialized;
}

export function knowledgeBaseStatus(): ReturnType<typeof getStats> & {
  optedOut: number;
  initialized: boolean;
  policy: ReturnType<typeof getScopePolicy>;
  /** 已停索引的会话：界面据此区分「你手动关闭」与「连续失败自动停」。 */
  disabledSessions: Array<{
    sessionId: string;
    reason: 'user' | 'auto_failure' | null;
    sourceKind: string;
    consecutiveFailures: number;
    lastError: string | null;
  }>;
} {
  return {
    ...getStats(),
    optedOut: readOptOut().size,
    initialized,
    policy: getScopePolicy(),
    disabledSessions: listSessionStates()
      .filter(s => s.index_enabled === 0)
      .map(s => ({
        sessionId: s.session_id,
        reason: s.disabled_reason,
        sourceKind: s.source_kind,
        consecutiveFailures: s.consecutive_failures,
        lastError: s.last_error,
      })),
  };
}

/** 仅测试/诊断使用：当前库里的切片总数（按会话可查）。 */
export function debugChunkCount(sessionId?: string): number {
  return countChunks(sessionId);
}
