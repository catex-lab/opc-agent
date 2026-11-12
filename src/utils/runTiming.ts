/**
 * 前端首字分段汇总（A210）。纯计算 + 一个只读观测出口。
 *
 * 服务端只给 t0/t1/t2（`run_end.timing`）；t3 由 `useChat` 在首个块增量时记，
 * t4 的**延迟**由 `useSmoothText` 自己在 hook 内量好（它最清楚 target 何时
 * 首次非空、shown 何时首次非空），通过 `noteReveal()` 交给本模块。
 *
 * 分段的判据：
 *   serverPreMs      = t1 - t0  请求在途 / 排队
 *   serverFirstTokenMs = t2 - t1 服务端到首 token
 *   ttftMs           = t3 - t0  端到端首字（含 SSE 传输 + rAF 批处理）
 *   uiSmoothMs       = t4 - t3  平滑动画延迟，**单列，不并入 TTFT**
 */

export interface ServerTimingMarks {
  t0: number;
  t1: number;
  t2: number | null;
}

/** 归因 meta：从 run_start 事件带过来的服务端真值 */
export interface TimingAttribution {
  agentId: string;
  model: string | null;
}

export interface TimingSummary {
  t0: number;
  t1: number;
  t2: number | null;
  t3: number | null;
  serverPreMs: number | null;
  serverFirstTokenMs: number | null;
  ttftMs: number | null;
  /** 单列：UI 平滑动画延迟，绝不混进 TTFT */
  uiSmoothMs: number | null;
  /** 归因：哪条 Agent 通道 + 实际模型；缺失时为 null（旧样本兼容） */
  agentId: string | null;
  model: string | null;
}

interface RevealSample {
  delayMs: number;
  at: number;
}

/** useSmoothText 报上来的最近一次「首字揭示延迟」 */
let lastReveal: RevealSample | null = null;

/** 观测出口：闸门（浏览器夹具）读 window.__OPC_TIMING__，不用于渲染 */
const samples: TimingSummary[] = [];

function isFiniteEpoch(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** 纯函数，可单测。字段缺失时对应分段为 null，绝不补 0 冒充「零延迟」 */
export function buildTimingSummary(
  marks: ServerTimingMarks | null | undefined,
  t3: number | null,
  revealDelayMs: number | null,
  attribution?: TimingAttribution | null
): TimingSummary | null {
  if (!marks || !isFiniteEpoch(marks.t0) || !isFiniteEpoch(marks.t1)) return null;
  const t2 = isFiniteEpoch(marks.t2) ? marks.t2 : null;
  const t3Ok = isFiniteEpoch(t3) ? t3 : null;
  return {
    t0: marks.t0,
    t1: marks.t1,
    t2,
    t3: t3Ok,
    serverPreMs: Math.max(0, marks.t1 - marks.t0),
    serverFirstTokenMs: t2 === null ? null : Math.max(0, t2 - marks.t1),
    ttftMs: t3Ok === null ? null : Math.max(0, t3Ok - marks.t0),
    uiSmoothMs:
      typeof revealDelayMs === 'number' && Number.isFinite(revealDelayMs)
        ? Math.max(0, revealDelayMs)
        : null,
    agentId: attribution?.agentId ?? null,
    model: attribution?.model ?? null,
  };
}

export function noteReveal(delayMs: number, at: number = Date.now()): void {
  lastReveal = { delayMs: Math.max(0, delayMs), at };
}

/** 取走最近一次揭示样本（配对成功后清掉，避免串到下一轮） */
export function takeReveal(): RevealSample | null {
  const r = lastReveal;
  lastReveal = null;
  return r;
}

/** 把一轮的完整分段推到只读观测出口 */
export function publishTiming(summary: TimingSummary): void {
  samples.push(summary);
  if (samples.length > 64) samples.shift();
  try {
    const w = window as unknown as {
      __OPC_TIMING__?: TimingSummary[];
      __OPC_TIMING_STATS__?: () => TimingStatsReport;
    };
    w.__OPC_TIMING__ = samples.slice();
    w.__OPC_TIMING_STATS__ = getTimingStats;
  } catch {
    /* 非浏览器环境（纯单测）不观测 */
  }
}

/** 消息头 hover 用的分段文案；没有数据时不显示 */
export function formatTimingTitle(summary: TimingSummary | null | undefined): string | undefined {
  if (!summary) return undefined;
  const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v)}ms`);
  const agent = summary.agentId ? ` [${summary.agentId}]` : '';
  return [
    `请求在途 ${ms(summary.serverPreMs)}`,
    `服务端首字 ${ms(summary.serverFirstTokenMs)}`,
    `端到端首字 ${ms(summary.ttftMs)}`,
    `UI 平滑 ${ms(summary.uiSmoothMs)}（单列）`,
  ].join(' · ') + agent;
}

// ── 分组统计出口 ────────────────────────────────────────────────────────

export interface TimingGroupStats {
  agentId: string;
  model: string | null;
  sampleCount: number;
  noContentCount: number;
  serverFirstTokenMs: { p50: number | null; p95: number | null };
  ttftMs: { p50: number | null; p95: number | null };
  uiSmoothMs: { p50: number | null; p95: number | null };
}

export interface TimingStatsReport {
  totalSamples: number;
  groups: TimingGroupStats[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

function groupStats(key: string, group: TimingSummary[]): TimingGroupStats {
  const [agentId, model] = key.split('\0');
  const sft = group
    .map(s => s.serverFirstTokenMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const ttft = group
    .map(s => s.ttftMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const smooth = group
    .map(s => s.uiSmoothMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return {
    agentId,
    model: model || null,
    sampleCount: group.length,
    noContentCount: group.filter(s => s.t2 === null).length,
    serverFirstTokenMs: { p50: percentile(sft, 50), p95: percentile(sft, 95) },
    ttftMs: { p50: percentile(ttft, 50), p95: percentile(ttft, 95) },
    uiSmoothMs: { p50: percentile(smooth, 50), p95: percentile(smooth, 95) },
  };
}

/** 按 agentId + model 分组统计 p50/p95，供 DevTools 调用 */
export function getTimingStats(): TimingStatsReport {
  const byKey = new Map<string, TimingSummary[]>();
  for (const s of samples) {
    const key = `${s.agentId ?? 'unknown'}\0${s.model ?? ''}`;
    let arr = byKey.get(key);
    if (!arr) {
      arr = [];
      byKey.set(key, arr);
    }
    arr.push(s);
  }
  const groups = Array.from(byKey.entries())
    .map(([key, arr]) => groupStats(key, arr))
    .sort((a, b) => b.sampleCount - a.sampleCount);
  return { totalSamples: samples.length, groups };
}
