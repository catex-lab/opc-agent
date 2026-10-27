/**
 * P4 审批选项与拒绝原因码验证。
 *
 * 要防的不是「按钮点不动」，而是「选项写了但做不到」：
 *   · 给 CLI 一次性模式摆一个「本会话始终允许」—— 它根本没有反向通道；
 *   · ACP 明明给了四个选项，我们却按 allow/deny 猜一个；
 *   · 拒绝只回一句「用户拒绝了」，模型把它当成工具故障再试一遍。
 *
 * 所以这里钉四件事：
 *   1. 选项目录必须与适配器真实能力一致（SDK 四档、CLI 双向两档）；
 *   2. ACP 选项归一化：认识的 kind 原样保留，认不出的丢掉，不猜；
 *   3. 拒绝文案两段式：先说明「不是工具故障」，再给可执行替代；
 *   4. 路由边界：非法 behavior / reasonCode 必须 400，不静默改成 deny。
 *
 * 运行：npx tsx scripts/verify-a128-permission-options.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { RunProjector } from '../server/agents/projector.js';
import { PendingReplies } from '../server/agents/channel.js';
import { selectAcpOption } from '../server/agents/adapters/acp.js';
import {
  CLI_PERMISSION_OPTIONS,
  PERMISSION_REASON_CODES,
  SDK_PERMISSION_OPTIONS,
  behaviorOfKind,
  buildDenialMessage,
  normalizePermissionOptions,
  parsePermissionBody,
  reasonCodeOfKind,
  type PermissionOption,
} from '../shared/permissions.js';

const failures: string[] = [];
let total = 0;

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq(actual: unknown, expected: unknown, label: string) {
  total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

// ============= 1. 选项目录 =============
{
  const kinds = SDK_PERMISSION_OPTIONS.map(o => o.kind);
  eq(kinds, ['reject_once', 'reject_always', 'allow_once', 'allow_always'], 'SDK 四档齐全且顺序固定');
  ok(SDK_PERMISSION_OPTIONS.every(o => o.id && o.label), 'SDK 每个选项都有稳定 id 与人话标签');
  ok(new Set(SDK_PERMISSION_OPTIONS.map(o => o.id)).size === 4, 'SDK 选项 id 不重复');
  ok(
    Boolean(SDK_PERMISSION_OPTIONS.find(o => o.kind === 'reject_always')?.note),
    'SDK 的「始终拒绝」带作用域说明（应用重启后失效）'
  );
  ok(
    Boolean(SDK_PERMISSION_OPTIONS.find(o => o.kind === 'allow_always')?.note),
    'SDK 的「始终允许」带安全说明（高危仍会被门禁拦截）'
  );

  eq(
    CLI_PERMISSION_OPTIONS.map(o => o.kind),
    ['reject_once', 'allow_once'],
    'CLI 双向协议只有两档，不摆做不到的 always'
  );
  ok(
    !CLI_PERMISSION_OPTIONS.some(o => o.kind.endsWith('_always')),
    'CLI 选项里没有 always（协议不认，摆了就是假功能）'
  );
}

// ============= 2. kind → 行为 / 原因码 =============
{
  eq(behaviorOfKind('allow_once'), 'allow', 'allow_once → allow');
  eq(behaviorOfKind('allow_always'), 'allow', 'allow_always → allow');
  eq(behaviorOfKind('reject_once'), 'deny', 'reject_once → deny');
  eq(behaviorOfKind('reject_always'), 'deny', 'reject_always → deny');

  eq(reasonCodeOfKind('reject_once'), 'user_rejected', 'reject_once → user_rejected');
  eq(reasonCodeOfKind('reject_always'), 'user_denied_always', 'reject_always → user_denied_always');
  eq(reasonCodeOfKind('allow_once'), undefined, 'allow 不带拒绝原因码');
  eq(reasonCodeOfKind('allow_always'), undefined, 'allow_always 不带拒绝原因码');
}

// ============= 3. 两段式拒绝文案 =============
{
  for (const code of PERMISSION_REASON_CODES) {
    const msg = buildDenialMessage(code);
    ok(msg.includes('不是工具故障'), `${code} 明确告诉模型「不是工具故障」`, msg);
    ok(msg.includes('请'), `${code} 带可执行替代，而不是一句死拒绝`, msg);
  }
  ok(buildDenialMessage('user_denied_always').includes('本会话'), '始终拒绝说明作用域是「本会话」');
  ok(buildDenialMessage('timeout').includes('时限'), '超时文案说清是无人答复，不是工具坏了');
  ok(buildDenialMessage('rule_blocked').includes('策略'), '门禁拒绝说明是策略限制，重试无用');
  ok(buildDenialMessage('user_rejected', 'rm -rf /').includes('rm -rf /'), '命中依据会附在文案里');
}

// ============= 4. ACP 选项归一化 =============
{
  const raw = [
    { optionId: 'a1', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'a2', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'r1', kind: 'reject_once', name: 'Reject' },
    { optionId: 'r2', kind: 'reject_always', name: 'Always reject' },
  ];
  eq(normalizePermissionOptions(raw), [
    { id: 'a1', kind: 'allow_once', label: 'Allow once' },
    { id: 'a2', kind: 'allow_always', label: 'Always allow' },
    { id: 'r1', kind: 'reject_once', label: 'Reject' },
    { id: 'r2', kind: 'reject_always', label: 'Always reject' },
  ], 'ACP 四档原样保留（id / kind / 服务端标签）');

  eq(
    normalizePermissionOptions([{ optionId: 'x', name: 'Allow once' }]),
    [{ id: 'x', kind: 'allow_once', label: 'Allow once' }],
    '缺 kind 时只按明确的 allow/reject 语义推断'
  );
  eq(
    normalizePermissionOptions([{ optionId: 'y', kind: 'mystery', name: 'Maybe?' }]),
    [],
    '认不出的选项直接丢掉，不猜成 allow'
  );
  eq(
    normalizePermissionOptions([
      { optionId: 'dup', kind: 'allow_once', name: 'A' },
      { optionId: 'dup', kind: 'reject_once', name: 'B' },
    ]).length,
    1,
    '同一 optionId 只保留第一个'
  );
  eq(normalizePermissionOptions('not-array'), [], '非数组输入返回空，不抛异常');
  eq(
    normalizePermissionOptions([{ optionId: 'n', kind: 'reject_once' }])[0].label,
    '拒绝',
    '服务端没给标签时用本地中文兜底'
  );
}

// ============= 5. ACP 选择：按 id，不按猜 =============
{
  const opts: PermissionOption[] = [
    { id: 'r-once', kind: 'reject_once', label: '拒绝' },
    { id: 'r-always', kind: 'reject_always', label: '始终拒绝' },
    { id: 'a-always', kind: 'allow_always', label: '始终允许' },
    { id: 'a-once', kind: 'allow_once', label: '允许' },
  ];
  eq(selectAcpOption(opts, { behavior: 'allow', optionId: 'a-always' })?.id, 'a-always', '带了 optionId 就精确选它');
  eq(selectAcpOption(opts, { behavior: 'allow' })?.id, 'a-always', '没带 id 时 allow 落到第一个 allow 档');
  eq(selectAcpOption(opts, { behavior: 'deny' })?.id, 'r-once', '没带 id 时 deny 落到第一个 reject 档');
  eq(
    selectAcpOption([{ id: 'only-reject', kind: 'reject_once', label: '拒绝' }], { behavior: 'allow' }),
    null,
    '找不到 allow 档时返回 null（宁可取消，也不误选 reject）'
  );
}

// ============= 6. 路由边界 =============
{
  const allow = parsePermissionBody({ behavior: 'allow', optionId: 'allow_once' });
  ok(allow.ok, 'allow + optionId 合法');
  if (allow.ok) {
    eq(allow.decision.behavior, 'allow', 'allow 保留行为');
    eq(allow.decision.optionId, 'allow_once', 'allow 保留选项 id');
    eq(allow.decision.reasonCode, undefined, 'allow 不带原因码');
  }

  const deny = parsePermissionBody({ behavior: 'deny', reasonCode: 'user_denied_always' });
  ok(deny.ok, 'deny + 合法原因码');
  if (deny.ok) eq(deny.decision.reasonCode, 'user_denied_always', '原因码原样透传');

  const legacy = parsePermissionBody({ behavior: 'deny' });
  ok(legacy.ok, '老客户端只发 behavior 也能用');
  if (legacy.ok) eq(legacy.decision.reasonCode, 'user_rejected', '缺原因码的 deny 默认 user_rejected');

  ok(!parsePermissionBody({ behavior: 'maybe' }).ok, '非法 behavior 必须报错，不静默当 deny');
  ok(!parsePermissionBody({ behavior: 'deny', reasonCode: 'because' }).ok, '非法原因码必须报错');
  ok(!parsePermissionBody({ behavior: 'allow', reasonCode: 'user_rejected' }).ok, 'allow 带拒绝原因码是矛盾请求');
  ok(!parsePermissionBody({ behavior: 'deny', optionId: 42 }).ok, 'optionId 必须是非空字符串');
  ok(!parsePermissionBody(null).ok, '非对象请求体必须报错');

  const withMsg = parsePermissionBody({ behavior: 'deny', message: '  自定义说明  ' });
  ok(withMsg.ok && withMsg.decision.message === '自定义说明', 'message 去空白后透传');
}

// ============= 7. PendingReplies：超时与收尾要能分开 =============
async function testPendingReplies() {
  const settleWithin = <T>(p: Promise<T>, ms: number) =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);

  {
    const r = new PendingReplies<{ reasonCode: string }>();
    const p = r.register('t', () => ({ reasonCode: 'timeout' }), 60);
    const out = await settleWithin(p, 500);
    eq(out.reasonCode, 'timeout', '超时走 timeout 兜底');
  }
  {
    const r = new PendingReplies<{ reasonCode: string }>();
    const p = r.register(
      'c',
      () => ({ reasonCode: 'timeout' }),
      0,
      'sess-1',
      () => ({ reasonCode: 'cancelled' })
    );
    r.clear('sess-1');
    const out = await settleWithin(p, 500);
    eq(out.reasonCode, 'cancelled', '会话收尾走 cancelled，不冒称 timeout');
  }
  {
    const r = new PendingReplies<{ reasonCode: string }>();
    const p = r.register('s', () => ({ reasonCode: 'timeout' }), 0);
    ok(r.settle('s', { reasonCode: 'user_rejected' }), '前端答复命中待处理项');
    const out = await settleWithin(p, 500);
    eq(out.reasonCode, 'user_rejected', '前端答复优先于任何兜底');
  }
  {
    const r = new PendingReplies<{ reasonCode: string }>();
    let resolved: { reasonCode: string } | null = null;
    const p = r.register(
      'other',
      () => ({ reasonCode: 'timeout' }),
      0,
      'sess-B',
      () => ({ reasonCode: 'cancelled' })
    );
    void p.then(v => { resolved = v; });
    r.clear('sess-A');
    await new Promise(res => setTimeout(res, 20));
    // 断言的是「没被清掉」：旧实现在这里会把 B 会话的项一并清走，
    // 那张卡片从此点不动，而日志里看不出异常
    eq(resolved, null, 'clear(scope) 不碰其他会话的待答复项');
    eq(r.size, 1, '其他会话的项仍在表里');
    r.clear('sess-B');
    const out = await settleWithin(p, 500);
    eq(out.reasonCode, 'cancelled', '轮到本会话收尾时才用 cancelled 兑现');
  }
}

// ============= 8. 投影器直通 =============
{
  const META = {
    runId: 'run-1',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentId: 'workbuddy',
    model: 'claude-sonnet-4-5',
  };
  const opts: PermissionOption[] = [
    { id: 'allow_once', kind: 'allow_once', label: '允许' },
    { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
  ];
  const p = new RunProjector(META as never, () => 1_000);
  p.push({ type: 'init', sessionId: 'sess-1' });
  const out = p.push({
    type: 'permission_request',
    requestId: 'req-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    options: opts,
  });
  const ev = out.find(e => e.type === 'permission_request');
  ok(!!ev, 'permission_request 被投影成 v2 事件');
  if (ev && ev.type === 'permission_request') {
    eq(ev.options, opts, 'options 原样直通（投影器不改写）');
  }

  const p2 = new RunProjector(META as never, () => 1_000);
  p2.push({ type: 'init', sessionId: 'sess-1' });
  const out2 = p2.push({
    type: 'permission_request',
    requestId: 'req-2',
    toolName: 'Bash',
    input: {},
  });
  const ev2 = out2.find(e => e.type === 'permission_request');
  ok(
    !!ev2 && ev2.type === 'permission_request' && ev2.options === undefined,
    '没有选项时字段缺省（不是空数组：不知道 ≠ 给了 0 个）'
  );
}

// ============= 9. 源码契约：不再硬编码两个 Agent =============
{
  const indexSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
  ok(
    indexSrc.includes('resolvePermissionAnywhere'),
    '权限应答路由向注册表全量查找，而不是只认两个 agent'
  );
  ok(
    !indexSrc.includes("['workbuddy', 'hermes']"),
    '旧的硬编码 agent 白名单已删除'
  );
  const registrySrc = fs.readFileSync(path.join(process.cwd(), 'server', 'agents', 'registry.ts'), 'utf8');
  ok(
    registrySrc.includes('resolvePermissionAnywhere('),
    '注册表提供全量查找入口'
  );
}

async function main() {
  await testPendingReplies();
  if (failures.length) {
    console.error(`\nA128 审批选项与拒绝原因码：${total - failures.length}/${total} 通过\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\nA128 审批选项与拒绝原因码：${total}/${total} 通过\n`);
}

main().catch(err => {
  console.error('\nA128 运行失败：', err);
  process.exit(1);
});
