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
import { getKbDb, getScopePolicy, countChunkVectors, type KbScopePolicy } from './store.js';
import { findRedactionResidue, redactForStorage } from './redact.js';
import {
  KB_VECTOR_MIN_SIMILARITY,
  KB_VECTOR_PROVIDER_ID,
  KB_VECTOR_SCAN_LIMIT,
  cosineSimilarity,
  deserializeVector,
  embedText,
  isVectorLayerEnabled,
} from './embedding.js';

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
  /** P3 去重：被合并进来的近似重复 citationId（保留的那条才带此字段）。 */
  mergedCitationIds?: string[];
}

export interface KbSearchResponse {
  query: string;
  scope: KbScope;
  /** 词法通道的模式；P3 起与 `retrieval` 分开，避免改变老调用方的判断。 */
  mode: 'fts' | 'like';
  scopeApplied: KbScope;
  hits: KbSearchHit[];
  tokensUsed: number;
  /** 出库二次扫描被拦下的条数（fail-closed） */
  filteredOut: number;
  topK: number;
  maxTokens: number;
  /** P3：'bm25' 表示纯词法（含自动降级），'hybrid' 表示向量参与 RRF 融合。 */
  retrieval: 'bm25' | 'hybrid';
  /** 进入融合的向量候选数；0 表示本次没有向量召回。 */
  vectorCandidates: number;
  /** 近似去重合并掉的条数。 */
  dedupedCount: number;
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

/* ══════════════ P3：近似去重 ══════════════ */

/**
 * 去重口径（写死在这里，改阈值必须同步改闸门）：
 *   - 3-gram Jaccard ≥ 0.82 → 判为近似重复；
 *   - 或「短文本几乎完全被长文本包含」（containment ≥ 0.9 且长度比 ≤ 0.75）
 *     → 判为同一内容的截断版本。
 *
 * 保留规则：长度差 ≥ 1.2 倍时保留更全的一条；否则保留时间更新的那条
 * （同一条内容在不同会话/多轮被重复索引时，新的通常代表用户最后的表述）。
 */
const KB_DEDUP_JACCARD = 0.82;
const KB_DEDUP_CONTAINMENT = 0.9;
const KB_DEDUP_SUBSET_RATIO = 0.75;

interface PreparedHit {
  hit: KbSearchHit;
  grams: Set<string>;
  length: number;
}

function shinglesOf(text: string): Set<string> {
  const plain = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const chars = Array.from(plain);
  const out = new Set<string>();
  if (chars.length <= 3) {
    if (plain) out.add(plain);
    return out;
  }
  for (let i = 0; i + 3 <= chars.length; i += 1) {
    out.add(chars.slice(i, i + 3).join(''));
  }
  return out;
}

/**
 * 向量通道只负责「补召回」，不负责「猜主题」。
 *
 * 本地向量是字符 n-gram 投影，没有真语义；如果不要求与查询有任何字符片段
 * 重叠，纯哈希相似度会把同工作区里完全无关的会话（甚至跨主题）拉进 topK。
 * 因此**向量新增候选**必须与查询共享至少一个 3-gram；已经是 BM25 命中的
 * 候选不受此限（它们本来就有词法相关性）。
 */
function sharesQueryGram(query: string, content: string): boolean {
  const queryGrams = shinglesOf(query);
  if (!queryGrams.size) return false;
  const contentGrams = shinglesOf(content);
  for (const gram of queryGrams) if (contentGrams.has(gram)) return true;
  return false;
}

function isNearDuplicate(a: PreparedHit, b: PreparedHit): boolean {
  if (!a.grams.size || !b.grams.size) return false;
  let intersection = 0;
  const [small, large] = a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams];
  for (const gram of small) if (large.has(gram)) intersection += 1;

  const union = a.grams.size + b.grams.size - intersection;
  if (union > 0 && intersection / union >= KB_DEDUP_JACCARD) return true;

