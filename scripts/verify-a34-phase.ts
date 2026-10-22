/**
 * A34 状态行阶段文案的纯函数单测。
 *
 * 只测 shared/blocks.ts 里的 runActivity / streamPhaseLabel —— 它们是
 * 「状态行该说什么」的唯一判据，前后端共用。浏览器侧的行为
 * （呼吸灯、选区工具条、换行开关）由 verify-a34.mjs 覆盖。
 *
 * 运行：npx tsx scripts/verify-a34-phase.ts
 */
import { runActivity, streamPhaseLabel, type Block } from '../shared/blocks';

const failures: string[] = [];
let total = 0;

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const now = Date.now();

const thinking: Block = {
  id: 't',
  type: 'thinking',
  text: '想',
  state: 'streaming',
  format: 'raw',
  startedAt: now,
};
const thinkingDone: Block = {
  id: 't2',
  type: 'thinking',
  text: '想',
  state: 'done',
  format: 'raw',
  startedAt: now,
  endedAt: now,
};
const tool: Block = {
  id: 'x',
  type: 'tool',
  toolId: 'x',
  name: 'Bash',
  status: 'running',
  startedAt: now,
};
const toolDone: Block = {
  id: 'x2',
  type: 'tool',
  toolId: 'x2',
  name: 'Bash',
  status: 'completed',
  startedAt: now,
  endedAt: now + 1200,
};
const text: Block = { id: 'p', type: 'text', text: '答', state: 'streaming' };
const textDone: Block = { id: 'p2', type: 'text', text: '答', state: 'done' };
const note: Block = { id: 'n', type: 'note', text: '交给 X', level: 'info' };

console.log('\n[A34] 状态行阶段文案');
ok(streamPhaseLabel([]) === '正在处理', '无块 → 正在处理');
ok(streamPhaseLabel([thinking]) === '正在思考', '思考流式中 → 正在思考');
ok(streamPhaseLabel([tool]) === '正在调用 Bash', '工具运行中 → 正在调用 <name>');
ok(streamPhaseLabel([text]) === '正在生成', '正文流式中 → 正在生成');
ok(streamPhaseLabel([textDone]) === '正在处理', '正文已结束 → 正在处理');
ok(streamPhaseLabel([thinkingDone]) === '正在处理', '思考已结束 → 正在处理');
ok(streamPhaseLabel([toolDone]) === '正在处理', '工具已结束 → 正在处理');
ok(streamPhaseLabel([note]) === '正在处理', 'note 不算活动');
ok(streamPhaseLabel([thinking], true) === '正在生成图像', '生图模式 → 正在生成图像');
ok(!streamPhaseLabel([thinking]).includes('深度求索'), '文案不含「深度求索」');

console.log('\n[A34] runActivity 判据');
ok(runActivity([]) === 'idle', '空 → idle');
ok(runActivity([thinking]) === 'thinking', '思考 → thinking');
ok(runActivity([tool]) === 'tool', '工具 → tool');
ok(runActivity([text]) === 'writing', '正文 → writing');
ok(runActivity([thinking, text]) === 'writing', '以最后一个块为准（thinking,text → writing）');
ok(runActivity([note]) === 'idle', 'note → idle');

console.log(`\n=== ${total - failures.length}/${total} 通过 ===`);
if (failures.length) {
  console.log('失败：' + failures.join(' / '));
  process.exit(1);
}
