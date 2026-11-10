/**
 * 停止收尾（A122 第四段绳）—— 浏览器层闸门。
 *
 * ## 场景
 *
 * 用户报「点了停止，`⟳ 思考中 已用 144s 47 字` 还在转」。要复现它，夹具必须
 * 做到一件事：**服务端开一个 thinking 块之后既不发 block_close、也不发 run_end**，
 * 把 SSE 挂住；然后由用户亲手点界面上的停止键掐断它。这正是 `handleStop`
 * 之后的真实序列 —— 服务端 `finish()` 补发的 closes 已经没人收了。
 *
 * 所以这里不用 `page.route` 一次性 fulfill 响应，而是自己起一个 HTTP 服务，
 * 用 `res.write()` 写完三帧后不 `res.end()`。
 *
 * ## 断言纪律
 *
 * [1] 是 [2] 的反向探针：同一套探针在**没点停止**时必须看见「思考中 / 已用 Ns」
 * 且秒数在涨、判据为假。否则 [2] 的「不再转圈」很可能只是元素根本没渲染出来。
 * [2] 里「spinner 消失」「不再有已用」是**否定式**，必须配「思考块还在、
 * 47 字正文还在」这两条肯定式，防止把整块删掉比改对了更绿。
 *
 * 运行：先 npm run build，再 node scripts/verify-stop-seal-ui.mjs
 */
import fs from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
];
const MODELS = [{ modelId: 'stub-model', name: 'Stub Model', description: '' }];
const SESSIONS = [
  {
    id: 's1', title: '停止收尾验证', agent_id: 'workbuddy', model: 'stub-model',
    kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString(),
  },
];
/** 与线上 Codex 适配器在 turn.started 时造的 47 字占位思考块同形 */
const THINK_TEXT = '思考中：首事件已到（turn.started），正文未到。Codex 在整段完成后才返回正文。';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

