import { Trash2, Users, ChevronDown, Check } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { PanelHeader } from './PanelHeader';
import { ORCHESTRATION_META, type OrchestrationMode, type RegisteredAgent } from '../types';

/**
 * 群聊头部。
 *
 * ## 为什么必须复用 PanelHeader
 *
 * 头部规范是全应用统一的（字号 / 内边距 / 底边线高度），全部收敛在
 * PanelHeader 里定义一次。群聊头部的信息量比一对一多（成员头像堆叠 +
 * 编排模式 + 人数），但那是**内容**的差异，不是**规格**的差异 ——
 * 所以这里只往 PanelHeader 的 leading / badge / subtitle / actions
 * 四个槽位里填东西，不自己写 <header>。否则两栏的分隔线立刻对不齐。
 *
 * ## 头像堆叠而不是平铺
 *
 * 群成员可能很多，平铺会占掉整行。用 IM 通用的负 margin 叠放，
 * 超过 4 个就收成「…+N」；点开成员列表可以看到全部。
 */

const MODE_ORDER: OrchestrationMode[] = ['dispatch', 'broadcast', 'relay', 'debate', 'mention'];

interface GroupChatHeaderProps {
  title: string;
  members: RegisteredAgent[];
  /** 在线成员数（成员里 availability === 'ready' 的） */
  onlineCount: number;
  orchestration: OrchestrationMode;
  onOrchestrationChange: (mode: OrchestrationMode) => void;
  onDelete: () => void;
}

export function GroupChatHeader({
  title,
  members,
  onlineCount,
  orchestration,
  onOrchestrationChange,
  onDelete,
}: GroupChatHeaderProps) {
  const shown = members.slice(0, 4);
  const rest = members.length - shown.length;
  const modeMeta = ORCHESTRATION_META[orchestration];

  return (
    <PanelHeader
      level="page"
      // 头像堆叠作为标题的 leading：一眼看出「这是一群人在说话」
      leading={
        <div className="flex flex-shrink-0 items-center">
          {shown.length === 0 ? (
            <div
              className="flex h-11 w-11 items-center justify-center rounded-full"
              style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
            >
              <Users size={20} style={{ color: 'var(--td-text-color-placeholder)' }} />
            </div>
          ) : (
            shown.map((m, i) => (
              <div
                key={m.id}
                className="rounded-full"
                style={{
                  // 负 margin 叠放；越靠后越在上层，形成从左到右的堆叠
                  marginLeft: i === 0 ? 0 : -10,
                  zIndex: shown.length - i,
                  // 描边用容器底色：深色主题下也接得住
                  boxShadow: '0 0 0 2px var(--td-bg-color-container)',
                }}
              >
                <AgentAvatar
                  id={m.id}
                  name={m.name}
                  icon={m.icon}
                  color={m.color}
                  size={32}
                  availability={m.status.availability}
                />
              </div>
            ))
          )}
          {rest > 0 && (
            <span
              className="ml-[-10px] flex h-8 w-8 items-center justify-center rounded-full text-caption font-medium"
              style={{
                zIndex: 0,
                backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                color: 'var(--td-text-color-secondary)',
                boxShadow: '0 0 0 2px var(--td-bg-color-container)',
              }}
            >
              +{rest}
            </span>
          )}
        </div>
      }
      title={title}
      badge={
        <span
          className="rounded px-1.5 py-[1px] text-caption"
          style={{
            backgroundColor: 'var(--td-bg-color-secondarycontainer)',
            color: 'var(--td-text-color-secondary)',
          }}
        >
          {members.length} 人 · {onlineCount} 在线
        </span>
      }
      subtitle={modeMeta.description}
      actions={
        <>
          {/* 编排模式切换：群聊的核心控制，放在头部操作区 */}
          <div className="relative">
            <ModePicker
              value={orchestration}
              onChange={onOrchestrationChange}
              label={modeMeta.label}
            />
          </div>

          <button
            type="button"
            onClick={onDelete}
            title="删除群聊"
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-opacity hover:opacity-80"
            style={{
              backgroundColor: 'var(--td-bg-color-secondarycontainer)',
              color: 'var(--td-text-color-secondary)',
            }}
          >
            <Trash2 size={15} />
          </button>
        </>
      }
    />
  );
}

/**
 * 编排模式选择器。
 *
 * 用原生 details/summary 而不是 TDesign Select：选项只有 5 个且每项都要
 * 带一句说明，Select 的窄下拉塞不下两行文字。details 的好处是点外面
 * 自动收起，不需要自己管 outside-click。
 */
function ModePicker({
  value,
  onChange,
  label,
}: {
  value: OrchestrationMode;
  onChange: (mode: OrchestrationMode) => void;
  label: string;
}) {
  return (
    <details className="relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-1 rounded-lg px-2.5 py-1.5 text-secondary"
        style={{
          backgroundColor: 'var(--td-bg-color-secondarycontainer)',
          color: 'var(--td-text-color-secondary)',
        }}
        title="切换编排模式"
      >
        <span className="font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {label}
        </span>
        <ChevronDown size={13} />
      </summary>

      <div
        className="absolute right-0 top-full z-30 mt-1 w-[280px] rounded-xl py-1 shadow-popup"
        style={{
          backgroundColor: 'var(--td-bg-color-container)',
          border: '1px solid var(--td-component-stroke)',
        }}
      >
        {MODE_ORDER.map(mode => {
          const meta = ORCHESTRATION_META[mode];
          const active = mode === value;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onChange(mode)}
              className="block w-full px-3 py-2 text-left"
              style={{
                backgroundColor: active ? 'var(--td-brand-color-light)' : 'transparent',
              }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="text-body font-medium"
                  style={{ color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-primary)' }}
                >
                  {meta.label}
                </span>
                {active && <Check size={13} style={{ color: 'var(--td-brand-color)' }} />}
              </div>
              <div
                className="mt-0.5 text-caption leading-4"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                {meta.description}
              </div>
            </button>
          );
        })}
      </div>
    </details>
  );
}
