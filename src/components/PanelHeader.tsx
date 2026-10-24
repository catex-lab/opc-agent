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
 * - **底色**：由 `surface` 开关决定，三档语义令牌，不引入任意色值。
 *   默认 `chrome`（框架面，与导航条、列表栏同一个令牌，三者连成一条完整外框）；
 *   会话头部用 `content`（内容面，聊天区上下连成一片）；
 *   右侧工作区用 `aside`（A95，内容面的近邻，见 `surface` 的注释）。
 * - **底边线**：一律 1px `--td-component-stroke`，除非显式 `divider={false}`。
 * - **水平内边距**：主区 `px-6`，窄栏 `px-4`；窄屏（<640px）主区降到 `px-4`。
 *
 * ## 例外：通讯录不用本组件
 *
 * 通讯录（ContactsPanel）按 QQ 通讯录的版式做：顶部是「搜索胶囊 + Tab」，
 * 没有标题行，所以不复用本组件。消息列表、会话头部（compact）、资料页在用。
 *
 * ## 紧凑变体（compact）
 *
 * 会话头部（一对一 / 群聊）用 `compact`：单行、`py-2.5`、总高约 52px，
 * 且不渲染副标题行。理由：聊天区要的是「上面别再压一道 88px 的横条」——
 * 头部的职能只是「现在在跟谁说话 + 状态 + 更多操作」，一行就够，
 * 省下的 36px 全给消息列表。列表栏 / 资料页仍用标准 88px。
 *
 * ⚠️ compact 的头**不要传 subtitle**（会被忽略）—— 副标题是双行结构的一半，
 *    单行头部里没有它的位置。
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
  /**
   * 紧凑变体：单行、约 52px 高、不渲染副标题。会话头部专用，见文件头注释。
   */
  compact?: boolean;
  /**
   * 标题栏底色。
   *
   * - `chrome`（默认）：框架面。列表栏 / 资料页用，与左侧导航连成一条外框。
   * - `content`：内容面。会话头部用 —— 聊天区上下连成一片白，头部不再像
   *   一块压在消息上的横条（QQ 的会话头部也是跟消息区同色）。
   * - `aside`（A95）：内容面的近邻。右侧工作区用 —— 它与对话区差一档，
   *   头部必须跟着面板走，否则面板顶会露出一条对话区颜色的横条。
   *
   * 之所以做成开关而不是让调用方自己传 style：底色属于「标题栏规范」，
   * 一旦允许外部覆盖，四处标题栏迟早又各写各的。
   */
  surface?: 'chrome' | 'content' | 'aside';
  /** 是否显示底边线，默认 true */
  divider?: boolean;
  /**
   * 返回上一级。只有单栏（窄屏）模式才需要 —— 那时内容区把列表挡住了，
   * 没有返回键就回不到列表。宽屏下不传，标题栏左侧保持干净。
   */
  onBack?: () => void;
  /** 返回键的无障碍文案 */
  backLabel?: string;
  /**
   * 右侧操作区的垂直对齐。
   *
   * - `center`（默认）：在整条标题栏里居中。单行头部（compact）用它，
   *   那里标题本身也是居中的，两者同轴。
   * - `title`：与标题行对齐。**双行结构里必须用它** —— 标题块是 44px、
   *   标题贴在块顶，而 84px 的整栏居中会把按钮压到标题下方约 10px，
   *   并排看就是「关闭键挂得太低」（设置页 2026-10-20 用户反馈）。
   */
  actionsAlign?: 'center' | 'title';
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
  compact = false,
  surface = 'chrome',
  divider = true,
  onBack,
  backLabel = '返回',
  actionsAlign = 'center',
  className = '',
}: PanelHeaderProps) {
  const isPage = level === 'page';
  // 页面级用 h1、栏级用 h2：标题层级与视觉层级保持一致
  const TitleTag = isPage ? 'h1' : 'h2';

  return (
    <header
      className={`flex shrink-0 flex-col justify-center ${className}`}
      style={{
        // compact（会话头部）压到 52px：聊天区少一道横条，消息列表多 36px。
        // 其余位置保持统一高度，两栏并排时标题与分隔线才对得齐。
        // 52 是 `--tc-header-height`：群设置面板要从这条底边往下铺、
        // 群成员栏的栏头也用它，三处必须同值。
        minHeight: compact ? 'var(--tc-header-height)' : 'var(--panel-header-height)',
        // 标题栏属于「框架」：与导航条、列表栏同一个令牌。
        // 三处共用一个值，才谈得上「标题栏色调与左侧栏一致」——
        // 靠「三处都记得写同一个令牌」是靠不住的。
        backgroundColor:
          surface === 'content'
            ? 'var(--tc-surface-content)'
            : surface === 'aside'
              ? 'var(--tc-surface-aside)'
              : 'var(--tc-surface-chrome)',
        ...(divider ? { borderBottom: '1px solid var(--tc-divider)' } : {}),
      }}
    >
      <div
        className={`flex items-center gap-3 ${
          compact ? 'px-4 py-2.5 sm:px-6' : isPage ? 'px-4 py-5 sm:px-6' : 'px-4 py-5'
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

        <div
          className="flex min-w-0 flex-1 flex-col"
          // compact 是单行结构，没有副标题来占位，块高不锁 44px
          style={compact ? undefined : { minHeight: 44 }}
        >
          <div className="flex items-center gap-2">
            <TitleTag
              // compact（会话头部）固定 16px：QQ 的会话名就是这个量级。
              // 用 text-page（17px）在 52px 单行里会显得头重脚轻，
              // 而且和下面的消息正文只差 3px，层级拉不开。
              className={`truncate font-semibold ${
                compact || !isPage ? 'text-title-lg' : 'text-page'
              }`}
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
           * ⚠️ compact（单行会话头部）不渲染副标题：那一行位置整个不存在。
           */}
          {!compact && subtitle != null && (
            <p
              className="mt-0.5 truncate text-secondary"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              {subtitle}
            </p>
          )}
        </div>

        {actions && (
          <div
            className="flex shrink-0 items-center gap-2"
            // `alignSelf: flex-start` 覆盖父级 items-center：让操作区贴住标题行
            // 顶部。`-1px` 是标题 17px/1.5 行高的光学中心与 28px 按钮中心的差。
            style={actionsAlign === 'title' ? { alignSelf: 'flex-start', marginTop: -1 } : undefined}
          >
            {actions}
          </div>
        )}
      </div>

      {children}
    </header>
  );
}
