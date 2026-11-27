/**
 * A150 / 2026-11-26：下架 Agent 的验收闸门。
 *
 * 为什么要有这一条：下架是**一次删除式操作**，最容易出现的两种半截下架是
 *   ① 只改了界面 —— 名册里看不见了，`GET /api/agents/<id>` 还照样 200，
 *      深链/旧代码一进来又冒出来；
 *   ② 顺手把定义删了 —— 历史会话里的 `agent_id` 解析不出名字。
 * 所以这里两侧都钉：**接口层必须真的 404**，**定义层必须真的还在**。
 *
 * 2026-11-26 扩展：下架名单从 Trae 一条扩到
 * `trae / gemini / doubao / kimicode`（Kimi 开放平台）；Kimi Code CLI 是
 * 用户明确要求保留的另一条链路，不在此列。除了名册与详情，还要钉住
 * 「设置 → 登录」不再给下架条目留凭据输入框，以及「获取 Agent」页不再出现它们。
 *
 * 第三块是真正的风险点：真实用户库里已经有这些 `agent_id` 的会话。
 * 注册表不实例化它们之后，前端 `getAgent(id)` 返回 undefined —— 那条会话
 * 还能不能打开、会不会白屏，只能真起浏览器看，静态读代码看不出结论。
 *
 * 运行：npx tsx scripts/verify-a150-retire.mjs（需先 npm run build）
 */
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
/** 每次用独立临时目录：本机删除会进回收站，固定目录会被上一轮的锁咬住。 */
const TMP = path.join(ROOT, '.tmp', `a150-retire-${Date.now()}`);
const DATA = path.join(TMP, 'data');
import { resolveChromePath } from './lib/chrome.mjs';
const CHROME = resolveChromePath();

/** 手写契约清单：不从被测代码派生，防止「它下架了哪些就断言哪些」的同源假绿。 */
const EXPECTED_RETIRED = [
  { id: 'trae', label: 'Trae' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'doubao', label: '豆包' },
  { id: 'kimicode', label: 'Kimi' },
];
const RETIRED_IDS = EXPECTED_RETIRED.map(a => a.id);

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

// ============= [1] 定义层：下架 ≠ 删定义 =============
console.log('\n[1] 定义层（下架机制本身）');
const { AGENT_DEFS, RETIRED_AGENT_IDS } = await import('../server/agents/definitions.ts');

ok(
  EXPECTED_RETIRED.every(a => RETIRED_AGENT_IDS.includes(a.id)),
  'RETIRED_AGENT_IDS 覆盖手写契约清单',
  RETIRED_AGENT_IDS.join(',')
);
// 肯定式配套：上面只钉「该有的在」，这条钉「没有多塞」—— 恢复一条必须有人改契约。
ok(
  RETIRED_AGENT_IDS.length === EXPECTED_RETIRED.length,
  '下架名单与契约清单条数一致（新增/恢复都要有人知道）',
  `${RETIRED_AGENT_IDS.length} = ${EXPECTED_RETIRED.length}`
);
for (const a of EXPECTED_RETIRED) {
  ok(
    AGENT_DEFS.some(d => d.descriptor.id === a.id),
    `${a.id} 定义仍在 AGENT_DEFS 里（恢复时不用重写事件映射）`
  );
}

process.env.OPC_DATA_DIR = DATA;
const { registry: reg } = await import('../server/agents/registry.ts');

for (const a of EXPECTED_RETIRED) {
  ok(reg.list().every(x => x.id !== a.id), `注册表 list() 里没有 ${a.id}`);
  ok(reg.get(a.id) === undefined, `注册表 get('${a.id}') 返回 undefined（详情 404 的来源）`);
}
ok(
  reg.list().length === AGENT_DEFS.length - RETIRED_AGENT_IDS.length,
  '名册条数 = 定义总数 − 下架数',
  `${reg.list().length} = ${AGENT_DEFS.length} − ${RETIRED_AGENT_IDS.length}`
);
ok(reg.list().length > 0, '名册非空（否则上面几条都是假绿）', String(reg.list().length));
// 反向保护：Kimi Code CLI 与下架的 Kimi 开放平台是两条账号体系，用户要求保留。
ok(reg.get('kimicli') !== undefined, "Kimi Code CLI 仍在注册表（用户要求保留）");
reg.disposeAll();

