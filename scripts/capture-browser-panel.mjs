/**
 * 实拍「工作区 → 浏览器」标签在**真 Electron** 里渲染出来的样子。
 *
 * ## 为什么必须另写一个脚本
 *
 * `verify:render` 跑在普通 Chrome 里，那里 `window.opc` 整个不存在 —— 浏览器
 * 标签只会显示「浏览器预览只在桌面端可用」。也就是说 **P2 的效果用那套 harness
 * 一张图都拍不到**。而 `verify:a78-browser` 的真实冒烟只证明「视图加载了探针页」
 * （读回背景色与 `typeof require`），没有一张人能看的图。
 *
 * 这个脚本把两件事接起来：起一个真 Electron（带 CDP），用 playwright 驱动
 * 渲染进程建会话 → 开面板 → 切到浏览器标签 → 加载一个本地 http 页面，
 * 最后用 GDI `CopyFromScreen` 拍**合成之后的屏幕像素**（原生视图不在网页
 * 视口里，`page.screenshot()` 拍不到它，这点与 capture-window.mjs 同坑）。
 *
 * ## 用法
 *
 *   node scripts/capture-browser-panel.mjs [cwd]
 *
 * 产物（.render-check/，已 gitignore）：
 *   browser-panel.png      整窗实拍
 *   browser-panel.json     断言结果（URL 是否真的加载了、视图是否可见）
 *
 * 前提：窗口在前台且没被别的窗口盖住（被盖住时系统会调暗像素，数值/观感都不对）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
// 宿主 CLI 自带的代理会让 playwright 连 127.0.0.1 的 CDP 时拿到 502
// （请求被转交给代理）。在**本进程**里就要摘掉，光删子进程 env 不够。
for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}
const PORT = Number(process.env.CAPTURE_PORT ?? 9341);
const OUT_DIR = path.resolve('.render-check');
const OUT_PNG = path.join(OUT_DIR, 'browser-panel.png');
const OUT_JSON = path.join(OUT_DIR, 'browser-panel.json');
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

/** 探针页：做得像个「Agent 刚改完的页面」，观感上才看得出预览有没有用。 */
const PROBE_HTML = `<!doctype html><meta charset="utf-8">
<title>Agent 改出来的页面</title>
<body style="margin:0;background:#0F6E56;color:#fff;font:14px/1.6 system-ui,sans-serif">
  <div style="padding:28px 26px">
    <div style="font-size:20px;font-weight:600">登录页改版 · 本地预览</div>
    <div style="opacity:.75;margin-top:6px">npm run dev → http://localhost:5173</div>
    <div style="margin-top:22px;display:flex;gap:10px">
      <div style="flex:1;height:38px;border-radius:8px;background:rgba(255,255,255,.16)"></div>
      <div style="width:96px;height:38px;border-radius:8px;background:#fff;color:#0F6E56;
                  display:flex;align-items:center;justify-content:center;font-weight:600">登录</div>
    </div>
    <div style="margin-top:14px;height:120px;border-radius:10px;background:rgba(255,255,255,.10)"></div>
  </div>
</body>`;

/**
 * 等 DevTools 端口真的开始监听。
 *
 * `connectOverCDP` **不会重试**：应用还没起来时连上去就是 ECONNREFUSED，
 * 直接抛（实测）。而 Electron 要到窗口建好之后才开这个端口，中间有几秒空档。
 */
function waitForDevTools(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = get(
        { host: '127.0.0.1', port, path: '/json/version', timeout: 1000 },
        res => {
          res.resume();
          resolve();
        }
      );
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`等 DevTools 端口 ${port} 超时`));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

const report = { ok: false };
const failures = [];
const check = (cond, label, extra = '') => {
  if (!cond) failures.push(extra ? `${label} —— ${extra}` : label);
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'capture-browser-panel.ps1'), PS_SCRIPT, 'utf8');

// 本地 http 服务：探针页与真实预览走同一条加载路径（file: 被白名单拦，测不到）
const probe = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PROBE_HTML);
});
await new Promise(r => probe.listen(0, '127.0.0.1', r));
const probePort = probe.address().port;
const probeUrl = `http://127.0.0.1:${probePort}/`;

const dataDir = mkdtempSync(path.join(tmpdir(), 'opc-shot-browser-'));
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
// 宿主 CLI 自带一套指向 127.0.0.1 的代理。playwright 的 connectOverCDP 会把
// 对 127.0.0.1:CDP 的请求也交给它，实测直接 502（「不像 DevTools 服务」）。
// 这不是 Electron 的问题，是宿主环境变量漏进了子进程，和上面三个同类。
for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete env[key];
}

