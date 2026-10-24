/**
 * 屏幕实拍一个 Electron 窗口 —— 用来回答「用户到底看到什么颜色」。
 *
 * ## 为什么不是 `page.screenshot()`，也不是 PrintWindow
 *
 * `page.screenshot()` 只截**页面视口**：系统画的三个窗口按钮（`titleBarOverlay`）
 * 在视口之外/之上，截不到。而 `PrintWindow(PW_RENDERFULLCONTENT)` 对**透明窗口**
 * 不可信 —— 窗口级玻璃（acrylic）的背板两次能量出不同的值，越量越糊涂。
 *
 * 只有屏幕实拍（GDI `CopyFromScreen`）拿到的是 DWM **合成之后**的最终像素，
 * 也就是用户眼睛看到的那个值。A23 修「窗口按钮底色与标题条不一致」时，
 * 就是靠它量出「标题条 237 / 按钮区 244，中间一条硬边」的。
 *
 * ## 抓窗口必须按 PID
 *
 * 本机容易残留上一轮启动的实例（`child.kill()` 只杀启动器，Electron 子进程会
 * 活下来）。按进程名取第一个窗口会抓到**旧窗口** —— 实测因此得到过
 * 「渲染进程报浅色、截图却是深色设置页」的自相矛盾，白查半天。
 *
 * ## 用法
 *
 *   node scripts/capture-window.mjs src                 # 源码态（electron .）
 *   node scripts/capture-window.mjs <某 exe 路径>        # 打包态
 *   node scripts/capture-window.mjs                    # 打包态，自动取最新 release-*
 *
 * 产物（都在 .render-check/ 下，已 gitignore）：
 *   capture-window.png         整窗
 *   capture-window-corner.png  右上角放大 4 倍（看接缝用）
 * 并打印一行沿标题条扫出来的像素（`ROW x:R,G,B ...`），可直接贴进结论里。
 *
 * ⚠️ 前提：窗口必须在前台且没被别的窗口/系统弹窗盖住 —— 被盖住时整块会
 * 被系统「调暗」（实测 245 会变成 135），数值就没有意义了。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.CAPTURE_PORT ?? 9339);
const OUT_DIR = path.resolve('.render-check');
const PS1 = path.join(OUT_DIR, 'capture-window.ps1');

/** 取打包版 exe：默认最新 release-*，避免拿旧包测出结论 */
function pickExe() {
  const arg = process.argv[2];
  if (arg === 'src') return null;
  if (arg && arg.endsWith('.exe')) return arg;
  return (
    readdirSync('.', { withFileTypes: true })
      .filter(d => d.isDirectory() && /^release/.test(d.name))
      .map(d => path.join(d.name, 'win-unpacked', 'OPC Agent.exe'))
      .filter(p => existsSync(p))
      .map(p => ({ p, t: statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.p ?? null
  );
}

/**
 * PowerShell 取样脚本。
 *
 * 关键两步：`SetProcessDPIAware()`（否则拿到的是逻辑像素，窗口内容会被裁掉，
 * 实测 1095×693 而不是 1643×1040）+ `CopyFromScreen`（合成后的真像素）。
 * 顺带把右上角放大 4 倍另存一份，肉眼看接缝比读数字直观。
 */
const PS_SCRIPT = `param([string]$Match = 'OPC Agent', [string]$Out = 'shot.png', [int]$ProcId = 0)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SC {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[SC]::SetProcessDPIAware() | Out-Null

$proc = $null
if ($ProcId -gt 0) {
  for ($i = 0; $i -lt 20; $i++) {
    $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { $proc = $p; break }
    Start-Sleep -Milliseconds 250
  }
}
if (-not $proc) {
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "*$Match*" })) { $proc = $p; break }
}
if (-not $proc) { Write-Output 'NOHWND'; exit 3 }

$h = $proc.MainWindowHandle
[SC]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700

$r = New-Object SC+RECT
[SC]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { Write-Output 'BADRECT'; exit 4 }

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

$cw = [Math]::Min(340, $w); $ch = [Math]::Min(56, $ht)
$crop = New-Object System.Drawing.Bitmap($cw, $ch)
$cg = [System.Drawing.Graphics]::FromImage($crop)
$cg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0,0,$cw,$ch)), (New-Object System.Drawing.Rectangle(($w-$cw),0,$cw,$ch)), [System.Drawing.GraphicsUnit]::Pixel)
$cg.Dispose()
$big = New-Object System.Drawing.Bitmap(($cw*4), ($ch*4))
$bg = [System.Drawing.Graphics]::FromImage($big)
$bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$bg.DrawImage($crop, 0, 0, ($cw*4), ($ch*4))
$bg.Dispose()
$big.Save(($Out -replace '\\.png$','-corner.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# 沿标题条扫一条横线：y=8 贴顶，避开按钮字形
$row = @()
for ($x = $w - 300; $x -lt $w; $x += 6) {
  if ($x -lt 0) { continue }
  $c = $bmp.GetPixel($x, 8)
  $row += ("{0}:{1},{2},{3}" -f $x, $c.R, $c.G, $c.B)
}
Write-Output ("ROW " + ($row -join ' '))

$bmp.Dispose(); $crop.Dispose(); $big.Dispose()
Write-Output "$w x $ht"
`;

const EXE = pickExe();
const out = path.join(OUT_DIR, 'capture-window.png');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(PS1, PS_SCRIPT, 'utf8');

console.log(`对象: ${EXE ?? '(源码态 electron .)'}`);

// 隔离：两个目录都要搬走，否则会写进真实用户数据（见 AGENTS.md「测试隔离」）
const env = {
  ...process.env,
  OPC_SAFE_GRAPHICS: '1',
  OPC_USER_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'opc-capture-')),
};
// 宿主 CLI 自带这两个变量，不 delete 会把 electron 当 node 跑（不开窗口）
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPC_GLASS;

const [cmd, args] = EXE
  ? [EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`]]
  : [
      path.resolve('node_modules/electron/dist/electron.exe'),
      ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`],
    ];

