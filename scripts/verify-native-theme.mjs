/**
 * **窗口标题栏**是否真的是应用自己画的那一条 —— 颜色、高度、位置都对得上。
 *
 * ## 这个脚本的前提变过一次（读之前必须先知道）
 *
 * 上一版的前提是：窗口用**标准 Windows 边框**，标题栏由 DWM 画、不在页面视口里，
 * 所以要 `PrintWindow` 抓整窗、找「OS 标题栏 / CSS 头部」的分界线，证明两边
 * 一起变暗。那一版修的是「系统标题栏跟应用不同步深浅」。
 *
 * 现在窗口改成了 `frame: false`（A24 起连三个按钮也自绘）：
 *   · 系统标题栏**整条没了** —— 页面从窗口第 0 行开始，标题栏是
 *     `src/components/TitleBar.tsx` 画的普通 DOM；
 *   · 最小化/最大化/关闭三个按钮**也在页面里**（A23 时还是 `titleBarOverlay`
 *     交给系统画的，那块底色永远实色，把透明度的上限卡在 45）。
 *
 * 于是「找分界线」这件事本身失效了：没有 OS 标题栏可找。新前提下的
 * 真问题是下面三件，而它们**都不会让任何 CSS 断言变红**：
 *
 *   1. 系统标题栏有没有真的消失（没消失 = 上面白压一条，页面被推下去 32px）
 *   2. 三个按钮的底色有没有等于标题条的底色（不等 = 右上角一块异色方块）
 *   3. 两边高度有没有对齐（不齐 = 按钮压在标题条底边线上，或悬在半空）
 *
 * ## 为什么仍然用 PrintWindow
 *
 * 虽然按钮现在由页面画、`page.screenshot()` 也能拍到，但本脚本要证明的是
 * **「窗口顶部那一条就是页面画的，不是 DWM 又画了一条」** —— 这需要
 * 窗口矩形内的最终像素，只有 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)`
 * 能给。`page.screenshot()` 只有视口内容，拿它验证「窗口顶部」等于自己跟
 * 自己比，恒绿。
 *
 * ## 四路交叉验证（单看任何一路都可能假绿）
 *
 *   A. 页面里的三个按钮 —— 数量、尺寸、是否都在 `[data-titlebar]` 内。
 *      同时断言 `navigator.windowControlsOverlay` **不存在**：它一回来，
 *      就说明 titleBarOverlay 被加回去了，透明度的 100% 会立刻失效。
 *   B. `outerHeight - innerHeight` —— 有系统标题栏时 ≈40（caption 32 + 边框），
 *      隐藏后只剩边框级（个位数）。差一个数量级，不会被噪声骗。
 *   C. PrintWindow 像素 —— 窗口**顶部那一整条（含右上角按钮的落点）**
 *      必须是页面画的框架面，且跟着主题变色。系统标题栏若还在，
 *      顶部这几十行就是 DWM 画的，颜色不会等于我们的 chrome 令牌。
 *   D. 主进程日志 —— `[Theme]` 行里带 `caption=self`，证明运行期确实是
 *      页面在画按钮（而不是悄悄退回系统控件）。
 *
 * ## 有一条曾经测不了、现在能测了（留作记录）
 *
 * A23 时三个按钮由系统画，字形抓不到：`PrintWindow` 里按钮落点区的
 * 「与底色差 >40 的像素」恒为 0 个，`CopyFromScreen` 又抢不到前台。
 * 所以那时「按钮长什么样」只能人眼看。
 *
 * A24 自绘之后这条自动解决了：字形是页面像素，`PrintWindow` 一定拍得到，
 * 下面 `inkRatio > 0` 就是「三个字形真的画出来了」的证据。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { decodePng } from './lib/png-luma.mjs';

const EXTRA_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--remote-debugging-port=9333'];
/**
 * 主题卡片选择器：优先用 A37 加的锚点，退回 A36 及更早包里的按钮文案。
 * 原因：本脚本验证的是 Electron 外壳，跑的是打包产物，而产物可能比源码旧。
 */
