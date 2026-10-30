/**
 * A149 验证：消息正文的排版收口；2026-10-30 起改为「改版」口径。
 *
 *   红框1 —— 「原生事件 7 条 sc/system/status · sid=…」不再出现在消息流里
 *   红框2 —— 过程（思考 / 中途旁白 / 轨迹条）与答案同一平面平铺：
 *            没有总收起条、没有导轨、没有答案前分隔线；思考块与轨迹条
 *            各自 auto-collapse（有答案即收），旁白与答案同档 14px
 *   红框3 —— 答案正文不出现 emoji 表情，段落两端对齐（末行左对齐）
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a149.mjs（需先 npm run build）
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

const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
];
const MODELS = [{ modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: '快' }];
const SESSIONS = [
  {
    id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-haiku-4-5',
    kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString(),
  },
];

const now = Date.now();
const NARRATION_1 = '我来帮你搜索 Codex 官方最新的新闻。';
const NARRATION_2 = '搜索结果里有些来自中文媒体、信息比较杂，我去 OpenAI 官方渠道核实一下最新动态。';
const NARRATION_3 = 'OpenAI 官方新闻页已加载，最新的 Codex 相关动态集中在 10 月 26 日。';
/** 答案正文：带 emoji（📰）与多段，用来验净化与两端对齐 */
const ANSWER = [
  '我查了 OpenAI 官方渠道（openai.com/news、openai.com/codex）以及近期媒体报道，整理了 Codex 目前最新的官方动态。注意：以下按时间从新到旧排列。',
  '',
  '📰 最新官方发布（OpenAI News 博客）',
  '',
  '- GPT-6.1 Terra 发布（10/26）：新的 GPT-6.1 系列模型，配套有系统卡附录（deployment safety）。',
  '- GPT-6.1 Sol 应用于代码安全（10/26）：官方以 CodeRabbit 为例，介绍 GPT-6.1 Sol 如何强化复杂代码库的安全审查。',
  '',
  '代码里的表情不该被删：`const mark = "🔍";`',
].join('\n');

const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '查一下 Codex 最新消息', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: ANSWER, model: 'claude-haiku-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    duration_ms: 3 * 60 * 1000 + 50 * 1000,
    blocks: [
      // 红框1：适配器没归一化的原生事件（A111 落库，A149 不再展示）
      {
        id: 'r1', type: 'raw', count: 7, omitted: 0,
        entries: [
          { channel: 'sc/system/status', payload: { type: 'system', subtype: 'status', session_id: 'sid=abc123' } },
        ],
      },
      // 红框2：开头的思考（没有父级 → 走 ThinkingView）
      {
        id: 'b1', type: 'thinking', text: NARRATION_1, state: 'done', format: 'raw',
        startedAt: now - 20000, endedAt: now - 20000,
      },
      { id: 'b2', type: 'text', text: NARRATION_1, state: 'done' },
      {
        id: 'b3', type: 'tool', toolId: 't1', name: 'WebSearch', status: 'completed',
        input: { query: 'codex 最新' }, output: '10 条结果',
        startedAt: now - 19000, endedAt: now - 16000,
      },
      { id: 'b4', type: 'text', text: NARRATION_2, state: 'done' },
      {
        id: 'b5', type: 'tool', toolId: 't2', name: 'WebFetch', status: 'completed',
        input: { url: 'https://openai.com/news' }, output: 'ok',
        startedAt: now - 15000, endedAt: now - 12000,
      },
      { id: 'b6', type: 'text', text: NARRATION_3, state: 'done' },
      {
        id: 'b7', type: 'tool', toolId: 't3', name: 'WebFetch', status: 'completed',
        input: { url: 'https://openai.com/codex' }, output: 'ok',
        startedAt: now - 11000, endedAt: now - 10000,
      },
      // 红框3：答案
      { id: 'b8', type: 'text', text: ANSWER, state: 'done' },
    ],
  },
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
const errors = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) return json({ runs: [] });
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
  return { ctx, page };
}

