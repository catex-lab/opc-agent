import { useMemo, useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Search, Users, X, UserPlus, UserMinus, Plus } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { AgentHoverCard } from './AgentHoverCard';
import { MENU_ITEM_SM_CLASS } from './menuItem';
import { AVAILABILITY_META, availabilityLabelOf, type RegisteredAgent } from '../types';

/**
 * 群聊右侧成员栏。
 *
 * ## 为什么放在右侧而不是塞进头部
 *
 * 头部已经压到 52px（见 GroupChatHeader 的注释），成员头像堆叠只能表达
 * 「有几个人」，说不出「都有谁、谁在线」。而「这个群里到底有谁」是群聊里
 * 仅次于消息本身的信息 —— 值得一条独立的栏，而不是再往下撑高头部。
 *
 * ## 只在宽屏出现
 *
 * 三栏 + 成员栏在 1440 下每栏都还有余量，到 1080 就挤了。所以 `< lg` 直接
 * 隐藏（`hidden lg:flex`）：窄屏下成员信息仍可从头部头像堆叠进入，不会丢功能。
 *
 * ## 可以折叠
 *
 * 成员栏是**参考信息**，不是主操作区：开会话、读消息时它占着 236px 是浪费，
 * 想确认「谁在线」时又必须能立刻打开。所以折叠后不留空白、也不整个消失，
 * 而是收成一条 44px 的竖条 —— 宽度还给消息区，入口还在原处。
 * 折叠状态是组件内部状态（不落盘）：它跟着「这一屏我在干什么」走，
 * 不属于需要跨会话记住的偏好。
 *
 * ## 宽度与会话栏同源
 *
 * 用 `--tc-member-panel-width` 令牌，和 `--tc-sidebar-width` 一起定义在
 * index.css。两处宽度都是「布局常量」，散落在组件里迟早对不齐。
 */

/**
 * 折叠后完全消失，只在右侧留一条**悬停热区**。
 *
 * 早先是收成一条 44px 的竖条，但那条竖条本身仍占着宽度 —— 用户折叠的
 * 目的就是「把这块让出来」，收成 44px 只让出了 80%。现在：
 *
 *   · 默认什么都不显示（消息区吃满整宽）；
 *   · 鼠标移到窗口右缘约 10px 内，浮出一个圆形箭头按钮；
 *   · 点它展开回 236px。
 *
 * 热区只有 10px 宽，按钮 36px 挂在它左侧（绝对定位溢出），鼠标从热区
 * 移到按钮上时祖先的 `:hover` 仍然成立（`:hover` 会作用于被悬停元素的
 * 所有祖先），所以按钮不会「一碰就消失」。
 *
 * ⚠️ 这个热区是 `absolute` 的，依赖父容器 `relative`（见 ChatPage 的
 *    聊天区外层）。父容器不加 relative，热区会挂到视口上去。
 */
const EDGE_WIDTH = 10;

interface GroupMemberPanelProps {
  members: RegisteredAgent[];
  /**
   * 注册表里的**全部** Agent。
   *
   * 「邀请」需要它才能算出「谁还没进群」。只传 members 的话，面板只能删人、
   * 永远加不回来（而且会有成员的 id 在注册表里查不到 —— 反查时已过滤掉）。
   */
  allAgents: RegisteredAgent[];
  /** 成员变动回调（本地 + PATCH 持久化，见 App.handleMembersChange） */
  onMembersChange: (agentIds: string[]) => void;
}

