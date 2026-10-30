/**
 * 本机 Agent 定义表。
 *
 * 每个 Agent 的静态信息（名称、厂商、能力、调用方式）集中在这里。
 * 新增一个 Agent = 在 AGENT_DEFS 里加一条 + （若需要新适配器）实现一个 adapter。
 */

import type { AgentDescriptor, AgentEvent, AgentInstall, SendContext } from './types.js';
import type { ScenarioTool } from '../../shared/scenarios.js';
import type { EventSource } from '../../shared/blocks.js';
import { codexSandboxFor } from './permissions.js';

/**
 * Claude Code 系（claude / cursor-agent）的 stream-json 行映射。
 *
 * 两者同构，所以只写一份：assistant 行里是 content blocks（text / thinking /
 * tool_use），user 行里是 tool_result。这也是「工具参数与结果成对出现」
 * 能还原成卡片的前提。
 */
function mapClaudeCodeLine(obj: unknown): AgentEvent | AgentEvent[] | null {
  const o = obj as {
    type?: string;
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number };
    message?: { content?: Array<Record<string, any>> };
  };
  if (!o || typeof o !== 'object') return null;

  if (o.type === 'user') {
    const content = o.message?.content;
    if (!Array.isArray(content)) return null;
    const results: AgentEvent[] = [];
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      results.push({
        type: 'tool_result',
        toolId: String(b.tool_use_id ?? ''),
        content:
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        isError: !!b.is_error,
      });
    }
    return results.length ? results : null;
  }

  if (o.type === 'assistant') {
    const content = o.message?.content;
    if (!Array.isArray(content)) return null;
    const events: AgentEvent[] = [];
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
        events.push({ type: 'text', content: b.text });
      } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
        events.push({ type: 'thinking', content: b.thinking });
      } else if (b?.type === 'tool_use') {
        events.push({
          type: 'tool',
          id: String(b.id ?? ''),
          name: String(b.name ?? 'tool'),
          input: b.input,
        });
      }
    }
    return events.length ? events : null;
  }

  if (o.type === 'result') {
    if (o.is_error) return { type: 'error', message: String(o.result ?? '执行失败') };
    const u = o.usage ?? {};
    const tokens =
      Number(u.input_tokens ?? u.inputTokens ?? 0) + Number(u.output_tokens ?? u.outputTokens ?? 0);
    const cost = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined;
    return tokens > 0 || cost != null ? { type: 'usage', tokens: tokens || undefined, cost } : null;
  }

  return null;
}

/** 权限模式 → 各 CLI 的审批参数 */
export type PermissionMode = NonNullable<SendContext['permissionMode']>;

/** CLI 调用规格 */
export interface CliSpec {
  /**
   * PATH 中查找的命令名。传数组表示同一条目有多个可能的命令名，
   * 按顺序找第一个命中的（A105：Trae 国内版装出来是 `trae-cn`，
   * 官方文档写的却是 `traecli` —— 只写一个就会把装好的用户判成未安装）。
   */
  bin: string | string[];
  /**
   * 追加的扩展名（A105：ZCode 桌面版的引擎是 `zcode.cjs`，
   * 没有任何可执行扩展名，不加这一项 PATHEXT 匹配不到它）。
   */
  binExts?: string[];
  /** 构造 argv（不含命令本身与垫片前缀参数） */
  buildArgs(prompt: string, ctx: SendContext): string[];
  /**
   * stdout 解析方式：
   *   - 'text'        原样当文本（会流式吐出来）
   *   - 'jsonl'       每行一个 JSON（流式事件）
   *   - 'json-object' 整个 stdout 是**一个** JSON 对象，进程结束时整体解析
   *                   （ZCode `--json` 就是这种：结束时一次性给
   *                   `{sessionId, response, usage}`。逐行解析会把
   *                   漂亮打印的多行 JSON 全当成纯文本显示出来。）
   */
  parse: 'text' | 'jsonl' | 'json-object';
  /**
   * jsonl 模式下把一行 JSON 映射为统一事件；返回 null 表示该行无输出价值。
   *
   * 允许返回数组：有的 CLI 把「工具开始 + 工具结果」塞在同一行里
   * （opencode 的 tool_use 就是如此），一条 JSON 需要拆成两个事件。
   */
  mapLine?(obj: unknown): AgentEvent | AgentEvent[] | null;
  /**
   * 有状态的映射器工厂。
   *
   * 为什么需要：codex 的 `item.updated` 给的是**累积文本**而不是增量，
   * 必须记住每个 item 上次发到第几个字符，才能算出真正的 delta。
   * 把状态放在定义表里的闭包中会在并发会话之间串味，所以每次调用新建一个。
   */
  createMapper?(): (obj: unknown) => AgentEvent | AgentEvent[] | null;
  /** 从一行 JSON 中提取续接上下文的令牌 */
  extractResumeToken?(obj: unknown): string | null;
  /**
   * 整体超时（毫秒）。默认 8 分钟。
   *
   * 为什么必须有：这些 CLI 在遇到网络故障时会**无限重连**而不是退出
   * （codex 实测会一直打印 "Reconnecting... waiting for network"）。
   * 没有超时的话，一次对话就能把 HTTP 请求永久挂住。
   */
  timeoutMs?: number;
  /**
   * A106：stdio 双向模式（目前只有 claude 的 control 协议）。
   *
   * 开了之后适配器把 stdin 保持打开，按 claude 的 control 协议
   * 逐个应答 `can_use_tool` 权限请求，而不是靠 `--allowedTools`
   * 预授权 —— 后者会让白名单内的工具**绕过权限门禁**直接跑
   * （预授权的工具不触发控制请求，场景白名单和高危判定都没机会生效）。
   * 协议细节见 `adapters/claude-control.ts`。
   */
  bidi?: boolean;
  /**
   * stderr 命中该模式即判定为不可恢复，立即终止并报错。
   * 用于把「会一直重试但永远不会成功」的情况快速失败。
   */
  fatalStderrPattern?: RegExp;
}

/**
 * HTTP 调用规格（kind === 'http' 时必填）。
 *
 * 三种方言覆盖了绝大多数「没 CLI 但有 API」的模型：
 *   - openai     OpenAI Chat Completions 兼容（豆包/火山方舟、DeepSeek、
 *                智谱、Kimi/Moonshot、Ollama、vLLM…… 事实标准）
 *   - anthropic  Anthropic Messages（`/v1/messages`，事件流格式不同）
 *   - gemini     Google generateContent（`streamGenerateContent`）
 *
 * `host` 单独一个字段而不是从 `url` 里解析：probe 的可达性检查要它，
 * 而 url 里带路径，直接拿去连会连错。
 */
