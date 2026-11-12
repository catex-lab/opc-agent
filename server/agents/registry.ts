/**
 * Agent 注册表。
 *
 * 启动时按定义表实例化所有 Provider，并维护探测结果缓存。
 * 上层（HTTP 层、群聊编排层）只通过这里拿 Agent。
 *
 * 设计取舍：探测是「有副作用」的（ACP 要起进程、SDK 要走一次鉴权），
 * 所以做了两级缓存 —— 内存态 + TTL。默认 TTL 内不重复探测，
 * 显式调用 probeAll(true) 才强制刷新。
 */

import { AGENT_DEFS, RETIRED_AGENT_IDS, findDef, eventSourceOf } from './definitions.js';
import type { AgentDefinition } from './definitions.js';
import { createProvider, AcpAdapter } from './adapters/index.js';
import { familyHintsFor } from './familyHints.js';
import { installEnv } from './installEnv.js';
import { recoveryHintFor, appendFailureAdvice } from './recovery.js';
import { getModelsForAgent, mergeModelOptions, type ModelOption } from './modelCatalog.js';
import { permissionSupportFor } from './permissions.js';
import { toAgentInfo, unknownStatus } from './types.js';
// A160：Agent 自定义 Logo（用户上传）。映射在 data/agent-appearance.json，
// 不改定义表 —— 恢复默认 = 删映射。
import { getAgentLogoUrl } from '../avatar-store.js';
// A115：用户资料注入（昵称 → systemPrompt）。见 withUserIdentity 的注释。
import { withUserIdentity } from '../user-profile.js';
// A209：回答语言偏好的唯一读取点。适配器不各自读 prefs，避免「有的通道生效、
// 有的不生效」这种没有报错的静默分歧。
import { loadAnswerLanguage } from '../answer-language.js';
import type { EventSource } from '../../shared/blocks.js';
import type {
  AgentDescriptor,
  AgentInfo,
  AgentProvider,
  AgentStatus,
  InstallEnv,
  PermissionDecision,
  AgentEvent,
  SendContext,
} from './types.js';

/** 探测结果缓存有效期 */
const PROBE_TTL_MS = 5 * 60 * 1000;

/** 探测并发上限：ACP 要起 Python 进程，SDK 要走网络，一次性全开会很慢 */
const PROBE_CONCURRENCY = 2;

/**
 * 启动后延迟多久再开始全量探测。
 *
 * 窗口刚起来时最需要资源：渲染首帧、加载会话、用户往往在几秒内就发第一条
 * 消息。这时候 15 个 Agent 一起探（每个都 spawn 子进程）会把首字拖慢。
 * 实测启动瞬间能看到挂死的 `gemini version` / `codebuddy-headless` 在抢 CPU。
 * 让出 5 秒，等窗口 idle 之后再探。
 */
const PROBE_START_DELAY_MS = 5_000;

/**
 * 单 Agent 探测的**硬预算**（A177）。
 *
 * 这里给的是「到点就按未知放行」的上限，不再是「等到 SDK 自己放弃」：
 * - CLI：版本探测单参数 3 秒 + 后端可达性 2.5 秒，12 秒足够；
 * - ACP：拉起 Python 并完成 initialize，本机实测常在 20 秒上下；
 * - SDK（WorkBuddy/CodeBuddy）：initialize 60 秒超时 + 31 秒重试的旧预算
 *   （120/45 秒）会直接挡在首字前面。探测只负责「能不能用」的粗略判断，
 *   20 秒拿不到就降级为「状态未知」，真正的调用由用户发消息时的运行时决定。
 */
const SINGLE_PROBE_TIMEOUT_MS = 12_000;
const ACP_PROBE_TIMEOUT_MS = 20_000;
const SDK_PROBE_TIMEOUT_MS = 20_000;

/**
 * 群聊这类「先确认成员状态」的等待上限。
 * 超过就按「状态未知但可发」继续，绝不让一轮对话无限挂着。
 */
const ENSURE_PROBED_BUDGET_MS = 3_000;
/** 前端可显式指定预算，但不允许无限等 */
export const MAX_SINGLE_PROBE_TIMEOUT_MS = 180_000;

/** 单 Agent 探测的失败分类。只有这四类，前端不需要猜。 */
export type ProbeFailureReason = 'timeout' | 'not-found' | 'permission' | 'unknown';

export interface SingleProbeResult {
  agentId: string;
  /** 探测动作本身是否正常完成（`not-installed` 也算完成，原因里标 not-found） */
  ok: boolean;
  status: AgentStatus;
  durationMs: number;
  probedAt: string;
  reason?: ProbeFailureReason;
  error?: string;
}

