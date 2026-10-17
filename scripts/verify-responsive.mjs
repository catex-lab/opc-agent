/**
 * 响应式与「标题栏同色」的断言脚本。
 *
 * 逐条断言，不是截图对比。要守住的几件事：
 *
 *  1. **标题栏与左侧栏同色** —— 量 `getComputedStyle`，不能靠眼睛。
 *     这条真正的历史坑在于：两者原本用的是同一个令牌（--td-bg-color-container），
 *     但浅色下 #fafafa 与主内容区的 #ffffff 只差 2%，标题栏看着像没有底色；
 *     深色下 #1c1c1c 与 #121212 差得够开，反而是清楚的。
 *     「同一个令牌」在两个主题里给出了不同观感 —— 所以要断言**颜色相同**，
 *     而不是断言「用的是同一个变量名」。
 *  2. **窄屏单栏** —— 列表与内容同一时刻只能有一个在 DOM 里。
 *     用 hidden 只藏不删的话，藏起来的那半截仍在跑副作用、仍能 Tab 到。
 *  3. **返回键只在窄屏出现**。
 *  4. **导航条宽度随宽度收缩**（64 → 56）。
 *  5. **聊天页不再显示 Agent 简介**（agent.description）。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = join(process.cwd(), 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const AGENTS = [
  { id: 'wb', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '这句简介不该出现在聊天页', capabilities: ['chat'], status: { availability: 'ready' } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '代码审查', capabilities: ['chat'], status: { availability: 'ready' } },
];
const SESSIONS = [{ id: 's1', title: 'WorkBuddy', agent_id: 'wb', kind: 'direct', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
const MESSAGES = [{ id: 'm1', role: 'user', created_at: new Date().toISOString(), content: '你好' }];

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = join(DIST, p);
  let body;
  try { body = await readFile(file); } catch { file = join(DIST, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route('**/api/**', route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/\/api\/agents/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: [{ modelId: 'm', name: 'M' }] });
  if (/\/api\/check-login/.test(url)) return json({ isLoggedIn: true, method: 'cli' });
  if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ messages: MESSAGES });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

const checks = [];
const record = (name, actual, expect) => {
  const ok = actual === expect;
  checks.push([name, ok, actual, expect]);
  return ok;
};

const read = () => page.evaluate(() => {
  const nav = document.querySelector('nav');
  const headers = [...document.querySelectorAll('header')];
  const column = nav?.nextElementSibling;
  const main = document.querySelector('main');
  return {
    navBg: nav ? getComputedStyle(nav).backgroundColor : null,
    navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
    headerBgs: headers.map(h => getComputedStyle(h).backgroundColor),
    mainBg: main ? getComputedStyle(main).backgroundColor : null,
    // 判「列表在不在 DOM」不能看 nav 的下一个兄弟节点 —— 列表被移除后
    // 那个位置变成 main，nextElementSibling 照样有值，断言会恒为 true。
    // 要用只存在于列表里的东西：会话列表的搜索框。
    columnInDom: !!document.querySelector('input[placeholder="搜索会话"]'),
    mainInDom: !!main,
    backBtn: document.querySelectorAll('button[title="返回消息列表"]').length,
    chatText: document.querySelector('main')?.innerText ?? '',
  };
});

// ── 宽屏 ──
let r = await read();
record('宽屏 标题栏与导航条同色', r.headerBgs[0], r.navBg);
record('宽屏 主区头部与导航条同色', r.headerBgs[1], r.navBg);
record('宽屏 导航条 64px', r.navWidth, 64);
record('宽屏 列表与内容同时在 DOM', String(r.columnInDom && r.mainInDom), 'true');
record('宽屏 没有返回键', r.backBtn, 0);
record('宽屏 聊天页不出现 Agent 简介', r.chatText.includes('这句简介不该出现在聊天页'), false);
// 框架面与内容面必须拉开一档，否则「同色」这件事看不出意义
record('宽屏 框架面与内容面有色差（≥ 8）', diffLum(r.headerBgs[0], r.mainBg) >= 8 ? '≥8' : String(diffLum(r.headerBgs[0], r.mainBg)), '≥8');

// ── 窄屏：只应有内容 ──
await page.setViewportSize({ width: 820, height: 700 });
await page.waitForTimeout(800);
r = await read();
record('窄屏 列表已从 DOM 移除（打开会话时）', r.columnInDom, false);
record('窄屏 内容仍在', r.mainInDom, true);
record('窄屏 有返回键', r.backBtn, 1);
record('窄屏 导航条 56px', r.navWidth, 56);

// ── 返回 → 只剩列表 ──
await page.locator('button[title="返回消息列表"]').first().click();
await page.waitForTimeout(800);
r = await read();
record('窄屏 返回后内容已从 DOM 移除', r.mainInDom, false);
record('窄屏 返回后列表出现', r.columnInDom, true);

// ── 深色下再量一次同色。先切回宽屏并打开会话，
//    否则 main 不在 DOM 里，拿不到内容面的颜色。──
await page.setViewportSize({ width: 1280, height: 800 });
await page.locator('button[title="通讯录"]').first().click().catch(() => {});
await page.waitForTimeout(500);
await page.locator('button[title="聊天"]').first().click();
await page.waitForTimeout(500);
await page.locator('div[role="button"]').filter({ hasText: 'WorkBuddy' }).first().click();
await page.waitForTimeout(800);
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(600);
r = await read();
record('深色 标题栏与导航条同色', r.headerBgs[0], r.navBg);
record('深色 框架面与内容面有色差（≥ 8）', diffLum(r.headerBgs[0], r.mainBg) >= 8 ? '≥8' : String(diffLum(r.headerBgs[0], r.mainBg)), '≥8');

// ── 设置页有外观分区 ──
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(500);
await page.locator('button[title="设置"]').first().click();
await page.waitForTimeout(900);
const settings = await page.evaluate(() => ({
  hasAppearance: document.body.innerText.includes('外观'),
  hasSystem: document.body.innerText.includes('跟随系统'),
}));
record('设置页 有外观分区', settings.hasAppearance, true);
record('设置页 有「跟随系统」选项', settings.hasSystem, true);

/** 两个颜色的相对亮度差的绝对值。小于 8 说明「同色」与「没色」分不出来。 */
function diffLum(a, b) {
  if (!a || !b) return 0;
  const lum = c => {
    const [r, g, bb] = c.match(/\d+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bb;
  };
  return Math.round(Math.abs(lum(a) - lum(b)));
}

let fail = 0;
console.log('\n响应式与标题栏同色：');
for (const [name, ok, actual, expect] of checks) {
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      实际=${actual}  期望=${expect}`}`);
}
if (errors.length) {
  console.log('页面错误：', errors.slice(0, 3));
  fail++;
}
console.log(`\n结果：${checks.length - fail}/${checks.length} 通过`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
