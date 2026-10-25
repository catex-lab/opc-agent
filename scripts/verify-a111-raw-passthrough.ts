/**
 * A111 验证：原生事件旁路（raw）—— 「映射不到」不等于「丢掉」。
 *
 * 为什么单独写这个脚本：这条链路的失败模式是**静默**的。旧代码里
 * `mapSdkMessage` 末尾一句 `return 'continue'`、`mapUpdate` 的 `default: return null`，
 * 未知消息就这么消失了 —— 类型检查、构建、原有测试全都不会响。
 * 所以断言必须直接盯「事件有没有出来」「块里有没有内容」。
 *
 * 分两层：
 *   L1 投影器纯逻辑（不碰 IO）：聚合、条数上限、体积截断、不打断文本流、收尾
 *   L2 适配器映射：直接喂未知消息给 mapSdkMessage / mapUpdate，断言变成 raw
 *
 * 跑法：npx tsx scripts/verify-a111-raw-passthrough.ts
 */
import { RunProjector } from '../server/agents/projector.js';
import { mapSdkMessage, type TurnState } from '../server/agents/adapters/sdk.js';
import { mapUpdate } from '../server/agents/adapters/acp.js';
import { cliRawChannel } from '../server/agents/adapters/cli.js';
import { AGENT_DEFS } from '../server/agents/definitions.js';
import { AsyncQueue } from '../server/agents/channel.js';
import type { AgentEvent, SendContext } from '../server/agents/types.js';
import { applyRunEvent, type Block, type RawBlock, type RunEvent, type TextBlock } from '../shared/blocks.js';

let pass = 0;
let fail = 0;
function say(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  [${detail}]` : ''}`);
  }
}

const meta = {
  runId: 'run-a111',
  sessionId: 'sess-a111',
  messageId: 'msg-a111',
  agentId: 'sdk-test',
};

function newProjector() {
  let t = 1_700_000_000_000;
  // 注入可控时钟：断言里要读 endedAt，用真实时钟会飘
  return new RunProjector(meta, () => (t += 10));
}

// ============= L1：投影器 =============

console.log('[A111] L1 投影器：raw 聚合');

{
  const p = newProjector();
  const out = p.push({ type: 'raw', channel: 'sdk:stream_event', payload: { type: 'stream_event', delta: 'x' } });
  say('1-1 首条 raw 开出 block_open', out.length === 1 && out[0]!.type === 'block_open');
  const block = (out[0] as { block?: RawBlock }).block;
  say('1-1 块类型是 raw', block?.type === 'raw');
  say('1-1 count=1', block?.count === 1);
  say('1-1 第一条原文在里面', JSON.stringify(block?.entries?.[0]?.payload ?? '').includes('stream_event'));
}

{
  const p = newProjector();
  p.push({ type: 'raw', channel: 'sdk:a', payload: { n: 1 } });
  const out = p.push({ type: 'raw', channel: 'sdk:b', payload: { n: 2 } });
  say('1-2 第二条只发 patch（不重复 open）', out.length === 1 && out[0]!.type === 'block_patch');
  const patch = (out[0] as { patch?: { count?: number; append?: { channel?: string } } }).patch;
  say('1-2 patch 带 count=2', patch?.count === 2);
  say('1-2 patch 只带新增那一条', patch?.append?.channel === 'sdk:b');
  // 关键：一个 run 只允许一块，否则消息流会被冲垮
  const raws = p.blockList.filter(b => b.type === 'raw');
  say('1-2 全程只有一块 raw', raws.length === 1, `实际 ${raws.length}`);
}

{
  const p = newProjector();
  for (let i = 0; i < 25; i++) p.push({ type: 'raw', channel: `sdk:t${i}`, payload: { i } });
  const raw = p.blockList.find(b => b.type === 'raw') as RawBlock;
  say('1-3 count 记全量 25', raw.count === 25, `count=${raw.count}`);
  say('1-3 条目封顶 20', raw.entries.length === 20, `entries=${raw.entries.length}`);
  say('1-3 省略数如实记录 5', raw.omitted === 5, `omitted=${raw.omitted}`);
}

{
  const p = newProjector();
  p.push({ type: 'raw', channel: 'sdk:huge', payload: { blob: 'x'.repeat(20000) } });
  const raw = p.blockList.find(b => b.type === 'raw') as RawBlock;
  const entry = raw.entries[0]!;
  say('1-4 超大 payload 被截断', entry.truncated === true);
  say(
    '1-4 截断后不超过 4096 字符',
    typeof entry.payload === 'string' && (entry.payload as string).length <= 4096,
    `len=${typeof entry.payload === 'string' ? (entry.payload as string).length : 'n/a'}`
  );
}

