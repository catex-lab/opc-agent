/**
 * 消息块模型与事件契约（前后端共用）。
 *
 * ## 为什么要这一层
 *
 * 一条助手回复内部有多种异构内容：思考、正文、工具调用、图片、编排叙述。
 * 旧的表示法是**几个平行字段**（content / thinking / toolCalls / contentBlocks），
 * 于是「思考 → 说话 → 再思考 → 调工具」这种顺序**根本无法表达** ——
 * 思考被固定画在正文上方，刷新后还会丢（thinking 当年没落库）。
 *
 * 现在统一成**一条有序的 block 序列**：
 *   - 顺序 = 数组顺序，不再靠字段位置猜
 *   - 流式 = block_open / block_delta / block_patch / block_close 四种生命周期
 *   - 落库 = 整条序列一次性存 JSON，刷新后与流式中**同一份数据**
 *
 * ## 分层
 *
 *   adapter（各家方言）→ AgentEvent（v1，最小公共集）
 *        → RunProjector（server，唯一一处累积逻辑）
 *        → RunEvent（v2，本文件）
 *        → SSE / 落库 / 群聊多路复用
 *
 * 前端只认 RunEvent，不再各自实现一遍「往最后一个块里追加」。
 *
 * ⚠️ 本文件只放类型与纯函数，不许 import server/ 或 src/ 模块。
 */

// ============= 块 =============

export type BlockState = 'streaming' | 'done' | 'error' | 'cancelled';

export interface TextBlock {
  id: string;
  type: 'text';
  text: string;
  state: BlockState;
}

/**
 * 思考块。
 *
 * `format` 区分「模型原始思考」与「厂商给出的摘要」：codex 只给 reasoning
 * summary，硬标成「思考过程」会让用户以为看到了完整推理链。UI 据此换文案。
 */
export interface ThinkingBlock {
  id: string;
  type: 'thinking';
  text: string;
  state: BlockState;
  format: 'raw' | 'summary';
  startedAt: number;
  endedAt?: number;
}

export type ToolBlockStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 工具事件的**来源可信度**（A100）。
 *
 * 为什么需要这个字段：13 个 CLI 里 9 个吐 jsonl、1 个吐 json-object、
 * **3 个只有纯文本**。前两类的事件是 Agent 自己声明的结构化事件，
 * 纯文本那 3 个则是适配器从 stdout 里**解析**出来的 —— 看起来一样，
 * 可信度差一个量级。不给用户区分，等于把「我猜的」和「它说的」画成同一个样子。
 *
 * 粒度为**每个 Agent**而不是每个事件：一个 Agent 的输出方式不会中途改变，
 * 逐事件标注只是把同一个值抄一万遍。
 *
 * 刻意没有 `inferred`（推断）这一档：本项目的适配器不产生推断事件 ——
 * 解析文本好歹有原文可对，而「根据等待时间猜它在干什么」那种做法这里没做，
 * 也就不需要为它留一个名字。
 */
export type EventSource =
  /** 官方 SDK / ACP 协议 / 结构化 HTTP 接口 */
  | 'native'
  /** CLI 的 jsonl / json-object 结构化输出 */
  | 'structured_cli'
  /** CLI 的纯文本输出，由适配器按模式解析出来 */
  | 'parsed_text';

export interface ToolBlock {
  id: string;
  type: 'tool';
  /** 厂商侧的工具调用 id，用于 tool_result 配对 */
  toolId: string;
  name: string;
  input?: Record<string, unknown>;
  /** 流式拼装中的半截 JSON（Anthropic 的 input_json_delta） */
  inputRaw?: string;
  /** 输出（bash 的 stdout、工具返回的文本） */
  output?: string;
  /** 输出被截断时置真，UI 提示「仅显示前 N 字」 */
  outputTruncated?: boolean;
  status: ToolBlockStatus;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
  /**
   * 这个工具事件是怎么来的。缺省 = 未知（老数据 / mock 适配器），
   * UI 对缺省值**不标注也不猜测**。
   */
  source?: EventSource;
}