export interface HttpSpec {
  dialect: 'openai' | 'anthropic' | 'gemini';
  /** 完整的请求地址（含路径与查询参数） */
  url: string;
  /**
   * 根地址（不含端点路径）。有它时适配器**每次请求按当前模型重拼 URL**，
   * `url` 退化成「默认模型那一条」的展示/兜底值。
   *
   * 为什么需要：Gemini 的模型名在路径里（`/models/<id>:generateContent`），
   * 用户在模型下拉里换一个模型，就换了一个端点。只存创建时拼好的 `url`
   * 会让 50 个模型全部打到第一个模型上 —— 而且报错是上游「模型不存在」，
   * 从表象看不出是本地拼错了。
   *
   * 内置条目（豆包 / Kimi / Gemini）地址是固定的，不填这个字段，行为不变。
   */
  baseUrl?: string;
  /** 用于可达性探测的主机（可带端口，默认 443） */
  host: string;
  /** 未指定模型时的默认模型 */
  defaultModel?: string;
  /** 采样温度。不传就用服务端默认 */
  temperature?: number;
  /** Anthropic 的 max_tokens（必填项，该方言没有默认值） */
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * 厂商 Agent SDK 的接入规格（A76）。
 *
 * ## 为什么它不是一个新的 `kind`
 *
 * `kind` 回答的是「用哪个适配器」。但 Qoder SDK 的 `ProcessTransport` 做的
 * 事恰恰是**在本机拉起 `qodercli` 子进程**再走 JSONL 双向协议 —— 底层和
 * `CliAdapter` 是同一个可执行文件，只是协议从「读 stdout」变成「双向说话」。
 *
 * 所以它是同一 kind 上的**通道升级**（SDK 优先、失败回退 CLI），不是第二套
 * 接入方式。`createProvider` 里对它的分叉写在 kind 判断**之前**，见
 * `adapters/index.ts` 的说明。
 *
 * 另有一条硬理由：前端 `App.tsx` 用 `kind === 'sdk'` 判「回退到平台模型列表」。
 * 把 qoder 改成 `sdk` 会让它在清单拿不到时显示 CodeBuddy 的模型名 ——
 * 那些名字 qodercli 一个都不认，选中就是一次必失败的调用。
 */
export interface SdkSpec {
  /**
   * 哪个产品系列。
   *
   * 决定包名 / CLI 名 / PAT 环境变量名三处差异（两份 README 逐节同构，
   * 各 685 行，2026-10-22 核对），由 `adapters/qoder-sdk.ts` 的
   * `QODER_FLAVORS` 展开。**必须是独立条目**：Qoder 与 Qoder CN 的账号 /
   * Credits / 模型 / 部署全独立，一个子进程只能持一份凭据。
   */
  flavor: 'qoder-intl' | 'qoder-cn';
}

/** 一个 Agent 的完整定义 */
export interface AgentDefinition {
  descriptor: AgentDescriptor;
  /** kind === 'cli' 时必填 */
  cli?: CliSpec;
  /** 有它就走 SDK 通道（优先），握手失败回退上面的 cli */
  sdk?: SdkSpec;
  /** kind === 'http' 时必填 */
  http?: HttpSpec;
  /** 已知的不可用原因（用于 GUI-only 之类） */
  unsupportedReason?: string;
  /**
   * 凭据检查：环境变量名。命中任一即认为已配置。
   * 用于在名册页直接显示「未登录」而不是等第一次调用才报错。
   */
  authEnvs?: string[];
  /** 凭据检查：相对 home 目录的凭据文件路径 */
  authFiles?: string[];
  /**
   * 额外搜索目录（支持 `%LOCALAPPDATA%` 这类模板）。
   * 用于装在 PATH 之外的工具，例如 Hermes 的 bin 目录。
   */
  extraPaths?: string[];
  /**
   * 引擎文件的候选路径（A105，支持 `%VAR%` / `~` 模板）。
   *
   * 与 `extraPaths` 的分工：`extraPaths` 是**目录**，靠命令名去匹配；
   * 这里是**文件**的完整路径，用于「知道引擎在哪、但不在 PATH 里」的 Agent
   * （ZCode 桌面版的引擎就是官方设计成不进 PATH 的）。探测时会把每个候选
   * 的所在目录并入搜索路径，再由 `bin` + `binExts` 命中。
   *
   * 路径里的 `{root}` 是占位符，会被 `shortcutNames` 反推出来的安装根替换
   * （安装目录由用户自选，写死任何盘符都会漏）。
   */
  engineCandidates?: string[];
  /**
   * 桌面快捷方式名（A105，Windows）。
   *
   * 安装目录由用户在安装时自选，没有任何环境变量记录它；而开始菜单 / 桌面
   * 的快捷方式一定指向真实路径。探测时解析它反推安装根，再拼上
   * `engineCandidates` 的相对部分 —— 不写死任何盘符。
   */
  shortcutNames?: string[];
  /**
   * 运行时必须能访问到的后端主机（不含协议，可带端口，默认 443）。
   *
   * 判定规则：**全部**主机都不可达时，才把该 Agent 标为 `unreachable`。
   * 之所以取「全不可达」而非「任一不可达」，是为了不产生误报 ——
   * 只要有一条路通，就说明网络层没被整体切断，不该替 Agent 下结论。
   *
   * 探测走的是与 CLI 子进程完全相同的链路（有代理就走代理），
   * 否则会出现「探测说通、真调用不通」的偏差。
   */
  backendHosts?: string[];
  /**
   * 该 Agent 可选的模型列表（CLI 类 Agent 用）。
   *
   * 为什么必须在定义表里显式声明：模型名是**各 Agent 私有的命名空间**。
   * opencode 认 `zai/glm-4.7` 这种 `provider/model` 形式，codex 认 `gpt-5.4`，
   * 而平台的默认模型（如 `claude-sonnet-4`）对它们全都无意义 ——
   * 注入过去只会让调用直接失败。有了这个白名单，后端就能把
   * 「用户选的模型是否属于这个 Agent」判断清楚。
   */
  models?: string[];
  /** 未显式选择模型时使用的模型（通常取 models[0] 中已验证可用的那个） */
  defaultModel?: string;
  /**
   * 模型选择权在谁手上。
   *
   * - `'agent'`（默认）：Agent 自己决定用哪个模型，客户端**不提供**选择器。
   *   这不是偷懒 —— hermes 这类 ACP Agent 虽然会在 `session/new` 里上报
   *   几百个模型，但实测它的 `session/set_model` 对任意 modelId
   *   （包括 `__nonsense_model__`）都返回 ok，既不校验也不生效。
   *   照上报列表做个下拉，就是给用户一个**假控件**：选完毫无变化，
   *   还会把无意义的 model 值写进会话记录，让人误以为切换成功过。
   * - `'client'`：确认过客户端调用 `session/set_model` 真能生效后才设。
   *   在此之前一律保持 `'agent'`。
   */
  modelSelection?: 'client' | 'agent';
  /**
   * 可在**应用内**填写的凭据规格（A30）。
   *
   * 为什么需要它：`authEnvs` 只认**进程环境变量**。打包成 Electron 之后，
   * 用户双击图标启动，进程环境里不会有 ARK_API_KEY / GEMINI_API_KEY ——
   * 于是名册上「豆包 / Gemini 未登录」成了一个用户**无法自己解开**的死结：
   * 界面上没有任何地方能填，只能去改系统环境变量再重启。
   *
   * 这里声明「这个 Agent 用哪个变量名收 Key」，设置页据此渲染输入框，
   * 保存后写进 `data/agent-credentials.json` 并注入 process.env ——
   * 探测与调用读的都是同一处，行为与「用户自己 export 过」完全一致。
   *
   * ⚠️ 只给**真正认这个变量**的 Agent 声明。不认的（如 codex 走 chatgpt
   * 登录态）声明了只会让用户填了个没用的 Key，然后仍显示未登录。
   */
  credential?: {
    /** 变量名候选（按优先级；第一个用于写入） */
    keyEnv: string[];
    /**
     * 可选的接入地址变量（部分 CLI/服务支持自定义网关）。
     * 例如 gemini CLI 读 `GOOGLE_GEMINI_BASE_URL`。
     */
    baseUrlEnv?: string;
    /** 填 Key 的指引（从哪申请） */
    hint?: string;
  };
  /**
   * 后端可达性检查可被某个环境变量覆盖（A30）。
   *
   * 场景：gemini 官方端点在本机被网络层阻断，但用户可以把它指向一个
   * 可达的 Gemini 兼容网关。此时**必须按网关的地址**判可达性，
   * 否则用户填了网关、状态还写着「不可达」，等于白填。
   */
  backendHostOverrideEnv?: string;
}

/**
 * 权限模式 → gemini 的 approval-mode。
 *
 * 四个取值全部来自 `gemini --help`（0.63.0 实测）：
 *   default   = prompt for approval（逐次询问审批）
 *   auto_edit = auto-approve edit tools
 *   yolo      = auto-approve all tools
 *   plan      = read-only mode（只读）
 *
 * ⚠️ 历史 bug：`default` 曾被映射成 `plan`（只读），理由是「-p 非交互模式下
 * 无法应答审批提示」。那是把两件事混为一谈 —— `plan` 在 gemini 里是**只读模式**，
 * 不是「询问失败时的降级」。结果是「工作场景（default）+ gemini」被静默降级成
 * 只读，用户以为让它改文件是产品 bug。现在按 gemini 自己的语义忠实映射：
 * default 就是 default；非交互子进程里询问不了时由 gemini 自己 fail-closed
 * （需要审批的不放行），那是 CLI 的行为，不是我们替它改的语义。
 */
function geminiApproval(mode: PermissionMode | undefined): string {
  switch (mode) {
    case 'acceptEdits':
      return 'auto_edit';
    case 'bypassPermissions':
      return 'yolo';
    case 'plan':
      return 'plan'; // 只读
    case 'default':
    default:
      return 'default'; // gemini 自己的默认：需要审批的工具逐次询问
  }
}

/**
 * 权限模式 → qodercli 的 `--permission-mode`。
 *
 * 五个取值全部来自 `qodercli --help`（1.1.73 实测）：
 *   default / accept_edits / bypass_permissions / dont_ask / auto。
 *
 * ⚠️ 它**没有只读沙箱**（不像 codex 的 `-s read-only`、gemini 的 `plan`）。
 * `plan` 档退化为 `dont_ask`：不发起审批询问、需要授权的工具一律不放行，
 * 结果是「改不了文件」—— 行为上近似只读，但不是沙箱级保证。
 * 因此 `permissions.ts` 的矩阵里 **不把 plan 记为已强制**，UI 会如实提示缺口。
 */
function qoderPermission(mode: PermissionMode | undefined): string {
  switch (mode) {
    case 'acceptEdits':
      return 'accept_edits';
    case 'bypassPermissions':
      return 'bypass_permissions';
    case 'plan':
      return 'dont_ask';
    case 'default':
    default:
      return 'default';
  }
}

/**
 * Qoder CLI 的 argv（国际版与国内版共用一份）。
 *
 * 两个产品系列的 README 逐节同构（各 685 行，2026-10-22 核对），CLI 参数形态
 * 一致 —— 所以只写一份。复制成两份的后果是「哪天修了国际版忘了国内版」，
 * 而那种偏差在 CN 没有账号可测的前提下**永远不会被发现**。
 *
 * 参数形态来自 `qodercli --help`（1.1.73）实测：
 *   -p/--print 非交互输出；--permission-mode 四档；-m/--model 当前会话模型。
 * 注意 `-p` 是**开关**不是「-p 后跟提示词」，提示词是位置参数
 * （Usage: qodercli [options] [command] [query...]），放最后。
 */
function qoderCliArgs(prompt: string, ctx: SendContext): string[] {
  const args = ['-p'];
  args.push('--permission-mode', qoderPermission(ctx.permissionMode));
  if (ctx.model) args.push('-m', ctx.model);
  // 思考强度（A62）：官方 IDE 的模型面板上有「思考强度：低/中/高/最大/超高」，
  // CLI 对应 `--reasoning-effort <level>`。**8 个合法值是从 CLI 的报错原文里
  // 拿到的**，不是猜的：
  //   "Invalid reasoning effort: bogus. Valid values are: auto, none, low,
  //    medium, high, xhigh, max, ultracode."
  if (ctx.reasoningEffort) args.push('--reasoning-effort', ctx.reasoningEffort);
  args.push(prompt);
  return args;
}

/**
 * 权限模式 → claude 的 --permission-mode。
 *
 * 六个取值全部来自 `claude --help`（2.1.291 实测）：
 *   acceptEdits / auto / bypassPermissions / manual / dontAsk / plan。
 *
 * `default` 落 `manual`（逐次询问）—— 与 gemini default 同义：
 * 我们的 default 本来就是「需要审批的工具逐次询问」。非交互子进程里
 * 询问不了时表现为 fail-closed，不是静默换成别的行为。
 */
function claudeApproval(mode: PermissionMode | undefined): string {
  switch (mode) {
    case 'plan':
      return 'plan'; // 只读
    case 'acceptEdits':
      return 'acceptEdits';
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'default':
    default:
      return 'manual';
  }
}

/**
 * 场景类别 → claude 的工具名（喂给 `--allowedTools`）。
 *
 * 工具名逐个在 `claude.exe` 里 grep 到才算数（`grep -a -o '"Read"'` 等），
 * 不是凭印象编的 —— 编一个不存在的名字不会报错，只会让那条规则永远不命中。
 * 分类口径与 `server/agents/toolPolicy.ts` 的 TOOL_CATEGORY 一致
 * （Glob/Grep 归 file：都是本机文件操作）。
 *
 * `tools` 不在表里：它的语义是「不限制」，与 SDK 的 `includes('tools') → 放行`
 * 一致，见 claudeAllowedTools()。
 */
const CLAUDE_TOOL_NAMES: Record<Exclude<ScenarioTool, 'tools' | 'image'>, string[]> = {
  file: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'],
  shell: ['Bash'],
  search: ['WebSearch', 'WebFetch'],
};

/**
 * 场景白名单 → claude `--allowedTools` 名单；null 表示不限制。
 *
 * 两类边界（写进矩阵 limitation，不隐瞒）：
 *   - `['tools']` → null：语义本就是「全部放行」
 *   - 解析结果为空（`[]` 或仅 `['image']`）→ null：argv 无法表达
 *     「一个工具都不许」，那种场景的保证由 permissionMode=plan（只读）兜底
 */
function claudeAllowedTools(tools: readonly ScenarioTool[] | undefined): string[] | null {
  if (!tools || tools.includes('tools')) return null;
  const names = new Set<string>();
  for (const t of tools) {
    for (const n of CLAUDE_TOOL_NAMES[t as Exclude<ScenarioTool, 'tools' | 'image'>] ?? []) {
      names.add(n);
    }
  }
  return names.size > 0 ? [...names] : null;
}

// ============= A65：pi / Antigravity CLI / Kimi Code CLI 的行映射 =============

/**
 * pi（`@earendil-works/pi-coding-agent`）的 `--mode json` 事件流。
 *
 * 依据：包内官方文档 `docs/json.md`（Event Types / Output Format 逐字给出）
 * + `pi-ai` 的 `AssistantMessageEvent` 类型声明（`thinking_delta` / `text_delta`）。
 * 本机 0.82.1 实跑确认了「首行是 session 头」与「stdin 被 ignore 时才会退出」
 * 这两点（见下面 buildArgs 的注释）。
 *
 * 行形状（真实）：
 *   {"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"..."}
 *   {"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hi"}}
 *   {"type":"tool_execution_start","toolCallId":"...","toolName":"bash","args":{...}}
 *   {"type":"tool_execution_end","toolCallId":"...","toolName":"bash","result":{...},"isError":false}
 *   {"type":"message_end","message":{"role":"assistant","usage":{...},"stopReason":"stop"}}
 */
function mapPiLine(obj: unknown): AgentEvent | AgentEvent[] | null {
  const o = obj as any;
  if (!o || typeof o !== 'object') return null;

  switch (o.type) {
    case 'message_update': {
      const e = o.assistantMessageEvent ?? {};
      if (typeof e.delta !== 'string' || !e.delta) return null;
      if (e.type === 'text_delta') return { type: 'text', content: e.delta };
      if (e.type === 'thinking_delta') return { type: 'thinking', content: e.delta };
      // toolcall_delta 是「参数还在拼」的半截 JSON，渲染出来只会是噪声；
      // 完整的工具调用由 tool_execution_start 给，这里丢掉。
      return null;
    }
    case 'tool_execution_start':
      return {
        type: 'tool',
        id: String(o.toolCallId ?? ''),
        name: String(o.toolName ?? 'tool'),
        input: o.args,
      };
    case 'tool_execution_end':
      return {
        type: 'tool_result',
        toolId: String(o.toolCallId ?? ''),
        content:
          typeof o.result === 'string' ? o.result : JSON.stringify(o.result ?? ''),
        isError: !!o.isError,
      };
    case 'message_end': {
      // 只认 assistant 的用量；user / toolResult 消息没有计费意义
      const m = o.message ?? {};
      if (m.role !== 'assistant') return null;
      // ⚠️ pi 把**请求级失败**塞在 assistant 消息里，而不是 stderr、也不改退出码：
      //    {"role":"assistant","stopReason":"error","errorMessage":"402: ..."}
      //    实测（0.82.1，DeepSeek 余额不足）进程 exit 0、stderr 全空 ——
      //    不认这个字段，用户只会看到「没有产生任何输出」这种无信息量的兜底文案。
      if (m.stopReason === 'error' || m.stopReason === 'aborted') {
        return {
          type: 'error',
          message: String(m.errorMessage ?? 'Pi 本轮以错误状态结束'),
        };
      }
      const u = m.usage ?? {};
      const tokens = Number(u.input ?? 0) + Number(u.output ?? 0);
      const cost = typeof u.cost?.total === 'number' ? u.cost.total : undefined;
      // 全零的用量等于「没有数据」—— 发出去会让气泡上出现 $0 / 0 tokens（假数据）
      if (tokens <= 0 && !(typeof cost === 'number' && cost > 0)) return null;
      return { type: 'usage', tokens: tokens > 0 ? tokens : undefined, cost };
    }
    default:
      // agent_start / turn_start / turn_end / queue_update / compaction_* 等
      // 生命周期事件不产生可渲染内容
      return null;
  }
}

/**
 * Antigravity CLI（`agy`）的 `--output-format stream-json` 事件流。
 *
 * 依据：官方 headless 文档（antigravity.google/docs/cli/headless）逐字给出的
 * 三类事件与字段；本机 1.1.20 实测 `agy --help` 的 flag 集合与之一致。
 *
 * 行形状（真实）：
 *   {"event":"init","conversation_id":"...","init":{"cwd":"...","tools":[...],"permission_mode":"request-review"}}
 *   {"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"...","usage":{...}}}
 *   {"event":"step_update","step_update":{"step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{...},"output":"..."}}}
 *   {"event":"result","result":{"status":"SUCCESS","response":"...","usage":{"total_tokens":11007}}}
 *
 * ⚠️ 两个必须记住的细节：
 *   1. 文本是 `text_delta` **增量**，ACTIVE 与 DONE 都会带（短回复只有 DONE 那一条）；
 *      所以要无条件拼接，不能只认某一种 state。
 *   2. `result.response` 是**整轮全文**。若已经拼过 delta 再发它，正文会重复一遍 ——
 *      因此只在「一个 delta 都没收到」时才用它兜底（有状态映射器负责判断）。
 */
function createAgyMapper(): (obj: unknown) => AgentEvent | AgentEvent[] | null {
  let sawText = false;
  return obj => {
    const o = obj as any;
    if (!o || typeof o !== 'object') return null;

    if (o.event === 'step_update') {
      const s = o.step_update ?? {};
      const events: AgentEvent[] = [];

      if (typeof s.text_delta === 'string' && s.text_delta) {
        sawText = true;
        events.push({ type: 'text', content: s.text_delta });
      }

      // 工具步骤在 DONE 时一次性给全（参数 + 输出），拆成「调用 + 结果」两个事件
      if (s.step_type === 'tool' && s.state === 'DONE') {
        const info = s.tool_info ?? {};
        const id = `agy-step-${String(s.step_index ?? '')}`;
        const failed = !!info.error;
        events.push({
          type: 'tool',
          id,
          name: String(info.name ?? s.tool_name ?? 'tool'),
          input: info.parameters,
        });
        events.push({
          type: 'tool_result',
          toolId: id,
          content: failed
            ? String(info.error?.message ?? info.error?.type ?? '工具执行失败')
            : typeof info.output === 'string'
              ? info.output
              : JSON.stringify(info.output ?? ''),
          isError: failed,
        });
      }

      return events.length ? events : null;
    }

    if (o.event === 'result') {
      const r = o.result ?? {};
      if (typeof r.status === 'string' && r.status !== 'SUCCESS') {
        return {
          type: 'error',
          message: String(r.error ?? `Antigravity 本轮状态 ${r.status}`),
        };
      }
      const events: AgentEvent[] = [];
      if (!sawText && typeof r.response === 'string' && r.response) {
        events.push({ type: 'text', content: r.response });
      }
      const tokens = Number(r.usage?.total_tokens ?? 0);
      if (tokens > 0) events.push({ type: 'usage', tokens });
      return events.length ? events : null;
    }

    // init 只用于取 conversation_id（见 extractResumeToken），不产生内容
    return null;
  };
}

/**
 * Kimi Code CLI（`kimi -p --output-format stream-json`）的行映射。
 *
 * 依据分两半，必须分清（不能把文档当成实测）：
 *   - **实测**：本机 2.3.0 跑 `kimi -p "..." --output-format stream-json`，
 *     首行就是 `{"role":"meta","type":"system.version","version":"2.3.0"}`；
 *     未登录时 stdout 只有这一行、stderr 报
 *     `No model configured. Run \`kimi\` and use /login to sign in`、退出码 1。
 *   - **文档**：官方 reference 只说「普通回复输出 Assistant 消息；调工具时先输出带
 *     `tool_calls` 的 Assistant 消息，再输出对应的 Tool 消息」，**没给字段级 schema**。
 *     社区实录（旧版 kimi-cli）的形状是 OpenAI 风格：
 *     `{"role":"assistant","content":"...","tool_calls":[{"id":"tc_1","function":{"name":"Shell","arguments":"{...}"}}]}`
 *     `{"role":"tool","tool_call_id":"tc_1","content":"..."}`
 *   所以这里按「role 优先、字段多路兜底」写：认不出就返回 null（静默跳过），
 *   绝不把整行当正文喷到气泡里。**拿到一次真实登录后的完整流之后应回来收紧。**
 */
function mapKimiLine(obj: unknown): AgentEvent | AgentEvent[] | null {
  const o = obj as any;
  if (!o || typeof o !== 'object') return null;

  const role = typeof o.role === 'string' ? o.role : typeof o.type === 'string' ? o.type : '';

  // meta：system.version / 会话开始之类，只用于取 session id
  if (role === 'meta' || role === 'system') return null;

  if (role === 'assistant') {
    const events: AgentEvent[] = [];
    if (typeof o.content === 'string' && o.content) {
      events.push({ type: 'text', content: o.content });
    }
    const calls = o.tool_calls ?? o.toolCalls;
    if (Array.isArray(calls)) {
      for (const c of calls) {
        const fn = c?.function ?? {};
        let input: unknown = fn.arguments ?? c?.arguments;
        // arguments 是 JSON 字符串（OpenAI 方言）；解析失败就原样给，便于排查
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            /* 保留字符串 */
          }
        }
        events.push({
          type: 'tool',
          id: String(c?.id ?? ''),
          name: String(fn.name ?? c?.name ?? 'tool'),
          input,
        });
      }
    }
    return events.length ? events : null;
  }

  if (role === 'tool') {
    const content = o.content;
    return {
      type: 'tool_result',
      toolId: String(o.tool_call_id ?? o.toolCallId ?? ''),
      content:
        typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      isError: !!o.is_error || o.status === 'error',
    };
  }

  return null;
}

