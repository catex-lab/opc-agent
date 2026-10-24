/**
 * QQ 化 UI 的验证（悬停名片 / 群成员栏 / 右键菜单 / 通讯录搜索行 / 视觉令牌）。
 *
 * 五条断言主线，对应这一轮的五项需求：
 *   [1] 头像悬停 → 弹出资料卡（延迟出现、移开消失）
 *   [2] 群聊 → 右侧成员栏 + 头部「群名（N）」
 *   [3] 单聊 → 头部名字 + 在线状态
 *   [4] 会话右键 → 置顶 / 标记未读 / 免打扰 / 复制名称 / 删除
 *   [5] 通讯录 → 搜索框 + 右侧「+」+ 联系人/群聊 两个 Tab
 *   [6] 视觉 → 侧栏宽度令牌、会话头部与消息区同色、标题 16px
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-qq-ui.mjs（需先 npm run build）
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
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code', 'tools'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构与代码审查', capabilities: ['chat', 'code', 'write'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'cursor', name: 'Cursor Agent', vendor: 'Anysphere', kind: 'acp', icon: 'cursor', color: '#43413C', description: '编辑器内联协作', capabilities: ['chat', 'code', 'write', 'tools'], status: { availability: 'ready', version: '0.42.0' }, permissionSupport: { enforced: ['default'] } },
  { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#3186FF', description: '多模态与大规模检索', capabilities: ['chat', 'search', 'image'], status: { availability: 'needs-auth', version: '0.9.2', message: '请先完成登录授权' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
];
const MODELS = [
  { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡，日常首选' },
  { modelId: 'claude-opus-4-1', name: 'Claude Opus 4.1', description: '最强推理' },
];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
  { id: 'g1', title: '', agent_id: null, model: null, kind: 'group', agent_ids: JSON.stringify(['workbuddy', 'claude', 'gemini']), orchestration: 'dispatch', created_at: new Date(Date.now() - 36e5).toISOString() },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '帮我确认一下品牌色', created_at: new Date(Date.now() - 6e4).toISOString() },
  { id: 'm2', session_id: 's1', role: 'assistant', content: '确实有两套品牌蓝。', model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy', created_at: new Date().toISOString() },
  { id: 'm3', session_id: 'g1', role: 'user', content: '拉个群', created_at: new Date(Date.now() - 18e5).toISOString() },
  { id: 'm4', session_id: 'g1', role: 'assistant', content: '好。', model: 'claude-sonnet-4-5', author_agent_id: 'claude', created_at: new Date(Date.now() - 17e5).toISOString() },
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

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
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

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

async function go(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
}
const shot = name => page.screenshot({ path: join(OUT, `${name}.png`) });

// ============= [1] 头像悬停名片 =============
console.log('\n[1] 头像悬停名片');
await go('/');
await page.locator('nav button').nth(1).click();
await page.waitForTimeout(900);

// 通讯录列表不再分段（在线/待处理/未接入），所以定位头像不能依赖 <section>。
// 用行本身（.tc-list-item）+ 悬停触发区（span.inline-flex）。
const firstAvatar = page.locator('.tc-list-item span.inline-flex').first();
ok((await firstAvatar.count()) === 1, '通讯录行里有可悬停的头像区');
await firstAvatar.hover();
// 名片有 240ms 延迟：先确认「不是立刻弹」，再等它出现
await page.waitForTimeout(120);
ok((await page.getByRole('tooltip').count()) === 0, '悬停 120ms 内不弹（避免扫列表时满屏乱闪）');
await page.waitForTimeout(400);
ok((await page.getByRole('tooltip').count()) === 1, '悬停约 240ms 后弹出名片');
{
  const card = page.getByRole('tooltip');
  const text = await card.innerText().catch(() => '');
  ok(text.includes('WorkBuddy'), '名片显示名字', text.replace(/\n/g, ' ').slice(0, 40));
  ok(text.includes('腾讯'), '名片显示厂商');
  ok(text.includes('擅长') && text.includes('代码'), '名片显示擅长领域');
  ok(text.includes('在线'), '名片显示在线状态');
  ok((await card.getByRole('button', { name: '查看资料' }).count()) === 1, '名片有「查看资料」按钮');
}
await shot('qq-hover-card');
await page.mouse.move(700, 500);
await page.waitForTimeout(500);
ok((await page.getByRole('tooltip').count()) === 0, '移开后名片消失');

// ============= [2] 群聊：右栏 + 头部人数 =============
console.log('\n[2] 群聊成员栏');
await go('/chat/g1');
const memberPanel = page.locator('aside[aria-label="群聊成员"]');
// A72 起默认折叠：成员栏是查阅面板，236px 常驻会挤掉消息区四分之一。
// 先断言「默认不在」，再展开验内容 —— 内容没变，只是默认态变了。
ok((await memberPanel.count()) === 0, '**默认折叠**（A72：不常驻占 236px）');
await page.locator('[data-member-panel-collapsed]').hover();
await page.waitForTimeout(250);
await page.locator('[data-member-panel-collapsed] button').click();
await page.waitForTimeout(400);
ok((await memberPanel.count()) === 1, '展开后群聊右侧有成员栏');
{
  const box = await memberPanel.boundingBox();
  ok(!!box && Math.round(box.width) === 236, '成员栏宽度 = 236px', box ? `w=${Math.round(box.width)}` : '无 box');
  const text = await memberPanel.innerText();
  ok(text.includes('群聊成员'), '成员栏标题在位');
  ok(text.includes('3'), '成员栏显示人数', text.replace(/\n/g, ' ').slice(0, 40));
  ok((await memberPanel.locator('.tc-list-item').count()) === 3, '成员栏列出 3 个成员');
  // 非在线成员带状态说明，在线成员不带 —— 有状态文字才需要标
  ok(text.includes('未登录'), '离线成员如实标状态');
}
{
  const gHeaderText = await page.locator('main header').first().innerText();
  ok(gHeaderText.includes('（3）'), '群名后显示人数「（3）」', gHeaderText.replace(/\n/g, ' ').slice(0, 40));
  ok(gHeaderText.includes('2 在线'), '头部显示在线人数');
}
// 成员栏里悬停也能出名片
await memberPanel.locator('span.inline-flex').first().hover();
await page.waitForTimeout(500);
ok((await page.getByRole('tooltip').count()) === 1, '成员栏头像同样可悬停出名片');
await page.mouse.move(200, 700);
await page.waitForTimeout(400);
await shot('qq-group-members');

// 单聊不应出现成员栏
await go('/chat/s1');
ok((await page.locator('aside[aria-label="群聊成员"]').count()) === 0, '单聊没有成员栏');

// ============= [3] 单聊头部 =============
console.log('\n[3] 单聊头部：名字 + 在线状态');
{
  const header = page.locator('main header').first();
  const text = await header.innerText();
  ok(text.includes('WorkBuddy'), '头部显示联系人名', text.replace(/\n/g, ' ').slice(0, 30));
  ok(text.includes('在线'), '头部显示在线状态');
  const fs = await header.locator('h1, h2').first().evaluate(el => getComputedStyle(el).fontSize);
  ok(fs === '16px', '会话名 16px（QQ 量级）', fs);
}

// ============= [4] 会话右键菜单 =============
console.log('\n[4] 会话右键菜单');
await go('/');
// 群聊在消息列表里必须显示成员名（而不是退化成「新对话」）
{
  const rows = page.locator('.tc-list-item');
  const texts = await rows.evaluateAll(els => els.map(e => e.innerText.replace(/\n/g, ' ')));
  const groupRow = texts.find(t => t.includes('Claude Code')) ?? '';
  ok(groupRow.length > 0 && !groupRow.includes('新对话'), '群聊行用成员名作标题', groupRow.slice(0, 40));
}
const row = page.locator('.tc-list-item').first();
// 右键在行的右侧文字区：避免鼠标落在头像上把悬停名片也一起触发
await row.click({ button: 'right', position: { x: 200, y: 20 } });
await page.waitForTimeout(300);
const menu = page.getByRole('menu');
ok((await menu.count()) === 1, '右键弹出菜单');
for (const label of ['置顶', '标记未读', '消息免打扰', '复制名称', '删除会话']) {
  ok((await page.getByRole('menuitem', { name: label }).count()) === 1, `菜单项「${label}」在位`);
}
await shot('qq-context-menu');

// 免打扰：点完菜单关闭、行尾出现静音图标
await page.getByRole('menuitem', { name: '消息免打扰' }).click();
await page.waitForTimeout(300);
ok((await page.getByRole('menu').count()) === 0, '点菜单项后菜单关闭');
ok((await page.locator('[aria-label="消息免打扰"]').count()) === 1, '行尾出现免打扰图标');
// 再右键：菜单项应变成「取消免打扰」
await row.click({ button: 'right', position: { x: 200, y: 20 } });
await page.waitForTimeout(300);
ok((await page.getByRole('menuitem', { name: '取消免打扰' }).count()) === 1, '免打扰后菜单变成「取消免打扰」');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// 标记未读：红点出现
await row.click({ button: 'right', position: { x: 200, y: 20 } });
await page.waitForTimeout(250);
await page.getByRole('menuitem', { name: '标记未读' }).click();
await page.waitForTimeout(300);
ok((await row.locator('[title="有新消息"]').count()) === 1, '标记未读后出现红点');

// ============= [4b] 右键头像 → 修改备注（A24 用户要求）=============
console.log('\n[4b] 消息列表：右键改备注');
await page.evaluate(() => localStorage.removeItem('opc:agentRemarks'));
await go('/');
const remarkRow = page.locator('.tc-list-item').first();
// 第一行是一对一会话（夹具里 s1 最近活跃），头像属于 agentId=workbuddy
const beforeName = await remarkRow.locator('.truncate').first().innerText();
await remarkRow.click({ button: 'right', position: { x: 200, y: 20 } });
await page.waitForTimeout(250);
ok((await page.getByRole('menuitem', { name: '修改备注' }).count()) === 1, '右键菜单第一项是「修改备注」');
await page.getByRole('menuitem', { name: '修改备注' }).click();
await page.waitForTimeout(300);
ok((await page.locator('[data-remark-dialog]').count()) === 1, '弹出备注输入弹窗');
await page.locator('[data-remark-input]').fill('我的小助手');
await page.locator('[data-remark-save]').click();
await page.waitForTimeout(300);
ok((await page.locator('[data-remark-dialog]').count()) === 0, '保存后弹窗关闭');
ok(
  (await page.evaluate(() => localStorage.getItem('opc:agentRemarks')) ?? '').includes('我的小助手'),
  '备注写进 localStorage'
);
const afterName = await remarkRow.locator('.truncate').first().innerText();
ok(afterName === '我的小助手', '列表里的显示名立刻换成备注', `${beforeName} → ${afterName}`);

// 清空即删除：留空保存回到原名，不给「空备注」这种半状态
await remarkRow.click({ button: 'right', position: { x: 200, y: 20 } });
await page.waitForTimeout(250);
await page.getByRole('menuitem', { name: '修改备注' }).click();
await page.waitForTimeout(250);
await page.locator('[data-remark-input]').fill('');
await page.locator('[data-remark-save]').click();
await page.waitForTimeout(250);
ok(
  (await page.evaluate(() => localStorage.getItem('opc:agentRemarks'))) === '{}',
  '留空保存 = 删除备注，显示名回到原名'
);

// 通讯录同样可以右键改备注（A24：消息和通讯录两栏都要有）
await page.locator('nav button').nth(1).click();
await page.waitForTimeout(600);
await page.locator('.tc-list-item').first().click({ button: 'right' });
await page.waitForTimeout(250);
ok((await page.getByRole('menuitem', { name: '修改备注' }).count()) === 1, '通讯录行右键也有「修改备注」');
await page.keyboard.press('Escape');
await page.locator('nav button').nth(0).click();
await page.waitForTimeout(600);

// ============= [4c] 输入框聚焦：不再出现黑色轮廓（A24 用户要求）=============
console.log('\n[4c] 输入框聚焦态');
const searchBox = page.getByPlaceholder('搜索会话');
await searchBox.click();
await page.waitForTimeout(200);
const focusStyle = await searchBox.evaluate(el => {
  const cs = getComputedStyle(el);
  return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
});
ok(
  focusStyle.style === 'none' || focusStyle.width === '0px',
  '点进搜索框没有 outline 黑框（品牌色 #1f1f1f 画的 2px 轮廓已撤掉）',
  JSON.stringify(focusStyle)
);

// ============= [5] 通讯录搜索行 =============
console.log('\n[5] 通讯录：搜索框 + 右侧添加 + 两个 Tab');
await page.locator('nav button').nth(1).click();
await page.waitForTimeout(700);
ok((await page.getByPlaceholder('搜索 AGENT、群聊').count()) === 1, '搜索框在位');
ok((await page.getByRole('button', { name: '添加' }).count()) === 1, '搜索框右侧是「+」');
await page.getByRole('button', { name: '添加' }).click();
await page.waitForTimeout(200);
ok((await page.getByRole('button', { name: '发起群聊' }).count()) === 1, '「+」菜单含发起群聊');
ok((await page.getByRole('button', { name: '重新探测' }).count()) === 1, '「+」菜单含重新探测');
await shot('qq-contacts-add');
await page.getByRole('button', { name: '添加' }).click();
{
  const labels = await page.getByRole('tab').evaluateAll(els => els.map(e => e.textContent.trim()));
  ok(labels.join('|') === 'AGENT|群聊', 'Tab = AGENT / 群聊（A72：联系人 → AGENT）', labels.join(' | '));
}

// ============= [6] 视觉令牌 =============
console.log('\n[6] 侧栏宽度 / 头部底色');
{
  const sidebar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--tc-sidebar-width').trim()
  );
  ok(sidebar === '288px', '宽屏侧栏宽度令牌 = 288px', sidebar);
}

// ============= [6b] 侧栏宽度可以手动拖（A23 用户要求）=============
console.log('\n[6b] 拖拽调整左侧二栏宽度');
{
  await go('/chat/s1');
  const handle = page.locator('[data-sidebar-resizer]');
  ok((await handle.count()) === 1, '宽屏下列表栏右侧有拖拽手柄');

  const before = await page.evaluate(() => {
    const col = document.querySelector('[data-sidebar-resizer]')?.previousElementSibling;
    return col ? col.getBoundingClientRect().width : 0;
  });
  const box = await handle.boundingBox();
  ok(!!box && box.width <= 6, '手柄是窄条（不挤占两栏）', box ? `w=${box.width}` : 'n/a');

  // A24 用户反馈：「竖线没有与原来的对齐，导致二栏的色值漂移」。
  // 根因是手柄当年作为一个正常 flex 子项占了 5px：主内容右移 5px，接缝处
  // 多出一条露父容器底色的竖带。现在用负边距把占位抵掉，这三条把它钉住。
  const geom = await page.evaluate(() => {
    const h = document.querySelector('[data-sidebar-resizer]');
    const col = h?.previousElementSibling;
    const main = h?.nextElementSibling;
    if (!h || !col) return null;
    const hr = h.getBoundingClientRect();
    return {
      colRight: Math.round(col.getBoundingClientRect().right),
      handleLeft: Math.round(hr.left),
      handleWidth: Math.round(hr.width),
      mainLeft: main ? Math.round(main.getBoundingClientRect().left) : null,
      handleBg: getComputedStyle(h).backgroundColor,
    };
  });
  ok(
    !!geom && Math.abs(geom.handleLeft - (geom.colRight - 1)) <= 1,
    '手柄左缘压在列表栏右缘上（对齐，不再偏移）',
    geom ? `handle ${geom.handleLeft} vs colRight ${geom.colRight}` : 'n/a'
  );
  // A103：不再「紧接」—— 全局改成 6px 缝 + 8px 微圆角，缝里露的是画布白。
  // 断言从「mainLeft === colRight」改成「间距恰为缝宽」：既守住新设计，
  // 也守住原意图（手柄不占布局宽度 —— 宽度全在 gap 里，不偷任何一栏）。
  ok(
    !!geom && geom.mainLeft - geom.colRight === 6,
    '主内容与列表栏之间是 6px 缝（A103：手柄不占布局宽度，缝里露画布白）',
    geom ? `main ${geom.mainLeft} vs colRight ${geom.colRight}` : 'n/a'
  );
  ok(
    !!geom && /rgba\(0, 0, 0, 0\)|transparent/.test(geom.handleBg),
    '手柄自身不涂底色（不会在两栏之间画出第三条色带）',
    geom?.handleBg ?? 'n/a'
  );

  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + 160, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  }

  const after = await page.evaluate(() => {
    const col = document.querySelector('[data-sidebar-resizer]')?.previousElementSibling;
    return {
      width: col ? col.getBoundingClientRect().width : 0,
      saved: localStorage.getItem('opc.sidebar-width'),
      token: getComputedStyle(document.documentElement).getPropertyValue('--tc-sidebar-width').trim(),
    };
  });
  ok(after.width > before + 40, '拖动后列表栏真的变宽', `${Math.round(before)} → ${Math.round(after.width)}`);
  ok(Number(after.saved) > 0, '宽度写进了 localStorage（刷新后还在）', String(after.saved));
  ok(after.token === `${Math.round(after.width)}px`, '令牌与实际宽度一致', after.token);

  // 夹紧：往左拖过头也不能窄到放不下两行标题
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 160);
  await page.mouse.down();
  await page.mouse.move(box.x - 600, box.y + 160, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const clamped = await page.evaluate(() => {
    const col = document.querySelector('[data-sidebar-resizer]')?.previousElementSibling;
    return col ? col.getBoundingClientRect().width : 0;
  });
  ok(clamped >= 218 && clamped <= 222, '拖到最窄时夹在下限 220px', `${Math.round(clamped)}px`);

  // 复位（双击手柄），后面的断言仍按默认宽度算
  await handle.dblclick();
  await page.waitForTimeout(250);
  const restored = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--tc-sidebar-width').trim()
  );
  ok(restored === '288px', '双击手柄恢复默认宽度', restored);
}
await go('/chat/s1');
{
  // A103：会话头部从 content(白) 改回 chrome 灰（#f5f5f5）—— 与最左导航条
  // 同色系，比消息区差一档。原来断言「头部与消息区同色」是有意的「QQ 做法」，
  // 用户明确要求反转，所以这里反过来钉「差一档」。
  const header = await page.locator('main header').first().evaluate(el => getComputedStyle(el).backgroundColor);
  const column = await page.locator('main [data-tc-column="chat"]').first().evaluate(el => getComputedStyle(el).backgroundColor);
  ok(header === 'rgb(245, 245, 245)', '会话头部用 chrome 灰（A103：与最左栏同色系）', header);
  ok(column === 'rgb(255, 255, 255)', '消息区仍是内容面纯白（与头部差一档）', column);
  const listHeaderBg = await page.locator('header').first().evaluate(el => getComputedStyle(el).backgroundColor);
  ok(listHeaderBg === 'rgb(245, 245, 245)', '左栏标题栏仍是框架面 #f5f5f5', listHeaderBg);
}

// ============= [7] 自绘标题栏 =============
// 只验渲染进程这一半（DOM 尺寸/颜色/拖动区）。另一半 —— 系统画的三个按钮
// 有没有画在同一个底色上 —— 必须用 PrintWindow 抓整窗才看得到，
// 在 verify-native-theme.mjs 里。
console.log('\n[7] 自绘标题栏');
{
  const bar = await page.evaluate(() => {
    const el = document.querySelector('[data-titlebar]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      bg: cs.backgroundColor,
      region: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
      token: getComputedStyle(document.documentElement).getPropertyValue('--tc-titlebar-height').trim(),
      text: el.innerText.trim(),
      innerWidth: window.innerWidth,
    };
  });
  ok(!!bar, '页面里有自绘标题栏');
  ok(bar?.token === '40px', '标题条高度令牌 = 40px', bar?.token ?? 'n/a');
  ok(bar?.height === 40, '标题条实际高度 = 40px', bar ? `${bar.height}px` : 'n/a');
  ok(bar?.y === 0, '标题条在窗口第 0 行（系统标题栏已让位）', bar ? `y=${bar.y}` : 'n/a');
  // A94：标题条从 chrome 改走 rail（与导航条同色，框架成 L 形），
  // 于是这里期望的值从 #f5f5f5 变成 #ececec。
  ok(bar?.bg === 'rgb(236, 236, 236)', '标题条底色 = 导航条 rail #ececec', bar?.bg ?? 'n/a');
  ok(/drag/.test(bar?.region ?? ''), '整条是窗口拖动区', bar?.region ?? 'n/a');
  ok(
    bar != null && Math.abs(bar.width - bar.innerWidth) <= 1,
    '标题条横贯整窗',
    bar ? `${bar.width} / ${bar.innerWidth}` : 'n/a'
  );
  ok(bar?.text === 'OPC Agent', '标题条显示应用名', bar?.text ?? 'n/a');
}

// ============= [8b] 切换会话：历史消息不滚动、不闪（A24 用户要求）=============
console.log('\n[8b] 切换会话：历史一次跳到底，不做平滑滚动');
await go('/chat/s1');
await page.waitForSelector('.tc-msg-enter', { timeout: 10000 });
// 先把两个会话都打开一次，消息进缓存 —— 之后切过去的路径才是
// 「消息已在 state 里」那段。旧 bug 正在这里做了一次从头到尾的平滑滚动。
await go('/chat/g1');
await page.waitForSelector('.tc-msg-enter', { timeout: 10000 });
await go('/chat/s1');
await page.waitForSelector('.tc-msg-enter', { timeout: 10000 });
await page.waitForTimeout(400);

const moves = await page.evaluate(async () => {
  const c = document.querySelector('[data-chat-scroll]');
  if (!c) return null;
  const jumps = [];
  let last = c.scrollTop;
  let running = true;
  const tick = () => {
    if (!running) return;
    if (Math.abs(c.scrollTop - last) > 120) jumps.push([Math.round(last), Math.round(c.scrollTop)]);
    last = c.scrollTop;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const row = [...document.querySelectorAll('.tc-list-item')].find(r =>
    r.innerText.includes('Claude Code')
  );
  row?.click();
  await new Promise(r => setTimeout(r, 1000));
  running = false;
  return {
    jumps,
    // 「距底部」的正确算法是 scrollHeight − scrollTop − clientHeight。
    // ⚠️ 不能写成 scrollHeight − scrollTop：内容不溢出时 scrollTop 恒为 0，
    //    那个式子等于内容总高（几百 px），会被误判成「停在顶部」——
    //    第一版就踩了这个坑，短会话天生不过。
    distToBottom: c.scrollHeight - c.scrollTop - c.clientHeight,
  };
});
ok(
  !!moves && moves.jumps.length <= 1,
  '切会话时滚动位置只跳一次（不是平滑滚完整段历史）',
  moves ? `跳变 ${moves.jumps.length} 次：${JSON.stringify(moves.jumps.slice(0, 4))}` : 'n/a'
);
ok(
  !!moves && moves.distToBottom <= 24,
  '切过去就贴底（不是停在顶部等消息）',
  moves ? `距底部 ${Math.round(moves.distToBottom)}px` : 'n/a'
);

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