/** 图片块的数据部分，字段与 src/types.ts 的 ImageBlock 保持结构兼容 */
export interface BlockImage {
  url: string;
  prompt?: string;
  size?: string;
  model?: string;
  provider?: string;
  alt?: string;
  sourceUrl?: string;
  expiresAt?: string;
}

export interface ImageBlock {
  id: string;
  type: 'image';
  image: BlockImage;
}

/** 可下载或可复用的任务产物（参考 A2A Artifact）；与过程消息分离。 */
export interface ArtifactBlock {
  id: string;
  type: 'artifact';
  name: string;
  mediaType: string;
  /** 本地 API 路径或稳定 URI；不应放短期签名 URL */
  uri?: string;
  /** 小型结构化结果；大型文件应通过 uri 获取 */
  data?: unknown;
  description?: string;
}

/** 编排叙述（群聊的「主控决定交给 X」「第 2/3 棒」） */
export interface NoteBlock {
  id: string;
  type: 'note';
  text: string;
  level: 'info' | 'warn';
}

/**
 * 原生事件旁路块（A111）。
 *
 * 装的是**适配器没能归一化**的原生事件原文。存在的意义只有一条：不丢。
 *
 * 设计上刻意保持「一个 run 最多一块」——同一轮里几十条未识别事件如果各占一块，
 * 消息流会被冲垮；聚合到一块、折叠展示，既不挡路又随时可查。
 *
 * 体积控制放在投影器（`MAX_RAW_ENTRIES` / `MAX_RAW_ENTRY_BYTES`）：payload 是
 * 各家 CLI 的原生 JSON，可能有整段上下文，直接落库会把 SQLite 撑爆。
 */
export interface RawBlock {
  id: string;
  type: 'raw';
  /** 未识别事件的条数（含已被省略的） */
  count: number;
  /** 保留下来的条目（按到达顺序）；超过上限后只增 count 不加条目 */
  entries: RawEntry[];
  /** 因体积/条数上限被省略的条数 */
  omitted: number;
  /** 收尾时间；缺失 = 本轮还在继续追加 */
  endedAt?: number;
}

export interface RawEntry {
  /** `协议:原生类型`，如 `sdk:stream_event` */
  channel: string;
  /** 到达时刻（毫秒） */
  at: number;
  /** 原生事件原文（已按 MAX_RAW_ENTRY_BYTES 截断） */
  payload: unknown;
  /** payload 被截断时置真，UI 提示「仅保留前 N 字节」 */
  truncated?: boolean;
}

export type Block = TextBlock | ThinkingBlock | ToolBlock | ImageBlock | NoteBlock | ArtifactBlock | RawBlock;

// ============= 事件（v2） =============

export type RunStatus = 'ok' | 'aborted' | 'error';

export type BlockDeltaChannel = 'text' | 'input' | 'output';

interface Seq {
  /** 每个 run 内单调递增，从 1 开始。断线重放靠它定位 */
  seq: number;
  runId: string;
}

export type RunEvent = Seq &
  (
    | {
        type: 'run_start';
        sessionId: string;
        messageId: string;
        agentId: string;
        model?: string;
      }
    | { type: 'block_open'; block: Block }
    | { type: 'block_delta'; blockId: string; channel: BlockDeltaChannel; delta: string }
    | { type: 'block_patch'; blockId: string; patch: Record<string, unknown> }
    | { type: 'block_close'; blockId: string; state: BlockState }
    | {
        type: 'run_end';
        status: RunStatus;
        durationMs?: number;
        cost?: number;
        tokens?: number;
      }
    | {
        type: 'error';
        scope: 'run' | 'block' | 'tool';
        message: string;
        blockId?: string;
        retryable?: boolean;
      }
    | {
        type: 'permission_request';
        requestId: string;
        toolUseId?: string;
        toolName: string;
        input: Record<string, unknown>;
        /** A40 门禁判出的风险分级（缺省 = safe） */
        risk?: 'safe' | 'risky' | 'dangerous';
        /** 命中的规则名（人话），弹窗上显示「为什么问这一句」 */
        rule?: string;
      }
    /**
     * 断线重连时先发的一条全量快照。
     * 收到它意味着「丢掉本地这轮的所有块，以我为准」，然后接着收增量。
     */
    | { type: 'snapshot'; blocks: Block[] }
  );

