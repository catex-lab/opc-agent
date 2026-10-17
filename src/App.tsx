import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { MessagesSquare, ArrowRight } from 'lucide-react';

import { useAgents } from './hooks/useAgents';
import { useTheme } from './hooks/useTheme';
import { useSessions } from './hooks/useSessions';
import { useModels } from './hooks/useModels';
import { useChat } from './hooks/useChat';
import { useAgentRegistry } from './hooks/useAgentRegistry';
import { getScenario } from './scenarios';
import { type PermissionMode, type CustomAgent, type Session, type Model, type OrchestrationMode } from './types';

import { NavRail, type NavKey } from './components/NavRail';
import { ConversationList, markSessionRead } from './components/ConversationList';
import { ContactsPanel } from './components/ContactsPanel';
import { AgentDetailPanel } from './components/AgentDetailPanel';
import { ChatHeader } from './components/ChatHeader';
import { SettingsPage } from './components/SettingsPage';
import type { Message } from './types';

/**
 * ChatPage 按需加载。
 *
 * 它连带引入 ChatMessages → ChatMarkdown → cherry-markdown，
 * 而 cherry-markdown 又把 mermaid / katex / highlight.js 一起拖进来，
 * 实测这条链占整个 bundle 的 **2 MB 以上**（gzip 后约 600 kB）。
 *
 * 但这些只有「真的在看消息」时才需要。用户打开应用先看到的是
 * 空态页或新建对话页 —— 那时候花 2 MB 去加载一个 markdown 渲染器是纯浪费。
 *
 * 打包态由 Electron 用 `http://127.0.0.1` 托管 dist，chunk 就是普通 HTTP
 * 请求，本地回环下延迟可忽略，所以这次拆分不会让用户感到「点了要等一下」。
 */
const ChatPage = lazy(() =>
  import('./pages/ChatPage').then(m => ({ default: m.ChatPage }))
);

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppContent />} />
      <Route path="/chat/:sessionId" element={<AppContent />} />
      <Route path="/settings" element={<AppContent />} />
    </Routes>
  );
}

