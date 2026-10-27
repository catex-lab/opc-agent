/**
 * P4 审批卡的界面验证：服务端给几档，卡片就画几档，点了要能真的回对。
 *
 * 为什么必须用浏览器实测：这一段的承诺全在「用户点下去之后发生了什么」。
 * 后端把 options 带回来了、路由校验也严了，只要卡片仍然画两颗写死的
 * 「拒绝 / 允许」，或者点「始终允许」发出去的是 behavior=allow 却没有
 * optionId，适配器就只能按第一档猜 —— 用户以为开了永久放行，实际没有。
 *
 * 四份夹具：
 *   [1][2][3] SDK 四档：渲染顺序 / 样式常量 / 点「始终允许」发出的请求体
 *   [4]       点「始终拒绝」必须带 user_denied_always，不能只说一句 deny
 *   [5]       老路径没下发 options → 只画两档，不凭空补 always
 *   [6]       群聊审批（修的是「卡片显示群请求、按钮却回复了 null」的旧缺陷）
 *
 * 运行：node scripts/verify-a128-permission-ui.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check', 'a128');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

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
const eq = (actual, expected, label) =>
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);

const SDK_OPTIONS = [
  { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
  { id: 'reject_always', kind: 'reject_always', label: '本会话始终拒绝', note: '本会话内不再询问这个工具；应用重启后失效' },
  { id: 'allow_once', kind: 'allow_once', label: '允许' },
  { id: 'allow_always', kind: 'allow_always', label: '本会话始终允许', note: '本会话内这个工具不再询问；高危操作仍会被门禁拦截' },
];

const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    eventCapabilities: ['thinking', 'tool', 'permission'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
  {
    id: 'hermes', name: 'Hermes', vendor: 'Nous', kind: 'acp', icon: 'hermes',
    color: '#7C5CFF', description: '长任务编排', capabilities: ['chat'],
    eventCapabilities: ['thinking', 'tool', 'permission'],
    status: { availability: 'ready', version: '0.9.0' },
    permissionSupport: { enforced: ['default'] },
  },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  {
    id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5',
    kind: 'direct', agent_ids: null, orchestration: null,
    created_at: new Date(Date.now() - 60000).toISOString(),
  },
  {
    id: 's2', title: '研发小组', agent_id: null, model: null,
    kind: 'group', agent_ids: '["workbuddy","hermes"]', orchestration: 'relay',
    created_at: new Date(Date.now() - 60000).toISOString(),
  },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '清理构建目录', created_at: new Date(Date.now() - 60000).toISOString() },
  { id: 'm2', session_id: 's2', role: 'user', content: '群里跑一下', created_at: new Date(Date.now() - 60000).toISOString() },
];

const permissionEvent = (overrides = {}) => ({
  type: 'permission_request',
  requestId: 'req-a128',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  risk: 'dangerous',
  rule: '删除目录',
  options: SDK_OPTIONS,
  ...overrides,
});

const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = join(DIST, p === '/' ? 'index.html' : p);
  let body;
  try { body = await readFile(file); } catch {
    file = join(DIST, 'index.html');
    body = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const consoleErrors = [];

/**
 * @param {object} permission  要下发的那条 permission_request
 * @param {{ group?: boolean }} opts  group=true 时让 /api/group-chat 也能发
 */
async function newPage(permission, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  const posts = [];
  const streamBody = sse([permission, { type: 'done' }]);

  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const url = req.url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

    if (url.includes('/api/permission-response')) {
      try { posts.push(req.postDataJSON()); } catch { posts.push(null); }
      return json({ success: true, agentId: 'workbuddy' });
    }
    if (url.includes('/api/group-chat')) {
      if (!opts.group) return json({ error: 'unexpected' });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamBody });
    }
    if (url.includes('/api/chat')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamBody });
    }
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
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
    return json({});
  });

  return { ctx, page, posts };
}

async function sendMessage(page) {
  const ta = page.locator('textarea').first();
  await ta.fill('执行一下');
  await page.waitForTimeout(120);
  await page
    .locator('t-chat-sender button, [class*="chat-input__actions"] button')
    .last()
    .click({ timeout: 5000 });
  await page.waitForSelector('[data-permission-option]', { timeout: 8000 });
  await page.waitForTimeout(250);
}

