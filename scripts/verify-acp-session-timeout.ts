/**
 * ACP「session/new 超时自愈」验证（Hermes gateway 挂死事故的产品级修复）。
 *
 * 要防的回归：
 *   1. session/new / initialize 超时后，挂死进程不被杀、rpc 不重置 ——
 *      旧实现每次重试都复用它再拖满默认超时（现产品默认 90 秒），用户干等一轮超时才得到一句死板报错；
 *   2. 自愈重建后必须真的能建出会话（换新进程要能正常回包）；
 *   3. 重试预算必须锁死在 1：第二次仍超时就收进程 + 报诚实文案，
 *      绝不允许「无限重试把用户拖死」。
 *
 * 手法：内嵌一个假 ACP 服务端（stdio JSON-RPC，行为由 mode.txt 控制：
 * `ok` / `hang-new`（session/new 永不回复，进程保持存活）/ `hang-init`），
 * 每次启动向 launches.jsonl 登记 pid。适配器超时注入成 ~1.5s（真实默认
 * 90 秒由 [D] 组钉住），全程不碰网络、不碰真实 data/。
 *
 * 跑法：
 *   npx tsx scripts/verify-acp-session-timeout.ts
 *
 * 反向探针（每条都要「真变红」才算数；跑完改回 = 正常模式回到全绿）：
 *   npx tsx scripts/verify-acp-session-timeout.ts --probe no-kill
 *     → 删掉「超时后杀进程」（destroyConnection 打成 no-op）→ pid 不退出 / 不重建判红
 *   npx tsx scripts/verify-acp-session-timeout.ts --probe no-retry
 *     → 删掉「重建重试」（预算改 0）→ 不重建、文案不含「已自动重启」判红
 *   npx tsx scripts/verify-acp-session-timeout.ts --probe infinite-budget
 *     → 预算改无限 → send 永不结束、进程越拉越多判红
 *   探针模式退出码：0 = 预期判红坐实；3 = 探针失效（fix 拆了却没变红，闸门白搭）。
 *
 * 判绿口径：退出码 0 + stdout 全文（不解析中间产物）。
 */
import './lib/temp-data-dir.js'; // 必须第一个 import：绝不碰真实 data/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AcpAdapter } from '../server/agents/adapters/acp.js';
import type { AgentDefinition } from '../server/agents/definitions.js';
import type { AgentEvent, SendContext } from '../server/agents/types.js';

