/**
 * P2：右侧工作区面板的「浏览器」标签 —— 用 `WebContentsView` 承载。
 *
 * ## 为什么是 WebContentsView，不是 BrowserView / webview / iframe
 *
 * - `BrowserView` 自 Electron 30 起**已废弃**，官方让位给 `WebContentsView`。
 * - `<webview>` 与 `<iframe>` 都跑在渲染进程里：iframe 被 X-Frame-Options 挡，
 *   且拿不到 DevTools 与逐事件导航状态；`<webview>` 则要给渲染进程开
 *   `webviewTag`，等于把一整颗浏览器实例的创建权交给页面。
 * - `WebContentsView` 挂在我们自己的 `contentView` 上，生命周期、bounds、
 *   可见性全部由主进程说了算 —— 渲染进程只能「请求」，不能「操作」。
 *
 * ## 三条安全默认值，一条都不能少
 *
 * 1. **独立 session 分区**（`persist:browser`）：cookie / 缓存 / 登录态与应用
 *    主 session 隔离。不隔离的话，用户在这个预览里登录的站点会和应用本身
 *    共享凭据，也会和 Agent 用的后端 session 混在一起。
 * 2. **不给 preload、`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`**：
 *    这个视图里跑的是**任意远程页面**，它拿不到我们那套 IPC 桥。
 * 3. **权限一律拒绝**（摄像头 / 麦克风 / 定位 / 通知 / 剪贴板读），
 *    新窗口一律 deny 并转系统浏览器。预览本地 dev server 不需要这些。
 *
 * ## 定位写死为「本地预览 + 调试」，不做通用浏览器
 *
 * Electron 的 UA 带 `Electron/44`，Google 登录、部分支付、Cloudflare 校验会
 * 直接拒绝。改 UA 冒充 Chrome 属于规避检测，有 ToS 风险且随时失效。
 * 所以这里只放行 http/https，其余协议一律不加载（见 `ALLOWED_PROTOCOLS`）。
 *
 * ## bounds 与可见性为什么必须一起设
 *
 * 原生视图**永远盖在 DOM 之上**。先 `setVisible(true)` 再 `setBounds()` 会闪一帧
 * 「全窗口的网页」，所以顺序固定为：设 bounds → 再显示。同理，切到别的标签
 * 必须 `setVisible(false)`，否则文件树会被它盖住。
 */

import { BrowserWindow, WebContentsView, app, session, shell } from 'electron';
import type { Rectangle } from 'electron';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { refreshCdpDescriptor } from './cdp.js';

/** 预览视图的 session 分区名。改名字等于丢掉用户已存的站点登录态。 */
export const BROWSER_PARTITION = 'persist:browser';

/** 只放行这两种协议。`file:` 不放行 —— 预览本地文件用系统打开更合适。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface BrowserNavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

const EMPTY_STATE: BrowserNavState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

/** 把用户输入 / 后端返回的字符串收敛成一个可加载的 URL。不合法返回 null。 */
export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  // 没写协议的按 https 补：用户在地址栏敲的是 localhost:5173 这种形式
  const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
}

export class BrowserPanel {
  private view: WebContentsView | null = null;
  private win: BrowserWindow | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  /** 渲染进程可见性意图：视图还没建出来时也要记住，建好那一刻就要对上 */
  private wantVisible = false;
  private lastState: BrowserNavState = { ...EMPTY_STATE };

  /** 绑定宿主窗口。窗口重建（macOS Dock 重新打开）时也要重新绑一次。 */
  attach(win: BrowserWindow): void {
    if (this.win === win) return;
    this.detach();
    this.win = win;
    // 窗口关闭时视图必须跟着销毁：它是一个持有登录态与网络能力的活对象，
    // 留着就是「应用关了还在跑」。
    win.on('closed', () => this.destroy());
  }

  detach(): void {
    if (!this.win) return;
    this.win = null;
    this.destroy();
  }

  private ensureView(): WebContentsView | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    if (!this.win || this.win.isDestroyed()) return null;

    const view = new WebContentsView({
      webPreferences: {
        // 独立分区：与主 session 的 cookie / 缓存 / 登录态隔离
        session: session.fromPartition(BROWSER_PARTITION),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // 不给 preload：这个视图里跑的是任意远程页面
      },
    });

    const wc = view.webContents;

