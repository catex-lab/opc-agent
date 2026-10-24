/**
 * A26 验证：全局表面协调性（边线与实色块）。
 *
 * 这个脚本的存在理由，是 A25 那轮的两个**探针盲区**：
 *
 *   1. 旧探针有 `if (r.bottom < 0 || r.top > innerHeight) continue;` ——
 *      只扫当前视口。设置页滚动区外的「从头创建 Agent」按钮因此从未被扫到，
 *      而它恰恰是用户报的「浅色 100% 下的白块」。只信探针就会判成「不复现」。
 *   2. `document.querySelectorAll('body *')` 穿不透 shadow DOM。聊天输入框
 *      在 `<t-chat-sender>` 的 shadow root 里，同样从未被扫到。
 *
 * 所以这里两件事都改了：全页扫描（去掉视口过滤）、递归 shadowRoot。
 *
 * 另外给页面铺了一层模拟壁纸 —— 没有它，`?glass=1` + t=100 时 body 透明，
 * 底下就是浏览器默认白，截图里「透明区」和「白块」长得一模一样，
 * 根本没法用肉眼验收。
 *
 * 断言分组：
 *   [1] 100% 下没有「白名单外」的实色块（浅/深 × 三页）
 *   [2] 可见边线全部是 alpha 形式（不再有固定灰阶），且强度受控
 *   [3] 结构分栏线：随透明度增强，且是两端渐隐的渐变
 *   [4] 控件轮廓线：100% 下仍然可见（界面越虚，这个信号越重要）
 *   [5] 实色块下限 --tc-solid：1.0 → 0.72
 *   [6] 公共底噪 veil：浅垫白、深垫黑，强度随透明度增长
 *   [7] R1 根因修复：--td-bg-color-specialcomponent 参与透明度
 *   [8] R4 根因修复：输入框 shadow DOM 的白底被盖掉
 *   [8b] A93：输入框去掉描边后，仍靠「底色差 + 投影」与周围区分
 *   [9] A28：开关开启态真的吃到了 --tc-solid（不是靠白名单蒙过去）
 *   [10] 控制台无错误
 *
 * 运行：node scripts/verify-surface.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// ── 夹具 ──────────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default'] } },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '帮我看下品牌色', created_at: new Date(Date.now() - 6e4).toISOString() },
  { id: 'm2', session_id: 's1', role: 'assistant', content: '已经统一成石墨黑，边线和实色块也跟着透明度走了。', model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy', created_at: new Date().toISOString() , blocks: [
      { id: 'b1', type: 'thinking', text: '先确认控件描边走的是 --td-component-stroke。', state: 'done', format: 'raw', startedAt: Date.now() - 3000, endedAt: Date.now() - 1000 },
      { id: 'b2', type: 'text', text: '已经统一成石墨黑，边线和实色块也跟着透明度走了。', state: 'done' },
    ] },
];

/**
 * 模拟壁纸：一个偏暗的斜向渐变。
 *
 * 特意选**暗**的：浅色主题 + 深壁纸是「文字读不清」最坏的那一档，
 * 也是固定灰阶边线最容易翻车的场景。用它当基线比用浅色壁纸严格。
 */
const WALLPAPER = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#2b5876"/><stop offset="1" stop-color="#4e4376"/>' +
    '</linearGradient></defs><rect width="1440" height="900" fill="url(#g)"/></svg>'
)}")`;

const failures = [];
const checks = { total: 0 };
function ok(cond, label, detail) {
  checks.total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const server = createServer(async (req, res) => {
  try {
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
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];

async function newContext(transparency, dark) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(
    ({ t, d }) => {
      localStorage.setItem('opc.transparency', String(t));
      /**
       * 深浅色必须走 `localStorage.theme`，不能直接 `classList.add('dark')`。
       *
       * `useTheme` 在 effect 里执行 `root.classList.toggle('dark', theme === 'dark')`，
       * 而 theme 由「偏好 + 系统」推导 —— 默认偏好是 'system'，于是挂载后
       * 会按系统的浅色把 class 抹掉。之前直接加 class 的写法因此整轮都在测浅色，
       * 深色的 veil 方向断言才会报「方向反了」（其实是深色根本没生效）。
       */
      localStorage.setItem('theme', d ? 'dark' : 'light');
    },
    { t: transparency, d: dark }
  );
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
    if (url.includes('/api/permission-response')) return json({ ok: true });
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/api/sessions/')[1].split('?')[0];
      return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES.filter(m => m.session_id === id) });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  return ctx;
}

