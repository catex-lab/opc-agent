/**
 * 授权范围选择器（2026-11-12 变体 A）浏览器打靶。
 *
 * 为什么必须真开浏览器：选择器是 Dock 卡片的一部分，渲染在 createPortal
 * 的 React 树之外；「默认选中仅本次」「选中 1.5px 品牌描边」「确认文案随
 * 范围变化」「设置页的授权行随撤销消失」全部是布局/渲染事实，只看源码
 * 证明不了用户看得见。断言用真实鼠标坐标 + elementFromPoint 自证落点。
 *
 * 夹具矩阵：
 *   [1] 选择器条件渲染 —— SDK 四档画；CLI 两档不画（协议只有 allow/deny，
 *       不画假档位）；ACP 单 always 档不画（三段缺「仅本次」的真档位）；
 *   [2] 选中态：真实坐标点「本会话」段 → aria-checked 迁移 + 选中样式；
 *   [3] 确认文案随动 + 「该 Agent 永久」的边界说明只在该档出现；
 *   [4] 答复链路：选「该 Agent 永久」→ 确认 → 请求体带 persistAgent:true；
 *       Enter 快捷键按当前选中范围答复；
 *   [5] 设置→权限管理：持久授权行出现、撤销即消失、空态与边界说明如实；
 *   [6] 控制台无错误。
 *
 * 运行：npm run build && node scripts/verify-permission-scope-ui.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check', 'permission-scope');
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
/** CLI 双向协议只有 allow/deny 两档（shared/permissions.ts 的铁律夹具） */
const CLI_OPTIONS = [
  { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
  { id: 'allow_once', kind: 'allow_once', label: '允许' },
];
/** ACP 目录可能只有一个 always 档 —— 缺「仅本次」的真档位，三段不画 */
const ACP_SINGLE_ALWAYS = [
  { id: 'o1', kind: 'allow_always', label: '允许' },
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
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '清理构建目录', created_at: new Date(Date.now() - 60000).toISOString() },
];

const permissionEvent = (overrides = {}) => ({
  type: 'permission_request', requestId: 'q1', toolUseId: 't1', toolName: 'Bash',
  input: { command: 'npm run build' }, risk: 'risky', rule: '构建',
  options: SDK_OPTIONS, expiresAt: Date.now() + 5 * 60 * 1000,
  ...overrides,
});

const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

/** 授权夹具状态：设置页的 GET/DELETE 都打这份（撤销真的会摘行） */
const GRANTS = [
  { id: 1, agent_id: 'workbuddy', tool_name: 'Bash', created_at: '2026-11-12T21:32:00.000Z' },
  { id: 2, agent_id: 'hermes', tool_name: '执行命令', created_at: '2026-11-11T18:05:00.000Z' },
];

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
 * @param {object[]} frames  permission_request SSE 帧
 * @param {{ grants?: boolean }} opts  true 时挂设置页的授权夹具路由
 */
async function newPage(frames, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  const posts = [];
  const deletes = [];
  const streamBody = sse([...frames, { type: 'done' }]);

  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const url = req.url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

    if (url.includes('/api/permission-response')) {
      try { posts.push(req.postDataJSON()); } catch { posts.push(null); }
      return json({ success: true, agentId: 'workbuddy' });
    }
    if (url.includes('/api/permission-grants')) {
      if (req.method() === 'GET') return json({ grants: [...GRANTS] });
      if (req.method() === 'DELETE') {
        try { deletes.push(req.postDataJSON()); } catch { deletes.push(null); }
        const d = deletes[deletes.length - 1] ?? {};
        const i = GRANTS.findIndex(g => g.agent_id === d.agentId && g.tool_name === d.toolName);
        if (i >= 0) GRANTS.splice(i, 1);
        return json({ success: true });
      }
      return json({ grants: [] });
    }
    if (url.includes('/api/permission-rules')) return json({ rules: [], note: '' });
    if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamBody });
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

  return { ctx, page, posts, deletes };
}

async function sendMessage(page) {
  const ta = page.locator('textarea').first();
  await ta.fill('执行一下');
  await page.waitForTimeout(120);
  await page
    .locator('t-chat-sender button, [class*="chat-input__actions"] button')
    .last()
    .click({ timeout: 5000 });
  await page.waitForSelector('[data-permission-card]', { timeout: 8000 });
  await page.waitForTimeout(250);
}

