/**
 * 全通道首字护栏闸门（SOLUTION-PLAN 1.1c / C3）。
 *
 * 护栏的「不报错的错」：
 *   · 首字前不守 → 用户对着静止气泡无限等（原缺陷）；
 *   · 首字后也守 → 合法的长工具间隔被误杀成「回复到一半断了」（AUDIT 明令禁止）；
 *   · 只在 registry 包了但 turn-runner 不消费 → 等于没做。
 * 用小 timeoutMs 精确钉这三条，并静态断言接线完整。
 *
 * 运行：npx tsx scripts/verify-first-token-guard-stream.ts
 */
import './lib/temp-data-dir.js';
import { readFileSync } from 'node:fs';
import { withFirstTokenGuard, guardTimeoutMessage } from '../server/agents/firstTokenGuardStream.js';
import type { AgentEvent } from '../server/agents/types.js';

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 造一个「延迟 delayMs 后吐一个 init 事件再结束」的源 */
function delayedSource(delayMs: number, events: AgentEvent[] = [{ type: 'init', sessionId: 's' }]): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await sleep(delayMs);
      for (const e of events) yield e;
    },
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function main() {
  // [1] 措辞中性（推广到所有通道，不写死 SDK / 模型）
  const msg = guardTimeoutMessage(120_000);
  ok(msg.includes('120 秒') && !/SDK|模型/.test(msg), '超时措辞中性且含秒数', msg);

  // [2] 首字前超时 → throw 人话错误
  {
    const guarded = withFirstTokenGuard(delayedSource(500), 60);
    let threw: Error | null = null;
    try { await collect(guarded); } catch (e) { threw = e as Error; }
    ok(threw !== null, '首字前超时会抛出');
    ok(!!threw && /秒没有任何响应/.test(threw.message), '抛的是人话错误', threw?.message);
  }

  // [3] 首字及时到达 → 正常透传，不误杀
  {
    const events: AgentEvent[] = [
      { type: 'init', sessionId: 's' },
      { type: 'text', content: 'hi' },
      { type: 'done' },
    ];
    const got = await collect(withFirstTokenGuard(delayedSource(10, events), 300));
    ok(got.length === 3, '首字及时到达：事件全透传', `收到 ${got.length}`);
    ok(got[1]?.type === 'text' && got[2]?.type === 'done', '事件顺序不变');
  }

  // [4] 关键：首字后长间隔（超过 guard 阈值）不被误杀
  {
    const source: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', sessionId: 's' } as AgentEvent;
        await sleep(180); // 远超 60ms 阈值
        yield { type: 'text', content: 'after long tool' } as AgentEvent;
      },
    };
    let threw: Error | null = null;
    let got: AgentEvent[] = [];
    try { got = await collect(withFirstTokenGuard(source, 60)); } catch (e) { threw = e as Error; }
    ok(threw === null, '首字后 180ms 长间隔不被误杀（防误杀长任务）', threw?.message ?? 'ok');
    ok(got.length === 2 && got[1]?.type === 'text', '长间隔后正文照常到达', JSON.stringify(got.map(e => e.type)));
  }

  // [5] 反向探针：如果不包护栏，慢源不会抛（证明超时断言不是恒真）
  {
    let threw = false;
    try { await collect(delayedSource(500)); } catch { threw = true; }
    ok(!threw, '反向探针：不包护栏时慢源不抛（超时来自护栏）');
  }

  // [6] 静态闸门：registry.stream 真的包了，且有关闭开关
  const src = readFileSync(new URL('../server/agents/registry.ts', import.meta.url), 'utf8');
  ok(src.includes('withFirstTokenGuard(source)'), 'registry.stream 包装护栏');
  ok(src.includes('OPC_REGISTRY_FIRST_TOKEN_GUARD'), '有一键关闭开关（可回退）');
  // 反向探针：包装调用出现在 stream 方法体内（不是 import 完没用）
  const streamBlock = src.slice(src.indexOf('stream(id: string'), src.indexOf('stream(id: string') + 1400);
  ok(streamBlock.includes('withFirstTokenGuard'), '包装在 stream() 方法体内');

  // [7] 静态闸门：turn-runner 既有 catch/finish 负责 error + run_end（护栏不重复造）
  const runner = readFileSync(new URL('../server/turn-runner.ts', import.meta.url), 'utf8');
  ok(/catch \(err: any\)/.test(runner) && /type: 'error'/.test(runner), 'turn-runner 有异常→error 事件的既有链路');
  ok(/projector\.finish\(status/.test(runner), 'turn-runner 既有 finish 补 run_end');

  if (failures.length) {
    console.error(`[GUARD] ✗ ${failures.length}/${total} 失败`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`[GUARD] ✓ ${total}/${total} 全部通过`);
}
main();
