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

import type { CapabilityProfile } from './capabilities';
import type { PermissionOption } from './permissions';

// ============= 块 =============

/**
 * 块的终态。
 *
 * `interrupted` 与 `cancelled` 的区别是**谁按的停**：
 *   · `cancelled` —— 用户 / 宿主主动中止，我们确实知道它停在这一步
 *   · `interrupted` —— 这一轮**正常结束**了，但这个块始终没回结果
 *     （进程退出、适配器漏发 tool_result、超时）
 *
 * 后者既不是「成功」也不是「失败」：把它伪造成 `done` 会让用户以为工具跑完了，
 * 伪造成 `error` 又凭空指控了一次失败。所以单列一档，界面才有话可说。
 */
export type BlockState = 'streaming' | 'done' | 'error' | 'cancelled' | 'interrupted';

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
  /**
   * 厂商把思考内容隐去了，只留下「有过一段思考」这个事实
   * （如 Anthropic 的 `redacted_thinking`）。此时 `text` 为空，
   * 界面显示「已隐去」，**不是**一个空白思考框。
   */
  redacted?: boolean;
}

/**
 * 工具块状态。
 *
 * `interrupted` 不是「还在跑」：它是本轮已经收尾、但这个工具从未报回结果。
 * 之所以独立一档，是因为它同时是「后台任务」胶囊的数据来源 ——
 * 那些调用可能真的还在子进程里跑，界面必须如实说「结果未回传」，
 * 而不是永远转圈（running）或假装完成（completed）。
 */
export type ToolBlockStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

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

/**
 * A205：bash 的「引号没配对」报错归类提示。
 *
 * 这一类失败几乎都不是脚本本身的问题，而是 CLI 自己的 shell 包装层把
 * 内层引号打乱了（Windows 路径 + 双引号最容易触发）。提示必须落在轨迹里，
 * 否则用户只会看到一句 bash EOF，误以为脚本坏了。
 *
 * 真机取证（qoder-cn，2026-11-03）：Qoder 的 Bash 工具用 `/usr/bin/bash eval`
 * 执行命令，`"C:\Users\..."` 的双引号会被这一层打乱；命令里的 `$_` 也会被
 * bash 展开（真机上 `$_.Length` 变成了 `extglob.Length`）。所以示例用**单引号**：
 * bash 不展开单引号内容，PowerShell 仍能收到原始 Windows 路径。
 */
const CLI_SHELL_QUOTE_ERR_RE = /unexpected EOF(?: while)? looking for matching/i;
export const CLI_SHELL_QUOTE_HINT =
  `[提示] 这是 CLI 的 shell 引号解析问题（bash: unexpected EOF looking for matching "），不是脚本本身出错。可改用单引号路径重试：powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\\path\\to\\your-script.ps1'`;

