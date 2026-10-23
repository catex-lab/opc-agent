/**
 * A82：工作区面板的两处交互改造验证。
 *
 *   [A] 源码契约 —— 拖拽方向、变量落点、按钮顺序，这些看截图看不出来的
 *   [B] 真实 Electron 冒烟 —— 用真鼠标事件拖手柄，看面板宽度真的变了；
 *       刷新后还在（localStorage）；双击复位；按钮真的贴在 ⋯ 左边
 *
 * 为什么单独一个脚本：改造本身小（一个手柄 + 一次换位），但两处都是
 * 「看着对、用起来反的」高发区 —— 方向写反的拖拽手柄在静态截图里完全正常。
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return (await res.json()) as T;
}

/* ── [A] 源码契约 ─────────────────────────────────────────────────────── */

function sourceContracts() {
  const resizerPath = path.join(root, 'src', 'components', 'WorkspaceResizer.tsx');
  let resizer = '';
  try {
    resizer = readFileSync(resizerPath, 'utf8');
  } catch {
    ok(false, '契约：WorkspaceResizer.tsx 存在');
  }
  if (resizer) {
    ok(true, '契约：WorkspaceResizer.tsx 存在');
    ok(
      /setPointerCapture/.test(resizer) && /hasPointerCapture/.test(resizer),
      '契约：拖动走 Pointer Capture（指针拖快跑出手柄也不断链）'
    );
    // 方向：面板在右侧，往左拖才变宽。写成加号就是「越拖越窄」，
    // 而那条分割线看起来完全正常 —— 只能靠读代码抓住。
    ok(
      /startRef\.current\.width\s*-\s*\(e\.clientX\s*-\s*startRef\.current\.x\)/.test(resizer),
      '契约：拖拽方向是「往左变宽」（面板在右边，符号不能写反）'
    );
    ok(/document\.body\.dataset\.resizing/.test(resizer), '契约：拖动期间挂 body[data-resizing]（禁选中 + 统一光标）');
    ok(/--tc-workspace-width/.test(resizer), '契约：宽度写进 CSS 变量（不靠每帧 setState 重渲染面板）');
    ok(/ArrowLeft|ArrowRight/.test(resizer), '契约：键盘也能改宽度（方向键，不只依赖鼠标）');
    ok(/onDoubleClick/.test(resizer), '契约：双击复位（拖坏了不用去设置里找）');
    ok(/absolute/.test(resizer) && /-ml-\[2px\]/.test(resizer), '契约：手柄绝对定位且不占布局宽度（否则面板与聊天区多一条缝）');
  }

  const prefs = readFileSync(path.join(root, 'src', 'uiPrefs.ts'), 'utf8');
  ok(/WORKSPACE_MIN|WORKSPACE_MAX/.test(prefs), '契约：宽度有上下限（否则能拖成一条线）');
  ok(/opc\.workspace-width/.test(prefs), '契约：宽度落盘到 localStorage（刷新后还在）');
  ok(/applyUiPrefs[\s\S]*applyWorkspaceWidth/.test(prefs), '契约：启动时首帧前就位（否则先 300 再跳变）');

  const panel = readFileSync(path.join(root, 'src', 'components', 'WorkspacePanel.tsx'), 'utf8');
  ok(
    /width:\s*'var\(--tc-workspace-width,\s*300px\)'/.test(panel),
    '契约：面板宽度读 CSS 变量，默认 300px'
  );
  ok(/<WorkspaceResizer \/>/.test(panel), '契约：面板里真的渲染了手柄');

  const header = readFileSync(path.join(root, 'src', 'components', 'ChatHeader.tsx'), 'utf8');
  const toggleAt = header.indexOf('onToggleWorkspace && (');
  const moreAt = header.indexOf('<details ref={moreRef}');
  const badgeAt = header.indexOf('<WorkspaceBadge');
  ok(toggleAt > 0 && moreAt > 0 && toggleAt < moreAt, '契约：工作区开关渲染在 ⋯ 之前（DOM 顺序即视觉左右）');
  ok(badgeAt > 0 && badgeAt < toggleAt, '契约：工作区徽标在开关左边（图标按钮成组，状态徽标在外）');
  // 只有一处开关：DOM 里出现两次就是复制粘贴留下来的影子控件
  ok((header.match(/onToggleWorkspace && \(/g) ?? []).length === 1, '契约：开关只渲染一次');
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
  const dataDir = mkdtempSync(path.join(tmpdir(), 'opc-a82-smoke-'));
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

/** 面板当前宽度（px）。读 aside 自己，不读 CSS 变量 —— 要验的是布局结果。 */
async function panelWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const aside = document.querySelector('aside[aria-label="工作区文件"]');
    return aside ? Math.round(aside.getBoundingClientRect().width) : -1;
  });
}

