/**
 * 真实标定框架（P3）验证。
 *
 * 分三层，离线可跑、不花 token：
 *   1. **纯函数**：归一化事件 → 能力清单（口径必须与投影器一致）
 *   2. **真实输出形状**：用本机实测的 codex / opencode NDJSON 片段喂解析器
 *      （2026-10-26 实跑记录，已去掉本机路径与个人信息）
 *   3. **缓存决策**：TTL 内不重跑、过期重跑、force 重跑、失败不写缓存
 *
 * 真起 CLI 的那一步不放进闸门：它需要网络与额度，失败原因多半是环境而不是代码。
 * 本脚本只验证「拿到输出之后会不会如实判定」。
 *
 * 运行：npx tsx scripts/verify-a127-capability-probe.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failures: string[] = [];
let total = 0;

function ok(cond: boolean, label: string, detail?: unknown) {
  total++;
  const d = detail === undefined ? '' : ` —— ${String(detail)}`;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${d}`);
  if (!cond) failures.push(label);
}

function eq(actual: unknown, expected: unknown, label: string) {
  total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : `\n      实际: ${a}\n      期望: ${e}`}`);
  if (!pass) failures.push(label);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-probe-'));
process.env.OPC_DATA_DIR = tmpDir;

/** 本机 2026-10-26 实测的 opencode 事件形状（prompt 与路径已替换） */
const OPENCODE_REASONING = '{"type":"reasoning","timestamp":1,"sessionID":"ses_x","part":{"type":"reasoning","text":"先推演一下：三个连续整数可以写成 n-1、n、n+1。","metadata":{"reasoningField":"reasoning_content"}}}';
const OPENCODE_TOOL = '{"type":"tool_use","timestamp":2,"sessionID":"ses_x","part":{"type":"tool","id":"call_1","tool":"shell","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\\r\\n","metadata":{"exit":0}}}}';
const OPENCODE_USAGE = '{"type":"step_finish","timestamp":3,"sessionID":"ses_x","part":{"type":"step-finish","reason":"tool-calls","cost":0.0028,"tokens":{"input":34,"output":11,"reasoning":17}}}';
const OPENCODE_TEXT = '{"type":"text","timestamp":4,"sessionID":"ses_x","part":{"type":"text","text":"好"}}';

/** 本机 2026-10-26 实测的 codex 事件形状 */
const CODEX_TOOL_START = '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
const CODEX_TOOL_DONE = '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"a.txt\\n","exit_code":0,"status":"completed"}}';
const CODEX_USAGE = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2,"reasoning_output_tokens":0}}';
const CODEX_REASONING = '{"type":"item.completed","item":{"id":"item_2","type":"reasoning","summary":"先确认 17*23 的拆分。"}}';

