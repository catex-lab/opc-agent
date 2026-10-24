/**
 * 应用 Logo（同人卦）资产生成线 —— 唯一的几何真源。
 *
 * 设计：**天火同人**（周易第十三卦）。自上而下六爻：
 *   上三爻为乾（☰，三实线）—— 主控、纲领；
 *   下三爻为离（☲，实-断-实）—— 众 Agent 炎上汇聚，中虚为火。
 * 「唯君子为能通天下之志」：把本机多个 Agent 的意志连通，即本应用的编排之事。
 *
 * 两种形态，同一套爻线：
 *   1. **徽章（tile）**：纯黑圆角方块 + 纯白爻线，外圈再描一道纯白细边。
 *      自带底色，任务栏 / 桌面 / 安装包 / Alt+Tab 上明暗桌面都看得清，
 *      不需要随主题换图。白边是纯黑白方案的关键：任务栏是深色时，
 *      纯黑方块会糊进背景里只剩爻线在飘；加一圈白边，形状就还在。
 *   2. **标记（mark）**：裸六爻，`currentColor` 或 `prefers-color-scheme`
 *      明暗自适应（浅色下黑、深色下白）。用于 favicon 与界面内。
 *
 * 为什么用 Chrome 栅格化而不是 Python/Pillow（替代原 make-icons.py）：
 *   1. Pillow 不在本机 venv 外可用，且旧脚本的源图（AI LOGO/me.png）已不存在；
 *   2. SVG 是唯一母版，位图全部由它渲染 —— 改设计只改这里，不会有
 *      「svg 改了、ico 忘了重新生成」的漂移；
 *   3. .ico 是多尺寸容器，这里按标准尺寸集逐一渲染后手写容器
 *      （PNG 压缩条目，Vista+ 全支持），不依赖任何图像库。
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

/**
 * 爻线几何（128×128 画布，六爻自上而下，初爻在最下方）。
 *
 * stroke:gap ≈ 10:8 —— 实测再细，16px 场景下六爻会糊成一条灰带；
 * 再粗则六爻总高超过画布。断爻的缺口单独给 14：阴爻的「断」是这个卦的
 * 识别点（离卦中虚 = 火），缩到 16px 时 8px 级别的缺口会被抗锯齿吃掉。
 * 小尺寸（≤24px）用 wide 变体：缺口拉到 16，牺牲留白换「断」的可读性。
 */
export const GEOM = {
  canvas: 128,
  stroke: 10,
  gap: 8,
  brokenGap: 14,
  /** 裸标记的水平范围（favicon / 界面内） */
  mark: { x0: 16, w: 96 },
  /** 徽章内标记的范围与圆角（OS 级图标） */
  tile: { x0: 24, w: 80, rx: 28 },
  /** 宽缺口变体：仅用于 ≤24px 的渲染 */
  wide: { stroke: 9, gap: 12, brokenGap: 16 },
};

/**
 * 配色 —— 纯黑白，不掺任何其他颜色。
 *
 * 徽章（OS 级图标）用固定的一组：黑底 + 白爻 + 白描边。OS 图标只有一套，
 * 没法随主题翻，所以靠「白描边」这一个技巧同时兼容浅色与深色桌面。
 * 裸标记（favicon / 界面）反而是两态纯色：浅下黑、深下白。
 */
export const COLORS = {
  tileBg: '#000000',
  tileMark: '#FFFFFF',
  /** 徽章描边：让黑底在深色桌面上不消失（见文件头） */
  tileRing: '#FFFFFF',
  tileRingWidth: 4,
  markLight: '#000000',
  markDark: '#FFFFFF',
};

/** 六爻的虚实序列：true = 阳爻（实线）。同人 = 上乾下离 */
export const LINES = [true, true, true, true, false, true];

/**
 * 生成一组爻线 rect。返回 { solids: [...], broken: [...] } 的描述，
 * 由调用方决定 fill 与是否包在徽章里 —— 几何只有这一份。
 */
function lineRects(x0, w, g = GEOM) {
  const total = 6 * g.stroke + 5 * g.gap;
  const top = (g.canvas - total) / 2;
  const segW = (w - g.brokenGap) / 2;
  return LINES.map((solid, i) => {
    const y = top + i * (g.stroke + g.gap);
    return solid
      ? [{ x: x0, y, w, h: g.stroke }]
      : [
          { x: x0, y, w: segW, h: g.stroke },
          { x: x0 + segW + g.brokenGap, y, w: segW, h: g.stroke },
        ];
  });
}

