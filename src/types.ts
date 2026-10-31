/**
 * 类型定义
 */

// 权限相关类型收敛到 shared/（与 server 共用同一份，避免前后端定义漂移）
import type { PermissionMode, PermissionSupport } from '../shared/types';
import type { Block, ThinkingBlock, ToolBlock, TextBlock, NoteBlock, ArtifactBlock, RawBlock, RawEntry } from '../shared/blocks';
import type { EventCapability, CapabilityProfile } from '../shared/capabilities';
import type { PermissionOption, PermissionReasonCode } from '../shared/permissions';
export type { PermissionMode, PermissionSupport };
export type { PermissionOption, PermissionReasonCode };
export type { Block, ThinkingBlock, ToolBlock, TextBlock, NoteBlock, ArtifactBlock, RawBlock, RawEntry };
export type { EventCapability, CapabilityProfile };
export { EVENT_CAPABILITY_ORDER } from '../shared/capabilities';

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
  /**
   * 免费 / 限时免费 / 付费角标。
   *
   * - opencode：按 models.dev 的官方价格判定（input 与 output 都为 0 才算免费）；
   * - WorkBuddy：按 SDK 的 `credits` 倍率判定（0 → 限时免费，正数 → 付费）。
   *
   * **拿不到价格/倍率时这里为空** —— 不标比标错好，用户不会因为一个角标去试一个
   * 其实要扣费的模型。
   */
  tag?: '免费' | '限时免费' | '付费';
  /** 右侧计费倍率（如 `0.34x`），与官方 WorkBuddy 菜单同款位置 */
  multiplier?: string;
  /** provider 展示名（OpenCode / Z.AI / GitHub Copilot …），用于第二行分组说明 */
  providerName?: string;
  /**
   * 这一条是否实测可路由（A151）。
   *
   * `false` = 来自官方清单但本机还没打过。界面上必须与已验证的区分开：
   * 官方清单里确实存在 `-m` 会被静默替换的名字（实测 `Qwen3.7-Plus`）。
   */
  verified?: boolean;
  /**
   * 这个模型支持的推理/思考强度档位（A62）。
   *
   * 与官方模型面板的「思考强度」对应，两种来源：
   * - codex：`codex debug models` JSON 里每个模型自带，per-model 权威；
   * - qoder：全局一套 8 档（CLI 报错原文 `auto…ultracode`）。
   *
   * **没有档位信息时这个字段不存在** —— 前端据此隐藏控件。
   * 绝不填一个猜的值：摆一个传不下去的档位选择器就是假控件。
   */
  reasoning?: {
    levels: Array<{ value: string; label: string; description?: string }>;
    /** 官方默认档（CLI 自己声明的）。没有就不预设选中值 */
    defaultLevel?: string;
  };
}

/**
 * 模型清单的来源与「能不能在这里切」（A151）。
 *
 * 原来只有两态：有列表 → 画下拉；没列表 → 画「模型由 Agent 决定」。
 * 那把两件不同的事混成了一句：
 *   ① **本应用切不了**（ZCode 只认它自己设置里的模型）；
 *   ② **我们不知道它有哪些**（gemini / pi 有 `-m` 但没有枚举命令）。
 * 于是 ZCode 明明把 13 条套餐与模型写在配置里，用户看到的却是「什么都没有」。
 *
 * 现在由后端明确给出 source：
 *   · `catalog`      —— CLI 枚举出来的，可选可切（opencode / qoder / codex / cursor）
 *   · `agent-config` —— 从 Agent 自己的配置文件读出来的，**只读**（zcode）
 *   · `unknown`      —— 真拿不到，维持原文案
 *
 * `selectable: false` 必须一路透到界面：能看、能知道现在用的是哪个，
 * 但点了不会生效的事一律不做。
 */
