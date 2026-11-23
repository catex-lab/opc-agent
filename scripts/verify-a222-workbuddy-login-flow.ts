/**
 * A222 闸门：WorkBuddy「桌面端已登录，应用里却一直显示未登录」的完整闭环。
 *
 * ## 真机复盘（2026-11-13，见当天工作日志）
 *
 * 三条链路各自起 `unstable_v2_authenticate()`，共用一份 `~/.workbuddy-ai`：
 *   1. `SdkAdapter.probe()` —— 8 秒预算，把一次性 authUrl 存进**模块级全局**；
 *      CLI 退出后 URL 还挂在「去登录」按钮上（21:44 生成，22:02 还在使用）。
 *   2. `GET /api/check-login` —— 没给 timeout，走 SDK 默认 300 秒，
 *      一个「查登录」的 GET 就会再起一条并发登录流。
 *   3. 「去登录」按钮 —— 只 `window.open` 那个死 URL，登录完成后没人接回调。
 * 结果是 10+ 个不同 pid 互顶，账号 A 被账号 B 顶掉，状态永久 `needs-auth`。
 *
 * ## 四层可观测量
 *
 *   [1] 真模块状态机（注入 authenticate 桩）：全局单飞 / 跨 Agent 让路 /
 *       活 URL 归属 / 终态立刻作废 URL / 成功后强制重探的钩子 / 状态词分类；
 *   [2] 浏览器夹具（真 dist + 真鼠标）：登录流刚启动还没拿到活链接时按钮
 *       **禁用且一次都不打开死链接**；活链接回来后点开的必须是它；
 *       流成功后自动触发重探。这一层直接复现用户那张截图；
 *   [3] 源码契约 + 反向探针：把实现逐个改回坏版本，判据必须变红；
 *   [4] 真服务端路由 e2e：独立 OPC_DATA_DIR + 随机端口，证明两条新端点
 *       没被通用 `/api/agents/:agentId` 吞掉，且非 SDK Agent 不会起 CLI。
 *
 * 运行：
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-yield
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-budget
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-reprobe
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-clear-url
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-live-url
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-dead-url-guard
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-session-word
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=no-terminal-clear
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=restore-vertical-bar
 *   npx tsx scripts/verify-a222-workbuddy-login-flow.ts --probe=restore-hint-rule
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { resolveChromePath } from './lib/chrome.mjs';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a222-'));
const UNIT_DATA = path.join(TMP, 'unit-data');
const E2E_DATA = path.join(TMP, 'e2e-data');
fs.mkdirSync(UNIT_DATA, { recursive: true });
fs.mkdirSync(E2E_DATA, { recursive: true });
// sdk.ts 会在模块加载时开库，必须先指向临时目录
process.env.OPC_DATA_DIR = UNIT_DATA;

const ARGS = process.argv.slice(2);
const PROBE = ARGS.find(a => a.startsWith('--probe='))?.slice(8) ?? null;
/** 反向探针只需复验源码契约；浏览器 / 真服务端层在全量那一次跑就够了。 */
const FULL = PROBE === null;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  [${detail}]` : ''}`);
  }
}
function eq<T>(actual: T, expected: T, name: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}
function group(t: string) { console.log(`\n── ${t} ──`); }

function stripComments(s: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of s.replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; out.push(''); continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; out.push(''); continue; }
    if (t.startsWith('//') || t.startsWith('*')) { out.push(''); continue; }
    const cut = raw.indexOf('//');
    out.push(cut >= 0 ? raw.slice(0, cut) : raw);
  }
  return out.join('\n');
}
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel: string) => stripComments(src(rel));
const line = (s: string, re: RegExp) => s.split('\n').some(l => re.test(l));
/** 只取 configureLoginFlowHooks({...}) 的函数体，避免别处的同名调用让断言恒绿。 */
function hookBody(s: string): string {
  const start = s.indexOf('configureLoginFlowHooks({');
  if (start < 0) return '';
  const end = s.indexOf('});', start);
  return end < 0 ? s.slice(start) : s.slice(start, end);
}

const DEAD_URL = 'https://fixture-login.example/oauth?state=DEAD_ONE_TIME_STATE';
const LIVE_URL = 'https://fixture-login.example/oauth?state=LIVE_FROM_LONG_RUNNING_FLOW';

