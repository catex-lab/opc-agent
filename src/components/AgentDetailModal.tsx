import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { StatusDot } from './StatusDot';
import { AgentDetailSections } from './AgentDetailSections';
import { agentStatusViewOf, availabilityLabelOf, type RegisteredAgent } from '../types';
import { useTranslation } from '../i18n';

interface AgentDetailModalProps {
  agent: RegisteredAgent | undefined;
  open: boolean;
  onClose: () => void;
  /**
   * D2-3（ui-review 26 号图）：底部操作区。三个入口都是**可选**回调 ——
   * 不传就不渲染对应按钮（A141：不给永远不会生效的控件），弹窗保持
   * 原来的纯只读形态。
   *
   * ⚠️ 当前两个渲染点（ChatPage / ChatHeader）都还没接这些回调 ——
   * 接线涉及视图系文件，见 ui 优化回报的待确认项。
   */
  /** 发消息（主按钮）。与资料页 `AgentDetailPanel.onStartChat` 同一语义 */
  onStartChat?: (agentId: string) => void;
  /** 真实检测（次级按钮）。与资料页 canary 手动触发同一语义 */
  onVerify?: (agentId: string) => void;
  /** 查看完整资料（文字链）：跳通讯录资料页 */
  onViewProfile?: (agentId: string) => void;
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
 * 信息区块来自 AgentDetailSections（资料页也用同一份），只有头部、容器
 * 与底部操作区是弹窗自己的。
 *
 * ## D2-1~D2-3（ui-review 26 号图）
 *
 *   · 宽度 760 → 540：760 只装 3 行信息 + 3 个标签 + 1 行介绍，下半部
 *     40% 空白；540 与内容量匹配。
 *   · 头部状态与资料页同一口径：探测 ready 但从未真实检测（lastCanary
 *     为空）时显示灰色「未验证」徽标，不再写「在线」（D1-1 / 共性 4；
 *     判定与 AgentDetailSections 的基本信息行完全一致）。
 *   · 底部加操作区：左「查看完整资料」文字链 +「真实检测」次级，
 *     右「发消息」主按钮 —— 不再是只能关掉的纯只读弹窗。回调都没传时
 *     整条操作区不渲染。
 */
export function AgentDetailModal({
  agent,
  open,
  onClose,
  onStartChat,
  onVerify,
  onViewProfile,
}: AgentDetailModalProps) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);

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

  const meta = agentStatusViewOf(agent);
  const canChat = agent.status.availability === 'ready';
  /**
   * D1-1 / 共性 4：探测说 ready 但从未跑过真实检测 —— 状态降为「未验证」
   * （灰），不写「在线」。与 AgentDetailSections 的「状态」行同一判定，
   * 弹窗与资料页口径必须一致。
   */
  const unverifiedReady = canChat && !agent.status.lastCanary;
  const hasActions = !!(onStartChat || onVerify || onViewProfile);

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
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-agent-detail-title"
        className="tc-dialog tc-pop-in flex max-h-full w-full max-w-[540px] flex-col overflow-hidden rounded-2xl"
      >
        {/* 卡头：头像 + 名字 + 状态 + 关闭。固定不滚，滚的是下面的信息区 */}
        <div
          className="flex shrink-0 items-start gap-3 px-5 pb-4 pt-5"
          style={{ borderBottom: '1px solid var(--tc-divider)' }}
        >
          <AgentAvatar
            id={agent.id}
            name={agent.name}
            icon={agent.icon}
            src={agent.logoUrl}
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
            {unverifiedReady ? (
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-secondary">
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption"
                  style={{
                    color: 'var(--td-text-color-secondary)',
                    backgroundColor: 'var(--td-bg-color-component)',
                  }}
                  data-agent-detail-unverified
                >
                  <StatusDot
                    color="var(--td-text-color-placeholder)"
                    shape="hollow"
                    size={6}
                    statusLabel={t('agentDetail.unverified')}
                  />
                  {t('agentDetail.unverified')}
                </span>
                {agent.vendor && (
                  <span className="truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    · {agent.vendor}
                  </span>
                )}
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1.5 text-secondary">
                <StatusDot color={meta.dot} shape={meta.dotShape} size={6} statusLabel={meta.label} />
                <span style={{ color: meta.color }}>{availabilityLabelOf(agent)}</span>
                {agent.vendor && (
                  <span className="truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    · {agent.vendor}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            title={t('agentDetail.close')}
            aria-label={t('agentDetail.close')}
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

        {/* 底部操作区（D2-3）：「查看完整资料」（文字链）+「真实检测」（次级）在左，
            「发消息」（主）在右。三个回调都缺席时不渲染 —— 弹窗退回纯只读，
            不摆看起来能点其实没反应的假控件（A141）。 */}
        {hasActions && (
          <div
            className="flex shrink-0 items-center gap-2.5 px-5 py-3.5"
            style={{ borderTop: '1px solid var(--tc-divider)' }}
            data-agent-detail-actions
          >
            {onViewProfile && (
              <button
                type="button"
                onClick={() => onViewProfile(agent.id)}
                className="rounded text-body underline-offset-2 transition-colors hover:underline"
                style={{ color: 'var(--td-text-color-secondary)' }}
                data-agent-detail-profile
              >
                {t('agentDetail.viewProfile')}
              </button>
            )}
            {onVerify && (
              <button
                type="button"
                onClick={() => onVerify(agent.id)}
                className="tc-btn-secondary"
                data-agent-detail-verify
              >
                {t('canary.run')}
              </button>
            )}
            {onStartChat && (
              <button
                type="button"
                onClick={() => onStartChat(agent.id)}
                disabled={!canChat}
                title={canChat ? undefined : t('agentDetail.cannotChat')}
                className="tc-btn-brand ml-auto"
                data-agent-detail-start-chat
              >
                {/* 与资料页同一口径：不可对话时按钮文字直接说原因 */}
                {canChat ? t('agentDetail.sendMessage') : t('agentDetail.cannotChat')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
