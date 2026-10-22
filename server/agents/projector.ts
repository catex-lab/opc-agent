/**
 * 事件投影器：AgentEvent（v1）→ RunEvent（v2）。
 *
 * ## 为什么把累积逻辑放在服务端
 *
 * 「往当前打开的那个块里追加」这件事原本在 `useChat` 和 `useGroupChat` 里
 * **各写了一份**，于是修一处漏一处，两条路径的行为必然漂移。更要命的是
 * 落库时没有块序列可存，刷新后只能靠旧字段重新拼，拼出来的顺序和流式时不一样。
 *
 * 现在只在这里写一次：
 *   adapter ──v1──▶ RunProjector ──v2──▶ SSE / DB / 群聊
 *
 * 好处是三重的：单聊、群聊、刷新还原共用同一份数据；adapter 不用动
 * （它们继续吐 v1，投影器兜住差异）；投影器是纯逻辑，可以拿夹具单测。
 *
 * ## 合并规则（本文件唯一需要小心的地方）
 *
 *   text      → 当前打开的是 text 块就续写，否则先关旧的再开新的
 *   thinking  → 同上，类型换成 thinking
 *   tool      → 关掉打开的文本块，开一个 tool 块
 *   tool_result → 按 toolId 回填并关闭；找不到就退到最后一个 running 的
 *   done      → 关掉所有打开的块（不再发 run_end，落库由调用方在中间插入）
 *
 * 连续两个 text 之间夹一个 thinking，必须切成两个 text 块 —— 否则
 * 「先解释、思考、再继续解释」会被合并成一段，思考的位置就丢了。
 */

import { randomUUID } from 'crypto';
import type { AgentEvent } from './types.js';
import type {
  Block,
  BlockState,
  RunEvent,
  RunStatus,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
} from '../../shared/blocks.js';

export interface RunMeta {
  runId: string;
  sessionId: string;
  messageId: string;
  agentId: string;
  model?: string;
}

/** 单个 run 的块上限：防止异常适配器把内存打爆 */
const MAX_BLOCKS = 400;

export class RunProjector {
  private seq = 0;
  private readonly meta: RunMeta;
  private readonly now: () => number;
  private readonly blocks: Block[] = [];
  /** 当前正在追加的文本/思考块（工具块不参与「续写」） */
  private openId: string | null = null;
  private openType: 'text' | 'thinking' | null = null;
  private started = false;
  private counter = 0;

  constructor(meta: RunMeta, now: () => number = Date.now) {
    this.meta = meta;
    this.now = now;
  }

  get blockList(): readonly Block[] {
    return this.blocks;
  }

  get lastSeq(): number {
    return this.seq;
  }

  private nextId(): string {
    this.counter += 1;
    return `${this.meta.runId}-b${this.counter}`;
  }

  private make<T extends object>(payload: T): RunEvent {
    // payload 由调用点保证是 RunEvent 的某个成员（type 必填），
    // 这里只负责补上 seq / runId 两个公共字段
    return { seq: ++this.seq, runId: this.meta.runId, ...payload } as unknown as RunEvent;
  }

  private closeOpen(state: BlockState): RunEvent[] {
    if (!this.openId) return [];
    const id = this.openId;
    const block = this.blocks.find(b => b.id === id);
    const out: RunEvent[] = [];
    if (block && (block.type === 'text' || block.type === 'thinking')) {
      block.state = state;
      if (block.type === 'thinking') {
        // 结束时间必须显式下发：让客户端自己 Date.now() 会和服务端差几毫秒，
        // 「流式中」与「刷新后」的耗时显示就对不上了
        const endedAt = this.now();
        block.endedAt = endedAt;
        out.push(this.make({ type: 'block_patch', blockId: id, patch: { endedAt } }));
      }
    }
    this.openId = null;
    this.openType = null;
    out.push(this.make({ type: 'block_close', blockId: id, state }));
    return out;
  }

  private openText(kind: 'text' | 'thinking', delta: string): RunEvent[] {
    if (this.blocks.length >= MAX_BLOCKS) {
      // 超限时不再开新块，把内容并到最后一个同类型块上（宁可挤，不可丢）
      const last = [...this.blocks].reverse().find(b => b.type === kind);
      if (last) {
        if (last.type === 'text' || last.type === 'thinking') last.text += delta;
        return [
          this.make({ type: 'block_delta', blockId: last.id, channel: 'text', delta }),
        ];
      }
    }

    const id = this.nextId();
    const out: RunEvent[] = [];
    if (kind === 'text') {
      const block: TextBlock = { id, type: 'text', text: delta, state: 'streaming' };
      this.blocks.push(block);
      // 下发的必须是**快照拷贝**：事件对象会被塞进重放缓冲（RunHub）长期保存，
      // 若与 this.blocks 共用引用，后续 append 的 += 会把这条已发出的事件也改掉，
      // 重连回放时就会拿到「未来的内容」，客户端再追加一遍 → 文本翻倍。
      out.push(this.make({ type: 'block_open', block: { ...block } }));
    } else {
      const block: ThinkingBlock = {
        id,
        type: 'thinking',
        text: delta,
        state: 'streaming',
        format: 'raw',
        startedAt: this.now(),
      };
      this.blocks.push(block);
      out.push(this.make({ type: 'block_open', block: { ...block } }));
    }
    // 首段内容随 block_open 一起下发（快照语义），**不再**额外发一条 delta ——
    // 否则客户端先按 open 里的 text 建块、再把同一段 delta 追加一次，内容翻倍。
    this.openId = id;
    this.openType = kind;
    return out;
  }

