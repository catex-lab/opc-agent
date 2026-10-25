import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** 危险操作：文字用错误色，与普通项拉开距离 */
  danger?: boolean;
  /**
   * 在这一项**之前**画一条分隔线。
   * 用来把「删除」这类破坏性操作与上面的日常操作分开 —— QQ 的右键菜单
   * 也是这么分段的：靠一条线，而不是靠颜色，让误点率降下来。
   */
  divider?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  /** 触发点的视口坐标（event.clientX / clientY） */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const EDGE_PADDING = 8;

/**
 * 右键上下文菜单。
 *
 * ## 为什么不用 TDesign 的 Dropdown
 *
 * Dropdown 是「挂在触发元素上、由点击打开」的组件，而右键菜单的位置来自
 * 指针坐标、触发元素是列表行本身，两者模型不合 —— 硬套要传一堆
 * `popupProps` 覆盖定位。这个组件只做三件事：定位、关闭、键盘。
 *
 * ## 定位：先渲染再纠正
 *
 * 菜单尺寸取决于内容，打开前算不出来。所以先用触发点坐标渲染（此时可能
 * 溢出视口），`useLayoutEffect` 里量出真实尺寸再翻转 —— 用 layout effect
 * 是为了在浏览器绘制前完成纠正，用户不会看到「先弹到屏幕外再跳回来」。
 *
 * ## 关闭时机
 *
 * 用 `mousedown` 的 **capture** 阶段监听：列表行的点击在冒泡阶段处理，
 * 不拦下来会出现「菜单已关，但顺手把底下的会话也打开了」。
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();

    // 右边放不下就翻到触发点左侧；左边再放不下就贴边
    let left = x;
    if (left + width + EDGE_PADDING > window.innerWidth) {
      left = Math.max(EDGE_PADDING, x - width);
    }
    // 下边同理
    let top = y;
    if (top + height + EDGE_PADDING > window.innerHeight) {
      top = Math.max(EDGE_PADDING, y - height);
    }
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // 滚动或改窗口大小后菜单会和「它指向的那一行」错位，直接关掉最干脆
    //
    // A118：用 pointerdown 而不是 mousedown —— 输入框（t-chat-sender 的
    // shadow）会把 mousedown / click 吃掉，用 mousedown 的话「点输入框
    // 关不掉菜单」。pointerdown 能穿出 shadow，且比 mousedown 更早。
    // 用 capture 是因为菜单项自己也可能 stopPropagation。
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  // 打开即把焦点交给第一项：键盘用户不用先 Tab 进来
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  // 挂到 body：菜单是「浮在最上层」的东西，留在列表容器里既受
  // overflow/z-index 影响，也会被祖先的 transform 改变 fixed 的参照系
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="会话操作"
      className="tc-glass fixed z-50 min-w-[168px] overflow-hidden rounded-lg py-1"
      style={{
        left: pos.left,
        top: pos.top,
      }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map(item => (
        <Fragment key={item.key}>
          {item.divider && (
            <div
              className="my-1 h-px"
              style={{ backgroundColor: 'var(--td-component-stroke)' }}
              role="separator"
            />
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // 先关菜单再执行：onSelect 里可能打开对话框或触发列表重排，
              // 菜单留在屏幕上会挡住结果
              onClose();
              item.onSelect();
            }}
            // A50：与 menuItem.ts 同一套外形。高亮由 JS 直接写 backgroundColor，
            // 所以这里不能靠 hover: 类名 —— 但「自己带圆角 + 左右内缩 4px」这条
            // 几何规则一样要遵守，否则高亮块会从浮层圆角处溢出成直角。
            // A74：宽度必须显式给（见 menuItem.ts 的 A74 段），否则 button 按内容
            // 收缩，右键菜单的高亮只盖住文字。
            className="mx-1 flex w-[calc(100%_-_8px)] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body transition-colors"
            style={{ color: item.danger ? 'var(--td-error-color)' : 'var(--td-text-color-primary)' }}
            onMouseEnter={e => {
              /* A75：与 menuItem.ts 的行、下拉选项行同一档（0.06 黑）。
                 原来是 --td-bg-color-component-hover(#eeeeee)，右键菜单
                 和旁边的「⋯」菜单并排时，划过的高亮不是一个颜色。 */
              e.currentTarget.style.backgroundColor = 'var(--tc-fill-hover)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            {item.icon && <span className="flex shrink-0 items-center">{item.icon}</span>}
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body
  );
}
