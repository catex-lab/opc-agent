/**
 * Agent Provider 适配层的统一类型定义。
 *
 * 设计要点：不把任何一个 Agent 硬编码进业务逻辑。所有 Agent（无论走
 * CodeBuddy SDK、CLI 子进程还是 ACP 协议）都实现同一个 AgentProvider 接口，
 * 并把各自的输出归一化成同一套 AgentEvent 事件流。
 *
 * AgentEvent 刻意与模板原有的 SSE 契约（init / text / tool / tool_result /
 * done / error）保持一致，因此前端 src/hooks/useChat.ts 的流式渲染逻辑
 * 无需改动即可驱动所有 Agent。
 */

// ============= 事件协议 =============

/** 统一事件流。与模板 SSE 契约一一对应。 */
export type AgentEvent =
  | { type: 'init'; sessionId: string; model?: string; resumeToken?: string | null }
  | { type: 'text'; content: string }
  /** 思考过程（Hermes ACP 的 agent_thought_chunk）。与正文分开，前端折叠展示 */
  | { type: 'thinking'; content: string }
  | { type: 'tool'; id: string; name: string; input?: unknown }
  | { type: 'tool_result'; toolId: string; content: string; isError?: boolean }
  | { type: 'done'; durationMs?: number; cost?: number }
  | { type: 'error'; message: string }
  /**
   * 工具授权请求。
   *
   * 这是唯一一个「需要反向输入」的事件：适配器 yield 出它之后会挂起，
   * 直到前端调用 POST /api/permission-response 触发 resolvePermission()。
   * 不支持的适配器（CLI 类）永不产生该事件。
   */
  | {
      type: 'permission_request';
      requestId: string;
      toolUseId?: string;
      toolName: string;
      input: Record<string, unknown>;
    };

// ============= Agent 描述 =============

/** Agent 的接入方式，决定用哪个适配器。 */
export type AgentKind = 'sdk' | 'cli' | 'acp' | 'mock';

/** Agent 能力标签，用于场景包与任务分派时筛选。 */
export type AgentCapability =
  | 'chat'      // 通用问答
  | 'code'      // 代码生成与审查
  | 'write'     // 长文本写作
  | 'tools'     // 可读写文件 / 执行命令
  | 'image'     // 可生成图像
  | 'search';   // 可联网检索

/** 可用性状态。前端据此渲染徽标与修复指引。 */
export type AgentAvailability =
  | 'ready'         // 已就绪，可直接调用
  | 'needs-auth'    // 已安装但未登录
  | 'needs-setup'   // 已安装但需额外配置（如修复原生二进制）
  /**
   * 本机环境访问不到该 Agent 的后端（网络/代理拦截）。
   *
   * 为什么要单列一种状态：凭据与二进制都齐备的 Agent 也可能**一次都调不通**——
   * 实测 codex 的 ~/.codex/auth.json 有效、版本探测通过，但它唯一的后端
   * chatgpt.com 被代理以 502 拒绝，于是名册显示「在线」、每次对话却必然失败。
   * 把它和 needs-auth 区分开，用户才知道该去查网络/代理而不是去登录。
   */
  | 'unreachable'
  | 'not-installed' // 未在本机找到
  | 'unsupported'   // 本机形态无法无头调用（如仅 GUI）
  | 'unknown';      // 尚未探测

/** Agent 的静态描述（不随探测结果变化）。 */
export interface AgentDescriptor {
  /** 稳定标识，如 'codex' */
  id: string;
  /** 展示名，如 'Codex' */
  name: string;
  /** 厂商，如 'OpenAI' */
  vendor?: string;
  /** 接入方式 */
  kind: AgentKind;
  /** 能力标签 */
  capabilities: AgentCapability[];
  /** 一句话说明，用于名册页 */
  description?: string;
  /** Logo 键，前端用它在 AGENT_LOGOS 里取官方 SVG（与 Agent id 同名） */
  icon?: string;
  /** 主题色 */
  color?: string;
  /** 探测/接入所需的外部命令名（用于展示修复指引） */
  command?: string;
  /** 未就绪时的安装 / 修复指引 */
  installHint?: string;
}

