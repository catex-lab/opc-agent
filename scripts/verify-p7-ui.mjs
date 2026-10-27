/**
 * P7 UI 验证：Agent 头像详情 + 群聊设置面板 + 液态玻璃。
 *
 * 复用 render-check.mjs 的手法：静态服务器托管 dist/ + Playwright 拦 /api/**，
 * 无需真实后端。fixtures 里给群聊塞了一条**图片消息**（只有 images、
 * 没有 contentBlocks —— 即「刷新后」的还原路径），用来验证玻璃浮层压在
 * 图片上时到底还能不能透出颜色。
 *
 * 断言分四组：
 *   [1] 群聊设置面板：点「⋯」从右侧滑出、宽度/位置、Esc 关闭
 *   [2] 昵称 / 群聊备注：点击就地编辑、回车保存、写进 localStorage
 *   [3] 置顶开关 / 免打扰开关 / 群消息设置三档（两者共用同一个 notifyMode，
 *       不能各说各话）
 *   [4] 删除聊天记录 / 退出群聊：都过确认框，且真的生效
 *   [5] 点头像 → Agent 详情弹窗（群聊头部成员位 + 消息流头像两条入口）
 *   [6] 液态玻璃：面板与弹窗都半透明 + backdrop-filter 真的生效，
 *       且 alpha 没有低到读不出字
 *   [7] 打开已有会话不闪屏：消息未到时只出骨架，绝不闪「新建对话」页
 *   [8] 设置页 → 消息 / 通讯录：会话页一次都不该被挂载（切页卡顿的根因）
 *
 * 运行：node scripts/verify-p7-ui.mjs（需先 npm run build）
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

/** 64x64 橙黄渐变 PNG（真实字节，浏览器真的会解码）—— 玻璃透底的「彩色背景」 */
const IMG_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA70lEQVR42tXCAUYAAAAEwSNJIkkiSRJZSSRJJEkiSSJJIkkSSRJJEkmS/ry948bEP6rHX6rHH6rHb6rHL6rHT6rHD6rHd6rHN6rHV6rHF6rHZ6rHJ6rHR6rHB6rHe6rHO6rHW6rHG6rHa6rHK6rHS6rHC6rHc6rHM6rHU6rHE6rHY6rHI6rHQ6rHA6rHfarHParHXarHHarHbarHLarHTarHDarHdarHNarHVarHFarHZarHJarHRapHqB4XqB7nqR7nqB5nqR5nqB6nqR6nqB4nqR4nqB7HqR7HqB5HqR5HqB6HqR6HqB4HqR4nqP4P9nTqSw76RQsAAAAASUVORK5CYII=',
  'base64'
);

const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code', 'tools'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构与代码审查', capabilities: ['chat', 'code', 'write'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default'] } },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡，日常首选' }];

const NOW = new Date().toISOString();
const SESSIONS = [
  {
    id: 'g1', title: '', agent_id: null, model: null, kind: 'group',
    agent_ids: JSON.stringify(['workbuddy', 'claude']), orchestration: 'dispatch',
    created_at: NOW,
  },
];
/** a1 是普通文字消息（带头像 → 点开详情）；a2 带图片（玻璃浮层后面的「彩色背景」） */
const MESSAGES = [
  { id: 'u1', session_id: 'g1', role: 'user', content: '拉个群', created_at: NOW, tool_calls: null, images: null },
  {
    id: 'a1', session_id: 'g1', role: 'assistant', content: '好，我把图也画了。',
    model: 'claude-sonnet-4-5', author_agent_id: 'claude', created_at: NOW, tool_calls: null, images: null,
  },
  {
    id: 'a2', session_id: 'g1', role: 'assistant', content: '',
    model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy', created_at: NOW, tool_calls: null,
    images: [{
      url: '/api/images/glass-bg.png',
      prompt: '一只戴墨镜的橘猫', size: '64x64', model: 'cogview-3-flash',
      provider: 'cogview', alt: '一只戴墨镜的橘猫',
    }],
  },
];

