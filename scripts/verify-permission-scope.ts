/**
 * 「授权范围 + 该 Agent 永久」验证（2026-11-12 变体 A）。
 *
 * 三层：
 *   [A] shared 协议：persistAgent 的边界校验（deny 带持久化必须报错）；
 *   [B] permission-grants：真实 SQLite（临时目录）上的增删查 + 缓存失效；
 *   [C] SDK 审批桥（生产代码 createCanUseToolBridge）：
 *       有授权 → 不发 permission_request 直接放行 + 轨迹叙述；
 *       rm -rf 类载荷即使有授权仍被门禁拦（最重要的安全断言）；
 *       会话内「始终拒绝」优先于持久授权；换 agent / 缺 agentId 不命中；
 *   [D] ACP handleServerRequest（生产代码）：命中即按协议正常路径回选
 *       allow 档 + 轨迹叙述；白名单仍在授权之前；没有 allow 档可回选时
 *       照旧弹卡（诚实边界）；换 agent 不命中；
 *   [E] 投影器：note → NoteBlock；permission_request 登记落库元数据；
 *   [F] 源码契约（跨文件不变量）：查表必须排在门禁之后；落库键必须来自
 *       服务端元数据（不信前端）；设置页真的在拉授权清单。
 *
 * 为什么不起真 HTTP 服务：本项目的 e2e 惯例是「脱机打生产模块」（a131 的
 * 说明）。POST /api/permission-response 的落库路径由 [E]（元数据登记）+
 * [B]（落库与缓存）+ [F]（路由体内 addGrant(meta.agentId, …) 的契约）三面
 * 合围 —— 路由体里没有第三行可写的代码。
 *
 * 运行：npx tsx scripts/verify-permission-scope.ts
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import { readFileSync } from 'node:fs';
import { AsyncQueue, PendingReplies } from '../server/agents/channel.js';
import { createCanUseToolBridge, type ApprovalMemory } from '../server/agents/adapters/sdkApproval.js';
import { AcpAdapter } from '../server/agents/adapters/acp.js';
import { RunProjector } from '../server/agents/projector.js';
import {
  __resetPermissionMetaForTests,
  peekPendingPermissionMeta,
  takePendingPermissionMeta,
} from '../server/agents/permissionMeta.js';
import {
  addGrant,
  hasAgentGrant,
  listGrants,
  removeGrant,
  __resetGrantCacheForTests,
} from '../server/permission-grants.js';
import { parsePermissionBody } from '../shared/permissions.js';
import type { AgentEvent, PermissionDecision, SendContext } from '../server/agents/types.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(detail ? `${label} —— ${detail}` : label);
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`);
    failures.push(label);
  }
}

function section(title: string) {
  console.log(`\n— ${title}`);
}

const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

// ============= [A] persistAgent 的协议边界 =============

section('[A] parsePermissionBody：persistAgent 只认字面 true，且只跟 allow 一起');
{
  const okCase = parsePermissionBody({ behavior: 'allow', optionId: 'allow_always', persistAgent: true });
  ok(okCase.ok, 'allow + persistAgent:true 合法');
  if (okCase.ok) {
    eq(okCase.persistAgent, true, 'persistAgent 出现在 decision 外面（适配器不感知）');
    eq(
      Object.keys(okCase.decision).sort(),
      ['behavior', 'optionId'],
      'decision 本体不含 persistAgent（三个适配器不用各删一遍）'
    );
  }
  const plain = parsePermissionBody({ behavior: 'allow', optionId: 'allow_once' });
  ok(plain.ok && !plain.persistAgent, '不带 persistAgent 时字段缺省（请求体与旧版形状一致）');
  ok(!parsePermissionBody({ behavior: 'deny', persistAgent: true }).ok, 'deny 不能携带持久化请求（400，不静默当 allow）');
  ok(!parsePermissionBody({ behavior: 'allow', persistAgent: '1' }).ok, "persistAgent:'1' 报错（truthy 别的值不静默纠正）");
  ok(!parsePermissionBody({ behavior: 'allow', persistAgent: 1 }).ok, 'persistAgent:1 报错');
  ok(!parsePermissionBody({ behavior: 'allow', persistAgent: false }).ok, 'persistAgent:false 报错（不带 = 缺省，而不是显式 false）');
}

// ============= [B] permission-grants：落库 / 撤销 / 缓存失效 =============

section('[B] permission-grants：真实 SQLite 上的增删查与缓存');
{
  eq(listGrants().length, 0, '新库初始没有授权行');

  ok(addGrant('agent-a', 'Bash'), 'addGrant 成功');
  ok(hasAgentGrant('agent-a', 'Bash'), '查表命中');
  ok(addGrant('agent-a', 'Bash'), '重复授权（UNIQUE upsert）不炸');
  eq(listGrants().filter(g => g.agent_id === 'agent-a' && g.tool_name === 'Bash').length, 1,
    '同一 (agent, tool) 只有一行 —— 重复授权是刷新，不是第二行');

  ok(!hasAgentGrant('agent-a', 'Write'), '同 agent 换工具不命中');
  ok(!hasAgentGrant('agent-b', 'Bash'), '换 agentId 不命中（授权键是 agentId + toolName）');
  ok(!hasAgentGrant('', 'Bash'), '空 agentId 不命中（查不到键的检查等于没查）');
  ok(!hasAgentGrant('agent-a', ''), '空 toolName 不命中');
  ok(!hasAgentGrant(undefined, 'Bash'), 'undefined 不命中');

  // 缓存失效：先读一次进缓存，再写入，必须立刻可见
  ok(hasAgentGrant('agent-a', 'Write') === false, '先读一次（Write 未授权进缓存）');
  addGrant('agent-a', 'Write');
  ok(hasAgentGrant('agent-a', 'Write'), 'addGrant 之后缓存立刻失效（读旧缓存 = 撤销不生效）');
  ok(removeGrant('agent-a', 'Write'), 'removeGrant 成功');
  ok(!hasAgentGrant('agent-a', 'Write'), '撤销之后立刻不命中（弹卡回归）');
  ok(!removeGrant('agent-a', 'Write'), '重复撤销返回 false（设置页据此提示）');
  ok(!removeGrant('agent-x', 'Bash'), '撤销不存在的授权返回 false');

  // 清场，后面的桥接测试从「agent-a 只有 Bash」这个已知状态开始
  removeGrant('agent-a', 'Bash');
  addGrant('agent-a', 'Bash');
  __resetGrantCacheForTests();
}

// ============= [C] SDK 审批桥：有授权不弹卡，门禁仍在最前 =============

/** 造一套桥接依赖。queue 由测试 drain 成数组，便于断言「发了什么事件」。 */
function makeBridge(agentId: string | undefined, memory?: ApprovalMemory) {
  const queue = new AsyncQueue<AgentEvent>();
  const replies = new PendingReplies<PermissionDecision>();
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const ev of queue) events.push(ev);
  })();
  const ctx = {
    sessionId: 's1',
    prompt: 'test',
    permissionMode: 'default',
    cwd: process.cwd(),
  } as SendContext;
  const mem: ApprovalMemory = memory ?? { allow: new Set(), deny: new Set() };
  const bridge = createCanUseToolBridge({
    queue,
    replies,
    memory: mem,
    ctx,
    sessionId: 's1',
    ...(agentId !== undefined ? { agentId } : {}),
    options: [
      { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
      { id: 'allow_once', kind: 'allow_once', label: '允许' },
      { id: 'allow_always', kind: 'allow_always', label: '本会话始终允许' },
    ],
    expiresInMs: 60_000,
  });
  return { bridge, events, replies };
}

