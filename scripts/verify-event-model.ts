/**
 * 事件模型（block 生命周期）验证脚本。
 *
 * 为什么不靠真实 Agent 调用：真实输出不确定、要联网、要凭据，而且只能证明
 * 「这一次碰巧对了」。投影器的核心是**合并规则** —— 什么时候续写同一个块、
 * 什么时候切新块、工具怎么配对、中止时怎么收尾。这些用夹具逐条断言才可靠。
 *
 * 运行：npx tsx scripts/verify-event-model.ts
 */
import { RunProjector, type RunMeta } from '../server/agents/projector.js';
import { applyRunEvent, legacyToBlocks, textOfBlocks, toolCallsOfBlocks } from '../shared/blocks.js';
import type { AgentEvent } from '../server/agents/types.js';
import type { Block, RunEvent } from '../shared/blocks.js';
import { AGENT_DEFS } from '../server/agents/definitions.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq<T>(actual: T, expected: T, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

const meta: RunMeta = {
  runId: 'run-1',
  sessionId: 'sess-1',
  messageId: 'msg-1',
  agentId: 'codex',
  model: 'test-model',
};

function run(events: AgentEvent[], projector = new RunProjector(meta)) {
  const out: RunEvent[] = [];
  for (const e of events) out.push(...projector.push(e));
  return { out, projector };
}

function assertSeqMonotonic(events: RunEvent[], label: string) {
  const seqs = events.map(e => e.seq);
  const sorted = [...seqs].every((v, i) => i === 0 || v > seqs[i - 1]);
  ok(sorted, `${label}：seq 严格递增`, `实际 ${seqs.join(',')}`);
  ok(seqs[0] === 1, `${label}：seq 从 1 开始`, `实际 ${seqs[0]}`);
}

// ============= 1. 典型一轮：思考 → 正文 → 工具 → 正文 =============