const failures = [];
const checks = { total: 0 };
/** 让 /api/sessions/:id 晚点回（>0 时生效），用来观测「消息还在路上」那一帧 */
let messageDelay = 0;
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/images/glass-bg.png')) {
    return route.fulfill({ status: 200, contentType: 'image/png', body: IMG_PNG });
  }
  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (url.includes('/api/permission-response')) return json({ ok: true });
  if (/\/api\/sessions\/g1\/messages/.test(url)) return json({ success: true, deleted: 3 });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    // 让「消息还没回来」这个瞬间可以被稳定观测（见 [7] 屏闪断言）
    if (messageDelay > 0) await new Promise(r => setTimeout(r, messageDelay));
    return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES.filter(m => m.session_id === id) });
  }
  if (/\/api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

/** 玻璃断言：半透明 + 真的模糊。alpha 太低会让文字读不出（见 index.css 注释） */
async function glassOf(selector, label) {
  const style = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      backdrop:
        cs.backdropFilter || cs.webkitBackdropFilter || '',
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
    };
  }, selector);
  if (!style) { ok(false, `${label}：元素存在`); return; }
  const blurOk = /blur\((\d+(?:\.\d+)?)px\)/.test(style.backdrop)
    && /saturate/.test(style.backdrop);
  const alpha = (() => {
    const m = style.bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(',').map(s => parseFloat(s));
    return parts.length > 3 ? parts[3] : 1;
  })();
  ok(blurOk, `${label}：backdrop-filter 生效（blur + saturate）`, style.backdrop);
  ok(alpha > 0.7 && alpha < 0.99, `${label}：半透明但没到读不出字`, `alpha=${alpha}`);
  ok(style.shadow !== 'none' && style.shadow.length > 0, `${label}：有投影/光晕兜住半透明底`, style.shadow.slice(0, 60));
}

async function go(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
}

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

// ============= [1] 群聊设置面板：点「⋯」从右往左滑出 ==============
console.log('\n[1] 群聊设置面板：滑出 / 内容 / 关闭');
await go('/chat/g1');
ok((await page.locator('[data-group-settings]').count()) === 0, '初始没有面板');

// 成员栏必须在**打开面板之前**量：面板打开时成员栏让位（同一块右栏位置
// 只放一个），关掉才回来。所以「同宽同起止」的基准得先取。
//
// ⚠️ A72 起成员栏**默认折叠**，此时渲染的是另一根 aside
// （`aria-label="群聊成员（已折叠）"`，宽 10px 的悬停热区）。
// 不先展开就量，量到的是那条热区，「面板与它同宽」会变成 10px 的基准，
// 四条几何断言全部失去意义。所以：先断言默认折叠，再展开，最后才量。
ok((await page.locator('[data-member-panel-collapsed]').count()) === 1, '成员栏默认折叠（A72）');
const expandBtn = page.locator('[aria-label="展开群成员"]');
ok((await expandBtn.count()) === 1, '折叠态有展开按钮');
if (await expandBtn.count()) {
  await expandBtn.click();
  await page.waitForTimeout(450); // 等展开动画结束
}
const member = await page.locator('aside[aria-label="群聊成员"]').boundingBox();
ok(!!member, '群成员侧栏在场（作为对齐基准）', member ? `w=${Math.round(member.width)}` : '无 box');

await page.locator('[data-chat-more]').click();
await page.waitForTimeout(450); // 等宽度动画结束
const panelWrap = page.locator('[data-group-settings]');
const panel = page.locator('[data-group-settings] aside');
ok((await panelWrap.count()) === 1, '点「⋯」后面板出现');
ok((await panelWrap.getAttribute('data-open')) === 'true', '面板标记为打开');
await shot('verify-p7-panel');

