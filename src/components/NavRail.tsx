import { MessageCircle, Users, Menu, FolderKanban } from 'lucide-react';

export type NavKey = 'chats' | 'projects' | 'contacts';

interface NavRailProps {
  active: NavKey | 'settings';
  onNavigate: (key: NavKey) => void;
  onOpenSettings: () => void;
  /** 窄屏（单栏模式）下收窄，把像素让给内容 */
  compact?: boolean;
}

/**
 * 最左侧的窄导航栏 —— 社交应用里那一条「功能切换条」。
 * 只放最高频的三个入口，不承载任何业务内容。
 *
 * 设计要点：
 *   • 统一 44×44 按钮 + 20px 图标，节奏一致
 *   • 激活态用「左侧 3px 品牌色指示条 + 浅色背景」双重标识，位置感明确
 *   • hover 有微妙的背景色抬升，交互反馈即时
 *   • focus-visible 带品牌色 ring，键盘导航友好
 *   • 角标 18px/11px，确保两位数清晰可读
 *
 * ⚠️ 主题切换按钮**不在这里**。
 * 深浅色是一个「设置」，不是「高频操作」—— 放在导航条上等于每天都要看到
 * 一个几乎不用的按钮，还占掉了唯一一个「无标签图标位」。已移到设置页的
 * 「外观」分区（跟随系统 / 浅色 / 深色）。
 */
