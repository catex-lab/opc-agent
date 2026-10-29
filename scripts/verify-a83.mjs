/**
 * A83 质感层验收 —— 把「手感」拆成可以断言的数字。
 *
 * 这一轮的五条要求全是**视觉/手感**，最容易出现的失败方式是「代码写了、
 * 看着差不多、其实没生效」：变量名拼错、color-mix 在不支持的地方静默失效、
 * 字重请求 450 被字体匹配成 600（更粗）、拖拽还挂着 150ms 过渡……
 * 所以这里不看截图，逐条读浏览器计算样式 / 量真实宽度。
 *
 * 覆盖：
 *   [1] 微色阶分层（1%–3%）+ 极淡描边，替换 10% 实线
 *   [2] 输入框聚焦 = 阴影抬升（边框颜色不动、阴影中性且带模糊）
 *   [3] 暗色自动降字重（且**真的换到了更轻的字面**，不是只改了个数字）
 *   [4] 等宽数字（1 与 8 同宽，数字不抖）
 *   [5] 孤字与孤卡（text-wrap: pretty + 最后一行撑满）
 *   [6] 打字机：高斯模糊渐显 + 字符错开（真实流式下捕获 .tc-type-char）
 *   [7] 拖拽干脆无回弹（拖拽期间全站过渡 0s；全站没有过冲曲线）
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
  { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#4285F4', description: '长上下文与多模态', capabilities: ['chat'], status: { availability: 'needs-auth' } },
  { id: 'cursor', name: 'Cursor Agent', vendor: 'Anysphere', kind: 'cli', icon: 'cursor', color: '#111111', description: '编辑器内联补全', capabilities: ['chat'], status: { availability: 'ready' } },
  { id: 'opencode', name: 'OpenCode', vendor: 'SST', kind: 'cli', icon: 'opencode', color: '#0F766E', description: '开源编码 Agent', capabilities: ['chat'], status: { availability: 'ready' } },
];

const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'wb', model: 'm', created_at: new Date().toISOString() },
  // 空会话：ChatPage 只有「真的拉过一轮且确实为空」才渲染 NewChatView（场景卡 /
  // Agent 卡 / .tc-cards 都在那一屏）。用 /chat/s-new 才走得到。
  { id: 's-new', title: '新会话', agent_id: 'wb', model: 'm', created_at: new Date().toISOString() },
];
const MESSAGES = [
  { id: 'm1', role: 'user', session_id: 's1', created_at: new Date().toISOString(), content: '这段怎么解释？' },
  {
    id: 'm2', role: 'assistant', session_id: 's1', model: 'm', created_at: new Date().toISOString(),
    content: '结论：确实存在两套品牌蓝。\n\n统一到品牌色令牌即可。',
  },
];

const CREDENTIALS = [
  { agentId: 'gemini', name: 'Gemini', keyEnv: 'GEMINI_API_KEY', keyEnvs: ['GEMINI_API_KEY'], hint: 'Google AI Studio 申请', configured: true, masked: 'AIzaSy****9f2c', baseUrl: '', fromEnv: false },
  { agentId: 'doubao', name: '豆包', keyEnv: 'ARK_API_KEY', keyEnvs: ['ARK_API_KEY'], hint: '火山方舟创建', configured: false, masked: '', baseUrl: '', fromEnv: false },
];

// ── 伪造 SSE：分片下发（真正的流式），用来捕获打字机字符 ────────────────
const sse = events => events.map((e, i) => `id: ${e.seq ?? i + 1}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const STREAM_EVENTS = [
  { seq: 1, type: 'run_start', runId: 'r1', sessionId: 's1', messageId: 'a-stream', agentId: 'wb', model: 'm' },
  { seq: 2, type: 'block_open', block: { id: 'b-think', type: 'thinking', text: '用户想确认品牌色为什么有两套。', state: 'streaming', format: 'raw', startedAt: Date.now() } },
  { seq: 3, type: 'block_delta', blockId: 'b-think', channel: 'text', delta: '先把所有硬编码搜一遍，再对比令牌定义，最后给统一方案。' },
  { seq: 4, type: 'block_close', blockId: 'b-think', state: 'done' },
  { seq: 5, type: 'block_open', block: { id: 'b-text', type: 'text', text: '已定位问题：两套品牌蓝同时在用。', state: 'streaming' } },
  { seq: 6, type: 'block_delta', blockId: 'b-text', channel: 'text', delta: '统一到品牌色令牌即可修复。' },
  { seq: 7, type: 'block_close', blockId: 'b-text', state: 'done' },
  { seq: 8, type: 'run_end', runId: 'r1', status: 'ok', durationMs: 1800 },
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

// ── 静态服务器 + 一个「慢速 SSE」端点 ────────────────────────────────────
// 为什么 SSE 不走 route.fulfill：fulfill 是一次性把整个 body 写回去的，
// 前端一帧内就拿到全部文本 —— 那样测不到「逐字出现」，只会看到一次性渲染。
// 所以 /api/chat 放行到真实服务器，由它每隔 80ms 写一个事件。
const server = createServer(async (req, res) => {
  try {
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
          if (i >= STREAM_EVENTS.length) return res.end();
          res.write(sse([STREAM_EVENTS[i++]]));
          setTimeout(tick, 80);
        };
        tick();
      });
      return;
    }
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
await ctx.route('**/api/**', route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  // /api/chat 交给服务器（慢速 SSE），不要在这里 fulfill
  if (url.includes('/api/chat')) return route.continue();
  if (url.includes('/api/agent-credentials')) return json({ credentials: CREDENTIALS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    const s = SESSIONS.find(x => x.id === id) ?? SESSIONS[0];
    return json({ session: s, messages: id === 's-new' ? [] : MESSAGES });
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
}

const rgbOf = s => {
  if (!s) return null;
  // color-mix 的计算值在 Chrome 里是 `color(srgb 0.988 0.988 0.988)`
  let m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, 1];
  m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null;
};
/** 0–255 的三通道平均差（近似「明度差几个色阶」） */
const levelDiff = (a, b) => {
  const x = rgbOf(a), y = rgbOf(b);
  if (!x || !y) return NaN;
  return Math.round(((Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2])) / 3) * 10) / 10;
};
const alphaOf = s => {
  const m = s.match(/[\d.]+/g);
  if (!m) return 1;
  return m.length >= 4 ? Number(m[3]) : 1;
};

