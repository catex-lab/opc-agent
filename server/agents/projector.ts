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
  EventSource,
  RunEvent,
  RunStatus,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  ArtifactBlock,
  RawBlock,
  RawEntry,
} from '../../shared/blocks.js';
import type {
  CapabilityProfile,
  EventCapability,
} from '../../shared/capabilities.js';
import { sortCapabilities } from '../../shared/capabilities.js';
import { MAX_ARTIFACT_DATA_BYTES } from './types.js';

/**
 * 一个 run 内最多保留多少条原生事件（A111）。
 *
 * 上限存在的理由不是「怕多」，而是**必须落库**：RawBlock 会跟着消息一起写进
 * SQLite，一轮几百条原生事件会把库撑得很难看，而 99% 的情况下没人会去翻第 20 条。
 * 超出后只增 `count` 与 `omitted`，UI 照样如实显示「另有 N 条未保留」。
 */
const MAX_RAW_ENTRIES = 20;

/** 单条原生事件的字节上限；超出就截断成字符串前缀，并标记 truncated */
const MAX_RAW_ENTRY_BYTES = 4096;

export interface RunMeta {
  runId: string;
  sessionId: string;
  messageId: string;
  agentId: string;
  model?: string;
  /**
   * 这个 Agent 的事件来源（A100）。由调用方从注册表取，投影器只负责盖章。
   *
   * 为什么由调用方传而不是投影器自己去查注册表：投影器是纯逻辑，
   * 拿夹具就能单测。一旦它 import 注册表，单测就得先把 16 个 Agent 定义
   * 全跑一遍探测 —— 那已经不叫单元测试了。
   */
  source?: EventSource;
  /**
   * 这一轮的能力档（P2）：key + declared（+ probed）。
   *
   * 由调用方组装（见 `agents/capability.ts`），投影器只负责把 `observed`
   * 数出来后一起发出去。理由同上：引擎/模型的解析要读凭据与定义表，
   * 而那些都不该进一个能被夹具单测的纯逻辑类。
   */
  capabilities?: CapabilityProfile;
}

/** 单个 run 的块上限：防止异常适配器把内存打爆 */
const MAX_BLOCKS = 400;

/**
 * 思考事件上随行的那两个标记。只有 `thinking` 用得着，`text` 传进来也无害。
 *
 * 为什么由事件携带而不是投影器判断：这两个值只有产出事件的那一层知道
 * （见 `server/agents/types.ts` 里 `AgentEvent.thinking` 的注释）。
 */
interface ThinkingOpts {
  format?: 'raw' | 'summary';
  redacted?: boolean;
}

export class RunProjector {
  private seq = 0;
  /**
   * 本次运行的元信息。
   *
   * 刻意**不是** readonly：`source` 允许在收到适配器的 init 事件后被覆盖
   * （见 `case 'init'`）。把它做成 readonly 会逼着另外开一个字段，
   * 那样就有两处需要保持一致的地方了。
   */
  private meta: RunMeta;
  private readonly now: () => number;
  private readonly blocks: Block[] = [];
  /** 当前正在追加的文本/思考块（工具块不参与「续写」） */
  private openId: string | null = null;
  private openType: 'text' | 'thinking' | null = null;
  private started = false;
  private counter = 0;
  /**
   * 这一轮**真的出现过**的事件能力（P2）。
   *
   * 刻意在投影器里数、而不是让适配器自己上报：适配器可以撒谎（清单已经撒过
   * 一次谎），而块序列是它一手造成的既成事实 —— 有什么块，就有什么能力。
   * 只有费用/token 这类不落块的数据才取自 done 载荷。
   */
  private observed = new Set<EventCapability>();

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