// ═══════════════════ [1] 真模块：登录流状态机 ═══════════════════
group('1. 真模块：全局单飞 / 活链接 / 终态作废');
const flow = await import('../server/agents/loginFlow.js');
const sdk = await import('../server/agents/adapters/sdk.js');

type StubOptions = {
  environment?: string;
  endpoint?: string;
  env?: Record<string, string>;
  timeout?: number;
  onAuthUrl?: (s: { authUrl?: string }) => void | Promise<void>;
};

const RT = { environment: 'external', endpoint: 'https://example.invalid', env: {} };
let stubCalls = 0;
let stubUrl: string | null = LIVE_URL;
let stubOutcome: 'resolve' | 'reject' | 'fail' = 'resolve';
const authenticateStub = async (o: StubOptions) => {
  stubCalls++;
  if (o.onAuthUrl && stubUrl) await o.onAuthUrl({ authUrl: stubUrl });
  if (stubOutcome === 'reject') throw new Error('Authentication timed out');
  if (stubOutcome === 'fail') throw new Error('network down');
  return { userinfo: { id: 'gate-user' } };
};
const opts = () => ({
  authenticateImpl: authenticateStub,
  runtime: RT as never,
  timeoutMs: 2_000,
});
const settled: Array<[string, boolean]> = [];
flow.configureLoginFlowHooks({ onSettled: (id, good) => settled.push([id, good]) });

flow.resetLoginFlowForTest();
settled.length = 0;
stubCalls = 0;
stubUrl = LIVE_URL;
stubOutcome = 'resolve';
ok(!flow.isLoginFlowActive(), '初始没有登录流在跑');
eq(flow.loginFlowStatus('workbuddy').state, 'idle', '初始状态是 idle');

const s1 = flow.startLoginFlow('workbuddy', opts());
ok(s1.state === 'starting' || s1.state === 'waiting', 'start 同步返回快照，不把 HTTP 挂到 300 秒', s1.state);
ok(flow.isLoginFlowActive(), '★ 流真的在跑（不是只改了个状态字）');
eq(flow.activeLoginFlowAuthUrl(), LIVE_URL, '★ 活链接归这条长等待的流持有');
eq(sdk.getLastAuthUrl(), LIVE_URL, '★ 名册侧读到的也是活链接，不是模块级陈旧全局');

const s2 = flow.startLoginFlow('workbuddy', opts());
eq(stubCalls, 1, '★ 同一 Agent 重复 start 并没有起第二个 CLI');
ok(s2.state !== 'busy', '同一 Agent 拿到的是自己那条流', s2.state);
const s3 = flow.startLoginFlow('codebuddy', opts());
eq(s3.state, 'busy', '★ 跨 Agent 也让路：别的 Agent 正在登录时不新建流');
eq(s3.busyAgentId, 'workbuddy', 'busy 快照写明是谁占着');
eq(stubCalls, 1, '★ 跨 Agent 尝试同样没有起第二个 CLI');
eq(flow.loginFlowStatus('codebuddy').state, 'busy', 'status 对别的 Agent 也报 busy');

await new Promise(r => setTimeout(r, 30));
eq(flow.loginFlowStatus('workbuddy').state, 'succeeded', 'SDK resolve 后流收敛到 succeeded');
ok(!flow.isLoginFlowActive(), '★ 终态立刻释放单飞');
eq(flow.activeLoginFlowAuthUrl(), null, '★★ 终态的 authUrl 立即作废（21:44 死链接的根因）');
eq(sdk.getLastAuthUrl(), null, '★★ getLastAuthUrl 不再返回已死的一次性 state');
eq(flow.loginFlowStatus('workbuddy').authUrl, undefined,
  '★★ 终态状态快照不再下发一次性 URL（失败/超时后重试不会点回死链）');
ok(settled.some(([id, good]) => id === 'workbuddy' && good), '★ onSettled(ok=true) 触发（服务端据此强制重探）');
eq(settled.length, 1, '只回调一次，不会重复重探');

