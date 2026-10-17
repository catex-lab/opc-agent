/**
 * **原生标题栏**是否跟着应用主题一起变。
 *
 * ## 为什么单独写一个脚本
 *
 * 上一轮做的「主题跟随系统 + 设置页开关」，验证的是 **CSS 那一半**：
 * 断言 `document.documentElement.classList` 里有没有 `.dark`。
 * 那一半从来都是好的 —— 出问题的是另外一半：
 *
 *   Windows 的**原生标题栏**不由 CSS 画，颜色取自 `nativeTheme.themeSource`。
 *
 * 修好之前，这个组合长这样：
 *   用户在设置里固定「深色」+ Windows 是浅色
 *     → 窗口顶部原生标题栏 = 浅色（操作系统画的）
 *     → 下面整块界面       = 深色（CSS 画的）
 *   一条白带压在深色界面上。
 *
 * 而这条 bug **不会让任何现有断言变红**：CSS 半边全绿、控制台无错，
 * 而且一般的截图根本看不到它（见下）。
 *
 * ## 怎么拿原生标题栏的像素（踩过两遍坑）
 *
 * 窗口有原生边框（frame 默认 true），标题栏由 DWM 绘制，**不在页面视口里**：
 *
 *   坑 1：`page.screenshot()` / CDP captureScreenshot 截的是页面视口，
 *         从标题栏下沿才开始。拿它量「标题栏」量的其实是应用自己的
 *         CSS 头部 —— CSS 本来就对，断言恒绿，是一条假绿断言。
 *
 *   坑 2：整屏截图（GDI+ CopyFromScreen）理论上能包含标题栏，但本机
 *         常驻着别的窗口（编辑器、IM），应用窗口被盖住时截到的是别人
 *         家的像素。而且缩放 + 窗口 show 动画还会让亮度算错。
 *
 *   正解：user32 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)`。
 *         它按窗口自身矩形重绘整窗（含非客户区标题栏），**不依赖 z-order**，
 *         也不受 show 动画影响。拿到的图第一行就是窗口顶边，往下第 N 行
 *         是标题栏与客户区的分界 —— 这个 N 由像素自己说出来（见
 *         findCaptionBoundary），不靠任何系统度量写死。
 *
 * ## 怎么证明「量到的确实是 OS 画的那一段」
 *
 * 光看「顶部带变暗了」不够 —— 万一边界算错、量到了 CSS 头部，也会变暗。
 * 所以同时用两个锚点交叉验证：
 *   1. 浅色下 OS 标题栏与 CSS 头部颜色不同（实测 238,244,249 vs 240,240,240），
 *      边界可被检测出来；深色下同理（32 vs 27）。两主题的边界行号必须一致。
 *   2. `page.screenshot()` 的顶部带（CSS 侧）与标题栏带（OS 侧）必须**一起**
 *      变暗 —— 只有一边变，就是没修干净的割裂。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { decodePng, topBandLuminance } from './lib/png-luma.mjs';

const EXTRA_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--remote-debugging-port=9333'];
const SLEEP = ms => new Promise(r => setTimeout(r, ms));

/** 取打包版 exe 路径：默认用最新的 release-*，避免拿旧包测出绿结果 */
function exeFromArgs() {
  const arg = process.argv[2];
  if (arg) return arg;
  const dirs = readdirSync('.', { withFileTypes: true })
    .filter(d => d.isDirectory() && /^release/.test(d.name))
    .map(d => path.join(d.name, 'win-unpacked', 'OPC Agent.exe'))
    .filter(p => existsSync(p))
    .map(p => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return dirs[0]?.p ?? null;
}

const EXE = exeFromArgs();
if (!EXE) {
  console.error('✗ 找不到打包版。先跑 npm run electron:build，或传路径：');
  console.error('   node scripts/verify-native-theme.mjs "release-p13/win-unpacked/OPC Agent.exe"');
  process.exit(2);
}
console.log(`测试对象: ${EXE}`);

const origin = process.cwd();

const results = [];
const ok = (cond, name, extra = '') => {
  results.push({ pass: !!cond, name, extra });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  [${extra}]` : ''}`);
};

const profileDir = mkdtempSync(path.join(tmpdir(), 'opc-native-theme-'));
let child = null;
let browser = null;

/** 从 stdout 抓 `[Theme]` 行 */
function themeLines(buf) {
  return buf.split(/\r?\n/).filter(l => l.includes('[Theme]'));
}

/** 应用窗口句柄（MainWindowHandle） */
function appHwnd() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command',
      "(Get-Process -Name 'OPC Agent' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle"],
    { encoding: 'utf8', timeout: 15000 }
  );
  const hwnd = Number((r.stdout ?? '').trim());
  if (!hwnd) throw new Error(`拿不到 OPC Agent 窗口句柄: ${(r.stderr ?? '').slice(0, 120)}`);
  return hwnd;
}