/** 命中引号类报错时追加一行可复制提示；幂等，重复调用不会叠多行 */
export function withCliShellQuoteHint(output: string): string {
  if (!CLI_SHELL_QUOTE_ERR_RE.test(output)) return output;
  if (output.includes(CLI_SHELL_QUOTE_HINT)) return output;
  return `${output.trimEnd()}\n\n${CLI_SHELL_QUOTE_HINT}`;
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

/**
 * 失败原因块。
 *
 * 为什么要落成块而不是只靠实时事件：错误原来只存在于 SSE 流里（前端挂在
 * `message.error` 上），刷新一次就没了 —— 界面上只剩一条没有内容的助手气泡，
 * 用户既看不到原因，也无法事后核对。落成块之后它和正文/工具走同一条
 * blocks 持久化路径，刷新、断线重放、历史接口都一致，不需要改表结构。
 *
 * 只存**已经整理过的最终文案**（适配器负责把 stderr 尾部、CLI 日志目录、
 * 最后一次结构化错误拼进去），渲染端原样展示，不做二次解释。
 */
export interface ErrorBlock {
  id: string;
  type: 'error';
  /** 可直接展示的失败原因（可能多行） */
  message: string;
  retryable?: boolean;
  /** 失败发生时刻（毫秒） */
  at: number;
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolBlock
  | ImageBlock
  | NoteBlock
  | ArtifactBlock
  | RawBlock
  | ErrorBlock;

// ============= 事件（v2） =============

export type RunStatus = 'ok' | 'aborted' | 'error';

export type BlockDeltaChannel = 'text' | 'input' | 'output';

interface Seq {
  /** 每个 run 内单调递增，从 1 开始。断线重放靠它定位 */
  seq: number;
  runId: string;
}

/**
 * 首轮知识库注入的引用条目（只读展示用）。
 *
 * 只在「本轮确实注入了上下文」时下发。`citations` 为空数组表示注入了
 * 「未检索到」状态行，不是「没注入」—— 没注入时压根不会有 kb_refs 事件。
 */
export interface KbCitationRef {
  citationId: string;
  sessionId: string;
  sessionTitle?: string;
  sourceType: 'direct' | 'group';
  role: string;
  agentId?: string | null;
  timeEnd: string;
  snippet: string;
  messageIds?: string[];
}

export type RunEvent = Seq &
  (
    | {
        type: 'run_start';
        sessionId: string;
        messageId: string;
        agentId: string;
        model?: string;
        /**
         * P1：这一轮**真正交给 Agent 的模型名**（服务端 resolve 之后的值）。
         *
         * 与 `model` 的区别不是值，而是契约：`model` 是这一轮的元信息，历史
         * 夹具 / 老服务端都可能随手填；`modelEffective` 由 `/api/chat` 显式
         * 从 `resolveStoredModelForAgent()` 的结果写入，前端**只认它**来回显。
         * 这样老夹具（不带这个字段）不会被新回显逻辑误伤。
         *
         * 空串 = 解析结果是 `undefined`，即不传 `--model`、由 Agent 自己决定；
         * 界面要据此说「由 Agent 决定」，而不是继续挂着一个不生效的名字。
         * `requested` 与它不同时说明发生了静默替换 —— 用户第三问的原话
         * 「输入框里展示的不一定是真实实时的模型」就是这一条。
         */
        modelEffective?: string;
        /**
         * 这一轮的过程能力档（P2）：key + declared（+ probed，标定过才有）。
         * `observed` 此刻还不知道 —— 它要等这一轮真跑完，见 `run_end`。
         */
        capabilities?: CapabilityProfile;
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
        /**
         * 同一份能力档，此刻补上 `observed` —— 这一轮**真的出现过**哪几类事件。
         *
         * 为什么放在 run_end 而不是另发一条事件：客户端收到 run_end 常会立刻
         * 刷新会话/写库，两件事挨在一起才不会出现「已结束但能力档还是空的」
         * 那一瞬。空数组是有意义的结论（"这一轮一项都没出现"），不能省略。
         */
        capabilities?: CapabilityProfile;
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
        /** P4：本次真实可选的答复档位；缺省 = 适配器没声明，前端用两按钮兜底 */
        options?: PermissionOption[];
      }
    /**
     * 断线重连时先发的一条全量快照。
     * 收到它意味着「丢掉本地这轮的所有块，以我为准」，然后接着收增量。
     */
    | { type: 'snapshot'; blocks: Block[] }
    /**
     * 首轮知识库注入的引用清单。
     *
     * 不参与块状态（不进 snapshot、不改变折叠），只供回答区展示
     * 「引用了 N 条历史会话」；断线重连时客户端保留已有值。
     */
    | { type: 'kb_refs'; count: number; citations: KbCitationRef[] }
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
    case 'kb_refs':
      // 引用清单不驱动块数组，交由前端挂在消息上
      return false;
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
              : ev.state === 'interrupted'
                ? 'interrupted'
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

/**
 * A122 第四段绳：把本轮还开着的块就地收口（客户端兜底）。
 *
 * 服务端 `RunProjector.finish()` 会给所有开着的块补发 `block_close`，但用户按
 * 「停止」时前端已经 `controller.abort()` 掐断了 SSE，而 `stopped` 分支明确**不**
 * 走断线重连 —— 这些收尾事件永远到不了客户端。于是 thinking 块的 `state` 永远
 * 停在 `'streaming'`：`ThinkingView` 的 spinner 与 `useElapsed` 秒表一直挂着
 * （实测「已用 144s」还在涨），按钮却早已恢复成发送键 —— 看着就是「假停止」。
 * 报错 / 断流 / 早退这几条路径同理：只要没收到 closes，本地就没人收尾。
 *
 * 只动仍在跑的块，已经 closed 的一律不碰 —— 正常 `run_end` 路径不该被改写。
 * 终态用 `interrupted`（结果未回传）而非 `done` / `error`：前者会假装跑完了，
 * 后者会凭空指控一次失败。与 `RunProjector.finish()` 的口径保持一致。
 *
 * @returns 是否真的改了块（供调用方决定要不要立刻 flush 进 React 状态）
 */
export function sealOpenBlocks(blocks: Block[]): boolean {
  const now = Date.now();
  let changed = false;
  for (const b of blocks) {
    if (b.type === 'text' || b.type === 'thinking') {
      if (b.state !== 'streaming') continue;
      b.state = 'interrupted';
      if (b.type === 'thinking') b.endedAt = b.endedAt ?? now;
      changed = true;
    } else if (b.type === 'tool') {
      if (b.status !== 'running' && b.status !== 'pending') continue;
      b.status = 'interrupted';
      b.endedAt = b.endedAt ?? now;
      changed = true;
    } else if (b.type === 'raw') {
      if (b.endedAt) continue;
      b.endedAt = now;
      changed = true;
    }
  }
  return changed;
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
 * 分阶段的 spinner：不同阶段说不同的话，而不是一个笼统词。
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

/**
 * 失败原因块的文案（取最后一条；没有则空串）。
 *
 * 失败回合常常只有这一块、没有任何正文，`content` 兼容字段会是空的 ——
 * 会话列表最后一条预览、搜索、老组件都会因此显示「空白」。用它兜底，
 * 让历史里至少能看到「失败 + 原因」，而不是一条空泡。
 */
export function errorTextOfBlocks(blocks: readonly Block[]): string {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b.type === 'error') return b.message;
  }
  return '';
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
          : b.status === 'failed' ||
              b.status === 'cancelled' ||
              b.status === 'interrupted' ||
              b.isError
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
