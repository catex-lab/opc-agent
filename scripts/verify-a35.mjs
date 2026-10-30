/**
 * A35 十一条反馈的浏览器验证。
 *
 *   [1] 顶部不再有「正在输入…」
 *   [2] 消息头部：logo + Agent 名，正文另起一行
 *   [3] 执行过程不再是卡片（步骤时间线）
 *   [4] 模型 / 权限选择器点击不描边
 *   [5] 输入框附件：菜单两项 / 选中出 chip / 清空
 *   [6] 右键选区：拦下原生菜单并浮出「复制 / 引用」
 *   [7] 滑杆：两根默认刻度 / 拖动出数值气泡 / 统一恢复默认含透明度
 *   [8] 群设置：底部按钮钉在面板底边（不漂移）+ 移出入口可见
 *   [9] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a35.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
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
  {
    id: 'hermes', name: 'Hermes', vendor: 'Nous', kind: 'acp', icon: 'hermes',
    color: '#7C5CFF', description: '长任务编排', capabilities: ['chat'],
    status: { availability: 'ready', version: '0.9.0' },
    permissionSupport: { enforced: ['default'] },
  },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
  { id: 's2', title: '研发小组', agent_id: null, model: null, kind: 'group', agent_ids: '["workbuddy","hermes"]', orchestration: 'relay', created_at: new Date().toISOString() },
];

const now = Date.now();
const ANSWER = '这是回答的第一行文字，用来量一下它和 logo 的相对位置。\n\n第二段继续说明。';

const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '看看目录', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: ANSWER, model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [
      { id: 'b1', type: 'thinking', text: '先看看环境。', state: 'done', format: 'raw', startedAt: now - 5000, endedAt: now - 3000 },
      { id: 'b2', type: 'tool', toolId: 't1', name: 'Bash', status: 'completed', input: { command: 'ls', description: '列出目录' }, output: 'a\nb', startedAt: now - 2500, endedAt: now - 1300 },
      { id: 'b3', type: 'text', text: ANSWER, state: 'done' },
    ],
  },
  { id: 'm3', session_id: 's2', role: 'user', content: '群里问一句', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm4', session_id: 's2', role: 'assistant', content: '群聊回答。', model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [{ id: 'b4', type: 'text', text: '群聊回答。', state: 'done' }],
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

const ATTACH_FILE = join(ROOT, '.tmp', 'a35-attach.txt');
await writeFile(ATTACH_FILE, 'attachment fixture\n', 'utf8');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const url = req.url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
    if (url.includes('/api/permission-response')) return json({ ok: true });
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
  return { ctx, page };
}

// ============= [1] 顶部不再有「正在输入…」 =============
console.log('\n[1] 会话头部不再有「正在输入…」');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const text = await page.evaluate(() => document.body.innerText);
  ok(!text.includes('正在输入'), '页面文字里没有「正在输入」', text.includes('正在输入') ? '仍存在' : '已移除');
  ok(text.includes('WorkBuddy'), '头部仍显示会话名（删的只是那枚假徽标）');
  await ctx.close();
}

// ============= [2] 消息头部：logo + Agent 名，正文换行 =============
console.log('\n[2] 消息头部：logo + Agent 名，正文另起一行');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const geo = await page.evaluate(() => {
    const header = document.querySelector('[data-msg-header]');
    const answer = document.querySelector('.tc-answer');
    if (!header || !answer) return { missing: true };
    const h = header.getBoundingClientRect();
    const a = answer.getBoundingClientRect();
    return {
      missing: false,
      text: header.innerText,
      headerBottom: h.bottom,
      answerTop: a.top,
      headerLeft: h.left,
      answerLeft: a.left,
      headerHasAvatar: !!header.querySelector('[data-agent-avatar]'),
    };
  });
  ok(!geo.missing, '消息头部与正文都存在');
  if (!geo.missing) {
    ok(geo.headerHasAvatar, '头部里有 Agent logo');
    ok(geo.text.includes('WorkBuddy'), 'logo 后面是 Agent 名（不是模型名）', geo.text.replace(/\n/g, ' '));
    ok(!geo.text.includes('Claude Sonnet'), '模型名退到次要位置（不与名字争主位）');
    ok(geo.answerTop >= geo.headerBottom - 1, '正文在头部下方（不再与 logo 同一行）', `answerTop ${Math.round(geo.answerTop)} ≥ headerBottom ${Math.round(geo.headerBottom)}`);
    ok(Math.abs(geo.answerLeft - geo.headerLeft) < 2, '正文与头部左对齐（整宽）', `${Math.round(geo.answerLeft)} vs ${Math.round(geo.headerLeft)}`);
  }
  await ctx.close();
}

// ============= [3] 执行过程去卡片化 =============
console.log('\n[3] 执行过程：步骤时间线，不再是卡片');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // 默认折叠，点汇总行展开
  const bar = page.locator('[data-steps-bar]');
  if (await bar.count()) await bar.first().click();
  await page.waitForTimeout(300);

  const shape = await page.evaluate(() => {
    const step = document.querySelector('[data-tool-step]');
    if (!step) return { missing: true };
    const cs = getComputedStyle(step);
    return {
      missing: false,
      dot: !!step.querySelector('.tc-step-dot'),
      cards: step.querySelectorAll('.tc-card').length,
      bg: cs.backgroundColor,
      radius: cs.borderTopLeftRadius,
    };
  });
  ok(!shape.missing, '存在步骤节点');
  if (!shape.missing) {
    ok(shape.dot, '每个步骤有状态圆点');
    ok(shape.cards === 0, '步骤内部没有卡片容器（.tc-card 数为 0）', String(shape.cards));
    ok(shape.bg === 'rgba(0, 0, 0, 0)', '步骤行本身透明（没有底色方块）', shape.bg);
    ok(shape.radius === '0px', '步骤行没有圆角卡片外形', shape.radius);
  }

  await page.screenshot({ path: join(OUT, 'a35-steps.png'), fullPage: false });
  await ctx.close();
}

// ============= [4] 选择器点击不描边 =============
console.log('\n[4] 模型 / 权限选择器：点击不描边');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const read = () => page.evaluate(() => {
    const el = document.querySelector('[data-permission-mode-select] .t-input')
      || document.querySelector('[data-permission-mode-select] .t-select__wrap')
      || document.querySelector('[data-permission-mode-select]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { border: cs.borderColor, shadow: cs.boxShadow, outline: cs.outlineStyle };
  });

  const before = await read();
  ok(!!before, '找到权限选择器');

  const trigger = page.locator('[data-permission-mode-select]').first();
  await trigger.click();
  await page.waitForTimeout(350);
  const after = await read();

  ok(!!after, '点击后仍能读到选择器');
  if (before && after) {
    ok(after.border === before.border, '点击后边框颜色不变（没有品牌色描边）', `${after.border}`);
    ok(after.shadow === 'none' || after.shadow === before.shadow, '没有多出焦点光晕', after.shadow);
    ok(after.outline === 'none' || after.outline === before.outline, '没有浏览器焦点环', after.outline);
  }
  await page.keyboard.press('Escape');
  await ctx.close();
}

// ============= [5] 附件按钮 =============
console.log('\n[5] 输入框附件：菜单 / chip / 清空');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const toggle = page.locator('[data-attach-toggle]');
  ok(await toggle.count() === 1, '输入框里有附件按钮');

  await toggle.click();
  await page.waitForTimeout(250);
  const menu = await page.evaluate(() => {
    const m = document.querySelector('[data-attach-menu]');
    if (!m) return null;
    return {
      kinds: [...m.querySelectorAll('[data-attach-kind]')].map(b => b.getAttribute('data-attach-kind')),
      text: m.innerText,
    };
  });
  ok(!!menu, '点开有菜单');
  if (menu) {
    ok(menu.kinds.includes('file') && menu.kinds.includes('folder'), '菜单含「文件」与「文件夹」两项', menu.kinds.join(','));
    ok(/图片/.test(menu.text) && /文档/.test(menu.text) && /视频/.test(menu.text), '文件项写明支持图片 / 文档 / 视频');
  }

  await page.setInputFiles('[data-attach-input="file"]', ATTACH_FILE);
  await page.waitForTimeout(300);
  const chips = await page.evaluate(() => {
    const box = document.querySelector('[data-attachments]');
    if (!box) return null;
    return [...box.querySelectorAll('[data-attachment]')].map(el => ({
      name: el.getAttribute('data-attachment'),
      kind: el.getAttribute('data-attachment-kind'),
    }));
  });
  ok(!!chips && chips.length === 1, '选中文件后出现 1 颗附件 chip', JSON.stringify(chips));
  if (chips && chips[0]) ok(chips[0].kind === 'file', 'chip 标了类型', chips[0].kind);

  await page.locator('[data-attach-clear]').click();
  await page.waitForTimeout(200);
  ok(await page.locator('[data-attachments]').count() === 0, '「清空」后附件条消失');
  await ctx.close();
}

// ============= [5b] 附件随消息发出 =============
console.log('\n[5b] 附件随消息发出（端到端）');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  await page.setInputFiles('[data-attach-input="file"]', ATTACH_FILE);
  await page.waitForTimeout(250);

  const ta = page.locator('textarea').first();
  await ta.fill('看下这个附件');
  await page.waitForTimeout(150);
  await page
    .locator('t-chat-sender button, [class*="chat-input__actions"] button')
    .last()
    .click({ timeout: 5000 });
  await page.waitForTimeout(900);

  const sent = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.tc-bubble-user')];
    const last = bubbles[bubbles.length - 1];
    return last ? last.innerText : null;
  });
  ok(!!sent && sent.includes('看下这个附件'), '用户气泡带着正文发出', String(sent).slice(0, 40));
  ok(!!sent && /\[附件\]/.test(sent), '消息里带上 [附件] 段');
  ok(!!sent && sent.includes('a35-attach.txt'), '附件路径进了消息（Agent 可直接读）', String(sent).slice(-60));
  ok(await page.locator('[data-attachments]').count() === 0, '发送后附件条自动清空');
  await ctx.close();
}

// ============= [5c] A93：粘贴剪贴板图片 =============
/**
 * 用户在输入区按 Ctrl+V 粘一张截图，应该直接变成附件 chip。
 *
 * 这里能守的是**事件层**：粘贴事件被输入区接管（`defaultPrevented`），
 * 且纯文字粘贴不拦。落盘那一半（`window.opc.savePastedImage` → 主进程写
 * 临时文件）在浏览器里没有 `window.opc`，只能走失败分支 —— 而失败分支
 * 恰恰也该断言：不能静默吞掉，必须给一句提示。
 *
 * 成功路径靠真 Electron 端到端验证（探针见 HANDOFF 的 A93 条目）：
 * 真主进程 + 真 preload + 真 IPC，断言「返回值是路径 / 文件真的存在 /
 * 字节一致 / chip 的 kind=image / chip 指向的文件存在」。
 */
