/**
 * 思考过程展示（2026-11-22 改版：思考行 = 流程内兄弟行）—— 浏览器验收。
 *
 * ## 语义：原 Agent 给什么，前端就展示什么
 *
 * 三种能力状态必须长得不一样，不能让用户猜：
 *   raw      完整推理链 → 「深度思考」行，点开看正文
 *   summary  只有摘要   → 行上挂「摘要」角标（不标就让人以为看到完整思维链）
 *   未提供   不渲染    → 没有 thinking 块就没有思考行
 *   redacted 厂商隐去   → 「已隐去」，无正文、不可展开
 *
 * ## 参考页形态（2026-11-22 改版，旧 ThinkingView / 消息级思考块退役）
 *   思考是步骤流里的兄弟行（紧跟它的工具行之后），圆点 + 动词 + 耗时；
 *   点开 = 左竖线思考正文（pf-think-note）。
 *
 * ## 层位
 * 静态 dist + API 夹具，不起服务端。适配器层「CLI 真的会发 reasoning 事件」
 * 由 verify-opencode-thinking.ts（L1）负责；匀速揭示由 verify-smooth-text.ts。
 * 运行：npm run build && node scripts/verify-think-view.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check');
import { resolveChromePath } from './lib/chrome.mjs';
const CHROME = resolveChromePath();
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
  // m1：历史，思考(raw) + 正文 → 默认折叠
  {
    id: 'm1', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(390),
    blocks: [
      { id: 'b1-think', type: 'thinking', state: 'done', format: 'raw', text: THINK_RAW, startedAt: Date.now() - 9000, endedAt: Date.now() - 4200 },
      { id: 'b1-text', type: 'text', state: 'done', text: 'C 盘剩余 58.3 GB，D 盘剩余 241.7 GB。' },
    ],
  },
  { id: 'm2', role: 'user', session_id: 's1', created_at: iso(120), content: '再查一次' },
  // m3：没有 thinking 块 → 不渲染思考行（纯文本消息不走流程，走答案区）
  {
    id: 'm3', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(110),
    blocks: [{ id: 'b3-text', type: 'text', state: 'done', text: 'C 盘剩余 58.2 GB。' }],
  },
  // m4：最新「已完成」且有正文 → 折叠；思考是 summary → 挂「摘要」角标
  {
    id: 'm4', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(60),
    blocks: [
      { id: 'b4-think', type: 'thinking', state: 'done', format: 'summary', text: '检查了磁盘用量，准备用 PowerShell 读取驱动器信息。', startedAt: Date.now() - 3000, endedAt: Date.now() - 900 },
      { id: 'b4-text', type: 'text', state: 'done', text: 'C 盘剩余 58.1 GB。' },
    ],
  },
  // m5：思考(raw) + 工具 + 思考 + 正文 → 两条思考都在流程里
  {
    id: 'm5', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(20),
    blocks: [
      { id: 'b5-think', type: 'thinking', state: 'done', format: 'raw', text: '先确认盘符，再决定用哪个命令。', startedAt: Date.now() - 8000, endedAt: Date.now() - 6000 },
      { id: 'b5-tool', type: 'tool', toolId: 't1', name: 'bash', input: { command: 'Get-PSDrive -PSProvider FileSystem' }, output: 'Name Used(GB) Free(GB)\nC: 412.6 58.3\nD: 180.2 241.7', status: 'completed', startedAt: Date.now() - 6000, endedAt: Date.now() - 4000 },
      { id: 'b5-think-2', type: 'thinking', state: 'done', format: 'raw', text: '输出已经拿到两个盘的用量，直接念数字即可，不必再补充「如何释放空间」——用户只问了剩多少。', startedAt: Date.now() - 4000, endedAt: Date.now() - 3000 },
      { id: 'b5-text', type: 'text', state: 'done', text: 'C 盘剩余 58.3 GB，D 盘剩余 241.7 GB。' },
    ],
  },
  // m6：最新一条、还没有正文 → 思考行展开
  {
    id: 'm6', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(5),
    blocks: [
      { id: 'b6-think', type: 'thinking', state: 'done', format: 'raw', text: '用户又问了一次，可能想要更精确的数字。', startedAt: Date.now() - 2000, endedAt: Date.now() - 1000 },
    ],
  },
  // m7：redacted 思考（厂商隐去）→ 「已隐去」，不可展开
  {
    id: 'm7', role: 'assistant', session_id: 's1', model: 'm', created_at: iso(2),
    blocks: [
      { id: 'b7-think', type: 'thinking', state: 'done', format: 'raw', text: '', redacted: true, startedAt: Date.now() - 1500, endedAt: Date.now() - 800 },
      { id: 'b7-text', type: 'text', state: 'done', text: '看完了。' },
    ],
  },
].map(m => ({ content: '', ...m }));

/* ── 真流式夹具（[8]）：先思考、再调工具、最后吐答案 ──────────────── */
const LIVE_DELTAS = [
  'C 盘剩余 58.3 GB，',
  'D 盘剩余 241.7 GB。',
  '两个盘都还有余量，',
  '暂时不需要清理。',
  '需要的话我可以列出',
  '占用最大的几个目录。',
];
const LIVE_FULL = LIVE_DELTAS.join('');
const sse = events => events.map((e, i) => `id: ${e.seq ?? i + 1}\ndata: ${JSON.stringify(e)}\n\n`).join('');
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
    if (req.url.startsWith('/api/chat')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
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
    try { body = await readFile(file); } catch { file = join(DIST, 'index.html'); body = await readFile(file); }
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

const BOOT = await page.evaluate(() => ({
  msgRows: document.querySelectorAll('[data-msg-list] > *').length,
  bodyText: (document.body.innerText || '').slice(0, 160),
}));
console.log('\n[0] 页面前置');
ok(BOOT.msgRows >= 8, '页面真的打开了：8 条消息都渲染出来（不是 ErrorBoundary 兜底页）', `msgRows=${BOOT.msgRows}`);
ok(!errors.some(e => e.includes('ErrorBoundary')), '首屏没有渲染崩溃', errors.slice(0, 1).join(' | '));

// ── [1] 三种能力状态 ─────────────────────────────────────────────────
// 改版：思考行全在流程里（消息级 .tc-think 退役）。
// m1(raw)、m4(summary)、m5(2 条 raw)、m6(raw)、m7(redacted) = 6 条思考行；
// m3 没有思考 → 0 行。
console.log('\n[1] 三种能力状态（流程内思考行）');
// 折叠态流程不挂载步骤流 → 先展开全部流程再数。但 [2] 要验「有正文默认折叠」，
// 所以折叠状态在展开前采样。
const preFoldState = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[data-flow]').forEach(el => {
    const summary = el.querySelector('[data-flow-summary]');
    const hasAnswer = el.querySelector('[data-flow-answer]')?.textContent?.trim()?.length > 0;
    out.push({ hasAnswer: !!hasAnswer, aria: summary?.getAttribute('aria-expanded') ?? null });
  });
  return out;
});
const summaryAll = page.locator('[data-flow-summary]');
const sumAllCount = await summaryAll.count();
for (let i = 0; i < sumAllCount; i++) {
  if ((await summaryAll.nth(i).getAttribute('aria-expanded')) !== 'true') await summaryAll.nth(i).click();
}
await page.waitForTimeout(300);
const states = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-flow-row][data-flow-row-kind="thinking"]')];
  return {
    count: rows.length,
    verbs: rows.map(r => r.querySelector('.pf-verb')?.textContent ?? ''),
    badges: rows.map(r => r.querySelector('[data-flow-think-badge]')?.textContent ?? null),
    redacted: rows.map(r => r.querySelector('.pf-verb')?.textContent?.includes('已隐去') ?? false),
    outside: [...document.querySelectorAll('.tc-think')].length,
  };
});
ok(states.count === 6, '6 条思考行都在流程里（m1/m4/m5×2/m6/m7；m3 无思考行）', String(states.count));
ok(states.outside === 0, '消息级思考块（.tc-think）已退役', String(states.outside));
ok(states.badges.filter(Boolean).join(',') === '摘要', 'summary 思考挂「摘要」角标，其余不挂', states.badges.join(','));
ok(states.redacted.filter(Boolean).length === 1, 'redacted 思考显示「已隐去」', String(states.redacted.filter(Boolean).length));

