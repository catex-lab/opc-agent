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
 *   browser-panel.png        整窗实拍（页面刚加载完）
 *   browser-panel-agent.png  Agent 通过第二条独立 CDP 连接点了一下之后的实拍
 *   browser-panel.json       断言结果（URL 是否真的加载了、视图是否可见、
 *                            Agent 的点击是否作用在同一个页面上）
 *
 * 前提：窗口在前台且没被别的窗口盖住（被盖住时系统会调暗像素，数值/观感都不对）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
// 宿主 CLI 自带的代理会让 playwright 连 127.0.0.1 的 CDP 时拿到 502
// （请求被转交给代理）。在**本进程**里就要摘掉，光删子进程 env 不够。
for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}
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

/**
 * 探针页：做得像个「Agent 刚改完的页面」，观感上才看得出预览有没有用。
 *
 * 带一个计数器按钮：P3 起还要用它证明「Agent 点的就是用户看的这一份」
 * —— 第二条独立 CDP 连接点一下，计数器从 0 变 1，同一块屏幕截图就是证据。
 */
const PROBE_HTML = `<!doctype html><meta charset="utf-8">
<title>Agent 改出来的页面</title>
<body style="margin:0;background:#0F6E56;color:#fff;font:14px/1.6 system-ui,sans-serif">
  <div style="padding:24px 22px">
    <div style="display:flex;align-items:center;gap:8px">
      <div style="font-size:18px;font-weight:600">登录页改版 · 本地预览</div>
      <div id="n" style="margin-left:auto;padding:2px 9px;border-radius:999px;
        background:rgba(255,255,255,.18);font-size:12px">Agent 点击 0 次</div>
    </div>
    <div style="opacity:.75;margin-top:4px;font-size:12px">npm run dev → http://localhost:5173</div>
    <div style="margin-top:18px;display:flex;gap:10px">
      <div style="flex:1;height:34px;border-radius:8px;background:rgba(255,255,255,.16)"></div>
      <div style="width:88px;height:34px;border-radius:8px;background:#fff;color:#0F6E56;
                  display:flex;align-items:center;justify-content:center;font-weight:600">登录</div>
    </div>
    <button id="b" style="margin-top:16px;padding:7px 16px;border:0;border-radius:8px;
      background:rgba(255,255,255,.22);color:#fff;font-size:12px;cursor:pointer">Agent 点我</button>
    <div style="margin-top:14px;height:96px;border-radius:10px;background:rgba(255,255,255,.10)"></div>
  </div>
  <script>window.__n = 0;
    document.getElementById('b').addEventListener('click', () => {
      window.__n++;
      document.getElementById('n').textContent = 'Agent 点击 ' + window.__n + ' 次';
    });</script>
</body>`;

/**
 * 等 Chromium 把真实调试端口写进 userData 下的 DevToolsActivePort。
 *
 * P3 起端口由应用自己开（`--remote-debugging-port=0` → Chromium 随机选）。
 * 这里刻意**不自己传端口**：脚本和真正的 Agent 走同一条发现路径，
 * 顺手把「端点发现」这条路也验了。
 */
async function waitForActivePort(userData, timeoutMs = 30_000) {
  const file = path.join(userData, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(file, 'utf8');
      const [p, ws] = text.split(/\r?\n/);
      const port = Number((p ?? '').trim());
      if (Number.isInteger(port) && port > 0) {
        return { port, wsPath: (ws ?? '').trim() || '/devtools/browser/' };
      }
    } catch {
      /* 还没写出来 */
    }
    await SLEEP(300);
  }
  return null;
}

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
//
// 注意**不再**自己传 `--remote-debugging-port`：P3 起端口由应用自己开
// （Chromium 用 =0 随机选，写进 userData 下的 DevToolsActivePort）。
// 这里刻意走那条发现路径 —— 脚本和真正的 Agent 用同一把钥匙进门，
// 顺手也就把「端点发现」这条路验了。
const child = spawn(
  path.resolve('node_modules/electron/dist/electron.exe'),
  ['.', '--no-sandbox', '--disable-gpu-sandbox'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] }
);

