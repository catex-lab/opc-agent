/**
 * 窗口级玻璃（应用本体透出桌面）验证。
 *
 * ## 为什么单独一个脚本
 *
 * `verify:native-theme` 量的是**像素**：PrintWindow 抓到的按钮落点区是不是
 * 我们的框架面。窗口级玻璃开启后，那块的最终颜色 = 半透明框架面叠在
 * **桌面**上 —— 桌面壁纸不在脚本控制范围内，断言固定 RGB 只会得到
 * 「今天壁纸是浅色所以过了」的假绿灯。所以那边强制 `OPC_GLASS=0`，
 * 玻璃这条链路由本脚本负责。
 *
 * ## 验什么（每一层都要有证据，不靠自我声明）
 *
 *   [1] 主进程确实走了 acrylic 分支（日志 + 加载地址带 `?glass=1`）
 *   [2] 渲染进程认了这个标记（`data-opc-glass`），并且**表面色真的变半透明**
 *       （读元素实际计算出来的 backgroundColor，而不是源码里写的字面量）
 *   [3] body 透明（否则上面所有半透明表面都白调）
 *   [3b] 设置页滑动条：一个数字同时驱动框架面、内容面与标题条，0–100 真线性
 *   [4] 阅读面（--tc-surface-raised）也参与透明度，但仍是最实的一档（A25）
 *   [5] 切深色后：框架面变 rgba(27,27,27,.72)，标题条走 rail rgba(35,35,35,.72)（A94）
 *   [6] 三个窗口按钮由页面画（A24）：数量、尺寸、与标题条同属一个 DOM
 *
 * ## A24：标题条不再有例外
 *
 * A23 时标题条被强制实色，因为三个窗口按钮由系统画、控件区底色永远是实色
 * （系统侧背板 ≈240 vs 页面侧 ≈226，除 alpha=1 之外无解），标题条只能不透明
 * 才能与它严丝合缝。A24 改成 `frame: false` + 自绘按钮之后，这个矛盾消失了：
 * 标题条与按钮同属页面，于是它们**必须一起变透**，否则滑动条拉到 100 时
 * 顶上会留一条实色带 —— 那正是用户要的「0 到 100 的真调整」。
 *
 * ## 它验不了什么（如实写在这里）
 *
 * 桌面**看起来**是什么样、模糊够不够 —— PrintWindow 抓不到（实测系统字形
 * 占比 0%），只能人眼看（用 scripts/capture-window.mjs 屏幕实拍）。
 *
 * 运行：node scripts/verify-window-glass.mjs（需先 npm run electron:build）
 * ⚠️ 本机不能同时开着另一个 OPC Agent 实例（单实例锁会让新进程直接退出）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9334;
const EXTRA_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', `--remote-debugging-port=${PORT}`];

const results = [];
const ok = (cond, name, extra = '') => {
  results.push({ pass: !!cond, name });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  [${extra}]` : ''}`);
};

/** 取打包版 exe：默认最新 release-*，避免拿旧包测出绿结果 */
function exeFromArgs() {
  const arg = process.argv[2];
  if (arg) return arg;
  return (
    readdirSync('.', { withFileTypes: true })
      .filter(d => d.isDirectory() && /^release/.test(d.name))
      .map(d => path.join(d.name, 'win-unpacked', 'OPC Agent.exe'))
      .filter(p => existsSync(p))
      .map(p => ({ p, t: statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.p ?? null
  );
}

const EXE = exeFromArgs();
if (!EXE) {
  console.error('✗ 找不到打包版，先 npm run electron:build');
  process.exit(2);
}
console.log(`测试对象: ${EXE}`);

/**
 * 子进程环境：两个宿主变量必须 delete（`X: undefined` 删不掉，见
 * verify-native-theme 里 childEnv 的注释）。
 * 这里**不**设 OPC_GLASS —— 要测的就是默认行为。
 */
const env = { ...process.env, OPC_SAFE_GRAPHICS: '1', OPC_USER_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'opc-glass-')) };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPC_GLASS;

let child = null;
let browser = null;

/** 读一个 CSS 令牌，拆成 [r,g,b,a] */
function parseColor(s) {
  const t = String(s).trim();
  const hex = t.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const nums = (t.match(/[\d.]+/g) || []).map(Number);
  return nums.length >= 4 ? nums : [...nums, 1];
}

let buf = '';

/**
 * 等 Chromium 自己报出 CDP 端口，而不是死等我们请求的那个端口。
 *
 * `--remote-debugging-port` 只是**请求**：端口被占（上一轮刚杀的进程还在
 * TIME_WAIT、或别的实例没退干净）时 Chromium 会换随机端口继续跑，并打印
 * `DevTools listening on ws://...`。死连原端口只会得到 ECONNREFUSED，
 * 误判成「应用没起来」。
 */
async function cdpEndpoint(fallback) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) return m[1];
    await new Promise(r => setTimeout(r, 150));
  }
  return fallback;
}