/**
 * A177：agentId 只允许小写字母、数字与连字符。
 *
 * 内置 id（workbuddy / doubao / ...）与自建 id（custom-xxxxxxxx）都满足。
 * 这个校验发生在**任何路径拼接之前**，且探测链路本身不使用 agentId 拼路径，
 * 因此 `../`、盘符、斜杠、百分号编码一律在入口被拒。
 */
export function isValidAgentId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/**
 * 把一次已完成的探测结果归类为四种失败原因之一（A177）。
 *
 * 只在**探测动作失败**时返回原因；`not-installed` 是「探测成功、Agent 不在本机」，
 * 但对调用方来说仍属于 not-found，所以也给出。
 */
export function classifyProbeFailure(status: AgentStatus): ProbeFailureReason | undefined {
  if (status.probeState === 'timeout') return 'timeout';

  const message = status.message ?? '';
  if (status.availability === 'not-installed') return 'not-found';
  if (/ENOENT|not found|未找到|未安装|CLI not found/i.test(message)) return 'not-found';
  if (/EACCES|EPERM|permission denied|拒绝访问|无权限|没有权限/i.test(message)) return 'permission';
  if (/Request timeout|timed out|timeout|超时/i.test(message)) return 'timeout';
  if (status.availability === 'unknown') return 'unknown';
  return undefined;
}

/**
 * 把「这次探测的结果」落到 `lastError` 上，让名册页不用点进详情就能看到
 * 上次失败是什么。
 *
 * 只改这一个字段，**不动 availability**（状态机保持原样）：
 *   - ready / unsupported / not-installed：清掉上一次的失败原因。
 *     「没装」本身就是名册上的既定状态，不算一次失败，别让每个未安装的
 *     Agent 都挂一行红字；
 *   - 其它非 ready（未登录 / 探测超时 / 需要修复 / 网络不可达）：把探测文案
 *     镜像到 lastError。
 */
export function withProbeOutcome(status: AgentStatus): AgentStatus {
  if (
    status.availability === 'ready' ||
    status.availability === 'unsupported' ||
    status.availability === 'not-installed'
  ) {
    if (!status.lastError) return status;
    const { lastError: _dropped, ...rest } = status;
    return rest;
  }
  if (!status.message || status.lastError === status.message) return status;
  return { ...status, lastError: status.message };
}

class AgentRegistry {
  private providers = new Map<string, AgentProvider>();
  private statuses = new Map<string, AgentStatus>();
  private probedAt = new Map<string, number>();
  /**
   * 正在进行中的探测。
   *
   * 为什么必须去重：探测是有副作用的（ACP 要起 Python 进程、SDK 要走鉴权）。
   * 启动后台探测、名册首次拉取、群聊前的可用性校验都可能同时要求探测同一个
   * Agent，没有这张表就会并发起多个 ACP 进程，互相抢 stdio 并留下孤儿进程。
   */
  private inflight = new Map<string, Promise<AgentStatus>>();
  /** 是否已经完成过至少一轮全量探测 */
  private probedOnce = false;
  /**
   * 已经做过「用前凭据校验」的会话。
   *
   * 触发点刻意克制：每个会话只在**第一次发消息**时校验一次，之后不再读盘；
   * 手动「重新探测」走 probeSingle，是另一条显式路径。这样既不会每条消息
   * 都校验，也不会拖垮首字延迟（三个适配器的校验都只是读一个小文件）。
   */
  private credentialChecked = new Set<string>();
  /** 与上面的 Set 配套的淘汰顺序（防止会话数无限增长） */
  private credentialCheckedOrder: string[] = [];
  /** 本机安装前置条件（A71）：启动时预热，toInfo 同步读取 */
  private installEnvCache?: InstallEnv;

  constructor() {
    for (const def of AGENT_DEFS) {
      // A150：暂时下架的条目**不实例化**（见 RETIRED_AGENT_IDS 的注释）。
      // 必须在 createProvider 之前 continue：只要进了 providers，就会同时进
      // list()（名册）、probeAll()（每轮都去探一次）和 get()（详情 404 失效），
      // 三者是同一个 Map 派生的，事后过滤必然漏掉一处。
      if (RETIRED_AGENT_IDS.includes(def.descriptor.id)) continue;
      try {
        this.providers.set(def.descriptor.id, createProvider(def));
      } catch (err) {
        console.error(
          `[Registry] 实例化 ${def.descriptor.id} 失败:`,
          (err as Error).message
        );
      }
    }
    console.log(`[Registry] 已注册 ${this.providers.size} 个 Agent`);
    // A71：安装前置条件（Node / PowerShell）在构造时就探好。
    //
    // 为什么必须在构造函数里：`GET /api/agents` 在冷启动时走的是
    // `ensureProbedInBackground()` + `registry.list()` 这条**不等探测完成**的路
    // （ACP 握手要 20 秒以上，等它名册就空了）。如果只在 `probeAll()` 里赋值，
    // 第一次拉名册时缓存还是空的，「本机没 Node」这行提示就永远不出来。
    //
    // 为什么可以直接同步赋值：`installEnv()` 只做 PATH 查找、不起子进程
    // （第一版用 `node -v` 取版本号，spawn 一旦不返回就让整个 promise 挂住，
    //  缓存永远不写 —— 一个可选的美化信息把必要的功能拖死了）。
    this.installEnvCache = installEnv();
  }

