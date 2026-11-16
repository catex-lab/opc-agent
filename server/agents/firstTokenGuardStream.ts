/**
 * 全通道首字护栏（SOLUTION-PLAN 步骤 1.1c / C3）。
 *
 * 把已有的 FirstTokenGuard（原本只有 SDK 通道 A214 用）推广到 registry.stream()
 * 返回的任意 AsyncIterable——这是每个 agent 每个回合的唯一消费入口，
 * 包一层即可全通道生效，不必改任何适配器、不改 turn-runner、不改投影器。
 *
 * ## 语义（刻意只守一段）
 * 只守「拿到第一个事件」之前。首字到达即 disarm，此后直接透传——
 * 工具调用之间的长间隔是合法的（联网/长命令可达数分钟），按间隔守会误杀正常轮次。
 * 这与 firstTokenGuard.ts 的原始边界一致，也是 AUDIT.md 的明确要求。
 *
 * ## 失败动作
 * 首字前超时 → throw 一条人话错误。turn-runner 的既有 catch 会发 error 事件、
 * 随后的 projector.finish() 会补 run_end ——「超时必发 run_end + 可见错误」
 * 由这条现成链路保证，护栏不自己造事件（避免双重收尾）。
 *
 * ## 与 SDK 内置护栏的关系
 * SDK 适配器内部已有一层 120s FirstTokenGuard（A214）。两层的计时都从回合开始、
 * 都取同一个默认值：SDK 通道若内部超时会先 throw 并结束 iterable，外层 race
 * 因 iterator.next() settle 而退出，不会重复报错；没有内层护栏的通道
 * （CLI / ACP / HTTP）由本层兜底。阈值只搬家不改值（resolveFirstTokenTimeoutMs）。
 */
import type { AgentEvent } from './types.js';
import { FirstTokenGuard } from './adapters/firstTokenGuard.js';

/** 中性措辞：推广到所有通道，不限定「模型 / SDK」 */
export function guardTimeoutMessage(ms: number): string {
  return (
    `对方 ${Math.round(ms / 1000)} 秒没有任何响应，已停止等待。` +
    `常见原因：服务无响应、排队中或已挂起；可直接重发。`
  );
}

/**
 * 包一层首字护栏。返回值仍是 AsyncIterable<AgentEvent>，调用方无感。
 * timeoutMs 省略时用 FirstTokenGuard 的默认值（120s，可环境变量覆盖）。
 */
export function withFirstTokenGuard(
  source: AsyncIterable<AgentEvent>,
  timeoutMs?: number,
): AsyncIterable<AgentEvent> {
  const guard = new FirstTokenGuard(timeoutMs);

  return {
    async *[Symbol.asyncIterator]() {
      const it = source[Symbol.asyncIterator]();
      let gotFirst = false;
      try {
        // 第一段：首字前 race（护栏生效）
        while (!gotFirst) {
          const step = await Promise.race([
            it.next().then(value => ({ value, timedOut: false })),
            guard.timeout.then(() => ({ value: null, timedOut: true })),
          ] as const);
          if (step.timedOut) {
            throw new Error(guardTimeoutMessage(guard.ms));
          }
          // timedOut=false 分支的 value 是 IteratorResult<AgentEvent>；TS 对联合
          // 字段访问不收窄到具体分支，这里显式断言（该分支 value 必非 null）。
          const first = step.value!;
          if (first.done) return;
          gotFirst = true;
          guard.disarm();
          yield first.value;
        }
        // 第二段：首字后纯透传，不再守间隔（长工具间隔合法）
        for (;;) {
          const { value, done } = await it.next();
          if (done) return;
          yield value;
        }
      } finally {
        guard.disarm();
        // 提前退出（用户停止 / abort）时把底层迭代器的资源收掉
        void it.return?.();
      }
    },
  };
}
