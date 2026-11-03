/**
 * A174：回答内容分级渲染 + 外链两种打开方式 —— DOM 层闸门与浅/深截图。
 *
 * ## 为什么不用 dist
 *
 * 发布线正在用 `dist/`，这里再 `npm run build` 会互相踩。改成**跑 Vite dev
 * server**（另起端口），`/api/**` 仍然由 Playwright 的 route 拦下来喂夹具 ——
 * 组件是真的、样式是真的、Cherry 的 shadow DOM 也是真的，只是不碰构建产物。
 *
 * ## 这条闸门真正要看的
 *
 * 纯逻辑（切分 / 白名单）在 `verify-a174-answer-render.ts` 里穷举。这里只验
 * **只有真渲染才能看到**的部分：
 *   · 行内链接的图标是不是真的插进了 shadow DOM（11px、单色、跟随 hover）
 *   · 下划线 1px / offset 3px 是不是真的生效（`::part(md_a)` 能不能穿透）
 *   · 悬浮提示里的完整地址与两个次要动作
 *   · 点击走的是哪个通道（system → `externalOpen`，in-app → `browserLoad`）
 *   · 证据块展开后的底色只深一档、正文 12px 等宽
 *   · 「推测」只有标签，没有虚线框
 *
 * 运行：node scripts/verify-a174.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
// 截图目录默认落在项目的 .render-check/a174；允许用 A174_OUT 指到别处，
// 只在磁盘写不进项目盘时用（本机 E 盘曾被别的一条线写满）。
const OUT = process.env.A174_OUT || join(ROOT, '.render-check', 'a174');
const PORT = 5299;
const BASE = `http://127.0.0.1:${PORT}`;
const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

/* ── 夹具：一条把四种分级都覆盖到的回答 ─────────────────────────────── */

const ANSWER = [
  '先看结论：这一版把正文里的外链、命令输出和代码改动分了级，[官方文档](https://example.com/docs) 里有完整说明，[规范草案](https://spec.example.org/v1) 是评审依据。',
  '',
  '[推测] 第四档（批量推荐）可能要到下个迭代才稳定，下面三篇只能当参考。',
  '',
  '三篇延伸阅读：',
  '- [渲染管线笔记](https://blog.example.com/render-pipeline)',
  '- [可访问性清单](https://a11y.example.org/checklist)',
  '- [性能基线](https://perf.example.net/baseline)',
  '',
  '跑一遍闸门：',
  '',
  '```bash',
  '$ npm run verify:a174-answer-render',
  'PASS 88 通过 / 0 失败',
  'ok 0.4s',
  '```',
  '',
  '`src/components/AnswerCards.tsx` L128–L176 +42 −7',
  '',
  '其余内容保持行内，不做任何转换。',
].join('\n');

const now = Date.now();
const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
];
const MODELS = [{ modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: '快' }];
const SESSIONS = [
  {
    id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-haiku-4-5', cwd: ROOT,
    kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString(),
  },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '这一版正文怎么分级？', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: ANSWER, model: 'claude-haiku-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [{ id: 'b1', type: 'text', text: ANSWER, state: 'done' }],
  },
];

/* ── 起 dev server ──────────────────────────────────────────────────── */

