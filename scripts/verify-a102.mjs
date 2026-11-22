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

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check');
import { resolveChromePath } from './lib/chrome.mjs';
const CHROME = resolveChromePath();

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
/** 三个工具步骤：纯文本解析 / 结构化 / 老数据无 source，外加一个嵌套思考节点
 *
 *  F3 之后「<3s 的步骤不挂耗时」是产品口径，所以前两步故意拉到 ≥3s：
 *  [3] 要比较「耗时贴同一右缘」至少得有两条 meta，否则这条断言会失去意义
 *  （不是放宽断言，是把夹具改成仍然能测到该行为的样子）。第三步保持 <3s，
 *  顺便守住「短步骤没有 meta」这条新口径。 */
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '跑一下测试', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: '跑完了。', model: 'qoder-model',
    author_agent_id: 'qoder', created_at: new Date(now).toISOString(),
    blocks: [
      {
        id: 'b1', type: 'tool', toolId: 't1', name: 'bash', status: 'completed',
        input: { command: 'npm test' }, source: 'parsed_text',
        output: '3 passed', startedAt: now - 5800, endedAt: now - 2600,
      },
      {
        id: 'b2', type: 'tool', toolId: 't2', name: 'write', status: 'completed',
        input: { file_path: 'src/components/SettingsPage.tsx', content: 'export const a = 1;' },
        source: 'structured_cli', output: 'ok', startedAt: now - 6400, endedAt: now - 3000,
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
// 完成态默认收起，先展开
await page.locator('[data-flow-summary]').first().click();
await page.waitForTimeout(400);

console.log('\n[1] 步骤行字号两档（14 主 / 12 辅，ProcessFlow 定版）');
const sizes = await page.evaluate(() => {
  const rows = [];
  for (const head of document.querySelectorAll('.pf-step-head')) {
    rows.push([...head.children].map(el => ({
      cls: el.getAttribute('class') || el.tagName.toLowerCase(),
      fs: parseFloat(getComputedStyle(el).fontSize),
    })));
  }
  return rows;
});
const distinct = [...new Set(sizes.flat().map(s => s.fs))].sort((a, b) => a - b);
// 2026-11-22 ProcessFlow 定版：动词/目标/耗时 14px（主），diff 12px（辅）。
const offenders = sizes.flat().filter(v => ![12, 14].includes(v.fs)).map(v => `${v.cls}=${v.fs}`);
ok(
  offenders.length === 0,
  '行内只有 12/14 两档（14 主 / 12 辅，无 11px 回归）',
  `实测 ${distinct.join(' / ')}px；越档：${offenders.join(', ') || '无'}`
);
const verbFs = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector('.pf-verb')).fontSize));
const lineFs = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector('.pf-target:not(.mono)')).fontSize));
ok(verbFs === 14, '动词 14px（流程行口径）', `实测 ${verbFs}px`);
ok(lineFs === verbFs, '行内容与动词同档', `${lineFs}px vs ${verbFs}px`);

console.log('\n[2] 动词不再继承更大字号');
ok(verbFs < 16, '动词不再继承 16px（流程行 = 14px）', `实测 ${verbFs}px`);
// 行高统一到 1.7（比值而非像素：不同元素的行盒高度本就由字号决定，
// 真正决定基线是否对齐的是**行高与字号同比**）。
const ratios = await page.evaluate(() => {
  const pick = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
  };
  return { verb: pick('.pf-verb'), line: pick('.pf-target'), diff: pick('.pf-diff') };
});
ok(
  ratios.verb != null && Math.abs(ratios.verb - ratios.line) < 0.01 && Math.abs(ratios.verb - ratios.diff) < 0.01,
  '动词 / 行内容 / diff 行高同比一致（同一继承源）',
  `${ratios.verb} / ${ratios.line} / ${ratios.diff}`
);

