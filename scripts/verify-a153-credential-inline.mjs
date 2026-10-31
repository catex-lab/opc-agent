/**
 * A153：Agent 详情页就地凭据配置（不再弹去设置页）。
 *
 * 守的是四件事：
 *   1. key 类 Agent 的详情页**就地**展开凭据编辑器，不再有「填写 API Key」
 *      跳转按钮（之前那个按钮把人扔到设置页的外观区，是个 bug）。
 *   2. 编辑器的完整闭环：填 Key → 保存 → 显示掩码 + 「检测连通性」「获取模型」
 *      按钮出现 → 点连通性出真实状态 → 点获取模型出清单。
 *   3. 「检测连通性」「获取模型」**只在已配置后**出现 —— 没 Key 时不让点。
 *   4. 设置页跳转 bug 已修：带 `section=login` 时落到登录配置区，且定位到
 *      目标 Agent 的凭据行（不再静默落在外观页）。
 *
 * 用临时 OPC_DATA_DIR，不碰真实凭据。保存用假 Key（探测必然返回 needs-auth，
 * 但「保存」本身只写盘，与 Key 是否有效无关 —— 这条正好验「保存不校验有效性」）。
 *
 * 运行：node scripts/verify-a153-credential-inline.mjs（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a153-cred-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const SHOTS = path.join(ROOT, '.tmp', 'a153-credential-inline');
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
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  const openDetail = async agentId => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    const goContacts = page.getByRole('button', { name: '打开通讯录' });
    if (await goContacts.count()) await goContacts.click();
    await page.waitForSelector(`[data-agent-row="${agentId}"]`, { timeout: 60000 });
    await page.locator(`[data-agent-row="${agentId}"]`).click();
    await page.waitForSelector('[data-agent-detail-page]', { timeout: 20000 });
    await page.waitForSelector('[data-agent-credential-inline]', { timeout: 15000 });
    return { ctx, page, errors };
  };

  // ============= [2] 详情页就地编辑器 =============
  console.log('\n[2] 详情页：豆包就地凭据编辑器');
  const d = await openDetail('doubao');

  ok(
    (await d.page.locator('[data-agent-credential-inline]').count()) === 1,
    '[2] 详情页就地展开凭据编辑器'
  );
  ok(
    (await d.page.locator('[data-agent-install] [data-install-open-settings]').count()) === 0,
    '[2] 不再有「填写 API Key」跳转按钮'
  );
  ok(
    (await d.page.locator('[data-credential-key="doubao"]').count()) === 1,
    '[2] 有 API Key 输入框'
  );
  // 未配置时：连通性 / 获取模型按钮不应出现
  const actionBtnsBefore = await d.page
    .locator('[data-agent-credential-inline] button')
    .allInnerTexts();
  ok(
    !actionBtnsBefore.some(t => t.includes('检测连通性') || t.includes('获取模型')),
    '[2] 未配置时不出现「检测连通性 / 获取模型」按钮',
    actionBtnsBefore.join('|')
  );

  // 填假 Key 并保存（TDesign Input 的真实 input 在 wrapper 内层）
  await d.page.locator('[data-credential-key="doubao"] input').fill('ark-test-key-123456');
  await d.page.getByRole('button', { name: '保存' }).click();
  // 保存成功 → 状态变成已配置，掩码出现
  await d.page.waitForSelector('[data-credential-editor="doubao"] .t-tag--success', { timeout: 10000 });
  ok(
    /已配置|\*\*\*\*/.test(await d.page.locator('[data-credential-editor="doubao"]').innerText()),
    '[2] 保存后显示已配置 + 掩码'
  );

  // 保存后连通性 / 获取模型按钮出现
  await d.page.getByRole('button', { name: '检测连通性' }).waitFor({ timeout: 5000 });
  ok(
    (await d.page.getByRole('button', { name: '检测连通性' }).count()) === 1,
    '[2] 已配置后出现「检测连通性」'
  );
  ok(
    (await d.page.getByRole('button', { name: '获取模型' }).count()) === 1,
    '[2] 已配置后出现「获取模型」'
  );

  // 点连通性 —— 假 Key，探测应返回 needs-auth（非 ready），但结果块必须出现
  await d.page.getByRole('button', { name: '检测连通性' }).click();
  await d.page.waitForSelector('[data-connectivity-result]', { timeout: 15000 });
  const connText = await d.page.locator('[data-connectivity-result]').innerText();
  ok(
    connText.trim().length > 0,
    '[2] 连通性结果块出现',
    connText.slice(0, 40)
  );

  // 点获取模型 —— 必有结果区（有清单列清单，没有给说明）
  await d.page.getByRole('button', { name: '获取模型' }).click();
  await d.page.waitForSelector('[data-models-result]', { timeout: 15000 });
  ok(
    (await d.page.locator('[data-models-result]').count()) === 1,
    '[2] 获取模型后出现结果区'
  );

  await d.page.locator('[data-agent-credential-inline]').screenshot({ path: path.join(SHOTS, 'doubao-editor-after-save.png') });
  ok(d.errors.length === 0, '[2] 详情页无控制台错误', d.errors.slice(0, 2).join(' | '));
  await d.ctx.close();

  // ============= [3] 设置页跳转 bug 修复 =============
  console.log('\n[3] 设置页：?section=login 落到登录配置并定位行');
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await ctx3.newPage();
  const errors3 = [];
  p3.on('pageerror', e => errors3.push(e.message));
  await p3.goto(`${base}/settings?section=login&agent=doubao`, { waitUntil: 'domcontentloaded' });
  await p3.waitForSelector('[data-settings-section="login"]', { timeout: 10000 });
  // 登录配置区的凭据行只在 section==='login' 时渲染 —— 行可见就证明
  // 落到了正确分区（之前的 bug 是落在外观页，行根本不渲染）。
  const rowVisible = await p3.locator('[data-credential-row="doubao"]').isVisible();
  ok(rowVisible, '[3] ?section=login 落到登录配置区（凭据行可见）');
  // 凭据行存在且可见（不再静默失败）
  const rowCount = await p3.locator('[data-credential-row="doubao"]').count();
  ok(rowCount === 1, '[3] 目标 Agent 的凭据行存在', `count=${rowCount}`);
  await p3.screenshot({ path: path.join(SHOTS, 'settings-login-jump.png') });
  ok(errors3.length === 0, '[3] 设置页无控制台错误', errors3.slice(0, 2).join(' | '));
  await ctx3.close();

  console.log(`\n  截图：${SHOTS}`);
} finally {
  await browser?.close();
  killTree(child);
}

console.log(`\n=== A153 就地凭据配置：${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log(`失败项：\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