function killTree(child) {
  if (!child || child.exitCode != null) return;
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

let vite = null;
async function startVite() {
  // 已经有一个 dev server 在跑就复用它 —— 反复起服务会让依赖预构建反复
  // 重建（每次都写 .vite/deps_temp），既慢又容易和别的验证线撞车
  try {
    const probe = await fetch(`${BASE}/`);
    if (probe.ok) {
      console.log('  · 复用已运行的 dev server');
      return;
    }
  } catch {
    /* 没有，往下自己起 */
  }
  const bin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(bin)) throw new Error(`找不到 vite：${bin}`);
  vite = spawn(process.execPath, [bin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  vite.stdout?.on('data', d => (log += String(d)));
  vite.stderr?.on('data', d => (log += String(d)));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (vite.exitCode != null) throw new Error(`vite 退出：\n${log}`);
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return log;
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`vite 60s 未就绪：\n${log}`);
}

async function resolveChrome() {
  if (existsSync(SYSTEM_CHROME)) return SYSTEM_CHROME;
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = existsSync(root)
    ? (await readdir(root)).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error('找不到 Chromium：请先安装 Chrome 或 npx playwright install chromium');
}

/* ── 页面：桥桩 + /api 夹具 ─────────────────────────────────────────── */

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.addInitScript(mode => {
    // 桥桩：只记录「走了哪个通道」，不真打开任何东西
    window.__extCalls = [];
    window.__browserCalls = [];
    window.opc = {
      // useTheme 挂载时会同步原生主题，缺这个方法会让整个 AppContent 崩掉
      setTheme: () => {},
      externalOpen: async url => {
        window.__extCalls.push(url);
        return true;
      },
      browserLoad: async url => {
        window.__browserCalls.push(url);
        return true;
      },
      browserState: async () => ({
        url: window.__browserCalls[window.__browserCalls.length - 1] || '',
        title: '',
        canGoBack: false,
        canGoForward: false,
        loading: false,
      }),
      onBrowserState: () => () => {},
      browserRect: () => {},
      browserVisible: () => {},
      openPath: async () => '',
    };
    try {
      localStorage.setItem('opc.link-open-mode', mode);
    } catch {
      /* ignore */
    }
  }, opts.mode || 'system');
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) return json({ runs: [] });
    if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
    if (url.includes('/api/permission-response')) return json({ ok: true });
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/sessions\/[^/?]+(\?|$)/.test(url)) {
      const id = url.split('/api/sessions/')[1].split('?')[0];
      return json({
        session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0],
        project: null,
        messages: MESSAGES.filter(m => m.session_id === id),
        dangling: null,
      });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  return { ctx, page, pageErrors };
}

/**
 * 打开聊天页并等到答案真的渲染出来。
 *
 * 不用 `waitUntil: 'networkidle'`：dev server 首屏要把依赖预构建一遍，还会
 * 因为「依赖变了」触发热重载，`networkidle` 既等不到也等不稳。改成等**业务
 * 信号**（答案容器出现），并在依赖重建触发的整页 reload 上重试一次。
 */