  /** 全部 Agent 的 描述 + 状态 */
  list(): AgentInfo[] {
    const out: AgentInfo[] = [];
    for (const [id, provider] of this.providers) {
      const status = this.statuses.get(id) ?? unknownStatus();
      out.push(this.toInfo(id, provider.descriptor, status));
    }
    return out;
  }

  get(id: string): AgentInfo | undefined {
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    return this.toInfo(
      id,
      provider.descriptor,
      this.statuses.get(id) ?? unknownStatus()
    );
  }

  /** 只判断是否存在，不组装 AgentInfo（A177：避免单探测链路顺带读别名册信息） */
  hasAgent(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * 统一的「描述 + 状态 + 权限能力」组装。
   *
   * 把 `permissionSupport` 挂在这里而不是 `toAgentInfo()`，是为了避免
   * `types.ts → permissions.ts → types.ts` 的循环依赖。
   */
  private toInfo(
    id: string,
    descriptor: AgentDescriptor,
    status: AgentStatus
  ): AgentInfo {
    // 端点主机从定义层的 `backendHosts` 派生，**不在 descriptor 里再抄一份**：
    // 这份数据是给用户看「请求打到哪」的，两份来源必然漂移，漂了就是骗人。
    const hosts = findDef(id)?.backendHosts;
    // 同族条目同理：资料页要回答「这两个 Kimi 是不是一回事」，答案取决于**对方**的
    // 账号体系，单个 descriptor 看不到别人。后端本来就持有全表，算一次给出去。
    const family = descriptor.family;
    const peers = family
      ? AGENT_DEFS.filter(d => d.descriptor.family === family && d.descriptor.id !== id).map(d => ({
          id: d.descriptor.id,
          name: d.descriptor.name,
          ...(d.descriptor.authScope ? { authScope: d.descriptor.authScope } : {}),
          ...(d.descriptor.regionName ? { regionName: d.descriptor.regionName } : {}),
        }))
      : [];
    // A69：同厂「另一个版本」的本地痕迹与 zcode 的上次请求。
    // 探测本身有缓存（30s TTL），不会每次刷新名册都开一次 sqlite。
    // 只在真的探测到时挂字段 —— 探不到就不出现，不写「未知」占位。
    const hints = familyHintsFor(id);
    const env = this.installEnvFor(descriptor);
    // A156：SDK 厂商只下发**显式写了**的那些；缺省仍是 Tencent SDK，
    // 前端把「缺字段」当 tencent 处理，与旧版本响应兼容。
    const sdkProvider = findDef(id)?.sdk?.provider;
    // A160：自定义 Logo 只挂**有值**的；缺字段 = 用内置 icon，与老响应兼容。
    const logoUrl = getAgentLogoUrl(id);
    return {
      ...toAgentInfo(descriptor, status),
      ...(sdkProvider && descriptor.kind === 'sdk' ? { sdkProvider } : {}),
      ...(logoUrl ? { logoUrl } : {}),
      ...(hosts && hosts.length > 0 ? { endpointHosts: hosts } : {}),
      ...(peers.length > 0 ? { familyPeers: peers } : {}),
      ...(hints?.localSiblings && hints.localSiblings.length > 0
        ? { localSiblings: hints.localSiblings }
        : {}),
      ...(hints?.lastRequest ? { lastRequest: hints.lastRequest } : {}),
      // 每个 Agent 一句「怎么恢复」：名册与详情页的非 ready 状态都能直接给下一步。
      recoveryHint: recoveryHintFor(id),
      permissionSupport: permissionSupportFor(id),
      ...(env ? { installEnv: env } : {}),
    };
  }

  /**
   * 只挂**这一条真正需要**的那一项（A71）。
   *
   * 为什么不整份下发：`requires:'node'` 的条目看到 `powershell` 是噪声，
   * 而且 14 条各带一份完整对象，接口体积会白涨一倍。
   * 拿不到缓存就返回 undefined —— 界面据此不显示「本机缺 Node」这种话，
   * 而不是显示一个猜出来的结论。
   */
  private installEnvFor(descriptor: AgentDescriptor): InstallEnv | undefined {
    const need = descriptor.install?.requires;
    if (!need || need === 'none') return undefined;
    const env = this.installEnvCache;
    if (!env) return undefined;
    if (need === 'node' && env.node) return { node: env.node };
    if (need === 'powershell' && env.powershell) return { powershell: env.powershell };
    return undefined;
  }

  getProvider(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * 注册一条用户自建 Agent（A114）。
   *
   * 为什么是运行时方法而不是构造函数里遍历：registry 是模块级单例，
   * **在 import 时就构造完了**，而自建 Agent 的定义来自
   * `data/custom-agents.json`（要读盘）。启动时由 server/index.ts 逐个调，
   * 设置页新建后也调同一个方法 —— 不必重启应用就能用上。
   *
   * 只往 `providers` 里加，**不**主动探测：探测是有副作用的（要走一次网络），
   * 而 `/api/agents` 冷启动那条路本来就是「后台探 + 本次按缓存返回」。
   * 由调用方决定要不要立刻 `probeOne(id, true)`。
   */
  registerCustom(def: AgentDefinition): void {
    const id = def.descriptor.id;
    if (this.providers.has(id)) return; // 幂等：重复注册不覆盖已有实例
    try {
      this.providers.set(id, createProvider(def));
      // 新条目没有探测记录，状态给 unknown 而不是沿用上一次的旧状态
      this.statuses.delete(id);
      this.probedAt.delete(id);
    } catch (err) {
      console.error(`[Registry] 注册自建 Agent ${id} 失败:`, (err as Error).message);
    }
  }

  /** 注销一条自建 Agent。删配置时调，避免删完还能在名册里点到它 */
  unregisterCustom(id: string): void {
    this.providers.delete(id);
    this.statuses.delete(id);
    this.probedAt.delete(id);
    this.inflight.delete(id);
  }

  /**
   * A211：切换 WorkBuddy 产品 profile 时**重建**适配器。
   *
   * 为什么不能只改一个变量：SdkAdapter 在构造时把 runtime（environment /
   * endpoint / CODEBUDDY_CONFIG_DIR）算进 `this.runtime`，并按会话缓存常驻
   * CLI 进程（slots）。那些进程启动时就继承了旧配置根与旧 token —— 只改状态
   * 会留下「界面显示新版本、实际还在用旧凭据」的假切换，正是
   * definitions.ts:1695 里「切了等于没切」的那类缺陷。
   *
   * 先 dispose()（closeEntry 逐个关掉 CLI 进程）再按同一份定义表重建，并清掉
   * 探测状态与时间戳，让下一轮探测真的用新参数跑一次。
   */
  replaceProvider(id: string): boolean {
    const def = findDef(id);
    if (!def) return false;
    try {
      const old = this.providers.get(id);
      try {
        old?.dispose?.();
      } catch (err) {
        console.error(`[Registry] 回收 ${id} 旧适配器失败:`, (err as Error).message);
      }
      this.providers.set(id, createProvider(def));
    } catch (err) {
      console.error(`[Registry] 重建 ${id} 适配器失败:`, (err as Error).message);
      return false;
    }
    this.statuses.delete(id);
    this.probedAt.delete(id);
    this.inflight.delete(id);
    return true;
  }

  /**
   * 某个 Agent 可用的模型（用于前端模型选择）。
   *
   * 优先级：ACP Agent 运行时上报的模型 > 静态白名单 + 动态目录。
   *
   * 动态目录（`modelCatalog.ts`）解决的是「白名单只有几条、而 CLI 实际能跑
   * 几十条」的问题：opencode 的清单来自它自己的 `opencode models`，
   * 元数据（显示名 / 免费付费 / 上下文）来自 models.dev。白名单里的项
   * 仍然排在最前 —— 那几条是逐个真实调用验证过的。
   *
   * 两者都没有就返回空数组 —— 空数组对前端意味着「不显示模型下拉」，
   * 这比硬塞一份 SDK 的模型列表要诚实：那些模型名对该 Agent 毫无意义，
   * 选中后只会让调用直接失败。
   */
  async modelsFor(id: string): Promise<ModelOption[]> {
    const def = findDef(id);

    // ACP Agent 上报的 availableModels **不等于客户端能切换**。
    // 实测 hermes-acp 的 session/set_model 对任意 modelId（包括
    // `__nonsense_model__`）都返回 ok，既不校验也不生效 —— 把它做成下拉
    // 就是一个假控件：用户以为切到了 claude-sonnet-5，实际什么都没变，
    // 还会把无意义的 model 值写进会话记录。所以只有显式声明
    // modelSelection: 'client'（即我们确实会调用 set_model 并验证过）时才暴露。
    if (def?.modelSelection === 'client') {
      const p = this.providers.get(id);
      if (p instanceof AcpAdapter && p.availableModels.length > 0) {
        return p.availableModels;
      }
    }

    const declared = def?.models ?? [];
    const catalog = await getModelsForAgent(id);
    if (catalog.length === 0) {
      return declared.map(modelId => ({ modelId, name: modelId }));
    }
    return mergeModelOptions(declared, catalog);
  }

  private isFresh(id: string): boolean {
    const at = this.probedAt.get(id);
    if (at === undefined) return false;
    if (!this.statuses.has(id)) return false;
    return Date.now() - at < PROBE_TTL_MS;
  }

  /**
   * P1：给调用方一个「需不需要等探测」的廉价判断。
   * 只在缓存缺失/过期时返回 true，用于在 SSE 头之后决定要不要先发一条
   * 「正在检查成员状态」——缓存热的时候不该每轮都制造一条噪声 note。
   */
  needsProbe(ids: string[]): boolean {
    return ids.some(id => !this.isFresh(id));
  }

  /**
   * 内部：真正跑一次探测并把结果写回**目标 Agent** 的缓存。
   *
   * A177 的隔离性基座：全量探测与单 Agent 探测都只走这一个函数，
   * 它只接收一个 `id`，没有「顺手把别人也探一遍」的分支。
   * `probeAll()` 是循环调用 `probeOne()`，**不是**反过来。
   */
  private startProbe(id: string, provider: AgentProvider): Promise<AgentStatus> {
    const task = (async (): Promise<AgentStatus> => {
      const budget = this.probeBudgetFor(provider);
      const live = provider.probe().catch((err: unknown): AgentStatus => {
        const message = (err as Error)?.message || String(err);
        return {
          availability: 'unknown',
          installed: false,
          message: `探测失败：${message}`,
          probeState: 'probe-failed',
          probedAt: new Date().toISOString(),
        };
      });

      // 硬超时：探测**只是状态判断**，不能成为发消息的前置阻塞。
      // 到点先按「未知」放行；底层探测若之后真的回来，再覆盖成真实结果。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<AgentStatus>(resolve => {
        timer = setTimeout(() => {
          resolve({
            availability: 'unknown',
            installed: this.statuses.get(id)?.installed ?? false,
            message: `探测超过 ${Math.round(budget / 1000)} 秒未返回，状态未知（可直接发消息）`,
            probeState: 'timeout',
            probedAt: new Date().toISOString(),
          });
        }, budget);
      });

      const status = await Promise.race([live, timeout]);
      if (timer) clearTimeout(timer);

      if (status.probeState === 'timeout') {
        // 超时标记不写 probedAt：下一轮仍应重试，不能被 5 分钟 TTL 冻住
        this.statuses.set(id, withProbeOutcome(status));
        void live.then(real => {
          this.statuses.set(id, withProbeOutcome(real));
          this.probedAt.set(id, Date.now());
        }).catch(() => {});
        return status;
      }

      this.statuses.set(id, withProbeOutcome(status));
      this.probedAt.set(id, Date.now());
      return status;
    })().finally(() => {
      // 只清自己这一条；不同 agentId 的 inflight 互不影响
      this.inflight.delete(id);
    });

    this.inflight.set(id, task);
    return task;
  }