const countOf = (events: AgentEvent[], type: string) =>
  events.filter(e => e.type === type).length;

/** 等队列 drain 跑完一轮微任务 + 宏任务 */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

section('[C] SDK 审批桥（生产代码）：授权命中不弹卡，门禁仍然最前');
{
  // C1 无授权：正常弹卡，allow_once 答复放行（回归基线）。
  // agent-none 从没被授权过 —— agent-a 在 [B] 结尾被留了 Bash 授权，别用错。
  {
    const { bridge, events, replies } = makeBridge('agent-none');
    const pending = bridge('Bash', { command: 'npm test' });
    await flush();
    ok(countOf(events, 'permission_request') === 1, '无授权 → 照常发出 permission_request');
    const req = events.find(e => e.type === 'permission_request');
    ok(!!req, '弹卡事件在队列里');
    replies.settle((req as { requestId: string }).requestId, { behavior: 'allow', optionId: 'allow_once' });
    const result = await pending;
    eq(result.behavior, 'allow', 'allow_once 答复 → 工具放行');
  }

  // C2 有授权：不弹卡直接放行 + 轨迹审计叙述。
  // 用超时护栏包住：查表被删（反向探针 P1）时这里会挂起等一个不会来的答复，
  // 不护栏的话整条闸门以「未决顶层 await」崩溃，红是红了但说不清红在哪。
  // 护栏定时器**不 unref**（否则事件循环空了它自己也不会响），成功路径 clearTimeout。
  {
    const { bridge, events } = makeBridge('agent-a');
    let guard: NodeJS.Timeout | null = null;
    let result: { behavior: string } | null = null;
    try {
      result = await Promise.race([
        bridge('Bash', { command: 'npm test' }),
        new Promise<never>((_, reject) => {
          guard = setTimeout(() => reject(new Error('auto-allow hung')), 2000);
        }),
      ]);
    } catch {
      ok(false, '有持久授权 → 直接放行（挂起等答复 = 查表没生效）');
      process.exit(1); // 立即退出：挂起的 replies.register 定时器不让进程自然收尾
    } finally {
      if (guard) clearTimeout(guard);
    }
    eq((result as { behavior: string }).behavior, 'allow', '有持久授权 → 直接放行');
    eq(countOf(events, 'permission_request'), 0, '不再向客户端发 permission_request（这就是「省掉问用户」）');
    const note = events.find(e => e.type === 'note') as { text?: string } | undefined;
    ok(!!note, '轨迹里有审计叙述（note 事件）');
    ok(
      !!note?.text?.includes('已授权范围自动放行') && !!note?.text?.includes('agent-a · Bash'),
      `叙述写明 agent 与工具：${note?.text ?? '(无)'}`
    );
  }

  // C3 高危门禁前置（最重要的安全断言）：授权不能把 rm -rf 放出去
  {
    const { bridge, events } = makeBridge('agent-a');
    const result = await bridge('Bash', { command: 'rm -rf /' });
    eq(result.behavior, 'deny', 'rm -rf 载荷即使有持久授权仍被门禁拒绝');
    ok(
      countOf(events, 'permission_request') === 0 && countOf(events, 'note') === 0,
      '门禁拦截发生在弹卡与审计之前（不弹卡、不留放行叙述）'
    );
    ok(
      /不是工具故障|策略/.test((result as { message?: string }).message ?? ''),
      '拒绝文案是两段式（策略限制，不是工具故障）'
    );
  }

  // C4 会话内「始终拒绝」优先于持久授权（最近、最明确的表态赢）
  {
    const denyMemory: ApprovalMemory = { allow: new Set(), deny: new Set(['Bash']) };
    const { bridge, events } = makeBridge('agent-a', denyMemory);
    const result = await bridge('Bash', { command: 'npm test' });
    eq(result.behavior, 'deny', '会话内 deny 记忆优先于持久授权（授权翻不了案）');
    ok(countOf(events, 'note') === 0, '被会话拒绝时不留放行叙述');
  }

  // C5 换 agent：同一工具、没授权的 Agent 照常弹卡
  {
    const { bridge, events, replies } = makeBridge('agent-b');
    const pending = bridge('Bash', { command: 'npm test' });
    await flush();
    ok(countOf(events, 'permission_request') === 1, '换 agentId → 不命中授权，照常弹卡');
    const req = events.find(e => e.type === 'permission_request') as { requestId: string };
    replies.settle(req.requestId, { behavior: 'deny', reasonCode: 'user_rejected' });
    const result = await pending;
    eq(result.behavior, 'deny', '拒绝正常回传');
  }

  // C6 agentId 缺省（适配器没报）：跳过查表，照常弹卡 —— 诚实边界
  {
    const { bridge, events, replies } = makeBridge(undefined);
    const pending = bridge('Bash', { command: 'npm test' });
    await flush();
    ok(countOf(events, 'permission_request') === 1, 'agentId 缺省 → 不做乐观放行，照常弹卡');
    const req = events.find(e => e.type === 'permission_request') as { requestId: string };
    replies.settle(req.requestId, { behavior: 'deny', reasonCode: 'user_rejected' });
    await pending;
  }
}

