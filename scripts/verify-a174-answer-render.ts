/**
 * A174 闸门：回答内容分级渲染 + 外链两种打开方式。
 *
 * ## 这一层守的是什么
 *
 * 分级渲染里**真正会出事**的不是「卡片好不好看」，而是三件事：
 *
 *   ① **协议白名单**：答案正文来自模型输出，可以出现任意 URL。`javascript:`
 *      / `data:` 只要漏一个，就是一次脚本注入；主进程 `shell.openExternal`
 *      更是把非 http(s) 直接交给操作系统。所以白名单必须**可穷举地**测。
 *   ② **切分不误伤正文**：切分是行级的，一旦判定过宽，普通句子会被吞进
 *      卡片、或代码块被拆散 —— 用户的「原文」就被改写了。这里用「不足 3
 *      条仍是行内」「非命令围栏原样保留」「流式期间未闭合不转卡」三条钉住。
 *   ③ **接线**：图标 / 提示 / 两种打开方式都跨了进程与 shadow 边界，纯函数
 *      测不到，只能静态确认「线确实接上了」。
 *
 * 运行：npx tsx scripts/verify-a174-answer-render.ts
 * （DOM 渲染与浅/深截图在 `scripts/verify-a174.mjs`）
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_TABLE_ROWS,
  chartOf,
  countHttpLinks,
  parseCodeRefLine,
  parseLinkLine,
  parseNumericCell,
  planAnswer,
  sanitizeHttpUrl,
  splitTableRow,
} from '../src/answer/renderPlan.js';
import { normalizePrefs, validatePrefsPatch } from '../server/preferences.js';

let pass = 0;
let fail = 0;

function ok(cond: unknown, msg: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log('  ✓', msg);
  } else {
    fail += 1;
    console.log('  ✗', msg, detail === undefined ? '' : `[${String(detail)}]`);
  }
}

function section(title: string): void {
  console.log(`\n[${title}]`);
}

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ══════════════ ① 协议白名单 ══════════════ */

section('协议白名单：只有 http/https 能出网');

const ALLOW: Array<[string, string]> = [
  ['https://example.com/a?b=1#c', 'https 带查询与锚点'],
  ['http://example.com', 'http 明文'],
  ['  https://example.com/x  ', '首尾空白会被 trim'],
  ['HTTPS://EXAMPLE.COM/Path', '协议大小写不敏感 + 请求侧规范化'],
  ['https://example.com/a%20b', '百分号编码的空格保留'],
];

for (const [raw, label] of ALLOW) {
  ok(sanitizeHttpUrl(raw) !== null, `放行：${label}`, raw);
}

const DENY: Array<[string, string]> = [
  ['javascript:alert(1)', 'javascript: 伪协议'],
  ['JaVaScRiPt:alert(1)', '伪协议大小写绕过'],
  ['data:text/html,<script>alert(1)</script>', 'data: URI'],
  ['file:///C:/Windows/System32/cmd.exe', 'file: 本地文件'],
  ['mailto:a@b.com', 'mailto'],
  ['//example.com/x', '协议相对地址（无 scheme）'],
  ['example.com', '裸域名（不是链接）'],
  ['https://exa mple.com/a', '含空格，URL 与显示不符'],
  ['https://example.com/\n<script>', '含换行，防止属性注入'],
  ['', '空串'],
];

for (const [raw, label] of DENY) {
  ok(sanitizeHttpUrl(raw) === null, `拒绝：${label}`, raw);
}

{
  const hostile = sanitizeHttpUrl('https://example.com/<img>');
  ok(!!hostile && !hostile.includes('<') && !hostile.includes('>'), '尖括号被编码，不会拼进 HTML', hostile);
  // 带空格/换行的「链接」一律拒 —— 显示文本与实际目标会对不上
  ok(sanitizeHttpUrl('https://example.com/<img src=x onerror=alert(1)>') === null, '带空格的注入串直接拒');
  ok(sanitizeHttpUrl('x'.repeat(3000)) === null, '超长输入直接拒（长度上限 2048）');
}

