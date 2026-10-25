/**
 * A118 验证：浮层「点输入框关不掉」。
 *
 * 用户原话：「切换新工作区后，我点击输入框，工作区弹窗没有关闭」。
 *
 * ## 根因（探针实测，不是猜）
 *
 * 输入框 `<t-chat-sender>` 是 TDesign 的 shadow DOM 组件，它在内部把
 * `mousedown` / `click` 吃掉了。实测点它的 textarea 时，document 上只收到：
 *
 *     pointerdown / focusin / pointerup
 *
 * **没有 click，连 mousedown 都没有** —— 浏览器因为 mousedown 被
 * preventDefault 而不生成 click。所以凡是拿 `click` 或 `mousedown` 做
 * 「点外部关闭」的浮层，在输入框这个最常点的地方全部失效，而点消息区、
 * 点列表栏都是好的。这种「大部分地方正常」正是它活了这么久的原因。
 *
 * ## 这个脚本守什么
 *
 *   [0] 前提自证 —— 先证明「输入框确实会吞 click / mousedown，但
 *       pointerdown 能穿出来」。这条不成立的话，下面所有断言都失去意义
 *       （比如将来 TDesign 改了实现，我们就该重新评估而不是盲改）。
 *   [1] 工作区徽标面板：点输入框必须关
 *   [2] 工作区徽标面板：点消息区 / 点列表栏必须关（别修坏）
 *   [3] 工作区徽标面板：点面板内部不许关（别修过头）
 *   [4] 会话头部「⋯」菜单：点输入框必须关
 *   [5] 输入框右键菜单：点输入框另一处必须关
 *
 * 运行：node scripts/verify-a118-overlay-dismiss.mjs（需先 npm run build）
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
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`); }
};

const AGENTS = [{
  id: 'a1', name: 'Cursor', vendor: 'v', kind: 'sdk', icon: 'workbuddy',
  color: '#0EC8A9', description: 'x', capabilities: ['chat'],
  status: { availability: 'ready', version: '1' },
}];
const now = Date.now();
const SESSIONS = [{
  id: 's1', title: '会话', agent_id: 'a1', model: 'm',
  cwd: 'C:\\Users\\me\\Desktop\\测试', created_at: new Date(now - 60000).toISOString(),
}];
const MSGS = [{
  id: 's1-m1', role: 'assistant', session_id: 's1', author_agent_id: 'a1',
  created_at: new Date(now - 50000).toISOString(), content: '你好', model: 'm',
}];

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  let file = join(DIST, url === '/' ? 'index.html' : url);
  let body;
  try { body = await readFile(file); } catch { file = join(DIST, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newPage({ dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(d => {
    try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch { /* 存储被禁 */ }
  }, dark);
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/\/api\/agents(\/probe)?(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: [{ modelId: 'm', name: 'Sonnet 4.5' }] });
    if (/\/api\/recent-directories/.test(url)) {
      return json({ directories: ['C:\\Users\\me\\Desktop\\新工作区', 'C:\\Users\\me\\Desktop\\测试'] });
    }
    if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });
    if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ session: SESSIONS[0], messages: MSGS });
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}

/** 打开会话，停在「有一个会话在聊」的状态 */
async function openChat(page) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('.tc-list-item').first().click();
  await page.waitForTimeout(900);
}

const wsOpen = page => page.evaluate(() => document.querySelector('[data-workspace-badge]')?.open ?? null);
const moreOpen = page => page.evaluate(() => document.querySelector('[data-chat-more]')?.open ?? null);
const hasMenu = page => page.evaluate(() => !!document.querySelector('[role="menu"]'));

/** 用真实鼠标坐标点输入框（不是 locator.click —— 见 [0] 组的说明） */
async function clickInput(page) {
  const box = await page.locator('t-chat-sender textarea').first().boundingBox();
  if (!box) throw new Error('找不到输入框');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(350);
}

