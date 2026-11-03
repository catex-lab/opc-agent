/** 知识库 P1 界面用到的类型 —— 字段与 server/kb 的返回体一一对应。 */

export type KbScope = 'session' | 'workspace' | 'project' | 'all';

export type KbDisabledReason = 'user' | 'auto_failure';

export interface KbScopePolicy {
  allowProject: boolean;
  allowAll: boolean;
}

/** 逐 Agent 的 kb.search 开关（默认关闭）。 */
export interface KbToolAgent {
  id: string;
  name: string;
  /** 该通道是否具备 MCP 工具面；false 时只享受首轮自动注入 */
  supported: boolean;
  enabled: boolean;
}

export interface KbToolPolicy {
  /** 每个 Agent 每轮最多主动检索的次数 */
  maxPerTurn: number;
  agents: KbToolAgent[];
}

export interface KbDisabledSession {
  sessionId: string;
  reason: KbDisabledReason | null;
  sourceKind: string;
  consecutiveFailures: number;
  lastError: string | null;
}

/** `GET /api/kb/status`（knowledgeBaseStatus）的返回体。 */
export interface KbStatus {
  /** 索引文件是否已初始化；未建索引时为 false */
  initialized: boolean;
  chunkCount: number;
  sessionCount: number;
  sizeBytes: number;
  lastBackfillAt: string | null;
  scopePolicy: KbScopePolicy;
  policy: KbScopePolicy;
  optedOut: number;
  disabledSessionCount: number;
  disabledByReason: { user: number; autoFailure: number };
  disabledSessions: KbDisabledSession[];
}

/** `POST /api/kb/search` 的单条命中。 */
export interface KbHit {
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
  content: string;
  messageIds: string[];
  tokenCount: number;
  timeStart: string;
  timeEnd: string;
  score: number;
  redactedCount: number;
}

export interface KbSearchResult {
  query: string;
  scope: KbScope;
  mode: 'fts' | 'like';
  scopeApplied: KbScope;
  hits: KbHit[];
  tokensUsed: number;
  filteredOut: number;
  topK: number;
  maxTokens: number;
}

export interface KbSessionState {
  session_id: string;
  index_enabled: number;
  source_kind: string;
  visibility: string;
  last_indexed_at: string | null;
  last_message_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  disabled_reason: KbDisabledReason | null;
}

export interface KbSessionPatchResult {
  sessionId: string;
  chunks: number;
  skipped: boolean;
  reason?: string;
  state: KbSessionState | null;
}

export interface KbBackfillResult {
  sessions: number;
  indexedSessions: number;
  skippedSessions: number;
  messages: number;
  chunks: number;
  errors: number;
  since: string | null;
}

/** 会话摘要里的最小字段：来源卡需要「会话标题或时间」。 */
export interface KbSessionSummary {
  id: string;
  title: string;
  kind: 'direct' | 'group';
  createdAt?: string;
}
