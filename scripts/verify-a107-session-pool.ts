/**
 * A107 验证脚本：SDK 会话池（进程复用 / 热更新 / 保上下文 / 自愈合）
 *
 * 三层制：
 * L1 纯函数 — configKeyOf / configDiff（不碰 IO）
 * L2 集成 — 桩 CLI + 真 SdkAdapter，断言进程复用、resume、abort、自愈合、
 *           error 不再静默挂死、model 热更新、cwd 变重建
 * L3 e2e — 真起服务端（独立 OPC_DATA_DIR + 随机端口）+ 桩 CLI，走 /api/chat
 *
 * 桩 CLI 讲真实协议：initialize / interrupt / set_model / set_permission_mode
 * 控制请求 + user 消息 + assistant/result 数据流 + error 消息。SDK 通过
 * OPC_CODEBUDDY_CLI 指向它，所以不起真 CLI 也能跑通池逻辑。
 *
 * 跳过 L3：设 A107_SKIP_L3=1（L3 起真服务端，CI/沙箱里可能受限）。
 *
 * A108 补充（同一套桩与适配器）：
 * - L1b 队列/权限表的**兑现语义**：fail() 必须把错误送到挂起的消费者；
 *   PendingReplies.clear() 必须用兜底答复兑现，不能留永久挂起的 Promise
 * - L2-11 CLI 返回 is_error 结果时前端要收到 error（以前静默结束）
 * - L2-12 dispose() 要回收常驻进程（以前退出应用会留下孤儿 node 进程）
 *
 * A109 补充（槽位化 + 预热）：
 * - L2-13 配置结构性变化**不能打断正在跑的那一轮**（重建挪进轮次链）
 * - L2-14 池上限 LRU 生效（第 4 个会话进来时最久没用的那个进程被关掉）
 * - L2-15 预热：先起进程、不发消息；首条消息复用同一个进程（starts 不增）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configKeyOf, configDiff } from '../server/agents/adapters/sdk.js';
import { SdkAdapter } from '../server/agents/adapters/sdk.js';
import { AsyncQueue, PendingReplies } from '../server/agents/channel.js';
import type { SendContext } from '../server/agents/types.js';
import type { AgentDefinition } from '../server/agents/definitions.js';

// ============= 基础设施 =============

const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'a107-'));
const logPath = path.join(root, 'stub.log');
const stubPath = path.join(root, 'stub-cli.cjs');
const node = process.execPath;

function say(label: string, ok: boolean, detail?: string): void {
  const mark = ok ? '✓' : '✗';
  console.log(`[A107] ${mark} ${label}${detail ? ' — ' + detail : ''}`);
}

// 最小 SendContext 工厂
function ctx(overrides: Partial<SendContext> & { sessionId: string }): SendContext {
  return {
    sessionId: overrides.sessionId,
    prompt: overrides.prompt ?? 'P',
    model: overrides.model ?? null,
    permissionMode: overrides.permissionMode ?? 'default',
    allowedTools: overrides.allowedTools ?? [],
    cwd: overrides.cwd ?? process.cwd(),
    systemPrompt: overrides.systemPrompt ?? null,
    memoryCwd: overrides.memoryCwd ?? null,
    resumeToken: overrides.resumeToken ?? null,
    signal: overrides.signal ?? undefined,
  } as SendContext;
}

// ============= L1：纯函数 =============

function l1() {
  console.log('\n=== A107-1 纯函数层 ===');

  const base = ctx({ sessionId: 's1' });
  const k1 = configKeyOf(base);
  const k2 = configKeyOf(ctx({ sessionId: 's1', model: 'm1' }));
  const k3 = configKeyOf(ctx({ sessionId: 's1', permissionMode: 'bypassPermissions' }));
  const k4 = configKeyOf(ctx({ sessionId: 's1', cwd: '/tmp' }));
  const k5 = configKeyOf(ctx({ sessionId: 's1', systemPrompt: 'new' }));
  const k6 = configKeyOf(base);

  say('configDiff same', configDiff(k1, k6) === 'same');
  say('configDiff mode-only (model)', configDiff(k1, k2) === 'mode-only');
  say('configDiff mode-only (perm)', configDiff(k1, k3) === 'mode-only');
  say('configDiff structural (cwd)', configDiff(k1, k4) === 'structural');
  say('configDiff structural (systemPrompt)', configDiff(k1, k5) === 'structural');
  say('configDiff structural vs mode-only', configDiff(k2, k4) === 'structural');
  say('configKeyOf 确定性', k1 === k6);
}

// ============= L1b：队列 / 权限表的兑现语义（A108） =============

/** 给「可能永远不兑现」的 Promise 加个观察窗，避免脚本自己挂住 */
async function settleWithin<T>(p: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<'__deadline__'>(resolve => {
    timer = setTimeout(() => resolve('__deadline__'), ms);
  });
  try {
    return await Promise.race([p.then(v => ({ kind: 'value' as const, v })), deadline.then(() => ({ kind: 'deadline' as const }))]);
  } finally {
    clearTimeout(timer!);
  }
}

