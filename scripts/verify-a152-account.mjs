/**
 * A152：账号与权益（详情页只读区块）的验收闸门。
 *
 * 要钉的是用户报的两件事：
 *   ① 「打开详情页不知道登录的是哪个账号」—— 详情页必须有「当前登录」，
 *      读得到就显示（codex 的邮箱要掩码），读不到就写清为什么（zcode 加密）；
 *   ② 「ZCode 领了 Start Plan（Weekend Build），应用里看不到、也选不了」——
 *      权益必须列出来、状态与「是否生效」必须分开写，并且**带缓存时间**：
 *      过期缓存不能被当成「没订阅」这个事实。
 *
 * 同时守住两条边界：
 *   · zcode 的模型/套餐**只能读不能切**（`modelSelectable:false` + 引导文案）；
 *   · 拿不到账号数据的 Agent（豆包）整块不渲染，**不许**摆「未知」占位。
 *
 * 数据来自本机真实配置（~/.zcode/v2、~/.codex/auth.json）——与 A151 同一套
 * 做法：zcode 的账号加密、codex 的 id_token 可解，这两条只有真机才验得到。
 * 时间相关的断言只验**规则**（stale 与 checkedAt 的关系），不写死具体日期，
 * 否则用户在 ZCode 里刷新一次缓存，闸门就红了。
 *
 * 运行：node scripts/verify-a152-account.mjs（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a152-account-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const SHOTS = path.join(ROOT, '.tmp', 'a152-account');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const STALE_MS = 24 * 60 * 60 * 1000;

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

let browser;
try {
  // ============= [2] 接口层 =============
  console.log('\n[2] 接口层：账号与权益');
  const zcode = (await json(await fetch(`${base}/api/agents/zcode/account`))).account;

  ok(!!zcode, '[2] zcode 有账号/权益数据');
  ok(zcode?.identity?.email === undefined, '[2] zcode 的邮箱读不到就不填（不猜）');
  ok(typeof zcode?.identity?.unavailableReason === 'string' && zcode.identity.unavailableReason.length > 0,
    '[2] zcode 明说为什么读不到账号', String(zcode?.identity?.unavailableReason ?? '').slice(0, 24));

  ok(Array.isArray(zcode?.plans) && zcode.plans.length >= 3,
    '[2] 权益列表真的列出来了', `${zcode?.plans?.length ?? 0} 个套餐`);
  const badPlan = (zcode?.plans ?? []).find(p => !Array.isArray(p.models) || p.models.length === 0);
  ok(!badPlan, '[2] 每个套餐都带「套餐内真实模型」', badPlan ? badPlan.id : '');
  ok((zcode?.plans ?? []).every(p => ['active', 'inactive', 'unknown'].includes(p.status)),
    '[2] 状态只用三种取值（认不出就是 unknown，不臆造）');
  ok((zcode?.plans ?? []).some(p => p.selected),
    '[2] 至少一条被标成「当前选中」（否则界面没法回答登录的是哪套）');
  ok((zcode?.plans ?? []).some(p => p.selected && !p.effective),
    '[2] 「选中了但没生效」这个组合透出来了（用户报的问题正是它）');

  ok(Array.isArray(zcode?.currentSelection) && zcode.currentSelection.length >= 1,
    '[2] 当前选择按 provider family 分开给出', `${zcode?.currentSelection?.length ?? 0} 段`);
  // 这条防的是「按选择键查 provider 永远查不到」那个 bug：
  // setting.json 的键带连接方式前缀，config.json 的键不带 —— 不归一化就会把
  // `coding-plan:builtin:…` 原样当名字显示。
  ok((zcode?.currentSelection ?? []).every(s => s.providerName && s.providerName !== s.providerKey),
    '[2] 当前选择的展示名不是原始键',
    (zcode?.currentSelection ?? []).map(s => `${s.providerName}/${s.providerKey}`).join(' | '));

  // 时间：只验「stale = checkedAt 超过 24h」这条规则。数据本身会随用户刷新而变化。
  if (zcode?.checkedAt) {
    const expectStale = Date.now() - Date.parse(zcode.checkedAt) > STALE_MS;
    ok(zcode.stale === expectStale, '[2] stale 与缓存时间一致（过期缓存不许冒充事实）',
      `${zcode.checkedAt} → stale=${zcode.stale}`);
  } else {
    ok(zcode?.stale === undefined, '[2] 没有时间戳就不标 stale（不知道就别编）');
  }
  ok(zcode?.modelSelectable === false, '[2] zcode 的套餐/模型不可在本应用切换');
  ok(typeof zcode?.switchHint === 'string' && zcode.switchHint.includes('ZCode'),
    '[2] zcode 给出「去 ZCode 里切」的引导', String(zcode?.switchHint ?? '').slice(0, 20));

  const codex = (await json(await fetch(`${base}/api/agents/codex/account`))).account;
  ok(!!codex?.identity?.email, '[2] codex 的邮箱读得到（id_token 可解）', String(codex?.identity?.email ?? ''));
  ok(!!codex?.identity?.planLabel, '[2] codex 的当前套餐读得到', String(codex?.identity?.planLabel ?? ''));
  ok(codex?.modelSelectable === true, '[2] codex 的模型可以传给 CLI（可切换）');
  ok(Array.isArray(codex?.plans) && codex.plans.length >= 1, '[2] codex 的套餐也进权益列表');

  const doubao = (await json(await fetch(`${base}/api/agents/doubao/account`))).account;
  ok(doubao === null, '[2] 没有可读账号数据的 Agent 返回 null（界面整块不渲染）');
  const nope = await fetch(`${base}/api/agents/nope/account`);
  ok(nope.status === 200, '[2] 未知 Agent 不 500（返回 null 即可）');
  ok((await json(nope)).account === null, '[2] 未知 Agent 的 account 也是 null');

  // ============= [3] UI 层 =============
  console.log('\n[3] UI：详情页「账号与权益」');
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  const openDetail = async (theme, agentId) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(t => {
      try {
        localStorage.setItem('theme', t);
      } catch {
        /* 隐私模式下写不进去，不影响布局 */
      }
    }, theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    const goContacts = page.getByRole('button', { name: '打开通讯录' });
    if (await goContacts.count()) await goContacts.click();
    await page.waitForSelector(`[data-agent-row="${agentId}"]`, { timeout: 60000 });
    await page.locator(`[data-agent-row="${agentId}"]`).click();
    await page.waitForSelector('[data-agent-detail-page]', { timeout: 20000 });
    await page.waitForSelector('[data-agent-account]', { timeout: 20000 });
    return { ctx, page, errors };
  };

  const z = await openDetail('light', 'zcode');
  const zText = await z.page.locator('[data-agent-detail-page]').innerText();
  ok(zText.includes('账号与权益'), '[3] 区块渲染出来了');
  ok(zText.includes('已领取权益'), '[3] 权益列表有标题');
  ok((await z.page.locator('[data-agent-plan]').count()) === (zcode?.plans ?? []).length,
    '[3] 每个套餐都渲染成一张卡',
    `${await z.page.locator('[data-agent-plan]').count()} / ${(zcode?.plans ?? []).length}`);
  ok((await z.page.locator('[data-account-selection]').count()) === (zcode?.currentSelection ?? []).length,
    '[3] 当前选择逐条渲染');
  ok(zText.includes('未生效'), '[3] 「未生效」写出来了（不能只说「已选」）');
  ok(zText.includes('已选，未生效'), '[3] 选中但没生效的套餐两个词都在');
  const checkedText = (await z.page.locator('[data-account-checked-at]').innerText().catch(() => '')).trim();
  ok(checkedText.includes('数据'), '[3] 权益旁边带缓存时间', checkedText);
  if (zcode?.stale) {
    ok(checkedText.includes('已过期'), '[3] 过期缓存明确标注（不冒充「没订阅」）', checkedText);
  }
  ok(zText.includes('credentials.json'), '[3] 读不到账号时写明来源与原因');
  const hint = (await z.page.locator('[data-account-switch-hint]').innerText().catch(() => '')).trim();
  ok(hint.includes('ZCode'), '[3] 给出「去 ZCode 里切换」的引导', hint.slice(0, 24));
  const modelNote = (await z.page.locator('[data-account-model-note]').innerText().catch(() => '')).trim();
  ok(modelNote.includes('--model'), '[3] 说明为什么不能在这里切（没有 --model）', modelNote.slice(0, 24));
  // 只读：界面上不许出现「选择 / 切换」按钮
  ok((await z.page.locator('[data-agent-account] button').count()) === 0,
    '[3] 区块里没有任何按钮（只读就是只读）');
  await z.page.locator('[data-agent-account]').screenshot({ path: path.join(SHOTS, 'zcode-account-light.png') });
  await z.page.screenshot({ path: path.join(SHOTS, 'zcode-detail-light.png') });
  ok(z.errors.length === 0, '[3] zcode 资料页没有未捕获异常', z.errors.slice(0, 2).join(' | '));
  await z.ctx.close();

  const c = await openDetail('light', 'codex');
  const cText = await c.page.locator('[data-agent-detail-page]').innerText();
  ok(cText.includes('账号与权益'), '[3] codex 也有这一块');
  ok(cText.includes(String(codex?.identity?.planLabel ?? '')), '[3] codex 的当前套餐显示出来了');
  const fullEmail = String(codex?.identity?.email ?? '');
  ok(!fullEmail || !cText.includes(fullEmail), '[3] 完整邮箱不出现在页面上', fullEmail);
  ok(/\S\*\*\*@/.test(cText), '[3] 邮箱做了掩码（保留首字母与域名）');
  ok(cText.includes('本应用可以把选中的模型传给 codex'), '[3] codex 明确说可以切换模型');
  await c.page.locator('[data-agent-account]').screenshot({ path: path.join(SHOTS, 'codex-account-light.png') });
  await c.page.screenshot({ path: path.join(SHOTS, 'codex-detail-light.png') });
  ok(c.errors.length === 0, '[3] codex 资料页没有未捕获异常', c.errors.slice(0, 2).join(' | '));
  await c.ctx.close();

  // 深色只截一张，供人工核对配色（浅/深两套 token 必须都成立）
  const d = await openDetail('dark', 'zcode');
  await d.page.locator('[data-agent-account]').screenshot({ path: path.join(SHOTS, 'zcode-account-dark.png') });
  await d.page.screenshot({ path: path.join(SHOTS, 'zcode-detail-dark.png') });
  ok((await d.page.locator('[data-agent-account]').count()) === 1, '[3] 深色下区块仍渲染');
  await d.ctx.close();

  console.log(`\n  截图：${SHOTS}`);
} finally {
  await browser?.close();
  killTree(child);
}

console.log(`\n=== A152 账号与权益：${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log(`失败项：\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
