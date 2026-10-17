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
          scenarioId: s.scenario_id ?? undefined,
          systemPrompt: s.system_prompt ?? undefined,
          createdAt: new Date(s.created_at),
          messages: []
        }));
        setSessions(loadedSessions);
        // 列表重建后所有会话的 messages 都被清空，之前的「已尝试拉取」
        // 记录必须一并作废，否则消息会再也加载不出来。
        attemptedLoads.current.clear();
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
      // 尚未落库（404）或其它非 2xx：静默跳过，保留本地已有的消息
      if (!res.ok) return;
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
          // P4-4：生图消息的图片块。后端已解析成数组；这里再兜一层，
          // 只有确实是数组且非空才带上（坏值不该让整条消息渲染失败）
          images: Array.isArray(m.images) && m.images.length > 0 ? m.images : undefined
        }));

        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, messages } : s
        ));
      }
    } catch (error) {
      // 只有网络层失败才值得报错；同时撤销去重标记，允许后续重试
      attemptedLoads.current.delete(sessionId);
      console.error('Failed to load session messages:', error);
    }
  }, []);

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

  return {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    sessionModels,
    fetchSessions,
    loadSessionMessages,
    deleteSession,
    updateSessionModel,
    addSession,
    updateSession,
    updateSessionMessages,
  };
}