async function main() {
  const {
    capabilitiesFromEvents,
    eventsFromOutput,
    eventsFromJsonObject,
  } = await import('../server/agents/capability-probe.js');
  const { probeCapabilities } = await import('../server/agents/capability-probe.js');
  const { capabilityKeyOf } = await import('../server/agents/capability.js');
  const { capabilityKeyString, CAPABILITY_PROBE_TTL_MS } = await import('../shared/capabilities.js');
  const db = await import('../server/db.js');
  const { findDef } = await import('../server/agents/definitions.js');
  const { RunProjector } = await import('../server/agents/projector.js');

  // ============= 1. 事件 → 能力（纯函数） =============
  console.log('\n[1] 事件归一：口径与投影器一致');
  eq(
    capabilitiesFromEvents([
      { type: 'thinking', content: '原文' },
      { type: 'tool', id: 't1', name: 'Bash' },
      { type: 'tool_result', toolId: 't1', content: 'ok' },
      { type: 'usage', tokens: 12, cost: 0.01 },
    ]),
    ['thinking', 'tool', 'tool_output', 'usage', 'cost'],
    '原文思考 + 工具 + 用量/费用'
  );
  eq(
    capabilitiesFromEvents([{ type: 'thinking', content: '摘要', format: 'summary' }]),
    ['thinking_summary'],
    'summary 归档到 thinking_summary，不混进 thinking'
  );
  eq(
    capabilitiesFromEvents([
      { type: 'tool', id: 't1', name: 'Bash' },
      { type: 'tool_output', toolId: 't1', content: '逐行' },
    ]),
    ['tool', 'tool_output'],
    '增量输出也算 tool_output'
  );
  eq(capabilitiesFromEvents([{ type: 'usage', tokens: 9 }]), ['usage'], '只有 token 时不算 cost');
  eq(capabilitiesFromEvents([{ type: 'usage', cost: 0.02 }]), ['cost'], '只有费用时不算 usage');
  eq(capabilitiesFromEvents([{ type: 'text', content: '答案' }]), [], '纯文本不产生过程能力');
  eq(capabilitiesFromEvents([]), [], '空事件流 → 空清单');

  // ============= 2. 真实输出形状 → 事件 =============
  console.log('\n[2] 真实 NDJSON 形状解析');
  {
    const { events, parsedLines } = eventsFromOutput(
      [OPENCODE_REASONING, OPENCODE_TOOL, OPENCODE_USAGE, OPENCODE_TEXT].join('\n'),
      findDef('opencode')!.cli!.createMapper!()
    );
    ok(parsedLines === 4, '4 行 JSON 全部识别', parsedLines);
    eq(capabilitiesFromEvents(events), ['thinking', 'tool', 'tool_output', 'usage', 'cost'], 'opencode 实测形状 → 五项能力');
    const thinking = events.find(e => e.type === 'thinking');
    ok(
      thinking?.type === 'thinking' && thinking.content.includes('先推演'),
      'reasoning.part.text 原样成为思考正文'
    );
    const toolEvents = events.filter(e => e.type === 'tool' || e.type === 'tool_result');
    ok(toolEvents.length === 2, '一条 tool_use 拆成 tool + tool_result', toolEvents.length);
    const usage = events.find(e => e.type === 'usage');
    ok(
      usage?.type === 'usage' && usage.tokens === 62 && usage.cost === 0.0028,
      'step_finish 的 tokens 求和 + cost 透传',
      JSON.stringify(usage)
    );
  }
  {
    const { events } = eventsFromOutput(
      [CODEX_TOOL_START, CODEX_TOOL_DONE, CODEX_USAGE].join('\n'),
      findDef('codex')!.cli!.createMapper!()
    );
    eq(capabilitiesFromEvents(events), ['tool', 'tool_output', 'usage'], 'codex 实测形状 → 工具/输出/用量');
    ok(!events.some(e => e.type === 'usage' && e.cost != null), 'codex 没有 cost（turn.completed 不带价）');
  }
  {
    const j = eventsFromJsonObject('{"response":"好的","usage":{"inputTokens":3,"outputTokens":2}}', obj => {
      const o = obj as any;
      return { type: 'usage', tokens: Number(o.usage.inputTokens) + Number(o.usage.outputTokens) };
    });
    ok(j.parsedLines === 1 && j.events.length === 1, 'json-object 的 CLI 整体解析一次', JSON.stringify(j));
  }
  {
    const { events } = eventsFromOutput(
      CODEX_REASONING,
      findDef('codex')!.cli!.createMapper!()
    );
    eq(capabilitiesFromEvents(events), ['thinking_summary'], 'codex reasoning item → 摘要档');
  }
  {
    const { events, parsedLines } = eventsFromOutput(
      ['OPENCODE banner', '', OPENCODE_TEXT, 'not json'].join('\n'),
      findDef('opencode')!.cli!.createMapper!()
    );
    ok(
      parsedLines === 1 && events.length === 1 && events[0]!.type === 'text',
      '非 JSON 行被跳过，只留下那一条 text',
      `${parsedLines} 行 / ${events.length} 事件`
    );
  }

  // ============= 3. 缓存与失败边界 =============
  console.log('\n[3] TTL 缓存与「失败不写缓存」');
  const NOW = 1_800_000_000_000;
  const key = capabilityKeyOf('opencode', 'zai/glm-4.7');
  const fakeTarget = { command: 'fake-cli', prefixArgs: [] as string[], displayPath: 'fake-cli' };
  /** 最近一次假 spawn 收到的 argv（用于断言防护参数） */
  let lastArgs: string[] = [];

  const run = async (
    opts: {
      cached?: { capabilities: any[]; at: number };
      stdout?: string;
      code?: number;
      timedOut?: boolean;
      force?: boolean;
    } = {}
  ) => {
    const saves: Array<{ key: unknown; probe: unknown }> = [];
    let spawns = 0;
    const res = await probeCapabilities('opencode', 'zai/glm-4.7', {
      force: opts.force,
      now: () => NOW,
      target: fakeTarget,
      loadProbe: () => opts.cached,
      saveProbe: (k, p) => saves.push({ key: k, probe: p }),
      spawn: async (_t, args) => {
        spawns++;
        lastArgs = args;
        return {
          code: opts.code ?? 0,
          stdout: opts.stdout ?? OPENCODE_TEXT,
          stderr: opts.code && opts.code !== 0 ? 'boom' : '',
          timedOut: opts.timedOut ?? false,
        };
      },
    });
    return { res, saves, spawns };
  };

  {
    const { res, spawns, saves } = await run({
      cached: { capabilities: ['thinking'], at: NOW - 1_000 },
    });
    ok(res.ok && res.cached === true, 'TTL 内命中缓存');
    ok(spawns === 0 && saves.length === 0, '命中缓存时不起 CLI、不重写');
    eq(res.probe?.capabilities, ['thinking'], '缓存内容原样返回');
  }
  {
    const { res, spawns, saves } = await run({
      cached: { capabilities: ['thinking'], at: NOW - CAPABILITY_PROBE_TTL_MS - 1 },
      stdout: OPENCODE_REASONING,
    });
    ok(res.ok && res.cached === false, '过期缓存 → 重新标定');
    ok(spawns === 1, '过期后确实起了 CLI', spawns);
    ok(saves.length === 1, '新结果写回缓存', saves.length);
    eq(res.probe?.capabilities, ['thinking'], '新结果来自本次输出');
    ok(res.probe?.at === NOW, '标定时刻由时钟给出（可测）', res.probe?.at);
  }
  {
    const { spawns } = await run({
      cached: { capabilities: ['thinking'], at: NOW - 1_000 },
      force: true,
    });
    ok(spawns === 1, 'force 忽略新鲜缓存');
  }
  {
    const { res, saves } = await run({ code: 1 });
    ok(!res.ok && /退出码 1/.test(res.error ?? ''), '非零退出 → 失败', res.error);
    ok(saves.length === 0, '失败不写缓存');
  }
  {
    const { res, saves } = await run({ timedOut: true });
    ok(!res.ok && /超时/.test(res.error ?? ''), '超时 → 失败', res.error);
    ok(saves.length === 0, '超时不写缓存');
  }
  {
    const { res, saves } = await run({
      stdout: '{"type":"error","error":{"message":"unauthorized"}}',
    });
    ok(!res.ok && /unauthorized/.test(res.error ?? ''), 'CLI 报错事件 → 失败', res.error);
    ok(saves.length === 0, '报错不写缓存');
  }
  {
    const { res, saves } = await run({ stdout: 'hello, not json' });
    ok(!res.ok && /没有解析到任何结构化事件/.test(res.error ?? ''), '退出 0 但没有事件 → 失败', res.error);
    ok(saves.length === 0, '解析不到事件不算「零能力」');
  }
  {
    const { res, saves } = await run({ stdout: OPENCODE_TEXT });
    ok(res.ok, '跑通但只有文本 → 成功');
    eq(res.probe?.capabilities, [], '零能力是结论，写成空数组');
    ok(saves.length === 1, '零能力也要写缓存（≠ 没标定过）', saves.length);
  }
  {
    const { res } = await run({ stdout: OPENCODE_REASONING });
    ok(lastArgs.includes('--thinking'), '标定 argv 仍带 --thinking（否则永远测不到思考）');
    ok(
      lastArgs.includes('--format') && lastArgs[lastArgs.indexOf('--format') + 1] === 'json',
      '标定 argv 带 --format json'
    );
    ok(lastArgs.includes('-m') && lastArgs[lastArgs.indexOf('-m') + 1] === 'zai/glm-4.7', '标定用指定模型');
    eq(res.key, key, '返回的 key 与三元组一致');
  }
  {
    const codexArgs = await probeCapabilities('codex', 'gpt-5', {
      now: () => NOW,
      target: fakeTarget,
      loadProbe: () => undefined,
      saveProbe: () => {},
      spawn: async (_t, args) => {
        lastArgs = args;
        return { code: 0, stdout: CODEX_USAGE, stderr: '', timedOut: false };
      },
    });
    ok(codexArgs.ok, 'codex 标定走通');
    ok(lastArgs.includes('exec') && lastArgs.includes('--json'), 'codex argv 用 exec --json');
    ok(
      lastArgs.includes('-s') && lastArgs[lastArgs.indexOf('-s') + 1] === 'read-only',
      '标定强制 read-only 沙箱（模型不听劝也写不了文件）'
    );
  }

  // ============= 4. 落库与三元组隔离 =============
  console.log('\n[4] 缓存按三元组隔离');
  {
    const k1 = capabilityKeyOf('opencode', 'zai/glm-4.7');
    const k2 = capabilityKeyOf('opencode', 'opencode/deepseek-v4.1-flash-free');
    const k3 = { ...k1, gateway: 'custom:relay.example.com' };

    db.saveCapabilityProbe(k1, { capabilities: ['thinking', 'tool'], at: NOW });
    eq(db.loadCapabilityProbe(k1)?.capabilities, ['thinking', 'tool'], '写入后可按同一三元组读回');
    ok(db.loadCapabilityProbe(k2) === undefined, '换模型 → 不复用旧标定');
    ok(db.loadCapabilityProbe(k3) === undefined, '换网关 → 不复用旧标定');

    db.saveCapabilityProbe(k2, { capabilities: [], at: NOW + 1 });
    eq(db.loadCapabilityProbe(k2)?.capabilities, [], '空清单落库后仍是空数组，不是 undefined');

    db.saveCapabilityProbe(k1, { capabilities: ['thinking'], at: NOW + 2 });
    const again = db.loadCapabilityProbe(k1);
    eq(again?.capabilities, ['thinking'], '再次标定覆盖旧结论');
    ok(again?.at === NOW + 2, '覆盖同时更新标定时刻', again?.at);

    const row = db.default
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_capability_probes'")
      .get();
    ok(!!row, '缓存表已建（与观测表分开）');
    console.log(`      key 串: ${capabilityKeyString(k1)}`);
  }

  // ============= 5. 能力档带出 probed =============
  console.log('\n[5] run_start 带出已有标定结果');
  {
    const { runProfileOf } = await import('../server/agents/capability.js');
    const k = capabilityKeyOf('codex', 'gpt-5');
    db.saveCapabilityProbe(k, { capabilities: ['thinking_summary', 'usage'], at: NOW });
    const profile = runProfileOf('codex', 'gpt-5');
    eq(profile.probed?.capabilities, ['thinking_summary', 'usage'], '能力档包含 probed');
    ok(profile.declared?.length === 4, '声明仍在（probed 不改写声明）', profile.declared?.length);

    const p = new RunProjector(
      {
        runId: 'r1',
        sessionId: 's1',
        messageId: 'm1',
        agentId: 'codex',
        model: 'gpt-5',
        capabilities: profile,
      },
      () => 1
    );
    const start = p.push({ type: 'init', sessionId: 's1' }).find(e => e.type === 'run_start');
    const caps = (start as any)?.capabilities;
    eq(caps?.probed?.capabilities, ['thinking_summary', 'usage'], 'run_start 下发 probed');
    ok(caps?.observed === undefined, 'run_start 仍不带 observed');
  }

  console.log(`\n${total - failures.length}/${total} 通过`);
  // Windows 上数据库句柄不关就删不掉临时目录（EBUSY）。关库再删，失败也不影响结论。
  try {
    db.default.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 清不掉就留给系统临时目录 */
  }
  if (failures.length) {
    console.error(`\n失败：\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