let stopCalls = 0;
let chatConnections = 0;
let chatAborts = 0;
const pageErrors = [];

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  const json = o => {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify(o));
  };

  if (p.startsWith('/api/')) {
    if (p === '/api/chat' && req.method === 'POST') {
      // 必须把请求体读完，否则某些 Node 版本会在响应写出后提前关连接
      for await (const _ of req) { /* drain */ }
      const started = Date.now() - 144_000;
      const frames = [
        { type: 'run_start', seq: 1, runId: 'r-stop-1', sessionId: 's1', messageId: 'm2', agentId: 'workbuddy', model: 'stub-model' },
        {
          type: 'block_open', seq: 2, runId: 'r-stop-1',
          block: { id: 'b1', type: 'thinking', text: '', state: 'streaming', format: 'raw', startedAt: started },
        },
        { type: 'block_delta', seq: 3, runId: 'r-stop-1', blockId: 'b1', delta: THINK_TEXT },
      ];
      chatConnections++;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.on('close', () => { chatAborts++; });
      // 刻意不 res.end()：没有 block_close，也没有 run_end
      return;
    }
    if (/\/api\/runs\/[^/]+\/stop$/.test(p)) {
      stopCalls++;
      return json({ ok: true });
    }
    if (p === '/api/runs/active') return json({ runs: [] });
    if (p === '/api/agents/probe') return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(p)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(p)) return json({ models: MODELS });
    if (/\/api\/sessions\/[^/]+$/.test(p)) {
      return json({ session: SESSIONS[0], messages: [] });
    }
    if (/\/api\/sessions/.test(p)) return json({ sessions: SESSIONS });
    if (p === '/api/permission-response') return json({ ok: true });
    return json({});
  }

  try {
    let file = join(DIST, p === '/' ? '/index.html' : p);
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

/** 系统 Chrome 优先；没有就取 ms-playwright 里最新的 chromium */
function resolveChrome() {
  const system = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(system)) return system;
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** 遍历普通 DOM + shadowRoot，抓思考块摘要条 */
const THINK_PROBE = `(() => {
  const found = [];
  const walk = root => {
    for (const el of root.querySelectorAll('details.tc-thinking')) {
      const s = el.querySelector('summary');
      const text = s ? String(s.textContent || '').trim().replace(/\\s+/g, ' ') : '';
      found.push({
        text,
        hasSpinner: !!(s && s.querySelector('.t-loading, [class*="t-loading"]')),
        bodyLen: String(el.querySelector('.tc-think-body')?.textContent || '').trim().length,
      });
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return found;
})()`;

/** TDesign chat sender 是 open shadow DOM，停止/发送态都在影子里 */
const SENDER_PROBE = `(() => {
  const host = document.querySelector('t-chat-sender');
  const sr = host && host.shadowRoot ? host.shadowRoot : null;
  const pool = sr ? [...sr.querySelectorAll('button, [class*="button"], [role="button"]')] : [];
  const cls = pool.map(e => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || ''));
  return { hasShadow: !!sr, buttons: pool.length, hasStopEl: cls.some(c => /stop/i.test(c)) || (sr ? [...sr.querySelectorAll('*')].some(e => /stop/i.test(String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || ''))) : false) };
})()`;

async function clickSenderButton(page) {
  const h = await page.evaluateHandle(`(() => {
    const host = document.querySelector('t-chat-sender');
    const sr = host && host.shadowRoot;
    if (!sr) return null;
    const cands = [...sr.querySelectorAll('button, [class*="button"]')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    });
    return cands.length ? cands[cands.length - 1] : null;
  })()`);
  const el = h.asElement();
  if (!el) throw new Error('找不到可点的 sender 按钮');
  await el.click({ timeout: 8000 });
}

/** 「已经收干净」的复合判据；[1] 反向探针与 [2] 正样本共用同一个函数 */
async function sealedState(page, sampleGapMs = 1300) {
  const first = (await page.evaluate(THINK_PROBE))[0];
  if (!first) return { present: false, spinnerGone: false, noLiveLabel: false, clockStopped: false, text: '', bodyLen: 0 };
  await page.waitForTimeout(sampleGapMs);
  const again = (await page.evaluate(THINK_PROBE))[0];
  return {
    present: true,
    spinnerGone: !first.hasSpinner,
    noLiveLabel: !/思考中/.test(first.text) && !/已用/.test(first.text),
    clockStopped: !!again && first.text === again.text,
    text: first.text,
    bodyLen: first.bodyLen,
  };
}

const exe = resolveChrome();
console.log('\n停止收尾 · 浏览器层（真点停止键，SSE 挂起不发 closes）');

if (!fs.existsSync(join(DIST, 'index.html'))) {
  console.log('  ⚠️ 没有 dist/index.html —— 先跑 npm run build');
  process.exit(1);
}
if (!exe) {
  ok(false, '找到可用的 Chrome/Chromium');
  server.close();
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: exe, headless: true });
async function newStage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(`${base}/chat/s1`, { waitUntil: 'domcontentloaded' });
  await page.locator('t-chat-sender textarea').first().waitFor({ timeout: 25000 });
  return { ctx, page };
}

async function startTurn(page) {
  await page.locator('t-chat-sender textarea').first().fill('继续');
  await clickSenderButton(page);
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < 15000) {
    const f = (await page.evaluate(THINK_PROBE))[0];
    if (f && /思考中/.test(f.text) && /已用/.test(f.text)) { seen = true; break; }
    await page.waitForTimeout(150);
  }
  return seen;
}

// ── [1] 反向探针：没点停止时，探针必须看得见「正在转」 ─────────────────
console.log('\n[1] 反向探针（不点停止，判据必须为假）');
{
  const { ctx, page } = await newStage();
  const started = await startTurn(page);
  ok(started, '[1] 夹具真的渲染出「思考中 · 已用 Ns」');
  const probe = await sealedState(page);
  console.log(`      现场摘要条：${probe.text || '(没抓到)'}  body=${probe.bodyLen}`);
  ok(probe.present, '[1] 思考块确实在页面上（肯定式前提）');
  ok(probe.noLiveLabel === false, '[1] 反向探针：未停止时「流式文案已消失」判据为假');
  ok(probe.clockStopped === false, '[1] 反向探针：未停止时秒数确实还在涨');
  ok(probe.spinnerGone === false, '[1] 反向探针：未停止时 spinner 确实在（选择器没瞎）');
  await ctx.close();
}

