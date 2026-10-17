import { useMemo, useState } from 'react';
import {
  RefreshCw,
  Search,
  Loader2,
  UserPlus,
  Users,
  ArrowRight,
  Check,
  X,
} from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { PanelHeader } from './PanelHeader';
import { type RegisteredAgent } from '../types';

interface ContactsPanelProps {
  agents: RegisteredAgent[];
  grouped: {
    ready: RegisteredAgent[];
    actionNeeded: RegisteredAgent[];
    unavailable: RegisteredAgent[];
  };
  loading: boolean;
  probing: boolean;
  error: string | null;
  onProbe: () => void;
  /** 发起群聊：传入勾选到的在线成员 id 列表 */
  onCreateGroup?: (agentIds: string[]) => void;
  /**
   * 查看某个 Agent 的详细资料。
   *
   * 列表行只留「头像 + 名称 + 在线圆点」，其余信息（介绍、能力、路径、
   * 接入方式、上次错误）全部收进二级页 —— 参照微信通讯录点开好友资料。
   * 列表负责「快速扫一眼谁在线」，资料页负责「这个 Agent 到底是什么」。
   */
  onViewDetail: (agentId: string) => void;
}

/**
 * 通讯录 —— IM 范式下 Agent 的主界面。
 *
 * 按「在线 / 待处理 / 未接入」三段分组，而不是按厂商或字母序。
 * 理由：用户打开通讯录的真实意图是「我现在能用谁」和「谁还不能用、为什么」，
 * 分组直接对应这两个问题，不用在一堆灰头像里找原因。
 *
 * ## 宽度与会话栏对齐
 *
 * 这一栏原先是 `flex-1`，于是和右侧主区各占一半（1080 窗口下约 560px）。
 * 但列表行已经精简成「头像 + 名称」，560px 宽的行里名称右端到栏边空出四百
 * 多像素，看着像布局塌了；更麻烦的是从「消息」切到「通讯录」时，
 * 中栏宽度从 300 跳到 560，同一个位置的栏忽宽忽窄。
 *
 * 所以这里与会话列表统一成 300px 定宽 + `level="column"` 标题栏。
 * 代价是标题栏塞不下两个文字按钮，右侧操作改为图标按钮（与「消息」栏的
 * `+` 一致），多选建群的确认条也相应压窄。
 */
