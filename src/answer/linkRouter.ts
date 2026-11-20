/**
 * 外链打开方式的唯一入口（A174）。
 *
 * 两条路都要有：
 *   · `system`  —— 系统浏览器，走主进程 `shell.openExternal`（`opc:open-external`）
 *   · `in-app`  —— 应用内，塞进右侧工作区的浏览标签页（复用 WorkspaceBrowser）
 *
 * 默认 `system`。偏好读取顺序与其它界面偏好一致：注入 > localStorage > 默认
 * （见 `src/prefs.ts` 顶部注释；localStorage 只是镜像，`npm run dev` 走它）。
 *
 * 「应用内打开」是一个**跨组件意图**：链接在消息里，浏览视图在工作区面板里。
 * 这里用一个模块级的 pending + 窗口事件把两处接起来，不引入全局 store：
 *   1. `openAnswerLink(url, 'in-app')` 写 pending 并派发事件；
 *   2. App 决定面板要不要打开（窄屏 / 群聊里打不开，退回系统浏览器）；
 *   3. WorkspacePanel 挂载时或收到事件时取走 pending，切到浏览标签页并加载。
 *
 * 「先写 pending 再派发」而不是直接把 URL 塞进事件：面板当时没挂载就没人接，
 * 事件会丢；pending 让后挂载的面板在挂载那一刻还能把它捞回来。
 */
import { sanitizeHttpUrl } from './renderPlan';
import { bootPref, pushPrefs } from '../prefs';
import { hasBrowserView } from '../browserPanel';

export type LinkOpenMode = 'system' | 'in-app';

export const LINK_OPEN_MODE_KEY = 'opc.link-open-mode';
export const WORKSPACE_OPEN_URL_EVENT = 'opc:workspace-open-url';

interface OpcBridge {
  externalOpen?: (url: string) => Promise<boolean>;
}

function bridge(): OpcBridge | undefined {
  return (window as unknown as { opc?: OpcBridge }).opc;
}

export function isLinkOpenMode(v: unknown): v is LinkOpenMode {
  return v === 'system' || v === 'in-app';
}

/** 注入 > localStorage > 默认 in-app（2026-11-21 用户拍板：正文链接默认右侧工作区） */
export function readLinkOpenMode(): LinkOpenMode {
  const injected = bootPref('linkOpenMode');
  if (isLinkOpenMode(injected)) return injected;
  try {
    const saved = window.localStorage.getItem(LINK_OPEN_MODE_KEY);
    if (isLinkOpenMode(saved)) return saved;
  } catch {
    /* 隐私模式 / 存储被禁：用默认值 */
  }
  return 'in-app';
}

/** 写偏好：localStorage 镜像（dev 与既有闸门都能看到） + 服务端落盘 */
export function saveLinkOpenMode(mode: LinkOpenMode): LinkOpenMode {
  try {
    window.localStorage.setItem(LINK_OPEN_MODE_KEY, mode);
  } catch {
    /* 同 readLinkOpenMode */
  }
  pushPrefs({ linkOpenMode: mode });
  return mode;
}

/** 系统浏览器。桥不存在（浏览器里跑前端）时退化成新标签页，且必带 noopener */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  const safe = sanitizeHttpUrl(url);
  if (!safe) return false;
  const fn = bridge()?.externalOpen;
  if (fn) {
    try {
      return (await fn(safe)) === true;
    } catch {
      return false;
    }
  }
  try {
    const win = window.open(safe, '_blank', 'noopener,noreferrer');
    if (win) win.opener = null;
    return true;
  } catch {
    return false;
  }
}

/** 应用内浏览能力是否存在（事实来源在 `src/browserPanel.ts`，不在这里重复判） */
export function hasInAppBrowser(): boolean {
  return hasBrowserView();
}

let pendingUrl: string | null = null;

/** 请求在应用内打开。返回 false 表示这条链路压根不可用（URL 非法） */
export function requestOpenInWorkspace(url: string): boolean {
  const safe = sanitizeHttpUrl(url);
  if (!safe) return false;
  pendingUrl = safe;
  window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_URL_EVENT, { detail: { url: safe } }));
  return true;
}

/** 面板取走待打开的地址（取走即清空，避免重复加载） */
export function takePendingWorkspaceUrl(): string | null {
  const url = pendingUrl;
  pendingUrl = null;
  return url;
}

export function clearPendingWorkspaceUrl(): void {
  pendingUrl = null;
}

/* ── dev-server 自动预览（2026-11-21 用户拍板「回环 URL 首现即开」）──────
 *
 * Agent 起了本地 dev server（Vite/Next/…）时，回环 URL 在流式正文里首次
 * 稳定出现 → 自动在右侧工作区浏览器打开，不等用户复制粘贴。
 *
 * 边界：
 * · 只认回环（localhost / 127.0.0.1 / [::1]）—— 外网链接绝不自动打开；
 * · 同源只开一次（面板已经停在那个地址上，后续同源 URL 不重复加载）；
 * · 没有内嵌浏览视图（浏览器里跑前端）时跳过；
 * · 调用方负责「URL 稳定 1.5s」的去抖 —— 流式中的半截地址不触发。 */
const LOOPBACK_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/gi;
const autoOpenedOrigins = new Set<string>();

export function firstLoopbackUrl(text: string): string | null {
  LOOPBACK_URL_RE.lastIndex = 0;
  const m = LOOPBACK_URL_RE.exec(text);
  return m ? m[0] : null;
}

export function autoOpenLoopbackPreview(url: string): boolean {
  if (!hasInAppBrowser()) return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  if (autoOpenedOrigins.has(origin)) return false;
  if (autoOpenedOrigins.size > 20) autoOpenedOrigins.clear();
  autoOpenedOrigins.add(origin);
  return requestOpenInWorkspace(url);
}

/**
 * 按偏好打开一条正文外链。
 *
 * `in-app` 只在**确实有内嵌浏览视图**时才走应用内；否则退回系统浏览器 ——
 * 宁可开在系统里，也不要点了没反应。
 */
export function openAnswerLink(url: string, mode: LinkOpenMode = readLinkOpenMode()): Promise<boolean> {
  if (mode === 'in-app' && hasInAppBrowser() && requestOpenInWorkspace(url)) {
    return Promise.resolve(true);
  }
  return openInSystemBrowser(url);
}
