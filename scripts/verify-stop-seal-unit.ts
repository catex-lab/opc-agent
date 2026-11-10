/**
 * 停止收尾（A122 第四段绳）—— 纯函数层闸门。
 *
 * ## 验的是什么
 *
 * 用户报「点了停止，思考中还在转圈」。根因不是 Agent 没停，而是：
 * `ThinkingView` 的 `streaming` 只看 `block.state === 'streaming'`，能把块
 * 从 streaming 改掉的只有 `block_close`；用户按停止时 SSE 已被
 * `controller.abort()` 掐断、`stopped` 分支又不许重连，服务端在
 * `RunProjector.finish()` 里补发的 closes 永远到不了客户端。
 *
 * 所以 [1] 先用真实 reducer 复现「只发 run_end 不发 closes」的残留，
 * [2] 再验 `sealOpenBlocks` 能收口且不误伤正常收尾的块。
 *
 * ## 反向探针
 *
 * 把 `shared/blocks.ts` 里 `sealOpenBlocks` 的函数体改成 `return false;`
 * 重跑本脚本，[2] 的每一条都必须变红 —— 否则这组断言是假绿。
 */
import {
  applyRunEvent,
  runActivity,
  sealOpenBlocks,
  type Block,
  type BlockState,
} from '../shared/blocks.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

const now = Date.now();
const think = (state: BlockState = 'streaming'): Block => ({
  id: 'b1',
  type: 'thinking',
  text: '思考中：首事件已到（turn.started），正文未到。',
  state,
  format: 'raw',
  startedAt: now - 144_000,
});

console.log('\n停止收尾 · 纯函数层');

// ── [1] 成因复现：服务端收尾事件到不了前端时，块确实残留 ──────────────
console.log('\n[1] 只收到 run_end、没收到 block_close（用户按停止时的真实序列）');
{
  const blocks: Block[] = [];
  applyRunEvent(blocks, {
    seq: 1, runId: 'r1', type: 'block_open', block: think(),
  } as never);
  applyRunEvent(blocks, {
    seq: 2, runId: 'r1', type: 'block_delta', blockId: 'b1', delta: 'Codex 在整段完成后才返回正文。',
  } as never);
  // run_end 不驱动块数组：applyRunEvent 只认块生命周期事件
  applyRunEvent(blocks, {
    seq: 3, runId: 'r1', type: 'run_end', status: 'error',
  } as never);

  const b = blocks[0] as Extract<Block, { type: 'thinking' }>;
  ok(blocks.length === 1 && b.state === 'streaming', '[1] 成因：thinking 块仍是 streaming');
  ok(runActivity(blocks) === 'thinking', '[1] 成因：阶段判据仍报「正在思考」', runActivity(blocks));
  ok(b.text.length > 40, '[1] 成因：47 字占位思考文本确实在块里', `${b.text.length} 字`);

  ok(sealOpenBlocks(blocks) === true, '[2] 修复：seal 报告有改动');
  ok(b.state === 'interrupted', '[2] 修复：state 收成 interrupted（结果未回传）', b.state);
  ok(typeof b.endedAt === 'number' && b.endedAt > 0, '[2] 修复：endedAt 被写下，秒表有终点');
  ok(runActivity(blocks) !== 'thinking', '[2] 修复：阶段不再报「正在思考」', runActivity(blocks));
  ok(b.text.length > 40, '[2] 修复：正文没被抹掉（不是把整块删掉的假绿）');
  ok(sealOpenBlocks(blocks) === false, '[2] 幂等：再 seal 一次不再改动');
}

// ── [2] 混合块：只收开着的，已收尾的一律不碰 ────────────────────────────
console.log('\n[2] 混合块与正常收尾路径');
{
  const blocks: Block[] = [
    think(),
    { id: 'x1', type: 'text', text: '半截正文', state: 'streaming' },
    { id: 'x2', type: 'text', text: '已完成正文', state: 'done' },
    { id: 'u1', type: 'tool', toolId: 'u1', name: 'Bash', status: 'running', startedAt: now - 1000 },
    { id: 'u2', type: 'tool', toolId: 'u2', name: 'Bash', status: 'pending', startedAt: now - 900 },
    { id: 'u3', type: 'tool', toolId: 'u3', name: 'Bash', status: 'completed', startedAt: now - 800, endedAt: now - 700 },
    { id: 'r1', type: 'raw', count: 1, omitted: 0, entries: [] },
    { id: 'i1', type: 'image', image: { url: '/api/images/x.png' } },
  ];
  ok(sealOpenBlocks(blocks) === true, '[2] 混合块有开着的 → 报告改动');
  const byId = (id: string) => blocks.find(b => b.id === id) as never as Record<string, unknown>;
  ok(byId('b1').state === 'interrupted', '[2] thinking streaming → interrupted');
  ok(byId('x1').state === 'interrupted', '[2] text streaming → interrupted');
  ok(byId('u1').status === 'interrupted', '[2] tool running → interrupted');
  ok(byId('u2').status === 'interrupted', '[2] tool pending → interrupted');
  ok(typeof byId('r1').endedAt === 'number', '[2] raw 补上 endedAt');
  ok(byId('x2').state === 'done', '[2] 已 done 的正文不被误改（正常 run_end 路径）');
  ok(byId('u3').status === 'completed', '[2] 已 completed 的工具不被误改');
  ok(byId('i1').endedAt === undefined, '[2] 图片块不被塞入无关字段');
  ok(sealOpenBlocks(blocks) === false, '[2] 幂等：第二次调用返回 false');

  // 正常路径：服务端 closes 先到，seal 不该有任何动作
  const closed: Block[] = [think()];
  applyRunEvent(closed, {
    seq: 1, runId: 'r2', type: 'block_close', blockId: 'b1', state: 'done',
  } as never);
  ok(sealOpenBlocks(closed) === false, '[2] 收到 block_close 的正常轮次：seal 不插手');
  ok((closed[0] as Extract<Block, { type: 'thinking' }>).state === 'done', '[2] 正常轮次仍是 done');
}

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) {
  console.log(`失败：${failures.join(' | ')}`);
  process.exit(1);
}
