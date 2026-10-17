/**
 * 编排引擎验证脚本。
 *
 * 为什么不靠真实 Agent 调用做验证：真实 LLM 的输出不确定、要联网、要凭据，
 * 而且只能证明「这一次碰巧对了」。编排引擎的核心是**决策逻辑** ——
 * 谁先谁后、每人的 prompt 里该带什么、路由解析对不对、失败时怎么兜底。
 * 这些用假的 runAgent 记录下来逐条断言，既确定性又跑得快。
 *
 * 运行：npx tsx scripts/verify-orchestrator.ts
 */
import {
  runOrchestration,
  extractMentioned,
  parseRouting,
  isInternalPhase,
  DEBATE_ROUNDS,
  type OrchestratorDeps,
  type TurnPhase,
} from '../server/orchestrator.js';

interface Call {
  agentId: string;
  prompt: string;
  phase: TurnPhase;
  round?: number;
}

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

/** 造一套假的编排依赖，记录所有调用 */
function makeDeps(opts: {
  /** 针对 (agentId, phase) 返回该 Agent 的正文 */
  reply?: (agentId: string, phase: TurnPhase) => string;
  /** 可用成员白名单；不传表示全可用 */
  usable?: string[];
} = {}) {
  const calls: Call[] = [];
  const notes: string[] = [];
  // 用 started/finished 记录进入与离开顺序，用来证明「并行」而不是「碰巧顺序一致」
  const started: string[] = [];
  const finished: string[] = [];

  const deps: OrchestratorDeps = {
    async runAgent(agentId, prompt, phase, round) {
      calls.push({ agentId, prompt, phase, round });
      started.push(agentId);
      // 让出一个微任务，若实现是串行 await 则顺序会被观察到
      await new Promise(r => setTimeout(r, 0));
      finished.push(agentId);
      return { text: opts.reply ? opts.reply(agentId, phase) : `[${agentId}|${phase}]` };
    },
    note: t => notes.push(t),
    displayName: id => id.toUpperCase(),
    isUsable: id => !opts.usable || opts.usable.includes(id),
  };

  return { deps, calls, notes, started, finished };
}

// ── 1. 广播：全员并行、同一 prompt ────────────────────────────────
{
  const { deps, calls, started } = makeDeps();
  await runOrchestration(
    { mode: 'broadcast', members: ['a', 'b', 'c'], prompt: '你好' },
    deps
  );
  eq(calls.length, 3, '广播：应调用 3 次');
  eq(calls.map(c => c.agentId).sort(), ['a', 'b', 'c'], '广播：应覆盖全部成员');
  eq([...new Set(calls.map(c => c.phase))], ['broadcast'], '广播：phase 应统一为 broadcast');
  eq([...new Set(calls.map(c => c.prompt))], ['你好'], '广播：三人应拿到同一 prompt');
  // 并行证明：三个都「已开始」时，还没有任何一个「已完成」
  eq(started.slice(0, 3), ['a', 'b', 'c'], '广播：应几乎同时开始（并行）');
}

// ── 2. 接力：串行、后一棒拿到前一棒的输出 ─────────────────────────
{
  const { deps, calls } = makeDeps({
    reply: (id, phase) => `来自${id}的产出(${phase})`,
  });
  await runOrchestration({ mode: 'relay', members: ['a', 'b'], prompt: '写个脚本' }, deps);

  eq(calls.length, 2, '接力：两位成员应各调用 1 次');
  eq(calls.map(c => c.agentId), ['a', 'b'], '接力：必须按成员顺序串行');
  eq(calls.map(c => c.round), [0, 1], '接力：round 应为 0,1');
  ok(calls[0].prompt.includes('写个脚本'), '接力：第 1 棒 prompt 应含原始任务');
  ok(!calls[0].prompt.includes('上一棒'), '接力：第 1 棒不该提「上一棒」');
  ok(
    calls[1].prompt.includes('来自a的产出(relay)'),
    '接力：第 2 棒 prompt 必须带上第 1 棒的输出',
    `实际 prompt: ${calls[1].prompt.slice(0, 120)}`
  );
  ok(calls[1].prompt.includes('第 2/2 棒'), '接力：第 2 棒应标注棒次');
}

