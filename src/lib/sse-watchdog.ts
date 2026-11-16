/**
 * SSE 静默看门狗（C8 / SUPER-AGENT-DESIGN §八 8.2）。
 *
 * 后端每 20 秒发一条心跳注释帧（见 server/sse-heartbeat.ts），唤醒浏览器的
 * `reader.read()`。本模块负责前端这一半：如果超过 SILENCE_TIMEOUT_MS 没有任何
 * 帧（含心跳），就判定「连接可能断了」，回调 onSilent() 让调用方 abort 当前流、
 * 走按 seq 的断线重连路径。
 *
 * 纯逻辑、不碰 React / DOM：闸门可用假时钟直接测；
 * useChat 只负责组装（touch 挂到 read、onSilent 挂到 controller.abort）。
 *
 * 关键语义：
 *  - touch() 只在**真的读到字节**时调用（心跳帧也算），空帧/解析失败不 refresh
 *    静默计时——否则一条还在读但没内容的流会被误判为健康。
 *  - start() 建立周期检查；stop() 幂等清理。
 *  - 一旦触发 onSilent，进入 latched 状态，不再重复触发（重连由调用方负责）。
 */

export const SILENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_CHECK_INTERVAL_MS = 5_000;

export interface WatchdogOptions {
  onSilent: () => void;
  silenceTimeoutMs?: number;
  checkIntervalMs?: number;
  /** 可注入时钟，闸门用假时钟；生产用 Date.now */
  now?: () => number;
  /** 可注入定时器宿主（默认 globalThis），闸门用假定时器 */
  timer?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

export interface SilenceWatchdog {
  touch: () => void;
  start: () => void;
  stop: () => void;
  isSilent: () => boolean;
  lastTouchAt: () => number;
}

const defaultTimer = {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
};

export function createSilenceWatchdog(opts: WatchdogOptions): SilenceWatchdog {
  const timeout = opts.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
  const checkMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const timer = opts.timer ?? defaultTimer;

  let last = now();
  let handle: unknown = null;
  let latched = false;
  let started = false;

  const check = () => {
    if (latched) return;
    if (now() - last >= timeout) {
      latched = true;
      opts.onSilent();
      // 触发后停止检查，避免重连期间反复回调
      if (handle !== null) { timer.clearInterval(handle); handle = null; }
    }
  };

  return {
    touch() {
      // latched 后 touch 无意义（本轮已判定断线，交给调用方重连）
      if (latched) return;
      last = now();
    },
    start() {
      if (started) return;
      started = true;
      last = now();
      handle = timer.setInterval(check, checkMs);
    },
    stop() {
      started = false;
      if (handle !== null) { timer.clearInterval(handle); handle = null; }
    },
    isSilent() { return latched; },
    lastTouchAt() { return last; },
  };
}
