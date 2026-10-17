import { useRef, useCallback } from 'react';
import { Select, Tooltip } from 'tdesign-react';
import { ChatSender } from '@tdesign-react/chat';
import { ChevronDownIcon, LockOnIcon, LockOffIcon, EditIcon, TaskIcon } from 'tdesign-icons-react';
import { Model, PermissionMode, RegisteredAgent } from '../types';
import { IMAGE_SIZES, IMAGE_SIZE_LABELS, IMAGE_MODELS } from '../imageOptions';

interface ChatInputProps {
  inputValue: string;
  selectedModel: string;
  models: Model[];
  isLoading: boolean;
  permissionMode: PermissionMode;
  onSend: (message: string) => void;
  onStop: () => void;
  onChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /**
   * 群聊成员。传了就在输入框上方渲染 `@` 成员条，并把模型选择器换成
   * 「模型由 Agent 决定」—— 群聊没有单一模型，每个成员各自解析。
   */
  mentionMembers?: RegisteredAgent[];
  /** 群聊的补充提示（如「指定模式下只会唤醒被 @ 的成员」） */
  mentionHint?: string;
  /**
   * P4-4：生图模式。
   *
   * 开启后输入区语义从「发消息」变成「描述 → 生成图像」：
   * 占位符改写，底部的模型/权限选择器换成生图模型与尺寸 ——
   * 权限模式对一次无状态 HTTP 调用毫无意义，留着只会让人以为它能控制什么。
   */
  imageMode?: boolean;
  imageSize?: string;
  imageModel?: string;
  onImageSizeChange?: (size: string) => void;
  onImageModelChange?: (model: string) => void;
}

// 权限模式配置
const PERMISSION_MODE_CONFIG: Record<PermissionMode, { 
  label: string; 
  shortLabel: string;
  icon: React.ReactNode; 
  color: string;
  description: string;
}> = {
  'default': { 
    label: '默认模式', 
    shortLabel: '默认',
    icon: <LockOnIcon />, 
    color: '#1f1f1f',
    description: '每次操作都需要确认'
  },
  'acceptEdits': { 
    label: '自动编辑', 
    shortLabel: '自动编辑',
    icon: <EditIcon />, 
    color: '#2ba471',
    description: '自动允许文件编辑操作'
  },
  'plan': { 
    label: '仅规划', 
    shortLabel: '仅规划',
    icon: <TaskIcon />, 
    color: '#ed7b2f',
    description: '只生成计划，不执行操作'
  },
  'bypassPermissions': { 
    label: '全部允许', 
    shortLabel: '全部允许',
    icon: <LockOffIcon />, 
    color: '#e34d59',
    description: '跳过所有权限确认（危险）'
  },
};