{
  // 位置与尺寸：贴右、**与群成员栏同宽**、上下同起同止（2026-10-20 用户反馈）
  const box = await panel.boundingBox();
  ok(
    !!box && !!member && Math.abs(box.width - member.width) < 2,
    '面板宽度 = 群成员栏宽度',
    box && member ? `panel.w=${Math.round(box.width)} member.w=${Math.round(member.width)}` : '无 box'
  );
  // A103 起三栏各内缩 6px（圆角落到画布上，见 verify:surface [3]），
  // 「贴右侧通栏」的基准从**视口**变成了**聊天列的右缘** —— 这条断言
  // 当时没跟着改，于是一直拿 1274 比 1280 假失败。群成员栏与设置面板
  // 都在聊天列内，两者右缘相同才是真的「通栏」。
  const chatRight = await page.evaluate(() => {
    const el = document.querySelector('[data-tc-column="chat"]');
    return el ? Math.round(el.getBoundingClientRect().right) : null;
  });
  ok(!!box && !!chatRight && Math.abs(chatRight - (box.x + box.width)) < 2, '面板贴聊天列右缘（通栏的基准是栏目，A103 起不再是视口）', box ? `right=${box.x + box.width} chatRight=${chatRight}` : '无 box');

  ok(
    !!box && !!member && Math.abs(box.y - member.y) < 2,
    '面板顶边 = 群成员栏顶边（都在会话头部之下）',
    box && member ? `panel.y=${Math.round(box.y)} member.y=${Math.round(member.y)}` : 'n/a'
  );
  ok(
    !!box && !!member && Math.abs(box.height - member.height) < 2,
    '面板高度 = 群成员栏高度',
    box && member ? `panel.h=${Math.round(box.height)} member.h=${Math.round(member.height)}` : 'n/a'
  );
  ok(
    !!box && !!member && Math.abs(box.y + box.height - (member.y + member.height)) < 2,
    '面板底边 = 群成员栏底边（同起同止）',
    box && member ? `panel.bottom=${Math.round(box.y + box.height)} member.bottom=${Math.round(member.y + member.height)}` : 'n/a'
  );
  // 不再是「整屏模态」：容器只有面板那么宽，左侧区域不被覆盖
  const vp = page.viewportSize();
  ok(!!box && box.width < (vp?.width ?? 0) - 100, '面板不再铺满整屏（左侧消息区不被遮挡）', box ? `w=${Math.round(box.width)} / vp=${vp?.width}` : 'n/a');

  // 面板参与布局：输入区必须整体落在面板左边缘之外，一点都不能被压住
  const input = await page.locator('textarea, [data-chat-input]').first().boundingBox().catch(() => null);
  ok(
    !!input && !!box && input.x + input.width <= box.x + 1,
    '输入区完全在面板左侧（不再被面板盖住）',
    input && box ? `input.right=${Math.round(input.x + input.width)} panel.x=${Math.round(box.x)}` : 'n/a'
  );
}

// 面板内容按截图的顺序一件不少
for (const label of ['群聊成员', '我在本群的昵称', '群聊备注', '设为置顶', '消息免打扰', '群消息设置', '删除聊天记录', '退出群聊']) {
  ok((await panel.getByText(label, { exact: true }).count()) >= 1, `面板含「${label}」`);
}
ok((await panel.locator('[data-group-nickname]').count()) === 1, '昵称是可点击的编辑项');
ok((await panel.locator('[data-group-remark]').count()) === 1, '群聊备注是可点击的编辑项');

// 群成员头像也要有悬停名片（A24 用户要求：这里也要详情弹窗）
// 与成员栏、通讯录共用同一个 AgentHoverCard —— 三处指向同一份注册表，
// 没理由让某一处「悬停没反应」。
{
  const firstMember = panel.locator('[data-group-members] img, .grid img').first();
  ok((await firstMember.count()) === 1, '成员格子有头像');
  if (await firstMember.count()) {
    const b = await firstMember.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(450);
    const card = page.locator('[role="tooltip"]');
    ok((await card.count()) === 1, '悬停群成员头像弹出资料卡');
    // 面板里没传 onViewDetail（打开成员资料不是群设置面板的职责），
    // 所以这里断言的是**卡片内容**：厂商 / 接入方式这类只在这里看得到的信息。
    ok(
      (await card.getByText(/CLI|SDK|ACP|模拟通道/).count()) >= 1,
      '名片里带厂商与接入方式（详情弹窗，不只是个名字）'
    );
    // 收尾不能按 Escape：群设置面板自己也监听 Esc，会把面板一起关掉。
    // 移开鼠标等 160ms 宽限期过去，卡片自己会消失。
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
  }
}

