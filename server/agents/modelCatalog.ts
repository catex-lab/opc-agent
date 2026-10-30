/**
 * Agent 模型目录（动态）。
 *
 * ## 为什么需要它
 *
 * opencode 的可用模型原先是一份写死在 `definitions.ts` 里的 4 个白名单，
 * 而本机 `opencode models` 实测能跑 97 个（跨 8 个 provider，其中 10 个
 * Zen 免费模型）。官方 App 的模型菜单还会给每个模型标「免费 / 付费」、
 * 显示上下文与模态 —— 我们只有一个裸模型名。这就是用户报的 bug：
 * **接入后显示的模型不全，也没有免费/付费标签**。
 *
 * ## 数据从哪来（两层，职责不同）
 *
 * 1. **能跑什么** —— CLI 自己枚举（`opencode models` / `qodercli --list-models` /
 *    `codex debug models`）。这是唯一诚实的事实来源：它只列出**当前凭据真正
 *    可路由**的模型。拿 models.dev 的 129 个 Zen 模型直接铺上去是不对的 ——
 *    那里面有大量本机没配 provider / 没有额度的模型，选中后调用必失败。
 *
 * 2. **长什么样** —— `https://models.dev/api.json`（OpenCode 官方同源目录）。
 *    提供显示名、价格（→ 免费/付费标签）、上下文长度、输入模态、是否支持推理。
 *    只有 opencode 用得上这一层：qoder / codex 的模型不在 models.dev 里，
 *    它们的显示名与描述由各自的 CLI 直接给出（见 `parseQoderModels` /
 *    `parseCodexModels`），拿不到价格就**不标角标**。
 *
 * 两者按 `provider/model` 对齐后合并；任一层失败都不影响另一层：
 * CLI 失败 → 退回 models.dev 里该 provider 的清单；网络失败 → 退回
 * 编译进包的快照 `opencodeCatalogSnapshot.ts`。**列表永不空**（对 opencode 而言）。
 *
 * ## 缓存
 *
 * 内存 + `data/model-catalog.json`，TTL 24h。CLI 枚举与联网都只在这层
 * 缓存过期后发生，正常请求是纯内存查表。
 */
import fs from 'fs';
import path from 'path';
import { dataDirPath } from '../paths.js';
import { expandPath, findExecutable, resolveAnyLaunchTarget, runCapture } from './probe.js';
import { OPENCODE_CATALOG_SNAPSHOT } from './opencodeCatalogSnapshot.js';

/**
 * 模型角标。
 *
 * - `免费`：长期免费（OpenCode Zen 的 `*-free`）
 * - `限时免费`：官方 UI 的 "Free now" —— 促销期免费，随时可能恢复计费
 * - `付费`：按量计费
 */
export type ModelTag = '免费' | '限时免费' | '付费';

/** 一条暴露给前端的模型 */
export interface ModelOption {
  /** 完整引用，如 `opencode/glm-5.3-flash-free` */
  modelId: string;
  /** 官方显示名 */
  name: string;
  /** 第二行说明：上下文 / 模态 / 推理 / 单价 */
  description?: string;
  /** 角标：免费 / 限时免费 / 付费（拿不到价格时缺省不标，绝不猜） */
  tag?: ModelTag;
  /**
   * 右侧计费倍率，如 `0.34x`（WorkBuddy 的 credits 倍率）。
   * 与官方菜单一致：倍率单独右对齐，不混进说明文字里。
   */
  multiplier?: string;
  /** 原始 provider 键（`opencode` / `zai` / `github-copilot` …） */
  provider?: string;
  /** provider 的展示名 */
  providerName?: string;
  /**
   * 这一条是否**实测可路由**（A151）。
   *
   * - `true`：来自 CLI 自己的枚举，或标定过（`modelAvailability.ts` 里打通过）；
   * - `false`：来自官方文案表、但本机还没打过的。界面标「未验证」，
   *   选之前要先标定 —— 官方清单里确实存在 `-m` 会被静默替换的名字。
   * - 缺省：老路径（不参与标定的 Agent），按可用处理。
   */
  verified?: boolean;
  /**
   * 这个模型支持的推理/思考强度档位（A62）。
   *
   * 与官方模型面板上的「思考强度：低 / 中 / 高 / 最大 / 超高」对应。
   * 两种来源：
   *   - codex：`codex debug models` 的 JSON 里每个模型自带
   *     `supported_reasoning_levels` + `default_reasoning_level`，per-model 权威；
   *   - qoder：CLI 只吐名字，档位是全局一套（见 `QODER_REASONING_LEVELS`）。
   *
   * **没有档位信息就不填这个字段**（前端据此隐藏控件），绝不给一个猜的值。
   */
  reasoning?: ReasoningConfig;
}

/** 推理强度档位集合（挂在一个模型或一个 Agent 上） */
export interface ReasoningConfig {
  levels: ReasoningLevel[];
  /** 官方默认档位（CLI 自己声明的；拿不到就不填，前端不预设选中值） */
  defaultLevel?: string;
}

export interface ReasoningLevel {
  /** 传给 CLI 的值，如 `low` / `xhigh` */
  value: string;
  /** 展示名，取官方 UI 的中文标签 */
  label: string;
  /** 官方对该档位的说明（codex 的 JSON 里有，qoder 没有就不填） */
  description?: string;
}

/**
 * 「只有名字」的源（qoder / codex）给出的单模型显示信息。
 *
 * 提到顶层而不是三处各写一份匿名对象字面量：解析器返回值、
 * `CatalogState.details` 的值、`buildListOptions` 的入参必须是**同一个形状**，
 * 少一个可选字段就会让推理档位在某一环悄悄丢掉（A62 的教训）。
 */
export interface ModelDetail {
  name?: string;
  description?: string;
  /** 同上：没有档位信息就不填，前端据此隐藏控件 */
  reasoning?: ReasoningConfig;
}

/**
 * 解析器吐出的单条（带 id）。
 *
 * 为什么不让 `ModelDetail` 自己带 `id`：`details` 的下标就是 modelId，
 * 值里再放一个 `id` 就是同一份数据存两处。而解析器（`parseQoderModels` /
 * `parseCodexModels`）、`QODER_VERIFIED_EXTRA`、`refreshCatalog` 的
 * `entries` 都**必须**带 id —— 两者用两个类型表达，谁也别将就。
 */
export interface CatalogEntry extends ModelDetail {
  id: string;
}

