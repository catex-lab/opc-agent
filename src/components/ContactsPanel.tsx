import { useMemo, useState } from 'react';
import {
  RefreshCw,
  Search,
  Loader2,
  Plus,
  Users,
  PencilLine,
  IdCard,
  ChevronDown,
  ChevronRight,
  Download,
  Plug,
} from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { AgentHoverCard } from './AgentHoverCard';
import { GetAgentsDialog, isInstallable } from './GetAgentsDialog';
import { ContextMenu } from './ContextMenu';
import { RemarkDialog } from './RemarkDialog';
import { useAgentRemarks, setAgentRemark } from '../agentRemarks';
import {
  SEARCH_PILL_CLASS,
  SEARCH_ROW_CLASS,
  ROUND_ADD_CLASS,
  SEARCH_ICON_SIZE,
  ADD_ICON_SIZE,
} from './columnHeader';
import { NewGroupDialog } from './NewGroupDialog';
import { GroupAvatar } from './UserAvatar';
import { useGroupAvatar } from '../sessionFlags';
import { MENU_ITEM_CLASS } from './menuItem';
import { AVAILABILITY_META, REGION_META, availabilityLabelOf, type RegisteredAgent, type Session } from '../types';

interface ContactsPanelProps {
  agents: RegisteredAgent[];
  loading: boolean;
  probing: boolean;
  error: string | null;
  onProbe: () => void;
  /** 发起群聊：弹窗里勾到的成员 id 列表（与会话栏同一条建群路径） */
  onCreateGroup?: (agentIds: string[]) => void;
  /**
   * 查看某个 Agent 的详细资料。
   *
   * 列表行只留「头像 + 名称 + 在线圆点」，其余信息（介绍、能力、路径、
   * 接入方式、上次错误）全部收进二级页 —— 列表只管「谁在线」，细节进二级页。
   * 列表负责「快速扫一眼谁在线」，资料页负责「这个 Agent 到底是什么」。
   */
  onViewDetail: (agentId: string) => void;
  /** 按 id 反查注册表（群聊标题的兜底：成员名拼接） */
  getAgent?: (id: string | undefined) => RegisteredAgent | undefined;
  /** 已有的群聊会话（「群聊」Tab 列表数据源） */
  groups?: Session[];
  /** 打开某个群聊会话 */
  onSelectGroup?: (sessionId: string) => void;
  /** 窄屏单栏模式：铺满整宽、不要右边线 */
  compact?: boolean;
  /**
   * 跳到设置页某条 Agent 的凭据行（A71）。
   * 只有 `method:'key'` 的条目（豆包 / Kimi / WorkBuddy）会用到 ——
   * 它们不需要安装，缺的是 Key。不传就不画那个按钮（不做点不动的假控件）。
   */
  onOpenCredential?: (agentId: string) => void;
  /**
   * 去设置页添加一个模型厂商（A129）。
   *
   * A114 起这里是一个「自定义 Agent」弹窗，只收地址+模型，Key 与连通性
   * 都不在同一个地方 —— 用户填错模型名要等第一次对话才看到 404。
   * 现在整件事收进「设置 → 登录配置 → 自定义模型厂商」，这里只做跳转。
   */
  onAddProvider?: () => void;
}

type Tab = 'agents' | 'groups';

