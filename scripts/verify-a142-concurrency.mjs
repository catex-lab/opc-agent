/**
 * A142 验证：一个会话在回复时，**另一个会话必须还能发消息**。
 *
 * ## 这条闸门守的是什么
 *
 * 用户报「一个 agent 发了消息，另一个 agent 就发不出去了，提示后台一个任务进行中」。
 * 复现（`.tmp/probe-concurrency.mjs`，改前）：
 *   · 会话 A 在跑 → 切到 B → 输入框仍挂着**停止**态；
 *   · 在 B 里点那颗按钮 → `POST /api/chat` 里始终只有 s1，B 一条都没发出去；
 *   · 而且那一下把 **A** 的 run 停了（按钮是停止键）。
 * 根因：`useChat` 是「全应用一轮」的状态机（`isLoading` 布尔 + `turnRef` 单值）。
 *
 * ## 为什么行为断言用「自建假服务端」而不是 page.route
 *
 * `page.route().fulfill()` 只能返回**完整**响应体，造不出「永不结束的 SSE」。
 * 而这条缺陷的全部意义就在于「A 还在跑」。所以这里起一个真 http 服务：
 * 静态产物 + 假 API，`/api/chat` 对 s1 挂住不 end，对 s2 正常收尾。
 *
 * ## 反向探针（--probe-old）
 *
 * 两段各有一套：
 *   · **源码契约**：把 `git show HEAD:src/hooks/useChat.ts`（修复前那一版）写进
 *     临时文件，同一批断言跑它 —— 必须全红。
 *   · **行为**：服务 `.tmp/dist-pre-a142/`（修复前构建的产物快照）。
 *     这份快照是**手工留的**：A142 构建新 dist 之前复制的一份。没有它时
 *     这一段会明确报「快照缺失」并跳过，**不会**假装通过。
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const OUT = join(ROOT, '.render-check', 'a142');
const OLD_DIST = join(ROOT, '.tmp', 'dist-pre-a142');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROBE = process.argv.includes('--probe-old');
const DIST = PROBE ? OLD_DIST : join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

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

const AGENTS = [
  { id: 'a1', name: 'AgentA', vendor: 'v', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: 'x', capabilities: ['chat'], status: { availability: 'ready', version: '1' } },
  { id: 'a2', name: 'AgentB', vendor: 'v', kind: 'sdk', icon: 'workbuddy', color: '#7C6BF5', description: 'x', capabilities: ['chat'], status: { availability: 'ready', version: '1' } },
];
const MODELS = [{ modelId: 'm1', name: 'Auto', providerName: 'P', multiplier: '0.00x', tag: '免费' }];
const SESSIONS = [
  { id: 's1', title: '会话A', agent_id: 'a1', model: 'm1', kind: 'chat', project_id: null, cwd: '', created_at: new Date().toISOString() },
  { id: 's2', title: '会话B', agent_id: 'a2', model: 'm1', kind: 'chat', project_id: null, cwd: '', created_at: new Date().toISOString() },
];

/** 本轮探针的全部观测点 */
const seen = {
  chat: [],      // { sid, at }
  stops: [],     // runId
  openStreams: new Set(), // sid：还在挂着的 SSE
};

