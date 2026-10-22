/**
 * 技能自动沉淀（A39）—— L3 技能记忆的最小实现，原料用我们独有的 Trace。
 *
 * ## 为什么要抄这一层
 *
 * 学习闭环是「任务成功 → 提炼可复用 Skill → 落 skills/ → 下次语义匹配」。
 * 判断「成功」如果只看任务完成度，信号太薄；我们能拿到的信号更多：A36 的执行轨迹里
 * 有每一步的动词、目标文件、真实 diff 增删、耗时 —— 提炼出来的技能是**带数字的**，
 * 而不是一段泛泛的「先分析再实现」。
 *
 * ## 三条落地口径
 *
 * 1. **不成功不沉淀**（硬性约束）：中止 / 报错 / 步骤太少，一律跳过。
 *    把一次失败的尝试写成技能，比没有技能更糟 —— 下次它会带着错误路径复活。
 * 2. **签名去重，不是标题去重**：同一个工作流换个文件名还是同一个技能，
 *    所以签名取「动词序列」而不是标题。命中已有技能就累加 `uses` 与
 *    `lastUsedAt`，不生成第二份重复文件。
 * 3. **文件是唯一事实来源**：meta 走 frontmatter，人可以直接打开 `.md` 编辑，
 *    编辑后的内容照样被 FTS5 索引（见 server/memory.ts 的 writeSkill）。
 *
 * ## 边界
 *
 * 只从**已完成**的 run 提炼。流式过程中不触发 —— 那会儿 diff 还没结算，
 * 会得到一份「只写了一半步骤」的技能。
 */

import path from 'node:path';
import type { Block } from '../shared/blocks.js';
import {
  buildTrace,
  formatHandledDuration,
  summarizeTrace,
  type TraceItem,
  type TraceSummary,
} from '../shared/trace.js';
import { listSkills, writeSkill } from './memory.js';

/** 步骤数下限：低于这个数，沉淀出来的东西是噪音而不是技能。 */
export const MIN_STEPS = 3;
/** 步骤数上限：超过就只列前 N 步，避免技能长到没人看。 */
export const MAX_STEPS_DOC = 25;

export interface DistillInput {
  /** 用户这一轮的原始输入（触发条件的来源）。 */
  prompt: string;
  blocks: readonly Block[];
  durationMs?: number | null;
  agentId: string;
  aborted: boolean;
  hadError: boolean;
}

export interface DistillDecision {
  ok: boolean;
  reason: string;
}

/**
 * 沉淀门槛。四条否决项按「最可能发生」排序：
 * 中止 → 步骤太少 → 报错 → 空轨迹。
 */
export function shouldDistill(input: DistillInput): DistillDecision {
  if (input.aborted) return { ok: false, reason: '任务被中止，不沉淀' };
  if (input.hadError) return { ok: false, reason: '任务报错，不沉淀' };
  const items = buildTrace(input.blocks).filter(i => i.kind === 'tool');
  if (items.length === 0) return { ok: false, reason: '没有任何工具调用，没有可复用的东西' };
  if (items.length < MIN_STEPS) return { ok: false, reason: `步骤不足 ${MIN_STEPS} 步，沉淀出来是噪音` };
  return { ok: true, reason: `${items.length} 步工具轨迹` };
}

/**
 * 技能签名：动词序列（连续重复折叠）。
 *
 * 只取动词不取文件名，是**故意的**：同一套「读→改→查」流程今天用在
 * SettingsPage.tsx、明天用在 ChatPage.tsx，是同一个技能。
 */
export function skillSignature(items: readonly TraceItem[]): string {
  const verbs: string[] = [];
  const walk = (list: readonly TraceItem[]) => {
    for (const it of list) {
      if (it.kind === 'tool') {
        if (verbs[verbs.length - 1] !== it.verb) verbs.push(it.verb);
      }
      if (it.nested.length) walk(it.nested);
    }
  };
  walk(items);
  return verbs.slice(0, 8).join('→');
}

/** 文件名安全化：只留字母数字与连字符，中文标题折成拼音做不到就退化成 skill-N。 */
export function slugify(text: string, fallbackIndex = 1): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // 标题是纯中文时 ascii 会是空串 —— 用一个稳定后缀兜底，
  // 而不是把整段中文塞进文件名（Windows 下一个中文名会带来一整套编码麻烦）。
  return ascii || `skill-${fallbackIndex}`;
}

export interface SkillDoc {
  name: string;
  body: string;
  signature: string;
}