try {
  console.log(`\n[1] 启动打包版（CDP :${PORT}）`);
  child = spawn(EXE, EXTRA_ARGS, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  buf = '';
  child.stdout.on('data', d => (buf += String(d)));
  child.stderr.on('data', d => (buf += String(d)));

  browser = await chromium.connectOverCDP(await cdpEndpoint(`http://127.0.0.1:${PORT}`), {
    timeout: 30000,
  });
  const page = browser.contexts().flatMap(c => c.pages())[0];
  ok(!!page, 'CDP 连上并拿到渲染进程页面', page?.url() ?? 'n/a');
  await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 30000 });
  // 等首帧的过渡走完再量：body 上还挂着 `transition`（文字色），
  // 刚加载时读到的可能是插值中的颜色，会量出一个「半透明的白」
  await SLEEP(700);

  // ── [1] 主进程：真的开了 acrylic，并且把标记带进了加载地址 ──
  ok(/窗口玻璃 acrylic 开启/.test(buf), '主进程走了 acrylic 分支（不是降级成不透明窗）');
  ok(/\?glass=1/.test(page.url()), '加载地址带 ?glass=1（首帧之前就位，不会先闪实色）', page.url());

  // ── [2] 渲染进程：标记 + 表面色真的半透明 ──
  // 读**实际用到的**颜色（元素的 backgroundColor），不读自定义属性：
  // `--tc-surface-chrome` 现在是一串 `rgb(... / var(--opc-chrome-alpha))`，
  // getPropertyValue 拿到的是未替换的原文，解析出来的数字只能靠巧合对上。
  const vars = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = n => cs.getPropertyValue(n).trim();
    const bgOf = sel => getComputedStyle(document.querySelector(sel)).backgroundColor;
    return {
      marked: document.documentElement.dataset.opcGlass,
      chromeAlphaVar: read('--opc-chrome-alpha'),
      contentAlphaVar: read('--opc-content-alpha'),
      raised: read('--tc-surface-raised'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      // A26 起 body 不再是纯透明，而是垫了一层极薄的中性 veil。
      // ⚠️ `--tc-veil-alpha` 的计算值是 `calc(.16 * calc(1 - 0.72))` 这种
      // 字符串，不能直接 Number()。用一个临时元素把它渲染成实际颜色再读。
      veilBg: (() => {
        const d = document.createElement('div');
        d.style.backgroundColor = 'var(--tc-veil)';
        document.body.appendChild(d);
        const c = getComputedStyle(d).backgroundColor;
        d.remove();
        return c;
      })(),
      titlebarBg: bgOf('[data-titlebar]'),
      navBg: bgOf('nav'),
    };
  });
  ok(vars.marked === '1', '<html data-opc-glass="1"> 已打标记', String(vars.marked));

  const nav = parseColor(vars.navBg);
  const raised = parseColor(vars.raised);
  ok(Math.abs(nav[3] - 0.72) < 0.02, '框架面半透明（alpha≈0.72）', vars.navBg);
  ok(Number(vars.chromeAlphaVar) === 0.72, '框架面 alpha 变量 = 0.72', vars.chromeAlphaVar);
  // 内容面 = 框架面 × 1.14（默认档 0.72 → 0.821），不是「加 0.1 个点」：
  // 加法在 100% 时会留下 0.1 的余量，滑动条就变成「拉到底还剩一层」。
  ok(
    Math.abs(Number(vars.contentAlphaVar) - 0.821) < 0.002,
    '内容面 alpha 变量 ≈ 0.821（按比例比框架面实一档）',
    vars.contentAlphaVar
  );
  // A25：抬升面（气泡 / 输入框 / 卡片）从「永远实色」改成**一起变透**。
  // 用户的反馈是「毛玻璃要全局，包括本体、消息卡片、内容卡片」——
  // 那些实色卡片在滑动条拉高时会变成整屏最跳的几块。
  ok(
    raised[3] > 0.8 && raised[3] < 1,
    '阅读面（--tc-surface-raised）已参与透明度（A25 起不再是实色例外）',
    vars.raised
  );
  // 但顺序不能乱：抬升面必须比内容面更实，否则卡片会「陷」进消息区
  ok(
    raised[3] > Number(vars.contentAlphaVar),
    '抬升面仍是最实的一档（比内容面实，层级没被拉平）',
    `${raised[3]} vs ${vars.contentAlphaVar}`
  );

  // ── 标题条：A24 起**跟着一起透**（它与自绘按钮同属一个 DOM）──
  const bar = parseColor(vars.titlebarBg);
  ok(
    bar[3] < 1 && Math.abs(bar[3] - 0.72) < 0.02,
    '标题条也参与透明度（不再有实色例外）',
    vars.titlebarBg
  );
  // A94：标题条改走 rail，底色从 #f5f5f5(245) 变成 #ececec(236)。
  // 顺带修掉一处**一直是红的关系**：下面那条「标题条与导航条计算值同源」
  // 在 A92 之后其实已经不自洽了（导航条 rail 236 / 标题条 chrome 245），
  // 只是 window-glass 只测打包版、那之后没重跑过，所以没人发现。
  ok(bar[0] === 236 && bar[1] === 236 && bar[2] === 236, '标题条底色 = 导航条 rail #ececec', vars.titlebarBg);
  // ⚠️ 这里**不能**断言令牌的字面原文是 `var(--tc-surface-chrome)`：
  //    getPropertyValue 在 Chrome 里会把自定义属性的值解析后再返回
  //    （实测拿到 `rgb(245 245 245 / 0.720)`，不是 var(...) 原文）。
  //    有意义的断言是「标题条与导航条的**实际计算值**完全一致」——
  //    这正说明它们同源（同一个令牌、同一个 alpha），而不是碰巧颜色接近。
  ok(
    vars.titlebarBg === vars.navBg,
    '标题条与导航条计算值同源（玻璃块不再给它单独覆盖实色）',
    `titlebar=${vars.titlebarBg} nav=${vars.navBg}`
  );

  // ── [3] body 必须让桌面透上来 ──
  //
  // ⚠️ 这条在 A26 之后改了结论：body 不再等于 `transparent`，而是垫了一层
  // 极薄的 veil（`--tc-veil`，默认档 ≈0.045）。veil 是「协调性」的机制 ——
  // 所有表面之下共享同一个底，块与块的色差被抹平（见 A26 / PLAN-A26.md）。
  //
  // 所以有意义的断言不是「alpha 恒等于 0」，而是两条：
  //   ① body 的 alpha 就是 veil 的设计值（说明没有别的东西偷偷盖上去）
  //   ② 它足够小（桌面仍然透得上来，而不是变成一块白板）
  {
    const body = parseColor(vars.bodyBg);
    const veil = parseColor(vars.veilBg);
    ok(
      Math.abs(body[3] - veil[3]) < 0.01,
      'body 的 alpha 就是 veil 的设计值（没有额外实色层）',
      `body=${vars.bodyBg} veil=${vars.veilBg}`
    );
    ok(body[3] > 0.02 && body[3] < 0.25, 'body 仍以透明为主（桌面透得上来）', vars.bodyBg);
  }

  // ── [3b] 设置页的滑动条：一个数字管整块界面，范围 0–100 ──
  // 用户要求「透明度控件要把标题栏和主内容纳入统一管理」+「0 到 100 的真调整」。
  // 这里把滑动条推到 100，断言**框架面、内容面、标题条一起归零**。
  //
  // ⚠️ 必须按 aria-label 定位，不能按 .tc-range：A29 在设置页加了
  // 「光斑大小 / 光斑亮度」两条滑杆，用的正是同一个 .tc-range 类
  // （与 TransparencySlider 同一条几何链）。按类定位会一次撞上 3 个元素，
  // Playwright strict mode 直接抛错。这个坑在 release-p31 上测不出来 ——
  // 那是个旧包，还没有光斑滑杆。
  // 主题卡片：优先 A37 的锚点，退回旧包的按钮文案（见下方注释）
