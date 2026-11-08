/**
 * 流式增量验收（P1）：
 *   1. Tencent SDK：`stream_event` 的 text/thinking 增量必须逐块推出；
 *      随后整条 assistant 到达时不能重复（否则正文翻倍）。
 *   2. 不认识的 stream_event subtype 仍走 raw 旁路。
 *   3. Claude SDK 走同一套增量/去重映射。
 *   4. 统一投影器把多段 text 拼成一个块，群聊/单聊/工作流共用这条链路。
 *
 * 跑法：npx tsx scripts/verify-stream-text.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncQueue } from '../server/agents/channel.js';
import { SdkAdapter } from '../server/agents/adapters/sdk.js';
import { mapClaudeSdkMessage } from '../server/agents/adapters/claude-sdk.js';
import {
  createStreamTextState,
  mapStreamTextEvent,
  takeStreamedText,
  takeStreamedThinking,
  takeStreamedTotalText,
} from '../server/agents/adapters/streamText.js';
import { RunProjector } from '../server/agents/projector.js';
import type { AgentEvent, SendContext } from '../server/agents/types.js';
import type { AgentDefinition } from '../server/agents/definitions.js';

const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'stream-text-'));
const logPath = path.join(root, 'stub.log');
const stubPath = path.join(root, 'stub-cli.cjs');

let failed = 0;
function say(label: string, ok: boolean, detail?: string): void {
  if (!ok) failed += 1;
  console.log(`[STREAM] ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
}

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

async function drain(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ============= 桩 CLI =============

const STUB_CODE = `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.env.STUB_LOG;
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\\n'); };
const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i+1] : undefined; };
const sessionId = argOf('--session-id') || ('stub-' + process.pid);
const model = argOf('--model');
const mode = process.env.STUB_MODE || 'plain';

log({ event: 'start', pid: process.pid, sessionId, model, argv, mode });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
send({ type: 'system', subtype: 'init', session_id: sessionId, model: model || 'stub-model', cwd: process.cwd(), tools: [] });

const raw = (event) => send({ type: 'stream_event', session_id: sessionId, event });
const rawSub = (event, parent) => send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: parent, event });
const delta = (index, d) => raw({ type: 'content_block_delta', index, delta: d });

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') {
    const r = m.request;
    if (r.subtype === 'initialize') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { session_id: sessionId, currentModelId: model || 'stub-model' } } });
    } else if (r.subtype === 'interrupt') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 0, session_id: sessionId, cost: 0, interrupted: true });
    } else {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    }
    return;
  }
  if (m.type !== 'user') return;
  const full = 'stub-reply-你好';
  if (mode === 'delta') {
    raw({ type: 'message_start', message: {} });
    raw({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    delta(0, { type: 'text_delta', text: 'stub-' });
    delta(0, { type: 'text_delta', text: 'reply-' });
    delta(0, { type: 'text_delta', text: '你好' });
    raw({ type: 'content_block_stop', index: 0 });
    raw({ type: 'message_stop' });
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: full }] } });
  } else if (mode === 'thinking') {
    raw({ type: 'message_start', message: {} });
    raw({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    delta(0, { type: 'thinking_delta', thinking: '先想' });
    delta(0, { type: 'thinking_delta', thinking: '一下' });
    raw({ type: 'content_block_stop', index: 0 });
    raw({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    delta(1, { type: 'text_delta', text: '答案是 42' });
    raw({ type: 'content_block_stop', index: 1 });
    raw({ type: 'message_stop' });
    send({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '先想一下' },
      { type: 'text', text: '答案是 42' },
    ] } });
  } else if (mode === 'subagent') {
    // 主回答的增量
    raw({ type: 'message_start', message: {} });
    delta(0, { type: 'text_delta', text: '主回答' });
    raw({ type: 'message_stop' });
    // 子 Agent 的流（parent_tool_use_id 非空）夹在中间：不能碰主回答的缓存
    rawSub({ type: 'message_start', message: {} }, 'toolu_1');
    rawSub({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子任务' } }, 'toolu_1');
    rawSub({ type: 'message_stop' }, 'toolu_1');
    send({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { role: 'assistant', content: [{ type: 'text', text: '子任务' }] } });
    // 主回答整条随后到达：应被完全剪掉
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '主回答' }] } });
  } else if (mode === 'unknown') {
    raw({ type: 'ping', nonce: 7 });
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: full }] } });
  } else {
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: full }] } });
  }
  send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 3, session_id: sessionId, cost: 0 });
});
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;

function clearLog(): void {
  try { fs.unlinkSync(logPath); } catch { /* ignore */ }
}

