import { useState } from 'react';
import { ChevronDown, Trash2, Info, Loader2 } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { PanelHeader } from './PanelHeader';
import {
  AVAILABILITY_META,
  CAPABILITY_META,
  type Model,
  type RegisteredAgent,
} from '../types';
import type { ScenarioTemplate } from '../scenarios';

interface ChatHeaderProps {
  agent: RegisteredAgent | undefined;
  /** 会话已绑定但 Agent 未注册（例如后端已下线该 Agent）时的兜底标题 */
  fallbackTitle: string;
  models: Model[];
  selectedModel: string;
  isLoading: boolean;
  /** P4：会话绑定的场景（有则显示场景标签） */
  scenario?: ScenarioTemplate;
  onModelChange: (modelId: string) => void;
  onDelete: () => void;
}

/**
 * 会话头部。
 *
 * 采用 IM 的「联系人卡片」式头部：头像 + 名字 + 在线状态 + 一句话简介，
 * 点开可看详情。模型选择收进一个次要的下拉，因为它是会话级设置，
 * 不该抢走头部最主要的视觉位置（工具型界面常犯的错）。
 */
export function ChatHeader({
  agent,
  fallbackTitle,
  models,
  selectedModel,
  isLoading,
  scenario,
  onModelChange,
  onDelete,
}: ChatHeaderProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const avail = agent?.status.availability;
  const meta = avail ? AVAILABILITY_META[avail] : null;

  return (
    <PanelHeader
      className="relative"
      leading={
        <AgentAvatar
          id={agent?.id || fallbackTitle}
          name={agent?.name || fallbackTitle}
          icon={agent?.icon}
          color={agent?.color}
          availability={avail}
          size={38}
        />
      }
      title={agent?.name || fallbackTitle}
      badge={
        <>
          {scenario && (
            <span
              className="rounded px-1.5 py-[1px] text-caption"
              style={{ backgroundColor: `${scenario.color}1f`, color: scenario.color }}
              title={`场景：${scenario.description}`}
            >
              {scenario.label}
            </span>
          )}
          {meta && (
            <span className="flex items-center gap-1 text-caption" style={{ color: meta.color }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.dot }} />
              {meta.label}
            </span>
          )}
          {isLoading && (
            <span
              className="flex items-center gap-1 text-caption"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              <Loader2 size={11} className="animate-spin" />
              正在输入…
            </span>
          )}
        </>
      }
      subtitle={agent?.description || agent?.vendor || '本机 Agent'}
      actions={
        <>
          {/* 模型选择（会话级设置，次要位置） */}
          {models.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowModels(v => !v)}
                // h-8 而不是 py-1.5：标题栏右侧的控件统一 32px 高，
                // 与两个图标按钮齐平。原先靠 py 撑出来是 30px，
                // 并排看会差 2px（上边差 1、下边差 1），看着像没对齐。
                className="flex h-8 max-w-[190px] items-center gap-1 rounded-lg px-2.5 text-secondary"
                style={{
                  backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                  color: 'var(--td-text-color-secondary)',
                }}
                title="切换模型"
              >
                <span className="truncate">
                  {models.find(m => m.modelId === selectedModel)?.name || selectedModel}
                </span>
                <ChevronDown size={13} />
              </button>

              {showModels && (
                <div
                  className="absolute right-0 top-full z-20 mt-1 max-h-[280px] w-[240px] overflow-y-auto rounded-xl py-1 shadow-popup"
                  style={{
                    backgroundColor: 'var(--td-bg-color-container)',
                    border: '1px solid var(--td-component-stroke)',
                  }}
                >
                  {models.map(m => (
                    <button
                      key={m.modelId}
                      type="button"
                      onClick={() => {
                        onModelChange(m.modelId);
                        setShowModels(false);
                      }}
                      className="block w-full px-3 py-2 text-left text-secondary"
                      style={{
                        color:
                          m.modelId === selectedModel
                            ? 'var(--td-brand-color)'
                            : 'var(--td-text-color-primary)',
                        backgroundColor:
                          m.modelId === selectedModel ? 'var(--td-brand-color-light)' : 'transparent',
                      }}
                    >
                      <div className="font-medium">{m.name}</div>
                      {m.description && (
                        <div className="mt-0.5 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                          {m.description}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowDetail(v => !v)}
            title="Agent 详情"
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            style={{
              backgroundColor: showDetail ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-secondarycontainer)',
              color: showDetail ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
            }}
          >
            <Info size={15} />
          </button>

          {/* 删除会话：与左侧列表一致的两步确认，避免误点即永久删除 */}
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="flex h-8 items-center rounded-lg px-2 text-secondary"
                style={{
                  backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                  color: 'var(--td-text-color-secondary)',
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete();
                }}
                className="flex h-8 items-center rounded-lg px-2 text-secondary font-medium"
                style={{
                  backgroundColor: 'var(--td-error-color)',
                  color: '#fff',
                }}
              >
                确认删除
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              title="删除会话"
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
              style={{
                backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                color: 'var(--td-text-color-secondary)',
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </>
      }
    >
      {/* 详情抽屉 */}
      {showDetail && agent && (
        <div
          className="px-6 pb-3 pt-0 text-secondary leading-relaxed"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <div
            className="space-y-2 rounded-xl px-4 py-3"
            style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span style={{ color: 'var(--td-text-color-placeholder)' }}>擅长领域</span>
              {agent.capabilities.map(cap => {
                const cm = CAPABILITY_META[cap];
                if (!cm) return null;
                return (
                  <span
                    key={cap}
                    className="rounded px-1.5 py-[2px] text-caption"
                    style={{ backgroundColor: `${cm.color}18`, color: cm.color }}
                  >
                    {cm.label}
                  </span>
                );
              })}
            </div>
            <div>
              <span style={{ color: 'var(--td-text-color-placeholder)' }}>接入方式 </span>
              {agent.kind === 'sdk'
                ? 'CodeBuddy SDK'
                : agent.kind === 'cli'
                  ? 'CLI 子进程'
                  : agent.kind === 'acp'
                    ? 'ACP 协议'
                    : '未接入'}
              {agent.status.version ? ` · v${agent.status.version}` : ''}
            </div>
            {agent.status.message && (
              <div>
                <span style={{ color: 'var(--td-text-color-placeholder)' }}>状态 </span>
                {agent.status.message}
              </div>
            )}
            {agent.status.lastError && (
              <div style={{ color: 'var(--td-error-color)' }}>
                <span style={{ color: 'var(--td-text-color-placeholder)' }}>上次错误 </span>
                {agent.status.lastError}
              </div>
            )}
          </div>
        </div>
      )}
    </PanelHeader>
  );
}
