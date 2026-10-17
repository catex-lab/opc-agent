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
    id: 'doubao', name: '豆包 MarsCode', vendor: '字节跳动', kind: 'cli', icon: 'doubao',
    color: '#1E37FC', description: '中文代码补全与解释',
    capabilities: ['chat', 'code'],
    status: { availability: 'needs-setup', version: '1.2.0' },
  },
];

// ── 夹具：会话列表（必须带 agentId，否则头像取不到官方 logo）──────────────
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', created_at: new Date().toISOString() },
  { id: 's2', title: 'Claude Code', agent_id: 'claude', model: 'claude-opus-4-1', created_at: new Date(Date.now() - 864e5).toISOString() },
  { id: 's3', title: 'Gemini CLI', agent_id: 'gemini', model: 'gemini-2.5-pro', created_at: new Date(Date.now() - 3 * 864e5).toISOString() },
  { id: 's4', title: 'Cursor Agent', agent_id: 'cursor', model: 'claude-sonnet-4-5', created_at: new Date(Date.now() - 5 * 864e5).toISOString() },
];

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

// ── 伪造 SSE 流：覆盖 thinking / tool / tool_result / text / done ────────
// 字段名必须严格对齐 server/index.ts 实际下发的形状：
//   tool        → { type, id, name, input, status }
//   tool_result → { type, toolId, content, isError }
// 之前这里误写成 toolId/toolName，导致 tool.name 为 undefined，
// 触发下游 toLowerCase 崩溃、整屏白屏 —— 夹具写错会伪装成产品缺陷。
const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n`).join('\n');

const STREAM_EVENTS = [
  { type: 'init', sessionId: 's1', assistantMessageId: 'a-stream', model: 'claude-sonnet-4-5' },
  { type: 'thinking', content: '用户想确认品牌色不一致的原因。先读 CSS 变量定义，再全局搜一遍腾讯蓝的硬编码位置，最后给出统一方案。' },
  { type: 'tool', id: 'st1', name: 'Read', input: { file_path: 'src/index.css' }, status: 'running' },
  { type: 'tool_result', toolId: 'st1', content: ':root { --td-brand-color: #3b82f6; }', isError: false },
  { type: 'tool', id: 'st2', name: 'Bash', input: { command: 'grep -rn "0052D9" src/', description: '搜索腾讯蓝硬编码位置' }, status: 'running' },
  { type: 'tool_result', toolId: 'st2', content: 'src/components/NavRail.tsx:58: #0052D9', isError: false },
  { type: 'text', content: '已定位问题：' },
  { type: 'text', content: '**两套品牌蓝同时在用**。' },
  { type: 'text', content: '\n\n- `--td-brand-color` 是 `#3b82f6`（Tailwind）\n- `NavRail` 渐变用的是 `#0052D9`（腾讯蓝）\n\n统一到腾讯调色板即可修复。' },
  { type: 'done' },
];

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
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(STREAM_EVENTS) });
  }
  if (url.includes('/api/permission-response')) return json({ ok: true });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    // 会话详情：后端返回 { messages: [...] }，字段名为 snake_case
    return json({ session: SESSIONS[0], messages: MESSAGES });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
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

await go('/settings');
await shot('light-settings');
await go('/settings', { dark: true });
await shot('dark-settings');

// ── B. 流式渲染 ─────────────────────────────────────────────────────────
console.log('\n[B] 流式渲染（思考 → 工具 → 正文）');
await go('/chat/s1');
const before = await page.locator('text=已定位问题').count();
const barsBefore = await page.getByText('查看步骤', { exact: false }).count();
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
    const barsAfter = await page.getByText('查看步骤', { exact: false }).count();
    const grouped = await page.locator('text="(2)"').count();
    console.log(`  折叠条增量=${barsAfter - barsBefore}，合并计数(2)=${grouped}`);
    if (barsAfter - barsBefore === 1 && grouped === 1) console.log('  ✓ 连续工具调用已合并为一组');
    else console.log('  ⚠️ 工具调用未按预期合并');
    await shot('light-stream');
  } else {
    console.log('  ⚠️ 未捕获到流式回复');
  }
} catch (e) {
  console.log('  ⚠️ 流式用例异常：' + String(e).slice(0, 160));
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
console.log('\n渲染自检完成');
