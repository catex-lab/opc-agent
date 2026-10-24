import { useCallback, useRef, useState } from 'react';
import { SIDEBAR_MAX, SIDEBAR_MIN, saveSidebarWidth } from '../uiPrefs';

/**
 * 左侧二栏（会话列表 / 通讯录）的宽度拖拽手柄。
 *
 * ## 为什么是 5px 的窄条，而不是给列表栏加 `resize: horizontal`
 *
 * CSS 的 `resize` 只对 `overflow` 不为 visible 的元素生效，而列表栏内部
 * 本来就是滚动容器 —— 挂上去会跟列表自己的滚动条抢右边缘那一条，用户想
 * 滚列表时反而拖出宽度。单独一条手柄职责单一：按在它身上才改变宽度。
 *
 * ## 为什么用 Pointer Events + setPointerCapture
 *
 * 鼠标拖快时指针会跑到手柄外面（甚至跑进消息区）。不 capture 的话，
 * `pointermove` 直接断掉，宽度停在半路；capture 之后所有事件都还发到
 * 手柄自己身上，拖多快都不丢。顺带把触摸/触控笔也覆盖了。
 *
 * ## 双保险：拖动期间禁用文本选中
 *
 * 手柄只有 5px，指针一旦偏离就会划到列表里的标题文字，整页变成蓝色选区。
 * 所以拖动时给 body 挂 `data-resizing`（见 index.css），拖动结束摘掉。
 *
 * ## 手柄**不占布局宽度**（A24 修）
 *
 * 第一版把手柄当成一个正常的 5px flex 子项插在两栏之间，结果：
 *   · 主内容整体右移 5px；
 *   · 列表栏的右边缘与内容区之间多出一条 5px 的空隙 —— 那条空隙露的是
 *     父容器的 `--tc-surface-content`（白 0.82），而列表栏自己是
 *     `--tc-surface-chrome`（灰 0.72），于是接缝处出现一条**异色竖带**，
 *     看起来就像列表栏的色值被「漂」掉了一块。
 *
 * 现在用 `-ml-px -mr-1` 把 5px 的占位抵掉（-1 + 5 - 4 = 0）：布局宽度净变化为零，
 * 手柄左边缘正好落在列表栏那 1px 的 `border-right` 上。高亮线因此用
 * `left-0` 而不是居中 —— 它要盖住的就是那条分割线本身，居中会偏 2px。
 */

interface SidebarResizerProps {
  /** 每次拖动结束（松手）时回调，用于落盘与提示 */
  onCommit?: (width: number) => void;
}

/** 当前列表栏宽度：优先读内联变量，读不到再退回样式表里的值 */
function currentWidth(): number {
  const inline = document.documentElement.style.getPropertyValue('--tc-sidebar-width');
  const fromInline = parseFloat(inline);
  if (Number.isFinite(fromInline) && fromInline > 0) return fromInline;
  const computed = getComputedStyle(document.documentElement).getPropertyValue('--tc-sidebar-width');
  const fromSheet = parseFloat(computed);
  return Number.isFinite(fromSheet) && fromSheet > 0 ? fromSheet : 264;
}

export function SidebarResizer({ onCommit }: SidebarResizerProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, width: 0 });
  const widthRef = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 只认主键：右键/中键按在手柄上不该开始拖
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, width: currentWidth() };
    widthRef.current = startRef.current.width;
    setDragging(true);
    document.body.dataset.resizing = '1';
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const next = startRef.current.width + (e.clientX - startRef.current.x);
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(next)));
    widthRef.current = clamped;
    // 拖动过程只改变量、不落盘：localStorage 是同步 IO，每次 pointermove
    // 都写一次会在拖动时掉帧
    document.documentElement.style.setProperty('--tc-sidebar-width', `${clamped}px`);
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      delete document.body.dataset.resizing;
      setDragging(false);
      const w = saveSidebarWidth(widthRef.current);
      onCommit?.(w);
    },
    [onCommit]
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整列表栏宽度"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      data-sidebar-resizer
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // 双击复位：用户拖到一个别扭的宽度后，不用去设置里找「恢复默认」
      onDoubleClick={() => {
        document.documentElement.style.removeProperty('--tc-sidebar-width');
        localStorage.removeItem('opc.sidebar-width');
      }}
      title="拖动调整宽度，双击恢复默认"
      className="group relative z-10 -mr-1 w-[5px] shrink-0 cursor-col-resize"
      style={{
        // A103：父级容器加了 6px 的缝（--tc-column-gap）。这条负边距先把缝
        // 抵消掉、再退回 1px，让手柄左边缘仍落在列表栏的右边上 ——
        // 不抵消的话高亮线会离列表栏 6px，从「点亮那条边界」变成「在旁边
        // 另画一条线」。`-mr-1` 保持原样：把 5px 占位抵掉 4px，
        // 主内容不会被顶走（净占位 = -1 + 5 + 6 - 4 = 6px，正好是那道缝）。
        marginLeft: 'calc(-1 * var(--tc-column-gap) - 1px)',
        backgroundColor: 'transparent',
      }}
    >
      {/* 视觉上只有悬停/拖动时才亮出来的一条线：常驻一条竖线会把两栏
          硬生生切开，而用户平时并不需要看到「这里可以拖」。
          `left-0` 对齐的是列表栏自己的 1px 右边线 —— 悬停时是「把那条线
          点亮」，而不是在旁边多画一条。 */}
      <span
        className="absolute inset-y-0 left-0 transition-colors duration-150"
        style={{
          width: dragging ? 2 : 1,
          backgroundColor: dragging ? 'var(--td-brand-color)' : 'transparent',
        }}
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        style={{ width: 1, backgroundColor: dragging ? 'transparent' : 'var(--td-brand-color)' }}
      />
    </div>
  );
}
