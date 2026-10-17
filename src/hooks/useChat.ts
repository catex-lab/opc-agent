import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Message, ToolCall, PermissionRequest, PermissionMode, Session, CustomAgent, ContentBlock, ImageBlock } from '../types';

const STORAGE_KEYS = {
  draftInput: 'draftInput',
};

interface UseChatOptions {
  currentSession: Session | undefined;
  currentSessionId: string | null;
  selectedModel: string;
  getAgent: (id: string) => CustomAgent | undefined;
  addSession: (session: Session) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  updateSessionMessages: (sessionId: string, updater: (messages: Message[]) => Message[]) => void;
  updateSessionModel: (sessionId: string, modelId: string) => void;
  setCurrentSessionId: (id: string | null) => void;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}

interface NewChatOptions {
  /**
   * 以下三项仅在「从新对话页发起第一条消息」时用于建会话。
   * 已是既有会话时调用方只需带 `imageSize` / `imageModel`（生图场景用），
   * 因此这三个字段是可选的 —— 否则调用方得为一次改尺寸而虚构一个 agentId。
   */
  agentId?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  /** P4：场景模板 id（可选，由场景入口预置） */
  scenarioId?: string;
  /** P4：会话级系统提示词（可选，场景注入） */
  systemPrompt?: string;
  /** P4-4：生图尺寸（仅生图场景生效，不传由后端取默认） */
  imageSize?: string;
  /** P4-4：生图模型（仅生图场景生效，不传由后端取默认） */
  imageModel?: string;
}

/** 生图场景的 id。命中它就把发送改道到 `/api/image` */
const IMAGE_SCENARIO_ID = 'image';

