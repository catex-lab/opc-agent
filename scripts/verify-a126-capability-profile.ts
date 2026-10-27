/**
 * 过程能力档（P2）验证。
 *
 * 覆盖三件事，都是「清单在撒谎」那一类缺陷的防线：
 *   1. 能力档的 key 必须是 (引擎 · 模型 · 网关) 三元组 —— 同一个 codex
 *      接官方模型和接第三方网关是两种事件形态，按 Agent 折叠就分不清。
 *   2. `run_start` 只带声明（declared），**不许**带 observed ——
 *      把声明抄成观测，就是假数据的复现方式。
 *   3. `run_end` 的 observed 是投影器数出来的事实：有什么块就有什么能力；
 *      没出现过就是空数组（有意义的结论），不是缺字段（不知道）。
 *
 * 数据层用临时 OPC_DATA_DIR：`db.ts` 在 import 时会打开库并跑迁移，
 * 直接 import 会动到真实 `data/chat.db`。先把环境指到临时目录再动态 import。
 *
 * 运行：npx tsx scripts/verify-a126-capability-profile.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-capability-'));
process.env.OPC_DATA_DIR = tmpDir;

async function main() {
  const { RunProjector } = await import('../server/agents/projector.js');
  const { capabilityKeyOf, gatewayOf, runProfileOf } = await import('../server/agents/capability.js');
  const { capabilityKeyString, EVENT_CAPABILITY_ORDER } = await import('../shared/capabilities.js');
  const db = await import('../server/db.js');
  const { saveCredential } = await import('../server/agent-credentials.js');

  const KEY = { engine: 'codex', model: 'gpt-5', gateway: 'official:chatgpt.com' };
  const META = {
    runId: 'run-1',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentId: 'codex',
    model: 'gpt-5',
    capabilities: { key: KEY, declared: ['thinking', 'tool', 'usage', 'cost', 'permission'] },
  };

  // ============= 1. run_start：只有声明，没有观测 =============
  {
    const p = new RunProjector(META, () => 1_000);
    const start = p.push({ type: 'init', sessionId: 'sess-1' }).find(e => e.type === 'run_start');
    const caps = (start as any)?.capabilities;
    eq(caps?.key, KEY, '1-1 run_start 带三元组 key');
    eq(caps?.declared, META.capabilities.declared, '1-2 run_start 带声明清单');
    ok(caps && !('observed' in caps), '1-3 run_start 不许带 observed（声明≠观测）');
  }

  // ============= 2. run_end：observed 是从块序列数出来的 =============
  {
    const p = new RunProjector(META, () => 1_000);
    const out: any[] = [];
    out.push(...p.push({ type: 'init', sessionId: 'sess-1' }));
    out.push(...p.push({ type: 'thinking', content: '先看目录', format: 'summary' }));
    out.push(...p.push({ type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } }));
    out.push(...p.push({ type: 'tool_output', toolId: 't1', content: 'a.txt\n' }));
    out.push(...p.push({ type: 'permission_request', requestId: 'q1', toolName: 'Bash', input: {} }));
    out.push(...p.push({ type: 'usage', inputTokens: 10, outputTokens: 2 } as any));
    const { end } = p.finish('ok', { tokens: 12, cost: 0.01 });
    out.push(end);

    const start = out.find(e => e.type === 'run_start');
    const endCaps = (end as any).capabilities;
    eq(endCaps?.key, (start as any)?.capabilities?.key, '2-1 run_end 与 run_start 是同一个 key');
    eq(
      endCaps?.observed,
      ['thinking_summary', 'tool', 'tool_output', 'permission', 'usage', 'cost'],
      '2-2 observed 完整且按稳定顺序'
    );
    eq((end as any).capabilities?.declared, META.capabilities.declared, '2-3 run_end 仍带声明（两档并排可比）');

    // 排序口径必须和前端展示顺序同源
    const order = EVENT_CAPABILITY_ORDER;
    const idx = endCaps.observed.map((c: string) => order.indexOf(c));
    ok(idx.every((v: number, i: number) => i === 0 || v > idx[i - 1]), '2-4 observed 顺序来自 shared 的展示顺序');
  }

  // ============= 3. 原始思考与摘要必须是两个不同的能力位 =============
  {
    const p = new RunProjector(META, () => 1_000);
    p.push({ type: 'init', sessionId: 'sess-1' });
    p.push({ type: 'thinking', content: '完整推理' });
    const { end } = p.finish('ok');
    eq((end as any).capabilities?.observed, ['thinking'], '3-1 原文思考记 thinking，不记 thinking_summary');
  }

  // ============= 4. 空思考不制造「观察到」 =============
  {
    const p = new RunProjector(META, () => 1_000);
    p.push({ type: 'init', sessionId: 'sess-1' });
    p.push({ type: 'thinking', content: '' });
    const { end } = p.finish('ok');
    eq((end as any).capabilities?.observed, [], '4-1 空思考块没产出 → 不算观察到思考');
  }

  // ============= 5. 被隐去的思考（空正文 + redacted）算真的想过 =============
  {
    const p = new RunProjector(META, () => 1_000);
    p.push({ type: 'init', sessionId: 'sess-1' });
    p.push({ type: 'thinking', content: '', redacted: true });
    const { end } = p.finish('ok');
    eq((end as any).capabilities?.observed, ['thinking'], '5-1 redacted 思考仍记 thinking');
  }

  // ============= 6. 没给 key 就不伪造能力档 =============
  {
    const p = new RunProjector(
      { runId: 'r2', sessionId: 's', messageId: 'm', agentId: 'codex' },
      () => 1_000
    );
    const start = p.push({ type: 'init', sessionId: 's' }).find(e => e.type === 'run_start');
    const { end } = p.finish('ok');
    ok(!('capabilities' in (start as any)), '6-1 没给 key：run_start 不挂能力档（不伪造 unknown 引擎）');
    ok(!('capabilities' in (end as any)), '6-2 没给 key：run_end 同样不挂');
  }

  // ============= 7. key 推导：官方 / 自定义 / 本地 =============
  {
    eq(capabilityKeyOf('codex', 'gpt-5'), KEY, '7-1 codex 官方端点 → official:<host>');
    eq(gatewayOf('claude'), 'local:cli', '7-2 无官方端点 → local:<kind>');
    eq(runProfileOf('codex', 'gpt-5').declared, ['thinking_summary', 'tool', 'tool_output', 'usage'],
      '7-3 declared 来自定义表');

    // 自定义 baseUrl 必须压过官方端点：同一个引擎指向第三方网关时，
    // 事件形态取决于那个网关，不是厂商。
    saveCredential('doubao', { baseUrl: 'https://relay.example.com/v1' });
    eq(gatewayOf('doubao'), 'custom:relay.example.com', '7-4 自定义 baseUrl → custom:<host>');
    saveCredential('doubao', { baseUrl: '' });
    eq(gatewayOf('doubao'), 'official:ark.cn-beijing.volces.com', '7-5 清掉自定义地址后回到官方端点');

    eq(capabilityKeyString({ engine: 'codex', gateway: 'local:cli' }), 'codex||local:cli',
      '7-6 无模型时 key 串不留假值');
  }

  // ============= 8. 观测结果落库：按三元组覆盖，不按 Agent 折叠 =============
  {
    db.saveCapabilityProfile({
      key: KEY,
      declared: ['thinking', 'tool'],
      observed: ['thinking_summary', 'tool'],
    });
    const back = db.latestCapabilityProfileFor('codex');
    eq(back?.observed, ['thinking_summary', 'tool'], '8-1 落库后读回 observed');
    eq(back?.declared, ['thinking', 'tool'], '8-2 声明也一并留存');
    eq(back?.key, KEY, '8-3 三元组原样读回');

    // 同引擎 + 不同网关 = 两行（这是三元组的意义）
    db.saveCapabilityProfile({
      key: { engine: 'codex', model: 'gpt-5', gateway: 'custom:relay.example.com' },
      observed: [],
    });
    const raw = new DatabaseSync(path.join(tmpDir, 'chat.db'));
    const rows = raw
      .prepare('SELECT cap_key, observed FROM agent_capabilities WHERE engine = ? ORDER BY cap_key')
      .all('codex') as Array<{ cap_key: string; observed: string }>;
    raw.close();
    eq(rows.length, 2, '8-4 同引擎不同网关各存一行');
    ok(rows.some(r => r.observed === '[]'), '8-5 空观测也落库（"一项都没出现"是结论，不是没数据）');

    // 没有 observed 的档不写：那是 run_start 阶段，写进去等于把声明记成事实
    const before = rows.length;
    db.saveCapabilityProfile({ key: { engine: 'claude', model: 'x', gateway: 'local:cli' }, declared: ['tool'] });
    ok(db.latestCapabilityProfileFor('claude') === undefined, '8-6 没有 observed 的档不落库', `此前 ${before} 行`);
  }

  // 收尾
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上连接仍开着可能删不掉，忽略 */
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n✗ 能力档断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`);
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log(`\n能力档断言：${checks.total}/${checks.total} 通过`);
    console.log('✓ 三元组 key / run_start 只带声明 / run_end 的 observed 来自块序列 / 落库按三元组隔离');
  })
  .catch(err => {
    console.error('验证脚本异常:', err);
    process.exit(1);
  });