// ============= [D] ACP handleServerRequest：命中即回选 allow 档 =============

section('[D] ACP（生产代码）：命中授权按协议正常路径回选，白名单仍在前面');
{
  const def = {
    descriptor: { id: 'acp-agent', name: 'ACP Fixture', kind: 'acp', command: 'acp-fixture' },
  } as never;
  const adapter = new AcpAdapter(def);
  const responses: Array<{ id: unknown; result: unknown }> = [];
  const queue = new AsyncQueue<AgentEvent>();
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const ev of queue) events.push(ev);
  })();
  // 测试注入（TS private 只是编译期）：假 rpc + 已连接的会话队列
  (adapter as unknown as { rpc: unknown }).rpc = {
    respond: (id: unknown, result: unknown) => responses.push({ id, result }),
    respondError: () => {},
  };
  const internal = adapter as unknown as {
    streams: Map<string, AsyncQueue<AgentEvent>>;
    allowlists: Map<string, unknown>;
    handleServerRequest: (msg: Record<string, unknown>) => void;
  };
  internal.streams.set('acp-s', queue);
  internal.allowlists.set('acp-s', undefined);

  const ask = (id: number, toolTitle: string, options: unknown) =>
    internal.handleServerRequest({
      method: 'session/request_permission',
      id,
      params: {
        sessionId: 'acp-s',
        toolCall: { toolCallId: `t${id}`, kind: 'execute', title: toolTitle, rawInput: { command: 'ls' } },
        options,
      },
    });

  const ACP_OPTIONS = [
    { optionId: 'o1', kind: 'allow_once', name: '允许' },
    { optionId: 'o2', kind: 'allow_always', name: '始终允许' },
    { optionId: 'o3', kind: 'reject_once', name: '拒绝' },
  ];

  // D1 无授权：走弹卡路径（permission_request 进队列，不回 RPC）
  ask(1, '执行命令', ACP_OPTIONS);
  await Promise.resolve();
  ok(countOf(events, 'permission_request') === 1, '无授权 → 向客户端发 permission_request');
  eq(responses.length, 0, '不直接回 RPC（等前端答复）');

  // D2 有授权：按正常 allow 应答路径回选，不弹卡 + 轨迹叙述
  addGrant('acp-agent', '执行命令');
  ask(2, '执行命令', ACP_OPTIONS);
  await Promise.resolve();
  eq(countOf(events, 'permission_request'), 1, '有授权 → 不再发 permission_request（计数不变）');
  eq(responses.length, 1, '命中即回 RPC');
  const sel = (responses[0]?.result as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
  eq(sel?.outcome, 'selected', 'outcome 是 selected（协议的正常 allow 应答路径，不是 cancelled）');
  ok(sel?.optionId === 'o1' || sel?.optionId === 'o2', `回选的是 allow 档：${sel?.optionId}`);
  const note = events.find(e => e.type === 'note') as { text?: string } | undefined;
  ok(!!note?.text?.includes('acp-agent · 执行命令'), `轨迹叙述写明 agent 与工具：${note?.text ?? '(无)'}`);

  // D3 白名单仍在授权之前：空场景白名单拦下一切，授权翻不了
  internal.allowlists.set('acp-s', []);
  ask(3, '执行命令', ACP_OPTIONS);
  await Promise.resolve();
  const blocked = (responses[responses.length - 1]?.result as { outcome?: { optionId?: string } })?.outcome;
  eq(blocked?.optionId, 'o3', '场景白名单拦截优先于持久授权（回选的是 reject 档）');
  eq(countOf(events, 'note'), 1, '被白名单拦截时不留放行叙述');
  internal.allowlists.set('acp-s', undefined);

  // D4 诚实边界：授权命中但目录里没有 allow 档可回选 → 照旧弹卡
  addGrant('acp-agent', '只读工具');
  ask(4, '只读工具', [{ optionId: 'o3', kind: 'reject_once', name: '拒绝' }]);
  await Promise.resolve();
  ok(countOf(events, 'permission_request') === 2, '没有 allow 档可回选 → 照旧弹卡（不假装放行）');

  // D5 换 agent 不命中：acp-agent 只有「执行命令」的授权，「网络请求」没有
  addGrant('other-agent', '网络请求');
  ask(5, '网络请求', ACP_OPTIONS);
  await flush();
  ok(countOf(events, 'permission_request') === 3, '没授权的工具（即便别的 agent 有）→ 照常弹卡');
}

