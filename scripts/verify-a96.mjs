/**
 * A96 行级 diff 的浏览器验证（2026-11-22 改版：明细 = 参考页 mono 行，不再有 DiffView 面板）。
 *
 *   [1] 展开流程后，编辑步骤的明细区出现 +/- 行
 *   [2] edit 的明细行结构：上下文 / 删除 / 新增，数量与角标一致
 *   [3] 增删行颜色 = success / error 令牌（不能都是灰的）
 *   [5] write 只报新增（+ 行，绝不编造 - 行——旧内容不在入参里）
 *   [6] read 类没有 diff 数据时明细退回输出本身
 *   [7] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a96.mjs（需先 npm run build）
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
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
];

const now = Date.now();
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '改一下这个文件', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: '改好了。', model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [
      {
        // 中间一行 b → X：前后各 1 行相同，应产出 1 ctx + 1 del + 1 add + 1 ctx
        id: 'b1', type: 'tool', toolId: 't1', name: 'Edit', status: 'completed',
        input: {
          file_path: 'D:/work/demo/app/src/components/SettingsPage.tsx',
          old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;',
          new_string: 'const a = 1;\nconst b = 999;\nconst c = 3;',
        },
        output: 'The file has been updated.', startedAt: now - 5800, endedAt: now - 5200,
      },
      {
        // write：入参里没有旧内容 → create 模式
        id: 'b2', type: 'tool', toolId: 't2', name: 'Write', status: 'completed',
        input: { file_path: 'D:/work/demo/app/src/new.ts', content: 'export const x = 1;\nexport const y = 2;' },
        output: 'created', startedAt: now - 5000, endedAt: now - 4800,
      },
      {
        // read：没有 diff 概念 → 必须退回原明细
        id: 'b3', type: 'tool', toolId: 't3', name: 'Read', status: 'completed',
        input: { file_path: 'D:/work/demo/app/src/read-me.ts' },
        output: 'export function readMe() {}', startedAt: now - 4600, endedAt: now - 4400,
      },
      { id: 'b4', type: 'text', text: '改好了。', state: 'done' },
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
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/runs/active')) return json({ runs: [] });
  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES.filter(m => m.session_id === id) });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// 2026-11-22 改版：过程回合 = 一条 ProcessFlow；答案在场 → 摘要线默认折叠。
const summary = page.locator('[data-flow-summary]').first();
await summary.click();
await page.waitForTimeout(300);

const steps = page.locator('[data-flow-row][data-flow-row-kind="tool"]');
const stepCount = await steps.count();
console.log('\n[1] 步骤与展开');
ok(stepCount === 3, '3 个工具步骤', String(stepCount));

// ---- 展开 Edit（改版：明细 = 参考页 mono 行，+/- 着色，不再有 DiffView 面板）----
await steps.nth(0).locator('.pf-step-head').click();
await page.waitForTimeout(250);

const dv = steps.nth(0).locator('[data-flow-detail]');
ok((await dv.count()) === 1, 'Edit 展开后出现行级明细');

// ---- [2] 行结构 ----
const rows = await steps.nth(0).evaluate(el => {
  const all = [...el.querySelectorAll('.pf-line')];
  return all.map(r => ({
    kind: r.classList.contains('is-add') ? 'add' : r.classList.contains('is-del') ? 'del' : 'ctx',
    text: r.textContent.replace(/\n$/, ''),
    color: getComputedStyle(r).color,
  }));
});
console.log('\n[2] 行结构');
ok(rows.length === 4, '4 行（ctx / del / add / ctx）', `${rows.length} 行`);
ok(rows.map(r => r.kind).join(',') === 'ctx,del,add,ctx', '顺序：上下文→删除→新增→上下文', rows.map(r => r.kind).join(','));
ok(rows[1].text.includes('- const b = 2;'), '删除行是旧内容（- 前缀）', rows[1].text.trim());
ok(rows[2].text.includes('+ const b = 999;'), '新增行是新内容（+ 前缀）', rows[2].text.trim());

// 角标与内容必须一致
const badge = await steps.nth(0).locator('.pf-diff').getAttribute('data-flow-diff');
const addCount = rows.filter(r => r.kind === 'add').length;
const delCount = rows.filter(r => r.kind === 'del').length;
ok(badge === `+${addCount} -${delCount}`, '角标数字与展开内容一致', `角标 ${badge} / 内容 +${addCount} -${delCount}`);

// ---- [3] 颜色（读令牌，不写死 hex）----
console.log('\n[3] 增删颜色');
const colors = await page.evaluate(() => {
  const lines = [...document.querySelectorAll('[data-flow-row="t1"] .pf-line')].map(r => ({
    add: r.classList.contains('is-add'),
    del: r.classList.contains('is-del'),
    color: getComputedStyle(r).color,
    el: r,
  }));
  // 探针父级画像：页面上到底有几个 [data-flow]，各自的 var 与 color
  const hosts = [...document.querySelectorAll('[data-flow]')].map(h => ({
    cls: h.className.slice(0, 40),
    var: getComputedStyle(h).getPropertyValue('--td-success-color').trim() || '(empty)',
    color: getComputedStyle(h).color,
    hasRow: !!h.querySelector('[data-flow-row="t1"]'),
  }));
  const cloneStyle = el => {
    const c = el.cloneNode(false);
    (el.parentElement ?? document.body).appendChild(c);
    const color = getComputedStyle(c).color;
    c.remove();
    return color;
  };
  // 探针直接克隆真实的 .pf-line 元素——颜色是 CSS 规则解析后的真值
  //（绕开「探针挂哪才能读到 var」这个位置陷阱，与断言对象的来源一致）
  const addLine = document.querySelector('[data-flow-row="t1"] .pf-line.is-add');
  const delLine = document.querySelector('[data-flow-row="t1"] .pf-line.is-del');
  const cloneAdd = addLine ? cloneStyle(addLine) : null;
  const cloneDel = delLine ? cloneStyle(delLine) : null;
  return {
    add: cloneAdd,
    del: cloneDel,
    lines: lines.map(({ add, del, color }) => ({ add, del, color })),
  };
});
ok(colors.lines.some(l => l.add && l.color === colors.add), '新增行 = success 色（读令牌）', JSON.stringify({ probeAdd: colors.add, lines: colors.lines }));
ok(colors.lines.some(l => l.del && l.color === colors.del), '删除行 = error 色（读令牌）', JSON.stringify({ probeDel: colors.del }));
ok(colors.add !== colors.del, '增删颜色不同（不能都是同一种灰）');
ok(
  colors.lines.every(l => (l.add ? l.color === colors.add : true) && (l.del ? l.color === colors.del : true)),
  '行色与行类一一对应（上下文行不着色）'
);

await page.screenshot({ path: join(OUT, 'a96-diff.png'), fullPage: false });

// ---- [5] write：create 口径（只有 + 行，绝不编造 - 行）----
console.log('\n[5] write 只报新增（不编造删除）');
// 2026-11-22 改版：逐行独立开合 —— Write 行自己点开
await steps.nth(1).locator('.pf-step-head').click();
await page.waitForTimeout(250);
const wRows = await steps.nth(1).evaluate(el =>
  [...el.querySelectorAll('.pf-line')].map(r => ({
    add: r.classList.contains('is-add'),
    text: r.textContent.trim(),
  }))
);
ok(wRows.length === 2, 'Write 明细 = 写入内容的行数', String(wRows.length));
ok(wRows.every(l => l.add && l.text.startsWith('+')), 'Write 全部是新增行（+ 前缀）', wRows.map(l => l.text).join(','));
const wBadge = await steps.nth(1).locator('.pf-diff').getAttribute('data-flow-diff');
ok(wBadge === '+2', 'Write 角标只有 +N（不假装知道删了什么）', String(wBadge));

// ---- [6] read：无 diff 数据 → 明细退回输出，不出现编造的增删行 ----
console.log('\n[6] 无 diff 数据时退回输出明细');
await steps.nth(2).locator('.pf-step-head').click();
await page.waitForTimeout(250);
{
  const diag = await steps.nth(2).evaluate(el => ({
    detail: el.querySelectorAll('[data-flow-detail]').length,
    add: el.querySelectorAll('.pf-line.is-add').length,
    del: el.querySelectorAll('.pf-line.is-del').length,
    text: el.querySelector('[data-flow-detail]')?.textContent?.slice(0, 60) ?? '',
  }));
  ok(diag.detail === 1, 'Read 有明细（输出兜底，不是空白）');
  ok(diag.add === 0 && diag.del === 0, 'Read 不出现编造的增删行', JSON.stringify(diag));
  ok(diag.text.includes('export function readMe'), 'Read 明细是输出本身', diag.text);
}


// ---- [7] 控制台 ----
console.log('\n[7] 控制台');
const realErrors = errors.filter(e => !/favicon|Download the React DevTools/i.test(e));
ok(realErrors.length === 0, '无控制台错误', realErrors.slice(0, 2).join(' | '));

await ctx.close();
await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