// ============= [1] 选择器条件渲染：目录决定档位，不画假段 =============
console.log('\n[1] 选择器只在三段都有真档位时渲染');
{
  // SDK 四档 → 画
  {
    const { ctx, page } = await newPage([permissionEvent()]);
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);
    eq(
      await page.locator('[data-permission-scope-option]').count(), 3,
      'SDK 四档 → 三段选择器渲染'
    );
    await page.screenshot({ path: join(OUT, 'scope-selector.png'), fullPage: false });
    await ctx.close();
  }
  // CLI 两档 → 不画（协议只有 allow/deny，「该 Agent 永久」无从产生）
  {
    const { ctx, page } = await newPage([permissionEvent({ requestId: 'cli1', options: CLI_OPTIONS, risk: undefined })]);
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);
    eq(
      await page.locator('[data-permission-scope]').count(), 0,
      'CLI 两档 → 不画选择器（不画假档位，效果稿注释①）'
    );
    eq(
      await page.evaluate(() => [...document.querySelectorAll('[data-permission-option]')].map(b => b.textContent.trim())),
      ['拒绝', '允许'],
      'CLI 两档按钮原样渲染（合并不重排都没有）'
    );
    await ctx.close();
  }
  // ACP 单 always 档 → 不画（缺「仅本次」的真档位，段位会是假的）
  {
    const { ctx, page } = await newPage([permissionEvent({ requestId: 'acp1', options: ACP_SINGLE_ALWAYS, risk: 'safe', expiresAt: undefined })]);
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);
    eq(
      await page.locator('[data-permission-scope]').count(), 0,
      'ACP 单 always 档 → 不画选择器（缺一档就不摆三段）'
    );
    await ctx.close();
  }
}

// ============= [2] 选中态：真实坐标点击 + 样式自证 =============
console.log('\n[2] 点「本会话」段：aria-checked 迁移、选中样式可量测');
{
  const { ctx, page } = await newPage([permissionEvent()]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  // 真实鼠标坐标 + elementFromPoint 自证这一下确实点在段上
  const seg = page.locator('[data-permission-scope-option="session"]');
  const box = await seg.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const probe = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return { hit: el?.getAttribute?.('data-permission-scope-option') ?? null, tag: el?.tagName ?? '' };
    },
    [cx, cy]
  );
  eq(probe.hit, 'session', `自证坐标 (${Math.round(cx)}, ${Math.round(cy)}) 落在「本会话」段上`);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(200);

  const state = await page.evaluate(() => ({
    checked: [...document.querySelectorAll('[data-permission-scope-option]')].map(
      el => el.getAttribute('aria-checked')
    ),
    focusable: [...document.querySelectorAll('[data-permission-scope-option]')].map(
      el => el.getAttribute('tabindex')
    ),
    styles: [...document.querySelectorAll('[data-permission-scope-option]')].map(el => {
      const cs = getComputedStyle(el);
      return { borderColor: cs.borderTopColor, bg: cs.backgroundColor };
    }),
  }));
  eq(state.checked, ['false', 'true', 'false'], 'aria-checked 迁移到「本会话」');
  eq(state.focusable, ['-1', '0', '-1'], 'roving tabindex 跟着选中段走');
  ok(
    state.styles[1].borderColor !== state.styles[0].borderColor && state.styles[1].bg !== state.styles[0].bg,
    '选中段与未选中段的描边色、底色可区分（不是只靠 aria）',
    `选中边 ${state.styles[1].borderColor} / 未选中边 ${state.styles[0].borderColor}；选中底 ${state.styles[1].bg}`
  );
  await page.screenshot({ path: join(OUT, 'scope-selected-session.png'), fullPage: false });
  await ctx.close();
}

