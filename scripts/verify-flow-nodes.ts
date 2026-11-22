/**
 * 过程流容器模型（子代理 / 群聊 Agent / 老数据回退）的离线验证（2026-11-22）。
 *
 * 覆盖面：
 *   [1] parentToolId 把子步骤归到 task 容器下，其余平铺；
 *   [2] 容器状态由孩子推导（error > running > interrupted > done）；
 *   [3] 并行判断：两个容器时间窗重叠 → 并行；不重叠 → 不并行；
 *   [4] 无 parentToolId 的老数据 → 全部平铺，无容器；
 *   [5] 空容器（task 无孩子）→ 平铺，不占一层；
 *   [6] 失败计数只算叶子：容器失败不把顶层打成失败、不计入重试次数。
 *
 * 全部纯函数断言：不 import server/**，不碰数据库。
 * 运行：npx tsx scripts/verify-flow-nodes.ts
 */
import {
  buildTrace,
  deriveFlowNodes,
  hasParallelContainers,
  summarizeTrace,
  type TraceItem,
} from '../shared/trace';
import { mergeAdjacentDuplicateTextBlocks, type Block, type ToolBlock } from '../shared/blocks';
import { autoMinimizeMode, clampPanelPos, snapMinimizedDrop, snapPanelMode } from '../src/trace/panelGeometry';

const failures: string[] = [];
const checks = { total: 0 };
function ok(cond: boolean, label: string, detail?: string) {
  checks.total += 1;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}
function eq<T>(a: T, b: T, label: string) {
  checks.total += 1;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) failures.push(`${label}\n      实际: ${ja}\n      期望: ${jb}`);
}

let seq = 0;
function tool(
  name: string,
  opts: {
    id?: string;
    parentToolId?: string;
    status?: ToolBlock['status'];
    st?: number;
    en?: number;
    target?: string;
  } = {}
): ToolBlock {
  seq += 1;
  const toolId = opts.id ?? `tid${seq}`;
  return {
    id: `t${seq}`,
    type: 'tool',
    toolId,
    name,
    input: opts.target !== undefined ? { description: opts.target } : undefined,
    status: opts.status ?? 'completed',
    startedAt: opts.st ?? 0,
    endedAt: opts.en,
    parentToolId: opts.parentToolId,
  };
}
const T0 = 1_700_000_000_000;

// ── [1] 子步骤归容器 ─────────────────────────────────────────────
{
  const items: TraceItem[] = buildTrace([
    tool('read', { st: T0, en: T0 + 100 }),
    tool('task', { id: 'T1', st: T0 + 200, en: T0 + 900, target: '改主题模块' }),
    tool('read', { parentToolId: 'T1', st: T0 + 250, en: T0 + 300, target: 'theme.ts' }),
    tool('edit', { parentToolId: 'T1', st: T0 + 400, en: T0 + 500 }),
    tool('bash', { st: T0 + 900, en: T0 + 1000, target: 'npm test' }),
  ]);
  const { nodes, leaves } = deriveFlowNodes(items);
  eq(nodes.length, 1, '容器：1 个 task 容器');
  eq(nodes[0]!.name, '改主题模块', '容器名 = 任务描述', nodes[0]?.name);
  eq(nodes[0]!.children.length, 2, '容器：2 个子步骤');
  eq(leaves.length, 2, '其余平铺（read + bash）');
}

// ── [2] 容器状态由孩子推导 ───────────────────────────────────────
{
  const items: TraceItem[] = buildTrace([
    tool('task', { id: 'T2', st: T0, en: T0 + 500 }),
    tool('bash', { parentToolId: 'T2', status: 'failed', st: T0 + 100, en: T0 + 300 }),
  ]);
  const { nodes } = deriveFlowNodes(items);
  eq(nodes[0]!.status, 'error', '容器状态：孩子失败 → error');

  const running: TraceItem[] = buildTrace([
    tool('task', { id: 'T3', st: T0 }),
    tool('read', { parentToolId: 'T3', status: 'running', st: T0 + 100 }),
  ]);
  eq(deriveFlowNodes(running).nodes[0]!.status, 'running', '容器状态：孩子运行中 → running');
  ok(deriveFlowNodes(running).nodes[0]!.running === true, '容器 running 标记');
}

