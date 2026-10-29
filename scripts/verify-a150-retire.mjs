/**
 * A150：Trae 官方入口「暂时下架」的验收闸门。
 *
 * 为什么要有这一条：下架是**一次删除式操作**，最容易出现的两种半截下架是
 *   ① 只改了界面 —— 名册里看不见了，`GET /api/agents/trae` 还照样 200，
 *      深链/旧代码一进来又冒出来；
 *   ② 顺手把定义删了 —— 历史会话里的 `agent_id='trae'` 解析不出名字，
 *      而且恢复时要重写那 100 行按官方文档写、从未实测过的事件映射。
 * 所以这里两侧都钉：**接口层必须真的 404**，**定义层必须真的还在**。
 *
 * 第三块是这次下架真正的风险点：真实用户库里已经有 `agent_id='trae'` 的会话。
 * 注册表不实例化它之后，前端 `getAgent('trae')` 返回 undefined —— 那条会话
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

// ============= [1] 定义层：下架 ≠ 删定义 =============
console.log('\n[1] 定义层（下架机制本身）');
const { AGENT_DEFS, RETIRED_AGENT_IDS } = await import('../server/agents/definitions.ts');

ok(RETIRED_AGENT_IDS.includes('trae'), "RETIRED_AGENT_IDS 含 'trae'", RETIRED_AGENT_IDS.join(','));
ok(
  AGENT_DEFS.some(d => d.descriptor.id === 'trae'),
  'trae 定义仍在 AGENT_DEFS 里（恢复时不用重写事件映射）'
);
// 肯定式配套：如果 RETIRED_AGENT_IDS 变成了空数组，上面那条「含 trae」会红，
// 但下面这条会绿 —— 两条一起才锁住「下架名单里恰好只有它」这个现状。
ok(
  RETIRED_AGENT_IDS.length === 1,
  '下架名单只有 1 条（新增下架要有人知道）',
  String(RETIRED_AGENT_IDS.length)
);

process.env.OPC_DATA_DIR = DATA;
const { registry: reg } = await import('../server/agents/registry.ts');

ok(reg.list().every(a => a.id !== 'trae'), '注册表 list() 里没有 trae', reg.list().map(a => a.id).join(','));
ok(reg.get('trae') === undefined, "注册表 get('trae') 返回 undefined（详情 404 的来源）");
ok(
  reg.list().length === AGENT_DEFS.length - RETIRED_AGENT_IDS.length,
  '名册条数 = 定义总数 − 下架数',
  `${reg.list().length} = ${AGENT_DEFS.length} − ${RETIRED_AGENT_IDS.length}`
);
// 同族条目：trae 没有兄弟，但 family 字段仍要能解析（资料页的「同族」块不该炸）
ok(reg.list().length > 0, '名册非空（否则上面几条都是假绿）', String(reg.list().length));
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
  ok(!ids.includes('trae'), '[2] 名册里没有 trae', ids.join(','));

  const detail = await fetch(`${base}/api/agents/trae?probe=1`);
  ok(detail.status === 404, '[2] GET /api/agents/trae 返回 404', String(detail.status));
  // 肯定式配套：同一个接口对一个正常 Agent 必须 200，否则「404」可能只是路由坏了
  const normal = await fetch(`${base}/api/agents/zcode`);
  ok(normal.status === 200, '[2] 同一接口对正常 Agent 仍 200', String(normal.status));

  // ============= [3] 历史数据：旧会话不许丢 =============
  console.log('\n[3] 历史数据（真实库里已有 agent_id=trae 的会话）');
  const created = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'trae', title: '历史 Trae 会话（A150 下架前）' }),
    })
  );
  const sessionId = created.session?.id;
  ok(!!sessionId, '[3] 下架后仍能读回旧会话（创建不受影响）', String(sessionId));

  const list = await json(await fetch(`${base}/api/sessions`));
  const found = (list.sessions ?? []).find(s => s.id === sessionId);
  ok(!!found, '[3] 会话列表里还在（数据没被下架操作动过）');
  // `db.getAllSessions()` 返回的是**原始行**，字段名是 snake_case 的 `agent_id`
  // （前端在 useSessions 里才映射成 agentId）。这里对的是接口原文，别用前端字段名。
  ok(found?.agent_id === 'trae', '[3] agent_id 仍是 trae（没有被静默改成别的）', String(found?.agent_id));

  // ============= [4] UI：打开旧会话不许白屏 =============
  console.log('\n[4] UI（真浏览器打开这条旧会话）');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(`${base}/chat/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const text = (await page.locator('body').innerText().catch(() => '')).trim();
  ok(text.length > 20, '[4] 页面有可见内容（不是白屏）', `${text.length} 字符`);
  // 肯定式：这条会话的标题必须真的渲染出来，否则「有内容」可能只是空壳侧栏
  ok(text.includes('历史 Trae 会话'), '[4] 旧会话标题渲染出来了');
  ok(pageErrors.length === 0, '[4] 没有未捕获异常', pageErrors.slice(0, 2).join(' | '));

  // 下架后「新建对话」里也不该能选到它 —— 但**不要**在这里断言「整页没有 Trae 字样」：
  // 上面刚建的那条会话标题里就带 Trae，侧栏会正常显示它。名册层面已在 [2] 用接口钉过。
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const home = (await page.locator('body').innerText().catch(() => '')).trim();
  ok(home.length > 20, '[4] 首页正常渲染（下架没把首页带崩）', `${home.length} 字符`);
  ok(pageErrors.length === 0, '[4] 首页也没有未捕获异常', pageErrors.slice(0, 2).join(' | '));
} finally {
  await browser?.close().catch(() => {});
  killTree(child);
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