// 两个不可恢复的操作：**上下排列**，跟在「群消息设置」之后（2026-10-20 用户反馈）
{
  const exitBox = await panel.locator('[data-exit-group]').boundingBox();
  const clearBox = await panel.locator('[data-clear-messages]').boundingBox();
  ok(
    !!exitBox && !!clearBox && Math.abs(exitBox.x - clearBox.x) < 4,
    '「退出群聊」与「删除聊天记录」左边缘对齐（同一列）',
    exitBox && clearBox ? `exit.x=${Math.round(exitBox.x)} clear.x=${Math.round(clearBox.x)}` : 'n/a'
  );
  ok(
    !!exitBox && !!clearBox && exitBox.y >= clearBox.y + clearBox.height - 4,
    '「退出群聊」在「删除聊天记录」下方（上下排列，不并排）',
    exitBox && clearBox ? `exit.y=${Math.round(exitBox.y)} clear.bottom=${Math.round(clearBox.y + clearBox.height)}` : 'n/a'
  );
  // 结构断言：aside 只剩「栏头 + 滚动内容」两个孩子。早先退出按钮是第三个
  // 孩子（shrink-0 的贴底容器），会一直占着面板底部 —— 那正是要修掉的形态。
  const shape = await panel.evaluate(el => ({
    children: el.children.length,
    lastHasExit: !!el.lastElementChild?.querySelector('[data-exit-group]'),
  }));
  ok(shape.children === 2, '面板不再有贴底的操作容器（只剩栏头 + 滚动区）', `children=${shape.children}`);
  ok(shape.lastHasExit, '「退出群聊」在滚动内容里，跟着内容走');

  // A24 用户反馈：两个按钮都不要红色描边。断言「描边同值」而不是
  // 「描边等于某个具体色」—— 具体色随主题变，但两者必须一致；
  // 同时确认它不再是 error 色（红描边会把退出抬成页面上最显眼的按钮）。
  const borders = await panel.evaluate(el => {
    const pick = sel => {
      const b = el.querySelector(sel);
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { border: cs.borderTopColor, color: cs.color };
    };
    return { exit: pick('[data-exit-group]'), clear: pick('[data-clear-messages]') };
  });
  ok(
    !!borders.exit && !!borders.clear && borders.exit.border === borders.clear.border,
    '两个按钮描边同值（都是中性描边）',
    `${borders.exit?.border} / ${borders.clear?.border}`
  );
  ok(
    !!borders.exit && borders.exit.border !== borders.exit.color,
    '「退出群聊」的描边不是它自己的红字色（没有红描边）',
    `border=${borders.exit?.border} text=${borders.exit?.color}`
  );
}

// 再点一次「⋯」即收起 —— 用户明确要求「不必去点空白处」
await page.locator('[data-chat-more]').click();
await page.waitForTimeout(150);
ok((await panelWrap.getAttribute('data-open')) === 'false', '再点一次「⋯」就收起');
ok((await page.locator('[data-chat-more]').getAttribute('aria-expanded')) === 'false', '按钮 aria-expanded 同步为 false');
await page.waitForTimeout(350);
ok((await page.locator('[data-group-settings]').count()) === 0, '收起后从 DOM 卸载');

// 重新打开，继续验证 Esc 关闭
await page.locator('[data-chat-more]').click();
await page.waitForTimeout(450);
ok((await panelWrap.getAttribute('data-open')) === 'true', '再次点开又回来了');

// Esc 关闭（带动画退场）
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok((await panelWrap.getAttribute('data-open')) === 'false', 'Esc 后面板标记为关闭');
await page.waitForTimeout(350);
ok((await page.locator('[data-group-settings]').count()) === 0, '退场动画后面板卸载');

// ============= [2] 昵称 / 群聊备注：就地编辑并持久化 ==============
console.log('\n[2] 昵称 / 群聊备注：点击编辑 → 回车保存');
await page.locator('[data-chat-more]').click();
await page.waitForTimeout(450);

