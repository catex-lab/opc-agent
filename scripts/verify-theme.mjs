/**
 * 主题「跟随系统」的验收。
 *
 * 不是「看一眼截图」，而是把五步都写成断言。这个 bug 之所以能藏很久，
 * 是因为它的失效方式是**静默**的：界面看着正常，只是不再跟着系统变。
 *
 * 要验证：
 *   1. 默认（没存过偏好）= 跟随系统；系统是深色 → 应用是深色，
 *      并且**不往 localStorage 写值** —— 旧实现一启动就把具体色值写死，
 *      从此「跟随系统」只生效一次。
 *   2. 系统从深色切浅色 → 应用跟着切。
 *   3. 用户手动固定浅色 → 保存 'light'。
 *   4. 系统再切深色 → 应用**不动**（这才是「固定」该有的行为）。
 *   5. 改回「跟随系统」→ 立刻跟随当前系统。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = join(process.cwd(), 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const AGENTS = [{ id: 'wb', name: 'WB', vendor: 'v', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: 'd', capabilities: ['chat'], status: { availability: 'ready' } }];

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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
await ctx.route('**/api/**', route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/\/api\/agents/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: [{ modelId: 'm', name: 'M' }] });
  if (/\/api\/sessions/.test(url)) return json({ sessions: [] });
  return json({});
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

const state = () => page.evaluate(() => ({
  dark: document.documentElement.classList.contains('dark'),
  saved: localStorage.getItem('theme'),
}));

const r1 = await state();
await page.emulateMedia({ colorScheme: 'light' });
await page.waitForTimeout(500);
const r2 = await state();

await page.locator('button[title="设置"]').first().click();
await page.waitForTimeout(900);
// 选择器要避开「跟随系统」那张卡：它的说明文案里也含「浅色」二字
// （"跟着 Windows 的深浅色设置走"），用 :has-text("浅色") 会命中两张卡。
await page.locator('[data-theme-option="light"]').first().click();
await page.waitForTimeout(400);
const r3 = await state();
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(600);
const r4 = await state();
await page.locator('[data-theme-option="system"]').first().click();
await page.waitForTimeout(600);
const r5 = await state();

const checks = [
  ['① 默认跟随系统 + 不写 localStorage（系统深色 → 深色）', r1.dark === true && r1.saved === null],
  ['② 系统切浅色 → 应用跟着切', r2.dark === false && r2.saved === null],
  ['③ 手动固定浅色 → 保存 light', r3.dark === false && r3.saved === 'light'],
  ['④ 系统再切深色 → 应用保持浅色（固定生效）', r4.dark === false && r4.saved === 'light'],
  ['⑤ 改回跟随系统 → 立刻跟随（当前为深色）', r5.dark === true && r5.saved === 'system'],
];

let fail = 0;
console.log('\n主题跟随系统：');
for (const [name, ok] of checks) {
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}
if (errors.length) {
  console.log('页面错误：', errors.slice(0, 3));
  fail++;
}
console.log(`\n结果：${checks.length - fail}/${checks.length} 通过`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