// 本机 EDR 注入未签名 DLL，GPU 子进程会 0xC0000005 带走主进程（见 A78 / A13）
const child = spawn(
  path.resolve('node_modules/electron/dist/electron.exe'),
  ['.', '--no-sandbox', '--disable-gpu-sandbox', `--remote-debugging-port=${PORT}`],
  { env, stdio: ['ignore', 'pipe', 'pipe'] }
);

let log = '';
child.stdout.on('data', d => (log += String(d)));
child.stderr.on('data', d => (log += String(d)));

let browser = null;
let page = null;
try {
  await waitForDevTools(PORT);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 40_000 });
  page = browser.contexts().flatMap(c => c.pages())[0];
  await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });

  // 真实端口只有监听后才拿得到（PORT=0 由系统分配）
  const m = log.match(/地址:\s*http:\/\/127\.0\.0\.1:(\d+)/);
  if (!m) throw new Error('没从启动日志里拿到 API 端口\n' + log.slice(-1500));
  const apiPort = m[1];
  const api = `http://127.0.0.1:${apiPort}`;
  report.apiPort = apiPort;

  // 建一个绑了工作目录的会话（面板只在 direct 会话且有 cwd 时渲染）
  const created = await fetch(`${api}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '浏览器预览实拍', cwd: CWD }),
  });
  const { session } = await created.json();
  report.sessionId = session?.id ?? null;
  check(!!session?.id, '会话创建成功');

  await page.goto(`${api}/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
  // 面板展开态存在 localStorage，先写再刷新（render-check 的夹具也是这个口径）
  await page.evaluate(() => {
    try {
      localStorage.setItem('opc.workspace-open', 'true');
    } catch {
      /* 隐私模式：刷新后会回到默认收起 */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });
  await SLEEP(1200);

  // 面板没开就点一下栏头开关（localStorage 可能没写进去）
  const toggle = page.getByRole('button', { name: /展开工作区|收起工作区/ });
  if (await toggle.count()) {
    const pressed = await toggle.first().getAttribute('aria-pressed');
    if (pressed === 'false') await toggle.first().click();
  }
  const panel = page.getByRole('tablist', { name: '工作区标签' });
  await panel.waitFor({ timeout: 15_000 });
  check(true, '工作区面板已渲染');

  // 文件标签先在：证明面板本身是活的，再切浏览器
  await page.getByRole('tab', { name: '文件' }).click();
  await SLEEP(600);

  await page.getByRole('tab', { name: '浏览器' }).click();
  const address = page.getByPlaceholder('http://localhost:5173');
  await address.waitFor({ timeout: 15_000 });
  await address.fill(probeUrl);
  await address.press('Enter');

  // 等导航状态真的推回来（不是等一个固定 sleep 猜）
  await page.waitForFunction(
    expected => {
      const el = document.querySelector('[data-browser-viewport]');
      return !!el && el.getBoundingClientRect().width > 100;
    },
    probeUrl,
    { timeout: 15_000 }
  );
  await page.waitForFunction(
    () => {
      const input = document.querySelector('input[aria-label="预览地址"]');
      return !!input && input.value.startsWith('http://127.0.0.1:');
    },
    { timeout: 20_000 }
  );
  await SLEEP(1800);

  report.viewportWidth = await page.evaluate(() => {
    const el = document.querySelector('[data-browser-viewport]');
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  check(report.viewportWidth > 100, '视口容器有实际尺寸', String(report.viewportWidth));

  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(OUT_DIR, 'capture-browser-panel.ps1'),
      '-Match',
      'electron',
      '-Out',
      OUT_PNG,
      '-ProcId',
      String(child.pid),
    ],
    { encoding: 'utf8' }
  );
  const stdout = (r.stdout ?? '').trim();
  if (stdout) console.log('  截图: ' + stdout.split(/\r?\n/).join(' '));
  if ((r.stderr ?? '').trim()) console.error(r.stderr.trim());
  check(/^\d+ x \d+$/.test(stdout.split(/\r?\n/).pop() ?? ''), '屏幕实拍成功', stdout);

  report.ok = failures.length === 0;
} catch (e) {
  report.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  failures.push(`实拍异常：${report.error.split('\n')[0]}`);
  console.error('实拍失败:', report.error);
  // 连不上 CDP 的原因几乎都在子进程的日志里（GPU 崩了 / 端口没开 / 被单实例锁挡了）
  if (log.trim()) console.error('—— 子进程日志尾部 ——\n' + log.slice(-3000));
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
  probe.close();
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
