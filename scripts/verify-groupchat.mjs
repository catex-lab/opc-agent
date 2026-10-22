/**
 * 群聊房间 UI 验证（稳定回归，不打真实后端、不碰真实 Agent）。
 *
 * 覆盖四块：
 *   [1] 群聊头部：PanelHeader 规格 + 成员头像堆叠 + 人数徽标 + 编排模式入口
 *   [2] 多作者气泡：两个 Agent 各按自己的头像与作者名渲染（夹具数据）
 *   [3] 输入框：@ 成员 chip 条、插入提及、发送键可用性
 *   [4] 真 SSE 流：伪造 /api/group-chat 事件流驱动 useGroupChat，验证
 *       turn 气泡归位、group_note 居中弱化渲染、流式状态收尾
 *
 * ## 三条探针铁律（都是踩过的坑，别改回去）
 *
 * 1. **读正文必须穿透 shadow DOM**。ChatMarkdown 是 web component，气泡
 *    正文在它的 shadowRoot 里，`document.body.innerText` 看不到 —— 拿
 *    innerText 断言气泡内容会全数假失败。用 deepText() 递归走 shadowRoot。
 *
 * 2. **头像不能按 src 正则 `/hermes|opencode/` 找**。Vite 会把 < 4KB 的
 *    资源内联成 data URI（opencode.svg 只有 577B），文件式 URL 只剩
 *    hermes/qoder/workbuddy 这几个大块头。断言「两个作者用了各自的官方
 *    logo」应该比对 img 的 src 值互异，而不是匹配文件名。
 *
 * 3. **group_note 只能用假 SSE 流测**。叙述行只进前端内存不落库，夹具
 *    数据永远造不出 note 行；刷新后重放也不会出现。唯一诚实的测法是
 *    伪造一条带 group_note 的事件流，真的走一遍 useGroupChat。
 */
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const CHROME = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
try {
  await access(join(ROOT, 'dist', 'index.html'));
} catch {
  console.error('缺少 dist/index.html，先 npm run build');
  process.exit(2);
}

// ── 夹具 ────────────────────────────────────────────────────────────
const AGENTS = [
  {
    id: 'hermes', name: 'Hermes', vendor: 'Nous Research', kind: 'acp', icon: 'hermes',
    color: '#5F5E5A', description: '多 provider 网关型 Agent',
    capabilities: ['chat', 'code', 'tools', 'image', 'search'],
    status: { availability: 'ready', version: '0.21.6' },
  },
  {
    id: 'opencode', name: 'OpenCode', vendor: 'SST', kind: 'cli', icon: 'opencode',
    color: '#10A37F', description: '多 provider CLI',
    capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '2.0.25' },
  },
];
const GID = 'grp-e2e-1';
const SESSION = {
  id: GID, title: 'Hermes、OpenCode', agent_id: null, kind: 'group',
  agent_ids: JSON.stringify(['hermes', 'opencode']), orchestration: 'dispatch',
  model: '', created_at: new Date().toISOString(),
};
const MESSAGES = [
  {
    id: 'u1', role: 'user', content: '用一句话说明什么是多智能体协作',
    author_agent_id: null, created_at: new Date(Date.now() - 6e4).toISOString(),
  },
  {
    id: 'a1', role: 'assistant', content: '多智能体协作是多个自主 Agent 分工协同完成复杂任务。',
    author_agent_id: 'opencode', model: 'zai/glm-4.7',
    created_at: new Date(Date.now() - 4e4).toISOString(),
  },
  {
    id: 'a2', role: 'assistant', content: '补充上一个维度：还可以按层级式、对等式、流水线式分类。',
    author_agent_id: 'hermes', model: null, created_at: new Date().toISOString(),
  },
];

/**
 * 伪造的群聊 SSE 流。
 *
 * 事件形状严格对齐 server/index.ts 的 /api/group-chat 与 useGroupChat 的
 * 消费契约：text/group_note 的载荷字段名分别是 content 和 text（不是
 * delta），turn_done 必须带 messageId 否则前端只做兜底收尾。
 *
 * 场景选 dispatch：同一段流里 hermes 先产出路由判断、随后 opencode 产出
 * 执行正文 —— 正好验证「同一 Agent 多个 turn 按当前 turn 归位」以及
 * group_note 的居中弱化渲染。
 */
