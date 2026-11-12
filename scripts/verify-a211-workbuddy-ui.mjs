/**
 * A211 最外层闸门：真服务端 + 真浏览器点击序列。
 *
 * ## 为什么不能只靠纯函数闸门
 *
 * 「服务端存了 profile」到「用户真的切过去了」中间隔着前端 state、HTTP 出参、
 * 列表重取、按钮禁用态、tooltip 遮挡等好几道，每一道单独看都可能绿。
 * 这里起一个独立端口的真服务端（独立 OPC_DATA_DIR + OPC_WB_HOME 夹具），
 * 用真实鼠标坐标点设置页的按钮，再用真实 HTTP 复核：
 *
 *   自动选中 → 点「切换到此版本」→ 生效值/固定标记/自定义模型清单全变
 *   → 点「自动选择」→ 全变回去 → 点「重新检测」→ 不崩、不回退
 *
 * 切换后 `GET /api/agents/workbuddy/models` 的 `configured` 从 2 条变 0 条
 * 再变回 2 条，是「界面切了、后端也真的切了」的硬证据；只看页面上的
 * `data-active-id` 的话，改一行前端 state 就能假绿。
 *
 * ## 夹具与隐私
 *
 * 官方产品配置、假 keyblob、含 `apiKey`/`url` 的 models.json 全部造在系统临时
 * 目录，绝不读用户真实 `~/.workbuddy*`。密钥用固定哨兵串，并在真 HTTP 响应里
 * 断言它一次都没出现。
 *
 * 运行：node scripts/verify-a211-workbuddy-ui.mjs（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-a211-ui-'));
const DATA = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 两个故意长得像密钥的夹具哨兵：靠它们断言真 HTTP 响应一次都没带出凭据。
const SECRET = 'sk-A211-UI-MUST-NOT-LEAK-4321'; // secret-scan:ignore 测试夹具哨兵，不是真密钥
const SECRET_URL = 'https://secret-gateway.invalid/v1'; // secret-scan:ignore 测试夹具哨兵，不是真密钥

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
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}
function group(t) { console.log(`\n── ${t} ──`); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
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
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { ready: true, log };
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return { ready: false, log };
}

// ── 夹具：两个官方数据根，国际版更活跃且带两条自定义模型 ──────────────────
const DAY = 86_400_000;
const NOW = Date.now();
function writeAt(file, text, at) {
  fs.writeFileSync(file, text, 'utf8');
  fs.utimesSync(file, new Date(at), new Date(at));
}
function makeRoot(folder, { endpoint, environment, productName, configAt, keyblobAt, customModels }) {
  const root = path.join(HOME, folder);
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  writeAt(path.join(root, 'cache', 'acc-product-config-v3-4321-6f0a.json'), JSON.stringify({
    dataFolderName: folder,
    productName,
    applicationName: folder,
    endpoint,
    networkEnvironment: environment,
    date: new Date(configAt).toISOString(),
    productConfigPathEnv: 'ACC_PRODUCT_CONFIG_PATH',
    authentication: { type: 'account-scoped-external-link' },
  }), configAt);
  if (keyblobAt) writeAt(path.join(root, 'keyblob'), 'fake-keyblob', keyblobAt);
  if (customModels) writeAt(path.join(root, 'models.json'), JSON.stringify(customModels), keyblobAt);
  return root;
}
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
makeRoot('.workbuddy', {
  endpoint: 'https://www.workbuddy.cn', environment: 'internal', productName: 'WorkBuddy',
  configAt: NOW - 9 * DAY, keyblobAt: NOW - 8 * DAY,
});
makeRoot('.workbuddy-ai', {
  endpoint: 'https://www.workbuddy.ai', environment: 'external', productName: 'WorkBuddy AI',
  configAt: NOW - 2 * DAY, keyblobAt: NOW - 1000,
  customModels: [
    { id: 'sensenova-6.8-flash-lite', name: '商汤轻量', vendor: 'SenseNova', apiKey: SECRET, url: SECRET_URL },
    { id: 'deepseek-v4-flash-0731', name: 'DeepSeek Flash', vendor: 'DeepSeek', apiKey: SECRET, url: SECRET_URL },
  ],
});

const env = { ...process.env, PORT: '0', OPC_DATA_DIR: DATA, OPC_WB_HOME: HOME, NODE_OPTIONS: '' };
for (const k of ['ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_V2', 'ACC_PRODUCT_CONFIG', 'ACC_PRODUCT_CONFIG_PATH']) delete env[k];

const port = await freePort();
env.PORT = String(port);
const base = `http://127.0.0.1:${port}`;

group('1. 起真服务端（独立数据目录 + 夹具 home）');
const child = spawn('npx tsx server/index.ts', {
  cwd: ROOT, shell: true, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
});
const { ready, log } = await waitReady(base, child);
ok(ready, '[1] 服务端起来了');
if (!ready) {
  console.log(log.slice(-2000));
  killTree(child);
  process.exit(1);
}
ok(fs.existsSync(path.join(ROOT, 'dist', 'index.html')), '[1] 前端产物存在（否则整条 UI 闸门会一起假红）');

/** 真 HTTP：每次都重新打服务端，不复用前端的 state */
async function api(p) {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, data: await res.json() };
}
async function configuredIds() {
  const { data } = await api('/api/agents/workbuddy/models');
  return (Array.isArray(data.configured) ? data.configured : []).map(m => m.id);
}