  /** 追加一段文本/思考 */
  private append(kind: 'text' | 'thinking', delta: string): RunEvent[] {
    if (!delta) return [];
    if (this.openType === kind && this.openId) {
      const block = this.blocks.find(b => b.id === this.openId);
      if (block && (block.type === 'text' || block.type === 'thinking')) {
        block.text += delta;
        return [
          this.make({ type: 'block_delta', blockId: block.id, channel: 'text', delta }),
        ];
      }
    }
    const closing = this.closeOpen('done');
    return [...closing, ...this.openText(kind, delta)];
  }

  /** 处理一条 v1 事件，返回需要下发的 v2 事件（可能为空/多条） */
  push(ev: AgentEvent): RunEvent[] {
    switch (ev.type) {
      case 'init': {
        if (this.started) {
          // 后续 init 只用于更新续接令牌，不重复发 run_start
          return [];
        }
        this.started = true;
        return [
          this.make({
            type: 'run_start',
            sessionId: this.meta.sessionId,
            messageId: this.meta.messageId,
            agentId: this.meta.agentId,
            model: this.meta.model,
          }),
        ];
      }

      case 'text':
        return this.append('text', ev.content);

      case 'thinking':
        return this.append('thinking', ev.content);

      case 'tool': {
        const closing = this.closeOpen('done');
        // 同一 toolId 重复上报（有的 CLI 会既发 started 又发 completed）时只认第一次
        if (ev.id && this.blocks.some(b => b.type === 'tool' && b.toolId === ev.id)) {
          return closing;
        }
        const block: ToolBlock = {
          id: this.nextId(),
          type: 'tool',
          toolId: ev.id || randomUUID(),
          name: typeof ev.name === 'string' && ev.name ? ev.name : 'unknown',
          input:
            ev.input && typeof ev.input === 'object'
              ? (ev.input as Record<string, unknown>)
              : undefined,
          status: 'running',
          startedAt: this.now(),
        };
        this.blocks.push(block);
        return [...closing, this.make({ type: 'block_open', block: { ...block } })];
      }

      case 'tool_output': {
        const block = this.findTool(ev.toolId);
        if (!block) return [];
        block.output = (block.output ?? '') + ev.content;
        return [
          this.make({
            type: 'block_delta',
            blockId: block.id,
            channel: 'output',
            delta: ev.content,
          }),
        ];
      }

      case 'tool_result': {
        const block = this.findTool(ev.toolId);
        if (!block) return [];
        const status = ev.isError ? 'failed' : 'completed';
        const patch: Record<string, unknown> = {
          status,
          isError: !!ev.isError,
          output: ev.content,
          endedAt: this.now(),
        };
        block.status = status;
        block.isError = !!ev.isError;
        block.output = ev.content;
        block.endedAt = this.now();
        return [
          this.make({ type: 'block_patch', blockId: block.id, patch }),
          this.make({ type: 'block_close', blockId: block.id, state: ev.isError ? 'error' : 'done' }),
        ];
      }

      case 'error':
        return [
          this.make({
            type: 'error',
            scope: 'run',
            message: ev.message,
            // 网络类错误通常可重试；认证/配置类不行
            retryable: /timeout|network|ECONN|socket|502|503|504/i.test(ev.message),
          }),
        ];

      case 'permission_request':
        return [
          this.make({
            type: 'permission_request',
            requestId: ev.requestId,
            toolUseId: ev.toolUseId,
            toolName: ev.toolName,
            input: ev.input,
            risk: ev.risk,
            rule: ev.rule,
          }),
        ];

      case 'usage':
        // 用量不是块：由调用方（/api/chat）在 done 时并入 run_end
        return [];

      case 'done':
        // 用量随 finish() 一起走：落库必须在 run_end 之前完成
        return this.closeOpen('done');
    }
  }

  private findTool(toolId: string): ToolBlock | undefined {
    if (toolId) {
      const hit = this.blocks.find(b => b.type === 'tool' && b.toolId === toolId);
      if (hit) return hit as ToolBlock;
    }
    // 适配器没给 id 或给错了：退到最后一个还在跑的工具（与旧行为一致）
    return [...this.blocks]
      .reverse()
      .find(b => b.type === 'tool' && b.status === 'running') as ToolBlock | undefined;
  }

  /**
   * 收尾：关闭所有打开的块，并给仍未回填的工具一个终态。
   *
   * 为什么要给工具兜底状态：适配器可能不发 tool_result（进程被杀、协议缺口），
   * 留一个永久 running 的卡片会让 UI 一直转圈。正常结束按 completed 收，
   * 报错按 failed，中止按 cancelled —— 这是「最不坏」的推断。
   */
  finish(status: RunStatus, usage?: { durationMs?: number; cost?: number; tokens?: number }): {
    closes: RunEvent[];
    end: RunEvent;
  } {
    const closes: RunEvent[] = [];
    closes.push(...this.closeOpen(status === 'ok' ? 'done' : 'cancelled'));

    for (const b of this.blocks) {
      if (b.type !== 'tool' || b.status !== 'running') continue;
      const next: BlockState =
        status === 'ok' ? 'done' : status === 'aborted' ? 'cancelled' : 'error';
      b.status = status === 'ok' ? 'completed' : status === 'aborted' ? 'cancelled' : 'failed';
      b.endedAt = this.now();
      closes.push(
        this.make({
          type: 'block_patch',
          blockId: b.id,
          patch: { status: b.status, endedAt: b.endedAt },
        })
      );
      closes.push(this.make({ type: 'block_close', blockId: b.id, state: next }));
    }

    const end = this.make({
      type: 'run_end',
      status,
      durationMs: usage?.durationMs,
      cost: usage?.cost,
      tokens: usage?.tokens,
    });
    return { closes, end };
  }

  /** 断线重连用的全量快照 */
  snapshot(): RunEvent {
    return this.make({ type: 'snapshot', blocks: this.blocks.map(b => ({ ...b })) });
  }
}