/** 把一次 run 变成一份技能文档（不落盘，落盘由 distillSkill 负责）。 */
export function buildSkillDoc(input: DistillInput): SkillDoc | null {
  const gate = shouldDistill(input);
  if (!gate.ok) return null;

  const trace = buildTrace(input.blocks);
  const items = trace.filter(i => i.kind === 'tool');
  const summary: TraceSummary = summarizeTrace(trace);
  const signature = skillSignature(trace);

  const title = summary.files.length
    ? `${summary.verbs.slice(0, 3).join('、')} ${summary.files.slice(0, 2).join('、')}`
    : summary.verbs.slice(0, 3).join('、');
  // 触发条件取用户输入第一行（超过 60 字折掉）—— 那是「什么情况下该用它」的最原始材料
  const trigger = input.prompt.trim().split('\n')[0].slice(0, 60);

  const steps = items.slice(0, MAX_STEPS_DOC).map((it, i) => {
    const diff =
      it.diff && (it.diff.added || it.diff.removed)
        ? `（+${it.diff.added} -${it.diff.removed}）`
        : '';
    return `${i + 1}. ${it.verb} ${it.path ?? it.target ?? ''}`.trimEnd() + diff;
  });
  if (items.length > MAX_STEPS_DOC) {
    steps.push(`…（其余 ${items.length - MAX_STEPS_DOC} 步略）`);
  }

  const now = new Date().toISOString();
  const body = [
    '---',
    `name: ${slugify(title, items.length)}`,
    `signature: ${signature}`,
    'uses: 1',
    `createdAt: ${now}`,
    `lastUsedAt: ${now}`,
    `agent: ${input.agentId}`,
    `steps: ${items.length}`,
    `diff: +${summary.diff.added} -${summary.diff.removed}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## 描述',
    `${summary.text}。`,
    '',
    '## 触发条件',
    `- 用户说：${trigger || '（未记录）'}`,
    `- 动作签名：\`${signature}\``,
    '',
    '## 执行步骤',
    ...steps,
    '',
    '## 参数化',
    `- {{target}}: 主要目标（${summary.files.slice(0, 3).join(' / ') || '见步骤'}）`,
    '',
    '## 历史表现',
    `- 提炼次数：1`,
    `- 最近一次：${items.length} 步，变更 +${summary.diff.added} -${summary.diff.removed}`,
    input.durationMs ? `- 耗时：${formatHandledDuration(input.durationMs)}` : '- 耗时：（未记录）',
    `- 执行者：${input.agentId}`,
    '',
  ].join('\n');

  return { name: path.basename(slugify(title, items.length)), body, signature };
}

interface SkillMeta {
  signature: string;
  uses: number;
  lastUsedAt: string;
}

/** 解析 frontmatter 里我们关心的三个字段。解析失败时返回 null（当作没有 meta）。 */
export function parseSkillMeta(body: string): SkillMeta | null {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const get = (k: string) => {
    const line = m[1].split('\n').find(l => l.startsWith(`${k}:`));
    return line ? line.slice(k.length + 1).trim() : '';
  };
  const signature = get('signature');
  if (!signature) return null;
  return {
    signature,
    uses: Number(get('uses')) || 1,
    lastUsedAt: get('lastUsedAt') || '',
  };
}

export type DistillResult =
  | { status: 'skipped'; reason: string }
  | { status: 'created'; name: string; signature: string }
  | { status: 'reused'; name: string; uses: number };

/**
 * 沉淀入口：创建新技能，或把已有技能的 uses/lastUsedAt 往前推一格。
 *
 * 「reused」不改正文 —— 第一步的配方是当初成功的那一份，后来重复执行
 * 成功与否不改变步骤本身（要改也应该由人改，见设置页的技能编辑器）。
 */
export function distillSkill(input: DistillInput): DistillResult {
  const gate = shouldDistill(input);
  if (!gate.ok) return { status: 'skipped', reason: gate.reason };

  const doc = buildSkillDoc(input);
  if (!doc) return { status: 'skipped', reason: '无法生成技能文档' };

  const existing = listSkills();
  const same = existing.find(s => {
    const meta = parseSkillMeta(s.body);
    return meta && meta.signature === doc.signature;
  });

  if (same) {
    const meta = parseSkillMeta(same.body)!;
    const uses = meta.uses + 1;
    const renewed = same.body
      .replace(/^uses: .*$/m, `uses: ${uses}`)
      .replace(/^lastUsedAt: .*$/m, `lastUsedAt: ${new Date().toISOString()}`);
    const r = writeSkill(same.name, renewed);
    if ('error' in r) return { status: 'skipped', reason: r.error };
    return { status: 'reused', name: same.name, uses };
  }

  const r = writeSkill(doc.name, doc.body);
  if ('error' in r) {
    // 同名但签名不同（比如同一个文件上的两种流程）：加序号再试一次
    const alt = doc.name.replace(/-?\d*$/, '') + `-${existing.length + 1}`;
    const r2 = writeSkill(alt, doc.body);
    if ('error' in r2) return { status: 'skipped', reason: r2.error };
    return { status: 'created', name: alt, signature: doc.signature };
  }
  return { status: 'created', name: doc.name, signature: doc.signature };
}