// URL 决策：活链接优先；流已结束时 fallback 也只在「根本没有流」时才用
eq(flow.resolveLoginUrl(LIVE_URL, DEAD_URL), LIVE_URL, '活链接优先于探测留下的死链接');
eq(flow.resolveLoginUrl(null, DEAD_URL), DEAD_URL, '老服务端 / 夹具没有登录流时仍可降级');
eq(flow.resolveLoginUrl('javascript:alert(1)', null), null, '非 http(s) 地址一律拒绝');
eq(flow.resolveLoginUrl('  ', null), null, '空白地址一律拒绝');

// 失败 / 超时：同样不许把 URL 留给下一次点击
flow.resetLoginFlowForTest();
stubCalls = 0;
stubUrl = null;
stubOutcome = 'fail';
flow.startLoginFlow('workbuddy', opts());
await new Promise(r => setTimeout(r, 30));
eq(flow.loginFlowStatus('workbuddy').state, 'failed', 'SDK 抛错 → failed');
eq(flow.activeLoginFlowAuthUrl(), null, 'failed 后也没有可复用的 URL');

flow.resetLoginFlowForTest();
stubOutcome = 'reject';
flow.startLoginFlow('workbuddy', opts());
await new Promise(r => setTimeout(r, 30));
eq(flow.loginFlowStatus('workbuddy').state, 'timed-out', 'Authentication timed out → timed-out');
ok(!flow.isLoginFlowActive(), 'timed-out 也释放单飞');

// 非法 URL 不许进快照
flow.resetLoginFlowForTest();
stubUrl = 'javascript:alert(1)';
stubOutcome = 'resolve';
flow.startLoginFlow('workbuddy', opts());
await new Promise(r => setTimeout(r, 20));
eq(flow.loginFlowStatus('workbuddy').authUrl, undefined, 'SDK 给的非 http(s) 地址被挡在快照外');
flow.resetLoginFlowForTest();

// 状态词：七态各有文案，tone 只有四档
const views = (['idle', 'starting', 'waiting', 'succeeded', 'failed', 'timed-out', 'busy'] as const)
  .map(s => flow.loginFlowView({ agentId: 'workbuddy', state: s }));
eq(views[0].label, '', 'idle 不占一行说明');
ok(views.slice(1).every(v => v.label.length > 0), '其余六态都有用户可见文案');
ok(views[3].tone === 'success' && views[2].tone === 'pending' && views[4].tone === 'error',
  'pending / success / error 三档 tone 区分正确');

// 登录态分层：本地有 keyblob ≠ 从未登录
eq(sdk.classifyWorkbuddyLoginState({ keyblobExists: true }), 'session-invalid',
  '★ 本地登录态文件存在但仍要求登录 → 登录态失效（不是「未登录」）');
eq(sdk.classifyWorkbuddyLoginState({ keyblobExists: false, message: '401 account list is empty' }),
  'session-invalid', '401 / 空账号列表也判失效');
eq(sdk.classifyWorkbuddyLoginState({ keyblobExists: false }), 'never-logged-in',
  '没有本地登录态且无错误 → 从未登录');
eq(sdk.classifyWorkbuddyLoginState({ keyblobExists: false, message: 'initialize 超时' }),
  'never-logged-in', '探测超时不该被误判成登录态失效');

// ═══════════════════ [2] 源码契约 + 反向探针 ═══════════════════
group('2. 源码契约（剥注释、锚行首）与反向探针');

interface Files {
  index: string; sdk: string; loginFlow: string; serverTypes: string;
  types: string; chatHeader: string; zh: string; en: string;
  agentLogin: string; chatMessages: string; detail: string;
  registryHook: string; indexCss: string; settings: string; settingsCss: string; custom: string;
}
const REAL: Files = {
  index: code('server/index.ts'),
  custom: code('server/routes/custom-agents.ts'),
  sdk: code('server/agents/adapters/sdk.ts'),
  loginFlow: code('server/agents/loginFlow.ts'),
  serverTypes: code('server/agents/types.ts'),
  types: code('src/types.ts'),
  chatHeader: code('src/components/ChatHeader.tsx'),
  zh: code('src/i18n/zh.ts'),
  en: code('src/i18n/en.ts'),
  agentLogin: code('src/agentLogin.ts'),
  chatMessages: code('src/components/ChatMessages.tsx'),
  detail: code('src/components/AgentDetailSections.tsx'),
  registryHook: code('src/hooks/useAgentRegistry.ts'),
  indexCss: code('src/index.css'),
  settings: code('src/components/SettingsPage.tsx'),
  settingsCss: code('src/settings-select.css'),
};

