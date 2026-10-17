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

import { AGENT_DEFS, findDef } from './definitions.js';
import { createProvider, AcpAdapter } from './adapters/index.js';
import { permissionSupportFor } from './permissions.js';
import { toAgentInfo, unknownStatus } from './types.js';
import type {
  AgentDescriptor,
  AgentInfo,
  AgentProvider,
  AgentStatus,
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

  constructor() {
    for (const def of AGENT_DEFS) {
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
    return { ...toAgentInfo(descriptor, status), permissionSupport: permissionSupportFor(id) };
  }

  getProvider(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * 某个 Agent 可用的模型（用于前端模型选择）。
   *
   * 优先级：ACP Agent 运行时上报的模型 > 定义表里声明的静态白名单。
   * 两者都没有就返回空数组 —— 空数组对前端意味着「不显示模型下拉」，
   * 这比硬塞一份 SDK 的模型列表要诚实：那些模型名对该 Agent 毫无意义，
   * 选中后只会让调用直接失败。
   */
  modelsFor(id: string): Array<{ modelId: string; name: string; description?: string }> {
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

    const declared = def?.models;
    return (declared ?? []).map(modelId => ({ modelId, name: modelId }));
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

  /** 把一次调用转成事件流（统一入口，供 /api/chat 使用） */
  stream(id: string, ctx: SendContext): AsyncIterable<AgentEvent> | null {
    const provider = this.providers.get(id);
    if (!provider) return null;
    return provider.send(ctx);
  }

  abort(id: string, sessionId: string): void {
    this.providers.get(id)?.abort(sessionId);
  }

  resolvePermission(
    id: string,
    requestId: string,
    decision: PermissionDecision
  ): boolean {
    return this.providers.get(id)?.resolvePermission?.(requestId, decision) ?? false;
  }

  /** 按 id 反查定义（供需要 cli 规格等静态信息的场景） */
  definition(id: string) {
    return findDef(id);
  }

  /** 进程退出时清理长驻子进程 */
  disposeAll(): void {
    for (const [, provider] of this.providers) {
      if (provider instanceof AcpAdapter) provider.dispose();
    }
  }
}

/** 单例 */
export const registry = new AgentRegistry();
export { PROBE_TTL_MS };
