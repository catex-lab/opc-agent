import type { ReactNode } from 'react';

/**
 * 统一标题栏 —— 全应用「标题栏长什么样」只在这里定义一次。
 *
 * ## 为什么要有这个组件
 *
 * 在此之前四处标题栏各写各的，实测计算样式是四套：
 *
 * | 位置 | 字号 | 内边距 | 底边线 |
 * |---|---|---|---|
 * | 消息（左栏） | 16px | px-4 pt-4 | 无 |
 * | 会话头部 | 16px | px-5 py-3 | 有 |
 * | 通讯录 | 17px | px-6 py-4 | 有 |
 * | 设置 | **24px** | 无 header 结构 | 无 |
 *
 * 设置页比别处大 50%，底边线也是有的有有的没有。靠「改类名」对齐只能治一次，
 * 下次新增页面照样漂移（群聊头部就是下一个）。所以固化成组件。
 *
 * ## 规范
 *
 * - **字号**：主区 `text-page`（17px）；窄栏 `text-title-lg`（16px）。
 *   两者都是既有的语义令牌，不引入新的魔数。
 * - **字重**：一律 600（font-semibold）。
 * - **垂直节奏**：主区一律 `py-4`（16px），主区标题栏因此天然收敛到同一高度
 *   （标题行 24 + 间距 2 + 副标题 18 + 上下各 16 = 76px）。
 *   窄栏用 `py-3`（12px）——300px 宽的列表栏还要塞搜索框，`py-4` 会让栏头过高。
 * - **副标题**：一律 `text-secondary`（12px）+ `mt-0.5`，次要文字色。
 * - **底边线**：一律 1px `--td-component-stroke`，除非显式 `divider={false}`。
 * - **水平内边距**：主区 `px-6`，窄栏 `px-4`（随栏宽缩放，属刻意差异）。
 *
 * 层级只用语义令牌表达，不要在调用处传 `text-[15px]` 这类任意值。
 */
export interface PanelHeaderProps {
  /** 标题文字 */
  title: ReactNode;
  /** 标题右侧的徽标（在线状态、计数等），与标题同一行 */
  badge?: ReactNode;
  /** 标题下方的副标题；不传则不占位 */
  subtitle?: ReactNode;
  /** 标题左侧的自定义内容，例如 Agent 头像 */
  leading?: ReactNode;
  /** 右侧操作区 */
  actions?: ReactNode;
  /**
   * 标题行下方的整宽内容（如搜索框）。
   * 渲染在标题栏内部、底边线之上，因此搜索框会随标题栏一起被分隔线收住。
   */
  children?: ReactNode;
  /** 主区（17px / px-6）还是窄栏（16px / px-4） */
  level?: 'page' | 'column';
  /** 是否显示底边线，默认 true */
  divider?: boolean;
  className?: string;
}

export function PanelHeader({
  title,
  badge,
  subtitle,
  leading,
  actions,
  children,
  level = 'page',
  divider = true,
  className = '',
}: PanelHeaderProps) {
  const isPage = level === 'page';
  // 页面级用 h1、栏级用 h2：标题层级与视觉层级保持一致
  const TitleTag = isPage ? 'h1' : 'h2';

  return (
    <header
      className={`flex shrink-0 flex-col justify-center ${className}`}
      style={{
        minHeight: 'var(--panel-header-height)',
        // 标题栏用 container 白底。
        //
        // 主区内容区是 page 灰底（--td-bg-color-page），标题栏原先不设背景、
        // 直接透出这层灰 —— 结果标题栏和下面的内容糊成一片，看不出
        // 「这是页面的头」，整屏也缺少层次。
        // 左栏本来就是 container 白底，加上这个不会有变化，反而让左右两侧
        // 的栏头在同一水平线上连成一条完整的白带。
        backgroundColor: 'var(--td-bg-color-container)',
        ...(divider ? { borderBottom: '1px solid var(--td-component-stroke)' } : {}),
      }}
    >
      <div className={`flex items-center gap-3 ${isPage ? 'px-6 py-5' : 'px-4 pt-2'}`}>
        {leading}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <TitleTag
              className={`truncate font-semibold ${isPage ? 'text-page' : 'text-title-lg'}`}
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {title}
            </TitleTag>
            {badge}
          </div>

          {subtitle != null && (
            <p
              className="mt-0.5 truncate text-secondary"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              {subtitle}
            </p>
          )}
        </div>

        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {children}
    </header>
  );
}