/** pi 的 `--thinking` 取值（`pi --help` 实测：off,minimal,low,medium,high,xhigh,max） */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** agy 的 `--effort` 取值（官方 headless 文档：low|medium|high，只有三档） */
const AGY_EFFORT_LEVELS = ['low', 'medium', 'high'];

// ============= 定义表 =============

/**
 * Codex 系（`codex exec --json`）的 JSONL 行映射。
 *
 * 抽成独立函数是为了给 Trae 复用（A74）：traecli 的命令面与 codex 同构
 * （exec / --json / --sandbox / --ask-for-approval / -c key=value / resume / apply），
 * 事件结构按同族处理。`errorLabel` 只影响报错文案里的产品名。
 */
function createCodexLineageMapper(errorLabel: string): (obj: unknown) => AgentEvent | AgentEvent[] | null {
  const textSent = new Map<string, number>();
  const outSent = new Map<string, number>();
  let auto = 0;

  const deltaOf = (sent: Map<string, number>, id: string, full: string): string => {
    const prev = sent.get(id) ?? 0;
    if (full.length <= prev) return '';
    sent.set(id, full.length);
    return full.slice(prev);
  };

  return (obj) => {
    const o = obj as any;
    if (!o || typeof o !== 'object') return null;

    if (o.type === 'error') {
      return { type: 'error', message: String(o.message ?? `${errorLabel} 错误`) };
    }
    if (o.type === 'turn.failed') {
      return { type: 'error', message: String(o.error?.message ?? `${errorLabel} 执行失败`) };
    }
    if (o.type === 'turn.completed') {
      const u = o.usage ?? {};
      const tokens =
        Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0);
      return tokens > 0 ? { type: 'usage', tokens } : null;
    }
    if (
      o.type !== 'item.started' &&
      o.type !== 'item.updated' &&
      o.type !== 'item.completed'
    ) {
      return null;
    }

    const item = o.item ?? {};
    const id = String(item.id ?? `${item.type ?? 'item'}-${auto++}`);
    const done = o.type === 'item.completed';
    const started = o.type === 'item.started';

    switch (item.type) {
      case 'agent_message': {
        const d = deltaOf(textSent, id, String(item.text ?? ''));
        return d ? { type: 'text', content: d } : null;
      }
      case 'reasoning': {
        const d = deltaOf(textSent, id, String(item.text ?? item.summary ?? ''));
        // codex 只给 reasoning summary，从不给原始思维链 —— 描述符里写的就是
        // `thinking_summary`。这里如实标注，UI 才会换文案，而不是把摘要
        // 冒充成「完整推理过程」。
        return d ? { type: 'thinking', content: d, format: 'summary' } : null;
      }
      case 'command_execution': {
        if (started) {
          return {
            type: 'tool',
            id,
            name: 'Bash',
            input: { command: String(item.command ?? '') },
          };
        }
        const out = String(item.aggregated_output ?? '');
        if (!done) {
          const d = deltaOf(outSent, id, out);
          return d ? { type: 'tool_output', toolId: id, content: d } : null;
        }
        return {
          type: 'tool_result',
          toolId: id,
          content: out,
          isError: Number(item.exit_code ?? 0) !== 0,
        };
      }
      case 'file_change': {
        if (started) {
          return { type: 'tool', id, name: 'Edit', input: { changes: item.changes } };
        }
        if (!done) return null;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const summary = changes
          .map((c: any) => `${c.kind ?? 'update'} ${c.path ?? ''}`)
          .join('\n');
        const events: AgentEvent[] = [{
          type: 'tool_result',
          toolId: id,
          content: summary || '文件已修改',
          isError: item.status === 'failed',
        }];
        if (item.status !== 'failed') {
          const safeChanges = changes
            .filter((c: any) => c && typeof c.path === 'string')
            .map((c: any) => ({ path: c.path, kind: String(c.kind ?? 'update') }));
          if (safeChanges.length > 0) {
            events.push({
              type: 'artifact',
              id: `codex-changes-${id}`,
              name: `文件变更（${safeChanges.length}）`,
              mediaType: 'application/vnd.opc.file-changes+json',
              data: safeChanges,
              description: 'Agent 原生 file_change 事件中的变更清单',
            });
          }
        }
        return events;
      }
      case 'mcp_tool_call': {
        const name = String(item.tool ?? item.name ?? 'MCP');
        if (started) {
          return { type: 'tool', id, name, input: item.arguments };
        }
        if (!done) return null;
        const content =
          typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '');
        return {
          type: 'tool_result',
          toolId: id,
          content,
          isError: item.status === 'failed',
        };
      }
      case 'web_search': {
        if (started) {
          return {
            type: 'tool',
            id,
            name: 'WebSearch',
            input: { query: String(item.query ?? '') },
          };
        }
        if (!done) return null;
        return {
          type: 'tool_result',
          toolId: id,
          content: String(item.query ?? '搜索完成'),
        };
      }
      default:
        return null;
    }
  };
}