/**
 * 消息列表的**全文**（穿透 shadow DOM）。
 *
 * 为什么不能用 `innerText`：答案与旁白都由 `ChatMarkdown` 渲染在 TDesign 的
 * shadow root 里，`innerText` / `textContent` 都不穿 shadow —— 拿它们判
 * 「这段文字在不在屏幕上」，答案永远是「不在」。第一次跑这条闸门时就踩了：
 * 「答案正文可见」假红，同时「旁白不可见」**假绿**（旁白也没被扫到）。
 */
const DEEP_TEXT = `
  (() => {
    const root = document.querySelector('[data-msg-list]');
    if (!root) return '';
    const out = [];
    const walk = node => {
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out.push(child.nodeValue);
        else if (child.nodeType === 1) walk(child);
      }
    };
    walk(root);
    return out.join('');
  })()
`;

/** 穿透 shadow DOM 收集答案块的所有 <p>：答案正文在 TDesign 的 shadow root 里。
    同一平面后页面上有多个 [data-answer-markdown]（旁白也是），取最后一个 ——
    答案在最后一个工具之后，是消息里的末位文本块。 */
const PICK_PARAGRAPHS = `
  (() => {
    const hosts = [...document.querySelectorAll('[data-answer-markdown]')];
    const host = hosts[hosts.length - 1];
    if (!host) return { missing: true, ps: [] };
    const ps = [];
    const walk = node => {
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const el of node.querySelectorAll('*')) {
        if (el.tagName === 'P') ps.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(host);
    return {
      missing: false,
      ps: ps.map(p => {
        const cs = getComputedStyle(p);
        return { text: p.textContent, align: cs.textAlign, alignLast: cs.textAlignLast, size: cs.fontSize };
      }),
    };
  })()
`;

// ============= [1] 红框1：原生事件不再展示 =============
console.log('\n[1] 红框1：原生事件行不再出现在消息流里');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  ok((await page.locator('[data-raw-block]').count()) === 0, '没有 [data-raw-block] 节点');
  const body = await page.evaluate(DEEP_TEXT);
  ok(!body.includes('原生事件'), '消息流里读不到「原生事件」四个字', body.slice(0, 40).replace(/\n/g, ' '));
  ok(!body.includes('sc/system/status'), '渠道名也不漏出来');
  // 肯定式：消息本身渲染出来了，否则上面两条是「整块没渲染」的假绿
  ok(body.includes('Codex'), '消息正文确实渲染出来了（否定式断言的前提）', `${body.length} 字`);

  await ctx.close();
}

// ============= [2] 红框2：过程与答案同一平面，各自折叠 =============
console.log('\n[2] 红框2：无总条/导轨/分隔线，过程块各自收起，旁白留在原地');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  // 结构上不再有过程流壳
  ok((await page.locator('[data-process-flow]').count()) === 0, '没有过程流总条（data-process-flow）');
  ok((await page.locator('.tc-rail-item').count()) === 0, '没有导轨行（.tc-rail-item）');
  ok((await page.locator('.tc-answer-divider').count()) === 0, '答案前没有分隔线');
  ok((await page.locator('.tc-proc-note').count()) === 0, '旁白不再降档（无 .tc-proc-note）');

  // 过程块各自管自己的折叠：思考收起、轨迹收起，但节点都在 DOM 里
  const think = page.locator('.tc-thinking').first();
  ok((await think.count()) > 0, '思考块在 DOM 里（没有被卸载）');
  ok((await think.evaluate(el => el.open).catch(() => null)) === false, '有答案 → 思考块默认收起');
  const traceBar = page.locator('[data-steps-bar]').first();
  ok((await traceBar.count()) > 0, '轨迹汇总行在 DOM 里');
  ok((await traceBar.getAttribute('aria-expanded')) === 'false', '有答案 → 轨迹默认收起');
  ok((await page.locator('[data-trace-scroll]').count()) === 0, '收起时步骤不渲染');

  // 旁白不再被收走：它是正文的一部分，直接可见（Trae 同一平面）
  const body = await page.evaluate(DEEP_TEXT);
  ok(body.includes(NARRATION_2), '中途旁白直接可见（不再被总条收走）');
  ok(body.includes('GPT-6.1 Terra'), '答案正文可见', `${body.length} 字`);

  await page.screenshot({ path: join(OUT, 'a149-collapsed.png'), fullPage: false });
  await ctx.close();
}

