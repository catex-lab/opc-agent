import { ChevronLeft, MessageSquarePlus } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { PanelHeader } from './PanelHeader';
import { AVAILABILITY_META, CAPABILITY_META, type RegisteredAgent } from '../types';

interface AgentDetailPanelProps {
  agent: RegisteredAgent;
  onBack: () => void;
  onStartChat: (agentId: string) => void;
}

/**
 * Agent 详细资料页 —— 通讯录点开某个 Agent 后的二级页面。
 *
 * 参照微信「查看好友资料」的信息层级：
 *   大头像 + 名字 + 在线状态 → 基本信息行 → 擅长领域 → 介绍 → 技术信息 → 底部操作。
 *
 * 之所以把这些从列表行里搬出来：通讯录是「扫一眼谁在线」的地方，
 * 每行塞六种信息会让扫描变成阅读；而「这个 Agent 到底能干什么、
 * 为什么连不上」是低频但需要深看的问题，值得单独一页。
 */
export function AgentDetailPanel({ agent, onBack, onStartChat }: AgentDetailPanelProps) {
  const avail = agent.status.availability;
  const meta = AVAILABILITY_META[avail];
  const canChat = avail === 'ready';

  const capabilities = agent.capabilities
    .map(cap => ({ key: cap, meta: CAPABILITY_META[cap] }))
    .filter((c): c is { key: typeof c.key; meta: NonNullable<typeof c.meta> } => !!c.meta);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      style={{ backgroundColor: 'var(--td-bg-color-page)' }}
    >
      <PanelHeader
        title="详细资料"
        // 副标题放「这是谁」——页面滚下去之后大头像会离开视野，
        // 标题栏里留着名字和厂商，才知道自己正在看谁。
        subtitle={[agent.name, agent.vendor].filter(Boolean).join(' · ')}
        leading={
          <button
            type="button"
            onClick={onBack}
            title="返回通讯录"
            aria-label="返回通讯录"
            className="tc-icon-btn -ml-1 h-8 w-8"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <ChevronLeft size={20} />
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[560px] px-6 py-8">
          {/* 头部：头像 / 名称 / 状态 */}
          <div className="flex flex-col items-center text-center">
            <AgentAvatar
              id={agent.id}
              name={agent.name}
              icon={agent.icon}
              color={agent.color}
              availability={avail}
              size={80}
            />
            <h2
              className="mt-4 text-title-lg font-semibold"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {agent.name}
            </h2>
            {agent.vendor && (
              <p className="mt-1 text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {agent.vendor}
              </p>
            )}
            <div className="mt-2 flex items-center gap-1.5 text-body" style={{ color: meta.color }}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.dot }} />
              {meta.label}
            </div>
          </div>

          {/* 基本信息 */}
          <section className="mt-7">
            <h3 className="tc-section-title mb-2">基本信息</h3>
            <div className="tc-detail-rows overflow-hidden rounded-xl" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
              <DetailRow label="状态" value={agent.status.message || meta.label} />
              <DetailRow label="版本" value={agent.status.version ? `v${agent.status.version}` : '未上报'} />
              <DetailRow label="接入方式" value={kindLabel(agent.kind)} />
              {agent.installHint && <DetailRow label="接入说明" value={agent.installHint} />}
            </div>
          </section>

          {/* 擅长领域 */}
          {capabilities.length > 0 && (
            <section className="mt-6">
              <h3 className="tc-section-title mb-2">擅长领域</h3>
              <div className="flex flex-wrap gap-2">
                {capabilities.map(({ key, meta: cm }) => (
                  <span
                    key={key}
                    className="rounded-md px-2 py-1 text-secondary"
                    style={{ backgroundColor: `${cm.color}18`, color: cm.color }}
                  >
                    {cm.label}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* 介绍 */}
          {agent.description && (
            <section className="mt-6">
              <h3 className="tc-section-title mb-2">介绍</h3>
              <p
                className="rounded-xl px-4 py-3 text-body leading-relaxed"
                style={{
                  backgroundColor: 'var(--td-bg-color-container)',
                  color: 'var(--td-text-color-secondary)',
                }}
              >
                {agent.description}
              </p>
            </section>
          )}

          {/* 技术信息：路径与错误只在存在时才出现，没有就不占位 */}
          {(agent.status.binaryPath || agent.status.lastError) && (
            <section className="mt-6">
              <h3 className="tc-section-title mb-2">技术信息</h3>
              <div className="tc-detail-rows overflow-hidden rounded-xl" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
                {agent.status.binaryPath && (
                  <DetailRow label="可执行文件" value={agent.status.binaryPath} mono />
                )}
                {agent.status.lastError && (
                  <DetailRow label="上次错误" value={agent.status.lastError} error />
                )}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* 底部主操作：固定在页脚，滚动时不会跑掉。
          内层与正文同宽同列 —— 正文是 560px 居中的信息列，按钮如果铺满
          整条页脚（1440 窗口下约 1030px），会出现「一根巨长的蓝条托着一个
          窄栏」的割裂感。页脚底色仍然整条铺满，只把按钮收进同一列。 */}
      <div
        className="shrink-0 py-4"
        style={{
          backgroundColor: 'var(--td-bg-color-container)',
          borderTop: '1px solid var(--td-component-stroke)',
        }}
      >
        {/* 内层补上 px-6，与正文列的内边距一致 —— 否则按钮会比上面的卡片
            左右各宽 24px，看着像没对齐 */}
        <div className="mx-auto w-full max-w-[560px] px-6">
          <button
            type="button"
            disabled={!canChat}
            onClick={() => onStartChat(agent.id)}
            className="tc-btn-brand w-full py-2.5 text-body"
          >
            <MessageSquarePlus size={16} />
            {canChat ? '发消息' : '当前不可对话'}
          </button>
          {!canChat && (
            <p className="mt-2 text-center text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {agent.status.message || meta.label} · 需要先完成登录或修复
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  error,
}: {
  label: string;
  value: string;
  mono?: boolean;
  error?: boolean;
}) {
  return (
    <div className="flex gap-3 px-4 py-3">
      <span
        className="w-[76px] shrink-0 text-body"
        style={{ color: 'var(--td-text-color-placeholder)' }}
      >
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 text-body leading-relaxed ${mono ? 'break-all font-mono' : 'break-words'}`}
        style={{
          color: error ? 'var(--td-error-color)' : 'var(--td-text-color-primary)',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** 接入形态的人话表述。原始 kind 是 sdk/cli/acp 这种实现细节，用户看不懂。 */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'sdk':
      return 'SDK 接入';
    case 'cli':
      return 'CLI 子进程';
    case 'acp':
      return 'ACP 协议';
    default:
      return '未接入';
  }
}
