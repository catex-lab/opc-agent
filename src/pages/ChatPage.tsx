import { useState, useRef, useLayoutEffect, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessagePlugin } from 'tdesign-react';
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
import { SCENARIOS, getScenario, enforcementGap, isModeGap, supportLimitation, PERMISSION_MODE_LABEL } from '../scenarios';
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_SIZE } from '../imageOptions';
import { ChatMessages } from '../components/ChatMessages';
import { ChatInput } from '../components/ChatInput';
import { GroupChatHeader } from '../components/GroupChatHeader';
import { GroupMemberPanel } from '../components/GroupMemberPanel';
import { GroupSettingsPanel } from '../components/GroupSettingsPanel';
import { AgentDetailModal } from '../components/AgentDetailModal';
import { PermissionGapNotice } from '../components/PermissionGapNotice';
import { WorkflowDialog } from '../components/WorkflowDialog';
import { DanglingNotice } from '../components/DanglingNotice';
import { useGroupChat } from '../hooks/useGroupChat';
// A115：群头像（群设置里换的，存在 sessionFlags）
import { useGroupAvatar } from '../sessionFlags';

/**
 * 在（可能嵌套的）shadow root 里找输入框的 `textarea`。
 *
 * 输入区的真实层级是
 *   `t-chat-sender` → #shadow-root → `t-textarea` → #shadow-root → `textarea`
 * 所以只钻一层是找不到的，必须逐层递归。同一个 shadow 里还有两个
 * `input[type=file]`（附件选择器），这里**只认 textarea**，避免焦点落到
 * 隐藏的文件框上。
 */
function findComposerTextarea(root: Element | ShadowRoot | null): HTMLTextAreaElement | null {
  if (!root) return null;
  // ⚠️ 传进来的是宿主元素时要**先进入它的 shadowRoot**：`host.querySelectorAll('*')`
  // 只搜 light DOM，而 t-chat-sender / t-textarea 的 light DOM 都是空的。
  const scope: ParentNode = root instanceof Element && root.shadowRoot ? root.shadowRoot : root;
  const direct = scope.querySelector('textarea');
  if (direct) return direct as HTMLTextAreaElement;
  for (const el of scope.querySelectorAll('*')) {
    const sr = (el as HTMLElement).shadowRoot;
    if (!sr) continue;
    const found = findComposerTextarea(sr);
    if (found) return found;
  }
  return null;
}

interface ChatPageProps {
  currentSession: Session | undefined;
  models: Model[];
  selectedModel: string;
  agents: CustomAgent[];
  /** 当前会话绑定的 Agent（用于消息流里的官方头像） */
  currentAgent?: RegisteredAgent;
  /** 按 id 反查注册表条目；群聊消息流里每个气泡各查自己的作者 */
  getAgent: (id: string) => RegisteredAgent | undefined;
  /**
   * 注册表里的全部 Agent。
   *
   * 群成员栏的「邀请成员」要用它算出「谁还没进群」—— 只有 members 的话
   * 面板就只能删人、永远加不回来。
   */
  allAgents: RegisteredAgent[];
  /** 当前会话 id（群聊 hook 需要） */
  currentSessionId: string | null;
  /**
   * 这个会话的消息是否已经拉过一轮。
   *
   * 用来区分「真的没有消息」和「消息还在路上」—— 前者该显示新建对话页，
   * 后者只能显示骨架。判错的代价是一整屏闪烁（见下方 showNewChatView）。
   */
  messagesLoaded: boolean;
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
  /** 群聊：改群名（本地 + PATCH 后端；本地空壳群只改内存） */
  onRenameGroup: (title: string) => void;
  /** 群设置：置顶 / 取消置顶 */
  onTogglePin: (pinned: boolean) => void;
  /**
   * A62：改某个会话的思考强度档位（本地 + PATCH 后端）。
   * 两个参数而不是一个：ChatPage 同时管着新对话与既有会话，
   * 调它的人要能说清「改哪个会话」。
   * 不传 = 输入框那颗下拉不渲染（调用方还没接上落库）。
   */
  onReasoningEffortChange?: (sessionId: string, value: string) => void;
  /** 群设置：清空聊天记录，返回删除条数（-1 = 失败） */
  onClearMessages: (sessionId: string) => Promise<number>;
  onDelete: () => void;
  /** A33：重新生成这条回复（一对一；群聊不传，按钮随之隐藏） */
  onRegenerate?: (message: Message) => void;
  /** A33：从这条消息处分支出一个新会话（同上，群聊不传） */
  onBranch?: (message: Message) => void;
  /** 单栏（窄屏）模式下返回列表；宽屏不传 */
  onBack?: () => void;
}