{
  const p = newProjector();
  p.push({ type: 'text', content: '前半段' });
  p.push({ type: 'raw', channel: 'sdk:noise', payload: { n: 1 } });
  const out = p.push({ type: 'text', content: '后半段' });
  // raw 块不能成为「续写目标」：否则后面的 text 会被续到 raw 上，或者白开一块
  say('1-5 raw 不打断文本流', out.length === 1 && out[0]!.type === 'block_delta');
  const texts = p.blockList.filter(b => b.type === 'text') as TextBlock[];
  say('1-5 文本仍是同一块', texts.length === 1, `text 块数=${texts.length}`);
  say('1-5 文本内容完整', texts[0]?.text === '前半段后半段', texts[0]?.text);
}

{
  const p = newProjector();
  p.push({ type: 'raw', channel: 'sdk:x', payload: { n: 1 } });
  const fin = p.finish('ok');
  const raw = p.blockList.find(b => b.type === 'raw') as RawBlock;
  say('1-6 finish 后 raw 块有 endedAt', typeof raw.endedAt === 'number');
  const closed = fin.closes.some(
    e => e.type === 'block_close' && (e as { blockId?: string }).blockId === raw.id
  );
  say('1-6 finish 会关闭 raw 块', closed);
  const patched = fin.closes.some(
    e => e.type === 'block_patch' && (e as { blockId?: string }).blockId === raw.id
  );
  say('1-6 finish 会下发 endedAt', patched);
}

{
  // 没有任何 raw 时，finish 不该凭空造块
  const p = newProjector();
  p.push({ type: 'text', content: '只有正文' });
  p.finish('ok');
  const raw = p.blockList.filter(b => b.type === 'raw');
  say('1-7 无 raw 时不产生空块', raw.length === 0);
}

// ============= L2：适配器映射 =============

console.log('\n[A111] L2 适配器：未知消息必须变成 raw');

const ctx: SendContext = { sessionId: 'sess-a111', prompt: 'hi' };

function newTurnState(): TurnState {
  return { currentToolId: null, openTools: [], started: Date.now() };
}

/**
 * 同步把队列里已入队的事件取干净。
 *
 * AsyncQueue 只提供异步迭代，没有同步 drain —— 先 close()（把 waiters 唤醒、
 * 标记结束），再迭代：`next()` 会优先吐已有的 items，吐完才返回 done。
 * 用这个而不是自己摸私有字段，是为了不把测试绑在实现细节上。
 */
async function drain(q: AsyncQueue<AgentEvent>): Promise<AgentEvent[]> {
  q.close();
  const out: AgentEvent[] = [];
  for await (const ev of q) out.push(ev);
  return out;
}

{
  const q = new AsyncQueue<AgentEvent>();
  const st = newTurnState();
  const verdict = mapSdkMessage({ type: 'stream_event', event: { delta: 'x' } }, ctx, q, st);
  const got = await drain(q);
  say('2-1 SDK 未知消息不算本轮结束', verdict === 'continue');
  say('2-1 SDK 未知消息产出一条事件', got.length === 1, `events=${got.length}`);
  say('2-1 事件类型是 raw', got[0]?.type === 'raw');
  const raw = got[0] as { channel?: string; payload?: unknown } | undefined;
  say('2-1 channel 带原生类型名', raw?.channel === 'sdk:stream_event', String(raw?.channel));
  say(
    '2-1 原文完整保留',
    JSON.stringify(raw?.payload ?? '').includes('"delta":"x"'),
    JSON.stringify(raw?.payload ?? '').slice(0, 60)
  );
}

{
  // system 底下的未知 subtype：channel 必须带上 subtype，否则「system 有十几种」
  // 全被压成同一个名字，排障时等于没报
  const q = new AsyncQueue<AgentEvent>();
  const verdict = mapSdkMessage({ type: 'system', subtype: 'compact_boundary' }, ctx, q, newTurnState());
  const got = await drain(q);
  say('2-2 system 未知 subtype 仍走 raw', verdict === 'continue' && got[0]?.type === 'raw');
  say('2-2 channel 含 subtype', (got[0] as { channel?: string })?.channel === 'sdk:system/compact_boundary');
}

{
  // 已知消息不能被 raw 抢走：assistant 文本仍走 text
  const q = new AsyncQueue<AgentEvent>();
  mapSdkMessage(
    { type: 'assistant', message: { content: [{ type: 'text', text: '正常正文' }] } },
    ctx, q, newTurnState()
  );
  const got = await drain(q);
  say('2-3 已知消息不受影响（仍是 text）', got.length === 1 && got[0]?.type === 'text');
}

