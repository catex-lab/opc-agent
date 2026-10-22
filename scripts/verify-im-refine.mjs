/**
 * 这一轮 IM 细节打磨的验证（六项改动）。
 *
 *   [1] 消息列表栏：没有「消息」标题、没有「N 个会话」统计；
 *       搜索框上移到栏头，新建按钮在它右侧，两者同高（h-9）
 *   [2] 最左侧导航条收窄到 56px，标题栏应用标记仍与导航图标同一竖轴
 *   [3] 群聊：点群名就地改名（回车保存 / Esc 取消），并 PATCH 到后端
 *   [4] 群聊成员栏：可折叠成 44px 竖条，再展开回 236px
 *   [5] 群聊：发送后输入框清空（在 verify-groupchat.mjs 的真 SSE 流程里断言）
 *   [6] 控制台无错误
 *
 * 详情弹窗（原「抽屉」）在 verify-header-contacts.mjs 里断言。
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-im-refine.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
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

// ── 夹具 ──────────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'cursor', name: 'Cursor Agent', vendor: 'Anysphere', kind: 'acp', icon: 'cursor', color: '#43413C', description: '编辑器内联协作', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '0.42.0' }, permissionSupport: { enforced: ['default'] } },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
  { id: 'g1', title: '', agent_id: null, model: null, kind: 'group', agent_ids: JSON.stringify(['workbuddy', 'claude', 'cursor']), orchestration: 'dispatch', created_at: new Date(Date.now() - 36e5).toISOString() },
  // s2 只用来验「打开就落在最后一条」：40 条消息足够撑出滚动条，
  // 又短到能在一次截图里看不出差别 —— 判据是 scrollTop，不是眼睛
  { id: 's2', title: 'Claude Code', agent_id: 'claude', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date(Date.now() - 72e5).toISOString() },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '帮我看下品牌色', created_at: new Date(Date.now() - 6e4).toISOString() },
  { id: 'm2', session_id: 's1', role: 'assistant', content: '已经统一成石墨黑。', model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy', created_at: new Date().toISOString() , blocks: [
      { id: 'b1', type: 'thinking', text: '先确认控件描边走的是 --td-component-stroke。', state: 'done', format: 'raw', startedAt: Date.now() - 3000, endedAt: Date.now() - 1000 },
      { id: 'b2', type: 'text', text: '已经统一成石墨黑。', state: 'done' },
    ] },
  { id: 'm3', session_id: 'g1', role: 'user', content: '拉个群', created_at: new Date(Date.now() - 18e5).toISOString() },
  { id: 'm4', session_id: 'g1', role: 'assistant', content: '好。', model: 'claude-sonnet-4-5', author_agent_id: 'claude', created_at: new Date(Date.now() - 17e5).toISOString() , blocks: [
      { id: 'g1b1', type: 'thinking', text: '先确认控件描边走的是 --td-component-stroke。', state: 'done', format: 'raw', startedAt: Date.now() - 3000, endedAt: Date.now() - 1000 },
      { id: 'g1b2', type: 'text', text: '好。', state: 'done' },
    ] },
  ...Array.from({ length: 40 }, (_, i) => ({
    id: `s2m${i}`,
    session_id: 's2',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${i + 1} 条历史消息：这是一段足够长的正文，用来把会话撑出滚动条，从而验证打开时是不是直接落在最后一条。`,
    model: 'claude-sonnet-4-5',
    author_agent_id: 'claude',
    created_at: new Date(Date.now() - (40 - i) * 6e4).toISOString(),
  })),
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** 记录 PATCH /api/sessions/:id 的请求体，验证改名真的发给了后端 */
const patches = [];
await ctx.route('**/api/**', async route => {
  const req = route.request();
  const url = req.url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (req.method() === 'PATCH' && /\/api\/sessions\/[^/]+$/.test(url)) {
    patches.push({ url, body: req.postDataJSON() });
    return json({ ok: true });
  }
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

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

/**
 * 记录每一次 scrollIntoView 的 behavior。
 *
 * 「打开会话有没有从第一条滑下来」光看最终位置是看不出来的 —— 平滑滚动
 * 一秒后也会停在底部。所以直接抓调用参数：切会话那一次必须是 `auto`
 * （瞬移），不是 `smooth`。
 */
await page.addInitScript(() => {
  window.__scrollBehaviors = [];
  const orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (arg) {
    window.__scrollBehaviors.push(
      arg && typeof arg === 'object' ? arg.behavior ?? 'auto' : 'auto'
    );
    return orig.apply(this, arguments);
  };
});

async function go(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
}
const shot = name => page.screenshot({ path: join(OUT, `${name}.png`) });

// ============= [1] 消息列表栏头 =============
console.log('\n[1] 消息列表栏：无标题无统计，搜索框 + 新建按钮同高');
await go('/chat/s1');
{
  const bar = await page.evaluate(() => {
    const box = el => (el ? el.getBoundingClientRect() : null);
    const header = document.querySelector('header');
    const input = document.querySelector('input[placeholder="搜索会话"]');
    const pill = input?.parentElement ?? null;
    const btn = document.querySelector('header button[title="新建"]');
    const firstRow = document.querySelector('.tc-list-item');
    const p = box(pill);
    const b = box(btn);
    const h = box(header);
    const f = box(firstRow);
    return {
      headerText: (header?.innerText ?? '').trim(),
      headerH: h ? Math.round(h.height) : 0,
      pillH: p ? Math.round(p.height) : 0,
      btnH: b ? Math.round(b.height) : 0,
      pillMidY: p ? Math.round(p.top + p.height / 2) : 0,
      btnMidY: b ? Math.round(b.top + b.height / 2) : 0,
      pillRight: p ? Math.round(p.right) : 0,
      btnLeft: b ? Math.round(b.left) : 0,
      pillTop: p ? Math.round(p.top) : 0,
      firstRowTop: f ? Math.round(f.top) : 0,
      // 会话头部（compact）用来比对「两栏顶部齐平」
      chatHeaderH: (() => {
        const mh = document.querySelector('main header');
        const r = box(mh);
        return r ? Math.round(r.height) : 0;
      })(),
    };
  });

  ok(bar.headerText === '', '栏头没有「消息」标题与「N 个会话」统计', JSON.stringify(bar.headerText));
  ok(bar.pillH === 36, '搜索框高 36px（h-9）', `${bar.pillH}px`);
  ok(bar.btnH === 36, '新建按钮同高 36px', `${bar.btnH}px`);
  ok(Math.abs(bar.pillMidY - bar.btnMidY) <= 1, '搜索框与新建按钮同一条中线', `${bar.pillMidY} / ${bar.btnMidY}`);
  ok(bar.btnLeft > bar.pillRight, '新建按钮在搜索框右侧', `btnLeft=${bar.btnLeft} > pillRight=${bar.pillRight}`);
  ok(bar.pillTop < bar.firstRowTop, '搜索框在列表之上（不再吸顶在列表里）', `${bar.pillTop} < ${bar.firstRowTop}`);
  ok(Math.abs(bar.headerH - bar.chatHeaderH) <= 1, '栏头与会话头部同高（两栏顶边线齐平）', `${bar.headerH} / ${bar.chatHeaderH}`);
}
await shot('im-refine-column');

// ============= [2] 导航条宽度 + 没有数量角标 =============
console.log('\n[2] 最左侧导航条：收窄、无角标');
{
  const rail = await page.evaluate(() => {
    const nav = document.querySelector('nav');
    const navBtn = nav?.querySelector('button');
    const tile = document.querySelector('[data-titlebar] > span > span');
    const mid = el => {
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2);
    };
    const btns = [...(nav?.querySelectorAll('button') ?? [])];
    return {
      navW: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
      navBtnCx: navBtn ? mid(navBtn) : 0,
      tileCx: tile ? mid(tile) : 0,
      // 角标是导航按钮里唯一的文本节点，去掉后按钮 innerText 应为空
      btnTexts: btns.map(b => b.innerText.trim()),
    };
  });
  ok(rail.navW === 56, '导航条宽 56px（原 64）', `${rail.navW}px`);
  ok(Math.abs(rail.tileCx - rail.navBtnCx) <= 1, '标题栏应用标记与导航图标同一竖轴', `${rail.tileCx} / ${rail.navBtnCx}`);
  ok(
    rail.btnTexts.every(t => t === ''),
    '导航图标上没有任何数字角标',
    JSON.stringify(rail.btnTexts)
  );
}

// ============= [3] 群名就地改名 =============
console.log('\n[3] 群聊：点群名就地改名');
await go('/chat/g1');
{
  const nameBtn = page.locator('main header button[title="点击修改群名"]');
  ok((await nameBtn.count()) === 1, '群名可点（提示「点击修改群名」）');
  ok((await page.locator('main header input[aria-label="群聊名称"]').count()) === 0, '未点击时不显示输入框');

  await nameBtn.click();
  await page.waitForTimeout(200);
  const input = page.locator('main header input[aria-label="群聊名称"]');
  ok((await input.count()) === 1, '点击后就地变成输入框');
  ok((await input.inputValue()).length > 0, '输入框预填当前群名', await input.inputValue());

  await input.fill('设计评审群');
  await input.press('Enter');
  await page.waitForTimeout(400);
  const after = await page.locator('main header').innerText();
  ok(after.includes('设计评审群'), '回车后头部显示新群名', after.replace(/\n/g, ' ').slice(0, 40));
  ok((await page.locator('main header input[aria-label="群聊名称"]').count()) === 0, '保存后输入框收起');
  ok(
    patches.some(p => p.url.endsWith('/api/sessions/g1') && p.body?.title === '设计评审群'),
    '改名 PATCH 到后端',
    JSON.stringify(patches.map(p => p.body))
  );
  await shot('im-refine-rename');
}

// Esc 取消：改名不生效
{
  await page.locator('main header button[title="点击修改群名"]').click();
  await page.waitForTimeout(150);
  const input = page.locator('main header input[aria-label="群聊名称"]');
  await input.fill('不该被保存');
  await input.press('Escape');
  await page.waitForTimeout(300);
  const after = await page.locator('main header').innerText();
  ok(after.includes('设计评审群'), 'Esc 取消后仍是原群名', after.replace(/\n/g, ' ').slice(0, 40));
  ok(
    !patches.some(p => p.body?.title === '不该被保存'),
    'Esc 取消没有发 PATCH',
    JSON.stringify(patches.map(p => p.body))
  );
}

// ============= [4] 成员栏折叠 / 展开 =============
console.log('\n[4] 群聊成员栏：默认折叠，鼠标移到右缘才浮出按钮');
{
  // A72 起默认折叠（用户要求）：这一栏是「谁在群里」的查阅面板，不是聊天主路径。
  // 236px 常驻会把消息区挤掉四分之一，而用户九成时间不需要看它。
  ok(
    (await page.locator('aside[aria-label="群聊成员"]').count()) === 0,
    '**默认折叠**（不再常驻占 236px）'
  );

  const edge = page.locator('[data-member-panel-collapsed]');
  ok((await edge.count()) === 1, '右缘留了一条悬停热区');
  const w1 = Math.round((await edge.boundingBox()).width);
  ok(w1 === 10, '热区只有 10px（不占版面）', `${w1}px`);

  const expandBtn = edge.locator('button');
  const opacity = () => expandBtn.evaluate(el => getComputedStyle(el).opacity);
  ok((await opacity()) === '0', '未悬停时展开按钮不可见', await opacity());

  await edge.hover();
  await page.waitForTimeout(350);
  ok((await opacity()) === '1', '鼠标移到右缘后浮出展开按钮', await opacity());
  await shot('im-refine-collapsed');

  // 展开 → 量宽度 → 再折叠 → 再展开：三个状态都走一遍，
  // 确认折叠不是"一次性开关"（展过一次就再也收不回去那种 bug）
  await expandBtn.click();
  await page.waitForTimeout(300);
  const expanded = page.locator('aside[aria-label="群聊成员"]');
  ok((await expanded.count()) === 1, '点一下就展开');
  const w0 = Math.round((await expanded.boundingBox()).width);
  ok(w0 === 236, '展开宽 236px', `${w0}px`);

  await page.locator('button[aria-label="折叠成员栏"]').click();
  await page.waitForTimeout(300);
  ok(
    (await page.locator('aside[aria-label="群聊成员"]').count()) === 0,
    '再点一次折叠，成员栏整块消失（不再留一条占位的竖条）'
  );

  await edge.hover();
  await page.waitForTimeout(200);
  await expandBtn.click();
  await page.waitForTimeout(300);
  const back = page.locator('aside[aria-label="群聊成员"]');
  ok((await back.count()) === 1, '再展开回来（折叠不是一次性的）');
  const w2 = Math.round((await back.boundingBox()).width);
  ok(w2 === 236, '宽度复原', `${w2}px`);
}

// ============= [5] 板块分割线（A25 起取消） =============
console.log('\n[5] 板块分割线：已取消，控件描边仍在');
{
  const read = () => page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const nav = document.querySelector('nav');
    const header = document.querySelector('header');
    // 输入框在 TDesign ChatSender 的 shadow DOM 里，`document.querySelector('textarea')`
    // 取不到。A33 用思考块的描边当探针，A35 思考块也去卡片化，改成临时元素
    // 直接读 `--td-component-stroke`（断言的是令牌本身，与具体元素无关）。
    const probe = document.createElement('div');
    probe.style.border = '1px solid var(--td-component-stroke)';
    document.body.appendChild(probe);
    const strokeColor = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return {
      divider: cs.getPropertyValue('--tc-divider').trim(),
      stroke: cs.getPropertyValue('--td-component-stroke').trim(),
      navBorder: nav ? getComputedStyle(nav).borderRightColor : null,
      headerBorder: header ? getComputedStyle(header).borderBottomColor : null,
      bubbleBorder: strokeColor,
    };
  });
  // 透明边框在计算样式里有两种写法：`rgba(0, 0, 0, 0)` 或关键字 `transparent`
  const invisible = v => v === 'rgba(0, 0, 0, 0)' || v === 'transparent';

  const light = await read();
  ok(light.divider === 'transparent', '浅色 --tc-divider = transparent（A25 取消分割线）', light.divider);
  ok(invisible(light.navBorder), '浅色：导航条右边线不可见', light.navBorder);
  ok(invisible(light.headerBorder), '浅色：栏头底边线不可见', light.headerBorder);
  ok(!invisible(light.stroke), '控件描边仍有实色（输入框/按钮不能一起透明）', light.stroke);
  ok(light.bubbleBorder === 'rgb(229, 229, 229)', '浅色：思考块描边仍是 --td-component-stroke', light.bubbleBorder);

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(400);
  const dark = await read();
  ok(dark.divider === 'transparent', '深色 --tc-divider 同样是 transparent', dark.divider);
  ok(invisible(dark.navBorder), '深色：导航条右边线不可见', dark.navBorder);
  ok(invisible(dark.headerBorder), '深色：栏头底边线不可见', dark.headerBorder);
  ok(dark.stroke !== 'transparent', '深色控件描边仍是实色', dark.stroke);
  await shot('im-refine-dark-dividers');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.waitForTimeout(200);
}