/** models.dev 单条模型里我们用得到的字段（快照同形） */
export interface RawProviderModel {
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  modalities?: { input?: string[] };
  reasoning?: boolean;
  description?: string;
}

/** 某个 Agent 的目录来源 */
interface CatalogSource {
  /** 用 CLI 自己的枚举命令拿到「真的能跑」的清单 */
  cli?: { bin: string; args: string[] };
  /**
   * 枚举输出的形态（决定用哪个解析器）：
   *
   * - `provider-model`（默认）：一行一个 `provider/model`，可再用 models.dev 补元数据
   * - `qoder`：一行一个裸模型名，自定义模型是 `显示名 (modelID)`；没有价格信息
   * - `codex-json`：`codex debug models` 的 JSON（含 display_name / 描述 / 上下文 / 优先级）
   * - `cursor`：一行一个 `id - 显示名`，当前/默认模型在行尾带 `(current, default)`
   */
  format?: 'provider-model' | 'qoder' | 'codex-json' | 'cursor';
  /**
   * 二进制不在 PATH 里时的额外搜索目录（与 `definitions.ts` 的 `extraPaths` 同义）。
   * 目录枚举也走子进程，找不到二进制就等于没有清单 —— 不能只靠 PATH。
   */
  extraDirs?: string[];
  /** CLI 不可用时的兜底 provider（models.dev 键）。只对 provider-model 形态有意义 */
  fallbackProviders: string[];
}

/**
 * 目录来源表。
 *
 * 三条 CLI 有「自己枚举模型」的能力，其余没有 —— 这个区别是本文件的核心纪律：
 *
 * | Agent | 枚举命令 | 形态 |
 * |---|---|---|
 * | opencode | `opencode models` | `provider/model` + models.dev 元数据 |
 * | qoder | `qodercli --list-models` | 裸名字（含自定义模型的 modelID） |
 * | codex | `codex debug models` | JSON（官方模型目录，含 hide/list 可见性） |
 * | cursor | `cursor-agent models` | `id - 显示名`（含 `(current, default)` 标记） |
 *
 * gemini / claude / pi / zcode / kimi 的 CLI **没有任何枚举命令**
 * （已逐个翻过 `--help` 与子命令表，2026-10-21 与 2026-10-30 两次实测），
 * 硬塞一份 models.dev 清单等于给用户一堆本机跑不通的选项 —— 那是把一个假控件
 * 换成另一个假控件。它们继续显示「模型由 Agent 决定」，比铺一份没人验证过的
 * 清单诚实。
 *
 * ⚠️ **2026-10-30 补 cursor 时踩到的教训**：这张表是**手写**的，
 * 「CLI 有枚举命令」与「我们接了这一条」之间没有任何自动校验 ——
 * cursor 官方一直有 `cursor-agent models`（本机实测 270 条），
 * 但没人加进这张表，于是它整整一段时间都显示「模型由 Agent 决定」，
 * 与当初 opencode 那个 bug 是同一个形态。`verify:model-catalog` 现在有一条
 * **源码契约**钉着：`definitions.ts` 里凡是会传 `ctx.model` 的 CLI Agent，
 * 必须在 `CATALOG_SOURCES` 里，或在显式的 `NO_ENUMERATION` 名单里说明原因。
 */
const CATALOG_SOURCES: Record<string, CatalogSource> = {
  opencode: {
    cli: { bin: 'opencode', args: ['models'] },
    format: 'provider-model',
    fallbackProviders: ['opencode'],
  },
  // `--list-models` 是 qodercli 1.1.73 的正式选项（help 原文：
  // "List available models for the current user"），只列当前账号真正可路由的。
  qoder: {
    cli: { bin: 'qodercli', args: ['--list-models'] },
    format: 'qoder',
    extraDirs: ['%USERPROFILE%\\.qoder\\bin\\qodercli'],
    fallbackProviders: [],
  },
  // 国内版（A76）：命令名是 `qoderclicn`（@qodercn-ai/qoderclicn 的 bin 名）。
  //
  // ⚠️ 这一条**不享受** qoder 的两项「已知信息」：
  //   - `QODER_VERIFIED_EXTRA`（实测路由通过的那几个 New Models）是在**国际版账号**
  //     上测的，CN 是独立账号体系，照搬就是编数据；
  //   - `QODER_REASONING_LEVELS`（8 档）来自国际版 CLI 的报错原文，CN 未核对。
  // 所以这里只做「CLI 说有什么就是什么」——本机没装 CN CLI 时就是空列表，
  // 界面显示「模型由 Agent 决定」，比铺一份没人验证过的清单诚实。
  'qoder-cn': {
    cli: { bin: 'qoderclicn', args: ['--list-models'] },
    format: 'qoder',
    extraDirs: [
      '%USERPROFILE%\\.qoder-cn\\bin',
      '%USERPROFILE%\\.qoder-cn\\bin\\qoderclicn',
    ],
    fallbackProviders: [],
  },
  // `codex debug models` 的 help 原文："Render the raw model catalog as JSON"。
  // 它藏在 `debug` 子命令下，光看 `codex --help` 是发现不了的。
  codex: {
    cli: { bin: 'codex', args: ['debug', 'models'] },
    format: 'codex-json',
    fallbackProviders: [],
  },
  // `cursor-agent models`（2026-10-30 本机实测 270 条）。
  //
  // 为什么拖到 A151 才接：`definitions.ts` 里 cursor 的 `installHint` 写着
  // 「装的是 cursor-agent CLI」，但**没人回头看它有没有枚举命令** ——
  // 而 `cursor-agent --help` 里明明白白列着 `--list-models` 与 `models`
  // 两个子命令（`models` 的说明就是 "List available models for this account"）。
  // 这就是本文件顶部那条教训的现场。
  //
  // `extraDirs` 与 definitions 的 `extraPaths` 同值：cursor-agent 装在
  // `%LOCALAPPDATA%\cursor-agent`，不在 PATH 里，不显式加目录就永远找不到。
  cursor: {
    cli: { bin: 'cursor-agent', args: ['models'] },
    format: 'cursor',
    extraDirs: ['%LOCALAPPDATA%\\cursor-agent'],
    fallbackProviders: [],
  },
};