const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '';
child.stdout.on('data', d => (buf += String(d)));
child.stderr.on('data', d => (buf += String(d)));

/**
 * 等应用自己把 CDP 端口写出来。
 *
 * ⚠️ **别用 `--remote-debugging-port` 猜端口**：`server/index.ts` 启动时会重新申请
 * 一个空闲端口（日志 `[CDP] 已申请远程调试端口`），命令行给的值被丢弃，
 * 真实端口只在 `<userData>/DevToolsActivePort` 第一行。照旧写死 9339 的后果是
 * `ECONNREFUSED` —— 报错长得像「应用没起来」，实际应用窗口早就画好了，
 * 2026-10-24 打包冒烟时因此白查了一轮。
 */
async function waitDevToolsPort(dir, ms = 45000) {
  const f = path.join(dir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const n = Number(readFileSync(f, 'utf8').split('\n')[0].trim());
      if (Number.isInteger(n) && n > 0) return n;
    } catch {}
    await SLEEP(300);
  }
  return null;
}

let browser = null;
try {
  const cdpPort = (await waitDevToolsPort(env.OPC_USER_DATA_DIR)) ?? PORT;
  console.log(`CDP 端口: ${cdpPort}${cdpPort === PORT ? '（回落到命令行值）' : '（应用自行申请）'}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 40000 });
  const page = browser.contexts().flatMap(c => c.pages())[0];
  await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40000 });
  await SLEEP(1600);

  const state = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    glass: document.documentElement.dataset.opcGlass ?? '(无)',
    titlebar: getComputedStyle(document.querySelector('[data-titlebar]')).backgroundColor,
  }));
  console.log('渲染进程:', JSON.stringify(state));

  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PS1,
      '-Match',
      EXE ? 'OPC Agent' : 'electron',
      '-Out',
      out,
      '-ProcId',
      String(child.pid),
    ],
    { encoding: 'utf8' }
  );
  const stdout = (r.stdout ?? '').trim();
  if (stdout) console.log(stdout.split(/\r?\n/).map(l => '  ' + l).join('\n'));
  if ((r.stderr ?? '').trim()) console.error(r.stderr.trim());

  const themeLine = buf.split(/\r?\n/).filter(l => /\[Theme\]/.test(l)).slice(-1)[0];
  if (themeLine) console.log('日志:', themeLine.trim());
  console.log(`\n图: ${path.relative(process.cwd(), out)} / ${path.relative(process.cwd(), out.replace(/\.png$/, '-corner.png'))}`);
} finally {
  try {
    await browser?.close();
  } catch {}
  try {
    child.kill();
  } catch {}
  await SLEEP(400);
  // Electron 子进程不会随启动器一起退出，留着会占单实例锁 + 污染下一次取样。
  // ⚠️ 按 PID 连树杀，**不要** `taskkill /IM "OPC Agent.exe"` —— 那会把用户自己
  // 正在用的应用一起杀掉（同名）。
  if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
}