// ============= [1] 微色阶分层 =============
console.log('\n[1] 微色阶分层（1%–3%）替代硬边框');

await go('/chat/s1');

const light = await page.evaluate(() => {
  const pick = css => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:-9999px;width:10px;height:10px;${css}`;
    document.body.appendChild(d);
    const cs = getComputedStyle(d);
    const out = { bg: cs.backgroundColor, border: cs.borderTopColor };
    d.remove();
    return out;
  };
  return {
    content: pick('background: var(--tc-surface-content)'),
    layer1: pick('background: var(--tc-layer-1)'),
    layer2: pick('background: var(--tc-layer-2)'),
    layer3: pick('background: var(--tc-layer-3)'),
    edge: pick('border: 1px solid var(--tc-edge)'),
    edgeStrong: pick('border: 1px solid var(--tc-edge-strong)'),
    stroke: pick('border: 1px solid var(--td-component-stroke)'),
  };
});

const d1 = levelDiff(light.content.bg, light.layer1.bg);
const d2 = levelDiff(light.content.bg, light.layer2.bg);
const d3 = levelDiff(light.content.bg, light.layer3.bg);
ok(d1 >= 2 && d1 <= 8, `浅色 layer-1 与内容面差 ${d1} 个色阶（1%–3%）`, `${light.content.bg} → ${light.layer1.bg}`);
ok(d2 > d1 && d2 <= 9, `浅色 layer-2 比 layer-1 再深一档（${d2}）`, light.layer2.bg);
ok(d3 > d2 && d3 <= 10, `浅色 layer-3 再深一档（${d3}）`, light.layer3.bg);
ok(alphaOf(light.edge.border) <= 0.06, `浅色 --tc-edge alpha = ${alphaOf(light.edge.border)}（≤0.06，不是 10% 实线）`, light.edge.border);
ok(
  alphaOf(light.edge.border) < alphaOf(light.edgeStrong.border),
  '--tc-edge（卡片 4.5%）比 --tc-edge-strong（控件 7%）更淡',
  `${alphaOf(light.edge.border)} vs ${alphaOf(light.edgeStrong.border)}`
);

// 真实卡片：新对话页的 .tc-choice-card / .tc-card 必须用上了微色阶 + 极淡边
await go('/chat/s-new');
const choice = await page.evaluate(() => {
  const el = document.querySelector('.tc-choice-card');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { border: cs.borderTopColor, bg: cs.backgroundColor };
});
ok(!!choice, '新对话页找得到场景/Agent 卡（.tc-choice-card）');
if (choice) {
  ok(alphaOf(choice.border) <= 0.08, `卡片描边 alpha = ${alphaOf(choice.border)}（不再是 10% 实线）`, choice.border);
}

// 选中一个场景 → 底部出现 .tc-card 预览卡（带内高光的那一类）
await page.locator('[data-scenario]').first().click();
await page.waitForTimeout(350);
const preview = await page.evaluate(() => {
  const el = document.querySelector('.tc-card');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { border: cs.borderTopColor, shadow: cs.boxShadow };
});
ok(!!preview, '选中场景后出现 .tc-card 预览卡');
if (preview) {
  ok(alphaOf(preview.border) <= 0.06, `.tc-card 描边 alpha = ${alphaOf(preview.border)}（4.5% 保险线）`, preview.border);
  ok(/inset/.test(preview.shadow), '.tc-card 带顶部内高光（厚度感，不是线框）', preview.shadow.slice(0, 70));
}

// ============= [2] 输入框聚焦 = 阴影替代高亮 =============
console.log('\n[2] 输入框聚焦：阴影抬升，边框不动');

await go('/settings');
await page.getByRole('button', { name: /登录配置/ }).first().click();
await page.waitForTimeout(500);
await page.locator('[data-credential-toggle="doubao"]').click();
await page.waitForTimeout(250);

const inputSel = '[data-credential-key="doubao"] .t-input';
const inputStyle = () =>
  page.locator(inputSel).first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopColor, shadow: cs.boxShadow };
  });

await page.mouse.move(5, 5);
await page.waitForTimeout(150);
const inputBefore = await inputStyle();
await page.locator('[data-credential-key="doubao"] input').click();
// 点完把鼠标移开：`.t-input:hover` 会把描边提到 7%，那是**悬停**反馈，
// 不是聚焦反馈。不移开的话，量到的「聚焦后边框变了」其实是 hover 造成的 ——
// 这类混淆正是 A30 当初把「点击时必然悬停」误当成「点击时描边」的原因。
await page.mouse.move(5, 5);
await page.waitForTimeout(300);
const inputAfter = await inputStyle();

ok(!!inputBefore && !!inputAfter, '找得到设置页的 TDesign 输入框');
if (inputBefore && inputAfter) {
  ok(inputAfter.shadow !== inputBefore.shadow, '聚焦后投影变了（有反馈）', inputAfter.shadow.slice(0, 60));
  ok(inputAfter.border === inputBefore.border, '聚焦后边框色不变（不描边）', inputAfter.border);
  const cols = [...inputAfter.shadow.matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/g)].map(m => ({
    r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4],
  }));
  ok(cols.length > 0 && cols.every(c => c.r === c.g && c.g === c.b), '聚焦阴影是中性色', JSON.stringify(cols));
  ok(cols.every(c => c.a <= 0.2), '聚焦阴影足够淡（不是实心环）', JSON.stringify(cols.map(c => c.a)));
}

// ============= [3] 暗色自动降字重 =============
console.log('\n[3] 暗色自动降字重（并验证真的换了字面）');

/** 量一段固定文字的实际渲染宽度：字重若只是「写了个数字」而字体没变，宽度不会变 */
const measureProbe = () =>
  page.evaluate(() => {
    const d = document.createElement('span');
    d.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:14px;white-space:nowrap;font-weight:inherit';
    d.textContent = '正在思考这件事用时 12 秒 The quick brown fox';
    document.body.appendChild(d);
    const w = d.getBoundingClientRect().width;
    const weight = getComputedStyle(document.body).fontWeight;
    d.remove();
    return { w: Math.round(w * 100) / 100, weight };
  });

const lightType = await measureProbe();
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(400);
const darkType = await measureProbe();

// 微色阶在深色下必须**反向**：越靠前越亮（叠白），且步长与浅色一致。
// 只测浅色是不够的 —— `--tc-ink` 若忘了在 :root.dark 里翻转，深色的卡片
// 会往黑里叠，在 #121212 上直接消失。
const darkLayer = await page.evaluate(() => {
  const pick = css => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:-9999px;width:10px;height:10px;${css}`;
    document.body.appendChild(d);
    const bg = getComputedStyle(d).backgroundColor;
    d.remove();
    return bg;
  };
  return { content: pick('background: var(--tc-surface-content)'), layer2: pick('background: var(--tc-layer-2)') };
});
const darkRgb = s => {
  const m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) return +m[1] * 255;
  const r = s.match(/rgba?\(([\d.]+)/);
  return r ? +r[1] : NaN;
};
const dDark = Math.round((darkRgb(darkLayer.layer2) - darkRgb(darkLayer.content)) * 10) / 10;
ok(dDark > 2 && dDark <= 10, `深色 layer-2 比内容面**更亮** ${dDark} 个色阶（叠白，方向没反）`, `${darkLayer.content} → ${darkLayer.layer2}`);