/**
 * Qoder：CLI 只吐 3 条，但官方 IDE 选择器有 15 条。
 *
 * ## 为什么 CLI 给的少
 *
 * `qodercli --help` 里 `-m/--model` 的原文把模型分成三类：
 * 「Default and New Models use model name; Custom uses modelID」。
 * 实测 `--list-models` 只列 **Default + Custom**（`qfmodel` / `dfmodel` /
 * 用户自建的 `sensenova-6.8-flash-lite`），New Models 一类完全不出来 ——
 * 这是 CLI 的口径问题，不是账号权限问题。
 *
 * ## 这份补充清单的准入标准：**必须实测路由通过**
 *
 * 只用 `-m <name>` 逐条打过去，按 CLI 的反应分三档：
 *
 * | 反应 | 含义 | 处置 |
 * |---|---|---|
 * | `You've reached your credit usage limit…`（不是 not available） | 名字有效、路由已通过，只是账号积分为 0 跑不出内容 | **进补充清单** |
 * | `Model "…" is not available right now; using "qfmodel" instead.` | 名字无效，被静默替换 | 不进（GUI 文案表里的历史/预览条目） |
 * | 进程挂起、无任何输出 | 积分为 0 时 CLI 连不上任何模型都是这个表现 | **不猜，等实测** |
 *
 * 2026-10-21 实测结论（`qodercli -p --permission-mode dont_ask -m <name> "回复OK"`）：
 * - 已验证：`Qwen3.8-Max`、`GLM-5.3`（均报 credit limit，即路由通过）
 * - CLI 明确不认：`GLM-5.2`、`Qwen3.5-Plus`、`Qwen3.8-Max-Preview`、`Qwen3.7-Max`
 * - 未验证（挂起）：`Qwen3.7-Plus`、`GLM-5.3-Flash`、`DeepSeek-V4-Pro`、
 *   `Kimi-K3`、`Kimi-K2.8-Preview`、`MiniMax-M3.1-Flash`、`Sonus`、`Cantus`
 *
 * ## 为什么不把官方 GUI 的 15 条全塞进来
 *
 * 那 15 条来自 `~/.qoder/.auth/dynamic-texts.json` 的 `modelSelector.item.*`
 * （namespace `qoder-ide` 的文案表）。它是「官方前端支持展示的全部模型字段」，
 * 上表第一类的历史/预览条目也在里面 —— 塞进去就是「点了就报错」的假控件，
 * 而这正是本项目反复在守的那条线。所以只收实测通过的。
 *
 * ## 描述从哪来
 *
 * 抄自官方文案表的 `modelSelector.item.<key>.description`（zh-CN）。
 * 那是公开文案，不是私有数据；私有格式的 `~/.qoder/.models/<uid>/catalog-v7`
 * （magic `QMC\x01`，含账号与价格倍率）**不碰**。
 *
 * （注意：上面那行路径里的 <uid> 不能换成星号 —— 星号紧跟斜杠会把本注释块
 *  就地闭合，剩下的说明全变成代码，报一串看不懂的语法错误。）
 *
 * 价格倍率拿不到（只在 catalog-v7 里），所以这两条**不标角标**——
 * 与 `buildListOptions` 的既有纪律一致：拿不到的数据不标也不猜。
 *
 * ⚠️ 这份清单是**快照**：官方后续上新/下线模型后，只要 CLI 还是不吐，
 * 这里就不会跟着变。要维持它，需要定期重跑上面的实测表并更新本常量。
 */
const QODER_VERIFIED_EXTRA: ReadonlyArray<CatalogEntry> = [
  {
    id: 'Qwen3.8-Max',
    name: 'Qwen3.8-Max',
    description:
      '千问最新一代大基座模型（Qwen3.8-Max-0902），2.4 万亿参数，在代码工程、专业办公、深度推理等核心场景全面领先。',
  },
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    description: '智谱开源旗舰模型，代码能力达到国际顶尖水平，兼具安全审查与漏洞推理能力。',
  },
];

/**
 * 把「实测路由通过」的补充模型并进 qoder 的枚举结果。
 *
 * 三件事：**去重**（官方哪天自己吐了就不重复出）、**追加在末尾**（CLI 给的三条
 * 是账号自己的 Default/Custom，理应排在前面）、**不改 CLI 解析结果本身**
 * （解析失败时 `entries` 为空，此时也把补充项带出来 —— 反正它们是实测可路由的）。
 */
function mergeQoderVerifiedExtras(
  entries: CatalogEntry[]
): void {
  for (const extra of QODER_VERIFIED_EXTRA) {
    if (entries.some(e => e.id === extra.id)) continue;
    entries.push({ ...extra });
  }
}

/**
 * Qoder 的推理/思考强度档位（A62）。
 *
 * ## 值域是 CLI 报错原文，不是我们编的
 *
 * 2026-10-21 实测 `qodercli --reasoning-effort bogus`，CLI 直接把合法值
 * 全列了出来：`auto, none, low, medium, high, xhigh, max, ultracode`。
 * 这与官方 IDE 文案表 `~/.qoder/.auth/dynamic-texts.json` 里的
 * `modelSelector.runtimeLabel.*` 逐个对上（`无/低/中/高/最大/超高/ultracode/自动`），
 * 所以中文标签是官方自己的译法。
 *
 * ## 为什么是「全局一套」而不是 per-model
 *
 * `qodercli --list-models` 只吐模型名，JSON 都不出，拿不到 per-model 档位；
 * 官方 IDE 面板里的档位选择器也是**换模型不换档位表**（同一套 8 档）。
 * 所以这里给全部 qoder 模型挂同一份 —— 这是官方行为，不是我们的近似。
 *
 * ⚠️ `auto` 放在最前且不设 `defaultLevel`：官方面板默认是「自动」，
 * 而 CLI 不传 `--reasoning-effort` 时用的就是它自己的默认（等价 auto），
 * 所以 `defaultLevel` 留空 = 不显式传参 = 走 CLI 默认。
 */
export const QODER_REASONING_LEVELS: ReasoningConfig = {
  levels: [
    { value: 'auto', label: '自动' },
    { value: 'none', label: '无' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '超高' },
    { value: 'max', label: '最大' },
    { value: 'ultracode', label: 'ultracode' },
  ],
};

