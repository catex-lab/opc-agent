/**
 * 权限模式强制能力验证（P4-5）。
 *
 * 这个脚本存在的核心目的：**防止「声称支持」与「实现真的做了」脱节**。
 *
 * 背景：`permissionMode` 一直是声明式参数，但并非每个适配器都会把它翻译成
 * CLI 的实际开关。实测（2026-10-17 逐个查 `--help`）发现 5 个可用 Agent 里
 * 有 3 个落不了地 —— 于是「问答 = 只读」在它们身上是空承诺。
 *
 * 本次的修法不是「统一加白名单」（各 CLI 根本没这个开关），而是：
 *   1. 能落地的真的落地（codex 接上 `-s/--sandbox`）；
 *   2. 落不了的，把能力边界如实暴露给 UI。
 *
 * 因此本脚本断言两类东西：
 *   - **映射正确**：权限模式 → CLI 参数，逐条对照 `--help` 实测的取值；
 *   - **声称一致**：矩阵里声称支持某模式，就必须能证明实现真的产出了对应参数
 *     （CLI 看 buildArgs，SDK 看源码）。这条是本脚本的主线。
 *
 * 全离线、不碰数据库、不需要任何 Agent 在线。
 * 运行：npx tsx scripts/verify-permission.ts
 */
import { readFileSync } from 'node:fs';
import { AGENT_DEFS, findDef } from '../server/agents/definitions.js';
import {
  codexSandboxFor,
  permissionSupportFor,
  canEnforce,
  describeEnforcementGap,
} from '../server/agents/permissions.js';
import { SCENARIOS, enforcementGap, restrictsDangerousTools } from '../src/scenarios.js';
import {
  categorizeTool,
  decideToolAccess,
  decideAcpToolAccess,
  knownToolNames,
} from '../server/agents/toolPolicy.js';
import type { PermissionMode } from '../server/agents/types.js';
import type { ScenarioTool } from '../shared/scenarios.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function section(title: string) {
  console.log(`\n— ${title}`);
}

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** 取某个 CLI Agent 的 buildArgs 结果 */
function argsOf(agentId: string, mode: PermissionMode | undefined, extra: Record<string, unknown> = {}) {
  const def = findDef(agentId);
  if (!def?.cli) throw new Error(`找不到 ${agentId} 的 cli 定义`);
  return def.cli.buildArgs('PROMPT', {
    sessionId: 's',
    prompt: 'PROMPT',
    permissionMode: mode,
    ...extra,
  } as Parameters<typeof def.cli.buildArgs>[1]);
}

// ============= A. codex 沙箱映射 =============
section('A. codex 权限模式 → 沙箱策略');

eq(codexSandboxFor('plan'), 'read-only', 'plan 映射为只读沙箱');
eq(codexSandboxFor('acceptEdits'), 'workspace-write', 'acceptEdits 映射为可写工作区');
eq(codexSandboxFor('bypassPermissions'), 'danger-full-access', 'bypassPermissions 映射为全放行');
eq(codexSandboxFor('default'), null, 'default 不指定沙箱（交给 codex 自身默认策略）');
eq(codexSandboxFor(undefined), null, '未传权限模式时不指定沙箱');

// 取值必须落在 `codex exec --help` 实测的枚举里，防止拼错一个不存在的值
const CODEX_SANDBOX_VALUES = ['read-only', 'workspace-write', 'danger-full-access'];
for (const mode of MODES) {
  const v = codexSandboxFor(mode);
  if (v) ok(CODEX_SANDBOX_VALUES.includes(v), `codex 沙箱取值合法：${mode} → ${v}`);
}

// ============= B. codex buildArgs 真的带上了参数 =============
section('B. codex 命令行参数');

