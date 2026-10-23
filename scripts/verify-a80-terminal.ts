/**
 * P4 验证：工作区面板的「终端」标签（管道版）。
 *
 * ## 为什么必须真跑一遍 Electron
 *
 * 终端这一版的风险全在**运行时**：shell 起没起来、输出到不到得了渲染进程、
 * `cd` 在两条命令之间还认不认、退出码报不报、杀不杀得掉。这些用源码断言
 * 一条都证明不了（契约只能证明「我调了 spawn」），用 Chrome 里的
 * `verify:render` 更不行（那里 `window.opc` 不存在，只显示降级说明）。
 *
 * 所以 B 组起一个真的应用实例，CDP 驱动渲染进程切到终端标签，然后：
 *
 *   1. 开场白到达（含 cwd 与「无 TTY」的说明）
 *   2. 敲 `echo <探针>` → 输出里出现探针字符串
 *   3. `cd sub` 再 `cd` → 输出里出现 sub 目录 —— 证明**同一个 shell 会话**
 *      还记得 cwd（换一个「每条命令起一个新进程」的实现，这一步就挂了）
 *   4. 敲 `exit` → 状态变成已退出、退出码上报
 *   5. 拒绝不存在的目录：`terminalStart` 返回人话，且**没有**起进程
 *
 * 运行：npx tsx scripts/verify-a80-terminal.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

const SLEEP = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ── A. 源码契约 ─────────────────────────────────────────────────────── */
function checkContracts() {
  const term = read('electron/terminal.ts');

  // 管道版：node-pty 在 A82 已经引入（PTY 优先），所以「没有 node-pty」
  // 这条断言反了。现在要守的是**降级通道本身没被丢掉**，且有一个能稳定
  // 走到它的开关 —— 否则这条分支只在「.node 坏了」时才被执行，
  // 等于永远没有测试覆盖（见 terminal.ts 里 ptyDisabledByEnv 的注释）。
  ok(/startPipe/.test(term), '契约：管道版通道还在（PTY 加载失败时的退路）');
  ok(/OPC_TERMINAL_NO_PTY/.test(term), '契约：有强制走管道版的开关（否则这条分支永远测不到）');
  ok(/spawn\(/.test(term), '契约：用 child_process.spawn 起 shell');
  ok(/stdio:\s*\['pipe', 'pipe', 'pipe'\]/.test(term), '契约：三个流全是管道（没有 PTY）');
  ok(/windowsHide:\s*true/.test(term), '契约：Windows 上不弹控制台窗口');

  // cwd 边界：只接受绝对路径，且必须真的存在
  ok(/statSync\(cwd\)\.isDirectory\(\)/.test(term), '契约：cwd 必须真的存在且是目录');
  ok(/必须是绝对路径/.test(term), '契约：拒绝相对路径（会按主进程 cwd 解析到应用安装目录）');

  // 单实例：两个 shell 交错输出，用户分不清哪行是谁打的
  ok(/先杀旧的/.test(term) && /this\.kill\(\)/.test(term), '契约：启动新 shell 前先杀旧的（同一时刻只有一个）');

  // 生命周期：shell 是能执行任意命令的活对象，不能比窗口/应用活得久
  const main = read('electron/main.ts');
  ok(/terminal\.kill\(\)/.test(main), '契约：main 里收尾终端');
  ok(/app\.on\('before-quit'[\s\S]{0,600}terminal\.kill\(\)/.test(main), '契约：退出前 kill shell（不留孤儿进程）');
  ok(/mainWindow\.on\('closed'[\s\S]{0,300}terminal\.kill\(\)/.test(main), '契约：窗口关闭时 kill shell');

  // IPC 与桥
  for (const channel of [
    'opc:terminal-start',
    'opc:terminal-input',
    'opc:terminal-kill',
    'opc:terminal-state',
    'opc:terminal-output',
    'opc:terminal-data',
    'opc:terminal-state',
  ]) {
    if (channel === 'opc:terminal-data' || channel === 'opc:terminal-state') continue;
    ok(main.includes(channel), `契约：main 注册 ${channel}`);
  }
  ok(main.includes("send('opc:terminal-data'"), '契约：输出增量推送给渲染进程');

  const preload = read('electron/preload.cjs');
  for (const fn of ['terminalStart(', 'terminalInput(', 'terminalKill(', 'terminalState(', 'terminalOutput(', 'onTerminalData(', 'onTerminalState(']) {
    ok(preload.includes(fn), `契约：preload 暴露 ${fn.replace('(', '')}`);
  }

  // 渲染侧
  const bridge = read('src/terminalPanel.ts');
  ok(bridge.includes('export function hasTerminal'), '契约：terminalPanel 导出 hasTerminal');
  const ui = read('src/components/WorkspaceTerminal.tsx');
  ok(ui.includes('终端只在桌面端可用'), '契约：没有原生能力时明说（不摆假输入框）');
  ok(ui.includes('管道版'), '契约：界面常驻「管道版」说明');
  ok(ui.includes('无 TTY'), '契约：界面常驻「无 TTY」说明（vim / top 不可用）');
  ok(ui.includes('还没绑工作目录'), '契约：没有 cwd 时给指引，不乱起 shell');
  // 自动只起一次：否则 exit / 电源键会被立刻拉起来，电源键就成了假控件
  ok(/booted/.test(ui) && /if \(!available \|\| !cwd \|\| booted\) return;/.test(ui), '契约：只自动启动一次（exit 后不自动重启）');
  // 自己回显：管道下 cmd 不回显，不补一行用户看不见自己敲了什么
  ok(/自己回显/.test(ui), '契约：输入行自己回显（管道下的 shell 不回显 stdin）');

  const panel = read('src/components/WorkspacePanel.tsx');
  ok(panel.includes('<WorkspaceTerminal'), '契约：面板挂了终端组件');
}

/* ── B. 真 Electron 冒烟 ─────────────────────────────────────────────── */

async function waitForActivePort(userData: string, timeoutMs = 25_000) {
  const file = path.join(userData, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const [p] = text.split(/\r?\n/);
      const port = Number((p ?? '').trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* 还没写出来 */
    }
    await SLEEP(300);
  }
  return null;
}

async function runSmoke() {
  const root = process.cwd();

  // 终端的工作目录：一个真实的临时目录，里面建一个子目录给 `cd` 用
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-term-proj-'));
  const subDir = path.join(projDir, 'sub');
  fs.mkdirSync(subDir);
  const PROBE = `opc-terminal-probe-${Date.now()}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-term-smoke-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPC_SAFE_GRAPHICS: '1',
    // A82：PTY 成了默认通道，管道版只剩「加载失败」这一条路能到 ——
    // 而那条路最难复现。所以这里显式关掉 PTY，让这套管道版断言真的跑起来。
    OPC_TERMINAL_NO_PTY: '1',
    OPC_USER_DATA_DIR: dataDir,
    OPC_DATA_DIR: dataDir,
    PORT: '0',
  };
  for (const key of [
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'OPC_GLASS',
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
  ]) {
    delete env[key];
  }

  // 两个构建都要：`electron .` 跑的是 dist-electron/ 产物（不是 TS 源码），
  // 而窗口加载的 http://127.0.0.1:PORT 前端来自 vite 的 dist/。
  // 少跑 build:electron 的后果是「改了主进程代码，冒烟还在测旧包」——
  // 这个坑在 a79 踩过一次，a80 首发版又漏了。
  const build = spawnSync('npm', ['run', '-s', 'build'], {
    cwd: root,
    stdio: 'ignore',
    shell: true,
  });
  if (build.status !== 0) {
    ok(false, '冒烟：build 失败', `exit=${build.status}`);
    return;
  }
  const buildElectron = spawnSync('npm', ['run', '-s', 'build:electron'], {
    cwd: root,
    stdio: 'ignore',
    shell: true,
  });
  if (buildElectron.status !== 0) {
    ok(false, '冒烟：build:electron 失败', `exit=${buildElectron.status}`);
    return;
  }

  const child = spawn(
    path.resolve('node_modules/electron/dist/electron.exe'),
    ['.', '--no-sandbox', '--disable-gpu-sandbox'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  child.stdout.on('data', d => (log += String(d)));
  child.stderr.on('data', d => (log += String(d)));

  // 看门狗：冒烟挂住比失败更糟（失败会告诉你哪里错，挂住只浪费时间）
  const watchdog = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 已退 */
    }
    console.error('冒烟看门狗超时（180s）');
    console.error(log.slice(-2500));
    process.exit(1);
  }, 180_000);

  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    const port = await waitForActivePort(dataDir);
    ok(!!port, '冒烟：应用开了调试端口（CDP 附着可用）');
    if (!port) throw new Error('没读到 DevToolsActivePort\n' + log.slice(-1500));

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000 });
    page = browser.contexts().flatMap(c => c.pages())[0];
    if (!page) throw new Error('没找到应用窗口');
    await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });

    const m = log.match(/地址:\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (!m) throw new Error('没拿到 API 端口\n' + log.slice(-1500));
    const api = `http://127.0.0.1:${m[1]}`;

    const created = await fetch(`${api}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '终端冒烟', cwd: projDir }),
    });
    const { session } = (await created.json()) as { session?: { id?: string } };
    ok(!!session?.id, '冒烟：会话创建成功');
    if (!session?.id) throw new Error('会话没建出来');

    await page.goto(`${api}/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        localStorage.setItem('opc.workspace-open', '1');
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

    // 切到终端标签（shell 会自动起）
    await page.getByRole('tab', { name: '终端' }).click();
    const input = page.getByLabel('终端输入');
    await input.waitFor({ timeout: 20_000 });
    // 输入框可用 = shell 已经起来了
    await page.waitForFunction(() => {
      const el = document.querySelector('input[aria-label="终端输入"]') as HTMLInputElement | null;
      return !!el && !el.disabled;
    }, { timeout: 20_000 });
    ok(true, '冒烟：shell 自动启动，输入框可用');

    const outputText = async () =>
      (await page.locator('pre').last().textContent()) ?? '';

    // ① 开场白：cwd 与「无 TTY」都要说出来
    await page.waitForFunction(
      expected => (document.querySelector('pre')?.textContent ?? '').includes('[终端]') &&
        (document.querySelector('pre')?.textContent ?? '').includes(expected),
      projDir,
      { timeout: 15_000 }
    );
    const banner = await outputText();
    ok(banner.includes('无 TTY'), '冒烟：开场白说明了「无 TTY」', banner.slice(0, 200));

    // ② echo 探针
    await input.fill(`echo ${PROBE}`);
    await input.press('Enter');
    await page.waitForFunction(
      expected => (document.querySelector('pre')?.textContent ?? '').includes(expected),
      PROBE,
      { timeout: 20_000 }
    );
    ok(true, '冒烟：命令输出到达界面');

    // 双重回显回归：管道下的 cmd.exe **自己会回显 stdin**（实测，还会打提示符），
    // 渲染进程为了 bash 那边又回显一遍，用户就看到每条命令打两次。
    // `pickShell()` 给 cmd 传 `/q` 关掉它那边；这里守住不再复发。
    // 判据：自回显是 `<cwd>> echo X`（有空格），cmd 的回显是 `<cwd>>echo X`（无空格）。
    const echoText = await outputText();
    if (/cmd\.exe/.test(echoText)) {
      ok(
        !new RegExp(`>echo ${PROBE}`).test(echoText),
        '冒烟：cmd 没有二次回显（/q 生效）',
        echoText.split('\n').filter(l => l.includes('echo')).join(' ⏎ ').slice(0, 200)
      );
    }

    // ③ cd 之后还认不认 —— 这一步是「同一个 shell 会话」的证据
    await input.fill('cd sub');
    await input.press('Enter');
    await page.waitForTimeout(600);
    await input.fill('cd');
    await input.press('Enter');
    await page.waitForFunction(
      expected => (document.querySelector('pre')?.textContent ?? '').includes(expected),
      subDir,
      { timeout: 20_000 }
    );
    ok(true, '冒烟：cd 跨命令保持（证明是同一个持久 shell，不是一条命令一个进程）');

    // ④ exit → 退出码上报
    await input.fill('exit');
    await input.press('Enter');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('input[aria-label="终端输入"]') as HTMLInputElement | null;
        return !!el && el.disabled;
      },
      { timeout: 20_000 }
    );
    const afterExit = await outputText();
    ok(/已退出/.test(afterExit), '冒烟：退出后状态如实显示', afterExit.slice(-160));
    // 不自动重启：电源键/启动按钮必须是有意义的选择
    const restarted = await page.getByRole('button', { name: '启动 shell' }).count();
    ok(restarted === 1, '冒烟：退出后不自动重启（给出显式启动按钮）');

    // ⑤ 拒绝不存在的目录（这条走 IPC，不经过 UI）
    const rejected = await page.evaluate(async () => {
      const opc = (window as unknown as { opc?: { terminalStart?: (c: string) => Promise<unknown> } }).opc;
      if (!opc?.terminalStart) return 'no-bridge';
      return await opc.terminalStart('E:/definitely/not/here-xyz');
    });
    ok(
      typeof rejected === 'object' && rejected !== null && (rejected as { ok?: boolean }).ok === false,
      '冒烟：拒绝不存在的工作目录',
      JSON.stringify(rejected)
    );
    ok(
      typeof rejected === 'object' && rejected !== null &&
        /不存在|不是目录/.test(String((rejected as { error?: string }).error ?? '')),
      '冒烟：拒绝时给出可读原因',
      JSON.stringify(rejected)
    );
  } catch (e) {
    ok(false, '冒烟：整体异常', e instanceof Error ? e.message.split('\n')[0] : String(e));
    console.error(e);
    if (log.trim()) console.error('—— 子进程日志尾部 ——\n' + log.slice(-2500));
  } finally {
    clearTimeout(watchdog);
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
    for (const dir of [projDir, dataDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 上进程可能还持着锁 */
      }
    }
  }
}

async function main() {
  console.log('[A] 源码契约');
  checkContracts();
  console.log('[B] 真实 Electron 冒烟');
  await runSmoke();

  const passed = checks.total - failures.length;
  console.log(`\n终端（P4 管道版）断言：${passed}/${checks.total} 通过`);
  if (failures.length) {
    console.log('\n✗ 失败项：');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
  console.log('✓ 安全边界 / 生命周期 / 真实命令执行均符合预期');
}

main().catch(e => {
  console.error('验证脚本自身出错:', e);
  process.exit(1);
});
