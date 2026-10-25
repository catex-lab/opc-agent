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
import { readFile, readdir, mkdir } from 'node:fs/promises';
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


// ── G. 关闭按钮位置 + 自定义 Agent 对话框（A114）────────────────────
// 两条用户反馈：
//   1. 「设置页右上角的关闭按钮往右上角适当调整，现在的位置不协调」
//   2. 「增加用户自建联系人 agent，用户可以通过其他平台的 api 来实现」
// 都是**位置 / 交互**问题，必须真派发事件、真量坐标。
console.log('\n[G] 关闭按钮位置 / 自定义 Agent 对话框');
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/').pop().split('?')[0];
    const s = SESSIONS.find(x => x.id === id) || SESSIONS[0];
    return json({ session: s, messages: MESSAGES });
  }
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  // 创建接口按「缺字段」回 400，用来验前端的错误展示路径
  if (url.includes('/api/agents/custom')) {
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '请填写 API 地址' }) });
  }
  return json({});
});
const page = await ctx.newPage();
const errors = [];
const failures = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

// ── G1. 关闭按钮位置 ────────────────────────────────────────────────
try {
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const btn = document.querySelector('[data-settings-close]');
    const panel = document.querySelector('[data-settings-modal] > div:nth-child(2)');
    if (!btn || !panel) return null;
    const b = btn.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    // 按钮自身有 translate(9px,-8px)，getBoundingClientRect 拿到的是**变换后**
    // 的位置，所以这里量的就是用户眼里看到的那一处
    return { fromTop: Math.round(b.top - p.top), fromRight: Math.round(p.right - b.right) };
  });
  if (!m) {
    failures.push('拿不到设置弹窗或关闭按钮');
    console.log('  ❌ 拿不到设置弹窗或关闭按钮');
  } else {
    // 目标 (14, 16)：弹窗圆角 16px，收进这个位置才落在弧线的顺势处。
    // 原来是 (22, 25) —— 与标题行对齐，结果是悬在标题旁边、离圆角还有一段。
    const topOk = m.fromTop === 14;
    const rightOk = m.fromRight === 16;
    if (!topOk || !rightOk) failures.push(`关闭按钮位置不对：距顶 ${m.fromTop}px、距右 ${m.fromRight}px（期望 14 / 16）`);
    console.log(topOk && rightOk
      ? `  ✓ 关闭按钮收进弹窗圆角  [距顶 ${m.fromTop}px / 距右 ${m.fromRight}px]`
      : `  ❌ 关闭按钮位置 [距顶 ${m.fromTop}px / 距右 ${m.fromRight}px，期望 14 / 16]`);
  }
} catch (e) {
  failures.push('关闭按钮用例异常：' + String(e).slice(0, 160));
  console.log('  ⚠️ 关闭按钮用例异常：' + String(e).slice(0, 160));
}

// ── G2. 自定义 Agent 对话框 ─────────────────────────────────────────
try {
  // 通讯录是**左侧导航的一项**（NavRail 的 'contacts'），不是路由 ——
  // 直接 goto('/contacts') 只会落到默认的「聊天」栏。
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('button[aria-label="通讯录"]').click();
  await page.waitForTimeout(900);
  // 展开右上角「+」菜单
  await page.locator('button[aria-label="添加"]').click();
  await page.waitForTimeout(250);
  const menuItem = page.locator('[data-contacts-custom-agent]');
  const hasItem = (await menuItem.count()) === 1;
  if (!hasItem) failures.push('「+」菜单里没有「自定义 Agent」项');
  console.log(hasItem ? '  ✓ 「+」菜单有「自定义 Agent」项' : '  ❌ 「+」菜单缺「自定义 Agent」项');

  await menuItem.click();
  await page.waitForTimeout(400);
  const dlg = page.locator('[data-custom-agent-dialog]');
  const opened = (await dlg.count()) === 1;
  if (!opened) failures.push('点了菜单项后对话框没打开');
  console.log(opened ? '  ✓ 对话框打开' : '  ❌ 对话框没打开');

  if (opened) {
    await page.screenshot({ path: join(OUT, 'a114-custom-agent-dialog.png') });
    // 四个字段都在
    for (const f of ['name', 'baseUrl', 'model', 'apiKey']) {
      const n = await page.locator(`[data-custom-field="${f}"] input`).count();
      if (n === 0) failures.push(`缺字段 ${f}`);
    }
    const fieldCount = await page.locator('[data-custom-field]').count();
    console.log(fieldCount === 4 ? '  ✓ 四个字段齐全' : `  ❌ 字段数 = ${fieldCount}`);

    // 示例芯片：点一下要把地址和模型名填进去
    await page.locator('button:has-text("DeepSeek")').first().click();
    await page.waitForTimeout(200);
    const filled = await page.evaluate(() => {
      const get = k => document.querySelector(`[data-custom-field="${k}"] input`)?.value ?? '';
      return { baseUrl: get('baseUrl'), model: get('model') };
    });
    const chipOk = filled.baseUrl === 'https://api.deepseek.com/v1' && filled.model === 'deepseek-chat';
    if (!chipOk) failures.push(`示例芯片没填对：${JSON.stringify(filled)}`);
    console.log(chipOk ? '  ✓ 示例芯片填充地址与模型名' : `  ❌ 示例芯片 [${JSON.stringify(filled)}]`);

    // 空表单提交 → 后端 400 → 前端把 error 显示出来（不能静默）
    await page.locator('[data-custom-field="name"] input').fill('测试自建');
    await page.locator('[data-custom-agent-submit]').click();
    await page.waitForTimeout(500);
    const errVisible = (await page.locator('[data-custom-agent-error]').count()) === 1;
    if (!errVisible) failures.push('提交失败时没有展示错误提示');
    console.log(errVisible ? '  ✓ 失败时有错误提示' : '  ❌ 没有错误提示');

    // Esc 关闭
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const closed = (await page.locator('[data-custom-agent-dialog]').count()) === 0;
    if (!closed) failures.push('Esc 没能关掉对话框');
    console.log(closed ? '  ✓ Esc 关闭对话框' : '  ❌ Esc 没关掉');
  }
} catch (e) {
  failures.push('自定义 Agent 用例异常：' + String(e).slice(0, 160));
  console.log('  ⚠️ 自定义 Agent 用例异常：' + String(e).slice(0, 160));
}

if (errors.length) {
  console.log(`\n⚠️  控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 6)) console.log('   ' + e.slice(0, 200));
}
if (failures.length) {
  console.log(`\n❌ 断言失败 ${failures.length} 条：`);
  for (const f of failures) console.log('   ' + f);
}
console.log('\nA114 交互验证完成' + (failures.length ? '（有失败）' : ''));
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
