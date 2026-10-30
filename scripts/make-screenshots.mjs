/**
 * 生成 README 用的界面截图。
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂示例数据。
 * 之所以不用真实服务端，是因为截图一旦含真实对话、本机路径或桌面内容，
 * 就会随仓库一起公开 —— 这个项目的历史上已经踩过一次（.render-check 里的
 * 整屏截图被 filter-repo 清掉了）。夹具里的数据全部是编的。
 *
 * 运行：npm run build && node scripts/make-screenshots.mjs
 * 输出：docs/screenshots/*.png
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'docs', 'screenshots');

/** Chrome 路径：环境变量优先，其次各平台常见位置 */
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find(p => existsSync(p));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// ── 示例数据（全部虚构）─────────────────────────────────────────────

const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手',
    capabilities: ['chat', 'code', 'tools'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', kind: 'cli', icon: 'codex',
    color: '#10A37F', description: '擅长重构与长上下文推理',
    capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '0.51.0' },
    permissionSupport: { enforced: ['default', 'acceptEdits'] },
  },
  {
    id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude',
    color: '#D97757', description: '擅长长上下文重构与代码审查',
    capabilities: ['chat', 'code', 'write'],
    status: { availability: 'ready', version: '1.0.44' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan'] },
  },
  {
    id: 'gemini', name: 'Gemini CLI', vendor: 'Google', kind: 'cli', icon: 'gemini',
    color: '#4285F4', description: '多模态与大规模检索',
    capabilities: ['chat', 'search'],
    status: { availability: 'needs-auth', version: '0.9.2' },
    permissionSupport: { enforced: ['default'] },
  },
];

const MODELS = [
  { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' },
  { modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: '快' },
];

const T0 = Date.now();

const SESSIONS = [
  {
    id: 's-direct', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5',
    kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date(T0 - 36e5).toISOString(),
  },
  {
    id: 's-group', title: '重构用户模块', agent_id: 'workbuddy', model: 'claude-sonnet-4-5',
    kind: 'group', agent_ids: ['codex', 'claude'], orchestration: 'dispatch',
    created_at: new Date(T0 - 72e5).toISOString(),
  },
];

const ASK = '这个项目的测试跑得有点慢，帮我看看瓶颈在哪';

const ANSWER = [
  '我看了 `scripts/` 下的 126 个验证脚本，瓶颈不在断言本身，而在**重复启动服务端**。',
  '',
  '### 结论',
  '',
  '每个 `verify-*.mjs` 都自己 `spawn` 一次 `server/index.ts`，冷启动要 1.5–2s。',
  '主链串行跑 76 段，光是起停就占了三分之二的时间。',
  '',
  '### 建议',
  '',
  '- 把服务端提到链的外层，各段只传 `base` 地址进来',
  '- 每段之间的 `taskkill` 改成复用同一进程',
  '- 独立 `OPC_DATA_DIR` 保留，段与段之间清库即可，不必重启',
  '',
  '按这个改，主链大概能从 12 分钟压到 4 分钟以内。',
].join('\n');

const MESSAGES = [
  {
    id: 'm1', session_id: 's-direct', role: 'user', content: ASK,
    created_at: new Date(T0 - 3e5).toISOString(),
  },
  {
    id: 'm2', session_id: 's-direct', role: 'assistant', content: ANSWER,
    model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy',
    created_at: new Date(T0 - 2e5).toISOString(), duration_ms: 47_000,
    blocks: [
      { id: 'b1', type: 'thinking', text: '先看主链是怎么组织的，再量一下每段的耗时分布。', state: 'done', format: 'raw' },
      {
        id: 'b2', type: 'tool', toolId: 't1', name: 'Read', status: 'completed',
        input: { path: 'package.json' }, output: '126 条 scripts',
        startedAt: T0 - 1.8e5, endedAt: T0 - 1.7e5,
      },
      {
        id: 'b3', type: 'tool', toolId: 't2', name: 'Grep', status: 'completed',
        input: { pattern: 'spawn\\(' }, output: '76 处命中',
        startedAt: T0 - 1.6e5, endedAt: T0 - 1.5e5,
      },
      { id: 'b4', type: 'text', text: ANSWER, state: 'done' },
    ],
  },
  {
    id: 'g1', session_id: 's-group', role: 'user',
    content: '重构用户模块：Codex 负责后端接口拆分，Claude 负责补测试',
    created_at: new Date(T0 - 6e5).toISOString(),
  },
  {
    id: 'g2', session_id: 's-group', role: 'assistant',
    content: [
      '后端拆完了，`users.ts` 按职责分成 `users.query.ts` / `users.mutate.ts` / `users.types.ts`。',
      '',
      '三个路由的行为没变，只是把 SQL 从路由里挪进了仓储层。改完 `tsc -b` 是干净的。',
    ].join('\n'),
    model: 'gpt-5-codex', author_agent_id: 'codex',
    created_at: new Date(T0 - 4e5).toISOString(), duration_ms: 132_000,
  },
  {
    id: 'g3', session_id: 's-group', role: 'assistant',
    content: [
      '接口拆完之后我补了 14 条测试，覆盖仓储层的边界：',
      '',
      '- 空结果与 `null` 要分开（前者返回 `[]`，后者抛错）',
      '- 并发改同一条记录时后写的覆盖先写的，这一点按现有行为钉住了',
      '',
      '有一个旧用例原本断言的是「返回 undefined」，实际一直是 `[]` —— 那条是错的，我改了断言并在提交信息里写明。',
    ].join('\n'),
    model: 'claude-sonnet-4-5', author_agent_id: 'claude',
    created_at: new Date(T0 - 1e5).toISOString(), duration_ms: 98_000,
  },
];

// ── 静态服务 ────────────────────────────────────────────────────────

if (!existsSync(DIST)) {
  console.error('找不到 dist/ —— 先跑 npm run build');
  process.exit(1);
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

const chrome = findChrome();
if (!chrome) {
  console.error('找不到 Chrome —— 用 CHROME_PATH 指定可执行文件路径');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];

async function newPage(initScript) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) return json({ runs: [] });
    if (url.includes('/api/chat')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
    }
    if (url.includes('/api/permission-response')) return json({ ok: true });
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS, defaultModel: 'claude-sonnet-4-5' });
    if (/\/api\/agents\/[^/]+\/models/.test(url)) {
      const id = url.split('/api/agents/')[1].split('/')[0];
      return json({
        models: id === 'workbuddy' ? MODELS : [],
        defaultModel: 'claude-sonnet-4-5',
        source: id === 'workbuddy' ? 'catalog' : 'unknown',
        selectable: id === 'workbuddy',
      });
    }
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/api/sessions/')[1].split('?')[0];
      return json({
        session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0],
        messages: MESSAGES.filter(m => m.session_id === id),
      });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    if (url.includes('/api/projects')) return json({ projects: [] });
    if (url.includes('/api/tasks')) return json({ tasks: [] });
    return json({});
  });
  return { ctx, page };
}

