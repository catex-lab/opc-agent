import { useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Trash2,
  Pin,
  PinOff,
  Bell,
  BellOff,
  Copy,
  MailOpen,
  Mail,
  Users,
  UserPlus,
  Download,
  PencilLine,
} from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { AgentHoverCard } from './AgentHoverCard';
import { ContextMenu } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { RemarkDialog } from './RemarkDialog';
import { NewGroupDialog } from './NewGroupDialog';
import { MENU_ITEM_CLASS } from './menuItem';
import {
  SEARCH_PILL_CLASS,
  SEARCH_ROW_CLASS,
  ROUND_ADD_CLASS,
  SEARCH_ICON_SIZE,
  ADD_ICON_SIZE,
} from './columnHeader';
import {
  useSessionFlags,
  toggleMuted,
  setManuallyUnread,
  setGroupRemark,
} from '../sessionFlags';
import { useAgentRemarks, setAgentRemark } from '../agentRemarks';
import { AVAILABILITY_META, type RegisteredAgent, type Session } from '../types';

const LAST_READ_KEY = 'opc:lastRead';

/** 读取「上次已读时间」表，用于算未读红点 */
export function readLastReadMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_READ_KEY) || '{}');
  } catch {
    return {};
  }
}

/** 标记某个会话已读 */
export function markSessionRead(sessionId: string): void {
  try {
    const map = readLastReadMap();
    map[sessionId] = new Date().toISOString();
    localStorage.setItem(LAST_READ_KEY, JSON.stringify(map));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

interface ConversationListProps {
  sessions: Session[];
  currentSessionId: string | null;
  getAgent: (id: string | undefined) => RegisteredAgent | undefined;
  /** 点「+」菜单里的「重新探测」：去通讯录（那里才是发现 / 探测 Agent 的地方） */
  onAddContacts: () => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  /** 置顶 / 取消置顶 */
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  /** 导出为 Markdown */
  onExport?: (sessionId: string) => void;
  /** 窄屏单栏模式：铺满整宽、不要右边线 */
  compact?: boolean;
  /** 「发起群聊」弹窗的成员池：通讯录里的全部 Agent */
  agents: RegisteredAgent[];
  /** 「发起群聊」弹窗里「选择一个已有群」的数据源 */
  groups: Session[];
  /** 建群：把勾选到的成员 id 交给上层（与通讯录建群同一条路径） */
  onCreateGroup: (agentIds: string[]) => void;
  /** 建群弹窗里点已有群：直接进那个群 */
  onSelectGroup: (sessionId: string) => void;
}

/**
 * 会话列表 —— 社交应用里的「消息」页。
 *
 * 与工具型界面的关键差别：一对一会话的主标题是**联系人的名字**（Agent 名），
 * 而不是从第一条消息截出来的会话标题。会话标题降级为副信息，
 * 只在标题确实提供额外信息（用户改过名）时才显示。
 */
export function ConversationList({
  sessions,
  currentSessionId,
  getAgent,
  onAddContacts,
  onSelect,
  onDelete,
  onTogglePin,
  onExport,
  compact = false,
  agents,
  groups,
  onCreateGroup,
  onSelectGroup,
}: ConversationListProps) {
  const [keyword, setKeyword] = useState('');
  /** 「+」的下拉菜单是否打开（发起群聊 / 重新探测） */
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  /** 发起群聊弹窗是否打开 */
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  /** 右键菜单：位置来自指针坐标，targetId 是它指向的那一行 */
  const [menu, setMenu] = useState<{ targetId: string; x: number; y: number } | null>(null);
  /** 待确认删除的会话（null = 没有对话框） */
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const lastRead = useMemo(() => readLastReadMap(), [sessions, currentSessionId]);
  /** 免打扰 / 手动标记未读（本地标记，见 sessionFlags.ts） */
  const flags = useSessionFlags();
  /** Agent 备注（本地别名，见 agentRemarks.ts） */
  const remarks = useAgentRemarks();
  /** 正在改备注的那一行（null = 没开弹窗） */
  const [remarkTarget, setRemarkTarget] = useState<{
    sessionId: string;
    agentId?: string;
    name: string;
    value: string;
  } | null>(null);

  /** 把会话整理成 IM 条目 */
  const items = useMemo(() => {
    return sessions
      .map(session => {
        const agent = getAgent(session.agentId);
        const lastMessage = session.messages[session.messages.length - 1];
        const lastAt = lastMessage?.timestamp
          ? new Date(lastMessage.timestamp)
          : session.createdAt;

        // 一对一会话：显示联系人名。
        // 群聊：优先会话标题，没起名就拼成员名 —— 之前这里直接退到「新对话」，
        // 于是消息列表里每个没起名的群都叫「新对话」，完全分不出是哪个群。
        //
        // 备注**替换**显示名（QQ 的做法）：一对一路由 agentId 取备注，
        // 群聊取群聊备注。用户写备注的目的就是不想再看到原名。
        const memberNames = (session.agentIds ?? [])
          .map(id => getAgent(id)?.name)
          .filter(Boolean) as string[];
        const displayName =
          session.kind === 'group'
            ? flags[session.id]?.remark || session.title || memberNames.join('、') || '群聊'
            : remarks[session.agentId ?? ''] || agent?.name || session.title || '新对话';
        const preview = lastMessage?.content?.trim() || '还没有消息';

        const muted = !!flags[session.id]?.muted;
        const readAt = lastRead[session.id];
        // 手动「标记未读」优先于已读时间：它就是为了让人回头再看一眼
        const unread =
          !!flags[session.id]?.unread ||
          (session.id !== currentSessionId &&
            session.messages.length > 0 &&
            (!readAt || new Date(readAt) < lastAt));

        return { session, agent, displayName, preview, lastAt, unread, muted };
      })
      .filter(({ displayName, preview }) =>
        keyword
          ? displayName.toLowerCase().includes(keyword.toLowerCase()) ||
            preview.toLowerCase().includes(keyword.toLowerCase())
          : true
      )
      .sort((a, b) => {
        // 置顶的永远在最前，与最近活跃时间无关 —— 这正是「置顶」的意思。
        // 两个都置顶或都不置顶时，才退回按时间倒序。
        const pinA = a.session.pinned ? 1 : 0;
        const pinB = b.session.pinned ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        return b.lastAt.getTime() - a.lastAt.getTime();
      });
  }, [sessions, getAgent, lastRead, currentSessionId, keyword, flags, remarks]);

  return (
    <div
      className={`flex flex-col ${compact ? 'w-full' : 'shrink-0 tc-split-hairline'}`}
      style={{
        // 框架面：与导航条、标题栏同色（见 index.css 的 --tc-surface-chrome）
        backgroundColor: 'var(--tc-surface-chrome)',
        // 宽度走令牌（--tc-sidebar-width）：通讯录用同一个值，切栏不跳宽
        width: compact ? undefined : 'var(--tc-sidebar-width)',
        // 单栏模式下它是唯一的栏，右侧不需要分割线。
        //
        // A26：原来是 `borderRight: 1px solid var(--td-component-stroke)`。
        // 那是一个**误用** —— --td-component-stroke 是控件描边（浅 #e5e5e5 /
        // 深 #404040），拿它画版面分栏，在深色 + 100% 透明度下会变成一条
        // 发黑的黑线（透出亮壁纸后固定灰阶的语义反转了，见 PLAN-A26 1.2）。
        // 现在改由 `.tc-split-hairline` 画：alpha 白/黑 + 两端渐隐 +
        // 强度随透明度增长。单栏模式（compact）本来就不该有线。
      }}
    >
      {/*
        顶部：搜索框 + 新建会话。没有标题行。

        之前这里是 PanelHeader（「消息」+「N 个会话」+ 右侧 +），搜索框被挤到
        列表区里 sticky 吸顶 —— 一个栏头要同时装标题、计数、按钮和搜索框，
        结果搜索框只能缩成一个 32px 的小格子。现在标题与计数都去掉：
        会话栏里排着的就是会话，「这是消息页」「有 12 个会话」都是用户
        一眼就看得见的事，标题只是在重复。

        省下的高度全部给搜索框，它变成栏头的一等公民；新建按钮挪到它右边，
        **两者同高（h-9）同圆角（全圆）** —— 高度差 1px 都会在 52px 的行里
        显出一条毛边。

        整行高度 = py-2 (8+8) + h-9 (36) = 52px，与聊天头部（PanelHeader
        compact 的 52px）齐平，两栏的底边线在顶部连成一条直线。
        用 <header> 而不是 <div>：它是这一栏的栏头，语义上就该是 header
        （打靶脚本也靠 `document.querySelectorAll('header')` 的下标定位它）。
      */}
      <header
        className={`${SEARCH_ROW_CLASS} shrink-0`}
        style={{
          backgroundColor: 'var(--tc-surface-chrome)',
          borderBottom: '1px solid var(--tc-divider)',
        }}
      >
        <div
          className={SEARCH_PILL_CLASS}
          style={{ backgroundColor: 'var(--tc-surface-raised)' }}
        >
          <Search size={SEARCH_ICON_SIZE} style={{ color: 'var(--td-text-color-placeholder)' }} />
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜索会话"
            className="w-full bg-transparent text-body outline-none"
            style={{ color: 'var(--td-text-color-primary)' }}
          />
        </div>
        {/* A45：这个「+」不再直接跳到新对话页，而是先出菜单（发起群聊 /
            重新探测）—— 用户要求「点加号弹窗，再选发起群聊」。
            z-30 与通讯录那颗「+」同因同治：要压住下面那层点外关闭的透明遮罩，
            否则菜单打开后按钮自己被遮住，点第二下关不掉。 */}
        <div className="relative z-30 shrink-0">
          <button
            type="button"
            onClick={() => setAddMenuOpen(v => !v)}
            title="新建"
            aria-label="新建"
            aria-expanded={addMenuOpen}
            data-conversation-add
            className={`relative z-30 ${ROUND_ADD_CLASS}`}
            style={{
              backgroundColor: 'var(--tc-surface-raised)',
              color: 'var(--td-text-color-secondary)',
            }}
          >
            <Plus size={ADD_ICON_SIZE} />
          </button>

          {addMenuOpen && (
            <>
              {/* 透明遮罩：点外面收起 */}
              <div className="fixed inset-0 z-20" onClick={() => setAddMenuOpen(false)} />
              <div
                className="tc-glass tc-pop-in absolute right-0 top-full z-30 mt-1 w-[168px] overflow-hidden rounded-xl py-1 shadow-popup"
                data-conversation-add-menu
              >
                <button
                  type="button"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setGroupDialogOpen(true);
                  }}
                  className={MENU_ITEM_CLASS}
                  style={{ color: 'var(--td-text-color-primary)' }}
                  data-start-group
                >
                  <Users size={14} />
                  发起群聊
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddMenuOpen(false);
                    onAddContacts();
                  }}
                  className={MENU_ITEM_CLASS}
                  style={{ color: 'var(--td-text-color-primary)' }}
                  data-add-contacts
                >
                  <UserPlus size={14} />
                  重新探测
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* 列表。搜索框已在栏头里，这里不再需要 sticky 那一层 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {items.length === 0 ? (
          <div
            className="px-3 py-10 text-center text-body"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            {sessions.length === 0 ? '还没有会话，点右上角 + 找人聊聊' : '没有匹配的会话'}
          </div>
        ) : (
          items.map(({ session, agent, displayName, preview, lastAt, unread, muted }) => {
            const isActive = session.id === currentSessionId;
            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  // 点开即清掉「手动未读」标记，否则红点会一直挂着
                  setManuallyUnread(session.id, false);
                  markSessionRead(session.id);
                  onSelect(session.id);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') onSelect(session.id);
                }}
                // 会话操作（置顶 / 删除）收进右键菜单。
                // 原先删除按钮在悬停时浮现在行右上角，会压住时间戳和未读点，
                // 而且鼠标扫过列表时一直在闪 —— 一个不可逆的破坏性操作，
                // 不该靠「碰巧划过」触发。
                onContextMenu={e => {
                  e.preventDefault();
                  setMenu({ targetId: session.id, x: e.clientX, y: e.clientY });
                }}
                className={`tc-list-item group relative mb-0.5 flex cursor-pointer items-center gap-2.5 px-2.5 py-2.5${isActive ? ' is-active' : ''}`}
              >
                {/* 头像悬停出名片：扫列表时想确认「这是谁」不必点进会话。
                    未注册的 Agent（后端已下线）没有资料可看，就不挂名片。 */}
                {session.kind === 'group' ? (
                  // 群聊没有单一 Agent，用「多人群」图标，与通讯录的群聊行同一语言
                  <span
                    className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full"
                    style={{
                      backgroundColor: 'var(--tc-surface-raised)',
                      color: 'var(--td-text-color-secondary)',
                    }}
                    aria-hidden="true"
                  >
                    <Users size={18} />
                  </span>
                ) : agent ? (
                  <AgentHoverCard agent={agent}>
                    <AgentAvatar
                      id={agent.id}
                      name={displayName}
                      icon={agent.icon}
                      color={agent.color}
                      availability={agent.status.availability}
                      size={42}
                    />
                  </AgentHoverCard>
                ) : (
                  <AgentAvatar
                    id={session.id}
                    name={displayName}
                    availability={undefined}
                    size={42}
                  />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="truncate text-body-lg font-medium"
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      {displayName}
                    </span>
                    {/* 置顶标记：不标的话用户看不出「这条为什么排在最上面」 */}
                    {session.pinned && (
                      <Pin
                        size={11}
                        className="shrink-0"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                        aria-label="已置顶"
                      />
                    )}
                    <span
                      className="ml-auto shrink-0 text-caption"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      {formatTime(lastAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span
                      className="truncate text-secondary"
                      style={{ color: 'var(--td-text-color-secondary)' }}
                    >
                      {preview}
                    </span>
                    {/* 未读与免打扰：
                        · 免打扰**不隐藏**未读点，只把它从红色降为灰色 ——
                          用户说的是「别打扰我」，不是「别让我知道」。
                          隐藏红点等于把消息彻底藏起来，那是「折叠」，不是免打扰。
                        · 静音图标常驻，表示这条会话的提醒是关着的。 */}
                    {(muted || unread) && (
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        {muted && (
                          <BellOff
                            size={11}
                            style={{ color: 'var(--td-text-color-placeholder)' }}
                            aria-label="消息免打扰"
                          />
                        )}
                        {unread && (
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{
                              backgroundColor: muted
                                ? 'var(--td-text-color-disabled)'
                                : 'var(--td-error-color)',
                            }}
                            title="有新消息"
                          />
                        )}
                      </span>
                    )}
                  </div>
                  {agent && agent.status.availability !== 'ready' && (
                    <span
                      className="mt-1 inline-block text-caption"
                      style={{ color: AVAILABILITY_META[agent.status.availability].color }}
                    >
                      {AVAILABILITY_META[agent.status.availability].label}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (() => {
        const target = items.find(i => i.session.id === menu.targetId);
        if (!target) return null;
        const isPinned = !!target.session.pinned;
        const isMuted = !!flags[target.session.id]?.muted;
        const markedUnread = !!flags[target.session.id]?.unread;
        return (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={[
              // 修改备注放第一项：它是「这条是谁」的入口，比置顶/免打扰更基础。
              // 一对一改的是 Agent 备注（通讯录同步），群聊改的是群聊备注。
              {
                key: 'remark',
                label: '修改备注',
                icon: <PencilLine size={14} />,
                onSelect: () => {
                  setRemarkTarget({
                    sessionId: target.session.id,
                    agentId: target.session.kind === 'group' ? undefined : target.session.agentId,
                    name: target.displayName,
                    value:
                      target.session.kind === 'group'
                        ? (flags[target.session.id]?.remark ?? '')
                        : (remarks[target.session.agentId ?? ''] ?? ''),
                  });
                },
              },
              {
                key: 'pin',
                label: isPinned ? '取消置顶' : '置顶',
                icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />,
                onSelect: () => onTogglePin(target.session.id, !isPinned),
              },
              {
                key: 'unread',
                // 已是手动未读时给「标记已读」—— 菜单项永远是「点了会发生什么」
                label: markedUnread ? '标记已读' : '标记未读',
                icon: markedUnread ? <MailOpen size={14} /> : <Mail size={14} />,
                onSelect: () => setManuallyUnread(target.session.id, !markedUnread),
              },
              {
                key: 'mute',
                label: isMuted ? '取消免打扰' : '消息免打扰',
                icon: isMuted ? <Bell size={14} /> : <BellOff size={14} />,
                onSelect: () => toggleMuted(target.session.id),
              },
              {
                key: 'copy',
                label: '复制名称',
                icon: <Copy size={14} />,
                onSelect: () => void copyText(target.displayName),
              },
              // 导出放在删除之前、且有分隔线：和「置顶/未读/免打扰/复制」
              // 这些日常操作分段，与破坏性的删除拉开距离
              ...(onExport
                ? [
                    {
                      key: 'export',
                      label: '导出为 Markdown',
                      icon: <Download size={14} />,
                      divider: true,
                      onSelect: () => onExport(target.session.id),
                    },
                  ]
                : []),
              {
                key: 'delete',
                label: '删除会话',
                icon: <Trash2 size={14} />,
                danger: true,
                divider: true,
                onSelect: () =>
                  setConfirmDelete({ id: target.session.id, name: target.displayName }),
              },
            ]}
          />
        );
      })()}

      {/* 删除确认。菜单里点「删除会话」不直接删 —— 后端是硬 DELETE，
          删掉的消息找不回来，值得多一次明确的确认。 */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="删除会话"
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) onDelete(confirmDelete.id);
          setConfirmDelete(null);
        }}
      >
        <p>确定删除「{confirmDelete?.name}」吗？</p>
        <p className="mt-1.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
          该会话的全部消息会一并删除，无法恢复。
        </p>
      </ConfirmDialog>

      {/* 改备注。一对一写 Agent 备注（通讯录、聊天头部同步显示），
          群聊写群聊备注。留空保存 = 恢复原名。 */}
      <RemarkDialog
        open={!!remarkTarget}
        name={remarkTarget?.name ?? ''}
        value={remarkTarget?.value ?? ''}
        onCancel={() => setRemarkTarget(null)}
        onSave={next => {
          if (remarkTarget?.agentId) setAgentRemark(remarkTarget.agentId, next);
          else if (remarkTarget) setGroupRemark(remarkTarget.sessionId, next);
          setRemarkTarget(null);
        }}
      />

      {/* 发起群聊（A45）：左右两栏的建群弹窗，勾完点「完成」直接落到群会话。
          建群本身走的是通讯录那条老路（App.handleCreateGroup），不另开一套。 */}
      <NewGroupDialog
        open={groupDialogOpen}
        agents={agents}
        groups={groups}
        getAgent={getAgent}
        onClose={() => setGroupDialogOpen(false)}
        onCreate={ids => {
          setGroupDialogOpen(false);
          onCreateGroup(ids);
        }}
        onOpenGroup={id => {
          setGroupDialogOpen(false);
          onSelectGroup(id);
        }}
      />
    </div>
  );
}

/**
 * 复制到剪贴板。
 *
 * Electron 里页面是 http://127.0.0.1:<port>（安全上下文），`navigator.clipboard`
 * 可用；但纯静态预览（file://）下会被拒绝 —— 那种情况静默失败即可，
 * 复制名称不是什么必须成功的操作，弹一个错误框反而打扰。
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* 剪贴板不可用：忽略 */
  }
}

/** IM 风格的时间：今天只显示时分，昨天显示「昨天」，更早显示月/日 */function formatTime(date: Date): string {
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return '昨天';
  }

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