export function ContactsPanel({
  agents,
  grouped,
  loading,
  probing,
  error,
  onProbe,
  onCreateGroup,
  onViewDetail,
}: ContactsPanelProps) {
  const [keyword, setKeyword] = useState('');
  // 多选建群模式。null = 普通通讯录；Set = 正在勾选成员
  const [selecting, setSelecting] = useState<Set<string> | null>(null);

  const filter = (list: RegisteredAgent[]) =>
    keyword
      ? list.filter(
          a =>
            a.name.toLowerCase().includes(keyword.toLowerCase()) ||
            (a.vendor || '').toLowerCase().includes(keyword.toLowerCase()) ||
            (a.description || '').toLowerCase().includes(keyword.toLowerCase())
        )
      : list;

  const sections = useMemo(
    () => [
      { key: 'ready', title: '在线', hint: '可直接对话', list: filter(grouped.ready) },
      {
        key: 'action',
        title: '待处理',
        hint: '需登录或修复',
        list: filter(grouped.actionNeeded),
      },
      {
        key: 'unavailable',
        title: '未接入',
        hint: '未安装',
        list: filter(grouped.unavailable),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grouped, keyword]
  );

  const total = agents.length;

  /** 进入/退出多选建群 */
  const toggleSelecting = () => {
    setSelecting(prev => (prev ? null : new Set()));
  };

  /** 勾选或取消一个成员。只允许勾选在线的 —— 拉一个必然失败的人进群没有意义 */
  const toggleMember = (id: string) => {
    setSelecting(prev => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCount = selecting?.size ?? 0;

  const submitGroup = () => {
    if (!selecting || selectedCount === 0 || !onCreateGroup) return;
    onCreateGroup([...selecting]);
    setSelecting(null);
  };

  const actionBtn = 'flex h-8 w-8 items-center justify-center rounded-lg transition-colors';

  return (
    <div
      className="flex w-[300px] shrink-0 flex-col"
      style={{
        backgroundColor: 'var(--td-bg-color-container)',
        borderRight: '1px solid var(--td-component-stroke)',
      }}
    >
      {/* 顶部。搜索框放在 children 里，与标题共用同一条底边线 ——
          与会话栏的结构完全一致，切换导航时栏头不会跳 */}
      <PanelHeader
        level="column"
        title="通讯录"
        subtitle={
          selecting
            ? `已选 ${selectedCount} 人`
            : `${total} 个 Agent · ${grouped.ready.length} 在线`
        }
        actions={
          <>
            <button
              type="button"
              onClick={toggleSelecting}
              title={selecting ? '退出多选' : '发起群聊（多选在线成员）'}
              aria-label={selecting ? '退出多选' : '发起群聊'}
              aria-pressed={!!selecting}
              className={actionBtn}
              style={{
                backgroundColor: selecting
                  ? 'var(--td-brand-color)'
                  : 'var(--td-bg-color-secondarycontainer)',
                color: selecting ? '#fff' : 'var(--td-text-color-secondary)',
              }}
            >
              {selecting ? <X size={16} /> : <UserPlus size={16} />}
            </button>

            <button
              type="button"
              onClick={onProbe}
              disabled={probing}
              title="重新探测本机 Agent 状态"
              aria-label="重新探测"
              className={actionBtn}
              style={{
                backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                color: 'var(--td-text-color-secondary)',
                opacity: probing ? 0.6 : 1,
              }}
            >
              {probing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            </button>
          </>
        }
      >
      </PanelHeader>

      {/* 多选模式下的确认条：常驻在列表上方，选几个人一目了然 */}
      {selecting && (
        <div
          className="mx-3 mt-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5"
          style={{
            backgroundColor: 'var(--td-brand-color-light)',
            border: '1px solid var(--td-brand-color-focus)',
          }}
        >
          <Users size={14} style={{ color: 'var(--td-brand-color)' }} />
          <span className="text-body" style={{ color: 'var(--td-text-color-primary)' }}>
            已选 <strong style={{ color: 'var(--td-brand-color)' }}>{selectedCount}</strong>
          </span>
          <button
            type="button"
            onClick={submitGroup}
            disabled={selectedCount === 0}
            className="tc-btn-brand ml-auto px-2.5 py-1 text-secondary"
          >
            创建群聊
            <ArrowRight size={12} />
          </button>
        </div>
      )}

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

      {/* 分组列表。搜索框吸顶，不占标题栏高度 —— 理由见 PanelHeader 的
          children 注释（栏头塞进搜索框会让标题被顶高 4px）。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div
          className="sticky top-0 z-10 -mx-2 px-2 pb-2 pt-2"
          style={{ backgroundColor: 'var(--td-bg-color-container)' }}
        >
          <div
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
            style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
          >
            <Search size={14} style={{ color: 'var(--td-text-color-placeholder)' }} />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="搜索 Agent 或厂商"
              className="w-full bg-transparent text-body outline-none"
              style={{ color: 'var(--td-text-color-primary)' }}
            />
          </div>
        </div>

        {loading && total === 0 ? (
          <div
            className="px-3 py-10 text-center text-body"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            正在读取 Agent 名册…
          </div>
        ) : (
          sections.map(section => {
            // 多选建群时只保留「在线」组：待处理/未接入的 Agent 勾了也进不了群，
            // 摆在这里只会诱导用户做一件必然失败的操作
            if (selecting && section.key !== 'ready') return null;

            return (
              <section key={section.key} className="mb-4">
                <div className="mb-1 flex items-baseline gap-1.5 px-2">
                  <h3 className="tc-section-title text-body">{section.title}</h3>
                  <span className="text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {section.list.length}
                  </span>
                  <span className="tc-hint ml-auto truncate">
                    {selecting ? '点击选择' : section.hint}
                  </span>
                </div>

                {section.list.length === 0 ? (
                  <div
                    className="px-3 py-4 text-center"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    <span className="tc-hint">
                      {selecting ? '没有可邀请的在线成员' : '这一组暂无 Agent'}
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {section.list.map(agent => (
                      <ContactRow
                        key={agent.id}
                        agent={agent}
                        selectable={!!selecting}
                        selected={!!selecting && selecting.has(agent.id)}
                        onSelect={() => toggleMember(agent.id)}
                        onViewDetail={() => onViewDetail(agent.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

interface ContactRowProps {
  agent: RegisteredAgent;
  /** 多选建群模式：整行变成勾选器 */
  selectable?: boolean;
  selected?: boolean;
  onSelect: () => void;
  onViewDetail: () => void;
}

/**
 * 通讯录的一行 —— 只放「头像 + 名称 + 在线圆点」。
 *
 * 原先这一行塞了厂商、版本、状态文字、描述、能力标签、接入方式，外加
 * 「对话」和「详情」两个按钮。信息密度过高，扫一眼看不出「谁在线」，
 * 反而要先读完每张卡片。现在按微信通讯录的做法：列表只负责识别与状态，
 * 其余信息全部收进二级资料页（AgentDetailPanel）。
 *
 * 在线与否由头像右下角的圆点表达（绿=在线 / 橙=待处理 / 红=需修复 /
 * 灰=未接入）。颜色不是唯一线索 —— AgentAvatar 的 title 里带了状态文字，
 * 悬停即可读到，不至于让色觉障碍用户完全失去信息。
 *
 * 行高、头像尺寸、内边距与会话列表的行完全一致（42px 头像 / px-2.5 py-2.5），
 * 两栏并排切换时列表节奏不跳。
 *
 * 行尾**不放 `>` 箭头**。微信通讯录的行也没有箭头：整行本来就可点，
 * 悬停有底色反馈，箭头在 300px 的窄栏里只是把名称的可读宽度又切掉一截，
 * 属于「解释一个已经说清楚的事」。可点性靠 hover 态和 `title` 承担。
 * （多选建群时行尾有勾选圈，那是操作控件，不是指示符，另当别论。）
 */
function ContactRow({
  agent,
  selectable = false,
  selected = false,
  onSelect,
  onViewDetail,
}: ContactRowProps) {
  const body = (
    <>
      <AgentAvatar
        id={agent.id}
        name={agent.name}
        icon={agent.icon}
        color={agent.color}
        availability={agent.status.availability}
        size={42}
      />
      <span
        className="min-w-0 flex-1 truncate text-body-lg font-medium"
        style={{ color: 'var(--td-text-color-primary)' }}
      >
        {agent.name}
      </span>
      {selectable && (
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors"
          style={{
            backgroundColor: selected ? 'var(--td-brand-color)' : 'transparent',
            border: selected ? 'none' : '1.5px solid var(--td-component-stroke)',
            color: '#fff',
          }}
        >
          {selected && <Check size={12} />}
        </span>
      )}
    </>
  );

  const rowClass = `tc-list-item flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left${
    selected ? ' is-active' : ''
  }`;

  // 多选建群：整行就是勾选器，点哪儿都能选中
  if (selectable) {
    return (
      <button type="button" onClick={onSelect} aria-pressed={selected} className={rowClass}>
        {body}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onViewDetail}
      title={`查看 ${agent.name} 的资料`}
      className={rowClass}
    >
      {body}
    </button>
  );
}
