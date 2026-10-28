import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderKanban, FolderOpen, Pencil, Trash2, MessageSquarePlus, Brain,
  Check, X, ChevronDown, ChevronLeft, Copy,
  Circle, CircleDot, CheckCircle2, Plus, ListTodo,
} from 'lucide-react';
import { MessagePlugin } from 'tdesign-react';
import type { Project, ProjectTask, ProjectTaskStatus, Session, RegisteredAgent } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { revealInFolder, hasNativeDialogs } from '../workspace';
import { copyText } from '../clipboard';

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
  /**
   * 「复制路径」的成功反馈（A139）。
   *
   * 反馈不能只靠图标变一下：路径本身是 11px 的次级小字，用户点完不会盯着
   * 那颗按钮看。所以同时改 `title`（悬停可复现）并在 1.5s 后复位 ——
   * 复位是必须的，否则「已复制」会一直挂着，下一次点它就不再有反馈。
   */
  const [copiedPath, setCopiedPath] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  /* ── 项目任务（A119）────────────────────────────────────────────
   *
   * 数据在这里自己拉，不提升到 App：任务只被这一屏用，提到 App 会让
   * 「projects 列表」和「当前项目的任务」两套数据混在一个状态里，切换项目
   * 时还得手动清，反而更容易出「切过去了还显示上一个项目的任务」。
   *
   * 每次 project.id 变化都重拉（而不是本地缓存各项目的任务）：任务量小、
   * 一次请求几百字节，缓存带来的失效判断比请求本身更贵。
   */
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [draftTask, setDraftTask] = useState('');

  /**
   * 复制项目路径（A139）。
   *
   * 为什么值得单开一颗按钮：路径是 11px 的次级小字、`truncate` 之后只能靠
   * `title` 悬停看全；而这个值恰恰是用户最常要拿去别处用的东西（终端里 cd、
   * 报给同事、填进配置文件）。原来只能靠手动划选 —— 在一条被截断的
   * 单行文本上划选，选到的往往只是可见的那半截。
   *
   * 失败时如实提示：静默失败会让用户以为剪贴板里是新路径，
   * 粘出来是上一次的旧值，比不复制更坑。
   */
  const copyPath = useCallback(async () => {
    const done = await copyText(project.path);
    if (!done) {
      MessagePlugin.warning('复制失败：剪贴板不可用');
      return;
    }
    setCopiedPath(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedPath(false), 1500);
  }, [project.path]);

  // 卸载时清掉待触发的定时器 —— 否则 1.5s 后会对已卸载组件 setState
  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const fetchTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const r = await fetch(`/api/projects/${project.id}/tasks`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `读取任务失败（${r.status}）`);
      setTasks(
        (j.tasks ?? []).map((t: any) => ({
          id: t.id,
          projectId: t.project_id,
          title: t.title,
          status: t.status,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        }))
      );
    } catch (e: any) {
      setTasksError(e?.message || '读取任务失败');
    } finally {
      setTasksLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  /** 写操作统一走这里：失败只把错误显示在面板里，不清空已有列表 */
  const mutateTask = useCallback(
    async (path: string, init: RequestInit, fallback: string) => {
      try {
        const r = await fetch(path, {
          headers: { 'Content-Type': 'application/json' },
          ...init,
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error || fallback);
        }
        setTasksError(null);
        await fetchTasks();
        return true;
      } catch (e: any) {
        setTasksError(e?.message || fallback);
        return false;
      }
    },
    [fetchTasks]
  );

  const addTask = async () => {
    const title = draftTask.trim();
    if (!title) return;
    // 先清输入框再发：成功与否都该让用户马上能接着敲下一条，
    // 失败时错误显示在列表上方，原文也不会丢（要重试就再敲一次）
    const ok = await mutateTask(
      `/api/projects/${project.id}/tasks`,
      { method: 'POST', body: JSON.stringify({ title }) },
      '添加任务失败'
    );
    if (ok) setDraftTask('');
  };

  const cycleTask = (task: ProjectTask) => {
    // 三档循环：待办 → 进行中 → 已完成 → 待办。
    // 为什么是循环而不是复选框：只有两档表达不了「正在做」，
    // 而「正在做」恰恰是任务面板最该一眼看出来的信息。
    const next: ProjectTaskStatus =
      task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo';
    void mutateTask(
      `/api/tasks/${task.id}`,
      { method: 'PATCH', body: JSON.stringify({ status: next }) },
      '更新任务失败'
    );
  };

  const removeTask = (task: ProjectTask) => {
    void mutateTask(`/api/tasks/${task.id}`, { method: 'DELETE' }, '删除任务失败');
  };

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
  const doneCount = tasks.filter(t => t.status === 'done').length;

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

          {/* 复制路径（A139）：路径本身是截断的 11px 小字，靠悬停 title 看全，
              却没法直接拿走用。与「在资源管理器打开」同一档（工具级图标按钮）。 */}
          <button
            type="button"
            onClick={() => void copyPath()}
            title={copiedPath ? '已复制路径' : '复制项目路径'}
            aria-label={copiedPath ? '已复制路径' : '复制项目路径'}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: copiedPath ? 'var(--td-success-color)' : 'var(--td-text-color-secondary)' }}
            data-project-copy-path
            data-copied={copiedPath ? '1' : undefined}
          >
            {copiedPath ? <Check size={15} /> : <Copy size={15} />}
          </button>

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

        {/* ── 项目任务（A119）───────────────────────────────────────
            放在记忆条与会话列表之间：任务是「接下来要做什么」，比「翻旧会话」
            更需要被看见。列表栏里看不出任务状态，所以这块不做折叠 ——
            折叠等于默认藏起来，而它本来就是这一页的主内容之一。 */}
        <div className="mb-5" data-project-tasks>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              <ListTodo size={15} style={{ color: 'var(--td-text-color-secondary)' }} />
              任务
            </h2>
            <span
              className="text-caption tabular-nums"
              style={{ color: 'var(--td-text-color-secondary)' }}
              data-project-task-progress
            >
              {tasks.length === 0 ? '暂无' : `${doneCount}/${tasks.length} 已完成`}
            </span>
          </div>

          {/* 新增。用表单而不是裸 input：回车提交是浏览器的原生行为，
              自己监听 keydown 在中文输入法下会误触（候选词确认也发 Enter）。 */}
          <form
            className="mb-2 flex items-center gap-2"
            onSubmit={e => {
              e.preventDefault();
              void addTask();
            }}
          >
            <input
              value={draftTask}
              onChange={e => setDraftTask(e.target.value)}
              placeholder="加一条任务，回车确认"
              data-project-task-input
              className="min-w-0 flex-1 rounded-lg px-3 py-1.5 text-body outline-none"
              style={{
                backgroundColor: 'var(--td-bg-color-component)',
                color: 'var(--td-text-color-primary)',
                border: '1px solid transparent',
              }}
            />
            <button
              type="submit"
              disabled={!draftTask.trim()}
              data-project-task-add
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-3 text-caption transition-colors disabled:opacity-40"
              style={{
                backgroundColor: 'var(--td-brand-color-light)',
                color: 'var(--td-brand-color)',
              }}
            >
              <Plus size={13} />
              添加
            </button>
          </form>

          {/* 读失败 / 写失败都在这里说一句。不把列表清空 ——
             一次写入失败不该让人以为任务全没了。 */}
          {tasksError && (
            <p className="mb-2 text-caption" style={{ color: 'var(--td-error-color)' }} data-project-task-error>
              {tasksError}
            </p>
          )}

          {tasks.length === 0 ? (
            <p
              className="rounded-xl px-4 py-6 text-center text-caption"
              style={{ border: '1px dashed var(--tc-edge)', color: 'var(--td-text-color-placeholder)' }}
              data-project-task-empty
            >
              {tasksLoading ? '正在读取任务…' : '还没有任务。记下这个项目接下来要做什么'}
            </p>
          ) : (
            <ul data-project-task-list>
              {tasks.map(t => {
                const done = t.status === 'done';
                const doing = t.status === 'doing';
                const Icon = done ? CheckCircle2 : doing ? CircleDot : Circle;
                const label = done ? '已完成' : doing ? '进行中' : '待办';
                return (
                  <li
                    key={t.id}
                    className="group mb-1 flex items-center gap-2.5 rounded-xl px-3 py-2 transition-colors hover:bg-[var(--tc-hover-chrome)]"
                    data-project-task-row={t.id}
                    data-task-status={t.status}
                  >
                    {/* 状态按钮：点一下推进一档。title 写清「点它会变成什么」，
                        否则用户看不出这是可点的（一个空心圆太像装饰）。 */}
                    <button
                      type="button"
                      onClick={() => cycleTask(t)}
                      title={`${label} · 点击改为「${done ? '待办' : doing ? '已完成' : '进行中'}」`}
                      aria-label={`任务状态：${label}`}
                      data-project-task-toggle
                      className="shrink-0"
                      style={{
                        color: done
                          ? 'var(--td-success-color)'
                          : doing
                            ? 'var(--td-brand-color)'
                            : 'var(--td-text-color-placeholder)',
                      }}
                    >
                      <Icon size={17} />
                    </button>
                    <span
                      className="min-w-0 flex-1 truncate text-body"
                      style={{
                        color: done ? 'var(--td-text-color-secondary)' : 'var(--td-text-color-primary)',
                        textDecoration: done ? 'line-through' : 'none',
                      }}
                      data-project-task-title
                    >
                      {t.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTask(t)}
                      title="删除任务"
                      aria-label="删除任务"
                      data-project-task-delete
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

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
