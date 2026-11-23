/**
 * 过程面板拖动几何（纯函数，便于闸门验证）。
 *
 * 禁区来自布局事实：标题栏 + Agent 名称行在上方，输入浮层在下方。
 * 面板只能停在两者之间；越界钳制，松手按最近边吸附。
 */

export type PanelMode = 'right' | 'top' | 'floating' | 'minimized';

export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DragBounds {
  viewportWidth: number;
  viewportHeight: number;
  /** 上方禁区高度（标题栏 + Agent 名称行） */
  topGuard: number;
  /** 下方禁区高度（输入浮层） */
  bottomGuard: number;
  margin?: number;
}

export function clampPanelPos(pos: Pick<PanelRect, 'x' | 'y' | 'width' | 'height'>, bounds: DragBounds): { x: number; y: number } {
  const m = bounds.margin ?? 8;
  const maxX = Math.max(m, bounds.viewportWidth - pos.width - m);
  const maxY = Math.max(bounds.topGuard + m, bounds.viewportHeight - bounds.bottomGuard - pos.height - m);
  return {
    x: Math.min(Math.max(pos.x, m), maxX),
    y: Math.min(Math.max(pos.y, bounds.topGuard + m), maxY),
  };
}

/**
 * 松手吸附：距右缘 40px 内吸右栏，距上禁区 40px 内吸顶，否则保持浮动。
 * 只有显式拖到边缘才吸附，避免从中间松手时面板乱跳。
 */
export function snapPanelMode(pos: PanelRect, bounds: DragBounds): PanelMode {
  const m = bounds.margin ?? 8;
  const rightGap = bounds.viewportWidth - (pos.x + pos.width);
  if (rightGap <= m + 40) return 'right';
  if (pos.y - bounds.topGuard <= 40) return 'top';
  return 'floating';
}

/**
 * 最小化胶囊松手落点 → 目标形态。
 *
 * 必须按**胶囊自己的宽度**判「碰到右缘」：上一版用展开后 260px 算，
 * 胶囊离右缘还有 160px 就吸附，用户明确判为错。真碰到右缘才切右吸附。
 */
export function snapMinimizedDrop(
  pos: Pick<PanelRect, 'x' | 'y'>,
  bounds: DragBounds,
  pillSize: Pick<PanelRect, 'width' | 'height'>
): PanelMode {
  const m = bounds.margin ?? 8;
  const rightGap = bounds.viewportWidth - (pos.x + pillSize.width);
  if (rightGap <= m + 16) return 'right';
  if (pos.y - bounds.topGuard <= 24) return 'top';
  return 'floating';
}

/** 窄屏自动最小化：只在用户没显式设过停靠形态时调用。 */
export function autoMinimizeMode(width: number, current: PanelMode): PanelMode {
  return width < 1100 && current === 'right' ? 'minimized' : current;
}