function rectsToSvg(rects, fill, rx = 2) {
  return rects
    .flat()
    .map(r =>
      fill === undefined
        ? `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rx}"/>`
        : `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rx}" fill="${fill}"/>`
    )
    .join('');
}

/**
 * 徽章 SVG：纯黑圆角方块 + 纯白同人卦 + 一圈纯白描边。
 *
 * 描边跨在 rect 边界上，外半边被 viewBox 裁掉，实际看到的是一道贴边的
 * 白箍。浅色桌面上白箍与背景同色（等于没有），深色桌面上它把方块的
 * 轮廓交代出来 —— 一个技巧吃下两种背景，且全程只有黑与白。
 */
export function tileSvg() {
  const t = GEOM.tile;
  const mark = rectsToSvg(lineRects(t.x0, t.w), COLORS.tileMark);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GEOM.canvas} ${GEOM.canvas}">` +
    `<rect x="0" y="0" width="${GEOM.canvas}" height="${GEOM.canvas}" rx="${t.rx}" ` +
    `fill="${COLORS.tileBg}" stroke="${COLORS.tileRing}" stroke-width="${COLORS.tileRingWidth}"/>` +
    mark +
    `</svg>`
  );
}

/**
 * 裸标记 SVG（明暗自适应）。
 *
 * `prefers-color-scheme` 在 SVG favicon 与 <img> 里同样生效 —— 这是
 * 「一个文件承担明暗两态」的关键，不需要两份文件、也不需要运行时切换。
 * 界面内联使用时走 currentColor（见 src/components/AppLogo.tsx）。
 *
 * 爻线不写 fill 属性，由 `.ln` 类统一上色：CSS 的优先级高于表现属性，
 * 类换了色就换了色，不会出现「属性写着黑、媒体查询写着白」的两处真相。
 * 纯黑白两态：浅色下爻线是黑，深色下是白。
 */
export function adaptiveMarkSvg() {
  const m = GEOM.mark;
  const cls = `.ln{fill:${COLORS.markLight}}@media (prefers-color-scheme: dark){.ln{fill:${COLORS.markDark}}}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GEOM.canvas} ${GEOM.canvas}">` +
    `<style>${cls}</style>` +
    `<g class="ln">${rectsToSvg(lineRects(m.x0, m.w), undefined)}</g>` +
    `</svg>`
  );
}

/* ── 栅格化 ─────────────────────────────────────────────────────── */

let page;
let cdp;