    // 新窗口一律 deny，http(s) 转交系统浏览器。
    // 不转交的话，站点里点一个 target=_blank 的链接会**完全没有反应**。
    wc.setWindowOpenHandler(({ url }) => {
      if (normalizeBrowserUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    // 权限请求一律拒绝。返回 false = 拒绝且不再询问。
    // 预览本地页面用不到摄像头/定位；真需要时用户可以在系统浏览器里做。
    wc.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);

    // 顶层导航只允许 http/https。站点内的跳转大多会走这里，
    // 放行 file: / javascript: 之类等于给预览视图开一条不该有的路。
    wc.on('will-navigate', (event, url) => {
      if (!normalizeBrowserUrl(url)) event.preventDefault();
    });

    const push = () => this.pushState();
    wc.on('did-navigate', () => {
      push();
      // P3：导航换了 target 的 URL，Agent 手里的 ws 端点要跟着更新
      void refreshCdpDescriptor(wc.getURL());
    });
    wc.on('did-navigate-in-page', () => {
      push();
      void refreshCdpDescriptor(wc.getURL());
    });
    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);
    wc.on('page-title-updated', push);
    wc.on('render-process-gone', (_e, details) => {
      console.error('[Browser] 渲染进程退出:', details.reason);
      this.pushState();
    });

    this.view = view;
    this.win.contentView.addChildView(view);
    // 新建出来的视图默认是可见的（但 bounds 是 0），必须先藏起来等 bounds
    view.setVisible(false);
    // P3：视图一建出来就把它的 target 解析给 Agent —— 这时还是 about:blank，
    // 靠「排除应用自己的窗口」认；导航之后 did-navigate 会再刷一次。
    void refreshCdpDescriptor(view.webContents.getURL());
    return view;
  }

  /** 渲染进程报上来的矩形（CSS 像素，相对窗口内容区）。 */
  setBounds(rect: Rectangle): void {
    // 0 宽/高 = 面板当前没渲染（切走了或收起了）。记下来但不应用：
    // 应用一个 0 尺寸的 bounds 会让视图在下一次显示时闪一下。
    const clean: Rectangle = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    const same =
      this.bounds.x === clean.x &&
      this.bounds.y === clean.y &&
      this.bounds.width === clean.width &&
      this.bounds.height === clean.height;
    this.bounds = clean;
    if (same) return;
    // 依据 `wantVisible` 而不是 `visible`：渲染进程可能先报矩形后报可见
    // （React 的两个 effect 顺序 + 异步 IPC），那时视图还没显示过。
    // 只认 visible 的话，这个顺序下视图永远不会被显示出来。
    if (this.view && this.wantVisible && clean.width > 0 && clean.height > 0) {
      this.view.setBounds(clean);
      this.view.setVisible(true);
      this.visible = true;
    }
  }

