import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  Globe,
  RefreshCw,
  TerminalSquare,
  X,
} from 'lucide-react';
import { PanelHeader } from './PanelHeader';
import { WorkspaceBrowser } from './WorkspaceBrowser';
import { WorkspaceTerminal } from './WorkspaceTerminal';

/**
 * A77：右侧工作区面板。三个标签：文件（P1）/ 浏览器（P2）/ 终端（P4）。
 *
 * ## 终端为什么现在摆得出来，而 P1 那时摆不出来
 *
 * P1 那会儿浏览器和终端都还没做，先摆两个点不动的标签就是把「假控件」
 * 写进界面 —— 本项目反复在防这件事（见 `permissions.ts` 的 limitation 口径）。
 * 现在三个都是真能用的：文件树能看、浏览器能加载、终端能敲命令。
 * 终端那一版**没有 PTY**（vim / top 不可用），这件事在 `WorkspaceTerminal`
 * 里常驻说明，不靠用户自己踩出来。
 *
 * ## 为什么是只读
 *
 * 面板回答的是「我在哪个项目里、它长什么样」。写操作有两条更合适的路：
 * Agent 自己的工具、以及用户的外部编辑器。在这里再做一套编辑/保存/冲突
 * 处理，成本远超收益，而且会和 Agent 的改动互相踩。
 *
 * ## 为什么点文件是「用系统程序打开」
 *
 * 内嵌编辑器要 monaco + 语言服务 + 保存链路，是一整个项目。
 * 而「在 VS Code 里打开这个文件」本来就是用户想要的动作，一步到位。
 * 浏览器开发态没有这层桥，退化成复制路径 —— 说清楚，不假装成功。
 */

interface OpcBridge {
  openPath?(path: string): Promise<string>;
  revealInFolder?(path: string): void;
}

interface FsEntry {
  name: string;
  path: string;
  abs: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
}

interface FsListResult {
  root: string;
  path: string;
  entries: FsEntry[];
  truncated: boolean;
}

interface WorkspacePanelProps {
  sessionId: string;
  /** 会话绑定的工作目录；null / undefined = 未绑定，面板给出指引而不是退回进程目录 */
  cwd?: string | null;
  onClose: () => void;
}

/** 目录名：同时兼容 `/` 与 `\`，末尾分隔符不算一段 */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** 上次停在哪个标签。布局偏好，不是会话状态 —— 所以放 localStorage。 */
const TAB_KEY = 'opc.workspace-tab';