// ============= [1][2] 四档渲染 + 样式常量 =============
console.log('\n[1] 服务端给四档，卡片按顺序画四档');
{
  const { ctx, page } = await newPage(permissionEvent());
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('[data-permission-option]')].map(el => ({
      id: el.getAttribute('data-permission-option'),
      kind: el.getAttribute('data-permission-kind'),
      label: el.textContent.trim(),
      title: el.getAttribute('title'),
      x: Math.round(el.getBoundingClientRect().x),
    }))
  );
  eq(buttons.map(b => b.id), ['reject_once', 'reject_always', 'allow_once', 'allow_always'], '顺序与服务端目录一致');
  eq(buttons.map(b => b.kind), ['reject_once', 'reject_always', 'allow_once', 'allow_always'], 'kind 原样透传');
  eq(buttons.map(b => b.label), ['拒绝', '本会话始终拒绝', '允许', '本会话始终允许'], '标签用人话，不显示枚举值');
  ok((buttons[1].title || '').includes('应用重启后失效'), '「始终拒绝」标题写明作用域', buttons[1].title ?? '');
  ok((buttons[3].title || '').includes('高危操作仍会被门禁拦截'), '「始终允许」标题写明安全边界', buttons[3].title ?? '');
  ok(
    buttons.every((b, i) => i === 0 || b.x > buttons[i - 1].x),
    '视觉顺序从左到右与目录一致（不是倒序）',
    buttons.map(b => b.x).join(' < ')
  );

  // ---- [2] 样式：设计常量写死在这里，被现有样式带跑就红 ----
  const style = await page.evaluate(() => {
    const el = id => document.querySelector(`[data-permission-option="${id}"]`);
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--td-success-color)';
    document.body.appendChild(probe);
    const success = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = 'var(--td-error-color)';
    const error = getComputedStyle(probe).backgroundColor;
    probe.remove();

    const read = id => {
      const b = el(id);
      const cs = getComputedStyle(b);
      return {
        fontSize: cs.fontSize,
        height: Math.round(b.getBoundingClientRect().height),
        fontWeight: cs.fontWeight,
        radius: cs.borderTopLeftRadius,
        color: cs.color,
        // 文字在 .t-button__text 里：只听根节点颜色会漏掉内部覆盖
        textColor: getComputedStyle(b.querySelector('.t-button__text') ?? b).color,
        background: cs.backgroundColor,
      };
    };
    const allow = el('allow_once');
    return {
      gap: getComputedStyle(allow.parentElement).gap,
      success,
      error,
      reject: read('reject_once'),
      rejectAlways: read('reject_always'),
      allow: read('allow_once'),
      allowAlways: read('allow_always'),
    };
  });

  eq(style.gap, '8px', '按钮间距 8px（原设计 gap-2，不被覆盖）');
  for (const key of ['reject', 'rejectAlways', 'allow', 'allowAlways']) {
    eq(style[key].fontSize, '12px', `${key} 字号 12px（TDesign small 档）`);
    eq(style[key].height, 24, `${key} 按钮高 24px`);
    eq(style[key].fontWeight, '500', `${key} 字重 500`);
  }
  eq(style.allow.background, style.success, '「允许」是实心成功色（主操作）');
  eq(style.allow.textColor, 'rgb(255, 255, 255)', '「允许」文字白色（量的是真正承载文字的 span）');
  eq(style.reject.background, 'rgba(0, 0, 0, 0)', '「拒绝」无底色（文字按钮）');
  eq(style.reject.textColor, style.error, '「拒绝」文字用危险色');
  eq(style.rejectAlways.textColor, style.error, '「始终拒绝」与「拒绝」同色，只靠描边区分层级');
  eq(style.allowAlways.textColor, style.success, '「始终允许」用成功色描边');
  for (const key of ['reject', 'rejectAlways', 'allow', 'allowAlways']) {
    eq(style[key].radius, '6px', `${key} 圆角 6px（设计常量）`);
  }

  await page.screenshot({ path: join(OUT, 'a128-four-options.png'), fullPage: false });
  await ctx.close();
}