  /**
   * 当前的能力档；调用方没给 key 时返回 undefined（不伪造一个 `unknown` 引擎）。
   *
   * @param withObserved `run_end` 传 true：此刻"这一轮出现过什么"才成为事实。
   *   `run_start` 传 false —— 那时把 observed 写进去就是把声明冒充成观测。
   */
  private profile(withObserved: boolean): CapabilityProfile | undefined {
    const base = this.meta.capabilities;
    if (!base) return undefined;
    return {
      ...base,
      ...(withObserved ? { observed: sortCapabilities(this.observed) } : {}),
    };
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

  private openText(kind: 'text' | 'thinking', delta: string, opts: ThinkingOpts = {}): RunEvent[] {
    if (this.blocks.length >= MAX_BLOCKS) {
      // 超限时不再开新块，把内容并到最后一个同类型块上（宁可挤，不可丢）。
      // 思考块还要同格式：summary 与原文混进一个块，之后就没法回答
      // 「这块到底是不是完整推理」了。
      const format = opts.format ?? 'raw';
      const last = [...this.blocks].reverse().find(b =>
        kind === 'text' ? b.type === 'text' : b.type === 'thinking' && b.format === format
      );
      if (last) {
        if (last.type === 'text' || last.type === 'thinking') last.text += delta;
        if (!delta) return [];
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
        format: opts.format ?? 'raw',
        startedAt: this.now(),
        // 只在真被隐去时才写这个字段：老数据 / 没声明的适配器保持原来的形状
        ...(opts.redacted ? { redacted: true } : {}),
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
  private append(kind: 'text' | 'thinking', delta: string, opts: ThinkingOpts = {}): RunEvent[] {
    const format = opts.format ?? 'raw';
    // 空内容正常情况下没有意义；但「被隐去的思考」恰恰是空正文 + redacted，
    // 它必须开出一个块来（否则界面上这一轮像是什么都没想过）。
    if (!delta && !(kind === 'thinking' && opts.redacted)) return [];
    if (this.openType === kind && this.openId) {
      const block = this.blocks.find(b => b.id === this.openId);
      const sameFormat = block?.type !== 'thinking' || block.format === format;
      if (block && (block.type === 'text' || block.type === 'thinking') && sameFormat) {
        block.text += delta;
        return delta
          ? [this.make({ type: 'block_delta', blockId: block.id, channel: 'text', delta })]
          : [];
      }
    }
    const closing = this.closeOpen('done');
    return [...closing, ...this.openText(kind, delta, opts)];
  }

  /** 处理一条 v1 事件，返回需要下发的 v2 事件（可能为空/多条） */
  push(ev: AgentEvent): RunEvent[] {
    switch (ev.type) {
      case 'init': {
        // A100：适配器在 init 里报了它实际走的通道 —— 以它为准，
        // 覆盖掉构造时传进来的静态值。
        //
        // 为什么必须有这一步：qoder 系列是「SDK 优先、握手失败回退 CLI」。
        // 静态推导只能给出「优先走 SDK」这个乐观答案；一旦回退到
        // `parse: 'text'` 的 CLI，事件其实是从纯文本解析出来的。
        // 不覆盖的话，界面上那个「原生」标签就是一句假话。
        if (ev.source) {
          this.meta = { ...this.meta, source: ev.source };
        }
        if (this.started) {
          // 后续 init 只用于更新续接令牌，不重复发 run_start
          return [];
        }
        this.started = true;
        const caps = this.profile(false);
        return [
          this.make({
            type: 'run_start',
            sessionId: this.meta.sessionId,
            messageId: this.meta.messageId,
            agentId: this.meta.agentId,
            model: this.meta.model,
            // observed 此刻还空着：这一轮才刚开始，不能提前把 declared 抄过去
            // 冒充事实（那正是「清单在撒谎」的复现方式）。
            ...(caps ? { capabilities: caps } : {}),
          }),
        ];
      }

      case 'text':
        return this.append('text', ev.content);

      case 'thinking': {
        const out = this.append('thinking', ev.content, {
          format: ev.format,
          redacted: ev.redacted,
        });
        // 空块没产出事件就不算「观察到」：被隐去的思考是空正文 + redacted，
        // 但它确实产出了块，所以按 out 判、不按 ev.content 判。
        if (out.length > 0) {
          this.observed.add(ev.format === 'summary' ? 'thinking_summary' : 'thinking');
        }
        return out;
      }

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
          // A100：把「这个工具事件从哪来」烙在块上。投影器是唯一创建
          // ToolBlock 的地方，所以只在这里写一次，UI 就能如实标注。
          source: this.meta.source,
        };
        this.blocks.push(block);
        this.observed.add('tool');
        return [...closing, this.make({ type: 'block_open', block: { ...block } })];
      }

      case 'tool_output': {
        const block = this.findTool(ev.toolId);
        if (!block) return [];
        this.observed.add('tool_output');
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

      case 'artifact': {
        if (!ev.id || !ev.name || !ev.mediaType) return [];
        let data: unknown;
        if (ev.data !== undefined) {
          try {
            const serialized = JSON.stringify(ev.data);
            if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= MAX_ARTIFACT_DATA_BYTES) {
              data = ev.data;
            }
          } catch {
            // 非 JSON 数据不进入持久化消息；uri 仍可引用外部产物。
          }
        }
        const block: ArtifactBlock = {
          id: this.nextId(),
          type: 'artifact',
          name: ev.name.slice(0, 240),
          mediaType: ev.mediaType.slice(0, 120),
          ...(ev.uri ? { uri: ev.uri.slice(0, 2048) } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(ev.description ? { description: ev.description.slice(0, 2000) } : {}),
        };
        this.blocks.push(block);
        return [this.make({ type: 'block_open', block: { ...block } })];
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
        this.observed.add('permission');
        return [
          this.make({
            type: 'permission_request',
            requestId: ev.requestId,
            toolUseId: ev.toolUseId,
            toolName: ev.toolName,
            input: ev.input,
            risk: ev.risk,
            rule: ev.rule,
            // 缺省保持缺省：没有选项和「给了 0 个选项」是两种事实
            ...(ev.options ? { options: ev.options } : {}),
            /**
             * A132：**投影器必须逐字段透传**，这里漏一个字段，前面适配器
             * 带得再对，前端也永远收不到 —— 而「收不到」的表现是倒计时不显示，
             * 看起来像 UI 没做，实际是链路断在中间。
             * 与 options 同样保持「缺省即缺省」：ACP 真没有超时，不许补一个。
             */
            ...(typeof ev.expiresAt === 'number' ? { expiresAt: ev.expiresAt } : {}),
          }),
        ];

      case 'usage':
        // 用量不是块：由调用方（/api/chat）在 done 时并入 run_end。
        // 但「上报过用量」本身是观测到的事实，能力档要记下来。
        this.observed.add('usage');
        return [];

      /**
       * 原生事件旁路（A111）。
       *
       * 一个 run 只开**一块**，后续条目靠 patch 追加 —— 理由见 RawBlock 的注释：
       * 几十条未识别事件各占一块会把消息流冲垮，而它们的价值是「可查」不是「可读」。
       *
       * 刻意**不动 `openId`**：raw 块不是文本块，不能成为「续写目标」。否则
       * 一条未识别事件插进正文流之后，接下来的 text 会被续写到 raw 块上（类型
       * 不符，append 会退回 openText 开新块），白丢一次合并机会；更糟的是
       * `closeOpen` 会把 raw 块当成打开的文本块去 patch endedAt。
       */
      case 'raw': {
        const existing = this.blocks.find(b => b.type === 'raw') as RawBlock | undefined;

        // 封顶检查必须放在**序列化之前**：CLI 适配器是按行喂的，一轮下来
        // 可能几百条未映射的行。原来的顺序是先 makeRawEntry（JSON.stringify
        // 一遍、可能还截断 4KB 字符串）再判断「反正这条不要了」—— 纯浪费。
        if (existing && existing.entries.length >= MAX_RAW_ENTRIES) {
          // 到顶了：只更新计数，不追加条目 —— 但**绝不静默**，omitted 会让 UI 说明
          existing.count += 1;
          existing.omitted += 1;
          return [
            this.make({
              type: 'block_patch',
              blockId: existing.id,
              patch: { count: existing.count, omitted: existing.omitted },
            }),
          ];
        }

        const at = this.now();
        const entry = this.makeRawEntry(ev.channel, ev.payload, at);

        if (!existing) {
          const block: RawBlock = {
            id: this.nextId(),
            type: 'raw',
            count: 1,
            entries: [entry],
            omitted: 0,
          };
          this.blocks.push(block);
          // 与其它块一致：下发的必须是快照拷贝，避免重放缓冲被后续追加改掉
          return [this.make({ type: 'block_open', block: { ...block, entries: [...block.entries] } })];
        }

        existing.count += 1;
        existing.entries.push(entry);
        return [
          this.make({
            type: 'block_patch',
            blockId: existing.id,
            // append 语义：只带新增那一条，避免每次 patch 都把前 19 条重发一遍
            patch: { count: existing.count, append: entry },
          }),
        ];
      }

      case 'done':
        // 用量随 finish() 一起走：落库必须在 run_end 之前完成
        return this.closeOpen('done');
    }
  }

  /**
   * 造一条原生事件条目，并按字节上限截断。
   *
   * 为什么先 `JSON.stringify` 判长度、而不是只看 `payload` 的类型：一个 200KB 的
   * 原生对象和一段 200KB 的字符串，对 SQLite 是同一件事。判的是**落库体积**，
   * 不是内存里的形状。
   *
   * 没超限时保留原结构（UI 能格式化缩进）；超限时退化成字符串前缀并标记
   * `truncated`，让用户知道「这里被截了」，而不是以为原生事件本来就这么短。
   */
  private makeRawEntry(channel: string, payload: unknown, at: number): RawEntry {
    let json: string | null = null;
    try {
      json = JSON.stringify(payload) ?? null;
    } catch {
      // 循环引用 / BigInt 等无法序列化的值：如实记一句，不抛
      return { channel, at, payload: '[无法序列化的原生事件]', truncated: true };
    }
    if (json === null) return { channel, at, payload: String(payload), truncated: true };
    if (json.length <= MAX_RAW_ENTRY_BYTES) return { channel, at, payload };
    return { channel, at, payload: json.slice(0, MAX_RAW_ENTRY_BYTES), truncated: true };
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
   * ## 为什么兜底状态不能是 `completed`
   *
   * 「这一轮跑完了」不等于「这个工具做完了」。后者只有 `tool_result` 能证明，
   * 而本函数面对的恰恰是**没有** `tool_result` 的那些块（进程被杀、协议缺口、
   * 适配器漏发）。以前这里按 `completed` 收，后果是双重的：
   *   · 界面显示成功，用户以为命令跑过了；
   *   · `lingeringToolBlocks()` 只认 running/pending，于是「后台任务」永远是 0 ——
   *     功能还在，数据被提前抹平了。
   *
   * 现在按「谁按的停」分三档：正常结束 → `interrupted`（结果未回传）、
   * 用户中止 → `cancelled`、出错 → `failed`。
   */
  finish(status: RunStatus, usage?: { durationMs?: number; cost?: number; tokens?: number }): {
    closes: RunEvent[];
    end: RunEvent;
  } {
    const closes: RunEvent[] = [];
    closes.push(...this.closeOpen(status === 'ok' ? 'done' : 'cancelled'));

    for (const b of this.blocks) {
      // pending 也算：它开了口却从没开始，同样没有结果可回
      if (b.type !== 'tool' || (b.status !== 'running' && b.status !== 'pending')) continue;
      const next: BlockState =
        status === 'ok' ? 'interrupted' : status === 'aborted' ? 'cancelled' : 'error';
      b.status =
        status === 'ok' ? 'interrupted' : status === 'aborted' ? 'cancelled' : 'failed';
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

    // A111：raw 块没有 status 字段，靠 endedAt 判断是否已收尾。
    // 不关它的话，UI 会一直以为这一轮还有旁路事件在进来。
    for (const b of this.blocks) {
      if (b.type !== 'raw' || b.endedAt) continue;
      b.endedAt = this.now();
      closes.push(this.make({ type: 'block_patch', blockId: b.id, patch: { endedAt: b.endedAt } }));
      closes.push(
        this.make({
          type: 'block_close',
          blockId: b.id,
          state: status === 'ok' ? 'done' : status === 'aborted' ? 'cancelled' : 'error',
        })
      );
    }

    // 费用/token 不落块，只有 done 载荷能证明「这一轮确实报了」。
    if (usage?.tokens != null) this.observed.add('usage');
    if (usage?.cost != null) this.observed.add('cost');

    const caps = this.profile(true);
    const end = this.make({
      type: 'run_end',
      status,
      durationMs: usage?.durationMs,
      cost: usage?.cost,
      tokens: usage?.tokens,
      ...(caps ? { capabilities: caps } : {}),
    });
    return { closes, end };
  }

  /** 断线重连用的全量快照 */
  snapshot(): RunEvent {
    return this.make({ type: 'snapshot', blocks: this.blocks.map(b => ({ ...b })) });
  }
}
