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
// 夹具必须同时含 user 与 assistant 两条消息：用户气泡的样式断言依赖
// `.tc-bubble-user` 真实存在。早先只有 assistant 一条，querySelector 返回
// null，气泡相关的断言会静默拿到 null（不断言时看不出来，一加断言就红）。
const MESSAGES = [
  { id: 'm1', role: 'user', created_at: new Date().toISOString(), content: '这段怎么解释？' },
  { id: 'm2', role: 'assistant', model: 'm', created_at: new Date().toISOString(), content: '段落含 `inline` 代码。\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n' },
];

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
  // 未读角标：品牌色底 + 品牌底上的文字色。
  // 只看 --tc-on-brand 变量不够 —— 早先这里写死 `text-white`，
  // 浅色主题（黑底白字）看着没问题，深色主题品牌色反转为浅灰后
  // 就变成「浅灰底 + 白字」，等于隐形。所以要量真实渲染的对比度。
  const badge = Array.from(document.querySelectorAll('nav span')).find(s => s.className.includes('-right-0.5'));
  const luminance = c => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
      v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastOf = el => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const a = luminance(cs.backgroundColor), b = luminance(cs.color);
    return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
  };
  return {
    brand: v('--td-brand-color'),
    onBrand: v('--tc-on-brand'),
    badgeContrast: contrastOf(badge),
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
    bubbleBg: userBubble ? getComputedStyle(userBubble).backgroundColor : null,
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

/**
 * 判断一个颜色是不是「蓝色系」。
 *
 * 产品要求全局不用蓝色 —— 蓝是所有通用 SaaS 的默认解，和黑白 logo 也接不上。
 * 光把当前值改掉不够：以后有人顺手把品牌色改回 #0052d9，测试照样全绿。
 * 所以加一条**性质断言**：色相落在蓝/靛区间（195°~265°）且饱和度够，
 * 就算违规。青（#0e7a8c，190°）和紫（#834ec2，267°）不在区间内。
 */
function isBlue(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return false; // 纯灰/黑白，没有色相
  const s = d / (255 - Math.abs(max + min - 255));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = ((h * 60) + 360) % 360;
  return h >= 195 && h <= 265 && s > 0.15;
}

const checks = [
  ['浅色 品牌色 = 石墨黑 #1f1f1f', rgb(light.brand), '#1f1f1f'],
  ['深色 品牌色 = #e5e5e5（未被 TDesign 覆盖）', rgb(dark.brand), '#e5e5e5'],
  ['浅色 品牌色不是蓝色系', isBlue(light.brand) ? '是蓝' : '非蓝', '非蓝'],
  ['深色 品牌色不是蓝色系', isBlue(dark.brand) ? '是蓝' : '非蓝', '非蓝'],
  ['浅色 页面底色 = #ffffff', rgb(light.pageBg), '#ffffff'],
  ['深色 页面底色 = #121212（未被 TDesign 覆盖）', rgb(dark.pageBg), '#121212'],
  ['浅色 错误色 = #e34d59', rgb(light.error), '#e34d59'],
  ['深色 错误色 = #e34d59（未被 TDesign 覆盖）', rgb(dark.error), '#e34d59'],
  ['深色 成功色已定义 = #2ba471', rgb(dark.success), '#2ba471'],
  ['深色 工具搜索色已定义 = #a06ce0', rgb(dark.toolSearch), '#a06ce0'],
  ['浅色 代码块底色 = #f7f7f8', rgb(light.preBg), 'rgb(247, 247, 248)'],
  ['深色 代码块底色 = #1b1b1b（不再发白）', rgb(dark.preBg), 'rgb(27, 27, 27)'],
  ['深色 代码块圆角 = 8px', rgb(dark.preRadius), '8px'],
  ['深色 代码字号 = 13px', rgb(dark.codeSize), '13px'],
  ['浅色 主题按钮无原生灰底', rgb(light.themeBtnBg), 'rgba(0, 0, 0, 0)'],
  ['深色 主题按钮无原生灰底', rgb(dark.themeBtnBg), 'rgba(0, 0, 0, 0)'],
  ['搜索框无原生黑边', rgb(light.rawInputBorder), '0px'],
  // 用户气泡：从「品牌色 → hover 色」的渐变改成纯品牌色实心。
  // 渐变两端明度差太大，渲染出来是一整块偏艳的色块，
  // 与导航栏并排看像两套品牌色。这里断言「实心 + 无渐变」，
  // 防止以后有人手滑把渐变加回来。
  ['浅色 用户气泡 = 品牌色实心', rgb(light.bubbleBg), 'rgb(31, 31, 31)'],
  ['深色 用户气泡 = 深色品牌色', rgb(dark.bubbleBg), 'rgb(229, 229, 229)'],
  ['浅色 用户气泡无渐变', rgb(light.bubbleImg), 'none'],
  // 品牌底上的文字色：中性品牌色必须反向配对，否则深色主题下会隐形。
  // 变量断言防「值被改错」，对比度断言防「变量定义了却没人用」——
  // 这两件事的失败方式完全不同，各留一条。
  ['浅色 品牌底文字 = #ffffff', rgb(light.onBrand), '#ffffff'],
  ['深色 品牌底文字 = #171717', rgb(dark.onBrand), '#171717'],
  ['浅色 未读角标对比度 ≥ 4.5', light.badgeContrast >= 4.5 ? '达标' : `仅 ${light.badgeContrast}`, '达标'],
  ['深色 未读角标对比度 ≥ 4.5', dark.badgeContrast >= 4.5 ? '达标' : `仅 ${dark.badgeContrast}`, '达标'],
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
