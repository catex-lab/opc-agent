import type { AgentStatus } from './types';

/** 与 server/agents/registry.ts 的 `ProbeFailureReason` 同源（四类，不含凭据态） */
export type AgentProbeReason = 'timeout' | 'not-found' | 'permission' | 'unknown';

export interface SingleProbeResponse {
  agentId: string;
  ok: boolean;
  status: AgentStatus;
  durationMs: number;
  probedAt: string;
  reason?: AgentProbeReason;
  error?: string;
}

/**
 * 前端只保留「这次点击」的反馈，不复制一份 Agent 状态。
 *
 * 状态本身仍然以 `agents[].status` 为准（服务端返回后只合并目标 Agent），
 * 这里只记录按钮要显示的瞬时事实：正在探测 / 何时结束 / 耗时 / 失败原因。
 */
export interface AgentProbeFeedback {
  state: 'probing' | 'done';
  ok?: boolean;
  reason?: AgentProbeReason;
 /** 服务端探测动作分类（timeout / credential-invalid / probe-failed） */
  probeState?: AgentStatus['probeState'];
  message?: string;
  at?: string;
  durationMs?: number;
}

export const PROBE_REASON_LABEL: Record<AgentProbeReason, string> = {
  timeout: '探测超时',
  'not-found': '未找到',
  permission: '无权限',
  unknown: '探测失败',
};

/** 只保留时分秒，避免窄栏里被完整 ISO 撑开 */
export function formatProbeTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function formatProbeDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * 结果行文案（A177）。
 *
 * 四种失败原因必须先说原因，再说时间与耗时；成功则说「探测完成」。
 * 时间戳永远带上，因为「刚才点过没有」是用户最先问的问题。
 */
export function describeProbeFeedback(fb?: AgentProbeFeedback): string {
  if (!fb) return '';
  if (fb.state === 'probing') return '正在探测…';
  const time = formatProbeTime(fb.at);
  const cost = formatProbeDuration(fb.durationMs);
  const tail = [time, cost].filter(Boolean).join(' · ');
  if (fb.reason) {
    const reason = PROBE_REASON_LABEL[fb.reason];
    return `${reason}${tail ? ` · ${tail}` : ''}${fb.message ? `：${fb.message}` : ''}`;
  }
  if (fb.probeState === 'timeout') {
    return `探测超时${tail ? ` · ${tail}` : ''}${fb.message ? `：${fb.message}` : ''}`;
  }
  if (fb.probeState === 'credential-invalid') {
    return `凭据无效${tail ? ` · ${tail}` : ''}${fb.message ? `：${fb.message}` : ''}`;
  }
  if (fb.probeState === 'probe-failed') {
    return `探测失败${tail ? ` · ${tail}` : ''}${fb.message ? `：${fb.message}` : ''}`;
  }
  return `探测完成${tail ? ` · ${tail}` : ''}`;
}

export interface SingleProbeRunnerDeps {
  /** 注入后可在闸门里完全离线执行，不依赖真实 HTTP */
  fetchImpl?: typeof fetch;
  onStart: (agentId: string) => void;
  onSuccess: (agentId: string, data: SingleProbeResponse) => void;
  onFailure: (agentId: string, feedback: AgentProbeFeedback) => void;
  now?: () => number;
}

/**
 * 单 Agent 探测的前端协调器（A177）。
 *
 * 三个约束在这里落地，UI 只负责渲染：
 * 1. 同一 agentId 的重复点击返回**同一个 Promise**，不会叠加请求；
 * 2. 不同 agentId 的 in-flight 互不影响；
 * 3. 结果只通过 `onSuccess` 交给调用方合并**目标 Agent**，不触碰其它条目。
 */
export function createSingleProbeRunner(
  deps: SingleProbeRunnerDeps
): (agentId: string) => Promise<SingleProbeResponse | null> {
  const inflight = new Map<string, Promise<SingleProbeResponse | null>>();
  const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
  const now = deps.now ?? (() => Date.now());

  return (agentId: string) => {
    const existing = inflight.get(agentId);
    if (existing) return existing;

    deps.onStart(agentId);
    const startedAt = now();

    const task = (async (): Promise<SingleProbeResponse | null> => {
      try {
        const response = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/probe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const payload = (await response.json().catch(() => ({}))) as
          | (Partial<SingleProbeResponse> & { error?: string })
          | Record<string, never>;

        if (!response.ok) {
          const message = (payload as { error?: string }).error || `HTTP ${response.status}`;
          deps.onFailure(agentId, {
            state: 'done',
            ok: false,
            reason: 'unknown',
            message,
            at: new Date(startedAt).toISOString(),
            durationMs: now() - startedAt,
          });
          return null;
        }

        const data = payload as SingleProbeResponse;
        deps.onSuccess(agentId, data);
        return data;
      } catch (error) {
        deps.onFailure(agentId, {
          state: 'done',
          ok: false,
          reason: 'unknown',
          message: (error as Error)?.message || String(error),
          at: new Date(startedAt).toISOString(),
          durationMs: now() - startedAt,
        });
        return null;
      } finally {
        // 同一个 agentId 的 Promise 结束才释放；期间重复点击都复用它
        inflight.delete(agentId);
      }
    })();

    inflight.set(agentId, task);
    return task;
  };
}

/** 服务端 probeState → 前端反馈里的字段，避免两处各写一套映射 */
export function probeFeedbackFromResult(data: SingleProbeResponse): AgentProbeFeedback {
  return {
    state: 'done',
    ok: data.ok,
    reason: data.reason,
    probeState: data.status?.probeState,
    message: data.status?.message,
    at: data.probedAt,
    durationMs: data.durationMs,
  };
}
