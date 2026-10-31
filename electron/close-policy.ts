/**
 * 关闭窗口时的决策表（A154）。
 *
 * ## 为什么抽成纯函数
 *
 * 这条分支只有在**跑起桌面壳、点一次右上角关闭**时才走得到：浏览器打靶脚本
 * 没有 `window.opc`，Node 单测也起不来 BrowserWindow。把「该隐藏 / 该关 /
 * 该弹哪个确认框」压成一张「输入 → 输出」的表，就能在普通脚本里穷举，
 * 主进程只剩执行（见 `main.ts` 的 `handleCloseRequest`）。
 *
 * ## 托盘不可用时的退化
 *
 * `tray` / `ask` 都依赖托盘图标存在。图标缺失（开发态忘了跑 make-icons）时
 * 不能把窗口藏起来 —— 藏了就没有任何入口能把它拿回来，用户会以为应用死了。
 * 所以这两档在无托盘时**退化**成「直接退出」，但仍有任务时先确认。
 */
import { isCloseBehavior, type CloseBehavior } from '../shared/close-behavior.js';

export type CloseAction = 'close' | 'hide' | 'confirm-quit' | 'ask';

export interface CloseContext {
  /** 偏好值来自磁盘/设置页，可能是脏的 —— 认不出来一律按默认 quit */
  behavior: unknown;
  /** 还在跑的 Agent 任务数（`runHub.activeRuns().length`） */
  runningTasks: number;
  /** 托盘图标是否真的创建成功 */
  trayAvailable: boolean;
}

export function decideCloseAction(ctx: CloseContext): CloseAction {
  const behavior: CloseBehavior = isCloseBehavior(ctx.behavior) ? ctx.behavior : 'quit';
  const running =
    Number.isFinite(ctx.runningTasks) && ctx.runningTasks > 0
      ? Math.floor(ctx.runningTasks)
      : 0;
  const tray = ctx.trayAvailable === true;

  if (behavior === 'tray' && tray) return 'hide';
  // 「每次都问」只有真的能二选一时才问；没有托盘就只剩「退出 / 取消」
  if (behavior === 'ask' && tray) return 'ask';
  return running > 0 ? 'confirm-quit' : 'close';
}
