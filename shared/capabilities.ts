/**
 * 过程能力档（P2）—— 「这个组合到底能不能给出某类过程事件」的唯一口径。
 *
 * ## 为什么不能按 Agent 记
 *
 * 以前能力清单是 `AgentDescriptor.eventCapabilities`，一个 Agent 一份。可同一个
 * Codex 接官方模型、直连第三方、走本地 CLI，是三种完全不同的事件形态：
 *   · 官方 responses 给 reasoning summary；
 *   · 第三方 chat 兼容层经常把 reasoning 丢掉；
 *   · 走 CLI 时还要看这个版本有没有开 `--json`。
 * 按 Agent 记，就等于把三种情况压成一个乐观答案 —— 清单一旦乐观，界面就会画
 * 一个永远空着的折叠条，这比不画更糟。
 *
 * 所以能力档的 key 是三元组：**引擎 · 模型 · 网关**。
 *   · engine  —— 引擎家族，就是 Agent 的稳定 id（codex / claude / opencode…）
 *   · model   —— 模型 id；引擎自带默认模型时可以缺省
 *   · gateway —— 请求实际走哪条路：官方端点 / 自定义 baseUrl / 本地子进程
 *
 * ## declared / observed / probed 三档
 *
 *   declared —— 定义表写的（静态，可能过期或撒谎）
 *   observed —— 这一轮**真的出现过**的事件能力（投影器数出来的事实）
 *   probed   —— 真实跑一次 CLI 标定出来的结果（P3；缺省 = 没标定过）
 *
 * 界面必须以 observed 为准：declared 只用来回答「本该有什么」，
 * 不能用来决定「画什么」。三档分开存，就是为了让「清单说有、实际一次都没给」
 * 这件事在界面上能说出来，而不是靠猜。
 */

/**
 * 事件能力：这个 Agent 能把「过程」暴露到什么粒度。
 *
 * 与业务能力（chat / code / write…）是两件事：一个能写代码的 Agent 完全可能
 * 只吐纯文本。`text` / `done` / `error` 是所有适配器都能给的最小公共集，不列在这里。
 */
export type EventCapability =
  | 'thinking'          // 思考过程原文
  | 'thinking_summary'  // 只给推理摘要（codex 的 reasoning summary）
  | 'tool'              // 工具调用与结果
  | 'tool_output'       // 工具执行中的增量输出
  | 'usage'             // token 用量
  | 'cost'              // 费用
  | 'permission';       // 反向权限请求

/**
 * 过程能力的稳定展示顺序：按「过程从内到外」排，不按字母。
 *
 * 为什么放在 shared：投影器要用它给 observed 排序（同一组能力必须永远产出
 * 同一个数组，否则落库与断线重放会出现「同样的 run 两种顺序」），界面要用它
 * 排 chip。两处各写一份就一定会漂。
 */
export const EVENT_CAPABILITY_ORDER: EventCapability[] = [
  'thinking',
  'thinking_summary',
  'tool',
  'tool_output',
  'permission',
  'usage',
  'cost',
];

/** 能力档的 key：引擎 · 模型 · 网关 */
export interface CapabilityKey {
  /** 引擎家族（Agent 的稳定 id，如 `codex`） */
  engine: string;
  /** 模型 id；缺省 = 使用该引擎的默认模型 */
  model?: string;
  /**
   * 请求实际走的路：
   *   `official:<host>` —— 厂商官方端点
   *   `custom:<host>`   —— 用户填的自定义 baseUrl（第三方 / 桥接）
   *   `local:<kind>`    —— 本地子进程（cli / sdk / acp / mock）
   */
  gateway: string;
}

/** 一次真实标定的结果（P3） */
export interface CapabilityProbe {
  capabilities: EventCapability[];
  /** 标定时刻（毫秒）。过期判断由调用方按自己的 TTL 做，这里只记事实 */
  at: number;
}

/**
 * 标定结果的保鲜期。
 *
 * 为什么是 7 天而不是「永不过期」：能力取决于那个网关上**当前**挂着什么模型，
 * 以及 CLI 有没有升级。这两件事都不在本地手里 —— 昨天的结论不能替今天背书。
 * 也不能太短：一次标定要真起 CLI、真花 token，按小时过期等于把用户当免费额度。
 *
 * 过期只影响「要不要重新标定」，**不影响已标定事实的展示** ——
 * `probe.at` 会一起下发，界面可以写「X 天前实测」。
 */
export const CAPABILITY_PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 一个 run 的过程能力档 */
export interface CapabilityProfile {
  key: CapabilityKey;
  /** 定义表声明的；缺省 = 没声明（未知），**不是**「不支持」 */
  declared?: EventCapability[];
  /** 这一轮真的出现过；run_start 时缺省，run_end 时必定给出（可能是空数组） */
  observed?: EventCapability[];
  /** 真实 CLI 标定的结果；缺省 = 没标定过 */
  probed?: CapabilityProbe;
}

/** 落库 / 缓存用的稳定字符串键 */
export function capabilityKeyString(key: CapabilityKey): string {
  return `${key.engine}|${key.model ?? ''}|${key.gateway}`;
}

/** 按展示顺序归一（去重 + 排序），保证同一组能力只有一个形状 */
export function sortCapabilities(list: Iterable<EventCapability>): EventCapability[] {
  const set = new Set(list);
  return EVENT_CAPABILITY_ORDER.filter(c => set.has(c));
}
