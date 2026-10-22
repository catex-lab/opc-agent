import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Globe,
  RotateCw,
} from 'lucide-react';
import {
  getCdpInfo,
  getNavState,
  goBack,
  goForward,
  hasBrowserView,
  loadUrl,
  openDevTools,
  reload,
  reportRect,
  setBrowserVisible,
  subscribeNavState,
  type BrowserNavState,
  type CdpInfo,
} from '../browserPanel';
import { isOverlayVisible, subscribeOverlay } from '../overlayGuard';

/**
 * P2：工作区面板的「浏览器」标签。
 *
 * ## 这块没有 Web 等价物
 *
 * 文件面板在浏览器开发态还能退化成「复制路径」，这个不行：它就是一个
 * `WebContentsView`，跑在 Electron 主进程里。所以 `hasBrowserView()`
 * 为 false 时**直接说明白**，不摆一个输了地址没反应的地址栏。
 *
 * ## 两个必须做对的时序
 *
 * 1. **矩形先于可见性**（或反过来）都要能工作。渲染进程的两个 effect 与
 *    异步 IPC 都不保证顺序，主进程的 `setBounds` 因此依据 `wantVisible`
 *    而不是 `visible` 应用 bounds。
 * 2. **卸载 / 切走时必须隐藏**。原生视图盖在 DOM 之上，不隐藏的话文件树
 *    会被一张网页糊住。
 *
 * ## 浮层一来就整体隐藏
 *
 * 见 `overlayGuard.ts`：任何浮层可见时把视图藏起来。预览闪一下不见，
 * 比「菜单被网页盖住、用户以为点了没反应」好得多。
 *
 * ## 刷新 / 重启之后URL 去哪了
 *
 * 分两种情况，处理方式不同：
 *   · **渲染进程刷新**（F5 / 视图热更新）：视图是主进程的对象，根本没被
 *     重建，URL 还在。所以首屏只要 `getNavState()` 拉一次就恢复了。
 *   · **应用重启**：视图重新建出来，是空的 about:blank。这时候才需要
 *     localStorage 里那份「上次的 URL」兜底 —— 否则每次开应用都看到一张白板。
 * 只有在主进程确实没有 URL 时才去读兜底，避免把用户已经手动清空的状态
 * 又给加载回来。
 */

const EMPTY: BrowserNavState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

/** 上次预览的 URL。布局/会话偏好，不是业务数据 —— 所以放 localStorage。 */
const LAST_URL_KEY = 'opc.workspace-last-url';

/** 只收 http/https：localStorage 是可以被别的脚本改的，恢复时不能当信任输入。 */
function isRestorableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function readLastUrl(): string | null {
  try {
    const saved = localStorage.getItem(LAST_URL_KEY);
    return saved && isRestorableUrl(saved) ? saved : null;
  } catch {
    return null;
  }
}

function saveLastUrl(url: string): void {
  try {
    localStorage.setItem(LAST_URL_KEY, url);
  } catch {
    /* 隐私模式：写不进去只影响下次启动的兜底 */
  }
}

