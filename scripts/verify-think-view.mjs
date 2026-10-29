/**
 * 思考过程展示（方案 A 消息级 + 方案 C 轨迹内）—— L2 浏览器验收。
 *
 * ## 语义：原 Agent 给什么，前端就展示什么
 *
 * 三种能力状态必须长得不一样，不能让用户猜：
 *   raw      完整推理链 → 头部「思考 · Ns · N 字」+ 正文沿左细线铺开
 *   summary  只有摘要   → 头部挂「摘要」角标（不标就让人以为看到完整思维链）
 *   未提供   不渲染    → 没有 thinking 块就没有 .tc-think 元素
 *
 * ## 展开策略（2026-10-26 用户口径，覆盖 A 的「最新一条默认展开」）
 *
 *   1. 正在流的思考 → 展开（此刻它就是正文）；
 *   2. 这条消息已经有答案正文 → 思考、轨迹、轨迹内思考全部收起 ——
 *      「输出正文回答前折叠上面的」；
 *   3. 其余（历史、无正文）→ 折叠。
 *
 * 夹具就是按这个矩阵摆的：m1 历史有正文 / m4 最新有正文 / m5 正文已开始流 /
 * m6 还在思考没有正文。四条的 open 值必须是 [false, false, false, true]。
 *
 * ## 层位
 * 静态 dist + API 夹具，不起服务端。适配器层「CLI 真的会发 reasoning 事件」
 * 由 `verify-opencode-thinking.ts`（L1）负责；匀速揭示的推进算法由
 * `verify-smooth-text.ts`（L1）负责 —— 静态夹具造不出「流式增量」，
 * 这里只能验到「揭示游标不丢字」这一层。
 *
 * 运行：npm run build && node scripts/verify-think-view.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { openAllProcess } from './lib/process-flow.mjs';

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

const THINK_RAW =
  '用户问的是磁盘剩余空间，需要先确认是哪个盘符。C 盘还是全部？直接用 PowerShell 的 Get-PSDrive 一次性读出所有驱动器的 Used / Free，比重扫整个文件系统快得多。';

const MESSAGES = [
  { id: 'm0', role: 'user', session_id: 's1', created_at: iso(400), content: '帮我看看磁盘还剩多少空间' },
  // m1：历史消息，思考 + 正文 → 折叠
  {
    id: 'm1', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(390),
    blocks: [
      {
        id: 'b1-think', type: 'thinking', state: 'done', format: 'raw',
        text: THINK_RAW,
        startedAt: Date.now() - 9000, endedAt: Date.now() - 4200,
      },
      { id: 'b1-text', type: 'text', state: 'done', text: 'C 盘剩余 58.3 GB，D 盘剩余 241.7 GB。' },
    ],
  },
  { id: 'm2', role: 'user', session_id: 's1', created_at: iso(120), content: '再查一次' },
  // m3：没有 thinking 块 → 什么都不渲染（不留空壳）
  {
    id: 'm3', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(110),
    blocks: [{ id: 'b3-text', type: 'text', state: 'done', text: 'C 盘剩余 58.2 GB。' }],
  },
  // m4：最新一条「已完成」且有正文 → 折叠（A 时代这里展开，现在让位给答案）
  {
    id: 'm4', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(60),
    blocks: [
      {
        id: 'b4-think', type: 'thinking', state: 'done', format: 'summary',
        text: '检查了磁盘用量，准备用 PowerShell 读取驱动器信息。',
        startedAt: Date.now() - 3000, endedAt: Date.now() - 900,
      },
      { id: 'b4-text', type: 'text', state: 'done', text: 'C 盘剩余 58.1 GB。' },
    ],
  },
  // m5：正文已经开始流 → 思考、轨迹、轨迹内思考全收起；同时提供方案 C 的样张
  // 注意：`isStreaming` 不写在消息上 —— 加载器逐字段映射，服务端从不发这个字段
  // （真实流式由 [9] 的 SSE 造）。这里靠 blocks 里的文本触发折叠规则。
  {
    id: 'm5', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(20),
    blocks: [
      {
        id: 'b5-think', type: 'thinking', state: 'done', format: 'raw',
        text: '先确认盘符，再决定用哪个命令。',
        startedAt: Date.now() - 8000, endedAt: Date.now() - 6000,
      },
      {
        id: 'b5-tool', type: 'tool', toolId: 't1', name: 'bash',
        input: { command: 'Get-PSDrive -PSProvider FileSystem' },
        output: 'Name Used(GB) Free(GB)\nC: 412.6 58.3\nD: 180.2 241.7',
        status: 'completed',
        startedAt: Date.now() - 6000, endedAt: Date.now() - 4000,
      },
      {
        id: 'b5-think-2', type: 'thinking', state: 'done', format: 'raw',
        text: '输出已经拿到两个盘的用量，直接念数字即可，不必再补充「如何释放空间」——用户只问了剩多少。',
        startedAt: Date.now() - 4000, endedAt: Date.now() - 3000,
      },
      {
        id: 'b5-text', type: 'text', state: 'done',
        text: 'C 盘剩余 58.3 GB，D 盘剩余 241.7 GB。',
      },
    ],
  },
  // m6：最新一条、还没有正文 → 展开（唯一该展开的一条）
  {
    id: 'm6', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(5),
    blocks: [
      {
        id: 'b6-think', type: 'thinking', state: 'done', format: 'raw',
        text: '用户又问了一次，可能想要更精确的数字。',
        startedAt: Date.now() - 2000, endedAt: Date.now() - 1000,
      },
    ],
  },
];

/* ── 真流式夹具（[9]）────────────────────────────────────────────────
 * 静态夹具造不出「正在增长」的正文（加载器逐字段映射，服务端不发
 * isStreaming），而这次要验的两件事 —— 正文一开始就折叠上面、正文匀速
 * 揭示 —— 只存在于流式过程中。所以 [9] 真跑一轮 SSE：先思考、再调工具、
 * 最后吐答案，每 120ms 一个事件，脚本在中途采样。
 */
