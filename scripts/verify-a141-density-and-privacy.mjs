/**
 * A141 验证：① 权限模式菜单图标过大 ② 模型选框宽度自适应 ③ 隐私页重设计 + 遥测删除。
 *
 * ## 为什么这一棒先量再改
 *
 * 用户给的是三张缩小截图，本项目已因此误判过四次（A134 / A136 / P0-2 / A139）。
 * 所以先跑只读探针（`.tmp/probe-icons-chips.mjs`、`.tmp/probe-a141-perm.mjs`、
 * `.tmp/probe-a141-namewidth.mjs`、`.tmp/probe-a141-chevron.mjs`），实测结论：
 *
 *   ① 权限菜单里的 `<svg>` 渲染成 **24×24**（lucide 默认），压在 13px 的标签旁边，
 *      行高被撑到 36px —— 用户说「明显太大」是真的。
 *   ② 模型芯片固定 `w-[140px]`：`Auto` 的名字只占 27.8px（112px 空气），
 *      `DeepSeek-V4.1-Flash (sg)` 只分到 96px 被截断 —— 两头都不对。
 *   ③ 模型浮层 272px 时最长行 `nameTruncated: true`，且倍率被挤到
 *      `multRight: 32`（选中行的 ✓ 与倍率挤在一起）。
 *   ④ 输入区四处 `suffixIcon={<ChevronDown />}` 全是 24px —— 与 ① 同一类问题。
 *   ⑤ 隐私页还在讲「匿名使用统计」并给一个开关，而端点默认是空的：
 *      等于给用户一个**永远不会生效的开关**，比不给更误导。
 *
 * ## 反向探针
 *
 * `--probe-old` 用注入样式/节点把五处改动全部退回旧版（24px 图标、140px 芯片、
 * 272px 浮层、加回统计开关、去掉点星卡），断言必须变红。
 * 源码契约那一段（遥测文件已删）**不可探针**——它读的是磁盘上的文件，
 * 运行时改不动；这一段靠「直接读源码」本身成立，不需要探针。
 *
 * 运行：node scripts/verify-a141-density-and-privacy.mjs [--probe-old]（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check', 'a141');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROBE = process.argv.includes('--probe-old');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const failures = [];
let total = 0;
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const AGENTS = [{
  id: 'a1', name: 'WorkBuddy', vendor: 'v', kind: 'sdk', icon: 'workbuddy',
  color: '#0EC8A9', description: 'x', capabilities: ['chat'],
  status: { availability: 'ready', version: '1' },
}];

/**
 * 三档真实名字 + 一个病态长的名字。
 *
 * 前三个取自 `data/model-catalog.json` 的实测宽度（塞进真实 DOM 量的，不是估算）：
 *   Auto 27.8px / Hy3 22.5px / DeepSeek-V4.1-Flash (sg) 146.2px
 * 芯片固定开销实测 34px（左右内边距 16 + gap 4 + 箭头 14）。
 * 第四个是人造的超长名：真实清单里最宽的是 `DeepSeek V4 Flash Vision Exp`
 * = 170.7px，连它也不该被省略，所以「上限与省略」只能靠人造名字来验。
 */
const MODELS = [
  { modelId: 'm-short', name: 'Auto', providerName: 'Anthropic', multiplier: '0.00x', tag: '免费' },
  { modelId: 'm-mid', name: 'Hy3', providerName: 'Z.AI', multiplier: '0.30x', tag: '限时免费' },
  { modelId: 'm-long', name: 'DeepSeek-V4.1-Flash (sg)', providerName: 'OpenCode', multiplier: '0.03x', tag: '付费' },
];
const OVERFLOW_MODEL = {
  modelId: 'm-overflow',
  name: 'DeepSeek-V4.1-Flash-Vision-Extended-2026-Pro',
  providerName: 'OpenCode', multiplier: '0.05x', tag: '付费',
};