export interface AgentModelSource {
  /**
   * - `catalog`      CLI 枚举出来的（能跑什么，判据是 CLI 自己）
   * - `agent-config` Agent 自己配置文件里的（只读，本应用说了不算）
   * - `manual`       没有清单，但它接受 `--model` ⇒ 让用户手动填名字
   * - `unknown`      既没清单也不接受 model（模型由 Agent 自己决定）
   */
  kind: 'catalog' | 'agent-config' | 'manual' | 'unknown';
  selectable: boolean;
  /**
   * 手动填模型名模式（P3）。
   *
   * 与 `selectable: false` 互斥：只读清单是「看得到、改不了」，
   * 手动模式是「看不到、但能改」。两者的界面形态完全不同 ——
   * 只读是列表 + 灰掉的行，手动是一个输入框。
   */
  manual?: boolean;
  /** 只读时界面底部那句解释（为什么不能在这里切） */
  note?: string;
  /** 只读时用来高亮「当前用的是哪一条」 */
  currentModel?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
  /**
   * 这次工具调用花了多久（毫秒）。
   *
   * 来自 ToolBlock 的 startedAt/endedAt；只有两端都有值时才计算。
   * 流式中（还没结束）为空 —— 不要显示「0.0s」冒充已经跑完。
   */
  durationMs?: number;
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
  contentBlocks?: ContentBlock[];  // 保留用于兼容（老消息/生图）
  /**
   * 有序内容块（E2/E3）。**新数据一律走这里**，渲染顺序以数组为准。
   *
   * 为什么不再用 contentBlocks：它只有 text / tool_use / image 三种，
   * 装不下 thinking，于是思考只能当 message 级字段固定画在正文上方，
   * 「思考 → 说话 → 再思考」的位置信息就丢了。
   */
  blocks?: Block[];
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
   * 本轮回复的耗时（毫秒，P6 成本统计）。
   * 与 `cost` / `tokens` 一样，只有适配器真的上报了才有值；
   * 没值时不要渲染成「0 秒」—— 没有数据和不花钱是两回事。
   */
  durationMs?: number;
  /** 本轮费用（美元）。SDK 适配器上报平台账单价时才有 */
  cost?: number;
  /** 本轮消耗的 token 数。ACP 只上报这个 */
  tokens?: number;
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
  /**
   * 推理/思考强度档位值（A62），如 `low` / `xhigh`。
   *
   * 存的是**值**不是展示名：官方改译名、换语言都不影响已存数据。
   * 取值必须来自当前模型 `reasoning.levels` 里的某一个（见 Model.reasoning）——
   * 传一个档位表里没有的值，CLI 会静默忽略，用户以为设了其实没有。
   *
   * `undefined` / `null` = 用 CLI 自己的默认（不显式传参）。
   */
  reasoningEffort?: string | null;
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
  /**
   * 上一轮没有产出回复（A100）。
   *
   * 由后端算好返回：最后一条消息是 user、且这个会话当前没有活跃 run。
   * 只在「重新打开会话」时才有值 —— 应用被关闭/进程崩溃/用户中止都会留下
   * 这个痕迹，而它们的**后果完全一样**（这一轮没了），所以不区分原因，
   * 只如实说「没有产出回复」，并明确「无法恢复」。
   *
   * 前端**不要自己推**：它看不见别的标签页是不是正在跑这一轮，
   * 只凭「最后一条是 user」会误报成中断。
   */
  dangling?: { messageId: string; at: string } | null;
  /**
   * A117：会话所属项目（`projects.id`）。
   *
   * 后端 `sessions.project_id` 是 A98 加出来的列，此前前端从没还原过它 ——
   * 因为前端没有项目视图，没人读。现在「项目视图」要按项目分会话，
   * 所以必须在 fetchSessions 的映射里带上，否则刷新后所有会话都归到
   * 「未归属项目」里，项目视图永远是空的。
   *
   * `undefined` = 未归属（没绑 cwd、或项目已被删）。读取侧必须容忍
   * 悬空引用，见 server/db.ts 的 getSessionProject()。
   */
  projectId?: string;
}

/**
 * A117：项目（`projects` 表）。
 *
 * 项目由**目录**唯一确定：同一个目录永远只有一行，`path` 是归一化后的
 * 小写正斜杠路径。创建走「取或建」—— 前端不需要先建项目再用。
 */
export interface Project {
  id: string;
  /** 归一化路径（唯一键，用于记忆分区） */
  path: string;
  /** 展示名。默认取目录名，可改（PATCH /api/projects/:id） */
  name: string;
  createdAt: string;
  lastOpenedAt: string;
  /** 归属该项目的会话数，由 GET /api/projects 顺带算好 */
  sessionCount: number;
  /** 项目记忆的作用域统计；目录不可推导时为 null */
  memory: ProjectMemoryStats | null;
}

/** A119：项目任务。挂在项目上而不是会话上 —— 任务天然跨会话。 */
export type ProjectTaskStatus = 'todo' | 'doing' | 'done';

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  status: ProjectTaskStatus;
  createdAt: string;
  updatedAt: string;
}