// ============= [0] 前提自证 =============
console.log('\n[0] 前提：输入框会吞 mousedown / click，但 pointerdown 能穿出来');
{
  const { ctx, page, errors } = await newPage();
  await openChat(page);

  const seen = await page.evaluate(() => {
    window.__seen = [];
    for (const type of ['pointerdown', 'mousedown', 'click', 'focusin', 'pointerup']) {
      document.addEventListener(type, e => {
        // 只记「来自输入框」的那一条（target 被 retarget 成 host）
        if (e.target?.tagName === 'T-CHAT-SENDER') window.__seen.push(type);
      }, true);
    }
    return true;
  });
  ok(seen, '监听器已挂上');

  await clickInput(page);
  const got = await page.evaluate(() => window.__seen);
  ok(got.includes('pointerdown'), '输入框的 pointerdown 能到达 document', got.join('/') || '无');
  ok(!got.includes('click'), '输入框的 click **到不了** document（这就是 bug 的根因）', got.join('/') || '无');
  ok(!got.includes('mousedown'), '输入框的 mousedown 也到不了 document', got.join('/') || '无');

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [1][2][3] 工作区徽标面板 =============
console.log('\n[1] 工作区面板：点输入框要关掉');
console.log('[2] 工作区面板：点消息区 / 列表栏也要关（别修坏）');
console.log('[3] 工作区面板：点面板内部不许关（别修过头）');
{
  const { ctx, page, errors } = await newPage({ dark: true });
  await openChat(page);

  // 1) 点输入框
  await page.locator('[data-workspace-badge] summary').click();
  await page.waitForTimeout(400);
  ok(await wsOpen(page) === true, '先点开工作区面板', 'open=true');
  await clickInput(page);
  ok(await wsOpen(page) === false, '**点输入框后面板关闭**（用户报的那条）', `open=${await wsOpen(page)}`);

  // 1b) 用户描述的场景：先切换目录，再点输入框
  await page.locator('[data-workspace-badge] summary').click();
  await page.waitForTimeout(400);
  const recent = page.locator('[data-workspace-recent]').first();
  if (await recent.count()) {
    await recent.click();
    await page.waitForTimeout(600);
    ok(await wsOpen(page) === true, '切换目录后面板仍然开着（切换是面板内操作）', `open=${await wsOpen(page)}`);
    await clickInput(page);
    ok(await wsOpen(page) === false, '**切换目录后点输入框也能关**（用户原话场景）', `open=${await wsOpen(page)}`);
  } else {
    ok(false, '「最近目录」存在（否则无法复现用户场景）', '未找到');
  }

  // 2) 点消息区
  await page.locator('[data-workspace-badge] summary').click();
  await page.waitForTimeout(300);
  await page.locator('[data-chat-scroll]').click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(350);
  ok(await wsOpen(page) === false, '点消息区关闭（原行为没坏）', `open=${await wsOpen(page)}`);

  // 3) 点面板内部：不许关
  await page.locator('[data-workspace-badge] summary').click();
  await page.waitForTimeout(300);
  const pathBox = await page.locator('[data-workspace-current-path]').boundingBox();
  await page.mouse.click(pathBox.x + 10, pathBox.y + 8);
  await page.waitForTimeout(350);
  ok(await wsOpen(page) === true, '点面板内部不关（否则菜单点不到）', `open=${await wsOpen(page)}`);

  await page.screenshot({ path: join(OUT, 'a118-workspace-dark.png') });
  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [4] 会话头部 ⋯ 菜单 =============
console.log('\n[4] 会话头部「⋯」菜单：点输入框要关');
{
  const { ctx, page, errors } = await newPage();
  await openChat(page);

  await page.locator('[data-chat-more] summary').click();
  await page.waitForTimeout(400);
  ok(await moreOpen(page) === true, '先点开「⋯」菜单', 'open=true');

  await clickInput(page);
  ok(await moreOpen(page) === false, '**点输入框后「⋯」菜单关闭**', `open=${await moreOpen(page)}`);

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [5] 输入框右键菜单 =============
console.log('\n[5] 输入框右键菜单：点别处要关');
{
  const { ctx, page, errors } = await newPage();
  await openChat(page);

  const box = await page.locator('t-chat-sender textarea').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForTimeout(450);
  ok(await hasMenu(page) === true, '右键输入框弹出菜单');

  // 点消息区（不是输入框）关闭 —— ContextMenu 是 portal 到 body 的，
  // 它原来用 mousedown capture，点输入框同样关不掉，这次一并改了。
  await page.locator('[data-chat-scroll]').click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(350);
  ok(await hasMenu(page) === false, '点消息区后右键菜单关闭', `hasMenu=${await hasMenu(page)}`);

  // 再开一次，这次点输入框内部另一处（textarea 之外的工具行）
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForTimeout(450);
  const opened = await hasMenu(page);
  if (opened) {
    // ⚠️ 第一版这里硬写 (box.x+30, box.y+height+18)，结果那个坐标**正好被
    // 菜单自己盖住** —— 点在菜单内部本来就不该关，断言必红，看起来像 bug。
    // 现在先量菜单的矩形，再在输入框里挑一个确定不与它相交的点。
    const menuBox = await page.locator('[role="menu"]').first().boundingBox();
    const candidates = [
      { x: box.x + 24, y: box.y + box.height - 12 },
      { x: box.x + box.width - 24, y: box.y + box.height - 12 },
      { x: box.x + box.width - 24, y: box.y + 12 },
    ];
    const inside = p => menuBox
      && p.x >= menuBox.x && p.x <= menuBox.x + menuBox.width
      && p.y >= menuBox.y && p.y <= menuBox.y + menuBox.height;
    const target = candidates.find(p => !inside(p));
    ok(!!target, '找到一个不被菜单遮住的输入框内坐标', target ? `${Math.round(target.x)},${Math.round(target.y)}` : '全被遮住');
    if (target) {
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(350);
      ok(await hasMenu(page) === false, '点输入框内另一处也关（同一片 shadow 区域）', `hasMenu=${await hasMenu(page)}`);
    }
  } else {
    ok(false, '第二次右键仍能弹出菜单（否则后一条无法验证）');
  }

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
