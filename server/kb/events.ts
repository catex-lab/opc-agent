/**
 * 消息落库事件（P1 知识库）。
 *
 * 为什么不让 `db.ts` 直接 import 索引器：索引器需要读 `sessions / messages`
 * 才能切片，反过来又会 import `db.ts`，形成环。这里放一个**零依赖**的通知口，
 * `db.ts` 只在写入成功后喊一声，索引器在启动时挂上监听。
 *
 * 事件同步投递，但监听方必须自己吞掉异常 —— 索引失败不能反过来影响聊天落库。
 */

export type KbPersistEvent =
  /** 新消息追加：增量切尾 */
  | { type: 'messages-upserted'; sessionId: string; messageIds: string[] }
  /** 既有消息被改写：整段重建 */
  | { type: 'message-updated'; sessionId: string }
  /** 单条消息被删除：整段重建 */
  | { type: 'message-deleted'; sessionId: string }
  /** 会话消息被清空：直接删该会话切片 */
  | { type: 'messages-deleted'; sessionId: string }
  | { type: 'session-deleted'; sessionId: string }
  | { type: 'all-cleared' };

type KbPersistSink = (event: KbPersistEvent) => void;

let sink: KbPersistSink | null = null;

export function setKbPersistSink(next: KbPersistSink | null): void {
  sink = next;
}

/**
 * 通知索引层。调用点都在 `db.ts` 的写操作之后。
 *
 * 这里不抛错：索引是派生数据，`chat.db` 已经提交成功，不能因为索引库
 * 暂时的锁/损坏让用户发不出消息。
 */
export function notifyKbPersist(event: KbPersistEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch (err) {
    console.warn('[KB] 索引更新失败（不影响聊天数据）:', err);
  }
}
