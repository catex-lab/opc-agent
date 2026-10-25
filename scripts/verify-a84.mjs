/**
 * A84 验收 —— 「控件别自带底色」与「工作区开关搬家」。
 *
 * 用户这一轮提的是四件**互相矛盾着**的事：
 *   [1] 工作区**没展开**时，展开按钮留在聊天头部 ⋯ 左边（保持图一）；
 *       一旦展开，这枚按钮要**挪到**工作区栏头原「×」的位置，且不要 × 图标。
 *       —— 同一枚图标，两种状态各只有一个落点，不能两处同时在。
 *   [2] 权限菜单（默认 / 自动编辑 / 只读 / 全放行）的图标**不要灰底方块**。
 *   [3] 红框里那些控件（工作区徽标 / ⋯ / 搜索胶囊 / 加号）也不要底色。
 *   [4] 全局：除了**选中回显态**，任何控件都不该有常驻底色。
 *
 * 这类要求最容易「改了一半」——代码里删了 backgroundColor，可 hover 类名
 * 还在、或者另一个文件里有一份同样的写法没删。所以这里不看截图：
 *   · 用**计算样式**断言 alpha（`transparent` / `rgba(0,0,0,0)` 都算无底色）；
 *   · 用**坐标**断言按钮真的换了位置（而不是复制了一份）；
 *   · 用**全站扫描**兜住「还有别的地方漏了」——这一条才是 [4] 的本体，
 *     它不认名单，凡是「只有图标、没有文字、又不是选中态」的按钮，一律要求透明。
 *
 * 反证也留了：hover 之后底色必须出现。否则「删干净」与「把交互反馈一起删了」
 * 在断言层面无法区分 —— 那才是真正的回归。
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
  '.png': 'image/png',
};

const AGENTS = [
  { id: 'wb', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat'], status: { availability: 'ready', version: '2.4.1' } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构与代码审查', capabilities: ['chat'], status: { availability: 'ready', version: '1.0.44' } },
];
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const CWD = 'D:\\work\\demo\\app';
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'wb', model: 'm', cwd: CWD, created_at: new Date().toISOString() },
];
const MESSAGES = [
  { id: 'm1', role: 'user', session_id: 's1', created_at: new Date().toISOString(), content: '这段怎么解释？' },
  { id: 'm2', role: 'assistant', session_id: 's1', model: 'm', created_at: new Date().toISOString(), content: '结论：确实存在两套品牌蓝。' },
];

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
// 工作区默认收起（App.tsx 读 localStorage）。显式钉成 0，免得本机跑过一次
// 「展开」之后，这个脚本测的其实是展开态 —— 那种失败会非常难查。
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('opc.workspace-open', '0');
  } catch {
    /* 隐私模式下写不进去，默认值本来就是 false */
  }
});
await ctx.route('**/api/**', route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  // 工作区面板一挂载就会读目录。形状必须对（{root, entries}）——
  // 早先这里落到兜底的 `{}`，WorkspacePanel 的 basename(data.root) 直接抛错，
  // ErrorBoundary 把整个三栏换成错误页，于是「展开工作区」看起来像没反应。
  if (/\/api\/fs\/list/.test(url)) return json({ root: CWD, path: '', entries: [] });
  if (/\/api\/fs\//.test(url)) return json({ ok: true });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    const s = SESSIONS.find(x => x.id === id) ?? SESSIONS[0];
    return json({ session: s, messages: MESSAGES });
  }
  if (/\/api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

async function go(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(120);
}

/** 「有没有底色」——只认 alpha。transparent / rgba(0,0,0,0) / color(srgb … / 0) 全算无 */
const alphaOf = s => {
  if (!s) return 1;
  if (s === 'transparent') return 0;
  const m = s.match(/[\d.]+/g);
  if (!m) return 1;
  if (/^color\(/i.test(s)) return m.length >= 4 ? Number(m[3]) : 1;
  return m.length >= 4 ? Number(m[3]) : 1;
};

/** A115：是不是中性色（R/G/B 三通道相等）——「黑白图标」的字面判据 */
const isNeutral = s => {
  if (!s) return false;
  if (s === 'transparent') return false;
  const m = s.match(/[\d.]+/g);
  if (!m || m.length < 3) return false;
  const [r, g, b] = m.map(Number);
  return r === g && g === b;
};

/** 取某个元素的「自身底色」——不看祖先，只认它自己画的这一层 */
const bgOf = (sel, nth = 0) =>
  page.evaluate(
    ([s, n]) => {
      const els = [...document.querySelectorAll(s)].filter(e => e.getClientRects().length > 0);
      const el = els[n];
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
        })(),
      };
    },
    [sel, nth]
  );

