import { useEffect, useRef } from 'react';

/**
 * 跟随鼠标的光斑（玻璃反光）。
 *
 * ## 它解决的是什么
 *
 * 毛玻璃界面在静止时是一块「哑光」的板子 —— 无论 alpha 调到多少，看上去
 * 都像贴纸。真实玻璃上总有一小块随视角移动的反光，有了它，界面才「是玻璃」。
 * 这是纯视觉层，不承载任何信息。
 *
 * ## 为什么只在窗口玻璃模式下挂
 *
 * 浏览器开发态 / 打靶脚本跑的是**不透明**界面（`?glass=1` 没带），
 * 那种界面本来就没有「玻璃」可言，浮一层光晕只会让截图对不上基线。
 * 所以由 `<html data-opc-glass="1">` 决定：没有这个标记就完全不动。
 *
 * ## 三个必须踩住的点
 *
 * 1. **不吃事件**。`pointer-events: none` 写在 CSS 上（`.tc-cursor-glow`）。
 *    这层是 440px 的大圆，忘了这一条，它会把下面的按钮全挡死。
 *
 * 2. **高频事件必须合并**。`pointermove` 一秒能来上百次，每次都写 DOM
 *    会把主线程占满。这里只记坐标，用 rAF 在下一帧统一写一次 transform。
 *
 * 3. **「离开」要认准**。`pointerout` 在**子元素之间移动时也会触发**
 *    （从按钮移到空白处，relatedTarget 是按钮）。只有 `relatedTarget`
 *    为 null 才是真的离开了文档 —— 这才是要淡出的时机。
 *    另外窗口失焦（Alt+Tab）也要淡出，否则光斑会僵在最后一帧。
 */
export function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 没有窗口玻璃就没有这层效果（见上面第 2 段）
    if (document.documentElement.dataset.opcGlass !== '1') return;

    let raf = 0;
    let x = 0;
    let y = 0;
    let visible = false;

    const paint = () => {
      raf = 0;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const show = () => {
      if (visible) return;
      visible = true;
      el.dataset.visible = '1';
    };

    const hide = () => {
      if (!visible) return;
      visible = false;
      el.dataset.visible = '0';
    };

    const onMove = (e: PointerEvent) => {
      // 触摸没有「悬停」概念，手指抬起后光斑会留在原地 —— 直接忽略
      if (e.pointerType === 'touch') return;
      x = e.clientX;
      y = e.clientY;
      show();
      if (!raf) raf = requestAnimationFrame(paint);
    };

    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerout', onOut);
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', hide);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onOut);
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  // 初始 data-visible="0"：第一次移动之前完全不显示，避免从 (0,0) 闪一下
  return <div ref={ref} className="tc-cursor-glow" data-visible="0" data-cursor-glow aria-hidden="true" />;
}
