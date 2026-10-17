import { useMemo, useState } from 'react';
import {
  RefreshCw,
  Search,
  MessageSquarePlus,
  ChevronRight,
  Loader2,
  UserPlus,
  Users,
  ArrowRight,
  Check,
} from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { PanelHeader } from './PanelHeader';
import {
  AVAILABILITY_META,
  CAPABILITY_META,
  type AgentAvailability,
  type RegisteredAgent,
} from '../types';

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
  onStartChat: (agentId: string) => void;
  /** 发起群聊：传入勾选到的在线成员 id 列表 */
  onCreateGroup?: (agentIds: string[]) => void;
}

/**
 * 通讯录 —— IM 范式下 Agent 的主界面。
 *
 * 按「在线 / 待处理 / 未接入」三段分组，而不是按厂商或字母序。
 * 理由：用户打开通讯录的真实意图是「我现在能用谁」和「谁还不能用、为什么」，
 * 分组直接对应这两个问题，不用在一堆灰头像里找原因。
 */
export function ContactsPanel({
  agents,
  grouped,
  loading,
  probing,
  error,
  onProbe,
  onStartChat,
  onCreateGroup,
}: ContactsPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
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
        hint: '需要登录或修复后才能使用',
        list: filter(grouped.actionNeeded),
      },
      {
        key: 'unavailable',
        title: '未接入',
        hint: '本机未安装或无法无头调用',
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
    setExpanded(null);
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

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ backgroundColor: 'var(--td-bg-color-page)' }}>
      {/* 顶部 */}
      <PanelHeader
        title="通讯录"
        subtitle={
          selecting
            ? `已选 ${selectedCount} 人 · 点击成员可取消`
            : `共 ${total} 个 Agent · ${grouped.ready.length} 个在线`
        }
        actions={
          <>
            {selecting && (
              <div
                className="flex w-[220px] items-center gap-2 rounded-lg px-2.5 py-1.5"
                style={{ backgroundColor: 'var(--td-bg-color-container)' }}
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
            )}

            <button
              type="button"
              onClick={toggleSelecting}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-body transition-opacity"
              style={{
                backgroundColor: selecting ? 'var(--td-brand-color)' : 'var(--td-bg-color-container)',
                color: selecting ? '#fff' : 'var(--td-text-color-primary)',
                border: selecting ? 'none' : '1px solid var(--td-component-stroke)',
              }}
            >
              <UserPlus size={14} />
              {selecting ? '取消' : '发起群聊'}
            </button>

            <button
              type="button"
              onClick={onProbe}
              disabled={probing}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-body transition-opacity disabled:opacity-60"
              style={{
                backgroundColor: 'var(--td-bg-color-container)',
                color: 'var(--td-text-color-primary)',
                border: '1px solid var(--td-component-stroke)',
              }}
            >
              {probing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {probing ? '探测中…' : '重新探测'}
            </button>
          </>
        }
      />

      {/* 多选模式下的确认条：常驻在列表上方，选几个人一目了然 */}
      {selecting && (
        <div
          className="mx-6 mt-3 flex items-center gap-3 rounded-xl px-4 py-2.5"
          style={{
            backgroundColor: 'var(--td-brand-color-light)',
            border: '1px solid var(--td-brand-color-focus)',
          }}
        >
          <Users size={16} style={{ color: 'var(--td-brand-color)' }} />
          <span className="text-body" style={{ color: 'var(--td-text-color-primary)' }}>
            已选 <strong style={{ color: 'var(--td-brand-color)' }}>{selectedCount}</strong> 位成员
          </span>
          <button
            type="button"
            onClick={submitGroup}
            disabled={selectedCount === 0}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-body text-white transition-opacity disabled:opacity-40"
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          >
            创建群聊
            <ArrowRight size={14} />
          </button>
        </div>
      )}

      {error && (
        <div
          className="mx-6 mt-3 rounded-lg px-3 py-2 text-body"
          style={{ backgroundColor: 'var(--td-error-color-1)', color: 'var(--td-error-color-6)' }}
        >
          加载失败：{error}
        </div>
      )}

      {probing && (
        <div
          className="mx-6 mt-3 rounded-lg px-3 py-2 text-secondary"
          style={{ backgroundColor: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' }}
        >
          正在逐个探测本机 Agent（ACP 需握手、SDK 需鉴权），大约需要 20 秒…
        </div>
      )}

      {/* 分组列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-4">
        {loading && total === 0 ? (
          <div className="py-16 text-center text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
            正在读取 Agent 名册…
          </div>
        ) : (
          sections.map(section => {
            // 多选建群时只保留「在线」组：待处理/未接入的 Agent 勾了也进不了群，
            // 摆在这里只会诱导用户做一件必然失败的操作
            if (selecting && section.key !== 'ready') return null;

            return (
            <section key={section.key} className="mb-7">
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="text-body font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
                  {section.title}
                </h3>
                <span className="text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {section.list.length}
                </span>
                <span className="ml-auto text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {selecting ? '点击选择成员' : section.hint}
                </span>
              </div>

              {section.list.length === 0 ? (
                <div
                  className="rounded-xl px-4 py-6 text-center text-secondary"
                  style={{ backgroundColor: 'var(--td-bg-color-container)', color: 'var(--td-text-color-placeholder)' }}
                >
                  {selecting ? '没有可邀请的在线成员' : '这一组暂无 Agent'}
                </div>
              ) : (
                <div className="grid gap-2">
                  {section.list.map(agent => (
                    <ContactRow
                      key={agent.id}
                      agent={agent}
                      expanded={!selecting && expanded === agent.id}
                      selectable={!!selecting}
                      selected={!!selecting && selecting.has(agent.id)}
                      onToggle={() => setExpanded(expanded === agent.id ? null : agent.id)}
                      onSelect={() => toggleMember(agent.id)}
                      onStartChat={() => onStartChat(agent.id)}
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
  expanded: boolean;
  /** 多选建群模式：整行变成勾选器，不再有「对话」按钮 */
  selectable?: boolean;
  selected?: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onStartChat: () => void;
}

function ContactRow({
  agent,
  expanded,
  selectable = false,
  selected = false,
  onToggle,
  onSelect,
  onStartChat,
}: ContactRowProps) {
  const avail = agent.status.availability;
  const meta = AVAILABILITY_META[avail];
  const canChat = avail === 'ready';

  // 多选态下点整行就是勾选，比在行内放一个小复选框好点中得多。
  // padding 提到 row 自身：多选态外层是 button、普通态外层是 div，两者都不带内边距
  const row = (
    <>
      <div className="flex items-start gap-3 px-4 py-3">
        <AgentAvatar
          id={agent.id}
          name={agent.name}
          icon={agent.icon}
          color={agent.color}
          availability={avail}
          size={44}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {agent.name}
            </span>
            {agent.vendor && (
              <span className="text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {agent.vendor}
              </span>
            )}
            {agent.status.version && (
              <span
                className="rounded px-1.5 py-[1px] text-caption"
                style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)', color: 'var(--td-text-color-secondary)' }}
              >
                v{agent.status.version}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1 text-secondary" style={{ color: meta.color }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.dot }} />
              {meta.label}
            </span>
          </div>

          {agent.description && (
            <p className="mt-1 text-secondary leading-relaxed" style={{ color: 'var(--td-text-color-secondary)' }}>
              {agent.description}
            </p>
          )}

          {/* 擅长领域 = 能力标签 */}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {agent.capabilities.map(cap => {
              const cm = CAPABILITY_META[cap];
              if (!cm) return null;
              return (
                <span
                  key={cap}
                  className="rounded px-1.5 py-[2px] text-caption"
                  style={{ backgroundColor: `${cm.color}18`, color: cm.color }}
                >
                  {cm.label}
                </span>
              );
            })}
            <span
              className="rounded px-1.5 py-[2px] text-caption"
              style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)', color: 'var(--td-text-color-placeholder)' }}
            >
              {kindLabel(agent.kind)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          {selectable ? (
            // 多选态：用一个明确的对勾表示勾选状态，不提供「对话」入口
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full transition-colors"
              style={{
                backgroundColor: selected ? 'var(--td-brand-color)' : 'transparent',
                border: selected ? 'none' : '1.5px solid var(--td-component-stroke)',
                color: '#fff',
              }}
            >
              {selected && <Check size={14} />}
            </span>
          ) : (
            <>
              {canChat && (
                <button
                  type="button"
                  onClick={onStartChat}
                  title={`与 ${agent.name} 对话`}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-secondary text-white"
                  style={{ backgroundColor: 'var(--td-brand-color)' }}
                >
                  <MessageSquarePlus size={13} />
                  对话
                </button>
              )}
              <button
                type="button"
                onClick={onToggle}
                title="详情"
                className="flex h-7 w-7 items-center justify-center rounded-lg"
                style={{
                  backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                  color: 'var(--td-text-color-secondary)',
                }}
              >
                <ChevronRight
                  size={15}
                  style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
                />
              </button>
            </>
          )}
        </div>
      </div>

      {/* 展开详情：状态说明 / 修复指引 / 上次错误 */}
      {expanded && !selectable && (
        <div
          className="mt-3 space-y-1.5 rounded-lg px-3 py-2.5 text-secondary leading-relaxed"
          style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
        >
          <DetailRow label="状态" value={agent.status.message || meta.label} />
          {agent.status.binaryPath && <DetailRow label="路径" value={agent.status.binaryPath} mono />}
          {agent.status.lastError && <DetailRow label="上次错误" value={agent.status.lastError} error />}
          {agent.installHint && <DetailRow label="接入方式" value={agent.installHint} />}
        </div>
      )}
    </>
  );

  // 多选态整行可点：包一层 button 让点击区域覆盖整行
  if (selectable) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className="block w-full rounded-xl text-left transition-opacity hover:opacity-95"
        style={{
          backgroundColor: selected ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-container)',
          border: `1px solid ${selected ? 'var(--td-brand-color)' : 'var(--td-component-stroke)'}`,
        }}
      >
        {row}
      </button>
    );
  }

  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{
        backgroundColor: 'var(--td-bg-color-container)',
        border: '1px solid var(--td-component-stroke)',
      }}
    >
      {row}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  error,
}: {
  label: string;
  value: string;
  mono?: boolean;
  error?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-[62px] shrink-0" style={{ color: 'var(--td-text-color-placeholder)' }}>
        {label}
      </span>
      <span
        className={mono ? 'break-all font-mono' : 'break-words'}
        style={{
          color: error ? 'var(--td-error-color)' : 'var(--td-text-color-secondary)',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'sdk':
      return 'SDK 接入';
    case 'cli':
      return 'CLI 子进程';
    case 'acp':
      return 'ACP 协议';
    default:
      return '未接入';
  }
}

/** 供外部复用：判断某个状态是否可对话 */
export function isChattable(avail: AgentAvailability): boolean {
  return avail === 'ready';
}