const RAW_DEFS: AgentDefinition[] = [
  // ---------- 首批就绪 ----------
  {
    descriptor: {
      id: 'workbuddy',
      name: 'WorkBuddy',
      vendor: 'Tencent',
      kind: 'sdk',
      // 依据：`~/.workbuddy/cache/acc-product-config-v3.json`
      //   productName="WorkBuddy" / endpoint=https://www.workbuddy.cn /
      //   networkEnvironment="internal" / dataFolderName=".workbuddy"。
      // 国际版是**另一个产品**（productName="WorkBuddy AI"、endpoint=www.workbuddy.ai、
      // dataFolderName=".workbuddy-ai"、networkEnvironment="external"），账号体系也不同
      // （腾讯云国际站，支持 Google/GitHub/X 直登）→ 将来若接入，必须是独立条目（R1）。
      family: 'tencent-workbuddy',
      familyName: 'WorkBuddy',
      surface: 'sdk',
      region: 'cn',
      regionName: '国内版',
      authScope: 'tencent-cloud-cn',
      authScopeName: '腾讯云账号',
      capabilities: ['chat', 'code', 'write', 'tools', 'search', 'image'],
      eventCapabilities: ['thinking', 'tool', 'usage', 'cost', 'permission'],
      description: '全能型主控 Agent，可读写文件、执行命令、联网检索，适合担任群聊的调度中枢',
      icon: 'workbuddy',
      color: '#0EC8A9',
      installHint: '通过 CodeBuddy CLI 登录，或在设置页填入 API Key',
    },
  },
  {
    descriptor: {
      id: 'codex',
      name: 'Codex',
      vendor: 'OpenAI',
      kind: 'cli',
      // OpenAI 只有一套全球产品，没有「国内版」；region 记 intl 表示「面向海外市场，
      // 国内网络不可直连」（本机实测后端 chatgpt.com 被代理 502）。
      family: 'openai-codex',
      familyName: 'Codex',
      surface: 'cli',
      region: 'intl',
      regionName: '国际站',
      authScope: 'openai',
      authScopeName: 'OpenAI 账号',
      capabilities: ['chat', 'code', 'tools'],
      // codex 的 reasoning 只有摘要，没有原始思维链 —— 必须如实标注，
      // 否则 UI 会把它当「完整思考过程」展示
      eventCapabilities: ['thinking_summary', 'tool', 'tool_output', 'usage'],
      description: 'OpenAI 官方编码 Agent，擅长代码生成、重构与仓库级修改',
      icon: 'codex',
      color: '#1F1F1F',
      command: 'codex',
      installHint: 'npm i -g @openai/codex，然后 codex login',
    },
    cli: {
      bin: 'codex',
      // 模型清单：`codex debug models`（help 原文 "Render the raw model catalog as JSON"）。
      // 它藏在 debug 子命令下，`codex --help` 里看不到 —— 由
      // `modelCatalog.ts` 的 CATALOG_SOURCES 接进模型菜单（A58）。
      buildArgs: (prompt, ctx) => {
        // A106：会话续接走官方子命令 `codex exec resume <SESSION_ID> <PROMPT>`
        // （`codex exec resume --help` 本机实测：位置参数 SESSION_ID 在前、
        // PROMPT 在后，选项在前）。续接时**不能**传 `-s/--sandbox` ——
        // resume 子命令的选项表里没有它（只有 -c/-m/--json/--skip-git-repo-check
        // 等），续接的会话沿用第一次创建时的沙箱配置。于是「同一会话中途
        // 切场景」在 codex 上改不了沙箱强度，这一点不假装支持
        // （permissions.ts 的 limitation 里已有 plan 强制的边界说明）。
        if (ctx.resumeToken) {
          const resumeArgs = ['exec', 'resume', '--skip-git-repo-check', '--json'];
          if (ctx.model) resumeArgs.push('-m', ctx.model);
          if (ctx.reasoningEffort) {
            resumeArgs.push('-c', `model_reasoning_effort=${ctx.reasoningEffort}`);
          }
          resumeArgs.push(ctx.resumeToken, prompt);
          return resumeArgs;
        }
        // `--json`：输出 JSONL 事件流（thread/turn/item）。不加就退化成纯文本，
        // 工具与思考永远进不了 UI —— 这是 codex 之前「只有一坨文字」的根因。
        const args = ['exec', '--skip-git-repo-check', '--json'];
        if (ctx.model) args.push('-m', ctx.model);
        // P4-5：权限模式必须落到 codex 的沙箱策略上。
        // 之前这里完全忽略 permissionMode —— 于是「问答」场景（plan = 只读）配 codex 时，
        // codex 仍以默认沙箱运行、照样能改文件，「只读」是个空承诺。
        // `-s/--sandbox` 的三个取值由 `codex exec --help` 实测确认。
        const sandbox = codexSandboxFor(ctx.permissionMode);
        if (sandbox) args.push('-s', sandbox);
        // 推理强度：codex 不认 `--reasoning-effort` 这类专用参数，它统一走
        // `-c <key>=<value>` 覆盖 config.toml 的任意键。这个键名来自本机
        // `~/.codex/config.toml` 第 2 行 `model_reasoning_effort = "low"`
        // —— 是用户自己配置里就有的官方字段，不是我们发明的。
        if (ctx.reasoningEffort) {
          args.push('-c', `model_reasoning_effort=${ctx.reasoningEffort}`);
        }
        args.push(prompt);
        return args;
      },
      parse: 'jsonl',
      extractResumeToken: (obj) => {
        const o = obj as { type?: string; thread_id?: unknown };
        return o.type === 'thread.started' && typeof o.thread_id === 'string' ? o.thread_id : null;
      },
      /**
       * 行结构（2026-10-19 本机 `codex exec --json` 实测）：
       *   {"type":"thread.started","thread_id":"..."}
       *   {"type":"turn.started"}
       *   {"type":"item.started|item.updated|item.completed","item":{...}}
       *   {"type":"turn.completed","usage":{...}}
       *   {"type":"error","message":"..."}
       *
       * 注意 item 里的文本是**累积值**而不是增量，所以要用 createMapper
       * 记住每个 item 上次发到第几个字符，否则整段会被重复追加。
       */
      createMapper: () => createCodexLineageMapper('Codex'),
      // 实测：codex 在连不上 chatgpt.com 时会无限重连，必须主动判死
      fatalStderrPattern: /waiting for network/i,
    },
    // 实测：codex 唯一的后端 chatgpt.com 被代理以 502 拒绝（CONNECT tunnel
    // failed），而 0.161.0 又移除了 wire_api="chat"，无法改指向任何
    // OpenAI 兼容端点 —— 于是凭据有效却一次都调不通，必须如实上报。
    backendHosts: ['chatgpt.com', 'api.openai.com'],
    // 本机实测：~/.codex/auth.json 内含 auth_mode / tokens / last_refresh
    authEnvs: ['OPENAI_API_KEY'],
    authFiles: ['.codex/auth.json'],
  },
  {
    descriptor: {
      id: 'gemini',
      name: 'Gemini',
      vendor: 'Google',
      kind: 'cli',
      // 与 antigravity **同族同账号**（都是 Google 账号），差别是代际不是区域：
      // Google 官方在 Gemini CLI 文档里直接写「未针对最新模型优化，建议用 Antigravity CLI」。
      // 同族不等于同一形态：两条都是 CLI，所以是两个条目而不是一个。
      family: 'google',
      familyName: 'Google',
      surface: 'cli',
      region: 'intl',
      regionName: '国际站',
      authScope: 'google',
      authScopeName: 'Google 账号',
      capabilities: ['chat', 'code', 'write', 'search'],
      eventCapabilities: ['tool', 'usage'],
      description: 'Google 官方 CLI Agent，上下文窗口大，适合长文档分析与方案评审',
      icon: 'gemini',
      color: '#3C3489',
      command: 'gemini',
      installHint: 'npm i -g @google/gemini-cli，并设置 GEMINI_API_KEY',
    },
    cli: {
      bin: 'gemini',
      buildArgs: (prompt, ctx) => {
        // `-o stream-json`：JSONL 事件流（init / message / tool_use / tool_result / result）。
        // gemini 的 choices 是 text | json | stream-json，只有最后一个能给出过程事件。
        const args = [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
          '--approval-mode',
          geminiApproval(ctx.permissionMode),
        ];
        if (ctx.model) args.push('-m', ctx.model);
        return args;
      },
      // A106：gemini **不接** resume，理由是本机 `gemini --help` 实测：
      // `-r, --resume` 只认 "latest" 或 `--list-sessions` 打出来的**序号**，
      // 不认 init 事件里的 session_id UUID。硬传 UUID 只会失败；要映射得
      // 先跑一次 --list-sessions 按项目反查序号，脆弱且 gemini 本机网络
      // 阻塞无法实测。宁可每轮新开会话，也不接一条跑不通的续接。
      parse: 'jsonl',
      extractResumeToken: (obj) => {
        const o = obj as { type?: string; session_id?: unknown };
        return o.type === 'init' && typeof o.session_id === 'string' ? o.session_id : null;
      },
      /**
       * gemini-cli 的 stream-json 行：
       *   {"type":"init","session_id":"...","model":"..."}
       *   {"type":"message","role":"assistant","content":"..."}
       *   {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{...}}
       *   {"type":"tool_result","tool_id":"...","status":"success","output":"..."}
       *   {"type":"result","status":"success","stats":{...}}
       *
       * 字段名做了多重兜底（content/delta、output/result）：这个格式仍在演进，
       * 少一个兜底就会在某个版本上整段静默 —— 那比报错更难查。
       */
      createMapper: () => (obj) => {
        const o = obj as any;
        if (!o || typeof o !== 'object') return null;

        switch (o.type) {
          case 'message': {
            if (o.role === 'user') return null;
            const text = typeof o.content === 'string' ? o.content : o.delta;
            return typeof text === 'string' && text ? { type: 'text', content: text } : null;
          }
          case 'tool_use':
            return {
              type: 'tool',
              id: String(o.tool_id ?? o.id ?? ''),
              name: String(o.tool_name ?? o.name ?? 'tool'),
              input: o.parameters ?? o.input,
            };
          case 'tool_result':
            return {
              type: 'tool_result',
              toolId: String(o.tool_id ?? o.id ?? ''),
              content:
                typeof o.output === 'string'
                  ? o.output
                  : typeof o.result === 'string'
                    ? o.result
                    : JSON.stringify(o.output ?? o.result ?? ''),
              isError: o.status === 'error' || o.status === 'failed',
            };
          case 'error':
            return { type: 'error', message: String(o.message ?? 'Gemini 错误') };
          case 'result': {
            const s = o.stats ?? {};
            const tokens =
              Number(s.total_tokens ?? 0) ||
              Number(s.input_tokens ?? 0) + Number(s.output_tokens ?? 0);
            return tokens > 0 ? { type: 'usage', tokens } : null;
          }
          default:
            return null;
        }
      },
    },
    // 实测：generativelanguage.googleapis.com 同样被代理 502 拒绝
    backendHosts: ['generativelanguage.googleapis.com'],
    // 若用户填了网关地址，可达性按网关判（否则填了也仍报「不可达」）
    backendHostOverrideEnv: 'GOOGLE_GEMINI_BASE_URL',
    // 本机实测：~/.gemini/settings.json 声明了 selectedType=gemini-api-key，
    // 但 GEMINI_API_KEY 未设置、也无 oauth_creds.json → 判定为未登录
    authEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    authFiles: ['.gemini/oauth_creds.json'],
    // A30：可在设置页填 Key（与 CLI 的 `export GEMINI_API_KEY=...` 等价），
    // 并可填 GOOGLE_GEMINI_BASE_URL 指向可达的 Gemini 兼容网关
    credential: {
      keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
      // A105：gemini-cli 有两条登录路 —— API Key，或在终端跑 `gemini` 走
      // Google 账号 OAuth（凭据写 ~/.gemini/oauth_creds.json）。只写 Key
      // 那条，用户会以为「登录过 Google 账号」不算数，从而反复重登。
      hint: 'Google AI Studio 申请 API Key，或在终端运行 gemini 完成 Google 账号 OAuth 登录；若官方端点不可达，可在「接入地址」填兼容网关',
    },
  },
  {
    descriptor: {
      id: 'opencode',
      name: 'OpenCode',
      vendor: 'SST',
      kind: 'cli',
      // 没有自有账号体系：模型全部来自 `zai/*`、`zhipuai/*` 这类 provider 命名空间，
      // 额度算在各家 provider 头上。所以 region 记 any（跟随 provider），
      // 而不是硬塞一个 cn/intl —— 塞了就是编。
      family: 'opencode',
      familyName: 'OpenCode',
      surface: 'cli',
      region: 'any',
      regionName: '跟随模型 provider',
      authScope: 'none',
      authScopeName: '无自有账号',
      capabilities: ['chat', 'code', 'tools'],
      description: '开源终端编码 Agent，支持多模型provider，适合本地仓库内作业',
      eventCapabilities: ['thinking', 'tool', 'usage', 'cost'],
      icon: 'opencode',
      color: '#085041',
      command: 'opencode',
      installHint: 'npm i -g opencode-ai，并配置至少一个 provider 的 API Key',
    },
    cli: {
      bin: 'opencode',
      buildArgs: (prompt, ctx) => {
        // `--format json`：NDJSON 事件流（text / reasoning / tool_use / step_finish）。
        // 实测（2026-10-19）：工具事件在**完成时**一次性给出，
        // part.state 里带 input / output / status，所以一行要拆成「工具 + 结果」两个事件。
        //
        // A106：`--session, -s <id>` 续接（`opencode run --help` 实测：
        // "Session ID to continue, or to create if it does not exist"）。
        // extractResumeToken 从任意行取 sessionID，与 --session 同一个 ID
        // 空间（opencode 的 JSON 流每行都带会话的 sessionID）。
        //
        // `--thinking`：**必须显式加**，否则一条 reasoning 事件都不会发。
        // 它是默认关的开关（`opencode run --help`：`--thinking  Show thinking
        // blocks`），没有传的话映射器里那条 `case 'reasoning'` 永远收不到
        // 事件 —— 这正是「descriptor 声明了 eventCapabilities: ['thinking']、
        // 前端却有思考面板」的根因：清单在撒谎。
        // 它是纯布尔开关，不带取值；`opencode` 没有 reasoning-effort 参数，
        // 所以 `ctx.reasoningEffort` 在这里没有落点。若某个模型本身不支持
        // 思考，CLI 不会报错，只是不发事件 —— 前端据此什么都不渲染。
        const args = ['run', '--format', 'json', '--thinking'];
        if (ctx.resumeToken) args.push('--session', ctx.resumeToken);
        if (ctx.model) args.push('-m', ctx.model);
        args.push(prompt);
        return args;
      },
      parse: 'jsonl',
      extractResumeToken: (obj) => {
        const o = obj as { sessionID?: unknown };
        return typeof o.sessionID === 'string' ? o.sessionID : null;
      },
      createMapper: () => (obj) => {
        const o = obj as any;
        if (!o || typeof o !== 'object') return null;

        switch (o.type) {
          case 'text': {
            const t = o.part?.text;
            return typeof t === 'string' && t ? { type: 'text', content: t } : null;
          }
          case 'reasoning': {
            const t = o.part?.text ?? o.part?.reasoning;
            return typeof t === 'string' && t ? { type: 'thinking', content: t } : null;
          }
          case 'tool_use': {
            const p = o.part ?? {};
            const state = p.state ?? {};
            const id = String(p.id ?? p.callID ?? '');
            const events: AgentEvent[] = [
              {
                type: 'tool',
                id,
                name: String(p.tool ?? 'tool'),
                input: state.input,
              },
            ];
            if (state.status === 'completed' || state.status === 'error') {
              events.push({
                type: 'tool_result',
                toolId: id,
                content: String(state.output ?? ''),
                isError: state.status === 'error',
              });
            }
            return events;
          }
          case 'step_finish': {
            // 每一步都会报一次用量，但整轮没结束 —— 交给 CLI 适配器攒着，
            // 由最终的 done 一并带上（不能在这里发 done，否则一轮会被切成多轮）
            const p = o.part ?? {};
            const tk = p.tokens ?? {};
            const tokens =
              Number(tk.input ?? 0) + Number(tk.output ?? 0) + Number(tk.reasoning ?? 0);
            const cost = typeof p.cost === 'number' ? p.cost : undefined;
            return tokens > 0 || cost != null
              ? { type: 'usage', tokens: tokens || undefined, cost }
              : null;
          }
          case 'error':
            return {
              type: 'error',
              message: String(o.error?.message ?? o.message ?? 'OpenCode 错误'),
            };
          default:
            return null;
        }
      },
    },
    // 本机实测：~/.local/share/opencode 下只有 opencode.db，无 auth.json。
    //
    // 但它并不需要 auth.json —— `opencode auth list` 显示它直接从**环境变量**
    // 读取各 provider 的凭据（DeepSeek / GitHub Copilot / Z.AI / Zhipu /
    // SenseNova 均已就绪）。只认 OPENCODE_API_KEY 会造成「明明能用却报未登录」
    // 的假阴性，所以这里列全它实际会消费的变量名。
    authEnvs: [
      'OPENCODE_API_KEY',
      'DEEPSEEK_API_KEY',
      'ZHIPU_API_KEY',
      'GLM_API_KEY',
      'GITHUB_TOKEN',
      'COPILOT_GITHUB_TOKEN',
      'SENSENOVA_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'DASHSCOPE_API_KEY',
      'KIMI_API_KEY',
      'MOONSHOT_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
    ],
    authFiles: ['.local/share/opencode/auth.json'],
    // 逐个真实调用验证过能返回文本的模型（`opencode run -m <id>`）。
    // 只列验证过的：列一个跑不通的，等于把失败甩给用户。
    models: [
      'zai/glm-4.7',
      'zhipuai/glm-4.7',
      'sensenova/glm-5.2',
      'opencode/deepseek-v4.1-flash-free',
    ],
    defaultModel: 'zai/glm-4.7',
  },

  // ---------- 待接入 ----------
  {
    descriptor: {
      id: 'claude',
      name: 'Claude Code',
      vendor: 'Anthropic',
      kind: 'cli',
      family: 'anthropic-claude',
      familyName: 'Claude Code',
      surface: 'cli',
      region: 'intl',
      regionName: '国际站',
      authScope: 'anthropic',
      authScopeName: 'Anthropic 账号',
      capabilities: ['chat', 'code', 'write', 'tools'],
      description: 'Anthropic 官方编码 Agent，长文本与代码理解见长',
      eventCapabilities: ['thinking', 'tool', 'usage', 'cost'],
      icon: 'claude',
      color: '#993C1D',
      command: 'claude',
      // 原生二进制缺失的问题已于 2026-10-17 修复：
      // 在 claude-code 包目录补装 @anthropic-ai/claude-code-win32-x64（2.1.291）
      // 并重跑 install.cjs，bin/claude.exe 从 500 字节桩变成 253MB 真身。
      // 若日后再遇到同样症状（claude --version 报 native binary not installed），
      // 修复命令：在 node_modules/@anthropic-ai/claude-code 下
      // npm i @anthropic-ai/claude-code-win32-x64@<版本> --no-save && node install.cjs
      installHint: '需要登录：运行 claude 后执行 /login（本机暂无凭据，无法代登录）',
    },
    cli: {
      bin: 'claude',
      buildArgs: (prompt, ctx) => {
        // stream-json 才能拿到 content blocks（thinking / tool_use）；
        // `-p` 模式下 claude 要求 stream-json 必须配 --verbose，缺了直接报错。
        const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
        // A106：双向模式（本条目 bidi: true 时适配器会注入 inputFormat）。
        // stdin 保持打开，权限请求经 control 协议逐次问我们 —— 见
        // adapters/cli.ts 的 control 处理与 adapters/claude-control.ts。
        const bidi = ctx.inputFormat === 'stream-json';
        if (bidi) args.push('--input-format', 'stream-json');
        // 权限模式落到 --permission-mode（claude 2.1.291 --help 实测六个取值，
        // 此前完全没用过这个开关，「只读」在 claude 身上也是空承诺）。
        args.push('--permission-mode', claudeApproval(ctx.permissionMode));
        if (ctx.model) args.push('--model', ctx.model);
        // A106：`-r/--resume <session-id>`（claude --help 实测）。
        // 位置有讲究：必须在 --allowedTools **之前** —— 那是 variadic，
        // 会把后面的参数全当成工具名吃掉。
        if (ctx.resumeToken) args.push('--resume', ctx.resumeToken);
        if (bidi) {
          // 双向模式下**不能再发** --allowedTools：预授权通过的工具不会触发
          // can_use_tool 控制请求，场景白名单与高危门禁就被绕过了
          // （SDK 路径同理，白名单在回调里判，不预授权）。
          return args;
        }
        // 工具白名单落到 --allowedTools（variadic，必须放在最后，
        // 否则会把后面的参数也当成工具名吃掉）。
        const allow = claudeAllowedTools(ctx.allowedTools);
        if (allow) args.push('--allowedTools', ...allow);
        return args;
      },
      parse: 'jsonl',
      mapLine: mapClaudeCodeLine,
      // A106：claude 走双向 control 协议（本机 2.1.291）。
      // stdin/stdout 环路已实测跑通（发用户消息 → init/assistant/result
      // 事件正常回收，只卡未登录）；can_use_tool 的应答形状取自本机
      // claude.exe 内的协议 schema。真实登录态下的端到端仍待补
      // （本机无凭据，见 TASKS A106 的「未实测」清单）。
      bidi: true,
      extractResumeToken: (obj) => {
        const o = obj as { type?: string; subtype?: string; session_id?: unknown };
        return o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string'
          ? o.session_id
          : null;
      },
    },
    authEnvs: ['ANTHROPIC_API_KEY'],
    authFiles: ['.claude/.credentials.json', '.claude.json'],
  },
  {
    descriptor: {
      id: 'hermes',
      name: 'Hermes',
      kind: 'acp',
      // ACP 走 stdio 本地子进程，不联网、也没有厂商账号 —— region 记 any，
      // 不要因为「它在本地」就写 cn，那会让区域角标凭空多一个。
      family: 'hermes',
      familyName: 'Hermes',
      surface: 'acp',
      region: 'any',
      regionName: '本地运行',
      authScope: 'none',
      authScopeName: '无自有账号',
      // 实测：ACP initialize 时注册了 image_gen / web 插件，
      // session/new 返回了 60+ 个可用模型，能力比最初估计的强
      capabilities: ['chat', 'code', 'write', 'tools', 'image', 'search'],
      description: 'Hermes Agent，通过 ACP 协议接入。自带图像生成与联网检索插件，模型选择丰富',
      eventCapabilities: ['thinking', 'tool', 'usage'],
      icon: 'hermes',
      color: '#5F5E5A',
      command: 'hermes-acp',
      installHint: 'Hermes 通过 ACP（stdio JSON-RPC）接入，需 hermes-acp 可执行文件',
    },
    // Hermes 的 bin 目录不在 PATH 中，需要显式加入搜索
    extraPaths: ['%LOCALAPPDATA%\\hermes\\bin'],
    authFiles: ['AppData/Local/hermes/auth.json', '.hermes/auth.json'],
  },
  {
    descriptor: {
      id: 'cursor',
      name: 'Cursor',
      vendor: 'Cursor',
      kind: 'cli',
      // 产品本身是 IDE，我们接的是它的 headless CLI 那一面 —— 所以 surface 记 cli，
      // **不是** ide。这条区分正是 surface 与 kind 分开的理由（见 types.ts 注释）。
      family: 'cursor',
      familyName: 'Cursor',
      surface: 'cli',
      region: 'intl',
      regionName: '国际站',
      authScope: 'cursor',
      authScopeName: 'Cursor 账号',
      capabilities: ['chat', 'code', 'write', 'tools'],
      description: 'Cursor Agent，与 IDE 同模型同工具，支持 plan 只读模式与 worktree 隔离',
      eventCapabilities: ['thinking', 'tool', 'usage'],
      icon: 'cursor',
      color: '#2C2C2A',
      command: 'cursor-agent',
      // 曾经的 unsupportedReason「仅 GUI，无无头调用方式」是**错的**：
      // Cursor 官方提供独立的 cursor-agent CLI（2025-2026），与 IDE 同模型同工具。
      // 本机 2026-10-18 实测确认可用（见下方 cli.buildArgs 的注释）。
      installHint: '安装 Cursor Agent CLI：在 Cursor 官网下载安装器（会落到 %LOCALAPPDATA%\\cursor-agent）',
    },
    cli: {
      // 二进制名不是 `cursor`。`cursor` 是 **IDE 启动器**（--help 全是开窗口 /
      // diff / 加文件夹，没有 agent 模式），真正的 Agent CLI 叫
      // `cursor-agent`（同目录有别名 `agent`），装在 %LOCALAPPDATA%\cursor-agent。
      // PATH 里两者都有，取错就只是个「能打开 IDE 的按钮」。
      bin: 'cursor-agent',
      buildArgs: (prompt, ctx) => {
        // 全部开关来自 2026-10-18 本机 `cursor-agent --help` 实测，
        // 并用一次真实调用验证过 stream-json 的行结构（见 mapLine）。
        const args = ['-p', '--output-format', 'stream-json'];
        // --trust：确认「这个工作目录可以读写」。**不是权限放大** ——
        // 实测不加它，CLI 直接拒绝执行并打印 Workspace Trust Required，
        // 连回复都不给。真正的「不询问就跑」是 -f/--yolo（走 bypassPermissions）。
        // 所以在任何模式下都必须有 trust，否则这个 Agent 等于不可用。
        args.push('--trust');
        // --mode 只有 plan / ask 两个取值，没有 default —— 所以只在 plan 时传。
        // ask 是「问答不落盘」，与我们的 acceptEdits 语义不符，故不映射。
        if (ctx.permissionMode === 'plan') args.push('--mode', 'plan');
        if (ctx.permissionMode === 'bypassPermissions') args.push('-f');
        if (ctx.model) args.push('--model', ctx.model);
        // --workspace 显式给出 cwd：不传时它用进程 cwd，而我们 spawn 的 cwd
        // 已经等于 ctx.cwd，这里重复一次是为了让「会话换了工作目录」也能生效。
        if (ctx.cwd) args.push('--workspace', ctx.cwd);
        // 续接令牌 = 它自己的 session_id（init 行里那个 UUID）
        if (ctx.resumeToken) args.push('--resume', ctx.resumeToken);
        args.push(prompt);
        return args;
      },
      parse: 'jsonl',
      /**
       * 行结构（2026-10-18 实测，逐字抄自真实输出）：
       *   {"type":"system","subtype":"init","apiKeySource":"login","cwd":"...",
       *    "session_id":"8a5090de-...","model":"Auto","permissionMode":"default"}
       *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},
       *    "session_id":"..."}
       *   {"type":"result","subtype":"success","is_error":false,"result":"OK",
       *    "session_id":"...","usage":{"inputTokens":20170,"outputTokens":24}}
       *
       * 事件形状与 stream-json 高度同构，所以按同一形状解析。
       */
      // 与 stream-json 同构：assistant 行给 content blocks（text/thinking/tool_use），
      // user 行给 tool_result。之前只映射了 text，于是工具与思考全丢。
      mapLine: mapClaudeCodeLine,
      extractResumeToken: (obj) => {
        const o = obj as { type?: string; subtype?: string; session_id?: unknown };
        if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') {
          return o.session_id;
        }
        return null;
      },
    },
    // cursor-agent 装在 PATH 之外（%LOCALAPPDATA%\cursor-agent），必须显式加搜索路径
    extraPaths: ['%LOCALAPPDATA%\\cursor-agent'],
    authEnvs: ['CURSOR_API_KEY'],
    // 登录态在 ~/.cursor 下（实测 apiKeySource="login" 时该目录有这两个文件）
    authFiles: ['.cursor/agent-cli-state.json', '.cursor/cli-config.json'],
  },
  {
    descriptor: {
      id: 'qoder',
      name: 'Qoder',
      vendor: 'Alibaba',
      kind: 'cli',
      // 依据：`~/.qoder/.qoder-app-status.json` → product="qoder"、已登录、头像在 qoder.com。
      // 阿里云官方文章：Qoder 与 **Qoder CN** 是两个产品系列，账号 / Credits / 模型 /
      // 部署全独立、不互通（R1）—— 所以 CN 是下面那条独立条目 `qoder-cn`，
      // 绝不合并在这一条里，也绝不能把本条的 id 改名叫 qoder。
      family: 'qoder',
      familyName: 'Qoder',
      surface: 'cli',
      region: 'intl',
      regionName: '国际版',
      authScope: 'qoder.com',
      authScopeName: 'Qoder 账号',
      capabilities: ['chat', 'code', 'write', 'tools'],
      // A76 之后事件粒度变了：SDK 通道能给出 thinking / tool / usage，
      // 文本通道给不出。这里按**能力上限**标（名册用它判断要不要画折叠条），
      // 实际走 CLI 回退时前端收到的事件自然更少，不会画出空卡片。
      eventCapabilities: ['thinking', 'tool', 'usage'],
      description: '阿里 Qoder Agent，经官方 Agent SDK 接入（底层仍是 qodercli），支持思考过程与工具卡片',
      icon: 'qoder',
      color: '#444441',
      command: 'qodercli',
      installHint: '安装 Qoder CLI（安装器会落到 %USERPROFILE%\\.qoder\\bin\\qodercli），然后 qodercli login',
    },
    cli: {
      // 二进制名不是 `qoder`。`qoder` 是 **IDE 启动器**（bin\\qoder.cmd →
      // ~/.qoder/entry/qoder.cmd → qoder-dispatcher.ps1，只负责拉起 GUI），
      // 真正的 Agent CLI 是 `qodercli`，装在 %USERPROFILE%\.qoder\bin\qodercli。
      // 2026-10-19 本机实测：`qodercli -p "..."` 直接返回文本，退出码 0。
      bin: 'qodercli',
      // 模型清单：`qodercli --list-models`（只列当前账号可路由的）。
      // ⚠️ 自定义模型那行是 `显示名 (provider-id…)`，**括号里那串不是 -m 的取值**：
      //    实测 `-m qoder-custom-efc0bc4d-…` → "Model ... is not available right now;
      //    using \"qfmodel\" instead."（被静默换掉），而 `-m sensenova-6.8-flash-lite`
      //    正常返回。所以 modelCatalog 取的是括号前的名字（A58）。
      buildArgs: qoderCliArgs,
      parse: 'text',
    },
    // A76：SDK 通道优先，握手失败自动回退上面的 cli。
    // 实测依据（2026-10-22）：本机 qodercli 1.1.73 + SDK 1.0.55 走
    // ProcessTransport 跑到 `result/success`，且能拿到 thinking / tool_use /
    // tool_result / result 四类事件。SDK 官方 pin 的是 1.1.75，1.1.73 实测无碍。
    sdk: { flavor: 'qoder-intl' },
    // qodercli 装在 PATH 之外，必须显式加搜索目录（目录名与可执行名同名）
    extraPaths: ['%USERPROFILE%\\.qoder\\bin\\qodercli'],
    // 登录态在 ~/.qoder/.auth/（实测 user 文件存在即为已登录，qodercli login 写入）
    authFiles: ['.qoder/.auth/user'],
  },
  {
    /**
     * Qoder 国内版（qoder.cn）。
     *
     * ## 为什么它是独立条目
     *
     * 阿里官方口径：Qoder 与 Qoder CN 是**两个产品系列**，账号 / Credits /
     * 模型 / 部署全独立、不互通。本机 `~/.qoder-cn/.qoder-app-status.json`
     * 实测 `product="qodercn"`、未登录。一个子进程只能持一份凭据，合并成一条
     * 就是「切了等于没切」的假控件。
     *
     * ## 诚实边界：本机验不了
     *
     * 这台机器上：`~/.qoder-cn` 存在但**未登录**，`bin/` 下**没有 `qoderclicn`**
     * （只有 7zr.exe 与 qoder-cn-computer-use）。所以这条只能做到
     * 「接得上、验不了」：
     *   - 包名 / CLI 名 / PAT 变量名三处差异来自官方 npm 包元数据与 README
     *     （`@qodercn-ai/qodercn-agent-sdk` 1.0.55 确实存在，两份 README 逐节同构）；
     *   - **但 `qoderclicn` 的实际安装路径、配置根目录没有实测**，下面
     *     `extraPaths` / `authFiles` 按国际版同构推断，两个候选目录都搜。
     * 等有 CN 账号时先 `qoderclicn --help` 核对一遍，再把这行注释改掉。
     */
    descriptor: {
      id: 'qoder-cn',
      name: 'Qoder CN',
      vendor: 'Alibaba',
      kind: 'cli',
      family: 'qoder',
      familyName: 'Qoder',
      surface: 'cli',
      region: 'cn',
      regionName: '国内版',
      authScope: 'qoder.cn',
      authScopeName: 'Qoder CN 账号',
      capabilities: ['chat', 'code', 'write', 'tools'],
      eventCapabilities: ['thinking', 'tool', 'usage'],
      description:
        '阿里 Qoder 国内版（qoder.cn），账号与积分独立；按官方 SDK 接入，本机无 CN 账号未实测',
      // 与国际版同一个品牌，复用同一套 logo 资源（不另画一个不存在的图形）
      icon: 'qoder',
      color: '#444441',
      command: 'qoderclicn',
      installHint:
        '安装 Qoder CN 桌面端后使用其自带 CLI（qoderclicn）登录；' +
        '本机尚未检测到该命令，安装路径按国际版同构推断（未实测）',
      // A71 要求每条都给结构化获取方式。这里只能是 `unknown`：
      // 官方没有给 CN 版 CLI 一个独立的下载页/安装命令（桌面端装完自带），
      // 我们也没核实到 —— 那就**不画按钮**，只写说明。
      // 画一个「去下载」按钮指向猜出来的地址，比不画更糟。
      install: {
        method: 'unknown',
        note: '安装 Qoder CN 桌面端后，用其自带 CLI（qoderclicn）登录；本机未检测到该命令',
        checkedAt: '2026-10-22',
        checkedFrom:
          '本机 ~/.qoder-cn 目录实查 + npm 包 @qodercn-ai/qoderclicn 元数据；官方独立安装入口未核实，故 method=unknown',
      },
    },
    cli: {
      // CN 版 CLI 的可执行名是 `qoderclicn`（npm 包 @qodercn-ai/qoderclicn
      // 的 bin 名，2026-10-22 查包元数据确认）。参数形态与国际版同构 ——
      // 所以直接复用同一个 buildArgs，不复制一份会漂的代码。
      bin: 'qoderclicn',
      buildArgs: qoderCliArgs,
      parse: 'text',
    },
    sdk: { flavor: 'qoder-cn' },
    // 两个候选目录都搜：`~/.qoder-cn/bin/qoderclicn`（与 `~/.qoder/bin/qodercli`
    // 同构）以及 `~/.qoder-cn/bin`。哪个都不在就是没装，不做更多猜测。
    extraPaths: ['%USERPROFILE%\\.qoder-cn\\bin', '%USERPROFILE%\\.qoder-cn\\bin\\qoderclicn'],
    // 登录态位置按国际版同构推断（未实测）。探测只看「文件在不在」，
    // 猜错的表现是「显示未登录」而不是「假装已登录」—— 方向是安全的。
    authFiles: ['.qoder-cn/.auth/user'],
  },
  {
    descriptor: {
      id: 'doubao',
      name: '豆包',
      vendor: 'ByteDance',
      kind: 'http',
      // 端点是 ark.cn-beijing.volces.com → 火山方舟（Volcengine Ark），
      // 账号是火山引擎账号。familyName 用平台官方名「火山方舟」而不是「豆包」：
      // 豆包是模型品牌，方舟才是我们实际接的那个开放平台。
      family: 'volcengine-ark',
      familyName: '火山方舟',
      surface: 'http',
      region: 'cn',
      regionName: '中国站',
      authScope: 'volcengine',
      authScopeName: '火山引擎账号',
      // ⚠️ 只能标 chat / write。HTTP 路径没有工具调用循环，标了 code / tools
      //    就是谎称能读写文件、能跑命令（详见 adapters/http.ts 的顶部说明）。
      capabilities: ['chat', 'write'],
      // 空数组 ≠ 没写。`undefined` 是「后端没声明，界面按未知处理」，
      // `[]` 是「确实一条过程能力都没有，界面把它们全部标成不支持」。
      // http 类只有一问一答，过程区永远是空的 —— 必须说清是「没有」而不是
      // 「我们没接」，否则用户会一直等一张不会出现的工具卡。
      eventCapabilities: [],
      description: '字节豆包大模型，经火山方舟 API 接入。一问一答，不读写本地文件',
      icon: 'doubao',
      color: '#B0479E',
      command: '火山方舟 API',
      // 模型名这一栏容易踩坑：方舟的「模型」既可以是模型名，也可以是你在
      // 控制台创建的**推理接入点 ID**（ep-xxxx）。用接入点才能带上你自己
      // 调的并发与计费配置，所以优先引导用户填 ep-。
      installHint: '设置环境变量 ARK_API_KEY（火山方舟控制台获取）。模型名填推理接入点 ID（ep-xxxx）或模型名，如 doubao-1.5-pro-32k',
    },
    http: {
      dialect: 'openai',
      url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      host: 'ark.cn-beijing.volces.com',
      defaultModel: 'doubao-1.5-pro-32k',
    },
    authEnvs: ['ARK_API_KEY', 'DOUBAO_API_KEY'],
    backendHosts: ['ark.cn-beijing.volces.com'],
    // A30：后端实测可达（无 Key 时 401），所以只要在设置页填上 Key 就能直接用
    credential: {
      keyEnv: ['ARK_API_KEY', 'DOUBAO_API_KEY'],
      // A105：同 Kimi —— 豆包桌面 App 的登录态与方舟 API Key 是两套东西，
      // 用户装了 App、登了号，看到「未登录」只会更困惑。
      hint: '火山方舟控制台创建 API Key（与豆包桌面 App 的登录态不通用）；模型可填推理接入点 ID（ep-xxxx）或 doubao-1.5-pro-32k',
    },
  },
  {
    descriptor: {
      id: 'zcode',
      name: 'ZCode',
      vendor: '智谱 (Z.AI)',
      kind: 'cli',
      // 一个条目、两种账号：登录时选 Z.ai（国际，美元计价）或 BigModel（国内，人民币）。
      // 配置里不写明连的是哪个，所以 region 记 any 而不是猜一个；
      // 界面上要如实显示「当前连的是哪个（读得到就读，读不到说读不到）」。
      family: 'zhipu-glm',
      familyName: '智谱 GLM',
      surface: 'cli',
      region: 'any',
      regionName: '登录时选择',
      authScope: 'bigmodel-or-zai',
      authScopeName: 'BigModel 或 Z.ai 账号',
      capabilities: ['chat', 'code', 'tools'],
      description:
        '智谱 GLM 的官方 CLI（2026-09 全量开源）。headless 单次执行：结束时一次性给出 JSON',
      eventCapabilities: ['usage'],
      icon: 'zcode',
      color: '#534AB7',
      command: 'zcode',
      installHint:
        '安装 ZCode 桌面版即可（应用会自动在开始菜单快捷方式与默认安装目录里找引擎 resources/glm/zcode.cjs，也可手动把引擎软链到 PATH）；模型在 ~/.zcode/cli/config.json 里配，本应用不代管',
    },
    cli: {
      bin: 'zcode',
      // A105：引擎是 `zcode.cjs`（Node 脚本），没有任何可执行扩展名 ——
      // 不加这项，findExecutable 按 PATHEXT 找不到它，装好的桌面版也会
      // 被报成「PATH 中未找到命令 zcode」。
      binExts: ['.cjs'],
      buildArgs: (prompt, ctx) => {
        // 依据 zcode 0.14.5 实测（Open ACE 的集成手册，与本文件其他 CLI 同规格）：
        //   --prompt <text>   单次执行，不开 TUI
        //   --json            结束时输出一个完整 JSON（response + usage + sessionId）
        //   --no-color        免得 ANSI 颜色码混进解析
        //   --mode            yolo / build / edit / plan
        // ⚠️ 没有 --model：实测该 flag 会让 zcode 打印帮助后退出，模型只能走
        //    ~/.zcode/cli/config.json。这里**不**把 ctx.model 编进 argv ——
        //    编了就是给用户一个静默失效的选项。
        const args = ['--prompt', prompt, '--json', '--no-color'];
        if (ctx.cwd) args.push('--cwd', ctx.cwd);
        const mode = ctx.permissionMode ?? 'default';
        args.push(
          '--mode',
          mode === 'plan'
            ? 'plan'
            : mode === 'acceptEdits'
              ? 'edit'
              : mode === 'bypassPermissions'
                ? 'yolo'
                : 'build'
        );
        // 续接：上一轮 JSON 里的 sessionId（sess_...）
        if (ctx.resumeToken) args.push('--resume', ctx.resumeToken);
        return args;
      },
      parse: 'json-object',
      extractResumeToken: obj => {
        const o = obj as { sessionId?: unknown };
        return typeof o.sessionId === 'string' ? o.sessionId : null;
      },
      mapLine: obj => {
        const o = obj as {
          response?: unknown;
          is_error?: unknown;
          error?: unknown;
          usage?: {
            inputTokens?: unknown;
            outputTokens?: unknown;
            totalTokens?: unknown;
            cacheReadTokens?: unknown;
          };
        };
        // headless 模式下错误也走这个 JSON（或以非零退出 + stderr 收场）
        if (o.is_error) {
          return { type: 'error', message: String(o.error ?? o.response ?? 'ZCode 执行失败') };
        }
        const events: AgentEvent[] = [];
        if (typeof o.response === 'string' && o.response) {
          events.push({ type: 'text', content: o.response });
        }
        const u = o.usage ?? {};
        const tokens = Number(u.totalTokens ?? 0) || Number(u.inputTokens ?? 0) + Number(u.outputTokens ?? 0);
        if (tokens > 0) events.push({ type: 'usage', tokens });
        return events.length ? events : null;
      },
      // 单次模式没有增量输出，超时按最长档：自主任务确实可能跑十几分钟
      timeoutMs: 15 * 60 * 1000,
      // 这几个错误重试一万次也不会好，直接fail fast
      fatalStderrPattern: /ZCODE_RUNTIME_MODEL_UNAVAILABLE|Unknown option|Unknown command|MODEL_UNAVAILABLE/i,
    },
    // 凭据不在环境变量里：zcode login（OAuth）或 ~/.zcode/cli/config.json 的
    // provider.options.apiKey。探测阶段只看配置文件在不在。
    authFiles: ['.zcode/cli/config.json'],
    // A105：ZCode **只通过桌面版分发**，官方设计就是引擎不进 PATH。
    // 安装目录由用户自选（常见装在 `D:\Apps\ZCode`，默认在
    // `%LOCALAPPDATA%\Programs\ZCode`），没有任何环境变量记录它 ——
    // 所以两条路一起走：默认安装位置猜一遍，再从开始菜单 / 桌面的
    // `ZCode.lnk` 反推真实安装根（`{root}` 会被替换成那个根）。
    // 两条都不中才判未安装。
    engineCandidates: [
      '{root}\\resources\\glm\\zcode.cjs',
      '%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
      '%LOCALAPPDATA%\\ZCode\\resources\\glm\\zcode.cjs',
      '%ProgramFiles%\\ZCode\\resources\\glm\\zcode.cjs',
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      '~/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    ],
    shortcutNames: ['ZCode.lnk'],
    extraPaths: [],
  },
  {
    descriptor: {
      id: 'kimicode',
      name: 'Kimi',
      vendor: 'Moonshot',
      kind: 'http',
      // 这是**开放平台**（api.moonshot.cn）那条链路，与下面的 kimicli（Kimi Code）
      // **不是重复**：Kimi 官方 FAQ 明确「开放平台 API Key 与 Kimi Code Key 不通用」，
      // 账号体系不同 → 按 R1 必须是两条（一个子进程只能持一份凭据）。
      // region 口径跟官方帮助中心走：中国站 platform.kimi.com / 国际站 platform.kimi.ai。
      family: 'kimi',
      familyName: 'Kimi',
      surface: 'http',
      region: 'cn',
      regionName: '中国站',
      authScope: 'kimi-open-platform',
      authScopeName: 'Kimi 开放平台 API Key',
      // 同上：没有工具循环，不标 code / tools。
      capabilities: ['chat', 'write'],
      // 理由同 doubao：`[]` 表示「确实没有过程能力」，不是「没声明」
      eventCapabilities: [],
      description: '月之暗面 Kimi，经 Moonshot API 接入。一问一答，不读写本地文件',
      icon: 'kimicode',
      color: '#26215C',
      command: 'Moonshot API',
      installHint: '设置环境变量 MOONSHOT_API_KEY（platform.moonshot.cn 获取）。默认模型 kimi-k2-0905-preview，可在会话中改',
    },
    http: {
      dialect: 'openai',
      url: 'https://api.moonshot.cn/v1/chat/completions',
      host: 'api.moonshot.cn',
      defaultModel: 'kimi-k2-0905-preview',
    },
    authEnvs: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    backendHosts: ['api.moonshot.cn'],
    credential: {
      keyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
      // A105：用户在本机 Kimi 桌面 App / Kimi Code CLI 里登录过，名册这一条
      // 仍显示未登录 —— 官方 FAQ 明确「开放平台 API Key 与 Kimi Code Key 不
      // 通用」，桌面 App 的登录态更不是 Key。不写这一句，用户会反复去登录
      // 一个本来就登录着的 App，然后认定应用坏了。
      hint: 'Moonshot 开放平台申请 API Key（账户状态需正常）；注意与 Kimi 桌面 App / Kimi Code CLI 的登录态不通用',
    },
  },

  // ---------- A65：本机已装 / 已能无头调用的三个 CLI ----------
  {
    descriptor: {
      id: 'pi',
      name: 'Pi',
      vendor: 'Earendil Works',
      kind: 'cli',
      // 没有自有账号：`~/.pi/agent/models-store.json` 里只有 deepseek，
      // 额度算在 provider 头上 → region 记 any。
      family: 'pi',
      familyName: 'Pi',
      surface: 'cli',
      region: 'any',
      regionName: '跟随模型 provider',
      authScope: 'none',
      authScopeName: '无自有账号',
      capabilities: ['chat', 'code', 'write', 'tools'],
      eventCapabilities: ['thinking', 'tool', 'usage', 'cost'],
      description:
        '极简终端编码 Agent（pi），自带 read/bash/edit/write 工具与多 provider 路由，输出事件流结构清晰',
      icon: 'pi',
      color: '#3F3F46',
      command: 'pi',
      installHint:
        'npm i -g @earendil-works/pi-coding-agent，然后在交互模式用 /login 或设置 provider 的 API Key（如 DEEPSEEK_API_KEY）',
    },
    cli: {
      bin: 'pi',
      buildArgs: (prompt, ctx) => {
        // `--mode json`：JSONL 事件流（session 头 + message_update / tool_execution_*）。
        // `-p`：非交互单次执行。
        //
        // ⚠️ 实测（0.82.1）：pi **会读 stdin**。终端里直接跑会停在等输入，
        //    只有 stdin 被关闭时才正常退出。我们的 CLI 适配器固定
        //    stdio=['ignore',...]，等价于 /dev/null，所以这里不需要额外参数；
        //    但**不要**为了「喂 stdin」改成 pipe —— 那会让 pi 永久挂住。
        const args = ['-p', '--mode', 'json'];
        // 续接：session 头里的 id 就是它自己的项目会话 id，
        // `--session-id` 的语义是「用这个 id，没有就新建」—— 幂等，正好适合我们。
        if (ctx.resumeToken) args.push('--session-id', ctx.resumeToken);
        if (ctx.model) args.push('--model', ctx.model);
        // 思考强度：pi 有 7 档（off…max），但只有取值合法时才传 ——
        // 传错值 pi 不报错、直接按默认跑，等于静默失效。
        if (ctx.reasoningEffort && PI_THINKING_LEVELS.includes(ctx.reasoningEffort)) {
          args.push('--thinking', ctx.reasoningEffort);
        }
        args.push(prompt);
        return args;
      },
      parse: 'jsonl',
      mapLine: mapPiLine,
      extractResumeToken: obj => {
        const o = obj as { type?: string; id?: unknown };
        return o.type === 'session' && typeof o.id === 'string' ? o.id : null;
      },
    },
    // pi 由 Hermes 自带的 node 前缀安装（%LOCALAPPDATA%\hermes\node），
    // 打包后的应用 PATH 可能拿不到它，显式加一条搜索目录。
    extraPaths: ['%LOCALAPPDATA%\\hermes\\node'],
    // 各家 provider 的 Key（pi 官方 providers 文档逐条列出，不是猜的）
    authEnvs: [
      'DEEPSEEK_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'XAI_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'NVIDIA_API_KEY',
      'AI_GATEWAY_API_KEY',
    ],
    // /login 会把 Key 存进 auth.json。⚠️ 该文件在「从没登录过」时也可能存在
    // （内容为 `{}`）—— 只能判「有没有这个文件」，判不了内容，属已知的弱信号。
    authFiles: ['.pi/agent/auth.json'],
  },
  {
    descriptor: {
      id: 'antigravity',
      name: 'Antigravity CLI',
      vendor: 'Google',
      kind: 'cli',
      // 与 gemini **同族同账号**（Google 账号，登录态在系统钥匙串 → 探测判不出来），
      // 但它是 Google 明确推荐的**新一代** CLI，不是 Gemini 的区域版本。
      // 产品本身是 Antigravity IDE，我们接的是 `agy` 这个 headless CLI 面 → surface=cli。
      family: 'google',
      familyName: 'Google',
      surface: 'cli',
      region: 'intl',
      regionName: '国际站',
      authScope: 'google',
      authScopeName: 'Google 账号',
      capabilities: ['chat', 'code', 'write', 'tools'],
      eventCapabilities: ['tool', 'usage'],
      description:
        'Google Antigravity 的终端 Agent（agy），与 IDE 共用引擎；支持 headless 事件流、计划模式与推理强度',
      icon: 'antigravity',
      color: '#4285F4',
      command: 'agy',
      installHint:
        'irm https://antigravity.google/cli/install.ps1 | iex（落到 %LOCALAPPDATA%\\agy\\bin），然后先交互运行一次 agy 完成 Google 登录',
    },
    cli: {
      bin: 'agy',
      buildArgs: (prompt, ctx) => {
        // 依据：官方 headless 文档 + 本机 1.1.20 `agy --help` 实测。
        const args = ['-p', prompt, '--output-format', 'stream-json'];

        // ⚠️ 这一条不是「可选优化」，是**正确性前提**：
        //    不带 --add-dir 时 agy 会在 ~/.gemini/antigravity-cli/scratch/ 里跑，
        //    既不是会话工作目录、也不触发项目 hooks，而且**照样 exit 0**。
        //    传相对路径也会被拒（同样 exit 0）—— 所以必须传绝对路径。
        if (ctx.cwd) args.push('--add-dir', ctx.cwd);

        if (ctx.model) args.push('--model', ctx.model);
        // 只有 low/medium/high 三档，其余值不传（传错 agy 直接报 invalid model selection）
        if (ctx.reasoningEffort && AGY_EFFORT_LEVELS.includes(ctx.reasoningEffort)) {
          args.push('--effort', ctx.reasoningEffort);
        }

        // 权限：agy 的 --mode 只有 accept-edits / plan 两个取值；
        // 「逐次询问」是它的默认（request-review），不需要传参。
        if (ctx.permissionMode === 'plan') args.push('--mode', 'plan');
        else if (ctx.permissionMode === 'acceptEdits') args.push('--mode', 'accept-edits');
        else if (ctx.permissionMode === 'bypassPermissions') {
          args.push('--dangerously-skip-permissions');
        }

        // 续接：result/init 里的 conversation_id
        if (ctx.resumeToken) args.push('--conversation', ctx.resumeToken);
        return args;
      },
      parse: 'jsonl',
      createMapper: createAgyMapper,
      extractResumeToken: obj => {
        const o = obj as { event?: string; conversation_id?: unknown; result?: { conversation_id?: unknown } };
        if (o.event === 'init' && typeof o.conversation_id === 'string') return o.conversation_id;
        if (o.event === 'result' && typeof o.result?.conversation_id === 'string') {
          return o.result.conversation_id;
        }
        return null;
      },
      // 未登录时它会打印授权 URL 然后**等 60 秒**再报错（stdin 已关也不会提前退出）。
      // 命中这句就立刻判死，别让用户白等一分钟。
      fatalStderrPattern: /authentication required|authentication failed/i,
    },
    extraPaths: ['%LOCALAPPDATA%\\agy\\bin'],
    // ⚠️ 登录态在**系统钥匙串**里（官方文档：authenticates via the system keyring），
    // 磁盘上没有可判定的凭据文件，所以这里不声明 authEnvs / authFiles ——
    // 声明了只会得到假的「未登录」或假的「已就绪」。运行期未登录由
    // fatalStderrPattern 与适配器的 auth 文案兜住。
  },
  {
    descriptor: {
      id: 'kimicli',
      name: 'Kimi Code CLI',
      vendor: 'Moonshot',
      kind: 'cli',
      // 与 kimicode 同族、**不同账号**：这条走 Kimi Code 账号（`~/.kimi-code/config.toml`），
      // 区域读 `~/.kimi-code/region` = "mainland-cn"（官方 `kimi login --region` 两档：
      // "mainland-cn" 对应 kimi.com、"global" 对应 kimi.ai）。
      // 将来要做国际站那条，用 `KIMI_CODE_HOME` 隔离 + `login --region global`，
      // 而不是给这一条加区域下拉。
      family: 'kimi',
      familyName: 'Kimi',
      surface: 'cli',
      region: 'cn',
      regionName: '中国站',
      authScope: 'kimi-code-cn',
      authScopeName: 'Kimi Code 账号',
      capabilities: ['chat', 'code', 'write', 'tools', 'search'],
      eventCapabilities: ['tool'],
      description:
        '月之暗面官方终端编码 Agent（kimi），可读写文件、执行命令、联网检索；与 HTTP 版 Kimi 是两条独立链路',
      // 复用品牌 logo（与 HTTP 版同一个 Kimi 标记）
      icon: 'kimicode',
      color: '#1783FF',
      command: 'kimi',
      installHint:
        'irm https://code.kimi.com/kimi-code/install.ps1 | iex（落到 %USERPROFILE%\\.kimi-code\\bin），然后 kimi login 完成登录',
    },
    cli: {
      bin: 'kimi',
      buildArgs: (prompt, ctx) => {
        // 依据：官方 reference（kimi 命令）+ 本机 2.3.0 `kimi --help` 实测。
        const args = ['-p', prompt, '--output-format', 'stream-json'];
        if (ctx.model) args.push('-m', ctx.model);
        // 续接：--session <id>。⚠️ 与 --continue 互斥，别两个都传。
        if (ctx.resumeToken) args.push('--session', ctx.resumeToken);
        // 权限：`-p` **不能**与 --plan / --yolo / --auto 组合（官方 flag 冲突规则），
        // 非交互模式固定按 auto 权限跑。所以这里一个权限参数都不传 ——
        // 传了 CLI 会直接拒绝启动，那是更糟的「假保障」。
        return args;
      },
      parse: 'jsonl',
      mapLine: mapKimiLine,
      extractResumeToken: obj => {
        const o = obj as { session_id?: unknown; sessionId?: unknown; session?: { id?: unknown } };
        const id = o.session_id ?? o.sessionId ?? o.session?.id;
        return typeof id === 'string' ? id : null;
      },
      // 未登录时的真实 stderr（本机实测）：
      //   No model configured. Run `kimi` and use /login to sign in, then retry
      // 重试一万次也不会好，直接 fail fast。
      fatalStderrPattern: /No model configured|use \/login to sign in/i,
    },
    // 装在 PATH 之外（官方安装器落到 ~/.kimi-code/bin），必须显式加搜索目录
    extraPaths: ['%USERPROFILE%\\.kimi-code\\bin'],
    // 登录态：kimi login（device-code）写入 ~/.kimi-code 下，未登录时只有 bin/ 与
    // sessions/。本机实测未登录状态下没有 config.toml —— 用它做判定依据。
    authFiles: ['.kimi-code/config.toml'],
  },
  {
    descriptor: {
      id: 'trae',
      name: 'Trae',
      vendor: 'ByteDance',
      kind: 'cli',
      // Trae 有国内版（trae.com.cn）与国际版（trae.ai），模型池不同。目前能核到的
      // 官方 CLI 文档只有国内站 docs.trae.cn，所以先按 cn 记一条。
      // 若日后确认两版共用同一账号体系，也不要合成一条（一个子进程只能持一份
      // 凭据）—— 与 qoder / kimicode 的处理一致：同族不同账号 = 两条目。
      family: 'trae',
      familyName: 'Trae',
      surface: 'cli',
      region: 'cn',
      regionName: '国内站',
      authScope: 'trae',
      authScopeName: 'Trae 账号',
      capabilities: ['chat', 'code', 'write', 'tools', 'search'],
      eventCapabilities: ['tool', 'usage'],
      description:
        '字节 Trae 的官方终端 Agent（traecli），支持非交互 exec、JSONL 事件流与沙箱权限；与 IDE 共用同一账号',
      // A104：接上官方 logo（src/assets/agent-logos/trae.svg，取自 asvg.app，
      // 与 trae.com.cn 的 favicon 同色 #32F08C）。
      // 原先这里留空走「首字母色块」，注释写的是「没有官方 logo 素材」——
      // 那个理由现在已经不成立，素材已落地，故连同注释一起替换。
      icon: 'trae',
      command: 'traecli',
      installHint:
        'TraeCode CLI（traecli）由 Trae 官方分发，需企业版旗舰套餐；安装方式见 docs.trae.cn，装完运行 traecli login。注意：装了 Trae IDE 不等于装了它 —— IDE 附带的 `trae-cn` 只是 IDE 启动器，不能当 Agent 用',
    },
    cli: {
      /**
       * A119：**只列 `traecli`**，不再列 `trae-cn`。
       *
       * A105 曾经把 `trae-cn` 也列进来，理由是「国内版装出来就叫这个，
       * 只写文档名会把装好的用户判成未安装」。那个判断错了 ——
       * `trae-cn` 是 **Trae IDE 自带的 VS Code 官方垫片**，不是 agent CLI：
       *
       *   C:\Apps\Trae CN\bin\trae-cn.cmd
       *     @echo off
       *     set ELECTRON_RUN_AS_NODE=1
       *     "%~dp0..\Trae CN.exe" "%~dp0..\resources\app\out\cli.js" %*
       *
       * `resources/app/out/cli.js` 就是 VS Code 的 `code` 命令，只认
       * version / status / tunnel / serve-web / install-extension /
       * locate-extension / open-url —— **没有 `exec`**；它的参数语义是
       * 「要打开的路径」（`--help` 第一行就是
       * `Usage: trae-cn.exe [options] [paths...]`）。
       *
       * 于是 `trae-cn exec --json --skip-git-repo-check -C <dir> "hi"`
       * 不报错，而是把 `exec` 当成文件夹路径 **拉起 IDE 窗口**：
       * 子进程变成 GUI，stdout 永不产出，界面一直转圈到 8 分钟超时。
       * 用户看到的现象是「跟 Trae 对话会弹出 Trae 自己的应用」。
       *
       * 顺带纠正 A105 的另一处误判：`trae-cn --version` 返回的 `1.107.1`
       * 是 **Trae CN IDE 的版本**，不是 traecli 的。拿它当「CLI 已装好」
       * 的证据，等于用 IDE 的版本号证明 CLI 存在。
       *
       * 真正的 `traecli` 由 Trae 官方单独分发（企业版旗舰套餐），本机
       * 没有安装（`~/.trae` / `~/.trae-cn` 都是 IDE 配置目录，不含 CLI）。
       * 所以这条现在会如实显示「未安装」并给出安装指引 —— 比假装就绪、
       * 一调用就弹窗好得多。
       *
       * 另加一道保险：probe.ts 的 `isIdeLauncher()` 会在探测阶段拦住
       * 「ELECTRON_RUN_AS_NODE + resources/app/out/cli.js」这种 IDE 启动器
       * 形态，即便日后又有人把某个 IDE 的垫片名写进 bin，也接不进来。
       */
      bin: ['traecli'],
      /**
       * ⚠️ **没有任何一条是实跑验证过的** —— 本机没有 `traecli`，
       * 上面列的事件结构全部来自官方文档，不是实测。
       * （A105 曾写「本机装有 Trae CN、`--version` 返回 1.107.1」，
       *  那个结论在 A119 被推翻：返回版本号的是 IDE，不是 CLI。）
       *
       * 依据：docs.trae.cn/cli_command-line-parameters
       * （2026-10-22 实读），逐条对应：
       *   `traecli exec [选项] [PROMPT]`  非交互运行
       *   `--json`                        事件以 JSONL 流式打到 stdout
       *   `-C/--cd <DIR>`                 工作根目录
       *   `-m/--model <MODEL>`            指定模型
       *   `-s/--sandbox <MODE>`           read-only / workspace-write / danger-full-access
       *   `--permission-mode <MODE>`      default / auto / bypass_permissions
       *   `-y/--yolo`                     跳过全部确认且不沙箱（危险）
       *   `--skip-git-repo-check`         允许在非 git 仓库里跑
       * 装好之后第一件事：跑 `traecli exec --json "say hi"` 看真实事件结构，
       * 再回来核对 createMapper 是否对得上。
       * 别用 `trae-cn` 试 —— 那是 IDE 的垫片，只会弹窗口（见上面的 bin 注释）。
       */
      buildArgs: (prompt, ctx) => {
        const args = ['exec', '--json', '--skip-git-repo-check'];
        if (ctx.cwd) args.push('-C', ctx.cwd);
        if (ctx.model) args.push('-m', ctx.model);
        // 权限模式 → 沙箱 / 审批策略。
        // 「只读」必须真的只读（P4-5 的教训：不落地的权限承诺是假保障），
        // 所以 plan 走 read-only 沙箱，而不是只改一句提示文案。
        if (ctx.permissionMode === 'plan') args.push('-s', 'read-only');
        else if (ctx.permissionMode === 'bypassPermissions') args.push('-y');
        else if (ctx.permissionMode === 'acceptEdits') args.push('--permission-mode', 'auto');
        args.push(prompt);
        return args;
      },
      parse: 'jsonl',
      // 事件结构按同族（Codex 系）处理，理由见 createCodexLineageMapper 的文件头。
      // 与 codex 的差别：`--resume` 只写在**交互模式**的选项表里，exec 没有续接参数，
      // 所以这里不实现 extractResumeToken —— 多轮上下文由本应用自己带的历史消息负责。
      createMapper: () => createCodexLineageMapper('Trae'),
    },
  },
];

