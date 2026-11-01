/**
 * A162：模型名不许跨 Agent 残留。
 *
 * ## 要钉的是什么
 *
 * 模型名是**各 Agent 私有的命名空间**：opencode 的 `zai/glm-4.7` 在 gemini
 * 那里根本不存在。但 `selectedModel` 是 App 级的单个 state，于是从一个会话
 * 切到「另一个 Agent 的会话」时，那个名字会跟着过去 —— 界面上显示已选中，
 * 发出去却被后端按「不属于这个 Agent」换成默认模型（`resolveModelForAgent`）。
 * 用户看到的是一个**假控件**：选了 A，实际跑的是 B。
 *
 * ## 为什么必须用夹具
 *
 * 真机上哪个 Agent 有哪些模型取决于装了什么、登了什么，不稳定。这里用
 * `page.route` 把 `/api/agents/:id/models` 换掉：
 *   - `workbuddy` → 一条 `alpha/one`
 *   - `gemini`    → **空清单**（`unknown`）
 *
 * ## 判据（为什么窗口期才是关键）
 *
 * 旧实现在切 Agent 时**不清空**上一个 Agent 的清单，于是 `pickableModels`
 * 仍是 alpha 那份，`alpha/one` 在里面「合法」，校验放它过去 —— 界面就停在
 * 「Alpha One」。等新清单回来才纠正。所以要在**切换后立刻**读控件，
 * 而不是等一会儿再读（等一会儿两版都是对的，那种断言证明不了任何事）。
 *
 * 运行：node scripts/verify-a162-model-carry.mjs（需先 npm run build）
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a162-carry-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

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

fs.mkdirSync(DATA, { recursive: true });

// ── [1] 源码层：三处「新建会话」都不许直接抄全局 selectedModel ──────
{
  const app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'src/hooks/useChat.ts'), 'utf8');
  // 肯定式：修复后的写法必须在位，否则下面「没有 model: selectedModel」
  // 在整段代码被删掉时同样是绿的。
  ok(
    (app.match(/model: modelForNewSession\(/g) || []).length === 2,
    '[1] App 里两处新建会话都走 modelForNewSession',
    String((app.match(/model: modelForNewSession\(/g) || []).length)
  );
  ok(
    app.includes('const modelForNewSession = useCallback'),
    '[1] modelForNewSession 真的定义过（不是只留了调用点）'
  );
  ok(chat.includes('carryModel'), '[1] useChat 的新建会话分支走 carryModel');
  // 否定式：newSession 对象里不许再出现裸的 `model: selectedModel`
  const bareInNewSession = /const newSession: Session = \{[\s\S]{0,400}?model: selectedModel,/.test(app);
  ok(!bareInNewSession, '[1] App 的 newSession 里没有裸的 model: selectedModel');
  const bareInChat = /const newSession: Session = \{[\s\S]{0,400}?model: selectedModel,/.test(chat);
  ok(!bareInChat, '[1] useChat 的 newSession 里没有裸的 model: selectedModel');
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`\n[2] 起服务端 :${port}`);
const child = spawn('npx tsx server/index.ts', {
  cwd: ROOT,
  shell: true,
  windowsHide: true,
  env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const { ready, log } = await waitReady(base, child);
ok(ready, '[2] 服务端起来了');
if (!ready) {
  console.log(log.slice(-1500));
  killTree(child);
  console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
  process.exit(1);
}

let browser;
try {
  // ── [2] 造两个会话：alpha 有模型、beta 没有清单 ────────────────
  const s1 = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A162 alpha', agentId: 'workbuddy', model: 'alpha/one' }),
    })
  );
  const s2 = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A162 beta', agentId: 'gemini' }),
    })
  );
  const sidA = s1.session?.id;
  const sidB = s2.session?.id;
  ok(!!sidA && !!sidB, '[2] 造出两条会话', `${sidA} / ${sidB}`);
  ok(s1.session?.model === 'alpha/one', '[2] alpha 会话的模型已落库', String(s1.session?.model));

  /* 把 beta 会话的模型清成空。
     这是「新建会话还没选过模型」的真实状态（A162 修完之后新建会话就落这个值）。
     不清的话 579 那条 effect 会用会话自己的 model 覆盖选中值，窗口期根本不存在，
     断言就测不到东西了。 */
  await fetch(`${base}/api/sessions/${sidB}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '' }),
  });
  const s2after = await json(await fetch(`${base}/api/sessions/${sidB}`));
  ok(
    !s2after.session?.model,
    '[2] beta 会话的模型已清空（模拟「新建会话还没选过模型」）',
    String(s2after.session?.model)
  );

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // 夹具：两个 Agent 各有自己的清单，且 **beta 的清单故意晚到 2.5 秒**。
  //
  // 那段延迟就是「窗口期」本身：清单还没换回来的时候，旧实现手上仍是 alpha
  // 那份列表，`alpha/one` 在里面「合法」，校验放行 ⇒ 控件继续显示 Alpha One。
  // 不延迟的话两版都会在几十毫秒内被纠正，断言证明不了任何事。
  await ctx.route('**/api/agents/*/models', async route => {
    const url = route.request().url();
    const agentId = url.split('/api/agents/')[1]?.split('/')[0] ?? '';
    const body =
      agentId === 'workbuddy'
        ? {
            models: [{ modelId: 'alpha/one', name: 'Alpha One', reasoning: false }],
            defaultModel: 'alpha/one',
            source: 'catalog',
            selectable: true,
          }
        : {
            models: [{ modelId: 'beta/one', name: 'Beta One', reasoning: false }],
            defaultModel: 'beta/one',
            source: 'catalog',
            selectable: true,
          };
    if (agentId !== 'workbuddy') await new Promise(r => setTimeout(r, 2500));
    await route
      .fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      .catch(() => {});
  });

  const page = await ctx.newPage();

  // ── [3] 基线：alpha 会话里控件显示 Alpha One ───────────────────
  await page.goto(`${base}/chat/${sidA}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-model-trigger]', { timeout: 20000 });
  await page
    .waitForFunction(
      () => (document.querySelector('[data-model-trigger]')?.textContent || '').includes('Alpha One'),
      null,
      { timeout: 15000 }
    )
    .catch(() => {});
  const before = (await page.locator('[data-model-trigger]').innerText()).trim();
  ok(before.includes('Alpha One'), '[3] 基线：alpha 会话的控件显示 Alpha One', before);

  // ── [4] 切到 beta 会话：窗口期内不许还挂着 alpha 的模型名 ───────
  await page.locator(`[data-conversation-item="${sidB}"]`).click();
  // 切换后立刻读 —— 这正是旧实现「清单还没换、校验放行」的那段窗口。
  // beta 的清单要 2.5s 才回来，所以这 600ms 一定落在窗口里。
  await page.waitForTimeout(600);
  const triggerCount = await page.locator('[data-model-trigger]').count();
  const after = triggerCount ? (await page.locator('[data-model-trigger]').innerText()).trim() : '';
  ok(
    !after.includes('Alpha One'),
    '[4] 窗口期内不残留上一个 Agent 的模型名',
    triggerCount ? after : '（控件已隐藏：清单还没回来）'
  );
  ok(
    triggerCount === 0 || after.includes('选择模型'),
    '[4] 此刻要么没有清单、要么显示「选择模型」，不是某个陌生名字',
    after
  );

  // ── [5] 肯定式配套：清单回来后必须落到控件上 ───────────────────
  //
  // 没有这一条，上面那条在「模型控件整块坏掉」时同样是绿的。
  await page
    .waitForFunction(
      () =>
        (document.querySelector('[data-model-trigger]')?.textContent || '').includes('Beta One'),
      null,
      { timeout: 15000 }
    )
    .catch(() => {});
  const later = await page.locator('[data-model-trigger]').innerText().catch(() => '');
  ok(
    String(later).trim().includes('Beta One'),
    '[5] 清单回来后控件显示 Beta One（整条链是通的）',
    String(later).trim()
  );

  // ── [6] 切回 alpha：模型要能自己回来（证明清空不是「永久丢掉」）──
  await page.locator(`[data-conversation-item="${sidA}"]`).click();
  await page
    .waitForFunction(
      () => (document.querySelector('[data-model-trigger]')?.textContent || '').includes('Alpha One'),
      null,
      { timeout: 15000 }
    )
    .catch(() => {});
  const back = await page.locator('[data-model-trigger]').innerText().catch(() => '');
  ok(
    String(back).trim().includes('Alpha One'),
    '[6] 切回 alpha 会话，模型名自己回来（会话级记忆没被清空逻辑破坏）',
    String(back).trim()
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(child);
  await new Promise(r => setTimeout(r, 300));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