const SSE_BODY = [
  { type: 'group_init', sessionId: GID, orchestration: 'dispatch', members: AGENTS, userMessageId: 'u2' },

  // 第一棒：hermes 路由判断
  { type: 'run_start', seq: 1, runId: 'r-h1', sessionId: GID, messageId: 'sse-h1', agentId: 'hermes', model: 'm', phase: 'route' },
  { type: 'block_open', seq: 2, runId: 'r-h1', block: { id: 'h1-b1', type: 'text', text: '', state: 'streaming' } },
  { type: 'block_delta', seq: 3, runId: 'r-h1', blockId: 'h1-b1', channel: 'text', delta: '主控正在判断该交给谁' },
  { type: 'block_close', seq: 4, runId: 'r-h1', blockId: 'h1-b1', state: 'done' },
  { type: 'turn_done', agentId: 'hermes', messageId: 'sse-h1', runId: 'r-h1' },

  { type: 'group_note', text: '路由判断：交给 OpenCode 处理代码问题' },

  // 第二棒：opencode 执行
  { type: 'run_start', seq: 1, runId: 'r-o1', sessionId: GID, messageId: 'sse-o1', agentId: 'opencode', model: 'm', phase: 'work' },
  { type: 'block_open', seq: 2, runId: 'r-o1', block: { id: 'o1-b1', type: 'text', text: '', state: 'streaming' } },
  { type: 'block_delta', seq: 3, runId: 'r-o1', blockId: 'o1-b1', channel: 'text', delta: 'SSE 流式正文渲染成功。' },
  { type: 'block_close', seq: 4, runId: 'r-o1', blockId: 'o1-b1', state: 'done' },
  { type: 'turn_done', agentId: 'opencode', messageId: 'sse-o1', runId: 'r-o1' },

  { type: 'done' },
].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

const QUESTION = '请说明什么是多智能体协作';

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = p === '/' ? 'index.html' : p;
  let file = join(ROOT, 'dist', f), body;
  try {
    body = await readFile(file);
  } catch {
    // SPA 回退：/chat/:id 这类前端路由必须落到 index.html
    file = join(ROOT, 'dist', 'index.html');
    body = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

let chatCalls = 0;
await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  // 假 SSE 流：完整事件体一次性交付，客户端按 \n\n 分帧消费
  if (url.includes('/api/group-chat') && route.request().method() === 'POST') {
    chatCalls++;
    return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: SSE_BODY });
  }
  if (/\/api\/agents\/[^/]+\/models/.test(url)) return json({ models: [] });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: [], defaultModel: null });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    // GET 返夹具；PATCH（编排模式持久化）收下即可
    if (route.request().method() === 'PATCH') return json({ ok: true });
    return json({ session: SESSION, messages: MESSAGES });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: [SESSION] });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
};

/** 穿透 shadow DOM 的文本收集（铁律 1） */
const DEEP_TEXT = () => {
  const walk = (n, out) => {
    if (!n) return out;
    if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t); return out; }
    if (n.shadowRoot) walk(n.shadowRoot, out);
    for (const c of n.childNodes || []) walk(c, out);
    return out;
  };
  return walk(document.body, []).join(' ');
};

