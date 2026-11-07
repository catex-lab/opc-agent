import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 正文，可以是多段 */
  children: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮用错误色实心 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 轻量确认框。
 *
 * ## 为什么不用 TDesign 的 Dialog
 *
 * 用了一次，视觉上明显不是这个应用的语言：TDesign Dialog 默认 480px 宽、
 * 内边距和按钮间距都是它自己那套尺度，和右键菜单、列表、标题栏放在一起
 * 像是从另一个产品里嵌进来的。而且 `confirmBtn={{ theme: 'danger' }}`
 * 实际渲染出来是白底描边按钮，看不出是危险操作。
 *
 * 这里只需要「标题 + 两段话 + 两个按钮」，自己写 80 行反而更可控：
 * 圆角、间距、按钮样式全部复用现有 token，与 ContextMenu 同一套视觉。
 *
 * ## 自写要补的三件事
 *
 * 1. **焦点**：打开时把焦点移到取消按钮（默认不落在危险操作上）
 * 2. **Esc**：关闭
 * 3. **滚动锁定**：面板打开时背景不该还能滚
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    cancelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // 锁定背景滚动，关闭时还原原来的值（不要硬写 ''，父级可能有自己的设置）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      /* A133：原来写死 rgba(0,0,0,0.45)。面板本身是 .tc-dialog（半透明玻璃），
         遮罩就必须走 --tc-mask-soft —— 这一档的取值理由写在 index.css:1488：
         「还能看见背后」的强度，配半透明底才有意义；实色底加深遮罩只会让
         界面变黑一块。设置弹窗（App.tsx:1347）与获取 Agent（GetAgentsDialog:133）
         早就是这一档，只有这里没跟上，于是同一套玻璃面板在三个弹窗下面
         压着两种不同深度的遮罩。 */
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        // 只有点在遮罩本身才关闭；从面板里拖出来松手不该关
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-confirm-title"
        data-confirm-dialog
        className="tc-dialog w-full max-w-[400px] rounded-xl p-6"
      >
        <h2
          id="tc-confirm-title"
          className="text-title-lg font-semibold"
          style={{ color: 'var(--td-text-color-primary)' }}
        >
          {title}
        </h2>

        <div className="mt-2 text-body" style={{ color: 'var(--td-text-color-secondary)' }}>
          {children}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="tc-btn-secondary"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3.5 py-1.5 text-body"
            style={{
              borderRadius: 'var(--td-radius-default)',
              // A26：主按钮跟着透明度降档（与 .tc-btn-brand 同一套下限 0.72）。
              // 危险按钮保持实色红：它是模态框里唯一的警示信号，且弹窗本身
              // 已经有蒙层压暗，不需要再降 —— 降了反而削弱「这是危险操作」。
              backgroundColor: danger ? 'var(--td-error-color)' : 'var(--tc-solid)',
              color: danger ? '#fff' : 'var(--tc-on-brand)',
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