  setVisible(next: boolean): void {
    this.wantVisible = next;
    if (!next) {
      if (this.view) this.view.setVisible(false);
      this.visible = false;
      return;
    }
    const view = this.ensureView();
    if (!view) return;
    // 顺序很重要：先 bounds 再显示，否则会闪一帧全窗口网页
    if (this.bounds.width > 0 && this.bounds.height > 0) {
      view.setBounds(this.bounds);
      view.setVisible(true);
      this.visible = true;
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** 加载一个 URL。返回 false = 输入不合法（协议不在白名单）。 */
  load(input: string): boolean {
    const url = normalizeBrowserUrl(input);
    if (!url) return false;
    const view = this.ensureView();
    if (!view) return false;
    void view.webContents.loadURL(url);
    return true;
  }

  goBack(): void {
    if (this.view?.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    if (this.view?.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  /** DevTools 用分离窗口：right 模式会和右侧面板抢同一块位置。 */
  openDevTools(): void {
    this.view?.webContents.openDevTools({ mode: 'detach' });
  }

  getState(): BrowserNavState {
    if (!this.view || this.view.webContents.isDestroyed()) return { ...EMPTY_STATE };
    const wc = this.view.webContents;
    const next: BrowserNavState = {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
    };
    this.lastState = next;
    return next;
  }

  private pushState(): void {
    const state = this.getState();
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('opc:browser-state', state);
  }

  /** 彻底销毁：从窗口摘下 + 关掉 webContents。 */
  destroy(): void {
    const view = this.view;
    this.view = null;
    this.visible = false;
    if (!view) return;
    try {
      if (this.win && !this.win.isDestroyed()) {
        this.win.contentView.removeChildView(view);
      }
    } catch {
      /* 窗口已经没了：摘下会抛，那时视图也跟着没了，不用管 */
    }
    try {
      view.webContents.close();
    } catch {
      /* 已经关闭 */
    }
  }
}

export const browserPanel = new BrowserPanel();

/* ── 冒烟探针 ───────────────────────────────────────────────────────────
 *
 * `verify:render` 跑在普通 Chrome 里，`window.opc` 整个不存在 —— 也就是说
 * **P2 的浏览器视图没法用那套 harness 验证**。这里给验证脚本一条真的路：
 * 起一个只创建浏览器视图的最小 Electron 实例，加载一个本地 http 页面，
 * 再把「视图到底渲染出来了没有、session 分对没有、页面里有没有 Node」读回来。
 *
 * 用本地 http 而不是 `data:` URL：`load()` 只放行 http/https，冒烟必须走
 * 和用户完全相同的代码路径，否则测的是一个特例。
 */

/** 探针页：一个可被 executeJavaScript 读出来的、唯一的背景色。 */
const PROBE_HTML = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#0F6E56;color:#fff;font:13px sans-serif">
<div id="probe">opc-browser-probe</div>
<script>window.__PROBE__ = document.getElementById('probe').textContent;</script>
</body>`;

/** 读回视图的真实状态。仅供验证脚本调用，正常路径不用它。 */
async function smokeProbe(panel: BrowserPanel): Promise<Record<string, unknown> | null> {
  const view = (panel as unknown as { view: WebContentsView | null }).view;
  if (!view || view.webContents.isDestroyed()) return null;
  const wc = view.webContents;
  const background = (await wc.executeJavaScript(
    "getComputedStyle(document.body).backgroundColor"
  )) as string;
  const probeText = (await wc.executeJavaScript('window.__PROBE__')) as string;
  return {
    url: wc.getURL(),
    background,
    probeText,
    // 页面里不该有 Node：这是「不给 preload + sandbox」的直接证据
    nodeInPage: (await wc.executeJavaScript('typeof require')) as string,
    requireInPage: (await wc.executeJavaScript('typeof process')) as string,
    partitionOk: wc.session === session.fromPartition(BROWSER_PARTITION),
  };
}

export async function runBrowserSmoke(outPath: string): Promise<void> {
  const report: Record<string, unknown> = { ok: false };
  let win: BrowserWindow | null = null;
  let server: ReturnType<typeof createServer> | null = null;

  try {
    // 本地 http 服务：探针页与真实预览走同一条加载路径
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PROBE_HTML);
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    // 不预加载 about:blank：本机实测那一步会 ERR_FAILED(-2)（原因未查明，
    // 但与预览视图无关），而视图本来就会自己建 webContents，不需要宿主窗口
    // 先有内容。真正要验的是「视图能不能渲染」，所以直接建视图、加载探针页。
    win = new BrowserWindow({ width: 960, height: 640, show: true });

    const panel = new BrowserPanel();
    panel.attach(win);
    // 与正常路径同一顺序：先 bounds 再显示
    panel.setBounds({ x: 320, y: 80, width: 520, height: 420 });
    panel.setVisible(true);

    const accepted = panel.load(`http://127.0.0.1:${port}/`);
    report.urlAccepted = accepted;
    report.visible = panel.isVisible();

    // 等 did-stop-loading：给足冷启动时间，不用固定 sleep 猜
    await new Promise<void>(resolve => {
      const done = () => resolve();
      const timer = setTimeout(done, 8000);
      panel['view']?.webContents.once('did-stop-loading', () => {
        clearTimeout(timer);
        done();
      });
    });

    const probe = await smokeProbe(panel);
    report.probe = probe;
    report.ok =
      accepted === true &&
      probe?.probeText === 'opc-browser-probe' &&
      probe?.background === 'rgb(15, 110, 86)' &&
      probe?.nodeInPage === 'undefined' &&
      probe?.partitionOk === true;
  } catch (e) {
    report.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  } finally {
    try {
      server?.close();
    } catch {
      /* 已关 */
    }
    try {
      win?.destroy();
    } catch {
      /* 已关 */
    }
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    app.quit();
  }
}