const DARK_CARD = '[data-theme-option="dark"], button:has-text("固定深色")';

const TRANSPARENCY_RANGE = 'input[aria-label="界面透明度"]';
  await page.locator('button[title="设置"]').first().click();
  await page.waitForSelector(TRANSPARENCY_RANGE, { timeout: 15000 });
  const rangeMax = await page.locator(TRANSPARENCY_RANGE).getAttribute('max');
  ok(rangeMax === '100', '滑动条上限是 100（不是 A23 的 45）', String(rangeMax));

  await page.locator(TRANSPARENCY_RANGE).fill('100');
  await SLEEP(400);

  const maxed = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      chromeAlpha: cs.getPropertyValue('--opc-chrome-alpha').trim(),
      contentAlpha: cs.getPropertyValue('--opc-content-alpha').trim(),
      navBg: getComputedStyle(document.querySelector('nav')).backgroundColor,
      titlebarBg: getComputedStyle(document.querySelector('[data-titlebar]')).backgroundColor,
      tick: !!document.querySelector('[data-transparency-default]'),
      value: document.querySelector('input[aria-label="界面透明度"]')?.value,
    };
  });
  ok(maxed.value === '100', '滑动条推到 100%', String(maxed.value));
  ok(Number(maxed.chromeAlpha) === 0, '框架面 alpha 真的归零（0 到 100 是直线）', maxed.chromeAlpha);
  ok(Number(maxed.contentAlpha) === 0, '内容面 alpha 一起归零（不留余量）', maxed.contentAlpha);
  // A94：框架面与标题条都走 rail，100% 下计算值是 rgba(236,236,236,0)。
  ok(/rgba\(236, 236, 236, 0\)/.test(maxed.navBg), '导航条实际计算值全透', maxed.navBg);
  ok(
    /rgba\(236, 236, 236, 0\)/.test(maxed.titlebarBg),
    '标题条也归零（A24：不再有「标题条恒实色」的例外）',
    maxed.titlebarBg
  );
  ok(maxed.tick, '滑动条上有默认节点');

  // 中间档也要是线性的：50% → 0.5
  await page.locator(TRANSPARENCY_RANGE).fill('50');
  await SLEEP(300);
  const half = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--opc-chrome-alpha').trim()
  );
  ok(Number(half) === 0.5, '50% 处框架面 alpha = 0.5（线性，不是分段）', half);

  // 复位到默认，后面的深色断言基于默认值
  await page.locator(TRANSPARENCY_RANGE).fill('28');
  await SLEEP(300);

  // ── [4] 深色：框架面变深且仍是半透明，窗口控件底色一起走 ──
  // 兜底选择器：本脚本跑的是**打包产物**，包可能比源码旧
  // （A37 改了设置页但没重新打包，p39 里还没有 `data-theme-option`）。
  await page.waitForSelector(DARK_CARD, { timeout: 15000 });
  await page.locator(DARK_CARD).first().click();
  await SLEEP(900);

  const dark = await page.evaluate(() => ({
    navBg: getComputedStyle(document.querySelector('nav')).backgroundColor,
    titlebarBg: getComputedStyle(document.querySelector('[data-titlebar]')).backgroundColor,
  }));
  const darkNav = parseColor(dark.navBg);
  ok(Math.abs(darkNav[3] - 0.72) < 0.02, '深色下框架面同样半透明', dark.navBg);
  ok(darkNav[0] < 60, '深色下框架面确实是深色（不是把浅色值留在那儿）', dark.navBg);
  const darkBar = parseColor(dark.titlebarBg);
  // A94：标题条从 chrome 改走 rail，深色下计算值是 rgba(35,35,35,.72)
  // （rail #232323），不再是 chrome 的 rgba(27,27,27,.72)。
  // 这里仍要守住「与导航条同值同 alpha」—— 那正是 A94 的目的。
  ok(
    darkBar[3] < 1 && Math.abs(darkBar[3] - 0.72) < 0.02 && darkBar[0] === 35,
    '深色标题条 = rgba(35,35,35,.72)（与导航条 rail 同值同 alpha）',
    dark.titlebarBg
  );

  const themeLine = buf.split(/\r?\n/).filter(l => l.includes('[Theme]')).slice(-1)[0] ?? '';
  ok(/bg=#00000000/.test(themeLine), '窗口底色保持全透明（否则 acrylic 被整块盖住）', themeLine.trim());
  // A24：主进程不再画窗口控件，日志里明确写 caption=self ——
  // 这条断言的作用是「防止有人把 titleBarOverlay 加回来」：
  // 一旦加回来，系统会重新画一块永远实色的按钮区，透明度的 100% 立刻失效。
  ok(/caption=self/.test(themeLine), '窗口按钮由页面自绘（主进程不再画控件）', themeLine.trim());
  ok(
    !/overlay=/.test(buf),
    '日志里不再出现 overlay=（出现即说明又交还给系统画了）'
  );

  // ── [6] 三个窗口按钮：页面里真的有三块，且尺寸符合 Windows 规格 ──
  const caps = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-caption-button]')];
    return {
      count: btns.length,
      actions: btns.map(b => b.dataset.captionButton),
      width: btns[0] ? Math.round(btns[0].getBoundingClientRect().width) : 0,
      height: btns[0] ? Math.round(btns[0].getBoundingClientRect().height) : 0,
      barHeight: Math.round(document.querySelector('[data-titlebar]').getBoundingClientRect().height),
      inTitlebar: btns.every(b => !!b.closest('[data-titlebar]')),
    };
  });
  ok(caps.count === 3, '页面里有三个窗口按钮', String(caps.count));
  ok(
    caps.actions.join(',') === 'minimize,maximize,close',
    '顺序是 最小化/最大化/关闭',
    caps.actions.join(',')
  );
  ok(caps.width === 46, '按钮宽度 46px（Windows 规格）', String(caps.width));
  // 高度用容差：打包态 devicePixelRatio = 1.5，标题条 40px 在布局上被量成
  // 39.33px（见 verify-native-theme 里同样的处理）。差 0.7px 看不出来，
  // 要求整例会得到假失败。
  ok(
    Math.abs(caps.height - caps.barHeight) <= 2,
    '按钮高度占满标题条',
    `${caps.height}/${caps.barHeight}`
  );
  ok(caps.inTitlebar, '三个按钮都在标题条内（同一个 DOM，才能一起变透）');

  await SLEEP(200);
} catch (err) {
  ok(false, '脚本执行', String(err?.message ?? err).slice(0, 240));
} finally {
  try { await browser?.close(); } catch {}
  try { child?.kill(); } catch {}
}

const failed = results.filter(r => !r.pass).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
if (failed > 0) {
  console.error(`\n✗ ${failed} 项失败`);
  process.exit(1);
}
