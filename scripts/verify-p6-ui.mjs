/**
 * P6 用量统计与会话导出的 UI 验证。
 *
 * 为什么能真端到端：导出走的是「fetch /api/sessions/:id → 生成 Markdown →
 * Blob 下载」，整条链不依赖任何真实 Agent。Playwright 能捕获 download
 * 事件并读回文件内容，所以断言的是**用户真能拿到的文件**，不是中间状态。
 *
 *   [1] 有用量的助手消息：渲染 usage 小字（`data-usage`），文案与
 *       formatUsage 的期望一致
 *   [2] 没用量的老消息：**不渲染** usage 行（没有数据 ≠ 花了 0 元）
 *   [3] 会话右键菜单里有「导出为 Markdown」
 *   [4] 点导出：真的触发下载；读回文件，标题/元信息/正文/用量/工具摘要齐全
 *   [5] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-p6-ui.mjs（需先 npm run build）
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

// ── 夹具 ──────────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', kind: 'cli', icon: 'codex', color: '#10A37F', description: 'OpenAI Codex CLI', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '0.161.0' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const NOW = Date.now();
const iso = offsetMs => new Date(NOW - offsetMs).toISOString();

const SESSIONS = [
  {
    id: 's1',
    title: '用量导出会话',
    agent_id: 'workbuddy',
    model: 'claude-sonnet-4-5',
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: 'E:/proj/demo',
    scenario_id: 'dev',
    created_at: iso(36e5),
  },
];

const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '帮我把这个 bug 修了', created_at: iso(30e5) },
  {
    id: 'm2',
    session_id: 's1',
    role: 'assistant',
    content: '问题在第三行，已改成先判空。',
    model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy',
    created_at: iso(29e5),
    duration_ms: 2340,
    cost: 0.05,
    tokens: 12345,
    tool_calls: [
      { id: 't1', name: 'Edit', input: { file_path: 'E:/proj/demo/src/a.ts' }, status: 'completed' },
    ],
  },
  // 老消息：没有三列 → 前端不得渲染 usage 行
  {
    id: 'm3',
    session_id: 's1',
    role: 'assistant',
    content: '这是迁移前的老回复，没有用量数据。',
    model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy',
    created_at: iso(28e5),
  },
];

const failures = [];
const checks = { total: 0 };
function ok(cond, label, detail) {
  checks.total++;
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
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  acceptDownloads: true,
});

await ctx.route('**/api/**', async route => {
  const req = route.request();
  const url = req.url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/\/api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    return json({
      session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0],
      messages: MESSAGES.filter(m => m.session_id === id),
    });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  if (url.includes('/api/chat')) {
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  }
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

// ── [1] 打开会话：用量行的有无 ────────────────────────────────────────
console.log('\n[1] 打开会话：usage 行的渲染');
await page.goto(base, { waitUntil: 'networkidle' });
{
  const row = page.locator('.tc-list-item').first();
  await row.click();
  // 等消息真的渲染出来，不赌固定时长：vite 冷启动 / 大 chunk 首次解析时
  // 600ms 未必够，老消息的对照气泡还没上屏，[3] 组的断言就会假失败。
  // 等到那条**最慢出现**的对照消息就位，比等固定时间诚实。
  await page.waitForSelector('.tc-bubble-assistant:has-text("迁移前的老回复")', { timeout: 15000 });

  const usageEl = page.locator('[data-usage]');
  const usageCount = await usageEl.count();
  ok(usageCount === 1, '整页只有一个 usage 行（只有一条有用量的消息）', `count=${usageCount}`);
  if (usageCount === 1) {
    const text = (await usageEl.first().getAttribute('data-usage')) ?? '';
    ok(text === '2.3s · $0.05 · 12.3k tokens', 'usage 文案与 formatUsage 一致', text);
  }
  // 老消息（没有三列）不能出现 usage 行 —— 这是「不假装花了 0 元」的断言
  const oldBubble = page.locator('.tc-bubble-assistant:has-text("迁移前的老回复")');
  ok((await oldBubble.count()) > 0, '老消息确实在页面上（对照组成立）');
  const usageInsideOld = await oldBubble.locator('xpath=..').locator('[data-usage]').count();
  ok(usageInsideOld === 0, '老消息没有 usage 行（没有数据 ≠ 花了 0 元）', `count=${usageInsideOld}`);
}

// ── [2] 右键菜单：导出项 ──────────────────────────────────────────────
console.log('\n[2] 会话右键菜单有「导出为 Markdown」');
await page.keyboard.press('Escape');
{
  const row = page.locator('.tc-list-item').first();
  await row.click({ button: 'right', position: { x: 60, y: 20 } });
  // 同理：等菜单节点而不是等 400ms。右键菜单没弹出时
  // menuText 取到空串，报的是「菜单里没有导出项」这种误导性失败。
  await page.waitForSelector('[role="menu"]', { timeout: 10000 });

  const menuText = await page.evaluate(() => {
    const m = document.querySelector('[role="menu"]');
    return m ? m.textContent ?? '' : '';
  });
  ok(menuText.includes('导出为 Markdown'), '菜单里有导出项', menuText.slice(0, 80));
  ok(menuText.includes('置顶'), '菜单里原有项仍在（没有只加不改）');

  // ── [3] 点导出：真下载 + 读回内容 ──────────────────────────────────
  console.log('\n[3] 点导出：真的下载，且内容完整');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('[role="menu"] :text("导出为 Markdown")'),
  ]);
  ok(!!download, '触发了下载事件');
  const suggested = download.suggestedFilename();
  ok(suggested === '用量导出会话.md', '下载文件名 = 会话标题.md', suggested);

  const dlPath = await download.path();
  const md = dlPath ? await readFile(dlPath, 'utf8') : '';
  ok(md.includes('# 用量导出会话'), '导出：标题是一级标题');
  ok(md.includes('- Agent：WorkBuddy'), '导出：Agent 名已译');
  ok(md.includes('- 模型：claude-sonnet-4-5'), '导出：模型进元信息');
  ok(md.includes('- 场景：开发'), '导出：场景中文标签');
  ok(md.includes('- 工作目录：E:/proj/demo'), '导出：工作目录');
  ok(md.includes('## 🧑 我 ·'), '导出：用户消息小节');
  ok(/## 🤖 WorkBuddy · .*（2\.3s · \$0\.05 · 12\.3k tokens）/.test(md), '导出：助手消息带作者与用量', md.split('\n').find(l => l.startsWith('## 🤖')) ?? '');
  ok(md.includes('问题在第三行，已改成先判空。'), '导出：助手正文');
  ok(md.includes('这是迁移前的老回复，没有用量数据。'), '导出：老消息正文也在');
  ok(!md.includes('（2.3s · $0.05 · 12.3k tokens）\n\n这是迁移前'), '导出：老消息没有伪造用量');
  ok(md.includes('✅ `Edit` E:/proj/demo/src/a.ts'), '导出：工具调用摘要');
  // 老消息的小节头部不该带用量括号
  const oldHeader = md.split('\n').find(l => l.includes('这是迁移前的老回复'));
  ok(!!oldHeader, '导出：老消息正文存在');
  ok(!md.includes('没有用量数据。\n\n（'), '导出：结构没有错位');
}

// ── [4] 控制台 ────────────────────────────────────────────────────────
console.log('\n[4] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n✗ P6 UI 断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`);
  process.exit(1);
}
console.log(`\nP6 UI 断言：${checks.total}/${checks.total} 通过`);
console.log('✓ 用量行只在该有数据时出现；导出真的产出完整 Markdown 文件');
