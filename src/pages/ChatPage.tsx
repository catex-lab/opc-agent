import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
/*
 * 注意：chat 组件库的样式**不在这里引**，统一放在 main.tsx。
 * 在这里引会让 TDesign 的 :root 变量随懒加载后注入，把首屏的品牌色盖掉。
 */
import {
  Model,
  Session,
  Message,
  PermissionMode,
  CustomAgent,
  PermissionRequest,
  RegisteredAgent,
  OrchestrationMode,
} from '../types';
import { NewChatView } from '../components/NewChatView';
import { SCENARIOS, getScenario } from '../scenarios';
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_SIZE } from '../imageOptions';
import { ChatMessages } from '../components/ChatMessages';
import { ChatInput } from '../components/ChatInput';
import { GroupChatHeader } from '../components/GroupChatHeader';
import { useGroupChat } from '../hooks/useGroupChat';

interface ChatPageProps {
  currentSession: Session | undefined;
  models: Model[];
  selectedModel: string;
  agents: CustomAgent[];
  /** 当前会话绑定的 Agent（用于消息流里的官方头像） */
  currentAgent?: RegisteredAgent;
  /** 按 id 反查注册表条目；群聊消息流里每个气泡各查自己的作者 */
  getAgent: (id: string) => RegisteredAgent | undefined;
  /** 当前会话 id（群聊 hook 需要） */
  currentSessionId: string | null;
  /** 追加/合并一条群聊消息 */
  upsertGroupMessage: (sessionId: string, message: Message) => void;
  isLoading: boolean;
  inputValue: string;
  permissionRequest: PermissionRequest | null;
  permissionMode: PermissionMode;
  onSendMessage: (message: string, newChatOptions?: NewChatOptions, onNavigate?: (path: string) => void) => void;
  onStop: () => void;
  onInputChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onPermissionAllow: () => void;
  onPermissionDeny: () => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** 群聊：改编排模式（本地 + PATCH 后端） */
  onOrchestrationChange: (mode: OrchestrationMode) => void;
  /** 群聊：改成员（本地 + PATCH 后端） */
  onMembersChange: (agentIds: string[]) => void;
  onDelete: () => void;
}

interface NewChatOptions {
  /** 仅新建会话时使用；既有会话传 `{ imageSize }` 即可（见 useChat 的注释） */
  agentId?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  /** P4：场景模板 id / 会话级 systemPrompt（可选，由场景入口预置） */
  scenarioId?: string;
  systemPrompt?: string;
  /** P4-4：生图尺寸 / 模型（仅生图场景生效） */
  imageSize?: string;
  imageModel?: string;
}

