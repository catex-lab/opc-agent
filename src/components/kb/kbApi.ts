import type {
  KbBackfillResult,
  KbScope,
  KbScopePolicy,
  KbSearchResult,
  KbSessionPatchResult,
  KbSessionSummary,
  KbStatus,
} from './types';

interface ApiErrorBody {
  error?: string;
  detail?: string;
  code?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* 非 JSON 错误体：保留状态码即可 */
    }
    throw new KbApiError(body.error || `请求失败（HTTP ${res.status}）`, res.status, body.code);
  }
  return (await res.json()) as T;
}

export class KbApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'KbApiError';
    this.status = status;
    this.code = code;
  }
}

export function fetchKbStatus(): Promise<KbStatus> {
  return request<KbStatus>('/api/kb/status');
}

export function patchKbPolicy(patch: Partial<KbScopePolicy>): Promise<KbScopePolicy> {
  return request<KbScopePolicy>('/api/kb/policy', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function searchKb(options: {
  query: string;
  sessionId: string;
  scope: KbScope;
  topK?: number;
}): Promise<KbSearchResult> {
  return request<KbSearchResult>('/api/kb/search', {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

export function patchKbSession(
  sessionId: string,
  indexed: boolean
): Promise<KbSessionPatchResult> {
  return request<KbSessionPatchResult>(`/api/kb/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ indexed }),
  });
}

export function backfillKb(mode: 'recent' | 'full'): Promise<KbBackfillResult> {
  return request<KbBackfillResult>('/api/kb/backfill', {
    method: 'POST',
    body: JSON.stringify({ mode, days: 90 }),
  });
}

export function rebuildKb(): Promise<KbBackfillResult> {
  return request<KbBackfillResult>('/api/kb/rebuild', { method: 'POST' });
}

/** 会话列表只用来把 source 卡里的 sessionId 映射成标题，失败时退回时间。 */
export async function fetchSessionSummaries(): Promise<KbSessionSummary[]> {
  try {
    const data = await request<{ sessions?: Array<Record<string, unknown>> }>('/api/sessions');
    return (data.sessions ?? [])
      .filter(s => typeof s.id === 'string')
      .map(s => ({
        id: s.id as string,
        title: typeof s.title === 'string' ? s.title : '',
        kind: s.kind === 'group' ? 'group' : 'direct',
        createdAt: typeof s.created_at === 'string' ? s.created_at : undefined,
      }));
  } catch {
    return [];
  }
}

/** Agent 名称映射，只取 id/name，不碰任何凭据字段。 */
export async function fetchAgentNames(): Promise<Record<string, string>> {
  try {
    const data = await request<{ agents?: Array<Record<string, unknown>> }>('/api/agents');
    const out: Record<string, string> = {};
    for (const agent of data.agents ?? []) {
      if (typeof agent.id === 'string' && typeof agent.name === 'string') {
        out[agent.id] = agent.name;
      }
    }
    return out;
  } catch {
    return {};
  }
}