const DARK_CARD = '[data-theme-option="dark"], button:has-text("固定深色")';
const LIGHT_CARD = '[data-theme-option="light"], button:has-text("固定浅色")';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

/** 与 electron/main.ts 的 TITLE_BAR_HEIGHT、index.css 的 --tc-titlebar-height 同源 */
const TITLE_BAR_HEIGHT = 40;
/** 标题条与三个窗口按钮所在的那一档。A94 起它等于 `--tc-surface-rail`
 *  （浅色 #ececec / 深色 #232323），不再是 `--tc-surface-chrome`。
 *  ⚠️ 这两个数是**像素采样**的期望值，不是令牌原文 —— 改令牌必须同步改这里，
 *     否则会得到「按钮底色不对」的假红。 */
const TITLEBAR = { light: [236, 236, 236], dark: [35, 35, 35] };

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
  console.error('   node scripts/verify-native-theme.mjs "release-p16/win-unpacked/OPC Agent.exe"');
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

/**
 * 子进程环境。
 *
 * ⚠️ 两个变量必须**删掉**，不能写成 `undefined`。
 * `{ ...process.env, X: undefined }` 里 `X` 仍然是原值 —— Node 只是跳过
 * 值为 undefined 的键，不会把已有的键删掉。本机宿主（WorkBuddy CLI）自带：
 *   · `ELECTRON_RUN_AS_NODE=1` → 打包版会当成 node 跑，**不开窗口**，
 *     于是 CDP 端口永远起不来（症状：`connect ECONNREFUSED 127.0.0.1:9333`）；
 *   · `NODE_OPTIONS=--require=...shim.cjs` → 垫片会改写文件删除行为。
 * 早先这里写的是 `X: undefined`，在干净的 shell 里碰巧能过，在宿主里必挂。
 * 用 delete 才是「真的移除」。
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 当前所有 `OPC Agent` 进程的 pid。
 *
 * 必须记下启动前的快照：本机很可能**同时开着用户自己的那份应用**
 * （或者上一轮打靶没退干净）。实测踩过一次：`Get-Process | Select -First 1`
 * 取到的是 19:45 就在跑的那个旧实例，于是 PrintWindow 抓的是**别人家的窗口**，
 * 一整片 #222 的怪像素 —— 而所有 DOM 断言全绿（那些走的是 CDP，连的是新实例）。
 * 两条链路量的不是同一个窗口，这种假绿最难发现。
 */
function processIds() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "(Get-Process -Name 'OPC Agent' -ErrorAction SilentlyContinue).Id -join ','"],
    { encoding: 'utf8', timeout: 15000 }
  );
  return new Set(
    (r.stdout ?? '')
      .trim()
      .split(',')
      .filter(Boolean)
      .map(Number)
  );
}

/**
 * 本次启动那个实例的窗口句柄。
 *
 * 用「启动前的 pid 快照」做差集，而不是取第一个 —— 见 processIds() 的注释。
 * 同时返回 pid 与「新实例个数」，让调用处能把「只找到 1 个」这件事断言出来。
 */
function freshWindow(before) {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command',
      "Get-Process -Name 'OPC Agent' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { \"$($_.Id)|$($_.MainWindowHandle)\" }"],
    { encoding: 'utf8', timeout: 15000 }
  );
  const rows = (r.stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => l.split('|').map(Number));
  const fresh = rows.filter(([pid]) => !before.has(pid));
  if (fresh.length === 0) {
    throw new Error(
      `本次启动的实例没有窗口（pid 快照 ${[...before].join(',')}，` +
        `当前有窗口的 ${rows.map(([p]) => p).join(',') || '无'}）`
    );
  }
  return { pid: fresh[0][0], hwnd: fresh[0][1], freshCount: fresh.length };
}

