/**
 * 类型定义
 */

// 权限相关类型收敛到 shared/（与 server 共用同一份，避免前后端定义漂移）
import type { PermissionMode, PermissionSupport } from '../shared/types';
import type { Block, ThinkingBlock, ToolBlock, TextBlock, NoteBlock, ArtifactBlock, RawBlock, RawEntry } from '../shared/blocks';
import type { EventCapability, CapabilityProfile } from '../shared/capabilities';
import type { PermissionOption, PermissionReasonCode } from '../shared/permissions';
import type { Provenance } from '../shared/provenance';
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
  /** P0：这份模型清单的来源 / 更新时间 / 是否真的从服务方取到 */
  provenance?: Provenance;
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
   * 失败分类（服务端按 recovery.ts 的口径盖章；本期只消费 'auth'）。
   *
   * 有值时错误卡渲染恢复动作行：'auth' → 「去登录 / 重新探测」。
   * 与 error 分开两个字段而不是把分类混进文案：按钮的渲染条件是
   * 机器可读的判定，不能靠在自然语言里抠关键词。
   * 缺字段（旧服务端 / 非分类错误）= 不画动作行，渲染与以前完全一致。
   */
  errorKind?: string;
  /**
   * 本轮回复的耗时（毫秒，P6 成本统计）。
   * 与 `cost` / `tokens` 一样，只有适配器真的上报了才有值；
   * 没值时不要渲染成「0 秒」—— 没有数据和不花钱是两回事。
   */
  durationMs?: number;
  /**
   * A210：这一轮的首字分段（服务端 t0/t1/t2 + 前端 t3/揭示延迟）。
   * 只为「刚跑完的这一轮」存在，不落库、刷新后没有 —— 它是诊断数据，
   * 不是消息内容。缺字段时消息头照旧只显示耗时。
   */
  timing?: import('./utils/runTiming').TimingSummary;
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
  /**
   * A175：本轮首轮注入的跨 Agent 知识库引用（只在内存，不落库）。
   *
   * - 有值时才有 `kb_refs` 事件，因此「没注入」= undefined，UI 不显示；
   * - 空数组表示**注入了「未检索到」状态行**，不是没注入 —— UI 会显示
   *   「本次未检索到相关历史会话」；
   * - 刷新后丢失是预期行为：它描述的是「这一轮看过什么」，不是消息内容。
   */
  kbRefs?: import('../shared/blocks').KbCitationRef[];
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
 * ready = 已检测到凭据（未校验），needs-auth = 未登录，not-installed = 未添加，
 * unsupported = 不可用。
 *
 * 2026-11 起 ready 不再等价于「一定能用」：探测只确认命令/凭据文件存在，
 * 没有发真实业务请求。界面文案必须写「未校验」，不能写「就绪」。
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
  /** P0：SDK 类「本地登录态」结论的溯源；老服务端没有时界面明说未知 */
  provenance?: Provenance;
  /**
   * 探测动作本身的结果分类（A177）。
   *
   * 与 `availability` 是两个维度：availability 说「能不能用」，
   * probeState 说「这次探测发生了什么」。最典型的冲突是 SDK 冷启动
   * initialize 超时：availability 仍是 `needs-auth`（看着像没登录），
   * probeState 是 `timeout` —— 界面必须显示「探测超时」，
   * 不能让用户去重登一个其实已经登录好的账号。
   */
  probeState?: 'timeout' | 'credential-invalid' | 'probe-failed';
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
  /** 该 Agent 的恢复指引（后端按 id 下发；非 ready 时界面展示） */
  recoveryHint?: string;
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
  /**
   * P0：这份数据的来源 / 读取时刻 / 有没有真的向服务方校验过。
   * 账号卡顶部的溯源行读它；缺省（老服务端）时显示「数据来源与时间未知」，
   * 绝不把本地文件快照说成「已校验」。
   */
  provenance?: Provenance;
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
 * `dot` 是**图形**（头像右下角 8px 圆点）：B1 起与 `color` 同源，一律
 * 引用 `--tc-status-*` 令牌 —— 原先这里写裸 hex（#00A870 / #ED7B2F /
 * #E34D59 / #C6C6C6），深色主题下那几颗点不会跟着提亮，与旁边的状态词
 * 对不上。同时新增 `dotShape`：**在线 = 实心、非在线 = 空心环**，
 * 让「能不能用」这件事不只靠颜色（色弱用户同样能分出来）。
 */
