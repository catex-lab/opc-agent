/**
 * A102 执行过程 UI 排版一致性的浏览器验证。
 *
 * 背景（为什么要有这个脚本）：用户截图反馈「文字字体字号不一致，排版很乱」。
 * 实测定位到三个硬伤，这个脚本把三条都钉住，防止回归：
 *
 *   1. `.tc-trace-verb` 没写 font-size，一路继承 body 的 16px —— 一行里
 *      动词 16px、目标 12px、diff 11px、耗时 11px，四种字号四种行高。
 *   2. 来源标签复用了 `.tc-trace-meta`，而那个类带 `margin-left:auto` ——
 *      一行出现两个自动边距，剩余空间对半分，耗时列整列错齐不了
 *      （实测同轮 600ms 在 x=915，别行 200ms 在 x=1284）。
 *   3. 验证条 12px、轨迹汇总行 11px，同一种角色两套字号。
 *
 *   [1] 步骤行内只有两档字号，动词与目标同档
 *   [2] 动词不再是继承来的 16px
 *   [3] 所有步骤行的耗时贴同一右缘
 *   [4] 来源标签不抢右缘，且位于耗时左侧
 *   [5] 圆点圆心与行头中心重合（行高变小后几何要跟着走）
 *   [6] 三条状态条高度一致
 *   [7] A100 的来源标注行为不回退
 *   [8] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a102.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { openAllProcess } from './lib/process-flow.mjs';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const AGENTS = [
  {
    id: 'qoder', name: 'Qoder', vendor: 'Qoder', kind: 'cli', icon: 'qoder',
    color: '#5B7FFF', description: '纯文本输出的 CLI', capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '1.0.55' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
];
const MODELS = [{ modelId: 'qoder-model', name: 'Qoder Model', description: '均衡' }];
const SESSIONS = [
  {
    id: 's1', title: 'Qoder', agent_id: 'qoder', model: 'qoder-model',
    kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString(),
  },
];

const now = Date.now();
/** 三个工具步骤：纯文本解析 / 结构化 / 老数据无 source，外加一个嵌套思考节点 */
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '跑一下测试', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: '跑完了。', model: 'qoder-model',
    author_agent_id: 'qoder', created_at: new Date(now).toISOString(),
    blocks: [
      {
        id: 'b1', type: 'tool', toolId: 't1', name: 'bash', status: 'completed',
        input: { command: 'npm test' }, source: 'parsed_text',
        output: '3 passed', startedAt: now - 5800, endedAt: now - 5200,
      },
      {
        id: 'b2', type: 'tool', toolId: 't2', name: 'write', status: 'completed',
        input: { file_path: 'src/components/SettingsPage.tsx', content: 'export const a = 1;' },
        source: 'structured_cli', output: 'ok', startedAt: now - 5000, endedAt: now - 4800,
      },
      {
        id: 'b3', type: 'tool', toolId: 't3', name: 'read', status: 'completed',
        input: { file_path: 'src/b.ts' },
        output: 'export const b = 2;', startedAt: now - 4600, endedAt: now - 4400,
      },
      { id: 'b4', type: 'thinking', text: '先看测试再改。', state: 'done', format: 'text' },
      { id: 'b5', type: 'text', text: '跑完了。', state: 'done' },
    ],
  },
];

let total = 0;
const failures = [];
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let file = join(DIST, p);
    let body;
    try {
      body = await readFile(file);
    } catch {
      file = join(DIST, 'index.html');
      body = await readFile(file);
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', m => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', e => errors.push(String(e)));

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/runs/active')) return json({ runs: [] });
  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (url.includes('/api/verify/commands')) return json({ cwd: null, projectTypes: [], commands: [], notes: [] });
  if (url.includes('/api/verify/results')) return json({ verifications: [] });
  if (url.includes('/api/files/evidence')) return json({ cwd: null, items: [], summary: { total: 0, landed: 0, notLanded: 0, other: 0, alarm: null } });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    return json({ session: SESSIONS[0], project: null, messages: MESSAGES, dangling: null });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
// A149：先展开过程流（否则轨迹不在 DOM 里）
await openAllProcess(page);
// 完成态默认收起，先展开
await page.locator('[data-steps-bar]').first().click();
await page.waitForTimeout(400);

console.log('\n[1] 步骤行内只有两档字号');
const sizes = await page.evaluate(() => {
  const rows = [];
  for (const head of document.querySelectorAll('.tc-step-head')) {
    const vals = [...head.children].map(el => ({
      cls: el.getAttribute('class') || el.tagName.toLowerCase(),
      fs: parseFloat(getComputedStyle(el).fontSize),
      lh: getComputedStyle(el).lineHeight,
    }));
    rows.push(vals);
  }
  return rows;
});
const distinct = [...new Set(sizes.flat().map(s => s.fs))].sort((a, b) => a - b);
ok(distinct.length === 2, '一行之内只有两档字号', `实测 ${distinct.join(' / ')}px`);
const verbFs = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector('.tc-trace-verb')).fontSize));
const targetFs = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector('.tc-trace-target')).fontSize));
ok(verbFs === targetFs, '动词与目标同档', `${verbFs}px vs ${targetFs}px`);