const SESSION = {
  id: 's1', title: '测试会话', agent_id: 'a1', model: 'm-short', kind: 'chat',
  project_id: null, cwd: '', created_at: new Date().toISOString(),
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    let file = join(DIST, p);
    let body;
    try { body = await readFile(file); }
    catch { file = join(DIST, 'index.html'); body = await readFile(file); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newPage({ models = MODELS } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) return json({ runs: [] });
    if (/\/api\/agents\/custom/.test(url)) return json({ agents: [] });
    if (/\/api\/agent-credentials/.test(url)) return json({ credentials: [] });
    if (/\/api\/agents(\/|$)/.test(url) && !/probe/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/memory/.test(url)) return json({ core: '', user: '', skills: [], budget: { used: 0, limit: 800 } });
    if (/\/api\/permission-rules/.test(url)) return json({ rules: [] });
    if (/\/api\/models/.test(url)) return json({ models });
    if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });
    if (/\/api\/projects/.test(url)) return json({ projects: [] });
    if (/\/api\/check-login/.test(url)) return json({ isLoggedIn: false, envConfigured: false, cliConfigured: false, envVars: {} });
    if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ session: SESSION, messages: [] });
    if (/\/api\/sessions/.test(url)) return json({ sessions: [SESSION] });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}

/**
 * 反向探针：把五处改动退回旧版。
 *
 * 用 `!important` 注入样式而不是删节点 —— 芯片宽度、浮层宽度、图标尺寸
 * 都是**计算样式**决定的，删掉 class 不一定回得去；直接钉死旧数值最可靠。
 * 统计开关与点星卡是节点层面的东西，用 MutationObserver 持续补/删，
 * 避免「扫描时还没渲染」的假绿（A139 踩过一次）。
 */
async function applyProbe(page) {
  if (!PROBE) return;
  await page.addStyleTag({
    content: `
      [data-permission-mode-select] svg, .permission-select-popup svg { width:24px !important; height:24px !important; }
      [data-model-trigger] { width:140px !important; max-width:140px !important; }
      [data-model-popup] { width:272px !important; }
      [data-model-trigger] svg, [data-permission-mode-select] .t-input__suffix svg { width:24px !important; height:24px !important; }
    `,
  });
  await page.evaluate(() => {
    /* 还原「菜单展开时叠着一块 tooltip」的旧版结果。
       `disabled` 是编译进 bundle 的 JSX 属性，运行时改不回去 ——
       所以这里直接造一块同款浮层（同样 pointer-events:none，与真实实现一致），
       用来证明「可见 tooltip 数 === 0」这条断言确实会因为它的存在而变红，
       而不是一条永远绿的摆设。 */
    const tip = document.createElement('div');
    tip.className = 't-popup t-tooltip';
    tip.style.cssText = 'position:fixed;left:40px;top:40px;width:180px;height:32px;background:#fff;pointer-events:none;z-index:9999;';
    document.body.appendChild(tip);

    const patch = () => {
      document.querySelectorAll('[data-about-star]').forEach(el => el.remove());
      /* 2026-10-29：第三方许可区也一起摘。
         不摘的话，新加的 6 条断言在探针下依然全绿 —— 就证明不了它们有区分力，
         而「区块被顺手删掉」正是这 6 条要防的那种退化。 */
      document.querySelectorAll('[data-about-licenses]').forEach(el => el.remove());
      const host = document.querySelector('[data-about-privacy]');
      if (host && !host.querySelector('.t-switch')) {
        const s = document.createElement('div');
        s.className = 't-switch';
        s.textContent = '允许发送匿名统计';
        host.appendChild(s);
      }
    };
    patch();
    new MutationObserver(patch).observe(document.body, { childList: true, subtree: true });
  });
  console.log('  ⚠️ --probe-old：六处改动已退回旧版，下面的断言应当变红\n');
}