const codexPlan = argsOf('codex', 'plan');
ok(
  codexPlan.includes('-s') && codexPlan.includes('read-only'),
  'plan 模式下真的产出 -s read-only',
  codexPlan.join(' ')
);
eq(
  [argsOf('codex', 'acceptEdits').includes('workspace-write'), argsOf('codex', 'bypassPermissions').includes('danger-full-access')],
  [true, true],
  '其余两档也真的产出对应沙箱值'
);
ok(!argsOf('codex', 'default').includes('-s'), 'default 模式不注入 -s');
ok(!argsOf('codex', undefined).includes('-s'), '未传模式时不注入 -s');
eq(argsOf('codex', 'plan').at(-1), 'PROMPT', 'prompt 仍是最后一个参数');
ok(
  argsOf('codex', 'plan').slice(0, 2).join(' ') === 'exec --skip-git-repo-check',
  '保留了原有 exec 子命令与跳过 git 检查'
);
const withModel = argsOf('codex', 'plan', { model: 'o3' });
ok(withModel.includes('-m') && withModel.includes('o3'), '带模型时仍有 -m <model>');

// ============= C. gemini 回归（改动不应影响它） =============
section('C. gemini 审批模式（回归）');

const geminiMap: Array<[PermissionMode, string]> = [
  ['plan', 'plan'],
  ['acceptEdits', 'auto_edit'],
  ['bypassPermissions', 'yolo'],
  // ⚠️ 注意这里不是 'default'：geminiApproval() 刻意把 default 也归到 plan（只读），
  // 因为 `-p` 非交互模式无法应答审批提示。这是既有行为，本次不改（gemini 本机不可达，
  // 改映射无法实测）。但矩阵必须如实反映这个退化，否则「工作场景 + gemini 改不了文件」
  // 会被当成产品 bug 反复排查。断言见下方 D 段。
  ['default', 'plan'],
];
for (const [mode, expected] of geminiMap) {
  const a = argsOf('gemini', mode);
  const i = a.indexOf('--approval-mode');
  eq(i >= 0 ? a[i + 1] : null, expected, `gemini ${mode} → --approval-mode ${expected}`);
}
// default 的退化必须被矩阵如实记录，而不是被当成「完整支持」
ok(
  !permissionSupportFor('gemini').enforced.includes('default'),
  'gemini 不把 default 算作「能强制」（它会退化为只读）'
);
ok(
  !!permissionSupportFor('gemini').limitation,
  'gemini 的 default 退化有 limitation 说明'
);

// ============= D. 能力矩阵的合法性与「声称 = 实现」 =============
section('D. 能力矩阵：声称支持必须能证明实现');

for (const def of AGENT_DEFS) {
  const support = permissionSupportFor(def.descriptor.id);
  ok(Array.isArray(support.enforced), `${def.descriptor.id} 有矩阵条目（或安全兜底）`);
  for (const m of support.enforced) {
    ok(MODES.includes(m), `${def.descriptor.id} 的 enforced 含合法模式：${m}`);
  }
}

// codex 声称支持 plan → 必须真的产出只读沙箱
ok(permissionSupportFor('codex').enforced.includes('plan'), 'codex 声称支持 plan');
ok(argsOf('codex', 'plan').includes('read-only'), 'codex 声称与实现一致（真的产出 read-only）');

// gemini 声称支持 plan → 必须真的产出 --approval-mode plan
ok(permissionSupportFor('gemini').enforced.includes('plan'), 'gemini 声称支持 plan');
{
  const a = argsOf('gemini', 'plan');
  eq(a[a.indexOf('--approval-mode') + 1], 'plan', 'gemini 声称与实现一致');
}

// workbuddy 走 SDK，没有命令行参数可查 —— 直接断言源码里确实把 permissionMode 传下去了
{
  const sdkSrc = readFileSync(new URL('../server/agents/adapters/sdk.ts', import.meta.url), 'utf8');
  ok(
    /permissionMode:\s*ctx\.permissionMode/.test(sdkSrc),
    'workbuddy 声称支持：SDK 源码里确实传了 permissionMode'
  );
  ok(
    /ctx\.permissionMode === 'bypassPermissions'/.test(sdkSrc),
    'workbuddy 声称支持：源码里确有 bypassPermissions 分支'
  );
}