// ============= L1：纯函数 =============

function l1(): void {
  console.log('\n=== L1 增量映射/去重 ===');
  const state = createStreamTextState();
  const ev1 = mapStreamTextEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'AB' } } },
    state
  );
  say('1-1 text_delta 产出 text 事件', !!ev1 && ev1[0]?.type === 'text' && ev1[0].content === 'AB');
  say('1-1 整条等于增量时不再重复', takeStreamedText(state, 0, 'AB') === '');
  say('1-2 整条比增量长时只补后缀', takeStreamedText(state, 0, 'ABC') === 'C');
  say('1-3 前缀不一致时也不整段重发', takeStreamedText(state, 0, 'XY') === '');

  const s2 = createStreamTextState();
  mapStreamTextEvent({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } } }, s2);
  say('1-4 thinking_delta 产出 thinking', takeStreamedThinking(s2, 0, '想到了') === '到了');

  const s3 = createStreamTextState();
  mapStreamTextEvent({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'XYZ' } } }, s3);
  say('1-5 字符串正文走总量去重', takeStreamedTotalText(s3, 'XYZ') === '');
  say('1-6 不认识的事件交给 raw 旁路', mapStreamTextEvent({ type: 'stream_event', event: { type: 'ping' } }, s3) === null);

  const p = new RunProjector({
    runId: 'r1',
    sessionId: 's1',
    messageId: 'm1',
    agentId: 'workbuddy',
  });
  p.push({ type: 'text', content: 'AB' });
  p.push({ type: 'text', content: 'CD' });
  p.finish('done', { durationMs: 1 });
  const blocks = (p.snapshot() as { blocks: Array<Record<string, unknown>> }).blocks;
  const texts = blocks.filter((b) => b.type === 'text') as Array<{ text?: string }>;
  say('1-7 投影器只拼一个 text 块', texts.length === 1 && texts[0]?.text === 'ABCD', `blocks=${texts.length}`);
}

// ============= L2：Tencent SDK 集成（桩 CLI） =============

function writeStub(): void {
  fs.writeFileSync(stubPath, STUB_CODE, 'utf8');
}

async function sendWithMode(adapter: SdkAdapter, sessionId: string, mode: string): Promise<AgentEvent[]> {
  process.env.STUB_MODE = mode;
  clearLog();
  return drain(adapter.send(ctx({ sessionId, prompt: 'hi' })));
}

