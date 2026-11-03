/**
 * 轨迹行 = 步骤 / 思考 / 旁白。
 *
 * 为什么旁白要进轨迹：一轮回答里常夹着「我先看一下目录」「Codex 的历史
 * 记录存在 ~/.codex 里」这类叙述。它们在界面上属于**过程**，不是答案；
 * 但 `shared/trace.buildTrace` 只认工具与思考，遇到 text 块会跳过。
 * 如果渲染层各自处理，旁白就会落在轨迹外面 —— 收拢时收不起来，展开时
 * 又把答案往下推。
 *
 * 这里按 text 块把块序列切成若干段：每段继续走 `buildTrace`（思考仍能
 * 挂到段内上一个工具下面），段与段之间插入一条旁白行。旁白本身不携带
 * 状态，也不参与完成判定。
 */

import type { Block } from '../../shared/blocks';
import { buildTrace, type TraceItem } from '../../shared/trace';
import { resolveTraceItems, type ResolveTraceOptions, type ResolvedTraceItem } from './fold';

/** 轨迹内部的一段旁白（原 TextBlock 的纯文本） */
export interface TraceNarration {
  kind: 'text';
  id: string;
  text: string;
}

/** 折叠体里的一行 */
export type TraceRow = ResolvedTraceItem | TraceNarration;

export function isNarration(row: TraceRow): row is TraceNarration {
  return row.kind === 'text';
}

/**
 * 消息的「过程区」能否合并成一条轨迹。
 *
 * 两个条件缺一不可：过程区里确实有工具（纯思考/纯文本消息不硬套摘要条），
 * 且没有 AgentTrace 不认识的块（image / artifact / note）——否则合并会
 * 把这些块吞掉或改变它们的顺序。
 *
 * `raw` 是原生事件的旁路抽屉：UI 不渲染（renderBlock 返回 null），
 * 轨迹行也跳过它。它不该把整轮归并挡在门外 —— CLI 通道每轮都会带一条
 * `system/init` 之类的未识别行，一旦要求「全是可见块」就永远合并不了。
 */
export function canGroupProcess(blocks: readonly Block[]): boolean {
  const visible = blocks.filter(b => b.type !== 'raw');
  return (
    visible.some(b => b.type === 'tool') &&
    visible.every(b => b.type === 'tool' || b.type === 'thinking' || b.type === 'text')
  );
}

/** 只要步骤 / 思考行（摘要、步数、耗时都按它们算） */
export function stepRows(rows: readonly TraceRow[]): ResolvedTraceItem[] {
  return rows.filter((row): row is ResolvedTraceItem => row.kind !== 'text');
}

/**
 * 块序列 → 轨迹行（含旁白）。
 *
 * 切段还有一个语义作用：旁白前的那一步思考，不再跨过旁白挂到更早的
 * 工具下面 —— 它和被旁白隔开的工具已经不是「紧跟在后面」的关系了。
 */
export function buildTraceRows(blocks: readonly Block[], opts: ResolveTraceOptions): TraceRow[] {
  const rows: TraceRow[] = [];
  let chunk: Block[] = [];

  const flush = () => {
    if (chunk.length === 0) return;
    const items: TraceItem[] = buildTrace(chunk);
    rows.push(...resolveTraceItems(items, opts));
    chunk = [];
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      flush();
      const text = block.text.trim();
      if (text) rows.push({ kind: 'text', id: block.id, text });
      continue;
    }
    if (block.type === 'tool' || block.type === 'thinking') chunk.push(block);
  }

  flush();
  return rows;
}