  /** 按 Agent 类型给探测硬预算：SDK 不再沿用 120/45 秒的冷启动长预算 */
  private probeBudgetFor(provider: AgentProvider): number {
    switch (provider.descriptor.kind) {
      case 'sdk':
        return SDK_PROBE_TIMEOUT_MS;
      case 'acp':
        return ACP_PROBE_TIMEOUT_MS;
      default:
        return SINGLE_PROBE_TIMEOUT_MS;
    }
  }

  /** 复用进行中的探测（同一 Agent 并发点击只起一次进程） */
  private probeTask(id: string, provider: AgentProvider): Promise<AgentStatus> {
    return this.inflight.get(id) ?? this.startProbe(id, provider);
  }

  /** 探测单个 Agent（同一 Agent 的并发探测会复用同一个 Promise） */
  async probeOne(id: string, force = false): Promise<AgentInfo | undefined> {
    const provider = this.providers.get(id);
    if (!provider) return undefined;

    if (!force && this.isFresh(id)) return this.get(id);

    await this.probeTask(id, provider);
    return this.get(id);
  }

  /**
   * A177：单 Agent 探测（供 `POST /api/agents/:agentId/probe` 使用）。
   *
   * 与 `probeOne` 的关键差别：
   * 1. **不调用 `get()`/`toInfo()`** —— 那会触发 `familyHintsFor(id)`，
   *    顺带扫描同厂其它配置目录。单探测期间只允许碰目标 Agent。
   * 2. **带可控超时**。超时后只写目标 Agent 的缓存与时间戳，其它 Agent 不动。
   * 3. **绝不兜底调 `probeAll()`**。调用链固定为
   *    `probeSingle → probeTask/startProbe → provider.probe()`。
   */
  async probeSingle(
    id: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<SingleProbeResult | undefined> {
    const provider = this.providers.get(id);
    if (!provider) return undefined;

    const started = Date.now();
    const hadProbe = this.probedAt.has(id);
    const timeoutMs = this.singleProbeTimeoutFor(provider, hadProbe, opts.timeoutMs);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const task = this.probeTask(id, provider);
    const winner = await Promise.race([
      task.then(status => ({ kind: 'done' as const, status })),
      timeoutPromise.then(kind => ({ kind } as const)),
    ]);
    if (timer) clearTimeout(timer);

    const durationMs = Date.now() - started;

    if (winner.kind === 'timeout') {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      const status: AgentStatus = {
        availability: 'unknown',
        installed: this.statuses.get(id)?.installed ?? false,
        message: `探测超时：已等待 ${seconds} 秒仍未返回`,
        probeState: 'timeout',
        probedAt: new Date().toISOString(),
      };
      // 只写目标 Agent；底层探测若后来返回，会以真实结果覆盖这条超时标记
      const marked = withProbeOutcome(status);
      this.statuses.set(id, marked);
      this.probedAt.set(id, Date.now());
      return {
        agentId: id,
        ok: false,
        status: marked,
        durationMs,
        probedAt: status.probedAt,
        reason: 'timeout',
        error: status.message,
      };
    }

    const status = winner.status;
    const reason = classifyProbeFailure(status);
    return {
      agentId: id,
      ok: reason !== 'timeout' && reason !== 'permission' && reason !== 'unknown',
      status,
      durationMs,
      probedAt: status.probedAt,
      ...(reason ? { reason } : {}),
      ...(reason ? { error: status.message } : {}),
    };
  }

  /** 按 Agent 类型给单探测预算：SDK 冷启动明显更慢，不能和 CLI 用同一档 */
  private singleProbeTimeoutFor(
    provider: AgentProvider,
    hadProbe: boolean,
    requested?: number
  ): number {
    if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
      return Math.min(Math.floor(requested), MAX_SINGLE_PROBE_TIMEOUT_MS);
    }
    // `hadProbe` 不再区分冷/热：SDK 的 60s+31s 长预算已被硬超时取代，
    // 留参是为了不改变调用方签名（前端仍可按需传 requested）。
    void hadProbe;
    switch (provider.descriptor.kind) {
      case 'sdk':
        return SDK_PROBE_TIMEOUT_MS;
      case 'acp':
        return ACP_PROBE_TIMEOUT_MS;
      default:
        return SINGLE_PROBE_TIMEOUT_MS;
    }
  }


