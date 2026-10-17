/**
 * 设计令牌断言脚本 —— 验证「我们写的值」是否真的生效。
 *
 * 背景：TDesign 用 `:root.dark` (特异性 0,2,0) 定义深色主题，裸 `.dark`
 * (0,1,0) 会被它压过去，导致我们整块深色令牌静默失效。这类问题编译通过、
 * 页面也不报错，只能靠读取浏览器计算样式才能发现。
 *
 * 因此这里不做「看一眼截图」，而是把期望值写成断言：任何一项不符就 FAIL。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = join(process.cwd(), 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const AGENTS = [{ id: 'wb', name: 'WB', vendor: 'v', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: 'd', capabilities: ['chat'], status: { availability: 'ready' } }];
const SESSIONS = [{ id: 's1', title: 'WB', agent_id: 'wb', model: 'm', created_at: new Date().toISOString() }];
const MESSAGES = [{ id: 'm2', role: 'assistant', model: 'm', created_at: new Date().toISOString(), content: '段落含 `inline` 代码。\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n' }];

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let file = join(DIST, p), body;
  try { body = await readFile(file); } catch { file = join(DIST, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); res.end(body);
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
  if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ messages: MESSAGES });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

/** 读取根变量 + 代码块的实际渲染色 */
const sample = () => page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const v = n => root.getPropertyValue(n).trim();
  const host = document.querySelector('.chat-markdown t-chat-md-content');
  const find = name => {
    let f = null;
    const dig = (r, d) => { if (d > 4 || f) return; for (const el of r.querySelectorAll('*')) { if (el.getAttribute('part') === name) { f = el; return; } if (el.shadowRoot) dig(el.shadowRoot, d + 1); } };
    if (host && host.shadowRoot) dig(host.shadowRoot, 0);
    return f;
  };
  const pre = find('md_pre');
  const codeInPre = find('md_code');
  const userBubble = document.querySelector('.tc-bubble-user');
  // 导航条底部两个原生按钮：preflight 关闭后若不重置，会保留 Chrome 原生灰底
  const navBtns = Array.from(document.querySelectorAll('nav button'));
  const themeBtn = navBtns[navBtns.length - 2];
  return {
    brand: v('--td-brand-color'),
    pageBg: v('--td-bg-color-page'),
    container: v('--td-bg-color-container'),
    error: v('--td-error-color'),
    success: v('--td-success-color'),
    toolSearch: v('--tool-color-search'),
    logo: v('--agent-logo-tile'),
    preBg: pre ? getComputedStyle(pre).backgroundColor : null,
    preBorder: pre ? getComputedStyle(pre).borderTopColor : null,
    preRadius: pre ? getComputedStyle(pre).borderRadius : null,
    codeBg: codeInPre ? getComputedStyle(codeInPre).backgroundColor : null,
    codeSize: codeInPre ? getComputedStyle(codeInPre).fontSize : null,
    bubbleImg: userBubble ? getComputedStyle(userBubble).backgroundImage : null,
    themeBtnBg: themeBtn ? getComputedStyle(themeBtn).backgroundColor : null,
    // 原生搜索框：preflight 关闭后会带一圈原生黑边
    rawInputBorder: (() => {
      const i = document.querySelector('input[placeholder="搜索会话"]');
      return i ? getComputedStyle(i).borderTopWidth : null;
    })(),
  };
});

const light = await sample();
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(600);
const dark = await sample();

const rgb = s => s && s.startsWith('#') ? s.toLowerCase() : s;
const checks = [
  ['浅色 品牌色 = 腾讯蓝 #0052d9', rgb(light.brand), '#0052d9'],
  ['深色 品牌色 = #4589ff（未被 TDesign 覆盖）', rgb(dark.brand), '#4589ff'],
  ['浅色 页面底色 = #ffffff', rgb(light.pageBg), '#ffffff'],
  ['深色 页面底色 = #121212（未被 TDesign 覆盖）', rgb(dark.pageBg), '#121212'],
  ['浅色 错误色 = #e34d59', rgb(light.error), '#e34d59'],
  ['深色 错误色 = #e34d59（未被 TDesign 覆盖）', rgb(dark.error), '#e34d59'],
  ['深色 成功色已定义 = #2ba471', rgb(dark.success), '#2ba471'],
  ['深色 工具搜索色已定义 = #4589ff', rgb(dark.toolSearch), '#4589ff'],
  ['浅色 代码块底色 = #f7f7f8', rgb(light.preBg), 'rgb(247, 247, 248)'],
  ['深色 代码块底色 = #1b1b1b（不再发白）', rgb(dark.preBg), 'rgb(27, 27, 27)'],
  ['深色 代码块圆角 = 8px', rgb(dark.preRadius), '8px'],
  ['深色 代码字号 = 13px', rgb(dark.codeSize), '13px'],
  ['浅色 主题按钮无原生灰底', rgb(light.themeBtnBg), 'rgba(0, 0, 0, 0)'],
  ['深色 主题按钮无原生灰底', rgb(dark.themeBtnBg), 'rgba(0, 0, 0, 0)'],
  ['搜索框无原生黑边', rgb(light.rawInputBorder), '0px'],
];

let fail = 0;
console.log('\n令牌断言：');
for (const [name, actual, expect] of checks) {
  const ok = actual === expect;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      实际=${actual}  期望=${expect}`}`);
}

console.log('\n用户气泡渐变：');
console.log(`  浅色 ${light.bubbleImg}`);
console.log(`  深色 ${dark.bubbleImg}`);

console.log(`\n结果：${checks.length - fail}/${checks.length} 通过`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