  const containment = intersection / Math.min(a.grams.size, b.grams.size);
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return containment >= KB_DEDUP_CONTAINMENT && ratio <= KB_DEDUP_SUBSET_RATIO;
}

/** 两条近似重复里选保留项：更全优先，其次更新。 */
function preferNewerOrFuller(candidate: PreparedHit, kept: PreparedHit): boolean {
  if (candidate.length >= kept.length * 1.2) return true;
  if (kept.length >= candidate.length * 1.2) return true;
  return candidate.hit.timeEnd >= kept.hit.timeEnd;
}

/** 把 drop 的引用信息并进 keep（citationId 与 messageIds 都保留）。 */
function mergeDuplicate(keep: PreparedHit, drop: PreparedHit): void {
  const merged = keep.hit.mergedCitationIds ?? [];
  merged.push(drop.hit.citationId);
  if (drop.hit.mergedCitationIds) merged.push(...drop.hit.mergedCitationIds);
  keep.hit.mergedCitationIds = [...new Set(merged)];
  keep.hit.messageIds = [...new Set([...keep.hit.messageIds, ...drop.hit.messageIds])];
}

interface RankedChunkRow {
  row: ChunkSearchRow;
  lexRank?: number;
  vecRank?: number;
  similarity?: number;
}

interface VectorSearchRow extends ChunkSearchRow {
  vec: unknown;
  dim: number;
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

  // P3：群聊切片（source_only）从「仅本群可见」放开到「用户可见的群聊内容」。
  // 本地库里的群会话都是当前用户创建的，因此 workspace/project/all 也允许
  // 读到群内容；真正的越权边界仍由范围策略（project/all 需显式 allow）负责：
  // 未开启时 `buildScopeWhere` 照旧抛 KbScopeDeniedError
  // （code=knowledge_base_scope_denied），这里只是放宽「可见性」不是放宽「授权」。
  //
  // ## 决策（2026-11-04，已与产品确认）：维持「本工作区可见」，不收回到单群会话
  //
  // 不收紧的理由：
  //   - 群聊内容同样是当前用户自己的对话，只是多 Agent 参与；按群隔离会让
  //     用户在同一工作区的单聊里「明明说过却搜不到」，与知识库的目的相悖；
  //   - 现有隔离粒度已经是「工作区/项目/全部 + 显式授权」，再加一层群维度
  //     收益低、规则复杂（跨群成员关系无法在本地库里可靠判定）。
  //
  // 触发重新评估的条件（满足任意一条再收紧到「同一群会话/群成员可见」）：
  //   - 出现多用户/多租户共用同一个 `kb.sqlite`（当前设计假设单用户本地库）；
  //   - 群聊里出现「用户明确不希望在其他会话被引用」的内容（如第三方隐私、
  //     跨团队敏感信息），且现有范围开关无法表达这种诉求；
  //   - 产品要求按群成员身份做检索授权，而不是按工作区边界。
  //
  // 收紧方式：在该 WHERE 再加 `OR c.session_id = 当前会话` 之类的群成员判定，
  // 越权语义保持不变（仍由 buildScopeWhere 抛 knowledge_base_scope_denied）。
  const visibilitySql = `(c.visibility = 'normal' OR (c.source_kind = 'group' AND c.visibility = 'source_only'))`;

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

  /* ── P3：向量召回 + RRF 融合 ── */
  const candidates = new Map<string, RankedChunkRow>();
  rows.forEach((row, index) => candidates.set(row.id, { row, lexRank: index }));

