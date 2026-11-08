/**
 * 最小 i18n 地基（pilot）。
 *
 * ## 为什么自己写，不引 i18next / react-intl
 *
 * pilot 只需要三件事：`t(key)`、中英两份资源、语言切换后组件重渲染。
 * 第三方库会带进 plural / date / 命名空间 / 插件一套我们暂时不用的机制，
 * 而 `npx tsc -b` + `vite build` 的产物会因此多出几十 KB 与一棵依赖树。
 * 真正需要复数、相对时间、日期格式时再引，届时替换点只有这一个文件。
 *
 * ## 语言来源
 *
 *   1. 用户显式选择（`preferences.json` / localStorage）——最高优先级；
 *   2. 系统 locale —— 只在选择为 `system` 时使用。正常打包态由 Express 在
 *      `index.html` 里注入 `window.__OPC_SYSTEM_LOCALE__`（Node 的
 *      `Intl.DateTimeFormat().resolvedOptions().locale`，也就是 Windows 的
 *      区域设置）；注入缺失时，若 UA 表明确实运行在 Electron 里再退回
 *      `navigator.language`；
 *   3. 拿不到任何系统信号 —— 按「非中英」处理，回落中文。
 *
 * 第 3 条同时是浏览器开发态与静态打靶环境（`scripts/verify-*.mjs` 直接用
 * `createServer` 托管 dist，不经过 Express 注入）的稳定默认：Playwright
 * 无 `locale` 参数时 `navigator.language` 是 `en-US`，若把它当系统语言，
 * 既有中文闸门会被整体翻成英文。真正的用户入口（Electron）一定走第 2 条。
 *
 * ## 切换是否需要重启
 *
 * 不需要。`setLocale()` 改的是模块内单例并通知订阅者，四个 pilot 区域的
 * 组件通过 `useTranslation()` 订阅；`<html lang>` 同步更新。
 */
import { useSyncExternalStore } from 'react';
import { bootPref, pushPrefs } from '../prefs';
import {
  INTERFACE_LANGUAGE_DEFAULT,
  isInterfaceLanguage,
  resolveLocale,
  htmlLangOf,
  type InterfaceLanguage,
  type Locale,
} from '../../shared/interface-language';
import { zh, type MessageKey } from './zh';
import { en } from './en';

export type { InterfaceLanguage, Locale, MessageKey };

const STORAGE_KEY = 'opc.interface-language';

declare global {
  interface Window {
    /** Express 在 index.html 内联的系统 locale（见 `server/system-locale.ts`） */
    __OPC_SYSTEM_LOCALE__?: string;
  }
}

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { zh, en };

/** 读一次系统 locale 信号；拿不到返回 undefined（交给 resolveLocale 回落中文） */
function systemLocaleSignal(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const injected = window.__OPC_SYSTEM_LOCALE__;
  if (typeof injected === 'string' && injected.trim()) return injected;
  // 只有 UA 里带 `Electron/` 才信 navigator.language。不能用 `window.opc`
  // 判断：`verify-a138` / `verify-a174` 会在 `addInitScript` 里伪造这个对象，
  // 而 Playwright 的默认 navigator.language 是 en-US，会把闸门整体翻成英文。
  if (
    typeof navigator !== 'undefined' &&
    /Electron\//.test(navigator.userAgent) &&
    navigator.language
  ) {
    return navigator.language;
  }
  return undefined;
}

/**
 * 本次页面生命周期内的显式选择。
 *
 * 注入值在页面生命周期内不变（服务端只在返回 index.html 时写一次）；
 * 用户刚在设置页切了语言、又关掉再打开设置页时，`readInterfaceLanguage()`
 * 若只读注入值会拿到切换前的旧值，选项高亮就回跳。这里用内存变量压过注入，
 * 刷新页面后由服务端注入的新值接管。
 */
let sessionChoice: InterfaceLanguage | null = null;

/** 用户显式选择（本次会话 > 注入 > localStorage > 默认 `system`） */
export function readInterfaceLanguage(): InterfaceLanguage {
  if (typeof window === 'undefined') return INTERFACE_LANGUAGE_DEFAULT;
  if (sessionChoice) return sessionChoice;
  const injected = bootPref('interfaceLanguage');
  if (isInterfaceLanguage(injected)) return injected;
  const raw = localStorage.getItem(STORAGE_KEY);
  return isInterfaceLanguage(raw) ? raw : INTERFACE_LANGUAGE_DEFAULT;
}

let current: Locale = resolveLocale(
  readInterfaceLanguage(),
  systemLocaleSignal()
);

const listeners = new Set<() => void>();

function applyHtmlLang(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = htmlLangOf(locale);
}

function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  applyHtmlLang(next);
  for (const fn of listeners) fn();
}

/**
 * 首帧前调用一次：把注入/localStorage 解析出的语言写进 `<html lang>`。
 *
 * `main.tsx` 在 `createRoot` 之前调用；即使漏掉，组件首次 `t()` 也会按
 * `current` 渲染，只是 `<html lang>` 会晚一点更新（影响 `hyphens` 与读屏）。
 */
export function initI18n(): Locale {
  applyHtmlLang(current);
  return current;
}

export function getLocale(): Locale {
  return current;
}

export function getInterfaceLanguage(): InterfaceLanguage {
  return readInterfaceLanguage();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 切换界面语言并持久化。
 *
 * 选 `system` 时按当前系统信号重新解析；系统信号在页面生命周期内不变，
 * 所以不需要监听 `languagechange`（Electron 跟随系统变化需要重启才生效，
 * 这一点在设置页的说明里不承诺实时切换）。
 */
export function saveInterfaceLanguage(language: InterfaceLanguage): InterfaceLanguage {
  sessionChoice = language;
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, language);
  }
  pushPrefs({ interfaceLanguage: language });
  setLocale(resolveLocale(language, systemLocaleSignal()));
  return language;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined ? whole : String(v);
  });
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 当前语言的文案。函数本身稳定，语言变化由 `useTranslation()` 的订阅驱动重渲染 */
export const t: Translate = (key, vars) => {
  const table = MESSAGES[current];
  return interpolate(table[key] ?? zh[key] ?? key, vars);
};

/** 组件入口：返回 `t` 与当前 locale，并在语言切换时触发重渲染 */
export function useTranslation(): { t: Translate; locale: Locale } {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return { t, locale };
}
