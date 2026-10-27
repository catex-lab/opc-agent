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

interface Waiter<T> {
  resolve: (r: IteratorResult<T>) => void;
  reject: (err: Error) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Waiter<T>[] = [];
  private closed = false;
  private failure: Error | null = null;

  /** 入队一个元素。已关闭则静默丢弃（避免 push 抛异常打断 SDK 流）。 */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  /** 正常结束：唤醒所有等待者。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve({ value: undefined as never, done: true });
  }

  /**
   * 异常结束。
   *
   * ⚠️ 这里**必须把错误直接 reject 给已经在等的人**，不能只「设 failure 再
   * close()」。踩过的坑（A108）：close() 会把 waiters 里的消费者用
   * `{done:true}` 唤醒，而 `next()` 只有在 items 为空**且没人挂起**时才读
   * failure —— 消费者恰恰就是挂起的那一方，于是 failure 永远没人读，调用方
   * 看到的是「流正常结束」。表现就是「Agent 报错了，但界面上什么都没有，
   * 这条回复被当成成功落库」。实测两种时序：
   *   - 消费者已挂起（最常见）→ 错误被吞，静默结束；
   *   - 消费者还没挂起 → 下一次 next() 才 reject。
   * 时序相关的行为是最难查的那类，所以这里统一成「错误一定送到」。
   */
  fail(err: Error): void {
    if (this.closed) {
      // 已经结束过：留一份 failure 给还在排空 items 的消费者，别丢
      this.failure = err;
      return;
    }
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    if (waiters.length > 0) {
      // 有人正在等：直接把错误交到它手里。
      // 不再留 failure —— 否则它下一次 next() 会再抛一次，调用方看到两条错误。
      for (const w of waiters) w.reject(err);
      return;
    }
    this.failure = err;
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
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
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
 *
 * ⚠️ 核心约束：**登记过的 Promise 必须被兑现**，无论走的是「前端答复」
 * 「超时」还是「会话收尾时清理」。早先的 `clear()` 只做 `map.clear()`，
 * 而超时兜底又用 `map.has(id)` 当守卫 —— 清掉之后守卫永远为假，于是那个
 * Promise 永远挂着（A108 实测：clear 后既不 resolve 也不 reject，等 1 秒
 * 依然 pending）。后果是 canUseTool 永不返回、CLI 侧永远等一句权限答复、
 * 这一轮既不出结果也不报错，正是「发了消息没响应」的形态。
 */
export class PendingReplies<D> {
  private map = new Map<
    string,
    { resolve: (d: D) => void; fallback?: () => D; scope?: string; onClear?: () => D }
  >();

  /**
   * 登记一个待答复项，返回一个「等用户决定」的 Promise。
   *
   * @param onTimeout 兜底答复（超时 / 被 clear 时都用它兑现），
   *                  不传的话调用方可能拿到 undefined —— 请务必传。
   * @param scope     归属（一般传会话 id）。`clear(scope)` 只清同一归属的项，
   *                  避免 A 会话收尾顺手把 B 会话正在等的弹窗清掉。
   * @param onClear   收尾时的答复。缺省沿用 `onTimeout` —— 但「超时」与
   *                  「会话结束」是两种事实，能分开就必须分开，否则原因码在撒谎。
   */
  register(
    id: string,
    onTimeout?: () => D,
    timeoutMs = 5 * 60 * 1000,
    scope?: string,
    onClear?: () => D
  ): Promise<D> {
    return new Promise<D>(resolve => {
      this.map.set(id, { resolve, fallback: onTimeout, scope, onClear });

      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          // 走同一个兑现口：先摘表再兑现，避免与 settle/clear 重复兑现
          const entry = this.map.get(id);
          if (!entry) return;
          this.map.delete(id);
          entry.resolve(entry.fallback ? entry.fallback() : (undefined as D));
        }, timeoutMs);
        // 不要因为这个定时器把进程吊住
        timer.unref?.();
      }
    });
  }

  /** 前端答复到达 */
  settle(id: string, decision: D): boolean {
    const entry = this.map.get(id);
    if (!entry) return false;
    this.map.delete(id);
    entry.resolve(decision);
    return true;
  }

  /**
   * 收尾清理：**用兜底答复兑现**，不是静默丢弃。
   *
   * @param scope 只清这个归属的；不传 = 全清（历史调用点行为不变）
   */
  clear(scope?: string): void {
    for (const [id, entry] of [...this.map]) {
      if (scope !== undefined && entry.scope !== scope) continue;
      this.map.delete(id);
      // 「会话收尾」优先用自己的答复：和超时共用一份兜底会让原因码撒谎
      entry.resolve(
        entry.onClear
          ? entry.onClear()
          : entry.fallback
            ? entry.fallback()
            : (undefined as D)
      );
    }
  }

  get size(): number {
    return this.map.size;
  }
}