// ── [2] 正样本：亲手点停止，spinner 与秒表都要收 ─────────────────────────
console.log('\n[2] 用户点停止后的收口');
{
  const { ctx, page } = await newStage();
  const started = await startTurn(page);
  ok(started, '[2] 停止前确实在转（与 [1] 同一个探针）', started ? '已见思考中' : '没渲染出来');

  let stopReady = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const st = await page.evaluate(SENDER_PROBE);
    if (st.hasStopEl) { stopReady = true; break; }
    await page.waitForTimeout(150);
  }
  ok(stopReady, '[2] 输入框已进入可停止态（点的是停止键，不是发送键）');

  const stopBefore = stopCalls;
  await clickSenderButton(page);
  await page.waitForTimeout(400);
  const sealed = await sealedState(page);
  console.log(`      停止后摘要条：${sealed.text || '(没抓到)'}  body=${sealed.bodyLen}`);
  ok(sealed.present, '[2] 思考块仍在（否定式断言的前提：不是整块被删掉）');
  ok(sealed.bodyLen >= 40, '[2] 47 字思考正文仍可见（肯定式）', `${sealed.bodyLen} 字`);
  ok(sealed.spinnerGone, '[2] spinner 不再出现');
  ok(sealed.noLiveLabel, '[2] 不再显示「思考中 / 已用 Ns」', sealed.text);
  ok(sealed.clockStopped, '[2] 秒表停住（1.3s 后文本不变）');
  ok(stopCalls === stopBefore + 1, '[2] 停止请求真的发到了服务端', `${stopBefore}→${stopCalls}`);
  const sender = await page.evaluate(SENDER_PROBE);
  ok(sender.hasShadow && !sender.hasStopEl, '[2] 发送键已恢复（停止链路生效）');
  await ctx.close();
}

// ── [3] 源码契约：四段绳不许被拆回去 ─────────────────────────────────────
console.log('\n[3] 源码契约');
{
  const chat = fs.readFileSync(join(ROOT, 'src/hooks/useChat.ts'), 'utf8');
  const stopSeg = chat.slice(chat.indexOf('const handleStop'), chat.indexOf('const resolveResumeConfirm'));
  ok(/turn\.seal\?\.\(\)/.test(stopSeg), '[3] handleStop 掐流后立刻调第四段绳');
  const finSeg = chat.slice(chat.lastIndexOf('} finally {'));
  ok(/sealOpenBlocks\(blocks\)[\s\S]{0,240}flushNow\(\)/.test(finSeg), '[3] finally 先收口再 flush（覆盖报错/断流出口）');
  ok(/turn\.seal = \(\) =>/.test(chat), '[3] 每轮句柄持有自己的收口函数（不借全局单值）');

  const shared = fs.readFileSync(join(ROOT, 'shared/blocks.ts'), 'utf8');
  ok(/export function sealOpenBlocks/.test(shared), '[3] 收口逻辑是 shared 纯函数（前后端同源）');

  const idx = fs.readFileSync(join(ROOT, 'server/index.ts'), 'utf8');
  const earlyIdx = idx.slice(idx.indexOf('if (!stream)'), idx.indexOf('if (!stream)') + 900);
  ok(/writeEvents\(early\.closes\)/.test(earlyIdx), '[3] /api/chat 早退分支补发 closes');
  ok(!/writeEvent\(projector\.finish\('error'\)\.end\)/.test(earlyIdx), '[3] 早退分支不再只发 .end');

  const runner = fs.readFileSync(join(ROOT, 'server/turn-runner.ts'), 'utf8');
  const earlyRunner = runner.slice(runner.indexOf('if (!stream)'), runner.indexOf('if (!stream)') + 1200);
  ok(/emit\(\[\.\.\.early\.closes, early\.end\]\)/.test(earlyRunner), '[3] 群聊早退分支补发 closes');
  ok(!/emit\(\[projector\.finish\('error'\)\.end\]\)/.test(earlyRunner), '[3] 群聊早退分支不再只发 .end');
}

ok(chatConnections >= 2, '夹具确实建立过两条挂起的 SSE', String(chatConnections));
ok(chatAborts >= 2, '两条 SSE 都由客户端掐断（模拟停止/关页）', String(chatAborts));
ok(pageErrors.length === 0, '页面没有运行期异常', pageErrors.slice(0, 2).join(' | '));

await browser.close();
server.close();

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) {
  console.log(`失败：${failures.join(' | ')}`);
  process.exit(1);
}
