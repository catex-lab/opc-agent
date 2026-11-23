/**
 * 过程流阶段条 + 重试口径的离线验证（2026-11-21）。
 *
 * 覆盖面（对应「阶段条 + 实时状态胶囊 + 重试口径」改造）：
 *   [1] classifyFlowPhase 的分类边界——read/search → understand、
 *       edit/write → change、shell 命中验证词表 → verify、普通 shell → understand；
 *   [2] 连续同类合并（步数、增删累计、起止时间）；
 *   [3] fix 归属——verify 失败之后的修改归 fix，验证通过后复位回 change；
 *   [4] verify 运行中不下结论（后续修改仍算 change，段保持「进行中」）；
 *   [5] summarizeTrace 重试口径——失败后验证通过 → 成功 + 重试 N 次；
 *       真失败 / 收复后再中断 / 运行中 / 从未失败各档口径；
 *   [6] 运行中 / 已结束 / 中断三种状态下的段收口（fold 判定 × groupPhases）；
 *   [7] 老数据（无时间戳）退化为可渲染的段（UI 等宽兜底的数据前提）。
 *
 * 全部纯函数断言：不 import server/**，不碰数据库，不需要构建产物。
 * 运行：npx tsx scripts/verify-trace-phases.ts
 */

import {
  buildTrace,
  classifyFlowPhase,
  groupPhases,
  summarizeTrace,
  type FlowPhase,
} from '../shared/trace';
import type { Block, ToolBlock } from '../shared/blocks';
import { resolveTraceItems } from '../src/trace/fold';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total += 1;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq<T>(actual: T, expected: T, label: string) {
  checks.total += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

let seq = 0;

/** 造一个工具块。时间戳给真实 epoch（流式/历史语义都依赖它们） */
function tool(
  name: string,
  opts: {
    cmd?: string;
    status?: ToolBlock['status'];
    st?: number;
    en?: number;
    old?: string;
    new?: string;
    content?: string;
  } = {}
): ToolBlock {
  seq += 1;
  const input: Record<string, unknown> = {};
  if (opts.cmd !== undefined) input.command = opts.cmd;
  if (opts.old !== undefined) input.old_string = opts.old;
  if (opts.new !== undefined) input.new_string = opts.new;
  if (opts.content !== undefined) input.content = opts.content;
  return {
    id: `t${seq}`,
    type: 'tool',
    toolId: `tid${seq}`,
    name,
    input: Object.keys(input).length > 0 ? input : undefined,
    status: opts.status ?? 'completed',
    startedAt: opts.st ?? 0,
    endedAt: opts.en,
  };
}

/** 便捷入口：块序列 → 轨迹行 → 阶段段 */
function phasesOf(blocks: Block[]): FlowPhase[] {
  return groupPhases(buildTrace(blocks));
}

const T0 = 1_700_000_000_000;

// ── [1] 分类边界 ─────────────────────────────────────────────────
{
  const items = buildTrace([
    tool('read', { st: T0, en: T0 + 100 }),
    tool('grep', { cmd: 'useTheme', st: T0 + 200, en: T0 + 300 }),
    tool('edit', { old: 'a\nb', new: 'a\nc', st: T0 + 400, en: T0 + 500 }),
    tool('write', { content: 'x\ny', st: T0 + 600, en: T0 + 700 }),
    tool('bash', { cmd: 'npm test', st: T0 + 800, en: T0 + 900 }),
    tool('bash', { cmd: 'git status', st: T0 + 1000, en: T0 + 1100 }),
    tool('bash', { cmd: 'ls -la', st: T0 + 1200, en: T0 + 1300 }),
    tool('multiedit', { st: T0 + 1400, en: T0 + 1500, old: 'a', new: 'b' }),
  ]);
  const kinds = items.map(classifyFlowPhase);
  eq(kinds, ['understand', 'understand', 'change', 'change', 'verify', 'understand', 'understand', 'change'], '分类：读搜=理解、改写=修改、验证命令=验证、普通 shell=理解');
  ok(classifyFlowPhase({ kind: 'thinking', id: 'x', toolName: 'thinking', verb: '', target: '', status: 'done', nested: [] }) === null, '分类：思考块不参与阶段');
}

// ── [2] 连续同类合并 ─────────────────────────────────────────────
{
  const phases = phasesOf([
    tool('read', { st: T0, en: T0 + 100 }),
    tool('grep', { cmd: 'x', st: T0 + 150, en: T0 + 250 }),
    tool('read', { st: T0 + 300, en: T0 + 400 }),
    tool('edit', { old: '1\n2\n3', new: '1\n9\n3', st: T0 + 500, en: T0 + 600 }),
    tool('edit', { old: 'a', new: 'a\nb', st: T0 + 700, en: T0 + 800 }),
  ]);
  eq(phases.map(p => p.kind), ['understand', 'change'], '合并：连续同类并成一段');
  eq(phases.map(p => p.steps), [3, 2], '合并：段内步数累计');
  eq(phases[0]!.startMs, T0, '合并：段起点 = 最早 startedAt');
  eq(phases[0]!.endMs, T0 + 400, '合并：段终点 = 最晚 endedAt');
  eq(phases[1]!.added, 2, '合并：增行累计（1 + 1，head/tail 裁剪后的真实变化区）');
  eq(phases[1]!.removed, 1, '合并：删行累计（1 + 0）');
}

// ── [3] fix 归属：验证失败之后的修改 → 验证通过后复位 ─────────────
{
  const phases = phasesOf([
    tool('edit', { old: 'a', new: 'b', st: T0, en: T0 + 100 }),
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0 + 200, en: T0 + 300 }),
    tool('edit', { old: 'c', new: 'd', st: T0 + 400, en: T0 + 500 }),
    tool('bash', { cmd: 'npm test', st: T0 + 600, en: T0 + 700 }),
    tool('edit', { old: 'e', new: 'f', st: T0 + 800, en: T0 + 900 }),
  ]);
  eq(phases.map(p => p.kind), ['change', 'verify', 'fix', 'verify', 'change'], 'fix 归属：失败后的修改=修复，验证通过后回到修改');
  eq(phases[1]!.failed, true, 'fix 归属：失败的验证段要标红');
  eq(phases[3]!.failed, false, 'fix 归属：通过的验证段不标红');
  // 思考插在两个同段工具之间不打断合并（buildTrace 会把思考挂到前一个工具下，
  // 但 groupPhases 直接跳过思考，只看工具流的连续性）
}