export function GroupMemberPanel({ members, allAgents, onMembersChange }: GroupMemberPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);
  /**
   * 默认**折叠**（A72，用户要求）。
   *
   * 理由：这一栏是"谁在群里"的查阅面板，不是聊天主路径。236px 常驻会把
   * 消息区挤掉四分之一，而用户九成时间不需要看它。折叠后右缘只留 10px
   * 悬停热区，鼠标过去就浮出展开按钮 —— 需要时一秒能拿到，不需要时不占地。
   */
  const [collapsed, setCollapsed] = useState(true);
  const [inviting, setInviting] = useState(false);
  const inviteBoxRef = useRef<HTMLDivElement>(null);

  /**
   * 点面板外面就收起邀请列表。
   *
   * 用 document 级的 pointerdown 而不是 onBlur：面板里的项是 <button>，
   * 点了之后焦点会跑到按钮上，blur 到面板自己身上那次是「点了面板内的项」，
   * 用 onBlur 会把刚点开的那一下也当成「外面」而立刻关掉。
   */
  useEffect(() => {
    if (!inviting) return;
    const onDown = (e: PointerEvent) => {
      const box = inviteBoxRef.current;
      if (!box) return;
      // closest 能覆盖「点在面板里的滚动条/子元素上」这些情况
      if (!box.contains(e.target as Node)) setInviting(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [inviting]);

  /** 还没进群的 Agent（按是否 ready 排序，方便先看到能用的） */
  const notInGroup = useMemo(() => {
    const inside = new Set(members.map(m => m.id));
    return allAgents
      .filter(a => !inside.has(a.id))
      .sort((a, b) => {
        const ra = a.status.availability === 'ready' ? 0 : 1;
        const rb = b.status.availability === 'ready' ? 0 : 1;
        return ra - rb;
      });
  }, [allAgents, members]);

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const filtered = kw ? members.filter(m => m.name.toLowerCase().includes(kw)) : members;
    // 在线的排前面：这一栏最常被问的就是「现在谁能接活」
    return [...filtered].sort((a, b) => {
      const ra = a.status.availability === 'ready' ? 0 : 1;
      const rb = b.status.availability === 'ready' ? 0 : 1;
      return ra - rb;
    });
  }, [members, keyword]);

  /* ── 折叠态：整块消失，右缘留一条悬停热区 ── */
  if (collapsed) {
    return (
      <div
        className="group/edge absolute inset-y-0 right-0 z-20 hidden lg:block"
        style={{ width: EDGE_WIDTH }}
        aria-label="群聊成员（已折叠）"
        data-member-panel-collapsed
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="展开群成员"
          aria-label="展开群成员"
          aria-expanded={false}
          className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full opacity-0 shadow-card transition-opacity duration-150 group-hover/edge:opacity-100 focus-visible:opacity-100"
          style={{
            backgroundColor: 'var(--td-bg-color-container)',
            // 这是**控件**的轮廓，不是板块分割线 —— A25 把 --tc-divider
            // 置为 transparent 之后，这里如果还挂着它，按钮就变成一团没有
            // 边界的浮影。控件描边走 --tc-edge-strong（7% 墨，A83 给
            // 「需要明确可点的控件」定的一档）：比板块描边的 4.5% 重一档，
            // 9px 的热区在成员栏边缘才立得住；也不再使用 10% 的
            // --td-component-stroke —— 那是「把界面切成格子」的老语言。
            border: '1px solid var(--tc-edge-strong)',
            color: 'var(--td-text-color-secondary)',
          }}
        >
          <ChevronLeft size={16} />
        </button>
      </div>
    );
  }

  return (
    <aside
      className="relative hidden shrink-0 flex-col lg:flex"
      style={{
        width: 'var(--tc-member-panel-width)',
        backgroundColor: 'var(--tc-surface-chrome)',
        borderLeft: '1px solid var(--tc-divider)',
      }}
      aria-label="群聊成员"
    >
      {/* 栏头：标题 + 人数 + 搜索开关 + 折叠。高度与聊天头部（52px）对齐 */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-3"
        style={{ height: 'var(--tc-header-height)', borderBottom: '1px solid var(--tc-divider)' }}
      >
        <Users size={14} style={{ color: 'var(--td-text-color-secondary)' }} />
        <span
          className="text-body font-semibold"
          style={{ color: 'var(--td-text-color-primary)' }}
        >
          群聊成员
        </span>
        <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {members.length}
        </span>
        {/* 这里**不再**写「N 在线」：聊天头部就在上面 40px 处有一个同名徽标，
            236px 的栏头里塞两份同样的数字，换来的是两个按钮被挤到贴边。
            在线与否在列表里已经表达（在线优先排序 + 离线行标状态）。 */}
        <button
          type="button"
          onClick={() => {
            setSearching(v => !v);
            if (searching) setKeyword('');
          }}
          title={searching ? '关闭搜索' : '搜索成员'}
          aria-label={searching ? '关闭成员搜索' : '搜索成员'}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md transition-colors"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          {searching ? <X size={13} /> : <Search size={13} />}
        </button>
        {/* 邀请成员：打开「还没进群」的列表。放在栏头而不是列表末尾 ——
            加人是群聊的高频动作，藏到滚动到底才看见不合适。 */}
        <button
          type="button"
          onClick={() => setInviting(v => !v)}
          title="邀请成员"
          aria-label="邀请成员"
          aria-expanded={inviting}
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
          /* A75：底色不写内联 —— 内联的 'transparent' 会压死 hover 反馈，
             三态（常态 / 悬停 / 展开）统一交给 index.css 的
             [data-invite-toggle] 那组规则。 */
          style={{
            color: inviting ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
          }}
          data-invite-toggle
        >
          <UserPlus size={13} />
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="折叠成员栏"
          aria-label="折叠成员栏"
          aria-expanded
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <ChevronRight size={13} />
        </button>
      </div>

      {searching && (
        <div className="shrink-0 px-2.5 pt-2">
          {/* A84：与两栏栏头的搜索胶囊同一条规则 —— 常态透明，聚焦才浮现底色。
              这个输入框是 searching 时才挂载且 autoFocus，所以视觉上仍然是
              「一出现就带着底」，但那层底来自聚焦态而不是常驻。 */}
          <div className="flex items-center gap-1.5 rounded-full bg-transparent px-2.5 py-1 transition-colors focus-within:bg-[var(--tc-fill-hover)]">
            <Search size={12} style={{ color: 'var(--td-text-color-placeholder)' }} />
            <input
              autoFocus
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="搜索成员"
              className="w-full bg-transparent text-secondary outline-none"
              style={{ color: 'var(--td-text-color-primary)' }}
            />
          </div>
        </div>
      )}

      {/* 邀请面板。挂在栏头顶部下方、相对 aside 定位（aside 已加 relative）。
          用 A27 那套浮层规格（`--tc-overlay-surface` 底 + .tc-glass），
          它压在成员列表之上，alpha 下限 0.9 才能保证字不透出来。 */}
      {inviting && (
        <div
          ref={inviteBoxRef}
          className="tc-glass tc-pop-in absolute right-2 top-[calc(var(--tc-header-height)+6px)] z-30 w-[204px] overflow-hidden rounded-xl py-1 shadow-popup"
          data-invite-panel
          role="dialog"
          aria-label="可邀请的 Agent"
        >
          {notInGroup.length === 0 ? (
            <div
              className="px-3 py-2.5 text-caption"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              所有 Agent 都已在群内
            </div>
          ) : (
            <div className="max-h-[280px] overflow-y-auto">
              {notInGroup.map(agent => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    onMembersChange([...members.map(m => m.id), agent.id]);
                    setInviting(false);
                  }}
                  className={MENU_ITEM_SM_CLASS}
                  data-invite-item={agent.id}
                >
                  <AgentAvatar
                    id={agent.id}
                    name={agent.name}
                    icon={agent.icon}
                    color={agent.color}
                    size={22}
                    availability={agent.status.availability}
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-secondary"
                    style={{ color: 'var(--td-text-color-primary)' }}
                  >
                    {agent.name}
                  </span>
                  {/* 未就绪的标出来：邀请一个连不上的 Agent 进来，
                      下次编排时会因为它不可用而整轮失败，不如先说明 */}
                  {agent.status.availability !== 'ready' && (
                    <span className="shrink-0 text-caption" style={{ color: AVAILABILITY_META[agent.status.availability].color }}>
                      {availabilityLabelOf(agent)}
                    </span>
                  )}
                  <Plus size={12} className="shrink-0" style={{ color: 'var(--td-text-color-placeholder)' }} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {list.length === 0 ? (
          <div
            className="px-3 py-8 text-center text-secondary"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            {keyword ? '没有匹配的成员' : '这个群还没有成员'}
          </div>
        ) : (
          list.map(member => {
            const ready = member.status.availability === 'ready';
            const meta = AVAILABILITY_META[member.status.availability];
            // 只剩一个人时不许移出：空群既发不了消息（编排器无对象可派），
            // 也会让用户从群聊里凭空失去这个会话的入口。
            const lastOne = members.length <= 1;
            return (
              <div
                key={member.id}
                className="tc-list-item group flex items-center gap-2 px-2 py-1.5"
                title={`${member.name} · ${meta.label}`}
                data-member-row={member.id}
              >
                <AgentHoverCard agent={member}>
                  <AgentAvatar
                    id={member.id}
                    name={member.name}
                    icon={member.icon}
                    color={member.color}
                    size={28}
                    availability={member.status.availability}
                  />
                </AgentHoverCard>
                <span
                  className="min-w-0 flex-1 truncate text-body"
                  style={{
                    color: ready ? 'var(--td-text-color-primary)' : 'var(--td-text-color-placeholder)',
                  }}
                >
                  {member.name}
                </span>
                {!ready && (
                  <span className="shrink-0 text-caption" style={{ color: meta.color }}>
                    {availabilityLabelOf(member)}
                  </span>
                )}
                {/* 移出。A35（用户反馈）：**常驻可见**（45% 对比），悬停整行
                    才提到 100%。
                    改前是 `opacity-0` —— 按钮在 DOM 里、功能也通，但默认完全
                    透明，用户在这一栏里看到的是一条「没有任何操作」的成员行，
                    于是反馈「这里加一个移出功能」。功能不缺，是入口看不见。
                    常驻低对比既保留了「不喧宾夺主」，也让人一眼知道这里能动。
                    键盘可达性不受影响：focus-visible 会把它提到 100%。 */}
                <button
                  type="button"
                  disabled={lastOne}
                  onClick={() =>
                    onMembersChange(members.filter(m => m.id !== member.id).map(m => m.id))
                  }
                  title={lastOne ? '至少保留一位成员' : `将 ${member.name} 移出群聊`}
                  aria-label={lastOne ? '至少保留一位成员' : `将 ${member.name} 移出群聊`}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-45 transition-opacity hover:bg-[var(--tc-hover-chrome)] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                  data-remove-member={member.id}
                >
                  <UserMinus size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