export function ChatPage({
  currentSession,
  models,
  selectedModel,
  agents,
  currentAgent,
  getAgent,
  currentSessionId,
  upsertGroupMessage,
  isLoading,
  inputValue,
  permissionRequest,
  permissionMode,
  onSendMessage,
  onStop,
  onInputChange,
  onModelChange,
  onPermissionAllow,
  onPermissionDeny,
  onPermissionModeChange,
  onOrchestrationChange,
  onMembersChange,
  onDelete,
}: ChatPageProps) {
  const navigate = useNavigate();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 新对话页面状态
  const [newChatAgentId, setNewChatAgentId] = useState('default');
  const [newChatCwd, setNewChatCwd] = useState('');
  // P4：选中的场景 id。选场景会预置推荐 Agent 与权限模式
  const [newChatScenarioId, setNewChatScenarioId] = useState<string | undefined>(undefined);
  // P4-4：生图选项。**跨场景保留** —— 用户在生图会话里挑了竖版，
  // 切去别的会话再回来，不该被重置回正方形。
  const [imageSize, setImageSize] = useState<string>(DEFAULT_IMAGE_SIZE);
  const [imageModel, setImageModel] = useState<string>(DEFAULT_IMAGE_MODEL);

  /** 选中/取消场景：预置推荐 Agent 与权限模式（用户随后仍可改） */
  const handleSelectScenario = useCallback(
    (scenarioId: string | undefined) => {
      setNewChatScenarioId(scenarioId);
      const sc = getScenario(scenarioId);
      if (sc) {
        if (sc.recommendedAgentId) setNewChatAgentId(sc.recommendedAgentId);
        onPermissionModeChange(sc.permissionMode);
      }
    },
    [onPermissionModeChange]
  );

  const isGroup = currentSession?.kind === 'group';
  const memberIds = currentSession?.agentIds ?? [];
  const orchestration = currentSession?.orchestration ?? 'dispatch';

  /**
   * 生图模式：会话已绑定生图场景，或在新对话页选中了生图场景。
   *
   * 判据用**场景**而不是 Agent：生图是独立 provider，与会话绑定的 Agent
   * 无关（场景推荐 hermes 只是因为它声明了 image 能力）。用 Agent 判断会
   * 让「在 hermes 会话里问代码问题」也走进生图通道。
   */
  const imageMode = currentSession?.scenarioId === 'image' || newChatScenarioId === 'image';

  /** 群聊成员（反查注册表拿头像/名字/在线状态） */
  const groupMembers = useMemo(
    () => memberIds.map(id => getAgent(id)).filter((a): a is RegisteredAgent => !!a),
    [memberIds, getAgent]
  );
  const onlineCount = useMemo(
    () => groupMembers.filter(m => m.status.availability === 'ready').length,
    [groupMembers]
  );

  // 群聊自己的发送通道：多 Agent、按编排模式调度，与一对一的 useChat 分开
  const group = useGroupChat({
    currentSessionId: currentSession?.id ?? null,
    agentIds: memberIds,
    orchestration,
    upsertMessage: msg => {
      if (!currentSessionId) return;
      upsertGroupMessage(currentSessionId, msg);
    },
    onOrchestrationSync: mode => onOrchestrationChange(mode),
  });

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  // 处理发送消息
  const handleSend = useCallback((message: string) => {
    if (!currentSession) {
      // 新对话
      onSendMessage(message, {
        agentId: newChatAgentId,
        cwd: newChatCwd,
        permissionMode: permissionMode,
        // P4：把场景注入的 systemPrompt 一并带出，落库并优先于 Agent 自带
        scenarioId: newChatScenarioId,
        systemPrompt: getScenario(newChatScenarioId)?.systemPrompt,
        // P4-4：生图选项（非生图场景会被后端忽略）
        imageSize,
        imageModel,
      }, (path) => {
        // 重置新对话选项
        setNewChatAgentId('default');
        setNewChatCwd('');
        setNewChatScenarioId(undefined);
        navigate(path);
      });
    } else if (isGroup) {
      // 群聊走自己的编排端点
      void group.sendGroupMessage(message);
    } else if (imageMode) {
      // 既有生图会话：只需带尺寸/模型，其余由会话自身决定
      onSendMessage(message, { imageSize, imageModel });
    } else {
      onSendMessage(message);
    }
  }, [
    currentSession,
    isGroup,
    imageMode,
    imageSize,
    imageModel,
    newChatAgentId,
    newChatCwd,
    newChatScenarioId,
    permissionMode,
    onSendMessage,
    group.sendGroupMessage,
    navigate,
  ]);

  const handleStop = isGroup ? undefined : onStop;
  const loading = isGroup ? group.isLoading : isLoading;

  const showNewChatView =
    !currentSession || (currentSession.messages.length === 0 && !isGroup);

  // 指定模式下的提示：不 @ 任何人就没人会被唤醒
  const mentionHint =
    orchestration === 'mention' && groupMembers.length > 1
      ? '当前为「指定」模式：只有被 @ 到的成员会发言，不 @ 则无人应答'
      : undefined;

  return (
    <>
      {/* 群聊头部：成员头像堆叠 + 编排模式切换，替代一对一的单人头部 */}
      {isGroup && currentSession && (
        <GroupChatHeader
          title={currentSession.title || '群聊'}
          members={groupMembers}
          onlineCount={onlineCount}
          orchestration={orchestration}
          onOrchestrationChange={onOrchestrationChange}
          onDelete={onDelete}
        />
      )}

      {/* 消息区域 */}
      <div className="flex-1 overflow-y-auto p-6">
        {showNewChatView ? (
          <NewChatView
            agents={agents}
            models={models}
            selectedModel={selectedModel}
            newChatAgentId={newChatAgentId}
            newChatCwd={newChatCwd}
            newChatPermissionMode={permissionMode}
            scenarios={SCENARIOS}
            selectedScenarioId={newChatScenarioId}
            onSelectModel={onModelChange}
            onSelectAgent={setNewChatAgentId}
            onSetCwd={setNewChatCwd}
            onSetPermissionMode={onPermissionModeChange}
            onSelectScenario={handleSelectScenario}
          />
        ) : (
          <ChatMessages
            messages={currentSession!.messages}
            models={models}
            messagesEndRef={messagesEndRef}
            getAgent={getAgent}
            agent={currentAgent}
            groupMode={isGroup}
            imageMode={imageMode}
            permissionRequest={isGroup ? group.permissionRequest : permissionRequest}
            onPermissionAllow={onPermissionAllow}
            onPermissionDeny={onPermissionDeny}
          />
        )}
      </div>

      {/* 输入区域 */}
      <ChatInput
        inputValue={inputValue}
        selectedModel={selectedModel}
        models={models}
        isLoading={loading}
        permissionMode={permissionMode}
        onSend={handleSend}
        onStop={handleStop ?? onStop}
        onChange={onInputChange}
        onModelChange={onModelChange}
        onPermissionModeChange={onPermissionModeChange}
        // 群聊：成员 chip 条 + 不用选单一模型
        mentionMembers={isGroup ? groupMembers : undefined}
        mentionHint={mentionHint}
        // P4-4：生图模式（输入区切成「描述 → 生图」）
        imageMode={imageMode}
        imageSize={imageSize}
        imageModel={imageModel}
        onImageSizeChange={setImageSize}
        onImageModelChange={setImageModel}
      />
    </>
  );
}
