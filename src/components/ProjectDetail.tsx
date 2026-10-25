import { useEffect, useRef, useState } from 'react';
import {
  FolderKanban, FolderOpen, Pencil, Trash2, MessageSquarePlus, Brain,
  Check, X, ChevronDown, ChevronLeft,
} from 'lucide-react';
import type { Project, Session, RegisteredAgent } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { revealInFolder, hasNativeDialogs } from '../workspace';

interface ProjectDetailProps {
  project: Project;
  /** 归属该项目的会话（已由调用方按 projectId 过滤） */
  sessions: Session[];
  agents: RegisteredAgent[];
  /** 打开某个会话（切到聊天视图） */
  onOpenSession: (sessionId: string) => void;
  /** 用指定 Agent 在该项目下开新会话（cwd = project.path） */
  onNewSession: (project: Project, agentId: string) => void;
  onRename: (project: Project, name: string) => void;
  onDelete: (project: Project) => void;
  /**
   * 返回项目列表。只在窄屏单栏模式传 —— 那时列表栏被详情挡住了，
   * 没有返回键就回不去（与会话头部 / 资料页同一条规则）。
   */
  onBack?: () => void;
  compact?: boolean;
}

/** IM 风格时间：今天显示时分，更早显示月/日。 */
function shortTime(d: Date): string {
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 项目详情（A117）—— 项目视图的右侧内容区。
 *
 * ## 这一页回答三个问题
 *
 *   1. 「这个目录是什么」—— 完整路径 + 在资源管理器里打开
 *   2. 「它有什么自己的规矩」—— 项目记忆的 token 占用与技能数（A98 的分区）
 *   3. 「在这儿干过什么」—— 归属该项目的会话，点一条直接进聊天
 *
 * ## 为什么「新建会话」要先选 Agent
 *
 * 会话必须有 Agent 才能跑，而项目本身不知道你想用谁。做成「点开 → 选 Agent」
 * 而不是「点一下就用默认 Agent」：后者会在用户没注意的时候把会话挂到一个
 * 不相干的 Agent 上（比如上次用的那个），而这类错误在界面上完全看不出来。
 */
export function ProjectDetail({
  project,
  sessions,
  agents,
  onOpenSession,
  onNewSession,
  onRename,
  onDelete,
  onBack,
  compact = false,
}: ProjectDetailProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // 换项目时收起所有临时状态 —— 否则切到另一个项目会带着上一个的输入框
  useEffect(() => {
    setRenaming(false);
    setPickerOpen(false);
    setConfirmDelete(false);
    setDraftName(project.name);
  }, [project.id, project.name]);

  // 点浮层外面收起。用 pointerdown 而不是 click：和项目里其余浮层一致，
  // 而且 click 在「按下即拖走」的场景下不会触发，菜单会赖着不走。
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pickerOpen]);

  const readyAgents = agents.filter(a => a.status.availability === 'ready');
  const usableAgents = readyAgents.length ? readyAgents : agents;

  const commitRename = () => {
    const clean = draftName.trim();
    if (!clean || clean === project.name) {
      setRenaming(false);
      setDraftName(project.name);
      return;
    }
    onRename(project, clean);
    setRenaming(false);
  };

  const mem = project.memory;
  const memPct = mem && mem.coreBudget > 0 ? Math.min(100, Math.round((mem.coreTokens / mem.coreBudget) * 100)) : 0;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--tc-surface-content)',
        borderRadius: 'var(--tc-column-radius)',
      }}
      data-project-detail={project.id}
    >
      {/* 头部：与列表栏同高（dense 60px），两块底边线连成一条 */}
      <header
        className="flex shrink-0 items-center gap-3 px-5"
        style={{
          minHeight: 'var(--panel-header-height-dense)',
          borderBottom: '1px solid var(--tc-divider)',
        }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title="返回项目列表"
            aria-label="返回项目列表"
            className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-project-back
          >
            <ChevronLeft size={18} />
          </button>
        )}
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' }}
        >
          <FolderKanban size={16} />
        </span>

        <div className="flex min-w-0 flex-1 flex-col">
          {renaming ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') { setRenaming(false); setDraftName(project.name); }
                }}
                className="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-title-lg font-semibold outline-none"
                style={{
                  color: 'var(--td-text-color-primary)',
                  backgroundColor: 'var(--td-bg-color-component)',
                  border: '1px solid var(--tc-edge-strong)',
                }}
                data-project-rename-input
              />
              <button
                type="button"
                onClick={commitRename}
                aria-label="保存名称"
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--tc-hover-chrome)]"
                style={{ color: 'var(--td-brand-color)' }}
              >
                <Check size={15} />
              </button>
              <button
                type="button"
                onClick={() => { setRenaming(false); setDraftName(project.name); }}
                aria-label="取消重命名"
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--tc-hover-chrome)]"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                <X size={15} />
              </button>
            </div>
          ) : (
            <h1
              className="truncate text-title-lg font-semibold"
              style={{ color: 'var(--td-text-color-primary)' }}
              title={project.name}
              data-project-title
            >
              {project.name}
            </h1>
          )}
          <p
            className="truncate text-caption"
            style={{ color: 'var(--td-text-color-secondary)' }}
            title={project.path}
            data-project-path
          >
            {project.path}
          </p>
        </div>

        {/* 操作区。新建会话是唯一的主操作，其余是图标按钮。 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="relative" ref={pickerRef}>
            <button
              type="button"
              onClick={() => setPickerOpen(v => !v)}
              className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-body transition-colors"
              style={{
                color: 'var(--td-text-color-primary)',
                border: '1px solid var(--tc-edge-strong)',
              }}
              aria-expanded={pickerOpen}
              data-project-new-session
            >
              <MessageSquarePlus size={15} />
              新建会话
              <ChevronDown size={13} style={{ color: 'var(--td-text-color-secondary)' }} />
            </button>

            {pickerOpen && (
              <div
                className="absolute right-0 top-full z-30 mt-1.5 max-h-80 w-60 overflow-y-auto rounded-xl py-1"
                style={{
                  backgroundColor: 'var(--td-bg-color-container)',
                  border: '1px solid var(--tc-edge)',
                  boxShadow: 'var(--tc-dialog-shadow)',
                }}
                data-project-agent-picker
              >
                <p className="px-3 py-1.5 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  用哪个 Agent 开聊
                </p>
                {usableAgents.length === 0 ? (
                  <p className="px-3 py-3 text-body" style={{ color: 'var(--td-text-color-secondary)' }}>
                    还没有可用的 Agent，先去通讯录看看
                  </p>
                ) : (
                  usableAgents.map(a => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => { setPickerOpen(false); onNewSession(project, a.id); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
                      data-project-pick-agent={a.id}
                    >
                      <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-caption font-medium"
                        style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-secondary)' }}
                      >
                        {a.name.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body" style={{ color: 'var(--td-text-color-primary)' }}>
                        {a.name}
                      </span>
                      {a.status.availability !== 'ready' && (
                        <span className="shrink-0 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                          未就绪
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 「在资源管理器里打开」只在有原生能力时出现 —— 浏览器开发态摆一颗
              点了没反应的按钮就是假控件（同 NewChatView 的选择目录按钮）。 */}
          {hasNativeDialogs() && (
            <button
              type="button"
              onClick={() => revealInFolder(project.path)}
              title="在资源管理器中打开"
              aria-label="在资源管理器中打开"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-secondary)' }}
              data-project-reveal
            >
              <FolderOpen size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={() => { setDraftName(project.name); setRenaming(true); }}
            title="重命名项目"
            aria-label="重命名项目"
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-project-rename
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            title="移除项目"
            aria-label="移除项目"
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-project-delete
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* 概览：三块数据 + 项目记忆占用条 */}
        <div className="mb-4 grid grid-cols-3 gap-2.5" data-project-overview>
          <Stat label="会话" value={String(sessions.length)} />
          {/* 预算只在「真的有记忆」时显示 —— 一个从没写过记忆的项目挂一句
              「预算 800」会让人以为已经有 800 字的额度被占着。 */}
          <Stat
            label="项目记忆"
            value={mem?.exists ? `${mem.coreTokens}` : '—'}
            hint={mem?.exists ? `预算 ${mem.coreBudget}` : undefined}
          />
          <Stat label="技能" value={mem ? String(mem.skillCount) : '—'} hint={mem && mem.skillCount > 0 ? '本项目' : undefined} />
        </div>

        {/* 记忆占用条。有记忆才画 —— 空条子只会让人以为「坏了」。
            进度条本身不做成可点的：改记忆要进设置页的记忆分区，那里有
            完整的编辑器，这里只负责「有没有 / 占多少」。 */}
        {mem?.exists && (
          <div
            className="mb-5 flex items-center gap-3 rounded-xl px-3 py-2.5"
            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
            data-project-memory-bar
          >
            <Brain size={15} style={{ color: 'var(--td-text-color-secondary)' }} />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-caption" style={{ color: 'var(--td-text-color-primary)' }}>
                  项目记忆已启用
                </span>
                <span className="text-caption tabular-nums" style={{ color: 'var(--td-text-color-secondary)' }}>
                  {mem.coreTokens}/{mem.coreBudget}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--tc-edge)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${memPct}%`,
                    backgroundColor: memPct >= 90 ? 'var(--td-warning-color)' : 'var(--td-brand-color)',
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* 会话列表 */}
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            会话
          </h2>
          <span className="text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
            {sessions.length} 个
          </span>
        </div>

        {sessions.length === 0 ? (
          <div
            className="rounded-xl px-4 py-8 text-center"
            style={{ border: '1px dashed var(--tc-edge)' }}
            data-project-no-session
          >
            <p className="text-body" style={{ color: 'var(--td-text-color-secondary)' }}>
              这个项目下还没有会话
            </p>
            <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              点右上角「新建会话」，工作目录会自动设成 {project.path}
            </p>
          </div>
        ) : (
          <div data-project-sessions>
            {sessions.map(s => {
              const agent = agents.find(a => a.id === s.agentId);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onOpenSession(s.id)}
                  className="mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  data-project-session-row={s.id}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-caption font-medium"
                    style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-secondary)' }}
                  >
                    {(agent?.name ?? s.title ?? '?').slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body" style={{ color: 'var(--td-text-color-primary)' }}>
                      {s.title || '新对话'}
                    </span>
                    <span className="block truncate text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                      {s.kind === 'group' ? '群聊' : (agent?.name ?? '未知 Agent')}
                      {s.model ? ` · ${s.model}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-caption tabular-nums" style={{ color: 'var(--td-text-color-secondary)' }}>
                    {shortTime(s.createdAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* 脚注：说清「移除项目」到底删了什么，省得用户以为是删目录 */}
        <p className="mt-6 text-caption leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
          移除项目只解除分组，<strong>不会删目录，也不会删记忆文件</strong>；
          会话会退回「未归属项目」。
        </p>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="移除这个项目？"
        confirmText="移除"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); onDelete(project); }}
      >
        <p>「{project.name}」下的 {sessions.length} 个会话会退回「未归属项目」，仍可在聊天列表里找到。</p>
        <p>目录本身和它的项目记忆都不会被删除。</p>
      </ConfirmDialog>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{ backgroundColor: 'var(--td-bg-color-component)' }}
    >
      <p className="text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>{label}</p>
      <p className="mt-0.5 text-title-lg font-semibold tabular-nums" style={{ color: 'var(--td-text-color-primary)' }}>
        {value}
      </p>
      {hint && <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>{hint}</p>}
    </div>
  );
}
