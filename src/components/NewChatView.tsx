import type { CSSProperties } from 'react';
import { Input, Select, Tooltip } from 'tdesign-react';
import { Briefcase, HelpCircle, Wrench, Code, PenLine, Image as ImageIcon, type LucideIcon, ChevronDown, FolderOpen } from 'lucide-react';
import { APP_CONFIG } from '../config';
import { Model, Agent, PermissionMode } from '../types';
import { ScenarioTemplate, enforcementGap } from '../scenarios';
import { AgentAvatar } from './AgentAvatar';
import { PermissionGapNotice } from './PermissionGapNotice';
import { InfoHint } from './InfoHint';
import { pickDirectory, hasNativeDialogs } from '../workspace';
import { useTranslation, type MessageKey } from '../i18n';

/** 场景数据仍是中文常量（服务端与门禁在用），界面按 id 取本地化文案 */
const SCENARIO_TEXT: Record<string, { label: MessageKey; desc: MessageKey }> = {
  work: { label: 'chat.scenario.work', desc: 'chat.scenario.workDesc' },
  qa: { label: 'chat.scenario.qa', desc: 'chat.scenario.qaDesc' },
  dev: { label: 'chat.scenario.dev', desc: 'chat.scenario.devDesc' },
  code: { label: 'chat.scenario.code', desc: 'chat.scenario.codeDesc' },
  write: { label: 'chat.scenario.write', desc: 'chat.scenario.writeDesc' },
  image: { label: 'chat.scenario.image', desc: 'chat.scenario.imageDesc' },
};

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
  /** A62：新对话的思考强度档位（`''` = 用 CLI 默认） */
  newChatReasoning?: string;
  newChatPermissionMode: PermissionMode;
  /** P4：场景模板（6 个） */
  scenarios: ScenarioTemplate[];
  /** P4：当前选中的场景 id（未选 = undefined，走「自定义」） */
  selectedScenarioId?: string;
  onSelectModel: (modelId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onSetCwd: (cwd: string) => void;
  /** A62：改新对话的思考强度档位 */
  onSetReasoning?: (value: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  /** P4：选中/取消场景。传 undefined 表示回到「不选场景」 */
  onSelectScenario: (scenarioId: string | undefined) => void;
}

export function NewChatView({
  agents,
  models,
  selectedModel,
  newChatAgentId,
  newChatCwd,
  newChatReasoning = '',
  scenarios,
  selectedScenarioId,
  onSelectAgent,
  onSetCwd,
  onSetReasoning,
  onSetPermissionMode,
  onSelectScenario,
}: NewChatViewProps) {
  const { t } = useTranslation();
  const selectedAgent = agents.find(a => a.id === newChatAgentId);
  const selectedScenario = scenarios.find(s => s.id === selectedScenarioId);
  /**
   * A62：当前选中模型的思考强度档位表。
   *
   * 没有档位表时**整个区块不渲染** —— 新对话页同样不摆假控件。
   * 模型由 Agent 决定（models 为空）时自然也没有。
   */
  const reasoningOfModel = selectedModel
    ? models.find(m => m.modelId === selectedModel)?.reasoning
    : undefined;
  const reasoningLevels = reasoningOfModel && reasoningOfModel.levels.length > 0
    ? reasoningOfModel.levels
    : null;
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
        {/* 标题 */}
        <div className="text-center mb-8">
          <h2
            className="text-display font-semibold mb-2"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {APP_CONFIG.name}
          </h2>
          <p style={{ color: 'var(--td-text-color-secondary)' }}>
            {t('chat.new.subtitle')}
          </p>
        </div>

        {/* 场景（P4）：选一个场景会预置提示词、推荐 Agent 与权限模式 */}
        <div className="mb-6">
          <div className="flex items-baseline justify-between mb-3">
            <label className="block text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {t('chat.new.scenario')}
            </label>
            <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {selectedScenario ? t('chat.new.scenarioSelectedHint') : t('chat.new.scenarioOptionalHint')}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {scenarios.map(s => {
              const isSelected = s.id === selectedScenarioId;
              const Icon = SCENARIO_ICONS[s.icon];
              return (
                <button
                  key={s.id}
                  type="button"
                  data-scenario={s.id}
                  onClick={() => onSelectScenario(isSelected ? undefined : s.id)}
                  title={SCENARIO_TEXT[s.id] ? t(SCENARIO_TEXT[s.id].desc) : s.description}
                  className={`tc-choice-card flex flex-col items-start gap-1.5 p-2.5 text-left${isSelected ? ' is-selected' : ''}`}
                  style={
                    isSelected
                      ? {
                          /* A159：场景色是 var(--tc-scn-*)，不能再拼 `${color}14` */
                          borderColor: s.color,
                          backgroundColor: `color-mix(in srgb, ${s.color} 8%, transparent)`,
                        }
                      : undefined
                  }
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${s.color} 12%, transparent)`,
                      color: s.color,
                    }}
                  >
                    {Icon ? <Icon size={15} /> : null}
                  </span>
                  <span className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                    {SCENARIO_TEXT[s.id] ? t(SCENARIO_TEXT[s.id].label) : s.label}
                  </span>
                  <span className="text-caption leading-snug" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {SCENARIO_TEXT[s.id] ? t(SCENARIO_TEXT[s.id].desc) : s.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent 选择 */}
        <div className="mb-6">
          <label className="block text-body-lg font-medium mb-3" style={{ color: 'var(--td-text-color-primary)' }}>
            {t('chat.new.chooseAgent')}
          </label>
          {/* A83：Agent 数量不固定（奇数时固定两列会剩一张孤卡）。
              换成 .tc-cards：换行后最后一行自动撑满，孤卡变成一张宽卡。
              240px 是「能放下头像 + 名字 + 一句描述」的下限。 */}
          <div
            className="tc-cards max-h-[280px] overflow-y-auto"
            style={{ '--tc-card-min': '240px' } as CSSProperties}
          >
            {agents.map(agent => {
              const isSelected = agent.id === newChatAgentId;
              return (
                <button
                  key={agent.id}
                  type="button"
                  data-agent={agent.id}
                  aria-pressed={isSelected}
                  className={`tc-choice-card block w-full p-3 text-left${isSelected ? ' is-selected' : ''}`}
                  style={
                    isSelected
                      ? { borderColor: 'var(--td-brand-color)', backgroundColor: 'var(--td-brand-color-light)' }
                      : undefined
                  }
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
                      src={agent.logoUrl}
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
                </button>
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
        <PermissionGapNotice message={permissionGap} />

        {/* 工作目录 */}
        <div className="mb-6">
          <label className="block text-body-lg font-medium mb-2" style={{ color: 'var(--td-text-color-primary)' }}>
            {t('chat.new.workspace')}{' '}
            {selectedScenario?.needsCwd ? (
              <span style={{ color: 'var(--td-error-color)' }}>{t('chat.new.workspaceRequired')}</span>
            ) : (
              <span style={{ color: 'var(--td-text-color-placeholder)' }}>{t('chat.new.optional')}</span>
            )}
          </label>
          <div className="flex items-center gap-2">
            <Input
              value={newChatCwd}
              onChange={(v) => onSetCwd(v as string)}
              placeholder={t('chat.new.cwdPlaceholder')}
              prefixIcon={<FolderOpen />}
            />
            {/*
              A63：选择目录按钮（与会话栏头工作区面板的「切换目录」同一颗
              原生对话框，见 workspace.ts / electron preload）。

              条件渲染而不是「摆了但禁用」：浏览器开发态没有原生对话框，
              按钮点了不会有任何反应 —— 那正是假控件。开发态保留左边
              的输入框（手动填 / 粘贴路径），能力一分不少。
            */}
            {hasNativeDialogs() && (
              <button
                type="button"
                onClick={() => void pickDirectory().then(picked => {
                  if (picked) onSetCwd(picked);
                })}
                className="flex h-[34px] flex-shrink-0 items-center gap-1.5 rounded-lg px-3 text-body transition-colors"
                style={{
                  border: '1px solid var(--td-component-border)',
                  color: 'var(--td-text-color-primary)',
                  backgroundColor: 'var(--td-bg-color-container)',
                }}
                data-newchat-pick-dir
              >
                <FolderOpen />
                {t('chat.new.pickDir')}
              </button>
            )}
          </div>
          <p className="text-secondary mt-1.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {selectedScenario?.needsCwd
              ? t('chat.new.cwdRequiredHint')
              : t('chat.new.cwdHint')}
          </p>
        </div>

        {/*
          A62：思考强度。紧跟工作目录之后 —— 两者都是「这一轮怎么跑」的前置设置。

          只在该模型真有档位表时出现（见上面 reasoningLevels 的派生规则）。
          「默认」= 不显式传参，用 CLI 自己的默认档位，它不是第 0 档，
          所以单独列在档位列表外面。
          data 属性供验证脚本定位。
        */}
        {reasoningLevels && onSetReasoning && (
          <div className="mb-6" data-reasoning-select>
            <label
              className="mb-2 flex items-center gap-1.5 text-body-lg font-medium"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {t('chat.new.reasoning')} <span style={{ color: 'var(--td-text-color-placeholder)' }}>{t('chat.new.optional')}</span>
              <InfoHint
                label={t('chat.new.reasoningHintLabel')}
                text={t('chat.new.reasoningHint', { n: reasoningLevels.length })}
              />
            </label>
            <Tooltip
              content={
                reasoningOfModel?.defaultLevel
                  ? t('chat.input.reasoningDefaultLevel', { level: reasoningLevels.find(l => l.value === reasoningOfModel.defaultLevel)?.label ?? reasoningOfModel.defaultLevel })
                  : t('chat.input.reasoningDefaultHint')
              }
              placement="top"
            >
              <Select
                value={newChatReasoning}
                onChange={(v) => onSetReasoning(v as string)}
                size="medium"
                style={{ width: '100%' }}
                suffixIcon={<ChevronDown />}
                /* A74：触发器占满表单宽度（512px），但浮层不能跟着那么宽 ——
                   TDesign 的 dropdown 默认与触发器同宽，实测会得到一条 512px 的
                   下拉里只放「低 / 快」几个字，右边整片留白。这里把浮层宽度钉到
                   260px，内容（档位名 + 一句说明）刚好排得下。 */
                popupProps={{ overlayInnerStyle: { width: 260, padding: '6px 4px' } }}
              >
                <Select.Option value="" label={t('chat.input.default')}>
                  <div className="flex items-center gap-2 py-0.5">
                    <span className="text-body leading-5">{t('chat.input.default')}</span>
                    <span
                      className="text-caption leading-4"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      {t('chat.input.defaultOptionHint')}
                    </span>
                  </div>
                </Select.Option>
                {reasoningLevels.map(level => (
                  <Select.Option key={level.value} value={level.value} label={level.label}>
                    <div className="flex w-full min-w-0 flex-col py-0.5">
                      <span className="text-body leading-5">{level.label}</span>
                      {level.description && (
                        <span
                          className="text-caption leading-4 truncate"
                          style={{ color: 'var(--td-text-color-secondary)' }}
                        >
                          {level.description}
                        </span>
                      )}
                    </div>
                  </Select.Option>
                ))}
              </Select>
            </Tooltip>
          </div>
        )}

        {/* 选中的场景 / Agent 预览 */}
        {(selectedScenario || selectedAgent) && (
          <div className="tc-card tc-card--lg p-4">
            {selectedScenario && (
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="rounded px-1.5 py-[2px] text-caption"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${selectedScenario.color} 12%, transparent)`,
                    color: selectedScenario.color,
                  }}
                >
                  {SCENARIO_TEXT[selectedScenario.id]
                    ? t(SCENARIO_TEXT[selectedScenario.id].label)
                    : selectedScenario.label}{t('chat.new.scenarioSuffix')}
                </span>
                <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {SCENARIO_TEXT[selectedScenario.id] ? t(SCENARIO_TEXT[selectedScenario.id].desc) : selectedScenario.description}
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
                    src={selectedAgent.logoUrl}
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
          {t('chat.new.switchHint')}
        </p>
        </div>
      </div>
    </div>
  );
}