/* ══════════════ ② 链接行解析 ══════════════ */

section('链接行：整行只认一个链接');

{
  ok(parseLinkLine('[标题](https://example.com)')?.host === 'example.com', 'markdown 链接');
  ok(parseLinkLine('- [标题](https://example.com/a)')?.label === '标题', '列表项前缀可识别');
  ok(parseLinkLine('1. <https://example.com>')?.host === 'example.com', '有序列表 + 尖括号');
  ok(parseLinkLine('https://example.com')?.label === 'https://example.com/', '裸 URL 用规范化后的 URL 当标题');
  ok(parseLinkLine('正文里带 https://example.com 的句子') === null, '句中出现链接不算整行链接');
  ok(parseLinkLine('[bad](javascript:alert(1))') === null, '伪协议链接行不认');
  ok(parseLinkLine('**粗体** 不是链接') === null, '普通文本不认');
}

/* ══════════════ ③ 代码改动行 ══════════════ */

section('代码改动卡：路径 + 区间 + 增删');

{
  const ref = parseCodeRefLine('`src/components/AnswerCards.tsx` L128–L176 +42 −7');
  ok(ref?.path === 'src/components/AnswerCards.tsx', '反引号路径解析');
  ok(ref?.from === 128 && ref?.to === 176, '区间解析');
  ok(ref?.added === 42 && ref?.removed === 7, '增删行数（含 U+2212 减号）');
  ok(parseCodeRefLine('src/a.ts L5-L9 +3 -1')?.to === 9, 'ASCII 连字符与减号也接受');
  ok(parseCodeRefLine('src/a.ts L9–L5 +3 −1') === null, '区间倒置拒收');
  ok(parseCodeRefLine('这一行只是提到了 src/a.ts') === null, '不是整行匹配就不转卡');
  ok(parseCodeRefLine('README') === null, '没有扩展名不算路径');
}

/* ══════════════ ④ planAnswer 切分 ══════════════ */

section('切分：不足 3 条仍是行内，≥3 条成卡');

{
  const two = [
    '参考这两篇：',
    '- [一](https://a.example.com)',
    '- [二](https://b.example.com)',
    '共两条。',
  ].join('\n');
  const segs = planAnswer(two);
  ok(!segs.some(s => s.kind === 'links'), '两条链接保持行内（不进卡网格）');
  ok(segs.every(s => s.kind === 'md'), '整段仍是一块 markdown');
  ok(countHttpLinks(segs) === 2, '行内链接计数正确');
}

{
  const three = ['- [一](https://a.example.com)', '- [二](https://b.example.com)', '- [三](https://c.example.com)'].join('\n');
  const segs = planAnswer(three);
  const links = segs.find(s => s.kind === 'links');
  ok(!!links && links.kind === 'links' && links.items.length === 3, '三条连续链接转成卡网格');
  ok(!segs.some(s => s.kind === 'md' && s.text.includes('https://a.example.com')), '转卡后链接不再留在正文里');
  ok(segs.filter(s => s.kind === 'links').length === 1, '只产生一个网格（不是三张卡）');
}

{
  const mixed = [
    '- [一](https://a.example.com)',
    '- [二](https://b.example.com)',
    '- [坏](javascript:alert(1))',
    '- [四](https://d.example.com)',
  ].join('\n');
  const segs = planAnswer(mixed);
  ok(!segs.some(s => s.kind === 'links'), '混入伪协议后整组不转卡（宁可退化成行内）');
  // 伪协议那一行仍留在 markdown 原文里（不能改用户原文），但**卡片里绝不会有**
  ok(
    segs.every(s => s.kind !== 'links' || s.items.every(it => sanitizeHttpUrl(it.url) !== null)),
    '没有任何卡片项指向伪协议',
  );
}

