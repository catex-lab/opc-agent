/**
 * 运行事件中转站（E5）。
 *
 * ## 它解决什么
 *
 * POST /api/chat 的 SSE 是「一条请求一条流」。网络抖一下、切个网络、
 * 或者渲染进程重载，这条流就断了 —— 而 Agent 子进程其实还在跑。
 * 没有中转站的话，用户只能看着半句话永远停在那里。
 *
 * 现在的做法：
 *   1. 每个 run 的事件既写 POST 响应，也进这里的 ring buffer
 *   2. 断线后前端带着 `after=<最后收到的 seq>` 重新 GET
 *   3. 缓冲里还有 → 补发缺的；已经滚出去了 → 先发一条 snapshot（当前全部块）再续增量
 *
 * ## 为什么不做完整 event sourcing
 *
 * 对话场景的断线窗口只有几秒到几十秒。把每个 token 事件持久化到 SQLite，
 * 写入量会翻十几倍，收益却只是「几小时后还能精确重放」—— 而那种需求
 * 用落库的 blocks 快照就够了。这里只保留最近 4096 条 / 2 分钟。
 */

import { applyRunEvent } from '../shared/blocks.js';
import type { Block, RunEvent } from '../shared/blocks.js';

/** 单个 run 保留的最大事件数 */
const MAX_EVENTS = 4096;
/** 结束后的保留时长：够前端重连一次即可 */
const TTL_MS = 2 * 60 * 1000;
/** 未结束的 run 最长保留时间，防止异常情况下内存只增不减 */
const MAX_AGE_MS = 30 * 60 * 1000;

interface RunRecord {
  events: RunEvent[];
  blocks: Block[];
  subscribers: Set<(event: RunEvent) => void>;
  createdAt: number;
  finishedAt: number | null;
  /** 这个 run 属于哪个会话。`run_start` 事件里带，收到时补上 */
  sessionId?: string;
  /** 这一轮是谁在跑（群聊里多棒接力时，同一会话会有多个 run） */
  agentId?: string;
  /**
   * 用户点「停止」时这一 run 该做的事（A122）。
   *
   * 由各路由在创建 run 之后注册：中止本轮的 AbortController + 让适配器杀掉子进程。
   * 存在的必要：路由只在「客户端断开 + 20s 宽限」这条路径上握着 ac，
   * 而重连端点明确「不因断开而中止」——所以前端把 fetch 掐掉并不能停下 Agent，
   * 必须有一条按 runId 走的即时中止路。
   */
  onAbort?: () => void;
}

/** 后台任务快照：只暴露「还在跑」的 run，不带事件与块 */
export interface ActiveRun {
  runId: string;
  sessionId?: string;
  agentId?: string;
  startedAt: number;
}

class RunHub {
  private runs = new Map<string, RunRecord>();
  private sweeper: NodeJS.Timeout;

  constructor() {
    // unref：不要因为一个清理定时器把 Node 进程吊住（测试/脚本里尤其明显）
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref?.();
  }

  create(runId: string): void {
    this.runs.set(runId, {
      events: [],
      blocks: [],
      subscribers: new Set(),
      createdAt: Date.now(),
      finishedAt: null,
    });
  }

  publish(event: RunEvent): void {
    const run = this.runs.get(event.runId);
    if (!run) return;

    run.events.push(event);
    if (run.events.length > MAX_EVENTS) {
      run.events.splice(0, run.events.length - MAX_EVENTS);
    }
    applyRunEvent(run.blocks, event);

    if (event.type === 'run_start') {
      run.sessionId = event.sessionId;
      run.agentId = event.agentId;
    }
    if (event.type === 'run_end') {
      run.finishedAt = Date.now();
      // 收尾之后已经没有可中止的东西；留着会把路由闭包（res / session / ac）
      // 一直吊到 sweep 才回收
      run.onAbort = undefined;
    }

    for (const fn of run.subscribers) {
      try {
        fn(event);
      } catch (err) {
        // 单个订阅者写失败（客户端已断开）不能影响其他订阅者
        console.warn('[RunHub] 订阅者回调失败:', (err as Error)?.message);
      }
    }
  }