// ============= [E] 投影器：note 块 + 落库元数据 =============

section('[E] 投影器：note 落成 NoteBlock，permission_request 登记落库元数据');
{
  __resetPermissionMetaForTests();
  const projector = new RunProjector({
    runId: 'run-1',
    sessionId: 's1',
    messageId: 'm1',
    agentId: 'agent-x',
  });

  const noteEvents = projector.push({ type: 'note', text: '权限：已授权范围自动放行（agent-x · Bash）' });
  eq(noteEvents.length, 1, 'note 产出一条 v2 事件');
  const opened = noteEvents[0] as { block?: { type: string; text: string; level: string } };
  eq(opened.block?.type, 'note', '块型是 note（与群聊编排叙述同一渲染路）');
  eq(opened.block?.level, 'info', '级别 info');
  ok(projector.blockList.some(b => b.type === 'note' && b.text.includes('agent-x · Bash')),
    '块序列里真的有这条叙述（会随消息落库，刷新后仍可查）');

  eq(projector.push({ type: 'note', text: '  ' }).length, 0, '空叙述不产出事件');

  const reqEvents = projector.push({
    type: 'permission_request',
    requestId: 'pr-1',
    toolName: 'Bash',
    input: { command: 'ls' },
  });
  eq(reqEvents.length, 1, 'permission_request 照常透传');
  const meta = peekPendingPermissionMeta('pr-1');
  ok(!!meta, '落库元数据已登记');
  eq(meta?.agentId, 'agent-x', 'agentId 来自投影器 meta（事件流本身，不是前端回传）');
  eq(meta?.toolName, 'Bash', 'toolName 来自事件');
  eq(takePendingPermissionMeta('pr-1')?.toolName, 'Bash', 'take 取走（至多消费一次）');
  eq(takePendingPermissionMeta('pr-1'), undefined, '再取为空（防重复落库）');
}