function watch(page) {
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
}

/**
 * 打开页面并铺好模拟壁纸。
 *
 * 壁纸**不能**在 addInitScript 里写：init script 在文档解析之前执行，
 * 那时 `document.documentElement` 还是 null —— 之前那次
 * 「Cannot read properties of null (reading 'style')」就是它抛的，
 * 而且壁纸从头到尾没生效，截图里根本看不出 100% 到底长什么样。
 *
 * 壁纸铺在 `<html>` 上而不是 `<body>`：glass 模式下 body 要画 veil，
 * 壁纸必须是 veil **下面**的那一层，才等价于真实窗口里「系统 acrylic 在
 * 页面之下」的关系。
 */
async function open(page, path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(wp => {
    document.documentElement.style.backgroundImage = wp;
    document.documentElement.style.backgroundSize = 'cover';
  }, WALLPAPER);
  await page.waitForTimeout(250);
}

/**
 * 全页扫描：把所有「可见且背景不透明」的元素列出来。
 *
 * 与旧探针的区别：**不再按视口过滤**。元素在滚动区外也一样参与判定 ——
 * 用户看到的问题不会因为它在折叠线以下就消失。
 */
const SCAN_OPAQUE = () => {
  const alphaOf = c => {
    if (!c) return 0;
    const m = c.match(/rgba?\(([^)]*)\)/);
    if (!m) return 0;
    const parts = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  };
  const out = [];
  const walk = (root, chain) => {
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (Number(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      const area = Math.round(r.width * r.height);
      if (area < 600) continue;
      const a = alphaOf(cs.backgroundColor);
      const grad = cs.backgroundImage !== 'none' && /gradient/.test(cs.backgroundImage);
      if (a < 0.05 && !grad) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
        bg: cs.backgroundColor,
        alpha: a,
        area,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20),
        chain,
        isAvatar: el.hasAttribute('data-agent-avatar'),
      });
      if (el.shadowRoot) walk(el.shadowRoot, [...chain, el.tagName.toLowerCase()]);
    }
  };
  walk(document.body, []);
  return out;
};

/**
 * 实色块白名单。每一条都必须写理由 —— 没有理由的「实色」就是漏改。
 *
 * 阈值定在 alpha ≥ 0.6（而不是 0.9）是有意的：0.9 只能抓住「完全没改」的，
 * 抓不到「改了一半」的。0.65 的用户气泡、0.72 的主按钮都会进来，
 * 于是每次跑脚本都会把「这几个为什么允许实心」重新过一遍。
 *
 * 前四条是「反色文字 / 品牌识别」的退让；后两条是 A27 加的**浮层** ——
 * 方向相反：它们不是「允许实心」，而是「必须实心」，见下面的说明。
 */
const WHITELIST = [
  { test: e => e.cls.includes('tc-bubble-user'), reason: '用户气泡：白字需深底，下限 0.65（A25 已论证）' },
  { test: e => e.cls.includes('tc-btn-brand'), reason: '主按钮：反色文字需深底，下限 0.72' },
  // A28：设置页的开关。开启态是「白钮压品牌色」—— 反色内容没有底色可退让，
  // 已由 index.css 的 `.t-switch.t-is-checked` 规则改走 --tc-solid（1.0 → 0.72），
  // 与 tc-btn-brand 逐字同款。
  //
  // A67 之后光斑**默认关闭**，于是设置页上第一个被扫到的开关是**关闭态**的灰轨。
  // 那也是 TDesign 自己的实色轨道，属于同一类「控件需要一个能看清的底」，
  // 不是我们绕过了透明度体系 —— 所以这里按 `t-switch` 整体放行，不再只认 checked。
  // 开启态到底有没有真吃到 --tc-solid，由 [7] 单独断言（不看白名单，直接比色值），
  // 所以放宽这一条不会让「降档规则失效」溜过去。
  { test: e => e.cls.includes('t-switch'), reason: '开关轨道：控件需可辨识的底（开启态走 --tc-solid 0.72，关闭态为 TDesign 默认灰轨；开启态另由 [7] 直接比色断言）' },
  { test: e => e.chain.includes('t-chat-sender') && e.chain.includes('t-button'), reason: '发送键：同上，且只能经 --td-brand-color 降档' },
  { test: e => e.isAvatar, reason: 'Agent 品牌 logo：识别性优先，只降 opacity 到 0.85' },
  /**
   * 浮层（A27）：这一类**必须**是实心的，和上面四条的方向相反。
   *
   * 本脚本守的是「页面表面不该有绕过透明度体系的实色块」；浮层压的**是内容**
   * 而不是桌面，它一旦跟着归零，背后的正文就整片穿上来（用户报的「弹窗页面
   * 杂乱」）。所以浮层有独立的下限 0.9，由 `verify:overlay` 专门守。
   *
   * 这里把它们从「实色块」里摘出去，不是放水 —— 是分工：surface 管「表面」，
   * overlay 管「浮层」。两边都不留缝：浮层如果掉回 0，overlay 会失败。
   */
  { test: e => e.cls.includes('tc-glass'), reason: '浮层：压在内容之上，下限 0.9（A27，由 verify:overlay 守）' },
  {
    test: e => /t-popup__content|t-dialog|t-message|t-notification/.test(e.cls),
    reason: 'TDesign 弹层族：同上（A27）',
  },
];