/** 等页面真的画完：网络静默 + 再给一拍给 CSS 过渡 */
async function settle(page, url) {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
}

const shots = [];

// 1. 通讯录（`/` 默认落在会话列表，要点左侧导航切过去）
{
  const { ctx, page } = await newPage();
  await settle(page, '/');
  await page.click('[aria-label="通讯录"]');
  await page.waitForTimeout(700);
  const file = join(OUT, '01-contacts.png');
  await page.screenshot({ path: file });
  shots.push(file);
  await ctx.close();
}

// 2. 单聊（含执行轨迹）
{
  const { ctx, page } = await newPage();
  await settle(page, '/chat/s-direct');
  const file = join(OUT, '02-chat.png');
  await page.screenshot({ path: file });
  shots.push(file);
  await ctx.close();
}

// 3. 群聊（两个 Agent 各回一段）
{
  const { ctx, page } = await newPage();
  await settle(page, '/chat/s-group');
  const file = join(OUT, '03-group.png');
  await page.screenshot({ path: file });
  shots.push(file);
  await ctx.close();
}

// 4. 设置 → 模型清单（展示「模型从哪来」这个能力，比空白的外观页有信息量）
//
// 不用「关于与隐私」：那一页的版本行来自 Electron preload 的
// window.opc.appInfo()，纯浏览器里没有 ⇒ 会降级成「正在读取构建信息…」。
// 试着注入过 window.opc，但它是终端/浏览器预览共用的一座桥，
// 桥存在而方法缺失会让设置页直接崩 —— 不值得为一行版本号冒这个险。
{
  const { ctx, page } = await newPage();
  await settle(page, '/settings');
  await page.click('[data-settings-section="permission"]');
  await page.waitForTimeout(900);
  const file = join(OUT, '04-settings.png');
  await page.screenshot({ path: file });
  shots.push(file);
  await ctx.close();
}

await browser.close();
server.close();

if (errors.length) {
  console.log(`\n⚠ 页面有 ${errors.length} 个未捕获异常：`);
  for (const e of errors.slice(0, 5)) console.log('   ', e.slice(0, 160));
}

console.log('\n截图已生成：');
for (const f of shots) console.log('  ', f.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