function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function WorkspacePanel({ sessionId, cwd, onClose }: WorkspacePanelProps) {
  /** 相对 cwd 的路径，'' = 根目录 */
  const [rel, setRel] = useState('');
  /**
   * 当前标签。只有两个 —— **没有「终端」**：它还没做，摆一个点不动的标签
   * 就是假控件（本项目反复在防的那件事）。
   *
   * 记住上次停在哪个标签：用户常常是「开着浏览器标签干活，中途去文件树
   * 看一眼路径」，回来不该又回到文件标签 —— 那一下跳转比多一次点击更烦。
   */
  const [tab, setTab] = useState<'files' | 'browser' | 'terminal'>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return saved === 'browser' || saved === 'terminal' ? saved : 'files';
    } catch {
      return 'files';
    }
  });
  const [data, setData] = useState<FsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 每次请求的序号：慢请求回来时如果已经不是最新一次，直接丢弃 */
  const requestSeq = useRef(0);

  // 换会话就回到根目录：把上一个项目的路径带到新会话里，只会得到
  // 一句「路径不存在」，用户还得自己点回根 —— 不如一开始就在根。
  useEffect(() => {
    setRel('');
  }, [sessionId]);

  // 标签选择落盘：读写都包 try（隐私模式下写不进去只影响下次默认值）
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* 见上 */
    }
  }, [tab]);

  const load = useCallback(
    async (target: string) => {
      if (!cwd) {
        setData(null);
        setError(null);
        return;
      }
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ sessionId, path: target });
        const res = await fetch(`/api/fs/list?${qs.toString()}`);
        const body = await res.json().catch(() => ({}));
        if (seq !== requestSeq.current) return;
        if (!res.ok) {
          setData(null);
          setError(typeof body?.error === 'string' ? body.error : `读取失败（${res.status}）`);
          return;
        }
        setData(body as FsListResult);
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setData(null);
        setError(e instanceof Error ? e.message : '读取失败');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [cwd, sessionId]
  );

  useEffect(() => {
    void load(rel);
  }, [load, rel]);

  // 提示条自己消失：它是「刚才那一下的结果」，不该常驻占一行
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const bridge = (window as unknown as { opc?: OpcBridge }).opc;

  const openFile = async (entry: FsEntry) => {
    if (bridge?.openPath) {
      const failure = await bridge.openPath(entry.abs);
      if (failure) setNotice(failure);
      return;
    }
    try {
      await navigator.clipboard.writeText(entry.abs);
      setNotice('已复制路径（浏览器开发态无法直接打开文件）');
    } catch {
      setNotice('浏览器开发态无法直接打开文件');
    }
  };

  const segments = rel ? rel.split('/').filter(Boolean) : [];
  const crumbs = segments.map((name, i) => ({
    name,
    path: segments.slice(0, i + 1).join('/'),
  }));

  const folderName = data ? basename(data.root) : cwd ? basename(cwd) : '未绑定';

  return (
    <aside
      className="flex min-h-0 shrink-0 flex-col"
      style={{
        width: 300,
        borderLeft: '1px solid var(--tc-split)',
        backgroundColor: 'var(--tc-surface-content)',
      }}
      aria-label="工作区文件"
    >
      <PanelHeader
        compact
        level="column"
        surface="content"
        title="工作区"
        badge={
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate text-caption"
              style={{ color: 'var(--td-text-color-secondary)' }}
              title={cwd || undefined}
            >
              {folderName}
            </span>
            {tab === 'files' && (
              <span
                className="shrink-0 rounded px-1 py-[1px] text-caption"
                style={{
                  backgroundColor: 'var(--tc-hover-chrome)',
                  color: 'var(--td-text-color-placeholder)',
                }}
              >
                只读
              </span>
            )}
          </span>
        }
        actions={
          <>
            {/* 刷新只对文件标签有意义：浏览器标签有自己的刷新，且在工具栏里 */}
            {tab === 'files' && (
              <button
                type="button"
                onClick={() => void load(rel)}
                title="刷新"
                aria-label="刷新目录"
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="关闭工作区"
              aria-label="关闭工作区"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              <X size={15} />
            </button>
          </>
        }
      />

      {/* 标签行。放在栏头**下面**而不是塞进 actions：栏头要与聊天栏头
          同高同线（PanelHeader compact 的 52px），往里加一排会把两栏的
          分隔线错开。 */}
      <div
        className="flex h-9 shrink-0 items-center gap-1 px-2"
        style={{ borderBottom: '1px solid var(--tc-hairline)' }}
        role="tablist"
        aria-label="工作区标签"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'files'}
          onClick={() => setTab('files')}
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption transition-colors"
          style={{
            backgroundColor: tab === 'files' ? 'var(--tc-hover-chrome)' : 'transparent',
            color:
              tab === 'files' ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
          }}
        >
          <Folder size={13} />
          文件
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'browser'}
          onClick={() => setTab('browser')}
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption transition-colors"
          style={{
            backgroundColor: tab === 'browser' ? 'var(--tc-hover-chrome)' : 'transparent',
            color:
              tab === 'browser' ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
          }}
        >
          <Globe size={13} />
          浏览器
        </button>
        {/*
          P4：终端。**这一版是真的能敲命令的**（管道版 shell），所以摆得出来。
          它没有 PTY —— 那件事在 WorkspaceTerminal 里常驻说明，不靠用户自己发现。
        */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'terminal'}
          onClick={() => setTab('terminal')}
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption transition-colors"
          style={{
            backgroundColor: tab === 'terminal' ? 'var(--tc-hover-chrome)' : 'transparent',
            color:
              tab === 'terminal' ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
          }}
        >
          <TerminalSquare size={13} />
          终端
        </button>
      </div>

      {tab === 'browser' ? (
        <WorkspaceBrowser />
      ) : tab === 'terminal' ? (
        <WorkspaceTerminal cwd={cwd} />
      ) : !cwd ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <Folder size={22} style={{ color: 'var(--td-text-color-placeholder)' }} />
          <p className="text-body">这个会话还没绑定工作目录</p>
          <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
            用标题栏的工作区徽标选一个目录，再回来看
          </p>
        </div>
      ) : (
        <>
          {/* 面包屑：横向可滚，不换行 —— 换行会让面板头部高度随路径深度跳动 */}
          <div
            className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto px-2 text-caption"
            style={{ borderBottom: '1px solid var(--tc-hairline)' }}
          >
            <button
              type="button"
              onClick={() => setRel('')}
              className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{
                color: rel ? 'var(--td-text-color-secondary)' : 'var(--td-text-color-primary)',
              }}
              title={data?.root || cwd}
            >
              {folderName}
            </button>
            {crumbs.map((crumb, i) => (
              <span key={crumb.path} className="flex shrink-0 items-center">
                <ChevronRight size={11} style={{ color: 'var(--td-text-color-placeholder)' }} />
                <button
                  type="button"
                  onClick={() => setRel(crumb.path)}
                  className="rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  style={{
                    color:
                      i === crumbs.length - 1
                        ? 'var(--td-text-color-primary)'
                        : 'var(--td-text-color-secondary)',
                  }}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>

          {notice && (
            <div
              className="shrink-0 px-3 py-1.5 text-caption"
              style={{ color: 'var(--td-text-color-secondary)', backgroundColor: 'var(--tc-hover-chrome)' }}
            >
              {notice}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {error ? (
              <div className="flex flex-col gap-2 px-3 py-4">
                <p className="text-body" style={{ color: 'var(--td-error-color)' }}>
                  {error}
                </p>
                <button
                  type="button"
                  onClick={() => void load(rel)}
                  className="self-start rounded-md px-2 py-1 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  style={{ border: '1px solid var(--tc-hairline)', color: 'var(--td-text-color-secondary)' }}
                >
                  重试
                </button>
              </div>
            ) : !data && loading ? (
              <p className="px-3 py-4 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                正在读取…
              </p>
            ) : data && data.entries.length === 0 ? (
              <p className="px-3 py-4 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                这个目录是空的
              </p>
            ) : (
              data?.entries.map(entry => {
                const isDir = entry.type === 'dir';
                return (
                  <div
                    key={entry.path}
                    className="group flex items-center gap-1 rounded-md pr-1 hover:bg-[var(--tc-hover-chrome)]"
                    style={{ marginLeft: 4, marginRight: 4 }}
                  >
                    <button
                      type="button"
                      onClick={() => (isDir ? setRel(entry.path) : void openFile(entry))}
                      title={isDir ? entry.name : `用系统程序打开：${entry.abs}`}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-[5px] text-left"
                    >
                      {isDir ? (
                        <Folder size={14} className="shrink-0" style={{ color: 'var(--td-text-color-secondary)' }} />
                      ) : (
                        <FileIcon size={14} className="shrink-0" style={{ color: 'var(--td-text-color-placeholder)' }} />
                      )}
                      <span className="truncate text-body" style={{ color: 'var(--td-text-color-primary)' }}>
                        {entry.name}
                      </span>
                      {!isDir && (
                        <span
                          className="ml-auto shrink-0 text-caption"
                          style={{ color: 'var(--td-text-color-placeholder)' }}
                        >
                          {formatSize(entry.size)}
                        </span>
                      )}
                    </button>
                    {!isDir && bridge?.revealInFolder && (
                      <button
                        type="button"
                        onClick={() => bridge.revealInFolder?.(entry.abs)}
                        title="在文件夹中显示"
                        aria-label={`在文件夹中显示 ${entry.name}`}
                        className="hidden h-6 w-6 shrink-0 items-center justify-center rounded group-hover:flex hover:bg-[var(--tc-active-chrome)]"
                        style={{ color: 'var(--td-text-color-secondary)' }}
                      >
                        <Folder size={12} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {data?.truncated && (
            <p
              className="shrink-0 px-3 py-1.5 text-caption"
              style={{
                borderTop: '1px solid var(--tc-hairline)',
                color: 'var(--td-text-color-placeholder)',
              }}
            >
              条目过多，只显示前 500 项
            </p>
          )}
        </>
      )}
    </aside>
  );
}