/**
 * PrintWindow 抓整窗 → { img, size }
 *
 * 位图尺寸取自 GetWindowRect（DPI 不感知进程里返回的是逻辑尺寸，
 * 与渲染进程 outerWidth/outerHeight 同单位），不写死分辨率。
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

/** 单像素 RGB */
function pixelAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** 三个通道的最大差 */
function maxDiff(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/**
 * 区域统计：平均色 / 众数色 / 与底色明显不同的像素占比。
 *
 * 众数色用来回答「这块区域的底色是什么」——平均色会被字形像素拉低，
 * 而底色恰恰是这块区域里**占绝对多数**的那个颜色。
 */
function regionStats(img, x0, y0, x1, y1) {
  const counts = new Map();
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = pixelAt(img, x, y);
      sr += r;
      sg += g;
      sb += b;
      n++;
      // 量化到 6 位/通道（每档 4）：抗锯齿产生的相近色不该各算一票，
      // 但档位也不能太粗 —— 4 位量化会把 #f5f5f5(245) 归到 255 那一档，
      // 于是「众数色」显示成纯白，看着像量错了地方。
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let bestKey = 0;
  let bestN = -1;
  for (const [k, v] of counts) {
    if (v > bestN) {
      bestN = v;
      bestKey = k;
    }
  }
  const mode = [((bestKey >> 12) & 0x3f) * 4, ((bestKey >> 6) & 0x3f) * 4, (bestKey & 0x3f) * 4];
  // 「字形」= 与众数色亮度差 > 40 的像素
  const modeLuma = 0.2126 * mode[0] + 0.7152 * mode[1] + 0.0722 * mode[2];
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = pixelAt(img, x, y);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (Math.abs(luma - modeLuma) > 40) ink++;
    }
  }
  return { avg: [sr / n, sg / n, sb / n].map(Math.round), mode, inkRatio: ink / n, n };
}

/** 行区间 [y0,y1) × 列比例 [fx0,fx1) 的平均亮度 */
function bandLuma(img, y0, y1, fx0 = 0.2, fx1 = 0.55) {
  const x0 = Math.round(img.width * fx0);
  const x1 = Math.round(img.width * fx1);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * 页面截图里同一块区域的亮度 —— 必须用**同样的列比例**取样，
 * 否则「窗口顶部」和「页面顶部」比的不是同一块地方。
 *
 * 只取中间段（20%~55%）而不是整宽：左边有应用标记（深色小块），
 * 右边在窗口图里是三个按钮的字形 —— 两边取样范围只要含到它们之一，
 * 亮度就会被拉低，比较就失去意义。
 */
function pageBandLuma(png, y0, y1, fx0 = 0.2, fx1 = 0.55) {
  return bandLuma(decodePng(png), y0, y1, fx0, fx1);
}

let appLog = '';

/**
 * 等 Chromium 自己报出 CDP 端口，而不是死等我们请求的那个端口。
 *
 * `--remote-debugging-port=9333` 只是**请求**。9333 被占（上一轮刚被杀掉的进程
 * 还在 TIME_WAIT、或别的实例没退干净）时，Chromium 会**自动换一个随机端口**
 * 继续跑，并在日志里写一行 `DevTools listening on ws://127.0.0.1:<port>/...`。
 * 死连 9333 的症状是 `connect ECONNREFUSED`，看起来像「应用没起来」，
 * 实际应用活得好好的 —— 实测连跑几轮验证时必现（A37 回归时踩到）。
 */
async function cdpEndpoint(fallback) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const m = appLog.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) return m[1];
    await new Promise(r => setTimeout(r, 150));
  }
  return fallback;
}