await page.goto(`${base}/chat/${GID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// ── [1] 群聊头部 ────────────────────────────────────────────────────
console.log('\n[1] 群聊头部');
check('标题显示群名', await page.locator('text=Hermes、OpenCode').count() > 0);
check('群名后带人数「（2）」', /（2）/.test(await page.evaluate(DEEP_TEXT)));
check('徽标显示「2 在线」', /2 在线/.test(await page.evaluate(DEEP_TEXT)));
check('编排模式入口显示「分派」', await page.locator('text=分派').count() > 0);
check('副标题含模式说明', /主控 Agent 判断该谁做/.test(await page.evaluate(DEEP_TEXT)));
const h1 = await page.locator('h1').first().evaluate(el => {
  const cs = getComputedStyle(el);
  return { fontSize: cs.fontSize, fontWeight: cs.fontWeight };
}).catch(() => null);
check('标题字号/字重符合 PanelHeader 规范（16px/600，compact 单行）',
  !!h1 && h1.fontSize === '16px' && h1.fontWeight === '600', JSON.stringify(h1));

// 头像堆叠：两个成员都是真实图片且互异（铁律 2：不按文件名匹配，比 src 值）
const stack = await page.evaluate(() => {
  const out = { hermes: null, opencode: null };
  for (const img of document.querySelectorAll('img')) {
    const title = img.closest('[title]')?.getAttribute('title') || '';
    if (title.startsWith('Hermes') && !out.hermes) out.hermes = img.getAttribute('src');
    if (title.startsWith('OpenCode') && !out.opencode) out.opencode = img.getAttribute('src');
  }
  return out;
});
check('头部堆叠里 Hermes 头像是真实图片', !!stack.hermes, String(stack.hermes).slice(0, 40));
check('头部堆叠里 OpenCode 头像是真实图片', !!stack.opencode, String(stack.opencode).slice(0, 40));
check('两个成员的 logo 互不相同（data URI 也参与比对）',
  !!stack.hermes && !!stack.opencode && stack.hermes !== stack.opencode);

// ── [2] 多作者气泡（夹具） ───────────────────────────────────────────
console.log('\n[2] 多作者气泡');
const rows = await page.evaluate(() => {
  const deep = (n, out) => {
    if (!n) return out;
    if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t); return out; }
    if (n.shadowRoot) deep(n.shadowRoot, out);
    for (const c of n.childNodes || []) deep(c, out);
    return out;
  };
  const list = document.querySelector('div.flex.flex-col.gap-6.max-w-3xl.mx-auto');
  if (!list) return [];
  return Array.from(list.children).map(row => {
    const pill = row.querySelector(':scope > span.rounded-full');
    if (pill) return { kind: 'note', text: pill.textContent, centered: row.classList.contains('justify-center') };
    const col = row.querySelector(':scope > div.flex.flex-col');
    if (!col) return { kind: 'other', classes: row.className };
    // A35：作者名从「气泡列内的一行小字」提到了消息头部（logo 后面），
    // 所以标签要从 [data-msg-header] 里读；用户行没有头部，标签仍为 null。
    const header = row.querySelector(':scope > [data-msg-header]');
    const label = (header
      ? header.querySelector('[data-msg-agent]')?.textContent
      : col.querySelector(':scope > span.text-caption')?.textContent)?.trim() ?? null;
    const bubble = col.querySelector('.tc-bubble-assistant, .tc-bubble-user');
    const text = bubble ? deep(bubble, []).join(' ') : '';
    const img = row.querySelector('img');
    return {
      kind: 'msg',
      classes: row.className,
      label,
      text,
      avatarSrc: img ? img.getAttribute('src') : null,
    };
  });
});
const byLabel = rows.filter(r => r.kind === 'msg');
const oc = byLabel.find(r => r.label === 'OpenCode');
const hm = byLabel.find(r => r.label === 'Hermes');
const usr = byLabel.find(r => r.label === null);
check('OpenCode 气泡带作者名标签', !!oc);
check('OpenCode 气泡正文正确（穿透 shadow DOM 读取）',
  !!oc && /多智能体协作是多个自主 Agent/.test(oc.text), oc?.text?.slice(0, 30));
check('Hermes 气泡带作者名标签', !!hm);
check('Hermes 气泡正文正确',
  !!hm && /补充上一个维度/.test(hm.text), hm?.text?.slice(0, 30));
check('两个作者的 logo 互不相同',
  !!oc && !!hm && !!oc.avatarSrc && !!hm.avatarSrc && oc.avatarSrc !== hm.avatarSrc);
check('用户气泡在右侧且不带作者标签',
  !!usr && /flex-row-reverse/.test(usr.classes || '') && /多智能体协作/.test(usr.text || ''));

// ── [3] 输入框 ──────────────────────────────────────────────────────
console.log('\n[3] 输入框');
check('@ 成员 chip 条可见', await page.locator('text=@ 成员').count() > 0);
// 用 data-mention-name 定位 chip，不要用文字或 title ——
// 群名现在是个可点击改名的按钮，而群名就是成员名拼接（「Hermes、OpenCode」），
// 按文字找会先命中群名按钮；title 又会随「已 @ / 未 @」变化。
const chipHermes = page.locator('button[data-mention-name="Hermes"]');
const chipOpencode = page.locator('button[data-mention-name="OpenCode"]');
check('Hermes 与 OpenCode 的 chip 都在',
  (await chipHermes.count()) === 1 && (await chipOpencode.count()) === 1,
  `hermes=${await chipHermes.count()} opencode=${await chipOpencode.count()}`);
const ta = page.locator('textarea').first();
const st = await ta.evaluate(el => ({ disabled: el.disabled, readOnly: el.readOnly }));
check('发送键未被禁用（群聊无单一模型可选）',
  st.disabled === false && st.readOnly === false, JSON.stringify(st));
await chipHermes.click();
await page.waitForTimeout(200);
const mentioned = await ta.inputValue().catch(() => '');
check('点击 chip 插入 @提及', /@Hermes/.test(mentioned), JSON.stringify(mentioned));
check('插入后 chip 变为「已选」', (await chipHermes.getAttribute('aria-pressed')) === 'true');

// 再点一次 = 取消（chip 看起来就是个开关，按下去必须能弹起来）
await chipHermes.click();
await page.waitForTimeout(200);
const removed = await ta.inputValue().catch(() => '');
check('再次点击取消 @ 提及', !/@Hermes/.test(removed), JSON.stringify(removed));
check('取消后 chip 回到未选', (await chipHermes.getAttribute('aria-pressed')) === 'false');

// 点回来，后面的流程按「带 @ 的输入」继续
await chipHermes.click();
await page.waitForTimeout(200);

// ── [4] 真 SSE 流驱动 useGroupChat ──────────────────────────────────
console.log('\n[4] 真 SSE 流（发一条消息）');
await ta.fill(QUESTION);
await page.locator('t-chat-sender button, [class*="chat-input__actions"] button').last()
  .click({ timeout: 5000 }).catch(e => check('点击发送', false, String(e).slice(0, 80)));

// 等流跑完：opencode 的执行正文出现且流式光标已消失
await page.waitForFunction(() => {
  const walk = (n, out) => {
    if (!n) return out;
    if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t); return out; }
    if (n.shadowRoot) walk(n.shadowRoot, out);
    for (const c of n.childNodes || []) walk(c, out);
    return out;
  };
  const text = walk(document.body, []).join(' ');
  return text.includes('SSE 流式正文渲染成功。') &&
    document.querySelectorAll('.animate-cursor-blink').length === 0;
}, { timeout: 10000 }).catch(() => {});

const full = await page.evaluate(DEEP_TEXT);
check('真的打了 /api/group-chat', chatCalls === 1, `${chatCalls} 次`);
check('用户消息即时回显', full.includes(QUESTION));
check('hermes turn 气泡出现（作者 Hermes）',
  /Hermes/.test(full) && /主控正在判断该交给谁/.test(full));
const notes = await page.evaluate(() => {
  const out = [];
  for (const row of document.querySelectorAll('div.flex.justify-center.py-0\\.5')) {
    const pill = row.querySelector(':scope > span.rounded-full');
    if (pill) out.push({ text: pill.textContent, centered: true });
  }
  return out;
});
const note = notes.find(n => /路由判断/.test(n.text));
check('group_note 渲染为居中弱化 pill', !!note, note?.text || '未找到');
check('group_note 不是气泡',
  (await page.locator('.tc-bubble-assistant:has-text("路由判断")').count()) === 0);
check('opencode turn 气泡正文正确', /SSE 流式正文渲染成功。/.test(full));
check('流式状态已收尾（无残留光标）',
  (await page.locator('.animate-cursor-blink').count()) === 0);

// 发送后输入框必须清空。
// 群聊走的是 useGroupChat，不经过 useChat 的 setInputValue('') ——
// 早先漏了这一步，指令发出去还留在框里，用户以为没发成功又按一次回车。
const afterSend = await ta.inputValue().catch(() => '<读不到>');
check('发送后输入框已清空', afterSend === '', JSON.stringify(afterSend));
check('无控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '));

await page.screenshot({ path: '.render-check/group-chat.png' });
await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n群聊 UI 验证：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
