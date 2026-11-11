/**
 * #16 前端刷新链路 · 真浏览器闸门（playwright-core + 真服务端 + route 夹具）。
 *
 * ## 为什么不能只数请求
 *
 * 「保存后 /api/models 被多打了一次」这条断言太容易变绿：切页、重挂载、
 * 定时器、甚至一次无关的探测都可能顺带发一轮请求。所以这里让夹具按
 * **两段快照**返回，钉的是最外层的可观测量：
 *   - 输入框 `[data-model-trigger]` 上的模型名从 SNAP-1 变成 SNAP-2；
 *   - 账号卡 `[data-account-provenance]` 的来源从 ACCT-SNAP-1 变成 ACCT-SNAP-2。
 * 请求计数只作旁证，不当判据。
 *
 * ## 对照组（反向探针）
 *
 * 三个页面用**同一套夹具、同一时刻切成 SNAP-2**：
 *   - A 点保存（成功）→ 必须刷新；
 *   - B 什么都不做 → 用来排除「定时器 / 轮询 / 夹具切换自己触发刷新」；
 *   - C 也点保存，但 POST 被夹具判 400 → 用来排除「只要发一次 POST 或编辑器
 *     重渲染就会刷新」，即证明刷新确实挂在成功分支的事件上。
 * 若 B 或 C 也跟着变，A 的绿就是假的 —— 判红。若 A 在「夹具已切快照、但还没
 * 点保存」时就变了，同样判红。肯定式与否定式成对。
 *
 * ## 为什么用弹窗版资料页
 *
 * 通讯录的整页资料页会把聊天列整个换掉，模型触发器根本不在 DOM 里；
 * 聊天页「更多操作 → Agent 详情」的弹窗是 portal 覆盖层，ChatInput 仍在，
 * 于是凭据编辑器 / 账号卡 / 模型触发器三者可以**同一页**观察，无需跳转。
 *
 * 全程临时 OPC_DATA_DIR + 随机端口，不碰真实 data/；保存用假 Key。
 * 运行：node scripts/verify-credential-refresh-ui.mjs（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `cred-refresh-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const SHOTS = path.join(ROOT, '.tmp', 'credential-refresh');
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
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
    await sleep(400);
  }
  return { ready: false, log };
}

/** 每个页面一份：打过几次、当前夹具给第几号快照。 */
const state = {
  A: { models: 0, agentModels: 0, account: 0, phase: 1 },
  B: { models: 0, agentModels: 0, account: 0, phase: 1 },
  C: { models: 0, agentModels: 0, account: 0, phase: 1 },
};

const snapshot = n => [{ modelId: `fx-v${n}`, name: `SNAP-${n}` }];
const provenance = (source, n) => ({ source: `${source}-${n}`, probedAt: Date.now(), verified: false });
const json = body => JSON.stringify(body);