/**
 * 通讯录 —— IM 范式下 Agent 的主界面。
 *
 * ## 版式：IM 通讯录
 *
 * 头部是 IM 通讯录的紧凑结构：
 *
 *   1. **搜索胶囊 + 添加钮**。没有「通讯录」大标题 —— 搜索框就是入口，
 *      标题那一行 88px 全是留白；
 *   2. **Tab：AGENT | 群聊**。「群聊」= 已有群聊的目录 + 发起群聊的入口，
 *      与 IM 的「联系人 | 群聊」同构（但不做「新群聊」那样的常驻入口行 ——
 *      建群是低频操作，收在右上角 + 里）。
 *
 * ## 为什么不再按「在线 / 待处理 / 未接入」分段
 *
 * 早先列表分成三段，每段一个标题 + 计数 + 说明。问题是一份十来行的名单被
 * 三段标题切成三块：**找一个具体的人要先把三块都扫一遍**，而分段想表达的
 * 其实只有一件事 ——「谁现在能用」。那件事用**排序**表达就够了：
 * 在线的永远排在最上面，其余按原顺序跟在后面。
 *
 * 状态信息并没有丢：头像右下角的点表达在线/待处理/未接入，**行尾还有一句状态词**
 * （A134 起每一行都写，不再只写异常行），悬停名片里也有完整说明。
 * 也就是说：**去掉的是分类，不是信息**。
 *
 * ## 发起群聊在哪发生（A48 改）
 *
 * 点右上角 `+` → 菜单里的「发起群聊」→ 打开**与会话栏同一个**建群弹窗
 * （`NewGroupDialog`：左栏搜索 + AGENT 分组，右栏已选名单 + 完成/取消）。
 *
 * 早先这里是「通讯录内多选」：切到群聊 Tab、每行变勾选器、顶部一条确认条。
 * 用户要求两处入口统一成同一个新窗口逻辑，于是那套形态整块删掉了 ——
 * 同一件事在一个应用里只有一种做法，也省掉「+ 变成 X」这种状态切换。
 *
 * ## 宽度与会话栏对齐
 *
 * 这一栏与会话列表统一用 `--tc-sidebar-width`：两栏切换时中栏不会忽宽忽窄。
 */