// 明确「不声称」的，不得偷偷声称
for (const id of ['opencode', 'hermes']) {
  ok(!permissionSupportFor(id).enforced.includes('plan'), `${id} 不声称支持只读（实测无对应开关）`);
  ok(!!permissionSupportFor(id).limitation, `${id} 有 limitation 说明`);
}
eq(permissionSupportFor('claude').enforced, [], 'claude 不声称任何强制（二进制缺失，未实测）');
ok(!!permissionSupportFor('claude').limitation, 'claude 有 limitation 说明');
eq(permissionSupportFor('__nope__').enforced, [], '未知 Agent 安全兜底为不支持');

// ============= E. canEnforce =============
section('E. canEnforce');

ok(canEnforce('codex', 'plan'), 'canEnforce(codex, plan)');
ok(!canEnforce('opencode', 'plan'), 'canEnforce(opencode, plan) 为 false');
ok(!canEnforce('hermes', 'plan'), 'canEnforce(hermes, plan) 为 false');
ok(!canEnforce('__nope__', 'plan'), '未知 Agent 一律 false');

// ============= F. 提示文案（后端入口） =============
section('F. 差异提示（后端 describeEnforcementGap，按 scenarioId）');

eq(describeEnforcementGap('codex', 'qa'), null, 'codex + 问答 → 不提示（能强制只读）');
const gapOpencode = describeEnforcementGap('opencode', 'qa');
ok(!!gapOpencode, 'opencode + 问答 → 有提示');
ok(!!gapOpencode && gapOpencode.includes('只读'), '提示里点明「只读」', String(gapOpencode));
const gapDev = describeEnforcementGap('opencode', 'dev');
ok(!!gapDev, 'opencode + 开发 → 也有提示（acceptEdits 落不了地）');
ok(
  !!gapDev && !gapDev.includes('该场景承诺'),
  '开发场景不说「承诺只读」（措辞要区分场景类型）',
  String(gapDev)
);
eq(describeEnforcementGap('codex', undefined), null, '没有场景时不提示');

// ============= G. 只有一份判据（共享层） =============
section('G. 判据唯一性（前后端共用 shared/scenarios.ts）');

// P4-5 之前前后端各有一份实现，靠逐字比对防漂移。共享层建立后根因已消除，
// 这里改成断言「确实只有一份」—— 防止有人又在前端复制一个同名函数。
{
  const srcShim = readFileSync(new URL('../src/scenarios.ts', import.meta.url), 'utf8');
  ok(
    /export\s+\*\s+from\s+'\.\.\/shared\/scenarios'/.test(srcShim),
    'src/scenarios.ts 只是再导出（没有第二份实现）'
  );
  ok(
    !/function\s+enforcementGap/.test(srcShim),
    'src/scenarios.ts 里没有自己再写一遍 enforcementGap'
  );

  const permSrc = readFileSync(
    new URL('../server/agents/permissions.ts', import.meta.url),
    'utf8'
  );
  ok(
    /return\s+enforcementGap\(getScenario\(scenarioId\),\s*permissionSupportFor\(agentId\)\)/.test(
      permSrc
    ),
    '后端 describeEnforcementGap 直接复用共享实现（不是另写一份）'
  );
}

// 后端入口（按 id 查场景）与前端入口（直接拿场景对象）必须给出同一结论
const agentIds = ['workbuddy', 'gemini', 'codex', 'opencode', 'hermes', 'claude'];
let compared = 0;
let mismatched = 0;
for (const scenario of SCENARIOS) {
  for (const id of agentIds) {
    const front = enforcementGap(scenario, permissionSupportFor(id));
    const back = describeEnforcementGap(id, scenario.id);
    compared++;
    if (front !== back) {
      mismatched++;
      failures.push(
        `两条入口结论不一致：场景 ${scenario.id} × Agent ${id}\n      前端: ${front}\n      后端: ${back}`
      );
    }
  }
}
ok(compared === SCENARIOS.length * agentIds.length, `覆盖 ${compared} 组（场景 × Agent）`);
ok(mismatched === 0, '按 id 查场景与直接传场景结论一致', `不一致 ${mismatched} 组`);