/**
 * 安装来源表（A71）。
 *
 * ## 为什么单独一张表，而不是塞进上面 14 个 descriptor
 *
 * 这 14 条 `installHint` 原来是**散文**，把三件不同的事混成一句：安装命令、
 * 登录步骤、环境变量。典型如 codex 的
 * `npm i -g @openai/codex，然后 codex login` —— 界面只能整句显示，
 * 用户不知道哪半截该粘到终端、哪半截是装完之后的事。
 *
 * 拆成结构化字段后，每段只有一个用途：`command` 整行可复制、`note` 是装完之后
 * 的动作、`url` 是核实过的官方页。**只复制不代跑**的理由见 PLAN-AGENT-INSTALL §3。
 *
 * 单独放一张表还有个实际好处：这张表是"往用户机器装东西"的唯一入口，
 * 审计时只看这一处就够；散在 14 个长块里，改一次要翻 1600 行。
 *
 * ## 核实记录（2026-10-22）
 *
 * `checkedAt` / `checkedFrom` 不是装饰：这些链接会烂，烂了要能被
 * `verify:install-meta` 的时效断言逼着有人去看。核实方式有三种，
 * 写在各条的 `checkedFrom` 里：
 *   - npm registry `GET /<pkg>/latest` 实查版本与 homepage
 *   - 官网页面实读（WebFetch），逐字抄下安装命令
 *   - 安装脚本 URL 直连 200
 *
 * ⚠️ 核实过程中**推翻了我自己方案里的两个判断**（原方案写 installer 4 条、script 2 条）：
 *   - **Cursor**：原以为只有桌面安装器，实际官网给的是 PowerShell 脚本
 *     `irm 'https://cursor.com/install?win32=true' | iex`（cursor.com/cli 实读）。
 *   - **Qoder**：同上，官网给 `irm https://qoder.com/install.ps1 | iex`（qoder.com/cli 实读）。
 *   所以现在是 **script 4 条、installer 只剩 zcode 一条**。这就是"必须实查"的价值 ——
 *   凭印象写会把两条有命令的写成"只能下安装器"，白白让用户多点三次。
 *
 * ## 宁可缺，不许假
 *
 * `zcode` 与 `hermes` **没有 `url`**：zcode 只通过 ZCode 桌面版分发（本应用不代管
 * 它的引擎与模型配置），hermes 我们没核实到可信的公开下载页。这两条界面上
 * **不画按钮**，只写说明 —— 画一个点下去 404 的按钮比不画更糟。
 */
