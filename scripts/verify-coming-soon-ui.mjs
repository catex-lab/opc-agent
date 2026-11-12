/**
 * A210「即将接入」占位清单：浏览器级 UI 断言。
 *
 * ## 覆盖点（每条都「否定式配肯定式」，且先证明页面真的开了）
 *   [1] 页面真的开了：[data-get-agents] 存在 + body.innerText 含「获取 Agent」。
 *       —— 这条不绿，后面全部不可信。
 *   [2] 独立分组渲染：[data-coming-soon-group] 存在、行数 = 夹具条数、
 *       每行文本含 name / vendor / 「即将接入」或「规划中」。
 *   [3] 真 Agent 行仍按 isInstallable() 正常渲染（not-installed 夹具），
 *       证明新分组没把老功能挤掉。
 *   [4] 否定：占位行内没有 button / a / [data-get-agents-open] /
 *       InstallCard 的任何按钮 / 可聚焦控件；selectable 恒为 "0"。
 *       肯定对照：真 Agent 行里确实有 button（证明选择器不是全局失灵）。
 *   [5] 真实鼠标坐标 + elementFromPoint 自证：取第一行占位行中心点，先断言
 *       elementFromPoint 命中元素在行内且不是可交互控件，再 page.mouse.click，
 *       断言无导航 / 无新弹窗 / onClose 未调用 / __chatCalls 保持 0。
 *       —— 不用 force:true、不用 dispatchEvent。
 *   [6] 肯定式对照：点真 Agent 行的 [data-get-agents-open] 确实触发 onViewDetail，
 *       证明「点不到」不是整个弹窗被删掉 / 整体点不动。
 *   [7] 「已就绪 N / M」里的 M = agents.length，不等于
 *       agents.length + comingSoon.length。
 *
 * ## 运行方式
 *   正向：node scripts/verify-coming-soon-ui.mjs
 *   探针：node scripts/verify-coming-soon-ui.mjs --probe hide-group
 *         （夹具不传 comingSoon / 传空数组，模拟「分组被删」的回归；
 *           此时断言 [2] 等必须变红，脚本仍以退出码 0 结束并打印变红条数）
 *   不依赖 tsx loader；直接 node 运行。浏览器用 playwright-core 的 chromium，
 *   定位方式沿用仓库现有脚本（verify-focus-contract.mjs /
 *   verify-a128-permission-ui.mjs）里的硬编码 Chrome 路径，找不到再退
 *   channel:'chrome'；绝不擅自下载浏览器。
 *
 * ## 为什么用组件级渲染，而不是启动整套 App / 服务端 / 造全套 /api/** 夹具
 *   这条链路要验证的只是「GetAgentsDialog 收到 comingSoon 之后画成什么样、
 *   点下去会发生什么」。整套 App 会去对齐 /api/agents、/api/sessions、
 *   /api/models、/api/chat、/api/permission-response 等十几个接口的形状，
 *   任一夹具对不上就是「假红」，掩盖掉真正要验的 UI 契约。这里用 esbuild
 *   把真实 GetAgentsDialog（连同它的真实依赖）打成一个 IIFE 临时 bundle，
 *   挂到 window.__mount(props)，在测试页里直接注入夹具 props 渲染 ——
 *   只做组件级渲染，CSS 变量给一组兜底值即可，不依赖真实 index.css。
 *   临时产物只放 os.tmpdir()，脚本结束清理，不写进仓库。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// 用脚本自身位置推导项目根，避免依赖「必须从仓库根运行」这一隐含前提。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENT = join(ROOT, 'src', 'components', 'GetAgentsDialog.tsx').replace(/\\/g, '/');

// 现有两个验证脚本一致的 Chrome 定位方式。
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ---- 反向探针 ----------------------------------------------------------
const argv = process.argv.slice(2);
const probeIdx = argv.indexOf('--probe');
const PROBE = probeIdx >= 0 ? (argv[probeIdx + 1] || '') : null;
const HIDE_GROUP = PROBE === 'hide-group';

// ---- 夹具（纯展示数据，形状与 src/types.ts 的 ComingSoonAgent 对齐） ----
// 真 Agent：一条 not-installed + method:'npm'，isInstallable() 必为真，
// 于是会渲染进 [data-get-agents-group="npm"] 的 [data-get-agents-row]，
// 且因夹具传了 onViewDetail 会带 [data-get-agents-open] 按钮。
const AGENTS = [
  {
    id: 'fixture-cli',
    name: 'Fixture CLI',
    vendor: 'Fixture',
    kind: 'cli',
    capabilities: ['chat', 'code'],
    status: { availability: 'not-installed', installed: false, probedAt: '2026-01-01T00:00:00.000Z' },
    install: {
      method: 'npm',
      command: 'npm i -g fixture-cli',
      url: 'https://example.com/fixture-cli',
    },
  },
];

// 占位条目：覆盖两种 status（即将接入 / 规划中）与多种 tier。
const COMING_SOON = [
  { id: 'soon-acp', name: '未来一号', vendor: 'Alpha 厂', tier: 'acp', status: 'soon', reason: '正在对齐原生 ACP 协议', color: '#0052D9' },
  { id: 'soon-stream', name: '蓝图二号', vendor: 'Beta 厂', tier: 'stream-json', status: 'planned', reason: '规划中，尚未排期', color: '#0594FA' },
  { id: 'soon-eval', name: '评估三号', vendor: 'Gamma 厂', tier: 'evaluating', status: 'soon', reason: '正在评估接入成本', color: '#834EC2' },
];

// 探针下「不传 comingSoon」== 传空数组：组件默认 comingSoon=[]，分组不渲染。
const MOUNT_COMING_SOON = HIDE_GROUP ? [] : COMING_SOON;

// ---- 结果收集 ----------------------------------------------------------
const results = { total: 0, pass: 0, fail: [] };
function ok(cond, label, detail) {
  results.total++;
  if (cond) {
    results.pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    results.fail.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- 测试页：兜底 CSS 变量 + fetch 拦截 + 计数器 + __mountFixture -------
// 只给组件真实引用到的 CSS 变量一组可见兜底值（不依赖 index.css / Tailwind）。
// 注意真实组件用的是 --tc-mask-soft；同时给 --tc-mask-softmax 兜底以兼容
// 任务描述里的写法。刻意不补 Tailwind 的布局类：让内容按文档流静态铺开，
// 10 行以内全部落在视口内，elementFromPoint 的坐标才稳定可自证。
const TEST_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{
  --tc-mask-soft: rgba(0,0,0,.45);
  --tc-mask-softmax: rgba(0,0,0,.45);
  --tc-surface-raised: #ffffff;
  --tc-divider: #e5e5e5;
  --tc-edge: rgba(0,0,0,.045);
  --td-text-color-primary: #1f1f1f;
  --td-text-color-secondary: #666666;
  --td-text-color-placeholder: #999999;
  --td-bg-color-component: #f5f5f5;
  --td-warning-color: #b26a00;
  --font-mono: ui-monospace, Menlo, monospace;
  --text-secondary: 12px;
  --tc-status-ok: #00a870;
  --tc-status-warn: #ed7b2f;
  --tc-status-danger: #e34d59;
  --tc-status-muted: #999999;
  --tc-status-dot-ok: #00a870;
  --tc-cap-chat:#1f1f1f;--tc-cap-code:#1f1f1f;--tc-cap-write:#1f1f1f;
  --tc-cap-tools:#1f1f1f;--tc-cap-image:#1f1f1f;--tc-cap-search:#1f1f1f;
  --agent-logo-tile: #f0f0f0;
  --agent-logo-tile-ring: rgba(0,0,0,.1);
  --tc-logo-alpha: 1;
}
body{margin:0;font-family:system-ui,sans-serif;color:var(--td-text-color-primary);}
</style></head><body>
<div id="root"></div>
<script>
window.__chatCalls = 0;   // 拦截 /api/chat 的调用计数
window.__closed = 0;      // onClose 被调用次数
window.__viewDetail = []; // onViewDetail 收到的 id
var __origFetch = window.fetch;
window.fetch = function (input, init) {
  var url = (typeof input === 'string') ? input : ((input && input.url) || '');
  if (String(url).indexOf('/api/chat') !== -1) window.__chatCalls++;
  return __origFetch ? __origFetch.apply(window, arguments) : Promise.resolve(undefined);
};
// props 里的函数不能跨 evaluate 序列化，所以在页面里定义好，Node 只传数据。
window.__mountFixture = function (agents, comingSoon) {
  window.__mount({
    open: true,
    agents: agents,
    comingSoon: comingSoon,
    onClose: function () { window.__closed++; },
    onViewDetail: function (id) { window.__viewDetail.push(id); }
  });
};
</script>
</body></html>`;

// ---- esbuild 临时入口：把真实组件挂到 window.__mount ------------------
const ENTRY_SRC = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GetAgentsDialog } from '${COMPONENT}';
let root = null;
window.__mount = function (props) {
  if (!root) root = createRoot(document.getElementById('root'));
  root.render(React.createElement(GetAgentsDialog, props));
};
`;

const FIXTURE_DIR = await mkdtemp(join(tmpdir(), 'opc-coming-soon-'));
let browser = null;
let launchDesc = '';

try {
  const built = await build({
    stdin: {
      contents: ENTRY_SRC,
      resolveDir: ROOT,
      sourcefile: 'verify-coming-soon-entry.tsx',
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [join(ROOT, 'node_modules')],
    // agentLogos.ts 引入 svg / png 资源，沿用现有脚本的 dataurl loader。
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
    write: false,
    logLevel: 'silent',
  });
  const bundlePath = join(FIXTURE_DIR, 'bundle.js');
  await writeFile(bundlePath, built.outputFiles[0].text, 'utf8');

  // 与现有脚本一致：优先硬编码 executablePath，找不到再退 channel。
  if (existsSync(CHROME)) {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    launchDesc = `executablePath(${CHROME})`;
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    launchDesc = "channel:'chrome'";
  }
  console.log(`chromium 定位：${launchDesc}`);

  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  // 新页面 / popup 监听：在 newPage() 之后注册，避免把初始页面算进去。
  let newPages = 0;
  let popups = 0;
  context.on('page', () => { newPages++; });
  page.on('popup', () => { popups++; });

  await page.setContent(TEST_HTML, { waitUntil: 'load' });
  await page.addScriptTag({ path: bundlePath });

  // 真正挂载：函数留在页面端，只把可序列化的数据传进去。
  await page.evaluate(
    ({ agents, comingSoon }) => window.__mountFixture(agents, comingSoon),
    { agents: AGENTS, comingSoon: MOUNT_COMING_SOON }
  );
  // React 18 的 createRoot().render 是异步的，等弹窗真正出现再做断言。
  await page.waitForSelector('[data-get-agents]', { timeout: 10000 });
  await page.waitForTimeout(120);

  // ---- 一次性取回静态 DOM 事实 -----------------------------------------
  const dom = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const qa = s => [...document.querySelectorAll(s)];
    const rows = qa('[data-coming-soon-row]').map(r => ({
      id: r.getAttribute('data-coming-soon-row'),
      selectable: r.getAttribute('data-coming-soon-selectable'),
      text: r.innerText || r.textContent || '',
      buttons: r.querySelectorAll('button').length,
      anchors: r.querySelectorAll('a').length,
      opens: r.querySelectorAll('[data-get-agents-open]').length,
      installBits: r.querySelectorAll(
        '[data-install-card], [data-install-copy], [data-install-open],' +
        '[data-install-reprobe], [data-install-open-settings], [data-get-agents-reprobe]'
      ).length,
      focusable: r.querySelectorAll('[tabindex], input, select, textarea, [role="button"]').length,
    }));
    const agentRows = qa('[data-get-agents-row]').map(r => ({
      id: r.getAttribute('data-get-agents-row'),
      text: r.innerText || r.textContent || '',
      buttons: r.querySelectorAll('button').length,
      opens: r.querySelectorAll('[data-get-agents-open]').length,
    }));
    return {
      hasDialog: !!q('[data-get-agents]'),
      bodyText: document.body.innerText || '',
      hasSoonGroup: !!q('[data-coming-soon-group]'),
      rows,
      agentRows,
      countText: q('[data-get-agents-count]') ? q('[data-get-agents-count]').textContent : '',
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      url: location.href,
    };
  });

  // ---- [1] 先证明页面真的开了（这条不绿，后面全部不可信） --------------
  console.log('\n[1] 页面确实开了');
  ok(dom.hasDialog === true, '肯定式：[data-get-agents] 弹窗存在');
  ok(dom.bodyText.includes('获取 Agent'), '肯定式：body.innerText 含「获取 Agent」');

  // ---- [2] 独立占位分组渲染（探针 hide-group 下这一组必须变红） --------
  console.log('\n[2] 占位分组渲染');
  ok(dom.hasSoonGroup === true, '肯定式：[data-coming-soon-group] 独立分组存在');
  ok(
    dom.rows.length === COMING_SOON.length,
    `肯定式：[data-coming-soon-row] 数量 = 夹具 ${COMING_SOON.length} 条`,
    `实际 ${dom.rows.length}`
  );
  for (const fx of COMING_SOON) {
    const row = dom.rows.find(r => r.id === fx.id);
    ok(!!row && row.text.includes(fx.name), `肯定式：占位行 ${fx.id} 含 name「${fx.name}」`);
    ok(!!row && row.text.includes(fx.vendor), `肯定式：占位行 ${fx.id} 含 vendor「${fx.vendor}」`);
    ok(
      !!row && (row.text.includes('即将接入') || row.text.includes('规划中')),
      `肯定式：占位行 ${fx.id} 含「即将接入」/「规划中」`
    );
  }

  // ---- [3] 真 Agent 老功能没被挤掉 ------------------------------------
  console.log('\n[3] 真 Agent 行仍按 isInstallable() 渲染');
  ok(dom.agentRows.length >= 1, '肯定式：[data-get-agents-row] 仍渲染');
  ok(
    dom.agentRows.some(r => r.id === AGENTS[0].id && r.text.includes(AGENTS[0].name)),
    `肯定式：not-installed 夹具「${AGENTS[0].name}」出现在真 Agent 行`
  );

  // ---- [4] 否定式：占位行不可安装 + 肯定式对照 -------------------------
  console.log('\n[4] 占位行不可安装（否定式 + 肯定式对照）');
  const hasRows = dom.rows.length > 0;
  ok(hasRows && dom.rows.every(r => r.buttons === 0), '否定式：占位行内没有 <button>');
  ok(hasRows && dom.rows.every(r => r.anchors === 0), '否定式：占位行内没有 <a>');
  ok(hasRows && dom.rows.every(r => r.opens === 0), '否定式：占位行内没有 [data-get-agents-open]');
  ok(hasRows && dom.rows.every(r => r.installBits === 0), '否定式：占位行内没有 InstallCard 任何按钮');
  ok(hasRows && dom.rows.every(r => r.focusable === 0), '否定式：占位行内没有可聚焦控件 / role=button');
  ok(
    hasRows && dom.rows.every(r => r.selectable === '0'),
    '肯定式：data-coming-soon-selectable 恒为 "0"',
    dom.rows.map(r => r.selectable).join(',') || 'n/a'
  );
  ok(
    !dom.rows.some(r => r.selectable !== '0'),
    '否定式：没有任何占位行被标成可选（非 "0"）'
  );
  // 肯定式对照：证明上面「没有 button」不是因为整个页面根本没画按钮。
  ok(
    dom.agentRows.length > 0 && dom.agentRows.some(r => r.buttons > 0),
    '肯定式对照：真 Agent 行里确实有 <button>（选择器未全局失灵）',
    `真 Agent 行 button 数 ${dom.agentRows.map(r => r.buttons).join(',') || 'n/a'}`
  );

  // ---- [5] 真实鼠标坐标 + elementFromPoint 自证 ------------------------
  console.log('\n[5] 真实坐标 + elementFromPoint 自证（不用 force / dispatchEvent）');
  let box = null;
  if (dom.rows.length > 0) {
    box = await page.locator('[data-coming-soon-row]').first().boundingBox();
  }
  const cx = box ? box.x + box.width / 2 : 0;
  const cy = box ? box.y + box.height / 2 : 0;
  ok(!!box && box.width > 0 && box.height > 0, '肯定式：第一行占位行有真实 boundingBox', box ? `${Math.round(box.width)}x${Math.round(box.height)} @(${Math.round(cx)},${Math.round(cy)})` : 'n/a');

  let hit = null;
  if (box) {
    hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { found: false };
      const row = el.closest('[data-coming-soon-row]');
      const interactive = el.closest('button, a, input, select, textarea, [role="button"], [tabindex]');
      return {
        found: true,
        inRow: !!row,
        rowId: row ? row.getAttribute('data-coming-soon-row') : null,
        interactive: !!interactive,
        tag: el.tagName,
      };
    }, { x: cx, y: cy });
  }
  ok(!!hit && hit.found && hit.inRow, '肯定式：elementFromPoint 命中元素落在占位行内部', hit ? `${hit.tag}/${hit.rowId}` : 'n/a');
  ok(!!hit && hit.found && !hit.interactive, '否定式：命中元素不是 button/a/可聚焦控件', hit ? hit.tag : 'n/a');

  const urlBefore = page.url();
  const dialogBefore = dom.dialogCount;
  if (box) {
    await page.mouse.click(cx, cy); // 真实鼠标坐标点击
    await page.waitForTimeout(180);
  }
  const after = await page.evaluate(() => ({
    closed: window.__closed,
    chatCalls: window.__chatCalls,
    dialogCount: document.querySelectorAll('[role="dialog"]').length,
    url: location.href,
  }));
  ok(box ? after.chatCalls === 0 : false, '否定式：真实点击后 __chatCalls 保持 0', `实际 ${after.chatCalls}`);
  ok(box ? after.closed === 0 : false, '否定式：真实点击后 onClose 没被调用', `实际 ${after.closed}`);
  ok(box ? after.url === urlBefore : false, '否定式：没有发生导航', `${urlBefore} → ${after.url}`);
  ok(box ? after.dialogCount === dialogBefore : false, '否定式：没有新增弹窗（role=dialog）', `前 ${dialogBefore} / 后 ${after.dialogCount}`);
  ok(box ? (newPages === 0 && popups === 0) : false, '否定式：没有新页面 / popup', `page ${newPages} / popup ${popups}`);

  // ---- [6] 肯定式对照：真 Agent 行能点（放在 [5] 之后，避免污染 __closed）
  console.log('\n[6] 肯定式对照：点真 Agent 行确实触发回调');
  const openBtnCount = await page.locator('[data-get-agents-open]').count();
  ok(openBtnCount >= 1, '肯定式：真 Agent 行里 [data-get-agents-open] 按钮存在', `实际 ${openBtnCount}`);
  if (openBtnCount >= 1) {
    await page.locator('[data-get-agents-open]').first().click();
    await page.waitForTimeout(180);
  }
  const afterOpen = await page.evaluate(() => window.__viewDetail.slice());
  ok(
    afterOpen.includes(AGENTS[0].id),
    `肯定式：点真 Agent 行触发 onViewDetail(${AGENTS[0].id})`,
    `实际 ${JSON.stringify(afterOpen)}`
  );

  // ---- [7] 计数 M 只算 agents，不算 comingSoon ------------------------
  console.log('\n[7] 「已就绪 N / M」计数');
  const m = /已就绪\s*\d+\s*\/\s*(\d+)/.exec(dom.countText || '');
  const M = m ? Number(m[1]) : null;
  ok(M === AGENTS.length, `肯定式：M = agents.length (${AGENTS.length})`, `M=${M} / 文本「${(dom.countText || '').trim()}」`);
  ok(
    M !== null && M !== AGENTS.length + COMING_SOON.length,
    `否定式：M ≠ agents.length + comingSoon.length (${AGENTS.length + COMING_SOON.length})`,
    `M=${M}`
  );

  // ---- 控制台错误 ------------------------------------------------------
  console.log('\n[8] 控制台');
  const realErrors = consoleErrors.filter(e => !/favicon|Download the React DevTools/i.test(e));
  ok(realErrors.length === 0, '否定式：无控制台错误', realErrors.slice(0, 3).join(' | ') || '0');
} catch (err) {
  console.error('\n脚本异常：', (err && err.stack) || err);
  results.total++;
  results.fail.push(`脚本异常：${(err && err.message) || err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
}

// ---- 汇总 / 退出码 ------------------------------------------------------
console.log(`\n通过 ${results.pass} / 失败 ${results.fail.length} / 共 ${results.total}`);
if (HIDE_GROUP) {
  // 探针模式：允许有红，但必须确实有断言变红（否则说明探针没生效），退出码恒为 0。
  console.log(`探针生效：${results.fail.length} 条断言如期变红`);
  if (results.fail.length === 0) console.log('注意：没有任何断言变红，探针可能未生效');
  process.exit(0);
} else {
  if (results.fail.length) {
    console.log('失败项：');
    for (const f of results.fail) console.log(`  · ${f}`);
    process.exit(1);
  }
  process.exit(0);
}