/** Agent 的动态状态（每次探测更新）。 */
export interface AgentStatus {
  availability: AgentAvailability;
  /** 是否在本机找到可执行文件 */
  installed: boolean;
  /** 可执行文件绝对路径 */
  binaryPath?: string;
  /** 版本号 */
  version?: string;
  /** 面向用户的状态说明 */
  message?: string;
  /** 最近一次调用失败的原因（用于把运行时错误反馈到名册页） */
  lastError?: string;
  /** 探测时间（ISO） */
  probedAt: string;
}

/**
 * 权限模式与强制能力矩阵的类型，收敛在 `shared/types.ts`。
 *
 * 为什么要共享：前端要用同一份数据判断「该场景的约束落不落得了地」，
 * 两边各写一份必然漂移。这里只是再导出，外部 import 路径不变。
 */
import type { PermissionMode, PermissionSupport } from '../../shared/types.js';
import type { ScenarioTool } from '../../shared/scenarios.js';
export type { PermissionMode, PermissionSupport, ToolWhitelistSupport } from '../../shared/types.js';

/** 描述 + 状态，即 /api/agents 返回的条目。 */
export interface AgentInfo extends AgentDescriptor {
  status: AgentStatus;
  /** P4-5：权限强制能力（UI 据此如实提示「该场景的只读约束落不了地」） */
  permissionSupport?: PermissionSupport;
}

// ============= 调用上下文 =============

export interface SendContext {
  /** 本应用内的会话 ID */
  sessionId: string;
  /** 用户输入 */
  prompt: string;
  /** 系统提示词（并非所有 CLI 都支持，不支持则拼进 prompt） */
  systemPrompt?: string;
  /** 工作目录 */
  cwd?: string;
  /** 指定模型 */
  model?: string;
  /** 上次调用返回的恢复令牌，用于续接上下文（CLI 的 --continue / --session） */
  resumeToken?: string | null;
  /** 权限模式，映射到各 CLI 的审批参数 */
  permissionMode?: PermissionMode;
  /**
   * 场景声明的工具白名单（**排他**语义）。
   *
   * - `undefined` → 不做限制（历史行为，保持兼容）
   * - `[]`        → 全部拒绝（场景承诺「不调用工具」）
   * - `['tools']` → 全部放行
   * - 其他        → 只放行列出的类别，判定见 `toolPolicy.ts`
   *
   * 由后端按 `scenarioId` 推导后填入，不信任前端传值。
   */
  allowedTools?: ScenarioTool[];
  /** 中止信号 */
  signal?: AbortSignal;
}

// ============= Provider 接口 =============

export interface AgentProvider {
  readonly descriptor: AgentDescriptor;
  /** 探测本机可用性。应快速返回，不发起真实 LLM 调用。 */
  probe(): Promise<AgentStatus>;
  /** 发起一次调用，返回统一事件流。 */
  send(ctx: SendContext): AsyncIterable<AgentEvent>;
  /** 中止某个会话正在进行的调用 */
  abort(sessionId: string): void;
  /**
   * 回应一次 permission_request。
   * 只有可能产生该事件的适配器需要实现（目前是 SdkAdapter）。
   * @returns 是否命中了待处理的请求
   */
  resolvePermission?(requestId: string, decision: PermissionDecision): boolean;
}

/** 前端对权限请求的答复 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

// ============= 工具函数 =============

/** 把一个 provider 的 descriptor + status 组装成 API 返回结构 */
export function toAgentInfo(
  descriptor: AgentDescriptor,
  status: AgentStatus
): AgentInfo {
  return { ...descriptor, status };
}

/** 未探测时的初始状态 */
export function unknownStatus(): AgentStatus {
  return {
    availability: 'unknown',
    installed: false,
    probedAt: new Date().toISOString(),
  };
}
