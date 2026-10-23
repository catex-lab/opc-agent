/**
 * 打包态冒烟：P1~P4 的工作区面板（A81，release-p55）。
 *
 * 验证对象是 **打包后的 win-unpacked/OPC Agent.exe**，不是源码态。
 * 为什么单写一个：`verify:package` 用外部 Chrome 打应用自己的 HTTP 服务，
 * 那条路只能验服务端 + 前端静态资源；而 P1~P4 的三大块全是 **Electron 主进程
 * 能力**（文件 IPC、WebContentsView、spawn shell、CDP 端口），只有真起打包态
 * 应用、从 CDP 钻进它的渲染进程才摸得到。
 *
 * 与源码态 verify:a79-cdp 的分工：
 *   a79 证明「功能是对的」；本脚本证明「功能进包之后还是对的」。
 *   asar 里跑主进程、从 app.asar/dist 读前端、userData 走 exe 同级目录 ——
 *   这三件事源码态全都碰不到。
 *
 * 检查内容（两轮，两个独立的应用进程）：
 *   第一轮（`OPC_TERMINAL_NO_PTY=1`）—— 管道版：
 *   [1] 打包态进程起得来，CDP 端口真的开了（Chromium 自己写的 DevToolsActivePort）
 *   [2] 文件面板：会话 cwd 里的条目真的列出来（A77 的 IPC 在 asar 里能用）
 *   [3] 浏览器面板：地址栏加载本地探针页，视图真的在渲染（A78）
 *   [4] 人机同屏：第二条独立 CDP 连接按 descriptor 附着到同一个 target 并读回页面
 *   [5] 终端：echo %RANDOM% 输出的是真随机数而不是字面量 —— 证明 shell 真跑起来了
 *       （自回显会让「echo xxx」的输入与输出无法区分，%RANDOM% 展开才是判据）
 *   [6] 界面如实标注：终端常驻「管道版 · 无 TTY」、CDP 端口显示在状态条
 *
 *   第二轮（不带开关，默认通道）—— PTY 版：
 *   [7] `state.pty === true`：node-pty 的 `.node` 真的从 `app.asar.unpacked`
 *       加载成功、ConPTY spawn 成功。**这一条是 asarUnpack 有没有配对的唯一证据**
 *       —— 配错了 `.node` 就在 asar 里 require，当场降级成管道版，而界面照常能用，
 *       不专门看这个标志永远发现不了。
 *   [8] xterm 挂载 + 交互式程序：`python` REPL 出 `>>>`、`print(6*7)` 出 `42`。
 *       管道版下 python 拿不到 TTY 会当场退出，所以这一步同时证明「不是管道版」。
 *
 * 为什么分两轮而不是一轮：两条通道在**同一个进程里是互斥的**（`state.pty` 只有一个值），
 * 而两边都要在打包态各验一次 —— 降级路径配错了用户看到的只是「终端变笨了」，
 * PTY 路径配错了用户看到的是「终端还能用但 vim 进不去」，都不报错。
 *
 * 启动参数与 verify-package.mjs 保持一致（--no-sandbox --disable-gpu-sandbox），
 * 本机 EDR 注入未签名 DLL 会让 GPU 子进程 0xC0000005 带走主进程。
 * 数据隔离：OPC_USER_DATA_DIR + OPC_DATA_DIR 都指临时目录，退出即清理。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const results = [];
const ok = (cond, name, extra = '') => {
  results.push({ pass: !!cond, name, extra });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const SLEEP = ms => new Promise(r => setTimeout(r, ms));

/** 带超时的 fetch：HTTP 卡住时不能把整个冒烟无限期拖住（实测挂住过）。 */
async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return res.json();
}

const PROBE_HTML = `<!doctype html><meta charset="utf-8">
<title>打包态探针</title>
<body style="margin:0;background:#0F6E56;color:#fff;font:14px/1.6 system-ui,sans-serif">
  <div style="padding:28px 26px">
    <div style="font-size:20px;font-weight:600">打包态预览探针</div>
    <div id="marker">opc-package-probe-marker</div>
  </div>
</body>`;

