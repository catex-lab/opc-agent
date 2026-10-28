/**
 * 界面偏好的前端入口（A135）。
 *
 * ## 读取顺序：注入 > localStorage > 默认
 *
 * 服务端在返回 `index.html` 时把整份偏好内联成 `window.__OPC_PREFS__`
 * （`server/preferences.ts` 的 `prefsAsInlineScript`）。它是**同步可读**的，
 * 所以 `main.tsx` 能在 `createRoot` 之前把透明度、栏宽写到 `<html>` 上，
 * 首帧就是用户上次的样子，不会先闪一下默认值。
 *
 * 另外两层是兜底，不是主路径：
 *   · localStorage —— `npm run dev`（Vite 托管前端，拿不到注入）走这条；
 *     七条既有闸门（a25 / a28 / a35 / a37 / overlay / qq-ui / surface）
 *     断言的就是它，所以写操作必须继续镜像过去。
 *   · 默认值 —— 没设过的人（也是绝大多数）。
 *
 * ## 为什么写入要防抖
 *
 * 透明度和栏宽是**拖动**出来的：一次拖动会触发几十次 `input` 事件。
 * 每次都发一个 PATCH，服务端就要重写几十次 JSON 文件。250ms 的静默期
 * 足够把一次拖动收成一个请求，用户松手之后最多四分之一秒落盘。
 *
 * ## 为什么失败只 warn 一次
 *
 * 打靶脚本会把 `**\/api/**` 全量拦成夹具，这个 PATCH 必然失败 —— 那不是
 * 产品缺陷。每次都打日志会刷屏，而且多条闸门在数「控制台错误」。所以：
 * 只提示一次，且用 warn 而不是 error。
 */
import type { GlowPrefs } from './uiPrefs';

/** 与 `server/preferences.ts` 的 `Prefs` 一一对应（那边是事实来源） */
export interface Prefs {
  theme?: 'system' | 'light' | 'dark';
  transparency?: number;
  sidebarWidth?: number;
  workspaceWidth?: number;
  workspaceOpen?: boolean;
  glow?: GlowPrefs;
  defaultModel?: string;
}

export type PrefsPatch = { [K in keyof Prefs]?: Prefs[K] | null };

declare global {
  interface Window {
    __OPC_PREFS__?: Partial<Prefs>;
  }
}

/**
 * 读一次注入值并缓存。
 *
 * 缓存是必要的：`applyUiPrefs()` 里要读四五次，每次都解一遍
 * `window.__OPC_PREFS__` 没有意义；而这个值在页面生命周期内不会变
 * （改了偏好是写服务端 + 直接改 DOM，不需要重新读注入）。
 */
let booted: Partial<Prefs> | null = null;

function boot(): Partial<Prefs> {
  if (booted) return booted;
  // 浏览器侧模块可能被 tsx 脱机脚本间接加载 —— Node 里 `window` 是
  // ReferenceError 而不是 undefined（A132 的教训）。
  if (typeof window === 'undefined') {
    booted = {};
    return booted;
  }
  const raw = window.__OPC_PREFS__;
  booted = raw && typeof raw === 'object' ? raw : {};
  return booted;
}

/** 读一项注入的偏好。没注入 / 没设过都返回 undefined */
export function bootPref<K extends keyof Prefs>(key: K): Prefs[K] | undefined {
  const v = boot()[key];
  return v === undefined || v === null ? undefined : v;
}

let warned = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: PrefsPatch = {};

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const body = pending;
  pending = {};
  if (!Object.keys(body).length) return;
  // keepalive：`pagehide` 时（用户关窗口）请求还在飞，不设这个会被取消，
  // 表现就是「最后一次拖动没存上」。
  void fetch('/api/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch((e: unknown) => {
    if (warned) return;
    warned = true;
    // 打靶脚本拦截 /api 时这里必然失败，属预期；真机上则意味着偏好存不住。
    console.warn('[Prefs] 偏好同步到服务端失败（本次界面仍已生效）:', e);
  });
}

/**
 * 把一个补丁送到服务端（防抖 250ms）。
 *
 * 调用方**不需要** await：界面上的效果由各自的 `apply*()` 同步完成，
 * 这里只负责「下次启动还认得」。存不进去不该阻塞任何交互。
 */
export function pushPrefs(patch: PrefsPatch): void {
  pending = { ...pending, ...patch };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 250);
}

// 关窗口/切后台时把还没发出去的补丁发掉。`pagehide` 比 `beforeunload`
// 可靠：后者在移动端和 bfcache 场景里可能根本不触发。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  // 开发态热更新会把模块重新求值，不撤掉监听会越积越多
  if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('pagehide', flush));
}
