/**
 * P2：浏览器预览视图的前端共享件。
 *
 * ## 为什么单独一个文件
 *
 * 与 `workspace.ts` 同一个理由：这颗桥会被多个组件用（面板里的浏览器标签、
 * 以及以后任何想驱动预览的地方）。各写一份 `window.opc?.browserLoad(...)`
 * 就会出现多份签名，改一次 preload 要同步改多处，漏一处就是「打包态点了
 * 没反应」—— 而那在浏览器开发态看不出来。
 *
 * ## 浏览器开发态
 *
 * `window.opc` 整个是 undefined。此时：
 *   · `hasBrowserView()` 返回 false，调用方据此显示「需要桌面端」而不是
 *     摆一个点了没反应的地址栏（假控件）；
 *   · 其余函数全部静默返回，不抛不错。
 *
 * 也就是说：**P2 的功能在浏览器开发态不可用**，这一点必须在界面上说出来。
 * 它和 P1 的文件面板不同 —— 文件面板退化成「复制路径」仍然有用，
 * 而浏览器视图没有任何 Web 等价物。
 */

export interface BrowserNavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

interface OpcBridge {
  browserRect?(rect: { x: number; y: number; width: number; height: number }): void;
  browserVisible?(visible: boolean): void;
  browserLoad?(url: string): Promise<boolean>;
  browserBack?(): Promise<void>;
  browserForward?(): Promise<void>;
  browserReload?(): Promise<void>;
  browserDevtools?(): Promise<void>;
  browserState?(): Promise<BrowserNavState>;
  onBrowserState?(cb: (state: BrowserNavState) => void): () => void;
}

function bridge(): OpcBridge | undefined {
  return (window as unknown as { opc?: OpcBridge }).opc;
}

/** 当前环境有没有浏览器预览视图（即是否跑在 Electron 里）。 */
export function hasBrowserView(): boolean {
  return typeof bridge()?.browserLoad === 'function';
}

/**
 * 上报视口矩形。
 *
 * 传 CSS 像素、相对窗口内容区（`getBoundingClientRect()` 的坐标系）。
 * 主进程把它当 DIP 用 —— 二者在 zoomFactor = 1 时一致；真有非 1 的缩放时
 * 由主进程统一处理，渲染进程不做乘法，避免两边各算一遍。
 */
export function reportRect(rect: { x: number; y: number; width: number; height: number }): void {
  try {
    bridge()?.browserRect?.(rect);
  } catch {
    /* 视图还没建：主进程会记下最后一次的矩形，建好那一刻对上 */
  }
}

export function setBrowserVisible(visible: boolean): void {
  try {
    bridge()?.browserVisible?.(visible);
  } catch {
    /* 同上 */
  }
}

/** @returns false = 协议不在白名单（只放行 http/https）或环境不支持 */
export async function loadUrl(url: string): Promise<boolean> {
  const fn = bridge()?.browserLoad;
  if (!fn) return false;
  try {
    return (await fn(url)) === true;
  } catch {
    return false;
  }
}

export async function goBack(): Promise<void> {
  try {
    await bridge()?.browserBack?.();
  } catch {
    /* 无历史可退：主进程自己判 canGoBack，这里不重复判 */
  }
}

export async function goForward(): Promise<void> {
  try {
    await bridge()?.browserForward?.();
  } catch {
    /* 同上 */
  }
}

export async function reload(): Promise<void> {
  try {
    await bridge()?.browserReload?.();
  } catch {
    /* 视图未就绪 */
  }
}

export async function openDevTools(): Promise<void> {
  try {
    await bridge()?.browserDevtools?.();
  } catch {
    /* 视图未就绪 */
  }
}

export async function getNavState(): Promise<BrowserNavState | null> {
  const fn = bridge()?.browserState;
  if (!fn) return null;
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

/** 订阅导航状态。返回取消订阅函数（React effect 清理用）。 */
export function subscribeNavState(cb: (state: BrowserNavState) => void): () => void {
  const fn = bridge()?.onBrowserState;
  if (!fn) return () => {};
  try {
    return fn(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}
