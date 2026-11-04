import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

export interface InfoHintItem {
  /** 术语（如「已就位」） */
  term: string;
  /** 一句人话定义 */
  definition: string;
}

export interface InfoHintProps {
  /** 术语表形态；与 `text` 二选一 */
  items?: InfoHintItem[];
  /** 单段说明形态；与 `items` 二选一 */
  text?: string;
  /** 触发按钮与浮层的无障碍名，如「挂载能力说明」 */
  label: string;
  title?: string;
  /** 浮层底部的一句补充，如「六档口径见 PLAN-EXTENSIONS.md §9」 */
  note?: string;
  className?: string;
  /** 警示态：用于「当前不可用」这类需要被看见的说明 */
  warn?: boolean;
}

/**
 * 「一枚信息图标 + 一个可读浮层」（A164 / 批次三）。
 *
 * 页面上原本有三段常驻解释性长文案（挂载能力图例、页脚统计、敏感内容提示），
 * 它们占掉三四行却只在第一次看时需要 —— 收进同一枚图标后面，三处共用本组件。
 *
 * ## 交互
 *
 * - 悬停约 300ms 展开；离开后约 200ms 收起（给鼠标移进浮层的时间）
 * - 点击锁定/解锁 —— 便于逐条读完；Esc 或点击外部关闭
 * - 可 Tab 聚焦，focus 同样展开（键盘用户不需要鼠标）
 * - `aria-expanded` + `aria-describedby` 指向浮层
 *
 * ## 为什么 portal 到 body
 *
 * 浮层挂在详情页的滚动容器里，容器一裁切，靠近底部的提示就只剩半截。
 * portal 之后用 `position: fixed` 贴按钮下方的坐标，并且越界时翻到上方。
 *
 * ## 视觉
 *
 * 图标是 16px 细线圆圈 i，单色（`--td-text-color-placeholder`），
 * **默认不参与状态色体系** —— 它只是「这里有解释」，不是警告；仅当传入
 * `warn`（如「功能当前不可用」）才转警示色。正文用 `text-body`，
 * 与页面正文同级，不做放大。
 *
 * 既有术语表形态（`items`）与单段说明形态（`text`）共用同一套交互，
 * 不允许再出现第二种 tooltip 组件。
 */
export function InfoHint({ items, text, label, title, note, className, warn }: InfoHintProps) {
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const uid = useId();
  const panelId = `info-hint-${uid}`;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const close = () => {
    clearTimer();
    setOpen(false);
    setLocked(false);
  };

  /** 贴住触发按钮：默认在下方右对齐，下方空间不够就翻到上方 */
  const place = () => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - 8 - height);
    }
    setPos({ left, top });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        triggerRef.current?.focus();
      }
    };
    const onViewportChange = () => place();

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const hoverOpen = () => {
    clearTimer();
    if (locked || open) return;
    timerRef.current = window.setTimeout(() => setOpen(true), 300);
  };

  /** 悬停离开后留 200ms：给鼠标从图标移到浮层上的时间 */
  const hoverClose = () => {
    clearTimer();
    if (locked) return;
    timerRef.current = window.setTimeout(() => setOpen(false), 200);
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        title={label}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)] ${className ?? ''}`}
        style={{
          color: warn ? 'var(--td-warning-color)' : 'var(--td-text-color-placeholder)',
        }}
        onMouseEnter={hoverOpen}
        onMouseLeave={hoverClose}
        onFocus={() => {
          clearTimer();
          setOpen(true);
        }}
        onBlur={close}
        onClick={() => {
          if (locked) {
            close();
          } else {
            clearTimer();
            setLocked(true);
            setOpen(true);
          }
        }}
        data-info-hint={label}
        data-warn={warn ? '1' : undefined}
      >
        <Info size={16} strokeWidth={1.5} />
      </button>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={label}
              className="rounded-xl px-3 py-2.5"
              style={{
                position: 'fixed',
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                width: 320,
                maxWidth: 'calc(100vw - 16px)',
                visibility: pos ? 'visible' : 'hidden',
                zIndex: 1000,
                backgroundColor: 'var(--tc-surface-raised)',
                border: '1px solid var(--tc-edge-strong)',
                boxShadow: 'var(--shadow-popup)',
              }}
              onMouseEnter={clearTimer}
              onMouseLeave={hoverClose}
              data-info-hint-panel
            >
              {title && (
                <p
                  className="mb-1.5 text-body font-semibold"
                  style={{ color: 'var(--td-text-color-primary)' }}
                >
                  {title}
                </p>
              )}
              {items && items.length > 0 ? (
                <ul className="space-y-1.5">
                  {items.map(item => (
                    <li key={item.term} className="text-body leading-5">
                      <span className="font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
                        {item.term}
                      </span>
                      <span style={{ color: 'var(--td-text-color-secondary)' }}> {item.definition}</span>
                    </li>
                  ))}
                </ul>
              ) : text ? (
                <p className="text-body leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
                  {text}
                </p>
              ) : null}
              {note && (
                <p
                  className="mt-2 text-caption leading-5"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  {note}
                </p>
              )}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