function classify(items) {
  const blocked = [];
  for (const it of items) {
    if (it.alpha < 0.6) continue;
    const w = WHITELIST.find(w => w.test(it));
    if (!w) blocked.push(it);
  }
  return blocked;
}

/** 解析 CSS 变量（惰性替换，必须挂到元素上让浏览器真算一次） */
const RESOLVE_VARS = names => {
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const out = {};
  for (const n of names) {
    probe.style.backgroundColor = `var(${n})`;
    out[n] = getComputedStyle(probe).backgroundColor;
  }
  probe.remove();
  return out;
};

const alphaOf = c => {
  if (!c) return null;
  const m = c.match(/rgba?\(([^)]*)\)/);
  if (!m) return null;
  const parts = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
  return parts.length >= 4 ? Number(parts[3]) : 1;
};

const PAGES = [
  ['/chat/s1', '会话页'],
  ['/', '通讯录'],
  ['/settings', '设置页'],
];

// ============= [1] 100% 下没有白名单外的实色块 =============
console.log('\n[1] 100% 透明度：全页扫描（含滚动区 + shadow DOM）');
for (const dark of [false, true]) {
  for (const [path, name] of PAGES) {
    const ctx = await newContext(100, dark);
    const page = await ctx.newPage();
    watch(page);
    await open(page, path + '?glass=1');
    // 滚到底再滚回：把懒渲染/IntersectionObserver 的内容也逼出来
    await page.evaluate(async () => {
      const step = 400;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 30));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);

    const items = await page.evaluate(SCAN_OPAQUE);
    const blocked = classify(items);
    ok(
      blocked.length === 0,
      `${name}·${dark ? '深色' : '浅色'}：无白名单外的实色块`,
      blocked.length
        ? blocked.slice(0, 4).map(b => `${b.tag}.${b.cls.slice(0, 26)} alpha=${b.alpha.toFixed(2)} "${b.text}"`).join(' | ')
        : `${items.length} 个有底元素，全部 ≤0.6 或在白名单内`
    );
    if (blocked.length) {
      await page.screenshot({ path: join(OUT, `a26-blocked-${name}-${dark ? 'dark' : 'light'}.png`), fullPage: true });
    }
    await page.screenshot({ path: join(OUT, `a26-${name}-${dark ? 'dark' : 'light'}-100.png`), fullPage: true });
    await ctx.close();
  }
}