// ============= [1] 工作区开关：未展开留在头部，展开后搬到栏头 =============
console.log('\n[1] 工作区开关：未展开在聊天头部，展开后搬到工作区栏头');

await go('/chat/s1');

const expandBtn = await bgOf('[data-workspace-toggle="expand"]');
const moreBtn = await bgOf('[data-chat-more] > summary');
ok(!!expandBtn, '未展开时聊天头部有「展开工作区」按钮', expandBtn && JSON.stringify(expandBtn.rect));
ok(!!moreBtn, '聊天头部的「⋯」还在');
ok(
  !!expandBtn && !!moreBtn && expandBtn.rect.right <= moreBtn.rect.x + 1,
  '展开按钮在「⋯」**左侧**（图一的布局不变）',
  expandBtn && moreBtn ? `toggle.right=${expandBtn.rect.right} ≤ more.x=${moreBtn.rect.x}` : ''
);
ok(!!expandBtn && alphaOf(expandBtn.bg) === 0, '未展开时这枚按钮**没有常驻底色**', expandBtn?.bg);
ok(
  (await page.locator('[data-workspace-toggle="collapse"]').count()) === 0,
  '未展开时栏头那个「收起」按钮不存在（不能两处同时出现）'
);

// 点开展开
await page.locator('[data-workspace-toggle="expand"]').click();
await page.waitForTimeout(600);
await page.mouse.move(5, 5);
await page.waitForTimeout(200);

const afterExpand = await page.evaluate(() => {
  const q = s => document.querySelector(s);
  const collapse = q('[data-workspace-toggle="collapse"]');
  const panel = q('[aria-label="工作区文件"]');
  const r = el => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), right: Math.round(b.right) };
  };
  return {
    hasExpand: !!q('[data-workspace-toggle="expand"]'),
    collapse: collapse ? { rect: r(collapse), bg: getComputedStyle(collapse).backgroundColor } : null,
    // 图标语义：lucide-react 会写 `class="lucide lucide-panel-right"`。
    // 靠类名而不是靠「有没有 svg」——后者分不出 PanelRight 和 ×。
    icon: collapse?.querySelector('svg')?.getAttribute('class') ?? null,
    hasXIcon: !!q('[aria-label="工作区文件"] svg.lucide-x'),
    hasXButton: !!q('[aria-label="工作区文件"] [aria-label="关闭工作区"]'),
    panel: panel ? r(panel) : null,
  };
});

ok(!afterExpand.hasExpand, '展开后聊天头部的「展开工作区」按钮**消失**了');
ok(!!afterExpand.collapse, '展开后工作区栏头出现「收起工作区」按钮');
ok(/lucide-panel-right/.test(afterExpand.icon ?? ''), '收起入口用的是同一枚 PanelRight 图标', afterExpand.icon);
ok(!afterExpand.hasXIcon, '栏头里**没有 × 图标**（用户明确不要）');
ok(!afterExpand.hasXButton, '栏头里没有「关闭工作区」的 × 按钮残留');
ok(!!afterExpand.collapse && alphaOf(afterExpand.collapse.bg) === 0, '收起按钮也没有常驻底色', afterExpand.collapse?.bg);
ok(
  !!afterExpand.collapse && !!afterExpand.panel && afterExpand.panel.right - afterExpand.collapse.rect.right >= 0 && afterExpand.panel.right - afterExpand.collapse.rect.right <= 40,
  '收起按钮贴在工作区栏头**最右侧**（就是原来 × 的位置）',
  afterExpand.collapse && afterExpand.panel
    ? `panel.right=${afterExpand.panel.right} − btn.right=${afterExpand.collapse.rect.right} = ${afterExpand.panel.right - afterExpand.collapse.rect.right}px`
    : ''
);

// 点回去：状态必须可逆，且聊天头部的按钮要回来
await page.locator('[data-workspace-toggle="collapse"]').click();
await page.waitForTimeout(600);
await page.mouse.move(5, 5);
await page.waitForTimeout(200);
const back = await page.evaluate(() => ({
  expand: !!document.querySelector('[data-workspace-toggle="expand"]'),
  collapse: !!document.querySelector('[data-workspace-toggle="collapse"]'),
}));
ok(back.expand && !back.collapse, '点「收起」后回到未展开态，按钮也回到聊天头部');

