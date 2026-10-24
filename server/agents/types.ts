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

import type { RiskLevel } from './permission-gate.js';

/** 统一事件流。与模板 SSE 契约一一对应。 */
export type AgentEvent =
  | { type: 'init'; sessionId: string; model?: string; resumeToken?: string | null }
  | { type: 'text'; content: string }
  /** 思考过程（Hermes ACP 的 agent_thought_chunk）。与正文分开，前端折叠展示 */
  | { type: 'thinking'; content: string }
  | { type: 'tool'; id: string; name: string; input?: unknown }
  /**
   * 工具执行过程中的增量输出（E5）。
   *
   * 有它才能做「bash 命令逐行滚」「长输出边跑边看」。没有的适配器不发，
   * 前端只在收到时把内容追加到工具卡的 tail 区，不做任何假设。
   */
  | { type: 'tool_output'; toolId: string; content: string }
  | { type: 'tool_result'; toolId: string; content: string; isError?: boolean }
  /** 任务产物元数据；文件内容由 uri 提供，避免把大文件塞进事件流。 */
  | {
      type: 'artifact';
      id: string;
      name: string;
      mediaType: string;
      uri?: string;
      data?: unknown;
      description?: string;
    }
  /**
   * 用量上报（不产生块）。
   *
   * 单独一个事件而不是塞进 done：有的 CLI 每完成一步就报一次用量
   * （opencode 的 step_finish、gemini 的 result），但整轮并没有结束。
   * 适配器把最新一次报给 CLI 适配器，最终 done 时一并带上。
   */
  | { type: 'usage'; durationMs?: number; cost?: number; tokens?: number }
  /**
   * 一轮结束。三个usage字段语义不同，**不要互相冒充**：
   *   - `durationMs`：耗时（毫秒），适配器自己量的 wall-clock
   *   - `cost`：费用（美元）。只有 SDK 适配器真的拿到了平台账单价才会填
   *   - `tokens`：token 数。ACP 的 `usage.totalTokens` 走这个字段
   *
   * 曾经 ACP 把 token 数塞进 `cost`，于是「成本统计」把 12000 个 token
   * 显示成 $12000。同类字段必须各就各位，否则统计功能本身就是假数据。
   */
  | { type: 'done'; durationMs?: number; cost?: number; tokens?: number }
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
      /** A40 门禁给出的风险分级。缺失时前端按「未知」处理，不猜 */
      risk?: RiskLevel;
      /** 命中的规则原文 / 分类器说明，供审批弹窗解释「凭什么卡你」 */
      rule?: string;
    };

// ============= Agent 描述 =============

/** Agent 的接入方式，决定用哪个适配器。 */
/**
 * 接入方式。
 *
 * `http` 是「只有 HTTP API、没有 CLI」的模型走的路（豆包 / Kimi 等）。
 * 它**没有工具调用循环**，所以只能承载 chat / write 能力，不能标 code / tools。
 */
export type AgentKind = 'sdk' | 'cli' | 'acp' | 'http' | 'mock';

/** Agent 能力标签，用于场景包与任务分派时筛选。 */
export type AgentCapability =
  | 'chat'      // 通用问答
  | 'code'      // 代码生成与审查
  | 'write'     // 长文本写作
  | 'tools'     // 可读写文件 / 执行命令
  | 'image'     // 可生成图像
  | 'search';   // 可联网检索

/**
 * 事件能力：这个 Agent 能把「过程」暴露到什么粒度。
 *
 * 与 AgentCapability 分开的理由见 AgentDescriptor.eventCapabilities 的注释。
 * `text` / `done` / `error` 是所有适配器都能给的，不列在这里。
 */
export type AgentEventCapability =
  | 'thinking'      // 思考过程（原文或摘要）
  | 'thinking_summary' // 只给摘要（如 codex 的 reasoning summary）
  | 'tool'          // 工具调用与结果
  | 'tool_output'   // 工具执行中的增量输出
  | 'usage'         // token 用量
  | 'cost'          // 费用
  | 'permission';   // 反向权限请求

/** Agent 能承接的结构化任务类别（参考 A2A AgentSkill）。 */
export interface AgentSkill {
  /** 稳定机器键，用于编排与过滤；同一个 Agent 内唯一 */
  id: string;
  /** 面向用户的任务名 */
  name: string;
  /** 适用任务说明 */
  description: string;
  /** 适合匹配用户任务的关键词 */
  tags?: string[];
  /** 支持的输入/输出媒体类型，如 text/plain、application/json */
  inputModes?: string[];
  outputModes?: string[];
}