  /**
   * 探测全部 Agent（带并发上限）。
   * @param force 忽略 TTL 强制重探
   */
  async probeAll(force = false): Promise<AgentInfo[]> {
    // 首轮全量探测让窗口先 idle 5 秒，别和首帧/首批消息抢进程资源。
    // 显式 force（用户在设置里点「重新探测」）不等。
    if (!force && !this.probedOnce) {
      // 不能 unref：这个延迟是「本轮探测的前半段」，不是可丢弃的装饰。
      // unref 之后如果进程里暂时没有别的句柄，Node 会直接退出，
      // 首轮探测就再也不会发生（闸门脚本里实测 exit 13）。
      await new Promise<void>(resolve => setTimeout(resolve, PROBE_START_DELAY_MS));
    }
    const ids = [...this.providers.keys()];
    const queue = [...ids];
    const workers = Array.from(
      { length: Math.min(PROBE_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length) {
          const id = queue.shift()!;
          await this.probeOne(id, force);
        }
      }
    );
    await Promise.all(workers);
    // A71：顺手刷新安装环境（60s 缓存，多数时候是空操作）
    this.installEnvCache = installEnv();
    this.probedOnce = true;
    return this.list();
  }

  /** 是否已经完成过至少一轮探测（否则名册里全是 unknown） */
  hasProbedOnce(): boolean {
    return this.probedOnce;
  }