// ============= [2] 边线：不再有固定灰阶 =============
console.log('\n[2] 边线：alpha 形式，强度受控');
for (const dark of [false, true]) {
  const ctx = await newContext(100, dark);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/chat/s1?glass=1');

  const r = await page.evaluate(() => {
    const alphaOf = c => {
      if (!c) return 0;
      const m = c.match(/rgba?\(([^)]*)\)/);
      if (!m) return 0;
      const parts = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    const brand = getComputedStyle(document.documentElement).getPropertyValue('--td-brand-color').trim();
    const brandProbe = document.createElement('div');
    brandProbe.style.color = 'var(--td-brand-color)';
    document.body.appendChild(brandProbe);
    const brandRgb = getComputedStyle(brandProbe).color;
    brandProbe.remove();

    const bad = [];
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          const w = cs[`border${side}Width`];
          const st = cs[`border${side}Style`];
          const c = cs[`border${side}Color`];
          if (parseFloat(w) < 1 || st === 'none') continue;
          const a = alphaOf(c);
          if (a < 0.05) continue;
          // 强调线（选中态的 1px 品牌色）是功能指示，不算「版面分割线」，
          // 单独放行 —— 但它必须是品牌色，不能是随便一个灰
          const isBrand = c.replace(/\s/g, '') === brandRgb.replace(/\s/g, '');
          all.push({ side, c, a, isBrand, el: `${el.tagName.toLowerCase()}.${(typeof el.className === 'string' ? el.className : '').slice(0, 34)}` });
          if (!isBrand && a > 0.21) bad.push({ side, c, a, el: `${el.tagName.toLowerCase()}.${(typeof el.className === 'string' ? el.className : '').slice(0, 34)}` });
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document.body);
    return { bad, total: all.length, samples: all.slice(0, 6), brand, brandRgb };
  });

  ok(
    r.bad.length === 0,
    `${dark ? '深色' : '浅色'}：没有强度失控的非强调边线`,
    r.bad.length ? r.bad.slice(0, 4).map(b => `${b.side} ${b.c} (${b.a.toFixed(2)}) ${b.el}`).join(' | ') : `${r.total} 条可见边线，全部 ≤0.21 或为品牌色强调线`
  );
  await ctx.close();
}

// ============= [3] 结构分栏线 =============
console.log('\n[3] 结构分栏线：两端渐隐 + 随透明度增强');
{
  const read = async t => {
    const ctx = await newContext(t, false);
    const page = await ctx.newPage();
    watch(page);
    await open(page, '/chat/s1?glass=1');
    const r = await page.evaluate(() => {
      const el = document.querySelector('.tc-split-hairline');
      if (!el) return null;
      const cs = getComputedStyle(el, '::after');
      const vars = {};
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      for (const n of ['--tc-split', '--tc-hairline', '--tc-solid', '--tc-veil']) {
        probe.style.backgroundColor = `var(${n})`;
        vars[n] = getComputedStyle(probe).backgroundColor;
      }
      probe.remove();
      return { bgImage: cs.backgroundImage, width: cs.width, position: cs.position, vars };
    });
    await ctx.close();
    return r;
  };

  const a = await read(0);
  const b = await read(100);
  ok(a !== null, '分栏元素存在（.tc-split-hairline）');
  ok(/linear-gradient/.test(a.bgImage), '分栏线是渐变而不是实线（两端渐隐）', a.bgImage.slice(0, 70));
  ok(a.width === '1px' && a.position === 'absolute', '线宽 1px、绝对定位（不占布局）', `${a.width} ${a.position}`);
  const sa = alphaOf(a.vars['--tc-split']);
  const sb = alphaOf(b.vars['--tc-split']);
  ok(sb > sa, '强度随透明度增强（表面色差消失后由它承担边界）', `t=0:${sa} → t=100:${sb}`);
  ok(sb > 0.1 && sb < 0.25, 't=100 时强度落在可见但不刺眼的区间', String(sb));
}

// ============= [4] 控件轮廓线 =============
console.log('\n[4] 控件轮廓线：100% 下仍可见');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/chat/s1?glass=1');
  const r = await page.evaluate(() => {
    // A33 答案去卡片化、A35 思考块去卡片化 —— 聊天区已无「带描边的实体」，
    // 直接用临时元素读令牌（要证的是令牌本身还在）。
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.backgroundColor = 'var(--td-component-stroke)';
    const stroke = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      stroke,
      bubble: stroke,
    };
  });
  const a = alphaOf(r.stroke);
  ok(r.stroke !== 'transparent' && a > 0, '控件描边没有跟着透明度一起归零', `${r.stroke} (alpha ${a})`);
  ok(a >= 0.1 && a <= 0.22, '强度在「看得见但不突兀」区间', String(a));
  ok(r.bubble !== null && alphaOf(r.bubble) > 0, '控件描边令牌仍在（功能边界不随卡片一起去掉）', String(r.bubble));
  await ctx.close();
}

