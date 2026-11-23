/**
 * 过程面板四态的浏览器闸门（2026-11-22 二轮改版）。
 *
 * 钉的是用户能看见的六件事：
 *   [1] 右停靠时输入框不跨过面板（真实几何，不靠 class 猜测）；
 *   [2] 十字箭头把手已删除，形态切换收敛为一个主图标 + 展开菜单；
 *   [3] 吸顶步骤条按数量伸缩，少则拉开、多则保底 96px 后滚动；
 *   [4] 浮动形态没有空态提示，也没有底部滑杆；点步骤仍有详情；
 *   [5] 任意形态可拖，落点决定形态（右缘 / 上沿 / 中间）；
 *   [6] 最小化胶囊可拖、可点开、运行中有一条轻量 live 指示。
 *
 * 全部走真实鼠标坐标（page.mouse），不用 force / 事件派发。
 * 运行：node scripts/verify-process-panel-ui.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromePath } from './lib/chrome.mjs';

const DIST = join(process.cwd(), 'dist');
const CHROME = resolveChromePath();
const PROBE = process.argv.includes('--probe-old');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let total = 0;
const failures = [];
function ok(cond, label, detail) {
  total += 1;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const NOW = new Date().toISOString();
const T0 = 1_700_000_000_000;
const AGENTS = [{
  id: 'a1', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
  color: '#0EC8A9', description: 'x', capabilities: ['chat'],
  status: { availability: 'ready', version: '1' },
}];
const MODELS = [{ modelId: 'm1', name: 'Hy4 (free)' }];

function makeSession(cfg) {
  const blocks = Array.from({ length: cfg.count }, (_, i) => ({
    id: `b${i}`,
    type: 'tool',
    toolId: `t${i}`,
    name: i % 3 === 0 ? 'bash' : 'read',
    input: { description: `step-${i}` },
    status: 'completed',
    startedAt: T0 + i * 1000,
    endedAt: T0 + i * 1000 + 500,
  }));
  const session = {
    id: 's1', title: '过程面板测试', agent_id: 'a1', model: 'm1', kind: 'chat',
    project_id: null, cwd: '', created_at: NOW, updated_at: NOW, dangling: null,
  };
  const messages = [
    { id: 'u1', role: 'user', content: '跑一轮测试', created_at: NOW },
    {
      id: 'a1', role: 'assistant', content: '', created_at: NOW,
      blocks, isStreaming: cfg.streaming === true,
    },
  ];
  return { session, messages };
}

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = join(DIST, p);
  let body;
  try {
    body = await readFile(file);
  } catch {
    file = join(DIST, 'index.html');
    body = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

// 运行态 streaming 只在「本轮由本端发起」时为真，刷新后的历史消息按设计不带这个标记；
// 因此 live 指示钉静态契约：两个形态各有一处 + 有动画 + reduced-motion 有静态退化。
console.log('\n[0] live 指示静态契约');
const panelSrc = readFileSync(join(process.cwd(), 'src/components/ProcessPanel.tsx'), 'utf8');
const panelCss = readFileSync(join(process.cwd(), 'src/trace/processPanel.css'), 'utf8');
ok((panelSrc.match(/data-panel-live/g) ?? []).length >= 2, '胶囊与面板头部各有一处 live 指示');
ok(/@keyframes pf-live-scan/.test(panelCss), 'live 扫描动画已定义');
ok(
  /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.pf-live::after[\s\S]*?animation:\s*none/.test(panelCss),
  'reduced-motion 下 live 动画静态退化'
);

async function open(cfg = {}) {
  const { session, messages } = makeSession({ count: cfg.count ?? 4, streaming: cfg.streaming });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const prefs = cfg.mode
    ? { processPanel: { mode: cfg.mode, lastMode: cfg.mode === 'minimized' ? 'right' : cfg.mode } }
    : {};
  await ctx.addInitScript(p => { window.__OPC_PREFS__ = p; }, prefs);
  await ctx.route('**/api/**', route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) return json({ runs: [] });
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (url.includes('/api/verify/commands')) return json({ cwd: null, projectTypes: [], commands: [], notes: [] });
    if (url.includes('/api/verify/results')) return json({ verifications: [] });
    if (url.includes('/api/files/evidence')) return json({ cwd: null, items: [], summary: { total: 0, landed: 0, notLanded: 0, other: 0, alarm: null } });
    if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ session, project: null, messages, dangling: null });
    if (/\/api\/sessions/.test(url)) return json({ sessions: [session] });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-process-panel]', { timeout: 15000 });
  await page.waitForTimeout(250);
  return { ctx, page, errors };
}

const close = async h => { await h.ctx.close(); };
const rect = async (page, sel) => page.locator(sel).first().evaluate(el => {
  const b = el.getBoundingClientRect();
  return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
});
const mode = async page => page.locator('[data-process-panel]').first().getAttribute('data-panel-mode');

// ── [1] 右停靠：输入框与面板不重叠 ────────────────────────────────
{
  console.log('\n[1] 右停靠几何与形态图标');
  const h = await open();
  const { page } = h;
  ok(await mode(page) === 'right', '页面打开后默认右停靠');
  ok((await page.locator('.pf-pill').count()) === 0, '红框里的完成胶囊已删');
  ok((await page.locator('[data-flow][data-flow-pill]').count()) > 0, '状态仍留在数据属性上给闸门读');
  const input = await rect(page, '.tcv2-inputwrap');
  const panel = await rect(page, '[data-process-panel]');
  ok(input.width > 400 && panel.width > 200, '输入区与面板都真实渲染', `input=${Math.round(input.width)} panel=${Math.round(panel.width)}`);
  ok(panel.left >= input.right - 1, '输入框没有跨过过程面板', `panel.left=${Math.round(panel.left)} input.right=${Math.round(input.right)}`);
  ok(await page.locator('.pf-panel-grip').count() === 0, '十字箭头拖动把手已删除');
  if (PROBE) {
    await page.evaluate(() => {
      const hd = document.querySelector('[data-panel-drag]');
      const old = document.createElement('button');
      old.className = 'pf-panel-grip';
      old.setAttribute('aria-label', 'Move');
      hd?.prepend(old);
    });
    ok(await page.locator('.pf-panel-grip').count() === 0, '反向探针：退回十字把手必须判红');
    console.log('  ⚠ --probe-old：已把旧拖动把手插回标题栏');
  }
  ok(await page.locator('[data-panel-drag]').count() === 1, '标题栏仍是唯一可拖区域');
  ok(await page.locator('[data-panel-mode-main]').count() === 1, '形态收敛为一个主图标');
  ok(await page.locator('[data-panel-mode-btn]').count() === 0, '默认不展开形态菜单');
  ok((await page.locator('[data-panel-detail]').count()) === 0, '右停靠也不摆空态提示');
  ok((await page.locator('[data-panel-seek]').count()) === 0, '右停靠没有底部滑杆');
  await page.locator('[data-panel-mode-main]').click();
  ok(await page.locator('.pf-mode-menu [data-panel-mode-btn]').count() === 4, '点主图标展开四项形态菜单');
  const menuRect = await rect(page, '.pf-mode-menu');
  const menuVisible = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return !!el && !!el.closest('.pf-mode-menu');
  }, { x: menuRect.left + 20, y: menuRect.top + 12 });
  ok(menuVisible, '菜单真能被鼠标命中（portal 没被 overflow 裁掉）', JSON.stringify(menuRect));
  await page.locator('[data-panel-mode-btn="top"]').click();
  ok(await mode(page) === 'top', '菜单里切吸顶真的生效');
  ok(h.errors.length === 0, '这一轮没有页面异常', h.errors.slice(0, 2).join(' | '));
  await close(h);
}

// ── [1b] 右吸附拖到中间 → 浮动 ────────────────────────────────────
{
  console.log('\n[1b] 右吸附 → 自由浮动');
  const h = await open();
  const { page } = h;
  const head = await rect(page, '[data-panel-drag]');
  await page.mouse.move(head.left + head.width / 2, head.top + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(600, 300, { steps: 10 });
  ok(await page.locator('[data-panel-drop-hint]').count() === 1, '拖动时有落点提示');
  if (PROBE) {
    // 反向探针：把小标签退回旧版整屏虚线框，下面必须判红
    await page.addStyleTag({
      content: '.pf-drop-hint { top:132px !important; left:48px !important; right:48px !important; bottom:132px !important; width:auto !important; height:auto !important; border:1px dashed !important; }',
    });
  }
  const hintBox = await rect(page, '[data-panel-drop-hint]');
  const small = hintBox.width < 220 && hintBox.height < 40;
  ok(small, '落点提示是小标签而非巨大虚线框（探针退回旧大框必须判红）', `${Math.round(hintBox.width)}x${Math.round(hintBox.height)}`);
  const hintText = await page.locator('[data-panel-drop-hint]').innerText();
  ok(/自由浮动/.test(hintText), '小标签写明松手后的形态', hintText);
  await page.mouse.up();
  await page.waitForTimeout(200);
  ok(await mode(page) === 'floating', '右吸附拖到中间松手 → 浮动', `实际 ${await mode(page)}`);
  await close(h);
}

// ── [2] 吸顶步骤条响应式 ──────────────────────────────────────────
for (const count of [4, 14]) {
  console.log(`\n[2] 吸顶步骤条（${count} 步）`);
  const h = await open({ mode: 'top', count });
  const { page } = h;
  const metrics = await page.locator('.pf-dock-top .pf-panel-axis').evaluate(axis => {
    const rows = [...axis.querySelectorAll('.pf-panel-row')];
    return {
      widths: rows.map(r => Math.round(r.getBoundingClientRect().width)),
      client: axis.clientWidth,
      scroll: axis.scrollWidth,
    };
  });
  ok(metrics.widths.length === count, `${count} 行都渲染了`, `实际 ${metrics.widths.length}`);
  const w = metrics.widths[0] ?? 0;
  if (count === 4) {
    ok(w >= 120, '步骤少时步骤条被拉宽', `w=${w}`);
    ok(metrics.scroll <= metrics.client + 1, '步骤少时不需要横向滚动');
  } else {
    ok(w >= 90 && w <= 130, '步骤多时保底宽度但仍可读', `w=${w}`);
    ok(metrics.scroll > metrics.client, '步骤多时容器可横向滚动', `${metrics.scroll}>${metrics.client}`);
  }
  ok(await page.locator('[data-panel-seek]').count() === 0, '吸顶没有底部滑杆');
  // 吸顶必须紧贴会话头下边缘：data-chat-page 的顶边就是 header 底边
  const pageTop = await page.locator('[data-chat-page]').evaluate(el => el.getBoundingClientRect().top);
  const topRect = await rect(page, '.pf-dock-top');
  ok(topRect.top - pageTop <= 8, '吸顶紧贴会话头下边缘', `gap=${Math.round(topRect.top - pageTop)}`);
  await close(h);
}

// ── [2b] 吸顶菜单可见 + 吸顶拖到右侧 → 右吸附 ─────────────────────
{
  console.log('\n[2b] 吸顶菜单与吸顶 → 右吸附');
  const h = await open({ mode: 'top' });
  const { page } = h;
  await page.locator('[data-panel-mode-main]').click();
  const r = await rect(page, '.pf-mode-menu');
  const visible = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return !!el && !!el.closest('.pf-mode-menu');
  }, { x: r.left + 20, y: r.top + 12 });
  ok(visible, '吸顶形态点图标后菜单真的可见', JSON.stringify(r));
  await page.keyboard.press('Escape');
  const head = await rect(page, '[data-panel-drag]');
  await page.mouse.move(head.left + head.width / 2, head.top + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(1430, 250, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  ok(await mode(page) === 'right', '吸顶拖到右缘松手 → 右吸附', `实际 ${await mode(page)}`);
  await close(h);
}

// ── [3] 浮动：无空态提示 / 无滑杆 / 可拖到中间 ────────────────────
{
  console.log('\n[3] 浮动形态');
  const h = await open({ mode: 'floating' });
  const { page } = h;
  ok(await page.locator('[data-panel-seek]').count() === 0, '浮动形态没有底部滑杆');
  ok(await page.locator('[data-panel-detail]').count() === 0, '浮动形态不摆空态详情框');
  const hint = await page.locator('[data-process-panel]').innerText();
  ok(!hint.includes('悬停或点击左侧时间轴'), '浮动面板里没有那句常驻提示');
  await page.locator('[data-panel-row]').first().click();
  ok(await page.locator('[data-panel-detail]').count() === 1, '点步骤后详情框仍会出现');
  const before = await rect(page, '[data-process-panel]');
  const head = await rect(page, '[data-panel-drag]');
  await page.mouse.move(head.left + head.width / 2, head.top + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(600, 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await rect(page, '[data-process-panel]');
  ok(Math.abs(after.left - before.left) > 80, '标题栏拖动真的移动了面板', `${Math.round(before.left)}→${Math.round(after.left)}`);
  ok(await mode(page) === 'floating', '拖到中间松手保持浮动');
  await close(h);
}

// ── [4] 最小化胶囊：点击还原 / 三处落点 / live 指示 ────────────────
{
  console.log('\n[4] 最小化胶囊');
  const h = await open({ mode: 'minimized' });
  const { page } = h;
  const pill = await rect(page, '[data-process-panel]');
  await page.mouse.click(pill.left + pill.width / 2, pill.top + pill.height / 2);
  await page.waitForTimeout(150);
  ok(await mode(page) === 'right', '轻点胶囊还原到右停靠（不被误判成拖动）');
  await close(h);
}

for (const [target, expect] of [
  [{ x: 1420, y: 250 }, 'right'],
  [{ x: 1300, y: 250 }, 'minimized'],
  [{ x: 600, y: 90 }, 'minimized'],
  [{ x: 600, y: 300 }, 'minimized'],
]) {
  console.log(`\n[4] 胶囊拖到 (${target.x},${target.y}) → ${expect}`);
  const h = await open({ mode: 'minimized' });
  const { page } = h;
  const pill = await rect(page, '[data-process-panel]');
  await page.mouse.move(pill.left + pill.width / 2, pill.top + pill.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  ok(await mode(page) === expect, `落点切到 ${expect}`, `实际 ${await mode(page)}`);
  const moved = await rect(page, '[data-process-panel]');
  ok(Math.abs(moved.left - pill.left) > 40 || Math.abs(moved.top - pill.top) > 40,
    `拖动确实移动了胶囊位置（${expect}）`, `${Math.round(pill.left)},${Math.round(pill.top)}→${Math.round(moved.left)},${Math.round(moved.top)}`);
  await close(h);
}

// ── [5] 设置模态期间：过程面板不许浮到弹窗上 ──────────────────────
{
  console.log('\n[5] 设置模态遮住过程面板');
  ok(
    /body:has\(\[data-settings-modal\]\) \[data-process-panel\]/.test(panelCss)
      && /body:has\(\[data-settings-modal\]\) \.pf-mode-menu/.test(panelCss),
    '隐藏规则同时覆盖四形态面板与形态菜单'
  );

  for (const modeCfg of ['top', 'right', 'floating', 'minimized']) {
    console.log(`\n[5] 设置模态 · ${modeCfg}`);
    const h = await open({ mode: modeCfg });
    const { page } = h;
    // A37：设置是浮在会话上的模态，ChatPage 仍在下面渲染。
    // 必须点 UI 入口走 SPA 导航 —— 直接 goto('/settings') 会丢掉会话 state，
    // 面板根本不渲染，那条「隐藏」断言就会假绿。
    await page.getByRole('button', { name: /设置|settings/i }).first().click();
    await page.waitForSelector('[data-settings-modal]', { timeout: 15000 });
    await page.waitForTimeout(200);

    // 肯定式：先证明设置弹窗真的开了，避免「整页没打开」让隐藏断言假绿
    const dialog = await rect(page, '[data-settings-panel]');
    ok(dialog.width > 300 && dialog.height > 200, '设置弹窗确实打开', `${Math.round(dialog.width)}x${Math.round(dialog.height)}`);
    ok(await page.locator('[data-process-panel]').count() === 1, `${modeCfg}：面板仍在 DOM，只藏显示不删状态`);

    if (PROBE) {
      // 反向探针：撤掉隐藏规则，下面的断言必须变红
      await page.addStyleTag({ content: 'body:has([data-settings-modal]) [data-process-panel] { display: revert !important; }' });
    }
    const hidden = await page.locator('[data-process-panel]').first().evaluate(el => {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return cs.display === 'none' || (b.width === 0 && b.height === 0);
    });
    ok(hidden, `${modeCfg}：面板在设置模态期间不可见（探针撤销隐藏必须判红）`);

    if (modeCfg === 'top' && !PROBE) {
      const hit = await page.evaluate(() => {
        const el = document.elementFromPoint(720, 100);
        return !!el && !!el.closest('[data-process-panel]');
      });
      ok(!hit, '吸顶原位置用真实鼠标坐标自证不再命中面板');
    }
    await close(h);
  }
}

await browser.close();
server.close();
console.log(`\n过程面板浏览器断言：${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 右停靠不重叠、形态菜单、响应式步骤条、浮动精简与全形态拖动均符合预期');
