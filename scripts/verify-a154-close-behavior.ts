/**
 * A154：关闭窗口行为（设置项 + 退出前任务确认）的验收闸门。
 *
 * 要钉的是用户提的两件事：
 *   ① 「点击关闭之后直接退出了」—— 现在有三档可选：直接退出（默认，保持老行为）/
 *      最小化到托盘 / 每次询问；
 *   ② 「退出前的任务确认」—— 还有 Agent 任务在跑时，直接退出前必须先确认一次。
 *
 * ## 为什么先测决策表，再测页面
 *
 * `electron/close-policy.ts` 是真机上「点右上角关闭」才会走到的分支：
 * 浏览器打靶脚本没有 `window.opc`，Node 里也起不来 BrowserWindow。把决策抽成
 * 纯函数后，这里能穷举所有组合（含脏偏好值、负数任务数、托盘不可用），
 * 而不是只靠一次手点。
 *
 * ## 设置项必须真的落盘
 *
 * 主进程与 Express 同进程，它读的就是 `server/preferences.ts` 的
 * `loadPrefs()`。所以闸门走**真实** PATCH + 落盘检查 + 重启后注入检查 ——
 * 只断言「点了按钮 aria-pressed 变了」会漏掉「值没进 preferences.json，
 * 关窗口时主进程读到的还是 quit」这个最要命的假绿。
 *
 * 运行：npm run verify:a154-close-behavior（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { decideCloseAction } from '../electron/close-policy';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a154-close-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const SHOTS = path.join(ROOT, '.tmp', 'a154-close-behavior');
const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function killTree(child: ReturnType<typeof spawn> | null) {
  if (!child || child.exitCode != null) return;
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

const json = async (res: Response) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

async function waitReady(
  base: string,
  child: ReturnType<typeof spawn>,
  timeoutMs = 90000
) {
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
    await new Promise(r => setTimeout(r, 400));
  }
  return { ready: false, log };
}

function resolveChrome(): string | null {
  if (fs.existsSync(SYSTEM_CHROME)) return SYSTEM_CHROME;
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

// ───────────────────────── [1] 决策表 ─────────────────────────
console.log('\n[1] 决策表：三档 × 是否有任务 × 托盘是否可用');
{
  const cases: Array<[string, Parameters<typeof decideCloseAction>[0], string]> = [
    ['没设过（undefined）且无任务 → 直接关', { behavior: undefined, runningTasks: 0, trayAvailable: true }, 'close'],
    ['没设过但有任务 → 先确认', { behavior: undefined, runningTasks: 2, trayAvailable: true }, 'confirm-quit'],
    ['脏值（拼错）按默认 quit 处理', { behavior: 'clsoe', runningTasks: 0, trayAvailable: true }, 'close'],
    ['quit + 无任务 → 不打扰，直接关', { behavior: 'quit', runningTasks: 0, trayAvailable: true }, 'close'],
    ['quit + 2 个任务 → 确认', { behavior: 'quit', runningTasks: 2, trayAvailable: true }, 'confirm-quit'],
    ['tray + 无任务 → 隐藏', { behavior: 'tray', runningTasks: 0, trayAvailable: true }, 'hide'],
    ['tray + 2 个任务 → 仍然隐藏（不中断任务）', { behavior: 'tray', runningTasks: 2, trayAvailable: true }, 'hide'],
    ['tray 但托盘不可用 + 无任务 → 退化成直接关', { behavior: 'tray', runningTasks: 0, trayAvailable: false }, 'close'],
    ['tray 但托盘不可用 + 有任务 → 退化成确认', { behavior: 'tray', runningTasks: 1, trayAvailable: false }, 'confirm-quit'],
    ['ask + 托盘可用 → 三选一', { behavior: 'ask', runningTasks: 0, trayAvailable: true }, 'ask'],
    ['ask + 托盘可用 + 有任务 → 仍然三选一（代价写在同一句里）', { behavior: 'ask', runningTasks: 3, trayAvailable: true }, 'ask'],
    ['ask 但托盘不可用 → 视为 quit', { behavior: 'ask', runningTasks: 4, trayAvailable: false }, 'confirm-quit'],
    ['任务数是负数（坏数据）当作 0', { behavior: 'quit', runningTasks: -1, trayAvailable: true }, 'close'],
    ['任务数是 NaN（坏数据）当作 0', { behavior: 'quit', runningTasks: NaN, trayAvailable: true }, 'close'],
  ];
  for (const [label, ctx, want] of cases) {
    const got = decideCloseAction(ctx);
    ok(got === want, `决策：${label}`, got === want ? '' : `got ${got}`);
  }
}

let child: ReturnType<typeof spawn> | null = null;
let port = await freePort();
let base = `http://127.0.0.1:${port}`;

try {
  console.log('\n[2] 偏好层：三档可存、脏值 400、重启仍在');
  {
    child = spawn('npx tsx server/index.ts', {
      cwd: ROOT,
      shell: true,
      windowsHide: true,
      env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await waitReady(base, child);
    ok(ready.ready, '服务端起得来', ready.ready ? base : ready.log.slice(-300));

    const initial = await json(await fetch(`${base}/api/preferences`));
    ok(typeof initial.closeBehavior === 'undefined', '全新 dataDir 下没有 closeBehavior（默认由前端/主进程给）');

    for (const value of ['tray', 'ask', 'quit']) {
      const r = await fetch(`${base}/api/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closeBehavior: value }),
      });
      const saved = await json(r);
      ok(r.status === 200 && saved.closeBehavior === value, `PATCH closeBehavior=${value} 被接受`, `status=${r.status}`);
    }

    const file = path.join(DATA, 'preferences.json');
    ok(fs.existsSync(file), '落到 dataDir/preferences.json', file);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    ok(onDisk.closeBehavior === 'quit', '磁盘内容 = 最后一次提交的值');

    // null 是「清空」语义（下面单独验），这里只打非法的**值**
    const badValues: Array<[string, string]> = [
      ['中文值', '"托盘"'],
      ['数字', '1'],
      ['布尔', 'true'],
      ['数组', '[]'],
    ];
    for (const [label, raw] of badValues) {
      const r = await fetch(`${base}/api/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: `{"closeBehavior":${raw}}`,
      });
      const j = await json(r);
      ok(r.status === 400 && typeof j.error === 'string', `${label} → 400（不静默纠正）`, `status=${r.status}`);
    }

    const cleared = await json(
      await fetch(`${base}/api/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closeBehavior: null }),
      })
    );
    ok(!('closeBehavior' in cleared), 'null = 清空该项（回到没设过，默认 quit）');

    // 真跨进程：进程内缓存会让「没落盘」看起来也对
    killTree(child);
    child = null;
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('npx tsx server/index.ts', {
      cwd: ROOT,
      shell: true,
      windowsHide: true,
      env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const again = await waitReady(base, child);
    ok(again.ready, '换端口重新起进程', again.ready ? base : again.log.slice(-300));
    // 先写一个值再重启，才有东西可验
    await fetch(`${base}/api/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closeBehavior: 'tray' }),
    });
    killTree(child);
    child = null;
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('npx tsx server/index.ts', {
      cwd: ROOT,
      shell: true,
      windowsHide: true,
      env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const third = await waitReady(base, child);
    ok(third.ready, '第二次重启服务端', third.ready ? base : third.log.slice(-300));
    const after = await json(await fetch(`${base}/api/preferences`));
    ok(after.closeBehavior === 'tray', '★ 重启后 closeBehavior 还是 tray（不是默认 quit）', `got ${after.closeBehavior}`);
  }

  console.log('\n[3] 设置页：外观分区里的「关闭窗口时」三选');
  {
    const CHROME = resolveChrome();
    ok(!!CHROME, '找到可用的 Chrome/Chromium', CHROME || '');
    if (CHROME) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const browser = await chromium.launch({ executablePath: CHROME, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(String(e)));
      page.on('console', m => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto(`${base}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-close-behavior-setting]', { timeout: 15000 });

      const opts = await page.evaluate(() =>
        [...document.querySelectorAll('[data-close-behavior]')].map(el => ({
          value: el.getAttribute('data-close-behavior'),
          pressed: el.getAttribute('aria-pressed'),
          text: (el.textContent || '').trim(),
        }))
      );
      ok(opts.length === 3, '三档都在', opts.map(o => o.value).join('/'));
      ok(opts.every(o => o.text.length > 0), '每档都有可见标签', opts.map(o => o.text).join(' / '));
      ok(opts.some(o => o.value === 'tray' && o.pressed === 'true'), '★ 注入值 tray 在页面上是选中态',
        JSON.stringify(opts.map(o => `${o.value}:${o.pressed}`)));

      await page.locator('[data-close-behavior="ask"]').click();
      await page.waitForTimeout(700); // 偏好 PATCH 有 250ms 防抖
      const local = await page.evaluate(() => localStorage.getItem('opc.close-behavior'));
      ok(local === 'ask', '★ 点击后 localStorage 镜像同步写', String(local));
      const now = await json(await fetch(`${base}/api/preferences`));
      ok(now.closeBehavior === 'ask', '★ 点击后服务端偏好也变成 ask（主进程读的就是这份）', `got ${now.closeBehavior}`);

      await page.screenshot({ path: path.join(SHOTS, 'settings-appearance.png') });
      ok(errors.length === 0, '页面零控制台错误', errors.slice(0, 2).join(' | ') || '干净');
      await browser.close();
    }
  }

  console.log('\n[4] 源码契约：主进程读服务端偏好、关窗拦截必须有放行出口');
  {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf-8');
    const policy = fs.readFileSync(path.join(ROOT, 'electron/close-policy.ts'), 'utf-8');
    const settings = fs.readFileSync(
      path.join(ROOT, 'src/components/SettingsPage.tsx'),
      'utf-8'
    );
    ok(/loadPrefs\(\)/.test(main), '主进程通过 loadPrefs() 读偏好（不是自己存一份）');
    ok(!/localStorage/.test(main), '主进程不碰 localStorage（打包态换端口会按源隔离）');
    ok(/runHub\.activeRuns\(\)/.test(main), '任务数来自 runHub.activeRuns()（与后台任务胶囊同源）');
    ok(/mainWindow\.on\('close'/.test(main), '窗口挂了 close 拦截');
    ok(/event\.preventDefault\(\)/.test(main), '拦截里确实 preventDefault（否则系统默认直接关）');
    // 不能用 indexOf 找带右括号的整句：实际写法是 `app.on('before-quit', () => {`，
    // 括号在 `,` 之后，找不到会返回 -1，slice(-1) 只拿到文件最后一个字符，
    // 这条断言就会稳定误红。所以只找事件名本身。
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
    ok(/isQuitting = true/.test(beforeQuit.slice(0, 400)),
      '★ before-quit 置位放行（托盘退出 / 系统关机不会被自己挡住）');
    ok(/decideCloseAction/.test(policy) && /isCloseBehavior/.test(policy),
      '决策表复用 shared 的枚举判定');
    ok(/readCloseBehavior/.test(settings) && /saveCloseBehavior/.test(settings),
      '设置页读写走 closeBehavior 模块');
  }
} catch (e) {
  console.log(`\n✗ 运行异常：${(e as Error)?.stack || e}`);
  failures.push('运行异常');
} finally {
  killTree(child);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

console.log(`\n${failures.length ? '✗' : '✓'} A154 关闭窗口行为：${pass}/${pass + fail} 通过`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
