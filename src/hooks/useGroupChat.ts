import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Message,
  ToolCall,
  ContentBlock,
  PermissionRequest,
  OrchestrationMode,
} from '../types';

/**
 * 群聊消息流 hook。
 *
 * 与 `useChat` 的分工：那个服务一对一（单 Agent、单气泡、可续接上下文）；
 * 这个服务群聊（多 Agent、每个 turn 一个独立气泡、按编排模式调度）。
 *
 * ## 为什么不能直接用 useChat 的逻辑
 *
 * 一对一里一轮对话只有一个助手气泡，内容事件直接往那个气泡上补。
 * 群聊里同一时刻可能有多个 Agent 并行发言（broadcast），而且 dispatch
 * 模式下同一个 Agent 会先后产生「路由 → 执行 → 汇总」多个气泡，所以
 * 必须先靠 `turn_start { agentId, messageId }` 建气泡，后续内容按
 * 「该 Agent 当前正在说的 turn」归位。
 *
 * ## 事件契约（server/index.ts 的 /api/group-chat）
 *
 *   group_init  { sessionId, orchestration, members, userMessageId }
 *   turn_start  { agentId, messageId, phase, round }
 *   text/thinking/tool/tool_result/error  —— 都带 agentId
 *   turn_done   { agentId, messageId }
 *   group_note  { text }                     编排过程叙述
 *   done
 *
 * 内部阶段（route）由后端静默处理，不会出现在流里 —— 见 orchestrator.ts
 * 的 INTERNAL_PHASES，前端无需判断。
 *
 * ## 会话 id 不需要重映射
 *
 * 后端 `/api/group-chat` 建会话时用的是 `id: sessionId || uuidv4()`，
 * 即**客户端传来的 id 就是落库的 id**。所以从通讯录建的那个本地会话
 * （App 里 uuidv4() 造的、尚未落库）发首条消息后 id 不变，
 * 不需要像模板那样处理「init 带回真实 id」的分支。
 */
interface UseGroupChatOptions {
  currentSessionId: string | null;
  agentIds: string[];
  orchestration: OrchestrationMode;
  /** 追加或合并一条消息到当前会话（按 id 匹配，命中则合并字段） */
  upsertMessage: (message: Message) => void;
  /** 后端下发的编排模式与前端不一致时同步（理论上是冗余保护） */
  onOrchestrationSync?: (mode: OrchestrationMode) => void;
}

