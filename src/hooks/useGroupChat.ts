import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Message, PermissionRequest, OrchestrationMode } from '../types';
import {
  applyRunEvent,
  textOfBlocks,
  thinkingOfBlocks,
  toolCallsOfBlocks,
  type Block,
  type RunEvent,
} from '../../shared/blocks';

/**
 * 群聊消息流 hook。
 *
 * 与 `useChat` 的分工：那个服务一对一（单 Agent、单气泡、可续接上下文）；
 * 这个服务群聊（多 Agent、每个 turn 一个独立气泡、按编排模式调度）。
 *
 * ## 事件契约（E1 之后）
 *
 *   group_init  { sessionId, orchestration, members, userMessageId }
 *   run_start   { runId, messageId, agentId, model, phase?, round? }
 *   block_open / block_delta / block_patch / block_close / snapshot
 *   turn_done   { agentId, messageId, runId, duration?, cost?, tokens? }
 *   group_note  { text }
 *   done
 *
 * 每一棒（turn）是一个独立的 run：broadcast 模式下多路并发时，
 * 靠 runId 把事件分流到各自的气泡，不再用 agentId 猜「当前在说哪个」——
 * dispatch 模式下同一个 Agent 会先后有 路由/执行/汇总 三棒，
 * 按 agentId 归位必然把汇总写进已经结束的执行气泡。
 *
 * ## A41 之后：工作流复用同一条流
 *
 * 动态工作流（/api/workflow/run）吐的是**同一套事件**，所以
 * `runWorkflowScript` 与 `sendGroupMessage` 共用下面的
 * `createEventStreamSession`：块累积逻辑只有一份（还在 shared/blocks.ts
 * 的 applyRunEvent），两处调用方各自持有一个独立的 run 状态表。
 * 如果将来加第三种「往会话里灌事件」的入口，也应该复用它而不是再抄一遍。
 */

interface RunState {
  runId: string;
  messageId: string;
  agentId: string;
  phase?: string;
  blocks: Block[];
  streaming: boolean;
  error?: string;
}

/** 五种编排模式。group_init 里的值必须落在这里面才算合法 */
const KNOWN_MODES: OrchestrationMode[] = ['dispatch', 'broadcast', 'relay', 'debate', 'mention'];

interface UseGroupChatOptions {
  currentSessionId: string | null;
  agentIds: string[];
  orchestration: OrchestrationMode;
  title?: string;
  /** 追加或合并一条消息到当前会话（按 id 匹配，命中则合并字段） */
  upsertMessage: (message: Message) => void;
  onOrchestrationSync?: (mode: OrchestrationMode) => void;
}

/**
 * 一次 SSE 会话的完整状态机：run 表、帧解析、块累积、落消息、断线重连。
 *
 * 抽成独立工厂函数（而不是留在 sendGroupMessage 闭包里）就是为了让
 * 工作流复用 —— 群聊与工作流的差异只在「请求发到哪个端点」。
 */
