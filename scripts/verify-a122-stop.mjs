/**
 * A122 验证：点「停止」要真的停下。
 *
 * ## 为什么这个 bug 值得三层都打一遍
 *
 * 用户报的是「我点了停止，而还在进行」。查下来三处各自都缺一半：
 *
 *   1. 前端 `handleStop` 只有一句 `setIsLoading(false)` —— 没掐流、没通知后端、
 *      没关气泡的流式态。SSE 照常把字往屏幕上送，A121 的匀速揭示还会继续吐字。
 *   2. 后端**根本没有停止接口**。唯一的中止路是「客户端断开 + 20s 断线宽限」，
 *      所以就算前端掐了 fetch，Agent 还要再跑 20 秒才死。
 *   3. 掐 fetch 本身还会**反噬**：`consume()` 抛出的异常正好落进 E5 的断线重连分支
 *      （AbortError 与网络断在 catch 里长得一模一样），刚停的流立刻被 `?after=seq` 接回去。
 *
 * 这三条两两互相掩盖，任何一层单独测都会「绿」：
 *   · 只测后端接口 → 前端没接线也测不出来
 *   · 只测前端 → 夹具里没有真 SSE，重连那条反噬路径看不见
 * 所以 [2] 用真服务端 + 讲真协议的桩 CLI，[3] 用真浏览器点真按钮，[4] 用源码契约
 * 守住「群聊/工作流这两条链路也接了同一个把手」（它们共用一个状态机，漏一条就是半修）。
 *
 * ## 桩 CLI
 *
 * WorkBuddy 走 SDK 通道，`OPC_CODEBUDDY_CLI` 把它的子进程指到桩上。
 * 桩讲真实协议（initialize / interrupt 控制请求 + assistant/result 数据流），
 * 并且**每条回复吐 40 段、每段间隔 120ms** —— 不停的话一轮要 5 秒，
 * 这样「停止之后还在不在长字」才是可测的，而不是碰巧跑得太快看不出来。
 *
 * ## 不碰真实数据
 *
 * `OPC_DATA_DIR` 指向 `.tmp/a122-*-<ts>/data`，绝不读写真实 `data/chat.db`。
 *
 * 运行：先 `npm run build`（[3] 要托管 dist），再 `node scripts/verify-a122-stop.mjs`
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a122-stop-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const STUB = path.join(TMP, 'stub-cli.cjs');
const STUB_LOG = path.join(TMP, 'stub.log');

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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitReady(base, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let log = '';
  child.stdout?.on('data', d => (log += String(d)));
  child.stderr?.on('data', d => (log += String(d)));
  while (Date.now() < deadline) {
    if (child.exitCode != null) return { ready: false, log };
    try {
      const res = await fetch(`${base}/api/sessions`);
      if (res.ok) return { ready: true, log };
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { ready: false, log };
}

/**
 * 桩 CLI 源码。
 *
 * 只在**本轮**吐够多段就停：40 段 × 120ms ≈ 5 秒，足够在中间任意时刻按下停止。
 * interrupt 控制请求必须回 success 再补一条 result —— 真实 CLI 就是这么收尾的，
 * 不回的话 SDK 的 stream() 会一直等，本端也吊着（A107 桩注释里记过同一个坑）。
 */
