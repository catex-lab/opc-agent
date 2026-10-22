import { useState, useCallback } from 'react';
import { MessagePlugin } from 'tdesign-react';
import { v4 as uuidv4 } from 'uuid';
import { Message, PermissionRequest, PermissionMode, Session, CustomAgent, ImageBlock } from '../types';
import {
  applyRunEvent,
  textOfBlocks,
  thinkingOfBlocks,
  toolCallsOfBlocks,
  type Block,
  type RunEvent,
} from '../../shared/blocks';

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
  /**
   * A62：思考强度档位。
   *
   * `''` = 用 CLI 自己的默认（显式表达「不设」），
   * 具体档位值 = 从模型 `reasoning.levels` 里选的那一个。
   * `null` = 库里存的就是「未设置」（与 `''` 等价，统一成 undefined 再下发）。
   * 前端只在模型真有档位表时才发，否则这个字段不出现（后端按 undefined 处理 = 不碰）。
   */
  reasoningEffort?: string | null;
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

  /**
   * A33「重新生成」的入参。
   *
   * `replaceMessageId`：要顶掉的那条旧回复。传了它就表示这不是一次普通
   * 发送 —— 界面不新增用户气泡（提问已在会话里），旧回复原位换成新的流式
   * 气泡，后端也不再重复落 user 消息。
   */
  interface RegenerateOptions {
    replaceMessageId: string;
  }

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
    onNavigate?: (path: string) => void,
    /** A33 重新生成：带上它就是「重跑最后一轮」，不是新提问 */
    regen?: RegenerateOptions
  ) => {
    if (!messageContent.trim() || isLoading) return;

    let sessionId = currentSessionId;
    let currentCwd = currentSession?.cwd;
    // A62：档位是**随时可改的会话设置**。`''` 与 undefined 语义不同：
    // '' = 用户明确选了「CLI 默认」（后端据此清掉旧值），undefined = 不碰。
    let currentReasoning: string | undefined = currentSession?.reasoningEffort ?? undefined;
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
        // A62：新会话从新对话页带来的档位（没摆下拉就 undefined）
        reasoningEffort: newChatOptions.reasoningEffort ?? undefined,
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
      currentReasoning = newSession.reasoningEffort ?? undefined;
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
      if (s.id !== sessionId) return s;
      if (regen) {
        // 重新生成：**原位**换掉旧回复 —— 不新增用户气泡（提问已在会话里），
        // 也不把新回复接在旧回复后面（那会让一问问出两个答案）。
        return {
          ...s,
          messages: s.messages.map(m =>
            m.id === regen.replaceMessageId ? { ...assistantMessage } : m
          ),
        };
      }
      const newTitle = s.messages.length === 0
        ? messageContent.slice(0, 30) + (messageContent.length > 30 ? '...' : '')
        : s.title;
      return {
        ...s,
        title: newTitle,
        messages: [...s.messages, userMessage, assistantMessage]
      };
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
    let usedModel = selectedModel;
    let errorText = '';
    /**
     * 本轮的块序列（E3）。
     *
     * 流式期间**原地累积**，按帧（requestAnimationFrame）刷进 React 状态：
     * 每个 token 都 setSessions 会让长回复每帧重渲染几十次，实测明显掉帧。
     * 一次 rAF 内的所有 delta 合并成一次提交，视觉上仍是逐字，成本却低一个量级。
     */
    let blocks: Block[] = [];
    let rafId: number | null = null;
    /**
     * rAF 的兜底定时器。
     *
     * rAF 一度是 flushNow 的唯一出路，而 Electron 的 backgroundThrottling
     * 默认开启：窗口被遮挡/最小化时 rAF 根本不触发，且 rafId 一旦非空
     * schedule() 就再不排新帧 —— 整轮 delta 闷在内存里，直到切回窗口
     * 才「一整块跳出来」（2026-10-19 用户实测复现的形态）。
     * 所以每次 schedule() 都同时挂一个 120ms 的 setTimeout 双保险。
     */
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let runId: string | null = null;
    let lastSeq = 0;

    const flushNow = () => {
      rafId = null;
      if (fallbackTimer != null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (blocks.length === 0) return;
      patchAssistant({
        blocks: [...blocks],
        // 兼容字段同步派生：列表预览、搜索、旧组件仍读它们
        content: textOfBlocks(blocks),
        toolCalls: toolCallsOfBlocks(blocks),
        thinking: thinkingOfBlocks(blocks) || undefined,
      });
    };

    const schedule = () => {
      // 两条路谁先到都只提交一次（flushNow 开头把另一条取消），
      // 内容最迟 120ms 后必达 React 状态，不再依赖窗口可见。
      if (rafId == null) rafId = requestAnimationFrame(flushNow);
      if (fallbackTimer == null) fallbackTimer = setTimeout(flushNow, 120);
    };

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
          ...(regen
            ? { regenerate: true, replaceMessageId: regen.replaceMessageId }
            : {}),
        } : {
          sessionId,
          message: messageContent,
          model: selectedModel,
          systemPrompt,
          cwd: currentCwd,
          // A62：档位值。模型没有档位表时前端不发这个键，
          // 后端收到 undefined 就不碰会话里已有的值。
          reasoningEffort: currentReasoning,
          permissionMode: currentPermissionMode,
          // 决定后端把这次调用路由到哪个适配器
          agentId: currentAgentId,
          // P4：场景模板 id（后端据此落库，便于刷新后还原场景）
          scenarioId: currentScenarioId,
          // A33 重新生成：后端据此跳过 user 消息、删掉被顶掉的旧回复
          ...(regen
            ? {
                regenerate: true,
                replaceMessageId: regen.replaceMessageId,
              }
            : {}),
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

      const decoder = new TextDecoder();

      /** init / run_start 共用：把临时会话与气泡 id 换成后端的真值 */
      const applyInit = (sid: string, mid: string, modelId?: string) => {
        if (sid) realSessionId = sid;
        if (mid) realAssistantMessageId = mid;
        if (modelId) usedModel = modelId;

        if (realSessionId !== sessionId) {
          setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, id: realSessionId } : s)));
          setCurrentSessionId(realSessionId);
          sessionId = realSessionId;
        }

        setSessions(prev => prev.map(s => {
          if (s.id !== realSessionId) return s;
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === tempAssistantMessageId ? { ...m, id: realAssistantMessageId } : m
            ),
          };
        }));
      };

      /** 把一条 SSE 事件应用到本地状态 */
      const handleEvent = (data: any) => {
        if (imageMode) {
          if (data.type === 'init') {
            applyInit(data.sessionId, data.assistantMessageId, data.model);
          } else if (data.type === 'image') {
            const imgs: ImageBlock[] = Array.isArray(data.images)
              ? data.images.filter((im: any) => im && typeof im.url === 'string' && im.url)
              : [];
            for (const im of imgs) {
              blocks.push({ id: `img-${blocks.length}`, type: 'image', image: im });
            }
            flushNow();
            // images 与 blocks 同时写：前者与 DB 的 images 列对齐，
            // 后者供本次流式渲染保持顺序
            patchAssistant({ images: imgs });
          } else if (data.type === 'error') {
            errorText = data.message || '未知错误';
            patchAssistant({ error: errorText });
          } else if (data.type === 'done') {
            flushNow();
            patchAssistant({ isStreaming: false });
          }
          return;
        }

        switch (data.type) {
          case 'run_start':
            runId = data.runId ?? null;
            if (typeof data.seq === 'number') lastSeq = data.seq;
            applyInit(data.sessionId, data.messageId, data.model);
            break;

          case 'block_open':
          case 'block_delta':
          case 'block_patch':
          case 'block_close':
          case 'snapshot':
            if (typeof data.seq === 'number') lastSeq = data.seq;
            if (applyRunEvent(blocks, data as RunEvent)) schedule();
            break;

          case 'error':
            errorText = data.message || '未知错误';
            patchAssistant({ error: errorText });
            break;

          case 'permission_request':
            setPermissionRequest({
              requestId: data.requestId,
              toolUseId: data.toolUseId || '',
              toolName: data.toolName,
              input: data.input,
              sessionId: realSessionId,
              timestamp: Date.now(),
              risk: data.risk,
              rule: data.rule,
            });
            break;

          case 'run_end':
            if (typeof data.seq === 'number') lastSeq = data.seq;
            flushNow();
            patchAssistant({
              isStreaming: false,
              durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
              cost: typeof data.cost === 'number' ? data.cost : undefined,
              tokens: typeof data.tokens === 'number' ? data.tokens : undefined,
            });
            break;
        }
      };

      /** 读一条 SSE 流（按空行分帧，半行留在 buffer 里） */
      const consume = async (resp: Response) => {
        const reader = resp.body?.getReader();
        // body 为 null（响应没有流可读）时必须抛出去。静默 return 会让外层
        // catch 不触发，isStreaming 永远停在 true —— 气泡永久转圈、
        // 控制台零报错，只能靠刷新恢复（2026-10-19 实测的缺陷）。
        if (!reader) throw new Error('响应体不可读（resp.body 为 null），无法接收流式数据');
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const line = frame.split('\n').find(l => l.startsWith('data: '));
            if (!line) continue;
            try {
              handleEvent(JSON.parse(line.slice(6)));
            } catch {
              // 单帧坏掉不能拖垮整条流
            }
          }
        }
      };

      try {
        await consume(response);
      } catch (err) {
        // 断线重连（E5）：带着最后收到的 seq 接回去，不重发整轮
        if (runId && lastSeq > 0) {
          const resumed = await fetch(`/api/runs/${runId}/stream?after=${lastSeq}`);
          if (!resumed.ok) throw err;
          await consume(resumed);
        } else {
          throw err;
        }
      }

    } catch (error) {
      console.error('Chat error:', error);
      // 必须按 realAssistantMessageId 匹配：applyInit() 早就把气泡 id 从
      // 临时值换成了后端真值，这里再用 tempAssistantMessageId 就一个都
      // 匹配不上 —— 错误贴不上、isStreaming 也不置 false，永久转圈。
      // run_start 之前出错时两者恰好相等，所以真 id 覆盖两种情况。
      setSessions(prev => prev.map(s => {
        if (s.id === sessionId) {
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === realAssistantMessageId
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
      // 看门狗：不管 run_end 有没有到、流有没有正常读完，这一轮都必须收尾。
      // isStreaming 停在 true 的代价是气泡永久转圈 —— 宁多关一次，不可漏关。
      // blocks 里可能还闷着没提交的尾帧，先冲掉再关。
      flushNow();
      patchAssistant({ isStreaming: false });
      setIsLoading(false);
    }
  }, [currentSession, currentSessionId, selectedModel, getAgent, updateSessionModel, setCurrentSessionId, setSessions, isLoading]);

  /**
   * A33 重新生成：用这条 assistant 回复**之前**的最近一条 user 消息重跑一轮。
   *
   * 为什么从界面消息里重新取提问，而不是让调用方把 prompt 传进来：
   * 那条提问已经落库、也可能被折叠进历史里，界面上的这一份才是用户
   * 「刚刚看到的」；前端重发一遍内容即可，后端不会重复落库。
   */
  const regenerate = useCallback(
    async (message: Message) => {
      if (isLoading) return;
      const msgs = currentSession?.messages ?? [];
      const idx = msgs.findIndex(m => m.id === message.id);
      let prompt = '';
      for (let i = (idx < 0 ? msgs.length : idx) - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          prompt = msgs[i].content;
          break;
        }
      }
      if (!prompt) {
        MessagePlugin.warning('找不到这条回复对应的提问，无法重新生成');
        return;
      }
      await sendMessage(prompt, undefined, undefined, { replaceMessageId: message.id });
    },
    [currentSession, isLoading, sendMessage]
  );

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
    regenerate,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  };
}