export function WorkspaceBrowser() {
  const available = hasBrowserView();
  const [nav, setNav] = useState<BrowserNavState>(EMPTY);
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [cdp, setCdp] = useState<CdpInfo | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // 导航状态由主进程推送（URL / 标题 / 前进后退 / 加载中）
  useEffect(() => subscribeNavState(setNav), []);

  // P3：人机同屏状态。只拉一次 —— 端口是启动时定下的，运行期不变
  useEffect(() => {
    void getCdpInfo().then(setCdp);
  }, []);

  // 首屏拉一次：推送只覆盖「订阅之后」的变化
  useEffect(() => {
    let cancelled = false;
    void getNavState().then(state => {
      if (cancelled) return;
      if (state) setNav(state);
      const current = state?.url ?? '';
      if (current && current !== 'about:blank') {
        saveLastUrl(current);
        return;
      }
      // 主进程那边是空的：应用刚启动（或视图刚重建），用上次的 URL 兜底
      const saved = readLastUrl();
      if (saved) void loadUrl(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // URL 变了就记下来：下次启动靠它恢复
  useEffect(() => {
    if (nav.url && nav.url !== 'about:blank') saveLastUrl(nav.url);
  }, [nav.url]);

  // 地址栏跟随真实 URL，但用户正在输入时不抢
  useEffect(() => {
    if (!editing) setInput(nav.url);
  }, [nav.url, editing]);

  /**
   * 上报视口矩形。三个触发源缺一不可：
   *   · ResizeObserver —— 面板自身尺寸变化；
   *   · window resize —— 窗口变化会改变面板位置与尺寸；
   *   · 挂载时一次 —— 首次出现。
   * 侧栏拖拽只改左边各栏宽度，面板右边界不动、矩形不变，所以不必监听它；
   * 但窗口缩放会同时改 x 与 width，必须覆盖。
   */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let raf = 0;
    const report = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        reportRect({ x: r.x, y: r.y, width: r.width, height: r.height });
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [available]);

  // 可见性：挂载即显示；浮层一出现就藏起来；卸载一定藏。
  useEffect(() => {
    const apply = () => setBrowserVisible(!isOverlayVisible());
    apply();
    const unsubscribe = subscribeOverlay(apply);
    return () => {
      unsubscribe();
      setBrowserVisible(false);
    };
  }, [available]);

  // 提示条自己消失
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const submitAddress = async () => {
    const ok = await loadUrl(input);
    if (!ok) setNotice('只支持 http/https 地址');
  };

  if (!available) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        style={{ color: 'var(--td-text-color-secondary)' }}
      >
        <Globe size={22} style={{ color: 'var(--td-text-color-placeholder)' }} />
        <p className="text-body">浏览器预览只在桌面端可用</p>
        <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          它由 Electron 的 WebContentsView 承载，浏览器里没有等价物
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div
        className="flex h-9 shrink-0 items-center gap-1 px-2"
        style={{ borderBottom: '1px solid var(--tc-hairline)' }}
      >
        <button
          type="button"
          onClick={() => void goBack()}
          disabled={!nav.canGoBack}
          title="后退"
          aria-label="后退"
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-40"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          onClick={() => void goForward()}
          disabled={!nav.canGoForward}
          title="前进"
          aria-label="前进"
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-40"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          title="刷新"
          aria-label="刷新"
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <RotateCw size={13} className={nav.loading ? 'animate-spin' : undefined} />
        </button>

        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            setInput(nav.url);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
              void submitAddress();
            }
            if (e.key === 'Escape') {
              e.currentTarget.blur();
            }
          }}
          placeholder="http://localhost:5173"
          aria-label="预览地址"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md px-2 py-1 text-caption outline-none"
          style={{
            backgroundColor: 'var(--tc-hover-chrome)',
            color: 'var(--td-text-color-primary)',
            fontFamily: 'var(--font-mono)',
          }}
        />

        <button
          type="button"
          onClick={() => void openDevTools()}
          title="打开开发者工具（分离窗口）"
          aria-label="打开开发者工具"
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <Bug size={13} />
        </button>
      </div>

      {notice && (
        <div
          className="shrink-0 px-3 py-1.5 text-caption"
          style={{ color: 'var(--td-text-color-secondary)', backgroundColor: 'var(--tc-hover-chrome)' }}
        >
          {notice}
        </div>
      )}

      {/*
        视口容器：**原生视图盖在这个盒子上**。它必须有确定的背景与尺寸，
        否则网页还没加载时会看到后面的聊天内容透出来。
        不要给它加圆角/阴影 —— 原生层不吃这些样式，加了只会让边界对不上。
      */}
      <div
        ref={viewportRef}
        className="min-h-0 flex-1"
        style={{ backgroundColor: '#ffffff' }}
        data-browser-viewport
      />

      <div
        className="flex h-7 shrink-0 items-center gap-1.5 px-2.5 text-caption"
        style={{
          borderTop: '1px solid var(--tc-hairline)',
          color: 'var(--td-text-color-placeholder)',
        }}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: nav.loading ? '#EF9F27' : '#1D9E75' }}
        />
        <span className="truncate">{nav.title || nav.url || '未加载'}</span>
        {/*
          P3：人机同屏状态。这一行必须让用户看见 —— 「Agent 能不能连上这个面板」
          不该是只存在于文档里的约定。不给 ws 端点：那对用户没有可操作性，
          而且端点本来是该交给 Agent 的东西（data/cdp.json / OPC_CDP_TARGET）。
        */}
        {cdp && (
          <span
            className="ml-auto shrink-0"
            title={
              cdp.enabled
                ? cdp.hasTarget
                  ? '远程调试端口已开放：Agent 可用 connectOverCDP 附着到同一个页面'
                  : '端口已开放，但还没认出不预览视图的 target（页面加载后即可）'
                : '远程调试端口已关闭（OPC_CDP=0）：Agent 连不上这个面板'
            }
          >
            {cdp.enabled ? `CDP :${cdp.port}` : 'CDP 关'}
          </span>
        )}
        <span className={cdp ? 'shrink-0' : 'ml-auto shrink-0'}>本地预览</span>
      </div>
    </div>
  );
}