/** 事件类型的判别联合，供 reducer 使用 */
export type RunEventType = RunEvent['type'];

// ============= 事件应用（前后端共用的唯一一份 reducer） =============

/**
 * 把一条事件应用到块数组上（原地修改）。
 *
 * 为什么放在 shared 而不是前端：断线重放的快照也要靠它算出来。
 * 如果服务端另写一份「事件 → 当前块」的逻辑，两份迟早不一致，
 * 重连后用户会看到和刚才不一样的界面 —— 这正是这次改造要消灭的问题。
 *
 * @returns 是否发生了变化（供调用方决定要不要重渲染）
 */
export function applyRunEvent(blocks: Block[], ev: RunEvent): boolean {
  switch (ev.type) {
    case 'block_open': {
      // 重放时可能重复收到同一个块：按 id 去重，避免出现两份
      const idx = blocks.findIndex(b => b.id === ev.block.id);
      if (idx >= 0) blocks[idx] = { ...ev.block };
      else blocks.push({ ...ev.block });
      return true;
    }

    case 'block_delta': {
      const block = blocks.find(b => b.id === ev.blockId);
      if (!block) return false;
      if (block.type === 'text' || block.type === 'thinking') {
        block.text += ev.delta;
      } else if (block.type === 'tool') {
        if (ev.channel === 'input') block.inputRaw = (block.inputRaw ?? '') + ev.delta;
        else block.output = (block.output ?? '') + ev.delta;
      }
      return true;
    }

    case 'block_patch': {
      const block = blocks.find(b => b.id === ev.blockId);
      if (!block) return false;
      // `append` 是 raw 块专用的**追加语义**（A111），必须单独处理。
      //
      // 踩过的坑：投影器发的是 `patch: { count, append: entry }`，想表达「只把
      // 新增那一条带上，别每次把前 19 条重发一遍」。但这里原本是一句裸的
      // `Object.assign(block, ev.patch)` —— 于是 `append` 变成了块上的一个**游离
      // 字段**，`entries` 一次都没长过。表现是：流式过程中 raw 块只显示第一条，
      // 刷新一次（走 snapshot 从库里读）才突然全出来。
      //
      // 这类 bug 特别难发现，因为投影器的单测全绿（服务端 `this.blocks` 是对的），
      // 而客户端那条应用路径没人测。所以 verify-a111 里补了 applyRunEvent 的断言。
      const { append, ...rest } = ev.patch as { append?: RawEntry } & Record<string, unknown>;
      Object.assign(block, rest);
      if (block.type === 'raw' && append) block.entries.push(append);
      return true;
    }

    case 'block_close': {
      const block = blocks.find(b => b.id === ev.blockId);
      if (!block) return false;
      if (block.type === 'tool') {
        block.status =
          ev.state === 'done'
            ? 'completed'
            : ev.state === 'cancelled'
              ? 'cancelled'
              : 'failed';
        block.endedAt = block.endedAt ?? Date.now();
      } else if (block.type === 'text' || block.type === 'thinking') {
        block.state = ev.state;
        if (block.type === 'thinking') block.endedAt = block.endedAt ?? Date.now();
      }
      return true;
    }

    case 'snapshot': {
      blocks.length = 0;
      for (const b of ev.blocks) blocks.push({ ...b });
      return true;
    }

    default:
      return false;
  }
}

/** 当前块序列的「进行中」摘要，供 UI 显示「思考中…」「执行中…」 */
export function runActivity(blocks: readonly Block[]): 'thinking' | 'tool' | 'writing' | 'idle' {
  // 找「最后一个有意义的主流程块」：note 是提示、raw 是旁路通道，两者都不代表
  // 当前在干什么。A111 之前只跳过 note，于是 SDK 在正文之后来一条原生事件
  // （stream_event 很常见），阶段就掉回 idle，spinner 从「正在生成」变回
  // 「正在处理」—— 明明还在跑，看起来却像卡住了。
  const last = [...blocks].reverse().find(b => b.type !== 'note' && b.type !== 'raw');
  if (!last) return 'idle';
  if (last.type === 'thinking' && last.state === 'streaming') return 'thinking';
  if (last.type === 'tool' && (last.status === 'running' || last.status === 'pending')) return 'tool';
  if (last.type === 'text' && last.state === 'streaming') return 'writing';
  return 'idle';
}

