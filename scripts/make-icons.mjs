/**
 * 应用 Logo 资产生成线 —— **唯一真源是 `build/logo-source.png`**。
 *
 * ## 2026-10-29：从「几何 SVG」换成「位图源」
 *
 * 上一版这里画的是**天火同人**（周易第十三卦）六爻：纯黑白、参数化 rect、
 * 由 `GEOM` / `LINES` 唯一描述，`AppLogo.tsx` 手写同一套几何，`verify-logo.mjs`
 * 做逐字段契约断言。用户随后要求改用设计稿 `科技猫咪徽章助手.png`
 * （彩色插画：猫趴在蓝色徽章里、深蓝描边、透明底），于是整条链的输入从
 * 「参数化几何」变成「一张位图」。
 *
 * 这次替换的连带影响（改之前先知道，否则会漏）：
 *   1. **没有几何契约了**。位图没有 rect 可断言，`verify-logo.mjs` 的资产层
 *      改成验「同一源图 → 各尺寸产物的色彩指纹一致」，不再是坐标比对。
 *   2. **小尺寸必须单独增强**。实测源图缩到 16px 只剩一团色块、24px 勉强
 *      能看出是个头 —— 这是彩色插画的物理限制，不是缩放的锅。所以 ≤24px
 *      走 `SMALL_BOOST`（提对比 + 提饱和），把「蓝环 + 白脸」这两个识别点保住。
 *   3. **明暗不再靠反转**。旧徽章是黑底白爻，深色主题下必须翻成白底黑爻；
 *      新图自带深蓝描边，实测在 #FFFFFF / #1A1A1A / #808080 三种底上都成立
 *      （深色底反而对比更强）。所以**一张图吃两种主题**，只在界面内对暗色
 *      做一点点提亮（见 index.css 的 `:root.dark [data-app-logo]`）。
 *
 * ## 保留的部分
 *
 * 栅格化（Chrome）+ 手写 ICO 容器 + 产物自检**原样保留**：ICO 的多尺寸容器
 * 是本机唯一能让 Windows 在 16/20/24/32 各档都不糊的手段；而 Pillow 不在
 * 用户机器的 venv 里（脚本必须能在裸 `npm run` 下跑），所以不用 Pillow。
 *
 * 用法：node scripts/make-icons.mjs
 * 依赖：playwright-core（devDependency）+ 本机 Chrome。
 */

import { chromium } from 'playwright-core';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME = process.env.OPC_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** 唯一设计源。换 logo 就换这个文件，再跑本脚本。 */
export const SRC = path.join(ROOT, 'build/logo-source.png');

/**
 * 小尺寸增强参数（≤24px）。
 *
 * 实测：源图 1254px 直接下采样到 16px，胡须与瞳孔被抗锯齿抹平，只剩
 * 「蓝环 + 一团白」；24px 能看出轮廓但眼睛是两个模糊的黑点。提对比 +
 * 提饱和之后，16px 至少还能读出「深蓝环包着白脸」这个形状，24px 能分辨
 * 五官位置 —— 这是这个尺寸的物理上限，再调也不会更清楚。
 */
export const SMALL_MAX = 24;
const SMALL_BOOST = { contrast: 1.15, saturate: 1.1, brighten: 1.02 };

/* ── 栅格化 ─────────────────────────────────────────────────────── */

let page;

/**
 * 把源 PNG 缩放到目标尺寸，返回 PNG Buffer。
 *
 * 为什么走 Chrome 而不是 Node 里的图像库：项目没有 sharp/jimp 依赖，
 * 而 Chrome 的 `imageSmoothingQuality='high'` 是浏览器里质量最好的一档
 * 下采样（接近 LANCZOS），且 `ctx.filter` 能直接做对比/饱和增强 ——
 * 不用为了 16px 的锐化再引一个图像处理依赖。
 *
 * 走 canvas → toDataURL 而不是 page.screenshot：画布本身就是透明的，
 * 源图的 alpha 通道原样保留（不会出现「圆角处一圈白角」）。
 */
