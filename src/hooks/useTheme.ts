import { useState, useEffect, useCallback, useMemo } from 'react';
import { Theme, ThemePreference } from '../types';

const STORAGE_KEY = 'theme';
const MEDIA = '(prefers-color-scheme: dark)';

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
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return { theme, preference, setPreference };
}
