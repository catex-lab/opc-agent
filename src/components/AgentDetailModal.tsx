import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { AgentDetailSections } from './AgentDetailSections';
import { AVAILABILITY_META, availabilityLabelOf, type RegisteredAgent } from '../types';
import { useDraggableDialog } from '../hooks/useDraggableDialog';

interface AgentDetailModalProps {
  agent: RegisteredAgent | undefined;
  open: boolean;
  onClose: () => void;
}

/**
 * Agent 详情弹窗 —— 聊天页「⋯ → Agent 详情」的落点。
 *
 * ## 为什么从「抽屉」改成「弹窗」
 *
 * 原来详情是渲染在会话头部 children 里的一段展开区：点开后头部从 52px
 * 撑到 200 多 px，**消息区被整块往下推**。两个后果：
 *   1. 用户点「详情」时正在看的那几条消息会被推走，关掉又要重新找回位置；
 *   2. 头部高度变成可变量，两栏的分隔线跟着跳。
 *
 * 弹窗把「看一眼就走」的东西放在浮层里，背后的会话一动不动 ——
 * 这也是 IM 里查看联系人资料的通行做法。
 *
 * ## 点空白关闭
 *
 * 遮罩的 `onMouseDown` 里判断 `e.target === e.currentTarget`：只有按在
 * 遮罩本身才关。用 mousedown 而不是 click，是为了避免「在卡片里选文字、
 * 拖到遮罩上松手」被当成点击遮罩（那种情况 click 的 target 是共同祖先）。
 * Esc 同样关闭，焦点落在关闭按钮上 —— 和 ConfirmDialog 一套手感。
 *
 * ## 内容与会话页共用
 *
 * 信息区块来自 AgentDetailSections（资料页也用同一份），只有头部与容器
 * 是弹窗自己的。
 */
export function AgentDetailModal({ agent, open, onClose }: AgentDetailModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDraggableDialog(panelRef, { handle: '[data-dialog-handle]' });

  useEffect(() => {
    if (!open) return;

    closeRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // 弹窗开着时背景不该还能滚。还原成打开前的值（不要硬写 ''）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || !agent) return null;

  const meta = AVAILABILITY_META[agent.status.availability];

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-agent-detail-overlay
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-agent-detail-title"
        className="tc-dialog tc-pop-in flex max-h-full w-full max-w-[440px] flex-col overflow-hidden rounded-2xl"
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        {/* 卡头：头像 + 名字 + 状态 + 关闭。固定不滚，滚的是下面的信息区 */}
        <div
          data-dialog-handle
          className="flex shrink-0 items-start gap-3 px-5 pb-4 pt-5"
          style={{ borderBottom: '1px solid var(--tc-divider)' }}
        >
          <AgentAvatar
            id={agent.id}
            name={agent.name}
            icon={agent.icon}
            color={agent.color}
            availability={agent.status.availability}
            size={52}
          />
          <div className="min-w-0 flex-1">
            <h2
              id="tc-agent-detail-title"
              className="truncate text-title-lg font-semibold"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {agent.name}
            </h2>
            <div className="mt-1 flex items-center gap-1.5 text-secondary">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: meta.dot }}
              />
              <span style={{ color: meta.color }}>{availabilityLabelOf(agent)}</span>
              {agent.vendor && (
                <span
                  className="truncate"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  · {agent.vendor}
                </span>
              )}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            className="tc-icon-btn -mr-1 -mt-1 h-8 w-8 shrink-0"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* 信息区：唯一可滚动的部分。max-h 交给外层 flex 算，
            内容短时卡片自然收紧，不会留一大片空白 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
          <AgentDetailSections agent={agent} />
        </div>
      </div>
    </div>,
    document.body
  );
}