export function NavRail({
  active,
  onNavigate,
  onOpenSettings,
  compact = false,
}: NavRailProps) {
  /**
   * 导航项**不带角标**。
   *
   * 原先通讯录图标右上角挂「在线 Agent 数」。问题有三层：
   *   1. 这个数字不表达「有事找我」—— 它是**存量**（本机装了 3 个 Agent），
   *      不是**待处理**。角标在 IM 里是「有 N 条没看」的语义，用错了位置；
   *   2. 它几乎永远不变，于是变成一个永远亮着的装饰，反而抢走图标的注意力；
   *   3. 通讯录里已经按「在线优先」排好序，在线人数在打开后一眼就能数出来。
   * 所以角标整块去掉（`badge` 字段一起删掉，避免又有人把它接回来）。
   */
  const navItems: Array<{
    key: NavKey;
    icon: typeof MessageCircle;
    label: string;
  }> = [
    { key: 'chats', icon: MessageCircle, label: '聊天' },
    /* A117：「项目」夹在聊天与通讯录之间，不是排在最后。
       它和「聊天」是同族的 —— 项目是「按目录把会话归堆」，点进去看到的
       还是会话；通讯录是 Agent 名录，属于另一类东西。把项目放到通讯录之后
       会让人以为它是「又一个通讯录」，而它其实更接近「聊天的另一种组织方式」。 */
    { key: 'projects', icon: FolderKanban, label: '项目' },
    { key: 'contacts', icon: Users, label: '通讯录' },
  ];

  const isActive = (key: string) => active === key;

  return (
    <nav
      // 宽度：56px（窄屏 48px）。原来是 64 / 56 —— 44px 的按钮居中在 64px 的
      // 栏里，左右各留 10px 空白，加上按钮自身的内边距，图标离窗口左缘足足
      // 有 22px，整条栏看着像「一条宽灰带子上点了两个小图标」。
      // 收到 56 之后左右各 6px，按钮几乎顶满栏宽，视觉重心才落在图标上。
      // ⚠️ 改这里必须同步改 TitleBar 的 railWidth（那边靠同宽把应用标记
      //    对准导航图标的中轴），两处不一致标记就会歪。
      className={`flex shrink-0 flex-col items-center gap-1.5 py-3 ${compact ? 'w-[48px]' : 'w-[56px]'}`}
      style={{
        // A92：导航条从「框架面」里再拆出一档（--tc-surface-rail），是外框的
        // 最外层。原来它和会话列表共用 chrome，两栏 ΔL* = 0，只靠一条 1px
        // 分隔线撑着，读起来是「一整块灰」而不是两层。
        // 现在四档：rail → 列表(chrome) → 内容(content) → 浮起(raised)。
        // 取值与边界见 index.css 的 --tc-surface-rail 注释。
        backgroundColor: 'var(--tc-surface-rail)',
        // A103：微圆角。栏不再顶到窗口左缘（父级有 6px 内缩），四个角都看得见。
        // 右边框原本是 1px `--tc-divider`（值为 transparent），现在有缝了，
        // 留着不影响视觉，但会实打实占 1px 布局宽度 —— 一并去掉。
        borderRadius: 'var(--tc-column-radius)',
      }}
    >
      {/* 主导航。
          原先这里有个品牌色「OP」方块，与窗口标题栏、通讯录头部重复表达
          「这是哪个应用」，且把第一个导航项往下顶 —— 去掉后导航条从顶部
          直接开始，视觉更干净。应用名由窗口标题承担。 */}
      <div className="flex flex-col items-center gap-1">
        {navItems.map(({ key, icon: Icon, label }) => {
          const active = isActive(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onNavigate(key)}
              title={label}
              aria-label={label}
              /* A84：把「当前在哪一栏」显式暴露给辅助技术。
                 原先选中态只由底色 + 左侧那条 3px 指示条表达 —— 纯视觉。
                 `aria-current="page"` 既是无障碍信息，也让「选中回显态」
                 变成一个可断言的属性（verify:a84 靠它区分「该有底色的」和
                 「不该有底色的」按钮，而不是靠维护一份页面名单）。 */
              aria-current={active ? 'page' : undefined}
              className={`
                relative flex h-11 w-11 items-center justify-center rounded-xl
                transition-all duration-200 ease-out
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-[var(--td-brand-color)] focus-visible:ring-offset-1
                ${active
                  ? 'text-[var(--td-brand-color)]'
                  : 'text-[var(--td-text-color-secondary)] hover:text-[var(--td-text-color-primary)] hover:bg-[var(--tc-hover-chrome)]'
                }
              `}
              /* A75：只在选中时写内联底色。非选中项**不能**写
                 `backgroundColor: 'transparent'` —— 内联样式优先级高于
                 Tailwind 的 hover:bg-[...]，会把上面那句悬停反馈整个压死
                 （实测：导航里除当前项外，鼠标划过一颗都不会变色）。
                 这条教训与 GroupChatHeader 的编排菜单同源，见那里的注释。 */
              style={
                active ? { backgroundColor: 'var(--tc-fill-selected)' } : undefined
              }
            >
              {/* 左侧激活指示条 */}
              <span
                className={`pointer-events-none absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-transform duration-200 ${
                  active ? 'scale-y-100' : 'scale-y-0'
                }`}
                style={{ backgroundColor: 'var(--td-brand-color)' }}
              />
              <Icon size={20} strokeWidth={active ? 2.5 : 2} />
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* 底部工具按钮。这里只剩「设置」—— 主题切换已移入设置页。 */}
      <div className="flex flex-col items-center gap-1 pb-1">
        <button
          type="button"
          onClick={onOpenSettings}
          title="设置"
          aria-label="设置"
          aria-current={isActive('settings') ? 'page' : undefined}
          className={`
            relative flex h-11 w-11 items-center justify-center rounded-xl
            transition-all duration-200
            focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-[var(--td-brand-color)] focus-visible:ring-offset-1
            ${isActive('settings')
              ? 'text-[var(--td-brand-color)]'
              : 'text-[var(--td-text-color-secondary)] hover:text-[var(--td-text-color-primary)] hover:bg-[var(--tc-hover-chrome)]'
            }
          `}
          /* A75：同上 —— 未选中时不写内联底色，否则 hover 反馈被压死。 */
          style={
            isActive('settings')
              ? { backgroundColor: 'var(--tc-fill-selected)' }
              : undefined
          }
        >
          <span
            className={`pointer-events-none absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-transform duration-200 ${
              isActive('settings') ? 'scale-y-100' : 'scale-y-0'
            }`}
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          />
          {/* 三条横线（Menu）而非齿轮：设置已经从「一个图标位」变成一组
              分区，汉堡菜单更贴近「展开一列菜单」的语义；齿轮则更像
              「调参数」，与这个入口实际承载的内容不一致。 */}
          <Menu size={20} strokeWidth={isActive('settings') ? 2.5 : 2} />
        </button>
      </div>
    </nav>
  );
}
