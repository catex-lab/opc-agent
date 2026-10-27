/**
 * A123 验证：权限模式是**会话级设置**，从芯片一路走到子进程命令行。
 *
 * ## 修的是什么
 *
 * 用户报「我全都放行，但还是要我授权允许」。查下来这一档**从来没有落到会话上**：
 *
 *   · 芯片写的是 `App.tsx` 里一个全局 `useState('default')`；
 *   · 发消息时 `useChat` 读的是 `currentSession.permissionMode`；
 *   · 而 sessions 表**没有这一列**，PATCH 也**不认这个字段** → 从库里读出来的会话
 *     永远 `undefined` → 每条消息都按 `'default'` 发 → 适配器里那句
 *     `if (permissionMode === 'bypassPermissions') return allow` 永远走不到。
 *
 * 两头都不报错，芯片显示的还正是它自己刚设的值 —— 典型假控件。
 *
 * ## 为什么必须打到子进程命令行
 *
 * 「PATCH 存进去了」和「权限窗真的不弹了」之间隔着路由回落、SendContext、
 * 适配器拼参数、SDK 桥四道。任何一道掉了，界面上都只表现为「还在弹窗」，
 * 而每一道单独看都是绿的。所以 [3] 用桩 CLI 把 argv 记下来直接对账，
 * 并分别跑 default / bypassPermissions 两条会话，看**帧序列里有没有
 * `permission_request`** —— 这是用户唯一能感知的结果。
 *
 * ## 覆盖
 *
 *   [1] 纯函数层   —— 跑 verify-session-persist.ts（含本列的迁移与读写）
 *   [2] 接口层     —— POST 带档 / 不带档为 NULL / PATCH 改档 / 非法值 400 且原值不动 /
 *                     清空 / **重启服务端后仍在**（持久化的唯一硬证据）
 *   [3] 适配器层   —— 桩 argv 真收到 `--permission-mode <值>`；default 会话弹权限窗、
 *                     全放行会话不弹（请求体刻意**不带** permissionMode，只靠会话里存的值）
 *   [4] 界面层     —— 芯片显示的是会话存的档位；点芯片换档真的落库；刷新后仍是新值
 *   [5] 源码契约   —— 五个读写点各钉一条，防止将来谁把某一环改回「本地变量自high」
 *
 * 运行：先 `npm run build`（[4] 要托管 dist），再 `node scripts/verify-a123-permission-mode.mjs`。
 * 全程用独立 `OPC_DATA_DIR` 与桩 CLI，不碰真实 `data/chat.db`、不调真实模型。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a123-perm-${Date.now()}`);
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

fs.mkdirSync(DATA, { recursive: true });

/**
 * 桩 CLI：收到用户消息后先吐一句文本，再主动发一个 `can_use_tool` 权限请求。
 * 我们的桥怎么应答，由服务端按会话档位决定 —— 那正是要验的那一步。
 *
 * 三条刻意的设计（都是实测里换来的）：
 *   · 每次启动把 **argv 记进日志**：`--permission-mode` 是唯一能证明
 *     「值真的走到了子进程命令行」的观测点，比读接口返回值硬得多。
 *   · 应答回来才收尾，并且带 12 秒兜底：不兜住的话「没收到应答」会变成脚本挂死，
 *     看起来像产品坏了。
 *   · 日志逐行 `appendFileSync`，父进程读的时候不需要它退出。
 */