section('切分：流式期间只转「已经闭合」的块');

{
  const partial = ['- [一](https://a.example.com)', '- [二](https://b.example.com)', '- [三](https://c.example.com)'].join('\n');
  ok(!planAnswer(partial, { streaming: true }).some(s => s.kind === 'links'), '链接组在流式末尾（未确定结束）暂不转卡');
  ok(planAnswer(partial, { streaming: false }).some(s => s.kind === 'links'), '同一段在历史消息里转卡');
}

{
  const followed = ['- [一](https://a.example.com)', '- [二](https://b.example.com)', '- [三](https://c.example.com)', '以上三条。'].join('\n');
  ok(planAnswer(followed, { streaming: true }).some(s => s.kind === 'links'), '链接组后面出现非链接行 → 视为闭合，流式也转卡');
}

/* ══════════════ ⑤ 证据块 ══════════════ */

section('证据块：只有「$ 命令 + 输出」形态才折');

{
  const text = ['```bash', '$ npm run verify:a174', 'PASS 1/1', 'ok 12:04:11', '```'].join('\n');
  const segs = planAnswer(text);
  const ev = segs.find(s => s.kind === 'evidence');
  ok(ev?.kind === 'evidence' && ev.command === 'npm run verify:a174', '命令从首行 $ 前缀抽出');
  ok(ev?.kind === 'evidence' && ev.lines === 2, '行数只算输出行');
  ok(!segs.some(s => s.kind === 'md' && s.text.includes('npm run verify')), '折进证据块后不再重复出现在正文');
}

{
  const noDollar = ['```bash', 'npm test', 'ok', '```'].join('\n');
  ok(!planAnswer(noDollar).some(s => s.kind === 'evidence'), '没有 $ 前缀的 shell 围栏不当证据');
  const python = ['```python', '$ print(1)', '1', '```'].join('\n');
  ok(!planAnswer(python).some(s => s.kind === 'evidence'), '非终端语言的围栏不当证据');
  const unclosed = ['```bash', '$ npm test', 'running...'].join('\n');
  ok(!planAnswer(unclosed, { streaming: true }).some(s => s.kind === 'evidence'), '流式未闭合围栏保持原样（避免代码块被吃掉）');
  ok(planAnswer(unclosed).every(s => s.kind === 'md'), '历史消息里未闭合围栏也只是 markdown');
}

/* ══════════════ ⑥ 不误伤：普通正文原样保留 ══════════════ */

section('不误伤：表格 / 普通代码块 / 中文标点');

/* 原期望（A174 P1）：表格整块留在 markdown，`segs.length === 1 && kind === 'md'`。
 * 新期望（本次）：标准 GFM 表转成 `table` 片段 —— 这是本需求明确要的形态变化，
 * 不是放宽。原「逐字保留」改为「行列内容逐字保留」，因为表格现在由 React
 * 渲染，不再经过 Cherry。 */
{
  const text = ['| 名称 | 链接 |', '| --- | --- |', '| 一 | https://a.example.com |', '', '> 引用里的一句话。'].join('\n');
  const segs = planAnswer(text);
  const table = segs.find(s => s.kind === 'table');
  ok(!!table, '标准 GFM 表转成表格片段');
  ok(table?.kind === 'table' && table.header.join('|') === '名称|链接', '表头逐字保留');
  ok(table?.kind === 'table' && table.rows[0].join('|') === '一|https://a.example.com', '单元格逐字保留（URL 原样）');
  ok(segs.some(s => s.kind === 'md' && s.text.includes('> 引用里的一句话。')), '表格之后的普通正文仍走 markdown');
  ok(countHttpLinks(segs) === 1, '单元格里的 http(s) 链接计入链接数');
}