function contract(f: Files) {
  const indexStart = f.custom.indexOf('app.post("/api/agents/:agentId/login/start"');
  const indexStatus = f.custom.indexOf('app.get("/api/agents/:agentId/login/status"');
  const indexGeneric = f.custom.indexOf('app.get("/api/agents/:agentId"');
  return {
    // 查登录的 GET 不许再起一条 300 秒登录流
    checkLoginYield:
      /if \(isLoginFlowActive\(\)\) \{/.test(f.index) && /登录流程进行中/.test(f.index),
    checkLoginBudget: line(f.index, /timeout:\s*SDK_LOGIN_WAIT_MS,/),
    sdkBudget:
      line(f.sdk, /export const SDK_LOGIN_WAIT_MS = 8_000;/) &&
      line(f.sdk, /timeout:\s*SDK_LOGIN_WAIT_MS,/),
    // 探测每轮开头清空本轮 URL；没有活流就不给假入口
    probeClearsUrl: line(f.sdk, /this\.probeAuthUrl = null;/),
    probeYields:
      line(f.sdk, /if \(isLoginFlowActive\(\)\) \{/) &&
      /activeLoginFlowAuthUrl\(\)/.test(f.sdk),
    noGlobalUrl:
      line(f.sdk, /return activeLoginFlowAuthUrl\(\);/) && !/let lastAuthUrl/.test(f.sdk),
    // 登录成功后必须强制重探，不能等前端 60 秒轮询。
    // 必须钉在钩子函数体里：文件里另有 5 处 `registry.probeOne(agentId, true)`，
    // 拿全文做判据的话，删掉钩子这一处照样绿。
    settledReprobe:
      /configureLoginFlowHooks\(\{/.test(f.index) &&
      /registry\.probeOne\(agentId, true\)/.test(hookBody(f.index)) &&
      /invalidateWorkbuddyProfile\(\)/.test(hookBody(f.index)),
    loginRoutes:
      indexStart >= 0 && indexStatus > indexStart && indexGeneric > indexStatus &&
      // F0-02②：/api/agents/:agentId 详情路由已迁 routes/custom-agents.ts
      /agent\.kind !== "sdk"/.test(f.custom),
    // 状态词分层
    sessionWord:
      /'session-invalid'/.test(f.serverTypes) &&
      /probeState === 'session-invalid'/.test(f.types) &&
      /登录态失效/.test(f.types) &&
      /'session-invalid': 'status\.session-invalid'/.test(f.chatHeader) &&
      /'status\.session-invalid'/.test(f.zh) && /'status\.session-invalid'/.test(f.en),
    // 前端：死链接窗口必须被堵住，且仍保留用户手势里的同步 window.open
    deadUrlGuard:
      /phaseRef\.current === 'idle' \? fallbackUrl : undefined/.test(f.agentLogin) &&
      /window\.open\(url, '_blank', 'noopener'\)/.test(f.agentLogin) &&
      /canOpen/.test(f.agentLogin),
    // 终态清链接：服务端快照与前端按钮两端都要收口
    terminalUrlClear:
      /!\s*TERMINAL\.has\(flow\.state\)/.test(f.loginFlow) &&
      /if \(TERMINAL\.has\(next\)\) \{/.test(f.agentLogin),
    loginWiring:
      /disabled=\{!login\.canOpen\}/.test(f.chatMessages) &&
      /disabled=\{!login\.canOpen\}/.test(f.detail) &&
      /data-agent-login-state=\{login\.phase\}/.test(f.chatMessages) &&
      /data-agent-login-state=\{login\.phase\}/.test(f.detail) &&
      /agentId && authUrl && \(/.test(f.chatMessages),
    refocusReload:
      /visibilitychange/.test(f.registryHook) && /void load\(\)/.test(f.registryHook),
    // UI 收口：选中态不画竖线、enum 说明不常驻
    noVerticalBar:
      !/\.tc-list-item\.is-active::before/.test(f.indexCss) &&
      !/\[data-settings-section\]\[aria-current="page"\]::before/.test(f.indexCss),
    noStandaloneHint:
      !/\.opc-enum-setting__hint\s*\{/.test(f.settingsCss) &&
      !/opc-enum-setting__hint/.test(f.settings) &&
      /note=\{current\.hint\}/.test(f.settings),
  };
}

type ProbeName =
  | 'no-yield' | 'no-budget' | 'no-reprobe' | 'no-clear-url' | 'no-live-url'
  | 'no-dead-url-guard' | 'no-session-word' | 'restore-vertical-bar' | 'restore-hint-rule'
  | 'no-terminal-clear';

/** 把实现逐个退回坏版本。返回 [突变后的文件, 期望变红的那一条] */
function mutate(name: ProbeName): [Files, keyof ReturnType<typeof contract>] {
  const f: Files = { ...REAL };
  switch (name) {
    case 'no-yield':
      f.index = f.index.replace('if (isLoginFlowActive()) {', 'if (false) {');
      return [f, 'checkLoginYield'];
    case 'no-budget':
      f.index = f.index.replace('timeout: SDK_LOGIN_WAIT_MS,', 'timeout: 300000,');
      return [f, 'checkLoginBudget'];
    case 'no-reprobe':
      f.index = f.index.replace(
        'if (ok) void registry.probeOne(agentId, true).catch(() => {});',
        'if (ok) void 0;'
      );
      return [f, 'settledReprobe'];
    case 'no-clear-url':
      // probe 开头与成功分支各有一句；只删第一句的话断言会因为第二句维持恒绿
      f.sdk = f.sdk.split('this.probeAuthUrl = null;').join('/* removed */');
      return [f, 'probeClearsUrl'];
    case 'no-live-url':
      f.sdk = f.sdk.replace('return activeLoginFlowAuthUrl();', 'return null;');
      return [f, 'noGlobalUrl'];
    case 'no-dead-url-guard':
      f.agentLogin = f.agentLogin.replace(
        "phaseRef.current === 'idle' ? fallbackUrl : undefined",
        'fallbackUrl'
      );
      return [f, 'deadUrlGuard'];
    case 'no-session-word':
      f.types = f.types.replace("probeState === 'session-invalid'", 'false');
      return [f, 'sessionWord'];
    case 'restore-vertical-bar':
      f.indexCss += "\n.tc-list-item.is-active::before { content: ''; }\n";
      return [f, 'noVerticalBar'];
    case 'restore-hint-rule':
      f.settingsCss += '\n.opc-enum-setting__hint { height: 36px; }\n';
      return [f, 'noStandaloneHint'];
    case 'no-terminal-clear':
      f.agentLogin = f.agentLogin.replace('if (TERMINAL.has(next)) {', 'if (false) {');
      return [f, 'terminalUrlClear'];
  }
}

const PROBES: ProbeName[] = [
  'no-yield', 'no-budget', 'no-reprobe', 'no-clear-url', 'no-live-url',
  'no-dead-url-guard', 'no-session-word', 'restore-vertical-bar', 'restore-hint-rule',
  'no-terminal-clear',
];
const base = contract(REAL);
for (const [k, v] of Object.entries(base)) ok(v, `[S] 契约成立：${k}`);
for (const name of PROBES) {
  const [bad, expectedRed] = mutate(name);
  const got = contract(bad);
  ok(
    got[expectedRed] === false && Object.entries(got).every(([k, v]) => k === expectedRed || v === true),
    `★ 反向探针：${name} → 只有 ${expectedRed} 变红`,
    Object.entries(got).filter(([k, v]) => !v).map(([k]) => k).join(',') || 'none-red'
  );
}
if (PROBE) {
  const chosen = mutate(PROBE as ProbeName);
  const got = contract(chosen[0]);
  ok(got[chosen[1]] === false,
    `[probe=${PROBE}] 指定突变确实把 ${chosen[1]} 判红（外部复验用）`);
}

// ═══════════════════ [3] 浏览器夹具：死链接不再被点开 ═══════════════════
group('3. 浏览器夹具（真 dist + 真鼠标 + 登录流桩）');
const DIST = path.join(ROOT, 'dist');
if (!FULL) {
  console.log('  · probe 模式：跳过浏览器 / 真服务端层，只复验源码契约反向探针');
} else if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  ok(false, '需要 dist/（先 npm run build），本层跳过');
} else {
  const CHROME = resolveChromePath();
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon',
  };
  const AGENTS = [{
    id: 'workbuddy', name: 'WorkBuddy', vendor: 'Tencent', kind: 'sdk', icon: 'workbuddy',
    color: '#7C5CFF', description: '桌面端助手', capabilities: ['chat'],
    eventCapabilities: [], skills: [],
    status: {
      availability: 'needs-auth', version: '1',
      message: '未登录，请先完成登录授权', authUrl: DEAD_URL,
    },
    permissionSupport: { enforced: ['default'] },
  }];
  const staticServer = createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    let file = path.join(DIST, url === '/' ? 'index.html' : url);
    let body: Buffer;
    try { body = await readFile(file); }
    catch { file = path.join(DIST, 'index.html'); body = await readFile(file); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>(r => staticServer.listen(0, '127.0.0.1', r));
  const addr = staticServer.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  let statusState: Record<string, unknown> = { state: 'starting' };
  let statusCalls = 0;
  const probeCalls: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      (window as unknown as { __opcOpenUrls: string[] }).__opcOpenUrls = [];
      (window as unknown as { __opcAgentPayloads: string[] }).__opcAgentPayloads = [];
      window.open = ((...args: unknown[]) => {
        (window as unknown as { __opcOpenUrls: string[] }).__opcOpenUrls.push(String(args[0] ?? ''));
        return null;
      }) as typeof window.open;
      // 夹具自检：记录每份名册里各条目的 status 是否存在，避免把「夹具数据缺字段」
      // 造成的应用崩溃误读成登录流缺陷。
      const origFetch = window.fetch.bind(window);
      window.fetch = (async (...args: Parameters<typeof window.fetch>) => {
        const res = await origFetch(...args);
        const u = String(args[0] ?? '');
        if (/\/api\/agents/.test(u) && res.ok) {
          try {
            const data = await res.clone().json();
            if (Array.isArray(data?.agents)) {
              (window as unknown as { __opcAgentPayloads: string[] }).__opcAgentPayloads.push(
                `${u.split('?')[0].split('/api/')[1] ?? '?'} => ` +
                data.agents.map((a: { id?: string; status?: unknown }) =>
                  a ? `${a.id ?? '?'}:${a.status ? 'status' : 'NO-STATUS'}` : 'UNDEFINED'
                ).join(',')
              );
            }
          } catch { /* 非 JSON 应答不记 */ }
        }
        return res;
      }) as typeof window.fetch;
    });
    await ctx.route('**/api/**', async route => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      const json = (o: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
      if (/\/api\/agents\/workbuddy\/login\/start$/.test(url) && method === 'POST')
        return json({ state: 'starting' });
      if (/\/api\/agents\/workbuddy\/login\/status$/.test(url)) {
        statusCalls++;
        return json(statusState);
      }
      if (/\/api\/agents\/[^/]+\/probe$/.test(url) && method === 'POST') {
        probeCalls.push(url);
        // 单探测的形状是 {status} —— `createSingleProbeRunner` 会把它整份
        // 写回该条目的 status。答成 {agents:[...]} 会写成 undefined，
        // `useAgentRegistry.grouped` 的 useMemo 立刻崩进错误边界（夹具假红）。
        // 这里刻意保留 needs-auth，让「登录完成」状态行仍可观测。
        return json({ status: { ...AGENTS[0].status } });
      }
      if (/\/api\/agents\/probe$/.test(url) && method === 'POST') {
        probeCalls.push(url);
        // 全量探测的形状是 {agents, comingSoon}
        return json({ agents: AGENTS, comingSoon: [] });
      }
      if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
      if (/\/api\/models/.test(url)) return json({ models: [{ modelId: 'wb-default', name: '默认' }] });
      if (/\/api\/sessions/.test(url)) return json({ sessions: [], messages: [] });
      if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });
      if (/\/api\/workbuddy-profiles/.test(url)) return json({ active: '.workbuddy-ai', profiles: [] });
      return json({});
    });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    // 先证明页面真的开了：整块 UI 全红时最常见的假因是 ErrorBoundary
    const appAlive = await page.locator('button[aria-label="通讯录"]').count();
    ok(appAlive === 1, '肯定式：应用真的挂载了（通讯录入口在）');
    await page.locator('button[aria-label="通讯录"]').click();
    await page.waitForTimeout(500);
    await page.locator('[data-agent-row="workbuddy"]').first().click();
    await page.waitForSelector('[data-agent-login-btn]', { timeout: 15000 });

    // ── 死链接窗口 ──
    ok(await page.locator('[data-agent-login-btn]').isDisabled(),
      '★★ 登录流刚启动、活链接还没回来时按钮禁用（不把用户送去死 state）');
    const startingLabel = await page.locator('[data-agent-login-state]').innerText().catch(() => '');
    ok(startingLabel.includes('正在准备登录链接'), '同时给出「正在准备登录链接」而不是静默灰掉',
      startingLabel.slice(0, 40));
    let opened: string[] = await page.evaluate(() =>
      (window as unknown as { __opcOpenUrls: string[] }).__opcOpenUrls ?? []);
    eq(opened.length, 0, '★ 在活链接回来之前一次都没调用 window.open');

    // ── 活链接到达 ──
    statusState = { state: 'waiting', authUrl: LIVE_URL };
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-agent-login-btn]') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    }, null, { timeout: 12000 });
    ok((await page.getAttribute('[data-agent-login-state]', 'data-agent-login-state')) === 'waiting',
      '状态行进入 waiting');
    await page.locator('[data-agent-login-btn]').click();
    await page.waitForTimeout(300);
    opened = await page.evaluate(() =>
      (window as unknown as { __opcOpenUrls: string[] }).__opcOpenUrls ?? []);
    eq(opened, [LIVE_URL], '★★ 点「去登录」打开的是活链接（恰好一次）');
    ok(!opened.includes(DEAD_URL), '★★ 探测留下的死链接一次都没被打开');

    // ── 登录成功 → 自动重探（用户不必再点「重新探测」）──
    const before = probeCalls.length;
    statusState = { state: 'succeeded' };
    try {
      await page.waitForSelector('[data-agent-login-state="succeeded"]', { timeout: 12000 });
    } catch (e) {
      const diag = await page.evaluate(() => {
        const el = document.querySelector('[data-agent-login-state]');
        const btn = document.querySelector('[data-agent-login-btn]') as HTMLButtonElement | null;
        return JSON.stringify({
          state: el?.getAttribute('data-agent-login-state') ?? null,
          text: el?.textContent ?? '',
          btnPresent: !!btn,
          btnDisabled: btn?.disabled ?? null,
          path: location.pathname,
          rows: document.querySelectorAll('[data-agent-row]').length,
          bodyLen: document.body.innerText.length,
          bodyHead: document.body.innerText.slice(0, 120),
          detail: [...document.querySelectorAll('pre, details, [data-error-detail]')]
            .map(n => n.textContent ?? '').join(' ~ ').slice(0, 500),
          payloads: (window as unknown as { __opcAgentPayloads?: string[] }).__opcAgentPayloads ?? [],
        });
      });
      throw new Error(`dom=${diag} | console=${consoleErrors.join(' | ').slice(0, 300)} | statusCalls=${statusCalls}`);
    }
    ok(true, '★ 登录成功后状态行进入 succeeded');
    ok((await page.locator('[data-agent-login-state="succeeded"]').innerText()).includes('登录完成'),
      '状态行写明「登录完成，正在刷新状态」');
    ok(await page.locator('[data-agent-login-btn]').isDisabled(),
      '★★ 终态后按钮禁用：重试不会再把已退出 CLI 的一次性链接点开第二次');
    const openedAgain: string[] = await page.evaluate(() =>
      (window as unknown as { __opcOpenUrls: string[] }).__opcOpenUrls ?? []);
    eq(openedAgain, [LIVE_URL], '终态后没有再触发任何 window.open');
    await page.waitForTimeout(600);
    ok(probeCalls.length > before, '★ 成功后自动触发了重新探测（状态自己变绿）',
      `probeCalls=${probeCalls.length}`);
    ok(pageErrors.length === 0, '页面没有未捕获异常', pageErrors.slice(0, 2).join(' | '));

    const shotDir = path.join(ROOT, '.render-check', 'a222');
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'login-flow-succeeded.png') });
    await ctx.close();
  } catch (err) {
    ok(false, '[3] 浏览器层异常', String(err).slice(0, 900));
  } finally {
    if (browser) await browser.close().catch(() => {});
    staticServer.close();
  }
}

