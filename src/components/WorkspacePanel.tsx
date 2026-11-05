import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  Globe,
  PanelRight,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react';
import { PanelHeader } from './PanelHeader';
import { WorkspaceBrowser } from './WorkspaceBrowser';
import { loadUrl } from '../browserPanel';
import { takePendingWorkspaceUrl, WORKSPACE_OPEN_URL_EVENT } from '../answer/linkRouter';
import { WorkspaceResizer } from './WorkspaceResizer';
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
 *
 * ## A86 修正：单击改成**面板内只读预览**，双击才用系统程序打开
 *
 * 上面那条（A77 的取舍）在真实使用里被否掉了：面板叫「工作区」，点一个 md
 * 却跳出应用，观感就是假的。所以现在的分工是 ——
 *
 *   · **单击 = 在面板里看**（`/api/fs/read`，只读、1 MB 上限、图片直出）；
 *   · **双击 / 预览页右上角按钮 = 用系统程序打开**（原来的 `openPath`）。
 *
 * 预览层**不做编辑**：没有保存、没有写回、没有冲突处理。写操作仍然只有
 * Agent 与外部编辑器两条路 —— 这条边界与 `server/fs.ts` 的「只读」口径一致，
 * 别在这里加 textarea。
 *
 * ## A172：html 在面板内做**沙箱预览**
 *
 * html 用 `<iframe sandbox>`（**不给** `allow-scripts` / `allow-same-origin`）
 * + `srcDoc` 渲染，srcDoc 里再注入 `default-src 'none'` 的 CSP、剥掉
 * `meta refresh`、加 `<base target="_blank">`。目标只有三条：
 * **只看不改、不联网、不执行脚本**。默认走预览，可切「源码」；切换偏好落到
 * localStorage（与标签页偏好同一套 key）。
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

/** A86：`/api/fs/read` 的返回。kind 决定用哪种渲染，前端不猜扩展名。 */
type FsReadKind = 'text' | 'image' | 'binary' | 'too-large';

interface FsReadResult {
  path: string;
  abs: string;
  size: number;
  kind: FsReadKind;
  content?: string;
  lines?: number;
  mime?: string;
  /** kind === 'image' 时由后端给出，指向 `/api/fs/raw` */
  url?: string;
}

interface PreviewState {
  entry: FsEntry;
  data: FsReadResult | null;
  loading: boolean;
  error: string | null;
}

/**
 * 预览最多渲染多少行。
 *
 * 1 MB 的源码能有几万行，一次全铺进 DOM 会让面板滚都滚不动（而这里没有
 * 虚拟列表）。超出部分不静默丢弃 —— 底部如实写「只渲染前 N 行」。
 */
export const MAX_PREVIEW_LINES = 2000;

/**
 * 超过这个字节数的 markdown **退回纯文本**（A87）。
 *
 * cherry-markdown 是完整解析器，几百 KB 的 md 会把面板卡住几秒 —— 而「看一眼
 * README」不需要那种量级。退回去时如实说明，不是静默降级。
 */
export const MAX_MARKDOWN_BYTES = 256 * 1024;

/**
 * A172：html 沙箱预览的大小上限，与 `server/fs.ts` 的 `MAX_TEXT_BYTES` 同值。
 *
 * 前端不能 import 服务端模块（会把 Node 代码拖进浏览器 bundle），所以这里
 * 复制一份口径。服务端超过 1 MB 会直接返回 `too-large`（连源码都不给），
 * 两边必须保持一致 —— 改 `server/fs.ts` 的这个值时这里要同步。
 */
export const MAX_HTML_PREVIEW_BYTES = 1024 * 1024;

/** html 预览偏好（预览 / 源码）。与标签页偏好同一套 `opc.workspace-*` 命名。 */
const HTML_VIEW_KEY = 'opc.workspace-html-view';

/** 只有这两种扩展名走富文本渲染；`.mdx` 不认（里面可能有 JSX，渲染不了）。 */
function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/** html 沙箱预览只认 `.html` / `.htm`。 */
function isHtmlFile(name: string): boolean {
  return /\.(html|htm)$/i.test(name);
}

