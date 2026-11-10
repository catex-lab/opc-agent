/**
 * P1 生效模型回显 · 纯函数 + 源码契约闸门。
 *
 * 浏览器层在 verify-model-effective-ui.mjs；这一层守的是「判定规则」本身，
 * 尤其是 A142 并发归属 —— 那条在浏览器里很难稳定复现，但错一次就是把
 * 别的会话的模型写进当前输入框。
 *
 * 运行：npx tsx scripts/verify-model-effective-unit.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { decideModelEcho, turnBelongsToWatching } from '../shared/model-effective.js';
import { RunProjector } from '../server/agents/projector.js';

let total = 0;
const failures: string[] = [];
function ok(cond: unknown, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

const ROOT = process.cwd();
const base = {
  alreadyDone: false,
  watching: 's1' as string | null,
  turnSessionId: 's1' as string | null,
  realSessionId: 's1',
  requested: 'requested-model',
};

console.log('\n[1] 正样本：真的发生替换才回显');
{
  const d = decideModelEcho({ ...base, declared: 'actual-model' });
  ok(d.echo, '★ 生效值≠请求值时回显');
  eq(d.reason, 'resolved', '出口是 resolved');
  eq(d.effective, 'actual-model', '回显的是服务端盖章的值，不是 model 元信息');
  eq(d.requested, 'requested-model', '请求值原样带回（上层要写提示）');
  const empty = decideModelEcho({ ...base, declared: '' });
  ok(empty.echo, '★ 生效值为空（由 Agent 决定）也要通知上层给提示');
  eq(empty.effective, '', '空串原样传，不伪造成某个模型名');
}

console.log('\n[2] 反向探针：老夹具/老服务端不带 modelEffective ⇒ 一律不动');
{
  const d = decideModelEcho({ ...base, declared: undefined });
  ok(!d.echo, '★ 没盖章就不回显（历史夹具带 model: stub-model 也不许误伤）');
  eq(d.reason, 'not-declared', '出口是 not-declared');
  const same = decideModelEcho({ ...base, declared: 'requested-model' });
  ok(!same.echo, '生效值与请求值相同不回显（不弹无意义提示）');
  eq(same.reason, 'unchanged', '出口是 unchanged');
  const replay = decideModelEcho({ ...base, declared: 'actual-model', alreadyDone: true });
  ok(!replay.echo, '★ 断线重连重放 run_start 时不重复回显');
  eq(replay.reason, 'already-done', '出口是 already-done');
}

console.log('\n[3] A142 并发归属：别的会话的 run 不许碰当前输入框');
{
  const other = decideModelEcho({ ...base, watching: 's2', declared: 'actual-model' });
  ok(!other.echo, '★ 用户已切到 s2，s1 迟到的 run_start 不回显');
  eq(other.reason, 'other-session', '出口是 other-session');

  // 新对话页：watching=null 但后端真 id 刚到，这一轮仍属于用户
  const fresh = decideModelEcho({
    ...base, watching: null, turnSessionId: null, declared: 'actual-model',
  });
  ok(fresh.echo, '★ 新对话页第一条消息（没有当前会话）仍能回显');

  // applyInit 中途把临时 id 换成真 id：两种都比得到
  ok(
    turnBelongsToWatching({ watching: 'real-1', turnSessionId: 'tmp-1', realSessionId: 'real-1' }),
    '当前会话已是后端真 id 时认得出'
  );
  ok(
    turnBelongsToWatching({ watching: 'tmp-1', turnSessionId: 'tmp-1', realSessionId: 'real-1' }),
    '当前会话还是临时 id 时也认得出'
  );
  ok(
    !turnBelongsToWatching({ watching: 's2', turnSessionId: 's1', realSessionId: 's1-real' }),
    '两边都不相等就是别的会话'
  );
  ok(
    decideModelEcho({ ...base, declared: '' , watching: 's2' }).echo === false,
    '「由 Agent 决定」的提示同样不许跨会话弹'
  );
}

console.log('\n[4] 投影器：只有盖章过才带 modelEffective');
{
  const meta = {
    runId: 'r1', sessionId: 's1', messageId: 'm1', agentId: 'workbuddy', model: 'requested-model',
  };
  const withStamp = new RunProjector({ ...meta, modelEffective: 'actual-model' });
  const ev1 = withStamp.push({ type: 'init' })[0];
  eq(ev1.type, 'run_start', 'init 产出 run_start');
  eq((ev1 as { modelEffective?: string }).modelEffective, 'actual-model', '★ 盖章后 run_start 带生效值');
  eq((ev1 as { model?: string }).model, 'requested-model', 'model 元信息保持原值，两个字段不混');

  const emptyStamp = new RunProjector({ ...meta, modelEffective: '' });
  const ev2 = emptyStamp.push({ type: 'init' })[0];
  eq((ev2 as { modelEffective?: string }).modelEffective, '', '空串也要带上（表示由 Agent 决定）');

  const noStamp = new RunProjector(meta);
  const ev3 = noStamp.push({ type: 'init' })[0];
  ok(
    !('modelEffective' in ev3),
    '★ 群聊/老夹具不盖章时字段完全不出现（前端据此走 not-declared）'
  );
  eq(withStamp.push({ type: 'init' }).length, 0, '后续 init 不重复发 run_start');
}

console.log('\n[5] 源码契约：三处接线不许被拆回去');
{
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const blocks = read('shared/blocks.ts');
  const runStart = blocks.slice(blocks.indexOf("type: 'run_start'"), blocks.indexOf("type: 'block_open'"));
  ok(/modelEffective\?: string/.test(runStart), 'shared/blocks.ts 的 run_start 声明了 modelEffective');

  const proj = read('server/agents/projector.ts');
  ok(/modelEffective\?: string/.test(proj), 'RunMeta 声明了 modelEffective');
  ok(/modelEffective: this\.meta\.modelEffective/.test(proj), 'run_start 真的把盖章值写进事件');

  const idx = read('server/index.ts');
  ok(/modelEffective: selectedModel \?\? ''/.test(idx), '★ /api/chat 用 resolvedModel 盖章（不是原始请求值）');
  ok(/resolveStoredModelForAgent\(/.test(idx), '/api/chat 仍走同一把模型解析尺子');

  const chat = read('src/hooks/useChat.ts');
  ok(/decideModelEcho\(/.test(chat), '★ 前端消费的是可单测的判定函数，不是散装 if');
  ok(/data\.modelEffective\)/.test(chat), 'run_start 分支把 modelEffective 传给 applyInit');
  ok(!/applyInit\(data\.sessionId, data\.messageId, data\.model\)/.test(chat), 'run_start 不再只传 model 元信息');
  ok(/currentSessionIdRef\.current = currentSessionId/.test(chat), '归属判定读的是最新当前会话（ref 同步）');
  ok(/onModelResolved\?\.\(/.test(chat), '回显经回调交给上层（同时更新会话里存的那份）');

  const app = read('src/App.tsx');
  ok(/onModelResolved: handleModelResolved/.test(app), 'App 提供了回显回调');
  ok(/updateSessionModel\(sessionId, effective\)/.test(app), '★ 回显同时写会话，防止切会话被旧值拉回');

  const runner = read('server/turn-runner.ts');
  ok(!/modelEffective/.test(runner), '群聊不盖章（每个成员模型不同，没有单一生效值可回显）');
}

console.log(`\n结果：${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