async function rasterPng(size, boost) {
  const b64 = (await readFile(SRC)).toString('base64');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;background:transparent}` +
      `canvas{display:block}` +
      `</style></head><body><canvas id="c" width="${size}" height="${size}"></canvas></body></html>`
  );
  const dataUrl = await page.evaluate(
    async ([src, px, b]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + src;
      await img.decode();
      const c = document.getElementById('c');
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (b) {
        ctx.filter = `contrast(${b.contrast}) saturate(${b.saturate}) brightness(${b.brighten})`;
      }
      ctx.drawImage(img, 0, 0, px, px);
      return c.toDataURL('image/png');
    },
    [b64, size, boost ?? null]
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/** 同一张图转 WebP（官网用），同样走 canvas 原生编码 */
async function rasterWebp(size, quality = 0.92) {
  const png = await rasterPng(size);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;background:transparent}canvas{display:block}` +
      `</style></head><body><canvas id="c" width="${size}" height="${size}"></canvas></body></html>`
  );
  const dataUrl = await page.evaluate(
    async ([b64, px, q]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const ctx = document.getElementById('c').getContext('2d');
      ctx.drawImage(img, 0, 0, px, px);
      return document.getElementById('c').toDataURL('image/webp', q);
    },
    [png.toString('base64'), size, quality]
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/**
 * 手写 ICO 容器（PNG 压缩条目）。
 *
 * 为什么不用 Pillow 的 save(format='ICO')：用户机器上不一定有 Pillow，而 ICO
 * 格式本身很简单 —— 6 字节头 + 每条目 16 字节 + 原样内嵌 PNG。Vista 起
 * Windows 就支持 PNG 条目，256px 必须用 PNG（BMP 条目会爆体积）。
 */
export function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const entries = [];
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 0); // 宽，256 记 0
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 1); // 高，同上
    e.writeUInt8(0, 2); // 调色板色数（PNG 条目不用）
    e.writeUInt8(0, 3); // 保留
    e.writeUInt16LE(1, 4); // 色平面
    e.writeUInt16LE(32, 6); // 位深
    e.writeUInt32LE(p.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

/** 读 PNG 的 IHDR，拿宽高（不依赖图像库） */
export function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 读 ICO 的目录，返回各条目尺寸（自检用：确认没被悄悄合并成一张） */
export function icoSizes(buf) {
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const w = buf.readUInt8(off);
    out.push(w === 0 ? 256 : w);
  }
  return out.sort((a, b) => a - b);
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

const SIZES_ICO = [16, 24, 32, 48, 64, 128, 256];
/** 托盘单独一套：Windows 托盘按 DPI 取 16/20/24/32，不含大尺寸 */
const SIZES_TRAY = [16, 20, 24, 32];

/** 小尺寸自动套增强，大尺寸原样 */
function raster(size) {
  return rasterPng(size, size <= SMALL_MAX ? SMALL_BOOST : undefined);
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`✗ 找不到设计源：${SRC}`);
    process.exit(1);
  }
  if (!existsSync(CHROME)) {
    console.error(`✗ 找不到 Chrome：${CHROME}（可用 OPC_CHROME 指定）`);
    process.exit(1);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    page = await browser.newPage();

    // 主图标（exe / 安装包 / 桌面与开始菜单快捷方式 / 任务栏固定 / Alt+Tab）
    const icoPngs = [];
    for (const s of SIZES_ICO) icoPngs.push({ size: s, data: await raster(s) });
    await writeFile(path.join(ROOT, 'build/icon.ico'), buildIco(icoPngs));

    // 托盘图标
    const trayPngs = [];
    for (const s of SIZES_TRAY) trayPngs.push({ size: s, data: await raster(s) });
    await writeFile(path.join(ROOT, 'build/tray-icon.ico'), buildIco(trayPngs));

    // BrowserWindow 的 icon（256 足够，Windows 自行缩放）
    await writeFile(path.join(ROOT, 'build/icon.png'), await raster(256));
    await writeFile(path.join(ROOT, 'build/icon-512.png'), await raster(512));

    // 界面内标记 + 关于页大图
    await mkdir(path.join(ROOT, 'src/assets'), { recursive: true });
    await writeFile(path.join(ROOT, 'src/assets/app-logo.png'), await raster(256));
    await writeFile(path.join(ROOT, 'src/assets/app-icon.png'), await raster(512));

    // favicon：浏览器标签实际按 16/32 取，两个都给
    await mkdir(path.join(ROOT, 'public'), { recursive: true });
    await writeFile(path.join(ROOT, 'public/favicon.png'), await raster(32));
    await writeFile(path.join(ROOT, 'public/favicon-16.png'), await raster(16));

    // 官网
    await mkdir(path.join(ROOT, 'site/assets'), { recursive: true });
    await writeFile(path.join(ROOT, 'site/assets/icon.png'), await raster(512));
    await writeFile(path.join(ROOT, 'site/assets/icon-52.webp'), await rasterWebp(52));
    await writeFile(path.join(ROOT, 'site/assets/icon-104.webp'), await rasterWebp(104));

    // 自检：读回每个产物，确认容器里确实是多尺寸而不是被合并成一张
    const gotIco = icoSizes(await readFile(path.join(ROOT, 'build/icon.ico')));
    const gotTray = icoSizes(await readFile(path.join(ROOT, 'build/tray-icon.ico')));
    const png256 = pngSize(await readFile(path.join(ROOT, 'build/icon.png')));
    const png512 = pngSize(await readFile(path.join(ROOT, 'src/assets/app-icon.png')));

    console.log(`✓ 设计源 build/logo-source.png（彩色徽章，透明底）`);
    console.log(`✓ build/icon.ico        尺寸 [${gotIco}]`);
    console.log(`✓ build/tray-icon.ico   尺寸 [${gotTray}]`);
    console.log(`✓ build/icon.png        ${png256?.width}x${png256?.height}`);
    console.log(`✓ build/icon-512.png / src/assets/app-icon.png / site/assets/icon.png  512x512`);
    console.log(`✓ src/assets/app-logo.png 256x256（界面内标记）`);
    console.log(`✓ public/favicon.png 32 / favicon-16.png 16`);
    console.log(`✓ site/assets/icon-52.webp / icon-104.webp`);

    const wantIco = JSON.stringify(SIZES_ICO);
    if (JSON.stringify(gotIco) !== wantIco) {
      console.error(`✗ icon.ico 尺寸不符：期望 ${wantIco}，实际 [${gotIco}]`);
      process.exit(1);
    }
    if (JSON.stringify(gotTray) !== JSON.stringify(SIZES_TRAY)) {
      console.error(`✗ tray-icon.ico 尺寸不符：期望 [${SIZES_TRAY}]，实际 [${gotTray}]`);
      process.exit(1);
    }
    if (png256?.width !== 256 || png512?.width !== 512) {
      console.error('✗ PNG 尺寸不符');
      process.exit(1);
    }
    console.log('自检通过。');
  } finally {
    await browser.close();
  }
}

// 直接执行才跑主流程 —— 被 verify-logo.mjs import 时只拿工具函数
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('✗ 生成失败:', err);
    process.exit(1);
  });
}
