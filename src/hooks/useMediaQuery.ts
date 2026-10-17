import { useState, useEffect } from 'react';

/**
 * 订阅一条 CSS 媒体查询。
 *
 * 为什么不用 Tailwind 的 `lg:` 前缀解决全部响应式：断点类只能改**样式**，
 * 而「窄屏时列表与内容二选一」是**结构**变化 —— 同一个时刻只该渲染其中
 * 一个，另一个连 DOM 都不该存在（否则隐藏的那半截仍然在跑副作用、
 * 仍然能 Tab 到）。这类判断必须回到 JS。
 *
 * 初始值用 `matchMedia().matches` 同步取，不要先给 false 再在 effect 里改：
 * 那样首帧会闪一下宽屏布局。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    // query 变了要重新读一次：否则从 'a' 切到 'b' 时会沿用 'a' 的结果
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