/**
 * 真实鼠标点击 + elementFromPoint 自证。
 * 不许用 force:true / dispatchEvent —— 那个点上如果被 tooltip 或别的浮层盖住，
 * 闸门必须红，而不是「事件照样派发成功、用户其实点不到」。
 */
async function realClick(page, selector, ownerSelector) {
  const loc = page.locator(selector);
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) return { hit: false, reason: 'no bounding box' };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = await page.evaluate(([px, py, owner]) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return null;
    return el.closest(owner) ? 'owner' : (el.tagName || 'unknown');
  }, [x, y, ownerSelector]);
  if (hit !== 'owner') return { hit: false, reason: `point hits ${String(hit)}` };
  await page.mouse.click(x, y);
  return { hit: true };
}

let browser;
try {
  group('2. 真 HTTP：自动选中活跃版本、脱敏、配置模型下发');
  const st = await api('/api/workbuddy-profiles');
  eq(st.status, 200, 'GET /api/workbuddy-profiles 返回 200');
  eq(st.data.activeId, '.workbuddy-ai', '★ 自动选中最近活跃的 .workbuddy-ai');
  eq(st.data.profiles.length, 2, '两个版本都列出来');
  ok(!('root' in st.data.profiles[0]), '★ profiles 不出本机绝对路径');
  ok(!JSON.stringify(st.data).includes(HOME), '★ 整个响应不含夹具绝对路径');
  ok(!JSON.stringify(st.data).includes(SECRET) && !JSON.stringify(st.data).includes(SECRET_URL),
    '★ 真 HTTP 响应里没有 apiKey / url');
  eq(st.data.customModels.length, 2, '桌面端两条自定义模型进入状态');
  eq(await configuredIds(), ['sensenova-6.8-flash-lite', 'deepseek-v4-flash-0731'],
    '★ /api/agents/workbuddy/models 的 configured 平级字段下发两条');

  group('3. 设置页真的打开、状态真的可见');
  ok(fs.existsSync(CHROME), '[3] Chrome 可用', CHROME);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/settings?section=login`, { waitUntil: 'domcontentloaded' });
  // 整条 UI 闸门全红时先证明页面开了（ErrorBoundary 会让 20 条一起假红）
  ok(await page.locator('[data-settings-panel="login"]').count() === 1,
    '★ 设置页的登录分区真的渲染了（不是 ErrorBoundary 空白）');
  await page.waitForSelector('[data-wb-state]', { timeout: 30000 });
  eq(await page.locator('[data-wb-state]').getAttribute('data-active-id'), '.workbuddy-ai',
    '页面上的生效版本与服务端一致');
  eq(await page.locator('[data-wb-profile-row]').count(), 2, '两行版本都画出来了');
  ok(await page.locator('[data-wb-warning]').count() === 1, '切换会中断对话的代价写清楚了');
  ok(await page.locator('[data-wb-switch][data-switch-id=".workbuddy"]').isEnabled(),
    '切到另一个版本的按钮可点');

  group('4. 跨状态序列①：真实鼠标切换到国内版');
  const c1 = await realClick(page, '[data-wb-switch][data-switch-id=".workbuddy"]',
    '[data-wb-switch][data-switch-id=".workbuddy"]');
  ok(c1.hit, '★ 按钮中心点真的能被鼠标命中（elementFromPoint 自证）', c1.reason || '');
  await page.waitForSelector('[data-wb-state][data-active-id=".workbuddy"]', { timeout: 60000 });
  eq(await page.locator('[data-wb-state]').getAttribute('data-pinned'), '1', '切完标记为已固定');
  const after1 = await api('/api/workbuddy-profiles');
  eq(after1.data.activeId, '.workbuddy', '★ 服务端真的切了（不是只改了前端 state）');
  eq(after1.data.customModels.length, 0, '国内版没有自定义模型，清单跟着清空');
  eq(await configuredIds(), [], '★ 模型菜单的 configured 同步变空（跨状态证据）');

  group('5. 跨状态序列②：回自动选择');
  ok(await page.locator('[data-wb-auto]').isEnabled(), '「自动选择」在固定态下可点');
  const c2 = await realClick(page, '[data-wb-auto]', '[data-wb-auto]');
  ok(c2.hit, '★ 自动按钮中心点真的能被鼠标命中', c2.reason || '');
  await page.waitForSelector('[data-wb-state][data-active-id=".workbuddy-ai"]', { timeout: 60000 });
  eq(await page.locator('[data-wb-state]').getAttribute('data-pinned'), '0', '固定标记复位');
  const after2 = await api('/api/workbuddy-profiles');
  eq(after2.data.activeId, '.workbuddy-ai', '★ 服务端回到活跃度最高的版本');
  eq(await configuredIds(), ['sensenova-6.8-flash-lite', 'deepseek-v4-flash-0731'],
    '★ 自定义模型清单跟着回来（不是缓存里的旧值）');

  group('6. 跨状态序列③：重新检测不崩、不回退');
  const c3 = await realClick(page, '[data-wb-refresh]', '[data-wb-refresh]');
  ok(c3.hit, '★ 重新检测按钮中心点真的能被鼠标命中', c3.reason || '');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-wb-refresh]');
    return el && !el.disabled;
  }, { timeout: 60000 });
  eq(await page.locator('[data-wb-state]').getAttribute('data-active-id'), '.workbuddy-ai',
    '重扫后仍停在正确版本');
  eq(await page.locator('[data-wb-error]').count(), 0, '页面没有报错行');

  group('7. 坏响应不白屏：服务端给 {} 时整个设置页仍完整');
  // 反向复现 verify:a28 的夹具兜底（json({})）：那时把 `{}` 直接当 State，
  // render 里 state.profiles.filter 抛异常 ⇒ ErrorBoundary 连导航一起吞掉，
  // 而且「外观分区已卸载 / 光斑开关消失」两条否定式断言还一起假绿。
  // 这里必须配肯定式：导航数、登录分区、还能切到别的分区。
  await page.route('**/api/workbuddy-profiles', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));
  await page.goto(`${base}/settings?section=login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-wb-error]', { timeout: 30000 });
  eq(await page.locator('[data-settings-section]').count(), 8,
    '★ 八个分区导航仍在（整页没被 ErrorBoundary 接管）');
  ok(await page.locator('[data-settings-panel="login"]').count() > 0,
    '★ 登录分区仍渲染（肯定式，不只钉「没有 X」）');
  ok(await page.locator('[data-wb-state]').count() === 0,
    '坏数据不画状态框（否定式，配上面的肯定式）');
  await page.locator('[data-settings-section="agents"]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-settings-panel="agents"]').count() > 0,
    '★ 还能切到别的分区（页面真的没崩）');
  await page.unroute('**/api/workbuddy-profiles');
} catch (err) {
  ok(false, '执行期未抛异常', (err?.stack || String(err)).slice(0, 600));
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(child);
  // 等进程真的退出再删夹具，避免 Windows 文件占用（kill() 返回 ≠ 进程已死）
  await new Promise(r => setTimeout(r, 600));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failures.length ? '✗' : '✓'} A211 真服务端 / 浏览器序列：${pass}/${pass + fail} 通过`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
console.log('✓ 自动选择 / 切换 / 回自动 / 重扫 四态序列均真实生效');