// ── [2] 展开策略：正文出现就折叠上面的（用 [1] 展开前采样的 preFoldState） ──
console.log('\n[2] 展开策略：正文出现就折叠上面的');
const foldVals = preFoldState;
ok(foldVals.length >= 5, '有 5 条以上流程', String(foldVals.length));
ok(foldVals.filter(v => v.hasAnswer).every(v => v.aria === 'false'), '有正文的流程全部折叠');
ok(foldVals.some(v => !v.hasAnswer && v.aria === 'true'), '无正文的流程（m6）展开');

// ── [3] 思考行视觉契约：左竖线正文 + 13px secondary ───────────────────
console.log('\n[3] 思考行与正文视觉契约');
// 流程已在 [1] 全部展开，直接点开 b1-think 看正文
const noteRow = page.locator('[data-flow-row="b1-think"]');
await noteRow.locator('.pf-step-head').click();
await page.waitForTimeout(250);

const note = await page.evaluate(() => {
  const el = document.querySelector('[data-flow-row="b1-think"] [data-flow-think-note]');
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
  return {
    fontSize: cs.fontSize,
    fontStyle: cs.fontStyle,
    lineHeight: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
    color: cs.color,
    borderLeftWidth: cs.borderLeftWidth,
    borderLeftStyle: cs.borderLeftStyle,
    secondary: probe('color', 'var(--td-text-color-secondary)'),
    text: (el.textContent || '').slice(0, 80),
  };
});
ok(note != null, '思考行点开后出现思考正文（左竖线形态）');
if (note) {
  ok(note.text.includes('磁盘剩余空间'), '思考正文如实展示', note.text);
  ok(note.fontSize === '13px', '正文 13px', note.fontSize);
  ok(note.fontStyle === 'normal', '正体', note.fontStyle);
  ok(note.color === note.secondary, '正文 = secondary（读令牌）', note.color);
  ok(note.borderLeftWidth === '2px' && note.borderLeftStyle === 'solid', '左竖线 2px（参考页形态）', note.borderLeftWidth + ' ' + note.borderLeftStyle);
  ok(Math.abs(note.lineHeight - 1.7) < 0.02, '行高 1.7', note.lineHeight.toFixed(2));
}