await panel.locator('[data-group-nickname]').click();
const nickInput = panel.locator('input[aria-label="我在本群的昵称"]');
ok((await nickInput.count()) === 1, '点昵称变成输入框');
await nickInput.fill('群里的测试昵称');
await nickInput.press('Enter');
await page.waitForTimeout(200);
ok((await panel.locator('[data-group-nickname]').innerText()).includes('群里的测试昵称'), '回车后昵称保存并回显');
{
  const flags = await page.evaluate(() => JSON.parse(localStorage.getItem('opc:sessionFlags') || '{}'));
  ok(flags.g1?.nickname === '群里的测试昵称', '昵称写进 localStorage（持久化）', JSON.stringify(flags.g1 || null));
}

await panel.locator('[data-group-remark]').click();
const remarkInput = panel.locator('input[aria-label="群聊备注"]');
await remarkInput.fill('玻璃质感回归群');
await remarkInput.press('Enter');
await page.waitForTimeout(200);
ok((await panel.locator('[data-group-remark]').innerText()).includes('玻璃质感回归群'), '回车后备注保存并回显');
await shot('verify-p7-nick-remark');

// ============= [3] 置顶 / 免打扰 / 群消息设置 ==============
console.log('\n[3] 置顶 / 免打扰 / 群消息设置（四档）');
const pinSwitch = panel.getByRole('switch', { name: '设为置顶' });
ok((await pinSwitch.getAttribute('aria-checked')) === 'false', '置顶默认关');
await pinSwitch.click();
await page.waitForTimeout(150);
ok((await pinSwitch.getAttribute('aria-checked')) === 'true', '点一下置顶打开');

const muteSwitch = panel.getByRole('switch', { name: '消息免打扰' });
ok((await muteSwitch.getAttribute('aria-checked')) === 'false', '免打扰默认关');
await muteSwitch.click();
await page.waitForTimeout(150);
ok((await muteSwitch.getAttribute('aria-checked')) === 'true', '再点一下免打扰打开（写 muted）');
{
  const flags = await page.evaluate(() => JSON.parse(localStorage.getItem('opc:sessionFlags') || '{}'));
  ok(flags.g1?.notifyMode === 'muted' && flags.g1?.muted === true, '免打扰与群消息设置同源（notifyMode）', JSON.stringify(flags.g1 || null));
}

// 群消息设置：四档下拉，与上面的开关共用同一状态
const notifyTrigger = panel.locator('[data-notify-trigger]');
await notifyTrigger.click();
await page.waitForTimeout(150);
const options = panel.locator('[role="option"]');
ok((await options.count()) === 4, '群消息设置有四档（含「接收消息并提醒」）', `count=${await options.count()}`);
{
  const labels = (await options.allInnerTexts()).map(t => t.replace(/\n/g, ' ').trim());
  ok(labels[0].includes('接收消息并提醒'), '第一档是「接收消息并提醒」（normal，不能被漏掉）', labels.join(' | '));
  ok(labels.includes('屏蔽群消息'), '最后一档是「屏蔽群消息」');
}
{
  // 当前档位（muted）应该打勾
  const checked = await panel.locator('[role="option"][aria-selected="true"]').count();
  ok(checked === 1, '当前档位有选中标记', `count=${checked}`);
  const activeText = await panel.locator('[role="option"][aria-selected="true"]').innerText();
  ok(/但不提醒/.test(activeText), '选中档位与免打扰开关一致', activeText.replace(/\n/g, ' '));
}
await options.nth(2).click();
await page.waitForTimeout(200);
ok((await notifyTrigger.innerText()).includes('群助手'), '切到「收进群助手且不提醒」');
ok((await muteSwitch.getAttribute('aria-checked')) === 'true', '群助手档同样算免打扰（投影一致）');