/* ══════════ [1] 源码契约：不能退回「全应用一轮」 ══════════ */
console.log('\n[1] 源码契约：按会话记句柄，不是全局单值');
{
  let src = '';
  let label = 'src/hooks/useChat.ts';
  if (PROBE) {
    /* 修复前那一版：**钉死 sha**，不用 HEAD。
       A142 提交之后 HEAD 就是修好的版本，`git show HEAD:…` 会拿到新代码，
       于是所有契约断言照样全绿 —— 探针变成一句自我实现（A140 踩过同款）。
       `59162a4` = A141 打包那次提交，也就是 A142 动 useChat 之前的最后一版。 */
    const PIN = '59162a4';
    try {
      src = execFileSync('git', ['show', `${PIN}:src/hooks/useChat.ts`], { cwd: ROOT, encoding: 'utf8' });
      label = `${PIN}:src/hooks/useChat.ts（A142 之前）`;
    } catch {
      try {
        src = execFileSync('git', ['show', 'HEAD:src/hooks/useChat.ts'], { cwd: ROOT, encoding: 'utf8' });
        label = 'HEAD:src/hooks/useChat.ts（⚠️ 钉死的 sha 取不到，回落到 HEAD —— 若已提交 A142，这一段不再有效）';
      } catch {
        ok(false, '反向探针能取到修复前的 useChat.ts', 'git show 失败');
        src = '';
      }
    }
  } else {
    src = await readFile(join(ROOT, 'src/hooks/useChat.ts'), 'utf8');
  }
  ok(src.length > 1000, `读到了 ${label}`, `${src.length} 字符`);

  // 剥注释再断言：注释里写着「原来是一个 useState(false) 的布尔」，
  // 直接在原文上跑 `useState(false)` 会命中注释 —— 正是 TRAPS §4 那个坑。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok(/turnsRef\s*=\s*useRef<Map<string,\s*Turn>>\(new Map\(\)\)/.test(code),
    '句柄存在 Map<sessionId, Turn> 里');
  ok(!/setIsLoading/.test(code), '没有残留的全局 setIsLoading');
  ok(/const\s+isLoading\s*=\s*currentSessionId\s*\?\s*runningIds\.includes\(currentSessionId\)/.test(code),
    'isLoading 由「当前会话是否在跑」派生');
  // 发送前的互斥判据：取的是「这个会话」的句柄，而且按 `busy` 判 ——
  // 两个变量名刻意不同（`busy` vs `turn`），这样两条断言不会互相兜住。
  ok(/const busy = currentSessionId \? turnsRef\.current\.get\(currentSessionId\) : undefined/.test(code),
    '发送前的互斥判据是「这个会话」而不是全局');
  ok(/if \(busy && !busy\.stopped\)/.test(code),
    '已按停止的句柄不再算忙（停完能立刻重发）');
  ok(/const turn = currentSessionId \? turnsRef\.current\.get\(currentSessionId\) : undefined/.test(code),
    '停止取的是当前会话的句柄');
  ok(/turnsRef\.current\.delete\(turn\.sessionId\)/.test(code),
    '一轮结束时按 turn.sessionId 摘（id 被 applyInit 换过也摘得对）');
  // 否定式必须配肯定式：不能只看「没有 setIsLoading」——
  // 整个删掉 useChat 也满足那一条。上面五条正向断言就是配对。
  ok(/runningIds/.test(code) && /setRunningIds/.test(code),
    'runningIds 既读又写（不是只声明不用的摆设）');
  // 「拦住但不静默」：守卫分支必须说话，不能像修复前那样一声不响地 return
  ok(/if \(busy && !busy\.stopped\) \{\s*MessagePlugin\.warning\(/.test(code),
    '同一会话互斥时给出提示，而不是静默 return');
}

/* ══════════ [2] 行为：A 在跑时 B 还能发 ══════════ */
if (PROBE) {
  let has = true;
  try { await access(join(OLD_DIST, 'index.html')); } catch { has = false; }
  if (!has) {
    console.log('\n  ⚠️ 缺少修复前的产物快照 .tmp/dist-pre-a142/ —— 行为段的反向探针跳过');
    console.log('     生成方式：在打 A142 的 build **之前** cp -r dist .tmp/dist-pre-a142');
    summary();
    process.exit(1);
  }
}

const server = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path.startsWith('/api/')) {
    if (path === '/api/chat' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      let p = {};
      try { p = JSON.parse(body); } catch { /* ignore */ }
      const sid = p.sessionId || '(none)';
      seen.chat.push({ sid, at: Date.now() });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = o => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { /* closed */ } };
      const runId = `run-${sid}-${seen.chat.length}`;
      const mid = `msg-${sid}-${seen.chat.length}`;
      seen.openStreams.add(sid);
      req.on('close', () => seen.openStreams.delete(sid));

      send({ type: 'run_start', runId, seq: 1, sessionId: sid, messageId: mid, agentId: 'a1', model: 'm1' });
      // 块事件按 v2 契约（shared/blocks.ts）：`block_open` 带 `block` 对象，
      // `block_delta` 用 `blockId` + `channel` + `delta`。
      // 第一版按 `{ id, blockType }` 写，前端 applyRunEvent 直接返回 false，
      // 界面一个字都不长 —— 而「没长字」看起来跟「流被掐了」一模一样，差点误判。
      send({ type: 'block_open', seq: 2, block: { id: 'b1', type: 'text', text: `${sid} 开始`, state: 'streaming' } });
      send({ type: 'block_delta', seq: 3, blockId: 'b1', channel: 'text', delta: '·' });

      if (sid === 's1') {
        // 长任务：每 700ms 长一个字，永不 end（直到探针断开）
        let n = 0;
        const t = setInterval(() => {
          if (res.writableEnded) return clearInterval(t);
          n++;
          send({ type: 'block_delta', seq: 10 + n, blockId: 'b1', channel: 'text', delta: `·${n}` });
        }, 700);
        req.on('close', () => clearInterval(t));
        return;
      }
      send({ type: 'block_close', seq: 900, blockId: 'b1', state: 'done' });
      send({ type: 'run_end', runId, seq: 901, status: 'ok', durationMs: 90 });
      res.end();
      return;
    }

    const m = path.match(/^\/api\/runs\/([^/]+)\/stop$/);
    if (m) {
      seen.stops.push(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ stopped: true }));
    }

    const json = o => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(o));
    };
    // 后台任务胶囊的数据源：s1 还在跑时必须如实返回，用来验「提示照出现，但不挡输入」。
    // 必须自己实现 `exclude`（真实服务端就是这么过滤的）：不过滤的话当前会话
    // 也会被算进「后台」，胶囊数字是假的，断言跟着假绿。
    if (path === '/api/runs/active') {
      const exclude = new URL(req.url || '/', 'http://x').searchParams.get('exclude') || '';
      const runs = [...seen.openStreams]
        .filter(sid => sid !== exclude)
        .map(sid => ({
          runId: `run-${sid}`, sessionId: sid, agentId: sid === 's1' ? 'a1' : 'a2', startedAt: Date.now(),
        }));
      return json({ runs });
    }
    if (path === '/api/agents/custom') return json({ agents: [] });
    if (path === '/api/agent-credentials') return json({ credentials: [] });
    if (path.startsWith('/api/agents')) return json({ agents: AGENTS });
    if (path.startsWith('/api/memory')) return json({ core: '', user: '', skills: [], budget: { used: 0, limit: 800 } });
    if (path.startsWith('/api/permission-rules')) return json({ rules: [] });
    if (path.startsWith('/api/models')) return json({ models: MODELS });
    if (path.startsWith('/api/user-profile')) return json({ nickname: '', avatar: '' });
    if (path.startsWith('/api/projects')) return json({ projects: [] });
    if (path.startsWith('/api/check-login')) return json({ isLoggedIn: false, envConfigured: false, cliConfigured: false, envVars: {} });
    const one = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (one) {
      const sid = one[1];
      // s2 必须**有历史消息**：空会话渲染的是「新对话」页，消息列表（连同
      // 底部的后台任务胶囊）根本不挂载 —— 胶囊断言会因为「页面没渲染」而假红。
      const msgs = sid === 's2'
        ? [{ id: 'm0', session_id: 's2', role: 'user', content: 'B 的历史提问', created_at: new Date().toISOString() }]
        : [];
      return json({ session: SESSIONS.find(s => s.id === sid) || SESSIONS[0], messages: msgs });
    }
    if (path.startsWith('/api/sessions')) return json({ sessions: SESSIONS });
    return json({});
  }

  let fp = decodeURIComponent(path);
  if (fp === '/') fp = '/index.html';
  let file = join(DIST, fp);
  let body;
  try { body = await readFile(file); }
  catch { file = join(DIST, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

/** 输入区状态：TDesign 的 sender 是 open shadow DOM，按钮在影子里 */
const SENDER = `(() => {
  const host = document.querySelector('t-chat-sender');
  const sr = host && host.shadowRoot ? host.shadowRoot : null;
  const cls = e => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || '');
  const all = sr ? [...sr.querySelectorAll('*')] : [];
  return {
    hasShadow: !!sr,
    hasStop: all.some(e => /stop/i.test(cls(e))),
  };
})()`;

/** 消息列表可见文字长度：穿 shadow DOM，否则 innerText 只数得到外层 */
const TEXT_LEN = `(() => {
  const list = document.querySelector('[data-msg-list]');
  if (!list) return -1;
  let n = 0;
  const walk = node => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) n += (c.nodeValue || '').trim().length;
      else if (c.nodeType === 1) { if (c.shadowRoot) walk(c.shadowRoot); walk(c); }
    }
  };
  walk(list);
  return n;
})()`;

async function clickSenderButton() {
  const h = await page.evaluateHandle(`(() => {
    const sr = document.querySelector('t-chat-sender') && document.querySelector('t-chat-sender').shadowRoot;
    if (!sr) return null;
    const c = [...sr.querySelectorAll('button, [class*="button"]')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    });
    return c.length ? c[c.length - 1] : null;
  })()`);
  const el = h.asElement();
  if (!el) throw new Error('找不到 sender 按钮');
  await el.click({ timeout: 8000 });
}

async function send(text) {
  await page.locator('t-chat-sender textarea').first().fill(text);
  await clickSenderButton();
}

async function switchTo(sid) {
  await page.locator(`[data-conversation-item="${sid}"]`).click();
  await page.waitForTimeout(900);
}

console.log(`\n[2] 会话 A 在跑时，B 还能不能发（服务 ${PROBE ? '修复前产物' : '当前产物'}）`);
await page.goto(`${base}/chat/s1`, { waitUntil: 'domcontentloaded' });
await page.locator('t-chat-sender textarea').first().waitFor({ timeout: 25000 });
await page.waitForTimeout(900);

await send('A 的第一条');
await page.waitForTimeout(1300);
{
  const st = await page.evaluate(SENDER);
  ok(seen.chat.length === 1 && seen.chat[0].sid === 's1', 'A 的消息发出去了', `POST=${JSON.stringify(seen.chat.map(c => c.sid))}`);
  ok(st.hasStop, 'A 的输入区进入停止态');
}

// A 正在长字，先记一个基线
const aLen1 = await page.evaluate(TEXT_LEN);
await page.waitForTimeout(1600);
const aLen2 = await page.evaluate(TEXT_LEN);
ok(aLen2 > aLen1, 'A 的回复在持续增长（基线）', `${aLen1} → ${aLen2}`);

await switchTo('s2');
const bIdle = await page.evaluate(SENDER);
ok(bIdle.hasShadow, 'B 的输入框渲染出来了');
ok(bIdle.hasStop === false, '**B 的输入区是发送态**（不是 A 的停止键）',
  bIdle.hasStop ? '仍是停止态 —— 这就是用户报的「发不出去」' : 'ok');

// 胶囊该出现（它在提示「另一个会话还在跑」），但不能挡住输入。
// 它是 5 秒轮询：切会话会立刻 tick 一次，但首帧不一定赶得上，给到 8 秒。
let pill = '';
for (let i = 0; i < 16; i++) {
  pill = await page.evaluate(`(() => {
    const t = document.body.textContent || '';
    const m = t.match(/(\\d+)\\s*个后台任务运行中/);
    return m ? m[0] : '';
  })()`);
  if (pill) break;
  await page.waitForTimeout(500);
}
ok(/1 个后台任务运行中/.test(pill), '后台任务胶囊如实提示「1 个在跑」', pill || '(8 秒内没出现)');

await send('B 的第一条');
await page.waitForTimeout(1400);
{
  const sentB = seen.chat.some(c => c.sid === 's2');
  ok(sentB, '**B 的消息真的发出去了**（POST /api/chat 里有 s2）',
    `POST=${JSON.stringify(seen.chat.map(c => c.sid))}`);
  ok(seen.openStreams.has('s1'), 'A 的流没有被 B 的发送打断', `open=${[...seen.openStreams]}`);
  // 评审图：A 还在跑（左侧 A 有流式标记 + 胶囊在提示），而 B 的输入区是正常发送态。
  // 这张图就是用户报的那个场景「修好之后长什么样」。
  await page.screenshot({ path: join(OUT, PROBE ? 'probe-b-while-a-running.png' : 'b-while-a-running.png') })
    .catch(() => {});
}

/* ══════════ [3] 回到 A：仍在跑，停止键还在 ══════════ */
console.log('\n[3] 回到 A：A 那一轮没被影响');
await switchTo('s1');
{
  const st = await page.evaluate(SENDER);
  ok(st.hasStop, 'A 仍是停止态（说明它一直在跑）');
  const l1 = await page.evaluate(TEXT_LEN);
  await page.waitForTimeout(1800);
  const l2 = await page.evaluate(TEXT_LEN);
  ok(l2 > l1, 'A 的回复还在长字', `${l1} → ${l2}`);
}

/* ══════════ [4] 同一会话不能并发两轮 ══════════
 *
 * 走**回车**而不是点按钮：流式期间那颗按钮已经变成停止键，点它等于停掉本轮。
 *
 * ⚠️ 实测：新构建里 loading 期间回车**不会**触发 onSend（TDesign 的 ChatSender
 * 自己吞了），所以「弹提示」这条在 UI 上根本到不了 —— 写它一定是假红。
 * `sendMessage` 开头那道 `turnsRef.current.has(currentSessionId)` 是**纵深防御**
 * （防将来新增的调用方），它的「不静默」契约在 [1] 里按源码断言。
 */
console.log('\n[4] 同一会话不能并发两轮');
{
  const before = seen.chat.length;
  await page.locator('t-chat-sender textarea').first().fill('A 的第二条');
  await page.locator('t-chat-sender textarea').first().press('Enter');
  await page.waitForTimeout(1000);
  ok(seen.chat.length === before, '回车没有造出第二轮（同一会话互斥）', `${before} → ${seen.chat.length}`);

  const draft = await page.locator('t-chat-sender textarea').first().inputValue();
  ok(draft.includes('A 的第二条'), '被拦下的那条还留在输入框里（不吞用户已经打的字）', JSON.stringify(draft));

  // 清掉草稿，别让它影响下一步
  await page.locator('t-chat-sender textarea').first().fill('');
}

/* ══════════ [5] 在 A 点停止：只停 A ══════════ */
console.log('\n[5] 停止只作用于当前会话');
{
  const bBefore = seen.chat.filter(c => c.sid === 's2').length;
  await clickSenderButton(); // 此刻是停止键
  await page.waitForTimeout(1800);
  ok(seen.stops.some(r => r.startsWith('run-s1-')), '停止请求打到了 A 的 run', seen.stops.join(',') || '(无)');
  ok(!seen.stops.some(r => r.startsWith('run-s2-')), '没有误停 B 的 run');
  const st = await page.evaluate(SENDER);
  ok(st.hasStop === false, 'A 的输入区回到发送态');

  // A 停下来之后，同一会话要能再发 —— 否则「互斥」变成了「永久锁死」
  await page.locator('t-chat-sender textarea').first().fill('A 的第三条');
  await clickSenderButton();
  await page.waitForTimeout(1400);
  ok(seen.chat.filter(c => c.sid === 's1').length >= 2, 'A 停了之后能立刻再发一条',
    `s1 POST 共 ${seen.chat.filter(c => c.sid === 's1').length} 次`);
  ok(seen.chat.filter(c => c.sid === 's2').length === bBefore, 'B 那边一条没多（互不干扰）');
}

await page.screenshot({ path: join(OUT, PROBE ? 'probe.png' : 'concurrency.png') }).catch(() => {});

await browser.close();
server.close();
summary();

function summary() {
  console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 条`} — ${total - failures.length}/${total}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}
