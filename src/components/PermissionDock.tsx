import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVisiblePermissions, answer } from '../permissions/permissionStore';
import { pickOptionByKind } from '../../shared/permissions';
import { PermissionCard } from './PermissionCard';

interface PermissionDockProps {
  currentSessionId: string | null;
  /** 会话 id → 标题。Dock 挂在 App 层，拿不到 useChat 的当前会话对象，所以由调用方给 */
  titleOf: (sessionId: string) => string;
}

/** 焦点在可编辑元素里时，快捷键必须让路 —— 否则打字打一半就把命令批准了。 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * 权限审批浮层 —— A132。
 *
 * 全局常驻在 `document.body` 上，不随会话卸载：会话切走了，那条流仍在服务端挂着
 * 等答复，卡片跟着消失等于把人晾死。队首是「当前会话优先、组内先来先批」，
 * 排序规则在 `sortPendingPermissions` 里，这里不重复实现。
 *
 * 收起态**只写「谁 + 要做什么」，不写命令本身** —— 浮层收起时也可能被旁人看到。
 */
export function PermissionDock({ currentSessionId, titleOf }: PermissionDockProps) {
  const items = useVisiblePermissions(currentSessionId);
  const [open, setOpen] = useState(true);
  const head = items[0];
  const rest = items.length - 1;

  // 顶层 sessionId 与 request.sessionId 同值，但读顶层这一份 —— 排序、计数、
  // 角标都从这一个字段出发，两处各读一份迟早会漂。
  const headSessionId = head?.sessionId ?? null;

  useEffect(() => {
    if (!head) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A24：Esc 若被外层面板监听，收起内层会把外层一起关掉。
        // 这里只在 Dock 确实展开时吃掉它，且**不发送任何答复**。
        if (!open) return;
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (!open || isTyping(e.target)) return;
      if (e.key === 'Enter') {
        const opt = pickOptionByKind(head.request.options ?? [], 'allow');
        if (opt) {
          e.preventDefault();
          void answer(head.request.requestId, opt);
        }
        return;
      }
      if (e.key === 'Delete') {
        const opt = pickOptionByKind(head.request.options ?? [], 'reject');
        if (opt) {
          e.preventDefault();
          void answer(head.request.requestId, opt);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [head, open]);

  const label = useMemo(
    () => (headSessionId ? titleOf(headSessionId) : ''),
    [headSessionId, titleOf]
  );

  if (!head) return null;

  return createPortal(
    <div
      className="tc-permission-dock tc-glass"
      data-opc-overlay
      data-permission-dock
      // 不挂 onMouseDown 关闭：审批卡没有「点外面」这种合法答复（A19 的豁免）
    >
      {rest > 0 && (
        <button
          type="button"
          className="w-full px-3 py-1.5 text-left text-xs"
          data-permission-queue-toggle
          onClick={() => setOpen(v => !v)}
        >
          {open
            ? `▾ 还有 ${rest} 条待授权`
            : `▸ 还有 ${rest} 条待授权（最新：${label}）`}
        </button>
      )}
      {!open && (
        <button
          type="button"
          className="w-full px-3 py-2 text-left text-xs"
          data-permission-dock-open
          onClick={() => setOpen(true)}
        >
          {label} 请求「{head.request.toolName}」，点此展开
        </button>
      )}
      {open && (
        <PermissionCard
          item={head}
          sessionLabel={label}
          isCurrentSession={headSessionId === currentSessionId}
          onResolve={opt => void answer(head.request.requestId, opt)}
        />
      )}
    </div>,
    document.body
  );
}
