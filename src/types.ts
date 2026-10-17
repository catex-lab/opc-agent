/**
 * 类型定义
 */

// 权限相关类型收敛到 shared/（与 server 共用同一份，避免前后端定义漂移）
import type { PermissionMode, PermissionSupport } from '../shared/types';
export type { PermissionMode, PermissionSupport };

/** 会话类型：一对一 / 群聊 */
export type SessionKind = 'direct' | 'group';

/**
 * 群聊编排模式。
 * - dispatch  主控 Agent 判断该谁做 → 派发 → 汇总（默认）
 * - broadcast 名册内所有 Agent 各自独立作答，横向对比
 * - relay     串行流水线，前者输出作为后者输入
 * - debate    指定正反方多轮交替，最后收敛
 * - mention   只唤醒被 @ 的 Agent
 */
export type OrchestrationMode = 'dispatch' | 'broadcast' | 'relay' | 'debate' | 'mention';

/** 编排模式的中文名与一句话说明，供群聊头部的模式切换器使用 */
export const ORCHESTRATION_META: Record<
  OrchestrationMode,
  { label: string; description: string }
> = {
  dispatch: { label: '分派', description: '由主控 Agent 判断该谁做，派发并汇总结果' },
  broadcast: { label: '广播', description: '所有成员各自独立作答，便于横向对比' },
  relay: { label: '接力', description: '串行流水线，前一个的输出作为后一个的输入' },
  debate: { label: '辩论', description: '正反方多轮交替发言，最后收敛' },
  mention: { label: '指定', description: '只唤醒被 @ 提到的 Agent' },
};

export interface Model {
  modelId: string;
  name: string;
  description?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
}

/**
 * 内容块类型 - 支持文字、工具调用与图像按顺序排列
 */
export type ContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'image'; image: ImageBlock };

/**
 * 生成图像块（P4-4）。
 *
 * 为什么单独成一个块类型而不是塞进 tool_use：生图不走工具调用，它是
 * 独立 provider 的一次 HTTP 产出。混进 tool_use 会让「查看步骤」里
 * 出现一条不是工具的东西，也会让工具折叠逻辑去解析图像字段。
 */
export interface ImageBlock {
  /**
   * 展示用地址。
   * 缓存成功时是本地 `/api/images/<hash>.png`（永久有效）；
   * 缓存失败时退回远端临时 URL（约 7 天过期，见 expiresAt）。
   */
  url: string;
  /** 生成该图的提示词 */
  prompt?: string;
  /** 尺寸，如 '1024x1024' */
  size?: string;
  /** 实际使用的生图模型，如 'cogview-3-flash' */
  model?: string;
  /** 生图 provider id，如 'cogview' */
  provider?: string;
  /** 无障碍文本 */
  alt?: string;
  /** 远端原始地址（保留出处，便于排查） */
  sourceUrl?: string;
  /** 未落盘缓存时的过期时间（ISO）。有值即提示「此图可能失效」 */
  expiresAt?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;  // 保留用于兼容，存储纯文本摘要
  model?: string;
  timestamp: Date;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];  // 保留用于兼容
  contentBlocks?: ContentBlock[];  // 新增：按顺序排列的内容块
  /**
   * 生图消息的图像（P4-4）。
   *
   * 与 `contentBlocks` 里的 image 块**同时存在但用途不同**：
   *   - 流式刚出图时走 contentBlocks（与文本/工具块保持顺序）
   *   - 刷新后从库里还原时只有 `images`（DB 不存 contentBlocks）
   * 渲染层两个都认，因此「刚生成」和「刷新后」长得一样。
   */
  images?: ImageBlock[];
  /** 思考过程（Hermes 等会流式返回），折叠展示 */
  thinking?: string;
  /** 该条消息的失败原因。有值时前端渲染为错误气泡 */
  error?: string;
  /**
   * 产生这条回复的 Agent。
   * 一对一里用于标注来源；群聊里是**作者身份** —— 前端据此把每个 Agent
   * 的输出渲染成带自己头像和名字的独立气泡。
   */
  agentId?: string;
  /**
   * 群聊的编排说明（「主控决定交给 Codex」「第 2/3 棒」这类过程提示）。
   *
   * 仅存在于前端内存，**不落库** —— 它是这次编排的过程叙述，
   * 刷新后重放反而会让用户以为是新发生的事。落库只存各 Agent 的实质发言。
   */
  note?: boolean;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  /** 一对一：会话绑定的 Agent。群聊不使用该字段（见 agentIds） */
  agentId?: string;
  /**
   * 工作目录。指定后传给 Agent 子进程/会话（文件操作等以此为准）。
   * 会持久化到 DB（sessions.cwd），刷新后仍在 —— 之前它只活在前端内存里，
   * 关掉重开会话就丢，场景的「工作目录绑定」因此无从谈起。
   */
  cwd?: string;
  /** 场景模板 id（P4）。由场景入口预置；不选场景则为空 */
  scenarioId?: string;
  /**
   * 会话级系统提示词（场景注入）。发送时**优先于** Agent 自带的 systemPrompt。
   * 场景模板（工作/问答/开发/代码/写作）靠它把「本场景该怎么干」带进会话。
   */
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  /**
   * 置顶。钉住的会话排在消息列表最前，与最近活跃时间无关。
   * 由列表行的右键菜单切换，落库在 sessions.pinned。
   */
  pinned?: boolean;
  createdAt: Date;
  messages: Message[];
  /** 'direct' 一对一（默认）| 'group' 群聊 */
  kind?: SessionKind;
  /** 群聊成员 Agent id 列表 */
  agentIds?: string[];
  /** 群聊编排模式，默认 dispatch */
  orchestration?: OrchestrationMode;
  /**
   * 仅在本地存在、尚未落库的会话（从通讯录发起对话时先建的空壳）。
   * 后端要等首条消息发出才会按同一个 id 建记录，在那之前去 GET
   * `/api/sessions/:id` 必然 404 —— 有了这个标记就干脆不发这个请求。
   * 由 fetchSessions 还原出来的会话不会带此标记。
   */
  isLocal?: boolean;
}