/** A117：项目记忆统计，与 server/memory.ts 的 ProjectMemoryStats 同形 */
export interface ProjectMemoryStats {
  key: string;
  exists: boolean;
  coreTokens: number;
  coreBudget: number;
  skillCount: number;
  skillTokens: number;
}

export interface CustomAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  /** Logo 键，对应 agentLogos.ts 的 AGENT_LOGOS */
  icon?: string;
  /**
   * A160：注册表里用户上传的自定义 Logo。`icon` 是内置图标，这个是覆盖层；
   * 只在「从注册表映射成 CustomAgent」时带上，localStorage 里的自建 Agent 没有。
   */
  logoUrl?: string;
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
  /** A40 服务端门禁判出的风险分级。缺失说明该适配器没过门禁，按「未知」展示 */
  risk?: 'safe' | 'risky' | 'dangerous';
  /** 命中的规则名（人话），弹窗上解释「凭什么问这一句」 */
  rule?: string;
  /**
   * A132：服务端兜底兑现的时刻（epoch ms）。
   *
   * 缺省 = 该适配器没有超时兜底（ACP 的 `pendingPerms` 是裸 Map，无 setTimeout）。
   * 此时 UI 显示「无超时」——**不许伪造一个倒计时**。
   */
  expiresAt?: number;
  /**
   * P4：本次真实可选的答复档位，由适配器决定、原样渲染。
   *
   * 缺省 = 该适配器没声明（历史路径），卡片退回「拒绝 / 允许」两个按钮。
   * 前端**不补齐** always 之类的档位 —— 摆了就得真做到。
   */
  options?: PermissionOption[];
}

/**
 * 权限响应
 */
export interface PermissionResponse {
  requestId: string;
  behavior: 'allow' | 'deny';
  /** P4：选中的档位 id（适配器据此精确回选；缺省按 behavior 找第一档） */
  optionId?: string;
  /** P4：拒绝原因码，用来区分定稿 / 超时 / 收尾 / 门禁 */
  reasonCode?: PermissionReasonCode;
  message?: string;
}

// ============= Agent 注册表（来自 /api/agents） =============

/**
 * 接入方式，决定后端用哪个适配器
 *
 * `http` 曾经漏在这个联合里（后端 `server/agents/types.ts` 的 AgentKind 有它）：
 * 前端拿到 `kind:'http'` 只是被类型系统当成「不可能的值」，运行时照样传进来，
 * 于是任何按 kind 分支的逻辑都会把豆包 / Kimi 开放平台当成默认分支。
 */
export type AgentKind = 'sdk' | 'cli' | 'acp' | 'http' | 'mock';

/** 能力标签，即 Agent 资料页上的「擅长领域」 */
export type AgentCapability = 'chat' | 'code' | 'write' | 'tools' | 'image' | 'search';

/**
 * 过程能力（A111）：这个 Agent 能把「执行过程」暴露到什么粒度。
 *
 * 与 `AgentCapability` 是两件事，不能混用：一个会写代码的 Agent 完全可能
 * 只吐纯文本。前端**只按这份清单决定画什么**，不按业务能力猜 —— 否则
 * 就会出现「永远空着的工具折叠条」。
 *
 * P2：联合类型本体已挪进 `shared/capabilities.ts`，前后端用同一份。
 * 这里保留旧名字与常量导出，既有引用不用改 —— 但**不再手抄一份**：
 * 手抄镜像漂起来是没有声音的（OpenHands 那份实测漂了 20 类）。
 */
export type AgentEventCapability = EventCapability;

/** 可执行的任务类别；结构与后端 AgentSkill 对齐。 */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

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
  /** 需要登录时的认证地址（探测侧结构化给出，供「去登录」按钮使用） */
  authUrl?: string;
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

/**
 * 获取方式（A71）—— 与 `server/agents/types.ts` 同源，由 `/api/agents` 原样下发。
 *
 * 前端拿它决定**画哪种按钮**，而不是从 `installHint` 里猜。猜的后果很具体：
 * `installHint` 里既有「npm i -g …」又有「设置 ARK_API_KEY」还有「运行 claude 后 /login」，
 * 靠正则判断"这句是不是命令"必然出错，而错的那一条就是给用户看假信息。
 */
export type InstallMethod = 'npm' | 'script' | 'installer' | 'key' | 'unknown';

