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
import type { Block, TextBlock, ThinkingBlock, ToolBlock } from '../shared/blocks.js';
// 折叠口径（真实结束优先 / 下一条事件兜底 / 不假装完成）的纯函数层
import {
  hasUnreturnedResult,
  resolveTraceItems,
  shouldAutoFoldOnTurnEnd,
  shouldFoldProcess,
} from '../src/trace/fold.js';
// 轨迹行（含旁白）与「整轮合并成一条」的判定
import { buildTraceRows, canGroupProcess, isNarration, stepRows } from '../src/trace/rows.js';

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

const text = (content: string): TextBlock => ({
  id: `txt-${Math.random().toString(36).slice(2, 7)}`,
  type: 'text',
  text: content,
  state: 'done',
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
  /* F1 改口径：
     原期望：`编辑、已读取、检查：SettingsPage.tsx`
     新期望：`改了 1 个文件 · 成功`
     依据：摘要改成结果语义 —— 这个夹具里 Edit 改了 1 个文件、其余步骤都完成，
           所以是「改了 1 个文件」+「成功」；读同一个文件不再另算「读完」。 */
  ok(s.text === '改了 1 个文件 · 成功', '摘要 = 改了 N 个文件 · 成功', s.text);
  ok(s.diff.added === 109 && s.diff.removed === 16, '摘要里的 diff 是各步骤之和', `+${s.diff.added} -${s.diff.removed}`);

  const many = buildTrace(
    Array.from({ length: 5 }, (_, i) => tool('Read', { file_path: `/p/f${i}.ts` }))
  );
  const sm = summarizeTrace(many);
  /* 原期望：`等 5 个文件`（动作清单里的截断写法）
     新期望：`读完 5 个文件 · 成功`
     依据：没有写盘动作时，「读完 N 个文件」就是这轮的全部结论。 */
  ok(sm.text === '读完 5 个文件 · 成功', '没有写盘动作 → 读完 N 个文件', sm.text);

  // F1 的结论档：进行中 / 失败 / 结果未回传 —— 按最坏情况取，不谎称成功
  const running = summarizeTrace(
    buildTrace([tool('Read', { file_path: '/p/a.ts' }, { status: 'running', endedAt: undefined })])
  );
  ok(running.text.endsWith('进行中'), '仍有步骤在跑 → 进行中', running.text);
  const failed = summarizeTrace(
    buildTrace([tool('Read', { file_path: '/p/a.ts' }, { status: 'failed', endedAt: 1600 })])
  );
  ok(failed.text.endsWith('失败'), '有一步报错 → 失败', failed.text);
  const interrupted = summarizeTrace(
    buildTrace([tool('Read', { file_path: '/p/a.ts' }, { status: 'interrupted', endedAt: 1600 })])
  );
  ok(interrupted.text.endsWith('结果未回传'), '有一步没回传 → 结果未回传', interrupted.text);
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

// ============= [7] 折叠口径：真实结束优先，其次兜底，不假装完成 =============
console.log('\n[7] resolveTraceItems：完成判定与关键步骤');
{
  const runningRead = () =>
    tool('Read', { file_path: '/a.ts' }, { status: 'running', endedAt: undefined });

  // 1) 真实结束事件优先
  const real = resolveTraceItems(buildTrace([tool('Read', { file_path: '/a.ts' })]), {
    streaming: true,
    contentStarted: false,
  });
  ok(
    real[0].completion === 'real' && real[0].status === 'done',
    '有 endedAt → 直接采信真实结束事件',
    `${real[0].completion}/${real[0].status}`
  );

  // 2) 缺少结束事件，但同组下一条事件已经到了 → 兜底完成
  const inferred = resolveTraceItems(
    buildTrace([runningRead(), tool('Read', { file_path: '/b.ts' })]),
    { streaming: true, contentStarted: false }
  );
  ok(
    inferred[0].completion === 'next-event' && inferred[0].status === 'done',
    '缺结束事件 + 下一条工具事件 → 按上一步完成',
    `${inferred[0].completion}/${inferred[0].status}`
  );

  // 3) 缺少结束事件，后面也没有任何事件 → 保持 running
  const open = resolveTraceItems(buildTrace([runningRead()]), {
    streaming: true,
    contentStarted: false,
  });
  ok(
    open[0].completion === 'open' && open[0].status === 'running',
    '长耗时步骤没有后续事件 → 不得假装完成',
    `${open[0].completion}/${open[0].status}`
  );

  // 4) 正文 token 就是最后一步的「下一条事件」→ 兜底完成
  const body = resolveTraceItems(buildTrace([runningRead()]), {
    streaming: true,
    contentStarted: true,
  });
  ok(
    body[0].completion === 'next-event' && body[0].status === 'done',
    '正文已开始 → 缺失结束事件的最后一步按已完成兜底',
    `${body[0].completion}/${body[0].status}`
  );

  // 5) 本轮已结束仍无结束事件 → missing，不是完成
  const missing = resolveTraceItems(buildTrace([runningRead()]), {
    streaming: false,
    contentStarted: true,
  });
  ok(
    missing[0].completion === 'missing' && missing[0].status === 'interrupted',
    '本轮结束仍无结束事件 → 结果未回传（不画成完成）',
    `${missing[0].completion}/${missing[0].status}`
  );

  // 6) 老数据（startedAt=0）不二次加工
  const legacy = resolveTraceItems(
    buildTrace([{ ...runningRead(), startedAt: 0 }]),
    { streaming: false, contentStarted: true }
  );
  ok(
    legacy[0].completion === 'missing' && legacy[0].status === 'running',
    '老数据保持原状态，不伪造 interrupted',
    `${legacy[0].completion}/${legacy[0].status}`
  );

  // 7) 四类关键步骤：完成后仍保持展开
  const kinds = [
    ['Write', 'write'],
    ['Edit', 'write'],
    ['Delete', 'delete'],
    ['Permission', 'permission'],
  ] as const;
  for (const [name, reason] of kinds) {
    const r = resolveTraceItems(buildTrace([tool(name, { file_path: '/a.ts' })]), {
      streaming: false,
      contentStarted: true,
    });
    ok(
      r[0].critical && r[0].criticalReason === reason,
      `${name} → 关键步骤（${reason}）常驻展开`,
      String(r[0].criticalReason)
    );
  }
  const failed = resolveTraceItems(
    buildTrace([tool('Bash', { command: 'x' }, { status: 'failed', endedAt: 2000 })]),
    { streaming: false, contentStarted: true }
  );
  ok(
    failed[0].status === 'error' && failed[0].critical && failed[0].criticalReason === 'error',
    '失败 → error + 关键步骤常驻展开',
    `${failed[0].status}/${failed[0].criticalReason}`
  );
  const read = resolveTraceItems(buildTrace([tool('Read', { file_path: '/a.ts' })]), {
    streaming: false,
    contentStarted: true,
  });
  ok(!read[0].critical, '普通读取不是关键步骤，完成后照常折叠');
}

// ============= [8] 整轮收拢：旁白归入轨迹 / 收拢时机 / 手动意图 =============
console.log('\n[8] 整轮收拢：旁白、结束信号与手动意图');
{
  // 1) 思考 + 工具 + 旁白 + 工具 → 同一条行序列（不再按 text 断段）
  const whole = buildTraceRows(
    [
      think('先看目录'),
      tool('Read', { file_path: '/a.ts' }),
      text('Codex 的历史记录存在本机 ~/.codex 里。'),
      tool('Grep', { pattern: 'codex' }),
    ],
    { streaming: false, contentStarted: true }
  );
  const kinds = whole.map(r => r.kind).join(',');
  ok(
    whole.length === 4 && whole[0].kind === 'thinking' && whole[2].kind === 'text',
    '整轮过程（思考 + 工具 + 旁白）落在同一个行序列里',
    kinds
  );

  // 2) 旁白行不吞空白块
  const blank = buildTraceRows([tool('Read', { file_path: '/a.ts' }), text('   ')], {
    streaming: false,
    contentStarted: true,
  });
  ok(blank.length === 1, '空白 text 块不产生旁白行', `rows=${blank.length}`);

  // 3) 旁白隔开的思考不再跨段挂到更早的工具下面
  const split = buildTraceRows(
    [tool('Read', { file_path: '/a.ts' }), text('换个位置再看'), think('看第二处')],
    { streaming: false, contentStarted: true }
  );
  const splitThird = split[2];
  ok(
    split.length === 3 &&
      !!splitThird &&
      splitThird.kind === 'thinking' &&
      splitThird.nested.length === 0,
    '旁白之后的思考不再挂到更早的工具下面',
    splitThird?.kind
  );

  // 4) 段内紧邻的思考仍按原规则挂靠
  const attached = buildTraceRows(
    [tool('Read', { file_path: '/a.ts' }), think('为什么读这个')],
    { streaming: false, contentStarted: true }
  );
  const attachedFirst = attached[0];
  ok(
    attached.length === 1 &&
      !!attachedFirst &&
      attachedFirst.kind !== 'text' &&
      attachedFirst.nested.length === 1,
    '紧跟工具的思考仍在段内挂靠'
  );

  // 5) 过程区能否合并成一条
  ok(
    canGroupProcess([
      think('想'),
      text('旁白'),
      tool('Read', { file_path: '/a.ts' }),
      text('再查一下'),
      tool('Grep', { pattern: 'x' }),
    ]),
    '有工具且只有 tool/thinking/text → 整轮合并成一条'
  );
  ok(!canGroupProcess([think('想'), text('旁白')]), '没有工具 → 不硬套摘要条');
  const imageBlock: Block = { id: 'img-1', type: 'image', image: { url: 'x' } };
  ok(
    !canGroupProcess([tool('Read', { file_path: '/a.ts' }), imageBlock]),
    '夹着 image 块 → 退回逐段渲染，不吞其它块'
  );

  // 7) CLI 旁路块（system/init 等原生事件）不得挡住整轮归并。
  // 这是 Qoder / Qwen 真机形态：raw + 思考 + 多组工具 + 多段旁白。
  // 合并成立 → 渲染层只产出一条轨迹，本轮结束后收成一行摘要；
  // 展开后摘要条下能看到全部步骤与旁白。
  const rawBlock: Block = {
    id: 'raw-1',
    type: 'raw',
    count: 1,
    entries: [{ channel: 'cli:system/init', at: 0, payload: { type: 'system', subtype: 'init' } }],
    omitted: 0,
  };
  const qoderTurn: Block[] = [
    rawBlock,
    think('先确认商汤说了什么，再决定查哪张表。'),
    tool('Read', { file_path: '/db/schema.sql' }),
    text('schema 里没有 msg 表，改查 app-db。'),
    tool('Write', { file_path: '/query/chat-query.qs', content: lines(52) }),
    tool('Bash', { command: 'qoder run chat-query.qs' }),
    text('chat 表能查到，接着换 sense 表。'),
    tool('Read', { file_path: '/db/sense.sql' }),
    text('sense 表的字段名和 chat 不一样。'),
    tool('Write', { file_path: '/query/sense-query.qs', content: lines(28) }),
  ];
  ok(
    canGroupProcess(qoderTurn),
    'raw 旁路块不挡住整轮归并 → 渲染层只产出一条轨迹（一行摘要）'
  );
  const qoderRows = buildTraceRows(qoderTurn, { streaming: false, contentStarted: true });
  ok(
    qoderRows.length === 9,
    '思考 + 5 个工具 + 3 段旁白 → 9 行（raw 被跳过）',
    `${qoderRows.length}`
  );
  ok(
    qoderRows.filter(isNarration).length === 3,
    '三段旁白全部进入同一条轨迹的行序列'
  );
  ok(
    stepRows(qoderRows).filter(r => r.kind === 'tool').length === 5,
    '展开摘要条能看到全部 5 个工具步骤'
  );
  // 8) 收拢时机：首个正文字段，或本轮结束
  ok(
    shouldFoldProcess({ hasAnswer: true, streaming: true }),
    '正文出现 → 立即收拢'
  );
  ok(
    !shouldFoldProcess({ hasAnswer: false, streaming: true }),
    '运行中且没有正文 → 保持展开'
  );
  ok(
    shouldFoldProcess({ hasAnswer: false, streaming: false }),
    '本轮结束但没产出正文 → 也收成一条'
  );

  // 9) 摘要条的「结果未回传」
  const missing = resolveTraceItems(
    buildTrace([tool('Read', { file_path: '/a.ts' }, { status: 'running', endedAt: undefined })]),
    { streaming: false, contentStarted: true }
  );
  ok(hasUnreturnedResult(missing), '最后一步 missing → 摘要条标「结果未回传」');
  const interrupted = resolveTraceItems(
    buildTrace([tool('Bash', { command: 'x' }, { status: 'interrupted', endedAt: undefined })]),
    { streaming: true, contentStarted: false }
  );
  ok(hasUnreturnedResult(interrupted), '最后一步 interrupted → 摘要条标「结果未回传」');
  ok(
    !hasUnreturnedResult(
      resolveTraceItems(buildTrace([tool('Read', { file_path: '/a.ts' })]), {
        streaming: false,
        contentStarted: true,
      })
    ),
    '全部正常完成 → 摘要条不标「结果未回传」'
  );

  // 10) 轮次结束分支不得覆盖手动意图
  ok(
    shouldAutoFoldOnTurnEnd({ wasStreaming: true, streaming: false, manual: false }),
    '自动：流式结束且用户未干预 → 收拢'
  );
  ok(
    !shouldAutoFoldOnTurnEnd({ wasStreaming: true, streaming: false, manual: true }),
    '用户手动展开/收起后 → 本轮结束不再自动收'
  );
  ok(
    !shouldAutoFoldOnTurnEnd({ wasStreaming: true, streaming: true, manual: false }),
    '仍在流式 → 不触发结束分支'
  );
  ok(
    !shouldAutoFoldOnTurnEnd({ wasStreaming: false, streaming: false, manual: false }),
    '挂载即完成 → 交给初始状态，不重复收拢'
  );
}

// ============= 汇总 =============
console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
