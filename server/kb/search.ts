/**
 * 检索（P1）：FTS5 trigram + BM25 + snippet；中文查询不足 3 字符走 LIKE 兜底。
 *
 * ## 范围为什么在这里收口
 *
 * 调用方只传 `sessionId + scope`，工作区/项目由服务端从会话里查出来，
 * 不信任请求里的任意路径。`buildScopeWhere()` 是唯一的 WHERE 生成器：
 * 本项目 / 全部在没有显式开启时直接抛错，连 SQL 都不会拼出来。
 */

import * as chatDb from '../db.js';
import { normalizeProjectPath } from '../project-key.js';
import { getKbDb, getScopePolicy, type KbScopePolicy } from './store.js';
import { findRedactionResidue, redactForStorage } from './redact.js';

export type KbScope = 'session' | 'workspace' | 'project' | 'all';

export const DEFAULT_SCOPE: KbScope = 'workspace';
export const DEFAULT_TOP_K = 4;
export const DEFAULT_MAX_TOKENS = 1600;

export class KbSearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KbSearchError';
    this.code = code;
  }
}

export class KbScopeDeniedError extends KbSearchError {
  constructor(scope: KbScope) {
    super('knowledge_base_scope_denied', `范围 ${scope} 未开启`);
    this.name = 'KbScopeDeniedError';
  }
}

export interface KbScopeContext {
  sessionId: string;
  workspaceKey: string | null;
  projectId: string | null;
  projectPath: string | null;
  /** 当前会话是单聊还是群聊；群聊在 session 范围内可检索自己的 source_only 切片。 */
  sourceKind: 'direct' | 'group';
}

export interface KbScopeWhere {
  sql: string;
  params: string[];
  applied: KbScope;
}

export function resolveScopeContext(sessionId: string): KbScopeContext {
  const session = chatDb.getSession(sessionId);
  if (!session) throw new KbSearchError('unknown_session', '会话不存在');
  const project = chatDb.getSessionProject(sessionId);
  return {
    sessionId,
    workspaceKey: normalizeProjectPath(session.cwd ?? '') || null,
    projectId: project?.id ?? null,
    projectPath: project?.path ?? null,
    sourceKind: session.kind === 'group' ? 'group' : 'direct',
  };
}

/**
 * 唯一允许生成范围 WHERE 的函数。
 *
 * 本项目 / 全部必须由 `policy` 显式放行；否则抛 `KbScopeDeniedError`。
 * 这里返回的参数全部走占位符，不做字符串拼接。
 */
export function buildScopeWhere(
  scope: KbScope,
  context: KbScopeContext,
  policy: KbScopePolicy
): KbScopeWhere {
  switch (scope) {
    case 'session':
      return {
        sql: 'c.session_id = ?',
        params: [context.sessionId],
        applied: scope,
      };

    case 'workspace':
      // 默认范围 = 本会话 + 本工作区。无 cwd 的会话没有工作区键，
      // 此时至少保证它自己的历史可检索，而不是直接 0 命中。
      if (!context.workspaceKey) {
        return { sql: 'c.session_id = ?', params: [context.sessionId], applied: scope };
      }
      return {
        sql: '(c.workspace_key = ? OR c.session_id = ?)',
        params: [context.workspaceKey, context.sessionId],
        applied: scope,
      };

    case 'project': {
      if (!policy.allowProject) throw new KbScopeDeniedError(scope);
      if (context.projectId && context.projectPath) {
        return {
          sql: `(c.project_id = ? OR c.workspace_key = ? OR c.workspace_key LIKE ? ESCAPE '\\')`,
          params: [
            context.projectId,
            context.projectPath,
            `${escapeLike(context.projectPath)}/%`,
          ],
          applied: scope,
        };
      }
      if (context.projectId) {
        return { sql: 'c.project_id = ?', params: [context.projectId], applied: scope };
      }
      if (context.workspaceKey) {
        return {
          sql: 'c.workspace_key = ?',
          params: [context.workspaceKey],
          applied: scope,
        };
      }
      return { sql: '0 = 1', params: [], applied: scope };
    }

    case 'all':
      if (!policy.allowAll) throw new KbScopeDeniedError(scope);
      return { sql: '1 = 1', params: [], applied: scope };

    default:
      throw new KbSearchError('invalid_scope', '未知的检索范围');
  }
}