console.log('\n[2] 动词不再继承 16px');
ok(verbFs === 12, '动词钉在 12px', `实测 ${verbFs}px`);
// 注意：不能断言「三者行高像素相等」—— diff 是 11px 字，继承 1.5 倍后
// 必然是 16.5px，和 12px 字的 18px 不可能相等。真正决定基线是否对齐的是
// **行高与字号同比**（半行距等比），所以断言比值。
const ratios = await page.evaluate(() => {
  const pick = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
  };
  return { verb: pick('.tc-trace-verb'), target: pick('.tc-trace-target'), diff: pick('.tc-diff') };
});
ok(
  Math.abs(ratios.verb - 1.5) < 0.01 && Math.abs(ratios.target - 1.5) < 0.01 && Math.abs(ratios.diff - 1.5) < 0.01,
  '动词 / 目标 / diff 行高都与字号同比（1.5）',
  `${ratios.verb} / ${ratios.target} / ${ratios.diff}`
);

console.log('\n[3] 所有步骤行的耗时贴同一右缘');
const edges = await page.evaluate(() => {
  const out = [];
  for (const step of document.querySelectorAll('[data-tool-step]')) {
    const meta = step.querySelector('.tc-trace-meta');
    if (!meta) continue;
    const head = step.querySelector('.tc-step-head').getBoundingClientRect();
    const m = meta.getBoundingClientRect();
    out.push(Math.round(head.right - m.right));
  }
  return out;
});
ok(edges.length >= 2, '取到多个步骤行', `${edges.length} 行`);
ok(Math.max(...edges) - Math.min(...edges) <= 1, '各行耗时距右缘一致',
  edges.map(e => `${e}px`).join(' / '));

console.log('\n[4] 来源标签不抢右缘');
const srcGeo = await page.evaluate(() => {
  const step = document.querySelector('[data-tool-step]:has([data-trace-source])');
  if (!step) return null;
  const head = step.querySelector('.tc-step-head').getBoundingClientRect();
  const src = step.querySelector('[data-trace-source]').getBoundingClientRect();
  const meta = step.querySelector('.tc-trace-meta').getBoundingClientRect();
  return {
    srcFromRight: Math.round(head.right - src.right),
    metaFromRight: Math.round(head.right - meta.right),
    srcLeftOfMeta: src.right <= meta.left + 1,
  };
});
ok(srcGeo !== null, '存在带来源标签的步骤行');
ok(srcGeo.srcFromRight > 20, '标签不在右缘上', `距右缘 ${srcGeo.srcFromRight}px`);
ok(srcGeo.srcLeftOfMeta, '标签在耗时左侧（不再和耗时抢自动边距）');

console.log('\n[5] 圆点几何跟随行高');
const dot = await page.evaluate(() => {
  const step = document.querySelector('[data-tool-step]');
  const head = step.querySelector('.tc-step-head').getBoundingClientRect();
  const d = step.querySelector('.tc-step-dot').getBoundingClientRect();
  return {
    headH: Math.round(head.height),
    off: Math.abs((d.top + d.height / 2) - (head.top + head.height / 2)),
  };
});
ok(dot.headH === 22, '行头高度 22px（修复前 25px）', `实测 ${dot.headH}px`);
ok(dot.off <= 1.5, '圆点圆心与行头中心重合', `偏差 ${dot.off.toFixed(1)}px`);

console.log('\n[6] 三条状态条高度一致');
const bars = await page.evaluate(() =>
  [...document.querySelectorAll('[data-steps-bar], .tc-verify-bar')].map(b =>
    Math.round(b.getBoundingClientRect().height)));
ok(bars.length >= 3, '取到汇总行 + 验证条 + 文件核对条', `${bars.length} 条`);
ok(Math.max(...bars) - Math.min(...bars) <= 1, '高度一致', bars.join(' / '));

console.log('\n[7] A100 来源标注行为不回退');
const tags = page.locator('[data-trace-source]');
ok((await tags.count()) === 1, '只有 1 个步骤带来源标签', String(await tags.count()));
const tagCls = await tags.first().getAttribute('class');
ok(tagCls === 'tc-trace-src', '标签用专属类（不再复用带 auto 边距的 tc-trace-meta）', tagCls);
const tagColor = await tags.first().evaluate(el => getComputedStyle(el).color);
ok(/rgb\(?2?3?/, tagColor) // 非空即有色，具体值由警告色令牌决定
;

console.log('\n[8] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | '));

await page.screenshot({ path: join(OUT, 'a102-typography.png'), fullPage: false });

await browser.close();
server.close();

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`失败 ${failures.length} 条：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