/** 给 qoder 的一条模型挂上全局档位表（同一份引用，模型间不复制） */
function qoderReasoning(): ReasoningConfig {
  return QODER_REASONING_LEVELS;
}

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_PATH = path.join(dataDirPath, 'model-catalog.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
/**
 * 单个 CLI 枚举的超时。
 *
 * 实测（2026-10-21，热态）：opencode 1.9s / qodercli 7.5s / codex 7.2s。
 * 但**冷态**（首次启动那 218MB 的 qodercli、杀软扫描）会明显更慢 ——
 * 20s 曾实测过一次 opencode 枚举超时、整张列表退化成 models.dev 的 129 条。
 * 给到 30s，宁可第一次打开菜单多等几秒，也不要悄悄换一份清单。
 */
const CLI_TIMEOUT_MS = 30_000;

/** provider 展示名（认不出的直接用原始键，不编造） */
const PROVIDER_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  zai: 'Z.AI',
  'zai-coding-plan': 'Z.AI 编程套餐',
  zhipuai: '智谱',
  'zhipuai-coding-plan': '智谱 编程套餐',
  deepseek: 'DeepSeek',
  sensenova: 'SenseNova',
  'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  moonshotai: 'Moonshot',
};

/**
 * provider 分组顺序。
 *
 * 前端没有分组控件（TDesign Select 没有 OptGroup），所以顺序就是分组：
 * 同一 provider 的模型连续排列，第二行开头写着 provider 名。
 * OpenCode 官方 Zen 排第一 —— 与官方 App 一致，也是免费额度所在。
 */
const PROVIDER_ORDER = [
  'opencode',
  'zai',
  'zai-coding-plan',
  'zhipuai',
  'zhipuai-coding-plan',
  'deepseek',
  'sensenova',
  'github-copilot',
];

/** 缓存结构（也是磁盘文件的形状） */
interface CatalogState {
  /** 结构版本：加字段就 +1，让旧缓存自然失效（否则菜单会缺显示名） */
  version: number;
  fetchedAt: number;
  /** agentId → 该 Agent 真实可运行的模型引用 */
  agents: Record<string, string[]>;
  /** provider 键 → 模型元数据 */
  providers: Record<string, Record<string, RawProviderModel>>;
  /**
   * agentId → modelId → 显示信息。
   *
   * 只有「不带 models.dev 元数据」的源（qoder / codex）需要它：
   * 它们的显示名与描述是 CLI 自己给的，不能从 models.dev 拼出来。
   */
  details?: Record<string, Record<string, ModelDetail>>;
  /** agentId → 该 Agent 的 CLI 自己声明的默认模型（如 codex 的 config.toml） */
  defaults?: Record<string, string>;
}

/**
 * 缓存结构版本。
 *
 * - 1 → 2：加了 `details`（qoder / codex 的显示名与描述）
 * - 2 → 3：`details` 的值加了 `reasoning`（A62 思考强度档位）
 * - 3 → 4：新增 `cursor` 来源（A151）。不升版本的话，旧缓存里没有
 *          `agents.cursor`，cursor 会在接下来 24 小时里继续显示
 *          「模型由 Agent 决定」—— 改完看不到效果，最容易被误判成「没接上」
 *
 * 不升版本的后果是旧缓存读回来所有模型都没有 `reasoning`，
 * 前端控件会「莫名消失」——而原因在磁盘里，排查时根本看不出异常。
 */
const CACHE_VERSION = 4;

let state: CatalogState | null = null;
let memFetchedAt = 0;
let loading: Promise<CatalogState> | null = null;

// ============= 纯函数（可离线验证） =============

/** 去掉 ANSI 颜色（CLI 在 TTY 里会带色，虽然我们传了 NO_COLOR，仍然兜一层） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * 解析 `opencode models` 的输出。
 *
 * 输出是一行一个 `provider/model`（如 `zai/glm-4.7`）。
 * 只接受「至少一个 `/`、且不含空白」的行 —— 报错文本、进度条、空行
 * 一律丢掉。宁可少列，不可把一句报错当成模型名。
 */
export function parseCliModelRefs(stdout: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.replace(ANSI_RE, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /\s/.test(line)) continue;
    const slash = line.indexOf('/');
    if (slash <= 0 || slash === line.length - 1) continue;
    if (!/^[A-Za-z0-9._@-]+\/[A-Za-z0-9._@:/-]+$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * 解析 `qodercli --list-models`。
 *
 * 实测输出（1.1.73）：
 * ```
 * MODEL
 * Qwen3.8-Flash
 * DeepSeek-Flash
 * sensenova-6.8-flash-lite (qoder-custom-efc0bc4d-c735-45db-b2a4-02…)
 * ```
 *
 * ⚠️ 括号里那串是**自定义 provider 的 id，不是 `-m` 的取值**。
 * 这一点是实测出来的，不是猜的：
 *   `-m qoder-custom-efc0bc4d-…` → "Model ... is not available right now;
 *   using \"qfmodel\" instead."（被静默换掉，正好是我们要避免的假控件）
 *   `-m sensenova-6.8-flash-lite` → 正常返回。
 * 所以 **id 取括号前的显示名**，括号里的东西整段丢掉（它还会被 `…` 截断，
 * 本来也不完整）。
 *
 * 另外两条规矩：
 * 1. 首行 `MODEL` 是表头，不是模型；
 * 2. 带空白的行多半是报错文本（真实模型名都是连字符形式），一律丢掉 ——
 *    宁可少列，也不把一句报错当成模型名。
 */
export function parseQoderModels(stdout: string): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.replace(ANSI_RE, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^MODEL$/i.test(line)) continue;

    const name = line.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (!name || /\s/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: name, name });
  }
  return out;
}

/** `codex debug models` 单条里我们用得到的字段 */
interface CodexRawModel {
  slug?: string;
  display_name?: string;
  description?: string;
  /** `list` = 官方模型选择器里可见；`hide` = 内部模型，不该出现在菜单里 */
  visibility?: string;
  context_window?: number;
  input_modalities?: string[];
  /** 官方推荐顺序（数字小的靠前） */
  priority?: number;
  /** 官方默认推理强度（本机 `gpt-6-astra` 实测是 `low`） */
  default_reasoning_level?: string;
  /**
   * 该模型支持的推理强度档位。
   *
   * 实测结构（`codex debug models`）：
   *   [{"effort":"low","description":"Fast responses with lighter reasoning"}, …]
   */
  supported_reasoning_levels?: Array<{ effort?: string; description?: string }>;
}