/** 默认对象 = 最新的 release-pNN/win-unpacked/OPC Agent.exe（按 mtime，不写死目录）。 */
function newestPackagedExe() {
  const candidates = readdirSync('.', { withFileTypes: true })
    .filter(d => d.isDirectory() && /^release/.test(d.name))
    .map(d => path.join(d.name, 'win-unpacked', 'OPC Agent.exe'))
    .filter(p => existsSync(p))
    .map(p => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return candidates[0]?.p ?? null;
}

const EXE = process.argv[2] || newestPackagedExe();
if (!EXE) {
  console.error('找不到打包产物（release*/win-unpacked/OPC Agent.exe）');
  process.exit(1);
}
console.log(`冒烟对象：${EXE}`);

async function waitForActivePort(userData, timeoutMs = 30_000) {
  const file = path.join(userData, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await import('node:fs').then(fs => fs.readFileSync(file, 'utf8'));
      const port = Number(text.split(/\r?\n/)[0].trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* 还没写出来 */
    }
    await SLEEP(300);
  }
  return null;
}

async function waitForDescriptorTarget(dataDir, url, timeoutMs = 25_000) {
  const file = path.join(dataDir, 'cdp.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await import('node:fs').then(fs => fs.readFileSync(file, 'utf8'));
      const d = JSON.parse(text);
      if (d?.target?.url === url) return d;
    } catch {
      /* 还没写出来 */
    }
    await SLEEP(300);
  }
  return null;
}

function launchPackaged(exe, extraEnv = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'opc-pkg-smoke-'));
  const env = {
    ...process.env,
    ...extraEnv,
    OPC_SAFE_GRAPHICS: '1',
    OPC_USER_DATA_DIR: dataDir,
    OPC_DATA_DIR: dataDir,
    PORT: '0',
  };
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'OPC_GLASS', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    delete env[key];
  }
  const child = spawn(exe, ['--no-sandbox', '--disable-gpu-sandbox'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += String(d)));
  child.stderr.on('data', d => (log += String(d)));
  return { child, dataDir, log: () => log };
}

/**
 * 连接 CDP，带重试与诊断。
 *
 * 打包态实测过一次：`/json/version` 能拿到、ws 也连上了，但握手在 20s 内没完成
 * （当时机器刚跑完 7 分钟打包，EDR 还在扫 140 MB 的 exe）。所以这里加重试，
 * 失败时把 /json/version 与 /json/list 原样打出来 —— 连不上时最需要的答案就是
 * 「端口后面到底有什么」。
 */
async function connectCdp(port, attempts = 3) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 45_000 });
    } catch (e) {
      lastErr = e;
      console.log(`  · CDP 连接第 ${i}/${attempts} 次失败，转储端点状态…`);
      for (const p of ['/json/version', '/json/list']) {
        try {
          const text = await (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(5000) })).text();
          console.log(`    GET ${p} → ${text.slice(0, 600)}`);
        } catch (e2) {
          console.log(`    GET ${p} → ${e2.message}`);
        }
      }
      if (i < attempts) await SLEEP(3000);
    }
  }
  throw lastErr;
}