// ============= [2] 权限图标：不要灰底方块 =============
console.log('\n[2] 权限菜单图标：去掉彩色淡底方块');

const permPrefix = await page.evaluate(() => {
  const shell = document.querySelector('[data-permission-mode-select]');
  if (!shell) return null;
  /* TDesign 的 borderless Select 渲染成 `.t-input`，prefixIcon 落在
     `.t-input__prefix.t-input__prefix-icon` 里（不是 `.t-select-input__prefix`）。
     取「带 svg 的那个 span」而不是 firstElementChild —— 组件库自己也会塞 span。 */
  const box = shell.querySelector('.t-input__prefix');
  const svg = box ? box.querySelector('svg') : null;
  const icon = svg ? svg.parentElement : null;
  if (!icon) return null;
  const cs = getComputedStyle(icon);
  return { bg: cs.backgroundColor, color: cs.color, cls: icon.className };
});
ok(!!permPrefix, '找得到权限选择器的前置图标');
ok(!!permPrefix && alphaOf(permPrefix.bg) === 0, '前置图标**没有底色**（原来那层 ${color}15 已去掉）', permPrefix?.bg);

// 展开下拉，逐个检查选项里的图标
await page.locator('[data-permission-mode-select] .t-select').click();
await page.waitForTimeout(450);
const permOptions = await page.evaluate(() => {
  const opts = [...document.querySelectorAll('.permission-select-popup .t-select-option')];
  return opts.map(o => {
    // 取「svg 的父元素」而不是「第一个带 svg 的 span」—— TDesign 的选项外面
    // 还有一层 `.t-select-option__content` span，它同样「含有 svg」，取到它会
    // 量到继承的文字色，四档看起来只剩两种颜色。
    const svg = o.querySelector('svg');
    const icon = svg ? svg.parentElement : null;
    return {
      text: (o.textContent || '').trim(),
      bg: icon ? getComputedStyle(icon).backgroundColor : null,
      color: icon ? getComputedStyle(icon).color : null,
    };
  });
});
ok(permOptions.length >= 4, `权限下拉有 ${permOptions.length} 个选项（默认 / 自动编辑 / 只读 / 全放行）`);
ok(permOptions.every(o => o.bg !== null), '每个选项都有图标');
ok(
  permOptions.every(o => alphaOf(o.bg) === 0),
  '所有选项的图标都没有底色方块',
  permOptions.map(o => `${o.text}:${o.bg}`).join(' | ')
);
/* A115（用户要求）：「权限图标替换为黑白色，不要彩色」。
 * A84 原本在这里断言「四档 4 色分得开」—— 那条要求从 A115 起反过来了：
 * 颜色退出编码，四档只由形状区分。所以这里改成断言「四档全是中性色」。
 *
 * A116 又收紧了一步：用户反馈「暗色模式下……权限选框内的图标……不要灰色」，
 * 于是四档从 primary/secondary/placeholder 三档递减**统一到 primary**，
 * 这里量到的只剩 1 档（本脚本只断言「中性」，具体是不是 primary 由
 * verify-a116-ui [3] 组比对 --td-text-color-primary 的解析值）。
 * 档位从 4 → 3 → 1 都是有意的，不是回归。 */
const permColors = new Set(permOptions.map(o => o.color));
const neutralCount = permOptions.filter(o => isNeutral(o.color)).length;
ok(
  neutralCount === permOptions.length && permOptions.length > 0,
  `四档图标全是中性色（${neutralCount}/${permOptions.length}）`,
  `${permColors.size} 档：${[...permColors].join(' / ')}`
);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ============= [3] 红框控件：工作区徽标 / ⋯ / 搜索胶囊 / 加号 =============
console.log('\n[3] 图四那几个控件：常态无底色');

const targets = [
  ['工作区徽标', '[data-workspace-badge] > summary'],
  ['聊天头部 ⋯', '[data-chat-more] > summary'],
  ['会话栏搜索胶囊', 'header .rounded-full'],
  ['会话栏加号', '[data-conversation-add]'],
];
for (const [label, sel] of targets) {
  const s = await bgOf(sel);
  ok(!!s, `找得到${label}`);
  if (s) ok(alphaOf(s.bg) === 0, `${label}常态没有底色`, s.bg);
}

