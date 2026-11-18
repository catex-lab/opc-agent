import { useEffect, useMemo } from 'react';
import { useVisiblePermissions, answer } from '../permissions/permissionStore';
import { pickOptionByKind } from '../../shared/permissions';
import { PermissionCard } from './PermissionCard';
import { useTranslation } from '../i18n';

interface PermissionDockProps {
  currentSessionId: string | null;
  /** 当前会话显示名：卡头「{name} 请求」用。由消息流宿主（ChatPage）给 */
  sessionLabel?: string;
}

/** 焦点在可编辑元素里时，快捷键必须让路 —— 否则打字打一半就把命令批准了。 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * 权限审批卡的挂载点（2026-11-18 内嵌化改造，原 A132 右下角浮层退役）。
 *
 * ## 形态变了，出处没变
 *
 * 卡片仍然由全局单一事实源 `permissionStore` 驱动（队列、归属、送达判定、
 * 「只有 200 才摘卡」都在那里），本组件只负责把**当前会话**的队首卡片
 * 渲染进消息流 —— 挂在 `ChatMessages` 的消息列末尾、输入框上方，输入框
 * 完整可见（原浮层盖住输入框，正是 ui-review P-1 的问题）。
 *
 * ## 跨会话的待授权去哪了
 *
 * 原浮层常驻 body、切走会话也挂着，代价是盖内容、抢焦点。内嵌后一张卡只属于
 * 它自己的会话流：切走的会话由会话列表承接 —— 「等授权」角标 + 「等待授权：
 * …」预览（P-5）说明那条流正卡着，切回去就能批。`sessionId === ''`（本地新建、
 * 还没落库的群）无法归属，仍在当前会话里兜底展示，不给它玩失踪。
 *
 * ## 快捷键
 *
 * ↵ = 队首的第一档 allow（`pickOptionByKind` 的契约：不替用户选 always）；
 * Del = 拒绝。焦点在卡片内部（按钮上）时不抢 —— 原生按钮自己处理
 * Enter/Space，文档级监听再发一次就是重复答复。Esc 不再收起：内嵌卡
 * 没有「收起」态，也没有「点外面」这种合法答复（A19 的豁免随之失效）。
 */
export function PermissionDock({ currentSessionId, sessionLabel }: PermissionDockProps) {
  const { t } = useTranslation();
  const sorted = useVisiblePermissions(currentSessionId);
  /** 只画当前会话的（含无法归属的 '' 兜底）；别的会话靠列表角标 + 预览提醒 */
  const visible = useMemo(
    () => sorted.filter(it => it.sessionId === currentSessionId || it.sessionId === ''),
    [sorted, currentSessionId]
  );
  const head = visible[0];
  const rest = visible.length - 1;

  useEffect(() => {
    if (!head) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      // 卡片内的按钮自带 Enter/Space 激活；文档级监听跳过，避免一次按键两次答复
      if (e.target instanceof Element && e.target.closest('[data-permission-card]')) return;
      if (e.key === 'Enter') {
        // ↵ 命中第一档 allow_*（仅本次），永不替用户选 always / 永久 ——
        // 持久授权只留给显式点击「永久允许」。
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
  }, [head]);

  if (!head) return null;

  return (
    <div className="tc-permission-dock" data-permission-dock>
      {rest > 0 && (
        <div className="pb-1 text-secondary" data-permission-queue-count>
          {t('permission.queue.more', { n: rest })}
        </div>
      )}
      <PermissionCard
        item={head}
        sessionLabel={sessionLabel ?? ''}
        onResolve={(opt, opts) => void answer(head.request.requestId, opt, opts)}
      />
    </div>
  );
}