// ── [3] 并行判断 ─────────────────────────────────────────────────
{
  const a: TraceItem[] = buildTrace([
    tool('task', { id: 'T4', st: T0, en: T0 + 1000 }),
    tool('read', { parentToolId: 'T4', st: T0 + 100, en: T0 + 200 }),
    tool('task', { id: 'T5', st: T0 + 300, en: T0 + 800 }),
    tool('edit', { parentToolId: 'T5', st: T0 + 350, en: T0 + 400 }),
  ]);
  const { nodes } = deriveFlowNodes(a);
  ok(hasParallelContainers(nodes), '并行：两个容器时间窗重叠');

  const b: TraceItem[] = buildTrace([
    tool('task', { id: 'T6', st: T0, en: T0 + 500 }),
    tool('read', { parentToolId: 'T6', st: T0 + 100, en: T0 + 150 }),
    tool('task', { id: 'T7', st: T0 + 600, en: T0 + 800 }),
    tool('edit', { parentToolId: 'T7', st: T0 + 650, en: T0 + 700 }),
  ]);
  const { nodes: nb } = deriveFlowNodes(b);
  ok(!hasParallelContainers(nb), '不并行：容器时间窗不重叠（串行）');
}

// ── [4] 无 parentToolId 的老数据 ─────────────────────────────────
{
  const items: TraceItem[] = buildTrace([
    tool('read', { st: T0, en: T0 + 100 }),
    tool('bash', { st: T0 + 200, en: T0 + 300 }),
    tool('edit', { st: T0 + 400, en: T0 + 500 }),
  ]);
  const { nodes, leaves } = deriveFlowNodes(items);
  eq(nodes.length, 0, '老数据：无容器');
  eq(leaves.length, 3, '老数据：全部平铺');
}

// ── [5] 空容器（task 无孩子）→ 平铺 ──────────────────────────────
{
  const items: TraceItem[] = buildTrace([
    tool('task', { st: T0, en: T0 + 100 }),
  ]);
  const { nodes, leaves } = deriveFlowNodes(items);
  eq(nodes.length, 0, '空容器：不占一层');
  eq(leaves.length, 1, '空容器：作为普通工具平铺');
}

// ── [6] 失败计数：容器失败不重复计入顶层 retries ──────────────────
{
  const items: TraceItem[] = buildTrace([
    tool('task', { id: 'T8', status: 'failed', st: T0, en: T0 + 300 }),
    tool('read', { parentToolId: 'T8', st: T0 + 50, en: T0 + 100 }),
  ]);
  const { nodes, leaves } = deriveFlowNodes(items);
  const summary = summarizeTrace(leaves);
  eq(summary.outcome, 'ok', '失败计数：容器失败不把顶层打成失败（叶子全成功）');
  eq(summary.retries, 0, '失败计数：容器失败不计入重试次数');
  eq(nodes[0]!.status, 'done', '容器状态：孩子全成功 → done（容器自身失败不污染）');
}


// ── [7] 图标映射：未知工具名回退 terminal，不报错 ──────────────────
{
  const { flowIcon } = await import('../src/trace/icons.js');
  const { Terminal, FileText, FlaskConical, Bot, Brain } = await import('lucide-react');
  ok(flowIcon('tool', 'some-unknown-tool-xyz') === Terminal, '图标：未知工具名回退 terminal');
  ok(flowIcon('tool', 'read') === FileText, '图标：read → file-text');
  ok(flowIcon('tool', 'bash', 'npm test') === FlaskConical, '图标：验证命令 → flask');
  ok(flowIcon('tool', 'bash', 'ls -la') === Terminal, '图标：普通命令 → terminal');
  ok(flowIcon('tool', 'task') === Bot, '图标：task → bot');
  ok(flowIcon('thinking', 'thinking') === Brain, '图标：思考 → brain');
}