export interface KbSearchOptions {
  query: string;
  sessionId: string;
  scope?: KbScope;
  topK?: number;
  maxTokens?: number;
  /** 不传则读 kb_meta 里的用户策略 */
  policy?: KbScopePolicy;
}

export interface KbSearchHit {
  citationId: string;
  sessionId: string;
  agentId: string | null;
  authorAgentId: string | null;
  workspaceKey: string | null;
  projectId: string | null;
  role: string;
  sourceType: 'direct' | 'group';
  visibility: 'normal' | 'source_only';
  summary: string;
  snippet: string;
  /** 脱敏后的完整正文，供来源卡片展开 */
  content: string;
  messageIds: string[];
  tokenCount: number;
  timeStart: string;
  timeEnd: string;
  score: number;
  redactedCount: number;
}

export interface KbSearchResponse {
  query: string;
  scope: KbScope;
  mode: 'fts' | 'like';
  scopeApplied: KbScope;
  hits: KbSearchHit[];
  tokensUsed: number;
  /** 出库二次扫描被拦下的条数（fail-closed） */
  filteredOut: number;
  topK: number;
  maxTokens: number;
}

interface ChunkSearchRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  author_agent_id: string | null;
  workspace_key: string | null;
  project_id: string | null;
  role: string;
  source_kind: string;
  visibility: string;
  summary: string;
  content: string;
  message_ids: string;
  token_count: number;
  time_start: string;
  time_end: string;
  redacted_count: number;
  snippet_text?: string;
  rank?: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function clampTopK(value: number | undefined): number {
  const n = Number.isFinite(value) ? Number(value) : DEFAULT_TOP_K;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

function normalizeMaxTokens(value: number | undefined): number {
  const n = Number.isFinite(value) ? Number(value) : DEFAULT_MAX_TOKENS;
  return Math.min(8000, Math.max(200, Math.floor(n)));
}

function termsOf(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map(term => term.trim())
    .filter(Boolean);
}

function ftsExpression(terms: string[]): string {
  return terms
    .map(term => `"${term.replace(/"/g, '""')}"`)
    .join(' AND ');
}

function hasShortTerm(terms: string[]): boolean {
  return terms.some(term => Array.from(term).length < 3);
}

/** LIKE 兜底时的片段：截命中词前后各 60 字，避免把整段正文塞回 UI。 */
function makeLikeSnippet(content: string, terms: string[]): string {
  const flat = content.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 60);
  const end = Math.min(flat.length, at + 120);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * 出库前二次扫描：只要还能洗出东西、或仍有残留，就整条丢弃。
 *
 * 这是 fail-closed，不是“尽量干净”——索引库要是被手工改过，宁可少一条
 * 来源，也不能把秘密回给模型。
 */
function sanitizeOutbound(value: string): string | null {
  const result = redactForStorage(value);
  if (result.redactedCount > 0) return null;
  if (findRedactionResidue(result.text).length > 0) return null;
  return result.text;
}

export function searchKnowledge(options: KbSearchOptions): KbSearchResponse {
  const query = String(options.query ?? '').trim();
  if (!query) throw new KbSearchError('empty_query', '查询不能为空');

  const scope = options.scope ?? DEFAULT_SCOPE;
  const policy = options.policy ?? getScopePolicy();
  const topK = clampTopK(options.topK);
  const maxTokens = normalizeMaxTokens(options.maxTokens);

  const context = resolveScopeContext(options.sessionId);
  const where = buildScopeWhere(scope, context, policy);

  // 群聊切片默认 visibility=source_only；只有「查自己」（session 范围）时
  // 才可见。workspace / project / all 一律保持不可见，避免群聊内容外溢。
  const visibilitySql =
    scope === 'session' && context.sourceKind === 'group'
      ? `(c.visibility = 'normal' OR c.visibility = 'source_only')`
      : `c.visibility = 'normal'`;

  const terms = termsOf(query);
  const useLike = Array.from(query).length < 3 || hasShortTerm(terms);

  const db = getKbDb();
  let rows: ChunkSearchRow[];
  let mode: 'fts' | 'like';

  if (useLike) {
    mode = 'like';
    const likeClauses = terms.map(() => `c.content LIKE ? ESCAPE '\\'`).join(' AND ');
    const params = terms.map(term => `%${escapeLike(term)}%`);
    rows = db
      .prepare(`
        SELECT c.*, 0 AS rank
        FROM kb_chunks c
        LEFT JOIN kb_sessions s ON s.session_id = c.session_id
        WHERE (${likeClauses})
          AND ${visibilitySql}
          AND c.is_excluded = 0
          AND COALESCE(s.index_enabled, 1) = 1
          AND (${where.sql})
        ORDER BY c.time_end DESC
        LIMIT ?
      `)
      .all(...params, ...where.params, topK + 4) as unknown as ChunkSearchRow[];
  } else {
    mode = 'fts';
    rows = db
      .prepare(`
        SELECT c.*,
               snippet(kb_chunks_fts, 0, '', '', ' … ', 40) AS snippet_text,
               bm25(kb_chunks_fts) AS rank
        FROM kb_chunks_fts
        JOIN kb_chunks c ON c.rowid = kb_chunks_fts.rowid
        LEFT JOIN kb_sessions s ON s.session_id = c.session_id
        WHERE kb_chunks_fts MATCH ?
          AND ${visibilitySql}
          AND c.is_excluded = 0
          AND COALESCE(s.index_enabled, 1) = 1
          AND (${where.sql})
        ORDER BY bm25(kb_chunks_fts) ASC
        LIMIT ?
      `)
      .all(ftsExpression(terms), ...where.params, topK + 4) as unknown as ChunkSearchRow[];
  }

  const hits: KbSearchHit[] = [];
  let tokensUsed = 0;
  let filteredOut = 0;

  for (const row of rows) {
    const safeContent = sanitizeOutbound(row.content);
    const safeSummary = sanitizeOutbound(row.summary);
    const safeSnippet = sanitizeOutbound(
      mode === 'fts' && row.snippet_text
        ? row.snippet_text
        : makeLikeSnippet(row.content, terms)
    );

    if (safeContent === null || safeSummary === null || safeSnippet === null) {
      filteredOut += 1;
      continue;
    }

    const tokenCount = Number(row.token_count ?? 0);
    if (hits.length > 0 && tokensUsed + tokenCount > maxTokens) break;
    if (hits.length >= topK) break;

    let messageIds: string[] = [];
    try {
      const parsed = JSON.parse(row.message_ids) as unknown;
      if (Array.isArray(parsed)) messageIds = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      messageIds = [];
    }

    hits.push({
      citationId: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      authorAgentId: row.author_agent_id,
      workspaceKey: row.workspace_key,
      projectId: row.project_id,
      role: row.role,
      sourceType: row.source_kind === 'group' ? 'group' : 'direct',
      visibility: row.visibility === 'source_only' ? 'source_only' : 'normal',
      summary: safeSummary,
      snippet: safeSnippet,
      content: safeContent,
      messageIds,
      tokenCount,
      timeStart: row.time_start,
      timeEnd: row.time_end,
      score: mode === 'fts' ? -(row.rank ?? 0) : 1,
      redactedCount: Number(row.redacted_count ?? 0),
    });
    tokensUsed += tokenCount;
  }

  return {
    query,
    scope,
    mode,
    scopeApplied: where.applied,
    hits,
    tokensUsed,
    filteredOut,
    topK,
    maxTokens,
  };
}