ok(lightType.weight === '400', `浅色正文字重 = 400`, lightType.weight);
ok(darkType.weight === '350', `深色正文字重 = 350（自动降一档）`, darkType.weight);
ok(
  Math.abs(darkType.w - lightType.w) > 0.5,
  '深色字重**真的换到了更轻的字面**（不是只改了个数字）',
  `${lightType.w}px → ${darkType.w}px`
);

// ============= [4] 等宽数字 =============
console.log('\n[4] 等宽数字（数字不抖）');

const tabular = await page.evaluate(() => {
  const mk = (variant, text) => {
    const d = document.createElement('span');
    d.style.cssText = `position:fixed;left:-9999px;top:0;font-size:14px;white-space:nowrap;font-variant-numeric:${variant}`;
    d.textContent = text;
    document.body.appendChild(d);
    const w = d.getBoundingClientRect().width;
    d.remove();
    return Math.round(w * 100) / 100;
  };
  return {
    computed: getComputedStyle(document.body).fontVariantNumeric,
    tab1: mk('tabular-nums', '1111111111'),
    tab8: mk('tabular-nums', '8888888888'),
    prop1: mk('normal', '1111111111'),
    prop8: mk('normal', '8888888888'),
  };
});

ok(/tabular-nums/.test(tabular.computed), 'body 计算样式含 tabular-nums', tabular.computed);
ok(Math.abs(tabular.tab1 - tabular.tab8) < 0.2, '等宽下 1 与 8 同宽（宽度不跳）', `${tabular.tab1} vs ${tabular.tab8}`);
// 反证：比例数字下两者宽度不同 —— 证明上面那条不是因为「字体本来就等宽」
ok(
  Math.abs(tabular.prop1 - tabular.prop8) > 0.2,
  '反证：比例数字下 1 与 8 宽度不同（说明等宽确实起了作用）',
  `${tabular.prop1} vs ${tabular.prop8}`
);