export interface AgentInstall {
  method: InstallMethod;
  pkg?: string;
  /** 逐字命令：展示与复制用同一份字符串，**不在应用里代跑** */
  command?: string;
  /** 官方页（https，域名在定义表白名单内）；核实不到就不下发 */
  url?: string;
  requires?: 'node' | 'powershell' | 'none';
  /** 装完之后还要做什么（登录 / 填 Key），不是安装步骤 */
  note?: string;
  checkedAt?: string;
  checkedFrom?: string;
}

export interface InstallEnv {
  /** PATH 里有没有 node（不报告版本号：取版本要起子进程，风险大于收益） */
  node?: { ok: boolean };
  powershell?: { ok: boolean };
}

/** 注册表返回的 Agent 条目：静态描述 + 动态状态 */
export interface RegisteredAgent {
  id: string;
  name: string;
  vendor?: string;
  kind: AgentKind;
  /**
   * A156：SDK 通道的厂商。只有 kind==='sdk' 且定义表显式写了 provider 时才有；
   * 缺省 = Tencent SDK（CodeBuddy / WorkBuddy 共用平台模型清单）。
   */
  sdkProvider?: 'tencent' | 'claude' | 'codex' | 'opencode';
  /**
   * 用户自建 Agent（A114）。名册页据此给「删除」入口。
   * 与后端 `server/agents/types.ts` 的 `AgentDescriptor.custom` 同源。
   */
  custom?: boolean;
  capabilities: AgentCapability[];
  /**
   * 过程能力清单（A111）。缺省（undefined）= 后端没声明，界面按「未知」处理，
   * **不要**替它假设支持或不支持。
   */
  eventCapabilities?: AgentEventCapability[];
  /**
   * 最近一次 run **观测到**的过程能力档（P2）。
   *
   * 与上面那份声明分开：声明可能过期，这份是投影器数出来的事实。
   * 缺省 = 还没跑过 / 老服务端不返回 —— 界面显示「未观察到」，
   * 不把「不知道」画成「不支持」。
   */
  observedCapabilities?: CapabilityProfile;
  /** Agent 可承接的任务类别；旧服务端可能不返回 */
  skills?: AgentSkill[];
  description?: string;
  icon?: string;
  color?: string;
  /**
   * A160：用户上传的自定义 Logo（`/api/avatars/<file>`）。
   * 缺省 = 用 `icon` 内置图标；是覆盖层，恢复默认后这个字段就消失。
   */
  logoUrl?: string;
  command?: string;
  installHint?: string;
  /** 结构化的获取方式（A71）。有它时界面按 method 出按钮，没有就退回纯文字 */
  install?: AgentInstall;
  /**
   * 本机是否具备安装前置条件（A71）。只在 `install.requires` 需要时才下发，
   * 拿不到就整个字段没有 —— 界面据此**不显示**「本机缺 Node」这种话，
   * 而不是显示一个猜出来的结论。
   */
  installEnv?: InstallEnv;
  status: AgentStatus;
  /** P4-5：权限强制能力 */
  permissionSupport?: PermissionSupport;

  /* ── 产品族元数据（A68）：与 server/agents/types.ts 的 AgentDescriptor 同源，
   * 由 /api/agents 原样下发。全部可选 —— 老后端 / 老夹具没有这些字段时，
   * 界面上不显示「身份」区块，而不是显示一堆「未知」。 */
  family?: string;
  familyName?: string;
  surface?: AgentSurface;
  region?: AgentRegion;
  regionName?: string;
  authScope?: string;
  authScopeName?: string;
  /** 运行时请求打到的主机（由后端从 backendHosts 派生）；本地子进程类为空 */
  endpointHosts?: string[];
  /** 同族的其他条目（后端派生）；用于资料页说清「是不是一回事」 */
  familyPeers?: Array<{ id: string; name: string; authScope?: string; regionName?: string }>;
  /**
   * 同厂但**未接入**的另一个版本（A69）。与 `familyPeers` 的区别是「接没接」：
   * peers 在名册里能点开，siblings 只有一句「检测到了，为什么没接」。
   * 后端探测不到就整个字段不下发，界面也不出现。
   */
  localSiblings?: Array<{
    id: string;
    name: string;
    regionName: string;
    detectedPath: string;
    evidence: string;
    blockedBy?: string;
    nextStep?: string;
  }>;
  /** 上次实际请求走的账号体系（目前只有 zcode）。是使用记录，不是当前设置 */
  lastRequest?: {
    account: 'zai' | 'bigmodel' | 'custom' | 'unknown';
    accountLabel: string;
    model: string;
    at: string;
    source: string;
  };
}