// ═══════════════════ [4] 真服务端路由 e2e ═══════════════════
group('4. 真服务端：两条端点没被通用路由吞掉');
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}
function killTree(child: ChildProcess): void {
  if (child.exitCode != null || !child.pid) return;
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}
const stubCli = path.join(TMP, 'stub-cli.cjs');
fs.writeFileSync(stubCli, 'process.stdin.resume(); setTimeout(() => process.exit(0), 150);\n');
let child: ChildProcess | null = null;
if (!FULL) {
  console.log('  · probe 模式：真服务端层跳过');
} else try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    '--require', path.join(ROOT, 'node_modules/tsx/dist/preflight.cjs'),
    '--import', 'file:///' + path.join(ROOT, 'node_modules/tsx/dist/loader.mjs').replace(/\\/g, '/'),
    path.join(ROOT, 'server/index.ts'),
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      OPC_DATA_DIR: E2E_DATA,
      OPC_CODEBUDDY_CLI: stubCli,
      OPC_SDK_SESSION_POOL: '0',
      NODE_ENV: 'test',
      NODE_OPTIONS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errLog = '';
  child.stderr?.on('data', d => { errLog += String(d); });
  child.stdout?.on('data', () => {});
  let ready = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try { if ((await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(1500) })).ok) { ready = true; break; } }
    catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  ok(ready, '★ 真服务端起来了（HTTP 探活，不认日志文案）', ready ? `:${port}` : errLog.slice(-200));
  if (ready) {
    // gemini 是 kind:'cli'；claude / codex / workbuddy 都是 kind:'sdk'，
    // 拿它们当反例会把一条真登录流起起来（真机那 10+ 个 pid 就是这么来的）。
    const statusRes = await fetch(`${base}/api/agents/gemini/login/status`);
    const statusBody = await statusRes.json() as { state?: string };
    ok(statusRes.status === 200 && statusBody.state === 'idle',
      '★★ GET /login/status 落在专用路由上（不是通用 /api/agents/:agentId 的 HTML 兜底）',
      `status=${statusRes.status} state=${statusBody.state}`);

    const startRes = await fetch(`${base}/api/agents/gemini/login/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const startBody = await startRes.json() as { error?: string };
    ok(startRes.status === 400 && /不支持浏览器登录流/.test(startBody.error ?? ''),
      '★ 非 SDK Agent 请求登录流被拒（不会为 CLI Agent 再起一个登录进程）',
      `status=${startRes.status}`);

    const missing = await fetch(`${base}/api/agents/no-such-agent/login/status`);
    ok(!missing.ok, '不存在的 Agent → 404（不是空 200 假装成功）', String(missing.status));

    const badId = await fetch(`${base}/api/agents/bad%20id!/login/status`);
    ok(!badId.ok, '非法 agentId → 不返回 200', String(badId.status));

    // 关键回归：这个 GET 以前用 SDK 默认 300 秒并偷偷起登录流。
    // 现在有显式 8 秒预算；真机上 SDK 自身还有一层 CLI 冷启动，实测 23 秒，
    // 所以给到 60 秒 —— 仍远小于旧的 300 秒，同时不被本机抖动判成假红。
    const t0 = Date.now();
    let answered = false;
    try {
      const r = await fetch(`${base}/api/check-login`, { signal: AbortSignal.timeout(60_000) });
      answered = r.ok || r.status === 500;
      await r.text();
    } catch { answered = false; }
    ok(answered, '★★ /api/check-login 不再挂 5 分钟（60 秒内有应答，旧实现 300 秒）',
      `${Date.now() - t0}ms`);
  }
} catch (err) {
  ok(false, '[4] 真服务端层异常', String(err).slice(0, 200));
} finally {
  if (child) killTree(child);
}

console.log(`\n=== A222 WorkBuddy 登录流：${pass}/${pass + fail} 通过 ===`);
if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail === 0 ? 0 : 1);