export function ContactsPanel({
  agents,
  loading,
  probing,
  error,
  onProbe,
  onCreateGroup,
  onViewDetail,
  getAgent,
  groups = [],
  onSelectGroup,
  compact = false,
  onOpenCredential,
  onAddProvider,
}: ContactsPanelProps) {
  const [keyword, setKeyword] = useState('');
  /** Tab：AGENT（Agent 通讯录）/ 群聊目录 */
  const [tab, setTab] = useState<Tab>('agents');
  /**
   * 发起群聊弹窗（A48）。
   *
   * 原来这里是「多选模式」：点发起群聊 → 切到群聊 Tab、每行变勾选器、
   * 上方出现确认条。用户要求「和聊天页发起群聊同样的新窗口逻辑」——
   * 两处入口指向同一个 `NewGroupDialog`，勾选 / 已选名单 / 完成都在弹窗里，
   * 通讯录列表本身不再有第二种形态。
   */
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  /**
   * 「获取 Agent」清单弹窗（A71）。
   *
   * 新用户装完本应用时 14 条里约 11 条是「未安装」（安装包里只有定义，没有 CLI）。
   * 逐条点进资料页各找一次按钮，是把一件一次性的事拆成十一次 —— 所以主入口在这里。
   */
  const [getAgentsOpen, setGetAgentsOpen] = useState(false);
  /** 右上角「+」的下拉（发起群聊 / 重新探测） */
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const filter = (list: RegisteredAgent[]) =>
    keyword
      ? list.filter(
          a =>
            a.name.toLowerCase().includes(keyword.toLowerCase()) ||
            (a.vendor || '').toLowerCase().includes(keyword.toLowerCase()) ||
            (a.description || '').toLowerCase().includes(keyword.toLowerCase())
        )
      : list;

  /**
   * AGENT 列表：一条平铺的名单，**在线的排在最上面**。
   *
   * 排序而不是分段（见文件头注释）。`Array.prototype.sort` 在 V8 里是稳定排序，
   * 所以同在线的几个之间、同不可用的几个之间，保持注册表本来的顺序 ——
   * 不会因为「点了下搜索又清空」就换个队形。
   */
  const visibleAgents = useMemo(() => {
    const filtered = filter(agents);
    return [...filtered].sort((a, b) => {
      const ra = a.status.availability === 'ready' ? 0 : 1;
      const rb = b.status.availability === 'ready' ? 0 : 1;
      return ra - rb;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, keyword]);

  const total = agents.length;
  /** 一条都没就绪 = 真正的新用户场景（安装包里不带任何 CLI），值得在列表顶上提示 */
  const readyCount = agents.filter(a => a.status.availability === 'ready').length;
  const installableCount = agents.filter(isInstallable).length;

  /**
   * 同族分组（A68）。
   *
   * 规则：**只有同族 ≥2 条**才成组（14 条里只有 Kimi 与 Google 两组）。
   * 单条目不成组 —— 否则会冒出十几个只有一行的标题，把名单撑成一棵目录树。
   *
   * 位置取该族**排名最高那个成员**的名次。为什么不把组统一挪到最前或最后：
   * 那会让一个在线的成员排到一个离线的单条目下面，直接破坏上面那条
   * 「在线的排最上」—— 用户扫名单的第一诉求就是它。
   */
  const sections = useMemo(() => {
    const byFamily = new Map<string, RegisteredAgent[]>();
    for (const a of visibleAgents) {
      if (!a.family) continue;
      const list = byFamily.get(a.family) ?? [];
      list.push(a);
      byFamily.set(a.family, list);
    }
    const multi = new Set(
      [...byFamily.entries()].filter(([, members]) => members.length > 1).map(([key]) => key)
    );

    type Section =
      | { type: 'single'; agent: RegisteredAgent }
      | { type: 'family'; key: string; label: string; members: RegisteredAgent[] };

    const out: Section[] = [];
    const emitted = new Set<string>();
    for (const a of visibleAgents) {
      if (a.family && multi.has(a.family)) {
        if (emitted.has(a.family)) continue;
        emitted.add(a.family);
        out.push({
          type: 'family',
          key: a.family,
          // 显示名用后端的 `familyName`（官方产品族名），不用 family 这个机器键
          label: a.familyName ?? a.family,
          members: byFamily.get(a.family) ?? [a],
        });
      } else {
        out.push({ type: 'single', agent: a });
      }
    }
    return out;
  }, [visibleAgents]);

  /** 折叠状态：默认全部展开 —— 要展开才能看见谁在线，那就不是名单了 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  /** 群聊 Tab 的列表（按标题过滤） */
  const visibleGroups = useMemo(
    () =>
      keyword
        ? groups.filter(g => (g.title || '').toLowerCase().includes(keyword.toLowerCase()))
        : groups,
    [groups, keyword]
  );

  const switchTab = (next: Tab) => setTab(next);
  return (
    <div
      className={`flex flex-col ${compact ? 'w-full' : 'shrink-0'}`}
      style={{
        backgroundColor: 'var(--tc-surface-chrome)',
        // 与会话列表同一个宽度令牌，切栏不跳宽
        width: compact ? undefined : 'var(--tc-sidebar-width)',
        // A103：微圆角，与 ConversationList 同规格（见那里的注释）。
        // A26 的 `.tc-split-hairline` 分栏线随缝的出现一并移除。
        borderRadius: 'var(--tc-column-radius)',
      }}
    >
      {/*
        顶部：搜索胶囊 + 两个圆钮 + Tab。IM 通讯录式 —— 没有大标题，
        搜索就是入口。整块带底边线，与列表区同一框架色。
      */}
      <div
        className="shrink-0"
        style={{
          backgroundColor: 'var(--tc-surface-chrome)',
          borderBottom: '1px solid var(--tc-divider)',
          // A110：与 ConversationList 栏头同因同治 —— 铺满栏宽的不透明块
          // 会把父容器的圆角直角填平（父级 overflow 是 visible，不裁剪）。
          // 详见 ConversationList.tsx 里那段注释。
          borderRadius: 'var(--tc-column-radius) var(--tc-column-radius) 0 0',
        }}
      >
        <div className={SEARCH_ROW_CLASS}>
          {/* 搜索胶囊：圆角全圆，与 IM 的搜索框同一形态。
              尺寸类名来自 columnHeader.ts —— 与会话栏共用一份真源，
              两栏切换时搜索框不能有任何跳动。
              A84：底色已收进 SEARCH_PILL_CLASS（常态透明、hover/聚焦才浮现），
              这里不再内联 backgroundColor —— 两栏各写一份正是当初不一致的根因。 */}
          <div className={SEARCH_PILL_CLASS}>
            <Search size={SEARCH_ICON_SIZE} style={{ color: 'var(--td-text-color-placeholder)' }} />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="搜索 AGENT、群聊"
              className="w-full bg-transparent text-body outline-none"
              style={{ color: 'var(--td-text-color-primary)' }}
            />
          </div>

          {/* 右侧只留一个「+」：添加/建群/加好友全收在搜索框右边的这个加号里。
              原来这里是「探测 + 建群」两个圆钮 —— 探测是运维动作，不该和日常操作
              并排抢位置，收进菜单后搜索框还能宽一点。 */}
          {/* z-30：要压住下面那层「点外面关闭」的透明遮罩（z-20），
              否则菜单打开后这个按钮自己也被遮罩挡住，点第二下关不掉 */}
          <div className="relative z-30 shrink-0">
            <button
              type="button"
              onClick={() => setAddMenuOpen(v => !v)}
              title="添加"
              aria-label="添加"
              aria-expanded={addMenuOpen}
              className={`relative z-30 ${ROUND_ADD_CLASS}`}
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              <Plus size={ADD_ICON_SIZE} />
            </button>

            {addMenuOpen && (
              <>
                {/* 透明遮罩：点外面收起。details/summary 不会自己关，这里显式做 */}
                <div className="fixed inset-0 z-20" onClick={() => setAddMenuOpen(false)} />
                {/* A27：这里原来是内联 `backgroundColor: var(--td-bg-color-container)`，
                    而那个变量跟的是「抬升面」—— t=100 时归零，下拉就变成一块
                    透明玻璃纸，背后的联系人名单整片穿上来。浮层必须走
                    `.tc-glass`（底色 = `--tc-overlay-alpha`，下限 0.9）。
                    ⚠️ 不能再写内联背景色：内联优先级高于 class，会把玻璃底盖掉。 */}
                <div
                  className="tc-glass tc-pop-in absolute right-0 top-full z-30 mt-1 w-[168px] overflow-hidden rounded-xl py-1 shadow-popup"
                  data-contacts-add-menu
                >
                  {onCreateGroup && (
                    <button
                      type="button"
                      onClick={() => {
                        setAddMenuOpen(false);
                        setGroupDialogOpen(true);
                      }}
                      className={MENU_ITEM_CLASS}
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      <Users size={14} />
                      发起群聊
                    </button>
                  )}
                  {/* A129：自定义厂商收进设置页。这里只做跳转 —— 添加流程
                      要拉模型清单、测连通，弹窗里做不下，也不该做两套。 */}
                  <button
                    type="button"
                    onClick={() => {
                      setAddMenuOpen(false);
                      onAddProvider?.();
                    }}
                    className={MENU_ITEM_CLASS}
                    style={{ color: 'var(--td-text-color-primary)' }}
                    data-contacts-add-provider
                  >
                    <Plug size={14} />
                    添加模型厂商
                  </button>
                  {/* A71：获取入口。放在「重新探测」上面 —— 探测是运维动作，
                      获取是新用户第一次打开就要做的事，位置要更靠上。 */}
                  <button
                    type="button"
                    onClick={() => {
                      setAddMenuOpen(false);
                      setGetAgentsOpen(true);
                    }}
                    className={MENU_ITEM_CLASS}
                    style={{ color: 'var(--td-text-color-primary)' }}
                    data-contacts-get-agents
                  >
                    <Download size={14} />
                    获取 Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddMenuOpen(false);
                      onProbe();
                    }}
                    disabled={probing}
                    className={MENU_ITEM_CLASS}
                    style={{
                      color: 'var(--td-text-color-primary)',
                      opacity: probing ? 0.6 : 1,
                    }}
                  >
                    {probing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    重新探测
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Tab：AGENT / 群聊。激活项品牌色 + 下划线压在整块的底边线上。
            不带计数徽标 —— 分区行里已经有计数，Tab 再放一遍是重复信息。

            A37：从「左对齐 + 固定间距」改成**两等分居中**（用户要求
            「AGENT」和「群聊」居中平均分布）。用 grid 而不是 justify-around：
            两个按钮各占一半，下划线自然也就铺满半栏 —— 左对齐时那两条
            下划线只有文字那么宽，在窄栏里看起来像没对齐。 */}
        {/* mt-1.5 而不是原来的 mt-2.5：搜索行从 `pt-3` 改成与会话栏一致的
            `py-2`（多出 8px 下内边距），这里少 4px 让 Tab 行回到原来的位置 ——
            栏头总高不变，只是搜索框整体上移 4px 与会话栏对齐。 */}
        <div className="mt-1.5 grid grid-cols-2 px-4" role="tablist">
          {(
            [
              ['agents', 'AGENT'],
              ['groups', '群聊'],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => switchTab(key)}
              // 激活下划线用内联 borderBottom 写死 2px：Tailwind 的 border-b-2
              // 在运行时被 TDesign 的 button reset 压成 0px（computed 实测），
              // 内联样式优先级最高，可彻底规避这一层叠问题。-mb-px 让下划线
              // 压在整块的底边线上，形成「选中项贴住底栏」的效果。
              className="-mb-px flex items-center justify-center pb-2 text-body font-medium transition-colors"
              style={
                tab === key
                  ? { color: 'var(--td-brand-color)', borderBottom: '2px solid var(--td-brand-color)' }
                  : { color: 'var(--td-text-color-secondary)', borderBottom: '2px solid transparent' }
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div
          className="mx-3 mt-2 rounded-lg px-2.5 py-1.5 text-secondary"
          style={{ backgroundColor: 'var(--td-error-color-1)', color: 'var(--td-error-color-6)' }}
        >
          加载失败：{error}
        </div>
      )}

      {probing && (
        <div
          className="mx-3 mt-2 rounded-lg px-2.5 py-1.5 text-secondary"
          style={{ backgroundColor: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' }}
        >
          正在逐个探测本机 Agent，约需 20 秒…
        </div>
      )}

      {/* 列表区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* A71：一条都没就绪时给一条提示。这是**新用户的第一屏** ——
            安装包里只有定义、没有任何 CLI，所以他看到的是整列灰点。
            不提示的话，用户会以为应用坏了，而不是"需要自己装"。
            只在这一种情况下出现（readyCount === 0）：只要有一条能用，
            这条提示就变成噪音，改从「+ → 获取 Agent」进。 */}
        {tab === 'agents' && total > 0 && readyCount === 0 && (
          <button
            type="button"
            onClick={() => setGetAgentsOpen(true)}
            className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            style={{
              backgroundColor: 'var(--td-brand-color-light)',
              color: 'var(--td-brand-color)',
            }}
            data-get-agents-banner
          >
            <Download size={14} />
            <span className="min-w-0 flex-1 truncate text-caption">
              {installableCount > 0 ? `${installableCount} 个 Agent 还没就绪` : 'Agent 都还没就绪'}
              · 查看怎么获取
            </span>
          </button>
        )}
        {loading && total === 0 ? (
          <div
            className="px-3 py-10 text-center text-body"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            正在读取 Agent 名册…
          </div>
        ) : tab === 'agents' ? (
          /* ── AGENT Tab：一条平铺名单，在线的排最上 ── */
          <div data-contacts-list>
            {visibleAgents.length === 0 ? (
              <div
                className="px-3 py-10 text-center"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                <span className="tc-hint">{keyword ? '没有匹配的 AGENT' : '还没有探测到 Agent'}</span>
              </div>
            ) : (
            <div className="flex flex-col gap-0.5">
              {sections.map(s =>
                s.type === 'single' ? (
                  <ContactRow
                    key={s.agent.id}
                    agent={s.agent}
                    onViewDetail={() => onViewDetail(s.agent.id)}
                  />
                ) : (
                  /* 同族分组：标题可折叠。标题行本身不是 Agent，不可点开资料页 ——
                     点它只做一件事：收起/展开。 */
                  <section key={s.key} className="pt-1 first:pt-0" data-family-group={s.key}>
                    <button
                      type="button"
                      onClick={() => setCollapsed(c => ({ ...c, [s.key]: !c[s.key] }))}
                      aria-expanded={!collapsed[s.key]}
                      className="flex w-full items-center gap-1 rounded-md px-2.5 py-1 text-left"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                      title={`${s.label}（同族 ${s.members.length} 个，点此${collapsed[s.key] ? '展开' : '收起'}）`}
                    >
                      {collapsed[s.key] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <span className="truncate text-caption">{s.label}</span>
                      <span className="shrink-0 text-caption">{s.members.length}</span>
                    </button>
                    {!collapsed[s.key] &&
                      s.members.map(agent => (
                        <ContactRow
                          key={agent.id}
                          agent={agent}
                          onViewDetail={() => onViewDetail(agent.id)}
                        />
                      ))}
                  </section>
                )
              )}
            </div>
          )}
          </div>
        ) : (
          /* ── 群聊 Tab · 目录：已有的群聊 ──
              **没有分类标题**（用户明确要求去掉「我的群聊」这行字样）：
              Tab 本身已经说明了「这里是群聊」，再来一行标题只是把名单
              往下推 24px。数量也不单独列 —— 名单就在眼前，数一遍比读
              一个数字更直接。 */
          <section className="mb-4 pt-1">
            {visibleGroups.length === 0 ? (
              <div
                className="px-3 py-10 text-center"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                <span className="tc-hint">
                  {keyword ? '没有匹配的群聊' : '还没有群聊，点右上角 + 发起'}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {visibleGroups.map(session => (
                  <GroupRow
                    key={session.id}
                    session={session}
                    getAgent={getAgent}
                    onOpen={() => onSelectGroup?.(session.id)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {/* 发起群聊弹窗（A48）：与会话栏的「+ → 发起群聊」是**同一个组件**，
          不再有「通讯录内多选」这套第二种交互。 */}
      {onCreateGroup && (
        <NewGroupDialog
          open={groupDialogOpen}
          agents={agents}
          groups={groups}
          // getAgent 在这个组件里是可选 prop；弹窗需要它来查已选成员的名字。
          // 没传就就地按 id 在 agents 里找 —— 同一份数据，不必要求调用方补。
          getAgent={getAgent ?? (id => agents.find(a => a.id === id))}
          onClose={() => setGroupDialogOpen(false)}
          onCreate={ids => {
            setGroupDialogOpen(false);
            onCreateGroup(ids);
          }}
          onOpenGroup={id => {
            setGroupDialogOpen(false);
            onSelectGroup?.(id);
          }}
        />
      )}

      {/* 获取 Agent 清单（A71）：新用户的主入口。与资料页的「获取」卡片
          共用 InstallCard —— 同一件事只有一种做法。 */}
      <GetAgentsDialog
        open={getAgentsOpen}
        agents={agents}
        onClose={() => setGetAgentsOpen(false)}
        onReprobe={onProbe}
        onOpenCredential={onOpenCredential}
        onViewDetail={onViewDetail}
      />
    </div>
  );
}

interface ContactRowProps {
  agent: RegisteredAgent;
  onViewDetail: () => void;
}

/**
 * 通讯录的一行 —— 只放「头像 + 名称 + 在线圆点」。
 *
 * 原先这一行塞了厂商、版本、状态文字、描述、能力标签、接入方式，外加
 * 「对话」和「详情」两个按钮。信息密度过高，扫一眼看不出「谁在线」，
 * 反而要先读完每张卡片。现在按 IM 通讯录的做法：列表只负责识别与状态，
 * 其余信息全部收进二级资料页（AgentDetailPanel）。
 *
 * 在线与否由头像右下角的圆点 + **行尾的状态词**共同表达（A134 起每一行都有词，
 * 绿色不再是唯一线索）。原话是审查报告 P0-3：「状态文字不能只依赖绿、红、橙色小圆点」——
 * 圆点是给扫视用的，词是给读的，两者都得在。
 *
 * 行高、头像尺寸、内边距与会话列表的行完全一致（42px 头像 / px-2.5 py-2.5），
 * 两栏并排切换时列表节奏不跳。
 *
 * 行尾**不放 `>` 箭头**。IM 通讯录的行也没有箭头：整行本来就可点，
 * 悬停有底色反馈，箭头在 300px 的窄栏里只是把名称的可读宽度又切掉一截，
 * 属于「解释一个已经说清楚的事」。可点性靠 hover 态和 `title` 承担。
 */
function ContactRow({ agent, onViewDetail }: ContactRowProps) {
  const remarks = useAgentRemarks();
  const remark = remarks[agent.id] ?? '';
  /** 显示名：备注优先（与消息列表、聊天头部同一套规则） */
  const displayName = remark || agent.name;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const regionMeta = agent.region ? REGION_META[agent.region] : undefined;
  /** 角标文字；`any`（不分区）在 REGION_META 里就是空串，这里自然不渲染 */
  const regionBadge = regionMeta?.badge ?? '';

  const body = (
    <>
      {/* 头像悬停出名片：想确认「这个 Agent 是什么」不必先点进资料页 */}
      <AgentHoverCard agent={agent} onViewDetail={onViewDetail}>
        <AgentAvatar
          id={agent.id}
          name={displayName}
          icon={agent.icon}
          color={agent.color}
          availability={agent.status.availability}
          size={42}
        />
      </AgentHoverCard>
      <span
        className="min-w-0 flex-1 truncate text-body-lg font-medium"
        style={{ color: 'var(--td-text-color-primary)' }}
      >
        {displayName}
      </span>
      {/* 区域角标（A68）：CN / INTL 两个缩写。
          只在「有区域且不是不分区」时出现 —— 把「不分区」也画成角标，会让满屏都是
          角标、反而看不出重点。title 用后端下发的**厂商官方口径**
          （腾讯「国内版」/ Kimi「中国站」），我们不自创一套统一叫法去覆盖它。 */}
      {regionBadge && (
        <span
          className="shrink-0 rounded px-1 text-caption"
          style={{ color: 'var(--td-text-color-placeholder)' }}
          title={`区域：${agent.regionName ?? regionMeta?.label ?? regionBadge}`}
          data-region-badge={regionBadge}
        >
          {regionBadge}
        </span>
      )}
      {/* 状态词：**每一行都写**，不只写异常行（A134 / 审查报告 P0-3）。
          原来只有非 ready 行才有文字，于是「三个 Agent 只有绿点、Gemini 有橙字」——
          同一列表两种表达方式，用户读不出绿点到底是「已安装」还是「已连接」还是
          「可用」。而底层 7 档状态一直是够的，缺的只是把词铺出来。
          文字比颜色可靠（色觉障碍、深浅色主题下都读得到），颜色只是**附加**线索；
          配色走 `--tc-status-*`，浅深两档都过了 4.5:1（见 index.css 那段注释）。 */}
      <span
        className="shrink-0 text-caption"
        style={{ color: AVAILABILITY_META[agent.status.availability].color }}
        data-agent-status={agent.status.availability}
      >
        {availabilityLabelOf(agent)}
      </span>
    </>
  );

  const rowClass = 'tc-list-item flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left';

  return (
    <>
      <button
        type="button"
        onClick={onViewDetail}
        // 渲染自检脚本靠这个锚点进资料页（整行可点，不必先悬停出头像名片）
        data-agent-row={agent.id}
        // 右键出菜单：改备注（本地别名）/ 看资料。
        // 挂在整行而不是只挂头像 —— 头像只有 42px，行是同一个目标的大靶子；
        // 用户说的「右键头像」自然落在行上，也仍然成立。
        onContextMenu={e => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`查看 ${displayName} 的资料`}
        className={rowClass}
      >
        {body}
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              key: 'remark',
              label: '修改备注',
              icon: <PencilLine size={14} />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'detail',
              label: '查看资料',
              icon: <IdCard size={14} />,
              onSelect: onViewDetail,
            },
          ]}
        />
      )}

      <RemarkDialog
        open={editing}
        name={agent.name}
        value={remark}
        onCancel={() => setEditing(false)}
        onSave={next => {
          setAgentRemark(agent.id, next);
          setEditing(false);
        }}
      />
    </>
  );
}

interface GroupRowProps {
  session: Session;
  /** 按 id 反查注册表（群标题的兜底：成员名拼接） */
  getAgent?: (id: string | undefined) => RegisteredAgent | undefined;
  onOpen: () => void;
}

/**
 * 群聊 Tab 的一行 —— 已有群聊的目录。
 *
 * 标题优先用会话标题；没起过名（本地新建的群默认空标题）时退化为
 * 成员名拼接，与消息栏的兜底逻辑一致。右侧显示人数。
 */
function GroupRow({ session, getAgent, onOpen }: GroupRowProps) {
  const memberNames = (session.agentIds ?? [])
    .map(id => getAgent?.(id)?.name)
    .filter(Boolean) as string[];
  const title =
    session.title ||
    (memberNames.length > 0 ? memberNames.join('、') : '群聊') ||
    '群聊';
  // A115：订阅这个群的头像（Hook 必须放在组件顶层，不能写在 JSX 里）
  const groupAvatar = useGroupAvatar(session.id);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`打开群聊：${title}`}
      className="tc-list-item flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left"
    >
      {/* A115：群头像。与会话列表、群聊头部共用同一个 GroupAvatar ——
          用户在群设置里换的头像，三个地方必须同时变，否则「换了没换」
          要看运气。 */}
      <GroupAvatar avatar={groupAvatar} size={42} />
      <span
        className="min-w-0 flex-1 truncate text-body-lg font-medium"
        style={{ color: 'var(--td-text-color-primary)' }}
      >
        {title}
      </span>
      <span className="tc-hint shrink-0">{session.agentIds?.length ?? 0} 人</span>
    </button>
  );
}