/**
 * A172：注入到 srcDoc 里的严格 CSP。
 *
 * - `default-src 'none'`：脚本、图片、字体、媒体、frame、XHR/fetch/WebSocket
 *   全部落到默认拒绝，文件里任何一个外链都发不出去 —— **零网络请求**；
 * - `style-src 'unsafe-inline'`：只留内联样式（否则页面会裸奔，连居中都没有）；
 * - `form-action 'none'`：表单提交也拒；
 * - `base-uri 'none'`：防止文件里写 `<base href="https://evil">` 把相对 URL 改写。
 */
const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/**
 * A172：把任意 html 改造成可安全塞进 `srcDoc` 的文档。
 *
 * 三件事：
 *   1. **剥掉 `<meta http-equiv="refresh">`** —— CSP 管不住「文档自己导航自己」，
 *      meta refresh 能把 iframe 跳到外网，是绕过 `default-src 'none'` 的唯一口子；
 *   2. 注入 CSP（越早越好：紧跟 `<head>` 之后，或补一个 `<head>`）；
 *   3. 加 `<base target="_blank">` —— 原文件里的链接只能在「新窗口」打开，而
 *      沙箱没给 `allow-popups`，等于点了没反应，不会把面板整个接管。
 */
export function buildSafeHtmlDocument(raw: string): string {
  const headInject =
    `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
    '<base target="_blank">';
  const withoutRefresh = raw.replace(
    /<meta\s+http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)[^>]*>/gi,
    ''
  );
  const head = /<head(\s[^>]*)?>/i;
  if (head.test(withoutRefresh)) return withoutRefresh.replace(head, m => `${m}${headInject}`);
  const html = /<html(\s[^>]*)?>/i;
  if (html.test(withoutRefresh)) return withoutRefresh.replace(html, m => `${m}<head>${headInject}</head>`);
  return `<head>${headInject}</head>${withoutRefresh}`;
}

/**
 * A87：md 预览复用聊天那套 `ChatMarkdown`（cherry-markdown）。
 *
 * ## 为什么要 lazy
 *
 * `WorkspacePanel` 挂在 `App` 上（不是 ChatPage 的路由内），静态 import
 * `@tdesign-react/chat` 会把 cherry-markdown 一起拖进**入口 chunk** ——
 * 实测 index 从 892 KB 涨到 4.15 MB，等于每次冷启动都要多解析 3.2 MB
 * 只为了「可能有人会点开一个 md」。改成动态 import 后，这段只在真的
 * 预览 md 时才下载。
 *
 * 命名导出要包一层 `.then`：`React.lazy` 只认 `default`。
 */
const ChatMarkdown = lazy(() =>
  import('@tdesign-react/chat').then(m => ({ default: m.ChatMarkdown }))
);

interface WorkspacePanelProps {
  sessionId: string;
  /** 会话绑定的工作目录；null / undefined = 未绑定，面板给出指引而不是退回进程目录 */
  cwd?: string | null;
  onClose: () => void;
  /**
   * C2：窄窗抽屉模式。
   *
   * 宽屏下它是并排的第三列，宽度由 `--tc-workspace-width` 决定（可拖）；
   * 窄窗下列宽已经不够分，它抬成 360px 浮层盖在聊天列上，不参与列宽分配，
   * 也不提供宽度手柄（拖窄了只会让正文更挤）。
   */
  drawer?: boolean;
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

export function WorkspacePanel({ sessionId, cwd, onClose, drawer = false }: WorkspacePanelProps) {
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
  /** A86：面板内预览。null = 正在看目录树 */
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** 每次请求的序号：慢请求回来时如果已经不是最新一次，直接丢弃 */
  const requestSeq = useRef(0);
  const previewSeq = useRef(0);

  /**
   * A174：正文外链「在应用内打开」的落地端。
   *
   * 链接在消息里、浏览视图在这里，中间靠 `linkRouter` 的 pending + 事件接。
   * 两个入口都要接：
   *   · 挂载时先捞一次 —— 面板是**因这次点击才被打开**的，事件已经发过了；
   *   · 常驻监听 —— 面板本来就开着的情况。
   * 取走 pending 之后切到浏览标签，并直接往主进程的视图里 load（不依赖
   * `WorkspaceBrowser` 已经挂载：它挂载后会从 navState 里读回当前地址）。
   */
  useEffect(() => {
    const consume = () => {
      const url = takePendingWorkspaceUrl();
      if (!url) return;
      setTab('browser');
      setPreview(null);
      void loadUrl(url);
    };
    window.addEventListener(WORKSPACE_OPEN_URL_EVENT, consume);
    consume();
    return () => window.removeEventListener(WORKSPACE_OPEN_URL_EVENT, consume);
  }, []);

  // 换会话就回到根目录：把上一个项目的路径带到新会话里，只会得到
  // 一句「路径不存在」，用户还得自己点回根 —— 不如一开始就在根。
  // A86：换 cwd 同理 —— 预览的是上一个项目的文件，留在屏幕上就是错的。
  useEffect(() => {
    setRel('');
    setPreview(null);
  }, [sessionId, cwd]);

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

  /**
   * A86：面板内只读预览。
   *
   * 失败一律落到 `preview.error` 并在预览层里显示 —— 不要退回「复制路径」，
   * 那会让「为什么看不了」变成一次静默降级。浏览器开发态没有 `/api/fs/read` 吗？
   * 有，它就在同一个 Express 上，所以这条路径在两种形态下都成立。
   */
  const openPreview = async (entry: FsEntry) => {
    const seq = ++previewSeq.current;
    setPreview({ entry, data: null, loading: true, error: null });
    try {
      const qs = new URLSearchParams({ sessionId, path: entry.path });
      const res = await fetch(`/api/fs/read?${qs.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (seq !== previewSeq.current) return;
      if (!res.ok) {
        setPreview({
          entry,
          data: null,
          loading: false,
          error: typeof body?.error === 'string' ? body.error : `读取失败（${res.status}）`,
        });
        return;
      }
      setPreview({ entry, data: body as FsReadResult, loading: false, error: null });
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setPreview({
        entry,
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : '读取失败',
      });
    }
  };

  const closePreview = () => {
    previewSeq.current++;
    setPreview(null);
  };

  /** 用系统默认程序打开（双击 / 预览页右上角按钮）。 */
  const openExternal = async (entry: FsEntry) => {
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

  /* A84：这里原来是 `data ? basename(data.root) : …`。
     `data` 只要有值就走 basename，而 basename 第一行是 `p.split(...)` ——
     后端若返回 200 但 body 不是 `{root, entries}`（代理改写、旧版本服务端、
     字段改名），`data.root` 是 undefined，这里直接抛 TypeError，
     ErrorBoundary 会把**整个三栏**换成错误页。
     一个「读目录失败」不该等于「应用崩了」，所以判空条件收到字段级。 */
  const folderName = data?.root ? basename(data.root) : cwd ? basename(cwd) : '未绑定';

  return (
    <aside
      // relative：宽度手柄要绝对定位在左边缘上（见 WorkspaceResizer）
      // drawer：脱离列布局，贴右缘浮在聊天列上方
      className={`flex min-h-0 shrink-0 flex-col${drawer ? ' absolute inset-y-0 right-0 z-30' : ' relative'}`}
      // A105：给栏目一个稳定锚点（verify-surface 断言圆角用）。
      // 这两块都是匿名 div，靠结构选择器定位会在任何一次布局调整后失效。
      data-tc-column="workspace"
      data-workspace-drawer={drawer ? 'true' : undefined}
      style={{
        // 宽度走 CSS 变量：拖动时每帧改变量不触发 React 重渲染（文件树、
        // WebContentsView 宿主都在这棵树里）。没拖过时退回 300px 设计值。
        // C2：抽屉是固定 360px —— 盖在正文上的一层，拖宽只会把聊天挤掉。
        width: drawer ? '360px' : 'var(--tc-workspace-width, 300px)',
        // A103：微圆角。左缘原先是一条 1px `--tc-split` 边线 —— 现在它与
        // 聊天列之间有 6px 缝，边线连同圆角一起换成几何分隔，故移除。
        // A95：工作区用专用面（比对话区差一档）。此前这里写的是
        // --tc-surface-content，和中间对话区完全同色，两侧只靠 1px 线分开 ——
        // 「在读」和「在写」两块分不清，扫一眼找不到光标在哪半边。
        backgroundColor: 'var(--tc-surface-aside)',
        borderRadius: drawer ? 'var(--tc-radius-float)' : 'var(--tc-column-radius)',
        // C2：抽屉浮在内容之上，需要投影把「层」讲清楚（与遮罩配套）。
        boxShadow: drawer ? 'var(--tc-shadow-drawer)' : undefined,
      }}
      aria-label="工作区文件"
    >
      {/* A82：宽度拖拽手柄。绝对定位且往左探出 2px，不占布局宽度 —— 与
          左侧 SidebarResizer 同一条理由（占位会让面板和聊天区多一条缝）。
          C2：抽屉模式没有可拖的列宽，手柄一并去掉。 */}
      {!drawer && <WorkspaceResizer />}
      <PanelHeader
        compact
        level="column"
        surface="aside"
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
              /* A84：去掉 `--tc-hover-chrome` 灰底。它是「只读」这条状态读数，
                 不是按钮；灰底会把它读成一枚可点的标签。 */
              <span
                className="shrink-0 rounded px-1 py-[1px] text-caption"
                style={{ color: 'var(--td-text-color-placeholder)' }}
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
            {/* A84（需求）：这里原来是「×」。用户的意思是——面板一展开，
                聊天头部那枚「展开工作区」按钮就该搬到这个位置，由它自己
                充当收起入口，且**不要 × 图标**。于是同一个图标（PanelRight）
                在两种状态下只有一个落点：没收起时在聊天头部，收起了就在这儿。
                图标语义连续（同一个「侧栏」符号），位置也连续（都在右上角）。 */}
            <button
              type="button"
              onClick={onClose}
              title="收起工作区"
              aria-label="收起工作区"
              data-workspace-toggle="collapse"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              <PanelRight size={15} />
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
      ) : preview ? (
        <FilePreview
          state={preview}
          onClose={closePreview}
          onOpenExternal={() => void openExternal(preview.entry)}
        />
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
            ) : data && (data.entries?.length ?? 0) === 0 ? (
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
                      // A86（反馈后改）：单击 = 面板内预览，双击 = 用系统程序打开。
                      // A82 那版是「单击直接外部打开」，理由是对齐资源管理器；但真实
                      // 使用里它让整个面板读起来像假的（点 md 跳出应用）。目录仍然是
                      // 单击进入 —— 目录没有「预览」这回事。
                      onClick={() => (isDir ? setRel(entry.path) : void openPreview(entry))}
                      onDoubleClick={() => {
                        if (!isDir) void openExternal(entry);
                      }}
                      title={isDir ? entry.name : `单击预览 · 双击用系统程序打开\n${entry.abs}`}
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

/**
 * A86：面板内的只读预览层。
 *
 * 三种正文 + 两种「看不了」：文本（带行号）、图片（`/api/fs/raw` 直出）、
 * 二进制与超大文件（说明 + 一个「用系统程序打开」的出口）。
 *
 * ## 为什么行号用两个 `<pre>` 而不是逐行 div
 *
 * 2000 行 = 2000 个 `<div>` + 4000 个 `<span>`，滚动会明显发涩。两列 `<pre>`
 * 只有两个节点，行高一致就对齐了 —— 这个面板不需要「行选中」之类的交互，
 * 没有理由为它建一棵大 DOM。
 */
function FilePreview({
  state,
  onClose,
  onOpenExternal,
}: {
  state: PreviewState;
  onClose: () => void;
  onOpenExternal: () => void;
}) {
  const { entry, data, loading, error } = state;
  const lines = data?.kind === 'text' && typeof data.content === 'string' ? data.content.split('\n') : [];
  const shown = lines.slice(0, MAX_PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  /**
   * A87：md 走**同一个**渲染器（TDesign ChatMarkdown / cherry-markdown），
   * 不另引一套。聊天正文已经在用它，两处同一套 `::part` 样式与主题变量 ——
   * 再引 react-markdown 就等于在一个应用里养两种 markdown，表格与代码块
   * 的行为会肉眼可见地不一致。
   */
  const richMarkdown = isMarkdownFile(entry.name) && (data?.size ?? 0) <= MAX_MARKDOWN_BYTES;
  /**
   * md 超过 MAX_MARKDOWN_BYTES 退回纯文本时的**显式说明**开关。
   *
   * 上面 MAX_MARKDOWN_BYTES 的注释承诺「如实说明，不是静默降级」—— 但原先
   * 渲染路径里没有任何提示，大 md 悄无声息地变成等宽纯文本。这个标记位
   * 就是补上那句说明（见下面纯文本分支顶部的提示条）。
   */
  const markdownPlainFallback =
    data?.kind === 'text' && isMarkdownFile(entry.name) && !richMarkdown;

  /**
   * A172：html 的「预览 / 源码」切换。
   *
   * 默认预览；偏好是全局的（同一套 localStorage 偏好），所以同一个文件关掉
   * 再打开时会停在上次选的视图 —— 用户不用每开一次就切一次。
   */
  const [htmlView, setHtmlView] = useState<'preview' | 'source'>(() => {
    try {
      return localStorage.getItem(HTML_VIEW_KEY) === 'source' ? 'source' : 'preview';
    } catch {
      return 'preview';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(HTML_VIEW_KEY, htmlView);
    } catch {
      /* 隐私模式写不进去只影响下次默认值 */
    }
  }, [htmlView]);

  const isHtml = isHtmlFile(entry.name);
  const htmlHasSource = data?.kind === 'text';
  /** 上限沿用文本阈值；服务端超过 1 MB 直接返回 too-large，这里只是同口径兜底 */
  const htmlPreviewAllowed = isHtml && htmlHasSource && (data?.size ?? 0) <= MAX_HTML_PREVIEW_BYTES;
  /** 拿了源码但超过阈值（服务端阈值若放宽才会出现）：强制源码 + 说明 */
  const htmlOversizeFallback = isHtml && htmlHasSource && !htmlPreviewAllowed;
  const showHtmlPreview = htmlPreviewAllowed && htmlView === 'preview';
  const mono = {
    fontFamily: 'var(--font-mono)',
    /* A133：原来是裸 12。文件预览是「次级信息」（读而不是写），
       取 --text-secondary 与「辅助说明」同一档；值不变，出处补上。 */
    fontSize: 'var(--text-secondary)',
    lineHeight: '18px',
  } as const;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-file-preview>
      <div
        className="flex h-9 shrink-0 items-center gap-1 px-2"
        style={{ borderBottom: '1px solid var(--tc-hairline)' }}
      >
        <button
          type="button"
          onClick={onClose}
          title="返回目录"
          aria-label="返回目录"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
          data-file-preview-close
        >
          <ChevronLeft size={14} />
        </button>
        <span
          className="min-w-0 flex-1 truncate text-caption"
          style={{ color: 'var(--td-text-color-primary)' }}
          title={entry.abs}
        >
          {entry.name}
        </span>
        {htmlPreviewAllowed && (
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5"
            style={{ border: '1px solid var(--tc-hairline)' }}
            role="group"
            aria-label="html 预览方式"
            data-html-view-toggle
          >
            {(['preview', 'source'] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setHtmlView(v)}
                aria-pressed={htmlView === v}
                className="rounded px-1.5 py-0.5 text-caption transition-colors"
                style={{
                  color:
                    htmlView === v
                      ? 'var(--td-text-color-primary)'
                      : 'var(--td-text-color-secondary)',
                  background:
                    htmlView === v ? 'var(--tc-hover-chrome)' : 'transparent',
                }}
              >
                {v === 'preview' ? '预览' : '源码'}
              </button>
            ))}
          </div>
        )}
        <span
          className="shrink-0 text-caption"
          style={{ color: 'var(--td-text-color-placeholder)' }}
        >
          {formatSize(data?.size ?? entry.size)}
        </span>
        <button
          type="button"
          onClick={onOpenExternal}
          title="用系统程序打开"
          aria-label="用系统程序打开"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {loading ? (
        <p className="px-3 py-4 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          正在读取…
        </p>
      ) : error ? (
        <div className="flex flex-col gap-2 px-3 py-4">
          <p className="text-body" style={{ color: 'var(--td-error-color)' }}>
            {error}
          </p>
          <button
            type="button"
            onClick={onOpenExternal}
            className="self-start rounded-md px-2 py-1 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ border: '1px solid var(--tc-hairline)', color: 'var(--td-text-color-secondary)' }}
          >
            用系统程序打开
          </button>
        </div>
      ) : !data ? null : data.kind === 'text' && richMarkdown ? (
        <div
          className="chat-markdown min-h-0 min-w-0 flex-1 overflow-auto px-3 py-2"
          data-markdown-preview
        >
          {/* 动态 chunk 还没到时给一句人话，不要白屏 —— 面板里白屏最容易被
              读成「这个功能是假的」 */}
          <Suspense
            fallback={
              <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                正在渲染…
              </p>
            }
          >
            <ChatMarkdown content={data.content ?? ''} />
          </Suspense>
        </div>
      ) : data.kind === 'text' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* md 超限退回纯文本的显式说明：样式沿用底部「只渲染前 N 行」那条
              （caption + hairline），位置放顶部 —— 它是「这份内容的渲染方式」，
              用户读第一行之前就该知道，不是弹窗、不占常驻行。 */}
          {markdownPlainFallback && (
            <p
              className="shrink-0 px-3 py-1.5 text-caption"
              style={{
                borderBottom: '1px solid var(--tc-hairline)',
                color: 'var(--td-text-color-placeholder)',
              }}
              data-markdown-plain-fallback
            >
              文件超过 {formatSize(MAX_MARKDOWN_BYTES)}，markdown 按纯文本显示
            </p>
          )}
          {/* A172：html 拿了源码但超预览阈值时，退回源码并说明原因 */}
          {htmlOversizeFallback && (
            <p
              className="shrink-0 px-3 py-1.5 text-caption"
              style={{
                borderBottom: '1px solid var(--tc-hairline)',
                color: 'var(--td-text-color-placeholder)',
              }}
              data-html-oversize-fallback
            >
              文件超过 {formatSize(MAX_HTML_PREVIEW_BYTES)}，html 按源码显示（不做沙箱预览）
            </p>
          )}
          {showHtmlPreview ? (
            /* A172：沙箱预览。sandbox 留空 = 全部能力关闭（不给脚本、不给
               同源、不给弹窗、不给表单）；CSP 与剥 meta refresh 见
               buildSafeHtmlDocument。srcDoc 不经过网络，内容来自 /api/fs/read。 */
            <iframe
              className="min-h-0 w-full flex-1"
              style={{ border: 0, background: '#fff' }}
              title={`${entry.name} 预览`}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={buildSafeHtmlDocument(data.content ?? '')}
              data-html-preview-iframe
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="flex min-h-full">
                <pre
                  className="shrink-0 select-none py-2 pl-2 pr-2 text-right"
                  style={{ ...mono, color: 'var(--td-text-color-placeholder)' }}
                  aria-hidden
                >
                  {shown.map((_, i) => i + 1).join('\n')}
                </pre>
                <pre
                  className="min-w-0 flex-1 py-2 pl-1 pr-3"
                  style={{ ...mono, color: 'var(--td-text-color-primary)' }}
                  data-html-source-pane={isHtml ? '' : undefined}
                >
                  {shown.join('\n')}
                </pre>
              </div>
            </div>
          )}
        </div>
      ) : data.kind === 'image' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
          <img
            src={data.url}
            alt={entry.name}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        </div>
      ) : (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <FileIcon size={22} style={{ color: 'var(--td-text-color-placeholder)' }} />
          <p className="text-body" data-file-preview-blocked-reason={isHtml ? 'html-too-large' : undefined}>
            {data.kind === 'too-large'
              ? isHtml
                ? `html 文件超过 ${formatSize(MAX_HTML_PREVIEW_BYTES)}，面板内不加载（不做沙箱预览）`
                : `文件太大（${formatSize(data.size)}），面板内不预览`
              : '这是二进制文件，面板内不预览'}
          </p>
          <button
            type="button"
            onClick={onOpenExternal}
            className="rounded-md px-2 py-1 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ border: '1px solid var(--tc-hairline)', color: 'var(--td-text-color-secondary)' }}
          >
            用系统程序打开
          </button>
        </div>
      )}

      {hidden > 0 && !richMarkdown && !showHtmlPreview && (
        <p
          className="shrink-0 px-3 py-1.5 text-caption"
          style={{
            borderTop: '1px solid var(--tc-hairline)',
            color: 'var(--td-text-color-placeholder)',
          }}
        >
          只渲染前 {MAX_PREVIEW_LINES} 行（共 {lines.length} 行）—— 完整内容请用系统程序打开
        </p>
      )}
    </div>
  );
}