{
  const text = ['```tsx', 'const x = [1, 2];', '```', '', '以上。'].join('\n');
  const segs = planAnswer(text);
  ok(segs.every(s => s.kind === 'md'), '普通代码块留在 markdown（由 Cherry 高亮）');
  ok(segs.map(s => (s.kind === 'md' ? s.text : '')).join('\n').includes('```tsx'), '围栏标记没有被吞');
}

{
  const text = '第 1 段中文。\n\n第 2 段里的链接保持行内：见 [文档](https://example.com)。';
  const segs = planAnswer(text);
  ok(countHttpLinks(segs) === 1, '段落内行内链接计数 1');
  ok(segs.every(s => s.kind === 'md'), '零散链接不触发卡片');
}

/* ══════════════ ⑦ 表格卡 ══════════════ */

type TableSeg = Extract<ReturnType<typeof planAnswer>[number], { kind: 'table' }>;

function tableOf(text: string): TableSeg | null {
  const seg = planAnswer(text).find(s => s.kind === 'table');
  return seg && seg.kind === 'table' ? seg : null;
}

section('表格卡：解析、对齐、数值列、折叠阈值');

{
  const t = tableOf(
    ['| 阶段 | 说明 | 耗时 |', '| :--- | --- | ---: |', '| 解析 | 行级切分 | 12 |', '| 渲染 | 卡片组件 | 8 |'].join('\n'),
  );
  ok(t?.header.length === 3, '表头 3 列');
  ok(t?.rows.length === 2, '数据行 2 行');
  ok(t?.align.join(',') === 'left,left,right', '显式对齐被采纳（左/左/右）', t?.align.join(','));
  ok(t?.numeric.join(',') === 'false,false,true', '数值列识别到第三列', t?.numeric.join(','));
}

{
  const t = tableOf(['| 名称 | 数量 |', '| --- | --- |', '| 甲 | 1,200 |', '| 乙 | 3.5 |'].join('\n'));
  ok(t?.align[1] === 'right', '未写对齐时数值列自动右对齐', t?.align[1]);
  ok(t?.align[0] === 'left', '文本列保持左对齐', t?.align[0]);
  ok(
    parseNumericCell('1,200') === 1200 && parseNumericCell('¥3.50') === 3.5 && parseNumericCell('42%') === 42,
    '千分位 / 货币前缀 / 百分号都能解析',
  );
  ok(parseNumericCell('12ms') === null && parseNumericCell('约 12') === null, '带单位或含糊文本不算数值');
}

{
  const t = tableOf(['| 项 | 值 |', '| :---: | --- |', '| 甲 | 1 |'].join('\n'));
  ok(t?.align[0] === 'center', '显式居中被采纳', t?.align[0]);
  // 显式写 `:---` 的数值列也按左对齐 —— 作者意图优先于启发式，避免静默改版式
  const leftExplicit = tableOf(['| 项 | 值 |', '| :--- | :--- |', '| 甲 | 120 |'].join('\n'));
  ok(leftExplicit?.align[1] === 'left', '显式左对齐覆盖数值推断', leftExplicit?.align[1]);
}

{
  const cells = splitTableRow('| 含 \\| 的文本 | 尾列 |');
  ok(cells?.length === 2 && cells[0] === '含 | 的文本', '\\| 转义还原成一个竖线');
  const t = tableOf(['| A | B | C |', '| --- | --- | --- |', '| 含 \\| 的文本 | 只有一列 |'].join('\n'));
  ok(t?.rows[0].length === 3 && t?.rows[0][2] === '', '少列的行走位补空（渲染层不用管列数）');
}

section('表格卡：不合格的 `|` 文本不误判');

