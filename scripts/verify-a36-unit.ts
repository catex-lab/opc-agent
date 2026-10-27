/**
 * A36 轨迹数据层的单元验证（不启浏览器）。
 *
 * 这一层是纯函数：把 `ToolBlock.input` 翻译成「动词 + 目标 + diff」。
 * 它最容易出的错是**数字**（增删行数算错、把「不知道」当成 0），
 * 而那种错在界面上完全看不出来 —— 只能靠断言钉住。
 *
 * 运行：tsx scripts/verify-a36-unit.ts
 */
// A39：trace 的纯函数层从 `src/trace.ts` 移到了 `shared/trace.ts`
// （前后端共用同一份实现）。这个脚本仍按旧路径 import，跑的时候
// 直接 ERR_MODULE_NOT_FOUND。
import {
  buildTrace,
  baseName,
  formatHandledDuration,
  formatStepDuration,
  lingeringToolBlocks,
  lineDiff,
  summarizeTrace,
  toolItem,
  toolPathOf,
} from '../shared/trace.js';
import type { Block, ThinkingBlock, ToolBlock } from '../shared/blocks.js';

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

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');

const tool = (name: string, input: Record<string, unknown>, extra: Partial<ToolBlock> = {}): ToolBlock => ({
  id: `b-${name}-${Math.random().toString(36).slice(2, 7)}`,
  type: 'tool',
  toolId: `t-${name}`,
  name,
  input,
  status: 'completed',
  startedAt: 1000,
  endedAt: 1600,
  ...extra,
});

const think = (text: string, extra: Partial<ThinkingBlock> = {}): ThinkingBlock => ({
  id: `th-${Math.random().toString(36).slice(2, 7)}`,
  type: 'thinking',
  text,
  state: 'done',
  format: 'raw',
  startedAt: 1000,
  endedAt: 4000,
  ...extra,
});

// ============= [1] 行级 diff =============
console.log('\n[1] lineDiff：增删行数');
{
  const d1 = lineDiff('a\nb\nc', 'a\nB\nc');
  ok(d1.added === 1 && d1.removed === 1, '中间一行改动 → +1 -1', `+${d1.added} -${d1.removed}`);

  const d2 = lineDiff('', lines(2));
  ok(d2.added === 2 && d2.removed === 0, '空 → 2 行 → +2 -0', `+${d2.added} -${d2.removed}`);

  const d3 = lineDiff(lines(3), '');
  ok(d3.added === 0 && d3.removed === 3, '3 行 → 空 → +0 -3', `+${d3.added} -${d3.removed}`);

  const same = lineDiff(lines(5), lines(5));
  ok(same.added === 0 && same.removed === 0, '完全相同 → +0 -0', `+${same.added} -${same.removed}`);

  // 只在尾部追加：公共前缀应被吃掉，不能报成「整段重写」
  const append = lineDiff(lines(10), lines(10) + '\nnew');
  ok(append.added === 1 && append.removed === 0, '尾部追加一行 → +1 -0', `+${append.added} -${append.removed}`);
}

// ============= [2] 工具 → 动词 / 目标 / diff =============
console.log('\n[2] toolItem：动词、目标、diff 口径');
{
  const edit = toolItem(
    tool('Edit', {
      file_path: 'D:/work/demo/app/src/components/SettingsPage.tsx',
      old_string: lines(16, 'old'),
      new_string: lines(109, 'new'),
    })
  );
  ok(edit.verb === '编辑', 'Edit → 编辑', edit.verb);
  ok(edit.target === 'SettingsPage.tsx', '目标取文件名', edit.target);
  ok(!!edit.diff && edit.diff.known, 'Edit 有真实 diff');
  ok(edit.diff?.added === 109 && edit.diff?.removed === 16, 'diff = +109 -16', `+${edit.diff?.added} -${edit.diff?.removed}`);
  ok(edit.durationMs === 600, '耗时取 endedAt - startedAt', String(edit.durationMs));

  const write = toolItem(tool('Write', { file_path: '/tmp/new.ts', content: lines(30) }));
  ok(write.verb === '写入', 'Write → 写入', write.verb);
  ok(write.diff?.added === 30, 'Write 只报新增行数（旧内容未知）', `+${write.diff?.added}`);
  ok(write.diff?.known === false, 'Write 的 diff 标为「不完整」（不编造删除数）');

  const read = toolItem(tool('Read', { file_path: '/tmp/a.ts' }));
  ok(read.verb === '已读取', 'Read → 已读取', read.verb);
  ok(read.diff?.added === 0 && read.diff?.removed === 0 && read.diff?.known === false, 'Read → ±0（无 diff 数据）');

  const build = toolItem(tool('Bash', { command: 'npm run build', description: '构建' }));
  ok(build.verb === '检查', '跑构建的 Bash → 检查', build.verb);
  ok(build.target === '构建', '目标取 description', build.target);
  ok(build.diff === undefined, '非文件类工具不带 diff 位');

  const ls = toolItem(tool('Bash', { command: 'ls -la' }));
  ok(ls.verb === '执行', '普通命令 → 执行', ls.verb);

  const search = toolItem(tool('WebSearch', { query: 'tdesign chat markdown' }));
  ok(search.verb === '搜索', 'WebSearch → 搜索', search.verb);

  ok(toolPathOf({ file_path: '/a/b.ts' }) === '/a/b.ts', 'toolPathOf 认 file_path');
  ok(toolPathOf({ filePath: '/a/c.ts' }) === '/a/c.ts', 'toolPathOf 认 filePath');
  ok(toolPathOf({}) === undefined, 'toolPathOf 无路径时返回 undefined');
  ok(baseName('E:\\a\\b\\c.ts') === 'c.ts', 'baseName 认反斜杠路径', baseName('E:\\a\\b\\c.ts'));
}