// ============= [2] 接口层 =============
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`\n[2] 接口层（起服务端 :${port}）`);
const child = spawn('npx tsx server/index.ts', {
  cwd: ROOT,
  shell: true,
  windowsHide: true,
  env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const { ready, log } = await waitReady(base, child);
ok(ready, '服务端起来了');
if (!ready) {
  console.log(log.slice(-1500));
  killTree(child);
  console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
  process.exit(1);
}

let browser;
try {
  const roster = await json(await fetch(`${base}/api/agents`));
  const ids = (roster.agents ?? []).map(a => a.id);
  ok(ids.length > 0, '[2] 名册非空（否则下一条是假绿）', String(ids.length));
  ok(RETIRED_IDS.every(id => !ids.includes(id)), '[2] 名册里没有下架条目', ids.join(','));
  ok(ids.includes('kimicli'), '[2] Kimi Code CLI 仍在名册（用户要求保留）');

  for (const id of RETIRED_IDS) {
    const detail = await fetch(`${base}/api/agents/${id}?probe=1`);
    ok(detail.status === 404, `[2] GET /api/agents/${id} 返回 404`, String(detail.status));
  }
  // 肯定式配套：同一个接口对一个正常 Agent 必须 200，否则「404」可能只是路由坏了
  const normal = await fetch(`${base}/api/agents/zcode`);
  ok(normal.status === 200, '[2] 同一接口对正常 Agent 仍 200', String(normal.status));

  // 设置页「登录」分区也不能再给它们留输入框 —— 列表层要跟注册表同口径。
  const creds = await json(await fetch(`${base}/api/agent-credentials`));
  const credIds = (creds.credentials ?? []).map(c => c.agentId);
  ok(credIds.length > 0, '[2] 凭据列表非空（否则下一条是假绿）', credIds.join(','));
  ok(
    RETIRED_IDS.every(id => !credIds.includes(id)),
    '[2] 凭据列表里没有下架条目',
    credIds.join(',')
  );

  // ============= [3] 历史数据：旧会话不许丢 =============
  console.log('\n[3] 历史数据（真实库里已有下架 Agent 的会话）');
  const sessions = [];
  for (const a of EXPECTED_RETIRED) {
    const created = await json(
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: a.id, title: `历史 ${a.label} 会话（下架前）` }),
      })
    );
    const sessionId = created.session?.id;
    ok(!!sessionId, `[3] ${a.label}：下架后仍能读回旧会话（创建不受影响）`, String(sessionId));
    if (sessionId) sessions.push({ ...a, sid: sessionId });
  }

  const list = await json(await fetch(`${base}/api/sessions`));
  for (const s of sessions) {
    const found = (list.sessions ?? []).find(x => x.id === s.sid);
    ok(!!found, `[3] ${s.label}：会话列表里还在（数据没被下架操作动过）`);
    // `db.getAllSessions()` 返回的是**原始行**，字段名是 snake_case 的 `agent_id`
    // （前端在 useSessions 里才映射成 agentId）。这里对的是接口原文。
    ok(found?.agent_id === s.id, `[3] ${s.label}：agent_id 没被静默改成别的`, String(found?.agent_id));
  }

  // ============= [4] UI：打开旧会话不许白屏，获取页不许再出现 =============
  console.log('\n[4] UI（真浏览器）');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  const first = sessions[0];
  ok(!!first, '[4] 有旧会话夹具可打开（否则下面都是假绿）');
  if (first) {
    await page.goto(`${base}/chat/${first.sid}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const text = (await page.locator('body').innerText().catch(() => '')).trim();
    ok(text.length > 20, '[4] 页面有可见内容（不是白屏）', `${text.length} 字符`);
    // 肯定式：这条会话的标题必须真的渲染出来，否则「有内容」可能只是空壳侧栏
    ok(text.includes(`历史 ${first.label} 会话`), '[4] 旧会话标题渲染出来了');
    ok(pageErrors.length === 0, '[4] 没有未捕获异常', pageErrors.slice(0, 2).join(' | '));
  }

  // 下架后「获取 Agent」里也不该能选到它们 —— 但不能断言「整页没有这些字样」：
  // 上面刚建的会话标题里就带这些名字，侧栏会正常显示它们。钉清单行本身。
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const home = (await page.locator('body').innerText().catch(() => '')).trim();
  ok(home.length > 20, '[4] 首页正常渲染（下架没把首页带崩）', `${home.length} 字符`);

  // 窄屏/首页默认可能把通讯录收起来，先把侧栏展开再点「+」。
  const goContacts = page.getByRole('button', { name: '打开通讯录' });
  if (await goContacts.count()) await goContacts.click();
  await page.locator('button[title="添加"]').first().click();
  await page.waitForSelector('[data-contacts-get-agents]', { timeout: 10000 });
  await page.locator('[data-contacts-get-agents]').click();
  await page.waitForSelector('[data-get-agents]', { timeout: 10000 });
  const rows = await page
    .locator('[data-get-agents-row]')
    .evaluateAll(nodes => nodes.map(n => n.getAttribute('data-get-agents-row')));
  ok(
    RETIRED_IDS.every(id => !rows.includes(id)),
    '[4] 获取 Agent 页没有下架条目',
    rows.join(',') || '(空)'
  );
  const empty = await page.locator('[data-get-agents-empty]').count();
  ok(rows.length > 0 || empty > 0, '[4] 获取 Agent 页不是空壳（肯定式）', `${rows.length} 行 / empty=${empty}`);
  ok(pageErrors.length === 0, '[4] 首页与获取页都没有未捕获异常', pageErrors.slice(0, 2).join(' | '));
} finally {
  await browser?.close().catch(() => {});
  killTree(child);
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
