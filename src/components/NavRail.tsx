import { MessageCircle, Users, Settings } from 'lucide-react';

export type NavKey = 'chats' | 'contacts';

interface NavRailProps {
  active: NavKey | 'settings';
  /** 在线 Agent 数量，显示在通讯录角标上 */
  readyCount: number;
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
  readyCount,
  onNavigate,
  onOpenSettings,
  compact = false,
}: NavRailProps) {
  const navItems: Array<{
    key: NavKey;
    icon: typeof MessageCircle;
    label: string;
    badge?: number;
  }> = [
    { key: 'chats', icon: MessageCircle, label: '聊天' },
    { key: 'contacts', icon: Users, label: '通讯录', badge: readyCount },
  ];

  const isActive = (key: string) => active === key;

  return (
    <nav
      className={`flex shrink-0 flex-col items-center gap-1.5 py-3 ${compact ? 'w-[56px]' : 'w-[64px]'}`}
      style={{
        // 框架面（--tc-surface-chrome）：导航条 / 列表栏 / 标题栏三者同色，
        // 它们构成应用的「外框」。内容区（--tc-surface-content）比它亮一档，
        // 于是「哪块是框架、哪块是内容」一眼能分。
        backgroundColor: 'var(--tc-surface-chrome)',
        borderRight: '1px solid var(--td-component-stroke)',
      }}
    >
      {/* 主导航。
          原先这里有个品牌色「OP」方块，与窗口标题栏、通讯录头部重复表达
          「这是哪个应用」，且把第一个导航项往下顶 —— 去掉后导航条从顶部
          直接开始，视觉更干净。应用名由窗口标题承担。 */}
      <div className="flex flex-col items-center gap-1">
        {navItems.map(({ key, icon: Icon, label, badge }) => {
          const active = isActive(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onNavigate(key)}
              title={label}
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
              style={{
                backgroundColor: active ? 'var(--td-brand-color-light)' : 'transparent',
              }}
            >
              {/* 左侧激活指示条 */}
              <span
                className={`pointer-events-none absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-transform duration-200 ${
                  active ? 'scale-y-100' : 'scale-y-0'
                }`}
                style={{ backgroundColor: 'var(--td-brand-color)' }}
              />
              <Icon size={20} strokeWidth={active ? 2.5 : 2} />
              {badge !== undefined && badge > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-caption font-semibold shadow-card"
                  style={{ backgroundColor: 'var(--td-brand-color)', color: 'var(--tc-on-brand)' }}
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
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
          style={{
            backgroundColor: isActive('settings') ? 'var(--td-brand-color-light)' : 'transparent',
          }}
        >
          <span
            className={`pointer-events-none absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-transform duration-200 ${
              isActive('settings') ? 'scale-y-100' : 'scale-y-0'
            }`}
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          />
          <Settings size={20} strokeWidth={isActive('settings') ? 2.5 : 2} />
        </button>
      </div>
    </nav>
  );
}
