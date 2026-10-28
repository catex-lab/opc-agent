/**
 * A135：界面偏好落到服务端 —— 打包态「重启就回默认」的根治。
 *
 * ## 用户看到的现象（P0-1）
 *
 * 调成深色、透明度 60、列表栏拖宽，关掉再打开全部回默认。审查报告当时只能说
 * 「可能在悄悄丢」，因为丢得没有痕迹。
 *
 * ## 根因
 *
 * 打包态传 `PORT=0`（`electron/bootstrap.cjs:71`），系统每次分配一个空闲端口，
 * 页面源是 `http://127.0.0.1:<端口>`（`electron/main.ts:98`）。**换端口就是换源，
 * localStorage 按源隔离** —— 每次启动都是一个新的空仓库。A131 实测本机
 * Chromium 里躺着 43 个端口源，`theme` 同时存在于其中 3 个。
 *
 * ## 这一层盯的是什么
 *
 * 不是「能读能写」，而是三件容易做成假绿的事：
 *   1. **跨进程**：同一个 dataDir，杀进程再起，值还在（进程内缓存不算数）；
 *   2. **首帧就位**：值必须来自 index.html 内联的 `window.__OPC_PREFS__`，
 *      而不是启动后补一次 fetch —— 所以断言「页面从没请求过 /api/preferences」；
 *   3. **非法值 400 不静默纠正**：夹紧/忽略未知字段会让「设了但没生效」
 *      只能靠肉眼发现（AGENTS.md 的会话设置四步同一条规矩）。
 *
 * ## 为什么必须真起服务端
 *
 * 注入发生在**路由层**（`sendIndexHtml`），单测那个函数证明不了「express 有没有
 * 把它挂在 static 之前」—— 挂晚了静态中间件会先把未注入的 index.html 发出去，
 * 函数本身照样绿。这是 A134 那轮「夹具层看不见路由层 bug」的原话。
 *
 * 运行：npm run verify:a135-prefs（需先 npm run build，浏览器段要读 dist）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a135-'));
const DATA = path.join(TMP, 'data');
const DIST = path.join(ROOT, 'dist');

let total = 0;
const failures = [];
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 200) };
  }
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitReady(base, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let log = '';
  child.stdout?.on('data', d => (log += String(d)));
  child.stderr?.on('data', d => (log += String(d)));
  while (Date.now() < deadline) {
    if (child.exitCode != null) return { ready: false, log };
    try {
      const res = await fetch(`${base}/api/preferences`);
      if (res.ok) return { ready: true, log };
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { ready: false, log };
}

async function startServer(port) {
  const child = spawn('npx tsx server/index.ts', {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      OPC_DATA_DIR: DATA,
      // 本机 safe-delete 垫片会把子进程的 fs 调用转去回收站，必须清空
      NODE_OPTIONS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { ready, log } = await waitReady(`http://127.0.0.1:${port}`, child);
  return { child, ready, log };
}

function stopServer(child) {
  if (!child || child.exitCode != null) return;
  // 先礼后兵：SIGTERM 在 Windows 上不一定有人接，补一次 taskkill 兜底
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** 系统 Chrome 优先；没有就取 ms-playwright 里最新的 chromium 构建 */
function resolveChrome() {
  const system = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(system)) return system;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter(d => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

// ───────────────────────────── 开跑 ─────────────────────────────

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('✗ 没有 dist/index.html —— 先跑 npm run build');
  process.exit(1);
}

let child = null;
let port = await freePort();
let base = `http://127.0.0.1:${port}`;