async function installFixtures(page, tag) {
  const s = state[tag];
  const fulfill = (route, body) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: json(body) }).catch(() => {});

  // 平台模型清单（useModels 自己订阅事件重拉）
  await page.route(u => u.pathname === '/api/models', async route => {
    s.models++;
    const n = s.phase;
    await fulfill(route, {
      models: snapshot(n),
      defaultModel: `fx-v${n}`,
      provenance: provenance('MODEL-SNAP', n),
    });
  });

  // 当前 Agent 的模型清单（App 的 modelsEpoch 订阅事件重拉）
  await page.route(u => u.pathname === '/api/agents/doubao/models', async route => {
    s.agentModels++;
    const n = s.phase;
    await fulfill(route, {
      models: snapshot(n),
      defaultModel: `fx-v${n}`,
      source: 'catalog',
      selectable: true,
      provenance: provenance('AGENT-SNAP', n),
    });
  });

  // 账号卡（useAgentAccount 的 refreshKey 订阅事件重拉）
  await page.route(u => u.pathname === '/api/agents/doubao/account', async route => {
    s.account++;
    const n = s.phase;
    await fulfill(route, {
      account: {
        plans: [],
        source: 'fixture',
        modelSelectable: true,
        modelNote: 'fixture',
        provenance: provenance('ACCT-SNAP', n),
      },
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`\n[1] 起服务端 :${port}`);
const child = spawn('npx tsx server/index.ts', {
  cwd: ROOT,
  shell: true,
  windowsHide: true,
  env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const { ready, log } = await waitReady(base, child);
ok(ready, '[1] 服务端起来了');
if (!ready) {
  console.log(log.slice(-1500));
  killTree(child);
  console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
  process.exit(1);
}

/** 造一条 doubao 会话：弹窗资料页的 agent 来自会话的 Agent。cwd 由服务端校验，
 *  与 a162 同一套形状，不编假路径。 */
const sessionRes = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '#16 刷新链路夹具', agentId: 'doubao' }),
});
const sessionBody = await sessionRes.json().catch(() => ({}));
const sid = sessionBody.session?.id;
ok(!!sid, '[1] 造出 doubao 会话夹具', String(sid));
if (!sid) {
  killTree(child);
  console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
  process.exit(1);
}

let browser;
try {
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  /** 打开聊天页 → 展开更多操作 → 开 Agent 详情弹窗。 */
  const openModal = async tag => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await installFixtures(page, tag);
    await page.goto(`${base}/chat/${sid}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-model-trigger]', { timeout: 30000 });
    await page.locator('[data-chat-more] summary').click();
    await page.getByRole('button', { name: 'Agent 详情' }).click();
    await page.waitForSelector('[data-agent-detail-overlay]', { timeout: 10000 });
    await page.waitForSelector('[data-agent-credential-inline]', { timeout: 20000 });
    await page.waitForSelector('[data-account-provenance]', { timeout: 20000 });
    return { ctx, page, errors };
  };

  const A = await openModal('A');
  const B = await openModal('B');
  // C：保存**失败**的反例。若刷新只是因为「发了一次 POST / 编辑器重渲染」，
  // C 也会跟着刷新 —— 那说明 A 的绿是假的。只有成功分支里的事件才该触发刷新。
  const C = await openModal('C');
  let cSavePosts = 0;
  await C.page.route(u => u.pathname === '/api/agent-credentials', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    cSavePosts++;
    await route
      .fulfill({ status: 400, contentType: 'application/json', body: json({ error: 'fixture: 拒绝保存' }) })
      .catch(() => {});
  });

  const triggerText = p => p.locator('[data-model-trigger]').innerText();
  const accountText = p => p.locator('[data-account-provenance]').innerText();

  /* ============= [2] 页面真的开了（整页 ErrorBoundary 会让后面全红） ============= */
  console.log('\n[2] 页面打开与初始快照');
  ok((await A.page.locator('[data-agent-credential-inline]').count()) === 1, '[2] A 有凭据编辑器');
  ok((await A.page.locator('[data-agent-account]').count()) === 1, '[2] A 有账号卡');
  ok((await B.page.locator('[data-agent-account]').count()) === 1, '[2] B 有账号卡');
  ok((await C.page.locator('[data-agent-account]').count()) === 1, '[2] C 有账号卡');
  ok(A.errors.length === 0 && B.errors.length === 0 && C.errors.length === 0,
    '[2] 三页都没有整页异常',
    [...A.errors, ...B.errors, ...C.errors].slice(0, 2).join(' | '));
  ok(state.A.models > 0 && state.A.agentModels > 0 && state.A.account > 0,
    '[2] A 初始三条数据都真拉过',
    `models=${state.A.models} agentModels=${state.A.agentModels} account=${state.A.account}`);
  ok(state.B.models > 0 && state.B.agentModels > 0 && state.B.account > 0,
    '[2] B 初始三条数据都真拉过');
  ok(state.C.models > 0 && state.C.agentModels > 0 && state.C.account > 0,
    '[2] C 初始三条数据都真拉过');

  const baseA = { ...state.A };
  const baseB = { ...state.B };
  const baseC = { ...state.C };
  const aTrigger0 = await triggerText(A.page);
  const aAccount0 = await accountText(A.page);
  const bTrigger0 = await triggerText(B.page);
  const bAccount0 = await accountText(B.page);
  ok(aTrigger0.includes('SNAP-1'), '[2] A 模型触发器是快照 1', aTrigger0.trim());
  ok(aAccount0.includes('ACCT-SNAP-1'), '[2] A 账号卡是快照 1', aAccount0.slice(0, 60));
  ok(!aTrigger0.includes('SNAP-2') && !aAccount0.includes('ACCT-SNAP-2'),
    '[2] 否定式：初始不该出现快照 2');
  ok(bTrigger0.includes('SNAP-1') && bAccount0.includes('ACCT-SNAP-1'), '[2] B 同样停在快照 1');
  ok((await triggerText(C.page)).includes('SNAP-1') &&
     (await accountText(C.page)).includes('ACCT-SNAP-1'), '[2] C 同样停在快照 1');

  /* ============= [3] 只换夹具、不操作：证明没有轮询 ============= */
  console.log('\n[3] 夹具切到快照 2，三页都不许自己变');
  state.A.phase = 2;
  state.B.phase = 2;
  state.C.phase = 2;
  await sleep(1800);
  ok(state.A.models === baseA.models && state.A.agentModels === baseA.agentModels &&
     state.A.account === baseA.account,
    '[3] A 没有偷偷重拉',
    `models ${baseA.models}→${state.A.models} account ${baseA.account}→${state.A.account}`);
  ok(state.B.models === baseB.models && state.B.agentModels === baseB.agentModels &&
     state.B.account === baseB.account,
    '[3] B 没有偷偷重拉');
  ok((await triggerText(A.page)).includes('SNAP-1'), '[3] A 模型触发器仍是快照 1');
  ok((await accountText(A.page)).includes('ACCT-SNAP-1'), '[3] A 账号卡仍是快照 1');
  ok((await triggerText(B.page)).includes('SNAP-1'), '[3] B 模型触发器仍是快照 1');
  ok((await accountText(B.page)).includes('ACCT-SNAP-1'), '[3] B 账号卡仍是快照 1');
  ok(state.C.models === baseC.models && state.C.agentModels === baseC.agentModels &&
     state.C.account === baseC.account, '[3] C 没有偷偷重拉');

  /* ============= [4] A 点保存；B 全程不动 ============= */
  console.log('\n[4] A 填 Key 并保存，B 不做任何操作');
  await A.page.locator('[data-credential-key="doubao"] input').fill('ark-fixture-key-1234567890');
  await A.page.getByRole('button', { name: '保存' }).click();
  const saved = await waitUntil(async () =>
    (await A.page.locator('[data-credential-editor="doubao"] .t-tag--success').count()) > 0,
    30000);
  ok(saved, '[4] 保存真的成功了（不是「保存没发生却碰巧刷了」）');

  const refreshed = await waitUntil(async () =>
    (await triggerText(A.page)).includes('SNAP-2') &&
    (await accountText(A.page)).includes('ACCT-SNAP-2'),
    30000);
  ok(refreshed, '[4] A 的模型清单与账号卡都换成了快照 2');

  // C：同样填 Key、同样点保存，但服务端返回 400 → 不走成功分支、不发事件
  await C.page.locator('[data-credential-key="doubao"] input').fill('ark-fixture-key-rejected');
  await C.page.getByRole('button', { name: '保存' }).click();
  const rejected = await waitUntil(() => cSavePosts === 1, 15000);
  ok(rejected, '[4] C 的保存请求确实发出并被拒（反例成立）', `posts=${cSavePosts}`);

  // 给对照组与 A 同样的等待窗口，再判 B / C 是否仍然静止
  await sleep(1800);

  /* ============= [5] 肯定式：A 真的重拉了，且数据落到了界面 ============= */
  console.log('\n[5] 肯定式：A 三条链路都刷新');
  ok(state.A.models > baseA.models, '[5] /api/models 重新拉过',
    `${baseA.models}→${state.A.models}`);
  ok(state.A.agentModels > baseA.agentModels, '[5] /api/agents/doubao/models 重新拉过',
    `${baseA.agentModels}→${state.A.agentModels}`);
  ok(state.A.account > baseA.account, '[5] /api/agents/doubao/account 重新拉过',
    `${baseA.account}→${state.A.account}`);
  const aTrigger1 = await triggerText(A.page);
  const aAccount1 = await accountText(A.page);
  ok(aTrigger1.includes('SNAP-2') && !aTrigger1.includes('SNAP-1'),
    '[5] 输入框模型名更新为快照 2', aTrigger1.trim());
  ok(aAccount1.includes('ACCT-SNAP-2') && !aAccount1.includes('ACCT-SNAP-1'),
    '[5] 账号卡来源更新为快照 2', aAccount1.slice(0, 60));
  const aStored = await A.page.evaluate(() => localStorage.getItem('defaultModel'));
  ok(aStored === 'fx-v2', '[5] 新清单确实被消费（默认模型已回落）', String(aStored));

  /* ============= [6] 否定式：B 一次都没刷 ============= */
  console.log('\n[6] 否定式：B 没操作、C 保存失败，两页都静止');
  ok(state.B.models === baseB.models && state.B.agentModels === baseB.agentModels &&
     state.B.account === baseB.account,
    '[6] B 三条请求数都没变',
    `models=${state.B.models} agentModels=${state.B.agentModels} account=${state.B.account}`);
  const bTrigger1 = await triggerText(B.page);
  const bAccount1 = await accountText(B.page);
  ok(bTrigger1.includes('SNAP-1') && !bTrigger1.includes('SNAP-2'),
    '[6] B 模型触发器仍是快照 1', bTrigger1.trim());
  ok(bAccount1.includes('ACCT-SNAP-1') && !bAccount1.includes('ACCT-SNAP-2'),
    '[6] B 账号卡仍是快照 1', bAccount1.slice(0, 60));
  const bStored = await B.page.evaluate(() => localStorage.getItem('defaultModel'));
  ok(bStored === 'fx-v1', '[6] B 的默认模型没有被换掉', String(bStored));

  ok(state.C.models === baseC.models && state.C.agentModels === baseC.agentModels &&
     state.C.account === baseC.account,
    '[6] C 保存失败后三条请求数都没变（刷新不是 POST / 重渲染带来的）',
    `models=${state.C.models} agentModels=${state.C.agentModels} account=${state.C.account}`);
  const cTrigger1 = await triggerText(C.page);
  const cAccount1 = await accountText(C.page);
  ok(cTrigger1.includes('SNAP-1') && !cTrigger1.includes('SNAP-2'),
    '[6] C 模型触发器仍是快照 1', cTrigger1.trim());
  ok(cAccount1.includes('ACCT-SNAP-1') && !cAccount1.includes('ACCT-SNAP-2'),
    '[6] C 账号卡仍是快照 1', cAccount1.slice(0, 60));
  ok((await C.page.locator('[data-credential-editor="doubao"] .t-tag--success').count()) === 0,
    '[6] C 没有「已配置」成功态（确认这一步真的是失败保存）');

  ok(A.errors.length === 0 && B.errors.length === 0 && C.errors.length === 0,
    '[6] 全程无控制台异常',
    [...A.errors, ...B.errors, ...C.errors].slice(0, 2).join(' | '));

  await A.page.locator('[data-agent-credential-inline]').screenshot({
    path: path.join(SHOTS, 'after-save.png'),
  }).catch(() => {});
  console.log(`\n  截图：${SHOTS}`);
  await A.ctx.close();
  await B.ctx.close();
  await C.ctx.close();
} finally {
  await browser?.close();
  killTree(child);
}

console.log(`\n=== #16 前端刷新链路：${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log(`失败项：\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