// ============= H. 场景层现状 =============
section('H. 场景模板与默认选择');

for (const id of ['qa', 'write']) {
  const s = SCENARIOS.find(x => x.id === id)!;
  eq([s.tools.length, s.permissionMode], [0, 'plan'], `${s.label}场景：无工具 + 只读`);
  // 默认推荐的 Agent 必须能真正强制只读，否则一进场景页就顶着一条警告
  const rec = s.recommendedAgentId!;
  ok(canEnforce(rec, 'plan'), `${s.label}场景的推荐 Agent（${rec}）能强制只读`);
  eq(enforcementGap(s, permissionSupportFor(rec)), null, `${s.label}场景 + 推荐 Agent → 无警告`);
}

for (const id of ['dev', 'code']) {
  const s = SCENARIOS.find(x => x.id === id)!;
  ok(s.tools.length > 0, `${s.label}场景确实声明了工具`);
}

// ============= I. 工具白名单（P4-5 后半段） =============
section('I. 工具白名单判据');

// I-1 分类表：常见的读写/执行/联网工具都要能归类，否则白名单会「静默失效」
const CATEGORY_CASES: Array<[string, string]> = [
  ['Read', 'file'],
  ['Write', 'file'],
  ['Edit', 'file'],
  ['MultiEdit', 'file'],
  ['Grep', 'file'],
  ['Glob', 'file'],
  ['Bash', 'shell'],
  ['BashOutput', 'shell'],
  ['KillShell', 'shell'],
  ['WebSearch', 'search'],
  ['WebFetch', 'search'],
  ['Task', 'escalation'],
  ['Skill', 'escalation'],
  ['TodoWrite', 'meta'],
];
for (const [name, expected] of CATEGORY_CASES) {
  eq(categorizeTool(name), expected, `工具分类：${name} → ${expected}`);
}
eq(categorizeTool('MadeUpToolName'), null, '未登记的工具名返回 null');
ok(knownToolNames().length >= 15, '分类表覆盖了足够多的工具', `${knownToolNames().length} 个`);

// I-2 白名单判定
const allow = (allowed: ScenarioTool[] | undefined, tool: string) =>
  decideToolAccess(allowed, tool).allowed;

ok(allow(undefined, 'Bash'), '未声明白名单 → 不限制（保持历史行为）');
ok(allow(['tools'], 'Bash') && allow(['tools'], 'Write'), "['tools'] → 全部放行");

ok(!allow([], 'Bash'), '空白名单 → 拒绝 Bash');
ok(!allow([], 'Read'), '空白名单 → 连 Read 也拒绝（承诺「不调用工具」）');
ok(!allow([], 'TodoWrite'), '空白名单 → 记账类也拒绝（字面执行「不调用工具」）');

ok(allow(['file'], 'Read') && allow(['file'], 'Edit') && allow(['file'], 'Grep'), "['file'] → 放行文件类");
ok(!allow(['file'], 'Bash'), "['file'] → 拒绝 Bash");
ok(!allow(['file'], 'WebSearch'), "['file'] → 拒绝联网检索");
ok(!allow(['file'], 'Task'), "['file'] → 拒绝 Task（可绕过白名单）");

ok(allow(['file', 'shell'], 'Bash') && allow(['file', 'shell'], 'Write'), "['file','shell'] → 两类的都放行");
ok(!allow(['file', 'shell'], 'WebFetch'), "['file','shell'] → 拒绝联网");

ok(allow(['file'], 'TodoWrite'), '白名单非空时放行记账类（否则代理无法维护 todo）');

// 未登记工具 fail-closed，且理由要说明白
{
  const d = decideToolAccess(['file'], 'MadeUpToolName');
  ok(!d.allowed, '未登记工具 → 拒绝（fail-closed）');
  ok(!!d.reason && d.reason.includes('未登记'), '拒绝理由点明「未登记」', String(d.reason));
  eq(d.category, null, '未登记工具的类别为 null');
}

