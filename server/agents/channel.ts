/**
 * 异步事件队列：把「回调式」的 SDK 输出桥接成「异步迭代式」的统一事件流。
 *
 * 背景：CodeBuddy SDK 的 `query()` 本身是 AsyncIterable，但它还有一个
 * `canUseTool` 回调，会在流的中途被同步调用、并且需要等待一个异步答复。
 * 回调里的东西没法直接 yield 出去，所以这里用队列做中转：
 *
 *   SDK stream ──push──▶ AsyncQueue ──yield──▶ 适配器 send() ──▶ SSE
 *        ▲                                          │
 *        └──────── 用户答复（permission） ◀───────────┘
 */

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: Error | null = null;

  /** 入队一个元素。已关闭则静默丢弃（避免 push 抛异常打断 SDK 流）。 */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** 正常结束：唤醒所有等待者。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w({ value: undefined as never, done: true });
  }

  /** 异常结束：先排空已入队的元素，再抛出错误。 */
  fail(err: Error): void {
    this.failure = err;
    this.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // 已入队的元素优先，保证 close 之后不丢数据
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.failure) {
          const err = this.failure;
          this.failure = null;
          return Promise.reject(err);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>(resolve => {
          this.waiters.push(resolve);
        });
      },
      // 消费方提前 break 时调用：丢弃剩余数据
      return: (): Promise<IteratorResult<T>> => {
        this.items = [];
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/**
 * 绑定中止回调，并**同时处理「信号已经中止」的情况**。
 *
 * 为什么不能直接用 addEventListener：如果信号在注册之前就已经 abort，
 * addEventListener 永远不会触发（规范如此）。而实际链路里「注册监听」
 * 往往发生在若干次 await 之后，很容易错过中止时机 —— 表现为子进程
 * 被漏杀、或者反过来被误杀。这里统一补上这个检查。
 *
 * @returns 解绑函数
 */
export function linkAbort(
  signal: AbortSignal | undefined,
  handler: () => void
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    handler();
    return () => {};
  }
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

/**
 * 一次性答复的挂起表。用于 permission_request：
 * 先登记一个待兑现的 Promise，等前端 POST 回来再 resolve。
 */
export class PendingReplies<D> {
  private map = new Map<string, (decision: D) => void>();

  /** 登记一个待答复项，返回一个「等用户决定」的 Promise */
  register(id: string, onTimeout?: () => D, timeoutMs = 5 * 60 * 1000): Promise<D> {
    return new Promise<D>(resolve => {
      const settle = (d: D) => {
        this.map.delete(id);
        resolve(d);
      };
      this.map.set(id, settle);

      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (this.map.has(id)) settle(onTimeout ? onTimeout() : (undefined as D));
        }, timeoutMs);
        // 不要因为这个定时器把进程吊住
        timer.unref?.();
      }
    });
  }

  /** 前端答复到达 */
  settle(id: string, decision: D): boolean {
    const fn = this.map.get(id);
    if (!fn) return false;
    fn(decision);
    return true;
  }

  /** 会话中止时清理，避免永久挂起 */
  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