// ── [4] verify 运行中不下结论 ────────────────────────────────────
{
  const phases = phasesOf([
    tool('edit', { old: 'a', new: 'b', st: T0, en: T0 + 100 }),
    tool('bash', { cmd: 'npm test', status: 'running', st: T0 + 200 }),
    tool('edit', { old: 'c', new: 'd', st: T0 + 300, en: T0 + 400 }),
  ]);
  eq(phases.map(p => p.kind), ['change', 'verify', 'change'], '运行中验证：不下结论，后续修改仍是 change（不是 fix）');
  eq(phases[1]!.endMs, undefined, '运行中验证：段保持「进行中」（endMs 缺省）');
  const summary = summarizeTrace(buildTrace([
    tool('bash', { cmd: 'npm test', status: 'running', st: T0 }),
  ]));
  eq(summary.outcome, 'running', '运行中验证：整轮口径仍是进行中');
}

// ── [5] summarizeTrace 重试口径 ──────────────────────────────────
{
  // 失败 → 修复 → 验证通过：记成功 + 重试 1 次
  const retried = summarizeTrace(buildTrace([
    tool('edit', { old: 'a', new: 'b', st: T0, en: T0 + 100 }),
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0 + 200, en: T0 + 300 }),
    tool('edit', { old: 'c', new: 'd', st: T0 + 400, en: T0 + 500 }),
    tool('bash', { cmd: 'npm test', st: T0 + 600, en: T0 + 700 }),
  ]));
  eq(retried.outcome, 'ok', '重试口径：失败后验证通过 → 成功（不再报失败）');
  eq(retried.retries, 1, '重试口径：重试次数 = 1');
  ok(retried.text.includes('重试 1 次'), '重试口径：文案注明重试次数', retried.text);

  // 两次失败都被收复 → 重试 2 次
  const twice = summarizeTrace(buildTrace([
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0, en: T0 + 100 }),
    tool('edit', { old: 'a', new: 'b', st: T0 + 200, en: T0 + 300 }),
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0 + 400, en: T0 + 500 }),
    tool('edit', { old: 'c', new: 'd', st: T0 + 600, en: T0 + 700 }),
    tool('bash', { cmd: 'npm test', st: T0 + 800, en: T0 + 900 }),
  ]));
  eq(twice.retries, 2, '重试口径：两次失败都被收复 → 重试 2 次');
  eq(twice.outcome, 'ok', '重试口径：多次失败最终通过 → 成功');

  // 真失败：最后一次失败之后没有通过的验证
  const failed = summarizeTrace(buildTrace([
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0, en: T0 + 100 }),
  ]));
  eq(failed.outcome, 'error', '重试口径：没有通过验证 → 失败（维持原口径）');

  // 失败在验证通过之后又出现：不算收复
  const relapsed = summarizeTrace(buildTrace([
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0, en: T0 + 100 }),
    tool('bash', { cmd: 'npm test', st: T0 + 200, en: T0 + 300 }),
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0 + 400, en: T0 + 500 }),
  ]));
  eq(relapsed.outcome, 'error', '重试口径：通过之后又失败 → 回到失败');

  // 收复之后又有没回传结果的步骤：落回「结果未回传」，不谎称成功
  const unreturned = summarizeTrace(buildTrace([
    tool('bash', { cmd: 'npm test', status: 'failed', st: T0, en: T0 + 100 }),
    tool('bash', { cmd: 'npm test', st: T0 + 200, en: T0 + 300 }),
    tool('bash', { cmd: 'long-task', status: 'interrupted', st: T0 + 400, en: T0 + 500 }),
  ]));
  eq(unreturned.outcome, 'interrupted', '重试口径：收复后仍有未回传步骤 → 结果未回传');

  // 从未失败：retries = 0，文案不带「重试」
  const clean = summarizeTrace(buildTrace([
    tool('bash', { cmd: 'npm test', st: T0, en: T0 + 100 }),
  ]));
  eq(clean.retries, 0, '重试口径：从未失败 → retries = 0');
  ok(!clean.text.includes('重试'), '重试口径：无失败时文案不提重试', clean.text);
}