{
  ok(tableOf('| A | B |\n| --- | --- |') === null, '只有表头没有数据行不转卡');
  ok(tableOf('| A |\n| --- |\n| 1 |') === null, '单列表格不认（那是带竖线的段落）');
  ok(tableOf('| A | B |\n| --- |\n| 1 | 2 |') === null, '分隔行列数与表头不一致不认');
  ok(tableOf('| A | B |\n| 一 | 二 |\n| 1 | 2 |') === null, '第二行不是分隔行不认');
  ok(!planAnswer('第一行 a | b\n第二行 c | d').some(s => s.kind === 'table'), '普通带竖线文本不误判');
  const mdOnly = planAnswer('第一行 a | b\n第二行 c | d');
  ok(mdOnly.every(s => s.kind === 'md'), '误判失败时原文完整留在 markdown');
}

section('表格卡：折叠阈值与流式松手');

{
  ok(MAX_TABLE_ROWS === 8, '折叠阈值是 8 行');
  const mk = (n: number): string =>
    ['| 项 | 值 |', '| --- | ---: |', ...Array.from({ length: n }, (_, i) => `| 行 ${i + 1} | ${i + 1} |`)].join('\n');
  ok(tableOf(mk(MAX_TABLE_ROWS))?.rows.length === MAX_TABLE_ROWS, '正好 8 行：不触发折叠（UI 判 > MAX）');
  ok((tableOf(mk(MAX_TABLE_ROWS + 1))?.rows.length ?? 0) > MAX_TABLE_ROWS, '9 行：触发折叠');
}

{
  const growing = ['| 项 | 值 |', '| --- | ---: |', '| 甲 | 1 |', '| 乙 | 2 |'].join('\n');
  ok(!planAnswer(growing, { streaming: true }).some(s => s.kind === 'table'), '流式末尾表格还在长：先留 markdown');
  ok(planAnswer(growing, { streaming: false }).some(s => s.kind === 'table'), '历史消息里直接转表格卡');
  const followed = `${growing}\n\n后续正文。`;
  ok(planAnswer(followed, { streaming: true }).some(s => s.kind === 'table'), '表格后出现非表格行 → 视为结束，流式也转卡');
  ok(
    planAnswer(followed, { streaming: true }).some(s => s.kind === 'md' && s.text.includes('后续正文。')),
    '表格之后的正文没有被吞',
  );
}

/* ══════════════ ⑧ 图表卡 ══════════════ */

section('图表卡：两列数值 ≥3 行才画，其余回退表格');

{
  const chartable = tableOf(
    ['| 渠道 | 访问量 |', '| --- | ---: |', '| 直接访问 | 1820 |', '| 搜索引擎 | 940 |', '| 社交媒体 | 460 |'].join('\n'),
  );
  ok(!!chartable, '图表候选仍先解析成表格片段');
  const chart = chartable ? chartOf(chartable) : null;
  ok(!!chart && chart.rows.length === 3, '三行条形全部产出', chart?.rows.length);
  ok(!!chart && chart.max === 1820, 'max 取最大数值', chart?.max);
  ok(!!chart && chart.rows[0].label === '直接访问' && chart.rows[0].value === 1820, '标签与数值正确');
  ok(!!chart && chart.labelHeader === '渠道' && chart.valueHeader === '访问量', '表头带到图卡标题');
}

{
  const threeCols = tableOf(['| 渠道 | 占比 | 备注 |', '| --- | ---: | --- |', '| 甲 | 10 | ok |', '| 乙 | 20 | ok |', '| 丙 | 30 | ok |'].join('\n'));
  ok(threeCols && chartOf(threeCols) === null, '三列表格回退为表格卡（不画图）');

  const twoRows = tableOf(['| 渠道 | 数量 |', '| --- | ---: |', '| 甲 | 10 |', '| 乙 | 20 |'].join('\n'));
  ok(twoRows && chartOf(twoRows) === null, '只有 2 行不画（条形对比没有信息量）');

  const negative = tableOf(['| 项目 | 增减 |', '| --- | ---: |', '| 新增 | 12 |', '| 删除 | -7 |', '| 净增 | 5 |'].join('\n'));
  ok(negative && chartOf(negative) === null, '出现负值回退表格（条形长度无法表达负值）');

  const textCol = tableOf(['| 项目 | 状态 |', '| --- | --- |', '| 甲 | 已完成 |', '| 乙 | 进行中 |', '| 丙 | 待开始 |'].join('\n'));
  ok(textCol && chartOf(textCol) === null, '第二列不是数值 → 回退表格');

  const zeros = tableOf(['| 项目 | 数量 |', '| --- | ---: |', '| 甲 | 0 |', '| 乙 | 0 |', '| 丙 | 0 |'].join('\n'));
  ok(zeros && chartOf(zeros) === null, '全为 0 回退表格（max=0 时条形没有比例）');

  const unitCol = tableOf(['| 项目 | 耗时 |', '| --- | --- |', '| 甲 | 12ms |', '| 乙 | 30ms |', '| 丙 | 8ms |'].join('\n'));
  ok(unitCol && chartOf(unitCol) === null, '带单位数值不画（单位不同不可横向比较）');
}