const STUB_CODE = `
const readline = require('node:readline');
const LOG = process.env.STUB_LOG;
const log = (o) => { if (LOG) require('node:fs').appendFileSync(LOG, JSON.stringify(o) + '\\n'); };
const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i+1] : undefined; };
const sessionId = argOf('--session-id') || ('stub-' + process.pid);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const GAP = Number(process.env.STUB_GAP_MS || 120);
const PARTS = Number(process.env.STUB_PARTS || 40);
let msgCount = 0;
let interrupted = false;
/** 这一轮排出去的定时器，interrupt 时要全部撤掉 */
const timers = [];
log({ event: 'start', pid: process.pid, sessionId });
send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'stub-model', cwd: process.cwd(), tools: [] });
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') {
    const r = m.request || {};
    if (r.subtype === 'initialize') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { session_id: sessionId, currentModelId: 'stub-model' } } });
    } else if (r.subtype === 'interrupt') {
      interrupted = true;
      // 关键：把这一轮还没到点的定时器全部取消。否则第二轮消息进来时，
      // 上一轮残留的定时器会继续吐 seg，并且那条最后的 result 会把第二轮
      // 直接「提前结束」—— 现场表现是界面上一个字都没有、状态却已是「已处理」，
      // 看着像产品的错，其实是桩自己造的（第一版就踩了这个）。
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      log({ event: 'interrupt' });
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 0, session_id: sessionId, cost: 0, interrupted: true });
    } else {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    }
    return;
  }
  if (m.type === 'user') {
    msgCount++;
    interrupted = false;
    log({ event: 'user', n: msgCount });
    tick(msgCount);
  }
});
function tick(n) {
  if (interrupted) return;
  for (let i = 0; i < PARTS; i++) {
    timers.push(setTimeout(() => {
      if (interrupted) return;
      // 每段刻意写长（≈30 字）：不停的话 2.5 秒能多出 600+ 字，
      // 「停止后还在不在涨」才是可判别的；4 字一段会被界面收尾小字的长度变化淹没。
      // 注意这里不能用模板字符串：整段桩代码本身就在一个模板字符串里，
      // 美元符加大括号会被外层先求值（i 在外层是 undefined，脚本加载就炸）。
      send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' seg' + i + '-' + Array(25).join('x') }] } });
      if (i === PARTS - 1) {
        send({ type: 'result', subtype: 'success', is_error: false, duration_ms: GAP * PARTS, session_id: sessionId, cost: 0 });
      }
    }, i * GAP));
  }
}
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;

/** 读一条 SSE 流，把每帧的 data 交给 onEvent（返回 true = 提前结束读取） */
async function readSse(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let data = null;
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        /* 单帧坏掉不拖垮整条流 */
      }
      if (data && onEvent(data)) {
        reader.cancel().catch(() => {});
        return;
      }
    }
  }
}

function stubLogText() {
  try {
    return fs.readFileSync(STUB_LOG, 'utf8');
  } catch {
    return '';
  }
}

function stubInterrupts() {
  return (stubLogText().match(/"event":"interrupt"/g) ?? []).length;
}

/**
 * 等桩日志里的 interrupt 次数涨上去。
 *
 * 不能拿「POST 回来那一刻的计数」直接比：`run_end` 是服务端写完就发的，
 * 而子进程那句日志是**另一个进程**落盘，两者差几毫秒很常见 —— 第一版就是
 * 这么写死的，结果同一份代码两次跑一次绿一次红（假红比假绿更难查）。
 */
async function waitForInterrupts(prev, ms = 4000) {
  const t0 = Date.now();
  let n = stubInterrupts();
  while (n <= prev && Date.now() - t0 < ms) {
    await new Promise(r => setTimeout(r, 120));
    n = stubInterrupts();
  }
  return n;
}

async function startServer(port) {
  const child = spawn('npx tsx server/index.ts', {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      OPC_DATA_DIR: DATA,
      // 本机垫片会把子进程的 fs 调用转去回收站，必须清空
      NODE_OPTIONS: '',
      // WorkBuddy 的 SDK 通道指向桩
      OPC_CODEBUDDY_CLI: STUB,
      STUB_LOG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { ready, log } = await waitReady(`http://127.0.0.1:${port}`, child);
  return { child, ready, log };
}

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

