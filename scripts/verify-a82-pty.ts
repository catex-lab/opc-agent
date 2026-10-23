/**
 * A82：PTY 版终端验证。
 *
 * 分两组：
 *   [A] 源码契约 —— 打包配置与降级路径不能只是「记得这么写过」
 *   [B] 真实 Electron 冒烟 —— 重点是一件只有 PTY 做得到的事：
 *       **交互式程序**。`python` 进 REPL、敲 `print(6*7)` 出 `42`。
 *       管道版下 python 会当场退出（拿不到 TTY），所以这一步同时是
 *       「PTY 真的在工作」与「没有偷偷退化到管道版」的双重证据。
 *
 * 与 verify-a80-terminal 的分工：a80 守管道版的边界（cwd / 单实例 / 生命周期），
 * 本脚本守 PTY 通道与它的降级路径。两者都跑，因为两条通道都还在产品里。
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const results: { pass: boolean; name: string; extra?: string }[] = [];
const ok = (cond: boolean, name: string, extra = '') => {
  results.push({ pass: !!cond, name, extra });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const SLEEP = (ms: number) => new Promise(r => setTimeout(r, ms));
const root = process.cwd();

/** 带超时的 fetch。API 卡住时不能把整个冒烟无限期拖住（实测挂住过）。 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return (await res.json()) as T;
}

/* ── [A] 源码契约 ─────────────────────────────────────────────────────── */

function sourceContracts() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  ok(!!pkg.dependencies?.['node-pty'], '契约：node-pty 在 dependencies（否则不会进包）', pkg.dependencies?.['node-pty'] ?? '缺失');
  ok(!pkg.devDependencies?.['node-pty'], '契约：node-pty 不在 devDependencies（两头放会让打包口径分裂）');
  ok(!!pkg.devDependencies?.['@xterm/xterm'], '契约：@xterm/xterm 在 devDependencies（前端库，vite 打包）');
  ok(pkg.scripts?.postinstall === 'patch-package', '契约：postinstall 会重放补丁（否则重装就丢）', pkg.scripts?.postinstall);

  const yml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  ok(/asarUnpack:[\s\S]*node-pty/.test(yml), '契约：asarUnpack 含 node-pty（.node 与要 spawn 的 exe 不能留在 asar 里）');
  ok(/nodeGypRebuild:\s*false/.test(yml), '契约：nodeGypRebuild 仍为 false（用预编译 N-API 件，不开原生重建）');
  ok(/node-pty/.test(yml) && !/nodeGypRebuild:\s*true/.test(yml), '契约：没有为了 node-pty 打开原生重建');

  ok(existsSync(path.join(root, 'patches', 'node-pty+1.1.0.patch')), '契约：Spectre 补丁文件在（否则本机 node-gyp 构建必炸）');

  const term = readFileSync(path.join(root, 'electron', 'terminal.ts'), 'utf8');
  ok(term.includes("require('node-pty')"), '契约：主进程懒加载 node-pty');
  ok(term.includes('startPty') && term.includes('startPipe'), '契约：PTY 与管道两条通道都在');
  ok(/加载失败，降级为管道版/.test(term), '契约：加载失败有降级路径且留了日志');
  ok(/pty\.resize|\.resize\(/.test(term), '契约：PTY 尺寸可变（vim 状态栏 / top 表格靠这个）');
  ok(/state\.pty/.test(term) || /pty:/.test(term), '契约：状态里带 pty 标志（界面据此说话，不靠注释）');

  const ui = readFileSync(path.join(root, 'src', 'components', 'WorkspaceTerminal.tsx'), 'utf8');
  ok(ui.includes("@xterm/xterm"), '契约：PTY 通道用 xterm.js 渲染');
  ok(ui.includes('FitAddon'), '契约：xterm 挂了 FitAddon（尺寸自适应）');
  ok(/state\.pty \?/.test(ui), '契约：界面按 pty 标志分流');
  ok(ui.includes('PTY · 交互式可用') && ui.includes('管道版 · 无 TTY'), '契约：两种通道都有如实标注');
  ok(/term\.onData\(data => sendKeys\(data\)\)/.test(ui), '契约：xterm 键流走 sendKeys（原始键，不是一整行）');
  ok(/state\.pty \? \([\s\S]*data-terminal-host/.test(ui), '契约：PTY 模式下不渲染管道版输入行（摆一个过不去方向键的输入框就是假控件）');

  const preload = readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
  ok(/terminalResize/.test(preload), '契约：preload 暴露 terminalResize');
}

/* ── [B] 真 Electron 冒烟 ─────────────────────────────────────────────── */

async function waitForActivePort(userData: string, timeoutMs = 30_000) {
  const file = path.join(userData, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0].trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* 还没写出来 */
    }
    await SLEEP(300);
  }
  return null;
}

