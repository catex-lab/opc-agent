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
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import { readFileSync } from 'node:fs';
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

// ============= 2. 断点滚出缓冲 → 快照恢复完整正文，且不重复回放 =============
{
  const runId = 'rh-rolled';
  runHub.create(runId);
  // 用投影器产出真实事件：run_start + block_open + 5000 条 block_delta，
  // 超过 MAX_EVENTS(4096) 后前面的开块事件会被挤出去 —— 正是「断点滚出缓冲」。
  const p = new RunProjector({ ...meta, runId }, () => 1_000);
  for (const out of p.push({ type: 'init', sessionId: 'sess-h' })) publishRunEvent(out);
  for (let i = 0; i < 5000; i++) {
    for (const out of p.push({ type: 'text', content: 'x' })) publishRunEvent(out);
  }
  const serverText = textOfBlocks(p.blockList);
  eq(serverText.length, 5000, '溢出前：服务端正文是 5000 字');

  const buffered = replayOf(runId, 0)!;
  const oldest = buffered[0]?.seq ?? 1;
  const newest = buffered[buffered.length - 1]?.seq ?? 1;
  ok(oldest > 500, '裁剪：缓冲已按 4096 上限裁剪', `oldest=${oldest}`);
  eq(newest - oldest + 1, 4096, '裁剪：保留的正是最近 4096 条');

  const out = replayOf(runId, 1)!;
  ok(out[0].type === 'snapshot', '滚出缓冲：首条必须是全量快照', out[0].type);
  ok(Array.isArray((out[0] as { blocks: Block[] }).blocks), '快照：携带块数组');
  // 快照已覆盖到最新 seq：缓冲里的历史增量不能再重放，否则正文会被重复加一遍
  eq(out[0].seq, newest, '快照：seq 取最新一条，而不是请求断点');
  ok(out.slice(1).every(e => e.seq > out[0].seq), '滚出缓冲：快照之后只允许更新的增量',
    out.slice(1).map(e => e.seq).join(','));

  const client: Block[] = [];
  for (const e of out) applyRunEvent(client, e);
  eq(textOfBlocks(client), serverText, '恢复正文：快照回放后与服务端原文完全一致');
  eq(textOfBlocks(client).length, 5000, '恢复正文：没有把缓冲增量重复加一遍（应为 5000 而不是 9096）');
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
  const fin = p.finish('ok');
  for (const out of [...fin.closes, fin.end]) publishRunEvent(out);

  const out = replayOf(runId, 0)!;
  const client: Block[] = [];
  for (const e of out) applyRunEvent(client, e);
  eq(client, p.blockList, '回放：客户端还原的块与服务端一致');
  eq(textOfBlocks(client), textOfBlocks(p.blockList), '回放：正文文本一致');
  // 块闭合和 run_end 必须一起发：只发 closes 会让 run 永远留在活跃清单里，
  // 重连流也等不到收尾。原来是反着断言的（把缺陷写成了契约），这里改成正确行为。
  ok(runHub.isFinished(runId) === true, '回放：闭合块并补发 run_end 后 run 已结束');
  eq(runHub.activeRuns().some(r => r.runId === runId), false, '回放：run_end 后从 active 清单消失');
}

// ============= 6. 即时中止（A122：界面上的「停止」） =============
{
  const runId = 'rh-stop';
  runHub.create(runId);
  const p = new RunProjector({ ...meta, runId }, () => 1_000);

  let aborted = 0;
  runHub.setAbortHandler(runId, () => {
    aborted++;
  });

  eq(runHub.stop(runId), true, '停止：还在跑的 run 停得动');
  eq(aborted, 1, '停止：中止动作被执行一次');
  eq(runHub.isFinished(runId), false, '停止：不把 run 自己标成已结束（收尾归路由）');
  eq(runHub.activeRuns().some(r => r.runId === runId), true, '停止：run 仍在 active 清单里，等路由发 run_end');

  // 停一次之后才收尾：动作不能被重复触发
  const fin = p.finish('aborted');
  for (const out of [...fin.closes, fin.end]) publishRunEvent(out);
  eq(aborted, 1, '收尾后不会再触发中止动作');
  eq(runHub.stop(runId), false, '停止：已结束的 run 没什么可停（接口据此回 404）');
  eq(runHub.activeRuns().some(r => r.runId === runId), false, '停止：run_end 后从 active 清单消失');
}

// 没注册中止动作 / run 不存在：一律 false，不假装停成功
{
  runHub.create('rh-nohandler');
  eq(runHub.stop('rh-nohandler'), false, '停止：没注册过中止动作时返回 false');
  eq(runHub.stop('rh-does-not-exist'), false, '停止：run 不存在时返回 false');
}

// 中止动作里抛错：不能把 stop 的调用方一起带崩
{
  runHub.create('rh-throw');
  runHub.setAbortHandler('rh-throw', () => {
    throw new Error('stub-abort-boom');
  });
  let threw = false;
  try {
    runHub.stop('rh-throw');
  } catch {
    threw = true;
  }
  eq(threw, false, '停止：中止动作抛错被吞住，不把异常甩给调用方');
  eq(runHub.isFinished('rh-throw'), false, '停止：抛错也不会把 run 标成已结束');
}

// ============= 7. 成员运行收尾：turn-runner 必须同时下发 closes 与 run_end =============
// 这里做源码级守卫：turn-runner 不 import db，直接跑起来会开真实数据库；
// 用离线断言锁住「正常结束必须是 emit([...closes, end])」这一个收尾动作。
{
  const src = readFileSync(new URL('../server/turn-runner.ts', import.meta.url), 'utf8');
  ok(/emit\(\[\.\.\.closes,\s*end\]\)/.test(src), 'turn-runner：正常结束同时下发块关闭与 run_end');
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