const CHECKED = '2026-10-22';

const INSTALL_INFO: Record<string, AgentInstall> = {
  // ── 不需要安装：缺的是登录 / Key ──────────────────────────────
  workbuddy: {
    method: 'key',
    requires: 'none',
    note: '本应用内置 SDK，不需要安装；缺的是登录或 API Key',
    checkedAt: CHECKED,
    checkedFrom: '官方双版本产品配置（A68 已核：productName / networkEnvironment）',
  },
  doubao: {
    method: 'key',
    requires: 'none',
    note: '不需要安装：只缺 ARK_API_KEY（火山方舟控制台获取）',
    checkedAt: CHECKED,
    checkedFrom: '后端只需 ARK_API_KEY，走 https 直连（A68 端点已核）',
  },
  kimicode: {
    method: 'key',
    requires: 'none',
    note: '不需要安装：只缺 MOONSHOT_API_KEY（platform.moonshot.cn 获取）',
    checkedAt: CHECKED,
    checkedFrom: '后端只需 MOONSHOT_API_KEY，走 https 直连（A68 端点已核）',
  },

  // ── 桌面安装器：CLI 随 IDE 分发 ──────────────────────────────
  trae: {
    method: 'installer',
    url: 'https://www.trae.com.cn/',
    requires: 'none',
    // A119：这条 note 以前写的是「装 Trae IDE 后在 IDE 内安装命令行工具」，
    // 读起来像「装完 IDE 就有 CLI」—— 实际不是：IDE 附带的 `trae-cn` 是
    // VS Code 系 IDE 启动器（参数是「要打开的路径」），`traecli exec` 这种
    // agent 用法它会当成路径去开窗口。真正的 traecli 是另一件独立分发物。
    note: 'Trae IDE 本身不含 agent CLI：需另装 traecli（企业版旗舰套餐），装完运行 traecli login',
    checkedAt: CHECKED,
    checkedFrom:
      'trae.com.cn 官网实读（2026-10-22，标题 TRAE｜你的 AI 开发工程师）；CLI 参数与套餐限制见 docs.trae.cn/cli_command-line-parameters；A119 本机实读 bin/trae-cn.cmd 与 resources/app/out/cli.js 确认其为 IDE 启动器',
  },

  // ── npm 全局包：要求本机有 Node ──────────────────────────────
  codex: {
    method: 'npm',
    pkg: '@openai/codex',
    command: 'npm i -g @openai/codex',
    url: 'https://github.com/openai/codex',
    requires: 'node',
    note: '装完运行 codex login 登录',
    checkedAt: CHECKED,
    checkedFrom: 'npm registry 实查 @openai/codex@0.163.0，homepage 指向该仓库',
  },
  gemini: {
    method: 'npm',
    pkg: '@google/gemini-cli',
    command: 'npm i -g @google/gemini-cli',
    url: 'https://github.com/google-gemini/gemini-cli',
    requires: 'node',
    note: '装完设置 GEMINI_API_KEY，或运行 gemini 走浏览器登录',
    checkedAt: CHECKED,
    checkedFrom: 'npm registry 实查 @google/gemini-cli@0.65.0，homepage 指向该仓库',
  },
  opencode: {
    method: 'npm',
    pkg: 'opencode-ai',
    command: 'npm i -g opencode-ai',
    url: 'https://opencode.ai',
    requires: 'node',
    note: '装完至少配置一个 provider 的 API Key',
    checkedAt: CHECKED,
    checkedFrom: 'npm registry 实查 opencode-ai@1.19.3（无 homepage 字段，站点另测 200）',
  },
  pi: {
    method: 'npm',
    pkg: '@earendil-works/pi-coding-agent',
    command: 'npm i -g @earendil-works/pi-coding-agent',
    url: 'https://github.com/earendil-works/pi',
    requires: 'node',
    note: '装完在交互模式用 /login，或设置 provider 的 API Key',
    checkedAt: CHECKED,
    checkedFrom: 'npm registry 实查 @earendil-works/pi-coding-agent@1.4.0',
  },
  claude: {
    method: 'npm',
    pkg: '@anthropic-ai/claude-code',
    command: 'npm i -g @anthropic-ai/claude-code',
    url: 'https://github.com/anthropics/claude-code',
    requires: 'node',
    // 原来这条的 installHint 写的是「需要登录」，被摆在"接入说明"里，
    // 新用户会以为要装。现在安装归安装、登录归这里。
    note: '装完运行 claude，在交互模式里执行 /login',
    checkedAt: CHECKED,
    checkedFrom: 'npm registry 实查 @anthropic-ai/claude-code@2.1.308',
  },

  // ── 厂商 PowerShell 脚本：只在终端里由用户自己跑 ──────────────
  antigravity: {
    method: 'script',
    command: 'irm https://antigravity.google/cli/install.ps1 | iex',
    url: 'https://antigravity.google/docs/getting-started?tab=cli',
    requires: 'powershell',
    note: '装完先交互运行一次 agy 完成 Google 登录',
    checkedAt: CHECKED,
    checkedFrom: '官方文档 Get Started 页实读，命令逐字抄录；脚本 URL 与定义里的一致',
  },
  kimicli: {
    method: 'script',
    command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    url: 'https://code.kimi.com/kimi-code',
    requires: 'powershell',
    note: '装完运行 kimi login（device-code 登录）',
    checkedAt: CHECKED,
    checkedFrom: '安装脚本 URL 直连 200；页面本身对爬虫返 403，未逐字比对命令',
  },
  cursor: {
    method: 'script',
    command: "irm 'https://cursor.com/install?win32=true' | iex",
    url: 'https://cursor.com/cli',
    requires: 'powershell',
    note: '装完运行 cursor-agent login；会落到 %LOCALAPPDATA%\\cursor-agent',
    checkedAt: CHECKED,
    checkedFrom: 'cursor.com/cli 实读，页面 PowerShell 区块逐字给出该命令（含单引号）',
  },
  qoder: {
    method: 'script',
    command: 'irm https://qoder.com/install.ps1 | iex',
    url: 'https://qoder.com/cli',
    requires: 'powershell',
    note: '装完运行 qodercli login',
    checkedAt: CHECKED,
    checkedFrom: 'qoder.com/cli 实读，页面 Windows PowerShell 区块逐字给出该命令',
  },

  // ── 没有命令行安装方式 ────────────────────────────────────
  zcode: {
    method: 'installer',
    requires: 'none',
    // 故意不给 url：ZCode 只随桌面版分发，本应用不代管它的引擎与模型配置。
    // 核实不到可信的独立下载页，就不画按钮（画一个 404 比不画更糟）。
    note: '随 ZCode 桌面版分发，没有命令行安装方式；装完把引擎软链到 PATH（本应用不代管它的模型配置）',
    checkedAt: CHECKED,
    checkedFrom: '本机 ~/.zcode 为桌面版留下的配置；未找到可核实的独立下载页',
  },
  hermes: {
    method: 'unknown',
    requires: 'none',
    note: '需要 hermes-acp 可执行文件；本应用未收录可核实的官方安装入口',
    checkedAt: CHECKED,
    checkedFrom: '定义里只有 extraPaths（%LOCALAPPDATA%\\hermes\\bin），没有官方 URL',
  },
};