export type StatusDotShape = 'solid' | 'hollow';

export const AVAILABILITY_META: Record<
  AgentAvailability,
  { label: string; color: string; dot: string; dotShape: StatusDotShape }
> = {
  ready: {
    label: '在线', color: 'var(--tc-status-ok)', dot: 'var(--tc-status-dot-ok)', dotShape: 'solid',
  },
  'needs-auth': {
    label: '未登录', color: 'var(--tc-status-warn)', dot: 'var(--tc-status-warn)', dotShape: 'hollow',
  },
  'needs-setup': {
    label: '需修复', color: 'var(--tc-status-danger)', dot: 'var(--tc-status-danger)', dotShape: 'hollow',
  },
  unreachable: {
    label: '网络不通', color: 'var(--tc-status-danger)', dot: 'var(--tc-status-danger)', dotShape: 'hollow',
  },
  'not-installed': {
    label: '未安装', color: 'var(--tc-status-muted)', dot: 'var(--tc-status-muted)', dotShape: 'hollow',
  },
  unsupported: {
    label: '不可用', color: 'var(--tc-status-muted)', dot: 'var(--tc-status-muted)', dotShape: 'hollow',
  },
  unknown: {
    label: '未探测', color: 'var(--tc-status-muted)', dot: 'var(--tc-status-muted)', dotShape: 'hollow',
  },
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
  status: { availability: AgentAvailability; probeState?: AgentStatus['probeState'] };
}): string {
  const view = agentStatusViewOf(agent);
  return view.label;
}

/**
 * A177/A178：把「探测动作的结果」抬到状态词的第一优先级。
 *
 * 为什么必须单独一层：SDK 的 availability 在鉴权失败时会统一落到
 * `needs-auth`，于是「initialize 超时」和「真的没登录」在界面上长成一样。
 * 用户看到「未登录」就去反复登录，而实际上账号是好的，只是冷启动没在
 * SDK 自己的 60 秒预算内完成初始化。这里把 probeState 优先，保证四种
 * 状态词互不混淆；没有 probeState 时完全沿用旧口径，不影响历史断言。
 */
export function agentStatusViewOf(agent: {
  kind: AgentKind;
  status: { availability: AgentAvailability; probeState?: AgentStatus['probeState'] };
}): { key: string; label: string; color: string; dot: string; dotShape: StatusDotShape } {
  const { availability, probeState } = agent.status;
  // 配色直接借用既有档位（warn / danger），不在这里再写一份 hex：
  // 状态词换了、颜色语义没换，圆点与标签自然保持同一套令牌。
  if (probeState === 'timeout') {
    return { ...AVAILABILITY_META['needs-auth'], key: 'probe-timeout', label: '探测超时' };
  }
  if (probeState === 'credential-invalid') {
    return { ...AVAILABILITY_META['needs-setup'], key: 'credential-invalid', label: '凭据无效' };
  }
  if (probeState === 'probe-failed') {
    return { ...AVAILABILITY_META['needs-setup'], key: 'probe-failed', label: '探测失败' };
  }

  const base = AVAILABILITY_META[availability];
  if (availability === 'needs-auth' && agent.kind === 'http') {
    return {
      key: 'needs-key', label: '缺 Key',
      color: base.color, dot: base.dot, dotShape: base.dotShape,
    };
  }
  return {
    key: availability, label: base.label,
    color: base.color, dot: base.dot, dotShape: base.dotShape,
  };
}

/** 状态圆点颜色：与状态词同源，避免「文字说超时、圆点还是橙色未登录」 */
export function agentStatusDotOf(agent: {
  kind: AgentKind;
  status: { availability: AgentAvailability; probeState?: AgentStatus['probeState'] };
}): string {
  return agentStatusViewOf(agent).dot;
}

/* ── A164 扩展（Agent 技能 + MCP 服务）───────────────────────────────────
 *
 * 与 `AgentSkill`（A2A 式能力标签，见 server/agents/types.ts）和 L3 技能记忆
 * （`data/memory/skills/*.md`，设置页「技能」那一栏）**都不是一回事**。
 * 这里说的是「从用户本机各家 Agent 目录里读进来的、可在 OPC 里共用一份的
 * SKILL.md / MCP 配置」。命名冲突的完整证据见 PLAN-EXTENSIONS.md §4.2。
 */