// ============= [6] 打开会话直接落在最后一条 =============
console.log('\n[6] 打开会话：直接落在最后一条，不从第一条滑下来');
await go('/chat/s2');
{
  const r = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(d => {
      const cs = getComputedStyle(d);
      return (
        (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
        d.scrollHeight > d.clientHeight + 40
      );
    });
    return {
      behaviors: (window.__scrollBehaviors || []).slice(),
      atBottom: el ? Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) <= 4 : null,
      top: el ? Math.round(el.scrollTop) : null,
      sh: el ? el.scrollHeight : null,
      ch: el ? el.clientHeight : null,
    };
  });
  ok(r.behaviors.length > 0, '确实发生过滚动定位', JSON.stringify(r.behaviors));
  ok(
    r.behaviors.every(b => b !== 'smooth'),
    '切会话用的是瞬移（没有 smooth 动画）',
    JSON.stringify(r.behaviors)
  );
  ok(r.atBottom === true, '打开时已经在最后一条', `top=${r.top} sh=${r.sh} ch=${r.ch}`);
}

// ============= [7] 右键只弹一个浮层 =============
console.log('\n[7] 消息列表右键：不会叠两个窗');
await go('/');
{
  const row = page.locator('.tc-list-item').first();
  // 先悬停让名片弹出来，再右键 —— 这正是用户复现的路径
  await row.hover({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => document.querySelectorAll('[role="tooltip"]').length);
  await row.click({ button: 'right', position: { x: 20, y: 20 } });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    menus: document.querySelectorAll('[role="menu"]').length,
    tooltips: document.querySelectorAll('[role="tooltip"]').length,
  }));
  ok(before === 1, '右键前悬停名片确实弹着（复现路径成立）', `tooltips=${before}`);
  ok(after.menus === 1, '右键只弹出一个菜单', JSON.stringify(after));
  ok(after.tooltips === 0, '右键时悬停名片自动收起（不会两个窗叠在一起）', JSON.stringify(after));
  await shot('im-refine-context-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// ============= [8] 控制台 =============
console.log('\n[8] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ').slice(0, 200));

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败（共 ${checks.total} 项）：`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✓ ${checks.total}/${checks.total} 全部通过`);