console.log('\n[5c] A93：粘贴剪贴板图片');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  /* paste 是 composed 事件，监听挂在 <t-chat-sender> 宿主上也能收到
     —— 但**合成事件必须自己带 `composed: true`**，否则它不会穿过
     shadow 边界，宿主上的监听器收不到，探针会误判成「没接管」。 */
  const pasteImage = () =>
    page.evaluate(() => {
      const el = document.querySelector('t-chat-sender');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'shot.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
  const pasteText = () =>
    page.evaluate(() => {
      const el = document.querySelector('t-chat-sender');
      const dt = new DataTransfer();
      dt.setData('text/plain', '粘贴的纯文字');
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });

  ok(await pasteImage(), '粘贴图片时输入区接管事件（不落到默认行为）');

  /* 浏览器态没有 window.opc：必须给出可读提示，而不是「按了没反应」。
     提示条 4 秒后自动消失，所以这里读完就立刻断言。 */
  await page.waitForTimeout(300);
  const note = await page.locator('[data-paste-note]').first().textContent().catch(() => null);
  ok(!!note && note.trim().length > 0, '无桥接时给出提示（不静默失败）', note ? note.trim().slice(0, 40) : 'null');
  ok(await page.locator('[data-attachments]').count() === 0, '落盘失败时不产生半截 chip');

  ok(!(await pasteText()), '粘贴纯文字不拦截（照常进 textarea）');
  await ctx.close();
}

// ============= [6] 右键选区 =============
console.log('\n[6] 右键选区：拦下原生菜单并浮出工具条');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const res = await page.evaluate(() => {
    // 正文在 ChatMarkdown 的 shadow DOM 里，必须选到里面的文本节点 ——
    // 选外层自定义元素时 Selection.toString() 是空串，组件会当成「没有选区」。
    const host = document.querySelector('.chat-markdown t-chat-md-content');
    const sr = host && host.shadowRoot;
    if (!sr) return { missing: true, reason: 'no shadowRoot' };
    const walker = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT);
    let node = null;
    while ((node = walker.nextNode())) {
      if ((node.textContent || '').trim().length > 8) break;
    }
    if (!node) return { missing: true, reason: 'no text node' };
    const raw = node.textContent;
    const lead = raw.length - raw.trimStart().length;
    const range = document.createRange();
    range.setStart(node, lead);
    range.setEnd(node, lead + Math.min(8, raw.trim().length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const rect = range.getBoundingClientRect();
    const ev = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, composed: true,
      clientX: Math.round(rect.left + 6), clientY: Math.round(rect.top + 6), button: 2,
    });
    // 在 host 上派发（它在 light DOM 里），事件能正常冒泡到 document
    const notCanceled = host.dispatchEvent(ev);
    return { missing: false, notCanceled, text: sel.toString(), x: Math.round(rect.left + 6) };
  });
  ok(!res.missing, '找到正文块');
  ok(res.notCanceled === false, '右键被拦下（原生菜单不会盖住工具条）', String(res.notCanceled));

  await page.waitForTimeout(250);
  const bar = await page.evaluate(() => {
    const el = document.querySelector('[data-selection-toolbar]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText, top: r.top, left: r.left, visible: r.width > 0 && r.height > 0 };
  });
  ok(!!bar && bar.visible, '工具条出现在页面上');
  if (bar) {
    ok(/复制/.test(bar.text) && /引用/.test(bar.text), '工具条含「复制 / 引用」', bar.text.replace(/\n/g, ' '));
    ok(Math.abs(bar.left - res.x) < 120, '工具条跟着鼠标位置出现（不是固定角落）', `left ${Math.round(bar.left)} vs click ${res.x}`);
  }
  await page.screenshot({ path: join(OUT, 'a35-contextmenu.png') });
  await ctx.close();
}