/* ══════════════ ⑨ 偏好：linkOpenMode ══════════════ */

section('偏好：链接默认打开方式能落盘、脏值被忽略');

{
  ok(
    normalizePrefs({ linkOpenMode: 'in-app' } as unknown).linkOpenMode === 'in-app',
    'normalizePrefs 保留合法值',
  );
  ok(
    normalizePrefs({ linkOpenMode: 'nonsense' } as unknown).linkOpenMode === undefined,
    'normalizePrefs 丢弃脏值（回落默认）',
  );
  const good = validatePrefsPatch({ linkOpenMode: 'system' });
  ok(good.ok === true && good.patch.linkOpenMode === 'system', 'PATCH 接受 system');
  const bad = validatePrefsPatch({ linkOpenMode: 'systeme' });
  ok(bad.ok === false, 'PATCH 拒绝拼错的值（不静默吞掉）');
  const reset = validatePrefsPatch({ linkOpenMode: null });
  ok(reset.ok === true && reset.patch.linkOpenMode === null, 'PATCH 用 null 清空（回到默认）');
}

/* ══════════════ ⑩ 接线（静态断言） ══════════════ */

section('接线：主进程 / preload / 装饰 / 设置项');

{
  const main = read('electron/main.ts');
  ok(main.includes("ipcMain.handle('opc:open-external'"), '主进程注册 opc:open-external');
  ok(/normalizeBrowserUrl\(raw\)/.test(main), '主进程侧再过一遍 URL 白名单');
  ok(/shell\.openExternal\(url\)/.test(main), '主进程用 shell.openExternal 交给系统');
  ok(/if \(!url\) return false;/.test(main), '非法 URL 返回 false，不尝试打开');

  const preload = read('electron/preload.cjs');
  ok(/externalOpen\(url\)/.test(preload), 'preload 暴露 externalOpen');
  ok(preload.includes("ipcRenderer.invoke('opc:open-external', url)"), 'preload 转发到正确通道');

  const decor = read('src/answer/linkDecor.ts');
  ok(decor.includes('sanitizeHttpUrl'), '装饰层先过白名单再写 href');
  ok(decor.includes('data-opc-extlink'), '外链锚点有 data- 锚点');
  ok(decor.includes('data-answer-link-tip'), '悬浮提示有 data- 锚点');
  ok(decor.includes('data-guess-tag'), '推测标签有 data- 锚点');
  ok(!/a\.setAttribute\('href', raw\)/.test(decor), '不会把原始 href 直接写回');

  const router = read('src/answer/linkRouter.ts');
  ok(router.includes("'in-app'") && router.includes("'system'"), '两条打开方式都在');
  ok(/hasInAppBrowser\(\).*requestOpenInWorkspace/m.test(router), '应用内不可用时退回系统浏览器');
  ok(router.includes('noopener,noreferrer'), '浏览器开发态的新标签页带 noopener');

  const chat = read('src/components/ChatMessages.tsx');
  ok(chat.includes('installAnswerLinkDecor'), '消息容器安装了行内装饰');
  ok(/cwd=\{sessionCwd\}/.test(chat), '代码改动卡拿到会话 cwd');
  ok(chat.includes('messageClock'), '证据块拿到消息时间');

  const settings = read('src/components/SettingsPage.tsx');
  ok(settings.includes('data-link-open-setting'), '设置项有 data-link-open-setting');
  ok(settings.includes("data-link-open-option={value}"), '两个选项都有 data- 锚点');
  ok(settings.includes('saveLinkOpenMode'), '点击会落盘');

  const css = read('src/index.css');
  const cssStart = css.indexOf('A174：回答内容分级渲染');
  const cssBlock = cssStart >= 0 ? css.slice(cssStart) : '';
  ok(cssBlock.includes('::part(md_a)'), '行内链接走 ::part(md_a)，不改 Cherry 内部');
  const mdARule = cssBlock.slice(cssBlock.indexOf('::part(md_a)'), cssBlock.indexOf('::part(md_a):hover'));
  ok(/text-decoration:\s*underline/.test(mdARule), '行内链接保留下划线（没有把可点性抹掉）');
  ok(/text-underline-offset:\s*3px/.test(mdARule), '下划线 offset 3px');
  ok(/text-decoration-thickness:\s*1px/.test(mdARule), '下划线 1px');
  ok(!/#[0-9a-fA-F]{3,8}/.test(cssBlock), '分级渲染样式里没有硬编码十六进制颜色（只用令牌）');
  ok(/var\(--tc-|var\(--td-/.test(cssBlock), '用的是既有令牌');
  ok(cssBlock.includes('repeat(2, minmax(0, 1fr))'), '链接卡是 2 列等宽网格');

  /* 表格卡 / 图表卡接线 */
  const cards = read('src/components/AnswerCards.tsx');
  ok(cards.includes('data-answer-table'), '表格卡有 data-answer-table');
  ok(cards.includes('data-answer-table-scroll'), '横向滚动容器有 data 锚点');
  ok(cards.includes('data-answer-table-head'), '表头有 data 锚点（用于吸顶断言）');
  ok(cards.includes('data-answer-table-fold'), '折叠按钮有 data 锚点');
  ok(cards.includes('data-answer-chart'), '图表卡有 data-answer-chart');
  ok(cards.includes('data-answer-chart-toggle'), '图表卡保留「查看表格」回退入口');
  ok(cards.includes('sanitizeHttpUrl'), '单元格链接同样过白名单');
  ok(!cards.includes('dangerouslySetInnerHTML') && !/\.innerHTML\s*=/.test(cards), '没有直接把 HTML 注入 DOM');

  const answerMd = read('src/components/AnswerMarkdown.tsx');
  ok(answerMd.includes("case 'table'"), 'AnswerMarkdown 分派 table 片段');
  ok(answerMd.includes('chartOf(seg)'), '表格 → 图表升级判定在渲染层');

  ok(cssBlock.includes('position: sticky'), '表头用 sticky 吸顶');
  ok(/\.tc-answer-table-scroll[\s\S]*?max-height: 360px/.test(cssBlock), '滚动容器有纵向上限（吸顶才有意义）');
  ok(/\.tc-answer-table-scroll[\s\S]*?overflow: auto/.test(cssBlock), '滚动容器双向可滚');
  ok(/data-align='right'/.test(cssBlock), '数值列右对齐有样式落点');
  ok(/th:first-child[\s\S]*?white-space: nowrap/.test(cssBlock), '首列不换行');
  ok(/rgb\(var\(--color-/.test(cssBlock), '表格/图表卡颜色全部走 --color-* 令牌');
  ok(!/#[0-9a-fA-F]{3,8}/.test(cssBlock), '新增样式没有硬编码十六进制颜色');
}

/* ══════════════ 汇总 ══════════════ */

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
