/**
 * 思考过程展示（方案 A）—— L2 浏览器验收。
 *
 * ## 语义：原 Agent 给什么，前端就展示什么
 *
 * 三种能力状态必须长得不一样，不能让用户猜：
 *   raw      完整推理链 → 头部「思考 · Ns · N 字」+ 正文沿左细线铺开
 *   summary  只有摘要   → 头部挂「摘要」角标（不标就让人以为看到完整思维链）
 *   未提供   不渲染    → 没有 thinking 块就没有 .tc-think 元素
 *
 * 默认展开策略：正在流的这一条 + 最新一条助手消息；其余历史折叠。
 *
 * ## 层位
 * 静态 dist + API 夹具，不起服务端。适配器层「CLI 真的会发 reasoning 事件」
 * 由 `verify-opencode-thinking.ts`（L1 纯函数）负责 —— 那才是 opencode 早期
 * 「声明了 thinking 能力但界面一直空白」的根因（buildArgs 没传 --thinking）。
 *
 * ## 为什么单独一个脚本
 * `verify-a85` 的夹具里唯一的 thinking 块紧跟在工具之后，被收进轨迹，
 * 走的是 AgentTrace 的嵌套节点（规格不同）。消息级开头思考（ThinkingView）
 * 的视觉契约在这里守着 —— 否则改坏它只会表现为「截图上看着怪」，没有任何
 * 脚本会红。
 *
 * 运行：npm run build && node scripts/verify-think-view.mjs
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
];
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const SESSIONS = [{ id: 's1', title: '思考展示', agent_id: 'wb', model: 'm', created_at: new Date().toISOString() }];

const iso = secAgo => new Date(Date.now() - secAgo * 1000).toISOString();

// 故意排成：历史一条（raw，应收起）+ 无思考的一条（absent）+ 最新一条（summary，应展开）
const MESSAGES = [
  { id: 'm0', role: 'user', session_id: 's1', created_at: iso(300), content: '帮我看看磁盘还剩多少空间' },
  {
    id: 'm1', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(290),
    blocks: [
      {
        id: 'b1-think', type: 'thinking', state: 'done', format: 'raw',
        text: '用户问的是磁盘剩余空间，需要先确认是哪个盘符。C 盘还是全部？直接用 PowerShell 的 Get-PSDrive 一次性读出所有驱动器的 Used / Free，比重扫整个文件系统快得多。',
        startedAt: Date.now() - 9000, endedAt: Date.now() - 4200,
      },
      { id: 'b1-text', type: 'text', state: 'done', text: 'C 盘剩余 58.3 GB，D 盘剩余 241.7 GB。' },
    ],
  },
  { id: 'm2', role: 'user', session_id: 's1', created_at: iso(120), content: '再查一次' },
  {
    id: 'm3', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(110),
    blocks: [{ id: 'b3-text', type: 'text', state: 'done', text: 'C 盘剩余 58.2 GB。' }],
  },
  {
    id: 'm4', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(10),
    blocks: [
      {
        id: 'b4-think', type: 'thinking', state: 'done', format: 'summary',
        text: '检查了磁盘用量，准备用 PowerShell 读取驱动器信息。',
        startedAt: Date.now() - 3000, endedAt: Date.now() - 900,
      },
      { id: 'b4-text', type: 'text', state: 'done', text: 'C 盘剩余 58.1 GB。' },
    ],
  },
];

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p.endsWith('/index.html')) p = '/index.html';
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
await ctx.route('**/api/**', route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/agent-credentials')) return json({ credentials: [] });
  if (/\api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    const s = SESSIONS.find(x => x.id === id) ?? SESSIONS[0];
    return json({ session: s, messages: MESSAGES });
  }
  if (/\api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
  if (/\api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\api\/models/.test(url)) return json({ models: MODELS });
  if (/\api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// ── [1] 三种能力状态 ─────────────────────────────────────────────────
console.log('\n[1] 三种能力状态');
const states = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.tc-think')];
  const badge = n => n.querySelector('.tc-think-badge')?.textContent ?? null;
  const head = n => n.querySelector('summary')?.textContent ?? '';
  // 头部的元信息位（耗时、字数）拆出来单独验：连成 textContent 后
  // 「5s97 字」里的 s 后面接数字，用 \b 判不出词边界。
  const metaTexts = nodes[0]
    ? [...nodes[0].querySelectorAll('.tc-think-meta')].map(e => e.textContent)
    : [];
  return {
    count: nodes.length,
    formats: nodes.map(n => n.getAttribute('data-think-format')),
    badges: nodes.map(n => badge(n)),
    heads: nodes.map(n => head(n)),
    metaTexts,
    bodyCount: document.querySelectorAll('.tc-think-body').length,
  };
});
ok(states.count === 2, '只有两条思考被渲染（无 thinking 块的那条不留空壳）', String(states.count));
ok(states.formats.join(',') === 'raw,summary', '格式标记如实透传', states.formats.join(','));
ok(states.badges[0] === null, 'raw 不挂角标', String(states.badges[0]));
ok(states.badges[1] === '摘要', 'summary 挂「摘要」角标', String(states.badges[1]));
ok(/思考/.test(states.heads[0]), '头部是「思考」', states.heads[0]);
ok(states.metaTexts.some(t => /^\d+\s*字$/.test(t)), '头部保留字数（用户口径：保留）', states.metaTexts.join(' / '));
ok(states.metaTexts.some(t => /^\d+\s*s$/.test(t)), '头部保留耗时（数字 + s）', states.metaTexts.join(' / '));
ok(states.bodyCount === 2, '每个思考块有正文容器', String(states.bodyCount));

// ── [2] 默认展开策略 ─────────────────────────────────────────────────
console.log('\n[2] 默认展开策略');
const openState = await page.evaluate(() =>
  [...document.querySelectorAll('.tc-think')].map(n => n.open)
);
ok(openState[0] === false, '历史消息的思考默认折叠', String(openState[0]));
ok(openState[1] === true, '最新一条助手消息的思考默认展开', String(openState[1]));

// ── [3] 正文视觉契约（方案 A）────────────────────────────────────────
console.log('\n[3] 正文视觉契约：左细线 + 13px secondary + 正体');
const body = await page.evaluate(() => {
  const el = document.querySelector('.tc-think[data-think-format="raw"] .tc-think-body');
  if (!el) return null;
  const cs = getComputedStyle(el);
  // 探针：把令牌解析成真实 rgb() 再比，避免写死 18%（深色是 24% 白）
  const probeEl = document.createElement('span');
  probeEl.style.borderLeftColor = 'var(--tc-rule)';
  document.body.appendChild(probeEl);
  const ruleToken = getComputedStyle(probeEl).borderLeftColor;
  probeEl.remove();
  const tok = {};
  for (const [k, v] of Object.entries({
    secondary: 'var(--td-text-color-secondary)',
    placeholder: 'var(--td-text-color-placeholder)',
  })) {
    const s = document.createElement('span');
    s.style.color = v;
    document.body.appendChild(s);
    tok[k] = getComputedStyle(s).color;
    s.remove();
  }
  return {
    fontSize: cs.fontSize,
    fontStyle: cs.fontStyle,
    lineHeight: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
    paddingLeft: cs.paddingLeft,
    borderLeftWidth: cs.borderLeftWidth,
    borderLeftStyle: cs.borderLeftStyle,
    borderLeftColor: cs.borderLeftColor,
    color: cs.color,
    background: cs.backgroundColor,
    ruleToken,
    tok,
  };
});
ok(body != null, '正文容器存在');
if (body) {
  ok(body.fontSize === '13px', '正文字号 13px（不是 12px 斜体脚注）', body.fontSize);
  ok(body.fontStyle === 'normal', '正体，不斜体', body.fontStyle);
  ok(body.paddingLeft === '13px', '左内缩 13px', body.paddingLeft);
  ok(body.borderLeftWidth === '2px' && body.borderLeftStyle === 'solid', '左细线 2px solid', `${body.borderLeftWidth} ${body.borderLeftStyle}`);
  ok(body.borderLeftColor === body.ruleToken, '左细线颜色 = --tc-rule（读令牌，不写死百分比）', body.borderLeftColor);
  ok(body.color === body.tok.secondary, '正文颜色 = secondary（比答案轻一档，不是一档灰之外的最浅）', body.color);
  ok(body.background === 'rgba(0, 0, 0, 0)' || body.background === 'transparent', '无背景卡（不是盒子）', body.background);
  ok(
    Math.abs(body.lineHeight - 1.75) < 0.02,
    '行高 1.75（长推理链要透气）',
    body.lineHeight.toFixed(2)
  );
}

// ── [4] 头部视觉契约 ─────────────────────────────────────────────────
console.log('\n[4] 头部视觉契约');
const headStyle = await page.evaluate(() => {
  // 探针元素：把令牌解析成真实 rgb() 再比。不写死 hex —— 本项目的品牌色
  // 是近黑 #1f1f1f（不是 TDesign 默认的 #0052d9），写死等于把主题写死。
  // 用属性赋值而不是 setProperty：后者在 Chromium 里会静默拒绝这条声明
  // （style 属性直接变 null），断言会永远读到 transparent 而看起来像产品 bug。
  const probe = (prop, value) => {
    const el = document.createElement('span');
    el.style[prop] = value;
    document.body.appendChild(el);
    const out = getComputedStyle(el)[prop];
    el.remove();
    return out;
  };
  const el = document.querySelector('.tc-think > summary');
  const title = document.querySelector('.tc-think > summary .tc-think-title');
  const meta = document.querySelector('.tc-think > summary .tc-think-meta');
  const badge = document.querySelector('.tc-think > summary .tc-think-badge');
  return {
    cs: el ? getComputedStyle(el) : null,
    titleFont: title ? getComputedStyle(title).fontWeight : null,
    metaFont: meta ? getComputedStyle(meta).fontSize : null,
    metaColor: meta ? getComputedStyle(meta).color : null,
    badgeColor: badge ? getComputedStyle(badge).color : null,
    badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
    token: {
      brand: probe('color', 'var(--td-brand-color)'),
      brandBg: probe(
        'backgroundColor',
        'color-mix(in srgb, var(--td-brand-color) 10%, transparent)'
      ),
    },
  };
});
if (headStyle.cs) {
  ok(headStyle.cs.fontSize === '12px', '头部字号 12px（secondary 档）', headStyle.cs.fontSize);
  ok(headStyle.cs.color === body?.tok?.secondary, '头部颜色 = secondary', headStyle.cs.color);
  ok(headStyle.cs.display === 'flex' && parseFloat(headStyle.cs.gap) === 7, '头部 flex + 7px 间距', `${headStyle.cs.display} / ${headStyle.cs.gap}`);
}
ok(headStyle.titleFont === '500', '「思考」标题 500 字重', headStyle.titleFont);
ok(headStyle.metaFont === '11px', '元信息 11px（caption 档）', headStyle.metaFont);
ok(headStyle.metaColor === body?.tok?.placeholder, '元信息 = placeholder（比标题更淡）', headStyle.metaColor);
ok(headStyle.badgeColor === headStyle.token.brand, '摘要角标文字 = 品牌色（读令牌，不写死 hex）', headStyle.badgeColor);
ok(headStyle.badgeBg === headStyle.token.brandBg, '摘要角标底色 = 10% 品牌色', `${headStyle.badgeBg} vs ${headStyle.token.brandBg}`);

// ── [4b] 几何：左细线与头部图标同一条竖线 ─────────────────────────────
// 折叠态下 details 的子元素 bounding rect 是 0（浏览器不给折叠内容布局），
// 所以只能量展开的那一条。
console.log('\n[4b] 几何对齐');
const geo = await page.evaluate(() => {
  const node = document.querySelector('.tc-think[open]');
  const head = node.querySelector('summary');
  const icon = node.querySelector('summary > svg');
  const body = node.querySelector('.tc-think-body');
  const box = body.getBoundingClientRect();
  return {
    iconLeft: icon ? Math.round(icon.getBoundingClientRect().left * 10) / 10 : null,
    ruleLeft: Math.round(box.left * 10) / 10,
    headLeft: Math.round(head.getBoundingClientRect().left * 10) / 10,
    bodyWidth: Math.round(box.width),
    containerWidth: Math.round(node.getBoundingClientRect().width),
  };
});
ok(
  geo.iconLeft != null && Math.abs(geo.iconLeft - geo.ruleLeft) <= 1,
  '头部图标左缘与左细线对齐（读起来是同一条竖线的开头）',
  `${geo.iconLeft} vs ${geo.ruleLeft}`
);
ok(
  geo.headLeft < geo.ruleLeft,
  '头部 hover 底色比正文更靠左（负边距撑出去，悬停范围覆盖细线）',
  `${geo.headLeft} vs ${geo.ruleLeft}`
);
ok(
  geo.bodyWidth === geo.containerWidth,
  '正文宽度撑满思考块（不是缩进去的小盒子）',
  `${geo.bodyWidth} vs ${geo.containerWidth}`
);

// ── [5] 用户的手动选择不被抢回去 ──────────────────────────────────────
console.log('\n[5] 用户折叠 / 展开的手动选择被尊重');
const before = await page.evaluate(() => [...document.querySelectorAll('.tc-think')].map(n => n.open));
await page.click('.tc-think[data-think-format="raw"] > summary');
await page.waitForTimeout(200);
const afterOpen = await page.evaluate(() =>
  document.querySelector('.tc-think[data-think-format="raw"]')?.open
);
ok(afterOpen === true, '手动展开历史消息的思考', String(afterOpen));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const afterReload = await page.evaluate(() => [...document.querySelectorAll('.tc-think')].map(n => n.open));
ok(
  JSON.stringify(afterReload) === JSON.stringify([false, true]),
  '刷新后回到默认策略（历史折叠 / 最新展开），不靠持久化状态',
  JSON.stringify(afterReload)
);
void before;

// ── [6] --tc-rule 明暗双主题都有 ─────────────────────────────────────
console.log('\n[6] --tc-rule 双主题令牌');
const css = await readFile(join(ROOT, 'src', 'index.css'), 'utf8');
ok(css.includes('--tc-rule: rgb(0 0 0 / 0.18)'), '浅色 --tc-rule = 18% 墨');
ok(css.includes('--tc-rule: rgb(255 255 255 / 0.2)'), '深色 --tc-rule = 20% 白');
ok(!/\bvar\(--tc-rule\)[^}]*!important/.test(css), '左细线不靠 !important');
// 两个主题的 alpha 都必须压在 0.21 以内 —— verify:surface 的边线审计
// 会把「非品牌色且 alpha > 0.21」判成强度失控的版面分割线。
for (const m of css.matchAll(/--tc-rule: rgb\([^)]*\/\s*([0-9.]+)\)/g)) {
  ok(Number(m[1]) <= 0.21, `--tc-rule alpha ${m[1]} ≤ 0.21（过审）`, m[1]);
}

// 深色下真跑一次解析，不只看源码里写了什么
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(400);
const dark = await page.evaluate(() => {
  const body = document.querySelector('.tc-think[open] .tc-think-body');
  const badge = document.querySelector('.tc-think[open] .tc-think-badge');
  return {
    rule: body ? getComputedStyle(body).borderLeftColor : null,
    color: body ? getComputedStyle(body).color : null,
    badge: badge ? getComputedStyle(badge).backgroundColor : null,
  };
});
ok(dark.rule === 'rgba(255, 255, 255, 0.2)', '深色下左细线真解析为 20% 白', dark.rule);
ok(dark.color === 'rgb(163, 163, 163)', '深色下正文跟随 secondary 提亮', dark.color);
ok(dark.badge.includes('0.1'), '深色下角标底色仍是有色透明底（不是纯黑块）', dark.badge);

// ── 截图（三态 + 浅色），给用户看实际长相 ─────────────────────────────
// 此刻页面还是深色（上一节的真解析检查刚加的 class），顺手把深色三态拍下来。
const shots = join(OUT, 'think');
await mkdir(shots, { recursive: true });
const nodes = page.locator('.tc-think');
await nodes.nth(0).locator('> summary').click();
await page.waitForTimeout(300);
await nodes.nth(0).screenshot({ path: join(shots, 'dark-raw.png') });
await nodes.nth(1).screenshot({ path: join(shots, 'dark-summary.png') });
await nodes.nth(0).locator('> summary').click();
await page.waitForTimeout(300);
await nodes.nth(0).screenshot({ path: join(shots, 'dark-collapsed.png') });

await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.waitForTimeout(400);
await nodes.nth(1).screenshot({ path: join(shots, 'light-summary.png') });
await page.screenshot({ path: join(OUT, 'think-view.png'), fullPage: true });

if (errors.length) {
  console.log(`\n页面报错：${errors.slice(0, 5).join(' | ')}`);
}

console.log(`\n${total - failures.length}/${total} 通过`);
await browser.close();
server.close();
if (failures.length > 0) {
  console.error(`\n失败：\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