  let vectorCandidatesCount = 0;
  if (isVectorLayerEnabled() && countChunkVectors(KB_VECTOR_PROVIDER_ID) > 0) {
    const queryVector = embedText(query);
    const vectorRows = db
      .prepare(`
        SELECT c.*, v.vec AS vec, v.dim AS dim
        FROM kb_vectors v
        JOIN kb_chunks c ON c.id = v.chunk_id
        LEFT JOIN kb_sessions s ON s.session_id = c.session_id
        WHERE v.provider = ?
          AND ${visibilitySql}
          AND c.is_excluded = 0
          AND COALESCE(s.index_enabled, 1) = 1
          AND (${where.sql})
        ORDER BY c.time_end DESC
        LIMIT ?
      `)
      .all(
        KB_VECTOR_PROVIDER_ID,
        ...where.params,
        KB_VECTOR_SCAN_LIMIT
      ) as unknown as VectorSearchRow[];

    const lexicalIds = new Set(rows.map(row => row.id));
    const scored = vectorRows
      .map(row => {
        const vec = deserializeVector(row.vec, Number(row.dim));
        return vec ? { row, similarity: cosineSimilarity(queryVector, vec) } : null;
      })
      .filter(
        (item): item is { row: VectorSearchRow; similarity: number } =>
          item !== null &&
          item.similarity >= KB_VECTOR_MIN_SIMILARITY &&
          (lexicalIds.has(item.row.id) || sharesQueryGram(query, item.row.content))
      )
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK + 8);

    vectorCandidatesCount = scored.length;
    scored.forEach((item, index) => {
      const existing = candidates.get(item.row.id);
      if (existing) {
        existing.vecRank = index;
        existing.similarity = item.similarity;
      } else {
        candidates.set(item.row.id, {
          row: item.row,
          vecRank: index,
          similarity: item.similarity,
        });
      }
    });
  }

  const retrieval: 'bm25' | 'hybrid' = vectorCandidatesCount > 0 ? 'hybrid' : 'bm25';

  // RRF：两路排名各自贡献 1/(k+rank)，不比较 BM25 与余弦的原始分值。
  const RRF_K = 60;
  const fused = [...candidates.values()]
    .map(item => ({
      item,
      score:
        (item.lexRank !== undefined ? 1 / (RRF_K + item.lexRank + 1) : 0) +
        (item.vecRank !== undefined ? 1 / (RRF_K + item.vecRank + 1) : 0),
    }))
    .sort(
      (a, b) =>
        b.score - a.score || b.item.row.time_end.localeCompare(a.item.row.time_end)
    );

  /* ── 出库脱敏 + 近似去重 ── */
  const prepared: PreparedHit[] = [];
  let filteredOut = 0;

  for (const { item } of fused) {
    const row = item.row;
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

    let messageIds: string[] = [];
    try {
      const parsed = JSON.parse(row.message_ids) as unknown;
      if (Array.isArray(parsed)) messageIds = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      messageIds = [];
    }

    prepared.push({
      hit: {
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
        tokenCount: Number(row.token_count ?? 0),
        timeStart: row.time_start,
        timeEnd: row.time_end,
        score:
          mode === 'fts' && row.rank !== undefined
            ? -(row.rank ?? 0)
            : (item.similarity ?? 1),
        redactedCount: Number(row.redacted_count ?? 0),
      },
      grams: shinglesOf(safeContent),
      length: safeContent.length,
    });
  }

  let dedupedCount = 0;
  const kept: PreparedHit[] = [];
  for (const candidate of prepared) {
    let merged = false;
    for (let i = 0; i < kept.length; i += 1) {
      const rep = kept[i]!;
      if (!isNearDuplicate(candidate, rep)) continue;

      if (preferNewerOrFuller(candidate, rep)) {
        // 新来的更全/更新：吸收旧代表后原位替换。
        mergeDuplicate(candidate, rep);
        kept[i] = candidate;
      } else {
        mergeDuplicate(rep, candidate);
      }
      dedupedCount += 1;
      merged = true;
      break;
    }
    if (!merged) kept.push(candidate);
  }

  const hits: KbSearchHit[] = [];
  let tokensUsed = 0;
  for (const item of kept) {
    if (hits.length >= topK) break;
    if (hits.length > 0 && tokensUsed + item.hit.tokenCount > maxTokens) break;
    hits.push(item.hit);
    tokensUsed += item.hit.tokenCount;
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
    retrieval,
    vectorCandidates: vectorCandidatesCount,
    dedupedCount,
  };
}