export function useGroupChat(options: UseGroupChatOptions) {
  const {
    currentSessionId,
    agentIds,
    orchestration,
    upsertMessage,
    onOrchestrationSync,
  } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);

  const sendGroupMessage = useCallback(
    async (messageContent: string) => {
      if (!messageContent.trim() || isLoading) return;
      if (!currentSessionId || agentIds.length === 0) return;

      upsertMessage({
        id: uuidv4(),
        role: 'user',
        content: messageContent,
        timestamp: new Date(),
      });

      setIsLoading(true);

      try {
        const response = await fetch('/api/group-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: currentSessionId,
            message: messageContent,
            agentIds,
            orchestration,
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        /**
         * 每个 turn 的流式累积状态。key 是 messageId，同一 Agent 的多个
         * turn 因此互不干扰。
         *
         * `active` 记录「这个 Agent 当前正在说哪个 turn」：dispatch 模式下
         * 同一个 Agent 会先后产生 路由 → 执行 → 汇总 三个 turn，内容事件
         * 必须落到**当前**那个。若按 agentId 去找历史第一个 turn，
         * 汇总内容会覆盖已经结束的执行气泡。
         */
        const turns = new Map<
          string,
          {
            agentId: string;
            text: string;
            thinking: string;
            toolCalls: ToolCall[];
            blocks: ContentBlock[];
            error?: string;
          }
        >();
        const active = new Map<string, string>();

        const turnOf = (messageId: string, agentId: string) => {
          let t = turns.get(messageId);
          if (!t) {
            t = { agentId, text: '', thinking: '', toolCalls: [], blocks: [] };
            turns.set(messageId, t);
          }
          return t;
        };

        /** 开一个新气泡（turn_start，或内容事件缺少前导时的兜底） */
        const openTurn = (messageId: string, agentId: string) => {
          turnOf(messageId, agentId);
          active.set(agentId, messageId);
          upsertMessage({
            id: messageId,
            role: 'assistant',
            content: '',
            agentId,
            timestamp: new Date(),
            isStreaming: true,
            contentBlocks: [],
          });
        };

        const flush = (messageId: string) => {
          const t = turns.get(messageId);
          if (!t) return;
          upsertMessage({
            id: messageId,
            role: 'assistant',
            content: t.text,
            agentId: t.agentId,
            timestamp: new Date(),
            isStreaming: true,
            contentBlocks: t.blocks.length ? [...t.blocks] : undefined,
            toolCalls: t.toolCalls.length ? [...t.toolCalls] : undefined,
            thinking: t.thinking || undefined,
            error: t.error,
          });
        };

        if (reader) {
          // SSE 以空行分帧，跨 chunk 的半行必须留在 buffer 里，
          // 否则一个事件被从中间切断就整条丢失
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
              let data: any;
              try {
                data = JSON.parse(line.slice(6));
              } catch {
                continue;
              }

              switch (data.type) {
                case 'group_init':
                  if (data.orchestration && onOrchestrationSync) {
                    onOrchestrationSync(data.orchestration);
                  }
                  break;

                case 'turn_start': {
                  // messageId 由后端生成；缺失时兜底自造一个，避免消息互相覆盖
                  const id: string = data.messageId || uuidv4();
                  openTurn(id, data.agentId);
                  break;
                }

                case 'text': {
                  let id = active.get(data.agentId);
                  if (!id) {
                    id = uuidv4();
                    openTurn(id, data.agentId);
                  }
                  const t = turnOf(id, data.agentId);
                  t.text += data.content;
                  const last = t.blocks[t.blocks.length - 1];
                  if (last && last.type === 'text') last.text = t.text;
                  else t.blocks.push({ type: 'text', text: t.text });
                  flush(id);
                  break;
                }

                case 'thinking': {
                  const id = active.get(data.agentId);
                  if (!id) break;
                  const t = turnOf(id, data.agentId);
                  t.thinking += data.content;
                  flush(id);
                  break;
                }

                case 'tool': {
                  const id = active.get(data.agentId);
                  if (!id) break;
                  const t = turnOf(id, data.agentId);
                  const toolCall: ToolCall = {
                    id: data.id || uuidv4(),
                    name: typeof data.name === 'string' ? data.name : 'unknown',
                    input: data.input,
                    status: 'running',
                  };
                  t.toolCalls.push(toolCall);
                  t.blocks.push({ type: 'tool_use', toolCall });
                  flush(id);
                  break;
                }

                case 'tool_result': {
                  const id = active.get(data.agentId);
                  if (!id) break;
                  const t = turnOf(id, data.agentId);
                  const idx = data.toolId
                    ? t.toolCalls.findIndex(x => x.id === data.toolId)
                    : t.toolCalls.length - 1;
                  if (idx >= 0) {
                    t.toolCalls[idx].status = data.isError ? 'error' : 'completed';
                    t.toolCalls[idx].isError = !!data.isError;
                    t.toolCalls[idx].result =
                      typeof data.content === 'string'
                        ? data.content
                        : JSON.stringify(data.content);
                    const bi = t.blocks.findIndex(
                      b => b.type === 'tool_use' && b.toolCall.id === t.toolCalls[idx].id
                    );
                    if (bi >= 0) {
                      (t.blocks[bi] as { type: 'tool_use'; toolCall: ToolCall }).toolCall = {
                        ...t.toolCalls[idx],
                      };
                    }
                  }
                  flush(id);
                  break;
                }

                case 'error': {
                  const agentId: string | undefined = data.agentId;
                  // 只把错误挂到**当前** turn；已结束的 turn 不该被回头改写
                  const id = agentId ? active.get(agentId) : undefined;
                  if (id && agentId) {
                    const t = turnOf(id, agentId);
                    t.error = data.message || '未知错误';
                    flush(id);
                  } else {
                    // 没有具体作者的失败（编排层整体失败）：单独一条错误消息
                    upsertMessage({
                      id: uuidv4(),
                      role: 'assistant',
                      content: '',
                      agentId,
                      timestamp: new Date(),
                      error: data.message || '编排失败',
                    });
                  }
                  break;
                }

                case 'turn_done': {
                  const id: string | undefined = data.messageId;
                  if (id && turns.has(id)) {
                    flush(id);
                    upsertMessage({
                      id,
                      role: 'assistant',
                      content: turns.get(id)!.text,
                      timestamp: new Date(),
                      isStreaming: false,
                    });
                  }
                  break;
                }

                case 'group_note': {
                  // 编排过程说明只进内存不落库：刷新后重放会让用户以为重新发生了
                  upsertMessage({
                    id: uuidv4(),
                    role: 'assistant',
                    content: data.text || '',
                    timestamp: new Date(),
                    note: true,
                  });
                  break;
                }

                case 'permission_request': {
                  setPermissionRequest({
                    requestId: data.requestId,
                    toolUseId: data.toolUseId,
                    toolName: data.toolName,
                    input: data.input,
                    sessionId: data.sessionId,
                    timestamp: data.timestamp,
                  });
                  break;
                }

                case 'done':
                  break;
              }
            }
          }
        }

        // 兜底：流正常结束但没收到 turn_done 的 turn，解除流式状态
        for (const [id, t] of turns) {
          upsertMessage({
            id,
            role: 'assistant',
            content: t.text,
            agentId: t.agentId,
            timestamp: new Date(),
            isStreaming: false,
          });
        }
      } catch (error) {
        console.error('[GroupChat] 请求失败:', error);
        upsertMessage({
          id: uuidv4(),
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          error: `请求失败：${(error as Error).message || '未知错误'}`,
        });
      } finally {
        setIsLoading(false);
      }
    },
    [currentSessionId, agentIds, orchestration, isLoading, upsertMessage, onOrchestrationSync]
  );

  return {
    isLoading,
    permissionRequest,
    sendGroupMessage,
    setPermissionRequest,
  };
}
