import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  lazy,
  Suspense,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { MessagePlugin } from 'tdesign-react';

import { useAgents } from './hooks/useAgents';
import { useTheme } from './hooks/useTheme';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useSessions } from './hooks/useSessions';
import { useModels } from './hooks/useModels';
import { useChat } from './hooks/useChat';
import { useAgentRegistry } from './hooks/useAgentRegistry';
import { getScenario } from './scenarios';
import { exportSessionToMarkdown } from './utils/exportSession';
import { type PermissionMode, type CustomAgent, type Session, type Model, type OrchestrationMode, type Project, type AgentModelSource } from './types';

import { NavRail, type NavKey } from './components/NavRail';
import { TitleBar } from './components/TitleBar';
import { CursorGlow } from './components/CursorGlow';
import { ConversationList, markSessionRead } from './components/ConversationList';
import { ContactsPanel } from './components/ContactsPanel';
import { ProjectPanel } from './components/ProjectPanel';
import { ProjectDetail } from './components/ProjectDetail';
import { SidebarResizer } from './components/SidebarResizer';
import { pickDirectory } from './workspace';
import { AgentDetailPanel } from './components/AgentDetailPanel';
import { ChatHeader } from './components/ChatHeader';
import { WorkspacePanel } from './components/WorkspacePanel';
import { SettingsPage } from './components/SettingsPage';
import { PermissionDock } from './components/PermissionDock';
import { setSessionTitleResolver } from './permissions/permissionStore';
import { bootPref, pushPrefs } from './prefs';
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
      {/* A119：项目视图的深链。`/projects` = 只开列表栏、没选项目；
          `/projects/:projectId` = 连详情一起打开。刷新与前进/后退都能还原。 */}
      <Route path="/projects" element={<AppContent />} />
      <Route path="/projects/:projectId" element={<AppContent />} />
      <Route path="/settings" element={<AppContent />} />
    </Routes>
  );
}

