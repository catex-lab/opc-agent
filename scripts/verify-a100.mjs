/**
 * A100「上一轮没有产出回复」的浏览器验证。
 *
 *   [1] 后端返回 dangling 时，输入框上方出现提示条
 *   [2] 文案说清楚「无法恢复」，且带那条消息的时间
 *   [3] 提示条在**可视区内**（不用滚动就能看到）—— 它要是藏在消息列表顶上
 *       就等于没有，用户一进来看到的是最后一条消息
 *   [4] 可以收起
 *   [5] 后端返回 dangling=null 时不出现（不能常驻一条假警报）
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a100.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

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
  {
    id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5',
    kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString(),
  },
];

const now = Date.now();
/** 只有一条 user 消息 —— 正是「发出去了但没回答」的形状 */
const MESSAGES_DANGLING = [
  {
    id: 'u1', session_id: 's1', role: 'user', content: '帮我改一下这个文件',
    created_at: new Date(now - 3 * 3600e3).toISOString(),
  },
];
const MESSAGES_OK = [
  MESSAGES_DANGLING[0],
  {
    id: 'a1', session_id: 's1', role: 'assistant', content: '改好了。', model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now - 3 * 3600e3 + 5000).toISOString(),
    blocks: [{ id: 't1', type: 'text', text: '改好了。', state: 'done' }],
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

/** 由它在「有 dangling」和「没有」之间切换 */
let withDangling = true;

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
    return json({
      session: SESSIONS[0],
      project: null,
      messages: withDangling ? MESSAGES_DANGLING : MESSAGES_OK,
      dangling: withDangling
        ? { messageId: 'u1', at: MESSAGES_DANGLING[0].created_at }
        : null,
    });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

console.log('\n[1] 提示条出现');
const notice = page.locator('[data-dangling]');
ok((await notice.count()) === 1, '出现「上一轮没有产出回复」提示条');

const text = (await notice.textContent()) ?? '';
console.log('\n[2] 文案');
ok(text.includes('上一轮没有产出回复'), '说清楚发生了什么', text.trim().slice(0, 40));
ok(text.includes('无法恢复'), '明确说「无法恢复」（不假装能恢复）');
ok(/\d{2}:\d{2}/.test(text), '带那条消息的时间', (text.match(/\d{2}:\d{2}/) ?? [''])[0]);

console.log('\n[3] 在可视区内');
const box = await notice.boundingBox();
const vh = page.viewportSize().height;
ok(!!box && box.y >= 0 && box.y + box.height <= vh, '不用滚动就能看到', box ? `y=${Math.round(box.y)} h=${Math.round(box.height)} vh=${vh}` : 'null');

const inputBox = await page.locator('textarea').first().boundingBox().catch(() => null);
ok(!inputBox || !box || box.y < inputBox.y, '位置在输入框上方', box && inputBox ? `${Math.round(box.y)} < ${Math.round(inputBox.y)}` : '未取到输入框');

await page.screenshot({ path: join(OUT, 'a100-dangling.png'), fullPage: false });

console.log('\n[4] 可收起');
await notice.locator('button[aria-label="收起提示"]').click();
await page.waitForTimeout(200);
ok((await page.locator('[data-dangling]').count()) === 0, '点击后收起');

console.log('\n[5] 没有 dangling 时不出现');
withDangling = false;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
ok((await page.locator('[data-dangling]').count()) === 0, '正常会话不显示（不常驻假警报）');

console.log('\n[6] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`失败 ${failures.length} 条：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
