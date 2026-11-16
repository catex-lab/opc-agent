/**
 * SSE 心跳闸门（C8 / SUPER-AGENT-DESIGN §八 8.2）。
 *
 * 为什么值得单独测：心跳是「不报错的错」的高发区 ——
 *   · 帧格式写成 data: 帧 → 前端 JSON.parse 失败或当成假事件；
 *   · 定时器没清理 → 进程退不出、连接关了还在写；
 *   · 只在一条 SSE 端点接了 → 其余端点仍会「一直转圈」。
 * 这三条单看都不报错，必须钉到最外层可观测量（帧字节 + 清理行为）。
 *
 * 运行：npx tsx scripts/verify-sse-heartbeat.ts
 */
import './lib/temp-data-dir.js';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  startSseHeartbeat,
  HEARTBEAT_FRAME,
  DEFAULT_HEARTBEAT_MS,
  type HeartbeatWritable,
} from '../server/sse-heartbeat.js';

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

class MockRes extends EventEmitter implements HeartbeatWritable {
  chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  write(chunk: string) { this.chunks.push(chunk); return true; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  // [1] 帧格式：必须是 SSE 注释帧，不含 data: 前缀（前端只认 data: 行）
  ok(HEARTBEAT_FRAME === ': heartbeat\n\n', '心跳帧是 SSE 注释帧', JSON.stringify(HEARTBEAT_FRAME));
  ok(!HEARTBEAT_FRAME.startsWith('data:'), '心跳帧不带 data: 前缀（不会被当事件解析）');
  ok(HEARTBEAT_FRAME.endsWith('\n\n'), '心跳帧以空行收尾（SSE 帧分隔）');

  // 前端 consume() 的解析规则：frame.split('\n').find(l => l.startsWith('data: '))
  // 用同一规则验证注释帧被跳过（反向探针：若帧是 data: 帧则会被解析）
  const frameLine = HEARTBEAT_FRAME.trim().split('\n').find(l => l.startsWith('data: '));
  ok(frameLine === undefined, '前端解析规则跳过心跳帧（find data: 行 = undefined）');
  const badFrame = 'data: heartbeat\n\n'.trim().split('\n').find(l => l.startsWith('data: '));
  ok(badFrame !== undefined, '反向探针：data: 帧会被前端解析（证明断言不是恒真）');

  // [2] 定时器真实触发（用短间隔）+ 帧字节正确
  const res = new MockRes();
  process.env.OPC_SSE_HEARTBEAT_MS = '40';
  const stop = startSseHeartbeat(res);
  await sleep(150);
  ok(res.chunks.length >= 2, '短间隔下心跳真实触发', `收到 ${res.chunks.length} 帧`);
  ok(res.chunks.every(c => c === HEARTBEAT_FRAME), '每帧字节都正确', JSON.stringify(res.chunks.slice(0, 3)));

  // [3] stop() 后不再发帧
  const before = res.chunks.length;
  stop();
  await sleep(120);
  ok(res.chunks.length === before, 'stop() 后心跳停止', `${before} → ${res.chunks.length}`);
  stop(); // 幂等
  ok(true, 'stop() 幂等（第二次不抛）');

  // [4] res close 自动清理
  const res2 = new MockRes();
  startSseHeartbeat(res2);
  const before2 = res2.chunks.length;
  res2.emit('close');
  await sleep(120);
  ok(res2.chunks.length === before2, 'res close 后自动停', `${before2} → ${res2.chunks.length}`);

  // [5] writableEnded 后自动停（下一 tick 检测到）
  const res3 = new MockRes();
  startSseHeartbeat(res3);
  res3.writableEnded = true;
  await sleep(120);
  ok(res3.chunks.length === 0, 'writableEnded 后不再写帧', `写了 ${res3.chunks.length} 帧`);

  // [6] 默认间隔是 20 秒（设计 §8.2 的 15-30s 区间）
  ok(DEFAULT_HEARTBEAT_MS === 20_000, '默认间隔 20 秒', String(DEFAULT_HEARTBEAT_MS));
  delete process.env.OPC_SSE_HEARTBEAT_MS;

  // [7] 静态闸门：6 条 SSE 流端点都接了心跳（防「只修一条就是半修」）
  // F0-02②：路由分区后调用点分散在 index.ts 与 server/routes/*，合并计数。
  const src =
    readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('../server/routes/verify.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('../server/routes/image.ts', import.meta.url), 'utf8');
  const calls = (src.match(/startSseHeartbeat\(res\)/g) ?? []).length;
  ok(calls >= 6, '所有 SSE 端点都接了心跳（>=6 处调用）', `实际 ${calls} 处`);
  // 反向探针：如果从没调用过，上面断言必须变红
  ok(!src.includes('startSseHeartbeat(res)') === false, '反向探针：源码确实含调用');

  if (failures.length) {
    console.error(`[HEARTBEAT] ✗ ${failures.length}/${total} 失败`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`[HEARTBEAT] ✓ ${total}/${total} 全部通过`);
}
main();
