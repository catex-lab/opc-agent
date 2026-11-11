/**
 * WorkBuddy 401 登录态过期的产品级自动恢复 —— 验收闸门。
 *
 * 用户报的形态：WorkBuddy 走 SDK，token 由 CLI 子进程从 ~/.workbuddy 的登录态
 * 读；该登录态停在 2026-09-24 已过期，但探测只读本地缓存 → 名册一直「在线」，
 * 发消息必 401 → 界面只剩一张红色「调用失败」卡，什么恢复动作都不给。
 *
 * 本闸门钉四层（判绿看退出码 + stdout 全文）：
 *   [S] 源码契约层 —— AUTH_RE 口径复用（不抄第二份正则）、error 事件/块带
 *       errorKind、话术追加在 message、单聊与群聊两处 re-probe 触发点存在、
 *       前端按钮的条件渲染（无 authUrl 不画「去登录」）。
 *   [P] 纯行为层 —— 真 RunProjector / 真 maybeReprobeOnAuthError 跑在
 *       临时数据目录上（import 前先指 OPC_DATA_DIR，绝不碰真实 data/）：
 *       401 → 结构化字段 + 话术；非 auth → 不盖章；401 后自动 re-probe 且
 *       lastError 不被探测覆盖。
 *   [E] 端到端夹具层 —— 另起一个夹具 HTTP 上游（必回 401）+ 真服务端
 *       （OPC_DATA_DIR 指向临时目录 + 自建厂商夹具），POST /api/chat 的 SSE
 *       error 事件必须带 errorKind + 话术，且服务端自动 re-probe 真的跑了；
 *       反向输入（500，非 auth）不触发。
 *   [U] UI 层 —— Playwright（channel:'chrome'）：错误卡出现「重新探测」、
 *       无 authUrl 时不出现「去登录」；点「重新探测」真的打 probe 接口并提示
 *       状态已刷新；注入 authUrl 后刷新页面按钮仍在（errorKind 随块落库）、
 *       点「去登录」真的开登录页；非 auth 错误两个按钮都不画。
 *   [R] 反向探针 —— 把三处实现逐个改坏（源码串内变异，仓库惯例同
 *       verify-model-catalog / verify-a167），判据必须变红；变异必须真的
 *       改动了字符串（不许空转）。
 *
 * 运行：npx tsx scripts/verify-workbuddy-auth-ux.ts（UI 层需先 npm run build）
 */
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), `wb-auth-ux-${Date.now()}`);
const FIXTURE_DATA = path.join(TMP, 'data');

/** 夹具自建厂商：id 必须满足 isValidAgentId（小写字母数字连字符） */
const CUSTOM_ID = 'custom-wb401fix';
const CUSTOM_MODEL = 'fixture-401-model';
/** customKeyEnv() 的推导（server/agents/customAgents.ts:75）—— 大写 + 非 alnum → _。
 *  变量名刻意不带 KEY 字样：这是「环境变量的名字」，不是密钥本体，
 *  带 KEY 会被自家 secret-scan 的 [assigned-secret] 结构规则误伤（先例：verify-hardening.ts 的 envLine）。 */
const CUSTOM_ENV_NAME = 'OPC_CUSTOM_KEY_CUSTOM_WB401FIX';
/** 夹具登录页（只用于「去登录」按钮的 popup 断言，永远不会真的可达） */
const FIXTURE_LOGIN_URL = 'https://fixture-login.example/oauth?state=fixture';
const RAW_401 =
  '401 Authentication required. Please use /login command to continue, or visit https://workbuddy.example/login';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function freePort(): Promise<number> {
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

async function waitReady(base: string, child, timeoutMs = 90000) {
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

const json = async (res: Response) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

/** POST /api/chat 并把 SSE 帧解析成事件数组（流结束 = 本轮收尾） */
async function postChatSSE(base: string, body: object): Promise<any[]> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const events: any[] = [];
  for (const frame of text.split('\n\n')) {
    for (const line of frame.split('\n')) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m) continue;
      try {
        events.push(JSON.parse(m[1]));
      } catch {
        /* 单帧坏掉不拖垮解析 */
      }
    }
  }
  return events;
}