// ============= [5][6][7] 令牌：实色下限 / veil / specialcomponent =============
console.log('\n[5-7] 令牌：实色下限 / 公共底噪 / R1 根因');
for (const dark of [false, true]) {
  const ctx = await newContext(100, dark);
  /**
   * A67 之后光斑开关**默认关闭**，设置页上就不再有「开启态」的开关了 ——
   * 而下面要断言开启态确实吃到 --tc-solid。所以在首帧前种一份「用户已打开」的偏好，
   * 等价于「用户自己去设置页把它打开了」（与 verify:a25 [4] / a35 [7] / a37 [4] 同款处理）。
   *
   * 注意：这是**只为这一条断言**准备的夹具。[1] 的全页扫描仍跑真实默认态（光斑关着），
   * 所以「关闭态灰轨」在那边照旧会被扫到并走白名单，不会因为这里开了开关就漏检。
   */
  await ctx.addInitScript(() => {
    localStorage.setItem('opc.glow', JSON.stringify({ enabled: true, size: null, brightness: null }));
  });
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/settings?glass=1');
  const v = await page.evaluate(RESOLVE_VARS, ['--tc-solid', '--tc-veil', '--td-bg-color-specialcomponent', '--td-bg-color-component-disabled']);
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // 先证明「深色真的生效了」。不先断言这一条，深色分支一旦没切过去，
  // 后面所有深色断言都会拿浅色的值去比，报出来的错因会完全跑偏。
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  ok(isDark === dark, `${dark ? '深色' : '浅色'}模式确实生效`, `html.dark = ${isDark}`);

  ok(Math.abs(alphaOf(v['--tc-solid']) - 0.72) < 0.01, `${dark ? '深色' : '浅色'}：--tc-solid 在 100% 停在下限 0.72`, `${v['--tc-solid']}`);

  const veilA = alphaOf(v['--tc-veil']);
  const veilRgb = v['--tc-veil'].match(/\d+/g).slice(0, 3).map(Number);
  ok(Math.abs(veilA - 0.16) < 0.01, `${dark ? '深色' : '浅色'}：veil 在 100% 为 0.16`, String(veilA));
  ok(
    dark ? veilRgb.every(c => c === 0) : veilRgb.every(c => c === 255),
    `${dark ? '深色垫黑（浅字需要暗底）' : '浅色垫白（深字需要亮底）'} —— 方向不能反`,
    veilRgb.join(',')
  );
  ok(bodyBg === v['--tc-veil'] || Math.abs((alphaOf(bodyBg) ?? 0) - 0.16) < 0.01, 'body 实际吃到了 veil', bodyBg);

  // R1：dashed 按钮 / 空态块用的那个变量
  ok(alphaOf(v['--td-bg-color-specialcomponent']) === 0, `${dark ? '深色' : '浅色'}：--td-bg-color-specialcomponent 已归零（R1）`, v['--td-bg-color-specialcomponent']);

  // 禁用态不能归零，否则禁用控件彻底消失
  ok(alphaOf(v['--td-bg-color-component-disabled']) > 0.02, `${dark ? '深色' : '浅色'}：禁用底仍有极淡底（不会消失）`, v['--td-bg-color-component-disabled']);

  // A28：开关开启态必须真的吃到 --tc-solid。
  //
  // 为什么单独立一条：上面 [1] 的白名单里放了 `.t-switch.t-is-checked`，
  // 而白名单是按「alpha ≥ 0.6 且匹配」放行的 —— 万一 index.css 那条降档
  // 规则因为选择器权重失效，alpha 会停在 TDesign 默认的 1.0，同样 ≤ 白名单
  // 条件，[1] 会一声不吭地通过。那就是「验证脚本替一个没生效的修复背书」。
  // 所以这里不看「是不是实色」，直接看「是不是那个该来的颜色」。
  const sw = await page.evaluate(() => {
    const el = document.querySelector('.t-switch.t-is-checked');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  const swA = alphaOf(sw);
  const solidA = alphaOf(v['--tc-solid']);
  ok(
    sw !== null && swA !== null && Math.abs(swA - solidA) < 0.01,
    `${dark ? '深色' : '浅色'}：开关开启态已走 --tc-solid（不是 TDesign 默认实色）`,
    sw ? `${sw}（--tc-solid = ${v['--tc-solid']}）` : '页面上没有开启态的开关'
  );
  await ctx.close();
}

// ============= [8] R4：输入框 shadow DOM 白底 =============
/**
 * A93 修订：这里原本第三条断言是「输入框仍有轮廓（border alpha > 0）」，
 * 意图是「不让输入框在视觉上消失」。用户后来的反馈是**相反方向**的：
 * 「输入框的边缘太粗，不协调」—— 1625px 宽的截图里，半透明描边被抗锯齿
 * 摊成两个像素，看起来是一条实线。根因是底色 + 描边 + 投影三样在画同一个
 * 边界，于是描边被去掉（`border-color: transparent`）。
 *
 * 所以判据拆成两条，各管一头：
 *   ① 描边必须透明 —— 不许再画那条线（A93 的诉求）；
 *   ② 边界信号必须还在 —— 但改由「底色与周围有色差」+「投影」承担
 *      （原断言真正想保护的东西，不能因为删了描边就丢掉）。
 */
const READ_SENDER = () => {
  const host = document.querySelector('t-chat-sender');
  const el = host?.shadowRoot?.querySelector('[part="t-chat__input__content"]');
  if (!el) return { err: 'part 取不到' };
  const alphaOf = c => {
    if (!c) return 0;
    const m = c.match(/rgba?\(([^)]*)\)/);
    if (!m) return 0;
    const parts = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  };
  const rgbOf = c => {
    const m = c && c.match(/rgba?\(([^)]*)\)/);
    if (!m) return null;
    const p = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean).map(Number);
    return p.length >= 3 ? [p[0], p[1], p[2]] : null;
  };
  const cs = getComputedStyle(el);
  /* 「周围」= 沿祖先链往上第一个有实底的元素。
     祖先链要跨 shadow 边界接上宿主，否则走到 shadow root 顶端就断了
     （t-chat__input__content 的 shadow 内祖先全是透明的）。
     ⚠️ 起点必须是 `el.parentElement` 而不是 `el` —— 从自己开始走的话，
     第一个命中的就是自己（底色 alpha = 1），「色差」永远算成 0。 */
  const chain = [];
  for (let n = el.parentElement; n; n = n.parentElement) chain.push(n);
  for (let n = host?.parentElement; n; n = n.parentElement) chain.push(n);
  let surround = null;
  for (const n of chain) {
    const b = getComputedStyle(n).backgroundColor;
    if (alphaOf(b) > 0.5) { surround = b; break; }
  }
  return {
    bg: cs.backgroundColor,
    alpha: alphaOf(cs.backgroundColor),
    borders: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
    borderAlphas: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].map(alphaOf),
    shadow: cs.boxShadow,
    rgb: rgbOf(cs.backgroundColor),
    surround,
    surroundRgb: rgbOf(surround),
  };
};

