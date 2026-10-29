/**
 * A96 行级 diff 的浏览器验证。
 *
 *   [1] 展开轨迹后，文件类步骤的展开区出现 .tc-diffview
 *   [2] edit 的 diff 行结构：上下文 / 删除 / 新增，数量与角标一致
 *   [3] 增删行有底色且**颜色不同**（不能都是灰的）
 *   [4] 行号：删除行只有旧行号、新增行只有新行号、上下文两者都有
 *   [5] write 类走 create 模式，并如实提示「旧内容不可知」
 *   [6] read 类没有 diff 数据时退回原明细（不能出现空 diff 框）
 *   [7] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a96.mjs（需先 npm run build）
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

/* A149：有答案的消息，整段过程（含轨迹）默认收在 ProcessFlow 里、子节点卸载。
   先展开过程流，再按原口径展开轨迹。 */
await openAllProcess(page);
// 完成态默认收起，先展开轨迹
const bar = page.locator('[data-steps-bar]').first();
await bar.click();
await page.waitForTimeout(300);

const steps = page.locator('[data-tool-step]');
const stepCount = await steps.count();
console.log('\n[1] 步骤与展开');
ok(stepCount === 3, '3 个工具步骤', String(stepCount));

// ---- 展开 Edit ----
await steps.nth(0).locator('.tc-step-head').click();
await page.waitForTimeout(250);

const dv = steps.nth(0).locator('.tc-diffview');
ok((await dv.count()) === 1, 'Edit 展开后出现行级 diff 视图');
ok((await dv.getAttribute('data-diffview')) === 'replace', 'edit 是 replace 模式（不是 create）');

// ---- [2] 行结构 ----
const rows = await steps.nth(0).evaluate(el => {
  const all = [...el.querySelectorAll('.tc-diffline')];
  return all.map(r => ({
    kind: r.getAttribute('data-kind'),
    sign: r.querySelector('.tc-diffline-sign')?.textContent ?? '',
    text: r.querySelector('.tc-diffline-text')?.textContent ?? '',
    nums: [...r.querySelectorAll('.tc-diffline-no')].map(n => n.textContent.trim()),
    bg: getComputedStyle(r).backgroundColor,
  }));
});
console.log('\n[2] 行结构');
ok(rows.length === 4, '4 行（ctx / del / add / ctx）', `${rows.length} 行`);
ok(rows.map(r => r.kind).join(',') === 'context,del,add,context', '顺序：上下文→删除→新增→上下文', rows.map(r => r.kind).join(','));
ok(rows[1].text.includes('const b = 2;'), '删除行是旧内容', rows[1].text.trim());
ok(rows[2].text.includes('const b = 999;'), '新增行是新内容', rows[2].text.trim());
ok(rows[1].sign === '-' && rows[2].sign === '+', '符号正确（- / +）', `${rows[1].sign} ${rows[2].sign}`);

// 角标与内容必须一致
const badge = await steps.nth(0).locator('.tc-diff').getAttribute('data-diff');
const addCount = rows.filter(r => r.kind === 'add').length;
const delCount = rows.filter(r => r.kind === 'del').length;
ok(badge === `+${addCount} -${delCount}`, '角标数字与展开内容一致', `角标 ${badge} / 内容 +${addCount} -${delCount}`);

// ---- [3] 底色 ----
console.log('\n[3] 增删底色');
const transparent = v => v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
ok(!transparent(rows[2].bg), '新增行有底色', rows[2].bg);
ok(!transparent(rows[1].bg), '删除行有底色', rows[1].bg);
ok(rows[2].bg !== rows[1].bg, '增删底色不同（不是同一种灰）', `${rows[2].bg} vs ${rows[1].bg}`);
ok(transparent(rows[0].bg), '上下文行没有底色', rows[0].bg);

// ---- [4] 行号 ----
console.log('\n[4] 行号');
ok(rows[1].nums[0] === '2' && rows[1].nums[1] === '', '删除行只有旧行号', rows[1].nums.join('|'));
ok(rows[2].nums[0] === '' && rows[2].nums[1] === '2', '新增行只有新行号', rows[2].nums.join('|'));
ok(rows[0].nums[0] === '1' && rows[0].nums[1] === '1', '上下文行新旧行号都有', rows[0].nums.join('|'));

await page.screenshot({ path: join(OUT, 'a96-diff.png'), fullPage: false });

// ---- [5] write → create ----
console.log('\n[5] write 的 create 模式');
await steps.nth(1).locator('.tc-step-head').click();
await page.waitForTimeout(250);
const dv2 = steps.nth(1).locator('.tc-diffview');
ok((await dv2.count()) === 1, 'Write 也有 diff 视图');
ok((await dv2.getAttribute('data-diffview')) === 'create', 'Write 标记为 create 模式');
const note = await steps.nth(1).locator('[data-diffview-note]').textContent().catch(() => '');
ok((note ?? '').includes('旧内容'), '明确提示旧内容不可知（不假装知道删了什么）', (note ?? '').trim());
const wRows = await steps.nth(1).evaluate(el => [...el.querySelectorAll('.tc-diffline')].map(r => r.getAttribute('data-kind')));
ok(wRows.every(k => k === 'add'), 'Write 全部是新增行', wRows.join(','));

// ---- [6] read 退回原明细 ----
console.log('\n[6] 无 diff 数据时退回原明细');
await steps.nth(2).locator('.tc-step-head').click();
await page.waitForTimeout(250);
ok((await steps.nth(2).locator('.tc-diffview').count()) === 0, 'Read 不出现 diff 视图（不能是空框）');
ok((await steps.nth(2).locator('.tc-step-detail').count()) >= 1, 'Read 退回原来的明细渲染');

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
