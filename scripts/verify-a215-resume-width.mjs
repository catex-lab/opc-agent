/**
 * A215 验证：「上一轮指令未完成」状态条与输入框同宽，并随窗口一起收缩。
 *
 * ## 为什么是跨宽度序列，不是量一帧
 *
 * 修复前状态条直接挂在消息滚动容器里，没有任何列宽约束 —— 它撑满
 * `data-chat-scroll` 的内容区（1440 窗口下约 1100px），而输入框被
 * `.tc-chat-column` 收在 768px，于是出现一条比输入框宽两百多像素的橙条。
 * 只量单一帧看不出「响应式」：万一有人写死 `width: 768px`，宽窗口绿、
 * 窄窗口照样溢出。所以在三档 viewport 下逐档量左右边界与宽度。
 *
 * ## 判据为什么不写 `=== 0`
 *
 * 状态条在滚动容器（`p-6` = 左右 24）里，输入区外层是 `px-4`（左右 16）；
 * 组件用 `-mx-2` 抵消了这 8px，但滚动容器的 `[scrollbar-gutter:stable]`
 * 还会占掉约 6px，窄窗口下两者不可能严格同宽。容差 8px 是几何事实，
 * 不是放水：宽窗口列宽封顶时两者严格相等，退回坏版本时差值是 200px+。
 * 同时配肯定式（聊天页 / 输入区 / 状态条都真的渲染、宽窗口下列宽收住），
 * 避免「两个元素都被删掉」这类假绿。窄窗口下输入框本身就接近撑满，
 * 所以「比消息内容区窄」只在列宽封顶的宽窗口量。
 *
 * ## 反向探针
 *
 * `--probe-old` 把状态条从两层列容器里搬回滚动容器（等价于修复前的 DOM
 * 结构）并设 `width: 100%`，断言必须变红。只加断言不验它能变红，等于
 * 没写（见 TRAPS §3「反向探针是硬要求」）。
 *
 * 运行：node scripts/verify-a215-resume-width.mjs [--probe-old]（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = join(process.cwd(), 'dist');
import { resolveChromePath } from './lib/chrome.mjs';
const CHROME = resolveChromePath();
const PROBE = process.argv.includes('--probe-old');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const failures = [];
let total = 0;
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const NOW = new Date().toISOString();
const AGENTS = [{
  id: 'a1', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
  color: '#0EC8A9', description: 'x', capabilities: ['chat'],
  status: { availability: 'ready', version: '1' },
}];
const MODELS = [{ modelId: 'm1', name: 'Hy4 (free)' }];
const SESSION = {
  id: 's1', title: '测试会话', agent_id: 'a1', model: 'm1', kind: 'chat',
  project_id: null, cwd: '', created_at: NOW, updated_at: NOW, dangling: null,
};
const MESSAGES = [
  { id: 'u1', role: 'user', content: '你知道opencode cli吗', created_at: NOW },
  { id: 'a1', role: 'assistant', content: 'Request timeout: initialize', created_at: NOW },
];

/** 刷新后恢复的待决项（useChat.STORAGE_KEYS.resumePrompt），比模拟一次 409 发送更稳 */
const RESUME_PROMPT = {
  info: {
    kind: 'dangling-cli-turn',
    title: '上一轮指令未完成',
    detail: 'CLI 会话里最后一轮以错误结束',
    reason: '最后一轮以错误结束，没有产出可用的回复',
    recommended: 'fresh',
    recommendReason: '不续接旧 CLI 会话，旧指令不会被重放',
    options: [],
  },
  sessionId: 's1',
  messageContent: '你知道opencode cli吗',
  newChatOptions: null,
  regen: false,
};

const server = createServer(async (req, res) => {
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
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(prompt => {
  try {
    localStorage.setItem('resumePrompt', JSON.stringify(prompt));
  } catch {
    // about:blank 没有 origin，忽略；真正导航到页面时还会再执行一次
  }
}, RESUME_PROMPT);
await ctx.route('**/api/**', route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/runs/active')) return json({ runs: [] });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (url.includes('/api/verify/commands')) return json({ cwd: null, projectTypes: [], commands: [], notes: [] });
  if (url.includes('/api/verify/results')) return json({ verifications: [] });
  if (url.includes('/api/files/evidence')) return json({ cwd: null, items: [], summary: { total: 0, landed: 0, notLanded: 0, other: 0, alarm: null } });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    return json({ session: SESSION, project: null, messages: MESSAGES, dangling: null });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: [SESSION] });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-resume-notice]', { timeout: 15000 });
