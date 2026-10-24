/**
 * A96 行级 diff 的单元验证（纯函数，不启浏览器）。
 *
 * ## 这一层最容易出的错
 *
 * 不是「渲染难看」，而是**角标与内容对不上**：轨迹头上写 `+3`，展开却有 20 行
 * 绿色。因为角标走 `lineDiff()`、展开走 `buildDiffHunks()`，两份实现只要有一处
 * 口径漂移就会露馅，而这种错在界面上看着"挺正常"，只能靠断言钉住。
 *
 * 所以本脚本的第一优先级是**逐组比对两个函数的增删计数**，其余才是结构断言。
 *
 * 运行：npx tsx scripts/verify-a96-diff.ts
 */
import { buildDiffHunks, lineDiff, type DiffHunk } from '../shared/trace.js';

let total = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');

/** 数一数 hunk 里各 kind 的行数 —— 与角标同口径 */
function counts(hunks: DiffHunk[] | null) {
  const all = (hunks ?? []).flatMap(h => h.lines);
  return {
    add: all.filter(l => l.kind === 'add').length,
    del: all.filter(l => l.kind === 'del').length,
    ctx: all.filter(l => l.kind === 'context').length,
  };
}

console.log('\nA96 行级 diff');

// ── 1. 基本结构 ──────────────────────────────────────────────────────
{
  const h = buildDiffHunks('edit', {
    file_path: 'src/x.ts',
    old_string: 'a\nb\nc',
    new_string: 'a\nX\nc',
  });
  ok(h != null && h.length === 1, 'edit 产出 1 个 hunk');
  const c = counts(h);
  ok(c.add === 1 && c.del === 1, '替换中间一行 → +1 -1', `+${c.add} -${c.del}`);
  ok(c.ctx === 2, '前后相同的行作为上下文保留', `${c.ctx} 行`);
  ok(h?.[0].mode === 'replace', 'edit 的 mode 是 replace（新旧都在）');
}

// ── 2. 口径一致（核心断言）────────────────────────────────────────────
{
  const cases: Array<[string, string, string]> = [
    ['单行替换', 'a\nb\nc', 'a\nX\nc'],
    ['纯新增', '', 'a\nb'],
    ['纯删除', 'a\nb', ''],
    ['无变化', 'a', 'a'],
    ['尾部追加', lines(10), `${lines(10)}\nnew1\nnew2`],
    ['中间改动', `h1\nh2\n${lines(20)}\nh3`, `h1\nh2\n${lines(20).replace('line5', 'LINE5')}\nh3`],
    ['整段替换', lines(8), lines(4, 'other')],
  ];
  let mismatch = 0;
  for (const [label, o, n] of cases) {
    const expect = lineDiff(o, n);
    const c = counts(buildDiffHunks('edit', { old_string: o, new_string: n }));
    if (c.add !== expect.added || c.del !== expect.removed) {
      mismatch++;
      console.log(
        `    不一致 [${label}] 期望 +${expect.added} -${expect.removed}，实际 +${c.add} -${c.del}`
      );
    }
  }
  ok(mismatch === 0, `与 lineDiff 口径完全一致（${cases.length} 组）`, `${mismatch} 组不一致`);
}

// ── 3. 多段编辑 ──────────────────────────────────────────────────────
{
  const h = buildDiffHunks('multiedit', {
    edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'b', new_string: 'B' },
    ],
  });
  ok(h != null && h.length === 2, 'multiedit 每条 edits 一个 hunk', `${h?.length ?? 0} 个`);
  const c = counts(h);
  ok(c.add === 2 && c.del === 2, 'multiedit 计数累加', `+${c.add} -${c.del}`);
}

// ── 4. write 类：只能给新增，不能假装知道删了什么 ────────────────────
{
  const h = buildDiffHunks('write', { file_path: 'new.ts', content: 'x\ny\nz' });
  ok(h?.[0].mode === 'create', 'write 的 mode 是 create（旧内容不可知）');
  const c = counts(h);
  ok(c.add === 3 && c.del === 0, 'write 全部算新增', `+${c.add} -${c.del}`);
  ok(h?.[0].oldStart === 0, 'create 模式 oldStart=0（没有旧文件行号）');
}

// ── 5. 没有 diff 概念的工具必须返回 null ─────────────────────────────
{
  ok(buildDiffHunks('read', { file_path: 'a.ts' }) === null, 'read 返回 null（退回原明细）');
  ok(buildDiffHunks('delete', { file_path: 'a.ts' }) === null, 'delete 返回 null');
  ok(buildDiffHunks('bash', { command: 'ls' }) === null, 'bash 返回 null');
  ok(buildDiffHunks('some_unknown_tool', { foo: 1 }) === null, '未知工具返回 null');
  ok(buildDiffHunks('edit', undefined) === null, '无入参返回 null');
  ok(buildDiffHunks('edit', {}) === null, '空入参返回 null');
}

// ── 6. 入参键名变体（不同 CLI 的命名不一致）──────────────────────────
{
  const a = buildDiffHunks('Edit', { old_str: 'a', new_str: 'b' });
  ok(a != null && counts(a).add === 1, '识别 old_str / new_str 变体');
  const b = buildDiffHunks('EditFile', { oldText: 'a', newText: 'b' });
  ok(b != null && counts(b).add === 1, '识别 oldText / newText 变体');
  const c = buildDiffHunks('str_replace_editor', { old_string: 'a', new_string: 'b' });
  ok(c != null && counts(c).add === 1, '识别 str_replace_editor');
  const d = buildDiffHunks('WRITE', { file_text: 'q' });
  ok(d != null && counts(d).add === 1, '工具名大小写不敏感 + file_text 变体');
}

// ── 7. 上下文上限 ────────────────────────────────────────────────────
{
  const h = buildDiffHunks('edit', {
    old_string: lines(30),
    new_string: lines(30).replace('line15', 'CHANGED'),
  });
  const c = counts(h);
  ok(c.ctx === 6, '上下文最多前后各 3 行', `${c.ctx} 行`);
  ok(c.add === 1 && c.del === 1, '改动行数仍准确', `+${c.add} -${c.del}`);
}

// ── 8. 超长截断 ──────────────────────────────────────────────────────
{
  const h = buildDiffHunks('write', { content: lines(400) });
  const shown = h?.[0].lines.length ?? 0;
  ok(shown === 240, '单块最多渲染 240 行', `${shown} 行`);
  ok((h?.[0].hidden ?? 0) === 160, '截断数量如实上报', `hidden=${h?.[0].hidden}`);
}

// ── 9. 行号正确性 ────────────────────────────────────────────────────
{
  const h = buildDiffHunks('edit', {
    old_string: 'a\nb\nc',
    new_string: 'a\nX\nc',
  });
  const ls = h?.[0].lines ?? [];
  const del = ls.find(l => l.kind === 'del');
  const add = ls.find(l => l.kind === 'add');
  ok(del?.oldLine === 2 && del?.newLine === undefined, '删除行只有旧行号', `oldLine=${del?.oldLine}`);
  ok(add?.newLine === 2 && add?.oldLine === undefined, '新增行只有新行号', `newLine=${add?.newLine}`);
  const ctx = ls.filter(l => l.kind === 'context');
  ok(
    ctx.every(l => l.oldLine != null && l.newLine != null),
    '上下文行同时有新旧行号'
  );
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
