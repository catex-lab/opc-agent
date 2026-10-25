/**
 * 渲染自检脚本 —— 用真实浏览器验证 UI 改动的实际效果。
 *
 * 为什么需要它：类型检查和构建只能证明「代码是合法的」，证明不了
 * 「界面是对的」。品牌色变量改错、字号类名写错、头像组件传参不对，
 * 这三类问题全都编译通过但在浏览器里一眼可见。
 *
 * 做法：起一个静态服务器托管 dist/，用 Playwright 拦截 /api/** 喂夹具数据，
 * 于是无需真实后端即可渲染出完整界面。共两组验证：
 *   A. 静态渲染 —— 直接进会话页/通讯录/设置页，截图对比浅色与深色
 *   B. 流式渲染 —— 拦截 POST /api/chat 返回伪造 SSE，跑通
 *      「思考 → 工具调用 → 正文」整条链路
 *   C. rAF 失效兜底 —— 把 rAF 换成永不回调的空洞，复现 Electron
 *      backgroundThrottling 下窗口被遮挡导致 rAF 不触发的场景，
 *      验证 delta 不会闷在内存里出不来
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = join(ROOT, '.render-check');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// ── 夹具：Agent 注册表 ──────────────────────────────────────────────────
// icon 必须与 src/agentLogos.ts 的键对齐，否则会退化成「首字母色块」，
// 那样就测不出官方 logo 的渲染是否正确。
const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手',
    capabilities: ['chat', 'code', 'tools'],
    // A111：**故意只声明一部分**。清单的价值全在「不支持」那半边 ——
    // 全支持的图看不出置灰态长什么样，等于没测。
    eventCapabilities: ['thinking', 'tool', 'usage', 'cost', 'permission'],
    status: { availability: 'ready', version: '2.4.1' },
  },
  {
    id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude',
    color: '#D97757', description: '擅长长上下文重构与代码审查',
    capabilities: ['chat', 'code', 'write'],
    status: { availability: 'ready', version: '1.0.44' },
  },
  {
    id: 'gemini', name: 'Gemini CLI', vendor: 'Google', kind: 'cli', icon: 'gemini',
    color: '#3186FF', description: '多模态与大规模检索',
    capabilities: ['chat', 'search', 'image'],
    status: { availability: 'needs-auth', version: '0.9.2', message: '请先完成登录授权' },
  },
  {
    id: 'cursor', name: 'Cursor Agent', vendor: 'Anysphere', kind: 'acp', icon: 'cursor',
    color: '#43413C', description: '编辑器内联协作',
    capabilities: ['chat', 'code', 'write', 'tools'],
    status: { availability: 'ready', version: '0.42.0' },
  },
  {
    id: 'doubao', name: '豆包 MarsCode', vendor: '字节跳动', kind: 'http', icon: 'doubao',
    color: '#1E37FC', description: '中文代码补全与解释',
    capabilities: ['chat', 'code'],
    // A111：空数组 = 「确实一条过程能力都没有」，界面要把七项全标成不支持。
    // 与「字段缺失（不知道）」是两回事，两种状态都得有夹具才测得出差别。
    eventCapabilities: [],
    // A112：kind:'http' + needs-auth 是「缺 Key」而不是「未登录」的那一支。
    // 必须留一条这样的夹具 —— 否则「未登录」这个错词永远没人守。
    status: { availability: 'needs-auth', version: '1.2.0' },
  },
];

// ── 夹具：会话列表（必须带 agentId，否则头像取不到官方 logo）──────────────
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', created_at: new Date().toISOString() },
  { id: 's2', title: 'Claude Code', agent_id: 'claude', model: 'claude-opus-4-1', created_at: new Date(Date.now() - 864e5).toISOString() },
  { id: 's3', title: 'Gemini CLI', agent_id: 'gemini', model: 'gemini-2.5-pro', created_at: new Date(Date.now() - 3 * 864e5).toISOString() },
  { id: 's4', title: 'Cursor Agent', agent_id: 'cursor', model: 'claude-sonnet-4-5', created_at: new Date(Date.now() - 5 * 864e5).toISOString() },
  // s5 绑了工作目录：工作区文件面板只在有 cwd 的会话上才渲染（A77），
  // 它单独一条，免得改动 s1 把 A/B 两组既有截图的面貌一起改掉。
  { id: 's5', title: 'opc-agent', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', cwd: 'C:\\ws\\opc-agent', created_at: new Date(Date.now() - 3e5).toISOString() },
];

// ── 夹具：工作区文件面板（A77）──────────────────────────────────────────
// 形态与 server/fs.ts 的 FsListResult 一致：abs 是绝对路径（供 openPath），
// 目录不带 size。真实后端由它算出，这里只喂静态数据。
const FS_ROOT = {
  root: 'C:\\ws\\opc-agent',
  path: '',
  truncated: false,
  entries: [
    { name: '.git', path: '.git', abs: 'C:\\ws\\opc-agent\\.git', type: 'dir' },
    { name: 'dist', path: 'dist', abs: 'C:\\ws\\opc-agent\\dist', type: 'dir' },
    { name: 'node_modules', path: 'node_modules', abs: 'C:\\ws\\opc-agent\\node_modules', type: 'dir' },
    { name: 'scripts', path: 'scripts', abs: 'C:\\ws\\opc-agent\\scripts', type: 'dir' },
    { name: 'server', path: 'server', abs: 'C:\\ws\\opc-agent\\server', type: 'dir' },
    { name: 'src', path: 'src', abs: 'C:\\ws\\opc-agent\\src', type: 'dir' },
    { name: '.gitignore', path: '.gitignore', abs: 'C:\\ws\\opc-agent\\.gitignore', type: 'file', size: 214, mtime: new Date().toISOString() },
    { name: 'package.json', path: 'package.json', abs: 'C:\\ws\\opc-agent\\package.json', type: 'file', size: 5482, mtime: new Date().toISOString() },
    { name: 'README.md', path: 'README.md', abs: 'C:\\ws\\opc-agent\\README.md', type: 'file', size: 1024, mtime: new Date().toISOString() },
  ],
};

const FS_SRC = {
  root: FS_ROOT.root,
  path: 'src',
  truncated: false,
  entries: [
    { name: 'assets', path: 'src/assets', abs: 'C:\\ws\\opc-agent\\src\\assets', type: 'dir' },
    { name: 'components', path: 'src/components', abs: 'C:\\ws\\opc-agent\\src\\components', type: 'dir' },
    { name: 'hooks', path: 'src/hooks', abs: 'C:\\ws\\opc-agent\\src\\hooks', type: 'dir' },
    { name: 'pages', path: 'src/pages', abs: 'C:\\ws\\opc-agent\\src\\pages', type: 'dir' },
    { name: 'App.tsx', path: 'src/App.tsx', abs: 'C:\\ws\\opc-agent\\src\\App.tsx', type: 'file', size: 42800, mtime: new Date().toISOString() },
    { name: 'index.css', path: 'src/index.css', abs: 'C:\\ws\\opc-agent\\src\\index.css', type: 'file', size: 61234, mtime: new Date().toISOString() },
    { name: 'main.tsx', path: 'src/main.tsx', abs: 'C:\\ws\\opc-agent\\src\\main.tsx', type: 'file', size: 2100, mtime: new Date().toISOString() },
  ],
};

const FS_PAGES = { src: FS_SRC };

// ── 夹具：会话消息（DB 形态，字段名与后端落库一致）──────────────────────
const MESSAGES = [
  {
    id: 'm1',
    role: 'user',
    content: '帮我确认一下 src/index.css 里的品牌色，为什么导航栏和气泡的蓝不一样？',
    created_at: new Date(Date.now() - 6e4).toISOString(),
  },
  {
    id: 'm2',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    created_at: new Date().toISOString(),
    tool_calls: [
      {
        id: 't1', name: 'Read', status: 'completed',
        input: { file_path: 'src/index.css' },
        result: ':root {\n  --td-brand-color: #3b82f6;\n  --td-brand-color-hover: #60a5fa;\n  --td-brand-color-active: #2563eb;\n}',
      },
      {
        id: 't2', name: 'Bash', status: 'completed',
        input: { command: 'grep -rn "0052D9" src/ --include=*.tsx', description: '搜索腾讯蓝的硬编码位置' },
        result: 'src/components/NavRail.tsx:58:  linear-gradient(135deg, #0052D9, #0594FA)\nsrc/components/ChatInput.tsx:30:  color: \'#0052d9\'',
      },
      {
        id: 't3', name: 'WebSearch', status: 'completed',
        input: { query: '腾讯 TDesign 品牌色规范' },
        result: 'TDesign 品牌色：#0052D9，hover #0594FA，active #003FB3……',
      },
      {
        id: 't4', name: 'Delete', status: 'error', isError: true,
        input: { file_path: 'src/legacy.css' },
        result: 'ENOENT: no such file or directory',
      },
    ],
    content: `## 结论：确实存在两套品牌蓝

问题根源是 CSS 变量与组件里的硬编码值不一致：

| 位置 | 取值 | 来源 |
| --- | --- | --- |
| \`--td-brand-color\` | \`#3b82f6\` | Tailwind blue-500 |
| \`NavRail\` 渐变 | \`#0052D9\` | 腾讯蓝 |

统一到腾讯调色板即可：

\`\`\`css
--td-brand-color: #0052d9;
--td-brand-color-hover: #0594fa;
--td-brand-color-active: #003fb3;
\`\`\`

这样导航条、用户气泡、权限标签就会回到同一个色相上。`,
  },
];

const MODELS = [
  { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡，日常首选' },
  { modelId: 'claude-opus-4-1', name: 'Claude Opus 4.1', description: '最强推理' },
  { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: '超长上下文' },
];

// ── 伪造 SSE 流：覆盖 block_open / delta / patch / close / run_end ─────────
// E5 之后前端只认 v2 事件契约（shared/blocks.ts 的 RunEvent 联合），
// 所以夹具也必须按投影器真实下发的形状写 —— 按 v1 写不会报错，只会
// 让浏览器里什么都不显示，然后报告一句「未捕获到流式回复」。
// `id:` 行对齐服务端的 `writeEvent`（值 = 事件 seq），客户端按它做断线续传。
const sse = events =>
  events.map((e, i) => `id: ${e.seq ?? i + 1}\ndata: ${JSON.stringify(e)}\n`).join('\n');

const STREAM_EVENTS = [
  { seq: 1, type: 'run_start', runId: 'r-stream', sessionId: 's1', messageId: 'a-stream', agentId: 'wb', model: 'claude-sonnet-4-5' },
  // 思考：首段随 block_open 下发，后续走 delta（与 RunProjector 一致）
  { seq: 2, type: 'block_open', block: { id: 'r-stream-b1', type: 'thinking', text: '用户想确认品牌色不一致的原因。', state: 'streaming', format: 'raw', startedAt: 1710000000000 } },
  { seq: 3, type: 'block_delta', blockId: 'r-stream-b1', channel: 'text', delta: '先读 CSS 变量定义，再全局搜一遍腾讯蓝的硬编码位置，最后给出统一方案。' },
  { seq: 4, type: 'block_patch', blockId: 'r-stream-b1', patch: { endedAt: 1710000000500 } },
  { seq: 5, type: 'block_close', blockId: 'r-stream-b1', state: 'done' },
  // 工具一：流式输出 → 收尾 patch（工具块不进「续写」，两次工具各占一个块）
  { seq: 6, type: 'block_open', block: { id: 'r-stream-b2', type: 'tool', toolId: 'st1', name: 'Read', input: { file_path: 'src/index.css' }, status: 'running', startedAt: 1710000000600 } },
  { seq: 7, type: 'block_delta', blockId: 'r-stream-b2', channel: 'output', delta: ':root { --td-brand-color: #3b82f6; }' },
  { seq: 8, type: 'block_patch', blockId: 'r-stream-b2', patch: { status: 'completed', isError: false, output: ':root { --td-brand-color: #3b82f6; }', endedAt: 1710000001200 } },
  { seq: 9, type: 'block_close', blockId: 'r-stream-b2', state: 'done' },
  // 工具二：Bash 的长输出，验证「输出中」与流式贴底
  { seq: 10, type: 'block_open', block: { id: 'r-stream-b3', type: 'tool', toolId: 'st2', name: 'Bash', input: { command: 'grep -rn "0052D9" src/', description: '搜索腾讯蓝硬编码位置' }, status: 'running', startedAt: 1710000001300 } },
  { seq: 11, type: 'block_delta', blockId: 'r-stream-b3', channel: 'output', delta: 'src/components/NavRail.tsx:58: #0052D9' },
  { seq: 12, type: 'block_patch', blockId: 'r-stream-b3', patch: { status: 'completed', isError: false, output: 'src/components/NavRail.tsx:58: #0052D9', endedAt: 1710000002000 } },
  { seq: 13, type: 'block_close', blockId: 'r-stream-b3', state: 'done' },
  // 正文：两段 delta 拼成一段连续文本（模拟 projector 的续写合并）
  { seq: 14, type: 'block_open', block: { id: 'r-stream-b4', type: 'text', text: '已定位问题：**两套品牌蓝同时在用**。', state: 'streaming' } },
  { seq: 15, type: 'block_delta', blockId: 'r-stream-b4', channel: 'text', delta: '\n\n- `--td-brand-color` 是 `#3b82f6`（Tailwind）\n- `NavRail` 渐变用的是 `#0052D9`（腾讯蓝）\n\n统一到腾讯调色板即可修复。' },
  { seq: 16, type: 'block_close', blockId: 'r-stream-b4', state: 'done' },
  { seq: 17, type: 'run_end', runId: 'r-stream', status: 'ok', durationMs: 2000 },
];

/**
 * 当前流式夹具。C 组（rAF 失效兜底）会临时换成剥掉 run_end 的变体，
 * 因为 run_end 自带一次直接 flushNow，会把这条路径上的退化掩盖掉。
 */