export type ExtensionKind = 'skill' | 'mcp';

/**
 * 挂载能力，四档。**这不是四种状态，是四种能力** ——
 * `unsupported` 表示「这个 Agent 根本没有把外部技能送进去的通道」，
 * 与「有这个通道但这次没送」是两件事，界面上必须分开表达（灰色而不是叉）。
 */
export type ExtensionMountMode = 'native' | 'flag' | 'prompt' | 'unsupported';

export interface ExtensionSourceRef {
  agentId: string;
  path: string;
  contentHash: string;
  seenAt: string | null;
}

export interface ExtensionTargetState {
  agentId: string;
  mode: ExtensionMountMode;
  status: string;
  /** 事实：该 Agent 自己的目录里确实有这一份 */
  present: boolean;
  detail: string | null;
  checkedAt: string | null;
}

export interface ExtensionItem {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string | null;
  description: string | null;
  /** 技能正文；命中敏感内容时后端置 null（整段不落库） */
  body: string | null;
  /**
   * 归一化前的原文（A166 / P1）。
   *
   * 只在「做过归一化」时非空 —— 非空就说明可以一键回滚。
   * 归一化后的正文里会含 `{{SKILL_DIR}}` / `{{SKILLS_ROOT}}` 占位符，
   * **需要分发层替换成目标 Agent 的实际路径**才可用（P3）。
   */
  bodyOriginal: string | null;
  /** MCP 配置 JSON 文本；命中敏感内容时值被替换成 *** 但结构保留 */
  configJson: string | null;
  contentHash: string;
  bodyHash: string;
  revision: number;
  locallyModified: boolean;
  blocked: boolean;
  blockedReason: string | null;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 列表项在 item 之上多带一份来源清单（`GET /api/extensions` 直接给） */
export interface ExtensionListItem extends ExtensionItem {
  sources: ExtensionSourceRef[];
  sourceCount: number;
  /**
   * 还有几个 Agent 真能收到这一份（通道 × 本机实存目录 × 不由自己持有）。
   * 0 = 无可分发目标，开关置灰；口径见 `server/extensions/targets.ts`。
   */
  targetCount: number;
  /** `targetCount > 0` 的便捷布尔；老后端缺这个字段时按「可分发」处理 */
  distributable: boolean;
}

export interface ExtensionStats {
  skillCount: number;
  mcpCount: number;
  blockedCount: number;
  duplicateCount: number;
  conflictCount: number;
}

export interface ExtensionTargetSpec {
  agentId: string;
  label: string;
  skillsDir: string | null;
  mode: ExtensionMountMode;
  note: string;
}

/**
 * 能力矩阵的六档状态（A164 方案 A）。
 *
 * 与 `server/extensions/targets.ts` 的 `MatrixState` 一一对应 —— 但**顺序、
 * 文案、是否可用全部由后端下发**（`matrixStates`），前端只按 `rank` 渲染。
 * 这里只声明形状，不复制那一份常量。
 */
export type ExtensionMatrixState =
  | 'ready'
  | 'injected'
  | 'sealed'
  | 'planned'
  | 'local-only'
  | 'unsupported';

export interface ExtensionMatrixStateMeta {
  state: ExtensionMatrixState;
  label: string;
  /** 组顺序的唯一来源：越小越靠前 */
  rank: number;
  /** 这一份能不能被该 Agent 用上 */
  available: boolean;
  /** 状态点取哪一类语义色（具体色值由 CSS 令牌决定） */
  tone: 'ok' | 'warn' | 'brand' | 'muted';
  /** 说明浮层里的定义 */
  hint: string;
}

export interface ExtensionImportReport {
  skillScanned: number;
  mcpScanned: number;
  added: number;
  updated: number;
  unchanged: number;
  conflicts: Array<{ kind: ExtensionKind; name: string }>;
  blocked: Array<{ kind: ExtensionKind; name: string; reason: string }>;
}

/* ── 归一化（A166 / P1）──────────────────────────────────────────────── */

export type ExtensionNormalizeRule = 'home-path' | 'tool-name';

export interface ExtensionNormalizeHit {
  rule: ExtensionNormalizeRule;
  /** 原文中的字符偏移（含） */
  start: number;
  /** 字符偏移（不含） */
  end: number;
  before: string;
  after: string;
  /** 1-based 行号 */
  line: number;
}

export interface ExtensionNormalizePreview {
  changed: boolean;
  hits: ExtensionNormalizeHit[];
  summary: Record<ExtensionNormalizeRule, number>;
  /** 归一化后的全文 */
  preview: string;
  /** 已经归一化过 ⇒ 能回滚 */
  hasOriginal: boolean;
}

export const EXT_NORMALIZE_RULE_LABEL: Record<ExtensionNormalizeRule, string> = {
  'home-path': '家目录绝对路径',
  'tool-name': '工具名引用',
};

/* ── 差异检测（A168 / P4）────────────────────────────────────────────── */

export type ExtensionDriftState = 'new' | 'updated' | 'conflict' | 'gone';

export interface ExtensionDriftEntry {
  kind: ExtensionKind;
  name: string;
  title: string | null;
  state: ExtensionDriftState;
  /** 提供新内容的 Agent；`gone` 时为 null */
  agentId: string | null;
  sourcePath: string | null;
  /** 后端拼好的一句话，前端直接显示 */
  detail: string;
}

export interface ExtensionDriftReport {
  scannedAt: string;
  entries: ExtensionDriftEntry[];
  counts: { new: number; updated: number; conflict: number; gone: number; total: number };
}

export interface ExtensionDriftApplyResult {
  kind: ExtensionKind;
  name: string;
  /** `added` / `updated` / `unchanged` / `conflict` / `missing` */
  outcome: string;
  reason?: string;
}

/**
 * 四态的界面文案。
 *
 * `conflict` 用「有冲突」而不是「已更新」：两者都意味着源变了，但只有前者
 * 应用后会**丢掉用户的编辑**。文案必须让这个差别在第一眼就成立。
 */
export const EXT_DRIFT_LABEL: Record<ExtensionDriftState, string> = {
  new: '新发现',
  updated: '源已更新',
  conflict: '有冲突',
  gone: '源已消失',
};

/**
 * 四档能力的中文标签。
 *
 * ⚠️ `unsupported` 写成「不支持」而不是「未挂载」：后者听起来像「这次忘了」，
 * 用户会去找一个不存在的开关。真相是那个 Agent 没有这条通道。
 */
export const EXT_MOUNT_LABEL: Record<ExtensionMountMode, string> = {
  native: '原生支持',
  flag: '启动参数',
  prompt: '提示词注入',
  unsupported: '不支持',
};

/**
 * 「本机 CLI 配置里写过的模型名」（自动发现并可选）。
 *
 * 与服务端 `server/agents/cliConfiguredModels.ts` 的 CliConfiguredModel 同形：
 * 这里只发现**名字**，不代表账号真有权益、也不代表 CLI 现在还认它。
 * 界面必须标「未验证」，选中只是把 id 原样透传给 CLI，由 CLI 用自己的
 * 配置连网关 —— 本应用不读凭据、不代为验证。
 */
export interface CliConfiguredModel {
  id: string;
  label: string;
  source: string;
  agentIds: string[];
}

/**
 * A210「即将接入」占位条目（前端形状，与服务端 comingSoon.ts 同形）。
 *
 * 这是**纯展示数据**，不是 RegisteredAgent：没有 status / install / 凭据，
 * 因此永远不会被 `isInstallable()` 判成「可安装」，也不会进联系人或
 * 新建会话选择器。真接入时后端用同一个 id 把它从清单里剔除即可转正。
 */
export interface ComingSoonAgent {
  id: string;
  name: string;
  vendor: string;
  tier: 'acp' | 'stream-json' | 'evaluating';
  status: 'soon' | 'planned';
  reason: string;
  color: string;
}

export const COMING_SOON_TIER_LABEL: Record<ComingSoonAgent['tier'], string> = {
  acp: '原生 ACP',
  'stream-json': '流式输出',
  evaluating: '评估中',
};

export const COMING_SOON_STATUS_LABEL: Record<ComingSoonAgent['status'], string> = {
  soon: '即将接入',
  planned: '规划中',
};