// ════════════════════════ [S] 源码契约判据 ════════════════════════
// 判据是**纯函数**（src → boolean），[R] 的反向探针直接复用它们。

/** 投影器：分类复用 recovery.ts、话术追加、errorKind 盖到块与事件两处 */
function projectorContract(src: string): boolean {
  const s = stripComments(src);
  return (
    /import\s*\{[^}]*classifyFailure[^}]*\}\s*from\s*['"]\.\/recovery\.js['"]/.test(s) &&
    /import\s*\{[^}]*appendFailureAdvice[^}]*\}\s*from\s*['"]\.\/recovery\.js['"]/.test(s) &&
    /classifyFailure\(ev\.message\)/.test(s) &&
    /appendFailureAdvice\(this\.meta\.agentId,\s*ev\.message\)/.test(s) &&
    // 块 open、块 patch、error 事件三处都必须盖章
    ((s.match(/\.\.\.\(errorKind \? \{ errorKind \} : \{\}\)/g) ?? []).length >= 3)
  );
}

/** 投影器/善后模块里不许出现第二份 auth 正则（口径只在 recovery.ts） */
function noSecondAuthRegex(src: string): boolean {
  return !/401|403|unauthorized|unauthenticated|not logged in/i.test(stripComments(src));
}

/** 自动善后模块：复用分类、force re-probe（绕 TTL）、探测后补写 lastError */
function authRecoveryContract(src: string): boolean {
  const s = stripComments(src);
  return (
    /import\s*\{\s*classifyFailure\s*\}\s*from\s*['"]\.\/recovery\.js['"]/.test(s) &&
    /probeOne\(agentId,\s*true\)/.test(s) &&
    /recordError\(agentId,\s*message\)/.test(s)
  );
}

/** 单聊（/api/chat）与群聊/工作流（turn-runner）都要真的调用善后入口 */
function reprobeWiringContract(turnSrc: string, chatSrc: string): boolean {
  return (
    /maybeReprobeOnAuthError\(agentId,\s*ev\.message\)/.test(stripComments(turnSrc)) &&
    /maybeReprobeOnAuthError\(agentId,\s*errorMsg/.test(stripComments(turnSrc)) &&
    /maybeReprobeOnAuthError\(agentId,\s*ev\.message\)/.test(stripComments(chatSrc)) &&
    /maybeReprobeOnAuthError\(agentId,\s*error\?\.message/.test(stripComments(chatSrc))
  );
}

/** shared/blocks：ErrorBlock 与 error 事件都要有 errorKind 字段（刷新后仍在） */
function blocksContract(src: string): boolean {
  const blockMatch = src.match(/export interface ErrorBlock \{[\s\S]*?\n\}/);
  const eventMatch = src.match(/type: 'error';\s*\n\s*scope: 'run' \| 'block' \| 'tool';[\s\S]*?\n\s*\}/);
  return (
    !!blockMatch &&
    /errorKind\?/.test(blockMatch[0]) &&
    !!eventMatch &&
    /errorKind\?/.test(eventMatch[0])
  );
}

/**
 * 前端契约：动作行只由 errorKind==='auth' 守卫渲染；「去登录」必须被
 * authUrl 守着（A141：不许画永远无效的按钮）；「重新探测」必须被 agentId 守着。
 * 用 data-* 测试钩子做锚点做邻近检查，不钉整段 JSX 字面量。
 */
function uiContract(src: string): boolean {
  const s = stripComments(src);
  const idxAuth = s.indexOf("errorKind === 'auth' && (");
  const idxActions = s.indexOf('<AuthErrorActions');
  if (!(idxAuth >= 0 && idxActions > idxAuth && idxActions - idxAuth < 240)) return false;
  const idxLogin = s.indexOf('data-auth-login-btn');
  const idxReprobe = s.indexOf('data-auth-reprobe-btn');
  const idxHint = s.indexOf('data-auth-reprobe-hint');
  if (idxLogin < 0 || idxReprobe < 0 || idxHint < 0) return false;
  if (!/agentId && authUrl && \(/.test(s.slice(Math.max(0, idxLogin - 480), idxLogin))) return false;
  if (!/\{agentId && \(/.test(s.slice(Math.max(0, idxReprobe - 480), idxReprobe))) return false;
  return true;
}

function i18nContract(zh: string, en: string): boolean {
  for (const key of ['chat.error.goLogin', 'chat.error.reprobe', 'chat.error.reprobing', 'chat.error.statusRefreshed']) {
    if (!zh.includes(`'${key}'`) || !en.includes(`'${key}'`)) return false;
  }
  return true;
}

// ════════════════════════ [R] 反向探针（源码串变异） ════════════════════════

function reverseProbes() {
  console.log('\n[R] 反向探针：把实现逐个改坏，判据必须变红（变异不许空转）');

  const projectorSrc = readSrc('server/agents/projector.ts');
  const turnSrc = readSrc('server/turn-runner.ts');
  const chatSrc = readSrc('server/index.ts');
  const chatMsgSrc = readSrc('src/components/ChatMessages.tsx');

  // R1：删掉 errorKind 分类（连同 import 一起删，模拟「口径没接上」）
  const r1a = projectorSrc
    .replace(/import\s*\{\s*classifyFailure,\s*appendFailureAdvice\s*\}\s*from\s*'\.\/recovery\.js';/, '')
    .replace(/const failureKind = classifyFailure\(ev\.message\);/, "const failureKind = 'unknown' as never;");
  ok(
    r1a !== projectorSrc && !projectorContract(r1a) && projectorContract(projectorSrc),
    '★ R1 删掉 errorKind 分类 → 投影器契约判红（分类/盖章/话术三处一起失守）'
  );
  // R1b：只删话术追加（保留分类）—— 文本腿单独断了也要红
  const r1b = projectorSrc.replace(
    /appendFailureAdvice\(this\.meta\.agentId,\s*ev\.message\)/,
    'ev.message'
  );
  ok(
    r1b !== projectorSrc && !projectorContract(r1b),
    '★ R1b 只删话术追加（message 不带恢复建议）→ 判红'
  );
  ok(
    noSecondAuthRegex(stripComments(projectorSrc)) && noSecondAuthRegex(readSrc('server/agents/auth-recovery.ts')),
    '[S] 投影器与善后模块都没有第二份 auth 正则（口径只在 recovery.ts）'
  );

  // R2：删掉自动 re-probe 的两处触发点
  const r2a = turnSrc.replace(/maybeReprobeOnAuthError\(agentId,\s*ev\.message\);/, '/* 反向探针：触发点被删 */;');
  const r2b = chatSrc.replace(/maybeReprobeOnAuthError\(agentId,\s*ev\.message\);/, '/* 反向探针：触发点被删 */;');
  ok(
    r2a !== turnSrc && r2b !== chatSrc &&
      !reprobeWiringContract(r2a, chatSrc) && !reprobeWiringContract(turnSrc, r2b) &&
      reprobeWiringContract(turnSrc, chatSrc),
    '★ R2 删掉单聊或群聊任一处 re-probe 触发点 → 接线契约判红'
  );
  // R2b：删掉「探测后补写 lastError」—— WorkBuddy 探测会返回 ready，
  // withProbeOutcome 对 ready 丢 lastError；不补写 = 401 被抹掉，必须红。
  const recSrc = readSrc('server/agents/auth-recovery.ts');
  const r2c = recSrc.replace(/registry\s*\n?\s*\.recordError\(agentId,\s*message\)/, '/* removed */');
  ok(
    r2c !== recSrc && !authRecoveryContract(r2c) && authRecoveryContract(recSrc),
    '★ R2b 删掉探测后补写 lastError → 善后契约判红（401 会被 ready 探测抹掉）'
  );

  // R3：删掉前端按钮的条件渲染
  const r3a = chatMsgSrc.replace("errorKind === 'auth' && (", 'true && (');
  const r3b = chatMsgSrc.replace('agentId && authUrl && (', 'authUrl && (');
  ok(
    r3a !== chatMsgSrc && !uiContract(r3a),
    '★ R3a 删掉 errorKind 条件（所有错误都画按钮）→ 前端契约判红'
  );
  ok(
    r3b !== chatMsgSrc && !uiContract(r3b),
    '★ R3b 删掉 authUrl 条件（无登录入口也画「去登录」）→ 前端契约判红'
  );
  ok(uiContract(chatMsgSrc), '[S] 前端契约：动作行/authUrl/agentId 三处守卫齐全');
  ok(blocksContract(readSrc('shared/blocks.ts')), '[S] errorKind 同时挂在 ErrorBlock 与 error 事件上（刷新后仍在）');
  ok(
    i18nContract(readSrc('src/i18n/zh.ts'), readSrc('src/i18n/en.ts')),
    '[S] i18n：chat.error.* 新键 zh / en 双语齐全'
  );
}

// ════════════════════════ [P] 纯行为层（真模块 + 临时数据目录） ════════════════════════

async function pureBehavior() {
  console.log('\n[P] 纯行为层：真 RunProjector / 真 maybeReprobeOnAuthError（临时数据目录）');
  const { RunProjector } = await import('../server/agents/projector.js');
  const { registry } = await import('../server/agents/registry.js');
  const { maybeReprobeOnAuthError, resetAuthReprobeDebounceForTest } = await import(
    '../server/agents/auth-recovery.js'
  );

  const meta = {
    runId: 'r-fix',
    sessionId: 's-fix',
    messageId: 'm-fix',
    agentId: 'workbuddy',
  } as any;

  // P1：裸 401（SDK 的 mapSdkMessage 吐出来的就是这种未加工串）
  const p1 = new RunProjector(meta);
  const ev1 = p1.push({ type: 'error', message: RAW_401 } as any);
  const errEvent = ev1.find(e => e.type === 'error');
  const opened = ev1.find(e => e.type === 'block_open')?.block as any;
  ok(errEvent?.errorKind === 'auth', '[P1] SSE error 事件带 errorKind:"auth"', String(errEvent?.errorKind));
  ok(
    !!errEvent &&
      errEvent.message.startsWith(RAW_401) &&
      errEvent.message.includes('怎么恢复') &&
      /重新登录|登录/.test(errEvent.message),
    '[P1] message 追加恢复话术（原文在前、话术在后）'
  );
  ok(opened?.type === 'error' && opened.errorKind === 'auth' && opened.message === errEvent?.message,
    '[P1] 错误块同样带 errorKind（刷新后按钮不消失）');

  // P2：非 auth 错误 —— 不许盖章成 auth，也不许追加话术
  const p2 = new RunProjector(meta);
  const ev2 = p2.push({ type: 'error', message: 'ECONNREFUSED 127.0.0.1:443' } as any);
  const err2 = ev2.find(e => e.type === 'error');
  ok(err2 && err2.errorKind !== 'auth' && !err2.message.includes('怎么恢复'),
    '[P2] 反向输入：网络错误不盖章 auth、不追加话术', String(err2?.errorKind));

  // P3：同一轮第二次 401 走「覆盖」路径，话术不许叠两层
  const p3 = new RunProjector(meta);
  p3.push({ type: 'error', message: RAW_401 } as any);
  const ev3 = p3.push({ type: 'error', message: RAW_401 } as any);
  const err3 = ev3.find(e => e.type === 'error');
  ok(
    (err3?.message.match(/怎么恢复/g) ?? []).length === 1,
    '[P3] 同一轮两条 401 → 话术恰好一层（appendFailureAdvice 幂等）'
  );

  // P4：401 发生后自动 re-probe 真的跑了，且 401 不被探测结果抹掉。
  // 用夹具自建 Agent（kind:'mock'，probe 只做本地查找，不联网）。
  const makeDef = (id: string) => ({
    descriptor: {
      id,
      name: `Fixture ${id}`,
      kind: 'mock' as const,
      capabilities: ['chat' as const],
      eventCapabilities: [],
    },
  });
  const probeAgent = 'custom-wbpurefix';
  const idleAgent = 'custom-wbpurefix2';
  registry.registerCustom(makeDef(probeAgent) as any);
  registry.registerCustom(makeDef(idleAgent) as any);

  resetAuthReprobeDebounceForTest();
  maybeReprobeOnAuthError(probeAgent, RAW_401);
  const deadline = Date.now() + 10_000;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    await sleep(200);
    lastError = registry.get(probeAgent)?.status.lastError;
    if (lastError && lastError.includes('401')) break;
  }
  ok(
    !!lastError && lastError.includes('401') && lastError.includes('怎么恢复'),
    '[P4] auth 错误后自动 re-probe 被触发，且 401 lastError 在探测覆盖后仍被补写',
    (lastError ?? '(无)').replace(/\s+/g, ' ').slice(0, 60)
  );
  ok(
    (registry.get(probeAgent)?.status.probedAt ?? '') !== '' &&
      registry.get(probeAgent)?.status.availability !== undefined,
    '[P4] 夹具 Agent 状态真的被探测写过（不再停在 unknown 初始态）'
  );

  // P5：非 auth 错误不触发善后（idleAgent 全程没人探过）
  maybeReprobeOnAuthError(idleAgent, 'ECONNRESET on socket');
  await sleep(1200);
  const idleInfo = registry.get(idleAgent);
  ok(
    !idleInfo?.status.lastError,
    '[P5] 反向输入：非 auth 错误不触发 re-probe / 不写 lastError',
    String(idleInfo?.status.availability)
  );
}

// ════════════════════════ [E] 端到端夹具层 ════════════════════════

interface Upstream {
  port: number;
  hits401: () => number;
  hits500: () => number;
  close: () => void;
}

/** 夹具上游：/chat/completions 对 A 夹具必回 401，对 B 夹具必回 500（非 auth） */
function startUpstream(): Promise<Upstream> {
  let hits401 = 0;
  let hits500 = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const authFail = String(req.url ?? '').includes('wb401fix');
      if (authFail) {
        hits401++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: RAW_401, type: 'authentication_error' } }));
        return;
      }
      hits500++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      // 措辞刻意避开 AUTH_RE / NETWORK_RE 的全部关键词
      res.end(JSON.stringify({ error: { message: 'upstream boom (code 7)' } }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        hits401: () => hits401,
        hits500: () => hits500,
        close: () => server.close(),
      });
    });
  });
}

