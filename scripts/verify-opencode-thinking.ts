/**
 * opencode 思考事件链路 —— L1 纯函数验收。
 *
 * ## 为什么要有这个脚本
 *
 * opencode v2.0.25 的 reasoning 是**默认关**的开关（`opencode run --help`：
 * `--thinking  Show thinking blocks`）。早期 `buildArgs` 只拼了
 * `['run', '--format', 'json']`，CLI 因此一条 reasoning 事件都不发，映射器里
 * 那条 `case 'reasoning'` 永远收不到东西 —— 表现就是 descriptor 声称
 * `eventCapabilities: ['thinking']`、前端却始终看不到思考面板：清单在撒谎。
 *
 * 起真 opencode 需要 provider 的 API Key + 外网，所以「CLI 会不会被要求思考」
 * 只能在这一层验：argv 是纯函数，跑一次就知道。协议形状（reasoning 事件的
 * part.text / part.reasoning）来自 opencode 的 NDJSON 流，映射器已按实测写法。
 *
 * ## 覆盖
 *   [1] buildArgs 带 --thinking（根因修复），且不传 opencode 不存在的参数
 *   [2] 映射器把 reasoning 归一成 { type: 'thinking' }
 *   [3] descriptor 的 eventCapabilities 与 [1][2] 自洽
 *   [4] 空 part / 空文本不产出思考事件 —— 「给什么展示什么」的「不给就不展示」
 *
 * 运行：npx tsx scripts/verify-opencode-thinking.ts
 */

import { findDef } from '../server/agents/definitions.js';
import type { AgentEvent } from '../server/agents/types.js';

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: unknown): void {
  total++;
  const d = detail === undefined ? '' : ` — ${String(detail)}`;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${d}`);
  if (!cond) failures.push(label);
}

const def = findDef('opencode');
ok(!!def, '[0] 找到 opencode 定义');
if (!def || !def.cli) process.exit(1);

console.log('\n[1] argv：--thinking 是根因');
const args = def.cli.buildArgs('你好', {});
console.log(`      opencode ${args.join(' ')}`);
ok(args.includes('--thinking'), 'argv 带 --thinking（reasoning 默认关，必须显式开）');
ok(
  args.includes('--format') && args[args.indexOf('--format') + 1] === 'json',
  '--format json 保留（事件流靠它）'
);
ok(args[args.length - 1] === '你好', 'prompt 仍是最后一个位置参数', args[args.length - 1]);

const args2 = def.cli.buildArgs('hi', { model: 'zai/glm-4.7', resumeToken: 'ses_123' } as any);
ok(args2.includes('--thinking'), '带 model / resume 时依然带 --thinking');
ok(
  args2.includes('--session') && args2[args2.indexOf('--session') + 1] === 'ses_123',
  '--session 续接不受影响'
);
ok(
  args2.includes('-m') && args2[args2.indexOf('-m') + 1] === 'zai/glm-4.7',
  '-m 模型参数不受影响'
);
// opencode 没有 reasoning-effort：传了会报未知参数（对比 qoder 的 --reasoning-effort）
ok(
  !args2.some(a => a === '--reasoning-effort' || a === '--effort'),
  '不传 opencode 不存在的 reasoning-effort 参数'
);

console.log('\n[2] 映射器：reasoning → thinking');
const map = def.cli.createMapper();
const ev = map({ type: 'reasoning', part: { text: '让我先确认盘符' } }) as AgentEvent;
ok(ev?.type === 'thinking', 'reasoning 事件 → type:thinking', JSON.stringify(ev));
ok(ev?.type === 'thinking' && ev.content === '让我先确认盘符', '正文原样透传，不改写不摘要');
const ev2 = map({ type: 'reasoning', part: { reasoning: '走兜底字段' } });
ok(ev2?.type === 'thinking' && (ev2 as AgentEvent).content === '走兜底字段', 'part.reasoning 兜底字段');
ok(map({ type: 'text', part: { text: '答案' } })?.type === 'text', 'text 事件不串味');

console.log('\n[4] 不给就不展示：不伪造思考');
ok(map({ type: 'reasoning', part: {} }) === null, '空 part → null');
ok(map({ type: 'reasoning', part: { text: '' } }) === null, '空文本 → null');
ok(map({ type: 'reasoning' }) === null, '没有 part → null');
ok(map({ type: 'session.created' }) === null, '未知事件 → null');

console.log('\n[3] 清单自洽');
const caps = def.descriptor.eventCapabilities ?? [];
ok(caps.includes('thinking'), 'descriptor 声明 thinking', caps.join(','));
ok(def.descriptor.kind === 'cli' && !!def.cli, 'kind=cli 且真的挂了 cli 规范');

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length > 0) {
  console.error(`\n失败：\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