/**
 * codex 推理档位的中文标签。
 *
 * **为什么中文名可以直接沿用**：`codex debug models` 只给英文 effort 值，
 * 中文名来自官方前端文案表 `modelSelector.runtimeLabel.*` —— 用的是官方自己的
 * 译法（低/中/高/最大/超高/无/开启/关闭/推荐），不是我们翻译的。
 * 未覆盖的值（如 `ultra`）保留英文原文，不硬造中文。
 */
const CODEX_REASONING_LABEL: Record<string, string> = {
  none: '无',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
  ultra: '极限',
};

/** 从 codex 的原始条目里取推理档位；模型没给就返回 undefined */
function codexReasoningOf(m: CodexRawModel): ReasoningConfig | undefined {
  if (!Array.isArray(m.supported_reasoning_levels) || m.supported_reasoning_levels.length === 0) {
    return undefined;
  }
  const levels: ReasoningLevel[] = [];
  for (const item of m.supported_reasoning_levels) {
    if (!item || typeof item.effort !== 'string' || !item.effort) continue;
    levels.push({
      value: item.effort,
      label: CODEX_REASONING_LABEL[item.effort] ?? item.effort,
      description: item.description,
    });
  }
  if (levels.length === 0) return undefined;
  const declared = typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined;
  return {
    levels,
    // 默认档必须是它自己声明过的那个，否则前端预设一个不支持的档位 = 假控件。
    // 多一道 `includes` 是因为 `default_reasoning_level` 与
    // `supported_reasoning_levels` 是两个独立字段，声明了但列表里没有的值
    // 会变成「看起来设了、实际传过去被 CLI 忽略」——那正是要避免的。
    defaultLevel: declared && levels.some(l => l.value === declared) ? declared : undefined,
  };
}

const CODEX_MODALITY_LABEL: Record<string, string> = {
  text: '文本', image: '图像', video: '视频', audio: '音频', pdf: 'PDF',
};

/**
 * codex 模型的第二行：上下文 272K · 文本/图像 · 官方描述。
 *
 * 顺序是**先硬事实、后散文**：弹层宽度固定（340px），codex 的描述是英文长句，
 * 放前面会把「上下文 / 模态」挤到省略号后面 —— 那两项才是选模型时先看的。
 */
function describeCodexModel(m: CodexRawModel): string | undefined {
  const parts: string[] = [];
  if (m.context_window && m.context_window > 0) parts.push(`上下文 ${fmtContext(m.context_window)}`);
  const mods = (m.input_modalities ?? [])
    .filter(x => x in CODEX_MODALITY_LABEL)
    .sort((a, b) => MODALITY_ORDER.indexOf(a) - MODALITY_ORDER.indexOf(b))
    .map(x => CODEX_MODALITY_LABEL[x]);
  if (mods.length) parts.push(mods.join('/'));
  const desc = (m.description || '').trim();
  if (desc) parts.push(desc);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * 解析 `codex debug models` 的 JSON。
 *
 * - 只取 `visibility === 'list'`：`hide` 是内部模型（Daybreak / Auto Review），
 *   官方选择器同样不显示，列出来只会让用户选到一个不该选的模型；
 * - 顺序按 `priority` 升序 —— 这是官方自己的推荐顺序，**不要**再按字母排；
 * - 没有价格字段，所以**不标免费/付费**（codex 是订阅制，不按 token 计费）。
 */
export function parseCodexModels(
  json: string
): CatalogEntry[] {
  let parsed: { models?: CodexRawModel[] } | null = null;
  try {
    parsed = JSON.parse(json) as { models?: CodexRawModel[] };
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.models) ? parsed.models : [];
  return list
    .filter((m): m is CodexRawModel => !!m && typeof m.slug === 'string' && m.visibility === 'list')
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map(m => ({
      id: m.slug as string,
      name: m.display_name || (m.slug as string),
      description: describeCodexModel(m),
      reasoning: codexReasoningOf(m),
    }));
}

/**
 * 解析 `cursor-agent models`。
 *
 * 实测输出（cursor-agent 2026-10-30，本机 270 条）：
 * ```
 * Available models
 *
 * auto - Auto (current, default)
 * gpt-5.3-codex-low - Codex 5.3 Low
 * claude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)
 * …
 * Tip: use --model <id> (or /model <id> in interactive mode) to switch. …
 * ```
 *
 * ## 三条边界（每条都对应上面一种真实存在的行）
 *
 * 1. **表头 / 空行 / 结尾的 Tip 都要丢**：判据是「不含 ` - ` 分隔符」。
 *    只按行数切、或者把第一行当表头跳过，遇到 Tip 那一行就会造出一个
 *    叫 `Tip: use --model <id> (or /model <id> in interactive mode) to switch. …`
 *    的假模型。
 * 2. **行尾括号不一定是状态**：`(current, default)` 是状态要剥掉，
 *    但 `(NO ZDR)` 是**显示名的一部分**（官方就这么写的），剥掉就把
 *    「这个模型不做零数据保留」这条警告弄丢了。所以只剥「括号里只有
 *    current / default 这两个词」的那种。
 * 3. **id 里不许有空格**：与 qoder 解析器同一条纪律 —— 宁可少列，
 *    不可把一句报错当成模型名。
 */
export function parseCursorModels(stdout: string): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.replace(ANSI_RE, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const sep = line.indexOf(' - ');
    if (sep <= 0) continue;

    const id = line.slice(0, sep).trim();
    if (!/^[A-Za-z0-9._@-]+$/.test(id)) continue;
    if (seen.has(id)) continue;

    const rawName = line.slice(sep + 3).trim();
    seen.add(id);
    out.push({ id, name: stripCursorStateMarker(rawName) || id });
  }
  return out;
}

/** 行尾 `(current)` / `(default)` / `(current, default)` 是状态标记，不是名字 */
const CURSOR_STATE_RE = /\s*\(([^()]*)\)\s*$/;

function stripCursorStateMarker(name: string): string {
  const m = name.match(CURSOR_STATE_RE);
  if (!m) return name;
  const inner = (m[1] ?? '').trim();
  // 只有「全是 current/default」才剥；(NO ZDR) 这类说明必须留着
  if (!/^(?:current|default)(?:\s*,\s*(?:current|default))*$/i.test(inner)) return name;
  return name.slice(0, m.index).trim();
}

/**
 * `cursor-agent models` 里标着 `default` 的那一条 —— 它是 CLI 自己声明的默认值。
 *
 * 与 `readCodexDefaultModel()` 同一角色（那边读 config.toml，这边读枚举输出）。
 * 找不到就返回 undefined，让前端退化成「列表第一条」，**不猜**。
 */