{
  const ev = mapUpdate({ sessionUpdate: 'plan', entries: [{ content: '步骤一', status: 'pending' }] });
  say('2-4 ACP plan 走 raw（不再被丢弃）', !!ev && !Array.isArray(ev) && ev.type === 'raw');
  const raw = ev as { channel?: string; payload?: unknown } | null;
  say('2-4 channel 标出 acp:plan', raw?.channel === 'acp:plan', String(raw?.channel));
  say('2-4 plan 条目原样保留', JSON.stringify(raw?.payload ?? '').includes('步骤一'));
}

{
  const ev = mapUpdate({ sessionUpdate: 'availableCommands', availableCommands: [{ name: '/review' }] });
  say('2-5 ACP availableCommands 走 raw', !!ev && !Array.isArray(ev) && ev.type === 'raw');
}

{
  const ev = mapUpdate({ sessionUpdate: 'usage_update', used: 1234, size: 200000 });
  const raw = ev as { channel?: string; payload?: { used?: number } } | null;
  say('2-6 usage_update 走 raw 而不是硬塞成 usage', raw?.channel === 'acp:usage_update');
  // 语义没对齐就不映射：ACP 报的是上下文占用，不是本轮消耗
  say('2-6 未伪造 usage 语义', raw?.payload?.used === 1234);
}

{
  // 已知 update 不受影响
  const ev = mapUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正文' } });
  say('2-7 已知 update 仍是 text', !!ev && !Array.isArray(ev) && ev.type === 'text');
  // 空 chunk 依然返回 null（「确实没内容」≠「不认识」）
  const empty = mapUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } });
  say('2-7 空 chunk 仍返回 null', empty === null);
}

{
  // 块级旁路：消息认识（assistant）、但里面的块不认识 —— 消息级兜底摸不到它
  const q = new AsyncQueue<AgentEvent>();
  mapSdkMessage(
    { type: 'assistant', message: { content: [{ type: 'server_tool_use', id: 'x', name: 'web_search' }] } },
    ctx, q, newTurnState()
  );
  const got = await drain(q);
  say('2-8 未知内容块进 raw（不再消失）', got.length === 1 && got[0]?.type === 'raw', `events=${got.length}`);
  say('2-8 channel 标出块级', (got[0] as { channel?: string })?.channel === 'sdk:block:server_tool_use');
}

{
  // 思考块：以前这个循环只认 text/image/tool_use，thinking 块静默丢弃，
  // 但 workbuddy 的清单里写着 thinking —— 清单在撒谎。现在必须兑现。
  const q = new AsyncQueue<AgentEvent>();
  mapSdkMessage(
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '我先看看目录结构' }] } },
    ctx, q, newTurnState()
  );
  const got = await drain(q);
  say('2-9 思考块映射成 thinking', got.length === 1 && got[0]?.type === 'thinking');
  say('2-9 思考内容完整', (got[0] as { content?: string })?.content === '我先看看目录结构');
}

{
  // 空思考块不该造出空块（前端会渲染一个点了没反应的折叠条）
  const q = new AsyncQueue<AgentEvent>();
  mapSdkMessage(
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } },
    ctx, q, newTurnState()
  );
  say('2-10 空思考块不产事件', (await drain(q)).length === 0);
}

{
  // 同一批内容里混着认识的块和不认识的块：认识的照常出，不认识的进 raw
  const q = new AsyncQueue<AgentEvent>();
  mapSdkMessage(
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '想一下' },
          { type: 'text', text: '正文' },
          { type: 'mystery_block', foo: 1 },
        ],
      },
    },
    ctx, q, newTurnState()
  );
  const got = await drain(q);
  const types = got.map(e => e.type).join(',');
  say('2-11 混合内容三种都出', types === 'thinking,text,raw', types);
}

// ============= L3：能力清单 =============
//
// 清单的意义全在「诚实」两个字：多报（声明了却不发）会让界面画出一张永远
// 空着的折叠条，少报（发了却没声明）会让 UI 把已经拿到的数据藏起来。
// 这一层就盯这两件事 —— 尤其是**多报**，因为它是静默的。

console.log('\n[A111] L3 能力清单：不许漏、不许撒谎');

const EVENT_CAPS = new Set([
  'thinking', 'thinking_summary', 'tool', 'tool_output', 'usage', 'cost', 'permission',
]);

{
  const noManifest = AGENT_DEFS.filter(d => d.descriptor.eventCapabilities === undefined);
  say(
    '3-1 每个 Agent 都声明了清单',
    noManifest.length === 0,
    noManifest.length ? noManifest.map(d => d.descriptor.id).join(',') : `${AGENT_DEFS.length} 条全覆盖`
  );
}

{
  const illegal: string[] = [];
  for (const d of AGENT_DEFS) {
    for (const cap of d.descriptor.eventCapabilities ?? []) {
      if (!EVENT_CAPS.has(cap)) illegal.push(`${d.descriptor.id}:${cap}`);
    }
  }
  say('3-2 清单里没有未知能力名', illegal.length === 0, illegal.join(','));
}

