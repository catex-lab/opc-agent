import { useRef, useCallback } from 'react';

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
}

/**
 * 让模态弹窗支持鼠标拖拽移动。
 *
 * ## 为什么不用 `-webkit-app-region: drag`
 *
 * 那是 Electron 主窗口的专属属性，对 DOM 里的浮层无效。只能自己算位移。
 *
 * ## 为什么位移不走 state
 *
 * 设置页里有滑杆、记忆面板、Agent 列表，每次 pointermove 都 setState
 * 等于每帧重渲染整棵子树，拖动会明显发涩。直接写 `style.transform`
 * 只触发浏览器合成层重绘，流畅得多。
 *
 * ## 边界策略
 *
 * 允许弹窗部分拖出屏幕，但保留 40px 可见区 —— 用户可以把弹窗贴到
 * 屏幕边缘，而不至于「拖丢了再也找不回来」。
 */
export function useDraggableDialog(
  panelRef: React.RefObject<HTMLElement | null>,
  options?: {
    /** 拖拽把手 CSS 选择器；不传则整个面板可拖 */
    handle?: string;
    /** 是否限制在可视区内；默认 true */
    bound?: boolean;
  }
) {
  const dragRef = useRef<DragState | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });

  const apply = (x: number, y: number) => {
    offsetRef.current = { x, y };
    const el = panelRef.current;
    if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  /** 关掉弹窗时归零，下次打开回到居中 */
  const reset = () => {
    dragRef.current = null;
    offsetRef.current = { x: 0, y: 0 };
    const el = panelRef.current;
    if (el) el.style.transform = '';
  };

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;

      // 只认把手区域
      if (options?.handle) {
        if (!target.closest(options.handle)) return;
      }
      // 避免在按钮 / 输入框 / 链接上开始拖动
      if (target.closest('button, a, input, textarea, select, [role="switch"]')) return;

      const el = panelRef.current;
      if (!el) return;

      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseX: offsetRef.current.x,
        baseY: offsetRef.current.y,
      };
      el.setPointerCapture(e.pointerId);
    },
    [options?.handle, panelRef]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;

      let dx = d.baseX + e.clientX - d.startX;
      let dy = d.baseY + e.clientY - d.startY;

      if (options?.bound !== false) {
        const el = panelRef.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          // 留 40px 可见区，拖不丢
          const minX = -(rect.width - 40);
          const maxX = vw - 40;
          const minY = -(rect.height - 40);
          const maxY = vh - 40;
          dx = Math.min(Math.max(dx, minX), maxX);
          dy = Math.min(Math.max(dy, minY), maxY);
        }
      }

      apply(dx, dy);
    },
    [options?.bound, panelRef]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragRef.current = null;
      const el = panelRef.current;
      if (el) el.releasePointerCapture?.(e.pointerId);
    },
    [panelRef]
  );

  const onPointerCancel = onPointerUp;

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, reset };
}