export function parseCursorDefaultModel(stdout: string): string | undefined {
  for (const rawLine of stdout.replace(ANSI_RE, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const sep = line.indexOf(' - ');
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    if (!/^[A-Za-z0-9._@-]+$/.test(id)) continue;
    const tail = line.slice(sep + 3);
    const m = tail.match(CURSOR_STATE_RE);
    if (!m) continue;
    if (/\bdefault\b/i.test(m[1] ?? '')) return id;
  }
  return undefined;
}

/**
 * 「只有名字、没有 models.dev 元数据」的源（qoder / codex / cursor）怎么拼列表。
 *
 * 保持来源给的顺序（那是它自己的推荐顺序），不排序、不标角标 ——
 * 我们没有它们的价格数据，标错比不标更糟。
 */
export function buildListOptions(
  refs: string[],
  details: Record<string, ModelDetail> = {}
): ModelOption[] {
  return refs.map(id => {
    const d = details[id];
    return {
      modelId: id,
      name: d?.name || id,
      description: d?.description,
      reasoning: d?.reasoning,
    };
  });
}

function fmtContext(n?: number): string {  if (!n) return '?';
  if (n >= 1048576) return `${Math.round(n / 1048576)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 单价：最多 3 位小数，去掉尾随 0（models.dev 里会出现 $0.44819/M 这种） */
function fmtPrice(n: number): string {
  return String(Number(n.toFixed(3)));
}

const MODALITY_ORDER = ['text', 'image', 'video', 'audio', 'pdf'];
const MODALITY_LABEL: Record<string, string> = {
  text: '文本', image: '图像', video: '视频', audio: '音频', pdf: 'PDF',
};

/** 是否「不按量计费」。价格字段缺失时返回 null（不猜） */
export function isFreeModel(raw: RawProviderModel | undefined): boolean | null {
  if (!raw?.cost) return null;
  const input = Number(raw.cost.input ?? 0);
  const output = Number(raw.cost.output ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return input === 0 && output === 0;
}

/**
 * 第二行说明：`$0.6/2.2/M · 上下文 200K · 文本/图像 · 支持推理`。
 *
 * 免费模型不带价格段（角标已经写着「免费」，重复一遍只是噪音）。
 */
export function describeModel(raw: RawProviderModel): string | undefined {
  const parts: string[] = [];
  const free = isFreeModel(raw);
  if (free === false) {
    parts.push(`$${fmtPrice(Number(raw.cost!.input))}/${fmtPrice(Number(raw.cost!.output))}/M`);
  }
  const ctx = raw.limit?.context;
  if (ctx) parts.push(`上下文 ${fmtContext(ctx)}`);
  const mods = (raw.modalities?.input ?? [])
    .filter(m => MODALITY_ORDER.includes(m))
    .sort((a, b) => MODALITY_ORDER.indexOf(a) - MODALITY_ORDER.indexOf(b))
    .map(m => MODALITY_LABEL[m] ?? m);
  if (mods.length) parts.push(mods.join('/'));
  if (raw.reasoning) parts.push('支持推理');
  return parts.length ? parts.join(' · ') : undefined;
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function providerRank(provider: string | undefined): number {
  const i = provider ? PROVIDER_ORDER.indexOf(provider) : -1;
  return i >= 0 ? i : PROVIDER_ORDER.length;
}

/**
 * 把「模型引用 + 元数据」拼成前端模型列表。
 *
 * 排序：provider 分组 → 组内免费在前 → 组内按显示名。
 * 与官方菜单一致：免费的先看见，付费的按字母排。
 */
export function buildModelOptions(
  refs: string[],
  providers: Record<string, Record<string, RawProviderModel>>
): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];

  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);

    const slash = ref.indexOf('/');
    const provider = slash > 0 ? ref.slice(0, slash) : '';
    const id = slash > 0 ? ref.slice(slash + 1) : ref;
    const raw = providers[provider]?.[id];
    const free = isFreeModel(raw);

    out.push({
      modelId: ref,
      name: raw?.name || id,
      description: raw ? describeModel(raw) : undefined,
      tag: free === null ? undefined : free ? '免费' : '付费',
      provider,
      providerName: providerLabel(provider),
    });
  }

  return out.sort((a, b) => {
    const ra = providerRank(a.provider);
    const rb = providerRank(b.provider);
    if (ra !== rb) return ra - rb;
    if (a.provider !== b.provider) {
      return String(a.provider).localeCompare(String(b.provider));
    }
    if (a.tag !== b.tag) return a.tag === '免费' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

/**
 * 把「静态白名单」与「动态目录」合并。
 *
 * 顺序以目录为准（provider 分组 → 免费在前 → 按名），**不把白名单提到最前**：
 * 97 条列表里如果前 4 条是 zai / zhipuai / sensenova / opencode 混排，
 * 用户看到的是一段没有规律的乱序，而下面才是整齐的分组。
 * 白名单的价值是「保证这几条一定在」，不是「排在最前」——
 * 目录里本来就包含它们（清单来自 CLI 自己的枚举），元数据也以目录为准。
 *
 * 只有一种情况白名单需要插到最前：CLI 没枚举到它（例如该 provider 当前
 * 没有凭据）。这时它仍然要出现在列表里，因为它是被真实调用验证过的。
 */
export function mergeModelOptions(
  declaredIds: string[],
  catalog: ModelOption[]
): ModelOption[] {
  const inCatalog = new Set(catalog.map(m => m.modelId));
  const missing = declaredIds
    .filter(id => !inCatalog.has(id))
    .map(id => ({ modelId: id, name: id }));
  return [...missing, ...catalog];
}

// ============= 取数 =============

/** 子进程环境：关掉颜色与交互，避免 CLI 以为自己在 TTY 里 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    TERM: 'dumb',
  };
}

/** 跑一次 CLI 枚举，返回 stdout；失败（未安装 / 非 0 退出）返回 null */
async function runCliEnumeration(spec: {
  bin: string;
  args: string[];
  extraDirs?: string[];
}): Promise<string | null> {
  const binPath = findExecutable(spec.bin, (spec.extraDirs ?? []).map(expandPath));
  if (!binPath) return null;
  const target = resolveAnyLaunchTarget(binPath);
  if (target.problem) {
    console.warn(`[ModelCatalog] ${spec.bin} 不可执行：${target.problem}`);
    return null;
  }
  const res = await runCapture(target, spec.args, {
    timeoutMs: CLI_TIMEOUT_MS,
    env: childEnv(),
  });
  if (res.code !== 0) {
    console.warn(
      `[ModelCatalog] \`${spec.bin} ${spec.args.join(' ')}\` 退出码 ${res.code}，改用兜底清单`
    );
    return null;
  }
  return res.stdout;
}

