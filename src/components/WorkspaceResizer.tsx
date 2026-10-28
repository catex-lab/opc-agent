import { useCallback, useRef, useState } from 'react';
import { pushPrefs } from '../prefs';
import {
  WORKSPACE_MAX,
  WORKSPACE_MIN,
  currentWorkspaceWidth,
  saveWorkspaceWidth,
} from '../uiPrefs';

/**
 * 右侧工作区面板的宽度拖拽手柄（A82）。
 *
 * ## 与左侧 SidebarResizer 的关系
 *
 * 机制几乎一样（5px 窄条 + Pointer Capture + `body[data-resizing]` 双保险），
 * 差别只有两处，都是**方向**带来的：
 *
 *  1. 面板在右边，指针往左拖才是变宽：`next = start - dx`。写成加号会
 *     「越拖越窄」，而那条分割线看起来完全正常 —— 这种反向着手的 bug
 *     靠看截图是发现不了的。
 *  2. 高亮线要盖住的是面板自己的 `border-left`，所以对齐 `left-0`。
 *
 * ## 为什么宽度走 CSS 变量而不是 React state
 *
 * 拖动过程中每帧都 setState 会让整个 WorkspacePanel 重渲染 —— 里面挂着
 * 文件树、WebContentsView 的宿主 div、浏览器标签。CSS 变量是同步的、
 * 只触发样式重算，拖动跟手，也不牵连 React（与左侧栏同一套分工，
 * 见 uiPrefs.ts 头部注释）。
 *
 * ## 键盘也能改（左侧栏没有的一条）
 *
 * 手柄是 `role="separator"`，但一个只能用鼠标拖的分隔条对键盘用户不存在。
 * 所以这里补了方向键 / Home / End：步进 16px，到端点即停。代价是十行代码，
 * 换来「这条控件不依赖你有鼠标」。
 */

interface WorkspaceResizerProps {
  /** 松手时回调（宽度已落盘），用于提示或埋点 */
  onCommit?: (width: number) => void;
}

/** 键盘步进：一次一又四分之三个字符宽度，够细但不至于按到手酸 */
const KEY_STEP = 16;

export function WorkspaceResizer({ onCommit }: WorkspaceResizerProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, width: 0 });
  const widthRef = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 只认主键：右键/中键按在柄上不该开始拖
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, width: currentWorkspaceWidth() };
    widthRef.current = startRef.current.width;
    setDragging(true);
    document.body.dataset.resizing = '1';
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // 面板在右侧：往左拖（dx 为负）是变宽
    const next = startRef.current.width - (e.clientX - startRef.current.x);
    const clamped = Math.min(WORKSPACE_MAX, Math.max(WORKSPACE_MIN, Math.round(next)));
    widthRef.current = clamped;
    // 只改变量、不落盘：localStorage 是同步 IO，每帧写一次会掉帧
    document.documentElement.style.setProperty('--tc-workspace-width', `${clamped}px`);
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      delete document.body.dataset.resizing;
      setDragging(false);
      const w = saveWorkspaceWidth(widthRef.current);
      onCommit?.(w);
    },
    [onCommit]
  );

  /** 键盘改宽度。与拖动共用同一条写变量的路，行为不会分叉。 */
  const nudge = useCallback((delta: number) => {
    const next = Math.min(
      WORKSPACE_MAX,
      Math.max(WORKSPACE_MIN, Math.round(currentWorkspaceWidth() + delta))
    );
    widthRef.current = next;
    saveWorkspaceWidth(next);
    onCommit?.(next);
  }, [onCommit]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整工作区面板宽度"
      aria-valuemin={WORKSPACE_MIN}
      aria-valuemax={WORKSPACE_MAX}
      tabIndex={0}
      data-workspace-resizer
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={e => {
        // 左右都接受：面板在右侧，两个方向各自有各自的直觉用户
        if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(KEY_STEP); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(-KEY_STEP); }
        else if (e.key === 'Home') { e.preventDefault(); nudge(WORKSPACE_MIN); }
        else if (e.key === 'End') { e.preventDefault(); nudge(WORKSPACE_MAX); }
      }}
      // 双击复位：拖到别扭的宽度后不用去设置里找「恢复默认」
      onDoubleClick={() => {
        document.documentElement.style.removeProperty('--tc-workspace-width');
        localStorage.removeItem('opc.workspace-width');
        // A135：服务端那份也要清，否则下次启动又变回用户刚放弃的宽度
        pushPrefs({ workspaceWidth: null });
      }}
      title="拖动调整宽度（← 变宽），双击恢复默认；聚焦后可用方向键"
      className="group absolute inset-y-0 left-0 z-10 -ml-[2px] w-[5px] cursor-col-resize"
      style={{ backgroundColor: 'transparent' }}
    >
      {/* 平时不亮：常驻一条竖线会把面板和聊天区硬切开。悬停/拖动时才点亮
          面板自己的那条 border-left —— 是「把线点亮」，不是「多画一条」。 */}
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