/**
 * 账号与权益（来自 `/api/agents/:agentId/account`，**只读**）。
 *
 * 与 `lastRequest` 的区别：那个是「上次请求真的打到哪」（使用记录），
 * 这个是「现在登录的是谁、领了哪些套餐、选中了哪个」（配置现状）。
 * 两者都可能过期，所以 `checkedAt` 一定要透到界面上。
 *
 * 全部可选字段都可能缺 —— 缺 = 该 Agent 读不到，**不代表没有**。
 */
export interface AgentAccountIdentity {
  name?: string;
  /** 邮箱原文。界面**必须掩码**后再显示（见 AgentDetailSections 的 maskEmail） */
  email?: string;
  org?: string;
  /** 当前套餐名（codex 的 `ChatGPT Free`） */
  planLabel?: string;
  source: string;
  /** 读不到身份的原因原话。与「没有账号」是两回事 */
  unavailableReason?: string;
}

export interface AgentAccountPlan {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'unknown';
  detail?: string;
  /** 套餐内真实模型名 */
  models: string[];
  /** 是否是当前选中的那一个 */
  selected: boolean;
  /** 选中了但没生效 —— 「领了却用不了」就是这个组合 */
  effective: boolean;
}

export interface AgentAccountSelection {
  family: string;
  familyLabel: string;
  kindLabel: string;
  providerName: string;
  providerKey: string;
  effective: boolean;
  detail?: string;
}

export interface AgentAccount {
  identity?: AgentAccountIdentity;
  currentSelection?: AgentAccountSelection[];
  plans: AgentAccountPlan[];
  source: string;
  /** 数据快照时间。缓存类数据必须带，否则分不清「没有」与「过期」 */
  checkedAt?: string;
  stale?: boolean;
  note?: string;
  /** 本应用能不能把这个 Agent 的模型传给 CLI */
  modelSelectable: boolean;
  modelNote: string;
  /** 不能在这里切时「去哪儿切」的原话 */
  switchHint?: string;
}

/** 产品形态（≠ 接入方式 kind）。`ide` 是保留值：本项目不接 IDE。 */
export type AgentSurface = 'cli' | 'acp' | 'sdk' | 'http' | 'ide';

/** 凭据所属市场。`any` = 不分区 / 跟随模型 provider / 本地运行。 */
export type AgentRegion = 'cn' | 'intl' | 'any';

/** 产品形态的显示名。用技术通用叫法（CLI / ACP / SDK / HTTP API），不另起中文名。 */
export const SURFACE_META: Record<AgentSurface, { label: string }> = {
  cli: { label: 'CLI' },
  acp: { label: 'ACP' },
  sdk: { label: 'SDK' },
  http: { label: 'HTTP API' },
  ide: { label: 'IDE' },
};

/**
 * 区域角标。
 *
 * 角标只用 `CN` / `INTL` 两个缩写（窄栏里放得下），**完整叫法**走 title
 * 与资料页的「身份」小节 —— 各厂商官方口径不同（腾讯叫「国内版」、Kimi 叫
 * 「中国站」），所以完整文案由后端下发的 `regionName` 决定，这里只给兜底。
 */
export const REGION_META: Record<AgentRegion, { badge: string; label: string }> = {
  cn: { badge: 'CN', label: '中国站' },
  intl: { badge: 'INTL', label: '国际站' },
  // `any` 不画角标：把「不分区」也画成一个角标，会让满屏都是角标、反而看不出重点
  any: { badge: '', label: '不分区' },
};

/**
 * 能力标签的中文名与配色。
 *
 * `color` 是**文字色**，一律走 `--tc-cap-*` 令牌（A159）。原先写裸 hex：
 * chat 的 #1F1F1F 在深色主题下几乎等于背景色（「问答」两个字看不见），
 * 其余五色也是按浅色底挑的，深色下只有 2.2~3.5:1。令牌的浅/深两档都算过
 * 「10% 同色底」上的对比度，见 index.css 那段注释。
 *
 * ⚠️ 调用方**不能**再用 `${color}18` 这种十六进制后缀拼底色 —— 令牌是
 * `var(...)`，拼出来是非法颜色。底色用 `color-mix(in srgb, <color> N%, transparent)`。
 */