/** 可解释的技能匹配：技能名/说明/标签与用户任务的词项重合分数。 */
export function scoreAgentSkills(skills: readonly AgentSkill[], prompt: string): number {
  const tokens = (value: string) => {
    const parts = value.toLocaleLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_+#.-]+/gu) ?? [];
    return parts.flatMap(part => {
      if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part)) return [part];
      if (part.length < 2) return [part];
      const bigrams = Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2));
      return [part, ...bigrams];
    });
  };
  const promptTokens = new Set(tokens(prompt));
  if (promptTokens.size === 0) return 0;
  let best = 0;
  for (const skill of skills) {
    const words = new Set(tokens([skill.id, skill.name, skill.description, ...(skill.tags ?? [])].join(' ')));
    let score = 0;
    for (const word of words) {
      if (promptTokens.has(word)) score += word.length > 1 ? 2 : 1;
      else if (word.length >= 2 && [...promptTokens].some(token => token.includes(word) || word.includes(token))) score += 1;
    }
    best = Math.max(best, score);
  }
  return best;
}

/** 结构化产物数据上限，避免原生适配器把巨型 payload 写入 SSE/SQLite。 */
export const MAX_ARTIFACT_DATA_BYTES = 256 * 1024;

const SKILL_META: Record<AgentCapability, { name: string; description: string }> = {
  chat: { name: '问答', description: '回答问题并分析信息' },
  code: { name: '代码任务', description: '编写、审查或修改代码' },
  write: { name: '写作', description: '撰写或编辑长短文本' },
  tools: { name: '工具操作', description: '使用 Agent 自身支持的工具完成任务' },
  image: { name: '图像生成', description: '根据提示生成图像' },
  search: { name: '联网检索', description: '检索并综合在线信息' },
};

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

/**
 * 一条 Agent 在「本机没有」时，用户该怎么把它弄到机器上（A71）。
 *
 * 为什么不用一句话说清（原来的 `installHint` 就是一句话）：那 14 句话把
 * **三件不同的事**混在了一起 —— 安装命令、登录步骤、环境变量。典型如 codex：
 * `npm i -g @openai/codex，然后 codex login`。界面只能整句显示，
 * 用户不知道哪半截该粘到终端、哪半截是装完之后的事。
 *
 * 拆开之后每个字段只有一个用途：
 *   - `command` 整行可复制到终端（**只复制，不代跑**，理由见 PLAN-AGENT-INSTALL §3）
 *   - `note`    装完之后还要做什么（登录 / 填 Key）
 *   - `url`     核实过的官方页（核实不到就**不写**，不画按钮）
 */
export type InstallMethod =
  /** npm 全局包，要求本机有 Node */
  | 'npm'
  /** 厂商提供的 PowerShell 安装脚本（`irm … | iex`），只在终端里由用户自己跑 */
  | 'script'
  /** 桌面端安装器，没有命令行安装方式 */
  | 'installer'
  /** 不需要安装，缺的是 API Key / 登录 */
  | 'key'
  /** 本应用没收录可信的安装入口 —— 界面不画按钮，只写说明 */
  | 'unknown';

export interface AgentInstall {
  method: InstallMethod;
  /** npm 包名（`method:'npm'` 必填，且必须出现在 `command` 里） */
  pkg?: string;
  /** 逐字命令，用于展示与复制 */
  command?: string;
  /** 官方下载/文档页，必须 https 且域名在 `INSTALL_HOSTS` 白名单里 */
  url?: string;
  /** 执行该命令的前置条件（用于界面如实提示「本机缺 Node」这类信息） */
  requires?: 'node' | 'powershell' | 'none';
  /** 装完之后还要做什么。**不是**安装步骤 */
  note?: string;
  /** 这条链接/命令的核实日期（ISO 日期）。链接会烂，这个字段是让它烂了能被发现 */
  checkedAt?: string;
  /** 怎么核实的（给人看的依据，便于下次复核时照着重做一遍） */
  checkedFrom?: string;
}

/**
 * 运行时环境探测结果（A71）。
 *
 * 与 `AgentInstall` 分开：前者是**静态元数据**（写死在定义表里），
 * 这个是**本机实况**（有没有 Node、有没有 PowerShell）。
 * 混在一起会让「换个机器同一份定义就变了」这件事变得说不清。
 */