export function useChat(options: UseChatOptions) {
  const {
    currentSession,
    currentSessionId,
    selectedModel,
    getAgent,
    updateSessionModel,
    setCurrentSessionId,
    setSessions,
  } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [inputValue, setInputValue] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.draftInput) || '';
  });
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);

  // 保存输入框内容到 localStorage（防抖）
  const saveInput = useCallback((value: string) => {
    setInputValue(value);
  }, []);

  // 发送消息
  const sendMessage = useCallback(async (
    messageContent: string,
    newChatOptions?: NewChatOptions,
    onNavigate?: (path: string) => void
  ) => {
    if (!messageContent.trim() || isLoading) return;

    let sessionId = currentSessionId;
    let currentCwd = currentSession?.cwd;
    let currentAgentId = currentSession?.agentId || 'workbuddy';
    let currentPermissionMode = currentSession?.permissionMode || 'default';
    // P4：会话级（场景注入）的 systemPrompt / scenarioId
    let currentSystemPrompt = currentSession?.systemPrompt;
    let currentScenarioId = currentSession?.scenarioId;
    
    // 如果没有当前会话，使用新对话页面的选项创建新会话
    if (!sessionId && newChatOptions) {
      const requestedAgentId = newChatOptions.agentId || 'workbuddy';
      const selectedAgent = getAgent(requestedAgentId);
      const agentPermissionMode = selectedAgent?.permissionMode || 'default';
      const requestedMode = newChatOptions.permissionMode;
      const finalPermissionMode =
        requestedMode && requestedMode !== 'default' ? requestedMode : agentPermissionMode;
      
      const newSession: Session = {
        id: uuidv4(),
        title: messageContent.slice(0, 30) + (messageContent.length > 30 ? '...' : ''),
        model: selectedModel,
        agentId: requestedAgentId,
        cwd: newChatOptions.cwd || undefined,
        // P4：场景绑定（当前无 UI 提供，字段先打通，P4-3 接上入口）
        scenarioId: newChatOptions.scenarioId || undefined,
        systemPrompt: newChatOptions.systemPrompt || undefined,
        permissionMode: finalPermissionMode,
        createdAt: new Date(),
        messages: [],
        // 本条消息正是落库的触发点，不必再回头 GET 一次
        isLocal: true,
      };
      
      setSessions(prev => [newSession, ...prev]);
      setCurrentSessionId(newSession.id);
      sessionId = newSession.id;
      currentCwd = newSession.cwd;
      currentAgentId = newSession.agentId || 'workbuddy';
      currentPermissionMode = newSession.permissionMode || 'default';
      currentSystemPrompt = newSession.systemPrompt;
      currentScenarioId = newSession.scenarioId;
      
      updateSessionModel(newSession.id, selectedModel);
      
      onNavigate?.(`/chat/${newSession.id}`);
    }

    const tempUserMessageId = uuidv4();
    const tempAssistantMessageId = uuidv4();

    const userMessage: Message = {
      id: tempUserMessageId,
      role: 'user',
      content: messageContent,
      timestamp: new Date()
    };

    const assistantMessage: Message = {
      id: tempAssistantMessageId,
      role: 'assistant',
      content: '',
      model: selectedModel,
      agentId: currentAgentId,
      timestamp: new Date(),
      isStreaming: true,
      contentBlocks: []
    };

    setSessions(prev => prev.map(s => {
      if (s.id === sessionId) {
        const newTitle = s.messages.length === 0 
          ? messageContent.slice(0, 30) + (messageContent.length > 30 ? '...' : '')
          : s.title;
        return {
          ...s,
          title: newTitle,
          messages: [...s.messages, userMessage, assistantMessage]
        };
      }
      return s;
    }));

    setInputValue('');
    localStorage.removeItem(STORAGE_KEYS.draftInput);
    setIsLoading(true);

    const agent = getAgent(currentAgentId);
    // 会话级（场景注入）的 systemPrompt 优先于 Agent 自带的：
    // 场景模板要能覆盖 Agent 的默认人设，否则「问答=只读」这类约束落不了地。
    const systemPrompt = currentSystemPrompt || agent?.systemPrompt;

    // 生图场景改道到独立端点：生图不是「把 prompt 交给 Agent 会话上下文」，
    // 而是无状态的一次 HTTP 调用。判据是**会话绑定的场景**而非某个 Agent，
    // 这样刷新后重进生图会话仍然走生图通道。
    const imageMode = currentScenarioId === IMAGE_SCENARIO_ID;

    let realSessionId: string = sessionId!;
    let realAssistantMessageId = tempAssistantMessageId;
    let fullContent = '';
    let usedModel = selectedModel;
    let currentToolCalls: ToolCall[] = [];
    let contentBlocks: ContentBlock[] = [];
    let currentTextBlock = '';  // 当前正在积累的文本块
    let thinkingText = '';
    let errorText = '';

    /** 统一更新助手消息的可变字段，避免每个分支重复写一大段 */
    const patchAssistant = (patch: Partial<Message>) => {
      setSessions(prev => prev.map(s => {
        if (s.id !== realSessionId) return s;
        return {
          ...s,
          messages: s.messages.map(m =>
            m.id === realAssistantMessageId ? { ...m, ...patch } : m
          ),
        };
      }));
    };

    try {
      const response = await fetch(imageMode ? '/api/image' : '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imageMode ? {
          sessionId,
          // 生图端点的入参叫 prompt（它不是对话消息，是一次生成请求）
          prompt: messageContent,
          imageModel: newChatOptions?.imageModel,
          size: newChatOptions?.imageSize,
          agentId: currentAgentId,
          cwd: currentCwd,
          scenarioId: currentScenarioId,
          systemPrompt,
        } : {
          sessionId,
          message: messageContent,
          model: selectedModel,
          systemPrompt,
          cwd: currentCwd,
          permissionMode: currentPermissionMode,
          // 决定后端把这次调用路由到哪个适配器
          agentId: currentAgentId,
          // P4：场景模板 id（后端据此落库，便于刷新后还原场景）
          scenarioId: currentScenarioId,
        })
      });

      // 生图端点在「缺密钥 / 未知 provider」时返回的是普通 JSON 400（不是 SSE）。
      // 不先判断就会拿 JSON 当 SSE 逐行解析，结果什么都不发生 ——
      // 用户只看到一个永远转圈、最后静默停下的气泡，完全不知道为什么。
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const j = await response.json();
          if (j?.error) detail = String(j.error);
        } catch {
          // 非 JSON 响应（网关错误页等），保留状态码
        }
        patchAssistant({
          isStreaming: false,
          error: `${imageMode ? '生图失败' : '请求失败'}：${detail}`,
        });
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                
                if (data.type === 'init') {
                  realSessionId = data.sessionId;
                  realAssistantMessageId = data.assistantMessageId;
                  usedModel = data.model;
                  
                  if (realSessionId !== sessionId) {
                    setSessions(prev => prev.map(s => 
                      s.id === sessionId ? { ...s, id: realSessionId } : s
                    ));
                    setCurrentSessionId(realSessionId);
                    sessionId = realSessionId;
                  }
                  
                  setSessions(prev => prev.map(s => {
                    if (s.id === realSessionId) {
                      return {
                        ...s,
                        messages: s.messages.map(m => 
                          m.id === tempAssistantMessageId 
                            ? { ...m, id: realAssistantMessageId }
                            : m
                        )
                      };
                    }
                    return s;
                  }));
                } else if (data.type === 'text') {
                  fullContent += data.content;
                  currentTextBlock += data.content;
                  
                  // 更新或创建最后一个文本块
                  const lastBlock = contentBlocks[contentBlocks.length - 1];
                  if (lastBlock && lastBlock.type === 'text') {
                    lastBlock.text = currentTextBlock;
                  } else if (currentTextBlock) {
                    contentBlocks.push({ type: 'text', text: currentTextBlock });
                  }
                  
                  setSessions(prev => prev.map(s => {
                    if (s.id === realSessionId) {
                      return {
                        ...s,
                        messages: s.messages.map(m => 
                          m.id === realAssistantMessageId 
                            ? { ...m, content: fullContent, model: usedModel, toolCalls: [...currentToolCalls], contentBlocks: [...contentBlocks] }
                            : m
                        )
                      };
                    }
                    return s;
                  }));
                } else if (data.type === 'tool') {
                  // 如果有累积的文本，先结束当前文本块
                  currentTextBlock = '';
                  
                  const toolCall: ToolCall = {
                    id: data.id || uuidv4(),
                    // 服务端已保证是字符串，但这里是「外部输入」的边界：
                    // 一旦 name 缺失，下游 toLowerCase() 会把整屏打成白屏，
                    // 所以在此处就归一化成字符串。
                    name: typeof data.name === 'string' ? data.name : 'unknown',
                    input: data.input,
                    status: 'running'
                  };
                  currentToolCalls.push(toolCall);
                  
                  // 添加工具调用块
                  contentBlocks.push({ type: 'tool_use', toolCall });
                  
                  setSessions(prev => prev.map(s => {
                    if (s.id === realSessionId) {
                      return {
                        ...s,
                        messages: s.messages.map(m => 
                          m.id === realAssistantMessageId 
                            ? { ...m, toolCalls: [...currentToolCalls], contentBlocks: [...contentBlocks] }
                            : m
                        )
                      };
                    }
                    return s;
                  }));
                } else if (data.type === 'tool_result') {
                  const toolId = data.toolId;
                  const toolIndex = toolId 
                    ? currentToolCalls.findIndex(t => t.id === toolId)
                    : currentToolCalls.length - 1;
                  
                  if (toolIndex >= 0) {
                    currentToolCalls[toolIndex].status = data.isError ? 'error' : 'completed';
                    currentToolCalls[toolIndex].isError = data.isError || false;
                    currentToolCalls[toolIndex].result = typeof data.content === 'string' 
                      ? data.content 
                      : JSON.stringify(data.content);
                    
                    // 同步更新 contentBlocks 中对应的工具调用
                    const blockIndex = contentBlocks.findIndex(
                      b => b.type === 'tool_use' && b.toolCall.id === currentToolCalls[toolIndex].id
                    );
                    if (blockIndex >= 0) {
                      (contentBlocks[blockIndex] as { type: 'tool_use'; toolCall: ToolCall }).toolCall = { ...currentToolCalls[toolIndex] };
                    }
                    
                    setSessions(prev => prev.map(s => {
                      if (s.id === realSessionId) {
                        return {
                          ...s,
                          messages: s.messages.map(m => 
                            m.id === realAssistantMessageId 
                              ? { ...m, toolCalls: [...currentToolCalls], contentBlocks: [...contentBlocks] }
                              : m
                          )
                        };
                      }
                      return s;
                    }));
                  }
                } else if (data.type === 'image') {
                  // 生图端点唯一的产出事件。图像块与文本/工具块共用同一条
                  // contentBlocks 序列，因此「先说明后出图」这类顺序也能表达。
                  const imgs: ImageBlock[] = Array.isArray(data.images)
                    ? data.images.filter((im: any) => im && typeof im.url === 'string' && im.url)
                    : [];
                  for (const im of imgs) {
                    contentBlocks.push({ type: 'image', image: im });
                  }
                  // images 与 contentBlocks 同时写：前者与 DB 的 images 列对齐
                  // （刷新后还原走它），后者供本次流式渲染保持顺序
                  patchAssistant({ images: imgs, contentBlocks: [...contentBlocks] });
                } else if (data.type === 'thinking') {
                  // 思考过程与正文分开累积，前端折叠展示
                  thinkingText += data.content;
                  patchAssistant({ thinking: thinkingText });
                } else if (data.type === 'error') {
                  // 模板原本完全忽略了 error 事件 —— 失败时会静默留一个空气泡。
                  // 这里把原因挂到消息上，由气泡渲染出来。
                  errorText = data.message || '未知错误';
                  patchAssistant({ error: errorText });
                } else if (data.type === 'done') {
                  patchAssistant({ isStreaming: false, thinking: thinkingText || undefined });
                } else if (data.type === 'permission_request') {
                  setPermissionRequest({
                    requestId: data.requestId,
                    toolUseId: data.toolUseId,
                    toolName: data.toolName,
                    input: data.input,
                    sessionId: data.sessionId,
                    timestamp: data.timestamp
                  });
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
      setSessions(prev => prev.map(s => {
        if (s.id === sessionId) {
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === tempAssistantMessageId
                ? {
                    ...m,
                    isStreaming: false,
                    error: `请求失败：${(error as Error).message || '未知错误'}`,
                  }
                : m
            )
          };
        }
        return s;
      }));
    } finally {
      setIsLoading(false);
    }
  }, [currentSession, currentSessionId, selectedModel, getAgent, updateSessionModel, setCurrentSessionId, setSessions, isLoading]);

  // 处理停止事件
  const handleStop = useCallback(() => {
    setIsLoading(false);
  }, []);

  // 处理权限允许
  const handlePermissionAllow = useCallback(async () => {
    if (!permissionRequest) return;
    
    
    await fetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: permissionRequest.requestId,
        behavior: 'allow'
      })
    });
    
    setPermissionRequest(null);
  }, [permissionRequest]);

  // 处理权限拒绝
  const handlePermissionDeny = useCallback(async () => {
    if (!permissionRequest) return;
    
    
    await fetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: permissionRequest.requestId,
        behavior: 'deny',
        message: '用户拒绝了此操作'
      })
    });
    
    setPermissionRequest(null);
  }, [permissionRequest]);

  return {
    isLoading,
    inputValue,
    setInputValue: saveInput,
    permissionRequest,
    sendMessage,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  };
}