async function l1b() {
  console.log('\n=== A107-1b 队列/权限表兑现语义（A108） ===');

  // ---- 1. fail() 时消费者已挂起：错误必须送到（旧实现是静默 done） ----
  {
    const q = new AsyncQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const parked = it.next();
    q.fail(new Error('boom'));
    let caught = '';
    try {
      await parked;
    } catch (e) {
      caught = (e as Error).message;
    }
    say('1b-1 fail() 送到已挂起的消费者', caught === 'boom', caught || '❌ 静默结束');
  }

  // ---- 2. fail() 早于 next()：仍然要抛 ----
  {
    const q = new AsyncQueue<string>();
    q.fail(new Error('boom2'));
    let caught = '';
    try {
      await q[Symbol.asyncIterator]().next();
    } catch (e) {
      caught = (e as Error).message;
    }
    say('1b-2 fail() 早于 next() 也抛错', caught === 'boom2', caught || '❌ 静默结束');
  }

  // ---- 3. 错误只报一次：reject 之后不能留一份 failure 让下一次 next() 再抛 ----
  {
    const q = new AsyncQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const parked = it.next();
    q.fail(new Error('once'));
    try { await parked; } catch { /* 预期 */ }
    const second = await settleWithin(it.next(), 200);
    say('1b-3 同一个错误不重复上报', second.kind === 'value' && (second.v as { done?: boolean }).done === true);
  }

  // ---- 4. 正常路径不受影响：push + close ----
  {
    const q = new AsyncQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const parked = it.next();
    q.push('event');
    q.close();
    const first = await parked;
    const second = await it.next();
    say(
      '1b-4 push + close 正常送达',
      first.done === false && first.value === 'event' && second.done === true
    );
  }

  // ---- 5. PendingReplies.clear() 必须兑现（旧实现让 Promise 永久挂起） ----
  {
    const r = new PendingReplies<{ behavior: string }>();
    const p = r.register('req-clear', () => ({ behavior: 'deny(clear)' }), 0);
    r.clear();
    const out = await settleWithin(p, 300);
    say(
      '1b-5 clear() 用兜底答复兑现',
      out.kind === 'value' && (out.v as { behavior: string }).behavior === 'deny(clear)',
      out.kind === 'deadline' ? '❌ 永久挂起' : ''
    );
  }

  // ---- 6. clear(scope) 只清自己的会话 ----
  {
    const r = new PendingReplies<{ behavior: string }>();
    const pa = r.register('req-a', () => ({ behavior: 'deny(a)' }), 0, 'sess-A');
    const pb = r.register('req-b', () => ({ behavior: 'deny(b)' }), 0, 'sess-B');
    r.clear('sess-A');
    const ra = await settleWithin(pa, 300);
    const rb = await settleWithin(pb, 300);
    say(
      '1b-6 clear(scope) 不误伤别的会话',
      ra.kind === 'value' && rb.kind === 'deadline',
      `A=${ra.kind} B=${rb.kind}`
    );
    // 收尾：把 B 兑现掉，避免脚本退出时留挂起 Promise
    say('1b-6 前端答复仍可命中本会话', r.settle('req-b', { behavior: 'allow' }) === true);
  }

  // ---- 7. 超时兜底仍然工作（且不会重复兑现） ----
  {
    const r = new PendingReplies<{ behavior: string }>();
    const p = r.register('req-t', () => ({ behavior: 'deny(timeout)' }), 120);
    const out = await settleWithin(p, 600);
    const after = r.settle('req-t', { behavior: 'allow' });
    say(
      '1b-7 超时兜底兑现且不可二次兑现',
      out.kind === 'value' && (out.v as { behavior: string }).behavior === 'deny(timeout)' && after === false
    );
  }
}

// ============= 桩 CLI（运行时写入 .cjs） =============

