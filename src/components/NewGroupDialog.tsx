import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronDown, ChevronRight, Users, X, Check } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { useAgentRemarks } from '../agentRemarks';
import { AVAILABILITY_META, availabilityLabelOf, type RegisteredAgent, type Session } from '../types';

interface NewGroupDialogProps {
  open: boolean;
  /** 通讯录里的全部 Agent（可勾选的成员池） */
  agents: RegisteredAgent[];
  /** 已有的群聊会话：左上角「选择一个已有群」展开后就是这份数据 */
  groups: Session[];
  getAgent: (id: string | undefined) => RegisteredAgent | undefined;
  onClose: () => void;
  /** 点「完成」：把勾选到的成员 id 交给上层建群 */
  onCreate: (agentIds: string[]) => void;
  /** 点已有群：直接进那个群，关掉弹窗 */
  onOpenGroup: (sessionId: string) => void;
}

/**
 * 发起群聊弹窗（A45 用户反馈：会话栏的「+」要弹出「发起群聊 / 重新探测」，
 * 点发起群聊后按 IM 的建群弹窗做）。
 *
 * ## 版式照搬 IM 的建群流程
 *
 * 左右两栏、**左边挑人、右边看已选**：
 *   · 左：搜索框 → 「选择一个已有群」（折叠，点进去是已有群目录）→
 *     「AGENT」（按首字母分段，每行「勾选圈 + 头像 + 名字」）。
 *   · 右：标题「发起群聊」+ 右上角「已选择 N 个 AGENT」+ 已选名单（可逐个 ×）+
 *     底部「完成 / 取消」。
 *
 * 为什么要两栏而不是「多选完再跳一页」：勾选的时候要能同时看到「选了谁」，
 * 否则选到第 6 个人就开始凭记忆点，只能靠数「已选 6」来确认。
 *
 * ## 首字母分组：中文名落到 `#`
 *
 * 没有引拼音库 —— 为了几个中文名字加一个依赖不值。拉丁名取首字母，其余
 * 一律归到 `#`，与 IM 对无法归类联系人的处理一致。分组只是导航辅助，
 * 归错了不影响任何功能。
 */