export const CAPABILITY_META: Record<AgentCapability, { label: string; color: string }> = {
  chat: { label: '问答', color: 'var(--tc-cap-chat)' },
  code: { label: '代码', color: 'var(--tc-cap-code)' },
  write: { label: '写作', color: 'var(--tc-cap-write)' },
  tools: { label: '工具调用', color: 'var(--tc-cap-tools)' },
  image: { label: '生图', color: 'var(--tc-cap-image)' },
  search: { label: '联网检索', color: 'var(--tc-cap-search)' },
};

/**
 * 过程能力的中文名与配色。
 *
 * 每个键都必须有文案 —— 资料页会把**全部**键都列出来（支持的高亮、
 * 不支持的置灰并写「不支持」）。这就是「不折损」在 UI 上的落地方式：
 * 用户能区分「这个 Agent 没做工具调用」和「这个 Agent 报不了工具调用」，
 * 而不是对着一段什么都没有的过程区猜。
 */
export const EVENT_CAPABILITY_META: Record<
  AgentEventCapability,
  { label: string; hint: string }
> = {
  thinking: { label: '思考过程', hint: '展示模型推理原文' },
  thinking_summary: { label: '思考摘要', hint: '只给推理摘要，不给原文' },
  tool: { label: '工具调用', hint: '展示调用了哪些工具、结果如何' },
  tool_output: { label: '工具实时输出', hint: '工具执行中边跑边看' },
  usage: { label: '用量统计', hint: '上报 token 消耗' },
  cost: { label: '费用统计', hint: '上报平台账单金额' },
  permission: { label: '授权确认', hint: '执行敏感操作前先征求同意' },
};

/**
 * 可用性状态的中文名与配色（对应 IM 的在线状态）。
 *
 * `color` 是**文字色**，一律走 `--tc-status-*` 令牌（A134）。原先写裸 hex，
 * 四档里每一档都至少在一个主题下不到 4.5:1（ready 深色 3.25、needs-auth
 * 浅色 2.86…），而这些词是 11px —— 只有颜色没有文字时更糟，只有文字却看不清
 * 同样等于没有。令牌的浅/深两档都算过对比度，见 index.css 那段注释。
 *
 * `dot` 是**图形**（头像右下角 8px 圆点），要求 3:1 即可，保留原值不动 ——
 * 小圆点不需要文字级的对比度，提亮反而会在深色下显得发光。
 */
export const AVAILABILITY_META: Record<
  AgentAvailability,
  { label: string; color: string; dot: string }
> = {
  ready: { label: '在线', color: 'var(--tc-status-ok)', dot: '#00A870' },
  'needs-auth': { label: '未登录', color: 'var(--tc-status-warn)', dot: '#ED7B2F' },
  'needs-setup': { label: '需修复', color: 'var(--tc-status-danger)', dot: '#E34D59' },
  unreachable: { label: '网络不通', color: 'var(--tc-status-danger)', dot: '#E34D59' },
  'not-installed': { label: '未安装', color: 'var(--tc-status-muted)', dot: '#C6C6C6' },
  unsupported: { label: '不可用', color: 'var(--tc-status-muted)', dot: '#C6C6C6' },
  unknown: { label: '未探测', color: 'var(--tc-status-muted)', dot: '#C6C6C6' },
};

/**
 * 名册 / 资料页上那个「状态词」（A112）。
 *
 * 为什么不直接用 `AVAILABILITY_META[..].label`：`needs-auth` 的中文写成
 * 「未登录」，这个词只对**真的需要登录**的接入方式成立。HTTP 类（豆包、
 * Kimi 开放平台）压根没有「登录」这个动作 —— 它们要的是一份 API Key。
 * 用户在豆包 App、Kimi 桌面版里登录一百次，也不会让名册这一行变绿；
 * 而名册偏偏写着「未登录」，等于指着一个不存在的动作让他反复重试。
 *
 * 所以按 kind 分开说：http → 「缺 Key」，其余保持「未登录」。
 * （gemini 那种 cli + OAuth 的，说「未登录」是对的，不改。）
 */
export function availabilityLabelOf(agent: {
  kind: AgentKind;
  status: { availability: AgentAvailability };
}): string {
  const { availability } = agent.status;
  if (availability === 'needs-auth' && agent.kind === 'http') return '缺 Key';
  return AVAILABILITY_META[availability].label;
}
