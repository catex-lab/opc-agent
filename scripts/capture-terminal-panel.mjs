/**
 * 实拍「工作区 → 终端」标签在**真 Electron** 里跑起来的样子。
 *
 * 与 capture-browser-panel.mjs 同一个理由：终端这一版跑在主进程 spawn 的
 * shell 里，普通 Chrome（verify:render 用的那个）`window.opc` 整个不存在，
 * 只会显示「只在桌面端可用」—— **用那套 harness 一张图都拍不到**。
 *
 * 这个脚本起一个真应用实例，CDP 驱动渲染进程切到终端标签，敲两条真命令，
 * 再用 GDI `CopyFromScreen` 拍**合成之后的屏幕像素**。
 *
 * ## 用法
 *
 *   node scripts/capture-terminal-panel.mjs [cwd]
 *
 * 产物（.render-check/，已 gitignore）：
 *   terminal-panel.png   整窗实拍
 *   terminal-panel.json  断言结果
 *
 * 前提：窗口在前台且没被别的窗口盖住（被盖住时系统会调暗像素）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
// 宿主 CLI 自带的代理会让 playwright 连 127.0.0.1 的 CDP 时拿到 502
for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}
const OUT_DIR = path.resolve('.render-check');
const OUT_PNG = path.join(OUT_DIR, 'terminal-panel.png');
const OUT_JSON = path.join(OUT_DIR, 'terminal-panel.json');
const CWD = process.argv[2] || process.cwd();

const PS_SCRIPT = `param([string]$Match = 'electron', [string]$Out = 'shot.png', [int]$ProcId = 0)
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
$bmp.Dispose()
Write-Output "$w x $ht"
`;

const report = { ok: false };
const failures = [];
const check = (cond, label, extra = '') => {
  if (!cond) failures.push(extra ? `${label} —— ${extra}` : label);
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'capture-terminal-panel.ps1'), PS_SCRIPT, 'utf8');

const dataDir = mkdtempSync(path.join(tmpdir(), 'opc-shot-term-'));
const env = {
  ...process.env,
  OPC_SAFE_GRAPHICS: '1',
  OPC_USER_DATA_DIR: dataDir,
  OPC_DATA_DIR: dataDir,
  PORT: '0',
};
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPC_GLASS;
for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) delete env[key];

// 本机 EDR 注入未签名 DLL，GPU 子进程会 0xC0000005 带走主进程（见 A78 / A13）。
// 调试端口由应用自己开（P3），这里**不自己传** —— 与真正的 Agent 同一条发现路径。
const child = spawn(
  path.resolve('node_modules/electron/dist/electron.exe'),
  ['.', '--no-sandbox', '--disable-gpu-sandbox'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] }
);
let log = '';
child.stdout.on('data', d => (log += String(d)));
child.stderr.on('data', d => (log += String(d)));

async function waitForActivePort(userData, timeoutMs = 30_000) {
  const file = path.join(userData, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(file, 'utf8');
      const port = Number((text.split(/\r?\n/)[0] ?? '').trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* 还没写出来 */
    }
    await SLEEP(300);
  }
  return null;
}

function shoot(outPath) {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(OUT_DIR, 'capture-terminal-panel.ps1'),
      '-Match', 'electron', '-Out', outPath, '-ProcId', String(child.pid),
    ],
    { encoding: 'utf8' }
  );
  const stdout = (r.stdout ?? '').trim();
  if (stdout) console.log('  截图: ' + stdout.split(/\r?\n/).join(' '));
  if ((r.stderr ?? '').trim()) console.error(r.stderr.trim());
  check(/^\d+ x \d+$/.test(stdout.split(/\r?\n/).pop() ?? ''), `屏幕实拍成功（${path.basename(outPath)}）`, stdout);
}

let browser = null;
try {
  const port = await waitForActivePort(dataDir);
  check(!!port, '应用自己开了调试端口');
  if (!port) throw new Error('没读到 DevToolsActivePort\n' + log.slice(-1500));

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000 });
  const page = browser.contexts().flatMap(c => c.pages())[0];
  await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });

  const m = log.match(/地址:\s*http:\/\/127\.0\.0\.1:(\d+)/);
  if (!m) throw new Error('没拿到 API 端口\n' + log.slice(-1500));
  const api = `http://127.0.0.1:${m[1]}`;

  const created = await fetch(`${api}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '终端实拍', cwd: CWD }),
  });
  const { session } = await created.json();
  check(!!session?.id, '会话创建成功');
  if (!session?.id) throw new Error('会话没建出来');

  await page.goto(`${api}/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      localStorage.setItem('opc.workspace-open', '1');
      localStorage.setItem('opc.workspace-tab', 'terminal');
    } catch {
      /* 隐私模式 */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });
  try {
    await page.waitForSelector('[role="tablist"]', { timeout: 8000 });
  } catch {
    const toggle = page.getByRole('button', { name: /展开工作区|收起工作区/ });
    if (await toggle.count()) {
      const pressed = await toggle.first().getAttribute('aria-pressed');
      if (pressed === 'false') await toggle.first().click();
    }
    await page.waitForSelector('[role="tablist"]', { timeout: 15000 });
  }
  await page.getByRole('tab', { name: '终端' }).click();

  const input = page.getByLabel('终端输入');
  await input.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="终端输入"]');
    return !!el && !el.disabled;
  }, { timeout: 20_000 });

  // 敲两条真命令：一条证明输出到达，一条证明 cwd 对（git 在这个仓库里一定能跑）
  await input.fill('echo opc-terminal-ok');
  await input.press('Enter');
  await page.waitForFunction(
    () => (document.querySelector('pre')?.textContent ?? '').includes('opc-terminal-ok'),
    { timeout: 20_000 }
  );
  await input.fill('git log --oneline -3');
  await input.press('Enter');
  await page.waitForFunction(
    () => {
      const text = document.querySelector('pre')?.textContent ?? '';
      return /git log --oneline -3/.test(text) && /[0-9a-f]{7}\s/.test(text);
    },
    { timeout: 30_000 }
  );
  await SLEEP(800);

  report.shell = await page.evaluate(() => {
    const el = document.querySelector('[role="tablist"]');
    return el ? 'ready' : 'missing';
  });
  const pre = await page.locator('pre').last().textContent();
  report.outputTail = (pre ?? '').slice(-400);
  check(/管道版/.test(pre ?? ''), '状态条标注了「管道版 · 无 TTY」');
  check((pre ?? '').includes('opc-terminal-ok'), 'echo 输出到达界面');

  shoot(OUT_PNG);
  report.ok = failures.length === 0;
} catch (e) {
  report.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  failures.push(`实拍异常：${report.error.split('\n')[0]}`);
  console.error('实拍失败:', report.error);
  if (log.trim()) console.error('—— 子进程日志尾部 ——\n' + log.slice(-2500));
} finally {
  try {
    await browser?.close();
  } catch {
    /* 已断 */
  }
  try {
    child.kill();
  } catch {
    /* 已退 */
  }
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 上进程可能还持着锁 */
  }
}

console.log(
  failures.length
    ? `\n✗ 未通过：\n` + failures.map(f => '  · ' + f).join('\n')
    : `\n✓ 实拍完成：${OUT_PNG}`
);
process.exit(failures.length ? 1 : 0);
