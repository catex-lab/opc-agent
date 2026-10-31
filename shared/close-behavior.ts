/**
 * 「关闭窗口」的行为偏好 —— 前端、服务端与 Electron 主进程共用的唯一一份枚举。
 *
 * 三档都是用户可见的真实行为，不是内部开关：
 *   quit  关闭窗口就退出（默认，与 A154 之前完全一致）
 *   tray  关闭窗口只是隐藏，任务继续在后台跑；单击托盘图标恢复
 *   ask   每次关闭都问一次
 *
 * ⚠️ 服务端偏好校验（`server/preferences.ts`）与主进程决策
 * （`electron/close-policy.ts`）必须用同一个判定，不能各写一份字面量联合 ——
 * 前端能存进一个主进程不认的值，表现就是「设置看着生效了，关窗口还是老样子」。
 */
export type CloseBehavior = 'quit' | 'tray' | 'ask';

export function isCloseBehavior(value: unknown): value is CloseBehavior {
  return value === 'quit' || value === 'tray' || value === 'ask';
}
