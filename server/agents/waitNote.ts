/**
 * 首内容等待说明（P5 修2，接入架构收敛方案的体验补丁）。
 *
 * ## 它解决什么问题
 *
 * SDK 类通道的首个可渲染内容之前有一段「无解释静默」：workbuddy 的 SDK
 * 冷启动实测最长 174 秒（A155），claude 冷启动也不快——期间用户只能对着
 * 计时 pill 猜。这个看门狗在预算时间内没见到首个内容事件时，往事件流里
 * 推一条 **note**（灰色胶囊，与群聊编排叙述同一块型），把「为什么在等」
 * 说出来。
 *
 * ## 用法（三个调用点统一）
 *
 *   const waitNote = armWaitNote(ev => queue.push(ev), '正在等待 …（原因）…');
 *   // drain 循环里：内容事件出现时 markContent()；循环结束时 dispose()
 *
 * 为什么用 note 而不是 thinking：A231 之前的教训——把状态说明塞进思考块，
 * 用户会把它当成真实思考内容（还会误导字数统计）。
 */

import type { AgentEvent } from './types.js';

export interface WaitNoteHandle {
  /** 首个内容事件到达时调用：撤掉看门狗 */
  markContent(): void;
  /** 回合结束（done / error / 中止）时调用：兜底清理 */
  dispose(): void;
}

/** 预算内没等到内容 → 推一条 note。之后 markContent 不再有效（一次性） */
export function armWaitNote(
  push: (ev: AgentEvent) => void,
  text: string,
  budgetMs = 8000
): WaitNoteHandle {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    push({ type: 'note', text, level: 'info' });
  }, budgetMs);
  timer.unref?.();
  return {
    markContent() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    },
    dispose() {
      settled = true;
      clearTimeout(timer);
    },
  };
}

/** 内容事件的判定（三个 SDK 适配器共用同一口径） */
export function isContentEvent(ev: AgentEvent): boolean {
  return ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool';
}
