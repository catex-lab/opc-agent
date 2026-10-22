/**
 * P3 验证：CDP 附着（人机同屏）。
 *
 * ## 为什么必须真跑一遍 Electron
 *
 * P3 的全部价值在一句话上：**Agent 能驱动用户眼前那个页面**。这句话
 * 用源码断言证明不了（契约只能证明「开关加了」），用 Chrome 里的
 * `verify:render` 更证明不了（那里连 `window.opc` 都没有）。
 *
 * 所以这里做一件很具体的事：起一个真的应用实例，然后开**两条独立的
 * CDP 连接**：
 *
 *   连接 ①（本脚本）     驱动应用自己的渲染进程：建会话 → 开面板 →
 *                        切到浏览器标签 → 加载探针页
 *   连接 ②（扮演 Agent） 从 `data/cdp.json` 里发现端点，附着到**同一个**
 *                        探针页 target 上，点一下页面里的按钮
 *
 * 点完之后读回页面状态：计数器变了，就说明「Agent 点哪、用户看哪」不是
 * 一句宣传语。两条连接是独立的（`connectOverCDP` 各建一个 session），
 * 连接 ② 对连接 ① 一无所知，除了那个共享的 target。
 *
 * ## 端点是怎么被发现的（这一段本身也是被测对象）
 *
 * 端口由 Chromium 用 `--remote-debugging-port=0` 自己选，写进 userData 下的
 * `DevToolsActivePort`；主进程再把它整理成 `data/cdp.json`。本脚本**只读
 * 这两个文件**，不看进程内存 —— 和真正的 Agent 走完全相同的发现路径。
 *
 * 运行：npx tsx scripts/verify-a79-cdp.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, get } from 'node:http';
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
  const cdp = read('electron/cdp.ts');

  // 端口交给 Chromium：`=0` + 读 DevToolsActivePort，而不是自己占端口猜
  ok(cdp.includes("appendSwitch('remote-debugging-port', '0')"), '契约：端口用 =0 交给 Chromium 分配');
  ok(cdp.includes('DevToolsActivePort'), '契约：从 DevToolsActivePort 读回真实端口');
  ok(cdp.includes("appendSwitch('remote-debugging-address', '127.0.0.1')"), '契约：显式只绑回环');
  ok(!/pickFreeLoopbackPort|net\.createServer/.test(cdp), '契约：没有自己占端口猜端口号的逻辑');
  ok(cdp.includes("process.env.OPC_CDP === '0'"), '契约：OPC_CDP=0 能关掉调试端口');

  // 端点要落地：Agent 是外部子进程，看不见主进程内存
  ok(cdp.includes("CDP_FILE_NAME = 'cdp.json'"), '契约：描述符文件名固定');
  ok(cdp.includes('writeCdpDescriptor'), '契约：描述符会写盘');
  ok(cdp.includes('process.env.OPC_CDP_ENDPOINT'), '契约：端点同时进环境变量（子进程继承）');
  ok(cdp.includes('process.env.OPC_CDP_TARGET'), '契约：预览视图 target 的 ws 也进环境变量');

  // target 解析：认错比认不出危险得多
  ok(cdp.includes('appUrls'), '契约：记录应用自己的窗口 URL');
  ok(/!appUrls\.some\(/.test(cdp), '契约：解析 target 时把应用自己的窗口排除掉');
  ok(/多于一个就宁可交出去 null/.test(cdp), '契约：候选不唯一时宁可给 null（不让 Agent 点到应用自己的界面）');

  // 主进程接线：开关必须在 ready 之前同步追加
  const main = read('electron/main.ts');
  ok(main.includes('enableCdp();'), '契约：main 调用了 enableCdp()');
  const enableIdx = main.indexOf('enableCdp();');
  const readyIdx = main.indexOf('app.whenReady()');
  ok(enableIdx > -1 && readyIdx > -1 && enableIdx < readyIdx, '契约：enableCdp() 在 app.whenReady() 之前（Chromium 初始化后追加开关无效）');
  ok(main.includes('await initCdpEndpoint()') || main.includes('initCdpEndpoint()'), '契约：ready 之后读回真实端口');
  ok(main.includes('setCdpAppUrls([url])'), '契约：把应用窗口 URL 交给 target 解析');
  ok(/void initCdpEndpoint\(\)\.then/.test(main), '契约：端点解析不阻塞窗口创建');

  // 视图导航后要刷新 target（URL 变了，Agent 手里的 ws 端点也得跟着变）
  const view = read('electron/browser-view.ts');
  ok(/did-navigate'[\s\S]{0,200}refreshCdpDescriptor/.test(view), '契约：did-navigate 后刷新 CDP target');
  ok(view.includes('refreshCdpDescriptor'), '契约：browser-view 引入 CDP 刷新');

  // 服务端路由只能读文件，不能 import electron（浏览器开发态服务跑在纯 Node 里）
  const server = read('server/index.ts');
  ok(server.includes('app.get("/api/browser/cdp"'), '契约：服务端暴露 /api/browser/cdp');
  ok(server.includes('fs.readFileSync(file, "utf8")'), '契约：服务端从文件读描述符（唯一真相）');
  const serverElectron = readdirSyncSafe('server').filter(f => /\.(ts|js)$/.test(f) &&
    /from ['"]electron['"]|require\(['"]electron['"]\)/.test(fs.readFileSync(path.join('server', f), 'utf8')));
  ok(serverElectron.length === 0, '契约：server/ 不 import electron', serverElectron.join(','));

  // preload 只给状态，不给 ws 端点（端点是要交给 Agent 的东西）
  const preload = read('electron/preload.cjs');
  ok(preload.includes('cdpInfo()'), '契约：preload 暴露 cdpInfo');
  ok(!/webSocketDebuggerUrl|wsUrl/.test(preload), '契约：preload 不泄露 ws 端点');

  // 端点怎么到 Agent 手里：主进程写进 process.env，子进程 spawn 时继承。
  // 这条链上任一处改成「显式白名单 env」，OPC_CDP_ENDPOINT 就会静默消失，
  // 而 Agent 侧的表现只是「连不上」—— 所以在这里钉住。
  for (const adapter of ['server/agents/adapters/cli.ts', 'server/agents/adapters/acp.ts']) {
    const src = read(adapter);
    ok(/\.\.\.process\.env/.test(src), `契约：${path.basename(adapter)} 的子进程继承主进程环境（端点因此能到 Agent 手里）`);
  }

  // 面板状态持久化
  const browserUi = read('src/components/WorkspaceBrowser.tsx');
  ok(browserUi.includes("LAST_URL_KEY = 'opc.workspace-last-url'"), '契约：上次 URL 有持久化键');
  ok(/isRestorableUrl/.test(browserUi) && /protocol === 'http:'/.test(browserUi), '契约：恢复 URL 前校验协议（localStorage 不是信任输入）');
  ok(browserUi.includes("nav.url !== 'about:blank'"), '契约：about:blank 不当成有效 URL');
  const panel = read('src/components/WorkspacePanel.tsx');
  ok(panel.includes("TAB_KEY = 'opc.workspace-tab'"), '契约：标签选择有持久化键');
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return fs.readdirSync(path.join(process.cwd(), dir));
  } catch {
    return [];
  }
}

/* ── B. 真 Electron 冒烟 ─────────────────────────────────────────────── */