const LIVE_DELTAS = [
  'C 盘剩余 58.3 GB，',
  'D 盘剩余 241.7 GB。',
  '两个盘都还有余量，',
  '暂时不需要清理。',
  '需要的话我可以列出',
  '占用最大的几个目录。',
];
const LIVE_FULL = LIVE_DELTAS.join('');
const sse = events =>
  events.map((e, i) => `id: ${e.seq ?? i + 1}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const LIVE_EVENTS = [
  { seq: 1, type: 'run_start', runId: 'r-live', sessionId: 's1', messageId: 'a-live', agentId: 'wb', model: 'm' },
  { seq: 2, type: 'block_open', block: { id: 'lv-think', type: 'thinking', text: '先确认盘符。', state: 'streaming', format: 'raw', startedAt: Date.now() } },
  { seq: 3, type: 'block_delta', blockId: 'lv-think', channel: 'text', delta: '直接用 Get-PSDrive 一次读完更快。' },
  { seq: 4, type: 'block_close', blockId: 'lv-think', state: 'done' },
  { seq: 5, type: 'block_open', block: { id: 'lv-tool', type: 'tool', toolId: 'lt1', name: 'bash', input: { command: 'Get-PSDrive -PSProvider FileSystem' }, status: 'running', startedAt: Date.now() } },
  { seq: 6, type: 'block_close', blockId: 'lv-tool', state: 'done' },
  { seq: 7, type: 'block_open', block: { id: 'lv-text', type: 'text', text: '', state: 'streaming' } },
  ...LIVE_DELTAS.map((delta, i) => ({ seq: 8 + i, type: 'block_delta', blockId: 'lv-text', channel: 'text', delta })),
  { seq: 20, type: 'block_close', blockId: 'lv-text', state: 'done' },
  { seq: 21, type: 'run_end', runId: 'r-live', status: 'ok', durationMs: 2400 },
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
    // 慢速 SSE：fulfill 是一次性写回整个 body，那样测不到「正在增长」，
    // 所以 /api/chat 必须由真实服务器分片写。
    if (req.url.startsWith('/api/chat')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let i = 0;
        const tick = () => {
          if (i >= LIVE_EVENTS.length) return res.end();
          res.write(sse([LIVE_EVENTS[i++]]));
          setTimeout(tick, 120);
        };
        tick();
      });
      return;
    }
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
  // /api/chat 交给服务器（慢速 SSE），不要在这里 fulfill
  if (url.includes('/api/chat')) return route.continue();
  if (url.includes('/api/agent-credentials')) return json({ credentials: [] });
  if (/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    const s = SESSIONS.find(x => x.id === id) ?? SESSIONS[0];
    return json({ session: s, messages: MESSAGES });
  }
  if (/api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
  if (/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/api\/models/.test(url)) return json({ models: MODELS });
  if (/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
/* A149：有答案的消息，过程（思考 / 轨迹）默认收在 ProcessFlow 里且子节点整棵
   卸载。本脚本按 `.tc-think` 的下标验「三态 + 展开策略」，不先展开就会数到
   0 条、下标全错。展开过程流不影响各 details 自己的 open 状态（那个由
   `collapse` prop 驱动），所以下面的断言口径一个字都不用改。 */
await openAllProcess(page);

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
    // 轨迹内思考是另一个类，不该被数进来
    noteCount: document.querySelectorAll('.tc-think-note').length,
  };
});
ok(states.count === 4, '消息级思考 4 条（无 thinking 块的那条不留空壳）', String(states.count));
ok(states.formats.join(',') === 'raw,summary,raw,raw', '格式标记如实透传', states.formats.join(','));
ok(states.badges[0] === null, 'raw 不挂角标', String(states.badges[0]));
ok(states.badges[1] === '摘要', 'summary 挂「摘要」角标', String(states.badges[1]));
ok(/思考/.test(states.heads[0]), '头部是「思考」', states.heads[0]);
ok(states.metaTexts.some(t => /^\d+\s*字$/.test(t)), '头部保留字数（用户口径：保留）', states.metaTexts.join(' / '));
ok(states.metaTexts.some(t => /^\d+\s*s$/.test(t)), '头部保留耗时（数字 + s）', states.metaTexts.join(' / '));
ok(states.bodyCount === 4, '每个消息级思考块有正文容器', String(states.bodyCount));

// ── [2] 展开策略矩阵 ─────────────────────────────────────────────────
console.log('\n[2] 展开策略：正文出现就折叠上面的');
const openState = await page.evaluate(() =>
  [...document.querySelectorAll('.tc-think')].map(n => n.open)
);
ok(openState[0] === false, '历史消息（有正文）的思考折叠', String(openState[0]));
ok(openState[1] === false, '最新一条「已完成且有正文」也折叠（覆盖 A 的默认展开）', String(openState[1]));
ok(openState[2] === false, '正文已出现的消息，上方思考折叠', String(openState[2]));
ok(openState[3] === true, '最新一条「还没有正文」的思考展开（过程此刻就是内容）', String(openState[3]));

// ── [3] 正文视觉契约（方案 A）────────────────────────────────────────
console.log('\n[3] 正文视觉契约：左细线 + 14px secondary + 正体（A149 与答案正文同档）');
const body = await page.evaluate(() => {
  const el = document.querySelector('.tc-think[data-think-format="raw"] .tc-think-body');
  if (!el) return null;
  const cs = getComputedStyle(el);
  // 探针：把令牌解析成真实 rgb() 再比，避免写死 18%（深色是 20% 白）
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
  ok(body.fontSize === '14px', '正文字号 14px = 答案正文字号（A149 抬档，不是 12px 斜体脚注）', body.fontSize);
  ok(body.fontStyle === 'normal', '正体，不斜体', body.fontStyle);
  ok(body.paddingLeft === '13px', '左内缩 13px', body.paddingLeft);
  ok(body.borderLeftWidth === '2px' && body.borderLeftStyle === 'solid', '左细线 2px solid', `${body.borderLeftWidth} ${body.borderLeftStyle}`);
  ok(body.borderLeftColor === body.ruleToken, '左细线颜色 = --tc-rule（读令牌，不写死百分比）', body.borderLeftColor);
  ok(body.color === body.tok.secondary, '正文颜色 = secondary（比答案轻一档，不是最浅那档）', body.color);
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
// 所以只能量展开的那一条 —— 夹具里唯一展开的是 m6（还在思考）。
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
await page.click('.tc-think[data-think-format="raw"] > summary');
await page.waitForTimeout(200);
const afterOpen = await page.evaluate(() =>
  document.querySelector('.tc-think[data-think-format="raw"]')?.open
);
ok(afterOpen === true, '手动展开历史消息的思考（不会被「已折叠」状态抢回去）', String(afterOpen));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
/* A149：刷新后过程流又回到默认收起态，`.tc-think` 会跟着卸载 ——
   重新展开一次，下面的下标断言才数得到 4 条。 */
await openAllProcess(page);
const afterReload = await page.evaluate(() => [...document.querySelectorAll('.tc-think')].map(n => n.open));
ok(
  JSON.stringify(afterReload) === JSON.stringify([false, false, false, true]),
  '刷新后回到默认策略（只有「正在思考且无正文」那条展开），不靠持久化状态',
  JSON.stringify(afterReload)
);

// ── [6] 轨迹内思考（方案 C）───────────────────────────────────────────
console.log('\n[6] 轨迹内思考：正体 14px + 左细线（方案 C，A149 与答案正文同档）');
const traceState = await page.evaluate(() => {
  const trace = document.querySelector('[data-trace]');
  const bar = trace?.querySelector('[data-steps-bar]');
  return {
    traces: document.querySelectorAll('[data-trace]').length,
    aria: bar?.getAttribute('aria-expanded') ?? null,
    scroll: document.querySelectorAll('[data-trace-scroll]').length,
  };
});
ok(traceState.traces === 1, '只有一条消息带工具轨迹', String(traceState.traces));
ok(traceState.aria === 'false', '正文已出现 → 轨迹收起（把版面让给答案）', String(traceState.aria));
ok(traceState.scroll === 0, '收起态不渲染步骤（动画播完就卸载，不白养子树）', String(traceState.scroll));

// 展开轨迹，读方案 C 的正文规格
await page.click('[data-steps-bar]');
await page.waitForTimeout(500);
const expandedFold = await page.evaluate(() => ({
  fold: document.querySelector('[data-trace-fold]')?.getAttribute('data-fold') ?? null,
  noteOpen: document.querySelector('.tc-think-note')?.open ?? null,
  // 轨迹内思考是独立一类，不能被数进 `.tc-think`（否则消息级的两条断言会串味）
  noteCount: document.querySelectorAll('.tc-think-note').length,
  messageThinkCount: document.querySelectorAll('.tc-think').length,
}));
ok(expandedFold.fold === '1', '展开后 data-fold=1（过渡动画的状态锚点）', String(expandedFold.fold));
ok(expandedFold.noteOpen === false, '正文已出现 → 轨迹内思考也收起（不再自动铺开）', String(expandedFold.noteOpen));
ok(
  expandedFold.noteCount === 1 && expandedFold.messageThinkCount === 4,
  '轨迹内思考单独一类（不混进 .tc-think）',
  `${expandedFold.noteCount} / ${expandedFold.messageThinkCount}`
);
const note = await page.evaluate(() => {
  const el = document.querySelector('.tc-think-note-body');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const probe = (prop, value) => {
    const s = document.createElement('span');
    s.style[prop] = value;
    document.body.appendChild(s);
    const out = getComputedStyle(s)[prop];
    s.remove();
    return out;
  };
  const head = document.querySelector('.tc-think-note > summary');
  const hcs = head ? getComputedStyle(head) : null;
  return {
    fontSize: cs.fontSize,
    fontStyle: cs.fontStyle,
    lineHeight: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
    fontFamily: cs.fontFamily.toLowerCase(),
    color: cs.color,
    background: cs.backgroundColor,
    paddingLeft: cs.paddingLeft,
    borderLeftWidth: cs.borderLeftWidth,
    borderLeftStyle: cs.borderLeftStyle,
    borderLeftColor: cs.borderLeftColor,
    rule: probe('borderLeftColor', 'var(--tc-rule)'),
    secondary: probe('color', 'var(--td-text-color-secondary)'),
    headFontSize: hcs?.fontSize ?? null,
    headColor: hcs?.color ?? null,
    headText: head?.textContent ?? '',
  };
});
ok(note != null, '轨迹内思考正文存在');
if (note) {
  ok(note.fontSize === '14px', '正文字号 14px（A149：不再比消息级思考小半档）', note.fontSize);
  ok(note.fontStyle === 'normal', '正体，不再斜体', note.fontStyle);
  ok(note.color === note.secondary, '正文颜色 = secondary（不是最浅一档 placeholder）', note.color);
  ok(note.borderLeftWidth === '2px' && note.borderLeftStyle === 'solid', '左细线 2px solid', `${note.borderLeftWidth} ${note.borderLeftStyle}`);
  ok(note.borderLeftColor === note.rule, '左细线颜色 = --tc-rule（与方案 A 同一条令牌）', note.borderLeftColor);
  ok(note.paddingLeft === '11px', '左内缩 11px（轨迹里空间更紧，比 A 浅）', note.paddingLeft);
  ok(note.background === 'rgba(0, 0, 0, 0)' || note.background === 'transparent', '无 3% 底色（不再是工具输出的盒子）', note.background);
  ok(!/mono|consolas|courier/.test(note.fontFamily), '不再用等宽字体（那是工具输出的语言）', note.fontFamily.split(',')[0]);
  ok(Math.abs(note.lineHeight - 1.7) < 0.02, '行高 1.7', note.lineHeight.toFixed(2));
  ok(note.headFontSize === '12px', '头部 12px（与方案 A 同一档）', note.headFontSize);
  ok(note.headColor === note.secondary, '头部颜色 = secondary', note.headColor);
  ok(note.headText.includes('深度思考') && note.headText.includes('字'), '头部保留「深度思考 + 字数」', note.headText);
}

// ── [7] 匀速揭示的接线 ────────────────────────────────────────────────
// 静态夹具造不出「流式增量」（加载器逐字段映射，服务端不发 isStreaming），
// 这里只守两条：所有正文都走 AnswerMarkdown、揭示游标没有把字吞掉。
// 真正的流式揭示在 [9] 由 SSE 验。
console.log('\n[7] 正文匀速揭示：接线与不丢字');
const reveal = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('[data-answer-markdown]')];
  return nodes.map(n => ({
    revealed: Number(n.getAttribute('data-revealed')),
    streaming: n.getAttribute('data-answer-streaming'),
  }));
});
ok(reveal.length === 4, '4 段正文都走 AnswerMarkdown', String(reveal.length));
ok(
  reveal.every(r => Number.isFinite(r.revealed) && r.revealed > 0),
  '揭示游标都有值（没有渲染成空）',
  reveal.map(r => r.revealed).join(',')
);
ok(
  reveal.every(r => r.streaming === '0'),
  '历史正文一律非流式（不重打一遍）',
  reveal.map(r => r.streaming).join(',')
);

// ── [8] --tc-rule 明暗双主题都有 ─────────────────────────────────────
console.log('\n[8] --tc-rule 双主题令牌');
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
  const note = document.querySelector('.tc-think-note-body');
  // 角标在 summary 里，折叠态的 details 也看得见 —— 别再加 `[open]` 前缀，
  // 唯一带角标的那条恰好是折叠的（m4），加了就永远读不到。
  const badge = document.querySelector('.tc-think-badge');
  return {
    rule: body ? getComputedStyle(body).borderLeftColor : null,
    color: body ? getComputedStyle(body).color : null,
    noteRule: note ? getComputedStyle(note).borderLeftColor : null,
    badge: badge ? getComputedStyle(badge).backgroundColor : null,
  };
});
ok(dark.rule === 'rgba(255, 255, 255, 0.2)', '深色下左细线真解析为 20% 白', dark.rule);
ok(dark.color === 'rgb(163, 163, 163)', '深色下正文跟随 secondary 提亮', dark.color);
ok(dark.noteRule === 'rgba(255, 255, 255, 0.2)', '深色下轨迹内思考的左细线同步', dark.noteRule);
ok(dark.badge.includes('0.1'), '深色下角标底色仍是有色透明底（不是纯黑块）', dark.badge);

// ── [9] 真流式：正文一开始就折叠上面 + 正文匀速揭示 ─────────────────────
console.log('\n[9] 真流式：正文开始 → 折叠上面 / 匀速揭示');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.fill('textarea', '再看一次磁盘');
await page.press('textarea', 'Enter');

const live = [];
for (let i = 0; i < 46; i++) {
  live.push(await page.evaluate(() => {
    const answers = [...document.querySelectorAll('[data-answer-markdown]')];
    const last = answers[answers.length - 1];
    const thinks = [...document.querySelectorAll('.tc-think')];
    const bars = [...document.querySelectorAll('[data-steps-bar]')];
    return {
      streaming: last?.getAttribute('data-answer-streaming') ?? null,
      revealed: last ? Number(last.getAttribute('data-revealed')) : -1,
      thinkOpen: thinks.length ? thinks[thinks.length - 1].open : null,
      thinkText: thinks.length ? thinks[thinks.length - 1].querySelector('summary')?.textContent ?? '' : '',
      traceAria: bars.length ? bars[bars.length - 1].getAttribute('aria-expanded') : null,
    };
  }));
  await page.waitForTimeout(80);
}

const streamingSamples = live.filter(s => s.streaming === '1');
ok(streamingSamples.length >= 5, '抓到流式过程（不是一次性渲染）', String(streamingSamples.length));
ok(
  live.some(s => s.thinkText.includes('思考中')),
  '思考流式时头部是「思考中」',
  live.find(s => s.thinkText.includes('思考中'))?.thinkText ?? '（没抓到）'
);
ok(
  live.some(s => s.thinkOpen === true),
  '思考流式时展开（过程此刻就是内容）',
  String(live.some(s => s.thinkOpen === true))
);
ok(
  live.some(s => s.traceAria === 'true'),
  '工具跑起来时轨迹自动展开',
  String(live.some(s => s.traceAria === 'true'))
);
// 正文开始之后：思考、轨迹都必须收起。
// 判据是「正文里已经有字」（revealed > 0）—— 空文本块开出来时不该折叠，
// 否则每轮都会在「刚准备说话」的那一帧抖一下。
const idx = live.findIndex(s => s.streaming === '1' && s.revealed > 0);
ok(idx > 0, '取到「正文已有字」的采样点', String(idx));
const afterText = idx > 0 ? live.slice(idx) : [];
ok(
  afterText.length > 0 && afterText.every(s => s.thinkOpen === false),
  '正文一出字，上方思考立即折叠',
  afterText.map(s => s.thinkOpen).join(',')
);
ok(
  afterText.length > 0 && afterText.every(s => s.traceAria === null || s.traceAria === 'false'),
  '正文一出字，上方轨迹同时折叠',
  afterText.map(s => s.traceAria).join(',')
);

// 揭示：单调不减、过程中确实落后于全文、结束后补齐
const revealed = streamingSamples.map(s => s.revealed).filter(n => n >= 0);
ok(revealed.length >= 3, '流式期间取到多个揭示游标', String(revealed.length));
ok(
  revealed.every((n, i) => i === 0 || n >= revealed[i - 1]),
  '揭示游标单调不减（不会回退重排）',
  revealed.join(',')
);
ok(
  new Set(revealed).size >= 3,
  '揭示是逐字推进，不是整段砸下来',
  `${new Set(revealed).size} 个不同值`
);
ok(
  revealed.some(n => n < LIVE_FULL.length - 5),
  '流式期间确实落后于全文（说明节流生效）',
  `${Math.max(...revealed)} / ${LIVE_FULL.length}`
);

const settled = await page.evaluate(() => {
  const answers = [...document.querySelectorAll('[data-answer-markdown]')];
  const last = answers[answers.length - 1];
  const thinks = [...document.querySelectorAll('.tc-think')];
  return {
    revealed: Number(last?.getAttribute('data-revealed')),
    streaming: last?.getAttribute('data-answer-streaming'),
    thinkOpen: thinks[thinks.length - 1]?.open ?? null,
  };
});
ok(settled.streaming === '0', '结束后标记回落到非流式', String(settled.streaming));
ok(settled.revealed === LIVE_FULL.length, '结束后揭示到全文（不会永远少半句）', `${settled.revealed}/${LIVE_FULL.length}`);
ok(settled.thinkOpen === false, '结束后思考保持折叠（不会「哗」地展开一片）', String(settled.thinkOpen));

// 截图：一轮真流式跑完后的实际长相（轨迹展开看方案 C）
await openAllProcess(page);
await page.locator('[data-steps-bar]').last().click();
await page.waitForTimeout(500);
const liveShots = join(OUT, 'think');
await page.screenshot({ path: join(liveShots, 'live-done.png'), fullPage: false });

// ── 截图（三态 + 浅色），给用户看实际长相 ─────────────────────────────
const shots = join(OUT, 'think');
await mkdir(shots, { recursive: true });
await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.waitForTimeout(400);
await openAllProcess(page);
const nodes = page.locator('.tc-think');
await nodes.nth(0).locator('> summary').click();
await page.waitForTimeout(300);
await nodes.nth(0).screenshot({ path: join(shots, 'light-raw.png') });
await nodes.nth(0).locator('> summary').click();
await page.waitForTimeout(300);
await nodes.nth(0).screenshot({ path: join(shots, 'light-collapsed.png') });
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