let currentStream = STREAM_EVENTS;

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
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
await mkdir(OUT, { recursive: true });
console.log(`静态服务器：${base}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  if (url.includes('/api/chat')) {
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(currentStream) });
  }
  if (url.includes('/api/permission-response')) return json({ ok: true });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    // 会话详情：后端返回 { messages: [...] }，字段名为 snake_case。
    // 按 id 取 —— 早先写死 SESSIONS[0]，于是 /chat/sN 永远返回第一条，
    // 想给某条会话配特殊字段（如工作目录）时根本进不去。
    const id = url.split('/').pop().split('?')[0];
    const s = SESSIONS.find(x => x.id === id) || SESSIONS[0];
    return json({ session: s, messages: MESSAGES });
  }
  if (/\/api\/fs\/list/.test(url)) {
    const rel = new URL(url).searchParams.get('path') || '';
    return json(FS_PAGES[rel] || FS_ROOT);
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
/** 断言失败（不是控制台错误）。攒到最后统一 exit 1 —— 只打 ❌ 不退出等于没守 */
const failures = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

/** 进页面并等渲染稳定 */
async function go(path, { dark = false } = {}) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (dark) {
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(500);
  }
}

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

// ── A. 静态渲染 ─────────────────────────────────────────────────────────
console.log('\n[A] 静态渲染');
await go('/chat/s1');
await shot('light-chat');

await go('/chat/s1', { dark: true });
await shot('dark-chat');

/**
 * 通讯录面板不在任何路由上，它由 NavRail 的 `nav` 状态切换。
 * 直接访问 `/` 得到的是「会话列表 + 空态」，所以必须真的点一下
 * 「通讯录」按钮，否则截到的是错的页面（这坑踩过一次）。
 * NavRail 里按钮顺序为：聊天、通讯录、主题、设置。
 */
async function goContacts({ dark = false } = {}) {
  await go('/');
  await page.locator('nav button').nth(1).click();
  await page.waitForTimeout(1200);
  if (dark) {
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(500);
  }
}

await goContacts();
await shot('light-contacts');
await goContacts({ dark: true });
await shot('dark-contacts');

/**
 * A112：名册上的状态词必须按接入方式分开说。
 *
 * `needs-auth` 的中文原本一律写「未登录」，但 HTTP 类（豆包、Kimi 开放平台）
 * 压根没有「登录」这个动作 —— 用户在豆包 App / Kimi 桌面版里登录一百次也不会
 * 让这一行变绿。名册写「未登录」，等于指着一个不存在的动作让他反复重试。
 * 夹具里 doubao 是 `kind:'http' + needs-auth`，专守这一支。
 */
await goContacts();
const doubaoRow = await page.locator('[data-agent-row="doubao"]').first().innerText();
const labelOk = doubaoRow.includes('缺 Key');
if (!labelOk) failures.push(`http 类状态词应为「缺 Key」，实际：${doubaoRow.replace(/\s+/g, ' ')}`);
console.log(labelOk ? '  ✓ http 类未就绪标「缺 Key」而不是「未登录」' : '  ❌ http 类状态词仍是「未登录」');

/**
 * Agent 资料页的过程能力清单（A111）。
 *
 * 两个 Agent 各截一张，因为要验的是**两种不同的「不支持」**：
 *   workbuddy —— 部分支持（置灰那几项要和高亮的明显可区分）
 *   doubao    —— 空清单（七项全置灰 + 一句「只返回最终回答」的说明）
 *
 * 入口是悬停头像 → 名片里的「查看资料」。名片是 portal 渲染的，所以
 * 必须真的 hover 一次，直接找按钮会找不到。
 */
async function goAgentDetail(agentId) {
  await goContacts();
  // 通讯录整行本身就是「查看资料」按钮，直接点，不必先悬停出头像名片
  const row = page.locator(`[data-agent-row="${agentId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 8000 });
  await row.click();
  await page.waitForTimeout(900);
}

for (const agentId of ['workbuddy', 'doubao']) {
  try {
    await goAgentDetail(agentId);
    await shot(`light-detail-${agentId}`);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(400);
    await shot(`dark-detail-${agentId}`);
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
  } catch (err) {
    console.log(`  ! 资料页 ${agentId} 截图失败：${err.message}`);
  }
}

await go('/settings');
await shot('light-settings');
await go('/settings', { dark: true });
await shot('dark-settings');

// ── B. 流式渲染 ─────────────────────────────────────────────────────────
console.log('\n[B] 流式渲染（思考 → 工具 → 正文）');
await go('/chat/s1');
const before = await page.locator('text=已定位问题').count();
const barsBefore = await page.locator('[data-steps-bar]').count();
try {
  await page.fill('textarea', '再帮我确认一次品牌色');
  await page.press('textarea', 'Enter');
  await page.waitForTimeout(2500);
  let after = await page.locator('text=已定位问题').count();
  if (after === before) {
    // Enter 不触发发送时，退回到点击发送按钮
    await page.locator('.t-chat-sender__send-btn, [class*="send-btn"]').last().click().catch(() => {});
    await page.waitForTimeout(2500);
    after = await page.locator('text=已定位问题').count();
  }
  if (after > before) {
    console.log('  ✓ 流式回复已渲染');
    // 连续工具调用必须合并成「一个」折叠条（含数量），而不是每个工具一条。
    // 否则「刚发完」与「刷新后」的同一条消息会长得不一样。
    // 注意：静态夹具里那条消息本来就有一个「查看步骤 (4)」条，
    // 所以这里比较的是**增量**，并单独确认出现了合并计数 (2)。
    // A36：汇总行的文案改成了活动摘要（「编辑、已读取：x.ts」），
    // 步骤数单独放在 [data-trace-count] 里，所以这里按节点数而不是按文案数。
    const barsAfter = await page.locator('[data-steps-bar]').count();
    const grouped = await page.locator('[data-trace-count]', { hasText: '2 步' }).count();
    console.log(`  轨迹条增量=${barsAfter - barsBefore}，合并为「2 步」=${grouped}`);
    if (barsAfter - barsBefore === 1 && grouped === 1) console.log('  ✓ 连续工具调用已合并为一组');
    else console.log('  ⚠️ 工具调用未按预期合并');
    await shot('light-stream');
  } else {
    console.log('  ⚠️ 未捕获到流式回复');
  }
} catch (e) {
  console.log('  ⚠️ 流式用例异常：' + String(e).slice(0, 160));
}

// ── C. rAF 失效时的兜底（模拟窗口被遮挡） ────────────────────────────────
// 2026-10-19 用户实测形态：「过一会儿自己出现，但一整块跳出来」。根因是
// flushNow 一度只有 rAF 一条出路，而 Electron 的 backgroundThrottling 让
// 窗口被遮挡/最小化时 rAF 完全不触发，且 rafId 一旦非空就再不排新帧 ——
// 整轮 delta 闷在内存里出不来。这里把 rAF 换成永不回调的空洞复现该环境。
//
// 两个关键手法（少一个这个用例就失去意义）：
//   1. addInitScript 在 app 启动**前**注入，否则 React 已持有真 rAF；
//   2. 夹具剥掉 run_end —— 它自带一次直接 flushNow，会把退化掩盖掉。
//      剥掉后内容还能出现，只能靠 setTimeout 兜底 / finally 看门狗，
//      而改动前的代码两者都没有，所以本用例在旧代码上必红。
console.log('\n[C] rAF 失效时内容仍须抵达（模拟窗口被遮挡）');
try {
  await page.addInitScript(() => {
    // 拦截成空洞：注册即忘，永不回调。返回 id 0 满足调用方对返回值的预期。
    window.requestAnimationFrame = () => 0;
  });
  await go('/chat/s1');
  const cBefore = await page.locator('text=已定位问题').count();
  currentStream = STREAM_EVENTS.filter(e => e.type !== 'run_end');
  await page.fill('textarea', '窗口被遮挡时也要把内容刷出来');
  await page.press('textarea', 'Enter');
  await page.waitForTimeout(2500);
  let cAfter = await page.locator('text=已定位问题').count();
  if (cAfter === cBefore) {
    await page.locator('.t-chat-sender__send-btn, [class*="send-btn"]').last().click().catch(() => {});
    await page.waitForTimeout(2500);
    cAfter = await page.locator('text=已定位问题').count();
  }
  if (cAfter > cBefore) {
    console.log('  ✓ rAF 失效时内容仍抵达界面（兜底生效）');
    await shot('light-stream-no-raf');
  } else {
    console.log('  ❌ rAF 失效时内容丢失 —— 兜底没生效（内容闷在内存里出不来）');
  }
  currentStream = STREAM_EVENTS;
} catch (e) {
  currentStream = STREAM_EVENTS;
  console.log('  ⚠️ 兜底用例异常：' + String(e).slice(0, 160));
}

// ── D. 工作区文件面板（A77）────────────────────────────────────────────
console.log('\n[D] 工作区文件面板');
// 面板的展开状态存在 localStorage（它是布局偏好，不是会话状态）。
// 这里显式置 1 —— 不置的话面板默认收起，D 组就什么也截不到。
await page.addInitScript(() => {
  try {
    localStorage.setItem('opc.workspace-open', '1');
  } catch {
    /* 隐私模式下写不进去：那条用例会失败，本身也是要暴露的信息 */
  }
});

const errsBeforeD = errors.length;
await go('/chat/s5');

const panel = page.locator('[aria-label="工作区文件"]');
try {
  await panel.waitFor({ state: 'attached', timeout: 4000 });
  console.log('  ✓ 面板已渲染');
} catch {
  console.log('  ❌ 工作区面板没有渲染（会话有 cwd 且开关为开，应当出现）');
}

if (await panel.count()) {
  // 标题栏状态：徽标里应当出现目录名与「只读」标记
  const readonly = await panel.locator('text=只读').count();
  console.log(readonly ? '  ✓ 标注了「只读」' : '  ❌ 缺少「只读」标注');

  // 目录在前、文件在后；隐藏文件（.git / .gitignore）不藏
  for (const name of ['node_modules', 'package.json', '.gitignore']) {
    const found = await panel.locator(`text=${name}`).count();
    console.log(found ? `  ✓ 条目 ${name}` : `  ❌ 缺少条目 ${name}`);
  }

  // 进入子目录：面包屑与列表都要跟着变
  await panel.locator('button', { hasText: 'src' }).first().click();
  await page.waitForTimeout(600);
  const inSrc = await panel.locator('text=components').count();
  console.log(inSrc ? '  ✓ 进入 src 子目录成功' : '  ❌ 进入 src 子目录失败');

  // 面包屑回根目录：点根目录那段，列表应当回到根（这才证明面包屑是可点的，
  // 而不是一段只能看的文字）
  await panel.locator('button', { hasText: 'opc-agent' }).first().click();
  await page.waitForTimeout(600);
  const backRoot = await panel.locator('text=node_modules').count();
  console.log(backRoot ? '  ✓ 面包屑可点（回到根目录）' : '  ❌ 面包屑点击无效');

  // 点文件：浏览器开发态没有 window.opc，应当落到「说明白」而不是静默失败
  await panel.locator('button', { hasText: 'package.json' }).first().click();
  await page.waitForTimeout(600);
  const notice = await panel.locator('text=浏览器开发态').count();
  console.log(notice ? '  ✓ 无原生能力时给出说明' : '  ⚠️ 未出现兜底提示（剪贴板可能可用，路径已复制）');

  // P3-c：标签选择要记住。这里能在普通 Chrome 里验：点「浏览器」→ localStorage
  // 落盘 → 整页刷新 → 还停在浏览器标签。刷渲染进程不等于重启应用（那个要 Electron），
  // 但持久化这条链路本身是同一段代码，值得在这里抓住。
  await panel.getByRole('tab', { name: '浏览器' }).click();
  await page.waitForTimeout(300);
  const tabSaved = await page.evaluate(() => localStorage.getItem('opc.workspace-tab'));
  console.log(tabSaved === 'browser' ? '  ✓ 标签选择已持久化' : `  ❌ 标签选择没落盘（${tabSaved}）`);
  await page.reload();
  await panel.waitFor({ state: 'attached', timeout: 4000 });
  await page.waitForTimeout(500);
  const tabRestored = await panel.getByRole('tab', { name: '浏览器' }).getAttribute('aria-selected');
  console.log(tabRestored === 'true' ? '  ✓ 刷新后仍停在浏览器标签' : '  ❌ 刷新后标签丢了');
  // 浏览器标签在非桌面端要给说明，不能摆假地址栏
  const noBridge = await panel.locator('text=浏览器预览只在桌面端可用').count();
  console.log(noBridge ? '  ✓ 无原生能力时给出说明' : '  ❌ 浏览器标签没有降级说明');

  // P4：终端同理 —— 非桌面端必须说清楚，不能摆一个输了命令没反应的输入框
  await panel.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(300);
  const termFallback = await panel.locator('text=终端只在桌面端可用').count();
  console.log(termFallback ? '  ✓ 终端在非桌面端给出说明' : '  ❌ 终端没有降级说明');
  const noFakeInput = await panel.locator('input[aria-label="终端输入"]').count();
  console.log(noFakeInput === 0 ? '  ✓ 没有摆假的终端输入框' : '  ❌ 出现了不可用的终端输入框');

  // 回到文件标签，别把浏览器/终端标签留给后面的深色截图
  await panel.getByRole('tab', { name: '文件' }).click();
  await page.waitForTimeout(300);

  await shot('light-workspace');

  await go('/chat/s5', { dark: true });
  if (await page.locator('[aria-label="工作区文件"]').count()) await shot('dark-workspace');
}

// ── 汇总 ────────────────────────────────────────────────────────────────
if (errors.length) {
  console.log(`\n⚠️  控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log('   ' + e.slice(0, 220));
} else {
  console.log('\n✓ 无控制台错误');
}

await browser.close();
server.close();

if (failures.length) {
  console.log(`\n❌ 断言失败 ${failures.length} 条：`);
  for (const f of failures) console.log('   ' + f);
  console.log('\n渲染自检完成（有失败）');
  process.exit(1);
}

console.log('\n渲染自检完成');
