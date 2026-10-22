import { useState, useEffect, useCallback, useRef } from 'react';
import { Session, Message } from '../types';

const STORAGE_KEYS = {
  sessionModels: 'sessionModels',
};

/**
 * 解析 DB 里以 JSON 字符串存的群成员列表。
 * 数据可能是历史遗留的坏值（空串、非 JSON），所以整个解析过程要兜住，
 * 宁可退化成空数组也不要让会话列表整体加载失败。
 */
function parseAgentIds(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const ids = parsed.filter((v): v is string => typeof v === 'string');
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  
  // 每个会话的模型选择缓存
  const [sessionModels, setSessionModels] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.sessionModels);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // 获取当前会话
  const currentSession = sessions.find(s => s.id === currentSessionId);

  /** 已尝试过从后端拉取消息的会话 id，避免重复请求（详见 loadSessionMessages） */
  const attemptedLoads = useRef<Set<string>>(new Set());

  /**
   * 消息**已经拉过一轮**的会话 id（成功、404 都算）。
   *
   * 为什么要单独一个 state：`messages.length === 0` 无法区分
   * 「这个会话真的没有消息」和「消息还在路上」。前端曾用后者判断要不要
   * 显示新建对话页 —— 于是每次打开一个已有会话，先闪一屏「场景卡片 /
   * 新建对话」，等消息到了再切成聊天记录。用户报的「打开聊天记录屏闪」
   * 就是这一下。
   *
   * 现在：拉过一轮之后才允许「空 = 新对话」这个推论成立；
   * 没拉过就渲染骨架，界面不会再换一整屏。
   */
  const [loadedSessions, setLoadedSessions] = useState<Set<string>>(() => new Set());

  const markLoaded = useCallback((sessionId: string) => {
    setLoadedSessions(prev => {
      if (prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
  }, []);

  // 从 API 加载会话列表
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      
      if (data.sessions) {
        const loadedSessions: Session[] = data.sessions.map((s: any) => ({
          id: s.id,
          title: s.title,
          model: s.model,
          // 必须带上 agentId：会话列表头像、会话头部名称与在线状态、
          // 消息流里的 Agent 头像全靠它反查注册表。漏掉这一行会让
          // 整个 IM 身份层失效（头像退化成首字母、头部只剩标题）。
          agentId: s.agent_id ?? undefined,
          // 群聊三件套同样必须带上，否则刷新后群成员和编排模式全丢，
          // 群聊会退化成一个没有成员的普通会话。
          kind: s.kind === 'group' ? 'group' : 'direct',
          agentIds: parseAgentIds(s.agent_ids),
          orchestration: s.orchestration ?? undefined,
          // P4：工作目录与场景绑定必须一并还原，否则刷新后 cwd 丢失、
          // 场景标签消失（这正是 P4-1 要修的问题）。
          cwd: s.cwd ?? undefined,
          // A62：思考强度档位。刷新后必须还原，否则用户每次重开
          // 都得重新选一遍档位（那等于这个设置不存在）
          reasoningEffort: s.reasoning_effort ?? undefined,
          scenarioId: s.scenario_id ?? undefined,
          systemPrompt: s.system_prompt ?? undefined,
          // 置顶是持久状态，刷新后必须还原，否则「钉住的会话」每次重开都掉下来
          pinned: s.pinned === 1 || s.pinned === true,
          createdAt: new Date(s.created_at),
          messages: []
        }));
        setSessions(loadedSessions);
        // 列表重建后所有会话的 messages 都被清空，之前的「已尝试拉取」
        // 记录必须一并作废，否则消息会再也加载不出来。
        attemptedLoads.current.clear();
        setLoadedSessions(new Set());
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    }
  }, []);

  // 加载单个会话的消息
  //
  // ★ 这里必须容忍 404：从通讯录发起的会话是**纯本地对象**（App.tsx 里用
  //   uuidv4() 造的），只有等首条消息发出、后端按同一个 id 落库之后才存在。
  //   在那之前切到该会话，GET 必然 404。这属于正常时序，不是错误 ——
  //   以前没判断 res.ok，于是每次发起新对话控制台都会多一条红色 404，
  //   把真正需要关注的报错淹没掉。
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    // 去重：同一会话只尝试拉一次。既避免 StrictMode 下的重复请求，
    // 也防止「404 后 messages 仍为空 → effect 再次触发」的重复打点。
    if (attemptedLoads.current.has(sessionId)) return;
    attemptedLoads.current.add(sessionId);

    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      // 尚未落库（404）或其它非 2xx：静默跳过，保留本地已有的消息。
      // **但要标记为已拉取** —— 否则界面会一直停在骨架屏上等一个永远
      // 不会来的响应（404 是「确实没有」而不是「还没到」）。
      if (!res.ok) {
        markLoaded(sessionId);
        return;
      }
      const data = await res.json();

      if (data.messages) {
        const messages: Message[] = data.messages.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          model: m.model,
          // 群聊里这句话是哪个 Agent 说的，前端据此渲染独立气泡
          agentId: m.author_agent_id ?? undefined,
          timestamp: new Date(m.created_at),
          toolCalls: m.tool_calls || undefined,
          // 有序块序列（E2）。新消息只有它，老消息为 undefined → 渲染层退回旧字段
          blocks: Array.isArray(m.blocks) && m.blocks.length > 0 ? m.blocks : undefined,
          // P4-4：生图消息的图片块。后端已解析成数组；这里再兜一层，
          // 只有确实是数组且非空才带上（坏值不该让整条消息渲染失败）
          images: Array.isArray(m.images) && m.images.length > 0 ? m.images : undefined,
          // P6 成本统计：库里有才带。老消息这三列是 NULL，还原成 undefined，
          // 前端据此不渲染统计行 —— 而不是显示 0 秒 / $0 冒充「这次没花钱」
          durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : undefined,
          cost: typeof m.cost === 'number' ? m.cost : undefined,
          tokens: typeof m.tokens === 'number' ? m.tokens : undefined
        }));

        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, messages } : s
        ));
        markLoaded(sessionId);
      } else {
        markLoaded(sessionId);
      }
    } catch (error) {
      // 只有网络层失败才值得报错；同时撤销去重标记，允许后续重试
      attemptedLoads.current.delete(sessionId);
      console.error('Failed to load session messages:', error);
    }
  }, [markLoaded]);

  // 删除会话
  const deleteSession = useCallback(async (sessionId: string): Promise<string | null> => {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });

      let navigateTo: string | null = null;

      setSessions(prev => {
        const filtered = prev.filter(s => s.id !== sessionId);
        return filtered;
      });

      // 返回需要导航到的位置
      const remaining = sessions.filter(s => s.id !== sessionId);
      if (currentSessionId === sessionId) {
        if (remaining.length > 0) {
          navigateTo = `/chat/${remaining[0].id}`;
          setCurrentSessionId(remaining[0].id);
        } else {
          navigateTo = '/';
          setCurrentSessionId(null);
        }
      }

      return navigateTo;
    } catch (error) {
      console.error('Failed to delete session:', error);
      return null;
    }
  }, [sessions, currentSessionId]);

  /**
   * 清空聊天记录，**保留会话**（P7 群设置「删除聊天记录」）。
   *
   * 与 deleteSession 的分工见 server 的 DELETE /api/sessions/:id/messages 注释。
   * 本地只把内存里的 messages 清空，不重新拉取 —— 后端已经删干净了，
   * 再拉一次只会得到同样的空数组，白费一次往返。
   *
   * **不要**顺手 `attemptedLoads.current.delete(sessionId)`（这里踩过）：
   * 「加载消息」的 effect 依赖 `sessions`，而清空本身就改了 `sessions`，
   * 于是 effect 会立刻再跑一遍；此时 `messages.length === 0` 正好满足它的
   * 触发条件，标记一被收回就会**马上重新 GET** 一次。后端真删干净时它只是
   * 白跑一趟，但只要消息还能被取回来（离线缓存 / 接口还没提交 / 验证夹具），
   * 用户就会看到「确认删除 → 消息全回来了」。
   * 保留标记 = 清空后界面就停在新对话态，这是用户点「删除」时预期的结果。
   */
  const clearSessionMessages = useCallback(
    async (sessionId: string): Promise<number> => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/messages`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const deleted: number = typeof data.deleted === 'number' ? data.deleted : 0;
        setSessions(prev =>
          prev.map(s => (s.id === sessionId ? { ...s, messages: [] } : s))
        );
        // 清空是**已拉取**状态下的空，不是「还在路上」——
        // 不标记的话界面会退回骨架屏，等一个不会来的加载
        markLoaded(sessionId);
        return deleted;
      } catch (error) {
        console.error('Failed to clear session messages:', error);
        return -1;
      }
    },
    [markLoaded]
  );

  // 保存每个会话的模型选择到 localStorage
  const updateSessionModel = useCallback((sessionId: string, modelId: string) => {
    setSessionModels(prev => {
      const updated = { ...prev, [sessionId]: modelId };
      localStorage.setItem(STORAGE_KEYS.sessionModels, JSON.stringify(updated));
      return updated;
    });
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, model: modelId } : s
    ));
  }, []);

  // 添加新会话
  const addSession = useCallback((session: Session) => {
    setSessions(prev => [session, ...prev]);
    setCurrentSessionId(session.id);
  }, []);

  // 更新会话
  const updateSession = useCallback((sessionId: string, updates: Partial<Session>) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, ...updates } : s
    ));
  }, []);

  // 更新会话消息
  const updateSessionMessages = useCallback((sessionId: string, updater: (messages: Message[]) => Message[]) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, messages: updater(s.messages) } : s
    ));
  }, []);

  /**
   * 置顶 / 取消置顶（消息列表右键菜单）。
   *
   * 乐观更新：先改本地让列表立刻重排，再落库。置顶是个「点了就该立刻看到」
   * 的动作，等一个来回的网络再重排会明显发木。
   *
   * 失败时回滚，但 **404 不算失败** —— 从通讯录发起、还没发首条消息的会话
   * 是纯本地对象，后端根本没有这条记录，此时 PATCH 必然 404。
   * 本地置顶状态先留着，等首条消息落库后由后续 PATCH 补上。
   */
  const setSessionPinned = useCallback(
    async (sessionId: string, pinned: boolean) => {
      const prev = sessions.find(s => s.id === sessionId)?.pinned ?? false;
      setSessions(p => p.map(s => (s.id === sessionId ? { ...s, pinned } : s)));

      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned }),
        });
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        console.warn('[Sessions] 置顶落库失败，已回滚:', error);
        setSessions(p => p.map(s => (s.id === sessionId ? { ...s, pinned: prev } : s)));
      }
    },
    [sessions]
  );

  /**
   * A62：改会话的思考强度档位（输入框里那颗下拉）。
   *
   * 与 setSessionPinned 同构：先本地改（界面立刻响应），再 PATCH 落库，
   * 失败回滚。**不静默失败** —— 用户改了档位、下一轮却没生效，
   * 比报错更难查。
   *
   * `value` 传 `''` 表示「回到 CLI 自己的默认」，后端把它存成 NULL。
   * 本地空壳会话（isLocal，还没落库）不发请求：值留在内存里，
   * 首条消息发出时由 /api/chat 一次性带过去。
   */
  const setSessionReasoningEffort = useCallback(
    async (sessionId: string, value: string) => {
      const prev = sessions.find(s => s.id === sessionId)?.reasoningEffort ?? undefined;
      setSessions(p => p.map(s => (s.id === sessionId ? { ...s, reasoningEffort: value } : s)));

      const target = sessions.find(s => s.id === sessionId);
      if (target?.isLocal) return;

      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reasoningEffort: value || null }),
        });
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        console.warn('[Sessions] 思考强度落库失败，已回滚:', error);
        setSessions(p => p.map(s => (s.id === sessionId ? { ...s, reasoningEffort: prev } : s)));
      }
    },
    [sessions]
  );

  /**
   * A63：改会话的工作目录（会话栏头的工作区徽标）。
   *
   * 与 setSessionReasoningEffort 同构：先本地改（界面立刻响应），再 PATCH
   * 落库，失败回滚。**不静默失败** —— 用户换了目录、下一轮却还在老地方
   * 干活，比报错更难查。
   *
   * 与档位的两点差别：
   *   1. `value` 传 `''` 表示清空（回到后端进程目录），后端存 null；
   *   2. 后端对非空值做**目录存在性校验**，400 时同样回滚 —— 坏值不进库，
   *      也不等发消息时才 spawn ENOENT。
   *
   * 本地空壳会话（isLocal，还没落库）不发请求：值留在内存里，首条消息
   * 发出时由 /api/chat 一次性带过去。
   */
  const setSessionCwd = useCallback(
    async (sessionId: string, value: string) => {
      const prev = sessions.find(s => s.id === sessionId)?.cwd;
      setSessions(p => p.map(s => (s.id === sessionId ? { ...s, cwd: value || undefined } : s)));

      const target = sessions.find(s => s.id === sessionId);
      if (target?.isLocal) return;

      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: value || null }),
        });
        if (!res.ok && res.status !== 404) {
          // 400 = 目录不存在（后端校验）。错误信息原样带给调用方，
          // 由 UI 决定怎么呈现 —— 这里只负责回滚到原值。
          const detail = await res.json().catch(() => null);
          throw new Error(detail?.error || `HTTP ${res.status}`);
        }
      } catch (error) {
        console.warn('[Sessions] 工作目录落库失败，已回滚:', error);
        setSessions(p => p.map(s => (s.id === sessionId ? { ...s, cwd: prev } : s)));
      }
    },
    [sessions]
  );

  // 当切换会话时，加载该会话的消息
  useEffect(() => {
    if (currentSessionId) {
      const session = sessions.find(s => s.id === currentSessionId);
      // isLocal 的会话还没落库，后端查不到，不发请求（否则控制台会留下 404）
      if (session && !session.isLocal && session.messages.length === 0) {
        loadSessionMessages(currentSessionId);
      }
    }
  }, [currentSessionId, sessions, loadSessionMessages]);

  /**
   * 这个会话的消息是否已经拉过一轮。
   *
   * 未落库的本地空壳会话（isLocal）永远是「已就绪」—— 它本来就没有消息，
   * 后端也查不到，不该让界面等一个不存在的请求。
   */
  const isMessagesLoaded = useCallback(
    (sessionId: string | null | undefined): boolean => {
      if (!sessionId) return false;
      const session = sessions.find(s => s.id === sessionId);
      if (session?.isLocal) return true;
      return loadedSessions.has(sessionId);
    },
    [sessions, loadedSessions]
  );

  return {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    sessionModels,
    fetchSessions,
    loadSessionMessages,
    isMessagesLoaded,
    deleteSession,
    updateSessionModel,
    addSession,
    updateSession,
    updateSessionMessages,
    setSessionPinned,
    setSessionReasoningEffort,
    setSessionCwd,
    clearSessionMessages,
  };
}
