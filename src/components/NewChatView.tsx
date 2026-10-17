import { Input } from 'tdesign-react';
import { FolderOpenIcon } from 'tdesign-icons-react';
import {
  Briefcase,
  HelpCircle,
  Wrench,
  Code,
  PenLine,
  Image as ImageIcon,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import { APP_CONFIG } from '../config';
import { Model, Agent, PermissionMode } from '../types';
import { ScenarioTemplate, enforcementGap } from '../scenarios';
import { AgentAvatar } from './AgentAvatar';

/** 场景图标键 → lucide 组件。数据层只存字符串键，映射留在 UI（避免数据耦合 UI 库） */
const SCENARIO_ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  'help-circle': HelpCircle,
  wrench: Wrench,
  code: Code,
  'pen-line': PenLine,
  image: ImageIcon,
};

interface NewChatViewProps {
  agents: Agent[];
  models: Model[];
  selectedModel: string;
  newChatAgentId: string;
  newChatCwd: string;
  newChatPermissionMode: PermissionMode;
  /** P4：场景模板（6 个） */
  scenarios: ScenarioTemplate[];
  /** P4：当前选中的场景 id（未选 = undefined，走「自定义」） */
  selectedScenarioId?: string;
  onSelectModel: (modelId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onSetCwd: (cwd: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  /** P4：选中/取消场景。传 undefined 表示回到「不选场景」 */
  onSelectScenario: (scenarioId: string | undefined) => void;
}

export function NewChatView({
  agents,
  newChatAgentId,
  newChatCwd,
  scenarios,
  selectedScenarioId,
  onSelectAgent,
  onSetCwd,
  onSetPermissionMode,
  onSelectScenario,
}: NewChatViewProps) {
  const selectedAgent = agents.find(a => a.id === newChatAgentId);
  const selectedScenario = scenarios.find(s => s.id === selectedScenarioId);
  // P4-5：场景要求的权限约束，当前 Agent 是否真的能强制。落不了地就如实说出来。
  const permissionGap = enforcementGap(selectedScenario, selectedAgent?.permissionSupport);

  return (
    // 内容可能比可视区高（6 张场景卡 + 6 个 Agent + 预览块），而外层是固定高度的
    // flex 容器。原来只有 `justify-center h-full`，超出部分会被**上下同时裁掉**
    // 且无法滚动 —— 实测标题被切、预览块被输入框盖住（警告因此看不见）。
    // 修法：外层负责滚动，内层 `min-h-full` + 居中 —— 内容短时居中，长时可从头滚到底。
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col items-center justify-center min-h-full py-8">
        <div className="w-full max-w-lg">
        {/* Logo 和标题 */}
        <div className="text-center mb-8">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 shadow-popup mx-auto"
            style={{
              background: 'linear-gradient(135deg, var(--td-brand-color), var(--td-brand-color-hover))'
            }}
          >
            <span className="text-3xl font-bold text-white">{APP_CONFIG.nameInitial}</span>
          </div>
          <h2
            className="text-2xl font-semibold mb-2"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {APP_CONFIG.name}
          </h2>
          <p style={{ color: 'var(--td-text-color-secondary)' }}>
            选择一个 Agent 开始对话
          </p>
        </div>

        {/* 场景（P4）：选一个场景会预置提示词、推荐 Agent 与权限模式 */}
        <div className="mb-6">
          <div className="flex items-baseline justify-between mb-3">
            <label className="block text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              场景
            </label>
            <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {selectedScenario ? '再点一次可取消，回到自定义' : '可选，不选则直接挑 Agent'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {scenarios.map(s => {
              const isSelected = s.id === selectedScenarioId;
              const Icon = SCENARIO_ICONS[s.icon];
              return (
                <button
                  key={s.id}
                  type="button"
                  data-scenario={s.id}
                  onClick={() => onSelectScenario(isSelected ? undefined : s.id)}
                  title={s.description}
                  className="flex flex-col items-start gap-1.5 rounded-xl border-2 p-2.5 text-left transition-all"
                  style={{
                    borderColor: isSelected ? s.color : 'transparent',
                    backgroundColor: isSelected ? `${s.color}14` : 'var(--td-bg-color-component)',
                  }}
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${s.color}1f`, color: s.color }}
                  >
                    {Icon ? <Icon size={15} /> : null}
                  </span>
                  <span className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                    {s.label}
                  </span>
                  <span className="text-caption leading-snug" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {s.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent 选择 */}
        <div className="mb-6">
          <label className="block text-body-lg font-medium mb-3" style={{ color: 'var(--td-text-color-primary)' }}>
            选择 Agent
          </label>
          <div className="grid grid-cols-2 gap-3 max-h-[280px] overflow-y-auto">
            {agents.map(agent => {
              const isSelected = agent.id === newChatAgentId;
              return (
                <div
                  key={agent.id}
                  data-agent={agent.id}
                  className="p-3 rounded-xl cursor-pointer transition-all border-2"
                  style={{
                    borderColor: isSelected ? 'var(--td-brand-color)' : 'transparent',
                    backgroundColor: isSelected ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-component)',
                  }}
                  onClick={() => {
                    onSelectAgent(agent.id);
                    // 自动应用 Agent 的默认权限模式
                    if (agent.permissionMode) {
                      onSetPermissionMode(agent.permissionMode);
                    }
                  }}
                >
                  <div className="flex items-center gap-3">
                    {/* 用 AgentAvatar 而非 lucide 通用图标：
                        这里和通讯录、会话列表展示的是同一批 Agent，
                        图标语言必须一致，否则「选 Agent」的卡片看起来像另一个 App。 */}
                    <AgentAvatar
                      id={agent.id}
                      name={agent.name}
                      icon={agent.icon}
                      color={agent.color}
                      size={40}
                      showStatus={false}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-body-lg font-medium truncate" style={{ color: 'var(--td-text-color-primary)' }}>
                        {agent.name}
                      </div>
                      {agent.description && (
                        <div className="text-secondary truncate mt-0.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
                          {agent.description}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/*
          P4-5：权限约束落不了地时的如实提示。
          放在 Agent 选择区**之后、工作目录之前**，是为了让它落在首屏可见范围内 ——
          早先放在底部预览卡片里，实测会被输入框盖住，等于没提示。
          data 属性供验证脚本定位。
        */}
        {permissionGap && (
          <div
            data-permission-gap
            className="mb-6 flex items-start gap-1.5 rounded-lg px-3 py-2 text-caption"
            style={{
              backgroundColor: 'rgba(227, 115, 24, 0.08)',
              color: '#8A4B00',
              border: '1px solid rgba(227, 115, 24, 0.28)',
            }}
          >
            <AlertTriangle size={14} className="mt-[1px] flex-shrink-0" />
            <span>{permissionGap}</span>
          </div>
        )}

        {/* 工作目录 */}
        <div className="mb-6">
          <label className="block text-body-lg font-medium mb-2" style={{ color: 'var(--td-text-color-primary)' }}>
            工作目录{' '}
            {selectedScenario?.needsCwd ? (
              <span style={{ color: 'var(--td-error-color)' }}>（该场景建议填写）</span>
            ) : (
              <span style={{ color: 'var(--td-text-color-placeholder)' }}>(可选)</span>
            )}
          </label>
          <Input
            value={newChatCwd}
            onChange={(v) => onSetCwd(v as string)}
            placeholder="例如：/Users/username/projects/my-app"
            prefixIcon={<FolderOpenIcon />}
          />
          <p className="text-secondary mt-1.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {selectedScenario?.needsCwd
              ? '该场景会读写文件 / 执行命令，请指定它可作业的目录'
              : '指定 Agent 的工作目录，用于文件操作等'}
          </p>
        </div>

        {/* 选中的场景 / Agent 预览 */}
        {(selectedScenario || selectedAgent) && (
          <div
            className="p-4 rounded-xl"
            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
          >
            {selectedScenario && (
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="rounded px-1.5 py-[2px] text-caption"
                  style={{ backgroundColor: `${selectedScenario.color}1f`, color: selectedScenario.color }}
                >
                  {selectedScenario.label}场景
                </span>
                <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {selectedScenario.description}
                </span>
              </div>
            )}
            {selectedAgent && (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <AgentAvatar
                    id={selectedAgent.id}
                    name={selectedAgent.name}
                    icon={selectedAgent.icon}
                    color={selectedAgent.color}
                    size={24}
                    showStatus={false}
                  />
                  <span className="text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                    {selectedAgent.name}
                  </span>
                </div>
                <p className="text-secondary line-clamp-2" style={{ color: 'var(--td-text-color-secondary)' }}>
                  {selectedScenario?.systemPrompt || selectedAgent.systemPrompt}
                </p>
              </>
            )}
          </div>
        )}

        {/* 提示文字 */}
        <p className="text-center text-secondary mt-6" style={{ color: 'var(--td-text-color-placeholder)' }}>
          模型和权限模式可在输入框下方切换
        </p>
        </div>
      </div>
    </div>
  );
}