function launchApp() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'opc-pty-smoke-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPC_SAFE_GRAPHICS: '1',
    OPC_USER_DATA_DIR: dataDir,
    OPC_DATA_DIR: dataDir,
    PORT: '0',
  };
  for (const key of [
    'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'OPC_GLASS',
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
  ]) {
    delete env[key];
  }
  const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), ['.', '--no-sandbox', '--disable-gpu-sandbox'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += String(d)));
  child.stderr.on('data', d => (log += String(d)));
  return { child, dataDir, log: () => log };
}

/** 读 xterm 屏幕上的每一行文本（xterm 已经处理好转义，拿到的是干净文字）。 */
async function readTerminalRows(page: Page): Promise<string[]> {
  return page.$$eval('.xterm-rows > div', els =>
    els.map(e => (e.textContent ?? '').replace(/\s+$/, ''))
  );
}

async function runSmoke() {
  // 两个构建都要跑，且**失败时必须把输出带出来**：stdio:'ignore' 会让
  // 「build 失败 exit=1」成为唯一信息，而下一次复现可能又是绿的（实测就是
  // 瞬态失败）—— 没有输出就永远查不出是哪一下。
  const build = spawnSync('npm', ['run', '-s', 'build'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: true,
  });
  if (build.status !== 0) {
    ok(false, '冒烟：build 失败', `${(build.stdout ?? '')}\n${(build.stderr ?? '')}`.slice(-1200));
    return;
  }
  const buildElectron = spawnSync('npm', ['run', '-s', 'build:electron'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: true,
  });
  if (buildElectron.status !== 0) {
    ok(false, '冒烟：build:electron 失败', `${(buildElectron.stdout ?? '')}\n${(buildElectron.stderr ?? '')}`.slice(-1200));
    return;
  }

  const fixture = mkdtempSync(path.join(tmpdir(), 'opc-pty-fixture-'));
  writeFileSync(path.join(fixture, 'readme.txt'), 'fixture');

  const { child, dataDir, log } = launchApp();
  let harness: Browser | null = null;

  const watchdog = setTimeout(() => {
    try { child.kill(); } catch { /* 已退 */ }
    console.error('冒烟看门狗超时（240s）—— 应用或 CDP 连接卡住了');
    console.error(log().slice(-2500));
    process.exit(1);
  }, 240_000);

  try {
    console.log('  · 等 DevToolsActivePort…');
    const port = await waitForActivePort(dataDir);
    ok(!!port, '冒烟：CDP 端口真的开了');
    if (!port) throw new Error('没拿到调试端口\n' + log().slice(-1500));

    console.log('  · 连接并建会话…');
    harness = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 45_000 });
    const appPage = harness.contexts().flatMap(c => c.pages())[0];
    if (!appPage) throw new Error('没找到应用窗口的 page');
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });

    const m = log().match(/地址:\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (!m) throw new Error('没从启动日志拿到 API 端口\n' + log().slice(-1500));
    const api = `http://127.0.0.1:${m[1]}`;

    const { session } = await fetchJson<{ session?: { id?: string } }>(`${api}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'PTY 冒烟', cwd: fixture }),
    });
    ok(!!session?.id, '冒烟：会话创建成功');
    if (!session?.id) throw new Error('会话没建出来');

    await appPage.goto(`${api}/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
    await appPage.evaluate(() => {
      try { localStorage.setItem('opc.workspace-open', 'true'); } catch { /* 隐私模式 */ }
    });
    await appPage.reload({ waitUntil: 'domcontentloaded' });
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });
    // 面板渲染要等两件事：localStorage 读回来、会话列表 fetch 完（currentSession
    // 有了面板才会挂）。所以先等 tablist，等不到再点一次栏头开关 ——
    // 不猜时序，两种顺序都要能工作（a81 实测过这个兜底是必要的）。
    try {
      await appPage.waitForSelector('[role="tablist"]', { timeout: 10_000 });
    } catch {
      const toggle = appPage.getByRole('button', { name: /展开工作区|收起工作区/ });
      if (await toggle.count()) {
        const pressed = await toggle.first().getAttribute('aria-pressed');
        if (pressed === 'false') await toggle.first().click();
      }
      await appPage.waitForSelector('[role="tablist"]', { timeout: 25_000 });
    }

    console.log('  · 切终端标签…');
    await appPage.getByRole('tab', { name: '终端' }).click();

    // xterm 挂上来了（PTY 通道的 UI 标志）
    await appPage.waitForSelector('[data-terminal-host] .xterm', { timeout: 20_000 });
    ok(true, '冒烟：xterm 已挂载（PTY 通道的界面）');

    // 通道身份：node-pty 加载成功 + ConPTY spawn 成功才会是 true。
    // 这一条同时是「没有悄悄退化到管道版」的证据。
    const st = await appPage.evaluate(async () => {
      const opc = (window as unknown as { opc?: { terminalState?: () => Promise<unknown> } }).opc;
      return opc?.terminalState ? await opc.terminalState() : null;
    });
    ok((st as { pty?: boolean } | null)?.pty === true, '冒烟：当前是 PTY 通道（node-pty 真的加载并 spawn 成功）', JSON.stringify(st));
    const cols = (st as { cols?: number } | null)?.cols ?? 0;
    ok(cols > 0, '冒烟：初始尺寸已上报', `cols=${cols}`);

    // 聚焦 xterm（它内部是一个隐藏 textarea），然后用真键盘事件输入
    await appPage.locator('[data-terminal-host] .xterm').click();
    await appPage.keyboard.type('echo PTY-A82-OK');
    await appPage.keyboard.press('Enter');
    await appPage.waitForFunction(
      () => Array.from(document.querySelectorAll('.xterm-rows > div'))
        .some(d => (d.textContent ?? '').includes('PTY-A82-OK')),
      { timeout: 15_000 }
    );
    ok(true, '冒烟：echo 输出到达屏幕');

    /* ── 只有 PTY 做得到的事：交互式程序 ── */
    console.log('  · 跑交互式程序（python REPL）…');
    await appPage.keyboard.type('python');
    await appPage.keyboard.press('Enter');
    await appPage.waitForFunction(
      () => Array.from(document.querySelectorAll('.xterm-rows > div'))
        .some(d => (d.textContent ?? '').includes('>>>')),
      { timeout: 25_000 }
    );
    ok(true, '冒烟：python REPL 起来了（>>> 提示符出现）');

    await appPage.keyboard.type('print(6*7)');
    await appPage.keyboard.press('Enter');
    await appPage.waitForFunction(
      () => Array.from(document.querySelectorAll('.xterm-rows > div'))
        .some(d => /^\s*42\s*$/.test(d.textContent ?? '')),
      { timeout: 15_000 }
    );
    ok(true, '冒烟：REPL 求值成功（42 单独一行）');

    await appPage.keyboard.type('exit()');
    await appPage.keyboard.press('Enter');
    // REPL 退没退不能靠猜：敲一条 echo，只有在 **cmd** 下才会原样打印出来
    //（还在 python 里就是 NameError）。少了这一步，后面那句 `exit` 会喂给
    // Python，shell 永远不退 —— 实测就是这么卡住的。
    await appPage.keyboard.type('echo BACK-AT-CMD');
    await appPage.keyboard.press('Enter');
    await appPage.waitForFunction(
      () => Array.from(document.querySelectorAll('.xterm-rows > div'))
        .some(d => (d.textContent ?? '').includes('BACK-AT-CMD')),
      { timeout: 20_000 }
    );
    ok(true, '冒烟：REPL 退出后回到 cmd（交互式程序完整闭环）');

    /* ── 尺寸联动：改视口高度，行数要跟着变 ──
     *
     * 用 Emulation.setDeviceMetricsOverride 而不是 Browser.setWindowBounds：
     * 后者在本机 Chromium 上不存在（实测 Protocol error）。前者改的是页面
     * 视口，一样会让终端容器变高 → ResizeObserver → fit → IPC → pty.resize，
     * 正是要验的那条链。
     */
    console.log('  · 改视口高度，验行数联动…');
    const readRows = () =>
      appPage.evaluate(async () => {
        const opc = (window as unknown as { opc?: { terminalState?: () => Promise<{ rows?: number }> } }).opc;
        return (await opc?.terminalState?.())?.rows ?? 0;
      });
    const before = await readRows();
    const pcdp = await appPage.context().newCDPSession(appPage);
    await pcdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    let after = before;
    for (let i = 0; i < 25; i++) {
      await SLEEP(400);
      after = await readRows();
      if (after !== before) break;
    }
    ok(after !== before && after > 0, '冒烟：视口变高后行数跟着变（尺寸链路通）', `${before} → ${after}`);
    await pcdp.send('Emulation.clearDeviceMetricsOverride');

    /* ── 退出：状态如实，且不自动重启 ── */
    console.log('  · 退出 shell…');
    // 显式 focus xterm 的隐藏 textarea：点击在视口被 override 改动后不一定
    // 落在终端上，而焦点错了键盘事件就全部石沉大海（实测过一次）。
    await appPage.focus('.xterm-helper-textarea');
    const focusOk = await appPage.evaluate(
      () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false
    );
    ok(focusOk, '冒烟：xterm 的输入框拿到焦点（否则按键到不了 shell）');

    // 无条件把退出前后的现场打出来。只看断言名的话，「按键没到 shell」和
    // 「shell 退了但状态没更新」长得一模一样，必须有屏幕和状态两份证据。
    const dumpTerminal = async (label: string) => {
      const rows = await readTerminalRows(appPage);
      const st = await appPage.evaluate(async () => {
        const opc = (window as unknown as { opc?: { terminalState?: () => Promise<unknown> } }).opc;
        return await opc?.terminalState?.();
      });
      console.log(`  · [${label}] 状态=${JSON.stringify(st)}`);
      console.log(`  · [${label}] 屏幕尾部:\n${rows.slice(-8).map(r => `      | ${r}`).join('\n')}`);
    };
    await dumpTerminal('退出前');

    await appPage.keyboard.type('exit');
    await appPage.keyboard.press('Enter');
    await SLEEP(3000);
    await dumpTerminal('退出后');

    const exited = await appPage.evaluate(async () => {
      const opc = (window as unknown as { opc?: { terminalState?: () => Promise<unknown> } }).opc;
      return await opc?.terminalState?.();
    });
    ok((exited as { running?: boolean } | null)?.running === false, '冒烟：退出后状态显示未运行', JSON.stringify(exited));
    const startBtn = await appPage.getByRole('button', { name: '启动 shell' }).count();
    ok(startBtn === 1, '冒烟：退出后给显式启动按钮（不自动重启）', `找到 ${startBtn} 个`);
    // 屏幕还在：退出信息写在 xterm 里，不能被拆掉
    const rows = await readTerminalRows(appPage);
    ok(rows.some(r => r.includes('已退出')), '冒烟：退出后屏幕内容仍在（xterm 没被提前拆掉）');
  } catch (e) {
    // 失败时把页面状态一起带出来：冒烟失败最常见的原因不是产品坏了，
    // 而是「面板没打开」「路由没到」这类前置条件，光看异常名看不出来。
    let pageDump = '';
    try {
      const page = harness?.contexts().flatMap(c => c.pages())[0];
      if (page) {
        pageDump = await page.evaluate(() => {
          const aside = document.querySelector('aside');
          return [
            `url=${location.href}`,
            `aside=${aside ? '有' : '无'}`,
            `tablist=${document.querySelector('[role="tablist"]') ? '有' : '无'}`,
            `body=${document.body.innerText.slice(0, 300)}`,
          ].join('\n');
        });
      }
    } catch {
      /* 页面已经没了 */
    }
    ok(false, '冒烟执行', `${e instanceof Error ? e.message : String(e)}\n${pageDump}\n${log().slice(-1500)}`);
  } finally {
    clearTimeout(watchdog);
    try { await harness?.close(); } catch { /* 已断 */ }
    try { child.kill(); } catch { /* 已退 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
    try { rmSync(fixture, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

sourceContracts();
await runSmoke();
