/**
 * 「关闭窗口」偏好 —— 前端入口（A154）。
 *
 * ## 读取顺序与其它界面偏好一致
 *
 * 注入 > localStorage > 默认（见 `src/prefs.ts` 顶部注释）。这一项**不需要**
 * 首帧就位（它不影响任何 CSS），所以没有进 `applyUiPrefs()`。
 *
 * ## 为什么只写服务端、不用再发 IPC 给主进程
 *
 * 主进程与 Express 跑在**同一个进程**里（`electron/main.ts` 头注释），
 * 它读的就是 `server/preferences.ts` 的 `loadPrefs()` —— 设置页 PATCH 进来
 * 之后缓存立刻更新，下一次关窗口按新值走。多一条 IPC 通道只会多一处可能分叉。
 *
 * ## 默认 quit
 *
 * A154 之前「点关闭就退出」是唯一行为。加了设置项就顺手把默认改成
 * 最小化到托盘，等于替老用户改了习惯 —— 想要托盘的人自己点一下即可。
 */
import { bootPref, pushPrefs } from './prefs';
import { isCloseBehavior, type CloseBehavior } from '../shared/close-behavior';

export type { CloseBehavior };

export const CLOSE_BEHAVIOR_DEFAULT: CloseBehavior = 'quit';

const KEY = 'opc.close-behavior';

export function readCloseBehavior(): CloseBehavior {
  const injected = bootPref('closeBehavior');
  if (isCloseBehavior(injected)) return injected;
  const raw = localStorage.getItem(KEY);
  return isCloseBehavior(raw) ? raw : CLOSE_BEHAVIOR_DEFAULT;
}

export function saveCloseBehavior(behavior: CloseBehavior): CloseBehavior {
  localStorage.setItem(KEY, behavior);
  pushPrefs({ closeBehavior: behavior });
  return behavior;
}