// ── [8] 相邻重复正文合并（界面最后一道兜底） ──────────────────────
{
  const text = (id: string, t: string): Block =>
    ({ id, type: 'text', text: t, state: 'done' }) as unknown as Block;
  const tool = (id: string): Block =>
    ({ id, type: 'tool', toolName: 'bash', state: 'done' }) as unknown as Block;

  eq(mergeAdjacentDuplicateTextBlocks([text('a', '同一段正文'), text('b', '同一段正文')]).length, 1,
    '相邻完全相同的正文块合并成一份');
  eq(mergeAdjacentDuplicateTextBlocks([text('a', 'A'), text('b', 'B')]).length, 2,
    '不同正文不合并');
  eq(mergeAdjacentDuplicateTextBlocks([text('a', '同一段正文'), tool('t'), text('b', '同一段正文')]).length, 3,
    '中间隔了工具块就不合并（不同阶段）');
  eq(mergeAdjacentDuplicateTextBlocks([text('a', '   '), text('b', '   ')]).length, 2,
    '空正文不参与合并');
}

// ── [9] 过程面板拖动几何：禁区钳制 / 边缘吸附 / 窄屏最小化 ──────────
{
  const bounds = { viewportWidth: 1440, viewportHeight: 900, topGuard: 84, bottomGuard: 96 };
  const size = { width: 260, height: 320 };
  const clamped = clampPanelPos({ x: -50, y: 0, ...size }, bounds);
  ok(clamped.x === 8 && clamped.y === 92, '拖动越界被钳制在标题栏禁区之外', JSON.stringify(clamped));
  const clampedBottom = clampPanelPos({ x: 9999, y: 9999, ...size }, bounds);
  ok(clampedBottom.x === 1172 && clampedBottom.y === 476, '拖到底部被钳制在输入浮层之上', JSON.stringify(clampedBottom));
  eq(snapPanelMode({ x: 1172, y: 400, ...size }, bounds), 'right', '松手贴近右缘 → 吸附右侧');
  eq(snapPanelMode({ x: 1135, y: 300, ...size }, bounds), 'right', '右缘 40px 内仍吸右');
  eq(snapPanelMode({ x: 1120, y: 300, ...size }, bounds), 'floating', '右缘超过 40px → 不再误吸右');
  eq(snapPanelMode({ x: 600, y: 124, ...size }, bounds), 'top', '上禁区 40px 内吸顶');
  eq(snapPanelMode({ x: 600, y: 130, ...size }, bounds), 'floating', '上禁区超过 40px → 保持浮动');
  eq(snapPanelMode({ x: 600, y: 300, ...size }, bounds), 'floating', '松手在中间 → 保持浮动');
  eq(autoMinimizeMode(900, 'right'), 'minimized', '窄屏未手动设置 → 自动最小化');
  eq(autoMinimizeMode(900, 'top'), 'top', '用户手动吸顶 → 窄屏不强制改');
  eq(autoMinimizeMode(1440, 'right'), 'right', '宽屏保持右侧停靠');

  // 最小化胶囊：贴右必须按胶囊自己的宽度，不能按展开后 260px 算
  const pill = { width: 100, height: 30 };
  eq(snapMinimizedDrop({ x: 1320, y: 300 }, bounds, pill), 'right', '胶囊真碰到右缘 → 切右吸附');
  eq(snapMinimizedDrop({ x: 600, y: 92 }, bounds, pill), 'top', '胶囊拖到上禁区 → 切吸顶');
  eq(snapMinimizedDrop({ x: 600, y: 300 }, bounds, pill), 'floating', '胶囊拖到中间 → 切浮动');
  eq(snapMinimizedDrop({ x: 1170, y: 300 }, bounds, pill), 'floating',
    '胶囊离右缘还远（旧口径会误吸右）→ 保持浮动');
}

console.log(`过程流容器模型断言：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 子代理容器、并行判断、老数据平铺、失败计数均符合预期');