// ============= [5] 孤字与孤卡 =============
console.log('\n[5] 孤字（text-wrap）与孤卡（自适应撑满）');

const wrap = await page.evaluate(() => getComputedStyle(document.body).textWrap);
ok(wrap === 'pretty', 'body 使用 text-wrap: pretty（避免末行孤字）', wrap);

await go('/chat/s-new');
const cards = await page.evaluate(() => {
  const box = document.querySelector('.tc-cards');
  if (!box) return null;
  const kids = [...box.children];
  if (kids.length < 2) return { n: kids.length };
  // 按 offsetTop 分行，量最后一行「实际占用宽度」与容器内容宽度
  const rows = new Map();
  for (const k of kids) {
    const t = k.offsetTop;
    rows.set(t, [...(rows.get(t) ?? []), k]);
  }
  const lastRow = [...rows.entries()].sort((a, b) => b[0] - a[0])[0][1];
  const lastRight = Math.max(...lastRow.map(k => k.offsetLeft + k.offsetWidth));
  const firstLeft = Math.min(...lastRow.map(k => k.offsetLeft));
  const style = getComputedStyle(box);
  const inner = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return {
    n: kids.length,
    rows: rows.size,
    lastCount: lastRow.length,
    lastSpan: Math.round(lastRight - firstLeft),
    inner: Math.round(inner),
  };
});
ok(!!cards && cards.n >= 2, '新对话页有 .tc-cards 卡片区', cards ? `n=${cards.n}` : 'null');
if (cards && cards.n >= 2) {
  ok(
    cards.lastSpan >= cards.inner - 3,
    '最后一行卡片撑满整行（没有孤卡留白）',
    `最后一行 ${cards.lastCount} 张占 ${cards.lastSpan}px / 容器 ${cards.inner}px`
  );
}