const STUB_CODE = `
const readline = require('node:readline');
const fs = require('node:fs');

const LOG = process.env.STUB_LOG;
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\\n'); };

const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i+1] : undefined; };
const sessionId = argOf('--session-id') || ('stub-' + process.pid);
const resumeId = argOf('--resume');
const permMode = argOf('--permission-mode');
const model = argOf('--model');

const cfg = {
  hang: process.env.STUB_HANG === '1',
  crashOn: Number(process.env.STUB_CRASH_ON || 0),
  emitError: process.env.STUB_EMIT_ERROR === '1',
  errorResult: process.env.STUB_ERROR_RESULT === '1',
  // A109：让回复慢下来，用来制造「上一轮还在跑」的窗口
  delayMs: Number(process.env.STUB_DELAY_MS || 0),
};

log({ event: 'start', pid: process.pid, sessionId, resumeId, permMode, model, argv });

const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

// 启动即发 init（会话模式下它会被 discardPendingMessages() 冲掉——被测行为之一）
send({ type: 'system', subtype: 'init', session_id: sessionId, model: model || 'stub-model', cwd: process.cwd(), tools: [] });

let msgCount = 0;

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') {
    const r = m.request;
    if (r.subtype === 'initialize') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { session_id: sessionId, currentModelId: model || 'stub-model' } } });
    } else if (r.subtype === 'interrupt') {
      log({ event: 'interrupt' });
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      // 真实 CLI 被打断后会补一个 result 收尾，让 SDK 的 stream() 自然结束；
      // 否则 SDK 会一直等消息、本端进程也吊在 stream() 上。这里模拟同样行为。
      send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 0, session_id: sessionId, cost: 0, interrupted: true });
    } else if (r.subtype === 'set_model') {
      log({ event: 'set_model', model: r.model });
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    } else if (r.subtype === 'set_permission_mode') {
      log({ event: 'set_permission_mode', mode: r.mode });
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    } else if (r.subtype === 'get_available_models') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { availableModels: [{ modelId: 'stub-model', name: 'Stub' }], rawModels: [] } } });
    } else {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    }
    return;
  }
  if (m.type === 'user') {
    msgCount++;
    const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content ?? '');
    log({ event: 'user', n: msgCount, text: String(text).slice(0, 40) });
    if (cfg.crashOn && msgCount >= cfg.crashOn) {
      log({ event: 'crash', n: msgCount });
      process.exit(3);
    }
    respond(text, msgCount);
  }
});

async function respond(text, n, delayed) {
  if (cfg.emitError) {
    send({ type: 'error', error: 'stub-boom' });
    return;
  }
  // A108：让 SDK 走「结果本身是错误」这条真实路径 ——
  // lib/session.js 的 stream() 见到 is_error + errors 会**先抛 ExecutionError**
  // 而不是把 result yield 出来，于是落到适配器的 catch 分支。
  // 这条分支以前调 queue.fail()，而 fail() 会把错误吞掉（消费者看到静默结束）。
  if (cfg.errorResult) {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['stub-fail'], duration_ms: 1, session_id: sessionId, cost: 0 });
    return;
  }
  // 挂起场景：收到用户消息后不再回任何东西，直到收到 interrupt 控制请求
  // （interrupt 分支会补一个 result 收尾，让 SDK stream() 结束）。
  // 注意 cfg.hang 在模块加载时固化，只让**首条**消息挂住——否则这个进程
  // 永久卡在 hang 模式，「abort 后复用同一进程再发一条」就无法验证（下一条
  // 也会被 hang 吞掉）。中断回一句，进程就回到可服务的空闲态。
  if (cfg.hang && msgCount === 1) {
    log({ event: 'hang', n });
    return;
  }
  // A109：慢回复 —— 用来在「上一轮还没跑完」时插入下一条消息。
  // 只在第一趟延迟（delayed 标记），否则 setTimeout 里再进来会无限递归。
  if (cfg.delayMs > 0 && !delayed) {
    log({ event: 'delay', n, ms: cfg.delayMs });
    setTimeout(() => { void respond(text, n, true); }, cfg.delayMs);
    return;
  }
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'stub-reply-' + n }] } });
  send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 3, session_id: sessionId, cost: 0 });
}

rl.on('close', () => { log({ event: 'stdin-closed' }); process.exit(0); });
process.on('SIGTERM', () => { log({ event: 'sigterm' }); process.exit(0); });
`;

function writeStub(): void {
  fs.writeFileSync(stubPath, STUB_CODE);
}