try {
  console.log('\n[1] 单文件落盘 + 跨进程仍在（杀进程再起）');
  {
    let s = await startServer(port);
    child = s.child;
    ok(s.ready, '服务端起得来', s.ready ? `${base}` : s.log.slice(-300));

    const initial = await json(await fetch(`${base}/api/preferences`));
    ok(
      initial && typeof initial === 'object' && Object.keys(initial).length === 0,
      '全新 dataDir 下没有任何偏好（不是一堆默认值）',
      JSON.stringify(initial)
    );

    const wanted = {
      theme: 'dark',
      transparency: 64,
      sidebarWidth: 380,
      workspaceWidth: 420,
      workspaceOpen: true,
      glow: { enabled: true, size: 520, brightness: 120 },
      defaultModel: 'glm-4.6',
    };
    const r = await fetch(`${base}/api/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wanted),
    });
    const saved = await json(r);
    ok(r.status === 200, 'PATCH 七项全部接受', `status=${r.status}`);
    ok(saved.transparency === 64 && saved.glow?.size === 520, '响应回显写入后的值');

    const file = path.join(DATA, 'preferences.json');
    ok(fs.existsSync(file), '落到 dataDir/preferences.json（不是数据库）', file);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    ok(onDisk.theme === 'dark' && onDisk.sidebarWidth === 380, '磁盘内容 = 提交的值');

    // 真跨进程：进程内缓存 `cached` 会让「没落盘」也看起来是对的
    stopServer(child);
    child = null;
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    s = await startServer(port);
    child = s.child;
    ok(s.ready, '换一个端口重新起进程', `${base}`);
    const after = await json(await fetch(`${base}/api/preferences`));
    ok(after.transparency === 64, '★ 重启后透明度还是 64（不是默认 28）', `got ${after.transparency}`);
    ok(after.theme === 'dark' && after.sidebarWidth === 380, '★ 主题与栏宽也还在');
    ok(after.glow?.enabled === true && after.glow?.size === 520, '★ 光斑设置还在');
  }

  console.log('\n[2] 非法值一律 400，且不动原值');
  {
    const bad = [
      [{ transparency: 101 }, 'transparency 101 越界'],
      [{ transparency: -1 }, 'transparency -1 越界'],
      [{ transparency: 64.5 }, 'transparency 小数'],
      [{ transparency: '64' }, 'transparency 字符串'],
      [{ sidebarWidth: 100 }, 'sidebarWidth 低于下限'],
      [{ workspaceWidth: 999 }, 'workspaceWidth 高于上限'],
      [{ theme: 'blue' }, 'theme 非枚举'],
      [{ workspaceOpen: 'true' }, 'workspaceOpen 字符串'],
      [{ sidebarWidht: 300 }, '未知字段（拼错）'],
      [{ glow: { enabled: 'yes' } }, 'glow.enabled 非布尔'],
      [{ glow: { enabled: true, size: 10 } }, 'glow.size 越界'],
      [{ defaultModel: '' }, 'defaultModel 空串'],
    ];
    for (const [body, label] of bad) {
      const r = await fetch(`${base}/api/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await json(r);
      ok(r.status === 400 && typeof j.error === 'string', `${label} → 400`, `status=${r.status}`);
    }
    const now = await json(await fetch(`${base}/api/preferences`));
    ok(now.transparency === 64, '★ 12 次非法请求之后原值仍是 64（没被夹紧改写）', `got ${now.transparency}`);

    // null = 清空这一项（回到「没设过」），与 undefined（不动）区分
    const r = await fetch(`${base}/api/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceWidth: null }),
    });
    const cleared = await json(r);
    ok(r.status === 200 && !('workspaceWidth' in cleared), 'null = 清空该项（不是设成 0）');
    ok(cleared.transparency === 64, '清一项不影响其它项');
    // 还原，后面的注入断言要用
    await fetch(`${base}/api/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceWidth: 420 }),
    });
  }

  console.log('\n[3] index.html 内联注入（首帧同步可读）');
  {
    const r = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
    const html = await r.text();
    ok(r.status === 200, 'GET / 正常返回');
    ok(
      /window\.__OPC_PREFS__\s*=/.test(html),
      '★ HTML 里内联了 window.__OPC_PREFS__',
      `${html.length} 字节`
    );
    ok(
      (r.headers.get('cache-control') || '').includes('no-store'),
      'index.html 不缓存（否则改了偏好要清缓存）',
      r.headers.get('cache-control') || '(空)'
    );

    const m = html.match(/window\.__OPC_PREFS__=(\{.*?\});<\/script>/s);
    let parsed = null;
    try {
      parsed = m ? JSON.parse(m[1].replace(/\\u003c/g, '<')) : null;
    } catch {
      parsed = null;
    }
    ok(parsed?.transparency === 64, '注入值与磁盘一致', `transparency=${parsed?.transparency}`);
    ok(parsed?.glow?.size === 520, '嵌套对象（glow）也完整注入');

    // 深链/子路由也要拿到注入值：SPA 兜底若走 sendFile 就漏了
    const deep = await fetch(`${base}/chat/whatever`, { headers: { Accept: 'text/html' } });
    const deepHtml = await deep.text();
    ok(/window\.__OPC_PREFS__\s*=/.test(deepHtml), '★ SPA 兜底路由同样注入（深链不丢偏好）');

    // 转义：defaultModel 是用户可控字符串，含 </script> 会提前闭合脚本块
    await fetch(`${base}/api/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'x</script><b>pwn' }),
    });
    const evil = await (await fetch(`${base}/`)).text();
    ok(!evil.includes('</script><b>pwn'), '★ </script> 被转义（不会提前闭合脚本块）');
    ok(evil.includes('\\u003c/script'), '转义形式是 \\u003c', '');
    await fetch(`${base}/api/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'glm-4.6' }),
    });
  }

  console.log('\n[4] 真浏览器：首帧就位，且没有额外请求');
  {
    const { chromium } = await import('playwright-core');
    const CHROME = resolveChrome();
    ok(!!CHROME, '找到可用的 Chrome/Chromium', CHROME || '');
    if (CHROME) {
      const browser = await chromium.launch({ executablePath: CHROME, headless: true });
      const page = await browser.newPage();
      const prefRequests = [];
      page.on('request', req => {
        if (req.url().includes('/api/preferences')) prefRequests.push(req.method());
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      // 给「启动后再补一次 fetch」留出机会：真补了就会出现在 prefRequests 里
      await page.waitForTimeout(1200);

      const style = await page.evaluate(() => ({
        chrome: document.documentElement.style.getPropertyValue('--opc-chrome-alpha'),
        sidebar: document.documentElement.style.getPropertyValue('--tc-sidebar-width'),
        glowSize: document.documentElement.style.getPropertyValue('--tc-glow-size'),
        glowOff: document.documentElement.dataset.opcGlow,
        dark: document.documentElement.classList.contains('dark'),
      }));
      // 透明度 64 ⇒ 框架面 alpha = 1 − 0.64 = 0.360
      ok(style.chrome === '0.360', '★ 透明度来自注入值（0.360，不是默认 0.720）', `got ${style.chrome}`);
      ok(style.sidebar === '380px', '★ 列表栏宽度来自注入值', `got ${style.sidebar || '(空)'}`);
      ok(style.glowSize === '520px', '★ 光斑尺寸来自注入值', `got ${style.glowSize || '(空)'}`);
      ok(style.glowOff === undefined, '光斑开关为「开」（没有 data-opc-glow="0"）');
      ok(style.dark === true, '主题 dark 生效');
      ok(
        prefRequests.length === 0,
        '★ 页面从未请求 /api/preferences（证明值来自内联，不是启动后补的）',
        prefRequests.length ? `请求过 ${prefRequests.join(',')}` : '0 次'
      );
      await browser.close();
    }
  }

  console.log('\n[5] 源码契约：七个消费方都先读注入值');
  {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf-8');
    const uiPrefs = read('src/uiPrefs.ts');
    const app = read('src/App.tsx');
    const theme = read('src/hooks/useTheme.ts');
    const models = read('src/hooks/useModels.ts');
    const prefs = read('src/prefs.ts');
    const server = read('server/index.ts');

    ok(/__OPC_PREFS__/.test(prefs), 'src/prefs.ts 读的是 window.__OPC_PREFS__');
    ok(
      /bootPref\('transparency'\)/.test(uiPrefs) &&
        /bootPref\('sidebarWidth'\)/.test(uiPrefs) &&
        /bootPref\('workspaceWidth'\)/.test(uiPrefs) &&
        /bootPref\('glow'\)/.test(uiPrefs),
      '四项外观偏好的读取都先走 bootPref',
      ''
    );
    ok(/bootPref\('theme'\)/.test(theme), '主题读取先走 bootPref');
    ok(/bootPref\('defaultModel'\)/.test(models), '默认模型读取先走 bootPref');
    ok(/bootPref\('workspaceOpen'\)/.test(app), '工作区开关读取先走 bootPref');

    // 写入必须**两边都写**：localStorage 是 7 条既有闸门的断言对象
    ok(
      /localStorage\.setItem\(TRANSPARENCY_KEY/.test(uiPrefs) &&
        /pushPrefs\(\{ transparency/.test(uiPrefs),
      '透明度写 localStorage 的同时 push 到服务端',
      ''
    );
    ok(
      /localStorage\.setItem\(SIDEBAR_KEY/.test(uiPrefs) && /pushPrefs\(\{ sidebarWidth/.test(uiPrefs),
      '栏宽同上（镜像不能丢，否则 7 条闸门失效）',
      ''
    );
    ok(/pushPrefs\(\{ theme/.test(theme), '主题写入 push 到服务端');
    ok(/pushPrefs\(\{ defaultModel/.test(app), '默认模型在「用户亲手选」处 push');
    ok(/pushPrefs\(\{ workspaceOpen/.test(app), '工作区开关写入 push 到服务端');

    // 路由顺序：注入必须挂在 express.static **之前**，否则静态中间件先发未注入的
    const iInject = server.indexOf("app.get(['/', '/index.html']");
    const iStatic = server.indexOf('app.use(express.static(webDir))');
    ok(iInject > 0 && iStatic > 0 && iInject < iStatic, '★ 注入路由注册在 express.static 之前', `inject@${iInject} static@${iStatic}`);
    ok(/sendIndexHtml\(res\)/.test(server.slice(server.indexOf('SPA 兜底'))), 'SPA 兜底也走 sendIndexHtml');
  }
} catch (e) {
  console.log(`\n✗ 运行异常：${e?.stack || e}`);
  failures.push('运行异常');
} finally {
  stopServer(child);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

console.log(`\n${failures.length ? '✗' : '✓'} A135 偏好持久化：${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
