import type { LucideIcon } from 'lucide-react';

/**
 * 统一空状态组件（审查报告 §四共性 3 / S3-1、S4-1、S5-1、E-1/E-2）。
 *
 * 全应用此前至少有四套空态样式（一句灰字 / 图标加两行字 / 卡片式……），
 * 报告的建议是收成**一个组件**、一个结构：
 *
 *   图标（36–40px 灰）→ 标题（15px 加粗）→ 1 行说明（13px 灰）→ 1 个主按钮（黑底）。
 *
 * 使用规则：
 *   · `title` 必填 —— 空态至少要说清「这里为什么是空的」；
 *   · `description` 是**一行**说明，不要塞两行（排版按一行设计）；
 *   · `action` 只放**一个**主动作。空态里的第二动作（比如「点右上角 +」）
 *     写进 description，不再并排第二颗按钮；
 *   · 动作必须真实可执行 —— 没有可执行的动作就不传 `action`，
 *     不摆点了没反应的假控件。
 *
 * 视觉令牌：字号走 `text-title`(15) / `text-body`(13)，按钮走 `.tc-btn-brand`
 * （DESIGN-SYSTEM 8 档字号与 15 控件类），图标颜色用 placeholder 档，
 * 不在这里新造颜色。`data-empty-state` 供验证脚本定位。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  actionIcon: ActionIcon,
  actionDisabled = false,
  onAction,
  /** 垂直居中充满父容器（面板内空态）还是紧凑内边距 */
  fill = false,
  /** 压缩内边距：嵌入卡片/局部区域时用 */
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** 主按钮文案；不传就不渲染按钮 */
  action?: string;
  /** 主按钮图标（可选） */
  actionIcon?: LucideIcon;
  /** 主按钮禁用态（如导入进行中） */
  actionDisabled?: boolean;
  onAction?: () => void;
  fill?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      data-empty-state
      className={`flex w-full flex-col items-center justify-center text-center ${
        fill ? 'min-h-full' : ''
      } ${compact ? 'px-3 py-6' : 'px-4 py-10'}`}
    >
      <Icon
        size={36}
        strokeWidth={1.5}
        aria-hidden="true"
        style={{ color: 'var(--td-text-color-placeholder)' }}
      />
      <h3
        className={`text-title font-semibold ${compact ? 'mt-3' : 'mt-4'}`}
        style={{ color: 'var(--td-text-color-primary)' }}
      >
        {title}
      </h3>
      {description && (
        <p
          className="mt-1.5 text-body leading-5"
          style={{ color: 'var(--td-text-color-placeholder)' }}
        >
          {description}
        </p>
      )}
      {action && onAction && (
        <button
          type="button"
          className="tc-btn-brand mt-4"
          onClick={onAction}
          disabled={actionDisabled}
        >
          {ActionIcon && <ActionIcon size={16} aria-hidden="true" />}
          {action}
        </button>
      )}
    </div>
  );
}