interface NewChatOptions {
  /** 仅新建会话时使用；既有会话传 `{ imageSize }` 即可（见 useChat 的注释） */
  agentId?: string;
  cwd?: string;
  /** A62：新会话的思考强度档位（`''` = 用 CLI 默认） */
  reasoningEffort?: string;
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
  allAgents,
  currentSessionId,
  messagesLoaded,
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
  onRenameGroup,
  onTogglePin,
  onReasoningEffortChange,
  onClearMessages,
  onDelete,
  onRegenerate,
  onBranch,
  onBack,
}: ChatPageProps) {
  const navigate = useNavigate();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 新对话页面状态
  const [newChatAgentId, setNewChatAgentId] = useState('default');
  const [newChatCwd, setNewChatCwd] = useState('');
  /**
   * A62：新对话的思考强度档位。`''` = 用 CLI 自己的默认。
   *
   * 与 newChatCwd 一样只活在内存里（刷新即丢）—— 新会话还没建，
   * 没地方可存；首条消息发出时才由 useChat 一并落库。
   */
  const [newChatReasoning, setNewChatReasoning] = useState('');
  /**
   * 群设置面板是否展开。
   *
   * 状态放在这里而不是 GroupChatHeader 里：面板现在是会话区右侧的**布局栏**
   * （与成员栏同宽同起止），必须由会话区的所有者渲染，头部只剩一颗开关按钮。
   * 2026-10-20 用户反馈：面板要跟成员栏一样大、并且把输入框一起挤窄。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 切会话时收起：群设置讲的是「这个群」，换了群还开着会指错对象
  useEffect(() => {
    setSettingsOpen(false);
  }, [currentSessionId]);
  // P4：选中的场景 id。选场景会预置推荐 Agent 与权限模式
  const [newChatScenarioId, setNewChatScenarioId] = useState<string | undefined>(undefined);
  // P4-4：生图选项。**跨场景保留** —— 用户在生图会话里挑了竖版，
  // 切去别的会话再回来，不该被重置回正方形。
  const [imageSize, setImageSize] = useState<string>(DEFAULT_IMAGE_SIZE);
  const [imageModel, setImageModel] = useState<string>(DEFAULT_IMAGE_MODEL);
  /**
   * 点了哪个 Agent 的头像 → 弹它的详情（P7）。
   *
   * 群聊里一条消息一个作者，一对一里作者固定是会话绑定的 Agent，
   * 两处都走这个 state + 一个 AgentDetailModal。头像本来就是「这是谁」
   * 的最强暗示，点开看详情是用户的第一直觉 —— 以前这个手势是死的。
   */
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);

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
    // 本地新建的群还没落库，改名只能随首条消息一起交给后端（见 useGroupChat）
    title: currentSession?.title,
    upsertMessage: msg => {
      if (!currentSessionId) return;
      upsertGroupMessage(currentSessionId, msg);
    },
    onOrchestrationSync: mode => onOrchestrationChange(mode),
  });

  /** A41：动态工作流弹窗（只对群聊开放 —— 单聊没有「编排」可言） */
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const openWorkflow = useCallback(() => {
    if (!isGroup) {
      MessagePlugin.info('工作流只对群聊开放：先在消息列表右上角建一个群');
      return;
    }
    setWorkflowOpen(true);
  }, [isGroup]);

  /**
   * 打开会话时「直接落在最后一条」，之后新消息才做平滑滚动。
   *
   * ## 为什么原来会「从第一条划到最后一条」
   *
   * 之前只有一句 `scrollIntoView({ behavior: 'smooth' })`，挂在
   * `currentSession.messages` 上。切会话时消息是异步取回来的：
   *   ① 先渲染 0 条（容器滚动位置 = 0，也就是顶部）；
   *   ② 消息到了 → 依赖变化 → 触发**平滑**滚动 → 用户看到一条长动画
   *      从第一条一路滑到最后一条。
   * 会话越长，这段动画越久，观感上像「页面自己在翻页」。
   *
   * ## 现在的判据
   *
   * 一个 ref 记住「上一次渲染的会话 id」，id 一变就置 `pendingJump`：
   * 等消息真的到了（`length > 0`）用 `behavior: 'auto'` **一次跳到底**，
   * 然后清掉标记。之后同一会话里的新消息才走 smooth —— 那时用户已经在
   * 底部附近，平滑滚动是「跟着新内容走」，不是「重新翻一遍聊天记录」。
   *
   * ⚠️ A24 修：这两个 ref 的复位原先写在 `useEffect` 里，而滚动本身在
   *    `useLayoutEffect` 里 —— **布局 effect 先跑，此时标记还是上一个会话
   *    留下的 false**，于是切到一个「消息已在缓存里」的会话时走的是 smooth
   *    分支：整段历史从第一条平滑滚到最后一条，正是用户说的「页面跳动」。
   *    现在把 id 比对放进同一个布局 effect，切会话的那一帧必定是硬跳。
   *
   * 空会话（新群 / 新对话）不会卡住：`length === 0` 时直接 return，
   * 标记留到首条消息进来时才消费。
   */
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const pendingJumpRef = useRef(true);

  /**
   * ⚠️ 必须是 `useLayoutEffect`，不能是 `useEffect`。
   *
   * 消息是**异步**取回来的：`useEffect` 在浏览器绘制之后才跑，所以用户
   * 会先看到一帧「消息停在顶部」，再被拽到底部 —— 会话越长这一帧越明显，
   * 观感就是「打开聊天记录时闪了一下」。`useLayoutEffect` 在绘制前把
   * 滚动位置定好，这一帧根本不存在。
   */
  useLayoutEffect(() => {
    const sessionId = currentSession?.id;
    // 切会话：标记必须在**同一次布局 effect 里**置位，不能等 passive effect
    if (lastSessionIdRef.current !== sessionId) {
      lastSessionIdRef.current = sessionId;
      pendingJumpRef.current = true;
    }

    const el = messagesEndRef.current;
    const container = scrollContainerRef.current;
    if (!el || !container) return;

    // 注意：消息容器带 24px 底部内边距（p-6），`scrollIntoView(block:end)`
    // 对齐的是「零高度锚点的底部」，会停在 padding 之上，留下约 23px 空档，
    // 看着没贴底。所以先 scrollIntoView（记录行为、承担平滑分支），
    // 再把容器直接拉到绝对底部，确保真正贴底。
    const snapToBottom = () => {
      el.scrollIntoView({ behavior: 'auto', block: 'end' });
      container.scrollTop = container.scrollHeight;
    };

    if (pendingJumpRef.current) {
      if ((currentSession?.messages.length ?? 0) === 0) return;
      pendingJumpRef.current = false;
      snapToBottom();
      // 图片 / 代码块 / markdown 的高度是**渲染后**才确定的，
      // 首帧跳到底可能还差一截。下一帧再补一次，用户看不到中间过程。
      requestAnimationFrame(snapToBottom);
      return;
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [currentSession?.id, currentSession?.messages]);

  // 处理发送消息
  const handleSend = useCallback((message: string) => {
    if (!currentSession) {
      // 新对话
      onSendMessage(message, {
        agentId: newChatAgentId,
        cwd: newChatCwd,
        // A62：新会话的档位。模型没有档位表时这里是 ''，等价于不设置
        reasoningEffort: newChatReasoning,
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
        setNewChatReasoning('');
        setNewChatScenarioId(undefined);
        navigate(path);
      });
    } else if (isGroup) {
      // 群聊走自己的编排端点。
      //
      // ⚠️ 必须自己清空输入框。一对一路径靠 useChat 里的 setInputValue('')
      //    收尾，而群聊根本不经过 useChat —— 早先漏了这一步，指令发出去
      //    还留在输入框里，用户以为没发成功，再按一次回车就发了两遍。
      //    先清空再发：发送是异步的，等它返回再清会让输入框在整段流式
      //    期间一直挂着旧文本。
      onInputChange('');
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
    newChatReasoning,
    newChatScenarioId,
    permissionMode,
    onSendMessage,
    onInputChange,
    group.sendGroupMessage,
    navigate,
  ]);

  /**
   * 引用（A34）：把消息里选中的一段文字以 Markdown 引用块追加到输入框。
   *
   * 保留用户已经输入的内容（空行分隔），多行逐行加 `> `。不覆盖、不清空 ——
   * 「引用」是补充上下文，不是替换用户正在写的东西。
   */
  const handleQuote = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      const quoted = t.split('\n').map(line => `> ${line}`).join('\n');
      const base = inputValue.replace(/\s+$/, '');
      onInputChange(base ? `${base}\n\n${quoted}\n` : `${quoted}\n`);
    },
    [inputValue, onInputChange]
  );

  /**
   * 编辑用户消息（A49）：把这条消息的内容**填回输入框**，并把焦点送进去。
   *
   * 语义边界（不冒充「就地改并重跑」）：原消息留在历史里，改完按回车是
   * 一条新消息。真正的「改原文 + 重跑」需要后端截断会话再重放，属于另一
   * 件事 —— 这里不假装有。
   *
   * 为什么焦点要手动给：输入区是 TDesign 的 `t-chat-sender`，正文在
   * **两层** shadow root 里（`t-chat-sender` → `t-textarea` → `textarea`），
   * React 侧拿不到内部 ref。这里逐层往下钻着找，找不到就算了（不影响
   * 「内容已填回」这个主行为）。
   *
   * ⚠️ 不能只写 `querySelector('textarea, input')`：`t-chat-sender` 的
   * shadow 里还有两个 `input[type=file]`（附件选择器），按顺序会先命中它们，
   * 焦点就被送进一个隐藏的文件框 —— 看起来「点了编辑但没反应」。
   */
  const handleEditMessage = useCallback(
    (message: Message) => {
      onInputChange(message.content ?? '');
      // 等这一帧渲染完再聚焦，否则 focus 会被随后的 value 更新打断
      requestAnimationFrame(() => {
        const textarea = findComposerTextarea(document.querySelector('t-chat-sender'));
        if (!textarea) return;
        textarea.focus();
        // 光标落到末尾：接着改比从头改更常见
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      });
    },
    [onInputChange]
  );

  const handleStop = isGroup ? undefined : onStop;
  const loading = isGroup ? group.isLoading : isLoading;

  /**
   * 是否显示「新建对话」页（场景卡片）。
   *
   * ## 为什么必须带 `messagesLoaded`
   *
   * 原来的判据只有 `messages.length === 0`。而打开一个已有会话时，
   * 列表里那条会话的 `messages` 一开始就是**空数组**（消息是随后 GET 回来的），
   * 于是：
   *   ① 首帧 → 判定「空会话」→ 渲染整页场景卡片；
   *   ② 消息到了 → 判定「有消息」→ 换成聊天记录。
   * 两屏内容完全不同的整页切换，就是用户说的「打开聊天记录会屏闪」。
   *
   * 现在只有**真的拉过一轮且确实为空**才算新对话；没拉过就显示骨架。
   */
  const showNewChatView =
    !currentSession ||
    (messagesLoaded && currentSession.messages.length === 0 && !isGroup);
  /** 消息还在路上：占位骨架，不做任何「换一整屏」的动作 */
  const showMessagesSkeleton = !!currentSession && !showNewChatView && !messagesLoaded;

  // 指定模式下的提示：不 @ 任何人就没人会被唤醒
  const mentionHint =
    orchestration === 'mention' && groupMembers.length > 1
      ? '当前为「指定」模式：只有被 @ 到的成员会发言，不 @ 则无人应答'
      : undefined;

  /**
   * 会话中的实时权限缺口（P4-5：提示不再只出现在新建对话页）。
   *
   * 原来这条提示只挂在 NewChatView 上，但会话里同样能改权限模式
   * （ChatInput 的选择器），群聊还能改成员 —— 承诺在各种入口都可能落不了地，
   * 只在新建页看得到，等于大部分时间看不到。
   *
   * 单聊取两级：
   *   ① 会话绑定场景的缺口（问答场景 + 落不了只读的 Agent）；
   *   ② 当前权限模式对会话 Agent 的缺口（实时切换后立即生效）。
   * 群聊：当前模式 × 每个成员的强制能力，点出具体是谁不行。
   */
  const livePermissionGap = useMemo(() => {
    if (isGroup) {
      const weak = groupMembers.filter(m => isModeGap(permissionMode, m.permissionSupport));
      if (weak.length === 0) return null;
      const names = weak.map(m => m.name).join('、');
      const reason = supportLimitation(weak[0].permissionSupport);
      return `当前权限模式「${PERMISSION_MODE_LABEL[permissionMode]}」对 ${names} 无法强制：${reason}。`;
    }
    const scenarioGap = enforcementGap(
      getScenario(currentSession?.scenarioId),
      currentAgent?.permissionSupport
    );
    if (scenarioGap) return scenarioGap;
    if (isModeGap(permissionMode, currentAgent?.permissionSupport)) {
      return `当前权限模式「${PERMISSION_MODE_LABEL[permissionMode]}」在该 Agent 上无法强制：${supportLimitation(currentAgent?.permissionSupport)}。`;
    }
    return null;
  }, [isGroup, groupMembers, permissionMode, currentSession?.scenarioId, currentAgent]);

  /**
   * 群名。没起名的群用成员名兜底 —— 与消息列表、通讯录群聊目录同一套口径，
   * 否则同一个群在三个地方叫三个名字。
   *
   * 提成变量是因为它现在有两个消费者：会话头部和右侧群设置面板的栏头。
   */
  const groupTitle =
    currentSession?.title || groupMembers.map(m => m.name).join('、') || '群聊';

  // A115：群头像。用 Hook 而不是直接读 —— 群设置面板就在本组件里，
  // 用户点「换头像」后这里必须立刻跟着变，否则要等一次无关重渲染。
  const groupAvatar = useGroupAvatar(currentSession?.id);

  return (
    <>
      {/* 群聊头部：成员头像堆叠 + 编排模式切换，替代一对一的单人头部 */}
      {isGroup && currentSession && (
        <GroupChatHeader
          title={groupTitle}
          members={groupMembers}
          onlineCount={onlineCount}
          orchestration={orchestration}
          onOrchestrationChange={onOrchestrationChange}
          onRename={onRenameGroup}
          onShowAgentDetail={setDetailAgentId}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
          onBack={onBack}
          onOpenWorkflow={openWorkflow}
          // A115：群头像。用户在群设置里换的，头部 leading 据此切成一整颗
          groupAvatar={groupAvatar}
        />
      )}

      {/* 点头像弹出的 Agent 详情弹窗：群聊与一对一消息流共用 */}
      <AgentDetailModal
        open={!!detailAgentId}
        agent={detailAgentId ? getAgent(detailAgentId) : undefined}
        onClose={() => setDetailAgentId(null)}
      />

      {/* A41：动态工作流。脚本里的每次调用都作为普通气泡落在本会话 */}
      <WorkflowDialog
        open={workflowOpen}
        onClose={() => setWorkflowOpen(false)}
        sessionId={currentSessionId}
        memberIds={memberIds}
        memberNames={groupMembers.map(m => m.name)}
        running={group.isLoading}
        onRun={source => {
          setWorkflowOpen(false);
          void group.runWorkflowScript(source);
        }}
      />

      {/* 会话区：消息 + 输入区，群聊时右侧再挂一条成员栏（QQ 式）。
          `relative` 是给成员栏的折叠热区做定位基准的（折叠后它 absolute
          贴在右缘，见 GroupMemberPanel 的注释）。
          `data-chat-page`：打靶脚本用它数「会话页被挂载了几次」——
          从设置页切回消息栏时，这个页面**一次都不该**挂起来（见 App.tsx
          的 handleNavigate 注释）。 */}
      <div data-chat-page className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 消息区域。`data-chat-scroll` 是给打靶脚本量的：
              切换会话时这个容器的 scrollTop 变了几次（换成平滑滚动会动
              几十次，见 useLayoutEffect 里的 pendingJump 说明）。 */}
          <div
            ref={scrollContainerRef}
            data-chat-scroll
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-6"
          >
            {showNewChatView ? (
              <NewChatView
                agents={agents}
                models={models}
                selectedModel={selectedModel}
                newChatAgentId={newChatAgentId}
                newChatCwd={newChatCwd}
                newChatReasoning={newChatReasoning}
                newChatPermissionMode={permissionMode}
                scenarios={SCENARIOS}
                selectedScenarioId={newChatScenarioId}
                onSelectModel={onModelChange}
                onSelectAgent={setNewChatAgentId}
                onSetCwd={setNewChatCwd}
                // A62：新对话也能先定档位。模型没有档位表时 NewChatView
                // 内部不渲染这颗下拉，这里传了也不会显示
                onSetReasoning={setNewChatReasoning}
                onSetPermissionMode={onPermissionModeChange}
                onSelectScenario={handleSelectScenario}
              />
            ) : showMessagesSkeleton ? (
              <MessagesSkeleton />
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
                onShowAgentDetail={setDetailAgentId}
                // A33：重新生成 / 分支。群聊里这两个能力不接
                // （语义说不清，见 App.tsx 的同名注释），不传即不渲染按钮。
                onRegenerate={onRegenerate}
                onBranch={onBranch}
                // A34：选中文字 → 复制 / 引用到输入框
                onQuote={handleQuote}
                // A49：用户消息下方的「编辑」→ 内容填回输入框
                onEditMessage={handleEditMessage}
                // A36：后台任务胶囊点「查看」时跳到那个还在跑的会话
                onOpenSession={sessionId => navigate(`/chat/${sessionId}`)}
                currentSessionId={currentSessionId}
                // A97：验证面板要按这个目录探测「能跑哪些检查」
                sessionCwd={currentSession?.cwd}
              />
            )}
          </div>

          {/* A100：上一轮没有产出回复。只在「最后一条是 user 且没有活跃 run」时
              由后端算出并返回 —— 刷新/重启后仍然成立，因为它查的是库里的消息
              顺序而不是内存里的运行态。群聊走另一条编排链路，这里不接。

              `dangling` 是**加载时**的快照，这一轮跑成功后不会自动消失，
              所以再拿本地消息顺序校验一次：最后一条真的是 user 才显示。
              没有这道校验，用户发完新消息、回答到了，横幅还会再冒出来。 */}
          {!isGroup &&
            currentSession?.dangling &&
            !loading &&
            currentSession.messages[currentSession.messages.length - 1]?.role === 'user' && (
              <DanglingNotice at={currentSession.dangling.at} />
            )}

          {/*
            输入区域。
            A62：思考强度两颗 prop 见下面 —— 既有会话读库里的值，改了立刻 PATCH；
            没接 onReasoningEffortChange、或当前模型没有档位表时，
            ChatInput 内部不渲染那颗下拉。
          */}
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
            reasoningEffort={currentSession?.reasoningEffort ?? ''}
            onReasoningEffortChange={
              onReasoningEffortChange && currentSession && !isGroup
                ? v => onReasoningEffortChange(currentSession.id, v)
                : undefined
            }
            // 群聊：成员 chip 条 + 不用选单一模型
            mentionMembers={isGroup ? groupMembers : undefined}
            mentionHint={mentionHint}
            // P4-5：会话中的权限强制缺口（生图模式下 ChatInput 内部会忽略）
            permissionGap={livePermissionGap}
            // P4-4：生图模式（输入区切成「描述 → 生图」）
            imageMode={imageMode}
            imageSize={imageSize}
            imageModel={imageModel}
            onImageSizeChange={setImageSize}
            onImageModelChange={setImageModel}
            // A73：模型浮层底部的「添加模型」—— 去设置页刷新模型清单
            onAddModel={() => navigate('/settings?section=models')}
          />
        </div>

        {/* 右栏：群成员栏 / 群设置面板，同一块位置只放一个。
            两者都是布局内的 `shrink-0` 右栏，宽 236px —— 打开时消息区与
            输入框一起收窄，这就是用户要的「输入框响应式与成员栏一致」。
            2026-10-20：群设置面板不再浮在会话之上（那样会盖住输入框）。 */}
        {isGroup && !settingsOpen && (
          <GroupMemberPanel
            members={groupMembers}
            allAgents={allAgents}
            onMembersChange={onMembersChange}
          />
        )}

        {isGroup && currentSession && (
          <GroupSettingsPanel
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            title={groupTitle}
            members={groupMembers}
            allAgents={allAgents}
            onMembersChange={onMembersChange}
            sessionId={currentSessionId}
            pinned={!!currentSession.pinned}
            onTogglePin={onTogglePin}
            onClearMessages={onClearMessages}
            onExitGroup={onDelete}
          />
        )}
      </div>
    </>
  );
}