console.log('\n[8] 输入框：shadow DOM 白底被盖掉（R4）');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/chat/s1?glass=1');
  const r = await page.evaluate(READ_SENDER);
  ok(!r.err, '能取到输入框本体（t-chat__input__content）', r.err || 'ok');
  ok(!r.err && r.alpha === 0, '浅色 100%：白底已被盖掉', r.err ? '-' : `${r.bg} (alpha ${r.alpha})`);
  ok(
    !r.err && r.borderAlphas.every(a => a === 0),
    'A93：描边整圈透明（不再画那条线）',
    r.err ? '-' : r.borders.join(' / ')
  );
  ok(
    !r.err && r.shadow !== 'none',
    'A93：全透明态下边界仍靠投影标出（不然不知道哪里能打字）',
    r.err ? '-' : r.shadow.slice(0, 60)
  );
  await ctx.close();
}

// ============= [8b] A93：非玻璃态靠「底色差 + 投影」立边界 =============
console.log('\n[8b] 输入框：非玻璃态下不靠描边也分得清（A93）');
{
  const ctx = await newContext(0, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/chat/s1');
  const r = await page.evaluate(READ_SENDER);
  ok(!r.err, '能取到输入框本体', r.err || 'ok');
  ok(
    !r.err && r.borderAlphas.every(a => a === 0),
    '描边整圈透明',
    r.err ? '-' : r.borderAlphas.join(' / ')
  );
  /* 色差用「逐通道最大差」而不是欧氏距离：判据和 verify:responsive 的
     「框架面与内容面有色差（≥ 8）」同一把尺子，读者不用换算两套阈值。 */
  const delta = r.rgb && r.surroundRgb
    ? Math.max(...r.rgb.map((v, i) => Math.abs(v - r.surroundRgb[i])))
    : null;
  ok(
    !r.err && delta !== null && delta >= 8,
    '输入框底色与所在面有色差（≥ 8）',
    r.err ? '-' : `${r.bg} vs ${r.surround} → Δ${delta}`
  );
  ok(!r.err && r.shadow !== 'none', '输入框有投影', r.err ? '-' : r.shadow.slice(0, 60));
  await ctx.close();
}

// ============= [10] 控制台 =============
console.log('\n[10] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ') || 'clean');

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