fs.writeFileSync(
  STUB,
  [
    "'use strict';",
    "const fs = require('fs'), readline = require('node:readline');",
    "const LOG = process.env.STUB_LOG;",
    "const log = o => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + String.fromCharCode(10)); };",
    "const send = o => process.stdout.write(JSON.stringify(o) + String.fromCharCode(10));",
    "const SID = 'stub-' + process.pid;",
    "let awaiting = false;",
    "log({ event: 'start', argv: process.argv.slice(2) });",
    "send({ type: 'system', subtype: 'init', session_id: SID, model: 'stub-model', cwd: process.cwd(), tools: ['Bash'] });",
    "const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });",
    "rl.on('line', line => {",
    "  let m = null; try { m = JSON.parse(line); } catch {}",
    "  if (!m) return;",
    "  log({ event: 'recv', type: m.type, subtype: m.request && m.request.subtype });",
    "  if (m.type === 'control_response' && awaiting) {",
    "    awaiting = false;",
    "    const allow = !!(m.response && m.response.response && m.response.response.allowed);",
    "    log({ event: 'answered', allow });",
    "    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: allow ? ' 应答后继续' : ' 被拒绝后收尾' }] } });",
    "    send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, session_id: SID, cost: 0 });",
    "    return;",
    "  }",
    "  if (m.type === 'control_request') {",
    "    const st = m.request && m.request.subtype;",
    "    if (st === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { session_id: SID, currentModelId: 'stub-model' } } });",
    "    else send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });",
    "    return;",
    "  }",
    "  if (m.type === 'user') {",
    "    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' 先说一句' }] } });",
    "    awaiting = true;",
    "    send({ type: 'control_request', request_id: 'stub-ask-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'stub-tu-1' } });",
    "    setTimeout(() => { if (awaiting) { awaiting = false; log({ event: 'answer-timeout' }); send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, session_id: SID, cost: 0 }); } }, 12000);",
    "  }",
    "});",
    "rl.on('close', () => process.exit(0));",
  ].join('\n')
);

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

/** 真起服务端。`keepData` = 重启后复用同一个数据目录（验持久化用） */
async function startServer(port) {
  const child = spawn('npx tsx server/index.ts', {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      OPC_DATA_DIR: DATA,
      NODE_OPTIONS: '',
      OPC_CODEBUDDY_CLI: STUB,
      STUB_LOG: STUB_LOG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/sessions`)).ok) return { child, base };
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { child, base, failed: true };
}

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

function stubLog() {
  try {
    return fs
      .readFileSync(STUB_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 从桩日志里取最后一次启动的 --permission-mode 值 */
function lastPermissionModeArg() {
  const starts = stubLog().filter(e => e.event === 'start');
  const last = starts[starts.length - 1];
  const argv = last?.argv ?? [];
  const i = argv.indexOf('--permission-mode');
  return i >= 0 ? argv[i + 1] : null;
}

/**
 * 发一条消息并把 SSE 帧收下来。
 * 弹了权限窗就按 `answer` 应答（默认 deny —— 快速收尾，不留挂起的答复）。
 */
async function chatOnce(base, sessionId, answer = 'deny') {
  const resp = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 刻意**不带** permissionMode：验的就是「只靠会话里存的值」能不能生效。
    // 带着值测出来的绿，只能证明请求体那条路通，证明不了持久化那条路。
    body: JSON.stringify({ sessionId, message: '列一下目录', agentId: 'workbuddy' }),
  });
  const types = [];
  let asked = null;
  if (!resp.ok) return { types: [`HTTP ${resp.status}`], asked: null };
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const got = await Promise.race([
      reader.read(),
      new Promise(r => setTimeout(() => r('TO'), 15000)),
    ]);
    if (got === 'TO') {
      types.push('…无帧超时…');
      break;
    }
    if (got.done) break;
    buf += dec.decode(got.value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const f of frames) {
      const line = f.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      types.push(ev.type === 'run_end' ? `run_end:${ev.status}` : ev.type);
      if (ev.type === 'permission_request') {
        asked = { requestId: ev.requestId, toolName: ev.toolName };
        await fetch(`${base}/api/permission-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: ev.requestId, behavior: answer }),
        });
      }
    }
  }
  return { types, asked };
}

function resolveChrome() {
  const system = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(system)) return system;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs
    .existsSync(root)
    ? fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