// ============= [5b] 行内图标对齐文字中线 =============
console.log('\n[5b] 行内图标对齐文字中线');

const iconAlign = await page.evaluate(() => {
  // 1) 规则是否真的落到了 lucide 图标上（本项目所有业务图标都是 lucide / t-icon）
  const svg = document.querySelector('svg.lucide') || document.querySelector('svg.t-icon');
  const va = svg ? getComputedStyle(svg).verticalAlign : null;

  // 2) 在 flex 行里 vertical-align 不参与布局，必须**没有**把图标挪歪：
  //    量「图标中心」与「同行文字中心」的偏差（≤1px 视为对齐）
  let delta = null;
  const rows = [...document.querySelectorAll('button, li, div')].filter(el => {
    const hasIcon = el.querySelector(':scope > svg.lucide');
    const text = (el.textContent || '').trim();
    return hasIcon && text.length > 0 && text.length < 24 && getComputedStyle(el).display.includes('flex');
  });
  for (const row of rows) {
    const icon = row.querySelector(':scope > svg.lucide');
    const ib = icon.getBoundingClientRect();
    const cs = getComputedStyle(row);
    // 用行内文本节点的 Range 取文字盒（比拿整行高度准）
    const range = document.createRange();
    const tn = [...row.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
    if (!tn) continue;
    range.selectNodeContents(tn);
    const tb = range.getBoundingClientRect();
    if (!tb.height) continue;
    delta = Math.round((ib.top + ib.height / 2 - (tb.top + tb.height / 2)) * 10) / 10;
    void cs;
    break;
  }
  return { va, delta, rows: rows.length };
});
ok(
  Math.abs(parseFloat(iconAlign.va) + 1.75) <= 0.5,
  '图标 vertical-align ≈ -1.75px（-0.125em；浏览器把 used value 取整成 -2px）',
  String(iconAlign.va)
);
ok(
  iconAlign.delta !== null && Math.abs(iconAlign.delta) <= 1.5,
  'flex 行里的图标仍与文字中线对齐（规则没有把布局挪歪）',
  `偏差 ${iconAlign.delta}px`
);

console.log('\n[6] 打字机：高斯模糊渐显 + 字符错开');

// keyframes 里必须有 blur（确定性检查，不依赖动画时刻）
const keyframes = await page.evaluate(() => {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of rules) {
      if (r.type === CSSRule.KEYFRAMES_RULE && /tc-type-in/.test(r.name)) out.push(r.cssText);
    }
  }
  return out.join('\n');
});
ok(/blur\(3px\)/.test(keyframes), 'tc-type-in 关键帧里有 blur(3px)（高斯模糊渐显）', keyframes.slice(0, 60) || '未找到关键帧');

await go('/chat/s1');
await page.fill('textarea', '再确认一次品牌色');
await page.press('textarea', 'Enter');

// 轮询：SSE 每 80ms 一片，抓到一次就够
// 两个计数要分开取最大值：状态行的标签只在阶段切换时重播，与思考块的
// 字符不同步；用「字符最多那一帧」的状态行计数会漏掉它。
let typing = { chars: 0, anim: '', delay: '', maxDelay: '', statusChars: 0 };
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(100);
  const snap = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.tc-type-char')];
    const status = [...document.querySelectorAll('[data-stream-status] .tc-type-char')];
    const el = all[0];
    const delays = all.map(e => parseFloat(e.style.animationDelay) || 0);
    return {
      chars: all.length,
      statusChars: status.length,
      anim: el ? getComputedStyle(el).animationName : '',
      delay: el ? el.style.animationDelay : '',
      maxDelay: delays.length ? `${Math.max(...delays)}ms` : '',
    };
  });
  typing.chars = Math.max(typing.chars, snap.chars);
  typing.statusChars = Math.max(typing.statusChars, snap.statusChars);
  if (snap.anim) typing.anim = snap.anim;
  if (snap.maxDelay) typing.maxDelay = snap.maxDelay;
  if (typing.chars > 0 && typing.statusChars > 0) break;
}