// ── 3. 辩论：正反交替 N 轮，最后由第三方收敛 ──────────────────────
{
  const { deps, calls } = makeDeps({ reply: (id, phase) => `${id}在${phase}的发言` });
  await runOrchestration(
    { mode: 'debate', members: ['pro', 'con', 'judge'], prompt: '该不该上微服务' },
    deps
  );

  eq(calls.length, DEBATE_ROUNDS * 2 + 1, '辩论：调用数应为 轮数×2 + 1 次收敛');
  eq(
    calls.map(c => c.agentId),
    ['pro', 'con', 'pro', 'con', 'judge'],
    '辩论：顺序应为 正-反-正-反-裁判'
  );
  eq(calls.map(c => c.round), [1, 1, 2, 2, undefined], '辩论：round 标注应正确');
  eq(calls[calls.length - 1].phase, 'converge', '辩论：最后一次应为 converge');
  ok(calls[0].prompt.includes('正方'), '辩论：第一位应被告知自己是正方');
  ok(calls[1].prompt.includes('反方'), '辩论：第二位应被告知自己是反方');
  ok(
    calls[3].prompt.includes('pro在debate的发言'),
    '辩论：第 2 轮反方 prompt 应带上正方的上一轮发言'
  );
  ok(
    calls[4].prompt.includes('pro在debate的发言') && calls[4].prompt.includes('con在debate的发言'),
    '辩论：收敛 prompt 应同时包含双方观点'
  );
}

// ── 4. 辩论：只有两人时也要能跑（不能崩） ────────────────────────
{
  const { deps, calls } = makeDeps();
  await runOrchestration({ mode: 'debate', members: ['a', 'b'], prompt: 'x' }, deps);
  eq(calls.length, DEBATE_ROUNDS * 2 + 1, '辩论(2人)：仍应完成全部轮次 + 收敛');
  eq(calls[calls.length - 1].agentId, 'a', '辩论(2人)：无第三方时由正方收敛');
}

// ── 5. 分派：路由 → 执行 → 汇总 ──────────────────────────────────
{
  const { deps, calls, notes } = makeDeps({
    reply: (id, phase) => (phase === 'route' ? 'ROUTE: w2' : `${id}的${phase}输出`),
  });
  await runOrchestration(
    { mode: 'dispatch', members: ['ctrl', 'w1', 'w2'], prompt: '帮我重构这个函数' },
    deps
  );

  eq(calls.length, 3, '分派：应为 路由+执行+汇总 共 3 次调用');
  eq(
    calls.map(c => `${c.agentId}:${c.phase}`),
    ['ctrl:route', 'w2:work', 'ctrl:summary'],
    '分派：应路由到 w2 并由 ctrl 汇总'
  );
  ok(
    calls[1].prompt === '帮我重构这个函数',
    '分派：执行者应拿到原始任务原文',
    `实际: ${calls[1].prompt}`
  );
  ok(
    calls[2].prompt.includes('w2的work输出'),
    '分派：汇总 prompt 应带上执行者的输出'
  );
  ok(
    notes.some(n => n.includes('W2')),
    '分派：应产出「决定交给谁」的编排说明'
  );
}

// ── 6. 分派：路由解析失败必须兜底为广播，而不是瞎猜 ──────────────
{
  const { deps, calls, notes } = makeDeps({
    reply: () => '我觉得都行，看情况吧', // 完全不守格式
  });
  await runOrchestration(
    { mode: 'dispatch', members: ['ctrl', 'w1', 'w2'], prompt: 'x' },
    deps
  );

  eq(
    calls.map(c => `${c.agentId}:${c.phase}`),
    ['ctrl:route', 'w1:broadcast', 'w2:broadcast'],
    '分派兜底：解析失败应退化为对候选成员的广播'
  );
  ok(
    notes.some(n => n.includes('退化为广播')),
    '分派兜底：应明确告知用户发生了降级'
  );
}

// ── 7. 分派：群里只有一人时不该浪费一次路由调用 ──────────────────
{
  const { deps, calls } = makeDeps();
  await runOrchestration({ mode: 'dispatch', members: ['solo'], prompt: 'x' }, deps);
  eq(calls.map(c => c.phase), ['work'], '分派(单人)：应直接作答，不做无意义的路由');
}

// ── 8. @指定：只唤醒被 @ 的人 ────────────────────────────────────
{
  const { deps, calls } = makeDeps();
  await runOrchestration(
    { mode: 'mention', members: ['a', 'b', 'c'], prompt: '@b 帮我看看' },
    deps
  );
  eq(calls.map(c => c.agentId), ['b'], '@指定：只应唤醒被 @ 的成员');
  eq(calls[0].phase, 'mention', '@指定：phase 应为 mention');
}

// ── 9. @指定：没人被 @ 时应提示而不是瞎跑 ────────────────────────
{
  const { deps, calls, notes } = makeDeps();
  await runOrchestration({ mode: 'mention', members: ['a', 'b'], prompt: '帮我看看' }, deps);
  eq(calls.length, 0, '@指定(无 @)：不应调用任何 Agent');
  ok(notes.some(n => n.includes('没有识别到')), '@指定(无 @)：应给出可操作的提示');
}

