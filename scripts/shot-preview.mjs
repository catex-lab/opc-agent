// 渲染预览页并截图（浅/深两版），用来肉眼检查版式
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const file = path.resolve('preview-thinking.html');
const outDir = path.resolve('.preview-shots');
fs.mkdirSync(outDir, { recursive: true });

// 本机 playwright-core 的版本号比已下载的 chromium 新，直接指定现成的可执行文件
const CHROME =
  process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 980, height: 1400 }, deviceScaleFactor: 2 });
await page.goto('file://' + file.replace(/\\/g, '/'));
await page.waitForTimeout(400);

// 浅色
await page.screenshot({ path: path.join(outDir, 'light.png'), fullPage: true });

// 深色
await page.click('#themeBtn');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, 'dark.png'), fullPage: true });

// 检查有无溢出/文字被裁
const overflow = await page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('.state-card, .think-body, .answer, .bubble-user')) {
    if (el.scrollWidth > el.clientWidth + 1) bad.push(el.className);
  }
  return bad;
});
console.log('overflow:', overflow.length ? overflow : 'none');
console.log('page height:', await page.evaluate(() => document.body.scrollHeight));

await browser.close();