  /**
   * 补发 `after` 之后的事件。
   *
   * 返回 null 表示这个 run 已经不存在（过期或服务重启）—— 调用方应回 404，
   * 前端退回「重新拉一次会话」而不是假装重连成功。
   */
  replay(runId: string, after: number): RunEvent[] | null {
    const run = this.runs.get(runId);
    if (!run) return null;

    const oldest = run.events[0]?.seq ?? 1;
    const out: RunEvent[] = [];

    // 请求的断点已经滚出缓冲：先给全量快照，再给缓冲里的全部增量
    if (after > 0 && after < oldest - 1) {
      out.push({
        seq: after,
        runId,
        type: 'snapshot',
        blocks: run.blocks.map(b => ({ ...b })),
      });
      out.push(...run.events);
      return out;
    }

    for (const ev of run.events) {
      if (ev.seq > after) out.push(ev);
    }
    return out;
  }

  subscribe(runId: string, fn: (event: RunEvent) => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.subscribers.add(fn);
    return () => run.subscribers.delete(fn);
  }

  isFinished(runId: string): boolean {
    return this.runs.get(runId)?.finishedAt != null;
  }

  /** 注册（或替换）这一 run 的中止动作。run 已不存在就不注册，交给调用方的 404 兜底 */
  setAbortHandler(runId: string, fn: () => void): void {
    const run = this.runs.get(runId);
    if (run) run.onAbort = fn;
  }

  /**
   * 即时中止一个 run（A122：界面上的「停止」）。
   *
   * 只做「执行已注册的中止动作」，不把自己标成 finished —— 收尾（闭合块、
   * 落库、发 run_end）是各路由的活。在这里抢先 finished 会让这一轮的答案
   * 停在半截却不落库，重连端点也会立刻 404，比不停更糟。
   *
   * 返回 false = 没有这个 run、已经结束、或没注册中止动作，没什么可停。
   */
  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.finishedAt != null || !run.onAbort) return false;
    try {
      run.onAbort();
    } catch (err) {
      console.warn(`[RunHub] 中止 ${runId} 失败:`, (err as Error)?.message);
      return false;
    }
    return true;
  }

  /** 当前有几个重连上来的订阅者（用于判断「客户端真的走了」还是「正在重连」） */
  subscriberCount(runId: string): number {
    return this.runs.get(runId)?.subscribers.size ?? 0;
  }

  /**
   * 还在跑的 run（A36 的「后台任务」数据源）。
   *
   * 语义就是「用户已经离开那个会话，但 Agent 还在干活」。这不是新造的概念：
   * 子进程本来就不跟着前端页面走，切会话 / 重载渲染进程都不会杀掉它 ——
   * 只是在此之前，界面上没有任何地方告诉用户「别的会话还在跑」。
   *
   * 排除 `sessionId` 是给调用方用的：当前会话正在跑的那一轮不是「后台任务」，
   * 用户眼前就看着它。
   */
  activeRuns(): ActiveRun[] {
    const out: ActiveRun[] = [];
    for (const [runId, run] of this.runs) {
      if (run.finishedAt != null) continue;
      out.push({
        runId,
        sessionId: run.sessionId,
        agentId: run.agentId,
        startedAt: run.createdAt,
      });
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      const expired = run.finishedAt
        ? now - run.finishedAt > TTL_MS
        : now - run.createdAt > MAX_AGE_MS;
      if (expired) this.runs.delete(id);
    }
  }
}

export const runHub = new RunHub();

/** 写事件时的快捷入口（index.ts 里每写一条 SSE 就调一次） */
export function publishRunEvent(event: RunEvent): void {
  runHub.publish(event);
}
