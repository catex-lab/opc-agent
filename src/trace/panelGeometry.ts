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
 * 松手吸附：距右缘 24px 内吸右栏，距上禁区 24px 内吸顶，否则保持浮动。
 * 只有显式拖到边缘才吸附，避免从中间松手时面板乱跳。
 */
export function snapPanelMode(pos: PanelRect, bounds: DragBounds): PanelMode {
  const m = bounds.margin ?? 8;
  const rightGap = bounds.viewportWidth - (pos.x + pos.width);
  if (rightGap <= m + 24) return 'right';
  if (pos.y - bounds.topGuard <= 24) return 'top';
  return 'floating';
}

/**
 * 最小化胶囊松手落点 → 目标形态。
 *
 * 胶囊本身只有百来像素宽，判定「贴右」必须按**展开后**的面板宽度算，
 * 否则胶囊拖到屏幕最右时也永远差一截，切不回右吸附。
 */
export function snapMinimizedDrop(
  pos: Pick<PanelRect, 'x' | 'y'>,
  bounds: DragBounds,
  panelSize: Pick<PanelRect, 'width' | 'height'>
): PanelMode {
  const m = bounds.margin ?? 8;
  const rightGap = bounds.viewportWidth - (pos.x + panelSize.width);
  if (rightGap <= m + 24) return 'right';
  if (pos.y - bounds.topGuard <= 24) return 'top';
  return 'floating';
}

/** 窄屏自动最小化：只在用户没显式设过停靠形态时调用。 */
export function autoMinimizeMode(width: number, current: PanelMode): PanelMode {
  return width < 1100 && current === 'right' ? 'minimized' : current;
}
