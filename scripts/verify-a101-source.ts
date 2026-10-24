/**
 * A100 事件来源标注的单元验证（纯函数，不碰 HTTP 也不起浏览器）。
 *
 * ## 这一层最容易出的错
 *
 * 不是「标不出来」，而是**标错方向**：把纯文本解析出来的事件标成 native，
 * 或者反过来把 SDK 原生事件标成低可信度。前者是骗人，后者是白挨骂 ——
 * 两种都会让用户对这个标签彻底失去信任。
 *
 * ## 为什么只测纯函数、不碰 registry 单例
 *
 * `registry.eventSourceOf()` 只是 `eventSourceOf(findDef(id))` 的包装。
 * 而 import registry 会跑它的构造函数（创建 16 个 provider + 装一次 PATH 探测），
 * 那就已经不是单元测试了。所以这里直接测定义表里的纯函数 + 真表覆盖率 ——
 * 真表才是「哪几个 Agent 会被标成低可信度」的答案。
 *
 * 运行：npx tsx scripts/verify-a101-source.ts
 */

import { AGENT_DEFS, eventSourceOf, type AgentDefinition } from '../server/agents/definitions.js';
import type { CliSpec } from '../server/agents/definitions.js';

let total = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

/** 造一个最小 AgentDefinition，只填本函数用得到的字段 */
function def(over: {
  kind?: AgentDefinition['descriptor']['kind'];
  sdk?: AgentDefinition['sdk'];
  parse?: CliSpec['parse'];
}): AgentDefinition {
  return {
    descriptor: { id: 'x', name: 'X', kind: over.kind ?? 'cli', capabilities: ['chat'] },
    sdk: over.sdk,
    cli:
      over.parse != null
        ? ({ bin: 'x', buildArgs: () => [], parse: over.parse } as CliSpec)
        : undefined,
  };
}

console.log('\nA100 事件来源判定');

// ── 1. 判定分支 ────────────────────────────────────────────────────
{
  ok(eventSourceOf(undefined) === undefined, '定义不存在 → undefined（不猜）');
  ok(eventSourceOf(def({ kind: 'cli', parse: 'text' })) === 'parsed_text', 'cli + text → parsed_text');
  ok(eventSourceOf(def({ kind: 'cli', parse: 'jsonl' })) === 'structured_cli', 'cli + jsonl → structured_cli');
  ok(eventSourceOf(def({ kind: 'cli', parse: 'json-object' })) === 'structured_cli', 'cli + json-object → structured_cli');
  ok(eventSourceOf(def({ kind: 'cli' })) === undefined, 'cli 但没有 parse → undefined（不猜）');
  ok(eventSourceOf(def({ kind: 'acp' })) === 'native', 'acp → native');
  ok(eventSourceOf(def({ kind: 'http' })) === 'native', 'http → native');
  // ★ kind='sdk' 必须算 native：它说的是「我们怎么接」，而 def.sdk 说的是
  //   「有没有配 SDK 握手参数」，两者覆盖不重合。漏掉它会让主力 Agent
  //   （workbuddy）在界面上没有来源标注 —— 第一版就是这么漏的。
  ok(eventSourceOf(def({ kind: 'sdk' })) === 'native', "kind='sdk' → native（不依赖 def.sdk 字段）");

  // sdk 优先于 cli：两者同时存在时（SDK 握手失败才回退 CLI），
  // 能走 SDK 事件就是原生的 —— 这一条是「标错方向」的高发区
  const both = def({ kind: 'cli', parse: 'text' });
  both.sdk = { client: {} as AgentDefinition['sdk'] };
  ok(eventSourceOf(both) === 'native', 'sdk 与 cli 同时存在时 sdk 优先（标成 native 而非 parsed_text）');
}