await page.waitForTimeout(400);

console.log('\n[0] 先证明页面真的打开了');
ok((await page.locator('[data-chat-page]').count()) === 1, '聊天页挂载了一次');
ok((await page.locator('t-chat-sender').count()) === 1, '输入区 t-chat-sender 已渲染');
ok((await page.locator('[data-resume-notice]').count()) === 1, '状态条已渲染');
ok(errors.length === 0, '页面没有未捕获异常', errors.slice(0, 2).join(' | '));

if (PROBE) {
  // 退回坏版本：状态条脱离两层列容器，直接撑满消息滚动区
  await page.evaluate(() => {
    const notice = document.querySelector('[data-resume-notice]');
    const wrapper = notice?.parentElement?.parentElement;
    if (!notice || !wrapper) return;
    wrapper.replaceWith(notice);
    notice.style.width = '100%';
    notice.style.marginTop = '12px';
  });
  console.log('  ⚠ --probe-old：已把状态条退回「无列约束、撑满消息区」的旧 DOM');
}

const measure = () => page.evaluate(() => {
  const rect = el => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, width: b.width };
  };
  const notice = document.querySelector('[data-resume-notice]');
  const sender = document.querySelector('t-chat-sender');
  const cols = [...document.querySelectorAll('.tc-chat-column')];
  // 输入区那一列：优先从 sender 往上找；退化时取不是状态条祖先的那一列
  const inputCol = sender?.closest('.tc-chat-column')
    ?? cols.find(c => !c.contains(notice))
    ?? null;
  const scroll = document.querySelector('[data-chat-scroll]');
  const pad = scroll
    ? parseFloat(getComputedStyle(scroll).paddingLeft) + parseFloat(getComputedStyle(scroll).paddingRight)
    : 0;
  return {
    notice: notice ? rect(notice) : null,
    input: inputCol ? rect(inputCol) : null,
    scrollContent: scroll ? scroll.clientWidth - pad : 0,
    scrollRight: scroll ? scroll.getBoundingClientRect().right : 0,
  };
});

const widths = [];
console.log('\n[1] 三档窗口：状态条与输入框同宽、左右对齐、不撑满消息区');
for (const width of [1440, 1080, 900]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(250);
  const m = await measure();
  if (!m.notice || !m.input) {
    ok(false, `[${width}] 量到两个元素`, '有元素缺失，后续断言无法成立');
    continue;
  }
  widths.push(Math.round(m.notice.width));
  const dw = Math.abs(m.notice.width - m.input.width);
  const dl = Math.abs(m.notice.left - m.input.left);
  const dr = Math.abs(m.notice.right - m.input.right);
  ok(dw <= 8, `[${width}] 与输入框同宽`,
    `状态条 ${m.notice.width.toFixed(1)} / 输入框 ${m.input.width.toFixed(1)}，Δ=${dw.toFixed(1)}px`);
  ok(dl <= 8 && dr <= 8, `[${width}] 左右边界对齐`,
    `Δleft=${dl.toFixed(1)}px Δright=${dr.toFixed(1)}px`);
  /* 弱护栏：负 margin 只是抵消 padding，不该把状态条推出滚动容器。
     真正抓「撑满全宽」的是上面的同宽断言 + 宽窗口专属那条。 */
  ok(m.notice.right <= m.scrollRight - 4, `[${width}] 没有溢出消息滚动容器`,
    `right=${m.notice.right.toFixed(1)} <= ${m.scrollRight.toFixed(1)} - 4`);
  /* 窄窗口下输入框本身就接近撑满，「比消息内容区窄」不成立也不该成立；
     只有列宽封顶的宽窗口才用它钉「收住了」，坏版本在这里是 1018 vs 768。 */
  if (width >= 1200) {
    ok(m.notice.width < m.scrollContent - 100, `[${width}] 列宽收住、没有撑满消息区`,
      `${m.notice.width.toFixed(1)} < ${m.scrollContent.toFixed(1)} - 100`);
  }
}

console.log('\n[2] 响应式：状态条真的随窗口收缩');
ok(new Set(widths).size >= 2, '至少两档宽度不同', widths.join(' / '));

console.log(`\n${PROBE ? '反向探针' : '正式'}：${failures.length} 条未通过 / ${total} 条`);
await browser.close();
await new Promise(r => server.close(r));
if (PROBE) process.exit(failures.length > 0 ? 0 : 1);
else process.exit(failures.length > 0 ? 1 : 0);