/**
 * 对外导出的定义表 = 原始定义 + 安装来源。
 *
 * 合并发生在模块加载时，而不是让每个消费方自己去查 `INSTALL_INFO` ——
 * 否则 registry / HTTP 层 / 验收脚本各查一次，迟早有一处忘掉。
 */
export const AGENT_DEFS: AgentDefinition[] = RAW_DEFS.map(def => {
  const install = INSTALL_INFO[def.descriptor.id];
  return install
    ? { ...def, descriptor: { ...def.descriptor, install } }
    : def;
});

/**
 * A150：**暂时下架**的 Agent（用户 2026-10-29 决定）。
 *
 * 为什么是「下架」而不是「删定义」：Trae 的事件映射、argv 构造、安装说明全部
 * 按官方文档写，本机**从未实跑过一次** —— 真正的 `traecli` 要企业版旗舰套餐，
 * 本机只有 Trae IDE（它附带的 `trae-cn` 是 VS Code 垫片，见 `cli.bin` 的注释）。
 * 删定义等于把「等有人装了再回来核对」的依据一起扔掉。
 *
 * 生效方式：注册表构造时跳过这些 id ⇒ 不进名册、不参与 `probeAll`、
 * `GET /api/agents/:id` 直接 404。定义本身仍在 `AGENT_DEFS` 里，
 * 所以 `findDef('trae')` 照样能解析出名字（历史数据不会退化成裸 id）。
 *
 * **恢复方式：把 id 从这个数组里删掉，别处一行都不用改。**
 * 恢复后第一件事是跑 `traecli exec --json "say hi"` 核对真实事件结构 ——
 * 现有映射一条都没被实测过。
 */