async function runSmoke() {
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

  const fixture = mkdtempSync(path.join(tmpdir(), 'opc-a82-fixture-'));
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
      body: JSON.stringify({ title: 'A82 冒烟', cwd: fixture }),
    });
    ok(!!session?.id, '冒烟：会话创建成功');
    if (!session?.id) throw new Error('会话没建出来');

    await appPage.goto(`${api}/chat/${session.id}`, { waitUntil: 'domcontentloaded' });
    await appPage.evaluate(() => {
      try { localStorage.setItem('opc.workspace-open', 'true'); } catch { /* 隐私模式 */ }
    });
    await appPage.reload({ waitUntil: 'domcontentloaded' });
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });
    // 面板打开依赖两件事：localStorage 读回来、以及会话的 cwd 就位。
    // 不猜时序 —— 先等，等不到就点一次栏头开关（与 a82-pty 同一个兜底，
    // 那里实测过光靠 localStorage 有时就是不灵）。
    const openPanel = async (timeout: number) => {
      try {
        await appPage.waitForSelector('aside[aria-label="工作区文件"]', { timeout });
        return true;
      } catch {
        const toggle = appPage.getByRole('button', { name: /展开工作区|收起工作区/ });
        if (await toggle.count()) {
          const pressed = await toggle.first().getAttribute('aria-pressed');
          if (pressed === 'false') await toggle.first().click();
        }
        await appPage.waitForSelector('aside[aria-label="工作区文件"]', { timeout: 20_000 });
        return true;
      }
    };
    await openPanel(10_000);

    /* ── 默认宽度 ── */
    const w0 = await panelWidth(appPage);
    ok(w0 === 300, '冒烟：默认宽度 300px（没拖过就不能是别的值）', `实测 ${w0}`);

    /* ── 拖拽：往左拖 120px，应变宽 ── */
    console.log('  · 拖手柄…');
    const handle = appPage.locator('[data-workspace-resizer]');
    await handle.waitFor({ timeout: 10_000 });
    const box = (await handle.boundingBox())!;
    const midY = box.y + box.height / 2;
    // 从手柄中点起手，往左 120px。指针事件必须是**连续**的几帧：
    // 一步跳到终点的话 pointermove 只发一次，capture 链路等于没测到。
    await appPage.mouse.move(box.x + box.width / 2, midY);
    await appPage.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await appPage.mouse.move(box.x + box.width / 2 - i * 10, midY);
      await SLEEP(16);
    }
    // 松手前先量一次：拖动过程中就要变宽，不能等松手才跳
    const during = await panelWidth(appPage);
    await appPage.mouse.up();
    await SLEEP(200);
    const w1 = await panelWidth(appPage);
    ok(w1 === 420, '冒烟：往左拖 120px 后面板变成 420px（方向没写反）', `拖动中 ${during} → 松手 ${w1}`);
    ok(during > w0, '冒烟：拖动过程中宽度就跟着变（不是松手才跳）', `${w0} → ${during}`);

    /* ── 落盘：刷新后还是 420 ── */
    await appPage.reload({ waitUntil: 'domcontentloaded' });
    await appPage.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 60_000 });
    await openPanel(15_000);
    const w2 = await panelWidth(appPage);
    ok(w2 === 420, '冒烟：刷新后宽度还在（localStorage 生效）', `实测 ${w2}`);

    /* ── 双击复位 ── */
    const handle2 = appPage.locator('[data-workspace-resizer]');
    const box2 = (await handle2.boundingBox())!;
    await appPage.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await SLEEP(200);
    const w3 = await panelWidth(appPage);
    ok(w3 === 300, '冒烟：双击手柄复位到 300px', `实测 ${w3}`);

    /* ── 键盘也能改 ── */
    await handle2.focus();
    await appPage.keyboard.press('ArrowLeft');
    await SLEEP(150);
    const w4 = await panelWidth(appPage);
    ok(w4 === 316, '冒烟：聚焦后按 ← 变宽 16px（不只依赖鼠标）', `实测 ${w4}`);
    await appPage.keyboard.press('ArrowRight');
    await SLEEP(150);
    const w5 = await panelWidth(appPage);
    ok(w5 === 300, '冒烟：按 → 变回 300px（两个方向都在）', `实测 ${w5}`);

    /* ── 按钮位置：开关紧贴 ⋯ 左侧 ── */
    const geom = await appPage.evaluate(() => {
      const toggle = document.querySelector('button[aria-label="收起工作区"], button[aria-label="展开工作区"]');
      const summary = document.querySelector('summary[aria-label="更多操作"]');
      if (!toggle || !summary) return null;
      const t = toggle.getBoundingClientRect();
      const s = summary.getBoundingClientRect();
      return { toggleRight: t.right, toggleLeft: t.left, summaryLeft: s.left };
    });
    ok(!!geom, '冒烟：开关与 ⋯ 都渲染出来了');
    if (geom) {
      const gap = geom.summaryLeft - geom.toggleRight;
      ok(
        geom.toggleRight <= geom.summaryLeft + 1 && gap < 16,
        '冒烟：开关紧贴 ⋯ 的左侧（同一类图标按钮成组）',
        `间距 ${Math.round(gap)}px`
      );
    }

    /* ── 面板内容没被手柄压住：文件树第一行还能点到 ── */
    const clickable = await appPage.evaluate(() => {
      const aside = document.querySelector('aside[aria-label="工作区文件"]');
      const resizer = document.querySelector('[data-workspace-resizer]');
      if (!aside || !resizer) return false;
      const a = aside.getBoundingClientRect();
      const r = resizer.getBoundingClientRect();
      // 手柄只该盖住左边缘那 5px，面板内容区必须还在它右边
      return r.right <= a.left + 4;
    });
    ok(clickable, '冒烟：手柄只覆盖左边缘，不压住面板内容');
  } catch (e) {
    let pageDump = '';
    try {
      const page = harness?.contexts().flatMap(c => c.pages())[0];
      if (page) {
        pageDump = await page.evaluate(() => {
          const aside = document.querySelector('aside');
          return [
            `url=${location.href}`,
            `aside=${aside ? '有' : '无'}`,
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