/** 进入会话（输入区只有选中会话后才渲染） */
async function gotoSession(page) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.locator('[data-conversation-item="s1"]').click();
  /**
   * 2026-10-29：这里原来是固定 `waitForTimeout(900)`，赌「900ms 内会话页渲染完」。
   *
   * 赌输的形态是 [6] 段两条 `undefinedpx` 假红：`path` 已经是 `/chat/s1`（点击成功了），
   * 但 `document.querySelector('[data-model-trigger]')` 返回 null —— React 还没把
   * 输入区提交上去。用同一段单独跑 6 次全部量到 14px，说明**不是产品缺陷**，
   * 而是「跑完整条脚本时机器更忙，900ms 不够」。
   *
   * 改成等元素真的出现。等不到就照旧红（不能因为等待失败就放行）——
   * 所以 `catch` 里什么都不做，交给后面的断言去判。
   */
  await page.waitForSelector('[data-model-trigger]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  await applyProbe(page);
}

async function gotoAbout(page) {
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
  await page.locator('[data-settings-section="about"]').first().click();
  await page.waitForTimeout(500);
  await applyProbe(page);
}

// ══════════ [1] 源码契约：代码里确实不再收集任何信息 ══════════
console.log('\n[1] 源码契约：遥测链路已整体删除');
{
  const gone = await access(join(ROOT, 'electron/analytics.ts'), FS.F_OK).then(() => false, () => true);
  ok(gone, 'electron/analytics.ts 已不存在（不是留着不引用）');

  const main = await readFile(join(ROOT, 'electron/main.ts'), 'utf8');
  // 先剥注释再判：注释里写「analytics」不构成收集能力，
  // 但把注释里的字当成实现来判会把「已删」误报成「还在」。
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const mainCode = strip(main);
  ok(!/analytics/i.test(mainCode), 'main.ts 代码里没有 analytics 引用（注释已剥离）');
  ok(!/TELEMETRY|install_id|session\/start/.test(mainCode), 'main.ts 没有上报端点或安装 ID 的痕迹');
  ok(!/ipcMain\.handle\('opc:analytics/.test(mainCode), 'main.ts 不再注册 opc:analytics-* IPC');

  const preload = await readFile(join(ROOT, 'electron/preload.cjs'), 'utf8');
  const preloadCode = strip(preload);
  ok(!/analytics/i.test(preloadCode), 'preload 不再向前端暴露统计接口');

  // 全仓扫一遍：只要还有一处引用，说明删得不干净
  const { execSync } = await import('node:child_process');
  let hits = '';
  try {
    hits = execSync(
      'grep -rIl "opc:analytics\\|TELEMETRY_ENDPOINT" src electron server 2>/dev/null || true',
      { encoding: 'utf8' }
    ).trim();
  } catch { hits = ''; }
  ok(hits === '', '全仓无 opc:analytics / TELEMETRY_ENDPOINT 残留', hits || '无');
}

// ══════════ [2] 权限菜单：图标回到 14px，与 13px 标签成比例 ══════════
console.log('\n[2] 权限模式菜单：图标 14px，不再压过标签');
{
  const { ctx, page, errors } = await newPage();
  await gotoSession(page);

  const triggerIcon = await page.locator('[data-permission-mode-select] svg').first().evaluate(el => {
    const b = el.getBoundingClientRect();
    return +b.width.toFixed(1);
  });
  ok(triggerIcon === 14, '触发器内的模式图标是 14px', `${triggerIcon}px`);

  await page.locator('[data-permission-mode-select] .t-select').first().click();
  await page.waitForTimeout(600);

  const rows = await page.locator('.permission-select-popup .t-select-option').evaluateAll(els => els.map(el => {
    const svg = el.querySelector('svg');
    const b = el.getBoundingClientRect();
    const label = [...el.querySelectorAll('span')].find(s => s.textContent.trim() && !s.querySelector('svg'));
    const lb = label ? label.getBoundingClientRect() : null;
    const slot = svg ? svg.parentElement.getBoundingClientRect() : null;
    return {
      text: el.textContent.trim().replace(/\s+/g, ' '),
      rowH: +b.height.toFixed(1),
      svgW: svg ? +svg.getBoundingClientRect().width.toFixed(1) : null,
      svgH: svg ? +svg.getBoundingClientRect().height.toFixed(1) : null,
      slotW: slot ? +slot.width.toFixed(1) : null,
      labelPx: label ? parseFloat(getComputedStyle(label).fontSize) : null,
      labelW: lb ? +lb.width.toFixed(1) : null,
    };
  }));

  ok(rows.length === 4, '菜单四档都在（否则下面的逐项断言是空转）', `${rows.length} 行`);
  for (const r of rows) {
    ok(r.svgW === 14 && r.svgH === 14, `「${r.text}」图标 14×14`, `${r.svgW}×${r.svgH}`);
  }
  // 判据不是「等于 14」而是「不比标签大」—— 换字号时这条仍然成立
  const worst = rows.reduce((a, r) => Math.max(a, r.labelPx ? r.svgW / r.labelPx : 0), 0);
  ok(worst <= 1.15, '图标不超过标签字号的 1.15 倍', `最大比值 ${worst.toFixed(2)}`);
  /* 行高这条原先是 `≤40`，但 24px 图标下量出来也是 36（行高由 TDesign 的
     选项内边距决定，不是图标撑的）—— 新旧两版都绿，等于没守。
     换成「图标不许溢出它所在的槽位」：槽位是 `w-5 h-5` = 20px，
     24px 的图标正好溢出 4px，这才是用户看到的「太挤/太大」的直接成因。 */
  const overflow = rows.filter(r => r.slotW && r.svgW > r.slotW + 0.5);
  ok(overflow.length === 0, '图标不溢出所在的 20px 槽位',
    overflow.length ? overflow.map(r => `${r.text}:${r.svgW}>${r.slotW}`).join(',') : '全部在槽内');

  /* 菜单展开时不许叠 tooltip。
     旧版这里是一块「每次操作都需要确认」的浮层，位置与菜单同为「触发器上方」，
     把第四档「全放行」整块盖住。`pointer-events: none` 只保证点得到，
     看不见仍然是缺陷 —— 所以判据是「有没有可见的 tooltip」，不是「点不点得到」。 */
  const tipVisible = await page.evaluate(() => [...document.querySelectorAll('.t-popup.t-tooltip')]
    .filter(el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.01 && r.width > 0 && r.height > 0;
    }).length);
  ok(tipVisible === 0, '菜单展开时不叠 tooltip（旧版会盖住第四档）', `${tipVisible} 块可见 tooltip`);

  // 第四档必须真的露出来：量它的矩形有没有被挤出浮层
  const last = await page.locator('.permission-select-popup .t-select-option').last().evaluate(el => {
    const r = el.getBoundingClientRect();
    const popup = el.closest('.t-popup').getBoundingClientRect();
    return {
      text: el.textContent.trim(),
      insidePopup: r.top >= popup.top - 0.5 && r.bottom <= popup.bottom + 0.5,
      h: +r.height.toFixed(1),
    };
  });
  ok(last.insidePopup && last.h > 20, '最后一档「' + last.text + '」完整落在浮层内', `h=${last.h}`);
  const labelsIntact = rows.every(r => r.labelW > 20);
  ok(labelsIntact, '四档标签文字都完整渲染（图标没有挤掉文字）',
    rows.map(r => `${r.text}:${r.labelW}`).join(' / '));

  await page.screenshot({ path: join(OUT, PROBE ? 'probe-perm-menu.png' : 'perm-menu.png') }).catch(() => {});
  ok(errors.length === 0, '控制台无错误', errors.length ? JSON.stringify(errors.slice(0, 2)) : '');
  await ctx.close();
}

// ══════════ [3] 模型芯片：短名收紧、真实长名完整、病态长名才省略 ══════════
console.log('\n[3] 模型芯片宽度随名字自适应');
{
  const { ctx, page } = await newPage({ models: [...MODELS, OVERFLOW_MODEL] });
  await gotoSession(page);

  const measure = () => page.locator('[data-model-trigger]').evaluate(el => {
    const b = el.getBoundingClientRect();
    const nameEl = el.querySelector('span.truncate');
    const nb = nameEl.getBoundingClientRect();
    return {
      w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      nameW: +nb.width.toFixed(1),
      truncated: nameEl.scrollWidth > nameEl.clientWidth + 1,
      text: nameEl.textContent,
      title: el.getAttribute('title'),
    };
  });

  const pick = async id => {
    await page.locator('[data-model-trigger]').click();
    await page.waitForTimeout(350);
    await page.locator(`[data-model-id="${id}"]`).click();
    await page.waitForTimeout(350);
    return measure();
  };

  const auto = await pick('m-short');
  const hy3 = await pick('m-mid');
  const long = await pick('m-long');
  const over = await pick('m-overflow');

  ok(auto.h === 32 && over.h === 32, '芯片高度恒为 32（与右侧选择器同高）', `${auto.h} / ${over.h}`);
  ok(auto.w >= 56 && auto.w <= 82, '短名 `Auto` 收紧到 56–82px（旧版固定 140）', `${auto.w}px`);
  ok(hy3.w >= 56 && hy3.w <= 80, '短名 `Hy3` 也收紧', `${hy3.w}px`);
  ok(long.w >= 175 && long.w <= 186, '真实长名按内容展开到约 180px', `${long.w}px`);
  ok(long.truncated === false, '真实长名 `DeepSeek-V4.1-Flash (sg)` 完整显示（旧版 140 时被截断）');
  ok(over.w >= 207 && over.w <= 209, '病态长名顶到 208px 上限（不是无限长）', `${over.w}px`);
  ok(over.truncated === true, '病态长名才省略，完整名仍在 title 里', `title=${JSON.stringify(over.title)}`);
  ok(over.title === OVERFLOW_MODEL.name, 'title 是完整模型名（悬停可看全）');
  ok(over.w - auto.w >= 100, '长短名宽度差 ≥ 100px —— 真的是内容驱动，不是固定值',
    `${auto.w} → ${over.w}`);
  ok(auto.text === 'Auto' && long.text === 'DeepSeek-V4.1-Flash (sg)', '芯片文本就是模型名本身');

  await page.screenshot({ path: join(OUT, PROBE ? 'probe-chip.png' : 'chip.png') }).catch(() => {});
  await ctx.close();
}

// ══════════ [4] 模型浮层：300px 下最长行不截断，✓ 与倍率不打架 ══════════
console.log('\n[4] 模型浮层 300px：最长行完整、倍率右对齐一致');
{
  const { ctx, page } = await newPage();
  await gotoSession(page);

  // 先选中长名那一行，让 ✓ 出现在最长行上 —— 那是最挤的情况
  await page.locator('[data-model-trigger]').click();
  await page.waitForTimeout(350);
  await page.locator('[data-model-id="m-long"]').click();
  await page.waitForTimeout(350);

  await page.locator('[data-model-trigger]').click();
  await page.waitForTimeout(450);
  const panel = await page.locator('[data-model-popup]').boundingBox();
  ok(Math.abs(panel.width - 300) <= 1, '浮层宽 300px', `${panel.width.toFixed(1)}px`);

  const rows = await page.locator('[data-model-popup] [role="option"]').evaluateAll(els => els.map(el => {
    const b = el.getBoundingClientRect();
    const name = el.querySelector('span.truncate');
    const check = el.querySelector('svg');
    const mult = [...el.querySelectorAll('span')].find(s => /x$/.test(s.textContent.trim()));
    const cb = check ? check.getBoundingClientRect() : null;
    const mb = mult ? mult.getBoundingClientRect() : null;
    return {
      id: el.getAttribute('data-model-id'),
      selected: el.getAttribute('data-model-row') === '1',
      rowW: +b.width.toFixed(1),
      nameTruncated: name ? name.scrollWidth > name.clientWidth + 1 : null,
      hasCheck: !!cb,
      multRight: mb ? +(b.right - mb.right).toFixed(1) : null,
      checkOverlapsMult: cb && mb ? cb.left < mb.right - 0.5 : null,
    };
  }));

  ok(rows.length === 3, '三行都在', `${rows.length} 行`);
  const bad = rows.filter(r => r.nameTruncated);
  ok(bad.length === 0, '所有行模型名完整显示（272px 时最长行是截断的）',
    bad.length ? bad.map(r => r.id).join(',') : '全部完整');

  const selected = rows.find(r => r.selected);
  ok(!!selected, '长名那一行确实处于选中态（否则下面的 ✓ 断言是空转）', selected?.id || '');
  ok(selected?.hasCheck === true, '选中行有 ✓');
  ok(selected?.checkOverlapsMult === false, '✓ 与倍率不重叠', `重叠=${selected?.checkOverlapsMult}`);

  const unselected = rows.filter(r => !r.selected);
  const rights = unselected.map(r => r.multRight);
  const spread = Math.max(...rights) - Math.min(...rights);
  ok(spread <= 0.5, '未选中行的倍率右边界一致（右对齐没被长名字挤歪）',
    rights.map(v => `${v}`).join(' / '));
  ok(unselected.every(r => r.rowW <= panel.width - 8), '行宽不超过面板内宽',
    `${unselected[0]?.rowW} ≤ ${(panel.width - 8).toFixed(1)}`);

  await page.screenshot({ path: join(OUT, PROBE ? 'probe-popup.png' : 'popup.png') }).catch(() => {});
  await ctx.close();
}

// ══════════ [5] 隐私页：不再有开关，说清「不收集」，给出入口与点星 ══════════
console.log('\n[5] 关于与隐私：无统计开关、有承诺、有入口、有点星');
{
  const { ctx, page, errors } = await newPage();
  await gotoAbout(page);

  const panel = page.locator('[data-about-privacy]');
  ok((await panel.count()) === 1, '隐私承诺卡存在');

  const switches = await page.locator('[data-about-privacy] .t-switch').count();
  ok(switches === 0, '隐私卡里没有统计开关（没有可关的东西，就不该给开关）', `${switches} 个`);

  const body = await page.locator('[data-settings-panel]').last().innerText();
  ok(/不收集任何信息/.test(body), '明说「不收集任何信息」');
  ok(!/允许发送匿名统计/.test(body), '旧文案「允许发送匿名统计」已消失');
  /* 2026-10-29：原先这里断言「逐项否认统计/埋点/崩溃上报」那段文案存在。
     用户要求整段删除，原因是它的后半句「全部代码在 GitHub 公开，可自行核验」
     **兑现不了**（本仓远端 private，点进去 404）。
     于是断言从「文案在」翻转成「不实承诺不在」——
     否定式必须配肯定式（本函数上面的 `/不收集任何信息/`、下面的 `/只存在本机/`，
     以及 `[data-about-privacy]` 的 count 断言），否则「整张隐私卡被删掉」也会绿。 */
  ok(!/GitHub 公开/.test(body), '不再声称「代码在 GitHub 公开可核验」（仓库 private，兑现不了）');
  ok(/你自己配置的模型服务商/.test(body), '说清了唯一会离开本机的东西是什么');
  /* 中文标点前多一格空白，是 JSX 换行折叠成空格的典型产物 ——
     肉眼在缩略图上根本看不出来，只有取文本才抓得到。 */
  ok(!/服务商\s+，/.test(body), '标点没有被 JSX 换行折叠出的空格顶开');
  ok(/只存在本机/.test(body), '给「数据在哪」一个明确答案');

  // 入口：href 必须是真地址，不能是占位
  const links = await page.locator('[data-about-link]').evaluateAll(els => els.map(el => ({
    key: el.getAttribute('data-about-link'),
    href: el.getAttribute('href'),
    target: el.getAttribute('target'),
    rel: el.getAttribute('rel'),
  })));
  const site = links.find(l => l.key === 'site');
  const gh = links.find(l => l.key === 'github');
  ok(!!site && site.href === 'https://github.com/catex-lab/opc-agent', '官网入口指向 catex-lab', site?.href || '缺失');
  ok(!!gh && gh.href === 'https://github.com/catex-lab/opc-agent', 'GitHub 入口指向真实仓库', gh?.href || '缺失');
  ok(links.every(l => l.target === '_blank'), '入口都在新窗口打开（交给系统浏览器）');
  ok(links.every(l => (l.rel || '').includes('noreferrer')), '外链带 rel=noreferrer');

  // 点星卡
  const star = page.locator('[data-about-star]');
  ok((await star.count()) === 1, '点星引导卡存在');
  const starText = (await star.count()) ? await star.innerText() : '';
  ok(/点个星|点星/.test(starText), '文案明确引导点星', starText.replace(/\s+/g, ' ').slice(0, 40));
  ok(/不收费|不收集/.test(starText), '说明了「为什么值得支持」，不是空喊');

  /* 下面每条都先判「在不在」再取值。
     反向探针会把整张点星卡摘掉 —— 直接 getAttribute 会抛 30s 超时，
     脚本崩在半路，后面那些该红的断言根本没机会跑（假绿的另一种形态）。 */
  const cta = page.locator('[data-about-star-cta]');
  const ctaCount = await cta.count();
  ok(ctaCount === 1, '点星主按钮存在');
  const ctaHref = ctaCount ? await cta.getAttribute('href') : null;
  ok(ctaHref === 'https://github.com/catex-lab/opc-agent', '主按钮跳到仓库页', ctaHref || '缺失');
  const fb = page.locator('[data-about-feedback]');
  const fbHref = (await fb.count()) ? await fb.getAttribute('href') : null;
  ok(fbHref === 'https://github.com/catex-lab/opc-agent/issues', '反馈按钮跳到 issues', fbHref || '缺失');

  /* 能不能被点到：按项目纪律用真实坐标 + elementFromPoint 自证，
     不许 force:true。点星卡在滚动区底部，必须先滚进视口再量。 */
  let hit = { inViewport: false, hitSelf: false, hitTag: '缺失', size: '缺失' };
  if (ctaCount === 1) {
    await cta.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    hit = await cta.evaluate(el => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
        hitSelf: !!top && (el === top || el.contains(top)),
        hitTag: top ? `${top.tagName.toLowerCase()}.${(top.className || '').toString().split(' ')[0]}` : 'null',
        size: `${r.width.toFixed(0)}×${r.height.toFixed(0)}`,
      };
    });
  }
  ok(hit.inViewport, '点星按钮滚进视口后完整可见');
  ok(hit.hitSelf, '点星按钮中心点真的命中它自己', `命中 ${hit.hitTag}`);
  ok(/^\d+×32$/.test(hit.size), '点星按钮是 32px 高的标准按钮', hit.size);

  // 底部那张（点星卡）单独留一张：评审时「顶部/底部」两张才拼得出整页
  if (ctaCount === 1) {
    await page.screenshot({ path: join(OUT, PROBE ? 'probe-about-bottom.png' : 'about-bottom.png') }).catch(() => {});
  }

  /* 截图前先回到顶部：`scrollIntoViewIfNeeded` 会把内容区滚到底，
     拍出来的图里看不到标题与应用信息卡 —— 评审图缺半页等于没拍。
     ⚠️ 滚动容器**不是** `[data-settings-panel]`（那是内容块本身），
     而是它外面那层 `.tc-scroll-fade`。第一版对着 panel 设 scrollTop=0
     什么也没发生，截图依旧少半页 —— 所以这里按「第一个真的能滚的祖先」找。 */
  await page.evaluate(() => {
    const host = document.querySelector('[data-about-privacy]');
    let el = host?.parentElement;
    while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
    if (el) el.scrollTop = 0;
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, PROBE ? 'probe-about.png' : 'about.png') }).catch(() => {});

  /* ── 第三方许可：MIT 署名义务的落点 ──
     这一块删掉不会有任何功能症状，只有法务意义上少了一条声明。
     正因为「删了也不报错」，才必须有断言钉住它 —— 否则下一次重构顺手
     把「关于」页精简掉，没人会发现安装包里的署名义务已经落空。
     判据按**包名**逐个点名，不按条目数量：数量对而内容错是最常见的假绿。 */
  const lic = page.locator('[data-about-licenses]');
  const licCount = await lic.count();
  ok(licCount === 1, '第三方许可区存在');

  // 用 textContent 而非 innerText：<details> 未展开时 innerText 是空串，
  // 拿它判会得到「断言通过」而实际什么都没读到（假绿）。
  const licText = licCount ? await lic.evaluate(el => el.textContent || '') : '';
  ok(/第三方许可/.test(licText), '标题写明「第三方许可」');
  ok(/不在本项目的 MIT 范围内/.test(licText), '说明这些组件不在本项目 MIT 范围内');

  /* 两类都要点名（A149）：
     ① `dependencies` —— 原样进 app.asar；
     ② 前端 devDependencies 里被 Vite 内联进 dist 的那些。
     只查第 ① 类曾经是这块的真实缺口：清单和页面都「有」，但漏了
     react / tdesign / lucide 这一大块 —— 而那才是安装包里跑得最多的代码。 */
  const REQUIRED_PKGS = [
    'Electron', '@tencent-ai/agent-sdk', 'express', 'node-pty', 'uuid', 'typescript',
    'react / react-dom', 'tdesign-react', '@tdesign-react/chat',
    'lucide-react', 'react-router-dom', '@xterm/xterm',
  ];
  const missingPkgs = REQUIRED_PKGS.filter(n => !licText.includes(n));
  ok(missingPkgs.length === 0, '两类随包分发的组件都点名了（后端依赖 + 前端打包）', missingPkgs.join(', ') || `全部 ${REQUIRED_PKGS.length} 个在列`);

  const missingLic = ['MIT', 'Apache-2.0'].filter(l => !licText.includes(l));
  ok(missingLic.length === 0, '标注了实际许可类型（MIT / Apache-2.0）', missingLic.join(', ') || '都有');
  ok(/THIRD-PARTY-LICENSES\.txt/.test(licText), '指向含传递依赖的完整清单文件');

  /* 单独留一张评审图：这一区在页面最底部，about.png（滚回顶部那张）拍不到它。
     展开后再拍 —— 折叠状态下只能看到一个 summary，看不出条目排版是否正常。 */
  if (licCount === 1) {
    await lic.evaluate(el => {
      el.open = true;
      el.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(300);
    await page
      .screenshot({ path: join(OUT, PROBE ? 'probe-about-licenses.png' : 'about-licenses.png') })
      .catch(() => {});
  }

  ok(errors.length === 0, '控制台无错误', errors.length ? JSON.stringify(errors.slice(0, 2)) : '');
  await ctx.close();
}

// ══════════ [6] 输入区箭头统一 14px ══════════
console.log('\n[6] 输入区四颗选择器的箭头统一 14px');
{
  const { ctx, page } = await newPage();
  await gotoSession(page);

  const sizes = await page.evaluate(() => {
    const out = {};
    const chip = document.querySelector('[data-model-trigger]');
    if (chip) {
      const s = chip.querySelector('svg');
      out.modelChip = s ? +s.getBoundingClientRect().width.toFixed(1) : null;
    }
    const perm = document.querySelector('[data-permission-mode-select]');
    if (perm) {
      const s = perm.querySelector('.t-input__suffix svg') || perm.querySelectorAll('svg')[1];
      out.permission = s ? +s.getBoundingClientRect().width.toFixed(1) : null;
    }
    return out;
  });
  ok(sizes.modelChip === 14, '模型芯片箭头 14px', `${sizes.modelChip}px`);
  ok(sizes.permission === 14, '权限选择器箭头 14px', `${sizes.permission}px`);

  // 其余两颗（生图模型 / 尺寸、思考强度）只在特定条件下渲染，
  // 用源码契约兜住：这个文件里不允许再出现无 size 的 ChevronDown。
  const src = await readFile(join(ROOT, 'src/components/ChatInput.tsx'), 'utf8');
  const bare = (src.match(/suffixIcon=\{<ChevronDown\s*\/>\}/g) || []).length;
  ok(bare === 0, '源码里没有「无 size 的 suffixIcon 箭头」（24px 默认值）', `${bare} 处`);

  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${total - failures.length}/${total} 通过${PROBE ? '（反向探针模式）' : ''}`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  · ${f}`);
}
console.log(`截图目录：${OUT}`);
process.exit(failures.length ? 1 : 0);