/**
 * PrintWindow 抓整窗 → { img, hwnd, w, h }
 *
 * 位图尺寸取自 GetWindowRect（DPI 不感知进程里返回的是逻辑尺寸，
 * 与渲染进程 outerWidth/outerHeight 同单位），不写死 1080x684。
 * flag 2 = PW_RENDERFULLCONTENT，DWM 合成窗口必须用它，否则截到全黑。
 */
function captureWindow(hwnd, outPath) {
  const ps = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -AssemblyName System.Drawing
$h = [IntPtr]${hwnd}
$r = New-Object PW+RECT
[void][PW]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][PW]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$w x $ht"
$g.Dispose(); $bmp.Dispose()
`;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.status !== 0 || !existsSync(outPath)) {
    throw new Error(`PrintWindow 失败: ${(r.stderr ?? '').slice(0, 200)}`);
  }
  return { img: decodePng(readFileSync(outPath)), size: (r.stdout ?? '').trim() };
}

/**
 * 找标题栏下边界：从第 0 行往下，第一行与第 0 行颜色明显不同的行号。
 *
 * 第 0 行是 OS 画的标题栏底色；往下穿过客户区边框就是应用的 CSS 头部。
 * 浅色 238,244,249 → 240,240,240、深色 32,32,32 → 27,27,27，都能分开。
 * 找不到（纯色图）返回 null —— 那说明 PrintWindow 没拿到真窗口，必须报错，
 * 不能默默拿一个假的「标题栏亮度」交差。
 */
function findCaptionBoundary(img) {
  const { width, data } = img;
  const col = Math.round(width / 2);
  const at = y => {
    const i = (y * width + col) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const base = at(0);
  for (let y = 1; y <= 120; y++) {
    const c = at(y);
    if (Math.abs(c[0] - base[0]) > 2 || Math.abs(c[1] - base[1]) > 2 || Math.abs(c[2] - base[2]) > 2) {
      return y;
    }
  }
  return null;
}

/** 标题栏带平均亮度：边界之内、离上下边缘各留 2 行（避开抗锯齿） */
function captionLuma(img, boundary) {
  const { width } = img;
  return bandLuma(img, 2, boundary - 2, width);
}

/** 行区间 [y0, y1) × 中间 80% 列的平均亮度 */
function bandLuma(img, y0, y1, width) {
  const x0 = Math.round(width * 0.1);
  const x1 = Math.round(width * 0.9);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

try {
  // ── [1] 起打包版，开 CDP ──
  console.log('\n[1] 启动打包版（CDP :9333）');
  child = spawn(EXE, EXTRA_ARGS, {
    cwd: origin,
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      ELECTRON_RUN_AS_NODE: undefined,
      OPC_SAFE_GRAPHICS: '1',
      OPC_USER_DATA_DIR: profileDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', d => (buf += String(d)));
  child.stderr.on('data', d => (buf += String(d)));

  browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 25000 });
  const page = browser.contexts().flatMap(c => c.pages())[0];
  ok(!!page, 'CDP 连上并拿到渲染进程页面', page?.url() ?? 'n/a');
  await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 25000 });

  // ── [2] preload 桥存在 ──
  // 这是「只在打包态成立」的一条：浏览器开发态没有 preload，
  // window.opc 是 undefined，本脚本必须跑打包版才有意义。
  const bridge = await page.evaluate(() => ({
    hasOpc: typeof window.opc !== 'undefined',
    hasSetTheme: typeof window.opc?.setTheme === 'function',
  }));
  ok(bridge.hasOpc, 'window.opc 桥存在（preload 已挂载）');
  ok(bridge.hasSetTheme, '桥暴露了 setTheme()');

  // ── [3] 系统浅色 + 跟随系统 → 原生层是 light ──
  // bg=#ffffff 同时承担「系统是浅色」的前提断言：preference=system 时
  // 主进程按系统解析，只有系统浅色才会是 #ffffff。整个脚本的前提就是
  // 系统浅色 + 应用手动固定深色 —— 割裂只在组合下出现。
  await SLEEP(800);
  const bootLine = themeLines(buf)[0] ?? '';
  ok(/themeSource=system/.test(bootLine), '首帧把「跟随系统」同步给原生层', bootLine.trim());
  ok(/bg=#ffffff/.test(bootLine), '前提：系统当前是浅色', bootLine.trim());

  // ── [4] PrintWindow 抓窗 + 找标题栏边界 ──
  console.log('\n[2] PrintWindow 抓整窗，分割「OS 标题栏」与「CSS 头部」');
  const hwnd = appHwnd();
  console.log(`    窗口句柄 = ${hwnd}`);
  const shotDir = mkdtempSync(path.join(tmpdir(), 'opc-native-shots-'));
  const geo = await page.evaluate(() => ({
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
  }));
  const shotLight = captureWindow(hwnd, path.join(shotDir, 'light.png'));
  console.log(`    窗口图 ${shotLight.img.width}x${shotLight.img.height}（GetWindowRect ${shotLight.size}，渲染进程 outer ${geo.outerWidth}x${geo.outerHeight}）`);
  const bLight = findCaptionBoundary(shotLight.img);
  ok(bLight !== null, '能分出标题栏与内容的分界（浅色）', bLight === null ? '未找到' : `第 ${bLight} 行`);
  const capLight = bLight === null ? 0 : captionLuma(shotLight.img, bLight);
  const cssLight = topBandLuminance(await page.screenshot(), 36);
  console.log(`    OS 标题栏亮度 = ${capLight.toFixed(1)}（应当亮）`);
  console.log(`    CSS 头部亮度  = ${cssLight.toFixed(1)}`);
  ok(capLight > 200, '基线可信：系统浅色下 OS 标题栏是亮的', capLight.toFixed(1));

  // ── [5] 手动固定深色（系统仍是浅色 —— 割裂出现的场合）──
  console.log('\n[3] 在设置里固定「深色」（系统保持浅色）');
  await page.locator('button[title="设置"]').first().click();
  await page.waitForSelector('button:has-text("固定深色")', { timeout: 10000 });
  await page.locator('button:has-text("固定深色")').first().click();
  await SLEEP(900);

  const darkLine = themeLines(buf).slice(-1)[0] ?? '';
  ok(/themeSource=dark/.test(darkLine), 'IPC 到达主进程，nativeTheme.themeSource = dark', darkLine.trim());
  ok(/bg=#121212/.test(darkLine), '窗口背景色同步为 #121212', darkLine.trim());

  // ── [6] 原生标题栏真的变暗了 ──
  // 这是唯一无法用别的方式替代的一条：日志证明代码跑了，
  // 窗口自身重绘的像素才证明「用户看到了什么」。
  const shotDark = captureWindow(hwnd, path.join(shotDir, 'dark.png'));
  const bDark = findCaptionBoundary(shotDark.img);
  ok(bDark !== null, '能分出标题栏与内容的分界（深色）', bDark === null ? '未找到' : `第 ${bDark} 行`);
  ok(
    bLight !== null && bDark !== null && Math.abs(bDark - bLight) <= 2,
    '标题栏高度两主题一致（分界没飘）',
    bDark === null ? 'n/a' : `浅色第 ${bLight} 行 / 深色第 ${bDark} 行`
  );
  const capDark = bDark === null ? 255 : captionLuma(shotDark.img, bDark);
  const cssDark = topBandLuminance(await page.screenshot(), 36);
  console.log(`    OS 标题栏亮度 = ${capDark.toFixed(1)}`);
  console.log(`    CSS 头部亮度  = ${cssDark.toFixed(1)}`);
  ok(
    capDark < capLight - 25,
    '原生标题栏确实变暗（浅色 → 深色）',
    `${capLight.toFixed(1)} → ${capDark.toFixed(1)}`
  );
  ok(
    capDark < 110 && cssDark < 110,
    '两边都暗：标题栏与应用一起进入深色（没有割裂）',
    `标题栏 ${capDark.toFixed(1)} / 应用 ${cssDark.toFixed(1)}`
  );

  // ── [7] 改回浅色，标题栏应该亮回来 ──
  await page.locator('button:has-text("固定浅色")').first().click();
  await SLEEP(900);
  const backLine = themeLines(buf).slice(-1)[0] ?? '';
  ok(/themeSource=light/.test(backLine), '切回浅色也到达主进程', backLine.trim());
  const shotBack = captureWindow(hwnd, path.join(shotDir, 'light-again.png'));
  const bBack = findCaptionBoundary(shotBack.img);
  const capBack = bBack === null ? 0 : captionLuma(shotBack.img, bBack);
  console.log(`    回到浅色后 OS 标题栏亮度 = ${capBack.toFixed(1)}`);
  ok(
    capBack > capDark + 25,
    '原生标题栏跟着亮回来',
    `${capDark.toFixed(1)} → ${capBack.toFixed(1)}`
  );

  rmSync(shotDir, { recursive: true, force: true });
} catch (e) {
  ok(false, '脚本执行', e.message.slice(0, 200));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child) child.kill();
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* 忽略：安全软件的过滤驱动可能锁住缓存目录 */
  }
}

let fail = 0;
for (const r of results) if (!r.pass) fail++;
console.log(`\n结果：${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