function createEventStreamSession(opts: {
  upsertMessage: (message: Message) => void;
  currentSessionId: string | null;
  onPermissionRequest: (p: PermissionRequest) => void;
  onOrchestrationSync?: (mode: OrchestrationMode) => void;
}) {
  const { upsertMessage } = opts;

  /** runId → 本轮状态 */
  const runs = new Map<string, RunState>();
  /** messageId → runId（turn_done 只带 messageId） */
  const runByMessage = new Map<string, string>();
  const lastSeq = new Map<string, number>();
  const dirty = new Set<string>();
  let rafId: number | null = null;
  /**
   * rAF 兜底定时器，与 useChat 同一套道理：Electron 的
   * backgroundThrottling 默认开启，窗口被遮挡/最小化时 rAF 不触发，
   * 而 rafId 一旦非空就再不排新帧 —— 多 Agent 的 delta 会一起闷在
   * 内存里，直到切回窗口才整块跳出来（2026-10-19 用户实测的形态）。
   */
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const pushMessage = (r: RunState) => {
    upsertMessage({
      id: r.messageId,
      role: 'assistant',
      agentId: r.agentId,
      timestamp: new Date(),
      isStreaming: r.streaming,
      blocks: [...r.blocks],
      // 兼容字段：列表预览、导出、旧组件仍读
      content: textOfBlocks(r.blocks),
      toolCalls: toolCallsOfBlocks(r.blocks),
      thinking: thinkingOfBlocks(r.blocks) || undefined,
      error: r.error,
    });
  };

  /** 按帧合并：一次 rAF 内多个 Agent 的 delta 只提交一轮 */
  const flush = () => {
    rafId = null;
    if (fallbackTimer != null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    for (const messageId of dirty) {
      const runId = runByMessage.get(messageId);
      const r = runId ? runs.get(runId) : undefined;
      if (r) pushMessage(r);
    }
    dirty.clear();
  };

  const schedule = (messageId: string) => {
    dirty.add(messageId);
    // rAF 与 setTimeout 双路，谁先到只提交一次，另一条被 flush 开头取消。
    // 最迟 120ms 必达 React 状态，不依赖窗口是否可见。
    if (rafId == null) rafId = requestAnimationFrame(flush);
    if (fallbackTimer == null) fallbackTimer = setTimeout(flush, 120);
  };

  const openRun = (data: any) => {
    const runId: string = data.runId;
    if (!runId) return;
    const existing = runs.get(runId);
    if (existing) return;
    const r: RunState = {
      runId,
      messageId: data.messageId || uuidv4(),
      agentId: data.agentId || 'assistant',
      phase: data.phase,
      blocks: [],
      streaming: true,
    };
    runs.set(runId, r);
    runByMessage.set(r.messageId, runId);
    // 先落一个空气泡：用户能立刻看到「谁开始说话了」
    pushMessage(r);
  };

  const handleEvent = (data: any) => {
    switch (data.type) {
      case 'group_init':
        // 工作流的 group_init 带的是 'workflow'（不在五种模式里）——
        // 只有合法模式才回写，否则会用脏值覆盖用户的模式选择
        if (data.orchestration && (KNOWN_MODES as string[]).includes(data.orchestration) && opts.onOrchestrationSync) {
          opts.onOrchestrationSync(data.orchestration);
        }
        break;

      case 'run_start':
        if (typeof data.seq === 'number') lastSeq.set(data.runId, data.seq);
        openRun(data);
        break;

      case 'block_open':
      case 'block_delta':
      case 'block_patch':
      case 'block_close':
      case 'snapshot': {
        if (typeof data.seq === 'number' && data.runId) lastSeq.set(data.runId, data.seq);
        const r = runs.get(data.runId);
        if (!r) break;
        if (applyRunEvent(r.blocks, data as RunEvent)) schedule(r.messageId);
        break;
      }

      case 'turn_done': {
        const runId = data.runId || runByMessage.get(data.messageId);
        const r = runId ? runs.get(runId) : undefined;
        if (!r) break;
        r.streaming = false;
        // 用量随 turn_done 下发；没有就是没有，不写 0 冒充「免费」
        pushMessage(r);
        upsertMessage({
          id: r.messageId,
          role: 'assistant',
          content: textOfBlocks(r.blocks),
          timestamp: new Date(),
          isStreaming: false,
          durationMs: typeof data.duration === 'number' ? data.duration : undefined,
          cost: typeof data.cost === 'number' ? data.cost : undefined,
          tokens: typeof data.tokens === 'number' ? data.tokens : undefined,
        });
        break;
      }

      case 'error': {
        // 有归属的错误挂到当前 run；没有归属的（编排层整体失败）单独一条
        const r = data.runId ? runs.get(data.runId) : undefined;
        if (r) {
          r.error = data.message || '未知错误';
          schedule(r.messageId);
        } else {
          upsertMessage({
            id: uuidv4(),
            role: 'assistant',
            content: '',
            agentId: data.agentId,
            timestamp: new Date(),
            error: data.message || '编排失败',
          });
        }
        break;
      }

      case 'group_note':
        // 编排叙述只进内存不落库：刷新后重放会让用户以为重新发生了。
        // 同时包成一个 note 块，渲染层不必为它单开一条分支。
        upsertMessage({
          id: uuidv4(),
          role: 'assistant',
          content: data.text || '',
          timestamp: new Date(),
          note: true,
          blocks: [{ id: uuidv4(), type: 'note', text: data.text || '', level: 'info' }],
        });
        break;

      case 'permission_request':
        opts.onPermissionRequest({
          requestId: data.requestId,
          toolUseId: data.toolUseId || '',
          toolName: data.toolName,
          input: data.input,
          // 会话 id 可能还是空壳（本地新建的群没落库）：用空串占位，
          // resolvePermission 走 requestId 反查，本来就不依赖这个字段
          sessionId: opts.currentSessionId ?? '',
          timestamp: Date.now(),
          risk: data.risk,
          rule: data.rule,
        });
        break;

      case 'done':
        break;
    }
  };

  const decoder = new TextDecoder();

  const consume = async (resp: Response) => {
    const reader = resp.body?.getReader();
    // 与 useChat 同一处缺陷：body 为 null 时静默 return 会让外层兜底
    // （drain）照跑，但流里剩余内容全部丢失且无任何报错。抛出去至少让
    // catch 打出错误。
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
          // 单帧坏掉不拖垮整条流
        }
      }
    }
  };

  /**
   * 带断线重连地消费：断了就把还在跑的 run 各带 seq 接回去（E5）。
   * 群聊与工作流都走这里 —— 工作流的每一次 assign/broadcast 都是真 run。
   */
  const consumeWithReconnect = async (resp: Response) => {
    try {
      await consume(resp);
    } catch (err) {
      const active = [...runs.values()].filter(r => r.streaming);
      if (active.length === 0) throw err;
      for (const r of active) {
        const after = lastSeq.get(r.runId) ?? 0;
        if (after <= 0) continue;
        const resumed = await fetch(`/api/runs/${r.runId}/stream?after=${after}`);
        if (resumed.ok) await consume(resumed);
      }
    }
  };

  /** 兜底：流正常结束但没收到 turn_done 的 run，解除流式状态 */
  const drain = () => {
    for (const r of runs.values()) {
      if (!r.streaming) continue;
      r.streaming = false;
      pushMessage(r);
    }
  };

  /** 收尾：取消还没执行的合并帧（必须在 finally 里调，见 hook） */
  const dispose = () => {
    if (rafId != null) cancelAnimationFrame(rafId);
    if (fallbackTimer != null) clearTimeout(fallbackTimer);
  };

  return { handleEvent, consume, consumeWithReconnect, drain, dispose };
}