export function NewGroupDialog({
  open,
  agents,
  groups,
  getAgent,
  onClose,
  onCreate,
  onOpenGroup,
}: NewGroupDialogProps) {
  const [keyword, setKeyword] = useState('');
  /** 勾选顺序无关，但已选名单按勾选先后排 —— 用户刚点的人在最后，能立刻看到 */
  const [selected, setSelected] = useState<string[]>([]);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const remarks = useAgentRemarks();
  /** 显示名：备注优先 —— 与会话列表、通讯录、聊天头部同一套口径 */
  const nameOf = (a: RegisteredAgent) => remarks[a.id] || a.name;

  // 每次打开都从零开始：上次勾了谁、搜了什么，都不该带进这一次
  useEffect(() => {
    if (!open) return;
    setKeyword('');
    setSelected([]);
    setGroupsOpen(false);
    setContactsOpen(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // 锁定背景滚动；关闭时还原父级原来的值（不要硬写 ''）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const kw = keyword.trim().toLowerCase();

  const filteredGroups = useMemo(
    () => (kw ? groups.filter(g => (g.title || '').toLowerCase().includes(kw)) : groups),
    [groups, kw]
  );

  const filteredAgents = useMemo(
    () =>
      agents
        .filter(a => (kw ? nameOf(a).toLowerCase().includes(kw) : true))
        // 按显示名排：分组之后每组内部的顺序也该是稳定的
        .slice()
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN')),
    // nameOf 依赖 remarks，remarks 变了要重排
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, kw, remarks]
  );

  /** 首字母分段：拉丁字母归自己，其余（中文、数字、符号）归 `#` */
  const buckets = useMemo(() => {
    const map = new Map<string, RegisteredAgent[]>();
    for (const a of filteredAgents) {
      const first = nameOf(a).trim().charAt(0).toUpperCase();
      const key = /[A-Z]/.test(first) ? first : '#';
      const list = map.get(key);
      if (list) list.push(a);
      else map.set(key, [a]);
    }
    // A→Z 在前，`#` 收尾（IM 的惯例）
    return [...map.entries()].sort(([a], [b]) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredAgents, remarks]);

  const toggle = (id: string) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const submit = () => {
    if (selected.length === 0) return;
    onCreate(selected);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        // 只有点在遮罩本身才关闭：从面板里按下、拖到遮罩上松手不该关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="发起群聊"
        data-new-group-dialog
        /* A115：原来这里是实色底 + `--shadow-float`，与另外四个弹窗
           （ConfirmDialog / RemarkDialog / GetAgentsDialog / AgentDetailModal）
           完全两套语言。现在统一走 `.tc-dialog` —— 半透明玻璃 + 四层立体影。
           遮罩也换成 `--tc-mask-soft`（实色 0.42 配半透明底只会让界面发黑）。 */
        className="tc-dialog flex h-[min(600px,100%)] w-[min(880px,100%)] overflow-hidden rounded-2xl"
      >
        {/* ── 左栏：挑人 ── */}
        <div
          className="flex min-w-0 flex-1 flex-col"
          style={{ backgroundColor: 'var(--tc-surface-chrome)' }}
        >
          {/*
            A51（用户反馈「文字上下左右边距太窄」）：整块内距从 16/12 提到 20/16，
            行内距从 8 提到 10，右栏 300 → 320。

            头部高度**写死 72px**（= 16 + 40 搜索胶囊 + 16），右栏头部用同一个值：
            不写死的话左边 72、右边 56，两条底部分隔线差 16px 对不上 —— 两个栏头
            并排时那种「差一点点」最扎眼。
          */}
          <div className="flex h-[72px] shrink-0 items-center px-5" style={{ borderBottom: '1px solid var(--tc-divider)' }}>
            <div
              // ⚠️ 必须 `w-full`：头部改成 flex 之后，这个胶囊成了 flex 项，
              // 不给宽度就按内容收缩（实测只剩 197px，搜索框窄得没法用）。
              className="flex h-10 w-full items-center gap-2 rounded-full bg-transparent px-3.5 transition-colors focus-within:bg-[var(--tc-fill-hover)]"
            >
              <Search size={14} style={{ color: 'var(--td-text-color-placeholder)' }} />
              <input
                ref={inputRef}
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                placeholder="搜索 AGENT、群聊"
                className="w-full bg-transparent text-body outline-none"
                style={{ color: 'var(--td-text-color-primary)' }}
                data-new-group-search
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pb-4 pt-1.5">
            {/* 已有群：折叠着放最上面。它的用途是「接着上次那个群聊」，
                不是建群的主路径，所以默认收起。 */}
            <button
              type="button"
              onClick={() => setGroupsOpen(v => !v)}
              aria-expanded={groupsOpen}
              data-existing-groups-toggle
              className="flex w-full items-center gap-1.5 px-5 py-2.5 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {groupsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              选择一个已有群
              <span className="ml-auto text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {groups.length}
              </span>
            </button>
            {groupsOpen && (
              <div className="pb-1">
                {filteredGroups.length === 0 ? (
                  <p
                    className="px-12 py-2.5 text-caption"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    {groups.length === 0 ? '还没有群聊' : '没有匹配的群聊'}
                  </p>
                ) : (
                  filteredGroups.map(g => {
                    const members = (g.agentIds ?? [])
                      .map(id => getAgent(id)?.name)
                      .filter(Boolean) as string[];
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => onOpenGroup(g.id)}
                        data-existing-group={g.id}
                        className="tc-list-item flex w-full items-center gap-2.5 px-5 py-2.5 text-left"
                      >
                        <span
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                          style={{ backgroundColor: 'var(--tc-surface-raised)', color: 'var(--td-text-color-secondary)' }}
                        >
                          <Users size={16} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-body font-medium"
                            style={{ color: 'var(--td-text-color-primary)' }}
                          >
                            {g.title || members.join('、') || '群聊'}
                          </span>
                          <span
                            className="block truncate text-caption"
                            style={{ color: 'var(--td-text-color-placeholder)' }}
                          >
                            {(g.agentIds?.length ?? 0)} 人
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {/* AGENT */}
            <button
              type="button"
              onClick={() => setContactsOpen(v => !v)}
              aria-expanded={contactsOpen}
              className="flex w-full items-center gap-1.5 px-5 py-2.5 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {contactsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              AGENT
              <span className="ml-auto text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {filteredAgents.length}
              </span>
            </button>

            {contactsOpen &&
              (filteredAgents.length === 0 ? (
                <p className="px-12 py-3 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  没有匹配的 AGENT
                </p>
              ) : (
                buckets.map(([letter, list]) => (
                  <div key={letter}>
                    <div
                      className="px-6 pb-1 pt-3 text-caption"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      {letter}
                    </div>
                    {list.map(a => {
                      const checked = selected.includes(a.id);
                      const meta = AVAILABILITY_META[a.status.availability];
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => toggle(a.id)}
                          aria-pressed={checked}
                          data-new-group-agent={a.id}
                          className="tc-list-item flex w-full items-center gap-2.5 px-5 py-2.5 text-left"
                        >
                          {/* 勾选圈在**左边**：IM 的建群列表就是「圈 → 头像 → 名字」，
                              圈在右边会跟「在线状态」抢行尾那一小块地方 */}
                          <span
                            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-colors"
                            style={{
                              backgroundColor: checked ? 'var(--td-brand-color)' : 'transparent',
                              // A115 续：未选中态的勾选框走 --tc-edge-strong
                              // （7% 墨）—— 控件轮廓档。1.5px 保留：18px 的
                              // 圆圈上 1px 显得太细。
                              border: checked ? 'none' : '1.5px solid var(--tc-edge-strong)',
                              color: 'var(--tc-on-brand)',
                            }}
                          >
                            {checked && <Check size={11} />}
                          </span>
                          <AgentAvatar
                            id={a.id}
                            name={nameOf(a)}
                            icon={a.icon}
                            color={a.color}
                            availability={a.status.availability}
                            size={32}
                          />
                          <span
                            className="min-w-0 flex-1 truncate text-body"
                            style={{ color: 'var(--td-text-color-primary)' }}
                          >
                            {nameOf(a)}
                          </span>
                          {/* 不可用的如实标出来 —— 拉进群也只会得到一条失败回复 */}
                          {a.status.availability !== 'ready' && (
                            <span className="shrink-0 text-caption" style={{ color: meta.color }}>
                              {availabilityLabelOf(a)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              ))}
          </div>
        </div>

        {/* ── 右栏：已选 ── */}
        <div
          className="flex w-[320px] shrink-0 flex-col"
          style={{
            // 显式给底色，不靠「父级是白的所以看起来是白的」：深色 + 玻璃态下
            // 父级是半透明的，不给的话右栏会透出弹窗背后那一层，与左栏的实色
            // 并排看就是「一半实、一半虚」。
            backgroundColor: 'var(--tc-surface-content)',
            borderLeft: '1px solid var(--tc-divider)',
          }}
        >
          <div
            className="flex h-[72px] shrink-0 items-center justify-between gap-2 px-5"
            style={{ borderBottom: '1px solid var(--tc-divider)' }}
          >
            <h2 className="text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              发起群聊
            </h2>
            <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              已选择 {selected.length} 个 AGENT
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {selected.length === 0 ? (
              <p
                className="px-3 py-8 text-center text-caption"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                从左侧勾选 AGENT
              </p>
            ) : (
              selected.map(id => {
                const a = getAgent(id);
                const name = a ? nameOf(a) : id;
                return (
                  <div
                    key={id}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
                    data-new-group-selected={id}
                  >
                    <AgentAvatar
                      id={id}
                      name={name}
                      icon={a?.icon}
                      color={a?.color}
                      availability={a?.status.availability}
                      size={32}
                      showStatus={false}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-body"
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      {name}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      title={`移除 ${name}`}
                      aria-label={`移除 ${name}`}
                      className="tc-icon-btn h-6 w-6 shrink-0"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div
            className="flex shrink-0 justify-end gap-2.5 px-5 py-4"
            style={{ borderTop: '1px solid var(--tc-divider)' }}
          >
            <button
              type="button"
              onClick={submit}
              disabled={selected.length === 0}
              data-new-group-submit
              className="tc-btn-brand"
            >
              完成
            </button>
            <button type="button" onClick={onClose} className="tc-btn-secondary">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
