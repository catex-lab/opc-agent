// 分段截图，便于逐块检查细节
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const file = path.resolve('preview-thinking.html');
const outDir = path.resolve('.preview-shots');
fs.mkdirSync(outDir, { recursive: true });

const CHROME =
  process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
await page.goto('file://' + file.replace(/\\/g, '/'));
await page.waitForTimeout(400);

const sections = await page.$$('.section');
for (let i = 0; i < sections.length; i++) {
  await sections[i].screenshot({ path: path.join(outDir, `s${i}.png`) });
}

// 深色下取关键两块
await page.click('#themeBtn');
await page.waitForTimeout(300);
await sections[1].screenshot({ path: path.join(outDir, 'dark-s1.png') });
await sections[3].screenshot({ path: path.join(outDir, 'dark-s3.png') });

await browser.close();
console.log('ok');