// ============= [3] 点「始终允许」发什么 =============
console.log('\n[3] 点「本会话始终允许」→ allow + optionId');
{
  const { ctx, page, posts } = await newPage(permissionEvent());
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  await page.locator('[data-permission-option="allow_always"]').click();
  await page.waitForTimeout(600);

  eq(posts.length, 1, '只发一条答复');
  if (posts[0]) {
    eq(posts[0].requestId, 'req-a128', '带对 requestId');
    eq(posts[0].behavior, 'allow', '行为是 allow（不是默认 deny）');
    eq(posts[0].optionId, 'allow_always', '精确回传选项 id（适配器据此记住本会话）');
    ok(posts[0].reasonCode === undefined, '允许不带拒绝原因码', String(posts[0].reasonCode));
  }
  ok((await page.locator('[data-permission-option]').count()) === 0, '答复后卡片消失（不会重复提交）');
  await ctx.close();
}

// ============= [4] 点「始终拒绝」发什么 =============
console.log('\n[4] 点「本会话始终拒绝」→ deny + user_denied_always');
{
  const { ctx, page, posts } = await newPage(permissionEvent({ requestId: 'req-deny' }));
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  await page.locator('[data-permission-option="reject_always"]').click();
  await page.waitForTimeout(600);

  eq(posts.length, 1, '只发一条答复');
  if (posts[0]) {
    eq(posts[0].requestId, 'req-deny', '带对 requestId');
    eq(posts[0].behavior, 'deny', '行为是 deny');
    eq(posts[0].optionId, 'reject_always', '回传 reject_always');
    eq(posts[0].reasonCode, 'user_denied_always', '原因码区分「本会话禁用」与一次性拒绝');
  }
  await ctx.close();
}

// ============= [5] 老路径：没有 options =============
console.log('\n[5] 服务端没给 options → 只画两档兜底');
{
  const { ctx, page, posts } = await newPage(permissionEvent({ requestId: 'req-legacy', options: undefined }));
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-permission-option]')].map(el => el.textContent.trim())
  );
  eq(labels, ['拒绝', '允许'], '兜底只有拒绝 / 允许，不凭空补 always');
  ok(
    (await page.locator('[data-permission-kind$="_always"]').count()) === 0,
    '兜底里没有 always 档（没有承诺就不摆按钮）'
  );

  await page.locator('[data-permission-option="allow_once"]').click();
  await page.waitForTimeout(500);
  if (posts[0]) {
    eq(posts[0].behavior, 'allow', '兜底的「允许」也能真的放行');
    eq(posts[0].optionId, 'allow_once', '兜底同样带 optionId');
  }
  await ctx.close();
}

// ============= [6] 群聊审批 =============
console.log('\n[6] 群聊：卡片与答复口是同一个请求');
{
  const { ctx, page, posts } = await newPage(permissionEvent({ requestId: 'req-group' }), { group: true });
  await page.goto(base + '/chat/s2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await sendMessage(page);

  ok((await page.locator('[data-permission-option]').count()) === 4, '群聊审批卡正常出现');
  await page.locator('[data-permission-option="allow_once"]').click();
  await page.waitForTimeout(600);

  eq(posts.length, 1, '群聊的答复真的发出去了（旧实现绑在 useChat 的 null 上，点了没反应）');
  if (posts[0]) {
    eq(posts[0].requestId, 'req-group', '回复的是群聊卡片的 requestId');
    eq(posts[0].behavior, 'allow', '行为正确');
    eq(posts[0].optionId, 'allow_once', '选项 id 正确');
  }
  ok((await page.locator('[data-permission-option]').count()) === 0, '群聊答复后卡片消失');
  await ctx.close();
}

// ============= [7] 控制台 =============
console.log('\n[7] 控制台');
{
  const real = consoleErrors.filter(e => !/favicon|Download the React DevTools/i.test(e));
  ok(real.length === 0, '无控制台错误', real.slice(0, 3).join(' | ') || '0');
}

await browser.close();
server.close();

console.log(`\nA128 审批卡：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