// ============= [3] 确认文案随动 + 边界说明只在该档出现 =============
console.log('\n[3] 确认文案随范围变化；「该 Agent 永久」才出现持久化说明');
{
  const { ctx, page } = await newPage([permissionEvent()]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  const labelOf = () => page.locator('[data-permission-confirm="1"]').innerText();
  eq((await labelOf()).trim(), '允许', '默认（仅本次）→ 允许');
  eq(await page.locator('[data-permission-scope-hint]').count(), 0, '默认不画持久化说明');

  await page.locator('[data-permission-scope-option="session"]').click();
  await page.waitForTimeout(120);
  eq((await labelOf()).trim(), '允许（本会话）', '本会话 → 允许（本会话）');
  eq(await page.locator('[data-permission-scope-hint]').count(), 0, '本会话档不画持久化说明');

  await page.locator('[data-permission-scope-option="agent"]').click();
  await page.waitForTimeout(120);
  eq((await labelOf()).trim(), '允许（该 Agent 永久）', '该 Agent 永久 → 允许（该 Agent 永久）');
  const hint = await page.locator('[data-permission-scope-hint]').innerText();
  ok(/撤销/.test(hint) && /门禁/.test(hint), '说明写明两件事：可在设置撤销 + 高危仍被门禁拦', hint);
  await page.screenshot({ path: join(OUT, 'scope-agent-hint.png'), fullPage: false });
  await ctx.close();
}

// ============= [4] 答复链路：persistAgent 真的进了请求体 =============
console.log('\n[4] 选「该 Agent 永久」→ 确认与 Enter 都带 persistAgent:true');
{
  {
    const { ctx, page, posts } = await newPage([permissionEvent()]);
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    await page.locator('[data-permission-scope-option="agent"]').click();
    await page.waitForTimeout(120);
    await page.locator('[data-permission-confirm="1"]').click();
    await page.waitForTimeout(400);

    eq(posts.length, 1, '只发一条答复');
    eq(
      posts[0],
      { requestId: 'q1', behavior: 'allow', optionId: 'allow_always', persistAgent: true },
      '请求体：allow + allow_always + persistAgent:true（服务端据此在同一请求里落库）'
    );
    await ctx.close();
  }
  // Enter 快捷键按当前选中范围答复（Dock 层共享同一份 scope 状态）。
  // 键盘切段必须先验 —— 答复之后卡片就摘了，没有「再按一次」的机会。
  {
    const { ctx, page, posts } = await newPage([permissionEvent()]);
    await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await sendMessage(page);

    // 键盘切段：焦点在选中段上按 ArrowRight 应迁到下一段（radiogroup 语义）
    await page.locator('[data-permission-scope-option="once"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const checked = await page.evaluate(() =>
      [...document.querySelectorAll('[data-permission-scope-option]')].map(el => el.getAttribute('aria-checked'))
    );
    eq(checked, ['false', 'true', 'false'], 'ArrowRight 把选中迁到「本会话」（radiogroup 键盘语义）');

    // 然后选「该 Agent 永久」→ Enter：按选中范围答复
    await page.locator('[data-permission-scope-option="agent"]').click();
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    eq(posts[0]?.persistAgent, true, 'Enter 按选中范围答复（不是写死的 allow_once）');
    eq(posts[0]?.optionId, 'allow_always', 'Enter 回传 allow_always 档');
    await ctx.close();
  }
}

// ============= [5] 设置 → 权限管理：可查可撤销，空态与边界如实 =============
console.log('\n[5] 设置→权限管理：授权行、撤销即消失、空态与边界说明');
{
  const { ctx, page, deletes } = await newPage([], { grants: true });
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
  await page.locator('[data-settings-section="permission"]').first().click();
  await page.waitForSelector('[data-permission-mgr]', { timeout: 8000 });
  await page.waitForTimeout(400);

  eq(
    await page.locator('[data-permission-grant-row]').count(), 2,
    '两条持久授权各占一行'
  );
  const rowText = await page.locator('[data-permission-grant-row]').first().innerText();
  ok(/WorkBuddy/.test(rowText), 'Agent 列显示名册里的名字（不是裸 id）', rowText.replace(/\s+/g, ' ').slice(0, 60));
  ok(/Bash/.test(rowText), '工具列原样展示 toolName');
  ok(/该 Agent 永久/.test(rowText), '范围 pill 写明持久档');
  // 授权时间取到分钟、按本地时区渲染 —— 夹具给 UTC 串，期望值用同一公式算，
  // 不假设测试机的时区
  const expectedTime = (() => {
    const d = new Date('2026-11-12T21:32:00.000Z');
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  })();
  ok(rowText.includes(expectedTime), '授权时间落到了分钟（本地时区）', expectedTime);

  // 撤销：真发 DELETE（带 agentId+toolName），成功后行消失
  await page.locator('[data-permission-grant-row]').first().locator('[data-permission-revoke]').click();
  await page.waitForTimeout(600);
  eq(deletes.length, 1, '撤销发了一次 DELETE');
  eq(
    { agentId: deletes[0]?.agentId, toolName: deletes[0]?.toolName },
    { agentId: 'workbuddy', toolName: 'Bash' },
    'DELETE 带上 agentId + toolName（服务端按同一把键删）'
  );
  eq(
    await page.locator('[data-permission-grant-row]').count(), 1,
    '撤销成功后该行消失（不是假装删了）'
  );

  // 边界说明永远在场：会话级授权列不了就直说
  const hint = await page.locator('[data-permission-mgr-hint]').innerText();
  ok(/内存|重启/.test(hint), '分区底部说明会话级授权的如实边界', hint);
  await page.screenshot({ path: join(OUT, 'settings-grants.png'), fullPage: false });
  await ctx.close();

  // 空态：一条授权都没有时给一句说明，不渲染空表格
  GRANTS.length = 0;
  {
    const { ctx, page } = await newPage([], { grants: true });
    await page.goto(base + '/settings', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
    await page.locator('[data-settings-section="permission"]').first().click();
    await page.waitForSelector('[data-permission-mgr]', { timeout: 8000 });
    await page.waitForTimeout(400);
    ok(await page.locator('[data-permission-mgr-empty]').isVisible(), '空态有一句话说明（不是空表格）');
    eq(await page.locator('[data-permission-grant-row]').count(), 0, '空态不渲染任何授权行');
    await page.screenshot({ path: join(OUT, 'settings-grants-empty.png'), fullPage: false });
    await ctx.close();
  }
}

// ============= [6] 控制台 =============
console.log('\n[6] 控制台');
{
  const real = consoleErrors.filter(e => !/favicon|Download the React DevTools/i.test(e));
  ok(real.length === 0, '无控制台错误', real.slice(0, 3).join(' | ') || '0');
}

await browser.close();
server.close();

console.log(`\n授权范围选择器（变体 A）：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