/** 探针页：一个按钮 + 一个计数器。Agent 点按钮，计数器就变。 */
const PROBE_HTML = `<!doctype html><meta charset="utf-8">
<title>cdp-probe</title>
<body style="margin:0;background:#0F6E56;color:#fff;font:14px system-ui,sans-serif">
  <div style="padding:20px">
    <div id="n" style="font-size:28px">0</div>
    <button id="b" style="margin-top:12px;padding:8px 18px;border:0;border-radius:8px;
      background:#fff;color:#0F6E56;font-size:14px;cursor:pointer">Agent 点我</button>
  </div>
  <script>window.__n = 0;
    document.getElementById('b').addEventListener('click', () => {
      window.__n++; document.getElementById('n').textContent = String(window.__n);
    });</script>
</body>`;

interface ActivePort {
  port: number;
  wsPath: string;
}

/** 读 userData 下的 DevToolsActivePort（Chromium 自己写的真实端口）。 */
async function waitForActivePort(userData: string, timeoutMs = 25_000): Promise<ActivePort | null> {
  const file = path.join(userData, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(file, 'utf8');
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

/** 等 data/cdp.json 里的 target 解析到指定 URL。 */
async function waitForDescriptorTarget(dataDir: string, url: string, timeoutMs = 20_000) {
  const file = path.join(dataDir, 'cdp.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d?.target?.url === url) return d;
    } catch {
      /* 还没写出来 */
    }
    await SLEEP(300);
  }
  return null;
}

function httpGetJson<T>(port: number, urlPath: string): Promise<T | null> {
  return new Promise(resolve => {
    const req = get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** 起一次应用实例。返回子进程与隔离目录。 */
function launchApp(extraEnv: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cdp-smoke-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPC_SAFE_GRAPHICS: '1',
    OPC_USER_DATA_DIR: dataDir,
    OPC_DATA_DIR: dataDir,
    PORT: '0',
    ...extraEnv,
  };
  // 宿主 CLI 自带的这几个变量会把 electron 当 node 跑 / 让 CDP 走代理拿 502
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
  const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), ['.', '--no-sandbox', '--disable-gpu-sandbox'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += String(d)));
  child.stderr.on('data', d => (log += String(d)));
  return { child, dataDir, log: () => log };
}

async function runSmoke() {
  const root = process.cwd();
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });

  // 探针页服务（与真实预览走同一条 http 加载路径）
  const probe = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PROBE_HTML);
  });
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const probePort = (probe.address() as { port: number }).port;
  const probeUrl = `http://127.0.0.1:${probePort}/`;

  const { child, dataDir, log } = launchApp();
  let harness: Browser | null = null;
  let agent: Browser | null = null;

  /**
   * 看门狗。
   *
   * 实测过一次：脚本在某个等待上挂住，十分钟没有任何输出，只能手动杀。
   * 冒烟脚本挂住比失败更糟 —— 失败会告诉你哪里错了，挂住只浪费所有人的时间。
   * 所以这里给一个总上限，超时就连子进程一起收掉并明确报出来。
   */
  const watchdog = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
    console.error('冒烟看门狗超时（180s）—— 应用或 CDP 连接卡住了');
    console.error(log().slice(-2500));
    process.exit(1);
  }, 180_000);

  try {
    // ── 端点发现：只靠 Chromium 写的文件，和真正的 Agent 同一条路 ──
    const active = await waitForActivePort(dataDir);
    ok(!!active, '冒烟：Chromium 写出了 DevToolsActivePort（端口真的开了）');
    if (!active) throw new Error('没拿到调试端口\n' + log().slice(-1500));

    // 主机名必须是回环：暴露到局域网等于把应用交给全网
    const version = await httpGetJson<{ webSocketDebuggerUrl?: string; Browser?: string }>(
      active.port,
      '/json/version'
    );
    ok(!!version?.webSocketDebuggerUrl, '冒烟：/json/version 可用');
    ok(
      (version?.webSocketDebuggerUrl ?? '').startsWith('ws://127.0.0.1:'),
      '冒烟：浏览器级 ws 端点绑在回环上',
      version?.webSocketDebuggerUrl
    );

    /* ── 连接 ①：本脚本，驱动应用自己的渲染进程 ── */
    harness = await chromium.connectOverCDP(`http://127.0.0.1:${active.port}`, { timeout: 20_000 });
    const appPage = harness.contexts().flatMap(c => c.pages())[0];
    if (!appPage) throw new Error('没找到应用窗口的 page');
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });

    const m = log().match(/地址:\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (!m) throw new Error('没从启动日志拿到 API 端口\n' + log().slice(-1500));
    const api = `http://127.0.0.1:${m[1]}`;

    const created = await fetch(`${api}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'CDP 附着实拍', cwd: root }),
    });
    const { session } = (await created.json()) as { session?: { id?: string } };
    ok(!!session?.id, '冒烟：会话创建成功');
    if (!session?.id) throw new Error('会话没建出来');

    await appPage.goto(`${api}/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
    await appPage.evaluate(() => {
      try {
        localStorage.setItem('opc.workspace-open', 'true');
      } catch {
        /* 隐私模式 */
      }
    });
    await appPage.reload({ waitUntil: 'domcontentloaded' });
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });

    // 面板渲染要等两件事：localStorage 读回来、会话列表 fetch 完（currentSession
    // 有了面板才会挂）。所以先等 tablist 出现，等不到再点一次栏头开关 ——
    // 不猜时序，两种顺序都要能工作。
    const ensurePanel = async () => {
      try {
        await appPage.waitForSelector('[role="tablist"]', { timeout: 8000 });
        return true;
      } catch {
        const toggle = appPage.getByRole('button', { name: /展开工作区|收起工作区/ });
        if (await toggle.count()) {
          const pressed = await toggle.first().getAttribute('aria-pressed');
          if (pressed === 'false') await toggle.first().click();
        }
        await appPage.waitForSelector('[role="tablist"]', { timeout: 15000 });
        return true;
      }
    };
    await ensurePanel();

    await appPage.getByRole('tab', { name: '浏览器' }).click();
    const address = appPage.getByPlaceholder('http://localhost:5173');
    await address.waitFor({ timeout: 15_000 });
    await address.fill(probeUrl);
    await address.press('Enter');
    await appPage.waitForFunction(
      () => document.querySelector('input[aria-label="预览地址"]')?.value.startsWith('http://127.0.0.1:'),
      { timeout: 20_000 }
    );

    /* ── 描述符：主进程把预览视图的 target 认出来并落地 ── */
    const descriptor = await waitForDescriptorTarget(dataDir, probeUrl);
    ok(!!descriptor?.target, '冒烟：cdp.json 里认出了预览视图的 target', JSON.stringify(descriptor ?? null).slice(0, 300));
    if (!descriptor?.target) throw new Error('没拿到预览视图的 target');
    ok(descriptor.target.wsUrl.startsWith('ws://127.0.0.1:'), '冒烟：target ws 端点绑在回环上');
    ok(descriptor.enabled === true, '冒烟：描述符标记 enabled');
    // 应用自己的窗口不能被交出去
    const appWindowUrl = appPage.url();
    ok(descriptor.target.url !== appWindowUrl, '冒烟：交出去的不是应用自己的窗口', `${descriptor.target.url} vs ${appWindowUrl}`);

    /* ── 服务端路由：与文件是同一份真相 ── */
    const route = await fetch(`${api}/api/browser/cdp`).then(r => r.json());
    ok(route.enabled === true, '冒烟：/api/browser/cdp 报 enabled', JSON.stringify(route));
    ok(route.port === active.port, '冒烟：路由报的端口与 Chromium 实际监听的一致', `${route.port} vs ${active.port}`);
    ok(route.hasTarget === true && route.targetUrl === probeUrl, '冒烟：路由报出预览视图的 URL', JSON.stringify(route));

    /* ── 连接 ②：扮演 Agent。只认识 descriptor，别的什么都不知道 ── */
    agent = await chromium.connectOverCDP(`http://127.0.0.1:${active.port}`, { timeout: 20_000 });
    const agentPages = agent.contexts().flatMap(c => c.pages());
    // Agent 不必靠 URL 猜：descriptor 已经给了 target id
    const targetPage: Page | undefined =
      agentPages.find(p => p.url() === probeUrl) ?? agentPages[agentPages.length - 1];
    ok(!!targetPage, '冒烟：第二条独立连接能看到同一个页面 target');
    if (!targetPage) throw new Error('Agent 连接看不到探针页');

    // 身份核对：Playwright 附着的就是 descriptor 里那个 target
    const cdpSession = await targetPage.context().newCDPSession(targetPage);
    const info = (await cdpSession.send('Target.getTargetInfo')) as {
      targetInfo: { targetId: string; url: string };
    };
    ok(
      info.targetInfo.targetId === descriptor.target.id,
      '冒烟：Agent 附着的 target 与 descriptor 交给用户的是同一个',
      `${info.targetInfo.targetId} vs ${descriptor.target.id}`
    );

    // Agent 动手：点页面里的按钮
    const before = await targetPage.textContent('#n');
    await targetPage.click('#b');
    await targetPage.waitForFunction(
      prev => document.getElementById('n')?.textContent !== prev,
      before ?? '0',
      { timeout: 5000 }
    );
    const after = await targetPage.textContent('#n');
    ok(after === '1', '冒烟：Agent 的点击真的作用在用户眼前那个页面上', `before=${before} after=${after}`);

    // 面板里的地址栏要反映同一状态（人机同屏：用户看到的 URL 就是 Agent 驱动的那个）
    const shownUrl = await appPage.inputValue('input[aria-label="预览地址"]');
    ok(shownUrl === probeUrl, '冒烟：面板地址栏与 Agent 驱动的页面一致', `${shownUrl} vs ${probeUrl}`);

    /* ── 负面：OPC_CDP=0 时不开端口 ── */
    const off = launchApp({ OPC_CDP: '0' });
    try {
      const offActive = await waitForActivePort(off.dataDir, 8000);
      ok(offActive === null, '负面：OPC_CDP=0 时不写 DevToolsActivePort（端口没开）');
      // 描述符仍然要写（标记 enabled=false）：这样 UI 与服务端能如实说「关着」，
      // 而不是「查不到」。给它足够的启动时间 —— 应用要连库、注册 Agent 才建窗。
      let offDesc: { enabled?: boolean } | null = null;
      for (let i = 0; i < 30 && !offDesc; i++) {
        try {
          offDesc = JSON.parse(fs.readFileSync(path.join(off.dataDir, 'cdp.json'), 'utf8'));
        } catch {
          await SLEEP(500);
        }
      }
      ok(offDesc !== null, '负面：OPC_CDP=0 时描述符仍然落地（UI 能如实显示「关」）');
      ok(offDesc?.enabled === false, '负面：OPC_CDP=0 时描述符标记 enabled=false');
    } finally {
      try {
        off.child.kill();
      } catch {
        /* 已退 */
      }
    }
  } catch (e) {
    ok(false, '冒烟：整体异常', e instanceof Error ? e.message.split('\n')[0] : String(e));
    console.error(e);
  } finally {
    clearTimeout(watchdog);
    for (const b of [harness, agent]) {
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
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows 上进程可能还持着锁 */
    }
  }
}

async function main() {
  // `electron .` 跑的是 dist-electron/ 产物，不先构建的话测的是上一版代码
  const build = spawnSync('npm', ['run', '-s', 'build:electron'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    shell: true,
  });
  if (build.status !== 0) {
    ok(false, '冒烟：build:electron 失败', `exit=${build.status}`);
  } else {
    console.log('[A] 源码契约');
    checkContracts();
    console.log('[B] 真实 Electron 冒烟（两条独立 CDP 连接）');
    await runSmoke();
  }

  const passed = checks.total - failures.length;
  console.log(`\nCDP 附着 / 人机同屏（P3）断言：${passed}/${checks.total} 通过`);
  if (failures.length) {
    console.log('\n✗ 失败项：');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
  console.log('✓ 端点发现 / 回环绑定 / target 唯一性 / 外部客户端真附着均符合预期');
}

main().catch(e => {
  console.error('验证脚本自身出错:', e);
  process.exit(1);
});