{
  // http 类没有工具循环，也没有过程事件 —— 声明任何过程能力都是谎报
  const liars = AGENT_DEFS
    .filter(d => d.descriptor.kind === 'http' && (d.descriptor.eventCapabilities?.length ?? 0) > 0)
    .map(d => d.descriptor.id);
  say('3-3 http 类不声称任何过程能力', liars.length === 0, liars.join(','));
}

{
  // 「声明了 X 就必须真能发 X」这一条**没法**在这里自动验：
  // 每个 CLI 的映射器是各自手写的函数，形状互不相同，喂一份通用夹具只会
  // 得到一堆误报。所以这里只做能做的部分 —— 结构诚实（3-1/3-2/3-3），
  // 至于语义诚实，靠的是新适配器落地时同步改清单这条人工纪律。
  say('3-4 清单结构可核对（语义诚实需人工纪律）', true);
}

// ============= L4：CLI 层旁路 =============
//
// 12 个 Agent 走 CliAdapter，sdk / acp 各只有一个 —— 所以「不认识就丢」
// 在这一层的杀伤面最大。这里测的是通道名这个纯函数：真正的丢弃发生在
// handleJsonLine 闭包里，只有起真子进程才跑得到（属 e2e 范畴）。

console.log('\n[A111] L4 CLI 层：未映射行要有可读通道名');

{
  say('4-1 type 直接用', cliRawChannel({ type: 'stream_event' }) === 'stream_event');
  say(
    '4-2 subtype 要带上（system 底下十几种）',
    cliRawChannel({ type: 'system', subtype: 'compact_boundary' }) === 'system/compact_boundary'
  );
  say('4-3 没有 type 时看 event', cliRawChannel({ event: 'rate_limit' }) === 'rate_limit');
  say('4-4 都没有时看 kind', cliRawChannel({ kind: 'notice' }) === 'notice');
  say('4-5 连类型字段都没有 → 退回 typeof，不留空串', cliRawChannel({ foo: 1 }) === 'object');
  say('4-6 非对象也不抛', cliRawChannel('裸字符串') === 'string' && cliRawChannel(null) === 'object');
}

// ============= L5：客户端应用路径 =============
//
// 这一层是补出来的，因为 L1 骗过我一次：投影器的 `this.blocks` 全对，
// 但前端走的是另一条路 —— 把 RunEvent 一条条喂给 applyRunEvent。
// 投影器发 `patch: { count, append: entry }`，而 applyRunEvent 当时是裸的
// `Object.assign`，`append` 变成游离字段、`entries` 一次没长过。表现是
// 「流式中只显示第一条，刷新后才全出来」。
//
// 所以这里做**往返比对**：同一串事件，一边进投影器，一边进 applyRunEvent，
// 最后两边的块必须逐字段相同。这条断言比任何单点断言都强。

console.log('\n[A111] L5 往返：流式应用结果必须等于服务端状态');

{
  const p = newProjector();
  const client: Block[] = [];
  const feed = (evs: RunEvent[]) => {
    for (const e of evs) applyRunEvent(client, e);
  };

  feed(p.push({ type: 'text', content: '正文前半' }));
  for (let i = 0; i < 25; i++) feed(p.push({ type: 'raw', channel: `sdk:e${i}`, payload: { i } }));
  feed(p.push({ type: 'text', content: '后半' }));
  const fin = p.finish('ok');
  feed(fin.closes);

  const serverRaw = p.blockList.find(b => b.type === 'raw') as RawBlock;
  const clientRaw = client.find(b => b.type === 'raw') as RawBlock | undefined;

  say('5-1 客户端也有一块 raw', !!clientRaw);
  say(
    '5-2 条目数与服务端一致',
    clientRaw?.entries.length === serverRaw.entries.length,
    `客户端 ${clientRaw?.entries.length} / 服务端 ${serverRaw.entries.length}`
  );
  say('5-3 count 一致', clientRaw?.count === serverRaw.count, `${clientRaw?.count} / ${serverRaw.count}`);
  say('5-4 omitted 一致', clientRaw?.omitted === serverRaw.omitted, `${clientRaw?.omitted} / ${serverRaw.omitted}`);
  say(
    '5-5 条目内容逐条相同',
    JSON.stringify(clientRaw?.entries) === JSON.stringify(serverRaw.entries)
  );
  say('5-6 append 没有变成游离字段', !Object.prototype.hasOwnProperty.call(clientRaw, 'append'));
  say(
    '5-7 文本块也一致',
    JSON.stringify(client.find(b => b.type === 'text')) ===
      JSON.stringify(p.blockList.find(b => b.type === 'text'))
  );
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
