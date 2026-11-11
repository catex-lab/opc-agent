/**
 * P4 审批卡的界面验证：服务端给几档，卡片就画几档，点了要能真的回对。
 *
 * 为什么必须用浏览器实测：这一段的承诺全在「用户点下去之后发生了什么」。
 * 后端把 options 带回来了、路由校验也严了，只要卡片仍然画两颗写死的
 * 「拒绝 / 允许」，或者点「始终允许」发出去的是 behavior=allow 却没有
 * optionId，适配器就只能按第一档猜 —— 用户以为开了永久放行，实际没有。
 *
 * 四份夹具：
 *   [1][2] SDK 四档：拒绝两颗原样渲染 + 授权范围三段选择器（2026-11-12 变体 A）
 *          / 样式常量（24 档选项、32 档确认、44px 选择器段）
 *   [3]    三个范围各自的请求体：默认仅本次 → allow_once；本会话 → allow_always；
 *          该 Agent 永久 → allow_always + persistAgent:true
 *   [4]    点「始终拒绝」必须带 user_denied_always，不能只说一句 deny
 *   [5]    老路径没下发 options → 只画两档，不凭空补 always、不画选择器
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

// ============= [1][2] 目录渲染 + 授权范围选择器 + 样式常量 =============
// 2026-11-12 变体 A：目录同时含 allow_once/allow_always 时，两颗 allow 按钮
// 被「三段授权范围选择器 + 确认主按钮」替代（用户拍板的效果稿）；拒绝类按钮
// 维持服务端目录顺序原样渲染。本闸门保护的核心不变量没有变：
//   · 服务端给几档，界面画几档，不凭空补（[5] 的老路径、CLI 两档仍然成立）；
//   · 点下去发出去的 optionId 与目录一致、适配器能精确回选；
//   · 设计常量（24 档选项 / 32 档确认 / 选择器几何）不被样式带跑。
console.log('\n[1] 四档目录 → 拒绝两颗原样 + 三段范围选择器 + 确认主按钮');
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
  eq(buttons.map(b => b.id), ['reject_once', 'reject_always', 'allow_once'], '拒绝两颗按目录顺序，确认按钮锚定默认档 allow_once');
  eq(buttons.map(b => b.kind), ['reject_once', 'reject_always', 'allow_once'], 'kind 原样透传');
  eq(buttons.map(b => b.label), ['拒绝', '本会话始终拒绝', '允许'], '确认主按钮默认文案是「允许」（仅本次）');
  ok((buttons[1].title || '').includes('应用重启后失效'), '「始终拒绝」标题写明作用域', buttons[1].title ?? '');
  ok((buttons[2].title || '').includes('高危操作仍会被门禁拦截'), '确认按钮标题写明安全边界（来自 allow_always 的 note）', buttons[2].title ?? '');
  ok(
    buttons.every((b, i) => i === 0 || b.x > buttons[i - 1].x),
    '视觉顺序从左到右与目录一致（不是倒序）',
    buttons.map(b => b.x).join(' < ')
  );

  // 授权范围选择器：三段、默认仅本次、radiogroup 语义
  const scope = await page.evaluate(() => ({
    root: !!document.querySelector('[data-permission-scope]'),
    options: [...document.querySelectorAll('[data-permission-scope-option]')].map(el => ({
      kind: el.getAttribute('data-permission-scope-option'),
      checked: el.getAttribute('aria-checked'),
      role: el.getAttribute('role'),
      tabindex: el.getAttribute('tabindex'),
    })),
    groupRole: document.querySelector('[data-permission-scope] [role="radiogroup"]')?.getAttribute('role'),
  }));
  ok(scope.root, '选择器出现在按钮区上方');
  eq(scope.groupRole, 'radiogroup', '选择器是 radiogroup');
  eq(scope.options.map(o => o.kind), ['once', 'session', 'agent'], '三段：仅本次 / 本会话 / 该 Agent 永久');
  eq(scope.options.map(o => o.checked), ['true', 'false', 'false'], '默认选中「仅本次」');
  eq(scope.options.map(o => o.role), ['radio', 'radio', 'radio'], '每段都是 radio');
  eq(scope.options.map(o => o.tabindex), ['0', '-1', '-1'], 'roving tabindex：只有选中段可 Tab 到');

  // ---- [2] 样式：设计常量写死在这里，被现有样式带跑就红 ----
  // 先把鼠标挪开再量：sendMessage 的落点就在右下角 Dock 区，
  // 悬停态的 .tc-btn-brand 是 --td-brand-color-hover，量出来就不是默认态了
  await page.mouse.move(300, 160);
  await page.waitForTimeout(200);
  const style = await page.evaluate(() => {
    const el = sel => document.querySelector(sel);
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--td-error-color)';
    document.body.appendChild(probe);
    const error = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = 'var(--td-brand-color)';
    const brand = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = 'var(--tc-on-brand)';
    const onBrand = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = 'var(--tc-fill-hover)';
    const fillHover = getComputedStyle(probe).backgroundColor;
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
      gap: getComputedStyle(el('[data-permission-option="allow_once"]').parentElement).gap,
      error,
      brand,
      onBrand,
      fillHover,
      stroke,
      reject: read('[data-permission-option="reject_once"]'),
      rejectAlways: read('[data-permission-option="reject_always"]'),
      confirm: read('[data-permission-confirm="1"]'),
      segOnce: read('[data-permission-scope-option="once"]', ':scope'),
      segSession: read('[data-permission-scope-option="session"]', ':scope'),
    };
  });

  eq(style.gap, '8px', '按钮间距 8px（原设计 gap-2，不被覆盖）');
  for (const key of ['reject', 'rejectAlways']) {
    eq(style[key].fontSize, '12px', `${key} 字号 12px（TDesign small 档）`);
    eq(style[key].height, 24, `${key} 按钮高 24px`);
    eq(style[key].fontWeight, '500', `${key} 字重 500`);
  }
  eq(style.reject.background, 'rgba(0, 0, 0, 0)', '「拒绝」无底色（文字按钮）');
  eq(style.reject.textColor, style.error, '「拒绝」文字用危险色');
  eq(style.rejectAlways.textColor, style.error, '「始终拒绝」与「拒绝」同色，只靠描边区分层级');
  // 确认主按钮：32 档品牌实心（A124 的唯一入口 .tc-btn-brand）
  eq(style.confirm.height, 32, '确认主按钮高 32px（提交级动作走 32 档，不是行内 24）');
  eq(style.confirm.background, style.brand, '确认主按钮是品牌色实心（石墨黑，不是蓝）');
  eq(style.confirm.textColor, style.onBrand, '确认主按钮文字用 on-brand 反向配对');
  // 选择器几何：高 44 / 圆角 6 / 选中品牌描边 + fill-hover 底。
  // 描边宽度（1.5px）量不准 —— Chrome 的 computed border-width 会取整，
  // 改量颜色：选中段描边是品牌色，未选中段是 --td-component-stroke。
  eq(style.segOnce.height, 44, '选择器段高 44px（效果稿 .seg .s）');
  eq(style.segOnce.radius, '6px', '选择器段圆角 6px');
  eq(style.segOnce.borderColor, style.brand, '选中段描边是品牌色');
  eq(style.segOnce.background, style.fillHover, '选中段底色是 --tc-fill-hover');
  eq(style.segSession.borderColor, style.stroke, '未选中段描边是 --td-component-stroke');
  ok(style.segOnce.borderColor !== style.segSession.borderColor, '选中与未选中的描边可区分');

  await page.screenshot({ path: join(OUT, 'a128-four-options.png'), fullPage: false });
  await ctx.close();
}

// ============= [3] 三个范围各自发什么 =============
console.log('\n[3] 范围选择器：默认仅本次 / 本会话 / 该 Agent 永久 各自的请求体');
{
  // 默认（仅本次）：确认按钮直接点 → allow_once，不带 persistAgent
  {
    const { ctx, page, posts } = await newPage(permissionEvent());
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    await page.locator('[data-permission-confirm="1"]').click();
    await page.waitForTimeout(600);

    eq(posts.length, 1, '只发一条答复');
    if (posts[0]) {
      eq(posts[0].requestId, 'req-a128', '带对 requestId');
      eq(posts[0].behavior, 'allow', '行为是 allow（不是默认 deny）');
      eq(posts[0].optionId, 'allow_once', '默认范围是「仅本次」→ allow_once');
      eq(posts[0].persistAgent, undefined, '仅本次不携带持久化标记');
      ok(posts[0].reasonCode === undefined, '允许不带拒绝原因码', String(posts[0].reasonCode));
    }
    ok((await page.locator('[data-permission-option]').count()) === 0, '答复后卡片消失（不会重复提交）');
    await ctx.close();
  }

  // 本会话：选段之后确认按钮的锚点跟着换成 allow_always
  {
    const { ctx, page, posts } = await newPage(permissionEvent());
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    await page.locator('[data-permission-scope-option="session"]').click();
    await page.waitForTimeout(150);
    ok(
      (await page.locator('[data-permission-option="allow_always"]').count()) === 1,
      '选「本会话」后确认按钮锚定 allow_always（适配器据此记住本会话）'
    );
    await page.locator('[data-permission-option="allow_always"]').click();
    await page.waitForTimeout(600);

    eq(posts.length, 1, '只发一条答复');
    if (posts[0]) {
      eq(posts[0].behavior, 'allow', '行为是 allow');
      eq(posts[0].optionId, 'allow_always', '精确回传选项 id（适配器据此记住本会话）');
      eq(posts[0].persistAgent, undefined, '本会话档不落库（语义仍是适配器内存）');
    }
    await ctx.close();
  }

  // 该 Agent 永久：带 persistAgent，且边界说明出现
  {
    const { ctx, page, posts } = await newPage(permissionEvent());
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    ok(
      (await page.locator('[data-permission-scope-hint]').count()) === 0,
      '没选「该 Agent 永久」时不画边界说明（不是常驻噪音）'
    );
    await page.locator('[data-permission-scope-option="agent"]').click();
    await page.waitForTimeout(150);
    ok(
      await page.locator('[data-permission-scope-hint]').isVisible(),
      '选「该 Agent 永久」后出现持久化边界说明（可撤销 + 门禁仍在）'
    );
    await page.locator('[data-permission-confirm="1"]').click();
    await page.waitForTimeout(600);

    eq(posts.length, 1, '只发一条答复');
    if (posts[0]) {
      eq(posts[0].behavior, 'allow', '行为是 allow');
      eq(posts[0].optionId, 'allow_always', '回传的仍是 allow_always 档（persistAgent 是附加指令，不是新选项）');
      eq(posts[0].persistAgent, true, '「该 Agent 永久」→ persistAgent:true（服务端在答复里一并落库）');
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

  ok((await page.locator('[data-permission-option]').count()) === 3, '群聊审批卡正常出现（拒绝两颗 + 确认主按钮）');
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
