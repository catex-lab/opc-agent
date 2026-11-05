import type { CSSProperties } from 'react';
import type { StatusDotShape } from '../types';

interface StatusDotProps {
  /**
   * 语义色，必须是 `--tc-status-*` 令牌的 `var(...)` 引用。
   * 组件不接受裸色值 —— B1 的目的就是让「状态点颜色」只有一个来源。
   */
  color: string;
  /**
   * 形状语义（只靠形状区分状态，颜色只是辅助）：
   *   - `solid`  = 在线：实心圆 + 1.5px 同色外环
   *   - `hollow` = 非在线：空心环（透明底 + 1.5px 描边）
   */
  shape: StatusDotShape;
  /** 直径，含描边（border-box）。默认 8px。 */
  size?: number;
  className?: string;
  /** 叠加定位用（如 AgentAvatar 的外切坐标） */
  style?: CSSProperties;
  /** 透出的状态名 —— 既有闸门（a25 等）按它区分圆点 */
  statusLabel?: string;
}

/**
 * 状态圆点。
 *
 * 五个位置都画同一颗点（列表头像 / 会话头 / 资料页 / 详情弹窗 / 悬停名片），
 * 以前各写各的 span + 内联 hex（`#00A870` / `#C6C6C6`）。这里收成一处：
 * 颜色只从 `types.ts` 的 `AVAILABILITY_META.dot`（现在是令牌）取，
 * 形状由 `dotShape` 决定。
 *
 * 为什么实心点保留 1.5px 外环：6px 的绿点压在浅色行底上太容易糊掉，
 * 同色 30% 的外环把边缘「托」出来，同时不引入第二种色相。
 * 空心点则用 1.5px 描边 + 透明底 —— 与实心点形成「填满 / 未填满」的
 * 形状差，色弱用户也能分出「在线 / 不在线」。
 */
export function StatusDot({
  color,
  shape,
  size = 8,
  className,
  style,
  statusLabel,
}: StatusDotProps) {
  const solid = shape === 'solid';
  return (
    <span
      aria-hidden="true"
      data-status-dot
      data-status={statusLabel}
      data-status-shape={shape}
      className={className}
      style={{
        display: 'inline-block',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        boxSizing: 'border-box',
        backgroundColor: solid ? color : 'transparent',
        border: solid ? undefined : `1.5px solid ${color}`,
        boxShadow: solid
          ? `0 0 0 1.5px color-mix(in srgb, ${color} 30%, transparent)`
          : undefined,
        ...style,
      }}
    />
  );
}