/** 系统 Chrome 优先；没有就取 ms-playwright 里最新的一个 chromium 构建 */
function resolveChrome() {
  const system = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(system)) return system;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs
    .existsSync(root)
    ? fs
        .readdirSync(root)
        .filter(d => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/**
 * 描述输入框里那颗「发送 / 停止」按钮。
 *
 * TDesign 的 chat sender 是 open shadow DOM，按钮在里面，`page.locator(css)`
 * 虽然能穿，但类名带 `t-chat__input__button__stop` 这种「图标级」后缀 ——
 * 拿它当可点元素会在 30 秒后超时（实测踩过）。所以这里在**页面内**遍历
 * shadowRoot 找按钮，并且用「影子里有没有含 stop 的元素」判断流动态。
 */
const SENDER_PROBE = `(() => {
  const host = document.querySelector('t-chat-sender');
  const sr = host && host.shadowRoot ? host.shadowRoot : null;
  const pool = sr ? [...sr.querySelectorAll('button, [class*="button"], [role="button"]')] : [];
  const found = pool.map(e => {
    const r = e.getBoundingClientRect();
    return { cls: String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || ''), tag: e.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return {
    hasShadow: !!sr,
    buttons: found,
    hasStopEl: found.some(b => /stop/i.test(b.cls)) || (sr ? [...sr.querySelectorAll('*')].some(e => /stop/i.test(String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : ''))) : false),
  };
})()`;

/**
 * 消息列表里的可见文字长度。
 *
 * 不能直接 `list.innerText.length` —— TDesign 的消息体在 shadow DOM 里，
 * `innerText` / `textContent` 都**穿不透** shadowRoot，实测整条回答 1200 字
 * 时它只报 65（只剩两条用户消息）。那样量出来的「不再增长」是探针失明，
 * 不是产品停了（第一版就被这个假绿骗过）。这里手写递归，遇到 shadowRoot 就下去。
 */
async function msgTextLength(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-msg-list]');
    if (!list) return -1;
    let n = 0;
    const walk = node => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) n += (c.nodeValue ?? '').trim().length;
        else if (c.nodeType === 1) {
          if (c.shadowRoot) walk(c.shadowRoot);
          walk(c);
        }
      }
    };
    walk(list);
    return n;
  });
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STUB, STUB_CODE);

  console.log('\nA122 点「停止」要真的停下');

  // ── [1] 纯函数层：runHub 的即时中止语义 ─────────────────────────
  {
    const r = spawnSync('npx', ['tsx', 'scripts/verify-run-hub.ts'], {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    ok(r.status === 0, '[1] runHub 中止语义（L1）全绿', out.trim().split('\n').filter(Boolean).pop()?.slice(0, 60));
  }

  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('\n  ⚠️ 没有 dist/index.html —— 先跑 npm run build（[3] 需要托管静态产物）\n');
    process.exit(1);
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startServer(port);
  if (!server.ready) {
    ok(false, '服务端启动并就绪', server.log.slice(-600));
    killTree(server.child);
    process.exit(1);
    return;
  }
  ok(true, '服务端启动并就绪（桩 CLI 已接上 SDK 通道）', `:${port}`);

  const cleanup = () => {
    killTree(server?.child);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 本机删除会转回收站，留临时目录不影响结论 */
    }
  };
  process.on('exit', cleanup);

  // ── [2] 后端接口：按 runId 即时中止 ─────────────────────────────
  let chatSessionId = '';
  {
    const sess = await json(
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'workbuddy', title: 'A122 停止验证' }),
      })
    );
    chatSessionId = sess.id ?? sess.session?.id ?? '';
    ok(Boolean(chatSessionId), '[2] 建好一条 workbuddy 会话', String(chatSessionId).slice(0, 8));

    let runId = '';
    let textFrames = 0;
    let endStatus = '';
    let sawRunEnd = false;
    let resolveStreaming;
    const streaming = new Promise(r => (resolveStreaming = r));

    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: chatSessionId, message: '随便说点什么', agentId: 'workbuddy' }),
    });
    ok(resp.ok, '[2] /api/chat 已接受本轮', `HTTP ${resp.status}`);

    // 读流要**一直读到后端自己收尾**：中途 cancel 会落进 20s 断线宽限，
    // 那就变成「靠断开才停」，正好把要验的东西验反。
    const streamDone = readSse(resp, ev => {
      if (ev.type === 'run_start') runId = ev.runId ?? '';
      if (ev.type === 'block_delta') textFrames++;
      if (ev.type === 'run_end') {
        sawRunEnd = true;
        endStatus = String(ev.status ?? '');
      }
      if (runId && textFrames >= 3) resolveStreaming();
      return false;
    });

    // 先等它真的开始吐字（桩每 120ms 一段，25s 足够）
    const raced = await Promise.race([
      streaming.then(() => 'streaming'),
      new Promise(r => setTimeout(() => r('timeout'), 25000)),
    ]);
    ok(raced === 'streaming', '[2] 停止前流里已在吐字（不是停了个空跑的 run）', `delta=${textFrames}`);
    ok(Boolean(runId), '[2] 拿到 runId（停止接口按它寻址）', runId.slice(0, 8));

    const before = await json(await fetch(`${base}/api/runs/active`));
    ok(
      (before.runs ?? []).some(r => r.runId === runId),
      '[2] 停止前这条 run 在 active 清单里（后台任务能看见它）'
    );
    const interruptsBefore = stubInterrupts();

    // 停止必须是「立刻」：断线宽限那条路要等 20 秒，等得起就不叫停止
    const tStop = Date.now();
    const stopRes = await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
    const stopBody = await stopRes.json().catch(() => ({}));
    const stopMs = Date.now() - tStop;
    ok(stopRes.status === 200 && stopBody.ok === true, '[2] POST /api/runs/:runId/stop 回 200', `HTTP ${stopRes.status}`);
    ok(stopMs < 1500, '[2] 停止接口本身是即时的', `${stopMs}ms`);

    const closed = await Promise.race([
      streamDone.then(() => 'closed'),
      new Promise(r => setTimeout(() => r('hanging'), 10000)),
    ]);
    ok(closed === 'closed', '[2] 停止后后端自己收尾并把流关掉（不是靠前端 cancel）');
    ok(sawRunEnd && endStatus === 'aborted', '[2] 流以 run_end status=aborted 收尾', endStatus || '(没收到)');
    const interruptsAfter = await waitForInterrupts(interruptsBefore);
    ok(
      interruptsAfter > interruptsBefore,
      '[2] 桩 CLI 真收到 interrupt 控制请求（子进程被叫停）',
      `${interruptsBefore}→${interruptsAfter}`
    );

    const after = await json(await fetch(`${base}/api/runs/active`));
    ok(
      !(after.runs ?? []).some(r => r.runId === runId),
      '[2] 停止后从 active 清单消失（不会留一个假「仍在跑」）'
    );

    const again = await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' });
    ok(again.status === 404, '[2] 重复停止回 404（不假装又停了一次）', `HTTP ${again.status}`);

    const ghost = await fetch(`${base}/api/runs/nonexistent-run/stop`, { method: 'POST' });
    ok(ghost.status === 404, '[2] 不存在的 run 回 404');

    // 半截答案不能因为停止而丢：用户停的是「继续跑」，不是「把已经说的抹掉」
    const s2 = await json(await fetch(`${base}/api/sessions/${chatSessionId}`));
    const assistant = (s2.messages ?? []).filter(m => m.role === 'assistant').pop();
    const kept = String(assistant?.content ?? '');
    ok(kept.length > 0, '[2] 停止后已产出的正文仍在会话里（没抹掉）', `${kept.length} 字`);
    ok(
      kept.length < 400,
      '[2] 正文确实停在半截（40 段没吐完）',
      `${kept.length}/≈1200`
    );
  }

  // ── [3] 真浏览器：点界面上的停止按钮 ────────────────────────────
  const exe = resolveChrome();
  if (!exe) {
    ok(false, '[3] 找不到可用的 Chrome/Chromium，浏览器层未跑');
  } else if (!chatSessionId) {
    ok(false, '[3] [2] 没建出会话，浏览器层跳过');
  } else {
    const browser = await chromium.launch({
      executablePath: exe,
      args: ['--no-sandbox', '--disable-gpu-sandbox'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const reattach = [];
    page.on('request', req => {
      if (/\/api\/runs\/[^/]+\/stream/.test(req.url())) reattach.push(req.url());
    });

    try {
      // 复用 [2] 那条会话：气泡、输入框、后端都是真的，且已经有一条「停在半截」的回复
      await page.goto(`${base}/chat/${chatSessionId}`, { waitUntil: 'domcontentloaded' });
      await page.locator('t-chat-sender textarea').first().waitFor({ timeout: 25000 });

      const senderState = () => page.evaluate(SENDER_PROBE);
      const idle = await senderState();
      console.log(
        `      sender 结构：shadow=${idle.hasShadow} 按钮=[${idle.buttons.map(b => `${b.cls}(${b.w}x${b.h})`).join(' | ').slice(0, 220)}]`
      );
      ok(idle.hasShadow && idle.buttons.length > 0, '[3] 输入框内确实找得到按钮（shadow DOM 穿透成功）');

      await page.locator('t-chat-sender textarea').first().fill('再随便说点很长的话');

      // 点发送：取影子里最后一颗有尺寸的按钮（发送键在右下角）
      const clickSenderButton = async () => {
        const h = await page.evaluateHandle(`(() => {
          const sr = document.querySelector('t-chat-sender') && document.querySelector('t-chat-sender').shadowRoot;
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
      };
      await clickSenderButton();

      // 等到「停止」态出现（TDesign 在流式时把那颗按钮换成停止图标）
      let streaming = false;
      const tSeen = Date.now();
      while (Date.now() - tSeen < 20000) {
        const st = await senderState();
        if (st.hasStopEl) {
          streaming = true;
          break;
        }
        await page.waitForTimeout(200);
      }
      ok(streaming, '[3] 发送后输入框进入可停止态（找得到停止控件）', `${Date.now() - tSeen}ms`);

      // 等到界面**真的开始长字**再动手停 —— 这才叫用户看到的「还在进行」。
      // 固定 sleep 会误判：首字到达要先等 CLI 握手 + 会话池排队，实测 1~3 秒，
      // 而 1 秒内停在「正在生成」是完全正常的（第一版就是拿 700ms 窗口判的，假红）。
      let grew = false;
      // 变量名不能叫 base：外层已有 `const base = http://127.0.0.1:port`，
      // 同名 let 会在本块里形成 TDZ，前面每次用 URL 都报「before initialization」
      let shownLen = await msgTextLength(page);
      const tG = Date.now();
      while (Date.now() - tG < 15000) {
        await page.waitForTimeout(300);
        const nowLen = await msgTextLength(page);
        if (nowLen > shownLen) {
          grew = true;
          shownLen = nowLen;
          break;
        }
      }
      ok(grew, '[3] 点停止前界面正文确实在增长（用户看到的「还在进行」）', `${Date.now() - tG}ms 见长`);
      if (!grew) {
        const sample = await page.evaluate(() => {
          const list = document.querySelector('[data-msg-list]');
          if (!list) return '(没有 [data-msg-list])';
          const acc = [];
          const walk = node => {
            for (const c of node.childNodes) {
              if (c.nodeType === 3) acc.push(c.nodeValue ?? '');
              else if (c.nodeType === 1) {
                if (c.shadowRoot) walk(c.shadowRoot);
                walk(c);
              }
            }
          };
          walk(list);
          return acc.join(' ').replace(/\s+/g, ' ').slice(-100);
        });
        console.log(`      现场文本：…${sample}`);
        console.log(`      桩日志尾部：${stubLogText().split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 200)}`);
      }

      const interruptsBefore = stubInterrupts();
      await clickSenderButton();
      await page.waitForTimeout(300);
      const justAfter = await msgTextLength(page);

      // 停止后给它 2.5 秒 —— 桩每 120ms 吐一段，还在跑的话一定看得见增长
      await page.waitForTimeout(2500);
      const later = await msgTextLength(page);

      ok(later <= justAfter + 60, '[3] 点停止后正文不再增长（A121 的匀速揭示也停了）', `${shownLen}→${justAfter}→${later}`);
      ok(reattach.length === 0, '[3] 停止没有触发断线重连把流接回来', `重连请求 ${reattach.length} 次`);

      const afterStop = await senderState();
      ok(!afterStop.hasStopEl, '[3] 停止后输入框回到可发送态（不是永久转圈）');

      const bodyText = await page.evaluate(() => document.body.innerText);
      ok(!bodyText.includes('请求失败'), '[3] 用户主动停止没有被报成「请求失败」');

      const interruptsAfterUi = await waitForInterrupts(interruptsBefore);
      ok(
        interruptsAfterUi > interruptsBefore,
        '[3] 界面这一次点击真的叫停了子进程（桩又多收到一次 interrupt）',
        `${interruptsBefore}→${interruptsAfterUi}`
      );
    } catch (e) {
      ok(false, '[3] 浏览器实测跑通', String(e).slice(0, 200));
    } finally {
      await browser.close();
    }
  }

  // ── [4] 源码契约：三条链路接的是同一个把手 ──────────────────────
  {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

    const chat = read('src/hooks/useChat.ts');
    ok(/signal: controller\.signal/.test(chat), '[4] 一对一：fetch 带上了 AbortController');
    ok(/turnRef\.current\?\.stopped\) throw err/.test(chat), '[4] 一对一：停止时躲过断线重连（不能把流接回来）');
    ok(/api\/runs\/\$\{turn\.runId\}\/stop/.test(chat), '[4] 一对一：停止打的是后端即时中止接口');

    const group = read('src/hooks/useGroupChat.ts');
    const signalHits = (group.match(/signal: stream\.signal/g) ?? []).length;
    ok(signalHits === 2, '[4] 群聊与工作流各挂一次 signal（只修一条就是半修）', `命中 ${signalHits}`);
    ok(/api\/runs\/\$\{r\.runId\}\/stop/.test(group), '[4] 群聊：逐路 POST 中止（多路并行不留半停）');
    ok(/if \(stopped\) throw err/.test(group), '[4] 群聊：停止后不重连');
    ok(/isStopped: \(\) => stopped/.test(group), '[4] 群聊：区分「用户停的」与「断线的」');

    const page = read('src/pages/ChatPage.tsx');
    ok(/isGroup \? group\.stopRun : onStop/.test(page), '[4] 群聊的停止接到群聊自己的把手（不再借用 1:1）');

    const api = read('server/index.ts');
    ok(/app\.post\("\/api\/runs\/:runId\/stop"/.test(api), '[4] 后端注册了即时停止路由');
    const handlerHits = (api.match(/runHub\.setAbortHandler/g) ?? []).length;
    ok(handlerHits === 1, '[4] 一对一路由注册了中止动作', `命中 ${handlerHits}`);
    const abortTurnHits = (api.match(/abortTurn: \(\) =>/g) ?? []).length;
    ok(abortTurnHits === 2, '[4] 群聊与工作流都把 controller 交给了 runner', `命中 ${abortTurnHits}`);

    const runner = read('server/turn-runner.ts');
    ok(/runHub\.setAbortHandler\(runId/.test(runner), '[4] 每一棒各自注册中止（停一路只杀那一路）');

    const hub = read('server/run-hub.ts');
    ok(/run\.onAbort = undefined;/.test(hub), '[4] run_end 后清掉中止闭包（不吊住 res/session）');
  }

  console.log(`\n${failures.length ? '❌' : '✅'} A122 停止链路：${pass}/${pass + fail} 通过`);
  for (const f of failures) console.log(`   · ${f}`);
  console.log('');
  process.exit(failures.length ? 1 : 0);
}

main().catch(err => {
  console.error('A122 脚本自身异常：', err);
  process.exit(1);
});