// ============= [7] 滑杆：刻度 / 气泡 / 统一恢复默认 =============
console.log('\n[7] 滑杆：默认刻度 + 拖动数值 + 统一恢复默认');
{
  const { ctx, page } = await newPage();
  // A66 起光斑默认关闭，两根光斑滑杆只在开关打开时渲染。这组要数「三个滑杆」
  // 与两根默认刻度，所以先种一份「已打开」的偏好（等价于用户去过设置页）。
  await ctx.addInitScript(() => {
    localStorage.setItem('opc.glow', JSON.stringify({ enabled: true, size: null, brightness: null }));
  });
  await page.goto(base + '/settings?glass=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const ranges = await page.evaluate(() =>
    [...document.querySelectorAll('input[type="range"]')].map(el => el.getAttribute('aria-label'))
  );
  ok(ranges.length >= 3, '三个滑杆都在', ranges.join(' / '));
  ok(ranges.includes('界面透明度') && ranges.includes('光斑大小') && ranges.includes('光斑亮度'), '透明度 / 大小 / 亮度齐全');

  const ticks = await page.evaluate(() =>
    [...document.querySelectorAll('[data-range-tick]')].map(el => ({
      label: el.getAttribute('data-range-tick'),
      left: el.style.left,
    }))
  );
  ok(ticks.length === 2, '光斑两个滑杆各有一根默认刻度', JSON.stringify(ticks));
  ok(ticks.every(t => t.left && t.left !== '0%'), '刻度落在默认值处（不是端点）');

  // 拖动 = 聚焦 + 改值；气泡只在拖动 / 聚焦时出现
  const size = page.locator('input[aria-label="光斑大小"]');
  await size.focus();
  await size.fill('600');
  await page.waitForTimeout(250);
  const bubble = await page.evaluate(() => {
    const el = document.querySelector('[data-range-bubble="光斑大小"]');
    return el ? el.innerText.trim() : null;
  });
  ok(bubble === '600px', '拖动时浮出精确数值气泡', String(bubble));

  const bright = page.locator('input[aria-label="光斑亮度"]');
  await bright.focus();
  await bright.fill('150');
  await page.waitForTimeout(250);
  const bubble2 = await page.evaluate(() => {
    const el = document.querySelector('[data-range-bubble="光斑亮度"]');
    return el ? el.innerText.trim() : null;
  });
  ok(bubble2 === '150%', '亮度滑杆也有数值气泡', String(bubble2));

  await page.screenshot({ path: join(OUT, 'a35-sliders.png') });

  // 把透明度也弄脏，再点统一的「恢复默认」
  const tr = page.locator('input[aria-label="界面透明度"]');
  await tr.focus();
  await tr.fill('80');
  await page.waitForTimeout(250);
  const trBubble = await page.evaluate(() => {
    const el = document.querySelector('[data-range-bubble="transparency"]');
    return el ? el.innerText.trim() : null;
  });
  ok(trBubble === '80%', '透明度滑杆也有数值气泡', String(trBubble));

  await page.locator('[data-ui-prefs-reset]').click();
  await page.waitForTimeout(350);

  const after = await page.evaluate(() => ({
    tr: document.querySelector('input[aria-label="界面透明度"]')?.value,
    size: document.querySelector('input[aria-label="光斑大小"]')?.value,
    bright: document.querySelector('input[aria-label="光斑亮度"]')?.value,
    inlineSize: document.documentElement.style.getPropertyValue('--tc-glow-size').trim(),
    inlineBright: document.documentElement.style.getPropertyValue('--tc-glow-brightness').trim(),
    stored: localStorage.getItem('opc.glow'),
  }));
  ok(after.tr === '28', '「恢复默认」把界面透明度一起还原（28）', String(after.tr));
  ok(after.size === '440' && after.bright === '100', '两个光斑参数也回到设计值', `${after.size} / ${after.bright}`);
  ok(after.inlineSize === '' && after.inlineBright === '', '光斑内联值被移除（跟随主题）', `${after.inlineSize}|${after.inlineBright}`);
  ok(!/size":\s*\d/.test(after.stored || ''), '落盘里 size 已清成 null', String(after.stored));
  await ctx.close();
}

// ============= [8] 群设置：两个危险操作竖排、跟着内容滚 + 移出入口 =============
console.log('\n[8] 群设置：危险操作竖排且跟随内容滚动');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 成员栏的移出按钮要在**打开群设置之前**数：面板打开时成员栏让位
  // （同一块右栏位置只放一个），关掉才回来。
  //
  // ⚠️ A72 起成员栏默认折叠，此时 `[data-remove-member]` 根本不在 DOM 里
  // （折叠态只渲染 10px 悬停热区）。所以先点展开再数 —— 否则这里数到 0，
  // 看起来像「移出按钮被删了」，其实只是面板没收开。
  const expandBtn35 = page.locator('[aria-label="展开群成员"]');
  if (await expandBtn35.count()) {
    await expandBtn35.click();
    await page.waitForTimeout(450); // 等展开动画结束
  }
  const panelRemove = await page.evaluate(
    () => document.querySelectorAll('[data-remove-member]').length
  );
  ok(panelRemove >= 2, '右侧成员栏每位成员都有移出按钮', String(panelRemove));
  const opacity = await page.evaluate(() => {
    const el = document.querySelector('[data-remove-member]');
    return el ? Number(getComputedStyle(el).opacity) : null;
  });
  ok(opacity !== null && opacity >= 0.4, '成员栏的移出按钮常驻可见（不再完全透明）', String(opacity));

  await page.locator('[data-chat-more]').first().click();
  await page.waitForTimeout(500);

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('[data-group-settings] aside');
    const clear = document.querySelector('[data-clear-messages]');
    const exit = document.querySelector('[data-exit-group]');
    const notify = document.querySelector('[data-notify-trigger]');
    const footer = document.querySelector('[data-settings-footer]');
    if (!panel || !clear || !exit || !notify || !footer) return null;
    const p = panel.getBoundingClientRect();
    const c = clear.getBoundingClientRect();
    const e = exit.getBoundingClientRect();
    const n = notify.getBoundingClientRect();
    const f = footer.getBoundingClientRect();
    const scroller = panel.querySelector('div.overflow-y-auto');
    return {
      clear: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) },
      exit: { x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height) },
      notifyBottom: Math.round(n.bottom),
      footerPosition: getComputedStyle(footer).position,
      scrollable: !!scroller && scroller.scrollHeight > scroller.clientHeight + 1,
      footerVisible: f.top >= p.top - 1 && f.bottom <= p.bottom + 1,
    };
  });

  ok(!!layout, '群设置面板与两个操作按钮都在');
  if (layout) {
    // 2026-10-20 用户反馈：不要并列、不要钉在底边，要竖排并跟到「群消息设置」之后
    ok(
      layout.footerPosition !== 'sticky' && layout.footerPosition !== 'fixed',
      '操作区不再钉在面板底边（跟随内容滚动）',
      layout.footerPosition
    );
    ok(
      Math.abs(layout.clear.x - layout.exit.x) <= 1,
      '两个按钮左边缘对齐（同一列，不是并排）',
      `clear.x=${layout.clear.x} exit.x=${layout.exit.x}`
    );
    ok(
      layout.exit.y >= layout.clear.y + layout.clear.h,
      '两个按钮上下排列（「退出群聊」在「删除聊天记录」下方）',
      `clear.y=${layout.clear.y}+${layout.clear.h} exit.y=${layout.exit.y}`
    );
    ok(
      layout.clear.y >= layout.notifyBottom,
      '按钮组落在「群消息设置」下方',
      `notify.bottom=${layout.notifyBottom} clear.y=${layout.clear.y}`
    );
    // 需要往下滚才看得到：内容超出一屏时，按钮初始不能落在可视区内
    ok(
      layout.footerVisible === !layout.scrollable,
      layout.scrollable ? '内容超一屏时按钮不在首屏（要滚动才看到）' : '内容未超一屏时按钮直接可见',
      `scrollable=${layout.scrollable} visible=${layout.footerVisible}`
    );
  }

  // 滚到底：按钮真的能出现
  const scrolled = await page.evaluate(() => {
    const panel = document.querySelector('[data-group-settings] aside');
    const scroller = panel?.querySelector('div.overflow-y-auto');
    if (!scroller) return null;
    scroller.scrollTop = scroller.scrollHeight;
    return scroller.scrollTop;
  });
  await page.waitForTimeout(250);
  const exitVisible = await page.evaluate(() => {
    const panel = document.querySelector('[data-group-settings] aside');
    const exit = document.querySelector('[data-exit-group]');
    if (!panel || !exit) return null;
    const p = panel.getBoundingClientRect();
    const e = exit.getBoundingClientRect();
    return e.top >= p.top - 1 && e.bottom <= p.bottom + 1;
  });
  ok(scrolled !== null, '找到面板滚动容器');
  ok(exitVisible === true, '滚到底后「退出群聊」完整可见', String(exitVisible));

  const settingsRemove = await page.evaluate(
    () => document.querySelectorAll('[data-settings-remove-member]').length
  );
  ok(settingsRemove >= 2, '群设置里每位成员都有移出入口', String(settingsRemove));

  await page.screenshot({ path: join(OUT, 'a35-group-settings.png') });
  await ctx.close();
}

// ============= [9] 控制台 =============
console.log('\n[9] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ') || '0 条');

await browser.close();
server.close();

console.log(`\n结果：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
