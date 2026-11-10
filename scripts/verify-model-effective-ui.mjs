/**
 * P1 生效模型回显 · 浏览器层闸门。
 *
 * ## 要钉的是哪一层
 *
 * 纯函数层（verify-model-effective-unit.ts）只能证明「判定规则对」，
 * 证明不了「输入框里那颗模型芯片真的变了」。这一层用真浏览器 + 真 SSE
 * 夹具，读 `[data-model-trigger]` 的 `title` —— 那是 `selectedModelName`
 * 原值，不会被 CSS 省略号截断（内部文字会被截，title 不会）。
 *
 * ## 四个场景
 *
 * [1] `stamped`      服务端盖章 `modelEffective='actual-model'` ⇒ 芯片变成 Actual Model
 * [2] `legacy`       老夹具只带 `model` 不盖章 ⇒ 芯片**不变**（向后兼容反向探针）
 * [3] `agentDecides` 盖章空串 ⇒ 芯片不变，但给出「由 Agent 决定」的提示
 * [4] `same`         盖章值与请求值相同 ⇒ 芯片不变，且不弹提示
 *
 * [2] 是 [1] 的反向探针：如果 [1] 变绿只是因为「发消息这个动作顺带刷新了
 * 模型下拉」，[2] 也会跟着变，那时 [2] 就会红。两个场景共用同一套发送动作。
 *
 * 运行：先 npm run build，再 node scripts/verify-model-effective-ui.mjs
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
/** 两个都可点：回显前后都能在清单里找到对应名字 */
const MODELS = [
  { modelId: 'requested-model', name: 'Requested Model', description: '' },
  { modelId: 'actual-model', name: 'Actual Model', description: '' },
];
const SESSIONS = [
  {
    id: 's1', title: '生效模型回显验证', agent_id: 'workbuddy', model: 'requested-model',
    kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString(),
  },
];

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`); }
}

/** 由测试脚本在每次新建页面前设定；顺序执行，不会互相串 */
let scenario = 'stamped';
let chatConnections = 0;
const pageErrors = [];

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  const json = o => {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify(o));
  };

  if (p.startsWith('/api/')) {
    if (p === '/api/chat' && req.method === 'POST') {
      for await (const _ of req) { /* drain */ }
      chatConnections++;
      // 只有 stamped / agentDecides / same 三个场景盖章；legacy 是老夹具形态
      const stamp = {
        stamped: 'actual-model',
        agentDecides: '',
        same: 'requested-model',
      }[scenario];
      const runStart = {
        type: 'run_start', seq: 1, runId: `r-${chatConnections}`,
        sessionId: 's1', messageId: `m-${chatConnections}`, agentId: 'workbuddy',
        // 老夹具也带 model，但那只是元信息，不许被当成生效值
        model: 'requested-model',
        ...(stamp !== undefined ? { modelEffective: stamp } : {}),
      };
      const frames = [
        runStart,
        {
          type: 'block_open', seq: 2, runId: runStart.runId,
          block: { id: 'b1', type: 'text', text: '', state: 'streaming', format: 'markdown', startedAt: Date.now() },
        },
        { type: 'block_delta', seq: 3, runId: runStart.runId, blockId: 'b1', delta: '收到' },
        { type: 'block_close', seq: 4, runId: runStart.runId, blockId: 'b1', state: 'done' },
        { type: 'run_end', seq: 5, runId: runStart.runId, status: 'ok' },
      ];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      return res.end();
    }
    if (p === '/api/runs/active') return json({ runs: [] });
    if (p === '/api/agents/probe') return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(p)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(p)) return json({ models: MODELS });
    if (/\/api\/sessions\/[^/]+$/.test(p)) return json({ session: SESSIONS[0], messages: [] });
    if (/\/api\/sessions/.test(p)) return json({ sessions: SESSIONS });
    if (p === '/api/permission-response') return json({ ok: true });
    return json({});
  }

  try {
    let file = join(DIST, p === '/' ? '/index.html' : p);
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

/** 模型芯片当前显示的名字：优先 title（不会被 CSS 截断） */
const MODEL_PROBE = `(() => {
  const el = document.querySelector('[data-model-trigger]');
  if (!el) return { present: false, title: '', text: '' };
  return {
    present: true,
    title: String(el.getAttribute('title') || ''),
    text: String(el.textContent || '').trim(),
  };
})()`;

/** TDesign MessagePlugin 的提示（含 shadow DOM 不必穿，它挂在 body 下） */
const TOAST_PROBE = `(() => {
  const nodes = [...document.querySelectorAll('.t-message, [class*="t-message"]')];
  return nodes.map(n => String(n.textContent || '').trim()).filter(Boolean);
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

console.log('\n生效模型回显 · 浏览器层（真发消息，读模型芯片的 title）');

if (!fs.existsSync(join(DIST, 'index.html'))) {
  console.log('  ⚠️ 没有 dist/index.html —— 先跑 npm run build');
  process.exit(1);
}
const exe = resolveChrome();
if (!exe) {
  ok(false, '找到可用的 Chrome/Chromium');
  server.close();
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: exe, headless: true });

async function runStage(name) {
  scenario = name;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(`${base}/chat/s1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-model-trigger]').first().waitFor({ timeout: 25000 });
  const before = await page.evaluate(MODEL_PROBE);

  await page.locator('t-chat-sender textarea').first().fill('继续');
  await clickSenderButton(page);

  // 轮询期间持续采提示并累积：TDesign 的 Message 默认几秒后自动消失，
  // 「此刻还在」会漏掉已经弹过的那条；断言要的是「这一轮见过」。
  const seenToasts = [];
  let after = before;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    after = await page.evaluate(MODEL_PROBE);
    for (const t of await page.evaluate(TOAST_PROBE)) {
      if (!seenToasts.includes(t)) seenToasts.push(t);
    }
    if (name === 'stamped' && after.title === 'Actual Model') break;
    // 值不变的场景没有可等的目标：夹具的 SSE 是立即 end 的，1.5s 足够
    // 让前端消费完一整轮；见到提示就提前收，别把它等没了。
    if (name !== 'stamped' && (seenToasts.length > 0 || Date.now() - t0 > 1500)) break;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(250);
  after = await page.evaluate(MODEL_PROBE);
  for (const t of await page.evaluate(TOAST_PROBE)) {
    if (!seenToasts.includes(t)) seenToasts.push(t);
  }
  await ctx.close();
  return { before, after, toasts: seenToasts };
}

// ── [1] 正样本：盖章的生效值真的写回输入框 ────────────────────────────────
console.log('\n[1] stamped：服务端盖章 actual-model');
{
  const r = await runStage('stamped');
  console.log(`      ${r.before.title} → ${r.after.title}`);
  ok(r.before.present && r.before.title === 'Requested Model', '[1] 发送前芯片显示的是用户选的值（肯定式前提）', r.before.title);
  ok(r.after.present, '[1] 芯片仍在（不是整块被删掉）');
  ok(r.after.title === 'Actual Model', '★ 芯片显示服务端真正生效的模型', r.after.title);
  ok(r.after.text.includes('Actual Model'), '★ 可见文字也跟着变（不是只改了 title 属性）', r.after.text);
  ok(r.toasts.some(t => /已按 Agent 的实际配置生效/.test(t)), '[1] 给用户一句「发生了替换」的说明');
}

// ── [2] 反向探针：老夹具不盖章，什么都不许变 ──────────────────────────────
console.log('\n[2] legacy：老夹具只带 model，不带 modelEffective');
{
  const r = await runStage('legacy');
  console.log(`      ${r.before.title} → ${r.after.title}`);
  ok(r.before.title === 'Requested Model', '[2] 起点与 [1] 相同');
  ok(r.after.title === 'Requested Model', '★ 芯片没被顺带刷新成别的值（[1] 不是靠重渲染变绿的）', r.after.title);
  ok(!r.toasts.some(t => /已按 Agent 的实际配置生效|由自己决定模型/.test(t)), '[2] 也没有凭空弹提示');
}

// ── [3] 生效值为空：提示，但不制造一个空下拉 ──────────────────────────────
console.log('\n[3] agentDecides：盖章空串（由 Agent 自己决定）');
{
  const r = await runStage('agentDecides');
  ok(r.before.title === 'Requested Model', '[3] 起点相同');
  ok(r.after.title === 'Requested Model', '★ 不把芯片清成空态（空下拉比旧名字更糟）', r.after.title);
  ok(r.toasts.some(t => /由自己决定模型/.test(t)), '[3] 明说输入框里的名称不生效');
}

// ── [4] 相同值：不回显、不弹提示 ──────────────────────────────────────────
console.log('\n[4] same：盖章值与请求值相同');
{
  const r = await runStage('same');
  ok(r.after.title === 'Requested Model', '[4] 芯片保持原值', r.after.title);
  ok(!r.toasts.some(t => /已按 Agent 的实际配置生效|由自己决定模型/.test(t)), '[4] 没发生替换就不弹无意义提示');
}

ok(chatConnections >= 4, '四个场景都真的发出过一轮消息', String(chatConnections));
ok(pageErrors.length === 0, '页面没有运行期异常', pageErrors.slice(0, 2).join(' | '));

await browser.close();
server.close();

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) {
  console.log(`失败：${failures.join(' | ')}`);
  process.exit(1);
}