export const RETIRED_AGENT_IDS: readonly string[] = ['trae'];

/** 安装链接允许出现的主机白名单（`verify:install-meta` 断言用） */
export const INSTALL_HOSTS = [
  'github.com',
  'opencode.ai',
  'antigravity.google',
  'code.kimi.com',
  'cursor.com',
  'qoder.com',
  'www.trae.com.cn',
] as const;

/** 按 id 快速查找 */
/**
 * 用户自建 Agent 的定义表（A114）。
 *
 * 启动时由 `server/index.ts` 调 `registerCustomDefs()` 灌入。之所以不并进
 * `AGENT_DEFS`：那份是**编译期常量**，而自建 Agent 是运行时从
 * `data/custom-agents.json` 读出来的 —— 用户可以随时增删，改完还要能热生效
 * （不必重启应用）。合成一份新数组等于每次增删都重新分配，而注册表那边
 * 也要跟着重建 Provider，反而不如显式注册。
 */
let customDefs: AgentDefinition[] = [];

/** 灌入自建 Agent 定义。重复调用以最后一次为准（设置页增删后重新灌） */
export function registerCustomDefs(defs: AgentDefinition[]): void {
  customDefs = defs;
}

/** 内置 + 自建。需要「全部 Agent」的地方用它，不要直接遍历 AGENT_DEFS */
export function allAgentDefs(): AgentDefinition[] {
  return [...AGENT_DEFS, ...customDefs];
}

export function findDef(id: string): AgentDefinition | undefined {
  // 自建在前：它的 id 带 `custom-` 前缀，不可能与内置条目撞名
  return customDefs.find(d => d.descriptor.id === id) ?? AGENT_DEFS.find(d => d.descriptor.id === id);
}

/**
 * 这个 Agent 到底认不认「模型」这个参数（A151 / P3）。
 *
 * ## 为什么不查一张手写的表
 *
 * 因为手写的表一定会和代码分叉 —— 本轮 cursor 的漏接就是这么发生的：
 * `CATALOG_SOURCES` 是人维护的，`definitions.ts` 里的 `buildArgs` 也是，
 * 两边没有任何自动校验，于是「CLI 有枚举命令」和「我们接了」长期不是一回事。
 *
 * 这里改成**直接问代码本身**：拿两个不同的模型名各构造一次 argv，
 * 变了就是认、没变就是不认。判据来自真正要执行的那条路径，
 * 不是另一份描述。
 *
 * 实测（2026-10-30）：
 *   认 —— codex / gemini / opencode / claude / cursor / qoder / qoder-cn /
 *         pi / antigravity / kimicli
 *   不认 —— zcode（argv 里根本没有 model 位；它只读自己的配置）
 *   没有 cli 通道 —— workbuddy（SDK）/ hermes / doubao / kimicode
 */
export function agentAcceptsModel(id: string): boolean {
  const def = findDef(id);
  const cli = def?.cli;
  if (!cli) return false;
  const base = {
    sessionId: 'probe',
    prompt: 'probe',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions' as const,
  };
  try {
    const a = JSON.stringify(cli.buildArgs('probe', { ...base, model: '__opc_probe_a__' }));
    const b = JSON.stringify(cli.buildArgs('probe', { ...base, model: '__opc_probe_b__' }));
    return a !== b;
  } catch {
    // 构造不出 argv 就是「不确定」—— 不确定时不许给手动输入框，
    // 否则用户填了名字却传不下去，又是一个假控件。
    return false;
  }
}

/**
 * 由 Agent 定义推导它的工具事件来源（A100）。**纯函数**，可单测。
 *
 * ## 为什么需要这个函数
 *
 * 13 个 CLI 里 9 个吐 jsonl、1 个吐 json-object、3 个只有纯文本。前两类
 * 的事件是 CLI 自己声明的结构化输出；纯文本那 3 个是适配器按模式**解析**出来
 * 的。两者在界面上长得一模一样，但可信度差一个量级 —— 不区分，就等于把
 * 「我猜的」和「它说的」画成同一个样子。
 *
 * ## 判定顺序（从最可信往下）
 *
 * 1. `sdk` 优先于 `cli`：定义表里两者可以同时存在（SDK 握手失败才回退 CLI），
 *    而能走 SDK 时事件就是原生的。
 * 2. `kind === 'sdk'` / `acp` / `http` 都是官方接口：SDK 走的是厂商 SDK，
 *    ACP 是正式协议，HTTP 是结构化接口 —— 都算 native。
 *    ⚠️ 曾经漏了 `kind === 'sdk'`，只判了 `def.sdk` 字段。两者的覆盖并不重合：
 *    `kind` 说的是**我们怎么接**，`def.sdk` 说的是**有没有配 SDK 握手参数**。
 *    漏掉它的后果是主力 Agent（workbuddy，kind='sdk'）在界面上没有来源标注。
 * 3. `cli` 看 `parse`：`jsonl` / `json-object` 是 CLI 自己吐的结构化输出；
 *    `text` 是适配器解析出来的，低一档。
 * 4. 其余（mock 等）返回 undefined —— **不猜**。UI 对 undefined 不标注。
 */
export function eventSourceOf(def: AgentDefinition | undefined): EventSource | undefined {
  if (!def) return undefined;
  if (def.sdk) return 'native';
  if (
    def.descriptor.kind === 'sdk' ||
    def.descriptor.kind === 'acp' ||
    def.descriptor.kind === 'http'
  ) {
    return 'native';
  }
  if (def.cli) return def.cli.parse === 'text' ? 'parsed_text' : 'structured_cli';
  return undefined;
}
