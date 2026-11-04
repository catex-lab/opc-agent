/**
 * 单调时钟：所有「耗时」都必须走这里，**不要**用 `Date.now()`。
 *
 * 用户机器可能被 NTP / 手动改时间回拨，墙钟一倒退，重试预算会算成负数，
 * 失败文案里的「已等待」也会变成谎话。墙钟只用于 ISO 时间戳（取证看先后）。
 *
 * 这里同时提供可注入版本：闸门传假函数，生产路径用真实 `performance.now()`，
 * 两条路径的计时逻辑完全一致。
 */
export type NowFn = () => number;

export function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Number(process.hrtime.bigint()) / 1e6;
}

/** 返回一个「从创建这一刻起经过了多少毫秒」的读数函数 */
export function createElapsed(now: NowFn = monotonicNow): () => number {
  const started = now();
  return () => now() - started;
}

/** 一位小数，与 helper 里的 trace 口径一致 */
export function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}