async function openChat(page) {
  page.setDefaultTimeout(120000);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(`${BASE}/chat/s1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    try {
      await page.waitForSelector('[data-answer-markdown]', { timeout: 60000 });
      await page.waitForTimeout(900);
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log('  · 页面被 dev server 热重载打断，重试');
      await page.waitForTimeout(3000);
    }
  }
}

/** 穿透 shadow DOM 读行内链接的真实计算样式 */
const INLINE_LINKS = `(() => {
  const out = [];
  const walk = node => {
    if (node.shadowRoot) {
      for (const a of node.shadowRoot.querySelectorAll('a')) {
        const cs = getComputedStyle(a);
        const svg = a.querySelector('svg');
        out.push({
          href: a.getAttribute('href'),
          url: a.getAttribute('data-opc-url'),
          blocked: a.hasAttribute('data-opc-link-blocked'),
          ext: a.hasAttribute('data-opc-extlink'),
          icon: svg ? { width: getComputedStyle(svg).width, height: getComputedStyle(svg).height, stroke: getComputedStyle(svg).color } : null,
          color: cs.color,
          line: cs.textDecorationLine,
          thickness: cs.textDecorationThickness,
          offset: cs.textUnderlineOffset,
          selects: cs.userSelect,
        });
      }
    }
    for (const el of node.querySelectorAll ? node.querySelectorAll('*') : []) {
      if (el.shadowRoot) walk(el);
    }
  };
  walk(document.querySelector('[data-msg-list]') || document.body);
  return out;
})()`;

let browser = null;
try {
  await mkdir(OUT, { recursive: true });
  console.log('\n[0] 启动 Vite dev server（不碰 dist）');
  await startVite();
  console.log(`  · ${BASE}`);

  const chrome = await resolveChrome();
  browser = await chromium.launch({ executablePath: chrome, headless: true });

  /* ── [1] 渲染：四种分级都出现 ───────────────────────────────────── */
  console.log('\n[1] 分级渲染：链接卡 / 证据块 / 代码改动卡 / 推测标签');
  {
    const { ctx, page, pageErrors } = await newPage(browser);
    await openChat(page);

    ok((await page.locator('[data-answer-markdown]').count()) > 0, '答案容器已渲染');
    ok((await page.locator('[data-answer-links]').count()) === 1, '连续 3 条链接渲染成一个链接卡网格');
    ok(
      (await page.locator('[data-answer-links]').getAttribute('data-answer-links')) === '3',
      '网格里是 3 张卡（不是 1 张也不是 9 张）',
    );
    ok((await page.locator('[data-answer-link-card]').count()) === 3, '3 张链接卡');
    ok((await page.locator('[data-answer-evidence]').count()) === 1, '证据块出现 1 个');
    ok((await page.locator('[data-answer-code-card]').count()) === 1, '代码改动卡出现 1 个');

    // —— 链接卡视觉口径：2 列等宽、11px 域名、13px 标题
    const grid = await page.evaluate(() => {
      const g = document.querySelector('[data-answer-links]');
      const card = document.querySelector('[data-answer-link-card]');
      const host = card?.querySelector('.tc-answer-linkcard-host');
      const title = card?.querySelector('.tc-answer-linkcard-title');
      return {
        display: getComputedStyle(g).display,
        cols: getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length,
        hostSize: host ? getComputedStyle(host).fontSize : null,
        hostMono: host ? getComputedStyle(host).fontFamily : null,
        titleSize: title ? getComputedStyle(title).fontSize : null,
        cardBorder: getComputedStyle(card).borderTopWidth,
      };
    });
    ok(grid.display === 'grid', '链接卡是 grid 布局', grid.display);
    ok(grid.cols === 2, '2×2 网格（两列）', grid.cols);
    ok(grid.hostSize === '11px', '域名 11px', grid.hostSize);
    ok(/mono|Consolas|Menlo|ui-monospace/i.test(grid.hostMono || ''), '域名等宽字体');
    ok(grid.titleSize === '13px', '标题 13px', grid.titleSize);
    ok(grid.cardBorder === '1px', '卡片只有发丝边（1px）', grid.cardBorder);

    // —— 证据块：单行摘要 + 展开
    const ev = await page.evaluate(() => {
      const root = document.querySelector('[data-answer-evidence]');
      const head = root.querySelector('[data-answer-evidence-toggle]');
      return {
        cmd: root.querySelector('.tc-answer-evidence-cmd').textContent,
        meta: root.querySelector('.tc-answer-evidence-meta').textContent,
        open: root.getAttribute('data-open'),
        body: root.querySelector('[data-answer-evidence-body]') !== null,
        headHeight: head.getBoundingClientRect().height,
      };
    });
    ok(ev.cmd === 'npm run verify:a174-answer-render', '摘要里是命令行本身', ev.cmd);
    ok(/\d{2}:\d{2}\s*·\s*\d+\s*行/.test(ev.meta.replace(/\s+/g, ' ')), '摘要里带时间与行数', ev.meta);
    ok(ev.open === '0' && !ev.body, '默认折叠，正文不占位');
    ok(ev.headHeight < 40, '折叠时只有一行摘要的高度', `${Math.round(ev.headHeight)}px`);

    await page.locator('[data-answer-evidence-toggle]').click();
    await page.waitForTimeout(200);
    const evOpen = await page.evaluate(() => {
      const root = document.querySelector('[data-answer-evidence]');
      const pre = root.querySelector('[data-answer-evidence-body]');
      const bubble = root.closest('.tc-answer');
      return {
        open: root.getAttribute('data-open'),
        font: pre ? getComputedStyle(pre).fontSize : null,
        mono: pre ? getComputedStyle(pre).fontFamily : null,
        bg: pre ? getComputedStyle(pre).backgroundColor : null,
        surface: bubble ? getComputedStyle(bubble).backgroundColor : null,
      };
    });
    ok(evOpen.open === '1', '点击后展开');
    ok(evOpen.font === '12px', '证据正文 12px', evOpen.font);
    ok(/mono|Consolas|Menlo|ui-monospace/i.test(evOpen.mono || ''), '证据正文等宽');
    ok(evOpen.bg !== evOpen.surface, '证据正文底色比表面深一档（不是同一个色）', `${evOpen.bg} vs ${evOpen.surface}`);

    // —— 代码改动卡
    const code = await page.evaluate(() => {
      const b = document.querySelector('[data-answer-code-card]');
      return {
        path: b.getAttribute('data-code-path'),
        range: b.getAttribute('data-code-range'),
        text: b.textContent.replace(/\s+/g, ' ').trim(),
        tag: b.tagName,
        bg: getComputedStyle(b).boxShadow,
        border: getComputedStyle(b).borderTopWidth,
      };
    });
    ok(code.path === 'src/components/AnswerCards.tsx', '卡片带完整路径', code.path);
    ok(code.range === 'L128–L176', '卡片带行区间', code.range);
    ok(code.text.includes('+42') && code.text.includes('−7'), '卡片带 +42 −7', code.text);
    ok(code.border === '1px' && code.bg === 'none', '不做按钮感（无阴影，只有发丝边）');

    // —— 推测标签：只留标签，没有虚线框
    const guess = await page.evaluate(() => {
      const tags = [];
      for (const host of document.querySelectorAll('t-chat-md-content')) {
        const sr = host.shadowRoot;
        if (!sr) continue;
        for (const t of sr.querySelectorAll('[data-guess-tag]')) {
          const cs = getComputedStyle(t);
          tags.push({ text: t.textContent, border: cs.borderTopWidth, style: cs.borderTopStyle, dashed: cs.borderTopStyle === 'dashed' });
        }
      }
      // 标记本身不应再以原文出现
      const plain = [];
      for (const host of document.querySelectorAll('t-chat-md-content')) {
        const sr = host.shadowRoot;
        if (!sr) continue;
        for (const p of sr.querySelectorAll('p')) plain.push(p.textContent);
      }
      return { tags, hasMarker: plain.some(t => t.includes('[推测]')) };
    });
    ok(guess.tags.length >= 1, '「推测」渲染成标签');
    ok(guess.tags.every(t => t.text === '推测'), '标签文字就是「推测」');
    ok(guess.tags.every(t => t.border === '1px' && t.style === 'solid'), '细实线边框（不是虚线框）', guess.tags.map(t => `${t.border}/${t.style}`).join(','));
    ok(!guess.hasMarker, '原文里的 [推测] 标记已被标签替换');

    // —— 行内链接：安全与样式
    const links = await page.evaluate(INLINE_LINKS);
    ok(links.length >= 2, '段落里的行内链接被装饰', `${links.length} 个 <a>`);
    ok(links.every(l => !l.href || /^https?:\/\//i.test(l.href)), '没有 javascript:/data: 之类的 href');
    ok(links.every(l => l.href === null || l.ext), '所有 http(s) 链接都打了 data-opc-extlink');
    const primary = await page.evaluate(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--td-text-color-primary').trim();
      const probe = document.createElement('span');
      probe.style.color = v;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    const docs = links.find(l => (l.url || '').includes('example.com/docs'));
    ok(!!docs, '找得到正文里的目标链接（含前导空白也算）', links.map(l => l.url).join(' | '));
    ok(!!docs && docs.color === primary, '链接用前景色，没有彩色强调', `${docs?.color} vs ${primary}`);
    ok(!!docs && /underline/i.test(docs.line), '有下划线', docs?.line);
    ok(!!docs && docs.thickness === '1px', '下划线 1px', docs?.thickness);
    ok(!!docs && docs.offset === '3px', '下划线 offset 3px', docs?.offset);
    ok(!!docs && docs.icon && docs.icon.width === '11px' && docs.icon.height === '11px', '外链图标 11px', docs?.icon?.width);
    ok(!docs || docs.selects !== 'none', '链接文字仍可选中（没被装饰影响）');

    // —— 悬浮提示：完整地址 + 两个次要动作
    const target = page.locator('t-chat-md-content a[data-opc-extlink]').first();
    await target.hover();
    await page.waitForTimeout(250);
    const tip = await page.evaluate(() => {
      const el = document.querySelector('[data-answer-link-tip]');
      if (!el) return { missing: true };
      return {
        missing: false,
        show: el.getAttribute('data-show'),
        url: el.querySelector('[data-link-tip-url]').textContent,
        actions: [...el.querySelectorAll('[data-link-action]')].map(b => b.getAttribute('data-link-action')),
        visible: el.getBoundingClientRect().width > 0,
      };
    });
    ok(!tip.missing && tip.show === '1' && tip.visible, 'hover 后提示可见');
    ok(!tip.missing && /^https?:\/\//.test(tip.url || ''), '提示里是完整地址', tip.url);
    ok(!tip.missing && tip.actions.includes('in-app') && tip.actions.includes('external'), '提示里有两个打开方式', (tip.actions || []).join(','));

    // —— 点击默认走系统浏览器
    await target.click();
    await page.waitForTimeout(200);
    const ext = await page.evaluate(() => window.__extCalls);
    ok(ext.length === 1 && /^https?:\/\//.test(ext[0]), '默认点击走 shell.openExternal（一条，且是 http(s)）', ext.join(','));

    // —— 次要动作「在应用内打开」走浏览标签页
    await target.hover();
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('[data-link-action="in-app"]').click());
    await page.waitForTimeout(700);
    const inApp = await page.evaluate(() => ({
      calls: window.__browserCalls,
      panel: document.querySelector('[data-tc-column="workspace"]') !== null,
    }));
    ok(inApp.calls.length >= 1 && /^https?:\/\//.test(inApp.calls[0]), '次要动作走应用内浏览视图（browserLoad）', inApp.calls.join(','));
    ok(inApp.panel, '工作区面板被打开（否则用户看不到标签页）');

    // —— 截图（浅色）
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[data-answer-evidence-toggle]')];
      if (document.querySelector('[data-answer-evidence][data-open="1"]')) return;
      buttons[0]?.click();
    });
    await page.waitForTimeout(300);
    const shot = page.locator('.tc-bubble-assistant').last();
    await page.screenshot({ path: join(OUT, 'a174-light.png'), fullPage: false });
    await shot.screenshot({ path: join(OUT, 'a174-light-answer.png') });

    // —— 截图（深色）
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, 'a174-dark.png'), fullPage: false });
    await shot.screenshot({ path: join(OUT, 'a174-dark-answer.png') });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    // 深色主题下再验一次「没有彩色强调」与对比度
    const darkStyle = await page.evaluate(() => {
      const roots = document.documentElement;
      const cs = getComputedStyle(roots);
      return { fg: cs.getPropertyValue('--td-text-color-primary').trim() };
    });
    ok(darkStyle.fg.length > 0, '深色主题令牌存在', darkStyle.fg);

    ok(pageErrors.length === 0, '没有运行时报错', pageErrors.join(' | '));
    await ctx.close();
  }

  /* ── [2] 设置项：两档可切换、会落盘 ─────────────────────────────── */
  console.log('\n[2] 设置：链接默认打开方式');
  {
    const { ctx, page, pageErrors } = await newPage(browser);
    await page.setDefaultTimeout(120000);
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.locator('[data-settings-section="appearance"]').click();
    await page.waitForSelector('[data-link-open-setting]', { timeout: 60000 });
    ok((await page.locator('[data-link-open-setting]').count()) === 1, '设置页有「链接打开方式」区块');
    ok((await page.locator('[data-link-open-option="system"]').count()) === 1, '有「系统浏览器」选项');
    ok((await page.locator('[data-link-open-option="in-app"]').count()) === 1, '有「应用内打开」选项');
    const beforeSel = await page.locator('[data-link-open-option="system"]').getAttribute('aria-checked');
    ok(beforeSel === 'true', '默认选中系统浏览器（不改变老行为）', beforeSel);
    await page.locator('[data-link-open-option="in-app"]').click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      stored: localStorage.getItem('opc.link-open-mode'),
      inApp: document.querySelector('[data-link-open-option="in-app"]').getAttribute('aria-checked'),
      system: document.querySelector('[data-link-open-option="system"]').getAttribute('aria-checked'),
    }));
    ok(after.inApp === 'true' && after.system === 'false', '选中态切换正确', `${after.inApp}/${after.system}`);
    ok(after.stored === 'in-app', '偏好写进 localStorage 镜像（落盘由 A135 链路保证）', after.stored);
    ok(pageErrors.length === 0, '设置页没有运行时报错', pageErrors.join(' | '));
    await ctx.close();
  }

  console.log(`\n截图：${join(OUT, 'a174-light.png')} / ${join(OUT, 'a174-dark.png')}`);
  console.log(`\n${failures.length === 0 ? '全部通过' : '存在失败'}：${total - failures.length} 通过 / ${failures.length} 失败`);
  if (failures.length) console.log(failures.map(f => `  · ${f}`).join('\n'));
} catch (e) {
  console.error('\n闸门执行失败：', e?.stack || e);
  failures.push('闸门执行异常');
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(vite);
  process.exit(failures.length === 0 ? 0 : 1);
}
