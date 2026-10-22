import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface RemarkDialogProps {
  open: boolean;
  /** 原显示名，作为输入框的提示与占位 */
  name: string;
  /** 当前备注（空 = 还没写过） */
  value: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}

/**
 * 改备注的小弹窗。
 *
 * 与 ConfirmDialog 同一套外壳（玻璃面板、遮罩点击关闭、Esc、焦点管理），
 * 只是把正文换成输入框 —— 所以没有复用 ConfirmDialog：那里 `children`
 * 是静态文案，把输入框塞进去拿不到「回车保存」和自动全选。
 *
 * 三个细节：
 *   1. **自动聚焦并全选**。用户点「修改备注」就是要改现有内容，
 *      让他再点一次输入框、再全选一次，是多余的两步。
 *   2. **回车保存、Esc 取消**。这是改一个字段的弹窗，回车是唯一符合直觉的提交。
 *   3. **清空即删除**。留空保存等于「不要备注了」，回到原名 ——
 *      不给「空备注」这种半状态，否则显示逻辑要多一条分支。
 */
export function RemarkDialog({ open, name, value, onSave, onCancel }: RemarkDialogProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开都从当前备注重新起步：上次取消时留下的草稿不该被带到下一次
  useEffect(() => {
    if (!open) return;
    setDraft(value);
    // 等弹窗真的挂上再聚焦（portal 里首次渲染时 ref 才有值）
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onCancel]);

  if (!open) return null;

  const submit = () => onSave(draft);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-remark-title"
        data-remark-dialog
        className="tc-glass w-full max-w-[360px] rounded-xl p-6"
      >
        <h2
          id="tc-remark-title"
          className="text-title-lg font-semibold"
          style={{ color: 'var(--td-text-color-primary)' }}
        >
          修改备注
        </h2>
        <p className="mt-1 text-secondary" style={{ color: 'var(--td-text-color-secondary)' }}>
          原名：{name}。备注只在本机生效，留空保存即恢复原名。
        </p>

        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // 回车保存：输入法组合中的回车不能当提交（中文输入时按回车选词很常见）
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={name}
          aria-label="备注"
          data-remark-input
          maxLength={24}
          className="mt-4 h-9 w-full rounded-lg px-3 text-body outline-none"
          style={{
            backgroundColor: 'var(--td-bg-color-component)',
            border: '1px solid var(--td-component-stroke)',
            color: 'var(--td-text-color-primary)',
          }}
        />

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="tc-btn-secondary px-3.5 py-1.5 text-body"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            data-remark-save
            className="px-3.5 py-1.5 text-body"
            style={{
              borderRadius: 'var(--td-radius-default)',
              backgroundColor: 'var(--td-brand-color)',
              color: 'var(--tc-on-brand)',
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
