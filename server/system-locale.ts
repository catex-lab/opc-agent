/**
 * 系统界面 locale 标签（i18n pilot）。
 *
 * 为什么在服务端算：Electron 的渲染进程通过 `navigator.language` 也能拿到，
 * 但打靶脚本是用 `createServer` 直接托管 `dist/`，没有 Express 注入；那时
 * Playwright 的默认 `navigator.language` 是 `en-US`，会把既有中文闸门整体
 * 翻成英文。改由本进程（真实运行在用户机器上）算出来注入，闸门与真机就
 * 拿到同一个值。
 *
 * 取值顺序：
 *   1. `LC_ALL` / `LC_MESSAGES` / `LANG`（Linux/macOS 及部分 Windows shell）；
 *   2. Node 的 `Intl.DateTimeFormat().resolvedOptions().locale` —— Windows 上
 *      来自系统区域设置，常见 `zh-CN` / `en-US` / `ja-JP`。
 *
 * 只返回标签，不在这里做「中/英/其它」的判定 —— 判定与回落规则只有一份，
 * 在 `shared/interface-language.ts` 的 `resolveLocale()`。
 */
export function systemLocaleTag(): string {
  const raw =
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    '';
  if (raw) {
    // `zh_CN.UTF-8` → `zh-CN`
    const tag = raw.split('.')[0].replace(/_/g, '-').trim();
    if (tag) return tag;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {
    return '';
  }
}
