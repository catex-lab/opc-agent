/**
 * A214：SDK 通道首字护栏。
 *
 * ## 为什么必须有
 *
 * 2026-11-13 真机实锤（chat.db + CLI 会话注册表 + 转录文件三源互证）：
 * WorkBuddy 新对话的首个模型请求挂起——CLI 进程活着、心跳正常，但转录
 * 0 字节 14 分钟+，用户侧永远「正在处理」。四个通道里这是唯一缺口：
 *   - CLI 通道：整轮 8 分钟兜底（DEFAULT_TIMEOUT_MS）
 *   - ACP 通道：90s 握手超时 + 会话超时自愈（A211）
 *   - HTTP 通道：socket timeout
 *   - SDK 通道：**此前两头都不设防** —— send() 与首条流事件可以无限等。
 *
 * ## 守卫范围（刻意只守一段）
 *
 * 只守「send() → 首条流事件」这段。首字之后的间隔**不守**：工具调用之间
 * 的长间隔是合法的（联网搜索实测可达数分钟），按间隔守卫会把正常轮次
 * 误杀成「回复到一半突然断了」。真机数据：健康首字 p95 远低于 120s
 * （Hy4 free 17.3s、预热后中位 1.0s）。
 *
 * ## 失败动作
 *
 * 驱逐条目（dropEntry → session.close() 杀掉 CLI 进程——它此刻只剩挂着的
 * 请求，上下文已无价值）+ 如实报错（`retryable: true`，可直接重发）。
 * 报错走 push+close 而不是 fail()，理由同 A107：措辞要由我们自己定，
 * 且不想经过 send() 的 catch 再包一层。
 *
 * 挂起的 send()/next() promise 在 race 输掉后仍可能迟到 reject——race
 * 已经 settle，迟到的 settle 被 race 消费，不会变成 unhandledRejection。
 */

/** 首字超时的哨兵。用 unique symbol 而不是字符串，杜绝和真实事件撞形 */
export const FIRST_TOKEN_TIMEOUT = Symbol('opc-first-token-timeout');

/** 环境变量覆盖（秒级调参用）；下限 15s，默认 120s */
export function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.OPC_SDK_FIRST_TOKEN_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.max(15_000, raw) : 120_000;
}

export function firstTokenTimeoutMessage(ms: number): string {
  return (
    `首字超时：模型 ${Math.round(ms / 1000)} 秒没有返回任何内容，已停止等待。` +
    `常见原因：免费模型排队、同一账号并发占用；可直接重发。`
  );
}

export class FirstTokenGuard {
  readonly timeout: Promise<typeof FIRST_TOKEN_TIMEOUT>;
  private timer: NodeJS.Timeout;

  constructor(readonly ms: number = resolveFirstTokenTimeoutMs()) {
    let lose!: () => void;
    this.timeout = new Promise((resolve) => {
      lose = () => resolve(FIRST_TOKEN_TIMEOUT);
    });
    this.timer = setTimeout(lose, ms);
    // unref 只影响「进程能否退出」：Electron 主进程常驻，计时器照常触发；
    // 万一只剩这个计时器在等，也不该拖住进程不放。
    this.timer.unref?.();
  }

  /** 首字已到：撤护栏（计时器不清掉会白白多挂一个 pending 句柄） */
  disarm(): void {
    clearTimeout(this.timer);
  }
}
