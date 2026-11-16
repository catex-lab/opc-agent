/**
 * SSE 心跳（C8 / SUPER-AGENT-DESIGN §八 8.2）。
 *
 * 长回合里 agent 可能几十秒不吐一个字（握手 / 思考 / 工具执行），浏览器侧
 * `reader.read()` 阻塞在一条静默的流上，无法区分「对方在想」和「连接死了」。
 * 每 20 秒写一条 SSE **注释帧**（`: heartbeat\n\n`）——按 SSE 规范注释帧会被
 * 客户端解析器跳过（前端只认 `data: ` 行），但会唤醒 `reader.read()`，让前端
 * 的重连看门狗能重置静默计时。
 *
 * 独立成文件而非内联 index.ts：index.ts import 即启动整台 server，闸门测不到；
 * 抽出来后 verify 能直接 import 函数本体（与 model-cache.ts 同一思路）。
 */
export interface HeartbeatWritable {
  write(chunk: string): unknown;
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  writableEnded?: boolean;
  destroyed?: boolean;
}

export const HEARTBEAT_FRAME = ': heartbeat\n\n';
export const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * 启动心跳，返回 stop()（幂等）。res 的 'close'/'finish' 也会自动清理。
 * intervalMs 可由 OPC_SSE_HEARTBEAT_MS 覆盖（闸门用短间隔快速验证）。
 */
export function startSseHeartbeat(
  res: HeartbeatWritable,
  intervalMs = Number(process.env.OPC_SSE_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || res.writableEnded || res.destroyed) { stop(); return; }
    try { res.write(HEARTBEAT_FRAME); } catch { stop(); }
  }, intervalMs);
  timer.unref?.();
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    res.off('close', stop);
    res.off('finish', stop);
  }
  res.once('close', stop);
  res.once('finish', stop);
  return stop;
}
