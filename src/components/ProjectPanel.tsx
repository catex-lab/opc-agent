import { useMemo, useState } from 'react';
import { FolderKanban, Plus, RefreshCw, Search, FolderOpen, Check, X } from 'lucide-react';
import type { Project } from '../types';
import { hasNativeDialogs } from '../workspace';

interface ProjectPanelProps {
  projects: Project[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * 添加项目。传 `cwd` 表示用户手输了路径；不传表示走原生目录对话框。
   * 两种入口都要有 —— 浏览器开发态 / 验证脚本里没有 `window.opc`，
   * 只留原生对话框的话，添加功能在那些环境下完全不可用（点一下毫无反应）。
   */
  onAdd: (cwd?: string) => void | Promise<void>;
  onRefresh: () => void;
  compact?: boolean;
}

/**
 * 项目列表栏（A117）。
 *
 * ## 它和「聊天」栏是什么关系
 *
 * 会话列表栏回答「我最近跟谁说过话」，按**时间**排；这一栏回答「我在哪些
 * 目录下干过活」，按**目录**分组。同一批会话，两种组织方式 —— 所以两栏
 * 宽度、底色、圆角完全一致（`--tc-sidebar-width` / chrome / column-radius），
 * 切换时视觉不跳。
 *
 * ## 为什么栏头只有 60px（dense）
 *
 * 会话栏的栏头是 52px 的搜索行，通讯录是搜索胶囊 + Tab。这一栏内容更少
 * （标题 + 计数 + 两颗按钮），没必要背 88px 的「栏级标题」规格 ——
 * 那个高度是为了让并排两栏的标题落在同一条水平线上，而这里右侧是内容区、
 * 不是另一条栏。用 PanelHeader 的 dense 变体，与右侧详情页头部同高，
 * 两块的底边线能连成一条。
 */
export function ProjectPanel({
  projects,
  loading,
  error,
  selectedId,
  onSelect,
  onAdd,
  onRefresh,
  compact = false,
}: ProjectPanelProps) {
  const [keyword, setKeyword] = useState('');
  /**
   * 手输路径的内联表单。
   *
   * 有原生对话框时「+」直接开对话框；没有时（浏览器开发态、验证脚本）
   * 展开这个表单 —— 否则那颗按钮点下去什么都不会发生，是假控件。
   */
  const [adding, setAdding] = useState(false);
  const [draftPath, setDraftPath] = useState('');
  const native = hasNativeDialogs();

  const startAdd = () => {
    if (native) void onAdd();
    else { setAdding(true); setDraftPath(''); }
  };

  const submitAdd = () => {
    const p = draftPath.trim();
    if (!p) return;
    void onAdd(p);
    setAdding(false);
    setDraftPath('');
  };

  const visible = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return projects;
    return projects.filter(
      p => p.name.toLowerCase().includes(k) || p.path.toLowerCase().includes(k)
    );
  }, [projects, keyword]);

  const totalSessions = projects.reduce((n, p) => n + p.sessionCount, 0);

  return (
    <div
      className={`flex flex-col ${compact ? 'w-full' : 'shrink-0'}`}
      style={{
        backgroundColor: 'var(--tc-surface-chrome)',
        width: compact ? undefined : 'var(--tc-sidebar-width)',
        borderRadius: 'var(--tc-column-radius)',
      }}
      data-project-panel
    >
      {/* 栏头：标题 + 计数 + 添加/刷新。高度与详情页头部一致（dense 60px） */}
      <header
        className="flex shrink-0 items-center gap-2 px-4"
        style={{
          minHeight: 'var(--panel-header-height-dense)',
          borderBottom: '1px solid var(--tc-divider)',
        }}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="truncate font-semibold text-title-lg" style={{ color: 'var(--td-text-color-primary)' }}>
            项目
          </h2>
          {/* 计数用次要色：它是「有多少」，不是「该点哪个」 */}
          <span className="shrink-0 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
            {projects.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          title="刷新项目列表"
          aria-label="刷新项目列表"
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
          data-project-refresh
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
        <button
          type="button"
          onClick={startAdd}
          title="添加项目（选一个目录）"
          aria-label="添加项目"
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
          data-project-add
        >
          <Plus size={17} />
        </button>
      </header>

      {/* 手输路径的内联表单（无原生对话框时出现） */}
      {adding && (
        <div className="shrink-0 px-3 pb-2 pt-2" data-project-add-form>
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={draftPath}
              onChange={e => setDraftPath(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitAdd();
                if (e.key === 'Escape') { setAdding(false); setDraftPath(''); }
              }}
              placeholder="目录绝对路径"
              className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-body outline-none"
              style={{
                color: 'var(--td-text-color-primary)',
                backgroundColor: 'var(--td-bg-color-component)',
                border: '1px solid var(--tc-edge-strong)',
              }}
              data-project-path-input
            />
            <button
              type="button"
              onClick={submitAdd}
              aria-label="确认添加"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-brand-color)' }}
              data-project-add-confirm
            >
              <Check size={15} />
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setDraftPath(''); }}
              aria-label="取消添加"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {/* 搜索：项目一多（十几个目录）就得靠它。没有项目时不渲染 ——
          对着空列表摆一个搜索框是纯装饰。 */}
      {projects.length > 0 && (
        <div className="shrink-0 px-3 pb-2 pt-2">
          <div
            className="flex h-9 items-center gap-2 rounded-full px-3"
            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
          >
            <Search size={14} style={{ color: 'var(--td-text-color-placeholder)' }} />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="搜索项目或路径"
              className="min-w-0 flex-1 bg-transparent text-body outline-none"
              style={{ color: 'var(--td-text-color-primary)' }}
              data-project-search
            />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-project-list>
        {error ? (
          <p className="px-3 py-6 text-body" style={{ color: 'var(--td-error-color)' }}>{error}</p>
        ) : loading && projects.length === 0 ? (
          <p className="px-3 py-6 text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>正在读取项目…</p>
        ) : projects.length === 0 ? (
          /* 空态：说清「项目是怎么来的」，否则用户会以为要先「新建项目」再聊天。
             实际是「取或建」—— 选一个目录就是建项目。 */
          <div className="px-3 py-8 text-center" data-project-empty>
            <FolderKanban size={28} className="mx-auto mb-2" style={{ color: 'var(--td-text-color-placeholder)' }} />
            <p className="text-body" style={{ color: 'var(--td-text-color-secondary)' }}>还没有项目</p>
            <p className="mt-1 text-caption leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
              项目就是「干过活的目录」。<br />
              选一个目录，它下面已有的会话会归到一起。
            </p>
            <button
              type="button"
              onClick={startAdd}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-brand-color)', border: '1px solid var(--tc-edge)' }}
              data-project-empty-add
            >
              <FolderOpen size={14} />
              {native ? '选择目录' : '输入目录路径'}
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
            没有匹配「{keyword}」的项目
          </p>
        ) : (
          visible.map(p => {
            const active = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                aria-current={active ? 'page' : undefined}
                className="mb-0.5 flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
                /* A75 的同一条教训：未选中项不能写内联 transparent 底色，
                   否则 hover 反馈被内联样式压死。只在选中时写。 */
                style={active ? { backgroundColor: 'var(--tc-fill-selected)' } : undefined}
                data-project-row={p.id}
              >
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: active ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-component)',
                    color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                  }}
                >
                  <FolderKanban size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="truncate text-body"
                      style={{
                        color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-primary)',
                      }}
                    >
                      {p.name}
                    </span>
                    {/* 有项目记忆才点这一颗 —— 它是「这个目录有自己的规矩」的
                        唯一视觉线索，比多一行字省地方。 */}
                    {p.memory?.exists && (
                      <span
                        title={`有项目记忆（${p.memory.coreTokens}/${p.memory.coreBudget} tokens）`}
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: 'var(--td-brand-color)' }}
                        data-project-memory-dot
                      />
                    )}
                  </span>
                  <span
                    className="mt-0.5 block truncate text-caption"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                    title={p.path}
                  >
                    {p.path}
                  </span>
                </span>
                <span
                  className="mt-1 shrink-0 text-caption tabular-nums"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                  data-project-count
                >
                  {p.sessionCount}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* 页脚：一句话交代「这一栏和聊天栏是什么关系」，顺带给个总数 */}
      {projects.length > 0 && (
        <div
          className="shrink-0 px-4 py-2 text-caption"
          style={{
            color: 'var(--td-text-color-placeholder)',
            borderTop: '1px solid var(--tc-divider)',
          }}
        >
          {projects.length} 个项目 · {totalSessions} 个会话
        </div>
      )}
    </div>
  );
}
