/**
 * SSE 流解析（绞杀者第 0 期 / F0-02②）。
 *
 * 单聊（`useChat`）与群聊 / 工作流（`useGroupChat`）原先各写了一份**逐字相同**的
 * 读流循环：`body.getReader()` → `TextDecoder(stream:true)` → 按 `\n\n` 分帧 →
 * 取每帧第一条 `data: ` 行 → `JSON.parse`。两份副本已经在同一个月里踩过同一个
 * 坑（body 为 null 时静默 return 会永久转圈），所以这里只留一份。
 *
 * 语义与原来逐字一致：
 *  - `data: ` 取值（冒号后必须有空格，与后端 `w.write('data: …')` 对齐）；
 *  - 一帧里有多条 data 行时只取第一条（现状行为，不改成拼接——那是协议变更）；
 *  - 单帧 JSON 坏掉只丢这一帧，不拖垮整条流；
 *  - 半行留在 buffer 里等下一次 read。
 *
 * `onChunk` 只在**真的读到字节**时回调（心跳注释帧也算），给静默看门狗 touch 用；
 * 空 value 不算一次真正的读。
 *
 * 纯函数、不碰 React / DOM，闸门用 mock Response 直接测。
 */

export interface SseReadOptions {
  /** 每读到一段非空字节回调一次（含心跳注释帧），用于刷新静默看门狗 */
  onChunk?: () => void;
}

/**
 * 读完一条 SSE 响应，逐帧把 JSON 载荷交给 `onEvent`。
 * 响应体不可读时抛错——**不能静默 return**，否则调用方的流式状态永远停在
 * 「生成中」（2026-10-19 实测缺陷）。
 */
export async function readSseStream(
  resp: Response,
  onEvent: (payload: any) => void,
  opts: SseReadOptions = {}
): Promise<void> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('响应体不可读（resp.body 为 null），无法接收流式数据');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) opts.onChunk?.();
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        // 单帧坏掉不能拖垮整条流
      }
    }
  }
}
