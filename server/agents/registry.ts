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
import { getModelsForAgent, mergeModelOptions, type ModelOption } from './modelCatalog.js';
import { permissionSupportFor } from './permissions.js';
import { toAgentInfo, unknownStatus } from './types.js';
// A115：用户资料注入（昵称 → systemPrompt）。见 withUserIdentity 的注释。
import { withUserIdentity } from '../user-profile.js';
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
const PROBE_CONCURRENCY = 3;

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
  private inflight = new Map<string, Promise<AgentInfo | undefined>>();
  /** 是否已经完成过至少一轮全量探测 */
  private probedOnce = false;
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
    return {
      ...toAgentInfo(descriptor, status),
      ...(hosts && hosts.length > 0 ? { endpointHosts: hosts } : {}),
      ...(peers.length > 0 ? { familyPeers: peers } : {}),
      ...(hints?.localSiblings && hints.localSiblings.length > 0
        ? { localSiblings: hints.localSiblings }
        : {}),
      ...(hints?.lastRequest ? { lastRequest: hints.lastRequest } : {}),
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

  /** 探测单个 Agent（同一 Agent 的并发探测会复用同一个 Promise） */
  async probeOne(id: string, force = false): Promise<AgentInfo | undefined> {
    const provider = this.providers.get(id);
    if (!provider) return undefined;

    if (!force && this.isFresh(id)) return this.get(id);

    const existing = this.inflight.get(id);
    if (existing) return existing;

    const task = (async () => {
      try {
        const status = await provider.probe();
        this.statuses.set(id, status);
        this.probedAt.set(id, Date.now());
      } catch (err) {
        this.statuses.set(id, {
          availability: 'unknown',
          installed: false,
          message: `探测失败：${(err as Error).message}`,
          probedAt: new Date().toISOString(),
        });
        this.probedAt.set(id, Date.now());
      } finally {
        this.inflight.delete(id);
      }
      return this.get(id);
    })();

    this.inflight.set(id, task);
    return task;
  }

  /**
   * 探测全部 Agent（带并发上限）。
   * @param force 忽略 TTL 强制重探
   */
  async probeAll(force = false): Promise<AgentInfo[]> {
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
   */
  async ensureProbed(ids: string[]): Promise<void> {
    await Promise.all(ids.map(id => this.probeOne(id)));
  }

  /** 把运行时错误回写到状态里，让名册页能显示「上次为什么失败」 */
  recordError(id: string, message: string): void {
    const prev = this.statuses.get(id);
    if (!prev) return;
    this.statuses.set(id, { ...prev, lastError: message });
  }

  /**
   * 把一次调用转成事件流（统一入口，供 /api/chat 使用）
   *
   * A115：`systemPrompt` 在这里过一次 `withUserIdentity()` —— 用户资料
   * （昵称）注入的**唯一**入口。选注册表而不是逐个适配器：适配器有五个
   * （sdk / http / acp / qoder-sdk / mock），漏一个就变成「有的 Agent
   * 认得我、有的不认得」，而这种不一致没有任何报错，只有用户会发现。
   */
  stream(id: string, ctx: SendContext): AsyncIterable<AgentEvent> | null {
    const provider = this.providers.get(id);
    if (!provider) return null;
    return provider.send({ ...ctx, systemPrompt: withUserIdentity(ctx.systemPrompt) });
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
      // 只在「确认可用」时预热：未探测 / 未登录 / 未安装都不该白起一个
      // ≈24MB 的进程（起来也会卡在鉴权上，最后还得被超时清掉）
      if (this.statuses.get(id)?.availability !== 'ready') return;
      // A115：与 stream() 同样过一次 withUserIdentity。
      // 不只是为了「预热也能带上称呼」—— sdk 适配器按 systemPrompt 的
      // **指纹**决定要不要重建会话池，两边不一致会让首条消息被判成
      // 「结构性不符」而重建，预热白做（见 sdk.ts 的建池键注释）。
      this.providers.get(id)?.prewarm?.({ ...ctx, systemPrompt: withUserIdentity(ctx.systemPrompt) });
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