// ============= [3] 红框2：旁白与答案同档；思考正文灰卡 =============
console.log('\n[3] 红框2：旁白 14px 与答案同档；思考正文是浅灰圆角卡片');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const answerSize = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-answer-markdown]')];
    const el = hosts[hosts.length - 1];
    return el ? getComputedStyle(el).fontSize : null;
  });
  ok(answerSize === '14px', '答案正文 14px（--text-body-lg）', String(answerSize));

  // 旁白与答案都经 AnswerMarkdown 渲染：逐块读 [data-answer-markdown] 的字号，
  // 全部必须同档（14px）—— A152 那套「旁白降 13px」的分支已删。
  const noteSize = await page.evaluate(() =>
    [...document.querySelectorAll('[data-answer-markdown]')].map(el => getComputedStyle(el).fontSize)
  );
  ok(noteSize.length >= 4, `过程旁白 + 答案共 ${noteSize.length} 个文本块`, String(noteSize.length));
  ok(
    noteSize.every(s => s === '14px'),
    '旁白与答案全部 14px 同档（不再有 13px 降档）',
    noteSize.join(',')
  );

  // 思考正文：展开后是浅灰圆角卡片，不是左细线
  await page.locator('.tc-thinking > summary').first().click();
  await page.waitForTimeout(300);
  const thinkCard = await page.evaluate(() => {
    const el = document.querySelector('.tc-think-body');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--td-bg-color-secondarycontainer)';
    document.body.appendChild(probe);
    const cardToken = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      fontSize: cs.fontSize,
      background: cs.backgroundColor,
      cardToken,
      borderLeftWidth: cs.borderLeftWidth,
      borderLeftStyle: cs.borderLeftStyle,
      borderRadius: cs.borderTopLeftRadius,
    };
  });
  ok(thinkCard != null, '思考正文展开后可见');
  if (thinkCard) {
    ok(thinkCard.fontSize === answerSize, '思考正文字号 = 答案正文字号', `思考 ${thinkCard.fontSize} / 答案 ${answerSize}`);
    ok(thinkCard.background === thinkCard.cardToken, '思考正文是灰卡（secondarycontainer 令牌）', thinkCard.background);
    ok(
      thinkCard.borderLeftWidth === '0px' || thinkCard.borderLeftStyle === 'none',
      '思考正文不再有左细线',
      `${thinkCard.borderLeftWidth} ${thinkCard.borderLeftStyle}`
    );
    ok(parseFloat(thinkCard.borderRadius) >= 6, '思考灰卡有圆角（≥6px）', thinkCard.borderRadius);
  }

  await page.screenshot({ path: join(OUT, 'a149-expanded.png'), fullPage: false });
  await ctx.close();
}

// ============= [4] 红框3：emoji 净化 + 两端对齐 =============
console.log('\n[4] 红框3：正文去 emoji、段落两端对齐');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  const stripped = await page.locator('[data-answer-markdown]').last().getAttribute('data-emoji-stripped');
  ok(stripped === '1', '标记出「这条正文确实做过净化」', String(stripped));

  const dump = await page.evaluate(PICK_PARAGRAPHS);
  ok(!dump.missing, '穿透 shadow 找到了段落');
  ok(dump.ps.length > 0, '答案正文有段落', `${dump.ps.length} 段`);

  const all = dump.ps.map(p => p.text).join('\n');
  ok(!all.includes('📰'), '渲染出的正文里没有 📰', all.includes('📰') ? '仍然存在' : '已清除');
  ok(all.includes('最新官方发布'), '被 emoji 前缀的标题文字还在（不是整行删掉）');
  ok(all.includes('🔍'), '行内 code 里的 🔍 保留（代码不是排版）');

  const target = dump.ps.find(p => p.text.includes('我查了 OpenAI 官方渠道'));
  ok(!!target, '找到第一段正文');
  if (target) {
    ok(target.align === 'justify', '段落两端对齐', target.align);
    ok(target.alignLast === 'left', '末行左对齐', target.alignLast);
  }

  await page.screenshot({ path: join(OUT, 'a149-answer.png'), fullPage: false });
  await ctx.close();
}

// ============= [5] 控制台 =============
console.log('\n[5] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log(`\n${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