/**
 * codex 自己声明的默认模型（`~/.codex/config.toml` 的 `model = "..."`）。
 *
 * 不传 `-m` 时 codex 用的就是它。不做完整 TOML 解析 —— 只认顶层那一行，
 * 认不出就当没有（返回 undefined，由上层决定怎么选），**不猜**。
 */
function readCodexDefaultModel(): string | undefined {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return undefined;
  try {
    const raw = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    const m = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** 拉 models.dev，只保留需要的 provider（整个 api.json 有 5.8MB） */
async function fetchProviders(
  providerIds: string[]
): Promise<Record<string, Record<string, RawProviderModel>>> {
  if (providerIds.length === 0) return {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const cat = (await res.json()) as Record<
      string,
      { models?: Record<string, RawProviderModel> }
    >;
    const out: Record<string, Record<string, RawProviderModel>> = {};
    for (const pid of providerIds) {
      const models = cat?.[pid]?.models;
      if (!models) continue;
      out[pid] = models;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function readDiskCache(): CatalogState | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as CatalogState;
    if (!parsed?.agents || !parsed?.providers) return null;
    // 结构变过就作废：旧缓存里没有 details，读回来菜单会只剩裸 id
    if (parsed.version !== CACHE_VERSION) return null;
    if (Date.now() - parsed.fetchedAt >= TTL_MS) return null;
    return parsed;
  } catch {
    // 文件不存在 / 损坏：当没缓存，走一次真实刷新
    return null;
  }
}

function writeDiskCache(next: CatalogState): void {
  try {
    fs.mkdirSync(dataDirPath, { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
  } catch (e) {
    console.error('[ModelCatalog] 写缓存失败（非致命）：', String(e));
  }
}

/** 真正去拿一次数据：CLI 枚举 + （仅 opencode）models.dev 元数据 */
async function refreshCatalog(): Promise<CatalogState> {
  // 1) 先枚举：知道「能跑什么」，才知道要去 models.dev 取哪些 provider。
  //    三个 CLI **并行**跑：qodercli 7.5s、codex 7.2s、opencode 1.9s（实测），
  //    串行冷启动要 16s+，并行压到 8s 左右，而且每个都拿到完整的超时预算。
  const refsByAgent: Record<string, string[]> = {};
  const details: Record<string, Record<string, ModelDetail>> = {};
  const defaults: Record<string, string> = {};

  const enumerated = await Promise.all(
    Object.entries(CATALOG_SOURCES).map(async ([agentId, src]) => {
      if (!src.cli) return null;
      const stdout = await runCliEnumeration(src.cli);
      return stdout === null ? null : { agentId, src, stdout };
    })
  );

  for (const hit of enumerated) {
    if (!hit) continue;
    const { agentId, src, stdout } = hit;
    const format = src.format ?? 'provider-model';

    if (format === 'provider-model') {
      refsByAgent[agentId] = parseCliModelRefs(stdout);
      continue;
    }

    const entries: CatalogEntry[] =
      format === 'qoder'
        ? parseQoderModels(stdout)
        : format === 'cursor'
          ? parseCursorModels(stdout)
          : parseCodexModels(stdout);

    // qoder 的 CLI 只吐 Default + Custom（见 QODER_VERIFIED_EXTRA 的说明），
    // 把实测路由通过的 New Models 补上。只在 qoder 分支做，别的影响不到 codex。
    //
    // ⚠️ 必须按 **agentId** 收窄到国际版，不能只判 `format === 'qoder'`：
    // `qoder-cn` 也用同一个解析器，但它是**独立账号体系**，
    // 那些「实测路由通过」的结论全是在国际版账号上得到的 ——
    // 搬到 CN 上就是编数据。档位表同理（见 CATALOG_SOURCES 的说明）。
    if (format === 'qoder' && agentId === 'qoder') {
      mergeQoderVerifiedExtras(entries);
      // 档位表是全局一套（见 QODER_REASONING_LEVELS 的说明），
      // 给**全部** qoder 模型挂上：解析出来的、补充进来的、以及
      // 「CLI 解析失败但补充项仍然在」的场景，一视同仁。
      // 用 ??= 而不是 =：将来若官方开始在 CLI 里吐 per-model 档位，
      // 解析器给的值优先，这里只兜底。
      for (const e of entries) {
        e.reasoning ??= qoderReasoning();
      }
    }

    refsByAgent[agentId] = entries.map(e => e.id);
    const detail: Record<string, ModelDetail> = {};
    for (const e of entries) {
      detail[e.id] = {
        name: e.name,
        description: e.description,
        reasoning: e.reasoning,
      };
    }
    details[agentId] = detail;

    if (format === 'codex-json') {
      // codex 不传 `-m` 时用的是 config.toml 里的 model —— 那是它自己声明的默认值。
      const declared = readCodexDefaultModel();
      if (declared) defaults[agentId] = declared;
    }

    if (format === 'cursor') {
      // cursor 把「当前 / 默认」写在枚举输出的行尾，不用另外读配置文件。
      const declared = parseCursorDefaultModel(stdout);
      if (declared) defaults[agentId] = declared;
    }
  }

  const providerIds = new Set<string>();
  for (const [agentId, refs] of Object.entries(refsByAgent)) {
    if ((CATALOG_SOURCES[agentId]?.format ?? 'provider-model') !== 'provider-model') continue;
    for (const ref of refs) providerIds.add(ref.slice(0, Math.max(1, ref.indexOf('/'))));
  }
  for (const src of Object.values(CATALOG_SOURCES)) {
    for (const p of src.fallbackProviders) providerIds.add(p);
  }

  // 2) 元数据：网络失败就退快照，绝不让整张列表因为网络问题消失
  let providers: Record<string, Record<string, RawProviderModel>> = {};
  try {
    providers = await fetchProviders([...providerIds]);
  } catch (e) {
    console.warn('[ModelCatalog] 拉取 models.dev 失败，使用内置快照：', String(e));
  }
  if (Object.keys(providers).length === 0) {
    providers = { opencode: OPENCODE_CATALOG_SNAPSHOT };
  }

  // 3) CLI 没给出清单（未安装 / 未登录）时，退回 models.dev 里该 provider 的全量。
  //    只对 provider-model 形态有意义 —— qoder / codex 的模型不在 models.dev 里，
  //    拿不到就是拿不到，宁可空列表（前端显示「模型由 Agent 决定」）。
  const agents: Record<string, string[]> = {};
  for (const [agentId, src] of Object.entries(CATALOG_SOURCES)) {
    const refs = refsByAgent[agentId] ?? [];
    const isProviderModel = (src.format ?? 'provider-model') === 'provider-model';
    agents[agentId] = refs.length || !isProviderModel
      ? refs
      : src.fallbackProviders.flatMap(p =>
          Object.keys(providers[p] ?? {}).map(id => `${p}/${id}`)
        );
  }

  const next: CatalogState = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    agents,
    providers,
    details,
    defaults,
  };
  state = next;
  memFetchedAt = next.fetchedAt;
  writeDiskCache(next);
  const counts = Object.entries(agents)
    .map(([id, refs]) => `${id}=${refs.length}`)
    .join(' ');
  console.log(`[ModelCatalog] 已刷新：${counts}`);
  return next;
}

/**
 * 确保目录已加载（内存 → 磁盘 → 真实刷新）。
 *
 * 并发调用共用同一个 Promise：模型列表接口可能被多个会话同时打，
 * 不能因此跑出多次 CLI 子进程。
 */
export function loadCatalog(force = false): Promise<CatalogState> {
  if (!force && state && Date.now() - memFetchedAt < TTL_MS) {
    return Promise.resolve(state);
  }
  if (loading) return loading;

  const disk = force ? null : readDiskCache();
  if (disk) {
    state = disk;
    memFetchedAt = disk.fetchedAt;
    return Promise.resolve(disk);
  }

  loading = refreshCatalog().finally(() => {
    loading = null;
  });
  return loading;
}

/** 后台预热（启动时调用，让第一次打开模型菜单不必等 CLI） */
export function ensureCatalogLoaded(): void {
  if (state) return;
  void loadCatalog().catch(e =>
    console.warn('[ModelCatalog] 预热失败：', String(e))
  );
}

/**
 * 作废缓存并立刻重新枚举。
 *
 * 用户刚在设置页填完某个 provider 的 Key，`opencode models` 能列出的模型
 * 会当场变多 —— 但目录有 24 小时 TTL，不作废的话他得等一天才能看见。
 * 磁盘缓存也一起删掉：只清内存会让下一次 loadCatalog 又把旧的读回来。
 */
export function invalidateCatalog(): void {
  state = null;
  memFetchedAt = 0;
  try {
    fs.rmSync(CACHE_PATH, { force: true });
  } catch {
    // 删不掉也无所谓：内存已清，下一次会重新枚举并覆盖
  }
  ensureCatalogLoaded();
}

/**
 * 某个 Agent 的完整模型列表。
 *
 * 两种拼法：
 * - provider-model（opencode）：`buildModelOptions` 用 models.dev 元数据补出
 *   显示名 / 免费付费 / 上下文，并按 provider 分组排序；
 * - qoder / codex：`buildListOptions` 只用 CLI 自己给的显示名与描述，
 *   **保持来源顺序、不标角标**（没有价格数据就不标）。
 */
export async function getModelsForAgent(agentId: string): Promise<ModelOption[]> {
  const src = CATALOG_SOURCES[agentId];
  if (!src) return [];
  const st = await loadCatalog();
  const refs = st.agents[agentId] ?? [];
  if ((src.format ?? 'provider-model') !== 'provider-model') {
    return buildListOptions(refs, st.details?.[agentId]);
  }
  return buildModelOptions(refs, st.providers);
}

/**
 * 该 Agent 的 CLI **自己声明的**默认模型（如 codex 的 `~/.codex/config.toml`）。
 *
 * 与 `definitions.ts` 里的静态 `defaultModel` 分工：静态那份是我们写死的
 * （opencode 的 `zai/glm-4.7`），这份是用户/CLI 自己的配置。两者都没有时
 * 返回 undefined，前端会退化成「列表第一条」，不会瞎填一个模型名。
 */
export async function getDefaultModelForAgent(agentId: string): Promise<string | undefined> {
  if (!CATALOG_SOURCES[agentId]) return undefined;
  const st = await loadCatalog();
  return st.defaults?.[agentId];
}

/**
 * 这个模型是否属于该 Agent 的动态目录（**同步**，只查内存）。
 *
 * 供 `model-routing` 做合法性校验：用户从菜单里选的模型可能不在静态白名单里，
 * 但确实在 CLI 枚举出的清单里 —— 不认它就会被静默换成默认模型，
 * 那正是「假控件」的另一种形态。
 *
 * 目录尚未加载时返回 `false`（fail-closed）：宁可回退到已验证的默认模型，
 * 也不把一个来路不明的模型名塞给 CLI。启动时 `ensureCatalogLoaded()`
 * 已经把这段窗口压到很小。
 */
export function isCatalogModel(agentId: string, modelId: string): boolean {
  const refs = state?.agents[agentId];
  return refs ? refs.includes(modelId) : false;
}

/**
 * 目录概况：给「设置 → 模型清单」那一屏用。
 *
 * 只报告**已经枚举到的**东西，不触发任何 CLI 子进程 —— 设置页每次打开都
 * 去跑一遍 `qodercli`（7.5s）是不可接受的。需要真刷新时走 `invalidateCatalog()`
 * + `loadCatalog(true)`，那是用户主动点的动作。
 *
 * `fetchedAt` 是这轮枚举的完成时间，不是文件 mtime：磁盘缓存被外部改过也不影响语义。
 */
export function getCatalogSummary(): {
  fetchedAt: number;
  counts: Record<string, number>;
} {
  if (!state) return { fetchedAt: 0, counts: {} };
  const counts: Record<string, number> = {};
  for (const [agentId, refs] of Object.entries(state.agents)) {
    counts[agentId] = refs.length;
  }
  return { fetchedAt: state.fetchedAt, counts };
}

/** 仅测试用：直接注入目录状态 */
export function __setCatalogStateForTest(next: CatalogState | null): void {
  state = next;
  memFetchedAt = next?.fetchedAt ?? 0;
}
