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
  // 未读角标已在 A19 随「导航图标不要角标」一同移除，不再断言对比度。
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

  /**
   * 全 DOM 扫蓝。
   *
   * 逐条断言只能覆盖「我记得去检查的那几处」；而「全局禁止蓝色」是个
   * **遍历性**要求 —— 漏掉一个 32px 的图标按钮，肉眼很难在截图里发现。
   * 所以这里把所有元素的实际渲染色都过一遍，把蓝色系揪出来。
   *
   * 覆盖 background-color / color / 四边 border-color / background-image
   * （渐变里的色标）/ box-shadow。lucide 图标走 currentColor，会被 color 命中。
   * 透明度为 0 的不算：看不见的颜色不构成设计。
   */
  const blueHits = [];
  const toRgb = str => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/g;
    const out = [];
    let x;
    while ((x = m.exec(str))) out.push({ r: +x[1], g: +x[2], b: +x[3], a: x[4] === undefined ? 1 : +x[4] });
    return out;
  };
  const blueEnough = ({ r, g, b }) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return false;
    const s = d / (255 - Math.abs(max + min - 255));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = ((h * 60) + 360) % 360;
    return h >= 195 && h <= 265 && s > 0.15;
  };
  const PROPS = ['backgroundColor', 'color', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const label = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
    for (const prop of PROPS) {
      const val = cs[prop];
      if (!val || !val.includes('rgb')) continue;
      const hit = toRgb(val).find(c => c.a > 0.02 && blueEnough(c));
      if (hit) blueHits.push(`${label} ${prop}=${val}`);
    }
    for (const prop of ['backgroundImage', 'boxShadow']) {
      const val = cs[prop];
      if (!val || !val.includes('rgb')) continue;
      const hit = toRgb(val).find(c => c.a > 0.02 && blueEnough(c));
      if (hit) blueHits.push(`${label} ${prop} 含蓝 ${hit.r},${hit.g},${hit.b}`);
    }
  }
  return {
    brand: v('--td-brand-color'),
    onBrand: v('--tc-on-brand'),
    blueHits: [...new Set(blueHits)].slice(0, 8),
    blueCount: new Set(blueHits).size,
    // 扫了多少个节点。没有它，「界面没渲染出来」和「渲染了但没蓝」都是
    // blueCount=0，会被同一条断言判成通过 —— 空页面静默过测。
    nodes: document.querySelectorAll('body *').length,
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
    // A92：导航条单独一档（rail）之后，这里守两件事 ——
    // ① 令牌本身还在（有人把它删了，导航条会退化成透明）；
    // ② 导航条**真的用上了**它（令牌定义了却没人用，是另一类静默失败）。
    // 列表栏仍须是 chrome：两栏同色正是 A92 修掉的问题，改回去要能被抓。
    railBg: (() => {
      const n = document.querySelector('nav');
      return n ? getComputedStyle(n).backgroundColor : null;
    })(),
    railToken: v('--tc-surface-rail'),
    chromeToken: v('--tc-surface-chrome'),
  };
});

const light = await sample();
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(600);
const dark = await sample();

/**
 * 逐个界面扫蓝。
 *
 * 上面两次 sample() 只看了聊天页。但设置页、通讯录、资料页是完全独立的渲染
 * 分支 —— 一个「全局去蓝」如果在设置页漏了一处，聊天页的断言照样全绿。
 * 所以把能走到的界面都扫一遍。`sample()` 里所有取值都做了 null 保护，
 * 换个界面调用不会炸。
 *
 * 走不到就跳过（不静默算通过）：结果里会带上实际扫到的界面名单。
 */
const surfaces = [];
const clickIf = async sel => {
  const l = page.locator(sel).first();
  if (!(await l.count())) return false;
  try {
    await l.click({ timeout: 3000 });
    await page.waitForTimeout(800);
    return true;
  } catch {
    return false;
  }
};
/**
 * 采样一个界面「出来了没有」。
 *
 * 标志物有两种给法：
 *   · `sel` 给了 → 用 `document.querySelector(sel)` 判断。**首选**，
 *     因为页面文案会变，data-* 钩子不会。
 *   · 只给 `marker` → 退回 `innerText.includes(marker)`。
 *
 * 为什么要有 `sel`：通讯录列表原本借用 Tab 文案「联系人」当标志物，
 * A72 按用户要求把 Tab 改成「AGENT」之后，这三个字在通讯录页上**默认已经
 * 不存在了**（「没有匹配的联系人」只在搜索时才出现，placeholder 不算 innerText），
 * 断言当场失效。那次是 p50 漏跑本脚本才没当场发现 —— 已改为钩子，
 * 以后改文案不再影响这条断言。
 */
