import { useState, useEffect, useCallback, useMemo } from 'react';
import { Theme, ThemePreference } from '../types';

const STORAGE_KEY = 'theme';
const MEDIA = '(prefers-color-scheme: dark)';

/**
 * 把主题偏好同步给 Electron 主进程。
 *
 * **这一步不是可选的**。界面的深浅色由 CSS 变量驱动，但 Windows 的
 * **原生标题栏**不由 CSS 画 —— 它由操作系统绘制，颜色取自
 * `nativeTheme.themeSource`。不通知主进程的话：
 *   用户在设置里固定「深色」+ Windows 是浅色
 *   → 窗口顶部原生标题栏是浅色，下面整块界面是深色
 *   → 一条白带压在黑界面上
 *
 * 用可选调用 `window.opc?.`：浏览器开发态没有这个桥，调用被跳过，
 * 行为与以前完全一致（那时也没有原生标题栏可管）。
 */
function syncNativeTheme(mode: ThemePreference) {
  (window as unknown as { opc?: { setTheme(m: ThemePreference): void } }).opc?.setTheme(mode);
}

/** 旧版本只存过 'light' / 'dark'，读出来仍然是合法的偏好值 */
function readPreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

/**
 * 主题。
 *
 * ## 为什么要有「偏好」和「解析结果」两个值
 *
 * `preference` 是用户的选择（跟随系统 / 浅色 / 深色），`theme` 是最终落到
 * DOM 上的那一个（只会是 light 或 dark）。两者不能合并成一个字段：
 * 用户选了「跟随系统」时，系统切到深色，`preference` 不变而 `theme` 要变。
 * 只存一个值的话，要么丢掉「跟随系统」这个意图，要么得在切系统时改写
 * 用户的选择 —— 后者会让用户下次手动选浅色时莫名回不到浅色。
 *
 * ## 默认跟随系统
 *
 * 原先的逻辑是「首次按系统判断，然后立刻写进 localStorage」—— 于是
 * 「跟随系统」只生效一次：第一次运行是什么，之后就永远是什么，系统
 * 再切也不跟。现在没存过偏好就一直是 'system'，不写死成具体值。
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState<boolean>(
    () => window.matchMedia(MEDIA).matches
  );

  // 监听系统主题。无论当前偏好是什么都要监听 —— 用户随时可能切回「跟随系统」，
  // 那时需要立刻拿到最新的系统状态，而不是启动时缓存的旧值。
  useEffect(() => {
    const mq = window.matchMedia(MEDIA);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme: Theme = useMemo(() => {
    if (preference === 'system') return systemDark ? 'dark' : 'light';
    return preference;
  }, [preference, systemDark]);

  // 应用主题到 DOM
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    // 让原生控件（滚动条、日期选择器、表单自动填充底色）也跟着走，
    // 否则深色界面里会冒出浅色的原生滚动条。
    root.style.colorScheme = theme;
    // 同步给主进程去调 nativeTheme.themeSource —— Windows 原生标题栏
    // 的颜色由它决定，CSS 管不到。这一行漏掉就会出现
    // 「应用是深色、标题栏是浅色」的割裂。
    syncNativeTheme(preference);
  }, [theme, preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    localStorage.setItem(STORAGE_KEY, next);
    // 立刻同步，不等 effect —— 用户点下去的瞬间标题栏就该变色，
    // 而不是等下一个渲染周期。
    syncNativeTheme(next);
  }, []);

  return { theme, preference, setPreference };
}