// ── [6] 三种状态的段收口（fold 判定 × groupPhases） ───────────────
{
  // 运行中：verify 没有结束事件、也没有后续事件 → fold 判 open（保持 running）
  const runningItems = resolveTraceItems(
    buildTrace([
      tool('edit', { old: 'a', new: 'b', st: T0, en: T0 + 100 }),
      tool('bash', { cmd: 'npm test', status: 'running', st: T0 + 200 }),
    ]),
    { streaming: true, contentStarted: false }
  );
  eq(runningItems[1]!.status, 'running', '运行中：无后续事件的 verify 保持 running');
  const runningPhases = groupPhases(runningItems);
  eq(runningPhases[1]!.endMs, undefined, '运行中：段保持「进行中」，UI 会把它延伸到当前时刻');

  // 已结束：verify 真实收尾 → 段闭合，整轮口径成功
  const doneItems = resolveTraceItems(
    buildTrace([
      tool('edit', { old: 'a', new: 'b', st: T0, en: T0 + 100 }),
      tool('bash', { cmd: 'npm test', st: T0 + 200, en: T0 + 300 }),
    ]),
    { streaming: false, contentStarted: true }
  );
  eq(doneItems[1]!.status, 'done', '已结束：verify 有真实结束事件');
  const donePhases = groupPhases(doneItems);
  ok(donePhases[1]!.endMs !== undefined, '已结束：段有收口时间');
  eq(summarizeTrace(doneItems).outcome, 'ok', '已结束：整轮口径成功');

  // 中断（用户中止，块被收口成 interrupted + endedAt）：段闭合但整轮是「未回传」
  const abortedItems = resolveTraceItems(
    buildTrace([
      tool('edit', { old: 'a', new: 'b', st: T0, en: T0 + 100 }),
      tool('bash', { cmd: 'npm test', status: 'interrupted', st: T0 + 200, en: T0 + 250 }),
    ]),
    { streaming: false, contentStarted: false }
  );
  eq(abortedItems[1]!.status, 'interrupted', '中断：verify 结果未回传');
  const abortedPhases = groupPhases(abortedItems);
  ok(abortedPhases[1]!.endMs !== undefined, '中断：段按 endedAt 收口（不悬空）');
  eq(abortedPhases[1]!.failed, false, '中断：没回结果不算失败（段不染红）');
  eq(summarizeTrace(abortedItems).outcome, 'interrupted', '中断：整轮口径 = 结果未回传（不是成功也不是失败）');
}

// ── [7] 老数据（无时间戳）：段仍可渲染，时间是缺省 ────────────────
{
  const phases = phasesOf([
    tool('read'),
    tool('edit', { old: 'a', new: 'b' }),
    tool('bash', { cmd: 'npm test' }),
  ]);
  eq(phases.map(p => p.kind), ['understand', 'change', 'verify'], '老数据：分类照常');
  ok(phases.every(p => p.startMs === undefined && p.endMs === undefined), '老数据：无时间戳 → 起止缺省（UI 按步数等宽）');
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`阶段条断言：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 分类、合并、fix 归属、重试口径、老数据兜底均符合预期');