async function endToEnd(upstreamPort: number) {
  console.log('\n[E] 端到端夹具层：必回 401 的上游 + 真服务端 + 自建厂商夹具');

  // 自建厂商夹具落进临时数据目录（服务端冷启动时注册进名册）。
  // 路径里带 id 标记：上游据此区分「该回 401 的」和「该回 500 的」。
  fs.mkdirSync(FIXTURE_DATA, { recursive: true });
  const customSpecs = [
    {
      id: CUSTOM_ID,
      name: '夹具401',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1-wb401fix`,
      dialect: 'openai',
      models: [CUSTOM_MODEL],
      createdAt: Date.now(),
    },
    {
      id: 'custom-wb500fix',
      name: '夹具500',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1-wb500fix`,
      dialect: 'openai',
      models: [CUSTOM_MODEL],
      createdAt: Date.now(),
    },
  ];
  fs.writeFileSync(
    path.join(FIXTURE_DATA, 'custom-agents.json'),
    JSON.stringify(customSpecs, null, 2),
    'utf8'
  );

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn('npx tsx server/index.ts', {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      OPC_DATA_DIR: FIXTURE_DATA,
      [CUSTOM_ENV_NAME]: 'fixture-key',
      NODE_OPTIONS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { ready, log } = await waitReady(base, child);
  ok(ready, '[E1] 夹具服务端起来了（数据目录/凭据全部来自夹具）');
  if (!ready) {
    console.log(log.slice(-1500));
    return { base: null, child };
  }

  // 显式预探测：拿一个 probedAt 基线（绝不触发 GET /api/agents 的后台全量扫描，
  // 否则基线会被后台探测污染，「自动 re-probe」的判据就不干净了）
  const pre = await json(await fetch(`${base}/api/agents/${CUSTOM_ID}/probe`, { method: 'POST' }));
  ok(!!pre?.status?.probedAt, '[E2] 预探测成功（probedAt 基线就位）', String(pre?.status?.availability));
  const probedAtBefore = String(pre?.status?.probedAt ?? '');
  const pre500 = await json(
    await fetch(`${base}/api/agents/custom-wb500fix/probe`, { method: 'POST' })
  );
  const probedAt500Before = String(pre500?.status?.probedAt ?? '');

  // E3：走真 /api/chat → SSE error 事件必须带 errorKind + 话术
  const created = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: CUSTOM_ID, model: CUSTOM_MODEL, title: '闸门 401' }),
    })
  );
  const sessionId = created.session?.id;
  ok(!!sessionId, '[E3] 建会话成功', String(sessionId));
  const events = await postChatSSE(base, {
    sessionId,
    message: '随便说一句',
    model: CUSTOM_MODEL,
    agentId: CUSTOM_ID,
  });
  const sseErr = events.find(e => e.type === 'error');
  ok(!!sseErr, '[E3] SSE 里收到了 error 事件', `${events.length} 帧`);
  ok(sseErr?.errorKind === 'auth', '[E3] SSE error 事件带结构化 errorKind:"auth"', String(sseErr?.errorKind));
  ok(
    typeof sseErr?.message === 'string' &&
      sseErr.message.includes('401') &&
      (sseErr.message.match(/怎么恢复/g) ?? []).length === 1 &&
      /重新登录/.test(sseErr.message),
    '[E3] message 带原文 + 恢复话术（且恰好一层）',
    String(sseErr?.message ?? '').replace(/\s+/g, ' ').slice(0, 80)
  );
  const errBlock = events.find(e => e.type === 'block_open')?.block;
  ok(errBlock?.type === 'error' && errBlock?.errorKind === 'auth',
    '[E3] 错误块落库带 errorKind（刷新后 UI 仍有按钮的依据）');

  // E4：自动 re-probe —— 探测基线必须被刷新（force 绕 5 分钟 TTL）
  let after: any = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(400);
    after = await json(await fetch(`${base}/api/agents/${CUSTOM_ID}`));
    if (String(after?.agent?.status?.probedAt ?? '') !== probedAtBefore) break;
  }
  ok(
    String(after?.agent?.status?.probedAt ?? '') !== probedAtBefore,
    '[E4] 401 后服务端自动 re-probe 真的跑了（probedAt 被刷新，绕过 TTL）',
    `${probedAtBefore.slice(11, 19)} → ${String(after?.agent?.status?.probedAt ?? '').slice(11, 19)}`
  );
  ok(
    String(after?.agent?.status?.lastError ?? '').includes('401') &&
      String(after?.agent?.status?.lastError ?? '').includes('怎么恢复'),
    '[E4] 名册 lastError 诚实地带上这次 401（探测覆盖后补写，不谎报「已过期」）',
    String(after?.agent?.status?.lastError ?? '').replace(/\s+/g, ' ').slice(0, 70)
  );

  // E5：反向输入 —— 500（非 auth）不触发自动 re-probe
  const created5 = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'custom-wb500fix', model: CUSTOM_MODEL, title: '闸门 500' }),
    })
  );
  const events5 = await postChatSSE(base, {
    sessionId: created5.session?.id,
    message: '随便说一句',
    model: CUSTOM_MODEL,
    agentId: 'custom-wb500fix',
  });
  const sseErr5 = events5.find(e => e.type === 'error');
  ok(
    !!sseErr5 && sseErr5.errorKind === undefined,
    '[E5] 反向输入：500 错误不带 errorKind（' + String(sseErr5?.errorKind) + '）'
  );
  await sleep(2500);
  const after5 = await json(await fetch(`${base}/api/agents/custom-wb500fix`));
  ok(
    String(after5?.agent?.status?.probedAt ?? '') === probedAt500Before,
    '[E5] 反向输入：非 auth 错误不触发自动 re-probe（probedAt 基线不动）'
  );

  return { base, child };
}