  /**
   * 若尚未探测过，就在后台起一轮。
   *
   * 为什么不 await：ACP 握手要 20 秒以上，把首次名册请求挂在那里，
   * 用户会看到一个长时间空白的通讯录。这里只负责「把探测启动起来」，
   * 前端轮询拿结果。
   */
  ensureProbedInBackground(): void {
    if (this.probedOnce || this.inflight.size > 0) return;
    void this.probeAll().catch(err =>
      console.error('[Registry] 后台探测失败:', (err as Error).message)
    );
  }

  /**
   * 确保指定 Agent 的状态是新鲜的（供群聊这类「必须先知道谁能用」的场景）。
   * 已新鲜的直接命中缓存，不会重复起进程。
   *
   * 带**总预算**：到点没探完就按「未知但可发」放行并返回 timedOut。
   * 群聊不应该因为某个成员冷启动慢（比如 SDK 的 initialize）把整轮挂住。
   */
  async ensureProbed(
    ids: string[],
    budgetMs = ENSURE_PROBED_BUDGET_MS
  ): Promise<{ timedOut: string[] }> {
    const targets = ids.filter(id => this.providers.has(id));
    if (!targets.length) return { timedOut: [] };
    // 全都新鲜：零等待
    if (!targets.some(id => !this.isFresh(id))) return { timedOut: [] };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), budgetMs);
    });
    const done = Promise.all(
      targets.map(id => this.probeOne(id).then(() => null).catch(() => null))
    ).then(() => 'done' as const);

    const winner = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    if (winner === 'done') return { timedOut: [] };

    const timedOut = targets.filter(id => !this.isFresh(id));
    for (const id of timedOut) {
      const prev = this.statuses.get(id);
      // 不写 probedAt：下一轮还会重试；这一轮只保证「能继续发」
      this.statuses.set(
        id,
        withProbeOutcome({
          ...(prev ?? {}),
          availability: 'unknown',
          installed: prev?.installed ?? false,
          message:
            `成员状态检查超过 ${Math.round(budgetMs / 1000)} 秒，暂按未知处理（不影响发送）。` +
            (prev?.message ? `上一次结果：${prev.message}` : ''),
          probeState: 'timeout',
          probedAt: new Date().toISOString(),
        } as AgentStatus)
      );
    }
    return { timedOut };
  }

  /** 把运行时错误回写到状态里，让名册页能显示「上次为什么失败」 */
  recordError(id: string, message: string): void {
    const prev = this.statuses.get(id);
    if (!prev) return;
    // 运行期失败同样要可执行：401/403 → 重新登录，429 → 额度/限流，ENOENT → 未安装。
    const annotated = appendFailureAdvice(id, message);
    this.statuses.set(id, { ...prev, lastError: annotated });
  }

  /**
   * 把一次调用转成事件流（统一入口，供 /api/chat 使用）
   *
   * A115：`systemPrompt` 在这里过一次 `withUserIdentity()` —— 用户资料
   * （昵称）注入的**唯一**入口。选注册表而不是逐个适配器：适配器有五个
   * （sdk / http / acp / qoder-sdk / mock），漏一个就变成「有的 Agent
   * 认得我、有的不认得」，而这种不一致没有任何报错，只有用户会发现。
   *
   * A209：回答语言也在这里定（`answerLanguage`），但**不直接改 systemPrompt**：
   * SDK 在 systemPrompt 为空时会回落到自己的 DEFAULT_SYSTEM_PROMPT，注册表
   * 若凭空写进一句语言指令，就把那份默认提示顶掉了。所以决策在这里、
   * 拼接在适配器各自的提示词组装处（顺序仍保持「用户人设 → 项目记忆 → 语言」）。
   * 调用方显式传 `'auto'`（群聊编排的内部阶段）时不覆盖。
   */
  stream(id: string, ctx: SendContext): AsyncIterable<AgentEvent> | null {
    const provider = this.providers.get(id);
    if (!provider) return null;
    // 用前校验：每个会话第一次发消息时做一次（只读本地文件，不发网络请求）。
    // 失败会写回名册，界面上的绿点会在下一次刷新时撤回。
    this.validateCredentialOnce(id, provider, ctx.sessionId);
    return provider.send({
      ...ctx,
      systemPrompt: withUserIdentity(ctx.systemPrompt),
      answerLanguage: ctx.answerLanguage ?? loadAnswerLanguage(),
    });
  }

  /**
   * 会话级的「用前凭据校验」。
   *
   * 为什么放在注册表而不是每个适配器的 send()：
   *   - 适配器只管自己的探测，不知道「这是不是本会话第一条消息」；
   *   - 校验结果必须写回**注册表缓存**，否则名册上的绿点不会撤回；
   *   - 只对实现了 `refreshCredential` 的适配器生效（Codex / Claude / Kimi Code），
   *     WorkBuddy 等没有廉价校验接口的不参与，避免拖垮首字延迟。
   */
  private validateCredentialOnce(id: string, provider: AgentProvider, sessionId?: string): void {
    if (!sessionId || !provider.refreshCredential) return;
    if (this.credentialChecked.has(sessionId)) return;
    this.credentialChecked.add(sessionId);
    this.credentialCheckedOrder.push(sessionId);
    if (this.credentialCheckedOrder.length > 2000) {
      const oldest = this.credentialCheckedOrder.shift();
      if (oldest) this.credentialChecked.delete(oldest);
    }
    try {
      const refreshed = provider.refreshCredential();
      if (!refreshed) return;
      this.statuses.set(id, withProbeOutcome(refreshed));
      this.probedAt.set(id, Date.now());
    } catch (err) {
      // 校验是附加保护，失败不能挡住用户发消息
      console.error(`[Registry] ${id} 用前校验失败（忽略）:`, (err as Error).message);
    }
  }

  abort(id: string, sessionId: string): void {
    this.providers.get(id)?.abort(sessionId);
  }

  /**
   * 预热某个 Agent 的常驻进程（目前只有 SDK 会话池实现）。
   *
   * 为什么放在注册表而不是直接拿 provider：调用方（HTTP 层）只认 agentId，
   * 不该知道哪个 Agent 背后是 SDK、哪个是子进程 CLI。
   */
  prewarm(id: string, ctx: SendContext): void {
    try {
      const fire = () => {
        try {
          this.providers.get(id)?.prewarm?.({
            ...ctx,
            systemPrompt: withUserIdentity(ctx.systemPrompt),
            answerLanguage: ctx.answerLanguage ?? loadAnswerLanguage(),
          });
        } catch (err) {
          console.error('[Registry] prewarm 失败（忽略）:', (err as Error).message);
        }
      };

      const availability = this.statuses.get(id)?.availability;
      if (availability === 'ready') {
        fire();
        return;
      }

      // 重启后的首次全量探测要几十秒（实测 15 个 Agent ≈48s），而用户往往
      // 在这个窗口里就已经点进会话了。旧实现此时读到的是 undefined/unknown，
      // 直接放弃预热 —— 等探测落定时预热窗口早过去了，首条消息只能冷启动。
      // 这里挂到进行中的探测上：探测结果若是 ready 立刻预热，否则照旧不预热
      // （未登录 / 未安装仍然不白起进程）。
      if (availability === undefined || availability === 'unknown') {
        const pending = this.inflight.get(id);
        if (pending) {
          void pending
            .then(status => {
              if (status.availability === 'ready') fire();
            })
            .catch(() => {
              /* 探测失败不预热，也不冒泡 */
            });
        }
      }
    } catch (err) {
      // 预热纯属优化：任何异常都不该冒到请求层
      console.error('[Registry] prewarm 失败（忽略）:', (err as Error).message);
    }
  }

  resolvePermission(
    id: string,
    requestId: string,
    decision: PermissionDecision
  ): boolean {
    return this.providers.get(id)?.resolvePermission?.(requestId, decision) ?? false;
  }

  /**
   * 不知道是哪个 Agent 发起的权限请求时，向所有 Provider 问一遍。
   *
   * 为什么需要：网页面只回传 `requestId`，不带 agent id。旧实现硬编码了
   * `['workbuddy', 'hermes']` 两个 id —— 用户自己接的供应商（自定义 sdk /
   * acp / cli 条目）弹出的审批卡点了「允许」永远没反应，因为那个循环根本
   * 没问过它。requestId 是全局唯一的 UUID，命中即返回；没命中返回 null。
   *
   * @returns 命中的 Agent id（供日志），未命中返回 null
   */
  resolvePermissionAnywhere(
    requestId: string,
    decision: PermissionDecision
  ): string | null {
    for (const [id, provider] of this.providers) {
      if (provider.resolvePermission?.(requestId, decision)) return id;
    }
    return null;
  }

  /** 按 id 反查定义（供需要 cli 规格等静态信息的场景） */
  definition(id: string) {
    return findDef(id);
  }

  /**
   * 这个 Agent 的工具事件是什么来源（A100）。
   *
   * ## 为什么按 Agent 而不是按事件
   *
   * 一个 Agent 的输出方式不会中途改变：走 SDK 的全程是原生事件，
   * 走 jsonl 的全程是结构化事件，只有纯文本的那 3 个全程是解析出来的。
   * 逐事件标注只是把同一个值抄一万遍。
   *
   * 判定逻辑本体在 `definitions.ts` 的 `eventSourceOf`（纯函数）——
   * 这里只是按 id 取定义。分开是为了让那套判定能被单测覆盖：
   * 若把逻辑写在注册表里，测一次就得把 16 个 Agent 的探测全跑一遍。
   */
  eventSourceOf(id: string): EventSource | undefined {
    return eventSourceOf(findDef(id));
  }

  /**
   * 进程退出时清理长驻子进程。
   *
   * 以前只认 AcpAdapter（那时候唯一会跨轮活着的就是 ACP 的 python 进程）。
   * A107 给 SDK 适配器加了常驻 CLI 会话池，同一个钩子必须覆盖到它 ——
   * 否则退出应用会在后台留下最多 3 个 node 进程。所以改成按可选方法调用，
   * 新适配器只要实现 dispose() 就自动被回收，不必回来改这里。
   */
  disposeAll(): void {
    for (const [, provider] of this.providers) {
      try {
        provider.dispose?.();
      } catch (err) {
        console.error('[Registry] dispose 失败:', (err as Error).message);
      }
    }
  }
}

/** 单例 */
export const registry = new AgentRegistry();
export { PROBE_TTL_MS };
