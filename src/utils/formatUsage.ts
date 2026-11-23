import type { Message } from '../types';
import { formatHandledDurationText } from '../../shared/trace';

/**
 * 把一条助手消息的用量格式化成一行小字（P6 成本统计）。
 *
 * ## 为什么「没有数据」必须返回 null 而不是 `0 秒 · $0.00`
 *
 * 三个字段的语义不同、来源也不同（见 `server/agents/types.ts` 的 done 事件）：
 *   - 耗时：适配器自己量的，一定有
 *   - 费用：只有 SDK 适配器拿到平台账单价才有
 *   - token 数：ACP 只有这个，没有费用
 *
 * 所以「这条消息没有费用」和「这条消息花了 0 元」是两回事：前者是
 * 适配器没上报，后者是真的免费。显示 `$0.00` 会把前者伪装成后者，
 * 成本统计当场变成假数据。没有就是没有，整项省掉。
 *
 * ## 耗时段为什么走 formatHandledDurationText（2026-11-20）
 *
 * 这里原来手搓一位小数（`63.7s`），与消息头部的「已处理 1 分 36 秒」并存
 * 时像两种数据（A36 审查意见）。全站回合耗时已收口到 shared/trace 的统一
 * 出口（<1 分按秒、≥1 分分+秒），本行必须跟随。亚秒仍显示 ms —— 那是
 * 「毫秒级调用」的真实量级，秒以下没有更好的单位。
 *
 * 纯函数、不依赖 React —— 验证脚本可以直接 import 它跑断言。
 * locale 缺省 'zh'（界面主语言），旧断言脚本不传参也拿得到稳定输出。
 */
export function formatUsage(
  message: Pick<Message, 'durationMs' | 'cost' | 'tokens'>,
  locale: 'zh' | 'en' = 'zh'
): string | null {
  const parts: string[] = [];

  if (typeof message.durationMs === 'number' && message.durationMs > 0) {
    parts.push(
      message.durationMs < 1000
        ? `${message.durationMs}ms`
        : formatHandledDurationText(message.durationMs, locale) ?? ''
    );
  }

  if (typeof message.cost === 'number' && message.cost > 0) {
    // 正常按分显示；真金白银的小额（<$0.01）也要有所表示，
    // 否则一笔 $0.004 的调用会和「没花钱」看起来一模一样
    parts.push(message.cost < 0.01 ? '<$0.01' : `$${message.cost.toFixed(2)}`);
  }

  if (typeof message.tokens === 'number' && message.tokens > 0) {
    parts.push(
      message.tokens >= 1000
        ? `${(message.tokens / 1000).toFixed(1)}k tokens`
        : `${message.tokens} tokens`
    );
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