async function main() {
  console.log('\nA123 权限模式落到会话');

  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('\n  ⚠️ 没有 dist/index.html —— 先跑 npm run build（[4] 需要托管静态产物）\n');
    process.exit(1);
  }

  // ── [1] 纯函数层：列迁移与会话读写 ──────────────────────────────
  {
    const r = spawnSync('npx', ['tsx', 'scripts/verify-session-persist.ts'], {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    ok(r.status === 0, '[1] 会话持久化（含 permission_mode 迁移）全绿', out.trim().split('\n').filter(Boolean).pop()?.slice(0, 60));
  }

  let port = await freePort();
  let { child, base, failed } = await startServer(port);
  if (failed) {
    ok(false, '服务端启动就绪', '超时');
    killTree(child);
    process.exit(1);
    return;
  }
  ok(true, '服务端启动并就绪（WorkBuddy 通道指向桩）', `:${port}`);

  const cleanup = () => killTree(child);
  process.on('exit', cleanup);

  // ── [2] 接口层：写入、校验、重启后仍在 ──────────────────────────
  let bypassSid = '';
  let plainSid = '';
  {
    const created = await json(
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'workbuddy', title: 'A123 全放行', permissionMode: 'bypassPermissions' }),
      })
    );
    bypassSid = created.session?.id ?? created.id ?? '';
    ok(Boolean(bypassSid), '[2] 新建时就能带权限档', bypassSid.slice(0, 8));

    const d1 = await json(await fetch(`${base}/api/sessions/${bypassSid}`));
    ok(
      (d1.session ?? d1).permission_mode === 'bypassPermissions',
      '[2] 建会话就把档位落库（不是只活在内存里）',
      String((d1.session ?? d1).permission_mode)
    );

    const plain = await json(
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'workbuddy', title: 'A123 默认' }),
      })
    );
    plainSid = plain.session?.id ?? plain.id ?? '';
    const d2 = await json(await fetch(`${base}/api/sessions/${plainSid}`));
    ok(
      (d2.session ?? d2).permission_mode == null,
      '[2] 没选过的会话列为 NULL（= 按 default 跑，与迁移前语义一致）',
      JSON.stringify((d2.session ?? d2).permission_mode)
    );

    // 改档
    const p1 = await fetch(`${base}/api/sessions/${plainSid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'plan' }),
    });
    const d3 = await json(await fetch(`${base}/api/sessions/${plainSid}`));
    ok(p1.ok && (d3.session ?? d3).permission_mode === 'plan', '[2] PATCH 改档生效', String((d3.session ?? d3).permission_mode));

    // 非法值：400，且**原值不许被动过**
    const p2 = await fetch(`${base}/api/sessions/${plainSid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'yolo-all-the-way' }),
    });
    const d4 = await json(await fetch(`${base}/api/sessions/${plainSid}`));
    ok(p2.status === 400, '[2] 非法档位回 400（不静默纠正成 default）', `HTTP ${p2.status}`);
    ok(
      (d4.session ?? d4).permission_mode === 'plan',
      '[2] 非法值没有写坏原数据',
      String((d4.session ?? d4).permission_mode)
    );

    // 清空 = 回到「没选过」
    await fetch(`${base}/api/sessions/${plainSid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: null }),
    });
    const d5 = await json(await fetch(`${base}/api/sessions/${plainSid}`));
    ok(
      (d5.session ?? d5).permission_mode == null,
      '[2] 传 null 是清空，不是「不动」（与 reasoningEffort 同一口径）',
      JSON.stringify((d5.session ?? d5).permission_mode)
    );
    // 恢复成 default 之外的档位给后面的界面层用
    await fetch(`${base}/api/sessions/${plainSid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'acceptEdits' }),
    });
  }

  // ── [3] 适配器层：值走到子进程命令行，且真的决定弹不弹窗 ────────
  {
    // 先把 plainSid 设回 default 语义（清列）以对照
    await fetch(`${base}/api/sessions/${plainSid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'default' }),
    });
    const t = await chatOnce(base, plainSid, 'deny');
    ok(!!t.asked, '[3] 默认档会话：子进程问权限时，界面上真的会弹出来', t.types.join(' → ').slice(0, 90));
    ok(lastPermissionModeArg() === 'default', '[3] 默认档真的传到子进程 argv', `--permission-mode ${lastPermissionModeArg()}`);

    const t2 = await chatOnce(base, bypassSid, 'deny');
    ok(!t2.asked, '[3] 全放行会话：不再弹权限窗（请求体没带档位，只靠会话里存的值）', t2.types.join(' → ').slice(0, 90));
    ok(
      lastPermissionModeArg() === 'bypassPermissions',
      '[3] 会话里存的档位真的走到了子进程命令行',
      `--permission-mode ${lastPermissionModeArg()}`
    );
    ok(
      t2.types.includes('run_end:ok'),
      '[3] 全放行那一轮自己跑完了（不是挂住或报错）',
      t2.types.slice(-2).join(' → ')
    );
  }

  // ── [4] 界面层：芯片显示会话的值、改档落库、刷新后仍在 ──────────
  {
    // 重启一次服务端：持久化只有「换个进程还读得出来」才算数
    killTree(child);
    await new Promise(r => setTimeout(r, 1200));
    port = await freePort();
    const again = await startServer(port);
    child = again.child;
    base = again.base;
    ok(!again.failed, '[4] 服务端重启完成（同一个数据目录）', `:${port}`);

    const d = await json(await fetch(`${base}/api/sessions/${plainSid}`));
    ok(
      (d.session ?? d).permission_mode === 'default',
      '[2/4] 重启后档位仍在（这一条是持久化的硬证据）',
      String((d.session ?? d).permission_mode)
    );

    const exe = resolveChrome();
    if (!exe) {
      ok(false, '[4] 找不到 Chrome/Chromium，界面层未跑');
    } else {
      const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu-sandbox'] });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(`${base}/chat/${plainSid}`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-permission-mode-select]').first().waitFor({ timeout: 25000 });

        /**
         * 芯片当前值。
         *
         * 不能读 `[data-permission-mode-select]` 的 innerText —— TDesign 的 Select
         * 把当前值放在一个只读 `<input>` 的 **value** 里，壳子的 innerText 是空的
         * （第一版就是拿 innerText 判的，于是「芯片显示什么」这条永远红，
         * 看起来像产品坏了，其实是读法不对）。
         */
        const chipText = async () =>
          page.evaluate(() => {
            const shell = document.querySelector('[data-permission-mode-select]');
            if (!shell) return '(找不到芯片)';
            const input = shell.querySelector('input');
            const raw = (input && input.value) || shell.innerText || '';
            return raw.replace(/\s+/g, ' ').trim();
          });
        const shown = await chipText();
        ok(shown.includes('默认'), '[4] 芯片显示的是**这条会话**存的档位', shown);

        // 换到「全放行」：点壳子开下拉（与 verify:a115/a116 同一姿势），
        // 选项挂在 body 下的 `.permission-select-popup` 里 —— 用全局
        // `.t-select-option` 会同时匹配到模型下拉，点下去是别的东西。
        await page.locator('[data-permission-mode-select]').first().click();
        await page.waitForTimeout(500);
        const opts = page.locator('.permission-select-popup .t-select-option');
        const optCount = await opts.count();
        let idx = -1;
        for (let i = 0; i < optCount; i++) {
          const t = (await opts.nth(i).innerText()).replace(/\s+/g, ' ').trim();
          if (t.includes('全放行')) idx = i;
        }
        ok(optCount === 4, '[4] 下拉里四档都在（弹窗确实打开了）', `实测 ${optCount} 项`);
        ok(idx >= 0, '[4] 下拉里找得到「全放行」那一项', `第 ${idx + 1} 项`);
        if (idx >= 0) {
          /**
           * 点之前先量一次「这颗选项到底能不能被点到」。
           *
           * 第一版在这里点了 30 秒超时：元素解析得到、innerText 也读得到，
           * 但 Playwright 的可操作性判定过不去 —— 命中测试打到的不是选项本身，
           * 而是 `div.t-popup__content`。要么页面上有**第二个**同名弹窗（我选错了
           * 实例），要么真用户也点不动。这两种结论完全不同，所以先把弹窗数量与
           * 各自矩形打出来，再用**真实鼠标坐标**点一次看值变不变。
           */
          const diag = await page.evaluate(i => {
            const popups = [...document.querySelectorAll('.permission-select-popup')].map(p => {
              const r = p.getBoundingClientRect();
              return {
                box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                options: p.querySelectorAll('.t-select-option').length,
              };
            });
            const el = document.querySelectorAll('.permission-select-popup .t-select-option')[i];
            if (!el) return { popups, missing: true };
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return {
              popups,
              box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              hitTag: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className || '').slice(0, 44)}` : null,
              hitIsSelfOrChild: hit ? el.contains(hit) || hit === el : false,
              samePopup: hit ? !!(hit.closest && hit.closest('.permission-select-popup') === el.closest('.permission-select-popup')) : false,
              /** 盖住的那一层到底是什么：类名链 + 它自己的矩形与 pointer-events */
              hitChain: hit
                ? [hit, hit.parentElement, hit.parentElement?.parentElement]
                    .filter(Boolean)
                    .map(n => `${n.tagName.toLowerCase()}.${String(n.className || '').slice(0, 52)}`)
                    .join('  ←  ')
                : null,
              hitBox: hit
                ? (r2 => ({ x: Math.round(r2.x), y: Math.round(r2.y), w: Math.round(r2.width), h: Math.round(r2.height) }))(
                    hit.getBoundingClientRect()
                  )
                : null,
              hitPointerEvents: hit ? getComputedStyle(hit).pointerEvents : null,
            };
          }, idx);
          console.log(`      弹窗与命中：${JSON.stringify(diag)}`);

          // 真鼠标点一次（这才是用户的手感）。值没变就说明点不动，再降级
          const box = await opts.nth(idx).boundingBox();
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(500);
          const afterRealClick = await chipText();
          ok(
            afterRealClick.includes('全放行'),
            '[4] 真实鼠标点击能选中那一档（不是只有程序派发才生效）',
            afterRealClick
          );
          if (!afterRealClick.includes('全放行')) {
            console.log('      ↓ 真鼠标点不动，改用事件派发继续验后半段（结论会如实标注）');
            await opts.nth(idx).evaluate(el => el.click());
            await page.waitForTimeout(600);
          }
        }

        const after = await chipText();
        ok(after.includes('全放行'), '[4] 点芯片后界面立刻是新的档位', after);
        const d2 = await json(await fetch(`${base}/api/sessions/${plainSid}`));
        ok(
          (d2.session ?? d2).permission_mode === 'bypassPermissions',
          '[4] 点芯片真的落库了（不是只改了本地 state）',
          String((d2.session ?? d2).permission_mode)
        );

        // 换到另一条会话再换回来：全局 state 的老 bug 就是这里露馅
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-permission-mode-select]').first().waitFor({ timeout: 25000 });
        const back = await chipText();
        ok(back.includes('全放行'), '[4] 刷新后芯片仍是会话存的档位（回显与库里一致）', back);

        // 建一条全放行会话，确认新建页也吃这个值
        const nb = await json(
          await fetch(`${base}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'workbuddy', title: 'A123 新建页', permissionMode: 'plan' }),
          })
        );
        await page.goto(`${base}/chat/${nb.session?.id ?? nb.id}`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-permission-mode-select]').first().waitFor({ timeout: 25000 });
        const planChip = await chipText();
        ok(planChip.includes('只读'), '[4] 只读档会话的芯片也按会话值回显', planChip);
      } catch (e) {
        ok(false, '[4] 界面层跑通', String(e).slice(0, 200));
      } finally {
        await browser.close();
      }
    }
  }

  // ── [5] 源码契约：五个环节各钉一条，断链就报红 ──────────────────
  {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

    const db = read('server/db.ts');
    ok(/permission_mode TEXT/.test(db), '[5] 建表语句里有 permission_mode 列');
    ok(/ensureColumn\('sessions', 'permission_mode'/.test(db), '[5] 老库有幂等迁移');
    ok(/updates\.permission_mode !== undefined/.test(db), '[5] updateSession 认这一列');

    const api = read('server/index.ts');
    ok(/permissionMode \|\| session\.permission_mode \|\| 'default'/.test(api), '[5] 一对一：请求体 > 会话值 > default');
    const fallbackHits = (api.match(/permissionMode \|\| session\.permission_mode/g) ?? []).length;
    ok(fallbackHits === 3, '[5] 群聊与工作流同口径（三处回落，漏一条就是半修）', `命中 ${fallbackHits}`);
    ok(/function permissionModeOf/.test(api), '[5] 合法性有单一校验入口（非法值 400）');

    const sessions = read('src/hooks/useSessions.ts');
    ok(/permission_mode \?\? undefined/.test(sessions), '[5] 前端从接口行里映射这一档（漏映射=刷新即丢）');
    ok(/permissionMode: value/.test(sessions), '[5] 改档走 PATCH');

    const chat = read('src/hooks/useChat.ts');
    ok(/currentSession\?\.permissionMode \|\| 'default'/.test(chat), '[5] 发消息读的是会话值');

    const app = read('src/App.tsx');
    ok(
      !/useState<PermissionMode>\('default'\)/.test(app),
      '[5] App 里不再有那个「全局权限档」useState（这一条守的就是本轮的根因）'
    );
    ok(/currentSession\?\.permissionMode \?\? 'default'/.test(app), '[5] 芯片的值来自当前会话');
  }

  killTree(child);
  console.log(`\n${failures.length ? '❌' : '✅'} A123 权限模式：${pass}/${pass + fail} 通过`);
  for (const f of failures) console.log(`   · ${f}`);
  console.log('');
  process.exit(failures.length ? 1 : 0);
}

main().catch(err => {
  console.error('A123 脚本自身异常：', err);
  process.exit(1);
});
