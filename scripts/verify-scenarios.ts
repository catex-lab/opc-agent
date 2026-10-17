/**
 * 场景模板验证（P4-2）。
 *
 * 纯数据校验，无需构建、无需浏览器、不碰数据库：
 *   - 6 个模板齐全、id 唯一、必填字段非空
 *   - permissionMode 合法
 *   - recommendedAgentId 必须在**注册表**里真实存在（否则场景卡会预选一个不存在的 Agent）
 *   - 开发/代码需要工作目录；问答/写作应为只读且无工具
 *   - getScenario() 的命中与未命中行为
 *
 * 运行：npx tsx scripts/verify-scenarios.ts
 */
import { SCENARIOS, getScenario, type ScenarioTemplate } from '../src/scenarios.js';
import { AGENT_DEFS } from '../server/agents/definitions.js';

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

const VALID_PERMISSION: ScenarioTemplate['permissionMode'][] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];

const knownAgentIds = new Set(AGENT_DEFS.map(d => d.descriptor.id));
const EXPECTED_IDS = ['work', 'qa', 'dev', 'code', 'write', 'image'];

// 1. 数量与 id 集合
eq(SCENARIOS.length, 6, '场景数量为 6');
eq(
  SCENARIOS.map(s => s.id).sort(),
  [...EXPECTED_IDS].sort(),
  '场景 id 集合符合预期'
);
eq(new Set(SCENARIOS.map(s => s.id)).size, SCENARIOS.length, '场景 id 唯一');

// 2. 每个模板的必填字段与合法性
for (const s of SCENARIOS) {
  ok(!!s.label && s.label.trim().length > 0, `[${s.id}] label 非空`);
  ok(!!s.description && s.description.trim().length > 0, `[${s.id}] description 非空`);
  ok(!!s.systemPrompt && s.systemPrompt.trim().length > 0, `[${s.id}] systemPrompt 非空`);
  ok(!!s.icon && s.icon.trim().length > 0, `[${s.id}] icon 非空`);
  ok(/^#[0-9A-Fa-f]{6}$/.test(s.color), `[${s.id}] color 是合法十六进制色`, s.color);
  ok(
    VALID_PERMISSION.includes(s.permissionMode),
    `[${s.id}] permissionMode 合法`,
    String(s.permissionMode)
  );
  ok(Array.isArray(s.tools), `[${s.id}] tools 是数组`);
  if (s.recommendedAgentId) {
    ok(
      knownAgentIds.has(s.recommendedAgentId),
      `[${s.id}] recommendedAgentId 在注册表中存在`,
      `${s.recommendedAgentId} 不在 [${[...knownAgentIds].join(', ')}]`
    );
  }
}

// 3. 场景语义：开发/代码需工作目录；问答/写作只读无工具
const dev = getScenario('dev');
const code = getScenario('code');
const qa = getScenario('qa');
const write = getScenario('write');
ok(dev?.needsCwd === true, '开发场景需要工作目录');
ok(code?.needsCwd === true, '代码场景需要工作目录');
eq(qa?.permissionMode, 'plan', '问答场景为只读(plan)');
eq(write?.permissionMode, 'plan', '写作场景为只读(plan)');
eq(qa?.tools, [], '问答场景无工具');
eq(write?.tools, [], '写作场景无工具');
ok((dev?.tools?.length ?? 0) > 0, '开发场景声明了工具');

// 4. getScenario 行为
eq(getScenario('image')?.label, '生图', 'getScenario 命中');
eq(getScenario(undefined), undefined, 'getScenario(undefined) 返回 undefined');
eq(getScenario('__nope__'), undefined, 'getScenario(未知 id) 返回 undefined');

if (failures.length > 0) {
  console.error(
    `\n✗ 场景模板断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`
  );
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n场景模板断言：${checks.total}/${checks.total} 通过`);
console.log('✓ 6 个场景的字段完整性、权限模式与推荐 Agent 均符合预期');