// I-3 ACP：用 kind（协议枚举）分类，不能用 title（人话）
ok(allow([], 'Bash') === false, '（占位一致性检查）');
eq(decideAcpToolAccess(['file'], 'read', '读取 package.json').allowed, true, 'ACP read → 放行');
eq(decideAcpToolAccess(['file'], 'execute', '执行 npm test').allowed, false, 'ACP execute → 拒绝');
eq(decideAcpToolAccess(['file', 'shell'], 'execute', '执行 npm test').allowed, true, 'ACP execute 在 shell 白名单内');
eq(decideAcpToolAccess([], 'read', '读取').allowed, false, 'ACP 空白名单 → 全拒');
{
  const d = decideAcpToolAccess(['file'], undefined, '未知标题');
  ok(!d.allowed, 'ACP kind 缺失且标题无法归类 → 拒绝（fail-closed）');
}

// I-4 矩阵：声称支持工具白名单的，必须能在源码里找到调用点
section('I-4 矩阵与实现一致（工具白名单）');

ok(permissionSupportFor('workbuddy').toolWhitelist?.enforced === true, 'workbuddy 声称能强制工具白名单');
ok(permissionSupportFor('hermes').toolWhitelist?.enforced === true, 'hermes 声称能强制工具白名单');
for (const id of ['codex', 'opencode', 'gemini', 'claude']) {
  eq(permissionSupportFor(id).toolWhitelist?.enforced, false, `${id} 不声称能强制工具白名单`);
  ok(!!permissionSupportFor(id).toolWhitelist?.limitation, `${id} 的工具白名单 limitation 非空`);
}

{
  const sdkSrc = readFileSync(new URL('../server/agents/adapters/sdk.ts', import.meta.url), 'utf8');
  ok(/decideToolAccess\(ctx\.allowedTools/.test(sdkSrc), 'workbuddy 声称与实现一致：canUseTool 里调了判据');
  // 顺序断言：白名单必须**先于** bypass 判断，否则「问答 + 全放行」会让白名单形同虚设
  const gateAt = sdkSrc.indexOf('decideToolAccess(ctx.allowedTools');
  const bypassAt = sdkSrc.indexOf("ctx.permissionMode === 'bypassPermissions'");
  ok(gateAt >= 0 && bypassAt >= 0 && gateAt < bypassAt, '白名单判断在 bypass 之前（顺序不能反）');

  const acpSrc = readFileSync(new URL('../server/agents/adapters/acp.ts', import.meta.url), 'utf8');
  ok(/decideAcpToolAccess\(/.test(acpSrc), 'hermes 声称与实现一致：ACP 授权请求里调了判据');
  ok(/allowlists\.set\(acpSessionId, ctx\.allowedTools\)/.test(acpSrc), 'ACP 按会话存了白名单');
}

// I-5 场景层：白名单语义与提示范围
ok(restrictsDangerousTools([]), '空白名单算「限制危险能力」');
ok(!restrictsDangerousTools(['tools']), "['tools'] 不算限制");
ok(!restrictsDangerousTools(['file', 'shell', 'search']), '开发场景（含 file+shell）不算限制危险能力');
ok(restrictsDangerousTools(['file']), '代码场景（只有 file）算限制危险能力');
ok(restrictsDangerousTools(['image']), '生图场景（只有 image）算限制危险能力');

// 推荐组合不应一进页面就顶着警告
for (const s of SCENARIOS) {
  const rec = s.recommendedAgentId;
  if (!rec) continue;
  const gap = enforcementGap(s, permissionSupportFor(rec));
  ok(gap === null, `${s.label}场景 + 推荐 Agent（${rec}）→ 无警告`, String(gap ?? ''));
}

// ============= 结果 =============
console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败（共 ${checks.total} 项）：\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks.total}/${checks.total} 全部通过`);