export interface CustomAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  /** Logo 键，对应 agentLogos.ts 的 AGENT_LOGOS */
  icon?: string;
  color?: string;
  permissionMode?: PermissionMode;
  /** P4-5：权限强制能力（由注册表映射过来，供场景页如实提示） */
  permissionSupport?: PermissionSupport;
  createdAt: Date;
  updatedAt: Date;
}

// Agent 是 CustomAgent 的别名
export type Agent = CustomAgent;

/** 实际落到 DOM 上的主题 */
export type Theme = 'light' | 'dark';

/**
 * 用户对主题的**偏好**。
 *
 * 比 Theme 多一个 'system'：跟随系统时，系统换肤要能带着应用一起换。
 * 所以偏好与解析结果是两个值，不能只存一个（见 hooks/useTheme.ts）。
 */
export type ThemePreference = Theme | 'system';

/**
 * 权限请求 - 用于工具调用确认
 */
export interface PermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

/**
 * 权限响应
 */
export interface PermissionResponse {
  requestId: string;
  behavior: 'allow' | 'deny';
  message?: string;
}

// ============= Agent 注册表（来自 /api/agents） =============

/** 接入方式，决定后端用哪个适配器 */
export type AgentKind = 'sdk' | 'cli' | 'acp' | 'mock';

/** 能力标签，即 Agent 资料页上的「擅长领域」 */
export type AgentCapability = 'chat' | 'code' | 'write' | 'tools' | 'image' | 'search';

/**
 * 可用性状态。IM 范式下它对应「在线状态」：
 * ready = 在线，needs-auth = 未登录，not-installed = 未添加，unsupported = 不可用。
 */
export type AgentAvailability =
  | 'ready'
  | 'needs-auth'
  | 'needs-setup'
  /** 本机/代理连不上它的后端：凭据与二进制都齐也调不通，该去查网络而不是去登录 */
  | 'unreachable'
  | 'not-installed'
  | 'unsupported'
  | 'unknown';

export interface AgentStatus {
  availability: AgentAvailability;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  message?: string;
  /** 最近一次调用失败的原因 */
  lastError?: string;
  probedAt: string;
}

/**
 * `PermissionSupport` 的定义在 `shared/types.ts`（前端与 server 共用一份）。
 *
 * 存在意义：并非所有适配器都能把 `permissionMode` / 工具白名单翻译成
 * CLI 的实际开关。没有这份数据，UI 就无法如实告诉用户「这个场景的约束落不了地」。
 */

/** 注册表返回的 Agent 条目：静态描述 + 动态状态 */
export interface RegisteredAgent {
  id: string;
  name: string;
  vendor?: string;
  kind: AgentKind;
  capabilities: AgentCapability[];
  description?: string;
  icon?: string;
  color?: string;
  command?: string;
  installHint?: string;
  status: AgentStatus;
  /** P4-5：权限强制能力 */
  permissionSupport?: PermissionSupport;
}

/** 能力标签的中文名与配色 */
export const CAPABILITY_META: Record<AgentCapability, { label: string; color: string }> = {
  chat: { label: '问答', color: '#1F1F1F' },
  code: { label: '代码', color: '#0E7A8C' },
  write: { label: '写作', color: '#834EC2' },
  tools: { label: '工具调用', color: '#0E7A5F' },
  image: { label: '生图', color: '#D54941' },
  search: { label: '联网检索', color: '#E37318' },
};

/** 可用性状态的中文名与配色（对应 IM 的在线状态） */
export const AVAILABILITY_META: Record<
  AgentAvailability,
  { label: string; color: string; dot: string }
> = {
  ready: { label: '在线', color: '#0E7A5F', dot: '#00A870' },
  'needs-auth': { label: '未登录', color: '#E37318', dot: '#ED7B2F' },
  'needs-setup': { label: '需修复', color: '#D54941', dot: '#E34D59' },
  unreachable: { label: '网络不通', color: '#D54941', dot: '#E34D59' },
  'not-installed': { label: '未安装', color: '#8B8B8B', dot: '#C6C6C6' },
  unsupported: { label: '不可用', color: '#8B8B8B', dot: '#C6C6C6' },
  unknown: { label: '未探测', color: '#8B8B8B', dot: '#C6C6C6' },
};