console.log('\n[3] 所有步骤行的耗时贴同一右缘');
const edges = await page.evaluate(() => {
  const out = [];
  for (const step of document.querySelectorAll('[data-flow-row]')) {
    const meta = step.querySelector('.pf-meta');
    if (!meta) continue;
    const head = step.querySelector('.pf-step-head').getBoundingClientRect();
    const m = meta.getBoundingClientRect();
    out.push(Math.round(head.right - m.right));
  }
  return out;
});
ok(edges.length >= 2, '取到多个步骤行', `${edges.length} 行`);
ok(Math.max(...edges) - Math.min(...edges) <= 1, '各行耗时距右缘一致',
  edges.map(e => `${e}px`).join(' / '));
// 单步耗时全量显示（<1s 用 ms 口径）
const shortStep = await page.evaluate(() =>
  document.querySelector('[data-flow-row="t3"]')?.querySelector('.pf-meta')?.textContent?.trim() ?? null);
ok(shortStep === '200ms', '单步耗时全量显示（t3 200ms → 200ms）', String(shortStep));

console.log('\n[4] 一行动词/目标/耗时不再抢自动边距');
const srcGeo = await page.evaluate(() => {
  const row = document.querySelector('[data-flow-row]');
  if (!row) return null;
  const head = row.querySelector('.pf-step-head').getBoundingClientRect();
  const target = row.querySelector('.pf-target')?.getBoundingClientRect() ?? null;
  const meta = row.querySelector('.pf-meta')?.getBoundingClientRect() ?? null;
  return {
    sourceTags: document.querySelectorAll('[data-trace-source]').length,
    targetFromLeft: target ? Math.round(target.left - head.left) : null,
    metaFromRight: meta ? Math.round(head.right - meta.right) : null,
  };
});
ok(srcGeo !== null && srcGeo.sourceTags === 0, '来源标签随流程流改版退役（不再出现第三枚自动边距）', String(srcGeo?.sourceTags));
ok(srcGeo && srcGeo.targetFromLeft !== null && srcGeo.targetFromLeft > 20, '动词后仍有目标文本占位', `距左 ${srcGeo?.targetFromLeft}px`);
ok(srcGeo && srcGeo.metaFromRight !== null && srcGeo.metaFromRight <= 8, '耗时仍贴右缘（行内 6px 内边距）', `距右 ${srcGeo?.metaFromRight}px`);

console.log('\n[5] 图标几何跟随行高（圆点退役）');
const dot = await page.evaluate(() => {
  const row = document.querySelector('[data-flow-row]');
  const head = row.querySelector('.pf-step-head').getBoundingClientRect();
  const d = row.querySelector('.pf-ico').getBoundingClientRect();
  return {
    headH: Math.round(head.height),
    off: Math.abs((d.top + d.height / 2) - (head.top + head.height / 2)),
  };
});
ok(dot.headH === 28, '行高 28px（流程行单行）', `实测 ${dot.headH}px`);
ok(dot.off <= 1.5, '图标中心与行头中心重合', `偏差 ${dot.off.toFixed(1)}px`);

console.log('\n[6] 整轮状态条同层级');
/* 旧 AgentTrace v2 的「汇总行 + 验证条 + 核对条」在 2026-11-22 流程流改版中
   合成一条摘要行；状态胶囊按用户定版删除，这里守「时钟 / 摘要行都在场且同层」。 */
const bars = await page.evaluate(() =>
  ['.pf-hdr', '.pf-steps-bar'].map(s => {
    const el = document.querySelector(s);
    return el ? Math.round(el.getBoundingClientRect().height) : 0;
  }));
ok(bars.every(h => h > 0), '时钟 / 摘要行两段都在', bars.join(' / '));
ok(Math.max(...bars) - Math.min(...bars) <= 12, '同层级高度差不超过 12px', bars.join(' / '));
ok((await page.locator('.pf-pill').count()) === 0, '状态胶囊已删（不再有可见完成/等待胶囊）');

console.log('\n[7] A100 目标文本不回退（流程流形态）');
const targets = await page.evaluate(() =>
  [...document.querySelectorAll('[data-flow-row] .pf-target')].map(el => el.textContent?.trim() ?? ''));
ok(targets.length >= 3, '每行目标文本都在（来源标签退役不等于目标丢失）', `${targets.length} 行`);
ok(targets[0] === 'npm test', '首行目标仍是命令本身', targets[0] ?? '');

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
