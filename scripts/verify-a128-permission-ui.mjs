/**
 * P4 审批卡的界面验证：服务端给几档，卡片就画几档，点了要能真的回对。
 *
 * 为什么必须用浏览器实测：这一段的承诺全在「用户点下去之后发生了什么」。
 * 后端把 options 带回来了、路由校验也严了，只要卡片仍然画两颗写死的
 * 「拒绝 / 允许」，或者点「始终允许」发出去的是 behavior=allow 却没有
 * optionId，适配器就只能按第一档猜 —— 用户以为开了永久放行，实际没有。
 *
 * 四份夹具：
 *   [1][2] SDK 四档：拒绝两颗原样渲染 + 三个一次点击动作（2026-11-18，ui-review
 *          P-2 一次点击改造）/ 样式常量（32 档决策按钮、14px 字号、中性描边动作）
 *   [3]    三个动作各自的请求体：仅本次允许 → allow_once；本会话允许 → allow_always；
 *          永久允许 → allow_always + persistAgent:true
 *   [4]    点「始终拒绝」必须带 user_denied_always，不能只说一句 deny
 *   [5]    老路径没下发 options → 只画两档，不凭空补 always、不画动作按钮
 *   [6]    群聊审批（修的是「卡片显示群请求、按钮却回复了 null」的旧缺陷）
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
  // A132：群聊在**流结束**（`done`）时会摘掉未答复项 —— 那是对的：流都收尾了，
  // 没人再等这个答复。但夹具里紧跟一条 `done` 会让卡片刚出现就被收走，
  // 而「发完请求立刻收尾」的流在真机上不存在（服务端会挂着等答复）。
  // 所以凡是要「卡片在场」的场景，必须让流停在那儿不结束（keepOpen）。
  const streamBody = sse(opts.keepOpen ? [permission] : [permission, { type: 'done' }]);

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

// ============= [1][2] 目录渲染 + 一次点击动作按钮 + 样式常量 =============
// 2026-11-18（ui-review P-2）：两步决策（三段范围选择器 + 确认主按钮）退役，
// 改成「拒绝类原样 + 仅本次允许 / 本会话允许 / 永久允许」一次点击，无默认选中。
// 本闸门保护的核心不变量没有变：
//   · 服务端给几档，界面画几档，不凭空补（[5] 的老路径、CLI 两档仍然成立）；
//   · 点下去发出去的 optionId 与目录一致、适配器能精确回选；
//   · 「永久允许」= allow_always + persistAgent，不新增第四种 kind；
//   · 设计常量（32 档决策按钮 / 14px 字号，P-2「13.5px 起」取其上的按钮文字档）
//     不被样式带跑。
console.log('\n[1] 四档目录 → 拒绝两颗原样 + 三个一次点击动作（无默认选中）');
{
  const { ctx, page } = await newPage(permissionEvent());
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('[data-permission-option]')].map(el => ({
      id: el.getAttribute('data-permission-option'),
      kind: el.getAttribute('data-permission-kind'),
      action: el.getAttribute('data-permission-action'),
      label: el.textContent.trim(),
      title: el.getAttribute('title'),
      x: Math.round(el.getBoundingClientRect().x),
    }))
  );
  eq(buttons.map(b => b.kind),
    ['reject_once', 'reject_always', 'allow_once', 'allow_always', 'allow_always'],
    'kind 序列：拒绝两颗原样 + 三个 allow 动作（永久=allow_always+persist，不新增 kind）');
  eq(buttons.map(b => b.action), [null, null, 'once', 'session', 'agent'],
    '三个动作带 data-permission-action 锚点，拒绝类不带');
  eq(buttons.map(b => b.label),
    ['拒绝', '本会话始终拒绝', '仅本次允许', '本会话允许', '永久允许'],
    '动作文案与效果稿 16 号图一致（一次点击，无「确认」步）');
  ok((buttons[1].title || '').includes('应用重启后失效'), '「始终拒绝」标题写明作用域', buttons[1].title ?? '');
  ok((buttons[3].title || '').includes('高危操作仍会被门禁拦截'), '「本会话允许」标题写明安全边界（来自 allow_always 的 note）', buttons[3].title ?? '');
  ok(/撤销/.test(buttons[4].title || '') && /门禁/.test(buttons[4].title || ''),
    '「永久允许」标题写明持久化边界（可在设置撤销 + 门禁仍在）', buttons[4].title ?? '');
  ok(
    buttons.every((b, i) => i === 0 || b.x > buttons[i - 1].x),
    '视觉顺序从左到右与目录一致（不是倒序）',
    buttons.map(b => b.x).join(' < ')
  );

  // P-2：无默认选中 —— 卡片里不许再有任何预选状态（radiogroup / aria-checked），
  // 摆默认选中等于替用户预支一个决定。
  const preselection = await page.evaluate(() => ({
    radiogroup: document.querySelectorAll('[data-permission-card] [role="radiogroup"]').length,
    checked: document.querySelectorAll('[data-permission-card] [aria-checked]').length,
    scopeTitle: document.querySelector('[data-permission-scope-title]')?.textContent?.trim() ?? '',
  }));
  eq(preselection.radiogroup, 0, 'P-2：radiogroup 选择器已退役');
  eq(preselection.checked, 0, 'P-2：无默认选中（没有任何 aria-checked 预选态）');
  eq(preselection.scopeTitle, '选择授权范围，点一次即生效：', '效果稿的提示行在按钮区上方');

  // ---- [2] 样式：设计常量写死在这里，被现有样式带跑就红 ----
  // 先把鼠标挪开再量：sendMessage 的落点可能停在按钮上，悬停态量出来就不是默认态
  await page.mouse.move(300, 160);
  await page.waitForTimeout(200);
  const style = await page.evaluate(() => {
    const el = sel => document.querySelector(sel);
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--td-error-color)';
    document.body.appendChild(probe);
    const error = getComputedStyle(probe).backgroundColor;
    probe.style.color = 'var(--td-text-color-primary)';
    const textPrimary = getComputedStyle(probe).color;
    probe.remove();

    const read = (sel, textSel) => {
      const b = el(sel);
      if (!b) return null;
      const cs = getComputedStyle(b);
      return {
        fontSize: cs.fontSize,
        height: Math.round(b.getBoundingClientRect().height),
        fontWeight: cs.fontWeight,
        radius: cs.borderTopLeftRadius,
        color: cs.color,
        // 文字在 .t-button__text 里：只听根节点颜色会漏掉内部覆盖
        textColor: getComputedStyle(b.querySelector(textSel ?? '.t-button__text') ?? b).color,
        background: cs.backgroundColor,
        borderWidth: cs.borderTopWidth,
        borderColor: cs.borderTopColor,
      };
    };
    const probe2 = document.createElement('div');
    probe2.style.borderColor = 'var(--td-component-stroke)';
    document.body.appendChild(probe2);
    const stroke = getComputedStyle(probe2).borderTopColor;
    probe2.remove();

    return {
      gap: getComputedStyle(el('[data-permission-actions]')).gap,
      error,
      textPrimary,
      stroke,
      reject: read('[data-permission-option="reject_once"]'),
      rejectAlways: read('[data-permission-option="reject_always"]'),
      once: read('[data-permission-action="once"]'),
      session: read('[data-permission-action="session"]'),
      agent: read('[data-permission-action="agent"]'),
    };
  });

  eq(style.gap, '8px', '按钮间距 8px（设计 gap-2，不被覆盖）');
  for (const [key, name] of [['reject', '拒绝'], ['rejectAlways', '始终拒绝'], ['once', '仅本次允许'], ['session', '本会话允许'], ['agent', '永久允许']]) {
    eq(style[key].fontSize, '14px', `${name} 字号 14px（--text-body-lg，P-2「13.5px 起」取 DESIGN-SYSTEM 档位）`);
    eq(style[key].height, 32, `${name} 按钮高 32px（A124 单档，决策动作不再是行内 24）`);
    eq(style[key].fontWeight, '500', `${name} 字重 500`);
    eq(style[key].radius, '6px', `${name} 圆角 6px`);
  }
  eq(style.reject.background, 'rgba(0, 0, 0, 0)', '「拒绝」无底色（文字按钮）');
  eq(style.reject.textColor, style.error, '「拒绝」文字用危险色');
  eq(style.rejectAlways.textColor, style.error, '「始终拒绝」与「拒绝」同色，只靠描边区分层级');
  // 三个一次点击动作：无默认选中的中性描边档（效果稿 16 号图），hover 才给底
  for (const [key, name] of [['once', '仅本次允许'], ['session', '本会话允许'], ['agent', '永久允许']]) {
    eq(style[key].textColor, style.textPrimary, `${name} 文字色为主文字色（中性档）`);
    eq(style[key].borderColor, style.stroke, `${name} 描边是 --td-component-stroke`);
    eq(style[key].background, 'rgba(0, 0, 0, 0)', `${name} 默认无底色`);
    ok(style[key].textColor !== style.error, `${name} 不用危险色（持久重量写在 title 里，不靠描红）`);
  }

  await page.screenshot({ path: join(OUT, 'a128-four-options.png'), fullPage: false });
  await ctx.close();
}

// ============= [3] 三个动作各自发什么 =============
console.log('\n[3] 一次点击：仅本次 / 本会话 / 永久 各自的请求体');
{
  // 仅本次允许 → allow_once，不带 persistAgent
  {
    const { ctx, page, posts } = await newPage(permissionEvent());
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    await page.locator('[data-permission-action="once"]').click();
    await page.waitForTimeout(600);

    eq(posts.length, 1, '只发一条答复');
    if (posts[0]) {
      eq(posts[0].requestId, 'req-a128', '带对 requestId');
      eq(posts[0].behavior, 'allow', '行为是 allow（不是默认 deny）');
      eq(posts[0].optionId, 'allow_once', '「仅本次允许」→ allow_once');
      eq(posts[0].persistAgent, undefined, '仅本次不携带持久化标记');
      ok(posts[0].reasonCode === undefined, '允许不带拒绝原因码', String(posts[0].reasonCode));
    }
    ok((await page.locator('[data-permission-option]').count()) === 0, '答复后卡片消失（不会重复提交）');
    await ctx.close();
  }

  // 本会话允许 → allow_always，不落库
  {
    const { ctx, page, posts } = await newPage(permissionEvent());
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    await page.locator('[data-permission-action="session"]').click();
    await page.waitForTimeout(600);

    eq(posts.length, 1, '只发一条答复');
    if (posts[0]) {
      eq(posts[0].behavior, 'allow', '行为是 allow');
      eq(posts[0].optionId, 'allow_always', '精确回传选项 id（适配器据此记住本会话）');
      eq(posts[0].persistAgent, undefined, '本会话档不落库（语义仍是适配器内存）');
    }
    await ctx.close();
  }

  // 永久允许 → allow_always + persistAgent:true，一次点击直接生效
  {
    const { ctx, page, posts } = await newPage(permissionEvent());
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    await page.locator('[data-permission-action="agent"]').click();
    await page.waitForTimeout(600);

    eq(posts.length, 1, '只发一条答复');
    if (posts[0]) {
      eq(posts[0].behavior, 'allow', '行为是 allow');
      eq(posts[0].optionId, 'allow_always', '回传的仍是 allow_always 档（persistAgent 是附加指令，不是新选项）');
      eq(posts[0].persistAgent, true, '「永久允许」→ persistAgent:true（服务端在答复里一并落库）');
    }
    await ctx.close();
  }
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
  const { ctx, page, posts } = await newPage(permissionEvent({ requestId: 'req-group' }), { group: true, keepOpen: true });
  await page.goto(base + '/chat/s2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await sendMessage(page);

  ok((await page.locator('[data-permission-option]').count()) === 5, '群聊审批卡正常出现（拒绝两颗 + 三个一次点击动作）');
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