function AppContent() {
  const navigate = useNavigate();
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const isSettingsPage = location.pathname === '/settings';

  const [nav, setNav] = useState<NavKey>('chats');
  /**
   * 正在查看资料的 Agent（通讯录点进去的二级页）。
   *
   * 用独立 state 而不是路由：资料页是「从通讯录临时点开看一眼」的浮层式
   * 二级页，关掉就回到原处。走路由会污染浏览历史 —— 用户按浏览器后退
   * 会退到上一个 Agent 的资料页，而不是离开通讯录。
   */
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);

  // Hooks
  const { theme, toggleTheme } = useTheme();
  // 旧的「自定义 Agent」功能保留在设置页里（本地提示词等）
  const { agents: customAgents, addAgent, updateAgent, deleteAgent } = useAgents();
  const { models, selectedModel, setSelectedModel, fetchModels } = useModels();
  const registry = useAgentRegistry();
  const {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    sessionModels,
    fetchSessions,
    deleteSession,
    updateSessionModel,
    addSession,
    updateSession,
    updateSessionMessages,
  } = useSessions();

  /**
   * useChat 与 ChatPage 目前仍按 CustomAgent 的形态取数据（systemPrompt /
   * permissionMode）。把注册表里的 Agent 映射成这个形态，避免改动这两处的
   * 内部逻辑；等自定义提示词功能整体迁移过去后可以再收掉这层适配。
   */
  const legacyAgents: CustomAgent[] = useMemo(
    () =>
      registry.agents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        systemPrompt: '',
        icon: a.icon,
        color: a.color,
        permissionMode: 'default' as PermissionMode,
        // P4-5：把注册表的能力矩阵一起带过去，场景页据此如实提示
        // 「该 Agent 无法强制只读」——否则用户会以为选了只读就真的只读。
        permissionSupport: a.permissionSupport,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    [registry.agents]
  );

  const getLegacyAgent = useCallback(
    (id: string) => legacyAgents.find(a => a.id === id),
    [legacyAgents]
  );

  const {
    isLoading,
    inputValue,
    setInputValue,
    permissionRequest,
    sendMessage,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  } = useChat({
    currentSession,
    currentSessionId,
    selectedModel,
    getAgent: getLegacyAgent,
    addSession,
    updateSession,
    updateSessionMessages,
    updateSessionModel,
    setCurrentSessionId,
    setSessions,
  });

  // 当前会话绑定的 Agent
  const currentAgent = registry.getAgent(currentSession?.agentId);
  const currentAgentId = currentAgent?.id;
  // 通讯录点开的资料页对象。名册刷新后若该 Agent 消失，这里自然变 undefined，
  // 资料页随之退回空态，不会停在一个已不存在的人身上。
  const detailAgent = detailAgentId ? registry.getAgent(detailAgentId) : undefined;
  // P4：当前会话绑定的场景（有则在头部显示场景标签）
  const currentScenario = getScenario(currentSession?.scenarioId);

  /**
   * 当前 Agent 自己的模型列表。
   *
   * 为什么不直接用全局的 SDK 模型列表：模型名是**各 Agent 私有的命名空间**。
   * 对 hermes / opencode 展示 claude-* 既不真实（选中后调用直接失败），
   * 也让「模型」这个控件对它们失去意义。列表为空 = 前端不显示下拉。
   */
  const [agentModels, setAgentModels] = useState<Model[]>([]);

  useEffect(() => {
    if (!currentAgentId) {
      setAgentModels([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(currentAgentId)}/models`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setAgentModels(Array.isArray(data.models) ? data.models : []);
      } catch {
        // 拿不到就当没有：宁可不显示下拉，也不塞一份不属于它的模型列表
        if (!cancelled) setAgentModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentAgentId]);

  /** SDK 类 Agent 用平台模型列表；其余用各自上报或声明的列表 */
  const activeModels = useMemo(() => {
    if (agentModels.length > 0) return agentModels;
    return currentAgent?.kind === 'sdk' ? models : [];
  }, [agentModels, currentAgent?.kind, models]);

  // 切到某个 Agent 后，若当前选中的模型不属于它，改用它的第一个模型。
  // 否则界面上会显示一个该 Agent 根本不认识的模型名。
  // 该 Agent 没有模型列表时（自管模型）清空选中：既避免显示一个陌生模型名，
  // 也不该为了这个空值去 PATCH 一次会话。
  useEffect(() => {
    if (activeModels.length === 0) {
      if (selectedModel) setSelectedModel('');
      return;
    }
    if (activeModels.some(m => m.modelId === selectedModel)) return;
    setSelectedModel(activeModels[0].modelId);
  }, [activeModels, selectedModel, setSelectedModel]);

  // 从 URL 同步 sessionId
  useEffect(() => {
    if (urlSessionId && urlSessionId !== currentSessionId) {
      setCurrentSessionId(urlSessionId);
    } else if (!urlSessionId && !isSettingsPage && currentSessionId) {
      setCurrentSessionId(null);
    }
  }, [urlSessionId, isSettingsPage, currentSessionId, setCurrentSessionId]);

  // 打开会话即标记已读（驱动未读红点）
  useEffect(() => {
    if (currentSessionId) markSessionRead(currentSessionId);
  }, [currentSessionId]);

  // 当切换会话时，恢复该会话的模型选择
  useEffect(() => {
    if (currentSessionId && sessionModels[currentSessionId]) {
      setSelectedModel(sessionModels[currentSessionId]);
    } else if (currentSession) {
      setSelectedModel(currentSession.model);
    }
  }, [currentSessionId, sessionModels, currentSession, setSelectedModel]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const updateCurrentSessionModel = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId);
      if (currentSessionId) updateSessionModel(currentSessionId, modelId);
    },
    [currentSessionId, updateSessionModel, setSelectedModel]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const navigateTo = await deleteSession(sessionId);
      if (navigateTo) navigate(navigateTo);
    },
    [deleteSession, navigate]
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setNav('chats');
      setCurrentSessionId(sessionId);
      navigate(`/chat/${sessionId}`);
    },
    [navigate, setCurrentSessionId]
  );

  const handleNewChat = useCallback(() => {
    setNav('contacts');
    setCurrentSessionId(null);
    navigate('/');
  }, [navigate, setCurrentSessionId]);

  /** 从通讯录发起一对一对话：先建一个空的本地会话，首条消息发出时后端落库 */
  const handleStartChatWith = useCallback(
    (agentId: string) => {
      // 从资料页点「发消息」时，资料页要让位给会话
      setDetailAgentId(null);
      const existing = sessions.find(s => s.agentId === agentId);
      if (existing) {
        handleSelectSession(existing.id);
        return;
      }

      const agent = registry.getAgent(agentId);
      const newSession: Session = {
        id: uuidv4(),
        title: agent?.name || '新对话',
        model: selectedModel,
        agentId,
        permissionMode: 'default',
        createdAt: new Date(),
        messages: [],
        // 尚未落库：首条消息发出时后端才会按这个 id 建记录
        isLocal: true,
      };

      setSessions(prev => [newSession, ...prev]);
      setNav('chats');
      setCurrentSessionId(newSession.id);
      navigate(`/chat/${newSession.id}`);
    },
    [sessions, registry, selectedModel, setSessions, setCurrentSessionId, navigate, handleSelectSession]
  );

  const handleNavigate = useCallback((key: NavKey) => {
    setNav(key);
    // 切换主导航时关掉资料页：否则点「聊天」后右侧还停在上一个 Agent 的资料
    setDetailAgentId(null);
    if (key === 'contacts') navigate('/');
  }, [navigate]);

  const handleOpenSettings = useCallback(() => navigate('/settings'), [navigate]);

  /**
   * 追加/合并一条群聊消息。
   *
   * 合并而不是替换：流式过程中同一 id 的消息会来很多次，每次只带增量字段
   * （正文、思考、某个工具的状态）。整条替换会把没在那一次事件里出现的
   * 字段（contentBlocks、thinking）抹掉。
   */
  const upsertGroupMessage = useCallback(
    (sessionId: string, message: Message) => {
      setSessions(prev =>
        prev.map(s => {
          if (s.id !== sessionId) return s;
          const idx = s.messages.findIndex(m => m.id === message.id);
          if (idx < 0) return { ...s, messages: [...s.messages, message] };
          const next = [...s.messages];
          next[idx] = { ...next[idx], ...message };
          return { ...s, messages: next };
        })
      );
    },
    [setSessions]
  );

  /**
   * 改群聊的编排模式。本地先改（界面立刻响应），再 PATCH 后端持久化。
   * 后端 /api/group-chat 每次请求也会带 mode，这里主要是为了让
   * 「刷新后模式还在」。
   */
  const handleOrchestrationChange = useCallback(
    (mode: OrchestrationMode) => {
      if (!currentSessionId) return;
      updateSession(currentSessionId, { orchestration: mode });
      void fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orchestration: mode }),
      }).catch(err => console.error('保存编排模式失败:', err));
    },
    [currentSessionId, updateSession]
  );

  /** 改群成员（本地 + PATCH）。目前只有建群时用到，预留增减成员的入口 */
  const handleMembersChange = useCallback(
    (agentIds: string[]) => {
      if (!currentSessionId) return;
      updateSession(currentSessionId, { agentIds });
      void fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentIds }),
      }).catch(err => console.error('保存群成员失败:', err));
    },
    [currentSessionId, updateSession]
  );

  /**
   * 从通讯录建群。
   *
   * 建的是**本地空壳会话**（isLocal）：后端要等首条消息发出才落库，
   * 在这之前 GET /api/sessions/:id 必然 404。这与一对一「从通讯录发起
   * 对话」是同一套时序，靠 isLocal 标记避免那次无意义的请求。
   */
  const handleCreateGroup = useCallback(
    (agentIds: string[]) => {
      if (agentIds.length === 0) return;
      const names = agentIds.map(id => registry.getAgent(id)?.name || id);
      const newSession: Session = {
        id: uuidv4(),
        title: names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' : ''),
        model: '',
        permissionMode: 'default',
        createdAt: new Date(),
        messages: [],
        kind: 'group',
        agentIds,
        orchestration: 'dispatch',
        isLocal: true,
      };
      setSessions(prev => [newSession, ...prev]);
      setNav('chats');
      setCurrentSessionId(newSession.id);
      navigate(`/chat/${newSession.id}`);
    },
    [registry, setSessions, setCurrentSessionId, navigate]
  );

  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  return (
    <div
      className="flex h-screen w-screen overflow-hidden"
      style={{ backgroundColor: 'var(--td-bg-color-page)' }}
    >
      {/* 最左：功能导航条 */}
      <NavRail
        active={isSettingsPage ? 'settings' : nav}
        theme={theme}
        readyCount={registry.readyCount}
        onNavigate={handleNavigate}
        onOpenSettings={handleOpenSettings}
        onToggleTheme={toggleTheme}
      />

      {isSettingsPage ? (
        <SettingsPage
          agents={customAgents}
          onAdd={addAgent}
          onUpdate={updateAgent}
          onDelete={deleteAgent}
        />
      ) : (
        <>
          {/* 中间：会话列表 或 通讯录 */}
          {nav === 'chats' ? (
            <ConversationList
              sessions={sessions}
              currentSessionId={currentSessionId}
              getAgent={registry.getAgent}
              onNewChat={handleNewChat}
              onSelect={handleSelectSession}
              onDelete={handleDeleteSession}
            />
          ) : (
            <ContactsPanel
              agents={registry.agents}
              grouped={registry.grouped}
              loading={registry.loading}
              probing={registry.probing}
              error={registry.error}
              onProbe={registry.probe}
              onCreateGroup={handleCreateGroup}
              onViewDetail={setDetailAgentId}
            />
          )}

          {/* 右侧：会话内容 */}
          <main
            className="flex min-w-0 flex-1 flex-col"
            style={{ backgroundColor: 'var(--td-bg-color-page)' }}
          >
            {detailAgent ? (
              <AgentDetailPanel
                agent={detailAgent}
                onBack={() => setDetailAgentId(null)}
                onStartChat={handleStartChatWith}
              />
            ) : currentSession ? (
              <>
                {/*
                  群聊用自己的头部（成员堆叠 + 编排模式），由 ChatPage 内部渲染；
                  一对一才用 ChatHeader。两套头部都基于同一个 PanelHeader，
                  规格统一，差别只在往槽位里填什么。
                */}
                {currentSession.kind !== 'group' && (
                  <ChatHeader
                    agent={currentAgent}
                    fallbackTitle={currentSession.title || '新对话'}
                    models={activeModels}
                    selectedModel={selectedModel}
                    isLoading={isLoading}
                    scenario={currentScenario}
                    onModelChange={updateCurrentSessionModel}
                    onDelete={() => handleDeleteSession(currentSession.id)}
                  />
                )}
                <Suspense
                  fallback={
                    <div
                      className="flex flex-1 items-center justify-center text-body"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      正在加载会话…
                    </div>
                  }
                >
                  <ChatPage
                    currentSession={currentSession}
                    currentSessionId={currentSessionId}
                    models={activeModels}
                    selectedModel={selectedModel}
                    agents={legacyAgents}
                    currentAgent={currentAgent}
                    getAgent={registry.getAgent}
                    upsertGroupMessage={upsertGroupMessage}
                    isLoading={isLoading}
                    inputValue={inputValue}
                    permissionRequest={permissionRequest}
                    permissionMode={permissionMode}
                    onSendMessage={sendMessage}
                    onStop={handleStop}
                    onInputChange={setInputValue}
                    onModelChange={updateCurrentSessionModel}
                    onPermissionAllow={handlePermissionAllow}
                    onPermissionDeny={handlePermissionDeny}
                    onPermissionModeChange={setPermissionMode}
                    onOrchestrationChange={handleOrchestrationChange}
                    onMembersChange={handleMembersChange}
                    onDelete={() => handleDeleteSession(currentSession.id)}
                  />
                </Suspense>
              </>
            ) : (
              <EmptyState
                readyCount={registry.readyCount}
                onGoContacts={() => setNav('contacts')}
                nav={nav}
              />
            )}
          </main>
        </>
      )}
    </div>
  );
}

/** 未选中会话时的空态 */
function EmptyState({
  readyCount,
  onGoContacts,
  nav,
}: {
  readyCount: number;
  onGoContacts: () => void;
  nav: NavKey;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      {/* 空态图标用品牌色淡底 + 品牌色线条，而不是灰色占位图。
          灰图标传达的是「这里什么都没有」，淡蓝底传达的是「等你开始」。 */}
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
        style={{
          backgroundColor: 'var(--td-brand-color-light)',
          color: 'var(--td-brand-color)',
        }}
      >
        <MessagesSquare size={26} strokeWidth={1.75} />
      </div>
      <h3 className="text-title font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
        {nav === 'contacts' ? '从左侧选一个 Agent 开始对话' : '选择一个会话，或发起新对话'}
      </h3>
      <p
        className="mt-2 max-w-[380px] text-body leading-relaxed"
        style={{ color: 'var(--td-text-color-secondary)' }}
      >
        本机共有 {readyCount} 个 Agent 处于在线状态。每个 Agent 都是通讯录里的一个联系人，
        可以单独对话，也可以拉进群聊协作。
      </p>
      {nav === 'chats' && (
        <button
          type="button"
          onClick={onGoContacts}
          className="tc-btn-brand mt-5 px-3.5 py-2 text-body"
        >
          打开通讯录
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

export default App;
