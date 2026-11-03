/**
 * 过程流折叠：把 `shared/trace` 的原始轨迹行再走一遍「完成判定」。
 *
 * 为什么单独一层：完成状态不能只看 `block.status`。结构化事件里
 * `block_close` 会带来真实的 `endedAt`；而纯文本解析（`source='parsed_text'`）
 * 或适配器漏发结果时，状态可能一直停在 `running`。直接把它画成「执行中…」
 * 会让一条早已跑完的步骤永远转圈，直接当成完成又是在编造事实。
 *
 * 判定优先级（与用户确认的生产口径一致）：
 *
 *   1. **真实结束事件**：`endedAt > 0` 或终态（completed / failed /
 *      cancelled / interrupted）。这是唯一可以直接采信的证据。
 *   2. **下一条事件兜底**：仍在流式，且这一步之后确实还有事件
 *      （同组下一个块、挂在本步下面的思考、或正文已经开始），
 *      才把上一步按已完成处理。事件顺序本身就是「它已经让位了」的证据。
 *   3. **没有后续事件**：保持 `running`，长耗时命令不能被假装跑完。
 *   4. **本轮已结束但一直没有结束事件**：标成 `missing`（结果未回传），
 *      不是完成，也不是仍在跑。非老数据会落到 `interrupted` 的既有表达。
 *
 * `critical` 是「完成后仍常驻展开」的四类关键步骤：写入（含编辑）、删除、
 * 报错、权限。权限请求在当前链路里由右下角浮层承担，不会进入轨迹块；
 * 这里仍按工具名预留判定，避免将来有 Agent 把它作为普通工具吐出来时又被折叠。
 */

import {
  EDIT_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type TraceItem,
  type TraceStatus,
} from '../../shared/trace';

/** 这一步的完成结论 */
export type StepCompletion =
  /** 有真实结束事件 */
  | 'real'
  /** 没有结束事件，但后一条事件已经到达（流式中） */
  | 'next-event'
  /** 没有结束事件，也没有后续事件：保持运行中 */
  | 'open'
  /** 本轮已结束，仍然没有结束事件：结果未回传 */
  | 'missing';

/** 关键步骤原因，落在 DOM 上便于核对，也用于 tooltip */
export type CriticalReason = 'write' | 'delete' | 'permission' | 'error';

export interface ResolvedTraceItem extends TraceItem {
  completion: StepCompletion;
  critical: boolean;
  criticalReason?: CriticalReason;
}

export interface ResolveTraceOptions {
  /** 这一轮是否仍在流式（决定 missing 与 open 哪个成立） */
  streaming: boolean;
  /**
   * 正文内容是否已经开始。
   *
   * 这就是 AgentTrace 的 `collapse`：ChatMessages 只在「最后一个工具之后
   * 出现非空正文」时把它置真，因此它恰好等价于「首个正文内容 token 已到达」，
   * 而不是任意首 token。它同时也是最后一步工具的后续事件证据。
   */
  contentStarted: boolean;
}

const DELETE_TOOL_NAMES: ReadonlySet<string> = new Set(['delete', 'deletefile']);
const PERMISSION_TOOL_NAME = /permission|approval|authoriz/i;

function hasRealEnd(item: TraceItem): boolean {
  if (item.kind !== 'tool') {
    const t = item.thinking;
    if (!t) return true;
    return t.state !== 'streaming' || (typeof t.endedAt === 'number' && t.endedAt > 0);
  }
  const b = item.block;
  if (!b) return item.status !== 'running';
  if (typeof b.endedAt === 'number' && b.endedAt > 0) return true;
  return (
    b.status === 'completed' ||
    b.status === 'failed' ||
    b.status === 'cancelled' ||
    b.status === 'interrupted'
  );
}

/**
 * 这一步之后是否还有事件。
 *
 * 只数「真的事件」，不数 UI 推断：同组后续块、挂在本步下面的思考、
 * 以及已经开始的正文。正文之后若又来了新工具，ChatMessages 的
 * `contentStarted` 会暂时回落，此时新工具本身会成为下一步的后续事件。
 */
function hasFollowingEvent(
  items: readonly TraceItem[],
  index: number,
  contentStarted: boolean
): boolean {
  if (index < items.length - 1) return true;
  if (items[index]!.nested.length > 0) return true;
  return contentStarted;
}

function statusOf(
  item: TraceItem,
  completion: StepCompletion,
  streaming: boolean
): TraceStatus {
  if (completion === 'real') {
    // endedAt 已经落下来但 status 还停在 running 的老快照：以结束事件为准
    return item.status === 'running' && item.kind === 'tool' ? 'done' : item.status;
  }
  if (completion === 'next-event') return 'done';
  if (completion === 'open') return 'running';
  // missing：本轮已经结束，却没有收到结束事件。
  // 有 startedAt 的块按既有「结果未回传」表达；老数据（startedAt=0）
  // 不做二次加工，避免把历史上「当年没记状态」的块重新上色。
  const startedAt = item.block?.startedAt ?? 0;
  return !streaming && startedAt > 0 ? 'interrupted' : item.status;
}

function criticalReasonOf(item: TraceItem, status: TraceStatus): CriticalReason | undefined {
  if (item.kind !== 'tool') return undefined;
  if (status === 'error') return 'error';
  if (DELETE_TOOL_NAMES.has(item.toolName)) return 'delete';
  if (WRITE_TOOL_NAMES.has(item.toolName) || EDIT_TOOL_NAMES.has(item.toolName)) return 'write';
  if (PERMISSION_TOOL_NAME.test(item.toolName)) return 'permission';
  return undefined;
}

function resolveOne(
  item: TraceItem,
  items: readonly TraceItem[],
  index: number,
  opts: ResolveTraceOptions
): ResolvedTraceItem {
  const real = hasRealEnd(item);
  let completion: StepCompletion;

  if (item.kind === 'tool') {
    if (real) completion = 'real';
    else if (!opts.streaming) completion = 'missing';
    else if (hasFollowingEvent(items, index, opts.contentStarted)) completion = 'next-event';
    else completion = 'open';
  } else {
    // 思考不是「步骤」，没有 next-event 兜底：没回结束就仍是进行中
    completion = real ? 'real' : 'open';
  }

  const status = statusOf(item, completion, opts.streaming);
  const criticalReason = criticalReasonOf(item, status);

  return {
    ...item,
    status,
    completion,
    critical: !!criticalReason,
    criticalReason,
    nested: item.nested.map(n => ({
      ...n,
      status: hasRealEnd(n) ? n.status : 'running',
      completion: hasRealEnd(n) ? 'real' : 'open',
      critical: false,
    })),
  };
}

/** 原始轨迹 → 带完成判定与关键步骤标记的轨迹 */
export function resolveTraceItems(
  items: readonly TraceItem[],
  opts: ResolveTraceOptions
): ResolvedTraceItem[] {
  return items.map((item, index) => resolveOne(item, items, index, opts));
}