// ============= [F] 源码契约（跨文件不变量） =============

section('[F] 源码契约：查表顺序、落库键来源、选择器条件渲染');
{
  // F1 SDK 桥：白名单门禁 → deny 记忆 → 持久授权 → memory.allow → 挂起等待。
  // 顺序即安全：持久授权只能省「问用户」，省不掉它前面的每一道闸。
  const bridgeSrc = src('../server/agents/adapters/sdkApproval.ts');
  const iGate = bridgeSrc.indexOf('evaluateToolCall(');
  const iDeny = bridgeSrc.indexOf('memory.deny.has(toolName)');
  const iGrant = bridgeSrc.indexOf('hasAgentGrant(agentId, toolName)');
  const iAllow = bridgeSrc.indexOf('memory.allow.has(toolName)');
  const iRegister = bridgeSrc.indexOf('replies.register(');
  ok(iGate > -1 && iDeny > -1 && iGrant > -1 && iAllow > -1 && iRegister > -1,
    '桥接的五个判定点都在（白名单门禁 / deny 记忆 / 持久授权 / allow 记忆 / 挂起等待）');
  ok(iGrant > iGate, '持久授权查表在白名单门禁之后（门禁前置不可挪动）');
  ok(iGrant > iDeny, '持久授权查表在会话 deny 记忆之后（最近表态优先）');
  ok(iGrant < iAllow, '持久授权查表在 memory.allow 之前（表命中的放行路径生效）');
  ok(iGrant < iRegister, '查表发生在挂起等待之前（命中就永远不弹卡）');
  ok(/type: 'note'/.test(bridgeSrc) && /已授权范围自动放行/.test(bridgeSrc),
    '自动放行留下轨迹叙述（审计可见）');

  // F2 ACP：白名单 → 持久授权 → 弹卡。
  const acpSrc = src('../server/agents/adapters/acp.ts');
  const aWhitelist = acpSrc.indexOf('decideAcpToolAccess(');
  const aGrant = acpSrc.indexOf('hasAgentGrant(this.descriptor.id, title)');
  const aPush = acpSrc.indexOf("type: 'permission_request'");
  ok(aWhitelist > -1 && aGrant > -1 && aPush > -1, 'ACP 的三个判定点都在');
  ok(aGrant > aWhitelist, 'ACP 查表在场景白名单之后');
  ok(aGrant < aPush, 'ACP 命中时永远不会走到弹卡（查表在 push 之前）');
  ok(/selectAcpOption\(options, \{ behavior: 'allow' \}\)/.test(acpSrc),
    '自动放行走协议的正常 allow 应答路径（selectAcpOption 复用，不另造回包）');

  // F3 CLI：门禁 → 持久授权 → 弹卡（公共路径上的同一把尺子）。
  const cliSrc = src('../server/agents/adapters/cli.ts');
  const cGate = cliSrc.indexOf('evaluateToolCall(');
  const cGrant = cliSrc.indexOf('hasAgentGrant(this.descriptor.id, ask.toolName)');
  const cPush = cliSrc.indexOf("type: 'permission_request'");
  ok(cGate > -1 && cGrant > -1 && cPush > -1, 'CLI 的三个判定点都在');
  ok(cGrant > cGate && cGrant < cPush, 'CLI 查表在门禁之后、弹卡之前');

  // F4 落库表与缓存失效。
  const grantsSrc = src('../server/permission-grants.ts');
  ok(/CREATE TABLE IF NOT EXISTS permission_grants/.test(grantsSrc), '建表是 CREATE TABLE IF NOT EXISTS 的增量');
  ok(/UNIQUE\(agent_id, tool_name\)/.test(grantsSrc), '唯一约束落在 (agent_id, tool_name)');
  ok(/export function addGrant[\s\S]*?invalidateGrantCache\(\)/.test(grantsSrc),
    'addGrant 失效缓存（撤销后读到旧缓存 = 撤销不生效）');
  ok(/export function removeGrant[\s\S]*?invalidateGrantCache\(\)/.test(grantsSrc),
    'removeGrant 失效缓存');

  // F5 路由：落库键必须来自服务端元数据 —— **不信前端**。
  const indexSrc = src('../server/index.ts');
  ok(/app\.get\("\/api\/permission-grants"/.test(indexSrc), 'GET /api/permission-grants 路由在');
  ok(/app\.delete\("\/api\/permission-grants"/.test(indexSrc), 'DELETE /api/permission-grants 路由在');
  ok(/parsed\.persistAgent/.test(indexSrc) && /takePendingPermissionMeta\(requestId\.trim\(\)\)/.test(indexSrc),
    'persistAgent 与待答复元数据在答复路由里被消费');
  ok(/addGrant\(meta\.agentId, meta\.toolName\)/.test(indexSrc),
    '落库键取自服务端元数据（requestId → agentId + toolName，事件流是唯一来源）');
  ok(!/addGrant\(\s*req\.body/.test(indexSrc) && !/addGrant\(\s*b\.agentId/.test(indexSrc),
    '路由绝不拿请求体里的 agentId/toolName 落库（前端传的不算数）');

  // F6 投影器：note 块 + 元数据登记收口在唯一经过点。
  const projSrc = src('../server/agents/projector.ts');
  ok(/case 'note'/.test(projSrc), '投影器处理 note 事件');
  ok(/recordPendingPermissionMeta\(/.test(projSrc) && /agentId: this\.meta\.agentId/.test(projSrc),
    'permission_request 经过投影器时登记落库元数据（单聊/群聊/工作流的唯一收口）');

  // F7 前端：选择器条件渲染 + 锚点 + 文案随动 + 答复链路。
  const cardSrc = src('../src/components/PermissionCard.tsx');
  ok(/allowOnce && allowAlways/.test(cardSrc),
    '选择器只在三段都有真档位时渲染（CLI 两档 / ACP 单 always 档不画假段位）');
  ok(/data-permission-scope-option=/.test(cardSrc) && /data-permission-scope\b/.test(cardSrc),
    '选择器挂 data 锚点（闸门定位用）');
  ok(/role="radiogroup"/.test(cardSrc) && /aria-checked=/.test(cardSrc) && /ArrowRight/.test(cardSrc),
    'radiogroup 语义 + 方向键切换（a11y 档）');
  ok(/data-permission-option=\{confirmOption\.id\}/.test(cardSrc) && /persistAgent: true/.test(cardSrc),
    '确认按钮锚定当前选中档，选「该 Agent 永久」时答复带 persistAgent');
  ok(/permission\.scope\.confirmOnce/.test(cardSrc)
    && /permission\.scope\.confirmSession/.test(cardSrc)
    && /permission\.scope\.confirmAgent/.test(cardSrc),
    '确认文案随范围变化（三档三个 key）');
  ok(/data-permission-scope-hint/.test(cardSrc), '「该 Agent 永久」的边界说明挂在按钮行下方');

  const storeSrc = src('../src/permissions/permissionStore.ts');
  ok(/opts\?\.persistAgent \? \{ persistAgent: true \}/.test(storeSrc),
    'store.answer 只在请求持久化时才把 persistAgent 放进请求体');

  const settingsSrc = src('../src/components/SettingsPage.tsx');
  ok(/fetch\('\/api\/permission-grants'\)/.test(settingsSrc), '设置页真的在拉授权清单');
  ok(/method: 'DELETE'/.test(settingsSrc) && /data-permission-revoke=/.test(settingsSrc),
    '设置页真的在撤销（不是摆一颗没接线的按钮）');
}

// ── 汇总 ──
console.log('');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n结果：${checks.total - failures.length}/${checks.total} 通过`);
  process.exit(1);
}
console.log(`结果：${checks.total}/${checks.total} 通过`);