export function ChatInput({
  inputValue,
  selectedModel,
  models,
  isLoading,
  permissionMode,
  onSend,
  onStop,
  onChange,
  onModelChange,
  onPermissionModeChange,
  mentionMembers,
  mentionHint,
  imageMode = false,
  imageSize,
  imageModel,
  onImageSizeChange,
  onImageModelChange,
}: ChatInputProps) {
  const chatSenderRef = useRef<any>(null);

  const isGroup = !!mentionMembers;

  /**
   * 是否必须选中模型才能发送。
   * 只有当该 Agent 确实提供模型列表时才成立；自管模型的 Agent（models 为空）
   * 不应因为没有 selectedModel 就被禁言。群聊同理：没有单一模型可选。
   * 生图模式也不适用 —— 它压根不用文本模型。
   */
  const modelRequired = !isGroup && !imageMode && models.length > 0;

  /**
   * 插入一次 @ 提及。
   *
   * 追加到末尾而不是按光标插入：ChatSender 的 textarea 在 shadow DOM 里，
   * 拿不到可靠的光标位置，硬插会把文字打到用户预料之外的地方。
   * 追加是可预期的，且后端 `extractMentioned` 只做正则匹配、不关心位置。
   */
  const insertMention = useCallback(
    (name: string) => {
      const at = `@${name} `;
      // 已经 @ 过就不再重复插
      const re = new RegExp(`@\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
      if (re.test(inputValue)) return;
      const base = inputValue.length && !inputValue.endsWith(' ') ? `${inputValue} ` : inputValue;
      onChange(`${base}${at}`);
    },
    [inputValue, onChange]
  );

  const handleSend = useCallback((e: any) => {
    const content = e?.detail?.message || e?.detail || e?.message || inputValue;
    if (content && typeof content === 'string' && content.trim() && (!modelRequired || selectedModel)) {
      onSend(content.trim());
    } else if (inputValue.trim() && (!modelRequired || selectedModel)) {
      onSend(inputValue.trim());
    }
  }, [inputValue, selectedModel, modelRequired, onSend]);

  const handleChange = useCallback((e: any) => {
    const value = e?.detail ?? e ?? '';
    onChange(typeof value === 'string' ? value : '');
  }, [onChange]);

  const currentModeConfig = PERMISSION_MODE_CONFIG[permissionMode];

  const selectedModelName = models.find(m => m.modelId === selectedModel)?.name || '选择模型';

  return (
    <div
      className="px-4 pb-6 pt-4"
      style={{
        backgroundColor: 'var(--tc-surface-content)'
      }}
    >
      <div className="max-w-3xl mx-auto">
        {/*
          群聊成员条。
          放在发送器**上方**而不是塞进 footer-prefix：成员是「这次要 @ 谁」，
          属于内容前置信息，和「权限模式」这种会话级设置不是一层。
          成员多时允许换行，不滚动 —— 换行是可预期的，横向滚动会藏人。
        */}
        {isGroup && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              @ 成员
            </span>
            {mentionMembers!.map(m => {
              // 已提过的成员高亮：告诉用户「这个人已经被叫上了」。
              // 后端 extractMentioned 同时认 id 和展示名，这里也必须都认，
              // 否则用户 @hermes 之后 chips 不高亮，会以为没生效。
              const esc = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const escId = m.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const used =
                new RegExp(`@\\s*${esc}(?![\\w-])`, 'i').test(inputValue) ||
                (m.id !== m.name && new RegExp(`@\\s*${escId}(?![\\w-])`, 'i').test(inputValue));
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => insertMention(m.name)}
                  title={`在输入框中 @ ${m.name}`}
                  className="flex items-center gap-1 rounded-full px-2 py-[3px] text-caption transition-opacity hover:opacity-80"
                  style={{
                    backgroundColor: used ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-secondarycontainer)',
                    color: used ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: used ? 'var(--td-brand-color)' : 'var(--td-text-color-placeholder)' }}
                  />
                  {m.name}
                </button>
              );
            })}
          </div>
        )}

        {isGroup && mentionHint && (
          <div
            className="mb-2 rounded-lg px-2.5 py-1.5 text-caption"
            style={{
              backgroundColor: 'var(--td-bg-color-secondarycontainer)',
              color: 'var(--td-text-color-secondary)',
            }}
          >
            {mentionHint}
          </div>
        )}

        <ChatSender
          ref={chatSenderRef}
          value={inputValue}
          placeholder={imageMode ? '描述你想生成的图像...' : '输入消息...'}
          disabled={modelRequired && !selectedModel}
          loading={isLoading}
          autosize={{ minRows: 1, maxRows: 6 }}
          actions={['send']}
          onSend={handleSend}
          onStop={onStop}
          onChange={handleChange}
        >
          {/* 模型选择器和权限模式选择器放在 footer-prefix 插槽 */}
          <div slot="footer-prefix" className="flex flex-wrap items-center gap-2">
            {imageMode ? (
              <>
                {/* 生图模型：默认 CogView-3-Flash（本机实测唯一免费可用） */}
                <Select
                  value={imageModel}
                  onChange={(value) => onImageModelChange?.(value as string)}
                  placeholder="生图模型"
                  size="medium"
                  style={{ width: 190 }}
                  suffixIcon={<ChevronDownIcon />}
                  popupProps={{
                    overlayClassName: 'image-model-select-popup',
                    overlayInnerStyle: { width: 250, padding: '6px 4px' },
                  }}
                >
                  {IMAGE_MODELS.map(m => (
                    <Select.Option key={m.id} value={m.id} label={m.name}>
                      <div className="flex flex-col py-0.5">
                        <span className="text-body font-medium leading-5">{m.name}</span>
                        {m.note && (
                          <span
                            className="text-caption leading-4 truncate"
                            style={{ color: 'var(--td-text-color-secondary)' }}
                          >
                            {m.note}
                          </span>
                        )}
                      </div>
                    </Select.Option>
                  ))}
                </Select>

                {/* 分隔线 */}
                <div
                  className="h-5 w-px rounded-full"
                  style={{ backgroundColor: 'var(--td-component-stroke)' }}
                />

                {/* 尺寸：方形 / 横版 / 竖版对成图构图影响很大，必须可选 */}
                <Select
                  value={imageSize}
                  onChange={(value) => onImageSizeChange?.(value as string)}
                  placeholder="尺寸"
                  size="medium"
                  style={{ width: 170 }}
                  suffixIcon={<ChevronDownIcon />}
                  popupProps={{
                    overlayClassName: 'image-size-select-popup',
                    overlayInnerStyle: { width: 200, padding: '6px 4px' },
                  }}
                >
                  {IMAGE_SIZES.map(s => (
                    <Select.Option key={s} value={s} label={IMAGE_SIZE_LABELS[s] || s} />
                  ))}
                </Select>
              </>
            ) : (
              <>
            {/*
              模型选择器。
              注意：models 为空表示「该 Agent 自己管模型」——hermes 用自己
              配置里的默认模型，opencode 之外有些 ACP Agent 也不上报列表。
              这时不能把发送键也禁掉（否则 agent 明明在线却发不出消息），
              改成显示一个不可点的说明徽标，诚实地告诉用户模型由 Agent 决定。
            */}
            {models.length > 0 ? (
              <Select
                value={selectedModel}
                onChange={(value) => onModelChange(value as string)}
                placeholder="选择模型"
                size="medium"
                style={{ width: 180 }}
                filterable
                suffixIcon={<ChevronDownIcon />}
                popupProps={{
                  overlayClassName: 'model-select-popup',
                  overlayInnerStyle: { width: 220, padding: '6px 4px' }
                }}
              >
                {models.map(model => (
                  <Select.Option
                    key={model.modelId}
                    value={model.modelId}
                    label={model.name}
                  >
                    <div className="flex flex-col py-0.5">
                      <span className="text-body font-medium leading-5">{model.name}</span>
                      {model.description && (
                        <span
                          className="text-caption leading-4 truncate"
                          style={{ color: 'var(--td-text-color-secondary)' }}
                        >
                          {model.description}
                        </span>
                      )}
                    </div>
                  </Select.Option>
                ))}
              </Select>
            ) : (
              <span
                className="flex items-center rounded-lg px-2.5 py-1.5 text-caption"
                style={{
                  backgroundColor: 'var(--td-bg-color-secondarycontainer)',
                  color: 'var(--td-text-color-placeholder)',
                }}
                title="该 Agent 自行决定使用哪个模型"
              >
                模型由 Agent 决定
              </span>
            )}
            
            {/* 分隔线 */}
            <div 
              className="h-5 w-px rounded-full"
              style={{ backgroundColor: 'var(--td-component-stroke)' }}
            />
            
            {/* 权限模式选择器 */}
            <Tooltip content={currentModeConfig.description} placement="top">
              <Select
                value={permissionMode}
                onChange={(value) => onPermissionModeChange(value as PermissionMode)}
                size="medium"
                style={{ width: 120 }}
                suffixIcon={<ChevronDownIcon />}
                prefixIcon={
                  <span 
                    className="flex items-center justify-center w-5 h-5 rounded-md"
                    style={{ 
                      color: currentModeConfig.color,
                      backgroundColor: `${currentModeConfig.color}15`,
                    }}
                  >
                    {currentModeConfig.icon}
                  </span>
                }
                popupProps={{
                  overlayClassName: 'permission-select-popup',
                  overlayInnerStyle: { width: 160, padding: '6px 4px' }
                }}
              >
                {(Object.keys(PERMISSION_MODE_CONFIG) as PermissionMode[]).map(mode => {
                  const config = PERMISSION_MODE_CONFIG[mode];
                  return (
                    <Select.Option 
                      key={mode} 
                      value={mode} 
                      label={config.shortLabel}
                    >
                      <div className="flex items-center gap-2 py-0.5">
                        <span 
                          className="flex items-center justify-center w-5 h-5 rounded-md shrink-0"
                          style={{ 
                            color: config.color,
                            backgroundColor: `${config.color}15`,
                          }}
                        >
                          {config.icon}
                        </span>
                        <span className="text-body leading-5">{config.shortLabel}</span>
                      </div>
                    </Select.Option>
                  );
                })}
              </Select>
            </Tooltip>
              </>
            )}
          </div>
        </ChatSender>
      </div>
    </div>
  );
}
