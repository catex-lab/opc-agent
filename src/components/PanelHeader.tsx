import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

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
 * - **垂直节奏**：主区一律 `py-5`（20px），标题栏因此天然收敛到同一高度
 *   （标题行 24 + 间距 2 + 副标题 18 + 上下各 20 = 84，取 88 兜住像素误差，
 *   多出的 4px 由 flex 居中分配）。**窄栏与主区用完全相同的 py-5** ——
 *   两栏并排时标题必须落在同一条水平线上，否则并排看会「晃」。
 * - **副标题**：一律 `text-secondary`（12px）+ `mt-0.5`，次要文字色。
 *   文字块恒定 44px 高（`min-h-[44px]`），有没有副标题都一样 ——
 *   块高一旦变了，标题在 88px 里的居中位置就会跟着变，两栏标题立刻错位。
 * - **底色**：`--tc-surface-chrome`，与导航条、列表栏**同一个令牌**。
 *   标题栏属于「框架」，不属于「内容」，三者要连成一条完整的外框。
 * - **底边线**：一律 1px `--td-component-stroke`，除非显式 `divider={false}`。
 * - **水平内边距**：主区 `px-6`，窄栏 `px-4`；窄屏（<640px）主区降到 `px-4`。
 *
 * 层级只用语义令牌表达，不要在调用处传 `text-[15px]` 这类任意值。
 */
export interface PanelHeaderProps {
  /** 标题文字 */
  title: ReactNode;
  /** 标题右侧的徽标（在线状态、计数等），与标题同一行 */
  badge?: ReactNode;
  /** 标题下方的副标题；不传则只占住 44px 的块高 */
  subtitle?: ReactNode;
  /** 标题左侧的自定义内容，例如 Agent 头像 */
  leading?: ReactNode;
  /** 右侧操作区 */
  actions?: ReactNode;
  /**
   * 标题行下方的整宽内容，渲染在标题栏内部、底边线之上。
   *
   * ⚠️ **不要用它放搜索框**。搜索框（约 32px）塞进来之后，窄栏的内容块
   * 变成「标题 24 + 副标题 18 + 搜索 32」= 74，88px 高度装不下，只能靠
   * `pt-2` 硬压 —— 结果是窄栏标题比主区标题高 4px，两栏并排能看出来。
   * 搜索框应放在列表区顶部并 `sticky top-0` 吸顶（见 ConversationList /
   * ContactsPanel），既保住标题对齐，又保留「滚动时不跑掉」。
   */
  children?: ReactNode;
  /** 主区（17px / px-6）还是窄栏（16px / px-4） */
  level?: 'page' | 'column';
  /** 是否显示底边线，默认 true */
  divider?: boolean;
  /**
   * 返回上一级。只有单栏（窄屏）模式才需要 —— 那时内容区把列表挡住了，
   * 没有返回键就回不到列表。宽屏下不传，标题栏左侧保持干净。
   */
  onBack?: () => void;
  /** 返回键的无障碍文案 */
  backLabel?: string;
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
  onBack,
  backLabel = '返回',
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
        // 标题栏属于「框架」：与导航条、列表栏同一个令牌。
        // 三处共用一个值，才谈得上「标题栏色调与左侧栏一致」——
        // 靠「三处都记得写同一个令牌」是靠不住的。
        backgroundColor: 'var(--tc-surface-chrome)',
        ...(divider ? { borderBottom: '1px solid var(--td-component-stroke)' } : {}),
      }}
    >
      <div
        className={`flex items-center gap-3 ${
          isPage ? 'px-4 py-5 sm:px-6' : 'px-4 py-5'
        }`}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={backLabel}
            aria-label={backLabel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--td-text-color-secondary)] transition-colors hover:bg-[var(--tc-hover-chrome)] hover:text-[var(--td-text-color-primary)]"
          >
            <ChevronLeft size={18} />
          </button>
        )}

        {leading}

        <div className="flex min-w-0 flex-1 flex-col" style={{ minHeight: 44 }}>
          <div className="flex items-center gap-2">
            <TitleTag
              className={`truncate font-semibold ${isPage ? 'text-page' : 'text-title-lg'}`}
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {title}
            </TitleTag>
            {badge}
          </div>

          {/*
           * 副标题。不传时**不渲染任何东西**，但上面那层 min-h-[44px]
           * 已经把块高锁死了 —— 标题永远从这 44px 的**顶部**开始，
           * 所以「有没有副标题」不会挪动标题的位置。
           *
           * 早先是塞一个 aria-hidden 的空 <p> 占位：能对齐，但会留下一段
           * 无意义的空白行。改成给容器定高之后，对齐和「不留空行」两件事
           * 才不冲突。
           *
           * ⚠️ 不要改成 justify-center —— 单行标题会被居中，比带副标题的
           * 标题低 10px，两栏并排立刻错位。
           */}
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