// ── [4] 思考行头部：动词 + 耗时 ─────────────────────────────────────
console.log('\n[4] 思考行头部');
const thinkHead = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-flow-row][data-flow-row-kind="thinking"]')];
  return rows.map(r => ({
    id: r.getAttribute('data-flow-row'),
    verb: r.querySelector('.pf-verb')?.textContent ?? '',
    meta: r.querySelector('.pf-meta')?.textContent ?? '',
  }));
});
const b1 = thinkHead.find(x => x.id === 'b1-think');
ok(b1 != null && b1.verb.includes('深度思考'), '思考行动词是「深度思考」', b1?.verb);
ok(b1 != null && b1.meta === '4.8s', '完成思考挂真实耗时', b1?.meta);

// ── [5] 深色主题：思考正文跟随主题 ──────────────────────────────────
console.log('\n[5] 深色主题');
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(400);
const dark = await page.evaluate(() => {
  const el = document.querySelector('[data-flow-row="b1-think"] [data-flow-think-note]');
  if (!el) return null;
  const probe = document.createElement('span');
  probe.style.color = 'var(--td-text-color-secondary)';
  document.body.appendChild(probe);
  const token = getComputedStyle(probe).color;
  probe.remove();
  return { color: getComputedStyle(el).color, token };
});
ok(dark != null && dark.color === dark.token, '深色下思考正文跟随 secondary 令牌', dark ? dark.color : '(缺失)');

// ── [6] 真流式：正文一开始就折叠上面 + 匀速揭示 ─────────────────────
console.log('\n[6] 真流式：正文开始 → 折叠上面 / 匀速揭示');
await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.fill('textarea', '再看一次磁盘');
await page.press('textarea', 'Enter');

const live = [];
for (let i = 0; i < 46; i++) {
  live.push(await page.evaluate(() => {
    const answers = [...document.querySelectorAll('[data-answer-markdown]')];
    const last = answers[answers.length - 1];
    const flows = [...document.querySelectorAll('[data-flow]')];
    const lastFlow = flows[flows.length - 1];
    return {
      streaming: last?.getAttribute('data-answer-streaming') ?? null,
      revealed: last ? Number(last.getAttribute('data-revealed')) : -1,
      flowAria: lastFlow?.querySelector('[data-flow-summary]')?.getAttribute('aria-expanded') ?? null,
      pill: lastFlow?.querySelector('[data-flow-pill]')?.getAttribute('data-flow-pill') ?? null,
    };
  }));
  await page.waitForTimeout(80);
}

const streamingSamples = live.filter(s => s.streaming === '1');
ok(streamingSamples.length >= 5, '抓到流式过程（不是一次性渲染）', String(streamingSamples.length));
ok(
  live.some(s => s.pill === 'thinking'),
  '思考流式时胶囊是「深度思考中」',
  live.find(s => s.pill === 'thinking')?.pill ?? '（没抓到）'
);
ok(
  live.some(s => s.flowAria === 'true'),
  '工具跑起来时摘要线展开',
  String(live.some(s => s.flowAria === 'true'))
);
const idx = live.findIndex(s => s.streaming === '1' && s.revealed > 0);
ok(idx > 0, '取到「正文已有字」的采样点', String(idx));
const afterText = idx > 0 ? live.slice(idx) : [];
ok(
  afterText.length > 0 && afterText.every(s => s.flowAria === null || s.flowAria === 'false'),
  '正文一出字，上方摘要线立即折叠',
  afterText.map(s => s.flowAria).join(',')
);

// ── [7] 控制台 ─────────────────────────────────────────────────────
console.log('\n[7] 控制台');
const realErrors = errors.filter(e => !/favicon|Download the React DevTools/i.test(e));
ok(realErrors.length === 0, '无控制台错误', realErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log(`
${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