{
  const { out, projector } = run([
    { type: 'init', sessionId: 'sess-1', model: 'test-model' },
    { type: 'thinking', content: '先看看目录' },
    { type: 'text', content: '我来查一下。' },
    { type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', toolId: 't1', content: 'a.txt\nb.txt' },
    { type: 'text', content: '目录里有 2 个文件。' },
    { type: 'done', durationMs: 1200 },
  ]);

  assertSeqMonotonic(out, '典型一轮');

  const blocks = projector.blockList;
  eq(
    blocks.map(b => b.type),
    ['thinking', 'text', 'tool', 'text'],
    '典型一轮：块的种类与顺序'
  );
  eq(
    blocks.filter(b => b.type === 'tool').map(b => (b.type === 'tool' ? b.status : '')),
    ['completed'],
    '典型一轮：工具状态'
  );
  eq(textOfBlocks(blocks), '我来查一下。目录里有 2 个文件。', '典型一轮：正文拼接');

  // 每个块必须有且仅有一次 open / close
  const opened = out.filter(e => e.type === 'block_open').map(e => (e as any).block.id);
  const closed = out.filter(e => e.type === 'block_close').map(e => (e as any).blockId);
  eq(opened.length, blocks.length, '典型一轮：每个块都 open 了');
  eq([...closed].sort(), [...opened].sort(), '典型一轮：每个块都 close 了');

  const start = out.find(e => e.type === 'run_start');
  ok(!!start, '典型一轮：有 run_start');
  eq((start as any)?.messageId, 'msg-1', '典型一轮：run_start 带 messageId');
  eq((start as any)?.model, 'test-model', '典型一轮：run_start 带 model');
}

// ============= 2. 连续 text 合并，夹 thinking 必须切块 =============

{
  const { projector } = run([
    { type: 'text', content: '第一段' },
    { type: 'text', content: '，继续' },
    { type: 'thinking', content: '嗯…' },
    { type: 'text', content: '第二段' },
  ]);
  const blocks = projector.blockList;
  eq(blocks.map(b => b.type), ['text', 'thinking', 'text'], '切块：text|thinking|text');
  eq(textOfBlocks(blocks), '第一段，继续第二段', '切块：正文拼接');
  eq(
    blocks.filter(b => b.type === 'text').map(b => (b.type === 'text' ? b.text : '')),
    ['第一段，继续', '第二段'],
    '切块：两段 text 没有合并'
  );
}

// ============= 3. 并行工具按 id 配对，不假设栈式 =============

{
  const { projector } = run([
    { type: 'tool', id: 'a', name: 'Read', input: { file_path: 'a.txt' } },
    { type: 'tool', id: 'b', name: 'Read', input: { file_path: 'b.txt' } },
    { type: 'tool_result', toolId: 'b', content: 'B' },
    { type: 'tool_result', toolId: 'a', content: 'A' },
  ]);
  const tools = projector.blockList.filter(b => b.type === 'tool');
  eq(tools.length, 2, '并行工具：两个块');
  eq(
    tools.map(t => (t.type === 'tool' ? `${t.toolId}:${t.output}:${t.status}` : '')),
    ['a:A:completed', 'b:B:completed'],
    '并行工具：结果按 id 落到各自块上'
  );
}

// ============= 4. tool_result 缺失 id 时退到最后一个 running =============

{
  const { projector } = run([
    { type: 'tool', id: 'x', name: 'Bash' },
    { type: 'tool_result', toolId: '', content: 'out' },
  ]);
  const tool = projector.blockList.find(b => b.type === 'tool');
  eq((tool as any)?.output, 'out', '兜底配对：结果落到最后一个 running 工具');
  eq((tool as any)?.status, 'completed', '兜底配对：状态变 completed');
}

// ============= 5. 中止：打开的块与运行中的工具都标 cancelled =============

{
  const projector = new RunProjector(meta);
  projector.push({ type: 'thinking', content: '想一半' });
  projector.push({ type: 'tool', id: 't9', name: 'Bash' });
  // 工具之后又开了一段正文：中止时它仍是打开状态
  projector.push({ type: 'text', content: '说到一半' });
  const { closes, end } = projector.finish('aborted');
  const blocks = projector.blockList;

  eq(
    blocks.filter(b => b.type === 'thinking').map(b => (b.type === 'thinking' ? b.state : '')),
    ['done'],
    '中止：工具开始时思考块已按 done 收尾'
  );
  eq(
    blocks.filter(b => b.type === 'text').map(b => (b.type === 'text' ? b.state : '')),
    ['cancelled'],
    '中止：打开中的正文标 cancelled'
  );
  eq(
    (blocks.find(b => b.type === 'tool') as any)?.status,
    'cancelled',
    '中止：运行中的工具标 cancelled'
  );
  ok(closes.length > 0, '中止：产生收尾事件');

  const closeSeqs = closes.map(c => c.seq);
  ok(
    closeSeqs.every((v, i) => i === 0 || v > closeSeqs[i - 1]),
    '中止：收尾事件 seq 递增',
    closeSeqs.join(',')
  );
  eq(end.seq, projector.lastSeq, '中止：run_end 是最后一条事件');
  ok(end.seq > closeSeqs[closeSeqs.length - 1], '中止：run_end 排在所有 block_close 之后');
}

// ============= 6. 正常结束：未回填的工具按 completed 收 =============

{
  const projector = new RunProjector(meta);
  projector.push({ type: 'tool', id: 't2', name: 'Bash' });
  const { end } = projector.finish('ok', { durationMs: 88, tokens: 10 });
  const tool = projector.blockList.find(b => b.type === 'tool') as any;
  eq(tool.status, 'completed', '正常结束：工具兜底 completed');
  eq(end.type, 'run_end', '正常结束：产生 run_end');
  eq((end as any).durationMs, 88, '正常结束：带耗时');
  eq((end as any).tokens, 10, '正常结束：带 token');
}

// ============= 6b. 产物数据大小边界 =============
{
  const projector = new RunProjector(meta);
  projector.push({
    type: 'artifact',
    id: 'large',
    name: 'large',
    mediaType: 'application/json',
    data: { content: 'x'.repeat(300 * 1024) },
  });
  const block = projector.blockList.find(b => b.type === 'artifact');
  ok(block?.type === 'artifact' && block.data === undefined, '超限产物不进入消息持久化');
}

// ============= 7. 错误事件：网络类可重试，认证类不可 =============

{
  const { out } = run([{ type: 'error', message: 'Proxy connection failed: 502' }]);
  const err = out.find(e => e.type === 'error') as any;
  ok(!!err, '错误：产生 error 事件');
  eq(err?.retryable, true, '错误：502 判为可重试');

  const { out: out2 } = run([{ type: 'error', message: '需要先登录 Codex' }]);
  eq((out2.find(e => e.type === 'error') as any)?.retryable, false, '错误：登录问题不可重试');
}

// ============= 8. 工具增量输出 =============

{
  const { out, projector } = run([
    { type: 'tool', id: 'sh1', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_output', toolId: 'sh1', content: 'line1\n' },
    { type: 'tool_output', toolId: 'sh1', content: 'line2\n' },
    { type: 'tool_result', toolId: 'sh1', content: 'line1\nline2\n' },
  ]);
  const deltas = out.filter(e => e.type === 'block_delta' && (e as any).channel === 'output');
  eq(deltas.length, 2, '工具输出：两段增量都下发');
  const tool = projector.blockList.find(b => b.type === 'tool') as any;
  eq(tool.output, 'line1\nline2\n', '工具输出：最终结果覆盖增量');
}

// ============= 9. 快照包含全部块 =============

{
  const projector = new RunProjector(meta);
  projector.push({ type: 'text', content: 'hi' });
  projector.push({ type: 'tool', id: 't3', name: 'Read' });
  const snap = projector.snapshot() as any;
  eq(snap.type, 'snapshot', '快照：类型正确');
  eq(snap.blocks.length, 2, '快照：包含全部块');
}

// ============= 10. 旧数据还原顺序 =============

{
  const blocks = legacyToBlocks({
    content: '正文',
    thinking: '思考',
    toolCalls: [{ id: 't', name: 'Bash', status: 'completed', result: 'ok' }],
    images: [{ url: '/x.png' }],
  });
  eq(blocks.map(b => b.type), ['thinking', 'tool', 'image', 'text'], '旧数据：还原顺序');
  eq(toolCallsOfBlocks(blocks).length, 1, '旧数据：工具可转回 ToolCall');
}

// ============= 11. adapter 行映射（真实录制夹具） =============

function mapperOf(id: string) {
  const def = AGENT_DEFS.find(d => d.descriptor.id === id);
  return def?.cli?.createMapper?.() ?? def?.cli?.mapLine ?? null;
}

function asArray(ev: AgentEvent | AgentEvent[] | null): AgentEvent[] {
  if (!ev) return [];
  return Array.isArray(ev) ? ev : [ev];
}

// --- codex：item 里是**累积文本**，必须算出真正的增量 ---
{
  const map = mapperOf('codex');
  ok(!!map, 'codex：有行映射器');

  const started = asArray(map!({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } }));
  eq(started[0]?.type, 'tool', 'codex：命令开始 → tool');

  const out1 = asArray(map!({ type: 'item.updated', item: { id: 'i1', type: 'command_execution', aggregated_output: 'a\n' } }));
  eq(out1[0]?.type === 'tool_output' ? (out1[0] as any).content : '', 'a\n', 'codex：首段输出');

  const out2 = asArray(map!({ type: 'item.updated', item: { id: 'i1', type: 'command_execution', aggregated_output: 'a\nb\n' } }));
  eq(out2[0]?.type === 'tool_output' ? (out2[0] as any).content : '', 'b\n', 'codex：累积输出只发增量');

  const doneEv = asArray(map!({
    type: 'item.completed',
    item: { id: 'i1', type: 'command_execution', aggregated_output: 'a\nb\n', exit_code: 0 },
  }));
  eq(doneEv[0]?.type, 'tool_result', 'codex：命令完成 → tool_result');

  const msg1 = asArray(map!({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '你好' } }));
  eq(msg1[0]?.type === 'text' ? (msg1[0] as any).content : '', '你好', 'codex：正文');

  const reason = asArray(map!({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: '想一想' } }));
  eq(reason[0]?.type, 'thinking', 'codex：reasoning → thinking');

  const changes = asArray(map!({
    type: 'item.completed',
    item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'README.md', kind: 'add' }] },
  }));
  eq(changes[0]?.type, 'tool_result', 'codex：文件修改仍保留工具结果');
  eq(changes[1]?.type, 'artifact', 'codex：原生 file_change 生成产物事件');
  if (changes[1]?.type === 'artifact') {
    eq(changes[1].mediaType, 'application/vnd.opc.file-changes+json', 'codex：文件变更产物媒体类型');
    eq(changes[1].data, [{ path: 'src/a.ts', kind: 'update' }, { path: 'README.md', kind: 'add' }], 'codex：产物只包含安全路径与操作类型');
  }

  const usage = asArray(map!({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
  eq(usage[0]?.type === 'usage' ? (usage[0] as any).tokens : 0, 15, 'codex：用量合并');
}

// --- opencode：实测一行里带「工具 + 结果」 ---
{
  const map = mapperOf('opencode');
  ok(!!map, 'opencode：有行映射器');

  const t = asArray(map!({ type: 'text', part: { type: 'text', text: 'Done.' } }));
  eq(t[0]?.type === 'text' ? (t[0] as any).content : '', 'Done.', 'opencode：正文');

  const toolEvs = asArray(map!({
    type: 'tool_use',
    part: {
      id: 'call_1',
      tool: 'shell',
      state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\r\n' },
    },
  }));
  eq(toolEvs.length, 2, 'opencode：一行拆成工具 + 结果');
  eq(toolEvs[0]?.type, 'tool', 'opencode：第一条是 tool');
  eq(toolEvs[1]?.type, 'tool_result', 'opencode：第二条是 tool_result');

  const step = asArray(map!({ type: 'step_finish', part: { tokens: { input: 100, output: 20, reasoning: 3 }, cost: 0.01 } }));
  eq(step[0]?.type === 'usage' ? (step[0] as any).tokens : 0, 123, 'opencode：用量合并');
  eq(step[0]?.type === 'usage' ? (step[0] as any).cost : 0, 0.01, 'opencode：费用');
}

// --- gemini：字段名多重兜底 ---
{
  const map = mapperOf('gemini');
  ok(!!map, 'gemini：有行映射器');
  eq(asArray(map!({ type: 'message', role: 'assistant', content: 'hi' }))[0]?.type, 'text', 'gemini：正文');
  eq(asArray(map!({ type: 'message', role: 'user', content: 'echo' })).length, 0, 'gemini：用户回显丢弃');
  eq(asArray(map!({ type: 'tool_use', tool_name: 'run_shell', tool_id: 'g1', parameters: { command: 'ls' } }))[0]?.type, 'tool', 'gemini：工具');
  eq(asArray(map!({ type: 'tool_result', tool_id: 'g1', status: 'success', output: 'ok' }))[0]?.type, 'tool_result', 'gemini：工具结果');
}

// --- claude / cursor：content blocks ---
{
  const map = mapperOf('claude');
  ok(!!map, 'claude：有行映射器');
  const evs = asArray(map!({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '嗯' },
        { type: 'text', text: '好' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } },
      ],
    },
  }));
  eq(evs.map(e => e.type), ['thinking', 'text', 'tool'], 'claude：三种块都映射');
  const res = asArray(map!({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'A' }] },
  }));
  eq(res[0]?.type === 'tool_result' ? (res[0] as any).toolId : '', 'tu1', 'claude：工具结果配对');
}