ok(typing.chars > 0, '流式期间出现了逐字动画元素（.tc-type-char）', `n=${typing.chars}`);
ok(typing.anim === 'tc-type-in', '逐字元素的动画是 tc-type-in', typing.anim || 'none');
ok(typing.statusChars > 0, '状态行的阶段文案也在逐字浮现', `n=${typing.statusChars}`);
ok(parseFloat(typing.maxDelay) > 0, '字符带递增的 animation-delay（错开显现）', `最大 ${typing.maxDelay}`);

// 流式**进行中**截一张（等 1.2s 之后流已结束，逐字 span 会被收成纯文本，
// 那样截到的是「打字结束后」的画面，看不出模糊渐显）
await page.screenshot({ path: join(OUT, 'a83-typing.png') });
await page.waitForTimeout(1200);

// ============= [7] 拖拽干脆无回弹 =============
console.log('\n[7] 拖拽：跟手、无过渡、无回弹');

await go('/chat/s1');
const handle = page.locator('[data-sidebar-resizer]');
ok((await handle.count()) === 1, '找到左侧栏拖拽手柄');
const hb = await handle.boundingBox();
if (hb) {
  const y = hb.y + hb.height / 2;
  const x = hb.x + hb.width / 2;
  // 拖之前先确认「有过渡」——否则拖拽期间变 0s 这条断言是空转
  const beforeDrag = await page.evaluate(() => {
    const li = document.querySelector('.tc-list-item');
    return {
      dur: li ? getComputedStyle(li).transitionDuration : '',
      w: getComputedStyle(document.documentElement).getPropertyValue('--tc-sidebar-width').trim(),
    };
  });
  ok(/0\.15s|0.15s/.test(beforeDrag.dur), '平时列表项是有过渡的（0.15s）—— 后面的 0s 才有意义', beforeDrag.dur);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y);
  // 不等待：松手/移动后**立刻**读，读到的是「跟手」还是「正在缓动」
  const during = await page.evaluate(() => {
    const li = document.querySelector('.tc-list-item');
    return {
      resizing: document.body.dataset.resizing,
      dur: li ? getComputedStyle(li).transitionDuration : '',
      w: getComputedStyle(document.documentElement).getPropertyValue('--tc-sidebar-width').trim(),
    };
  });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const li = document.querySelector('.tc-list-item');
    return {
      dur: li ? getComputedStyle(li).transitionDuration : '',
      w: getComputedStyle(document.documentElement).getPropertyValue('--tc-sidebar-width').trim(),
    };
  });

  ok(during.resizing === '1', '拖拽期间 body 挂了 data-resizing', String(during.resizing));
  ok(
    during.dur.split(',').every(d => parseFloat(d) === 0),
    '拖拽期间全站过渡 = 0s（不追着指针走）',
    during.dur
  );
  const w0 = parseFloat(beforeDrag.w);
  const w1 = parseFloat(during.w);
  ok(Math.abs(w1 - w0 - 40) <= 1, '指针移 40px，宽度立刻变 40px（无缓动延迟）', `${w0} → ${w1}`);
  ok(/0\.15s/.test(after.dur), '松手后过渡恢复（0.15s）', after.dur);

  // 复位，别把宽度写进 localStorage 影响后续断言
  await page.mouse.dblclick(x + 40, y).catch(() => {});
}

// 全站不许有「过冲」曲线：cubic-bezier 的 y 分量 > 1 就是回弹
const overshoot = await page.evaluate(() => {
  const hits = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const tf = getComputedStyle(el).transitionTimingFunction;
    for (const m of tf.matchAll(/cubic-bezier\(([^)]+)\)/g)) {
      const p = m[1].split(',').map(v => parseFloat(v));
      if (p[1] > 1 || p[3] > 1) hits.add(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 24)} → ${m[0]}`);
    }
  }
  return [...hits].slice(0, 6);
});
ok(overshoot.length === 0, '全站没有过冲（回弹）缓动曲线', overshoot.join(' | ') || '0 处');

const spring = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--ease-spring').trim()
);
ok(spring === '', '--ease-spring 令牌已移除（回弹曲线不再存在）', spring || 'undefined');

ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | '));

await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'a83-dark-chat.png') });

await browser.close();
server.close();

console.log(`\n结果：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