async function raster(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}` +
      `svg{display:block;width:${size}px;height:${size}px}` +
      `</style></head><body>${svg}</body></html>`
  );
  // omitBackground 必须为 true：page.screenshot 默认把页面合成到白底上，
  // 徽章的圆角会露出一圈白边，ICO 放进任务栏就是四个白角。
  return page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
}

/**
 * WebP 走 canvas 而不是 CDP。
 *
 * 先试过 `Page.captureScreenshot {format:'webp'}`，本机 Chrome 直接回
 * `Invalid parameters`（playwright 的 screenshot 又不支持 webp）。canvas 的
 * `toDataURL('image/webp')` 是浏览器原生编码路径，与截图管线无关，更稳。
 */
async function rasterWebp(svg, size, quality = 0.9) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;background:transparent}canvas{display:block}` +
      `</style></head><body><canvas id="c" width="${size}" height="${size}"></canvas></body></html>`
  );
  const dataUrl = await page.evaluate(
    async ([svgText, q]) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(svgText);
      await img.decode();
      const ctx = document.getElementById('c').getContext('2d');
      ctx.drawImage(img, 0, 0);
      return document.getElementById('c').toDataURL('image/webp', q);
    },
    [svg, quality]
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/**
 * 手写 ICO 容器（PNG 压缩条目）。
 *
 * 为什么不用 Pillow 的 save(format='ICO')：本机没有 Pillow，而 ICO 格式
 * 本身很简单 —— 6 字节头 + 每条目 16 字节 + 原样内嵌 PNG。Vista 起
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
/** ≤24px 用宽缺口变体（见 GEOM.wide） */
const SMALL_MAX = 24;

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`✗ 找不到 Chrome：${CHROME}（可用 OPC_CHROME 指定）`);
    process.exit(1);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    page = await browser.newPage();

    const tile = tileSvg();
    const mark = adaptiveMarkSvg();

    // SVG 母版落盘（设计源，评审/微调都改这里再跑本脚本）
    await writeFile(path.join(ROOT, 'build/icon.svg'), tile, 'utf8');
    await mkdir(path.join(ROOT, 'src/assets'), { recursive: true });
    await writeFile(path.join(ROOT, 'src/assets/app-logo.svg'), mark, 'utf8');
    await mkdir(path.join(ROOT, 'public'), { recursive: true });
    await writeFile(path.join(ROOT, 'public/favicon.svg'), mark, 'utf8');

    /** 小尺寸切宽缺口几何（描边与 tileSvg 保持一致，否则两套尺寸两张脸） */
    async function tileAt(size) {
      if (size > SMALL_MAX) return raster(tile, size);
      const g = { ...GEOM, ...GEOM.wide };
      const t = g.tile;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.canvas} ${g.canvas}">` +
        `<rect x="0" y="0" width="${g.canvas}" height="${g.canvas}" rx="${t.rx}" ` +
        `fill="${COLORS.tileBg}" stroke="${COLORS.tileRing}" stroke-width="${COLORS.tileRingWidth}"/>` +
        rectsToSvg(lineRects(t.x0, t.w, g), COLORS.tileMark) +
        `</svg>`;
      return raster(svg, size);
    }

    // 主图标（exe / 安装包 / 桌面与开始菜单快捷方式 / 任务栏固定 / Alt+Tab）
    const icoPngs = [];
    for (const s of SIZES_ICO) icoPngs.push({ size: s, data: await tileAt(s) });
    await writeFile(path.join(ROOT, 'build/icon.ico'), buildIco(icoPngs));

    // 托盘图标
    const trayPngs = [];
    for (const s of SIZES_TRAY) trayPngs.push({ size: s, data: await tileAt(s) });
    await writeFile(path.join(ROOT, 'build/tray-icon.ico'), buildIco(trayPngs));

    // BrowserWindow 的 icon（256 足够，Windows 自行缩放）
    await writeFile(path.join(ROOT, 'build/icon.png'), await raster(tile, 256));
    await writeFile(path.join(ROOT, 'build/icon-512.png'), await raster(tile, 512));
    // 关于页与官网用的是同一枚 512
    await writeFile(path.join(ROOT, 'src/assets/app-icon.png'), await raster(tile, 512));
    await mkdir(path.join(ROOT, 'site/assets'), { recursive: true });
    await writeFile(path.join(ROOT, 'site/assets/icon.png'), await raster(tile, 512));
    await writeFile(path.join(ROOT, 'site/assets/icon-52.webp'), await rasterWebp(tile, 52));
    await writeFile(path.join(ROOT, 'site/assets/icon-104.webp'), await rasterWebp(tile, 104));

    // 自检：读回每个产物，确认容器里确实是多尺寸而不是被合并成一张
    const ico = await readFile(path.join(ROOT, 'build/icon.ico'));
    const tray = await readFile(path.join(ROOT, 'build/tray-icon.ico'));
    const gotIco = icoSizes(ico);
    const gotTray = icoSizes(tray);
    const png256 = pngSize(await readFile(path.join(ROOT, 'build/icon.png')));
    const png512 = pngSize(await readFile(path.join(ROOT, 'src/assets/app-icon.png')));

    console.log(`✓ build/icon.svg（徽章母版：黑底白爻白描边）+ src/assets/app-logo.svg + public/favicon.svg（裸标记，黑白明暗自适应）`);
    console.log(`✓ build/icon.ico        尺寸 [${gotIco}]`);
    console.log(`✓ build/tray-icon.ico   尺寸 [${gotTray}]`);
    console.log(`✓ build/icon.png        ${png256?.width}x${png256?.height}`);
    console.log(`✓ build/icon-512.png / src/assets/app-icon.png / site/assets/icon.png  512x512`);
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

// 直接执行才跑主流程 —— 被 verify-logo.mjs import 时只拿 GEOM/COLORS/LINES
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('✗ 生成失败:', err);
    process.exit(1);
  });
}
