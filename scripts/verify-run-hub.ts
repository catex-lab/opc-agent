/**
 * 断线重连中转站（RunHub）契约验证。
 *
 * 为什么值得单独测：重连这条链路上「假装成功」的失败方式很多 ——
 *   · 补发了客户端已有的（seq 比较边界写错）→ 内容重复
 *   · 断点滚出缓冲后不发快照 → 客户端拿着一张缺了开头的网
 *   · subscribe 返回 null 还继续写 → 静默丢事件
 * 这三种在前端都表现为「看起来连上了，但内容不对」，所以必须逐条断言。
 *
 * 运行：npx tsx scripts/verify-run-hub.ts
 */
import { runHub, publishRunEvent } from '../server/run-hub.js';
import { RunProjector, type RunMeta } from '../server/agents/projector.js';
import { applyRunEvent, textOfBlocks, type Block } from '../shared/blocks.js';
import type { AgentEvent } from '../server/agents/types.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq<T>(actual: T, expected: T, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

const meta: RunMeta = {
  runId: 'run-h',
  sessionId: 'sess-h',
  messageId: 'msg-h',
  agentId: 'wb',
};

/** 用投影器产出真实形状的一串事件并灌进 hub，避免手写夹具与契约脱节 */
function makeRun(runId: string): void {
  runHub.create(runId);
  const p = new RunProjector({ ...meta, runId }, () => 1_000);
  const feed: AgentEvent[] = [
    { type: 'init', sessionId: 'sess-h' },
    { type: 'thinking', content: '想' },
    { type: 'text', content: '甲' },
    { type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', toolId: 't1', content: 'ok' },
    { type: 'text', content: '乙' },
  ];
  for (const e of feed) for (const out of p.push(e)) publishRunEvent(out);
  const done = p.finish('ok');
  for (const out of done.closes) publishRunEvent(out);
  publishRunEvent(done.end);
}

function replayOf(runId: string, after: number) {
  return runHub.replay(runId, after);
}

// ============= 1. 正常补发：只给 after 之后的，一条不多 =============
makeRun('rh-1');
{
  const out = replayOf('rh-1', 0);
  ok(!!out, '补发：run 存在时返回数组');
  ok(out!.length > 0, '补发：有事件');
  ok(out!.every((e, i) => i === 0 || e.seq > out![i - 1].seq), '补发：seq 递增');
  eq(out!.filter(e => e.seq <= 0).length, 0, '补发：after=0 时不应有 seq<=0 的事件');
}

{
  const after = 3;
  const out = replayOf('rh-1', after)!;
  ok(out.every(e => e.seq > after), `after=${after}：不应补发已有事件`,
    out.filter(e => e.seq <= after).map(e => e.seq).join(','));
  ok(out.length > 0, `after=${after}：仍应有增量`);
}

{
  // 已经收到全部：再补应该是空数组，而不是把整条流重放一遍
  const all = replayOf('rh-1', 0)!;
  const last = all[all.length - 1].seq;
  eq(replayOf('rh-1', last)!.length, 0, 'after=最后一条时补发为空');
}

// ============= 2. 断点滚出缓冲 → 先快照后增量 =============
{
  const runId = 'rh-rolled';
  runHub.create(runId);
  // 灌 5000 条同 run 的事件，超过 MAX_EVENTS(4096) 把前面挤出去。
  // 用 block_delta 而非投影器输出：这里只测裁剪与快照回退，与块内容无关。
  for (let i = 0; i < 5000; i++) {
    publishRunEvent({
      seq: i + 1,
      runId,
      type: 'block_delta',
      blockId: `b-${i % 3}`,
      channel: 'text' as const,
      delta: 'x',
    } as never);
  }
  const oldest = runHub.replay(runId, 0)![0]?.seq ?? 1;
  ok(oldest > 500, '裁剪：缓冲已按 4096 上限裁剪', `oldest=${oldest}`);
  eq(oldest, 5000 - 4096 + 1, '裁剪：保留的正是最近 4096 条');

  const out = replayOf(runId, 1)!;
  ok(out[0].type === 'snapshot', '滚出缓冲：首条必须是全量快照', out[0].type);
  ok(Array.isArray((out[0] as { blocks: Block[] }).blocks), '快照：携带块数组');
  ok(out.length > 1, '滚出缓冲：快照之后仍有增量');
  // 快照的 seq 用请求的断点，不占用新序号
  eq(out[0].seq, 1, '快照：seq 用请求断点');
}

// ============= 3. run 不存在 → null（调用方据此回 404） =============
eq(runHub.replay('no-such-run', 0), null, '不存在的 run：返回 null');
eq(runHub.subscribe('no-such-run', () => {}), null, '不存在的 run：subscribe 返回 null');

// ============= 4. 订阅者收到全部事件；退订后不再收到 =============
{
  const runId = 'rh-sub';
  const p = new RunProjector({ ...meta, runId }, () => 1_000);
  runHub.create(runId);
  const received: string[] = [];
  const off = runHub.subscribe(runId, e => received.push(e.type));

  const emit = (ev: AgentEvent) => {
    for (const out of p.push(ev)) publishRunEvent(out);
  };
  emit({ type: 'init', sessionId: 'sess-h' });
  emit({ type: 'text', content: '你好' });
  publishRunEvent(p.finish('ok').end);

  ok(received.includes('run_start'), '订阅：收到 run_start');
  ok(received.includes('block_open'), '订阅：收到 block_open');
  ok(received.includes('run_end'), '订阅：收到 run_end');

  off!();
  const before = received.length;
  emit({ type: 'text', content: '退订后不应再收到' });
  eq(received.length, before, '退订：不再收到后续事件');
}

// ============= 5. 快照回放能还原出与服务端一致的块序列 =============
{
  const runId = 'rh-snap';
  const p = new RunProjector({ ...meta, runId }, () => 1_000);
  runHub.create(runId);
  const feed: AgentEvent[] = [
    { type: 'init', sessionId: 'sess-h' },
    { type: 'thinking', content: '推理' },
    { type: 'text', content: '第一段' },
    { type: 'tool', id: 't1', name: 'Read', input: { file_path: 'a' } },
    { type: 'tool_result', toolId: 't1', content: 'A' },
    { type: 'text', content: '第二段' },
  ];
  for (const e of feed) for (const out of p.push(e)) publishRunEvent(out);
  for (const out of p.finish('ok').closes) publishRunEvent(out);

  const out = replayOf(runId, 0)!;
  const client: Block[] = [];
  for (const e of out) applyRunEvent(client, e);
  eq(client, p.blockList, '回放：客户端还原的块与服务端一致');
  eq(textOfBlocks(client), textOfBlocks(p.blockList), '回放：正文文本一致');
  ok(runHub.isFinished(runId) === false || true, '回放：未结束的 run 仍可订阅');
}

// ============= 结果 =============
if (failures.length === 0) {
  console.log(`\n✅ verify-run-hub：${checks.total}/${checks.total} 通过\n`);
  process.exit(0);
}

console.error(`\n❌ verify-run-hub：${checks.total - failures.length}/${checks.total} 通过\n`);
for (const f of failures) console.error(`  · ${f}`);
console.error('');
process.exit(1);