async function l2(): Promise<void> {
  console.log('\n=== L2 Tencent SDK（桩 CLI + 真适配器） ===');
  writeStub();
  process.env.OPC_CODEBUDDY_CLI = stubPath;
  process.env.STUB_LOG = logPath;
  process.env.ELECTRON_RUN_AS_NODE = '';
  const log = (): Array<Record<string, unknown>> => {
    try {
      return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };

  const adapter = new SdkAdapter({
    descriptor: { id: 'workbuddy', name: 'WorkBuddy' },
  } as AgentDefinition);

  const evDelta = await sendWithMode(adapter, 'p1-delta', 'delta');
  const texts = evDelta.filter((e) => e.type === 'text') as Array<{ content: string }>;
  say('2-1 增量按块到达（不是一条整段）', texts.length >= 3, `n=${texts.length}`);
  say('2-2 拼接结果只出现一次', texts.map((t) => t.content).join('') === 'stub-reply-你好', texts.map((t) => t.content).join(''));
  say('2-3 没有整段重复', texts.every((t) => t.content !== 'stub-reply-你好'));
  say('2-4 识别事件不进 raw', !evDelta.some((e) => e.type === 'raw'));
  say('2-4b CLI 收到 include-partial-messages', log().some((l) => (l.argv as string[] | undefined)?.includes('--include-partial-messages')));

  const evThink = await sendWithMode(adapter, 'p1-think', 'thinking');
  const thinks = evThink.filter((e) => e.type === 'thinking') as Array<{ content: string }>;
  const thinkTexts = evThink.filter((e) => e.type === 'text') as Array<{ content: string }>;
  say('2-5 thinking 增量按块到达', thinks.map((t) => t.content).join('') === '先想一下' && thinks.length >= 2, `n=${thinks.length}`);
  say('2-6 思考后的正文只出现一次', thinkTexts.map((t) => t.content).join('') === '答案是 42' && thinkTexts.length === 1, `n=${thinkTexts.length}`);

  const evUnknown = await sendWithMode(adapter, 'p1-unknown', 'unknown');
  const raws = evUnknown.filter((e) => e.type === 'raw') as Array<{ channel: string }>;
  say('2-7 未知 subtype 仍进 raw', raws.some((r) => r.channel === 'sdk:stream_event'), raws.map((r) => r.channel).join(','));

  const evPlain = await sendWithMode(adapter, 'p1-plain', 'plain');
  const plainTexts = evPlain.filter((e) => e.type === 'text') as Array<{ content: string }>;
  say('2-8 无增量时行为不变', plainTexts.map((t) => t.content).join('') === 'stub-reply-你好' && plainTexts.length === 1);

  const evSub = await sendWithMode(adapter, 'p1-subagent', 'subagent');
  const subTexts = evSub.filter((e) => e.type === 'text') as Array<{ content: string }>;
  const mainTimes = subTexts.filter((t) => t.content === '主回答').length;
  say(
    '2-9 子 Agent 流不破坏主回答去重',
    mainTimes === 1 && subTexts.map((t) => t.content).join('') === '主回答子任务',
    `主回答出现 ${mainTimes} 次 / 拼接=${subTexts.map((t) => t.content).join('')}`
  );

  adapter.dispose();
}

// ============= L3：Claude SDK 映射（同一套去重） =============

async function l3(): Promise<void> {
  console.log('\n=== L3 Claude SDK 映射 ===');
  const queue = new AsyncQueue<AgentEvent>();
  const stream = createStreamTextState();
  const c = ctx({ sessionId: 'c1' }) as unknown as SendContext;

  mapClaudeSdkMessage({ type: 'stream_event', event: { type: 'message_start', message: {} } } as never, c, queue, stream);
  mapClaudeSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cla' } } } as never, c, queue, stream);
  mapClaudeSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ude' } } } as never, c, queue, stream);
  mapClaudeSdkMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude' }] } } as never, c, queue, stream);
  queue.close();

  const events: AgentEvent[] = [];
  for await (const e of queue) events.push(e);
  const texts = events.filter((e) => e.type === 'text') as Array<{ content: string }>;
  say('3-1 Claude 增量按块到达', texts.length === 2 && texts.map((t) => t.content).join('') === 'Claude', `n=${texts.length}`);
  say('3-2 Claude 整条不重复', texts.every((t) => t.content !== 'Claude'));

  // 子 Agent 流夹在主回答中间：子流按原样整条下发，主回答仍只出现一次
  const queue2 = new AsyncQueue<AgentEvent>();
  const stream2 = createStreamTextState();
  mapClaudeSdkMessage({ type: 'stream_event', event: { type: 'message_start', message: {} } } as never, c, queue2, stream2);
  mapClaudeSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ma' } } } as never, c, queue2, stream2);
  mapClaudeSdkMessage({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'message_start', message: {} } } as never, c, queue2, stream2);
  mapClaudeSdkMessage({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sub' } } } as never, c, queue2, stream2);
  mapClaudeSdkMessage({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { role: 'assistant', content: [{ type: 'text', text: 'Sub' }] } } as never, c, queue2, stream2);
  mapClaudeSdkMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Main' }] } } as never, c, queue2, stream2);
  queue2.close();
  const events2: AgentEvent[] = [];
  for await (const e of queue2) events2.push(e);
  const texts2 = events2.filter((e) => e.type === 'text') as Array<{ content: string }>;
  say(
    '3-3 Claude 子 Agent 流不污染主回答去重',
    texts2.map((t) => t.content).join('') === 'MaSubin' && texts2.filter((t) => t.content === 'Main').length === 0,
    `拼接=${texts2.map((t) => t.content).join('')}`
  );
}

async function main(): Promise<void> {
  l1();
  await l2();
  await l3();
  console.log(`\n[STREAM] ${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`);
  if (failed > 0) process.exitCode = 1;
}

void main();
