/**
 * A100 事件来源标签的浏览器验证。
 *
 *   [1] `source: 'parsed_text'` 的步骤显示「文本解析」标签
 *   [2] 标签带说明（悬浮提示里写清楚可信度差一档的原因）
 *   [3] 原生 / 结构化输出的步骤**不显示**标签 —— 满屏噪音的标签等于没有标签
 *   [4] 缺 source 的老数据不显示、也不崩
 *   [5] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a101.mjs（需先 npm run build）
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
/** 三个工具步骤：纯文本解析 / 结构化 / 老数据无 source */
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
        input: { file_path: 'src/a.ts', content: 'export const a = 1;' }, source: 'structured_cli',
        output: 'ok', startedAt: now - 5000, endedAt: now - 4800,
      },
      {
        id: 'b3', type: 'tool', toolId: 't3', name: 'read', status: 'completed',
        input: { file_path: 'src/b.ts' },
        output: 'export const b = 2;', startedAt: now - 4600, endedAt: now - 4400,
      },
      { id: 'b4', type: 'text', text: '跑完了。', state: 'done' },
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
await page.waitForTimeout(1200);

console.log('\n[1] 展开轨迹');
// A149：先展开过程流（否则轨迹不在 DOM 里）
await openAllProcess(page);
// 完成态默认收起，先展开
await page.locator('[data-steps-bar]').first().click();
await page.waitForTimeout(300);

const steps = page.locator('[data-tool-step]');
ok((await steps.count()) === 3, '3 个工具步骤', String(await steps.count()));

console.log('\n[2] 只标纯文本那一种');
const tags = page.locator('[data-trace-source]');
ok((await tags.count()) === 1, '只有 1 个步骤带来源标签', String(await tags.count()));
ok((await tags.getAttribute('data-trace-source')) === 'parsed_text', '标签值是 parsed_text', await tags.getAttribute('data-trace-source'));
const tagText = (await tags.first().textContent()) ?? '';
ok(tagText.includes('文本解析'), '文案是「文本解析」', tagText.trim());

const inFirst = await steps.nth(0).locator('[data-trace-source]').count();
ok(inFirst === 1, '标签挂在纯文本解析的那个步骤上', String(inFirst));
const inSecond = await steps.nth(1).locator('[data-trace-source]').count();
ok(inSecond === 0, '结构化输出的步骤不带标签（不制造噪音）', String(inSecond));
const inThird = await steps.nth(2).locator('[data-trace-source]').count();
ok(inThird === 0, '缺 source 的老数据不带标签、也不猜', String(inThird));

console.log('\n[3] 标签说明');
const tip = await tags.first().getAttribute('title');
ok(!!tip && tip.includes('纯文本'), '悬浮说明里写清楚「只输出纯文本」', (tip ?? '').slice(0, 30));
ok(!!tip && tip.includes('可信度'), '说明里点出可信度差异', (tip ?? '').slice(0, 40));

await page.screenshot({ path: join(OUT, 'a101-source-tag.png'), fullPage: false });

console.log('\n[4] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`失败 ${failures.length} 条：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