async function run() {
  // 探针页服务：与真实预览走同一条 http 加载路径
  const probe = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PROBE_HTML);
  });
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const probeUrl = `http://127.0.0.1:${probe.address().port}/`;

  // 文件面板夹具：一个子目录 + 两个文件，名字里带本轮 token，断言才不会误抓旧内容
  const token = `pkg${Date.now().toString(36).slice(-5)}`;
  const fixture = mkdtempSync(path.join(tmpdir(), 'opc-pkg-fixture-'));
  mkdirSync(path.join(fixture, `${token}-dir`));
  writeFileSync(path.join(fixture, `${token}-alpha.txt`), 'alpha');
  writeFileSync(path.join(fixture, `${token}-beta.txt`), 'beta');

  const { child, dataDir, log } = launchPackaged(EXE, {
    // 第一轮跑**管道版**：A82 起 PTY 成了默认通道，而这里整套断言
    // （输入行 / %RANDOM% 展开 / 「管道版」标注）本来就是照管道版写的。
    // 显式关掉 PTY，验的是「打包后降级路径仍然可用」。
    OPC_TERMINAL_NO_PTY: '1',
  });
  let harness = null;
  let agent = null;

  const watchdog = setTimeout(() => {
    try { child.kill(); } catch { /* 已退 */ }
    console.error('冒烟看门狗超时（240s）—— 打包态应用或 CDP 连接卡住了');
    console.error(log().slice(-2500));
    process.exit(1);
  }, 240_000);

  try {
    console.log('  · 等 DevToolsActivePort…');
    const port = await waitForActivePort(dataDir);
    ok(!!port, '打包态：Chromium 写出了 DevToolsActivePort（CDP 端口真的开了）');
    if (!port) throw new Error('没拿到调试端口\n' + log().slice(-1500));

    console.log('  · 连接 ①（驱动打包态应用的渲染进程）…');
    harness = await connectCdp(port);
    const appPage = harness.contexts().flatMap(c => c.pages())[0];
    if (!appPage) throw new Error('没找到应用窗口的 page');
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });

    const m = log().match(/地址:\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (!m) throw new Error('没从启动日志拿到 API 端口\n' + log().slice(-1500));
    const api = `http://127.0.0.1:${m[1]}`;
    ok(true, '打包态：服务端真的开始监听', api);

    console.log('  · 建会话 / 开面板…');
    const { session } = await fetchJson(`${api}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '打包态面板冒烟', cwd: fixture }),
    });
    ok(!!session?.id, '打包态：会话创建成功');
    if (!session?.id) throw new Error('会话没建出来');

    await appPage.goto(`${api}/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
    await appPage.evaluate(() => {
      try { localStorage.setItem('opc.workspace-open', 'true'); } catch { /* 隐私模式 */ }
    });
    await appPage.reload({ waitUntil: 'domcontentloaded' });
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });

    const ensurePanel = async () => {
      try {
        await appPage.waitForSelector('[role="tablist"]', { timeout: 10_000 });
        return;
      } catch {
        const toggle = appPage.getByRole('button', { name: /展开工作区|收起工作区/ });
        if (await toggle.count()) {
          const pressed = await toggle.first().getAttribute('aria-pressed');
          if (pressed === 'false') await toggle.first().click();
        }
        await appPage.waitForSelector('[role="tablist"]', { timeout: 20_000 });
      }
    };
    await ensurePanel();

    /* ── [2] 文件面板 ── */
    await appPage.getByRole('tab', { name: '文件' }).click();
    const panel = appPage.locator('aside').last();
    await panel.locator(`text=${token}-alpha.txt`).waitFor({ timeout: 15_000 });
    const entries = await panel.locator('button[title]').evaluateAll(els =>
      els.map(e => e.getAttribute('title')).filter(Boolean)
    );
    ok(entries.some(t => t.includes(`${token}-alpha.txt`)), '文件面板：会话 cwd 的条目真的列出来了', `${entries.length} 个条目`);
    ok(entries.some(t => t.includes(`${token}-beta.txt`)), '文件面板：第二个文件也在');
    ok(entries.some(t => t.includes(`${token}-dir`)), '文件面板：子目录也在');

    /* ── [3] 浏览器面板 ── */
    console.log('  · 切浏览器标签 / 加载探针页…');
    await appPage.getByRole('tab', { name: '浏览器' }).click();
    const address = appPage.getByPlaceholder('http://localhost:5173');
    await address.waitFor({ timeout: 15_000 });
    await address.fill(probeUrl);
    await address.press('Enter');
    await appPage.waitForFunction(
      () => document.querySelector('input[aria-label="预览地址"]')?.value.startsWith('http://127.0.0.1:'),
      { timeout: 20_000 }
    );
    ok(true, '浏览器面板：地址栏回填了探针页 URL');

    // 视图真的在渲染：descriptor 认出了预览 target（它按 CDP target 枚举，认不出来
    // 说明视图没起来或者 URL 不对）
    console.log('  · 等 cdp.json 认出预览视图 target…');
    const descriptor = await waitForDescriptorTarget(dataDir, probeUrl);
    ok(!!descriptor?.target, '浏览器面板：预览视图的 target 被认出来了', descriptor?.target?.url ?? '(无)');
    if (!descriptor?.target) throw new Error('打包态没认出预览视图 target\n' + log().slice(-1500));

    // 状态条如实显示 CDP 端口（开着没有必须让用户看见）
    const statusText = await appPage.locator('aside').last().innerText();
    ok(/CDP :\d+/.test(statusText), '浏览器面板：状态条显示 CDP 端口', statusText.split('\n').pop());

    /* ── [4] 人机同屏：第二条独立连接 ── */
    console.log('  · 连接 ②（扮演 Agent，只认识描述符）…');
    agent = await connectCdp(port);
    const agentPages = agent.contexts().flatMap(c => c.pages());
    const targetPage = agentPages.find(p => p.url() === probeUrl) ?? agentPages[agentPages.length - 1];
    ok(!!targetPage, '第二条独立连接能看到同一个页面 target');
    if (!targetPage) throw new Error('Agent 连接看不到探针页');

    const cdpSession = await targetPage.context().newCDPSession(targetPage);
    const info = await cdpSession.send('Target.getTargetInfo');
    ok(
      info.targetInfo.targetId === descriptor.target.id,
      '人机同屏：Agent 附着的 target 与 descriptor 交给用户的是同一个',
      `${info.targetInfo.targetId} vs ${descriptor.target.id}`
    );
    const marker = await targetPage.textContent('#marker');
    ok(marker === 'opc-package-probe-marker', '人机同屏：Agent 读回了用户眼前那个页面的内容', marker);

    /* ── [5] 终端 ── */
    console.log('  · 切终端标签 / 跑命令…');
    await appPage.getByRole('tab', { name: '终端' }).click();
    const termInput = appPage.getByPlaceholder('输入命令，回车执行');
    await termInput.waitFor({ timeout: 20_000 });
    ok(true, '终端：输入行就绪（shell 自己起来了）');

    // 判据要精确到「有没有展开」，但不能要求紧邻：cmd 的 Windows banner 常常
    // 迟于我们的自回显到达（我们乐观地写了开场白就置 running，命令已经缓冲进去），
    // 于是 banner 会插在回显行与输出行之间。所以找 echo 行**之后**第一处展开结果。
    await termInput.fill('echo PKG-%RANDOM%');
    await termInput.press('Enter');
    let output = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      output = await appPage.locator('pre').last().innerText();
      const ls = output.split(/\r?\n/);
      const i = ls.findIndex(l => l.includes('echo PKG-%RANDOM%'));
      if (i >= 0 && ls.slice(i + 1).some(l => /^\s*PKG-\d{1,5}\s*$/.test(l))) break;
      await SLEEP(400);
    }
    const lines = output.split(/\r?\n/);
    const echoIdx = lines.findIndex(l => l.includes('echo PKG-%RANDOM%'));
    const expanded = echoIdx >= 0 && lines.slice(echoIdx + 1).find(l => /^\s*PKG-\d{1,5}\s*$/.test(l));
    ok(
      !!expanded,
      '终端：命令真的执行了（%RANDOM% 展开成数字）',
      JSON.stringify(lines.slice(Math.max(0, echoIdx - 1), echoIdx + 5))
    );
    // 顺带盯双重回显：字面量应该只出现在回显行里一次
    const literalCount = (output.match(/%RANDOM%/g) || []).length;
    ok(literalCount === 1, '终端：%RANDOM% 字面量只出现一次（没有双重回显）', `出现 ${literalCount} 次`);
    if (literalCount !== 1 || echoIdx < 0) {
      console.log('  ── 终端完整输出（诊断）──');
      console.log(output.split(/\r?\n/).map((l, i) => `  ${String(i).padStart(3)}| ${l}`).join('\n'));
      console.log('  ── 结束 ──');
    }

    // 持久 shell：cd 之后 pwd/cd 应显示新目录（一条命令一个进程的实现到这步就挂）
    await termInput.fill(`cd ${token}-dir`);
    await termInput.press('Enter');
    await SLEEP(1200);
    await termInput.fill('cd');
    await termInput.press('Enter');
    await SLEEP(1500);
    output = await appPage.locator('pre').last().innerText();
    ok(output.includes(`${token}-dir`), '终端：cd 跨命令保持（同一个持久 shell）', output.split('\n').slice(-4).join(' | '));

    const panelText = await appPage.locator('aside').last().innerText();
    ok(panelText.includes('管道版'), '终端：界面常驻「管道版」标注（不靠用户自己踩出来）');
  } catch (e) {
    ok(false, '冒烟执行', e instanceof Error ? `${e.message}\n${log().slice(-2000)}` : String(e));
  } finally {
    clearTimeout(watchdog);
    for (const b of [harness, agent]) {
      try { await b?.close(); } catch { /* 已断 */ }
    }
    try { child.kill(); } catch { /* 已退 */ }
    probe.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
  }

  /* ══ 第二轮：默认通道 = PTY（A82）═════════════════════════════════════
   *
   * 单独起一个进程：两条通道在同一进程里互斥，而打包态要各验一次。
   * 这一轮只盯 PTY 专属的东西 —— 文件/浏览器/同屏第一轮已经验过，
   * 换进程重跑一遍只是把同样的结论抄两遍。
   */
  const { child: child2, dataDir: dataDir2, log: log2 } = launchPackaged(EXE);
  let harness2 = null;
  const watchdog2 = setTimeout(() => {
    try { child2.kill(); } catch { /* 已退 */ }
    console.error('第二轮看门狗超时（240s）—— PTY 打包态冒烟卡住了');
    console.error(log2().slice(-2500));
    process.exit(1);
  }, 240_000);

  try {
    console.log('  · [PTY 轮] 等 DevToolsActivePort…');
    const port2 = await waitForActivePort(dataDir2);
    ok(!!port2, 'PTY 打包态：CDP 端口真的开了');
    if (!port2) throw new Error('没拿到调试端口\n' + log2().slice(-1500));

    harness2 = await connectCdp(port2);
    const page2 = harness2.contexts().flatMap(c => c.pages())[0];
    if (!page2) throw new Error('没找到应用窗口的 page');
    await page2.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });

    const m2 = log2().match(/地址:\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (!m2) throw new Error('没从启动日志拿到 API 端口\n' + log2().slice(-1500));
    const api2 = `http://127.0.0.1:${m2[1]}`;

    const { session: session2 } = await fetchJson(`${api2}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '打包态 PTY 冒烟', cwd: fixture }),
    });
    ok(!!session2?.id, 'PTY 打包态：会话创建成功');
    if (!session2?.id) throw new Error('会话没建出来');

    await page2.goto(`${api2}/chat/${session2.id}`, { waitUntil: 'domcontentloaded' });
    await page2.evaluate(() => {
      try { localStorage.setItem('opc.workspace-open', 'true'); } catch { /* 隐私模式 */ }
    });
    await page2.reload({ waitUntil: 'domcontentloaded' });
    await page2.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });
    try {
      await page2.waitForSelector('[role="tablist"]', { timeout: 10_000 });
    } catch {
      const toggle = page2.getByRole('button', { name: /展开工作区|收起工作区/ });
      if (await toggle.count()) {
        const pressed = await toggle.first().getAttribute('aria-pressed');
        if (pressed === 'false') await toggle.first().click();
      }
      await page2.waitForSelector('[role="tablist"]', { timeout: 25_000 });
    }
    await page2.getByRole('tab', { name: '终端' }).click();

    /* [7] 通道身份 —— 这一条就是 asarUnpack 配没配对的判据 */
    await page2.waitForSelector('[data-terminal-host] .xterm', { timeout: 25_000 });
    ok(true, 'PTY 打包态：xterm 挂载（PTY 通道的界面）');
    const st = await page2.evaluate(async () => {
      const opc = window.opc;
      return opc?.terminalState ? await opc.terminalState() : null;
    });
    ok(
      st?.pty === true,
      'PTY 打包态：node-pty 从 app.asar.unpacked 真的加载并 spawn 成功',
      JSON.stringify(st)
    );
    if (st?.pty !== true) {
      // 降级了就把主进程日志带出来：这一条失败时最可能的原因是 asarUnpack
      // 没配对（.node 留在 asar 里 require 不了），日志里会有降级那一行。
      console.log('  ── 主进程日志尾部（诊断）──');
      console.log(log2().split(/\r?\n/).slice(-25).map(l => `  | ${l}`).join('\n'));
    }

    /* [8] 交互式程序 —— 管道版下 python 拿不到 TTY 会当场退出，所以这一步
           同时是「PTY 真在工作」与「没有悄悄退化」的双重证据 */
    if (st?.pty === true) {
      await page2.locator('[data-terminal-host] .xterm').click();
      await page2.keyboard.type('echo PKG-PTY-OK');
      await page2.keyboard.press('Enter');
      await page2.waitForFunction(
        () => Array.from(document.querySelectorAll('.xterm-rows > div'))
          .some(d => (d.textContent ?? '').includes('PKG-PTY-OK')),
        { timeout: 20_000 }
      );
      ok(true, 'PTY 打包态：echo 输出到达屏幕');

      await page2.keyboard.type('python');
      await page2.keyboard.press('Enter');
      await page2.waitForFunction(
        () => Array.from(document.querySelectorAll('.xterm-rows > div'))
          .some(d => (d.textContent ?? '').includes('>>>')),
        { timeout: 30_000 }
      );
      ok(true, 'PTY 打包态：python REPL 起来了（>>> 提示符出现）');

      await page2.keyboard.type('print(6*7)');
      await page2.keyboard.press('Enter');
      await page2.waitForFunction(
        () => Array.from(document.querySelectorAll('.xterm-rows > div'))
          .some(d => /^\s*42\s*$/.test(d.textContent ?? '')),
        { timeout: 20_000 }
      );
      ok(true, 'PTY 打包态：REPL 求值成功（42 单独一行）');

      // 退回 cmd 再敲一次 exit：交互式程序「进得来也出得去」才算闭环
      await page2.keyboard.type('exit()');
      await page2.keyboard.press('Enter');
      await page2.keyboard.type('echo BACK-AT-CMD');
      await page2.keyboard.press('Enter');
      await page2.waitForFunction(
        () => Array.from(document.querySelectorAll('.xterm-rows > div'))
          .some(d => (d.textContent ?? '').includes('BACK-AT-CMD')),
        { timeout: 25_000 }
      );
      ok(true, 'PTY 打包态：REPL 退出后回到 cmd（交互式程序完整闭环）');
    }

    // 界面说话要如实：PTY 通道下不能再挂「管道版」的牌子
    const panelText2 = await page2.locator('aside').last().innerText();
    ok(panelText2.includes('PTY'), 'PTY 打包态：界面标注为 PTY（不是管道版）');
  } catch (e) {
    ok(false, 'PTY 冒烟执行', e instanceof Error ? `${e.message}\n${log2().slice(-2000)}` : String(e));
  } finally {
    clearTimeout(watchdog2);
    try { await harness2?.close(); } catch { /* 已断 */ }
    try { child2.kill(); } catch { /* 已退 */ }
    try { rmSync(dataDir2, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
    try { rmSync(fixture, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

await run();
