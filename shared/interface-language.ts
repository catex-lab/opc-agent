/**
 * 界面语言（i18n）的语义定义。
 *
 * ## 为什么只有三档
 *
 * 用户能选的是「跟随系统 / 中文 / 英文」；真正落地的界面语言只有中文、英文两种。
 * `system` 不是第三种语言，而是「把决定权交给系统」——它必须在启动时解析成一个
 * 确定的 `Locale`，之后所有组件读到的都是解析结果。
 *
 * ## 回落口径
 *
 * 系统 locale 既不是中文也不是英文时**回落中文**（产品的主要用户群与既有文案
 * 都是中文，回落英文会让老用户突然看到半套英文界面）。注意这里只看**首选**
 * locale，不看 `navigator.languages` 的备选链：一台日语系统即使备选里有 `en-US`，
 * 也应按「非中英」处理，而不是被备选里的英文截走。
 */

/** 用户可选的界面语言（持久化值） */
export type InterfaceLanguage = 'system' | 'zh' | 'en';

/** 解析后的实际界面语言（资源文件按它选） */
export type Locale = 'zh' | 'en';

export const INTERFACE_LANGUAGE_DEFAULT: InterfaceLanguage = 'system';

export function isInterfaceLanguage(v: unknown): v is InterfaceLanguage {
  return v === 'system' || v === 'zh' || v === 'en';
}

/**
 * 把「用户选择 + 系统 locale 标签」解析成实际界面语言。
 *
 * `systemLocale` 允许传空（拿不到系统信号）：按「非中英」处理，回落中文 ——
 * 这同时也是浏览器开发态与静态打靶环境的稳定默认，避免 Playwright 的
 * 默认 `en-US` 把既有中文闸门全部翻成英文。
 */
export function resolveLocale(
  language: InterfaceLanguage | undefined,
  systemLocale: string | undefined | null
): Locale {
  if (language === 'zh' || language === 'en') return language;
  const tag = (systemLocale ?? '').trim().toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('en')) return 'en';
  return 'zh';
}

/** `<html lang>` 用完整标签，读屏与 `hyphens` 都依赖它 */
export function htmlLangOf(locale: Locale): string {
  return locale === 'en' ? 'en' : 'zh-CN';
}