try {
  // ── [1] 起打包版，开 CDP ──
  console.log('\n[1] 启动打包版（CDP :9333）');
  // 先记下已存在的实例，后面要靠这个差集认准「自己起的那个窗口」
  const pidsBefore = processIds();
  child = spawn(EXE, EXTRA_ARGS, {
    cwd: origin,
    // ⚠️ OPC_GLASS=0：本脚本量的是**像素**（PrintWindow 里按钮落点区是不是
    // 我们的框架面）。窗口级玻璃开启后，那块的最终颜色 = 半透明框架面
    // 叠在**桌面**上，而桌面壁纸不在脚本控制范围内 —— 断言一个固定 RGB
    // 只会得到「今天壁纸是浅色所以过了」的假绿灯。
    // 玻璃这条链路由 `verify:window-glass` 单独验（断言开关、令牌、透明度）。
    env: childEnv({
      OPC_SAFE_GRAPHICS: '1',
      OPC_USER_DATA_DIR: profileDir,
      OPC_GLASS: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appLog = '';
  child.stdout.on('data', d => (appLog += String(d)));
  child.stderr.on('data', d => (appLog += String(d)));

  browser = await chromium.connectOverCDP(await cdpEndpoint('http://127.0.0.1:9333'), {
    timeout: 25000,
  });
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

  // ── [3] 首帧主题 + 覆盖层接管了系统标题栏 ──
  // bg=#ffffff 同时承担「系统是浅色」的前提断言：preference=system 时
  // 主进程按系统解析，只有系统浅色才会是 #ffffff。
  await SLEEP(800);
  const bootLine = themeLines(appLog)[0] ?? '';
  ok(/themeSource=system/.test(bootLine), '首帧把「跟随系统」同步给原生层', bootLine.trim());
  ok(/bg=#ffffff/.test(bootLine), '前提：系统当前是浅色', bootLine.trim());
  ok(/caption=self/.test(bootLine), '首帧就声明窗口按钮由页面自绘', bootLine.trim());

  console.log('\n[2] 窗口控件是否由页面自己画（A24 起 frame:false）');
  const geo = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-caption-button]')];
    return {
      caps: btns.length,
      capW: btns[0] ? Math.round(btns[0].getBoundingClientRect().width) : 0,
      capH: btns[0] ? Math.round(btns[0].getBoundingClientRect().height) : 0,
      capInBar: btns.every(b => !!b.closest('[data-titlebar]')),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      dpr: window.devicePixelRatio,
    };
  });
  console.log(
    `    按钮 ${geo.caps} 个（${geo.capW}×${geo.capH}），inner ${geo.innerWidth}x${geo.innerHeight}，outer ${geo.outerWidth}x${geo.outerHeight}`
  );
  // A24 把三个按钮从「系统画」改成「页面画」，所以 WCO 必须**未生效** ——
  // `visible === false` 且标题栏矩形全 0（按钮区被页面占走了）。它一旦
  // 生效，就说明 titleBarOverlay 又回来了：系统会重新画一块永远实色的
  // 按钮区，透明度的 100% 立刻失效（推导见 verify-window-glass 头部）。
  // ⚠️ 不能断言「navigator.windowControlsOverlay 不存在」：Electron 44 里
  //    这个对象恒挂（实测 typeof = 'object'），关掉时只是 visible=false。
  const wco = await page.evaluate(() => {
    const w = navigator.windowControlsOverlay;
    const r = w?.getTitlebarAreaRect?.();
    return {
      present: !!w,
      visible: w?.visible ?? null,
      emptyRect: !!r && r.width === 0 && r.height === 0,
    };
  });
  ok(
    wco.visible === false && wco.emptyRect,
    'Window Controls Overlay 未生效（按钮不再由系统画）',
    `present=${wco.present} visible=${wco.visible} emptyRect=${wco.emptyRect}`
  );
  ok(geo.caps === 3, '页面里有三个窗口按钮', String(geo.caps));
  // 尺寸用 ±2 容差，不用精确相等。本机窗口比 innerWidth 宽约 1%
  // （实测 1095/1081），标题条的高度被 DWM 缩放成 39.33px ——
  // 要求等于 40 会得到「按钮只有 39px」的假失败。视觉上差 0.7px 看不出来。
  ok(Math.abs(geo.capW - 46) <= 2, '按钮宽度 46px（Windows 规格）', String(geo.capW));
  ok(
    Math.abs(geo.capH - TITLE_BAR_HEIGHT) <= 2,
    `按钮高度 ≈ 标题条高度 ${TITLE_BAR_HEIGHT}px`,
    String(geo.capH)
  );
  ok(geo.capInBar, '三个按钮都在标题条内（同一个 DOM）');
  // 有系统标题栏时 outerHeight - innerHeight ≈ 40（caption 32 + 边框）；
  // 隐藏后只剩窗口边框。两个量级差 4 倍以上，不会被噪声骗。
  const nonClient = geo.outerHeight - geo.innerHeight;
  ok(
    nonClient <= 12,
    '窗口非客户区已收窄到边框级（32px 系统标题栏确实没了）',
    `outer-inner=${nonClient}`
  );

  // ── [4] 渲染进程那条标题条本身 ──
  console.log('\n[3] 渲染进程的标题条（TitleBar.tsx）');
  const bar = await page.evaluate(() => {
    const el = document.querySelector('[data-titlebar]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      y: Math.round(r.y),
      height: Math.round(r.height),
      width: Math.round(r.width),
      bg: cs.backgroundColor,
      appRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
      token: getComputedStyle(document.documentElement).getPropertyValue('--tc-titlebar-height').trim(),
    };
  });
  ok(!!bar, '页面里有 [data-titlebar]');
  ok(bar?.height === TITLE_BAR_HEIGHT, `标题条高度 = ${TITLE_BAR_HEIGHT}px`, bar ? `${bar.height}px` : 'n/a');
  ok(bar?.token === `${TITLE_BAR_HEIGHT}px`, '--tc-titlebar-height 令牌同值', bar?.token ?? 'n/a');
  ok(bar?.y === 0, '标题条位于窗口第 0 行（没有被系统标题栏压下去）', bar ? `y=${bar.y}` : 'n/a');
  ok(bar?.bg === 'rgb(236, 236, 236)', '标题条底色 = 导航条 rail #ececec（A94）', bar?.bg ?? 'n/a');
  ok(
    /drag/.test(bar?.appRegion ?? ''),
    '整条是窗口拖动区（-webkit-app-region: drag）',
    bar?.appRegion ?? 'n/a'
  );
  ok(
    bar != null && Math.abs(bar.width - geo.innerWidth) <= 1,
    '标题条横贯整窗（盖住了右上角三个按钮的落点）',
    bar ? `${bar.width} / ${geo.innerWidth}` : 'n/a'
  );

  // ── [5] PrintWindow：三个按钮到底画在什么底色上 ──
  console.log('\n[4] PrintWindow 抓整窗，量右上角控件区的底色');
  const win = freshWindow(pidsBefore);
  ok(
    win.freshCount === 1,
    '抓到的是本次启动的那个窗口（没量到别的实例）',
    `pid=${win.pid} hwnd=${win.hwnd}，本次新增 ${win.freshCount} 个`
  );
  const hwnd = win.hwnd;
  console.log(`    窗口句柄 = ${hwnd}`);
  const shotDir = mkdtempSync(path.join(tmpdir(), 'opc-native-shots-'));

  const shotLight = captureWindow(hwnd, path.join(shotDir, 'light.png'));
  /**
   * 位图的像素单位要自己推，不能想当然。
   *
   * `GetWindowRect` 的返回值随 PowerShell 进程的 DPI 感知状态而变：
   * 本机的 powershell.exe 是 DPI-**不感知**的，拿到的与位图都是逻辑像素
   * （实测 1095×693 对应 outer 1096×694，比例 ≈1.0）；换成 DPI 感知的宿主
   * 就会是物理像素（×1.5）。所以用「图宽 / outerWidth」现算比例，
   * 而不是写死 dpr 或写死 1 —— 写死哪一个都会在另一种宿主上量错位置。
   */
  const scale = shotLight.img.width / geo.outerWidth;
  const px = n => Math.round(n * scale);
  console.log(
    `    窗口图 ${shotLight.img.width}x${shotLight.img.height}（GetWindowRect ${shotLight.size}，` +
      `outer ${geo.outerWidth}x${geo.outerHeight}，像素比 ${scale.toFixed(3)}）`
  );

  /**
   * 控件区取样框。
   *
   * 横向框住右上角 180 DIP（三个按钮共 138 DIP，两侧各留一点余量），
   * 纵向只取标题条内 4~34 DIP。右边界往里收 16 DIP：窗口矩形包含不可见的
   * 拖拽边框，那几列是边框色，会把「众数色」带偏。
   */
  const captionBox = img => [
    Math.round(img.width - px(16 + 180)),
    px(4),
    Math.round(img.width - px(16)),
    px(TITLE_BAR_HEIGHT - 6),
  ];
  // 取样带只取「一定是纯色框架面」的那一段：避开左侧的应用标记与文字，
  // 也避开右侧的按钮字形。窗口图与页面截图必须取同一相对区间才可比。
  const winTopLuma = bandLuma(shotLight.img, px(4), px(TITLE_BAR_HEIGHT - 4), 0.25, 0.45);
  const pageTopLuma = pageBandLuma(await page.screenshot(), px(4), px(TITLE_BAR_HEIGHT - 4), 0.25, 0.45);
  console.log(`    窗口图顶部带亮度 = ${winTopLuma.toFixed(1)}，页面顶部带亮度 = ${pageTopLuma.toFixed(1)}`);
  ok(
    Math.abs(winTopLuma - pageTopLuma) <= 8,
    '窗口顶部 40px 就是页面那条标题条（不是系统画的另一条）',
    `${winTopLuma.toFixed(1)} vs ${pageTopLuma.toFixed(1)}`
  );

  const capLight = regionStats(shotLight.img, ...captionBox(shotLight.img));
  console.log(
    `    按钮落点区 平均色=${capLight.avg.join(',')} 众数色=${capLight.mode.join(',')} ` +
      `（系统画的字形不在 PrintWindow 里，实测占比 ${(capLight.inkRatio * 100).toFixed(2)}%）`
  );
  // 用平均色而不是众数色：众数色做了 4 位量化，245 会被归到 255 那一档。
  ok(
    maxDiff(capLight.avg, TITLEBAR.light) <= 6,
    '按钮落点区是标题条 rail #ececec（系统没在上面另画一条标题栏）',
    capLight.avg.join(',')
  );
  // ⚠️ 不要试图用 PrintWindow 验自绘按钮的**字形**：它走 GDI 合成，
  //    拿不到 GPU 图层里的 SVG（实测同一次运行里，标题条的 HTML 文字
  //    在图上，三个字形一个像素都没有 —— 0.00%）。字形改用 CDP
  //    page.screenshot 验，见下面 [4b]。
  ok(
    capLight.inkRatio < 0.02,
    'PrintWindow 这个来源本就不含字形（前提：按底色断言才不会被字形拉偏）',
    `${(capLight.inkRatio * 100).toFixed(2)}%`
  );

  // ── [4b] 字形用 page.screenshot 验（PrintWindow 拿不到 GPU 图层）──
  // A24 起三个按钮是页面元素，字形在 CDP 截图里必然可见 ——
  // 这条就是「自绘真的画出来了」的证据，PrintWindow 那条做不到这件事。
  const pageShot = decodePng(await page.screenshot());
  const pageScale = pageShot.width / geo.innerWidth;
  const capPage = regionStats(
    pageShot,
    Math.round((geo.innerWidth - 196) * pageScale),
    Math.round(4 * pageScale),
    Math.round((geo.innerWidth - 16) * pageScale),
    Math.round(34 * pageScale)
  );
  console.log(
    `    页面截图按钮落点区 平均色=${capPage.avg.join(',')} 字形占比=${(capPage.inkRatio * 100).toFixed(2)}%`
  );
  ok(
    capPage.inkRatio > 0.002 && capPage.inkRatio < 0.06,
    '三个按钮的字形在页面截图里（自绘生效），且占比合理',
    `${(capPage.inkRatio * 100).toFixed(2)}%`
  );

  // ── [6] 手动固定深色（系统仍是浅色 —— 割裂出现的场合）──
  console.log('\n[5] 在设置里固定「深色」（系统保持浅色）');
  await page.locator('button[title="设置"]').first().click();
  // 主题卡片用「锚点 or 旧文案」兜底：这两个脚本跑的是**已打包的应用**，
  // 包可能落后于源码（A37 改了设置页但没重新打包，最新包仍是 A36 的 p39，
  // 那一版还没有 `data-theme-option`，按钮文案是「固定深色」）。
  await page.waitForSelector(DARK_CARD, { timeout: 10000 });
  await page.locator(DARK_CARD).first().click();
  await SLEEP(900);

  const darkLine = themeLines(appLog).slice(-1)[0] ?? '';
  ok(/themeSource=dark/.test(darkLine), 'IPC 到达主进程，nativeTheme.themeSource = dark', darkLine.trim());
  ok(/bg=#121212/.test(darkLine), '窗口背景色同步为 #121212', darkLine.trim());
  ok(/caption=self/.test(darkLine), '深色下仍是页面自绘（不再有 overlay 配色）', darkLine.trim());

  const barDark = await page.evaluate(() => {
    const el = document.querySelector('[data-titlebar]');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  // A94：标题条走 rail 档，深色下是 #232323（rgb(35,35,35)），
  // 不再是 chrome 的 #1b1b1b。断言仍守「页面侧跟着系统主题一起变」。
  ok(barDark === 'rgb(35, 35, 35)', '标题条 CSS 也进入深色 #232323（rail 档）', barDark ?? 'n/a');

  const shotDark = captureWindow(hwnd, path.join(shotDir, 'dark.png'));
  const capDark = regionStats(shotDark.img, ...captionBox(shotDark.img));
  console.log(
    `    按钮落点区 平均色=${capDark.avg.join(',')} 众数色=${capDark.mode.join(',')}`
  );
  ok(
    maxDiff(capDark.avg, TITLEBAR.dark) <= 6,
    '按钮落点区跟着变深 = #232323（与应用一起，没有割裂）',
    capDark.avg.join(',')
  );
  const winTopLumaDark = bandLuma(shotDark.img, px(4), px(TITLE_BAR_HEIGHT - 4), 0.25, 0.45);
  const pageTopLumaDark = pageBandLuma(await page.screenshot(), px(4), px(TITLE_BAR_HEIGHT - 4), 0.25, 0.45);
  ok(
    winTopLumaDark < winTopLuma - 25 && pageTopLumaDark < pageTopLuma - 25,
    '窗口顶部与页面顶部一起变暗（两边是同一块）',
    `${winTopLuma.toFixed(0)}/${pageTopLuma.toFixed(0)} → ${winTopLumaDark.toFixed(0)}/${pageTopLumaDark.toFixed(0)}`
  );

  // ── [7] 改回浅色，应该亮回来 ──
  console.log('\n[6] 切回浅色');
  await page.locator(LIGHT_CARD).first().click();
  await SLEEP(900);
  const backLine = themeLines(appLog).slice(-1)[0] ?? '';
  ok(/themeSource=light/.test(backLine), '切回浅色也到达主进程', backLine.trim());
  ok(/caption=self/.test(backLine), '切回浅色后仍由页面自绘', backLine.trim());
  const shotBack = captureWindow(hwnd, path.join(shotDir, 'light-again.png'));
  const capBack = regionStats(shotBack.img, ...captionBox(shotBack.img));
  ok(
    maxDiff(capBack.avg, TITLEBAR.light) <= 6,
    '按钮落点区亮回来',
    capBack.avg.join(',')
  );

  // 排查「按钮落点区量出来对不对」时，把整窗截图留下：printWindow 的结果
  // 与 page.screenshot 在肉眼上差得很远（透明窗口/自绘字形/DPR），不看图
  // 只能猜。默认不进 git（.render-check 已 ignore）。
  if (process.env.OPC_DEBUG_CAPTURE) {
    copyFileSync(
      path.join(shotDir, 'light.png'),
      path.resolve('.render-check', 'native-light.png')
    );
    copyFileSync(
      path.join(shotDir, 'dark.png'),
      path.resolve('.render-check', 'native-dark.png')
    );
    console.log(`    [调试] 整窗截图已存到 .render-check/native-{light,dark}.png`);
  }

  rmSync(shotDir, { recursive: true, force: true });
} catch (e) {
  // 打包版「起不来」时，唯一有用的证据是它自己的 stdout/stderr。
  // 不打印的话，症状只剩一句 ECONNREFUSED（实测踩过：ELECTRON_RUN_AS_NODE
  // 被父进程带进来，应用以 Node 模式启动并秒退，日志里写着 bad option）。
  if (appLog.trim()) {
    console.log(`\n  应用输出：\n${appLog.trim().split('\n').slice(0, 12).join('\n')}\n`);
  }
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