// 切回「接收消息并提醒」→ 免打扰开关应当同步关上
await notifyTrigger.click();
await page.waitForTimeout(150);
await panel.locator('[role="option"]').nth(0).click();
await page.waitForTimeout(300);
{
  const checked = await muteSwitch.getAttribute('aria-checked');
  const label = await notifyTrigger.innerText();
  const flags = await page.evaluate(() => JSON.parse(localStorage.getItem('opc:sessionFlags') || '{}'));
  ok(checked === 'false', '切回「接收消息并提醒」后免打扰同步关闭', `aria-checked=${checked} | 标签=${label.replace(/\n/g, '')} | flags=${JSON.stringify(flags.g1 || null)}`);
  ok(flags.g1?.notifyMode === undefined, 'normal 是缺省值，不占位存储（localStorage 里不留 notifyMode）', JSON.stringify(flags.g1 || null));
}

// ============= [4] 删除聊天记录 / 退出群聊 ==============
console.log('\n[4] 删除聊天记录 / 退出群聊（都过确认框）');
await panel.locator('[data-clear-messages]').click();
await page.waitForTimeout(250);
{
  const dialog = page.locator('[data-confirm-dialog]');
  ok((await dialog.count()) === 1, '删除聊天记录弹确认框', `count=${await dialog.count()}`);
  ok((await dialog.getByText('不可恢复', { exact: false }).count()) >= 1, '确认框说明后果');
  await shot('verify-p7-clear-confirm');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForTimeout(500);
  ok((await page.getByText('拉个群').count()) === 0, '确认后消息真的清空');
  ok((await page.locator('[data-group-settings]').getAttribute('data-open')) === 'true', '面板仍然开着（不必反复打开）');
}

// 重进一次会话，再走退出群聊（清空后消息接口仍返回夹具，重新填充也无妨）
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('[data-chat-more]').click();
await page.waitForTimeout(450);
await page.locator('[data-group-settings] [data-exit-group]').click();
await page.waitForTimeout(250);
{
  const dialog = page.locator('[data-confirm-dialog]');
  ok((await dialog.count()) === 1, '退出群聊弹确认框', `count=${await dialog.count()}`);
  await shot('verify-p7-exit-confirm');
  await dialog.getByRole('button', { name: '退出', exact: true }).click();
  await page.waitForTimeout(600);
  ok(!page.url().endsWith('/chat/g1'), '确认后退出了群聊会话页', page.url());
}

// ============= [5] 点头像 → Agent 详情弹窗 ==============
console.log('\n[5] 点 Agent 头像 → 详情弹窗');
await go('/chat/g1');

// 入口一：群聊头部成员位
await page.locator('[data-member-avatar="claude"]').click();
await page.waitForTimeout(350);
{
  const dialog = page.locator('[data-agent-detail-overlay] [role="dialog"]');
  ok((await dialog.count()) === 1, '点头像弹出详情');
  ok((await dialog.getByText('Claude Code', { exact: true }).count()) === 1, '弹窗标题是点中的 Agent');
  ok((await dialog.getByText('擅长领域', { exact: false }).count()) === 1, '弹窗含擅长领域');
  await shot('verify-p7-detail');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok((await page.getByRole('dialog').count()) === 0, 'Esc 关闭详情');
}

// 入口二：消息流里那条 assistant 消息的头像
await page.locator('[data-agent-avatar="claude"]').first().click();
await page.waitForTimeout(350);
ok((await page.locator('[data-agent-detail-overlay] [role="dialog"]').count()) === 1, '消息流头像同样弹出详情');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// ============= [6] 液态玻璃 ==============
console.log('\n[6] 液态玻璃：半透明 + 真的模糊');
await page.locator('[data-chat-more]').click();
await page.waitForTimeout(450);
await glassOf('[data-group-settings] aside', '群聊设置面板');
await shot('verify-p7-glass-panel');