export function useGroupChat(options: UseGroupChatOptions) {
  const {
    currentSessionId,
    agentIds,
    orchestration,
    title,
    upsertMessage,
    onOrchestrationSync,
  } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);

  /** 新开一条流会话（群聊发言与工作流共用同一套状态机） */
  const newSession = () =>
    createEventStreamSession({
      upsertMessage,
      currentSessionId,
      onPermissionRequest: setPermissionRequest,
      onOrchestrationSync,
    });

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
      const stream = newSession();

      try {
        const response = await fetch('/api/group-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: currentSessionId,
            message: messageContent,
            agentIds,
            orchestration,
            title,
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
        }

        await stream.consumeWithReconnect(response);
        // 兜底：流正常结束但没收到 turn_done 的 run，解除流式状态
        stream.drain();
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
        stream.dispose();
        setIsLoading(false);
      }
    },
    [currentSessionId, agentIds, orchestration, title, isLoading, upsertMessage, onOrchestrationSync]
  );

  /**
   * 跑一段工作流脚本（A41）。
   *
   * 与 sendGroupMessage 的唯一区别是端点与请求体：脚本替掉「一句话」，
   * 事件协议完全一致，所以 run 气泡、断线重连、权限请求都是同一套。
   * 脚本里每一次 assign/broadcast 都会以正常的气泡出现在会话里。
   */
  const runWorkflowScript = useCallback(
    async (source: string) => {
      if (!source.trim() || isLoading) return;
      if (!currentSessionId || agentIds.length === 0) return;

      setIsLoading(true);
      const stream = newSession();

      try {
        const response = await fetch('/api/workflow/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: currentSessionId,
            source,
            agentIds,
            orchestration,
            title,
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
        }

        await stream.consumeWithReconnect(response);
        stream.drain();
      } catch (error) {
        console.error('[Workflow] 请求失败:', error);
        upsertMessage({
          id: uuidv4(),
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          error: `工作流失败：${(error as Error).message || '未知错误'}`,
        });
      } finally {
        stream.dispose();
        setIsLoading(false);
      }
    },
    [currentSessionId, agentIds, orchestration, title, isLoading, upsertMessage, onOrchestrationSync]
  );

  return {
    isLoading,
    permissionRequest,
    sendGroupMessage,
    runWorkflowScript,
    setPermissionRequest,
  };
}