// ============= [3] 块序列 → 轨迹（嵌套） =============
console.log('\n[3] buildTrace：思考节点挂到上一个步骤下面');
{
  const blocks: Block[] = [
    think('开头的思考'),
    tool('Edit', { file_path: '/a/x.ts', old_string: 'a', new_string: 'b' }),
    think('编辑后的思考'),
    tool('Read', { file_path: '/a/y.ts' }),
  ];
  const items = buildTrace(blocks);
  ok(items.length === 3, '4 个块压成 3 行（思考被吸收）', String(items.length));
  ok(items[0].kind === 'thinking', '开头的思考自己占一行');
  ok(items[1].kind === 'tool' && items[1].nested.length === 1, '紧跟工具的思考挂到它下面');
  ok(items[1].nested[0].kind === 'thinking', '嵌套节点是思考');
  ok(items[2].kind === 'tool' && items[2].nested.length === 0, '后面没有思考的工具不带嵌套');
}

// ============= [4] 活动摘要 =============
console.log('\n[4] summarizeTrace：一句话摘要');
{
  const items = buildTrace([
    tool('Edit', { file_path: '/p/src/SettingsPage.tsx', old_string: lines(16, 'o'), new_string: lines(109, 'n') }),
    tool('Read', { file_path: '/p/src/SettingsPage.tsx' }),
    tool('Bash', { command: 'npm test', description: '跑测试' }),
  ]);
  const s = summarizeTrace(items);
  ok(s.text === '编辑、已读取、检查：SettingsPage.tsx', '摘要 = 动词 + 冒号 + 文件名', s.text);
  ok(s.diff.added === 109 && s.diff.removed === 16, '摘要里的 diff 是各步骤之和', `+${s.diff.added} -${s.diff.removed}`);

  const many = buildTrace(
    Array.from({ length: 5 }, (_, i) => tool('Read', { file_path: `/p/f${i}.ts` }))
  );
  const sm = summarizeTrace(many);
  ok(sm.text.includes('等 5 个文件'), '文件多于 2 个时折成「等 N 个文件」', sm.text);
}

// ============= [5] 时长文案 =============
console.log('\n[5] 时长文案');
{
  ok(formatHandledDuration(4500) === '4.5s', '< 1 分钟保留一位小数', formatHandledDuration(4500) ?? 'null');
  ok(formatHandledDuration(2862000) === '47m42s', '47 分 42 秒', formatHandledDuration(2862000) ?? 'null');
  ok(formatHandledDuration(3723000) === '1h02m', '超过 1 小时进位', formatHandledDuration(3723000) ?? 'null');
  ok(formatHandledDuration(0) === null, '0 不编造时长');
  ok(formatHandledDuration(undefined) === null, '无数据不编造时长');
  ok(formatStepDuration(600) === '600ms', '单步 < 1s 用毫秒', formatStepDuration(600) ?? 'null');
  ok(formatStepDuration(1600) === '1.6s', '单步 >= 1s 用秒', formatStepDuration(1600) ?? 'null');
}

// ============= [6] 后台任务（遗留工具） =============
console.log('\n[6] lingeringToolBlocks：本轮结束仍在跑的工具');
{
  const running = tool('Bash', { command: 'npm run dev' }, { status: 'running', endedAt: undefined });
  const blocks: Block[] = [running, tool('Read', { file_path: '/a.ts' })];

  ok(lingeringToolBlocks(blocks, true).length === 1, '本轮已结束 → 数出 1 个遗留');
  ok(lingeringToolBlocks(blocks, false).length === 0, '本轮仍在流式 → 不算遗留（running 是正常状态）');

  // 老数据没有时间戳，status 停在 running 只说明「当年没记完成状态」
  const legacy: Block[] = [{ ...running, startedAt: 0 }];
  ok(lingeringToolBlocks(legacy, true).length === 0, '老数据（startedAt=0）不算遗留，避免永久胶囊');

  // A125：finish() 不再把没回结果的工具伪造成 completed，而是标 interrupted。
  // 胶囊必须跟着认这一档，否则「修好终态」的代价是「功能永远数不出东西」。
  const interrupted = tool('Bash', { command: 'npm run dev' }, { status: 'interrupted', endedAt: 8000 });
  ok(lingeringToolBlocks([interrupted], true).length === 1, 'interrupted（结果未回传）也算遗留');
  ok(
    lingeringToolBlocks([{ ...interrupted, startedAt: 0 }], true).length === 0,
    '老数据即使被标 interrupted 且无时间戳，也不算遗留'
  );
  ok(toolItem(interrupted).status === 'interrupted', 'toolItem：interrupted 不落进 done / error');
  ok(toolItem(tool('Bash', { command: 'x' })).status === 'done', '对照组：completed 仍是 done');
}

// ============= 汇总 =============
console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
