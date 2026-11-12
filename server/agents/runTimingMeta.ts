/**
 * 一轮对话的首字时间戳旁路（A210）。
 *
 * 仿 `permissionMeta.ts`：零依赖纯模块，按 runId 挂一个 Map，
 * **不改 SSE 事件形状**（`run_start` / `run_end` 只加可选字段）。
 * 投影器层可以安全写旁路，保持可单测。
 *
 * 五个点的分工：
 *   t0 前端 fetch 发出（epoch ms，随 `/api/chat` body 的 clientSentAt 带来）
 *   t1 服务端收到请求
 *   t2 服务端首个正文事件进入 SSE
 *   t3 前端 applyRunEvent 收到首个增量（前端本地，不上报）
 *   t4 前端 useSmoothText 的 shown 首次非空（前端本地，不上报）
 *
 * 渲染进程与内嵌 Express 主进程同机同钟，`Date.now()` 可直接相减；
 * **不要混 `performance.now()`**（不同时间基准，差值无意义）。
 * t4−t3 必须在前端单独算，不能并进 TTFT —— 那是动画延迟，不是 Agent 慢。
 */

export interface RunTimingMarks {
  t0: number;
  t1: number;
  /** 本轮一个正文事件都没产生时为 null（例如秒拒 / 权限超时） */
  t2: number | null;
}

/** 只留最近若干轮：正常对话不会翻到很久以前，避免长驻进程内存单调增长 */
const MAX_RECORDS = 256;
const marks = new Map<string, RunTimingMarks>();

/** 淘汰最旧的一条（Map 保持插入顺序） */
function trim(): void {
  while (marks.size > MAX_RECORDS) {
    const oldest = marks.keys().next().value;
    if (oldest === undefined) break;
    marks.delete(oldest);
  }
}

/** t0 缺席或不是有限数时，整组标记为不可信：宁可不给数，也不编一个 */
function safeEpoch(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function beginRunTiming(runId: string, clientSentAt: unknown, receivedAt: number = Date.now()): void {
  if (!runId) return;
  marks.set(runId, {
    t0: safeEpoch(clientSentAt, receivedAt),
    t1: receivedAt,
    t2: null,
  });
  trim();
}

/** 幂等：只记第一次正文事件。thinking / tool 块不算「首字」 */
export function noteFirstContent(runId: string, at: number = Date.now()): void {
  const m = marks.get(runId);
  if (!m || m.t2 !== null) return;
  m.t2 = at;
}

/** 取走（一轮只收口一次）。收口后不留残骸 */
export function takeRunTiming(runId: string): RunTimingMarks | null {
  const m = marks.get(runId);
  if (!m) return null;
  marks.delete(runId);
  return m;
}

/** 供单测 / 闸门观察内部状态，不用于产品逻辑 */
export function peekRunTiming(runId: string): RunTimingMarks | null {
  return marks.get(runId) ?? null;
}

/** 判断一条 RunEvent 是否算「首个正文」 */
export function isFirstContentEvent(event: { type: string; channel?: string; block?: { type?: string } }): boolean {
  if (event.type === 'block_delta') {
    return event.channel !== 'thinking';
  }
  if (event.type === 'block_open') {
    return event.block?.type === 'text';
  }
  return false;
}