/**
 * 消息加载中的骨架。
 *
 * 刻意做得**很轻**：几块低对比的灰条，没有动画、没有转圈。
 * 这里的目标不是「告诉用户正在加载」（那一瞬间的事），而是「不要在这一瞬间
 * 换一整屏内容」—— 早先这里渲染的是新建对话页，几十张场景卡片一闪而过，
 * 才是真正的干扰。灰条与消息气泡同宽同位，消息到位时视觉上是「填充」，
 * 不是「切换」。
 *
 * ⚠️ A24：骨架**贴底**排（`h-full justify-end`），不是从顶上往下排。
 *    聊天记录永远是「最后一条在底部」，骨架却堆在顶部 —— 切会话时用户先
 *    看到屏幕上方三根灰条，紧接着整页内容出现在底部，视觉上就是一次跳动。
 *    贴底之后，灰条与真实消息落在同一片区域，消息到位只是「灰条换成内容」，
 *    位置不变。
 */
function MessagesSkeleton() {
  return (
    <div
      data-messages-loading
      aria-hidden
      className="flex h-full flex-col justify-end gap-5"
      style={{ opacity: 0.55 }}
    >
      {[
        { side: 'left', w: '46%', h: 34 },
        { side: 'right', w: '32%', h: 34 },
        { side: 'left', w: '58%', h: 52 },
      ].map((row, i) => (
        <div
          key={i}
          className={`flex ${row.side === 'right' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className="rounded-xl"
            style={{
              width: row.w,
              height: row.h,
              backgroundColor: 'var(--tc-hover-chrome)',
            }}
          />
        </div>
      ))}
    </div>
  );
}