function AppContent() {
  const navigate = useNavigate();
  const { sessionId: urlSessionId, projectId: urlProjectId } = useParams<{
    sessionId?: string;
    projectId?: string;
  }>();
  const location = useLocation();
  const isSettingsPage = location.pathname === '/settings';
  /**
   * A119：当前是不是停在项目视图。
   *
   * 判据是**路径前缀**而不是 `urlProjectId` 是否存在：`/projects`（没选具体
   * 项目）也属于项目视图，只看 projectId 会把这一档漏掉，刷新后退回聊天栏。
   */
  const isProjectsPath =
    location.pathname === '/projects' || location.pathname.startsWith('/projects/');

  /**
   * A117 起主导航只有状态、没有 URL，于是「切到项目栏再刷新」会掉回聊天视图。
   * A119 补上深链后，初始值直接从 URL 还原 —— 用惰性初始化而不是挂载后再
   * effect 改一遍，是为了避免首帧先渲染聊天栏、下一帧才换成项目栏的闪动。
   */
  const [nav, setNav] = useState<NavKey>(() => (isProjectsPath ? 'projects' : 'chats'));

  /**
   * A117：项目视图的状态。
   *
   * `projects` 放在 App 层而不是 ProjectPanel 内部：右侧详情页也要用同一个
   * 项目对象（名字、路径、记忆统计），两栏各拉一份会出现「列表已改名、
   * 详情还是旧名」这种半秒不一致。
   *
   * 拉取时机是「首次切到项目栏」而不是启动即拉：`GET /api/projects` 会
   * 顺带算每个项目的记忆 token 与技能数（要读磁盘），启动时白白多付一次
   * 与首屏无关的开销。
   */
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => urlProjectId ?? null
  );

  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const r = await fetch('/api/projects');
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `读取项目失败（${r.status}）`);
      const list: Project[] = (j.projects ?? []).map((p: any) => ({
        id: p.id,
        path: p.path,
        name: p.name,
        createdAt: p.created_at,
        lastOpenedAt: p.last_opened_at,
        sessionCount: p.sessionCount ?? 0,
        memory: p.memory ?? null,
      }));
      setProjects(list);
      // 只清理失效的选中项（项目被删），**不自动选第一个**：
      // 自动选中会让窄屏用户一进项目栏就落在某个详情页上、看不到列表，
      // 而宽屏则是一进来就有内容 —— 两种屏幕的行为不一致，且「为什么是
      // 这个项目」说不清。统一成「没选就是没选」，右侧给一句提示。
      setSelectedProjectId(prev => (prev && list.some(p => p.id === prev) ? prev : null));
    } catch (e: any) {
      setProjectsError(e?.message || '读取项目失败');
    } finally {
      setProjectsLoading(false);
    }
  }, []);
  /**
   * 正在查看资料的 Agent（通讯录点进去的二级页）。
   *
   * 用独立 state 而不是路由：资料页是「从通讯录临时点开看一眼」的浮层式
   * 二级页，关掉就回到原处。走路由会污染浏览历史 —— 用户按浏览器后退
   * 会退到上一个 Agent 的资料页，而不是离开通讯录。
   */
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);

  /**
   * A77：右侧工作区文件面板是否展开。
   *
   * 持久化到 localStorage：它是**布局偏好**，不是会话状态。用户收起它
   * 通常是「这块屏幕不够宽」，下次开应用不该又自己弹回来。
   *
   * 读的时候包 try：隐私模式 / 禁用存储时 localStorage 会抛，而这是
   * 首屏渲染路径上的一次读取 —— 为它崩掉整个应用不值得。
   */
  const [workspaceOpen, setWorkspaceOpen] = useState<boolean>(() => {
    // A135：服务端注入的那份优先（打包态每次启动换端口 ⇒ localStorage 归零）
    const injected = bootPref('workspaceOpen');
    if (injected !== undefined) return injected;
    try {
      return localStorage.getItem('opc.workspace-open') === '1';
    } catch {
      return false;
    }
  });

  const toggleWorkspace = useCallback(() => {
    setWorkspaceOpen(prev => {
      const next = !prev;
      try {
        localStorage.setItem('opc.workspace-open', next ? '1' : '0');
      } catch {
        /* 写不进去只影响下次启动的默认值，本次行为不受影响 */
      }
      pushPrefs({ workspaceOpen: next });
      return next;
    });
  }, []);

  // Hooks
  const { preference, setPreference } = useTheme();
  /**
   * 单栏模式（窄屏）。
   *
   * 阈值 900：再窄下去「导航条 64 + 列表 272 + 内容」里内容区只剩 560 上下，
   * 消息气泡和输入框都会被挤成细条。到这条线以下就改成「列表与内容二选一」，
   * 用标题栏左侧的返回键回列表 —— 这是 IM 在手机上的标准行为。
   */
  const compact = useMediaQuery('(max-width: 899px)');
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
    setSessionPinned,
    setSessionReasoningEffort,
    setSessionPermissionMode,
    setSessionCwd,
    clearSessionMessages,
    isMessagesLoaded,
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
    sendMessage,
    regenerate,
    handleStop,
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
  /**
   * 该 Agent 自己的默认模型（后端随模型列表一起给出）。
   *
   * 为什么需要：模型列表按 provider 分组、免费在前，第一条**不是**默认模型
   * （opencode 的默认是 zai/glm-4.7，列表第一条是 OpenCode Zen 的免费模型）。
   * 靠下标选初始值等于把「默认」这个语义丢掉，用户会在不知情时换掉模型。
   */
  const [agentDefaultModel, setAgentDefaultModel] = useState<string>('');

  /**
   * 模型清单的来源与可切换性（A151）。
   *
   * 默认 `selectable: true`：绝大多数 Agent 走 catalog 那条路，不能因为
   * 请求还没回来就把下拉禁掉。只有后端明确说 `selectable: false`
   * （目前只有 zcode 的只读清单）才切成只读。
   */
  const [agentModelSource, setAgentModelSource] = useState<AgentModelSource & { forAgent?: string }>({
    kind: 'unknown',
    selectable: true,
  });

  /**
   * 模型清单的「代号」。
   *
   * 设置页里点了「刷新模型清单」之后，后端会重新枚举，但下面那个 effect 只
   * 依赖 `currentAgentId` —— 用户刷完回到会话，菜单还是刷新前那份，等于按钮
   * 白点了。改一个计数器当依赖，就能在不换 Agent 的情况下强制重取。
   */
  const [modelsEpoch, setModelsEpoch] = useState(0);

  useEffect(() => {
    if (!currentAgentId) {
      setAgentModels([]);
      setAgentDefaultModel('');
      setAgentModelSource({ kind: 'unknown', selectable: true });
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
        if (!cancelled) {
          setAgentModels(Array.isArray(data.models) ? data.models : []);
          setAgentDefaultModel(typeof data.defaultModel === 'string' ? data.defaultModel : '');
          /* A151：后端会明确说这份清单是哪来的、能不能切。
             老服务端不返回这两个字段时按「有列表就可选」处理 —— 向后兼容，
             别把升级前的响应解读成「只读」。 */
          const kind: AgentModelSource['kind'] =
            data.source === 'agent-config'
              ? 'agent-config'
              : data.source === 'manual'
                ? 'manual'
                : data.source === 'catalog'
                  ? 'catalog'
                  : 'unknown';
          setAgentModelSource({
            kind,
            selectable: data.selectable !== false,
            // P3：手动填模型名模式。后端只在这种 Agent **真的接受 --model**
            // 时才会给，前端不自己判断。
            manual: kind === 'manual' && data.manual !== false,
            note: typeof data.note === 'string' ? data.note : undefined,
            currentModel:
              kind === 'agent-config' && typeof data.defaultModel === 'string'
                ? data.defaultModel
                : undefined,
            // 这份结论属于哪个 Agent —— 切 Agent 时旧结论不能沿用
            forAgent: currentAgentId,
          });
        }
      } catch {
        // 拿不到就当没有：宁可不显示下拉，也不塞一份不属于它的模型列表
        if (!cancelled) {
          setAgentModels([]);
          setAgentDefaultModel('');
          setAgentModelSource({ kind: 'unknown', selectable: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentAgentId, modelsEpoch]);

  /** SDK 类 Agent 用平台模型列表；其余用各自上报或声明的列表 */
  const activeModels = useMemo(() => {
    if (agentModels.length > 0) return agentModels;
    return currentAgent?.kind === 'sdk' ? models : [];
  }, [agentModels, currentAgent?.kind, models]);

  /** 与 activeModels 配套的来源信息；SDK 类退回平台清单时同样是可选的 catalog */
  const activeModelSource = useMemo<AgentModelSource>(() => {
    /* 判据不能是「列表非空」：手动模式（P3）与只读清单都可能是空数组，
       按长度判会把刚拿到的结论丢掉，界面又退回「模型由 Agent 决定」。
       所以认的是「这份结论是不是当前这个 Agent 的」。 */
    if (agentModelSource.forAgent === currentAgentId) return agentModelSource;
    if (agentModels.length > 0) return agentModelSource;
    if (currentAgent?.kind === 'sdk' && models.length > 0) {
      return { kind: 'catalog', selectable: true };
    }
    return { kind: 'unknown', selectable: true };
  }, [agentModels, agentModelSource, currentAgent?.kind, currentAgentId, models]);

  /**
   * **能真正传下去**的模型（A151）。
   *
   * 只读清单（zcode 从配置文件读出来的 13 条）不能参与「自动选一个」——
   * 否则会挑中第一条「BigModel - Coding Plan」写进会话，发出去时被 CLI
   * 忽略，界面上却显示已选中。那正是这个项目一直在守的假控件。
   */
  const pickableModels = useMemo(
    () => (activeModelSource.selectable ? activeModels : []),
    [activeModelSource.selectable, activeModels]
  );

  /**
   * 手动填模型名模式（P3）。
   *
   * 这一类 Agent 的 `models` 恒为空（没有枚举命令），但用户填的名字
   * **真的能传下去**。所以不能走下面那条「列表为空就清空选中」的规则 ——
   * 那会在每次渲染时把用户刚填的模型名抹掉。
   */
  const manualModel = !!activeModelSource.manual;

  /**
   * 标定一个「未验证」模型（A151 / P2）。
   *
   * 触发点只有一个：用户**在菜单里点了那一条**。不挂在打开菜单、启动应用
   * 这类自动路径上 —— 一次标定要真起一次 CLI（qoder 冷态实测 8-20s）、
   * 真花 token，十几条一起跑就是十几分钟的黑屏。
   *
   * 返回值决定浮层的下一步：`ok` 才写进会话，否则把 CLI 的**原话**贴出来。
   * 改写过的「不可用」用户没法判断是自己账号的问题还是模型名的问题。
   *
   * 成功时 `modelsEpoch++` 让清单重取一次：那条的 `verified` 会变成 true，
   * 「未验证」角标随之消失。只改本地 state 不够 —— 刷新一次又回来了。
   */
  const handleProbeModel = useCallback(
    async (
      modelId: string
    ): Promise<{ ok: boolean; message?: string; verdict?: 'ok' | 'routed' | 'invalid' | 'unknown' }> => {
      if (!currentAgentId) return { ok: false, message: '当前没有绑定 Agent，无法标定' };
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(currentAgentId)}/models/probe`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ models: [modelId] }),
          }
        );
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          return { ok: false, message: data?.error || `标定失败（HTTP ${res.status}）` };
        }
        const rec = data?.results?.[modelId];
        if (!rec) return { ok: false, message: '标定没有返回结果' };
        if (rec.verdict === 'ok' || rec.verdict === 'routed') {
          setModelsEpoch(e => e + 1);
          return { ok: true, verdict: rec.verdict };
        }
        if (rec.verdict === 'invalid') {
          return {
            ok: false,
            verdict: 'invalid',
            message: `该模型在本机不可用：${rec.evidence || 'CLI 说这个名字不存在'}`,
          };
        }
        /* unknown 与 invalid 必须分开报：invalid 是「CLI 明确说没这个名字」，
           unknown 是「CLI 没给出可判读的回应」（超时 / 没装 / 没登录）。
           手动模式（P3）下前者不许选中，后者允许用户自己决定 —— 比如
           claude 本机缺 native binary，永远判 unknown，一刀切会把这个功能
           直接锁死。 */
        return {
          ok: false,
          verdict: 'unknown',
          message: `CLI 没有给出可判读的回应：${rec.evidence || '无输出'}`,
        };
      } catch (e: any) {
        return { ok: false, message: e?.message || '标定请求失败' };
      }
    },
    [currentAgentId]
  );

  // 切到某个 Agent 后，若当前选中的模型不属于它，改用**它自己的默认模型**
  // （后端随列表给出），拿不到默认值时才退到第一条。
  // 否则界面上会显示一个该 Agent 根本不认识的模型名。
  // 该 Agent 没有模型列表时（自管模型）清空选中：既避免显示一个陌生模型名，
  // 也不该为了这个空值去 PATCH 一次会话。
  useEffect(() => {
    // 手动模式（P3）：模型名是用户自己填的，这里没有「列表」可比对，
    // 一旦按列表清空就等于把用户填的值抹掉。
    if (manualModel) return;
    if (pickableModels.length === 0) {
      if (selectedModel) setSelectedModel('');
      return;
    }
    if (pickableModels.some(m => m.modelId === selectedModel)) return;
    const preferred = pickableModels.some(m => m.modelId === agentDefaultModel)
      ? agentDefaultModel
      : pickableModels[0].modelId;
    setSelectedModel(preferred);
  }, [pickableModels, selectedModel, setSelectedModel, agentDefaultModel, manualModel]);

  // 从 URL 同步 sessionId
  useEffect(() => {
    if (urlSessionId && urlSessionId !== currentSessionId) {
      setCurrentSessionId(urlSessionId);
    } else if (!urlSessionId && !isSettingsPage && currentSessionId) {
      setCurrentSessionId(null);
    }
  }, [urlSessionId, isSettingsPage, currentSessionId, setCurrentSessionId]);

  /**
   * A119：URL → 项目视图状态的同步（深链的另一半）。
   *
   * 深链要**双向**才成立：`handleSelectProject` 负责 state → URL，这里负责
   * URL → state（刷新、前进/后退、直接粘一个链接进来）。只做单向的话，
   * 浏览器后退会退到上一个项目，界面却停在原地。
   *
   * 清空分支（`/projects` 而没有 projectId）是必须的：从 `/projects/A`
   * 退到 `/projects` 时若不清，右侧会继续挂着 A 的详情 —— URL 说没选、
   * 界面说选了。
   */
  useEffect(() => {
    if (!isProjectsPath) return;
    setNav('projects');
    setDetailAgentId(null);
    if (urlProjectId && urlProjectId !== selectedProjectId) {
      setSelectedProjectId(urlProjectId);
    } else if (!urlProjectId && selectedProjectId) {
      setSelectedProjectId(null);
    }
  }, [isProjectsPath, urlProjectId, selectedProjectId]);

  /**
   * A119：深链里的项目已经不存在（被删掉）时，把 URL 收回 `/projects`。
   *
   * 必须在「列表确实拉过一轮」之后再判断：首帧 `projects` 还是空数组，
   * 直接比会把一个完全合法的深链误判成失效，用户刷新一下就被踢回列表。
   * 所以三个前置条件缺一不可 —— 在加载中、拉取报错、列表为空，一律不判。
   */
  useEffect(() => {
    if (!isProjectsPath || !urlProjectId) return;
    if (projectsLoading || projectsError || projects.length === 0) return;
    if (projects.some(p => p.id === urlProjectId)) return;
    navigate('/projects', { replace: true });
  }, [isProjectsPath, urlProjectId, projects, projectsLoading, projectsError, navigate]);

  // 打开会话即标记已读（驱动未读红点）
  useEffect(() => {
    if (currentSessionId) markSessionRead(currentSessionId);
  }, [currentSessionId]);

  // 当切换会话时，恢复该会话的模型选择。
  // 会话里**没有记模型**（新会话 / 老数据）时不要写空值 —— 那会把上面
  // 按 Agent 默认模型选好的值清掉，界面变成一个空的模型下拉。
  // 该 Agent 真的没有模型列表时，由上面的 effect 负责清空。
  useEffect(() => {
    if (currentSessionId && sessionModels[currentSessionId]) {
      setSelectedModel(sessionModels[currentSessionId]);
    } else if (currentSession?.model) {
      setSelectedModel(currentSession.model);
    }
  }, [currentSessionId, sessionModels, currentSession, setSelectedModel]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  /**
   * A117：每次进入项目栏都拉一次项目列表。
   *
   * 为什么不在启动时拉：`GET /api/projects` 要读每个项目的记忆文件来算
   * token 占用，那是磁盘 IO，与首屏无关。
   *
   * 为什么不做「只拉一次」：项目列表里有两个数会**在别的页面变**——
   * `sessionCount`（删会话 / 新会话落库）和 `memory`（用户在设置页改了
   * 项目记忆）。只拉一次的话，用户切回来看到的是一份过期快照，而界面上
   * 没有任何线索说明它是旧的。项目数量级是「十几个目录」，重拉一次的
   * 成本远低于「数字不对」的困惑。
   *
   * 列表非空时不显示 loading 文案（见 ProjectPanel 里 `loading && length===0`
   * 的判断），所以重拉不会闪一下骨架。
   */
  useEffect(() => {
    if (nav !== 'projects') return;
    void fetchProjects();
  }, [nav, fetchProjects]);

  const updateCurrentSessionModel = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId);
      // A135：用户亲手选过的模型成为下次启动的默认（原来只落在 localStorage，
      // 打包态换端口就没了）。会话级那份仍由 updateSessionModel 管，两者不冲突。
      pushPrefs({ defaultModel: modelId });
      if (currentSessionId) updateSessionModel(currentSessionId, modelId);
    },
    [currentSessionId, updateSessionModel, setSelectedModel]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const navigateTo = await deleteSession(sessionId);
      // A117：删会话会改变它所属项目的 sessionCount，而那个数是后端在
      // GET /api/projects 里算的 —— 重拉一次，项目列表的数字才跟着变。
      // 只在「用户已经用过项目栏」时才拉：从没打开过项目栏的人，不该因为
      // 删了一条会话就多付一次「读所有项目记忆文件」的开销。
      if (projects.length > 0) void fetchProjects();
      if (navigateTo) navigate(navigateTo);
    },
    [deleteSession, navigate, fetchProjects, projects.length]
  );

  /**
   * 导出会话为 Markdown（P6）。
   *
   * 成败都要给反馈：下载动作发生在浏览器里，用户看不到文件系统，
   * 静默成功和静默失败都让人以为「点了没反应」。Agent 名用注册表
   * 现译，群聊导出时每个气泡才有作者名（而不是一串 id）。
   */
  const handleExportSession = useCallback(
    async (sessionId: string) => {
      try {
        const { fileName } = await exportSessionToMarkdown(
          sessionId,
          id => registry.getAgent(id)?.name ?? id
        );
        MessagePlugin.success(`已导出 ${fileName}`);
      } catch (err) {
        MessagePlugin.error(`导出失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [registry]
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      // A48（反馈）：从通讯录点开某个 Agent 的资料页后，再去点群聊目录里的群
      // （或会话列表里的会话），右侧必须让位给会话。资料页的渲染优先级高于会话
      // （见下面 `detailAgent ? ... : currentSession ? ...`），不清掉它就会
      // 「地址跳到 /chat/xxx，右侧还停在联系人详情」。
      setDetailAgentId(null);
      setNav('chats');
      setCurrentSessionId(sessionId);
      navigate(`/chat/${sessionId}`);
    },
    [navigate, setCurrentSessionId]
  );

  /**
   * A132：把「会话 id → 标题」注册给权限 store，供系统通知用。
   *
   * store 在 App 之外（不依赖 React），拿不到会话列表；反过来由 App 注册进去，
   * 通知标题才写得出「研发小组 等待授权」而不是一串 UUID。
   */
  useEffect(() => {
    setSessionTitleResolver(id => sessions.find(s => s.id === id)?.title || '未知会话');
    return () => setSessionTitleResolver(null);
  }, [sessions]);

  /**
   * A132：点系统通知 → 跳到那条会话。
   *
   * 只做「定位」，**不做任何答复** —— 通知里没有批准按钮，这条桥也不提供
   * 「批准」通道（`preload.cjs` 里刻意没有 permission-response）。
   * 浏览器开发态没有 `window.opc`，可选链直接跳过。
   */
  useEffect(() => {
    const bridge = (window as unknown as {
      opc?: { onPermissionFocus?: (cb: (sessionId: string) => void) => () => void };
    }).opc;
    const off = bridge?.onPermissionFocus?.(id => handleSelectSession(id));
    return () => off?.();
  }, [handleSelectSession]);

  /**
   * A119：选中一个项目 —— 状态与 URL 一起改。
   *
   * 为什么不在 effect 里由 state 反推 URL：那样「点一下多一条历史记录」和
   * 「state 被别处改（比如刚添加完项目）也顺带改 URL」会混在一起，出问题时
   * 分不清是谁触发的。这里显式成对调用，因果一眼可见。
   *
   * `null` = 回到「项目栏但没选具体项目」，对应 `/projects`。
   */
  const handleSelectProject = useCallback(
    (projectId: string | null) => {
      setSelectedProjectId(projectId);
      navigate(projectId ? `/projects/${projectId}` : '/projects');
    },
    [navigate]
  );

  /**
   * A117：添加项目。
   *
   * 两个入口合一：不传 `cwd` 时开原生目录对话框（Electron），传了就按手输
   * 路径提交（浏览器开发态 / 验证脚本没有 `window.opc`）。
   * 后端是「取或建」—— 同一个目录重复添加只会刷新 last_opened_at，不会
   * 造出第二行，所以这里不必先查重。
   */
  const handleAddProject = useCallback(async (cwd?: string) => {
    let dir = cwd;
    if (!dir) {
      const picked = await pickDirectory();
      if (!picked) return; // 用户取消 / 当前环境没有原生对话框：安静退出
      dir = picked;
    }
    try {
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: dir }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || '添加项目失败');
      await fetchProjects();
      if (j.project?.id) handleSelectProject(j.project.id);
      MessagePlugin.success(`已添加项目「${j.project?.name ?? dir}」`);
    } catch (e: any) {
      // 目录不存在是这里最常见的失败（后端 validateDirectory 会拦），
      // 必须把后端那句话原样给用户 —— 它带着具体路径，比「添加失败」有用得多。
      MessagePlugin.error(e?.message || '添加项目失败');
    }
  }, [fetchProjects, handleSelectProject]);

  /** 在项目下开新会话：cwd 一起带上，后端会按 cwd 自动绑到同一个项目（A98） */
  const handleNewSessionInProject = useCallback(
    (project: Project, agentId: string) => {
      const agent = registry.getAgent(agentId);
      const newSession: Session = {
        id: uuidv4(),
        title: agent?.name || '新对话',
        model: selectedModel,
        agentId,
        permissionMode: 'default',
        createdAt: new Date(),
        messages: [],
        cwd: project.path,
        // 本地先标上，落库前就能在项目详情里看见；后端会按 cwd 算出同一个 id
        projectId: project.id,
        isLocal: true,
      };
      setSessions(prev => [newSession, ...prev]);
      setNav('chats');
      setCurrentSessionId(newSession.id);
      navigate(`/chat/${newSession.id}`);
    },
    [registry, selectedModel, setSessions, setCurrentSessionId, navigate]
  );

  const handleRenameProject = useCallback(async (project: Project, name: string) => {
    try {
      const r = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || '重命名失败');
      }
      // 本地先改，避免等一次往返才看到新名字
      setProjects(prev => prev.map(p => (p.id === project.id ? { ...p, name } : p)));
    } catch (e: any) {
      MessagePlugin.error(e?.message || '重命名失败');
      await fetchProjects();
    }
  }, [fetchProjects]);

  const handleDeleteProject = useCallback(async (project: Project) => {
    try {
      const r = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || '移除项目失败');
      }
      await fetchProjects();
      // 会话的 project_id 已被后端置空 —— 本地那份也要跟着清，否则项目
      // 视图里还能看见已经解绑的会话（要等下一次 fetchSessions 才消失）
      setSessions(prev => prev.map(s => (s.projectId === project.id ? { ...s, projectId: undefined } : s)));
      // A119：选中态与 URL 一起收。只清 state 的话，深链同步的 effect 会
      // 拿 URL 里的旧 id 把它写回去（URL 说还选着、库里已经没有这个项目）。
      if (selectedProjectId === project.id) handleSelectProject(null);
      MessagePlugin.success(`已移除「${project.name}」`);
    } catch (e: any) {
      MessagePlugin.error(e?.message || '移除项目失败');
    }
  }, [fetchProjects, setSessions, selectedProjectId, handleSelectProject]);

  /**
   * A33 分支：把「截至这条消息」的会话复制成一个新会话并跳过去。
   *
   * 复制发生在**后端**（会话元数据 + 全部消息逐条重落），前端只拿新 id 走
   * 「刷新列表 → 选中 → 导航」三步。为什么不本地复制：消息里可能带图片
   * 块、成本统计、blocks JSON，本地拼一份迟早与库里的口径不一致，
   * 而刷新后真正被读出来的是库里那份。
   */
  const handleBranch = useCallback(
    async (message: Message) => {
      if (!currentSessionId) return;
      try {
        const res = await fetch(`/api/sessions/${currentSessionId}/branch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: message.id }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        // 新会话不在本地列表里，必须先拉一次列表 —— 否则刷新后它会消失
        await fetchSessions();
        handleSelectSession(j.sessionId);
        MessagePlugin.success(`已分支出新会话（${j.messageCount} 条历史）`);
      } catch (err) {
        MessagePlugin.error(
          `分支失败：${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [currentSessionId, fetchSessions, handleSelectSession]
  );

  /**
   * 会话栏「+」菜单里的「重新探测」。
   *
   * 这个应用里没有「加好友」——联系人就是本机已装、能被探测到的 Agent。
   * 所以「重新探测」的正确落点是**通讯录 + 重新探测**：新装一个 Agent
   * 之后，用户点这里就能让它出现在名单里，而不是给一个填 ID 的空表单。
   */
  const handleAddContacts = useCallback(() => {
    setNav('contacts');
    setCurrentSessionId(null);
    navigate('/');
    registry.probe();
  }, [navigate, registry.probe, setCurrentSessionId]);

  /**
   * 从通讯录发起一对一对话：先建一个空的本地会话，首条消息发出时后端落库。
   *
   * A119：这个空壳会话**就是「新建对话页」的载体** —— 内容区只在
   * `currentSession` 存在时才渲染 ChatPage，而 ChatPage 在「会话为空」时
   * 整页渲染 NewChatView。所以「先建空壳」不是冗余动作，是进入新建页的
   * 唯一路径（项目详情里的「新建会话」同理）。
   *
   * 由此带来一个必须一起修的约束：空壳会话绑的 Agent 才是**事实**，
   * 新建页里那张 Agent 卡片的高亮/预览必须跟着它走，不能各说各话。
   * 见 ChatPage 的 `draftAgentId` 与 `onRebindAgent`。
   */
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

  /**
   * A119：给「还没发过消息的空壳会话」换 Agent。
   *
   * 场景：通讯录点「发消息」→ 建了绑 Agent A 的空壳会话 → 落在新建页 →
   * 用户改主意想用 B。早先那张卡片点了没有任何效果（新建页的选中态读的是
   * 它自己那份 state，跟会话绑的 agentId 是两回事），是个假控件。
   *
   * 只由 ChatPage 在「会话一条消息都没有」时调用 —— 聊过一半换 Agent
   * 语义上说不通：历史消息是前一个 Agent 的上下文，换掉等于换了个会话
   * 却留着别人的对话记录。
   *
   * 落库与否分开处理：本地空壳只改内存（首条消息会带着新 agentId 落库，
   * 那时后端才第一次见到这个会话），已经存在于服务端的空会话走 PATCH。
   * 后者真的会发生：清空聊天记录后会话仍在库里、消息数归零，新建页会
   * 重新出现。
   */
  const handleRebindAgent = useCallback(
    (agentId: string) => {
      if (!currentSessionId) return;
      const target = sessions.find(s => s.id === currentSessionId);
      if (!target) return;

      const nextAgent = registry.getAgent(agentId);
      const prevAgent = target.agentId ? registry.getAgent(target.agentId) : undefined;
      // 标题还是「新对话」或上一个 Agent 的名字时，跟着换成新 Agent 的名字；
      // 用户自己起过名就一个字都别动。
      const autoTitle = !target.title || target.title === '新对话' || target.title === prevAgent?.name;

      updateSession(currentSessionId, {
        agentId,
        ...(autoTitle && nextAgent?.name ? { title: nextAgent.name } : {}),
      });

      if (!target.isLocal) {
        void fetch(`/api/sessions/${currentSessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId }),
        });
      }
    },
    [currentSessionId, sessions, registry, updateSession]
  );

  /**
   * 切换主导航。
   *
   * ## 为什么这里要**同步**清掉当前会话（2026-10-18 修卡顿）
   *
   * 从设置页点「消息 / 通讯录」时，原先只 `navigate('/')`，会话 id 由
   * 「URL → sessionId」的 effect 在**渲染之后**清掉。于是这一帧里
   * `currentSession` 还在：
   *   ① React 先把整个 ChatPage 挂起来（懒加载组件 + 整段聊天记录重渲染，
   *      消息里的 markdown 全部重新解析）；
   *   ② effect 跑完，session 变 null，ChatPage 立刻又被卸载。
   * 一次点击要付一次「完整挂载 + 完整卸载」的代价 —— 用户感受到的就是
   * 「从设置页切回消息/通讯录明显卡一下」，会话越长越明显。
   *
   * 现在在同一个 handler 里先清会话再导航：第一帧就没有 ChatPage，
   * 那一次昂贵的挂载根本不会发生。
   *
   * 注意「消息」页在**非**设置页时不清理 —— 那里点「消息」的语义是
   * 「回到消息栏」，右侧正在看的会话应该留着。
   */
  const handleNavigate = useCallback((key: NavKey) => {
    setNav(key);
    // 切换主导航时关掉资料页：否则点「聊天」后右侧还停在上一个 Agent 的资料
    setDetailAgentId(null);
    // A117：「项目」与通讯录同理 —— 它占的是列表栏，右侧换成项目详情。
    // 不清会话的话，切到项目栏的第一帧右侧还会挂着 ChatPage（同上那段代价）。
    if (key === 'contacts' || isSettingsPage) {
      setCurrentSessionId(null);
      navigate('/');
    } else if (key === 'projects') {
      // A119：项目栏有自己的 URL，不能再走 `navigate('/')`（那会让刷新退回
      // 聊天视图）。用**当前选中**的项目拼路径而不是固定跳 `/projects`：
      // 从聊天栏切回来时用户多半还想接着看刚才那个项目，清掉选中等于每次
      // 都逼他重新点一遍。
      setCurrentSessionId(null);
      navigate(selectedProjectId ? `/projects/${selectedProjectId}` : '/projects');
    }
  }, [navigate, isSettingsPage, setCurrentSessionId, selectedProjectId]);

  /**
   * A37：设置从「整页路由」改成「弹窗」。
   *
   * 路由仍然是 `/settings`（深链、刷新、返回键都还能用），但界面上不再
   * 把主内容替换掉 —— 会话留在下面当背景，设置浮在上面。
   *
   * 关闭时要回到**打开它之前**那一页，而不是固定跳回首页：用户常常是
   * 「正在看某个会话 → 改个外观 → 关掉继续看」，跳回首页等于把上下文弄丢。
   */
  const settingsReturnRef = useRef('/');
  const handleOpenSettings = useCallback(() => {
    const here = location.pathname;
    if (here && here !== '/settings') settingsReturnRef.current = here;
    navigate('/settings');
  }, [navigate, location.pathname]);

  /**
   * 打开设置并定位到某条 Agent 的凭据行（A71）。
   *
   * 为什么带 `?agent=` 而不是只打开设置页：`method:'key'` 的条目（豆包 / Kimi /
   * WorkBuddy）的下一步就是"填一个 Key"，而设置页里有好几行凭据。只把用户送到
   * 门口、让他自己在一列里找，等于把「快捷」丢掉了一半。
   */
  const handleOpenCredential = useCallback(
    (agentId: string) => {
      const here = location.pathname;
      if (here && here !== '/settings') settingsReturnRef.current = here;
      // A129：自建厂商的 Key 归「自定义模型厂商」编辑器管，凭据列表里没有它的行 ——
      // 带 `?agent=` 过去会找不到锚点，直接落到那个分区。
      if (agentId.startsWith('custom-')) {
        navigate('/settings?section=login');
        return;
      }
      navigate(`/settings?agent=${encodeURIComponent(agentId)}`);
    },
    [navigate, location.pathname]
  );

  const handleCloseSettings = useCallback(() => {
    const back = settingsReturnRef.current;
    navigate(back && back !== '/settings' ? back : '/');
  }, [navigate]);

  /**
   * 去设置页添加一个模型厂商（A129）。
   *
   * 与 `handleOpenCredential` 同一套返回逻辑：记下来处，关闭设置后回到原来的
   * 页面。不带 `?agent=`，直接落到「登录配置」分区 —— 厂商编辑器在里面。
   */
  const handleAddProvider = useCallback(() => {
    const here = location.pathname;
    if (here && here !== '/settings') settingsReturnRef.current = here;
    navigate('/settings?section=login&provider=add');
  }, [navigate, location.pathname]);

  /**
   * 删除一个自建 Agent（A114）。
   *
   * 后端会一并清掉定义、Key 与内存态。删完必须重拉名册，否则通讯录里
   * 还挂着这一条，点进去又是 404。detailAgent 也一并关掉 —— 它引用的
   * 就是刚被删掉的那个对象。
   */
  const handleDeleteCustomAgent = useCallback(
    async (agentId: string) => {
      try {
        const res = await fetch(`/api/agents/custom/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          MessagePlugin.warning((data as { error?: string }).error || '删除失败');
          return;
        }
        setDetailAgentId(null);
        await registry.load();
      } catch (err) {
        MessagePlugin.warning((err as Error).message || '删除失败');
      }
    },
    [registry]
  );

  // Esc 关闭设置弹窗。弹窗的键盘出口是必备项 —— 鼠标在滑杆上时，
  // 用户最直觉的动作是「按 Esc」，而不是把指针移到右上角那个 × 上。
  useEffect(() => {
    if (!isSettingsPage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCloseSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSettingsPage, handleCloseSettings]);

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

  /**
   * 改群成员（本地 + PATCH）。
   *
   * 建群时写第一批名单，之后由群聊成员栏的「邀请 / 移出」增量修改
   * （见 GroupMemberPanel）。两条路都走这里，落库形状一致。
   */
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
   * 改群名。
   *
   * 本地先改（群聊头部立刻显示新名字），再 PATCH 持久化。
   *
   * ⚠️ 本地空壳会话（isLocal，从通讯录刚建、还没发过消息）**不发 PATCH** ——
   *    后端此刻还没有这条记录，请求必然 404，控制台会多一条无意义的报错。
   *    这类群的改名留在内存里，等首条消息落库时由 /api/group-chat 的
   *    `title` 字段一起带上（见 useGroupChat 的 title 选项）。
   */
  const handleRenameGroup = useCallback(
    (title: string) => {
      if (!currentSessionId) return;
      updateSession(currentSessionId, { title });
      const isLocal = sessions.find(s => s.id === currentSessionId)?.isLocal;
      if (isLocal) return;
      void fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }).catch(err => console.error('保存群名失败:', err));
    },
    [currentSessionId, updateSession, sessions]
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
      // A48（反馈同因同治）：建完群要**真的进群**。资料页的渲染优先级
      // 高于会话（`detailAgent ? ... : currentSession ? ...`），从通讯录资料页
      // 点「发起群聊 → 完成」时若不清它，地址进了新群、右侧却还停在联系人详情
      // —— 与「点群不进群」是同一个根因。
      setDetailAgentId(null);
      setNav('chats');
      setCurrentSessionId(newSession.id);
      navigate(`/chat/${newSession.id}`);
    },
    [registry, setSessions, setCurrentSessionId, navigate]
  );

  /**
   * 权限档位是**会话级设置**（A123）。
   *
   * 这里原本是一个全局 `useState('default')`：芯片改的是它，而发消息时 `useChat`
   * 读的是 `currentSession.permissionMode` —— 两个来源永不相交。后果是「选了全放行、
   * 下一轮还是弹窗问授权」，而芯片上看不出任何异常（它显示的正是自己刚设的值）。
   * 现在读会话、写会话（PATCH 落库），与工作目录 / 思考档位走同一条链。
   *
   * 不需要「先记一个待用值」的中间态：芯片只在有 currentSession 时才渲染。
   */
  const permissionMode: PermissionMode = currentSession?.permissionMode ?? 'default';
  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (currentSession) void setSessionPermissionMode(currentSession.id, mode);
    },
    [currentSession, setSessionPermissionMode]
  );

  /**
   * 单栏模式下「该显示哪一栏」。
   *
   * 判据是「用户是否正在看某个具体对象」：打开了资料页或会话 → 显示内容区；
   * 否则显示列表。宽屏下两栏同时显示，这个判断不参与。
   */
  /**
   * 单栏模式（窄屏）下「列表栏」与「内容区」互斥。
   *
   * A117：项目详情也算内容区 —— 否则窄屏点一个项目，右侧的详情根本不渲染，
   * 看起来像「点了没反应」。
   */
  const showContent = !!detailAgent || !!currentSession || (nav === 'projects' && !!selectedProjectId);
  const showColumn = !compact || !showContent;

  /**
   * A77：工作区面板什么时候真的渲染。
   *
   * 三个条件缺一不可：
   *   - 用户把它展开着（偏好）；
   *   - 不是窄屏单栏模式 —— 300px 的面板会把聊天区挤成一条缝；
   *   - 是**一对一**会话。群聊成员各有各的 cwd，一个面板只能指向其中
   *     某一个，那等于谎报一个不存在的「共同工作目录」——与 A63 不在
   *     群聊头部放工作区徽标是同一条理由。
   */
  const showWorkspace =
    workspaceOpen && !compact && !!currentSession && currentSession.kind !== 'group';

  /** 单栏模式的返回：回到列表（清掉会话与资料页） */
  const handleBackToList = useCallback(() => {
    setDetailAgentId(null);
    setCurrentSessionId(null);
    navigate('/');
  }, [navigate, setCurrentSessionId]);

  /* ── A117：项目视图的派生数据 ────────────────────────────────────────
   *
   * 会话按 `projectId` 在前端过滤，不再向后端要「某项目的会话」接口：
   * 会话列表本来就整份在内存里（fetchSessions 一次拉全），多一个接口只会
   * 多一份可能与主列表不一致的数据源。
   *
   * 排序按创建时间倒序 —— 项目详情回答的是「在这儿干过什么」，
   * 最近干的排最前。不跟聊天列表的「置顶优先」：那是消息栏的规则，
   * 在这里置顶会把一个三个月前的会话顶到最上面。 */
  const selectedProject = useMemo(
    () => projects.find(p => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const projectSessions = useMemo(() => {
    if (!selectedProject) return [];
    return sessions
      .filter(s => s.projectId === selectedProject.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [sessions, selectedProject]);

  return (
    /*
     * 纵向两段：自绘标题栏（40px 固定）+ 三栏主体。
     *
     * 标题栏**不在**三栏里，而是压在它们上面横贯整窗 —— 这样它才能盖住
     * 系统画的那三个窗口控件（`titleBarOverlay` 画在页面之上、右上角），
     * 而左侧的导航条与列表栏从它下面开始。见 TitleBar.tsx 的注释。
     *
     * 主体必须 `min-h-0 flex-1`：flex 子项默认 `min-height: auto`，
     * 消息列表一旦变长就会把整行撑出视口，`h-screen` 也拦不住。
     */
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <TitleBar compact={compact} />
      {/* 跟随鼠标的玻璃反光。固定定位 + `pointer-events: none`，不参与布局；
          只在窗口真有 acrylic 材质时（`data-opc-glass=1`）才亮，见组件注释。 */}
      <CursorGlow />

      <div
        className="relative flex min-h-0 flex-1 overflow-hidden"
        style={{
          backgroundColor: 'var(--tc-surface-content)',
          // A103（需求）：全局各栏微圆角。两件事必须一起做才看得见圆角 ——
          //   ① 这一层加 6px 内缩：最左/最右的栏不再顶到窗口边，圆角处露出的
          //      是这块画布（内容面白）而不是被窗口裁掉；
          //   ② `gap` 让栏与栏之间留缝：紧贴的两块圆角只会拼出一个梭形缺口。
          // 画布沿用内容面白，不引入第五种表面色 —— 消息区本来就是这块白，
          // 栏目是浮在它上面的几张圆角卡片。
          padding: 'var(--tc-column-gap)',
          gap: 'var(--tc-column-gap)',
        }}
      >
        {/* 最左：功能导航条 */}
        <NavRail
          active={isSettingsPage ? 'settings' : nav}
          onNavigate={handleNavigate}
          onOpenSettings={handleOpenSettings}
          compact={compact}
        />

        {/* A37：设置不再替换主内容，而是浮在它上面（见下面的弹窗）。
            主界面继续渲染 —— 遮罩后面能看见原来的会话，关掉就接着看。 */}
        <>
          {/* 中间：会话列表 / 项目 / 通讯录。单栏模式下与内容区互斥。 */}
            {showColumn && (nav === 'chats' ? (
              <ConversationList
                sessions={sessions}
                currentSessionId={currentSessionId}
                getAgent={registry.getAgent}
                onAddContacts={handleAddContacts}
                onSelect={handleSelectSession}
                onDelete={handleDeleteSession}
                onTogglePin={setSessionPinned}
                onExport={handleExportSession}
                compact={compact}
                agents={registry.agents}
                groups={sessions.filter(s => s.kind === 'group')}
                onCreateGroup={handleCreateGroup}
                onSelectGroup={handleSelectSession}
              />
            ) : nav === 'projects' ? (
              <ProjectPanel
                projects={projects}
                loading={projectsLoading}
                error={projectsError}
                selectedId={selectedProjectId}
                onSelect={handleSelectProject}
                onAdd={handleAddProject}
                onRefresh={fetchProjects}
                compact={compact}
              />
            ) : (
              <ContactsPanel
                agents={registry.agents}
                loading={registry.loading}
                probing={registry.probing}
                error={registry.error}
                onProbe={registry.probe}
                onCreateGroup={handleCreateGroup}
                onViewDetail={setDetailAgentId}
                getAgent={registry.getAgent}
                groups={sessions.filter(s => s.kind === 'group')}
                onSelectGroup={handleSelectSession}
                compact={compact}
                onOpenCredential={handleOpenCredential}
                onAddProvider={handleAddProvider}
              />
            ))}

            {/* 列表栏与内容区之间的宽度拖拽手柄。
                只在宽屏、且列表栏真的在场时渲染 —— 单栏模式下两栏互斥，
                中间没有缝可拖。手柄自己用负边距把 5px 的占位抵掉，所以
                渲染它不会让主内容右移、也不会在接缝处露一条异色竖带
                （见 SidebarResizer.tsx 的「手柄不占布局宽度」）。 */}
            {showColumn && !compact && <SidebarResizer />}

            {/* 右侧：会话内容。
                A103：这一层**不再自己铺底色** —— 底色交给里面的聊天列，
                这样「聊天列 / 工作区」之间才能露出 6px 缝（露的是外层画布的白），
                两块的圆角才都看得见。main 只是定位容器。 */}
            {showContent || !compact ? (
              <main
                className="flex min-w-0 flex-1 flex-col"
              >
                {nav === 'projects' ? (
                  selectedProject ? (
                    <ProjectDetail
                      project={selectedProject}
                      sessions={projectSessions}
                      agents={registry.agents}
                      onOpenSession={handleSelectSession}
                      onNewSession={handleNewSessionInProject}
                      onRename={handleRenameProject}
                      onDelete={handleDeleteProject}
                      onBack={compact ? () => handleSelectProject(null) : undefined}
                      compact={compact}
                    />
                  ) : (
                    /* 项目栏但一个都没选中：列表栏已经在说「还没有项目」，
                       这里只交代一句「右边是什么」，不留一整块纯白。 */
                    <div
                      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2"
                      style={{
                        backgroundColor: 'var(--tc-surface-content)',
                        borderRadius: 'var(--tc-column-radius)',
                      }}
                      data-project-detail-empty
                    >
                      <p className="text-body-lg" style={{ color: 'var(--td-text-color-secondary)' }}>
                        {projects.length === 0 ? '还没有项目' : '选一个项目'}
                      </p>
                      <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                        {projects.length === 0
                          ? '从左侧「+」选一个目录，它下面的会话会归到一起'
                          : '左侧点一个项目，这里会显示它的记忆与全部会话'}
                      </p>
                    </div>
                  )
                ) : detailAgent ? (
                  // 资料页自带的 onBack 清掉 detailAgent，单栏模式下这就等于
                  // 「回到通讯录列表」（showContent 变 false），无需另开一个返回口。
                  <AgentDetailPanel
                    agent={detailAgent}
                    onBack={() => setDetailAgentId(null)}
                    onStartChat={handleStartChatWith}
                    // A68：同族关系里的名字可直接跳到那条资料（例如 Kimi ⇄ Kimi Code CLI）。
                    // 只换 detailAgentId，不碰会话 —— 资料页是只读的，跳转无副作用。
                    onSelectAgent={setDetailAgentId}
                    onReprobe={registry.probe}
                    onOpenCredential={handleOpenCredential}
                    onDeleteCustom={handleDeleteCustomAgent}
                  />
                ) : currentSession ? (
                  /* A103：gap 让「聊天列 / 工作区」之间留缝；两块各自圆角，
                     缝里露出的是外层画布（内容面白）。
                     min-w-0 不可省 —— 长标题/长行文本会把 flex 子项顶宽，
                     聊天列不会收缩，面板会被挤出视口。 */
                  <div className="flex min-h-0 min-w-0 flex-1 flex-row" style={{ gap: 'var(--tc-column-gap)' }}>
                    {/* 聊天列。单独套一层而不是让 header/ChatPage 直接当 main 的子节点：
                        右侧工作区面板要作为**兄弟列**并排，横向容器必须在这一层。 */}
                    <div
                      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                      data-tc-column="chat"
                      style={{
                        // A103：聊天列自己扛内容面底色 + 圆角。它现在是浮在白色
                        // 画布上的一张圆角卡片 —— 顶上的会话头部（chrome 灰）
                        // 因此有了可见的圆角上沿，消息区保持纯白。
                        backgroundColor: 'var(--tc-surface-content)',
                        borderRadius: 'var(--tc-column-radius)',
                      }}
                    >
                      {/*
                        群聊用自己的头部（成员堆叠 + 编排模式），由 ChatPage 内部渲染；
                        一对一才用 ChatHeader。两套头部都基于同一个 PanelHeader，
                        规格统一，差别只在往槽位里填什么。
                      */}
                      {currentSession.kind !== 'group' && (
                        <ChatHeader
                          agent={currentAgent}
                          fallbackTitle={currentSession.title || '新对话'}
                          isLoading={isLoading}
                          scenario={currentScenario}
                          // A63：工作区徽标（方案二）。群聊有自己的头部，
                          // 那里不放工作区 —— 群成员各有各的 cwd，单个徽标
                          // 会谎报一个不存在的「共同工作目录」。
                          cwd={currentSession.cwd}
                          onCwdChange={cwd => void setSessionCwd(currentSession.id, cwd)}
                          // A77：工作区面板开关。只在宽屏给（窄屏下面板不渲染，
                          // 给一个点了没反应的按钮就是假控件）。
                          workspaceOpen={workspaceOpen}
                          onToggleWorkspace={compact ? undefined : toggleWorkspace}
                          onDelete={() => handleDeleteSession(currentSession.id)}
                          onBack={compact ? handleBackToList : undefined}
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
                        messagesLoaded={isMessagesLoaded(currentSession.id)}
                        models={activeModels}
                        modelSource={activeModelSource}
                        // A151 / P2：「未验证」模型被点中时先标定一次
                        onProbeModel={handleProbeModel}
                        selectedModel={selectedModel}
                        agents={legacyAgents}
                        currentAgent={currentAgent}
                        getAgent={registry.getAgent}
                        allAgents={registry.agents}
                        upsertGroupMessage={upsertGroupMessage}
                        isLoading={isLoading}
                        inputValue={inputValue}
                        permissionMode={permissionMode}
                        onSendMessage={sendMessage}
                        onStop={handleStop}
                        onInputChange={setInputValue}
                        onModelChange={updateCurrentSessionModel}
                        onPermissionModeChange={setPermissionMode}
                        onOrchestrationChange={handleOrchestrationChange}
                        onMembersChange={handleMembersChange}
                        onRenameGroup={handleRenameGroup}
                        onTogglePin={pinned => setSessionPinned(currentSession.id, pinned)}
                        // A62：改当前会话的思考强度档位（useSessions 里 PATCH 落库）
                        onReasoningEffortChange={setSessionReasoningEffort}
                        onClearMessages={clearSessionMessages}
                        onDelete={() => handleDeleteSession(currentSession.id)}
                        onBack={compact ? handleBackToList : undefined}
                        // A33：消息底部操作行的「重新生成」「分支」。
                        // 群聊不让用：一条消息里多个作者，重跑该找谁的上下文、
                        // 分支该切到哪都说不清（如实隐藏而不是给个含糊的动作）。
                        onRegenerate={!(currentSession?.kind === 'group') ? regenerate : undefined}
                        onBranch={!(currentSession?.kind === 'group') ? handleBranch : undefined}
                        // A119：空壳会话换 Agent（新建页的 Agent 卡片）
                        onRebindAgent={handleRebindAgent}
                      />
                    </Suspense>
                    </div>

                    {/* A77：工作区面板（右侧兄弟列）。 */}
                    {showWorkspace && (
                      <WorkspacePanel
                        sessionId={currentSession.id}
                        cwd={currentSession.cwd}
                        onClose={toggleWorkspace}
                      />
                    )}
                  </div>
                ) : (
                  <EmptyState onGoContacts={() => setNav('contacts')} nav={nav} />
                )}
              </main>
          ) : null}
        </>

        {/* 设置弹窗（A37）。
            · 定位在标题栏**下方**（父级是标题栏之外的那一行），所以三个
              窗口按钮和拖动区仍然可用 —— 全屏 fixed 会把它们盖住。
            · 遮罩点击 = 关闭（次要出口），右上角 × 是主出口（Esc 也行）。
            · 尺寸用 min() 夹住：窗口再大也不会把弹窗撑成第二块全屏页面。 */}
        {isSettingsPage && (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center p-3 sm:p-6"
            data-settings-modal
          >
            <div
              className="absolute inset-0"
              /* A115 续：遮罩换到 --tc-mask-soft。设置弹窗现在是半透明玻璃
                 （.tc-dialog），再压 38% 的黑会让整块比周围暗一圈，
                 立体感反而没了 —— 与 A115 给 workflow-dialog 换遮罩同因。 */
              style={{ backgroundColor: 'var(--tc-mask-soft)' }}
              onClick={handleCloseSettings}
              data-settings-backdrop
            />
            {/* 尺寸：`min()` 夹住 —— 窄窗口时铺满可用宽度，宽窗口时收在 900px。
                反馈「宽度太大、与整体不协调」：1080 在 1080 的窗口里几乎
                等于第二块全屏页面；900 之后两侧能看见遮罩与背后的会话，
                「浮层」这层语义才成立。 */}
            <div
              /* A115 续：改挂 .tc-dialog —— 与其余六个业务弹窗同一套
                 「玻璃 + 四层立体影 + 两条厚度边」。改之前这里是内联
                 实色底 + 1px 10% 墨描边 + --shadow-float 两段影：
                 整个应用里最后一块「旧语言」的面，而它恰恰是用户最常
                 打开的一块。⚠️ 内联的 backgroundColor / border / boxShadow
                 必须一并删掉 —— 内联优先级高于 class，留着任何一个都会
                 把玻璃底盖回实色，那种失效没有报错，只是「看起来没变」。
                 A130（定稿）：弹窗固定在窗口内、不许拖动。A120 接的
                 拖拽已摘 —— DOM 浮层出不了视口，拖到边上只会被裁成半截文字。 */
              /* A138（反馈）：**高度固定，不再跟内容走**。
                 原来是 `h-auto max-h-[…]`，于是切换分区时整块弹窗在 419 ~ 700px
                 之间弹跳（实测极差 281px：「我的资料 / 权限门禁 / 外观 / 模型清单 /
                 助手人设」都是 419，「记忆 / 关于与隐私」顶到 700）。用户的原话是
                 「每打开一个设置页的选项，窗口大小都会重新变化」。
                 设置浮层是**同一块面板换内容**，不是每次开一个新窗口 ——
                 外框跟着内容伸缩，读起来就像每次都重新开了一个窗口。
                 固定后高度恒定：内容多的分区自己滚（滚动容器本来就有
                 `overflow-y-auto` + `.tc-scroll-fade`），少的分区下方留白。
                 ⚠️ 别再改回 `h-auto`，那是这个问题的直接成因。
                 `100%` 相对的是 `absolute inset-0` 那一层（高度确定），
                 所以窗口矮时自动退成「铺满可用高度」，不会顶出视口。 */
              className="tc-dialog relative flex h-[min(700px,100%)] w-[min(900px,100%)] overflow-hidden rounded-2xl [&_header]:select-none"
              data-settings-panel
            >
              <SettingsPage
                agents={customAgents}
                onAdd={addAgent}
                onUpdate={updateAgent}
                onDelete={deleteAgent}
                themePreference={preference}
                onThemePreferenceChange={setPreference}
                onCredentialsSaved={registry.load}
                onModelsRefreshed={() => {
                  // 两条来源都要重取：SDK 类走 useModels 那份，其余走下面那个 effect
                  setModelsEpoch(v => v + 1);
                  void fetchModels();
                }}
                onClose={handleCloseSettings}
              />
            </div>
          </div>
        )}

        {/* A132 审批浮层：挂在 App 层而不是会话页 —— 它必须**不随会话卸载**。
            会话切走了，服务端那条流还在等答复，卡片跟着消失等于把人晾死。
            自己 createPortal 到 body，所以放在这层不影响布局。 */}
        <PermissionDock
          currentSessionId={currentSessionId}
          titleOf={id => sessions.find(s => s.id === id)?.title || '未知会话'}
        />
      </div>
    </div>
  );
}

/** 未选中会话时的空态 */
function EmptyState({
  onGoContacts,
  nav,
}: {
  onGoContacts: () => void;
  nav: NavKey;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 text-center sm:px-8">
      {/* A37：需求「右侧区域仅保留标题和打开通讯录组件」。
          去掉的是一整块 56px 的图标 + 一段三行的解释文字：
          那段话在通讯录页也会出现（那边讲的是同一件事），
          两处都说等于都没说清；而这块区域本来就只是「空」，不需要装饰。 */}
      <h3 className="text-title font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
        {nav === 'contacts' ? '从左侧选一个 Agent 开始对话' : '选择一个会话，或发起新会话'}
      </h3>
      {nav === 'chats' && (
        <button
          type="button"
          onClick={onGoContacts}
          className="tc-btn-brand mt-5"
        >
          {/* A37：去掉行尾的「→」。按钮本身有底色和圆角，已经明确是「可点」，
              再挂一个箭头是重复的指示。 */}
          打开通讯录
        </button>
      )}
    </div>
  );
}

export default App;
