import { useMemo, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { PanelHeader } from './PanelHeader';
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
  onNewChat: () => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
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
  onNewChat,
  onSelect,
  onDelete,
}: ConversationListProps) {
  const [keyword, setKeyword] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  // 处于「待确认删除」状态的会话 id
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const lastRead = useMemo(() => readLastReadMap(), [sessions, currentSessionId]);

  /** 把会话整理成 IM 条目 */
  const items = useMemo(() => {
    return sessions
      .map(session => {
        const agent = getAgent(session.agentId);
        const lastMessage = session.messages[session.messages.length - 1];
        const lastAt = lastMessage?.timestamp
          ? new Date(lastMessage.timestamp)
          : session.createdAt;

        // 一对一会话：显示联系人名；否则用会话标题
        const displayName = agent?.name || session.title || '新对话';
        const preview = lastMessage?.content?.trim() || '还没有消息';

        const readAt = lastRead[session.id];
        const unread =
          session.id !== currentSessionId &&
          session.messages.length > 0 &&
          (!readAt || new Date(readAt) < lastAt);

        return { session, agent, displayName, preview, lastAt, unread };
      })
      .filter(({ displayName, preview }) =>
        keyword
          ? displayName.toLowerCase().includes(keyword.toLowerCase()) ||
            preview.toLowerCase().includes(keyword.toLowerCase())
          : true
      )
      .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  }, [sessions, getAgent, lastRead, currentSessionId, keyword]);

  // 副标题里的未读数。用过滤后的 items 而非 sessions —— 搜索时副标题会变成
  // 「匹配 N 个会话」，两个数字必须来自同一个集合，否则会对不上。
  const unreadCount = items.filter(i => i.unread).length;

  return (
    <div
      className="flex w-[300px] shrink-0 flex-col"
      style={{
        backgroundColor: 'var(--td-bg-color-container)',
        borderRight: '1px solid var(--td-component-stroke)',
      }}
    >
      {/* 顶部：标题 + 发起新对话。
          搜索框不放这里 —— 它会被挤到列表区顶部吸顶（见下方 sticky 块）。
          原因见 PanelHeader 的 children 注释：栏头塞进搜索框就装不下 88px，
          标题会被顶高 4px，与主区标题对不齐。 */}
      <PanelHeader
        level="column"
        title="消息"
        subtitle={
          keyword
            ? `匹配 ${items.length} 个会话`
            : `${items.length} 个会话${unreadCount > 0 ? ` · ${unreadCount} 条未读` : ''}`
        }
        actions={
          <button
            type="button"
            onClick={onNewChat}
            title="发起新对话"
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            style={{
              backgroundColor: 'var(--td-bg-color-secondarycontainer)',
              color: 'var(--td-text-color-secondary)',
            }}
          >
            <Plus size={17} />
          </button>
        }
      />

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* 搜索框吸顶：滚动时列表从它下面穿过，看起来仍像「固定栏头」，
            但已经不占标题栏的高度预算 */}
        <div
          className="sticky top-0 z-10 -mx-2 px-2 pb-2 pt-1"
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
              placeholder="搜索会话"
              className="w-full bg-transparent text-body outline-none"
              style={{ color: 'var(--td-text-color-primary)' }}
            />
          </div>
        </div>
        {items.length === 0 ? (
          <div
            className="px-3 py-10 text-center text-body"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            {sessions.length === 0 ? '还没有会话，点右上角 + 找人聊聊' : '没有匹配的会话'}
          </div>
        ) : (
          items.map(({ session, agent, displayName, preview, lastAt, unread }) => {
            const isActive = session.id === currentSessionId;
            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(session.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onSelect(session.id);
                }}
                onMouseEnter={() => setHovered(session.id)}
                onMouseLeave={() => {
                  setHovered(null);
                  // 指针离开就撤销待确认态，避免「点了删除但不小心移开鼠标」
                  // 之后下次悬停回来直接处于危险确认态
                  setPendingDelete(p => (p === session.id ? null : p));
                }}
                className={`tc-list-item group relative mb-0.5 flex cursor-pointer items-center gap-2.5 px-2.5 py-2.5${isActive ? ' is-active' : ''}`}
              >
                <AgentAvatar
                  id={agent?.id || session.id}
                  name={displayName}
                  icon={agent?.icon}
                  color={agent?.color}
                  availability={agent?.status.availability}
                  size={42}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="truncate text-body-lg font-medium"
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      {displayName}
                    </span>
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
                    {unread && (
                      <span
                        className="ml-auto h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: 'var(--td-error-color)' }}
                        title="有新消息"
                      />
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

                {/* 悬停时出现的删除按钮。
                    删除会话是不可逆的（后端直接 DELETE），所以做成
                    「两步确认」：第一次点击只把按钮切换成确认态，
                    第二次才真删。比弹 Modal 打扰更小，也比单击即删安全。 */}
                {hovered === session.id && (
                  pendingDelete === session.id ? (
                    <div className="absolute right-2 top-2 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setPendingDelete(null);
                        }}
                        title="取消删除"
                        className="flex h-6 items-center justify-center rounded-md px-1.5 text-caption"
                        style={{
                          backgroundColor: 'var(--td-bg-color-container)',
                          color: 'var(--td-text-color-secondary)',
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setPendingDelete(null);
                          onDelete(session.id);
                        }}
                        title="确认删除"
                        className="flex h-6 items-center justify-center rounded-md px-1.5 text-caption font-medium"
                        style={{
                          backgroundColor: 'var(--td-error-color)',
                          color: '#fff',
                        }}
                      >
                        删除
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        setPendingDelete(session.id);
                      }}
                      title="删除会话"
                      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md"
                      style={{
                        backgroundColor: 'var(--td-bg-color-container)',
                        color: 'var(--td-text-color-secondary)',
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** IM 风格的时间：今天只显示时分，昨天显示「昨天」，更早显示月/日 */
function formatTime(date: Date): string {
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