function readLog(): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function clearLog(): void {
  if (fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
}

function starts(log: Array<Record<string, unknown>>) {
  return log.filter((l) => l.event === 'start');
}

// ============= L2：集成（桩 CLI + 真 SdkAdapter） =============

async function l2() {
  console.log('\n=== A107-2 集成层（桩 CLI + 真 SdkAdapter） ===');
  writeStub();
  // 让 SDK 走我们的桩，而不是真 CLI
  process.env.OPC_CODEBUDDY_CLI = stubPath;
  // 桩把运行轨迹写到这个文件，供断言进程复用 / 自愈合
  process.env.STUB_LOG = logPath;
  // 让 SDK 走 node 而不是 Electron 的 process.execPath
  process.env.ELECTRON_RUN_AS_NODE = '';

  // A155：构造器改成接收完整 AgentDefinition（要读 def.sdk 的产品参数）。
  // 这个脚本只跑桩 CLI 的池逻辑，不关心产品参数，所以最小化给一个 descriptor。
  const adapter = new SdkAdapter({
    descriptor: { id: 'workbuddy', name: 'WorkBuddy' },
  } as AgentDefinition);

  // ---- 2-1 进程复用：两条消息只起一个进程 ----
  clearLog();
  const ev1 = await drain(adapter.send(ctx({ sessionId: 'l2-1', prompt: 'hi' })));
  const ev2 = await drain(adapter.send(ctx({ sessionId: 'l2-1', prompt: 'again' })));
  const log1 = readLog();
  say('2-1 两条消息只起一个进程', starts(log1).length === 1, `starts=${starts(log1).length}`);
  say('2-1 消息1有回复', ev1.some((e) => e.type === 'text' && String(e.content).includes('stub-reply-1')));
  say('2-1 消息2有回复', ev2.some((e) => e.type === 'text' && String(e.content).includes('stub-reply-2')));
  say('2-1 消息2有 done', ev2.some((e) => e.type === 'done'));

  // ---- 2-2 resume 令牌上报（CLI session id 作为 resumeToken） ----
  const initEvents = ev1.filter((e) => e.type === 'init');
  say('2-2 init 事件数量', initEvents.length >= 1, `n=${initEvents.length}`);
  const firstToken = (initEvents[0] as { resumeToken?: string | null })?.resumeToken;
  // 注意：这里是 SDK 生成的 uuid（不是 'stub-' 前缀），只要非空即已上报
  say('2-2 首条 init 带非空 resumeToken', typeof firstToken === 'string' && firstToken.length > 0);

  // ---- 2-6 abort 后进程仍复用（不打断式中断，进程不杀） ----
  console.log('[A107] → 2-6 abort 复用');
  clearLog();
  process.env.STUB_HANG = '1';
  const ctrl = new AbortController();
  const ev6: Array<Record<string, unknown>> = [];
  const gen6 = adapter.send(ctx({ sessionId: 'l2-6', prompt: 'hang', signal: ctrl.signal }));
  setTimeout(() => ctrl.abort(), 600); // 跑到一半 abort
  for await (const e of gen6) ev6.push(e);
  // abort 即时关闭队列，但 interrupt 控制请求是异步往返，稍后才落盘；
  // 等它落盘再读日志，否则会「读了个空」。
  await new Promise((r) => setTimeout(r, 800));
  delete process.env.STUB_HANG;
  const log6 = readLog();
  say('2-6 abort 后 stub 收到 interrupt', log6.some((l) => l.event === 'interrupt'));
  // 同一会话再发一条，应该复用同一个进程
  const ev6b = await drain(adapter.send(ctx({ sessionId: 'l2-6', prompt: 'after abort' })));
  say('2-6 abort 后复用进程', starts(readLog()).length === 1);
  say('2-6 abort 后下一条有回复', ev6b.some((e) => e.type === 'text'));

  // ---- 2-7 结构性失败 → 自愈合 ----
  console.log('[A107] → 2-7 自愈合');
  clearLog();
  // STUB_CRASH_ON 在桩模块加载时固化，所以必须在 ev7a **之前**设——
  // 桩进程在 ev7a 首次 send 时才被 spawn，那时才读得到 crashOn=2
  //（即「第 2 条消息时崩」）。ev7a 是第 1 条不崩，ev7b 是第 2 条崩。
  process.env.STUB_CRASH_ON = '2';
  const ev7a = await drain(adapter.send(ctx({ sessionId: 'l2-7', prompt: 'first' })));
  const ev7b = await drain(adapter.send(ctx({ sessionId: 'l2-7', prompt: 'second' })));
  delete process.env.STUB_CRASH_ON;
  const ev7c = await drain(adapter.send(ctx({ sessionId: 'l2-7', prompt: 'third' })));
  const log7 = readLog();
  say('2-7 自愈合：第1条成功', ev7a.some((e) => e.type === 'done'));
  say('2-7 自愈合：第2条失败（stub crash）', ev7b.some((e) => e.type === 'error'));
  say('2-7 自愈合：第3条成功', ev7c.some((e) => e.type === 'done'));
  say('2-7 自愈合：共起2个进程', starts(log7).length === 2, `starts=${starts(log7).length}`);

  // ---- 2-8 error 消息不再静默挂住 ----
  console.log('[A107] → 2-8 error surface');
  clearLog();
  process.env.STUB_EMIT_ERROR = '1';
  const ev8 = await drain(adapter.send(ctx({ sessionId: 'l2-8', prompt: 'boom' })));
  delete process.env.STUB_EMIT_ERROR;
  say('2-8 error 消息被 surface', ev8.some((e) => e.type === 'error'));
  say('2-8 不挂住（有 done 或 error）', ev8.some((e) => e.type === 'done' || e.type === 'error'));

  // ---- 2-9 配置热更新（model 变，不重启进程） ----
  console.log('[A107] → 2-9 model 热更新');
  clearLog();
  await drain(adapter.send(ctx({ sessionId: 'l2-9', prompt: 'm1', model: 'm1' })));
  await drain(adapter.send(ctx({ sessionId: 'l2-9', prompt: 'm2', model: 'm2' })));
  const log9 = readLog();
  say('2-9 model 热更新：只起1个进程', starts(log9).length === 1);
  say('2-9 model 热更新：CLI 收到 set_model', log9.some((l) => l.event === 'set_model' && l.model === 'm2'));

  // ---- 2-10 cwd 变 → 重建并带 resume 保上下文 ----
  console.log('[A107] → 2-10 cwd 重建');
  clearLog();
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  await drain(adapter.send(ctx({ sessionId: 'l2-10', prompt: 'first', cwd: root })));
  await drain(adapter.send(ctx({ sessionId: 'l2-10', prompt: 'second', cwd: sub })));
  const log10 = readLog();
  say('2-10 cwd 变：起2个进程', starts(log10).length === 2);
  const secondStart = log10.filter((l) => l.event === 'start')[1] as { resumeId?: string } | undefined;
  say('2-10 cwd 变：第2个进程带 --resume', typeof secondStart?.resumeId === 'string' && secondStart.resumeId.length > 0);

  // ---- 2-11 结果本身是错误 → 必须报出来，不能静默结束 ----
  console.log('[A107] → 2-11 错误结果不再静默');
  clearLog();
  process.env.STUB_ERROR_RESULT = '1';
  const ev11 = await drain(adapter.send(ctx({ sessionId: 'l2-11', prompt: 'fail' })));
  delete process.env.STUB_ERROR_RESULT;
  say('2-11 is_error 结果被 surface', ev11.some((e) => e.type === 'error'), `events=${ev11.map((e) => e.type).join(',')}`);
  say('2-11 不会假装成功（无 done）', !ev11.some((e) => e.type === 'done'));

  // ---- 2-13 配置结构性变化不打断正在跑的那一轮（A109 核心） ----
  console.log('[A107] → 2-13 重建不打断在跑的轮次');
  clearLog();
  process.env.STUB_DELAY_MS = '800';
  const sub13 = path.join(root, 'sub13');
  fs.mkdirSync(sub13, { recursive: true });
  const p13a = drain(adapter.send(ctx({ sessionId: 'l2-13', prompt: 'slow', cwd: root })));
  // 等上一轮真的进了「CLI 正在生成」这个状态，再插一条 cwd 变了的消息
  await new Promise((r) => setTimeout(r, 200));
  const p13b = drain(adapter.send(ctx({ sessionId: 'l2-13', prompt: 'next', cwd: sub13 })));
  const [ev13a, ev13b] = await Promise.all([p13a, p13b]);
  delete process.env.STUB_DELAY_MS;
  const log13 = readLog();
  say(
    '2-13 上一轮没被打断（无 error）',
    !ev13a.some((e) => e.type === 'error'),
    ev13a.map((e) => e.type).join(',')
  );
  say('2-13 上一轮正常收尾', ev13a.some((e) => e.type === 'text') && ev13a.some((e) => e.type === 'done'));
  say('2-13 下一轮也拿到回复', ev13b.some((e) => e.type === 'text'));
  const starts13 = starts(log13);
  say('2-13 cwd 变仍然重建了进程', starts13.length === 2, `starts=${starts13.length}`);
  say(
    '2-13 重建的那个带 --resume（上下文接回去）',
    typeof (starts13[1] as { resumeId?: string } | undefined)?.resumeId === 'string'
  );

  // ---- 2-14 池上限：LRU 淘汰最久没用的会话 ----
  console.log('[A107] → 2-14 池上限 LRU');
  clearLog();
  for (const sid of ['lru-1', 'lru-2', 'lru-3', 'lru-4']) {
    await drain(adapter.send(ctx({ sessionId: sid, prompt: 'hi' })));
  }
  const pids14 = starts(readLog()).map((l) => Number(l.pid));
  const alive14 = pids14.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  say('2-14 起了 4 个进程', pids14.length === 4, `pids=${pids14.join(',')}`);
  say('2-14 只留 3 个（LRU 淘汰 1 个）', alive14.length === 3, `alive=${alive14.length}`);
  say('2-14 被淘汰的是最久没用的那个', !alive14.includes(pids14[0]), `first=${pids14[0]}`);

  // ---- 2-15 预热：先起进程，首条消息复用同一个 ----
  console.log('[A107] → 2-15 预热');
  clearLog();
  const warmCtx = ctx({ sessionId: 'l2-15', prompt: 'warm' });
  adapter.prewarm(warmCtx);
  // 等桩真的被 spawn（预热是 fire-and-forget，不返回 Promise）
  for (let i = 0; i < 50 && starts(readLog()).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const warmStarts = starts(readLog()).length;
  say('2-15 预热把进程起起来了', warmStarts === 1, `starts=${warmStarts}`);
  say('2-15 预热没有发送任何消息', !readLog().some((l) => l.event === 'user'));
  const ev15 = await drain(adapter.send(ctx({ sessionId: 'l2-15', prompt: 'hi' })));
  say('2-15 首条消息有回复', ev15.some((e) => e.type === 'text'));
  say(
    '2-15 首条消息复用预热的进程（没再 spawn）',
    starts(readLog()).length === 1,
    `starts=${starts(readLog()).length}`
  );

  // ---- 2-12 dispose() 回收常驻进程 ----
  console.log('[A107] → 2-12 退出回收');
  clearLog();
  const ev12 = await drain(adapter.send(ctx({ sessionId: 'l2-12', prompt: 'alive' })));
  say('2-12 前置：这条有回复', ev12.some((e) => e.type === 'text'));
  const alivePids = starts(readLog()).map((l) => Number(l.pid)).filter((n) => Number.isFinite(n));
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  say('2-12 前置：进程还活着', alivePids.length > 0 && alivePids.every(isAlive), `pids=${alivePids.join(',')}`);
  adapter.dispose();
  // 进程退出是异步的，给它 3 秒
  for (let i = 0; i < 30 && alivePids.some(isAlive); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  say('2-12 dispose() 后进程已退出', !alivePids.some(isAlive), `pids=${alivePids.join(',')}`);
  const slots = (adapter as unknown as { slots: Map<string, unknown> }).slots;
  say('2-12 dispose() 后池已清空', slots.size === 0, `size=${slots.size}`);
}

async function drain(gen: AsyncIterable<Record<string, unknown>>) {
  const out: Array<Record<string, unknown>> = [];
  for await (const e of gen) out.push(e);
  return out;
}

// ============= L3：真服务端 e2e =============

async function l3() {
  console.log('\n=== A107-3 服务端 e2e（独立 OPC_DATA_DIR + 随机端口） ===');
  writeStub();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = 30000 + Math.floor(Math.random() * 5000);
  const env = {
    ...process.env,
    OPC_DATA_DIR: dataDir,
    PORT: String(port),
    OPC_CODEBUDDY_CLI: stubPath,
    STUB_LOG: logPath,
    NODE_ENV: 'test',
  };

  // 起服务端（tsx server/index.ts）
  const { spawn } = await import('child_process');
  const server = spawn(node, ['--require', path.resolve('node_modules/tsx/dist/preflight.cjs'), '--import', 'file:///' + path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('server/index.ts')], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d.toString(); });

  /**
   * 就绪判定：**用 HTTP 探，不要认日志字符串**。
   *
   * 这里踩过一个坑（A109 才查出来）：原来等的是 stdout 里的 "listening" /
   * "Server running"，而 server/index.ts 打的是「◉ API 服务器已启动」的
   * 横幅 —— 两个字符串都对不上，于是 waitReady 必然超时，L3 在**任何**
   * 环境下都会被判成「环境限制，非失败」。也就是说这条 e2e 一直是假的。
   * 教训：就绪判定要探真实能力（接口能不能应答），别依赖人写的日志文案。
   */
  const waitReady = async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (server.exitCode != null) throw new Error(`server exited: ${server.exitCode}; ${serverErr.slice(-200)}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
        if (res.ok) return;
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('server start timeout; stderr(末200): ' + serverErr.slice(-200));
  };

  try {
    await waitReady();

    // 建会话
    const sid = (await fetchJson(`http://127.0.0.1:${port}/api/sessions`, 'POST', { agentId: 'workbuddy', title: 'A107 e2e' })).session.id;

    // 记录 msg1 之前的进程数（注意：不能拿「日志行数」当进程数 ——
    // 一个桩进程会写 start/user 多行，行数差会把「复用」误判成「又起了进程」）
    const startsBefore1 = starts(readLog()).length;

    // 发消息1
    const ev1 = await sseChat(port, sid, 'hi');
    const startsAfter1 = starts(readLog()).length;

    // 发消息2
    const ev2 = await sseChat(port, sid, 'again');
    const startsAfter2 = starts(readLog()).length;

    // /api/chat 走 RunProjector，事件是 block 生命周期（不是旧的 {type:'text'}）。
    // 注意首段文本随 block_open 的快照一起下发，**没有**对应的 block_delta ——
    // 只认 delta 会漏掉「一句话就说完」的回复（本项目里这几乎是常态）。
    const textOf = (evs: Array<Record<string, unknown>>) =>
      evs
        .map((e) => {
          if (e.type === 'block_delta' && typeof e.delta === 'string') return e.delta;
          const block = e.type === 'block_open' ? (e.block as { text?: unknown } | undefined) : undefined;
          return typeof block?.text === 'string' ? block.text : '';
        })
        .join('');
    const types = (evs: Array<Record<string, unknown>>) => evs.map((e) => e.type).join(',');

    say('3-1 消息1有回复', textOf(ev1).includes('stub-reply-1'), types(ev1).slice(0, 120));
    say('3-1 消息2有回复', textOf(ev2).includes('stub-reply-2'), types(ev2).slice(0, 120));
    say('3-1 消息1正常收尾（run_end ok）', ev1.some((e) => e.type === 'run_end' && e.status === 'ok'));
    say('3-1 消息1窗口起进程数=1', startsAfter1 - startsBefore1 === 1, `delta=${startsAfter1 - startsBefore1}`);
    say('3-1 消息2窗口起进程数=0（复用）', startsAfter2 - startsAfter1 === 0, `delta=${startsAfter2 - startsAfter1}`);

    // 验证 DB 里 resumeToken 已写入
    const db = new DatabaseSync(path.join(dataDir, 'chat.db'), { readOnly: true });
    const sess = db.prepare("SELECT sdk_session_id FROM sessions WHERE id = ?").get(sid) as { sdk_session_id?: string } | undefined;
    say('3-1 DB 里 resumeToken 已写入', typeof sess?.sdk_session_id === 'string' && sess.sdk_session_id.length > 0, `token=${sess?.sdk_session_id?.slice(0, 20)}`);

    // ---- 3-2 预热：建会话就把进程热起来，首条消息复用（A109） ----
    //
    // 这条依赖 workbuddy 的探测状态是 ready —— 预热刻意只在「确认可用」时
    // 启动（未登录/未安装不该白起 24MB 进程）。本机没登录时按「跳过」处理，
    // 不伪装成通过：那不是代码问题，是环境没到那一步。
    const probe = await waitAgentReady(port, 'workbuddy', 45_000);
    if (probe.state === 'not-ready') {
      skipped.push(`3-2 预热后首条消息（workbuddy 状态 ${probe.availability}）`);
      console.log(
        `[A107] ⊘ 3-2 跳过：workbuddy 状态是 ${probe.availability}（未登录/网络受限），按设计不预热`
      );
    } else if (probe.state === 'unknown') {
      /* 探测没给出结论 ≠ 环境未就绪。把它当跳过，就是把「没人知道」写成
         「跑不了」—— A109 这条闸门就是这么长期假绿的。所以这里必须红。 */
      say(
        '3-2 前置：Agent 状态可判读（不是超时仍 unknown）',
        false,
        `45s 内仍是 ${probe.availability ?? 'unknown'}`
      );
    } else {
      clearLog();
      const warmSid = (
        await fetchJson(`http://127.0.0.1:${port}/api/sessions`, 'POST', {
          agentId: 'workbuddy',
          title: 'A107 e2e warm',
        })
      ).session.id;
      let warmStarted = false;
      for (let i = 0; i < 60; i++) {
        if (starts(readLog()).length > 0) {
          warmStarted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      say('3-2 建会话即预热（没发消息就起了进程）', warmStarted, `starts=${starts(readLog()).length}`);
      say('3-2 预热阶段没有发送消息', !readLog().some((l) => l.event === 'user'));
      if (warmStarted) {
        const evWarm = await sseChat(port, warmSid, 'first');
        // 与 3-1 同理：首段文本随 block_open 的快照下发，没有对应的 block_delta。
        // 原来这里只认 block_delta，workbuddy 未就绪时 3-2 整段被跳过所以没暴露。
        say(
          '3-2 首条消息有回复',
          textOf(evWarm).includes('stub-reply-1'),
          types(evWarm).slice(0, 120)
        );
        say(
          '3-2 首条消息复用预热的进程（starts 仍为 1）',
          starts(readLog()).length === 1,
          `starts=${starts(readLog()).length}`
        );
      } else {
        // 预热没起进程 ⇒ 上面两条断言根本没跑。以前这里静默跳过，
        // 报告里看不出「A109 的那两条今天没验」。
        skipped.push('3-2 预热后首条消息（预热没起进程，两条断言未执行）');
      }
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 轮询 /api/agents 直到某个 Agent 的探测结果明确。
 *
 * A109 修正（2026-11-01）：返回**三态**，不再是一个 boolean。
 *
 * 原来的写法是「超时 = false = 不可用」，于是两种完全不同的情况被混成一种：
 *   · Agent 明确说 needs-auth / not-installed  → 真的跑不了，跳过合理
 *   · 超时后仍是 unknown                        → **我们不知道**。跳过等于把
 *     「没人知道」说成「环境未就绪」，一条从未执行过的断言就这样伪装成绿。
 *
 * 顺带把超时从 20s 提到 45s：本机实测 workbuddy 要 **27 秒**才从 unknown
 * 变成 needs-auth，20s 必然超时 —— 即便它将来 ready 了，也会被当成不可用。
 */
async function waitAgentReady(
  port: number,
  agentId: string,
  timeoutMs: number
): Promise<{ state: 'ready' | 'not-ready' | 'unknown'; availability?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    try {
      const data = (await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json()) as {
        agents?: Array<{ id: string; status?: { availability?: string } }>;
      };
      const info = data.agents?.find((a) => a.id === agentId);
      const availability = info?.status?.availability;
      last = availability;
      if (availability === 'ready') return { state: 'ready', availability };
      if (availability && availability !== 'unknown') return { state: 'not-ready', availability };
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { state: 'unknown', availability: last };
}

async function fetchJson(url: string, method: string, body: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function sseChat(port: number, sessionId: string, message: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, agentId: 'workbuddy' }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
  }
  return events;
}

// ============= 主控 =============

let failed = 0;
/**
 * 被跳过的段（A109）。
 *
 * 存在的理由：跳过本身没问题，**静默跳过**才是问题 —— 一条从没执行过的断言
 * 在报告里和「通过」长得一模一样。这里把它们收起来在结尾点名，并且
 * `A107_REQUIRE_L3=1` 时直接把跳过算成失败（手工验收/登录后复验用）。
 */
const skipped: string[] = [];
const origSay = say;
// @ts-expect-error 覆盖 say 统计失败
say = (label: string, ok: boolean, detail?: string) => {
  if (!ok) failed++;
  origSay(label, ok, detail);
};

(async () => {
  try {
    l1();
    await l1b();
    await l2();
    if (process.env.A107_SKIP_L3 === '1') {
      console.log('\n=== A107-3 跳过（A107_SKIP_L3=1） ===');
    } else {
      try {
        await l3();
      } catch (e) {
        // L3 起真服务端，在沙箱/CI 里可能因环境受限失败。但**不能静默**：
        // 这个 catch 曾经把「waitReady 等错了日志文案」这种脚本自身缺陷
        // 也吞成「环境限制，非失败」，让整条 e2e 长期是假的（A109 查出来的）。
        // 现在至少进跳过清单，结尾点名。
        const msg = (e as Error).message;
        skipped.push(`3 服务端 e2e 未跑（${msg.slice(0, 90)}）`);
        console.log(`[A107] ⊘ L3 未运行：${msg}`);
      }
    }
  } finally {
    // 清理
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n=== A107 结果：${failed === 0 ? '全绿' : failed + ' 项失败'} ===`);
  if (skipped.length) {
    console.log(`⊘ 跳过 ${skipped.length} 段 —— 这些断言本次**没有执行**，不能当通过：`);
    for (const s of skipped) console.log(`  - ${s}`);
    if (process.env.A107_REQUIRE_L3 === '1') {
      console.log('A107_REQUIRE_L3=1 ⇒ 跳过按失败计（登录/网络就绪后请这样复验）');
      process.exit(1);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
})();