let log = '';
child.stdout.on('data', d => (log += String(d)));
child.stderr.on('data', d => (log += String(d)));

/** GDI 屏幕实拍（合成后的像素；原生视图不在网页视口里，page.screenshot 拍不到）。 */
function shoot(outPath) {
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
      outPath,
      '-ProcId',
      String(child.pid),
    ],
    { encoding: 'utf8' }
  );
  const stdout = (r.stdout ?? '').trim();
  if (stdout) console.log('  截图: ' + stdout.split(/\r?\n/).join(' '));
  if ((r.stderr ?? '').trim()) console.error(r.stderr.trim());
  const size = stdout.split(/\r?\n/).pop() ?? '';
  check(/^\d+ x \d+$/.test(size), `屏幕实拍成功（${path.basename(outPath)}）`, stdout);
  return size;
}

let browser = null;
let agent = null;
let page = null;
try {
  // 端口由 Chromium 分配并写进 userData —— 和 Agent 的发现路径完全一致
  const activePort = await waitForActivePort(dataDir);
  check(!!activePort, '应用自己开了调试端口（DevToolsActivePort）');
  if (!activePort) throw new Error('没读到 DevToolsActivePort\n' + log.slice(-1500));
  report.cdpPort = activePort.port;

  await waitForDevTools(activePort.port);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${activePort.port}`, { timeout: 40_000 });
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

  // 状态条上的 CDP 指示（P3：人机同屏开着没有，要让用户看见）
  report.cdpLabel = await page.evaluate(() => {
    const el = document.querySelector('[data-browser-viewport]')
      ?.parentElement?.querySelector('span[title*="远程调试"]');
    return el?.textContent ?? '(没找到 CDP 状态)';
  });
  check(/^CDP :\d+$/.test(report.cdpLabel ?? ''), '状态条显示 CDP 端口', String(report.cdpLabel));

  shoot(OUT_PNG);

  /* ── P3：第二条独立连接 = Agent。它只从 cdp.json 发现端点 ── */
  agent = await chromium.connectOverCDP(`http://127.0.0.1:${activePort.port}`, { timeout: 20_000 });
  const agentPages = agent.contexts().flatMap(c => c.pages());
  const probePage = agentPages.find(p => p.url() === probeUrl);
  check(!!probePage, 'Agent 连接能看到同一个页面 target');
  if (probePage) {
    const before = await probePage.textContent('#n');
    await probePage.click('#b');
    await probePage.waitForFunction(
      prev => document.getElementById('n')?.textContent !== prev,
      before ?? '',
      { timeout: 5000 }
    );
    const after = await probePage.textContent('#n');
    check(after !== before, 'Agent 的点击作用在用户眼前那个页面上', `${before} → ${after}`);
    report.agentClick = { before, after };

    await SLEEP(600);
    const agentPng = path.join(OUT_DIR, 'browser-panel-agent.png');
    shoot(agentPng);
    report.agentShot = agentPng;
  }

  report.ok = failures.length === 0;
} catch (e) {
  report.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  failures.push(`实拍异常：${report.error.split('\n')[0]}`);
  console.error('实拍失败:', report.error);
  // 连不上 CDP 的原因几乎都在子进程的日志里（GPU 崩了 / 端口没开 / 被单实例锁挡了）
  if (log.trim()) console.error('—— 子进程日志尾部 ——\n' + log.slice(-3000));
} finally {
  for (const b of [browser, agent]) {
    try {
      await b?.close();
    } catch {
      /* 已断 */
    }
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
    : `\n✓ 实拍完成：${OUT_PNG}${report.agentShot ? ` + ${report.agentShot}` : ''}`
);
process.exit(failures.length ? 1 : 0);