// ── 2. 真表覆盖 ────────────────────────────────────────────────────
{
  console.log('\n真表覆盖（16 条定义）');
  const rows = AGENT_DEFS.map(d => ({
    id: d.descriptor.id,
    kind: d.descriptor.kind,
    parse: d.cli?.parse,
    hasSdk: !!d.sdk,
    source: eventSourceOf(d),
  }));

  for (const r of rows) {
    console.log(`    ${r.id.padEnd(12)} kind=${String(r.kind).padEnd(5)} parse=${String(r.parse ?? '-').padEnd(12)} sdk=${r.hasSdk ? '有' : '无'} → ${r.source}`);
  }

  const group = (s: string) => rows.filter(r => r.source === s).map(r => r.id);

  // 不硬编码数量（Agent 表会变），改成断**不变量**：
  // 每个 Agent 都能判出来源，且判定结果与它的接入方式自洽。
  const unknown = rows.filter(r => r.source === undefined);
  ok(unknown.length === 0, '没有「判定不出来」的 Agent（否则 UI 上它会静默缺标）', unknown.map(r => r.id).join(','));

  const wantNative = rows.filter(r => r.hasSdk || r.kind === 'sdk' || r.kind === 'acp' || r.kind === 'http');
  const gotNative = rows.filter(r => r.source === 'native');
  ok(wantNative.length === gotNative.length, 'native 的数量 = 走 SDK/ACP/HTTP/SDK kind 的数量', `${gotNative.length}/${wantNative.length}`);
  ok(
    wantNative.every(r => r.source === 'native'),
    '凡是走 SDK/ACP/HTTP 的都标成 native（没有一个漏标）',
    wantNative.filter(r => r.source !== 'native').map(r => r.id).join(',')
  );

  const textCli = rows.filter(r => r.parse === 'text' && r.kind === 'cli' && !r.hasSdk);
  const parsedText = rows.filter(r => r.source === 'parsed_text');
  ok(textCli.length === parsedText.length, 'parsed_text 的数量 = 纯文本 CLI 且没有 SDK 的数量', `${parsedText.length}/${textCli.length}`);
  ok(
    textCli.every(r => r.source === 'parsed_text'),
    '纯文本解析的一个都没被标成结构化（方向正确）',
    textCli.filter(r => r.source !== 'parsed_text').map(r => r.id).join(',')
  );

  const structured = rows.filter(r => r.source === 'structured_cli');
  const jsonl = rows.filter(r => r.parse === 'jsonl').length;
  const jsonObject = rows.filter(r => r.parse === 'json-object').length;
  ok(structured.length === jsonl + jsonObject, '结构化输出数 = jsonl + json-object', `${structured.length} = ${jsonl}+${jsonObject}`);

  // 汇总一行，方便人眼核对「到底哪几个 Agent 会被标成低可信度」
  console.log(`\n    native         ${group('native').join(', ')}`);
  console.log(`    structured_cli ${group('structured_cli').join(', ')}`);
  console.log(`    parsed_text    ${group('parsed_text').join(', ')}`);

  // 被标成低可信度的那几个必须真的很少 —— 这一条是功能的价值前提：
  // 如果满屏都是「文本解析」，这个标签就成了噪音而不是提示。
  ok(
    parsedText.length <= rows.length / 3,
    '被标成低可信度的 Agent 不超过三分之一（否则标签会变成噪音）',
    `${parsedText.length}/${rows.length}`
  );
}

// ── 3. 投影器必须以运行时值为准（这条最要紧）────────────────────
{
  console.log('\n投影器覆盖静态值');
  const { RunProjector } = await import('../server/agents/projector.js');

  // 静态值乐观地说是 native（构造时从定义表推导）
  const p = new RunProjector({
    runId: 'r1',
    sessionId: 's1',
    messageId: 'm1',
    agentId: 'qoder',
    source: 'native',
  });
  // 适配器随后报出真实通道：SDK 握手失败，回退到了纯文本 CLI
  p.push({ type: 'init', sessionId: 's1', source: 'parsed_text' });
  p.push({ type: 'tool', id: 't1', name: 'bash', input: { command: 'ls' } });

  const block = p.blockList.find(b => b.type === 'tool');
  ok(block?.source === 'parsed_text', 'init 报出的通道覆盖构造时的静态值', String(block?.source));

  // 反向：适配器没报时保持静态值，不猜
  const p2 = new RunProjector({
    runId: 'r2',
    sessionId: 's1',
    messageId: 'm2',
    agentId: 'codex',
    source: 'structured_cli',
  });
  p2.push({ type: 'init', sessionId: 's1' });
  p2.push({ type: 'tool', id: 't2', name: 'bash', input: { command: 'ls' } });
  const b2 = p2.blockList.find(b => b.type === 'tool');
  ok(b2?.source === 'structured_cli', '适配器没报时保留静态值', String(b2?.source));

  // 什么都没传 → undefined，UI 不标注也不猜
  const p3 = new RunProjector({ runId: 'r3', sessionId: 's1', messageId: 'm3', agentId: 'mock' });
  p3.push({ type: 'init', sessionId: 's1' });
  p3.push({ type: 'tool', id: 't3', name: 'bash', input: { command: 'ls' } });
  const b3 = p3.blockList.find(b => b.type === 'tool');
  ok(b3?.source === undefined, '静态与运行时都没给 → undefined（不猜）', String(b3?.source));
}

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`失败 ${failures.length} 条：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