// 群消息设置的下拉也是玻璃
await page.locator('[data-group-settings] [data-notify-trigger]').click();
await page.waitForTimeout(200);
await glassOf('[data-group-settings] [role="listbox"]', '群消息设置下拉');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Agent 详情弹窗压在**图片消息**上：这正是用户要求的场景
await page.locator('[data-agent-avatar="claude"]').first().click();
await page.waitForTimeout(400);
{
  const imgOk = await page.evaluate(() => {
    const img = document.querySelector('img[src*="glass-bg.png"]');
    return !!img && img.naturalWidth > 0;
  });
  ok(imgOk, '消息流里那张图片消息真的加载出来了（玻璃后面的彩色背景）');
  await shot('verify-p7-glass-detail-on-image');
  await glassOf('[data-agent-detail-overlay] [role="dialog"]', '图片消息上的详情弹窗');
  // A133：遮罩全站收敛成一档（--tc-mask-soft = 0.34），这里守的是「够淡、透得出背后的图」。
  // 原注释写的是「蒙层要比 ConfirmDialog 淡」——那个相对关系已经不存在了
  // （ConfirmDialog 也改成了同一档），所以别把它当成两者之间的比较。
  const mask = await page.evaluate(() => {
    const el = document.querySelector('[data-agent-detail-overlay]');
    return el ? getComputedStyle(el).backgroundColor : '';
  });
  const maskAlpha = (() => {
    const m = String(mask).match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const p = m[1].split(',').map(s => parseFloat(s));
    return p.length > 3 ? p[3] : 1;
  })();
  ok(maskAlpha > 0 && maskAlpha < 0.45, '详情弹窗蒙层偏淡（看得见背后的图）', `alpha=${maskAlpha}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

// 暗色主题：玻璃同样要成立（用户要求「不论暗色还是亮色」）
console.log('\n[6b] 暗色主题下的玻璃');
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(600);
await page.locator('[data-chat-more]').click();
await page.waitForTimeout(450);
await glassOf('[data-group-settings] aside', '暗色 · 群聊设置面板');
await shot('verify-p7-glass-dark');
{
  // 暗色下浮层要比内容面亮（「亮 = 靠前」），否则玻璃看起来像挖了个洞
  const pair = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      glass: cs.getPropertyValue('--tc-glass-bg').trim(),
      content: cs.getPropertyValue('--tc-surface-content').trim(),
    };
  });
  // 颜色值可能是 rgba(...) 也可能是 #121212 —— 两种都要能读成 RGB 分量
  const rgb = s => {
    const t = String(s).trim();
    const hex = t.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return (t.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  };
  const g = rgb(pair.glass);
  const c = rgb(pair.content);
  ok(g.length === 3 && c.length === 3 && g[0] > c[0], '暗色下玻璃底色比内容面亮一档（浮得起来）', `${pair.glass} vs ${pair.content}`);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.waitForTimeout(400);

// ============= [7] 打开会话不闪屏 ==============
console.log('\n[7] 打开已有会话：先骨架，不闪「新建对话」页');
/**
 * 用户报的现象：打开任意群聊 / Agent 聊天记录，界面会「闪一下」。
 * 根因是 `messages.length === 0` 被当成「这是新对话」—— 打开会话的首帧
 * 消息还没回来，于是整页渲染新建对话页（几十张场景卡），消息到了再换成
 * 聊天记录。
 *
 * 这里把消息接口**故意拖慢 700ms**，然后用 MutationObserver 全程盯着
 * 页面上有没有出现过「选择一个 Agent 开始对话」这行字。出现一次就算失败。
 */
await page.addInitScript(() => {
  window.__newChatFlash = 0;
  const probe = () => {
    if (document.body && document.body.innerText.includes('选择一个 Agent 开始对话')) {
      window.__newChatFlash += 1;
    }
  };
  // 观察 document 而不是 documentElement：init script 在文档解析前就执行，
  // 那一刻 <html> 可能还不存在（observe 会直接抛 TypeError）
  new MutationObserver(probe).observe(document, { childList: true, subtree: true });
});

// 1600ms：骨架的可见窗口要经得住「截图一次 + 计数一次」的操作耗时。
// 700ms 时窗口只剩两百来毫秒，断言会被自己的截图拖成偶发失败（2026-10-19 实测）。
messageDelay = 1600;
await page.goto(base + '/chat/g1', { waitUntil: 'load' });
{
  const sawSkeleton = await page
    .locator('[data-messages-loading]')
    .first()
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  ok(sawSkeleton, '消息未到时先显示骨架（而不是换一整屏）');
  // 计数必须紧跟在 waitFor 之后、截图之前：截图要几百毫秒，
  // 挪到后面就会落在「消息已到达」之后，把一条稳定的断言变成偶发失败。
  ok(
    (await page.locator('[data-messages-loading]').count()) === 1,
    '骨架只在加载期存在一份',
  );
  await shot('verify-p7-skeleton');
}
await page.waitForTimeout(1200);
ok((await page.locator('[data-messages-loading]').count()) === 0, '消息到达后骨架撤掉');
ok((await page.getByText('拉个群', { exact: false }).count()) >= 1, '消息真的渲染出来了');
{
  const flash = await page.evaluate(() => window.__newChatFlash ?? -1);
  ok(flash === 0, '全程没有闪出「新建对话」页', `出现次数=${flash}`);
}
messageDelay = 0;

// ============= [8] 设置页 → 消息 / 通讯录：不再重挂会话页 ==============
console.log('\n[8] 设置页切回消息 / 通讯录：会话页不该被挂载');
await page.goto(base + '/chat/g1', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
ok((await page.locator('[data-chat-page]').count()) === 1, '前提：会话页已挂载');

/** 装一个「数会话页挂载次数」的观察器，用来抓「挂上又立刻卸掉」的抖动 */
async function watchChatMounts() {
  await page.evaluate(() => {
    window.__chatMounts = 0;
    if (window.__chatMountObserver) window.__chatMountObserver.disconnect();
    window.__chatMountObserver = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches?.('[data-chat-page]') || n.querySelector?.('[data-chat-page]')) {
            window.__chatMounts += 1;
          }
        }
      }
    });
    window.__chatMountObserver.observe(document.body, { childList: true, subtree: true });
  });
}

// 先切到设置页
await page.locator('button[title="设置"]').click();
await page.waitForTimeout(500);
ok(page.url().endsWith('/settings'), '进入了设置页', page.url());

await watchChatMounts();
// A37 起设置是**弹窗**：遮罩铺满内容区，左侧导航栏的点击会被它拦下
// （这正是弹窗该有的行为 —— 出口是 × / 遮罩 / Esc 三个）。
// 所以这里不能再「点导航栏切走」。而且弹窗关掉是**回到打开时的那一页**
// （这里是某个会话），不是跳首页 —— 这条断言因此也跟着改口径：
// 不再问「有没有回到消息列表」，而是问「会话页有没有被重建」。
// 弹窗是浮层，底层 ChatPage 全程没卸载，所以关掉时也不该有新的挂载。
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
{
  const mounts = await page.evaluate(() => window.__chatMounts);
  ok(mounts === 0, '开关设置弹窗期间会话页一次都没被重新挂载（弹窗是浮层，底层不重建）', `挂载次数=${mounts}`);
  ok((await page.locator('[data-chat-page]').count()) === 1, '关掉设置后仍停在原会话（改完外观接着看）');
}

await page.locator('button[title="设置"]').click();
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await watchChatMounts();
await page.locator('button[title="通讯录"]').click();
await page.waitForTimeout(700);
{
  // 从「正在看的会话」切到通讯录：切完右侧不该还挂着会话页。
  // 这里不断言「一次都没被挂载」——A37 之后进入通讯录时 React 会先卸载
  // 再挂一个新节点（布局从双栏变单栏），挂载次数不再是稳定指标；
  // 用户能感知的是「切完还有没有会话页」，所以断言这个。
  ok(
    (await page.locator('[data-chat-page]').count()) === 0,
    '切到通讯录后右侧不再挂着会话页',
  );
  ok(
    (await page.getByPlaceholder('搜索 AGENT、群聊').count()) === 1,
    '通讯录真的渲染出来了',
  );
}

// ============= [9] 控制台 ==============
console.log('\n[9] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ').slice(0, 200));

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败（共 ${checks.total} 项）：`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✓ ${checks.total}/${checks.total} 全部通过`);