export interface InstallEnv {
  /** PATH 里有没有 node。**不报告版本号** —— 见 installEnv.ts 顶部说明 */
  node?: { ok: boolean };
  /** PATH 里有没有 powershell / pwsh */
  powershell?: { ok: boolean };
}

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
  /** 细化的任务技能；缺省时由通用能力标签派生兼容技能 */
  skills?: AgentSkill[];
  /**
   * 事件能力（E1）。
   *
   * `capabilities` 描述「这个 Agent 会干什么」（问答/写代码/生图），
   * 这里描述「它能把过程暴露到什么粒度」。两者不能混用：
   * 一个能写代码的 Agent 完全可能只吐纯文本，UI 若按业务能力推断
   * 「它应该有工具卡片」，就必然出现永远空着的折叠条。
   *
   * 缺省（undefined）= 只有最小公共集：text / done / error。
   */
  eventCapabilities?: AgentEventCapability[];
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
  /**
   * 结构化的获取方式（A71）。有它时界面按 method 出按钮；
   * 没有时退回 `installHint` 纯文字 —— 老条目不会因为缺字段而崩。
   */
  install?: AgentInstall;

  /* ── 产品族元数据（A68，全部可选）────────────────────────────────
   *
   * 解决的问题：同一个厂商可能有 agent / CLI / IDE，有国际版 / 国内版，
   * 光看 `name` 分不清「两个 Kimi 为什么是两个条目」「这个 Qoder 是哪个区的」。
   *
   * ⚠️ 与 `kind` 的区别：`kind` 是**我们怎么接**（sdk/cli/acp/http），
   * `surface` 是**产品本身是什么形态**。同一个产品可以既有 IDE 又有 CLI
   * （qoder / cursor / antigravity / kimi 都是），我们只接 CLI/ACP/HTTP 那一面，
   * 所以 `surface` 永远不该出现 `ide`（见 verify:family 的断言）。
   *
   * 为什么把「机器键」和「官方显示名」分成两个字段：`authScope` 要参与唯一性断言
   * （必须稳定、不能有空格和标点），而界面上必须显示**厂商自己的叫法**
   * （腾讯叫「国内版/国际版」、Kimi 叫「中国站/国际站」），两者不能兼得。
   */

  /**
   * 产品族标识（机器可读，同族共用）。
   * 例：`kimi`（开放平台与 Kimi Code 同族）、`google`（Gemini 与 Antigravity 同族）。
   */
  family?: string;
  /** 产品族的**官方显示名**。例：`WorkBuddy`、`Kimi`、`火山方舟`。 */
  familyName?: string;
  /** 产品形态（≠ 接入方式 `kind`）。`ide` 是保留值，本项目不接。 */
  surface?: 'cli' | 'acp' | 'sdk' | 'http' | 'ide';
  /** 凭据属于哪个市场。`any` = 不分区 / 跟随模型 provider / 本地运行。 */
  region?: 'cn' | 'intl' | 'any';
  /** 区域在**该厂商官方口径里**叫什么（腾讯「国内版」、Kimi「中国站」…）。 */
  regionName?: string;
  /**
   * 账号体系标识（机器可读）—— 决定**额度算谁的**。
   * 不同 `authScope` 必须是两条目：一个子进程只能持一份凭据，
   * 合成一条就是「切了等于没切」的假控件。
   */
  authScope?: string;
  /** 账号体系的官方叫法。例：`腾讯云账号`、`Kimi 开放平台 API Key`。 */
  authScopeName?: string;
  /**
   * 运行时请求打到哪些主机（不含协议）。
   *
   * **不是**在定义表里另写一份：它由 `AgentDefinition.backendHosts` 在
   * `registry.toInfo()` 里派生出来。理由很直接 —— 这份数据是给用户看
   * 「我的请求到底发去哪」的，一旦有两份来源就一定会漂移，漂了就是骗人。
   * 本地子进程类 Agent（无固定端点）留空，界面上不显示这一行，不写「未知」。
   */
  endpointHosts?: string[];
  /**
   * 同族的其他条目（不含自己），由 `registry.toInfo()` 从定义表派生。
   *
   * 为什么放在后端算：资料页要回答的那个问题 ——「这两个 Kimi 到底是不是一回事」
   * —— 答案取决于**对方**的账号体系，而单个 descriptor 看不到别人。
   * 客户端自己算就得先拿到全量名册再按 family 过滤，多一处容易漂的重复逻辑；
   * 后端本来就持有全表，算一次给出去最省事也最准。
   */
  familyPeers?: Array<{
    id: string;
    name: string;
    /** 对方的账号体系：与自己的相同 = 共用额度；不同 = 额度不互通 */
    authScope?: string;
    regionName?: string;
  }>;
  /**
   * 同厂、但**没有接入**的另一个版本（A69 / PLAN §6 P2）。
   *
   * 与 `familyPeers` 的区别是「接没接」：peers 在名册里能点开，siblings 只有一句
   * 「检测到了，为什么没接」。之所以要暴露这个，是因为用户机器上装着
   * `~/.qoder-cn` / `~/.workbuddy-ai` 时，名册只有一个条目会让人以为「不支持」
   * 甚至「现在这条就是国际版」。
   *
   * 由 `familyHints.ts` 探测，**只在真的探测到时挂上**；探不到就不出现，
   * 不写「未知」占位。
   */
  localSiblings?: Array<{
    id: string;
    name: string;
    regionName: string;
    detectedPath: string;
    evidence: string;
    /** 没接入的具体原因（与 nextStep 互斥） */
    blockedBy?: string;
    /** 可接入时要用户准备什么 */
    nextStep?: string;
  }>;
  /**
   * 上次实际请求走的账号体系（目前只有 zcode 提供）。
   *
   * 措辞必须是「上次」：zcode 把当前 provider 存在加密字段里读不出来，
   * 所以这里给的是**使用记录**（`model_usage` 表），带时间与来源。
   */
  lastRequest?: {
    account: 'zai' | 'bigmodel' | 'custom' | 'unknown';
    accountLabel: string;
    model: string;
    at: string;
    source: string;
  };
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
  /**
   * 需要登录时的认证地址。
   *
   * 单独一个字段而不是让前端从 message 里抠 URL：message 是给人看的
   * 自然语言，抠 URL 等于把解析规则藏进 UI；而且 address 里可能带
   * state 等一次性参数，抠错一个字符登录就失败。
   */
  authUrl?: string;
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
  /**
   * 本机是否具备安装前置条件（A71）。只在 `install.requires` 需要时才挂上，
   * 免得 14 条都拖着一个空对象。界面据此把「跑这条命令会失败」提前说清，
   * 而不是让用户复制完才发现没装 Node。
   */
  installEnv?: InstallEnv;
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
  /**
   * A98：记忆作用域所用的目录 —— **只取会话自己绑定的那个 cwd，不做回落**。
   *
   * 为什么不复用上面的 `cwd`：`cwd` 在发送链路上会回落到 `process.cwd()`
   * （为了工具能正常跑，这是对的）。但记忆不能这么算：那样一个没绑目录的
   * 纯问答会话会莫名其妙吃进「后端进程所在仓库」的项目记忆 —— 用户在
   * 聊天窗口里问个常识问题，回答却按本仓库的规范来，比没有记忆更糟。
   *
   * `undefined` = 不注入项目层，只用全局记忆。
   */
  memoryCwd?: string;
  /** 指定模型 */
  model?: string;
  /**
   * 推理/思考强度（档位值，如 `low` / `xhigh`）。
   *
   * 由模型的 `reasoning.levels` 约束取值 —— 前端只能从那里面选，
   * 不信任任意字符串（codex 传错的值会被 CLI 悄悄忽略，用户以为设了其实没有）。
   *
   * `undefined` = 不显式传参，用 CLI 自己的默认（等价于 config.toml 里那一行）。
   */
  reasoningEffort?: string;
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
  const skills = descriptor.skills?.length
    ? descriptor.skills
    : descriptor.capabilities.map(capability => ({
        id: capability,
        ...SKILL_META[capability],
        tags: [capability],
        inputModes: ['text/plain'],
        outputModes: capability === 'image' ? ['text/plain', 'image/*'] : ['text/plain'],
      }));
  return { ...descriptor, skills, status };
}

/** 未探测时的初始状态 */
export function unknownStatus(): AgentStatus {
  return {
    availability: 'unknown',
    installed: false,
    probedAt: new Date().toISOString(),
  };
}