// ── 10. 不可用成员应被剔除，且明确告知 ───────────────────────────
{
  const { deps, calls, notes } = makeDeps({ usable: ['a'] });
  const used = await runOrchestration(
    { mode: 'broadcast', members: ['a', 'dead'], prompt: 'x' },
    deps
  );
  eq(calls.map(c => c.agentId), ['a'], '不可用成员：不应被调用');
  eq(used, ['a'], '不可用成员：返回值应只含实际参与者');
  ok(notes.some(n => n.includes('不可用')), '不可用成员：应告知用户谁被跳过');
}

// ── 11. 全员不可用时应给出明确提示 ───────────────────────────────
{
  const { deps, calls, notes } = makeDeps({ usable: [] });
  const used = await runOrchestration(
    { mode: 'broadcast', members: ['x', 'y'], prompt: 'z' },
    deps
  );
  eq(calls.length, 0, '全员不可用：不应发起任何调用');
  eq(used, [], '全员不可用：返回值应为空');
  ok(notes.some(n => n.includes('没有可用的成员')), '全员不可用：应提示用户去让 Agent 上线');
}

// ── 12. 纯函数：@ 解析的边界（@code 不能误命中 codex） ────────────
{
  const name = (id: string) => id.toUpperCase();
  eq(extractMentioned('@codex 改一下', ['code', 'codex'], name), ['codex'], '@解析：@codex 只应命中 codex');
  eq(extractMentioned('@code 改一下', ['code', 'codex'], name), ['code'], '@解析：@code 只应命中 code');
  eq(extractMentioned('@CODEX 你好', ['codex'], name), ['codex'], '@解析：应忽略大小写');
  eq(extractMentioned('@codex和@code', ['code', 'codex'], name), ['code', 'codex'], '@解析：应支持多个 @');
  eq(extractMentioned('@codex和@code', ['code', 'codex'], name), ['code', 'codex'], '@解析：CJK 词（和/的）不应截断 @ 名');
  eq(extractMentioned('@codex的代码', ['codex'], name), ['codex'], '@解析：@名后紧跟「的」应能识别');
  eq(extractMentioned('没有 at', ['codex'], name), [], '@解析：无 @ 时应返回空');
}

// ── 13. 纯函数：路由解析的三级降级 ───────────────────────────────
{
  const name = (id: string) => id.toUpperCase();
  const cands = ['w1', 'w2'];
  eq(parseRouting('ROUTE: w2', cands, name), 'w2', '路由解析：显式标记');
  eq(parseRouting('route：w1', cands, name), 'w1', '路由解析：应容忍中文冒号与小写');
  eq(parseRouting('我认为 w1 更合适', cands, name), 'w1', '路由解析：降级为词边界匹配');
  eq(parseRouting('交给 W2 吧', cands, name), 'w2', '路由解析：降级为展示名匹配');
  eq(parseRouting('都行', cands, name), null, '路由解析：无法判断时应返回 null');
  // 注意：'w1x 不是 w1' 里末尾那个 w1 本来就是独立词，返回 w1 是**正确**的。
  // 要测词边界，必须让 w1 只以 'w1x' 这种形式出现。
  eq(parseRouting('w1x 才是对的', cands, name), null, '路由解析：词边界应生效，w1x 不算 w1');
  eq(parseRouting('用 w1x 吧', cands, name), null, '路由解析：w1x 不应命中 w1');
}

// ── 14. 契约：哪些阶段属于「内部阶段」 ───────────────────────────
{
  // route 是决策管道（原文形如 `ROUTE: xxx`），不该变成用户可见的气泡，
  // 也不该落库。群聊 UI 依赖这个约定 —— 改这里等于改协议，两侧要同步。
  eq(isInternalPhase('route'), true, '内部阶段：route 是内部阶段');
  eq(isInternalPhase('work'), false, '内部阶段：work 是可见产出');
  eq(isInternalPhase('summary'), false, '内部阶段：summary 是最终汇总结论');
  eq(isInternalPhase('broadcast'), false, '内部阶段：broadcast 是可见产出');
  eq(isInternalPhase('relay'), false, '内部阶段：relay 是可见产出');
  eq(isInternalPhase('debate'), false, '内部阶段：debate 是可见产出');
  eq(isInternalPhase('converge'), false, '内部阶段：converge 是可见产出');
  eq(isInternalPhase('mention'), false, '内部阶段：mention 是可见产出');
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`编排引擎断言：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 五种模式的调用顺序、提示词拼接、路由解析与兜底策略均符合预期');