/**
 * 流式状态行的阶段文案（A34）。
 *
 * spinner mode：不同阶段说不同的话，而不是一个笼统词。
 * 默认（刚发出、还没有任何块）是「正在处理」—— 中性、不借用任何厂商的
 * 专属说法。放在 shared 是为了能被单测直接调用，且与 runActivity 用同一套判据。
 */
export function streamPhaseLabel(blocks: readonly Block[], imageMode = false): string {
  if (imageMode) return '正在生成图像';
  const activity = runActivity(blocks);
  if (activity === 'thinking') return '正在思考';
  if (activity === 'tool') {
    const running = [...blocks]
      .reverse()
      .find(b => b.type === 'tool' && (b.status === 'running' || b.status === 'pending'));
    return running && running.type === 'tool' ? `正在调用 ${running.name}` : '正在调用工具';
  }
  if (activity === 'writing') return '正在生成';
  return '正在处理';
}

// ============= 纯函数工具 =============

/** 拼接所有正文块（用于 message.content 这类兼容字段） */
export function textOfBlocks(blocks: readonly Block[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/** 拼接所有思考块 */
export function thinkingOfBlocks(blocks: readonly Block[]): string {
  return blocks
    .filter((b): b is ThinkingBlock => b.type === 'thinking')
    .map(b => b.text)
    .join('');
}

/** 工具块 → 旧版 ToolCall 形状（给 ToolCallsCollapse 这类既有组件用） */
export interface LegacyToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
}

export function toolCallsOfBlocks(blocks: readonly Block[]): LegacyToolCall[] {
  return blocks
    .filter((b): b is ToolBlock => b.type === 'tool')
    .map(b => ({
      id: b.toolId || b.id,
      name: b.name,
      input: b.input,
      status:
        b.status === 'completed'
          ? 'completed'
          : b.status === 'failed' || b.status === 'cancelled' || b.isError
            ? 'error'
            : 'running',
      result: b.output,
      isError: b.isError,
    }));
}

/** 是否有任何块（用于「思考中…」占位判断） */
export function hasVisibleContent(blocks: readonly Block[]): boolean {
  return blocks.some(b => {
    if (b.type === 'text') return b.text.length > 0;
    if (b.type === 'thinking') return b.text.length > 0;
    return true;
  });
}

/**
 * 旧数据 → 块序列。
 *
 * 老消息在库里只有 content / tool_calls / images 三列，**顺序信息已经丢了**。
 * 这里按旧版渲染的既有顺序还原（思考 → 工具 → 图片 → 正文），
 * 保证「刷新后」与用户当年看到的样子一致；新消息一律走 blocks 列，不进这里。
 */
export function legacyToBlocks(input: {
  content?: string;
  thinking?: string;
  toolCalls?: LegacyToolCall[];
  images?: BlockImage[];
}): Block[] {
  const out: Block[] = [];
  const { content, thinking, toolCalls, images } = input;

  if (thinking) {
    out.push({
      id: 'legacy-thinking',
      type: 'thinking',
      text: thinking,
      state: 'done',
      format: 'raw',
      startedAt: 0,
      endedAt: 0,
    });
  }

  for (const t of toolCalls ?? []) {
    out.push({
      id: `legacy-tool-${t.id}`,
      type: 'tool',
      toolId: t.id,
      name: t.name,
      input: t.input,
      output: t.result,
      status: t.status === 'completed' ? 'completed' : t.status === 'error' ? 'failed' : 'running',
      isError: t.isError,
      startedAt: 0,
      endedAt: 0,
    });
  }

  for (const [i, img] of (images ?? []).entries()) {
    out.push({ id: `legacy-image-${i}`, type: 'image', image: img });
  }

  if (content) {
    out.push({ id: 'legacy-text', type: 'text', text: content, state: 'done' });
  }

  return out;
}