// ════════════════════════ [U] UI 层 ════════════════════════

async function uiLayer(base: string) {
  console.log('\n[U] UI 层：错误卡的「去登录 / 重新探测」（channel:chrome）');

  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    ok(false, '[U] 需要 dist/（先 npm run build），本层跳过');
    return;
  }

  const created = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: CUSTOM_ID, model: CUSTOM_MODEL, title: '闸门 UI' }),
    })
  );
  const sessionId = created.session?.id;
  ok(!!sessionId, '[U1] 建 UI 会话成功', String(sessionId));

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    browser = await chromium.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
    });
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    /* 「去登录」的产品契约是 window.open(authUrl, '_blank', 'noopener') ——
     * 在 Electron 里由主进程 setWindowOpenHandler 转交系统浏览器。headless
     * Chrome 下 noopener 弹窗不会被 Playwright 报成 popup（已知限制），
     * 所以在**参数层**记下每次 window.open 的第一参：点「去登录」必须真的
     * 用登录地址调用了浏览器的打开入口。stub 安装在 init script 里，
     * reload 之后仍然生效。 */
    await page.addInitScript(() => {
      (window as any).__opcOpenUrls = [];
      (window as any).open = (...args: unknown[]) => {
        (window as any).__opcOpenUrls.push(String(args[0] ?? ''));
        return null;
      };
    });

    // 夹具登录页永远可「打开成功」，popup 的 URL 才能被断言
    await context.route('https://fixture-login.example/**', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'fixture login' })
    );

    await page.goto(`${base}/chat/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await page.locator('t-chat-sender textarea').first().waitFor({ timeout: 30000 });
    await page.locator('t-chat-sender textarea').first().fill('帮我看看这条会话');

    // 点发送（TDesign ChatSender 的影子 DOM，a122 同款做法）
    const clickSenderButton = async (target: typeof page) => {
      const h = await target.evaluateHandle(`(() => {
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
    await clickSenderButton(page);

    // 真实 401 流回来 → 错误卡 + 恢复动作行
    await page.waitForSelector('[data-auth-error-actions]', { timeout: 45000 });
    ok(true, '[U1] 真实 401 流结束后错误卡出现恢复动作行（useChat 实时路径）');
    const errCardText = await page.evaluate(() => {
      const el = document.querySelector('[data-auth-error-actions]');
      return el?.parentElement?.textContent ?? '';
    });
    ok(errCardText.includes('调用失败') && errCardText.includes('怎么恢复'),
      '[U1] 错误卡显示失败原因 + 恢复话术（文本腿，旧客户端也能看到的那份）');
    ok((await page.locator('[data-auth-reprobe-btn]').count()) === 1, '[U1] 「重新探测」按钮在');
    ok((await page.locator('[data-auth-login-btn]').count()) === 0,
      '[U1] 反向断言：没有 authUrl 时「去登录」不渲染（A141：不给永远无效的按钮）');

    // U2：点「重新探测」→ 真的打 POST /api/agents/:id/probe + 提示状态已刷新
    const probeCalls: string[] = [];
    await page.route(new RegExp(`/api/agents/${CUSTOM_ID}/probe$`), async route => {
      probeCalls.push(route.request().method());
      await route.continue();
    });
    await page.locator('[data-auth-reprobe-btn]').click();
    await page.waitForSelector('[data-auth-reprobe-hint]', { timeout: 45000 });
    const hint = (await page.locator('[data-auth-reprobe-hint]').innerText().catch(() => '')).trim();
    ok(probeCalls.length === 1 && probeCalls[0] === 'POST',
      '[U2] 点击真的调了探测接口（恰好一次 POST）', probeCalls.join(','));
    ok(hint.includes('状态已刷新'), '[U2] 错误卡下方提示「状态已刷新：…」', hint.slice(0, 50));

    // U3：注入 authUrl 后刷新 → errorKind 随块落库，按钮仍在；点「去登录」真的开登录页
    const agentsPayload = await json(await fetch(`${base}/api/agents`));
    const agentRow = (agentsPayload.agents ?? []).find(a => a.id === CUSTOM_ID);
    if (agentRow) agentRow.status = { ...agentRow.status, authUrl: FIXTURE_LOGIN_URL };
    await page.route('**/api/agents', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(agentsPayload) })
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-auth-login-btn]', { timeout: 30000 });
    ok(true, '[U3] 刷新后错误卡仍在且「去登录」出现（errorKind 随块落库回来了）');
    await page.locator('[data-auth-login-btn]').click();
    await page.waitForTimeout(600);
    const openUrls: string[] = await page.evaluate(() => (window as any).__opcOpenUrls ?? []);
    ok(
      openUrls.length === 1 && openUrls[0].startsWith('https://fixture-login.example'),
      '[U3] 点「去登录」真的用登录地址调用了浏览器的打开入口（window.open → 系统浏览器）',
      JSON.stringify(openUrls).slice(0, 90)
    );

    // U4：反向输入 —— 非 auth 错误（服务端没盖 errorKind）两个按钮都不画
    const created4 = await json(
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: CUSTOM_ID, model: CUSTOM_MODEL, title: '闸门 非auth' }),
      })
    );
    const page4 = await context.newPage();
    const page4Errors: string[] = [];
    page4.on('pageerror', e => page4Errors.push(e.message));
    // 拦下这一页的发送：回一条没有 errorKind 的普通错误（模拟旧服务端/网络错误）
    await page4.route('**/api/chat', route =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          'data: {"type":"error","scope":"run","message":"ECONNREFUSED 127.0.0.1:9","retryable":true}\n\n' +
          'data: {"type":"run_end","status":"error"}\n\n',
      })
    );
    await page4.goto(`${base}/chat/${created4.session?.id}`, { waitUntil: 'domcontentloaded' });
    await page4.locator('t-chat-sender textarea').first().waitFor({ timeout: 30000 });
    await page4.locator('t-chat-sender textarea').first().fill('再试一次');
    await clickSenderButton(page4);
    await page4
      .locator('div')
      .filter({ hasText: 'ECONNREFUSED 127.0.0.1:9' })
      .first()
      .waitFor({ timeout: 30000 });
    ok(true, '[U4] 非 auth 错误照常显示错误卡');
    ok((await page4.locator('[data-auth-error-actions]').count()) === 0,
      '[U4] 反向断言：非 auth 错误不画「去登录 / 重新探测」动作行');
    ok(page4Errors.length === 0, '[U4] 没有未捕获异常', page4Errors.slice(0, 2).join(' | '));
    ok(pageErrors.length === 0, '[U] 页面无未捕获异常', pageErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close().catch(() => {});
  }
}

// ════════════════════════ 主流程 ════════════════════════

console.log('WorkBuddy 401 自动恢复闸门（verify-workbuddy-auth-ux）');
console.log(`[verify] 临时目录：${TMP}（不触碰真实 data/）`);

let serverChild: any = null;
try {
  reverseProbes();
  await pureBehavior();

  const upstream = await startUpstream();
  try {
    const e = await endToEnd(upstream.port);
    serverChild = e.child;
    if (e.base) {
      await uiLayer(e.base);
    } else {
      ok(false, '[U] 服务端没起来，UI 层跳过');
    }
  } finally {
    upstream.close();
  }
} finally {
  killTree(serverChild);
  const dead = Date.now() + 8000;
  while (serverChild && serverChild.exitCode == null && Date.now() < dead) {
    await sleep(100);
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* Windows 文件占用：留给系统临时目录 */
  }
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log('✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