// 反证：hover 必须浮出底色。否则「删干净」和「把反馈也删了」分不出来。
const badgeSummary = page.locator('[data-workspace-badge] > summary');
const beforeHover = await bgOf('[data-workspace-badge] > summary');
await badgeSummary.hover();
await page.waitForTimeout(320);
const afterHover = await bgOf('[data-workspace-badge] > summary');
ok(
  alphaOf(beforeHover?.bg) === 0 && alphaOf(afterHover?.bg) > 0,
  'hover 之后工作区徽标**浮出**底色（反馈还在，只是不再常驻）',
  `${beforeHover?.bg} → ${afterHover?.bg}`
);
await page.mouse.move(5, 5);
await page.waitForTimeout(200);

// ============= [4] 全局扫描：非选中态的图标按钮一律无底色 =============
console.log('\n[4] 全局扫描：除了选中回显态，图标按钮都不许有底色');

/**
 * 判定口径（写清楚，免得以后有人放宽标准把这条断言变成摆设）：
 *   · 只看**可见**的 button / summary；
 *   · 只看**图标按钮**：去掉空白后没有文字（`⋯` 这种符号算文字，所以
 *     `⋯` 按钮若用了字符会被排除 —— 我们这里用的是 svg，命中）；
 *   · 排除**选中回显态**：aria-pressed/expanded/selected/checked 为 true、
 *     aria-current 存在（导航当前栏）、带 .is-active、或 role 是
 *     switch/checkbox/radio/tab（那是状态机）；
 *   · 排除 `data-allow-fill`：目前只有头像占位与开关轨道这类「图片替身 /
 *     状态轨道」会用到，且必须在代码里显式标注 —— 白名单是**逐点**的，
 *     不是按文件或按前缀。
 */
const auditPages = ['/chat/s1', '/', '/settings'];
const violations = [];

/** 在当前页面上扫一遍，返回违例 */
const scanPage = () =>
  page.evaluate(() => {
    const isActive = el =>
      el.getAttribute('aria-pressed') === 'true' ||
      el.getAttribute('aria-expanded') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('aria-checked') === 'true' ||
      el.hasAttribute('aria-current') ||
      el.classList.contains('is-active') ||
      el.hasAttribute('data-active') ||
      ['switch', 'checkbox', 'radio', 'tab'].includes(el.getAttribute('role') || '') ||
      el.hasAttribute('data-allow-fill');
    const alpha = s => {
      if (!s) return 1;
      if (s === 'transparent') return 0;
      const m = s.match(/[\d.]+/g);
      if (!m) return 1;
      return m.length >= 4 ? Number(m[3]) : 1;
    };
    const out = [];
    for (const el of document.querySelectorAll('button, summary, [role="button"]')) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (alpha(cs.backgroundColor) === 0) continue;
      if (isActive(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (text) continue; // 有文字的按钮（主按钮 / 胶囊标签）不在本条范围内
      if (!el.querySelector('svg')) continue; // 没有图标也不是「图标按钮」
      out.push({
        label: el.getAttribute('aria-label') || el.getAttribute('title') || String(el.className).trim().slice(0, 30),
        bg: cs.backgroundColor,
        html: el.outerHTML.slice(0, 120).replace(/\s+/g, ' '),
      });
    }
    return out;
  });

let audited = 0;
for (const p of auditPages) {
  await go(p);
  violations.push(...(await scanPage()).map(v => ({ ...v, page: p })));
  audited++;
  // `/` 是会话列表 / 通讯录两栏共用的路由，只扫一次会漏掉通讯录那一栏
  if (p === '/') {
    const contactsNav = page.locator('button[aria-label="通讯录"]');
    if (await contactsNav.count()) {
      await contactsNav.first().click();
      await page.waitForTimeout(700);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(150);
      violations.push(...(await scanPage()).map(v => ({ ...v, page: '/ 通讯录' })));
      audited++;
    }
  }
}

ok(
  violations.length === 0,
  `全站「非选中态的图标按钮」都没有底色（扫描 ${audited} 个视图）`,
  violations.length
    ? violations.slice(0, 6).map(v => `${v.page} ${v.label}=${v.bg}`).join(' ; ')
    : '0 处'
);

// ============= 收尾 =============
ok(errors.length === 0, '全程没有 JS 报错', errors.slice(0, 3).join(' | '));

await page.screenshot({ path: join(OUT, 'a84.png') });
await browser.close();
server.close();

console.log(`\n${failures.length ? '✗' : '✓'} A84  ${checks.total - failures.length}/${checks.total}`);
if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