let pass = 0;
let fail = 0;
function say(id: string, name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✓ [${id}] ${name}${detail ? `  [${detail}]` : ''}`); }
  else { fail++; console.log(`  ✗ [${id}] ${name}${detail ? `  [${detail}]` : ''}`); }
}

// ============= 假 ACP 服务端 =============
//
// initialize → 回 agentInfo（hang-init 模式下永不回复）；
// session/new → 回 sessionId + models（hang-new 模式下永不回复）；
// session/prompt → 发一条 text chunk 通知，然后正常回包结束。
// 挂死 = 「永不回复但进程保持存活」，正是实测事故里 gateway 的行为。
// 每次启动登记 pid 到 launches.jsonl，供断言「拉起几个进程 / pid 已退出」。
const FAKE_SERVER = `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = process.env.FAKE_ACP_DIR || '.';
try {
  fs.appendFileSync(path.join(dir, 'launches.jsonl'), JSON.stringify({ pid: process.pid, t: Date.now() }) + '\\n');
} catch {}

let mode = 'ok';
try { mode = fs.readFileSync(path.join(dir, 'mode.txt'), 'utf8').trim(); } catch {}
let sessionSeq = 0;

function send(obj) { try { process.stdout.write(JSON.stringify(obj) + '\\n'); } catch {} }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'initialize') {
    if (mode === 'hang-init') return; // 永不回复，进程保持存活
    respond(msg.id, { protocolVersion: 1, agentInfo: { name: 'fake-hermes', version: '1.0.0-test' } });
    return;
  }
  if (msg.method === 'session/new') {
    if (mode === 'hang-new') return; // 永不回复，进程保持存活（复现 gateway 挂死）
    sessionSeq += 1;
    respond(msg.id, {
      sessionId: 'fake-session-' + process.pid + '-' + sessionSeq,
      models: { availableModels: [{ modelId: 'fake-model', name: 'Fake Model' }] },
    });
    return;
  }
  if (msg.method === 'session/prompt') {
    notify('session/update', {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    });
    respond(msg.id, { stopReason: 'end_turn', usage: { totalTokens: 5 } });
    return;
  }
  if (msg.method === 'session/request_permission') {
    respond(msg.id, { outcome: { outcome: 'cancelled' } });
    return;
  }
  // session/cancel 等：忽略 —— 挂死的进程不会因为收到 cancel 就活过来
});
`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-acp-timeout-'));
const serverJs = path.join(tmpDir, 'fake-hermes-acp.mjs');
fs.writeFileSync(serverJs, FAKE_SERVER, 'utf8');
process.env.FAKE_ACP_DIR = tmpDir; // 适配器 spawn 时透传 process.env，假服务端靠它找目录

const launchesPath = path.join(tmpDir, 'launches.jsonl');
const modePath = path.join(tmpDir, 'mode.txt');

function setMode(mode: 'ok' | 'hang-new' | 'hang-init'): void {
  fs.writeFileSync(modePath, mode, 'utf8');
}
function readLaunches(): number[] {
  if (!fs.existsSync(launchesPath)) return [];
  return fs
    .readFileSync(launchesPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return (JSON.parse(line) as { pid: number }).pid; } catch { return -1; }
    })
    .filter(pid => pid > 0);
}
function resetLaunches(): void {
  fs.writeFileSync(launchesPath, '', 'utf8');
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitPidDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await sleep(150);
  }
  return !pidAlive(pid);
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 兜底清理：把 launches.jsonl 里登记过的 pid 全部按树杀掉，不留测试进程 */
function killAllLaunched(): void {
  for (const pid of readLaunches()) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch { /* 已经退了 */ }
  }
}

// .mjs 直接作为 command：resolveLaunchTarget 对 .(c|m)js 会自动用 node 跑，
// 不需要 .cmd 垫片（与 sealed 分支 verify-acp-crash.ts 同一手法）。
function buildDef(): AgentDefinition {
  return {
    descriptor: {
      id: 'fake-hermes',
      name: 'Fake Hermes',
      vendor: 'test',
      kind: 'acp',
      capabilities: ['chat'],
      eventCapabilities: [],
      description: 'test',
      color: '#000',
      command: serverJs,
      installHint: '',
    },
  } as AgentDefinition;
}

function makeCtx(sessionId: string): SendContext {
  return {
    sessionId,
    prompt: 'hi',
    cwd: tmpDir,
    model: 'fake-model',
    systemPrompt: '',
    allowedTools: [],
  };
}

const INJECTED_TIMEOUT = 1500;
const WATCHDOG_MS = 20_000;

interface CollectResult {
  events: AgentEvent[];
  /** 看门狗到点还没结束（= send 挂住，自愈预算失控的第一信号） */
  timedOut: boolean;
  elapsedMs: number;
}

async function collect(adapter: AcpAdapter, ctx: SendContext, watchdogMs: number): Promise<CollectResult> {
  const events: AgentEvent[] = [];
  let timedOut = false;
  const t0 = Date.now();
  // 看门狗：到点先 dispose（杀当前进程 → 挂着的请求以「进程退出」落错 →
  // 生成器收尾），保证测试进程自己一定能退出去。
  const watchdog = setTimeout(() => { timedOut = true; adapter.dispose(); }, watchdogMs);
  try {
    for await (const ev of adapter.send(ctx)) events.push(ev);
  } catch (err) {
    events.push({ type: 'error', message: (err as Error).message });
  } finally {
    clearTimeout(watchdog);
  }
  return { events, timedOut, elapsedMs: Date.now() - t0 };
}

function errorMessage(events: AgentEvent[]): string {
  const e = events.find(x => x.type === 'error') as { message?: string } | undefined;
  return e?.message ?? '';
}

// 反向探针用的补丁位：destroyConnection 是「超时后杀进程」的实现点，
// 原型方法在运行期可替换（TS 的 private 只是编译期概念）。
const PROTO = AcpAdapter.prototype as unknown as Record<string, unknown>;
const ORIGINAL_DESTROY = PROTO.destroyConnection as (...args: unknown[]) => void;

// ============= 反向探针 =============
//
// 每条探针把修复的一项关键行为临时「拆掉」，跑同一组 [A] 断言，
// 指定的哨兵断言必须真变红 —— 否则说明闸门根本钉不住这个行为。

interface ProbeResult { checks: Map<string, boolean>; pids: number[]; elapsedMs: number; timedOut: boolean }

async function runScenarioA(mutation: (adapter: AcpAdapter) => void): Promise<ProbeResult> {
  setMode('hang-new');
  resetLaunches();
  const adapter = new AcpAdapter(buildDef(), { requestTimeoutMs: INJECTED_TIMEOUT, initTimeoutMs: INJECTED_TIMEOUT });
  mutation(adapter);
  const { events, timedOut, elapsedMs } = await collect(adapter, makeCtx('sess-probe'), WATCHDOG_MS);
  const message = errorMessage(events);
  const pids = readLaunches();
  const checks = new Map<string, boolean>([
    ['A1', !timedOut], // send 在看门狗内结束
    ['A4', message.includes('已自动重启')], // 文案诚实说明做过自愈
    ['A7', pids.length === 2], // 自愈重建恰好发生一次
    ['A9', pids[0] !== undefined && await waitPidDead(pids[0])], // 原连接进程已被杀
  ]);
  adapter.dispose();
  return { checks, pids, elapsedMs, timedOut };
}

async function runProbe(
  name: string,
  mutation: (adapter: AcpAdapter) => void,
  sentinels: string[]
): Promise<boolean> {
  console.log(`  … 反向探针 ${name}：哨兵 ${sentinels.join(' / ')} 预期判红`);
  const result = await runScenarioA(mutation);
  const red = sentinels.filter(s => result.checks.get(s) === false);
  const stillGreen = sentinels.filter(s => result.checks.get(s) !== false);
  for (const s of red) console.log(`    ✓ 探针生效：[${s}] 如预期变红`);
  for (const s of stillGreen) console.log(`    ✗ 探针失效：[${s}] 仍然绿`);
  console.log(`    … 进程拉起 ${result.pids.length} 个，elapsed=${result.elapsedMs}ms, timedOut=${result.timedOut}`);
  return red.length > 0;
}

if (process.argv.includes('--probe')) {
  const probeName = process.argv[process.argv.indexOf('--probe') + 1] ?? '';
  console.log(`[probe] 反向探针模式：${probeName}`);
  let red = false;
  switch (probeName) {
    case 'no-kill':
      // 拆掉「超时后杀进程」：destroyConnection 打成 no-op —— 旧实现的致命行为
      red = await runProbe('no-kill', () => {
        PROTO.destroyConnection = function () { /* 什么都不做：不杀树、不重置 */ };
      }, ['A7', 'A9']);
      break;
    case 'no-retry':
      // 拆掉「重建重试」：预算改成 0 —— 退回「超时即报错、不自动恢复」
      red = await runProbe('no-retry', adapter => {
        (adapter as unknown as { retryBudget: number }).retryBudget = 0;
      }, ['A4', 'A7']);
      break;
    case 'infinite-budget':
      // 预算改成无限 —— 「无限重试把用户拖死」必须被预算锁死
      red = await runProbe('infinite-budget', adapter => {
        (adapter as unknown as { retryBudget: number }).retryBudget = Number.POSITIVE_INFINITY;
      }, ['A1', 'A7']);
      break;
    default:
      console.log(`  ✗ 未知探针：${probeName}（可选 no-kill | no-retry | infinite-budget）`);
      process.exit(3);
  }
  killAllLaunched();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  if (red) {
    console.log(`\n[probe] ${probeName}: 判红坐实 —— 闸门钉得住该行为。退出码 0。`);
    process.exit(0);
  }
  console.log(`\n[probe] ${probeName}: 探针失效（拆掉修复后哨兵仍绿）—— 闸门是摆设。退出码 3。`);
  process.exit(3);
}

// ============= [D] 超时可注入：默认 90 秒 + 两种注入口 =============
console.log('[D] 超时注入面（默认 90 秒 / options / 环境变量）');
{
  const plain = new AcpAdapter(buildDef()) as unknown as { requestTimeoutMs: number; initTimeoutMs: number };
  say('D1', '默认 requestTimeoutMs 是 90 秒（产品默认值）', plain.requestTimeoutMs === 90 * 1000, `got=${plain.requestTimeoutMs}`);
  say('D2', '默认 initTimeoutMs 仍是 60s', plain.initTimeoutMs === 60_000, `got=${plain.initTimeoutMs}`);

  const injected = new AcpAdapter(buildDef(), { requestTimeoutMs: INJECTED_TIMEOUT, initTimeoutMs: INJECTED_TIMEOUT }) as unknown as { requestTimeoutMs: number; initTimeoutMs: number };
  say('D3', '构造 options 可注入短超时', injected.requestTimeoutMs === INJECTED_TIMEOUT && injected.initTimeoutMs === INJECTED_TIMEOUT, `got=${injected.requestTimeoutMs}/${injected.initTimeoutMs}`);

  const prevEnv = process.env.OPC_ACP_REQUEST_TIMEOUT_MS;
  process.env.OPC_ACP_REQUEST_TIMEOUT_MS = '2500';
  const viaEnv = new AcpAdapter(buildDef()) as unknown as { requestTimeoutMs: number };
  say('D4', '环境变量 OPC_ACP_REQUEST_TIMEOUT_MS 可注入', viaEnv.requestTimeoutMs === 2500, `got=${viaEnv.requestTimeoutMs}`);

  process.env.OPC_ACP_REQUEST_TIMEOUT_MS = 'not-a-number';
  const badEnv = new AcpAdapter(buildDef()) as unknown as { requestTimeoutMs: number };
  say('D5', '非法环境变量回落默认（不能变成永不超时）', badEnv.requestTimeoutMs === 90 * 1000, `got=${badEnv.requestTimeoutMs}`);
  if (prevEnv === undefined) delete process.env.OPC_ACP_REQUEST_TIMEOUT_MS;
  else process.env.OPC_ACP_REQUEST_TIMEOUT_MS = prevEnv;
}

// ============= [S] 基线：健康 gateway 一切照旧（否定式配肯定式） =============
console.log('[S] 基线：session/new 正常回包时行为不变');
{
  let okAdapter: AcpAdapter | null = null;
  try {
    setMode('ok');
    resetLaunches();
    okAdapter = new AcpAdapter(buildDef(), { requestTimeoutMs: INJECTED_TIMEOUT, initTimeoutMs: INJECTED_TIMEOUT });
    const { events, timedOut, elapsedMs } = await collect(okAdapter, makeCtx('sess-ok'), WATCHDOG_MS);
    const types = events.map(e => e.type);
    say('S1', '正常路径收到 init/text/done', types.includes('init') && types.includes('text') && types.includes('done'), `types=${types.join(',')}`);
    say('S2', '正常路径没有 error 事件', !types.includes('error'), errorMessage(events).slice(0, 80));
    say('S3', '只拉起 1 个进程（不多不少）', readLaunches().length === 1, `launches=${readLaunches().length}`);
    say('S4', '正常路径不引入额外等待（< 5s）', !timedOut && elapsedMs < 5000, `elapsed=${elapsedMs}ms`);
    say('S5', 'session/new 的模型清单进入 availableModels', okAdapter.availableModels.length > 0, `models=${okAdapter.availableModels.length}`);
  } finally {
    okAdapter?.dispose();
  }
}

// ============= [A] session/new 挂死 → 自愈 → 重试仍挂死 → 诚实文案 + 树被杀 + 预算=1 =============
console.log('[A] session/new 超时：杀树重建重试一次，第二次仍超时才报错');
let aPids: number[] = [];
{
  let aAdapter: AcpAdapter | null = null;
  try {
    setMode('hang-new');
    resetLaunches();
    aAdapter = new AcpAdapter(buildDef(), { requestTimeoutMs: INJECTED_TIMEOUT, initTimeoutMs: INJECTED_TIMEOUT });

    const { events, timedOut, elapsedMs } = await collect(aAdapter, makeCtx('sess-hang'), WATCHDOG_MS);
    const message = errorMessage(events);
    const types = events.map(e => e.type);
    aPids = readLaunches();

    say('A1', 'send 在看门狗内结束（没有挂死测试进程）', !timedOut, `elapsed=${elapsedMs}ms`);
    say('A2', '注入生效：全程两个超时窗口（~3s 量级），不是秒拒也不是产品默认 90 秒',
      elapsedMs >= 2 * INJECTED_TIMEOUT && elapsedMs < 15_000, `elapsed=${elapsedMs}ms`);
    say('A3', '收到 error 事件（且没有 init —— 会话没建出来）', types.includes('error') && !types.includes('init'), `types=${types.join(',')}`);
    say('A4', '文案含「已自动重启」（诚实说明做过自愈）', message.includes('已自动重启'), message.slice(0, 90));
    say('A5', '文案含「重启 Hermes 桌面端」（唯一剩下的动作，可执行）', message.includes('重启 Hermes 桌面端'), message.slice(0, 90));
    say('A6', '文案不再是旧的一句死板「创建 ACP 会话失败」', !message.includes('创建 ACP 会话失败'), message.slice(0, 90));
    say('A7', '自愈重建恰好发生一次（拉起 2 个进程）', aPids.length === 2, `launches=${aPids.length}`);
    // 反向断言：预算耗尽后必须安静 —— 第三次进程绝不允许被拉起来
    await sleep(2500);
    say('A8', '报错后不再自动重建（2.5s 后仍是 2 个进程 = 预算 1）', readLaunches().length === 2, `launches=${readLaunches().length}`);
    const dead1 = aPids[0] !== undefined && await waitPidDead(aPids[0]);
    const dead2 = aPids[1] !== undefined && await waitPidDead(aPids[1]);
    say('A9', '第一个进程（原连接）整棵树已被杀', dead1, `pid=${aPids[0] ?? 'N/A'} alive=${aPids[0] !== undefined ? pidAlive(aPids[0]) : 'N/A'}`);
    say('A10', '第二个进程（重建的连接）也已被杀，不留挂死进程', dead2, `pid=${aPids[1] ?? 'N/A'} alive=${aPids[1] !== undefined ? pidAlive(aPids[1]) : 'N/A'}`);
  } finally {
    // 补丁位还原（正常模式没有补丁，这里保证探针后跑也干净）
    PROTO.destroyConnection = ORIGINAL_DESTROY;
    aAdapter?.dispose();
  }
}

// ============= [B] 同一适配器自愈后：下一次 send 用全新进程建会话成功 =============
console.log('[B] 自愈后同一适配器换全新进程正常工作');
{
  let bAdapter: AcpAdapter | null = null;
  try {
    setMode('ok');
    bAdapter = new AcpAdapter(buildDef(), { requestTimeoutMs: INJECTED_TIMEOUT, initTimeoutMs: INJECTED_TIMEOUT });
    const { events, timedOut } = await collect(bAdapter, makeCtx('sess-ok2'), WATCHDOG_MS);
    const types = events.map(e => e.type);
    const pids = readLaunches();
    const text = events.find(e => e.type === 'text') as { content?: string } | undefined;

    say('B1', '收到 init/text/done（全新进程能正常建会话并回包）', types.includes('init') && types.includes('text') && types.includes('done'), `types=${types.join(',')}`);
    say('B2', '没有 error 事件', !types.includes('error'), errorMessage(events).slice(0, 80));
    say('B3', '拉起的是全新进程（pid 与 [A] 的两个都不同）',
      pids.length === 3 && pids[2] !== aPids[0] && pids[2] !== aPids[1], `pids=${pids.join(',')}`);
    say('B4', '文本内容来自新进程（hello）', text?.content === 'hello', `text=${String(text?.content)}`);
    const sessions = (bAdapter as unknown as { acpSessions: Map<string, string> }).acpSessions;
    const mapped = sessions.get('sess-ok2') ?? '';
    say('B5', '会话映射指向新进程的 sessionId（内嵌新 pid）',
      mapped.includes(String(pids[2] ?? '')), `mapped=${mapped}`);
  } finally {
    bAdapter?.dispose();
  }
}

// ============= [C] initialize 挂死 → 同样自愈（覆盖握手路径） =============
console.log('[C] initialize 超时：同样杀树重建重试一次');
{
  let cAdapter: AcpAdapter | null = null;
  try {
    setMode('hang-init');
    resetLaunches();
    cAdapter = new AcpAdapter(buildDef(), { requestTimeoutMs: INJECTED_TIMEOUT, initTimeoutMs: INJECTED_TIMEOUT });
    const { events, timedOut, elapsedMs } = await collect(cAdapter, makeCtx('sess-init-hang'), WATCHDOG_MS);
    const message = errorMessage(events);
    const pids = readLaunches();

    say('C1', 'send 在看门狗内结束', !timedOut, `elapsed=${elapsedMs}ms`);
    say('C2', '收到 error 事件', events.some(e => e.type === 'error'), `events=${events.map(e => e.type).join(',')}`);
    say('C3', '文案含「已自动重启」（initialize 也走了自愈）', message.includes('已自动重启'), message.slice(0, 90));
    say('C4', '自愈重建恰好发生一次（拉起 2 个进程）', pids.length === 2, `launches=${pids.length}`);
    const dead1 = pids[0] !== undefined && await waitPidDead(pids[0]);
    const dead2 = pids[1] !== undefined && await waitPidDead(pids[1]);
    say('C5', '两个进程都已被杀', dead1 && dead2, `pids=${pids.join(',')}`);
  } finally {
    cAdapter?.dispose();
  }
}

// ============= 汇总 =============
killAllLaunched();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，忽略 */ }

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