const sweepSurface = async (name, marker, sel) => {
  const r = await sample();
  // 「界面出来了没有」用**内容**判断，不用节点数。
  // 一开始这里写的是 `nodes < 150 就算没渲染`，结果 150 这个数字是拍的 ——
  // 整个应用本来就只有 90~130 个节点，于是三个界面全被误判成空白页。
  // 真正该问的是「这页的标志性内容在不在」。
  const rendered = sel
    ? await page.evaluate(s => !!document.querySelector(s), sel)
    : await page.evaluate(m => document.body.innerText.includes(m), marker);
  surfaces.push({ name, marker, rendered, count: r.blueCount, hits: r.blueHits, nodes: r.nodes });
};

await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.waitForTimeout(400);
if (await clickIf('button[title="通讯录"]')) {
  // 标志物用 `data-contacts-list` 钩子，**不要用界面文案**。
  // A37 之前这里的标志物是「在线」，它能命中纯属巧合：那句话来自右侧空态的
  // 「本机共有 N 个 Agent 处于在线状态」，跟通讯录列表本身毫无关系。
  // A37 按用户要求把那段小字删了，标志物当场失效 —— 断言报的是
  // 「界面没出来」，读起来像布局崩了，实际只是探针借了一句不相干的文案。
  // A72 把 Tab「联系人」改成「AGENT」又踩了同一类坑（文案变了），
  // 所以这里改成钩子：列表容器 `data-contacts-list` 在空态/有内容时都在。
  await sweepSurface('通讯录列表', '[data-contacts-list]', '[data-contacts-list]');
  // 资料页的标志物用返回键（`data-detail-back`）而不是标题文字：
  // A23 之后那页的「详细资料」标题已被去掉，只剩返回键与资料本身。
  if (await clickIf('button[title^="查看 "]')) await sweepSurface('通讯录资料页', '基本信息');
}
await clickIf('button[title="聊天"]');
if (await clickIf('button[title="设置"]')) await sweepSurface('设置页', '登录配置');

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
  // A92：左侧两栏原来是同一个 chrome 令牌（ΔL* = 0），264px 的列表栏和 56px
  // 的导航条被读成一整块灰。现在导航条单独一档、方向随主题（浅色更深、
  // 深色更亮），四档才单调。这四条同时守「值」和「接线」：
  // 前两条证明导航条用了 rail，后两条证明列表栏没跟着一起漂。
  ['浅色 导航条 = #ececec（比列表栏深一档）', rgb(light.railBg), 'rgb(236, 236, 236)'],
  ['浅色 列表栏仍是框架面 #f5f5f5', rgb(light.chromeToken), '#f5f5f5'],
  ['深色 导航条 = #232323（比列表栏亮一档）', rgb(dark.railBg), 'rgb(35, 35, 35)'],
  ['深色 列表栏仍是框架面 #1b1b1b', rgb(dark.chromeToken), '#1b1b1b'],
  // A19 已移除导航图标角标，未读角标对比度不再断言
  // 遍历性断言：整棵 DOM 里不许出现任何蓝色系渲染色。
  ['浅色 全 DOM 无蓝色渲染色', light.blueCount === 0 ? '0 处' : `${light.blueCount} 处：${light.blueHits.join(' | ')}`, '0 处'],
  ['深色 全 DOM 无蓝色渲染色', dark.blueCount === 0 ? '0 处' : `${dark.blueCount} 处：${dark.blueHits.join(' | ')}`, '0 处'],
  // 其他界面（设置 / 通讯录 / 资料页）单独扫，见上面 surfaces
  ...surfaces.map(s => {
    const detail = s.count === 0 ? `0 处（扫了 ${s.nodes} 个节点）` : `${s.count} 处：${s.hits.join(' | ')}`;
    return [
      `${s.name} 无蓝色渲染色`,
      s.rendered ? detail : `界面没出来（正文里找不到「${s.marker}」），这条不算数`,
      s.rendered ? detail : `含「${s.marker}」`,
    ];
  }),
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
