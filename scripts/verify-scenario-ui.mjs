/**
 * 场景入口 UI 验证（P4-3）。
 *
 * 复用 render-check.mjs 的手法：起静态服务器托管 dist/，用 Playwright 拦截
 * /api/** 喂夹具，无需真实后端即可渲染「新建对话」页，逐条断言场景卡的行为。
 *
 * 断言：
 *   [1] 场景区渲染出 6 张卡（工作/问答/开发/代码/写作/生图）
 *   [2] 选「开发」→ 出现「开发场景」标签 + 预览里带出推荐 Agent(OpenCode)
 *       + 工作目录提示切到「该场景建议填写」
 *   [3] 再点一次「开发」→ 取消，标签消失
 *   [4] 选「问答」→ 标签为「问答场景」，且预览里出现其只读 systemPrompt
 *   [5] 全程无控制台错误
 *
 * 运行：node scripts/verify-scenario-ui.mjs（需先 npm run build）
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

// 必须包含场景推荐的 Agent（workbuddy / opencode / hermes），否则推荐项解析不到
// P4-5：能力矩阵随 /api/agents 一起下发。夹具必须带上它，
// 否则前端拿不到 permissionSupport，权限差异提示永远不出现（会假绿）。
const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用助手', capabilities: ['chat', 'code', 'tools'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'opencode', name: 'OpenCode', vendor: 'SST', kind: 'cli', icon: 'opencode', color: '#085041', description: '终端编码 Agent', capabilities: ['chat', 'code', 'tools'], status: { availability: 'ready', version: '2.0.25' }, permissionSupport: { enforced: ['default'], limitation: 'opencode 没有只读或沙箱参数，无法强制只读' } },
  { id: 'hermes', name: 'Hermes', kind: 'acp', icon: 'hermes', color: '#5F5E5A', description: 'ACP Agent', capabilities: ['chat', 'code', 'tools', 'image'], status: { availability: 'ready', version: '0.21.6' }, permissionSupport: { enforced: ['default'], limitation: 'ACP 只有交互式审批，没有只读模式' } },
];
const MODELS = [{ modelId: 'zai/glm-4.7', name: 'GLM-4.7', description: '默认' }];

// 一条「已存在但还没有消息」的直聊会话 —— 只有这种状态才会渲染 NewChatView
// （无会话时 App 渲染的是 EmptyState，不是 ChatPage）。
const SESSIONS = [
  { id: 'new1', title: '新对话', agent_id: 'workbuddy', model: 'zai/glm-4.7', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (url.includes('/api/permission-response')) return json({ ok: true });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ session: SESSIONS[0], messages: [] });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  · 截图 ${name}.png`);
}

// 「新建对话」页：进入一个「已存在但还没有消息」的直聊会话 → ChatPage 渲染 NewChatView
await page.goto(base + '/chat/new1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

console.log('\n[1] 场景区渲染');
const labels = ['工作', '问答', '开发', '代码', '写作', '生图'];
const cardIds = ['work', 'qa', 'dev', 'code', 'write', 'image'];
for (let i = 0; i < cardIds.length; i++) {
  const cnt = await page.locator(`[data-scenario="${cardIds[i]}"]`).count();
  ok(cnt === 1, `场景卡「${labels[i]}」渲染`, `count=${cnt}`);
}
ok((await page.getByText('场景', { exact: true }).count()) >= 1, '出现「场景」分区标题');
await shot('scenario-cards');

console.log('\n[2] 选「开发」');
await page.locator('[data-scenario="dev"]').click();
await page.waitForTimeout(400);
ok((await page.getByText('开发场景', { exact: false }).count()) === 1, '出现「开发场景」标签');
ok((await page.getByText('OpenCode', { exact: false }).count()) >= 1, '预览带出推荐 Agent：OpenCode');
ok((await page.getByText('该场景建议填写', { exact: false }).count()) === 1, '工作目录提示切到「该场景建议填写」');
ok((await page.getByText('读写文件', { exact: false }).count()) >= 1, '预览显示开发场景的 systemPrompt/说明');
await shot('scenario-dev-selected');

console.log('\n[3] 再点一次取消');
await page.locator('[data-scenario="dev"]').click();
await page.waitForTimeout(400);
ok((await page.getByText('开发场景', { exact: false }).count()) === 0, '「开发场景」标签消失（已取消）');
ok((await page.getByText('该场景建议填写', { exact: false }).count()) === 0, '工作目录提示回到「(可选)」');

console.log('\n[4] 选「问答」');
await page.locator('[data-scenario="qa"]').click();
await page.waitForTimeout(400);
ok((await page.getByText('问答场景', { exact: false }).count()) === 1, '出现「问答场景」标签');
ok((await page.getByText('只做只读分析与解答', { exact: false }).count()) >= 1, '预览显示问答场景的只读 systemPrompt');

console.log('\n[5] 权限约束能否落地（P4-5）');
// 问答场景的推荐 Agent 是 workbuddy（真能强制只读）→ 不该出现警告
ok(
  (await page.locator('[data-permission-gap]').count()) === 0,
  '问答场景 + WorkBuddy（能强制只读）→ 不显示警告'
);
// 换成 opencode（实测无只读开关）→ 必须如实警告，否则用户以为只读已生效
await page.locator('[data-agent="opencode"]').click();
await page.waitForTimeout(400);
ok(
  (await page.locator('[data-permission-gap]').count()) === 1,
  '问答场景 + OpenCode（无法强制只读）→ 显示警告'
);
const gapText = await page.locator('[data-permission-gap]').innerText().catch(() => '');
ok(gapText.includes('只读'), '警告文案点明「只读」', gapText.slice(0, 60));
ok(gapText.includes('无法') || gapText.includes('没有'), '警告文案说明「无法强制」的原因', gapText.slice(0, 80));
// 「DOM 里有」≠「用户看得见」：早先它放在底部预览卡片里，被输入框盖住，
// 断言照样通过但等于没有提示。这里要求它**不滚动就落在可视区内**。
{
  const box = await page.locator('[data-permission-gap]').boundingBox();
  const vp = page.viewportSize();
  const inView = !!box && !!vp && box.y >= 0 && box.y + box.height <= vp.height;
  ok(inView, '警告在首屏可视区内（未被裁切/遮挡）', box ? `y=${Math.round(box.y)} h=${Math.round(box.height)} vp=${vp?.height}` : '无 boundingBox');
}
await shot('scenario-permission-gap');
// 切回 workbuddy → 警告消失（证明它是跟着 Agent 能力实时算的，不是写死的）
await page.locator('[data-agent="workbuddy"]').click();
await page.waitForTimeout(400);
ok(
  (await page.locator('[data-permission-gap]').count()) === 0,
  '切回 WorkBuddy → 警告消失'
);

console.log('\n[6] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ').slice(0, 200));

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n✗ 场景入口 UI 断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`);
  process.exit(1);
}
console.log(`\n场景入口 UI 断言：${checks.total}/${checks.total} 通过`);