// --- pi / antigravity / kimicli（A65）：三个新 CLI 的行映射 ---
{
  // 夹具逐字取自本机真实输出（pi 0.82.1 的 402 失败流）+ 官方文档给的形状。
  const pi = mapperOf('pi');
  ok(!!pi, 'pi：有行映射器');
  eq(
    asArray(pi!({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好' } }))[0]?.type,
    'text',
    'pi：text_delta → text'
  );
  eq(
    asArray(pi!({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '嗯' } }))[0]?.type,
    'thinking',
    'pi：thinking_delta → thinking'
  );
  eq(
    asArray(pi!({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"a"' } })).length,
    0,
    'pi：半截工具参数不渲染'
  );
  const piTool = asArray(pi!({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }));
  eq(piTool[0]?.type, 'tool', 'pi：工具开始 → tool');
  eq(
    asArray(pi!({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: 'ok', isError: false }))[0]?.type,
    'tool_result',
    'pi：工具结束 → tool_result'
  );
  const piUsage = asArray(
    pi!({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 5, cost: { total: 0.02 } } },
    })
  );
  eq(piUsage[0]?.type === 'usage' ? (piUsage[0] as any).tokens : 0, 15, 'pi：用量合并');
  eq(piUsage[0]?.type === 'usage' ? (piUsage[0] as any).cost : 0, 0.02, 'pi：费用');
  // 实测坑：pi 把请求级失败放在 assistant 消息里，exit 0、stderr 全空
  const piErr = asArray(
    pi!({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '402: Insufficient Balance', usage: {} },
    })
  );
  eq(piErr[0]?.type, 'error', 'pi：stopReason=error → error 事件');
  // 全零用量不能当「$0 / 0 tokens」显示
  eq(
    asArray(
      pi!({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', usage: { input: 0, output: 0, cost: { total: 0 } } },
      })
    ).length,
    0,
    'pi：全零用量不发 usage（不显示假的 $0）'
  );
  const piDef = AGENT_DEFS.find(d => d.descriptor.id === 'pi')!;
  eq(
    piDef.cli!.extractResumeToken?.({ type: 'session', version: 3, id: 'uuid-1' }) ?? '',
    'uuid-1',
    'pi：session 头取续接令牌'
  );
}

{
  const agy = mapperOf('antigravity');
  ok(!!agy, 'antigravity：有行映射器');

  // ACTIVE 与 DONE 都带 text_delta（短回复只有 DONE），必须无条件拼接
  eq(
    asArray(agy!({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ap' } }))[0]?.type,
    'text',
    'agy：ACTIVE 增量 → text'
  );
  eq(
    asArray(agy!({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'ple' } }))[0]?.type,
    'text',
    'agy：DONE 增量也照发'
  );

  const toolEvs = asArray(
    agy!({
      event: 'step_update',
      step_update: {
        step_index: 4,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\r\n' },
      },
    })
  );
  eq(toolEvs.length, 2, 'agy：工具步骤拆成工具 + 结果');
  eq(toolEvs[1]?.type === 'tool_result' ? (toolEvs[1] as any).isError : true, false, 'agy：工具成功不标错');

  const failTool = asArray(
    agy!({
      event: 'step_update',
      step_update: {
        step_index: 5,
        state: 'DONE',
        step_type: 'tool',
        tool_info: { name: 'run_command', parameters: {}, error: { type: 'denied', message: 'soft-denied' } },
      },
    })
  );
  eq(failTool[1]?.type === 'tool_result' ? (failTool[1] as any).isError : false, true, 'agy：工具失败标错');

  const agyUsage = asArray(
    agy!({ event: 'result', result: { status: 'SUCCESS', response: 'apple', usage: { total_tokens: 1234 } } })
  );
  const usageEv = agyUsage.find(e => e.type === 'usage') as any;
  eq(usageEv?.tokens, 1234, 'agy：result 里的用量');
  // 已经拼过 delta 就不能再把整轮 response 发一遍（会重复整段正文）
  eq(agyUsage.some(e => e.type === 'text'), false, 'agy：拼过 delta 后不重复发 response');

  const agyErr = asArray(agy!({ event: 'result', result: { status: 'ERROR', error: 'invalid model selection' } }));
  eq(agyErr[0]?.type, 'error', 'agy：非 SUCCESS 状态 → error');

  const agyDef = AGENT_DEFS.find(d => d.descriptor.id === 'antigravity')!;
  eq(
    agyDef.cli!.extractResumeToken?.({ event: 'init', conversation_id: 'conv-1' }) ?? '',
    'conv-1',
    'agy：init 取 conversation_id'
  );
}

{
  // 一个全新的 mapper：没有任何 delta，result.response 必须兜底成正文
  const fresh = mapperOf('antigravity')!;
  const fallback = asArray(fresh({ event: 'result', result: { status: 'SUCCESS', response: '只有 result 的短回复' } }));
  eq(fallback[0]?.type === 'text' ? (fallback[0] as any).content : '', '只有 result 的短回复', 'agy：无 delta 时用 response 兜底');
}

{
  const kimi = mapperOf('kimicli');
  ok(!!kimi, 'kimicli：有行映射器');
  eq(asArray(kimi!({ role: 'meta', type: 'system.version', version: '2.3.0' })).length, 0, 'kimicli：meta 行不渲染');
  eq(
    asArray(kimi!({ role: 'assistant', content: '好' }))[0]?.type === 'text' ? 'text' : '',
    'text',
    'kimicli：assistant 正文'
  );
  const kimiTool = asArray(
    kimi!({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'Shell', arguments: '{"command":"ls"}' } }],
    })
  );
  eq(kimiTool[0]?.type, 'tool', 'kimicli：tool_calls → tool');
  eq((kimiTool[0] as any)?.input?.command ?? '', 'ls', 'kimicli：arguments 解析成对象');
  eq(
    asArray(kimi!({ role: 'tool', tool_call_id: 'tc_1', content: 'a.txt' }))[0]?.type,
    'tool_result',
    'kimicli：tool 消息 → tool_result'
  );
  const kimiDef = AGENT_DEFS.find(d => d.descriptor.id === 'kimicli')!;
  eq(kimiDef.cli!.extractResumeToken?.({ role: 'meta', session_id: 'sess-9' }) ?? '', 'sess-9', 'kimicli：session_id 取续接令牌');
}

// ============= 12. 关键不变量：投影输出喂给前端 reducer，必须与服务端块完全一致 =============

{
  const projector = new RunProjector(meta, () => 1_000);
  const out: RunEvent[] = [];
  const feed: AgentEvent[] = [
    { type: 'init', sessionId: 'sess-1' },
    { type: 'thinking', content: '想' },
    { type: 'thinking', content: '一下' },
    { type: 'text', content: '第一段' },
    { type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_output', toolId: 't1', content: 'a\n' },
    { type: 'tool_result', toolId: 't1', content: 'a\nb\n' },
    { type: 'text', content: '第二段' },
    { type: 'artifact', id: 'a1', name: '摘要', mediaType: 'application/json', data: { ok: true } },
  ];
  for (const e of feed) out.push(...projector.push(e));
  out.push(...projector.finish('ok').closes);

  const client: Block[] = [];
  for (const e of out) applyRunEvent(client, e);

  eq(client, projector.blockList, '前后端块序列逐字段一致');
  const artifact = client.find(b => b.type === 'artifact');
  ok(artifact?.type === 'artifact', 'artifact 事件会持久投影成独立数据块');
}

// ============= 结果 =============

if (failures.length === 0) {
  console.log(`\n✅ verify-event-model：${checks.total}/${checks.total} 通过\n`);
  process.exit(0);
}

console.error(`\n❌ verify-event-model：${checks.total - failures.length}/${checks.total} 通过\n`);
for (const f of failures) console.error(`  · ${f}`);
console.error('');
process.exit(1);
