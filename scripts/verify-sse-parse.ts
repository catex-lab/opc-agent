/**
 * 闸门：SSE 分帧/解析合一（绞杀者第 0 期 / F0-02②）。
 *
 * 钉死 `src/lib/sse-parse.ts` 从 useChat / useGroupChat 两处副本搬出来时的行为：
 *   1. 按空行分帧，一帧被拆到两次 read 也能拼回来；
 *   2. 只认 `data: `（冒号后有空格）那行，一帧多条 data 只取第一条（现状行为）；
 *   3. 心跳注释帧（`: heartbeat`）不产生事件，但要触发 onChunk（看门狗靠它刷新）；
 *   4. 单帧 JSON 坏掉只丢这一帧，不拖垮整条流；
 *   5. 响应体不可读必须抛错（静默 return 会让气泡永久转圈）。
 *
 * 用 mock reader 注入，不发真实网络请求；纯函数级验证。
 */

import { readSseStream } from '../src/lib/sse-parse.js';

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

const encoder = new TextEncoder();

/** 把一个 chunk 列表包成 Response 形状；chunk 为 '' 时模拟「读到空字节」 */
function mockResponse(chunks: Array<string | Uint8Array>): Response {
  let i = 0;
  const reader = {
    read: async () => {
      if (i >= chunks.length) return { done: true, value: undefined };
      const c = chunks[i++];
      const value = typeof c === 'string' ? encoder.encode(c) : c;
      return { done: false, value };
    },
  };
  return { body: { getReader: () => reader } } as unknown as Response;
}

async function collect(chunks: Array<string | Uint8Array>) {
  const events: any[] = [];
  let chunksSeen = 0;
  await readSseStream(mockResponse(chunks), e => events.push(e), { onChunk: () => chunksSeen++ });
  return { events, chunksSeen };
}

try {
  // [1] 基本分帧：一次读里两帧
  {
    const { events } = await collect(['data: {"n":1}\n\ndata: {"n":2}\n\n']);
    ok(events.length === 2 && events[0].n === 1 && events[1].n === 2, '一次读两帧按序交付');
  }

  // [2] 半帧跨两次 read
  {
    const { events } = await collect(['data: {"n":', '1}\n\n']);
    ok(events.length === 1 && events[0].n === 1, '半帧跨两次 read 能拼回');
  }

  // [3] 心跳注释帧：不产生事件，但算一次「读到字节」
  {
    const { events, chunksSeen } = await collect([': heartbeat\n\n', 'data: {"n":3}\n\n']);
    ok(events.length === 1 && events[0].n === 3, '心跳注释帧不产生事件');
    ok(chunksSeen === 2, '心跳帧也触发 onChunk', `chunksSeen=${chunksSeen}`);
  }

  // [4] 坏帧不拖垮后续帧
  {
    const { events } = await collect(['data: {broken}\n\ndata: {"n":4}\n\n']);
    ok(events.length === 1 && events[0].n === 4, '坏 JSON 只丢那一帧');
  }

  // [5] 一帧多条 data 行：只取第一条（现状行为，不是协议升级）
  {
    const { events } = await collect(['data: {"n":5}\ndata: {"n":6}\n\n']);
    ok(events.length === 1 && events[0].n === 5, '一帧多条 data 只取第一条');
  }

  // [6] 非 data 行忽略；`data:` 无空格不算（与后端 'data: ' 写法对齐）
  {
    const { events } = await collect(['event: ping\nid: 7\n\ndata:{"n":8}\n\n']);
    ok(events.length === 0, '非 data 行整帧忽略');
  }

  // [7] 空 value 不触发 onChunk（空流不该被当成健康的连接）
  {
    const { chunksSeen } = await collect([new Uint8Array(0)]);
    ok(chunksSeen === 0, '空 value 不触发 onChunk');
  }

  // [8] 响应体不可读必须抛
  {
    let threw = false;
    try {
      await readSseStream({ body: null } as Response, () => {});
    } catch {
      threw = true;
    }
    ok(threw, 'body 为 null 时抛错（不静默 return）');
  }
} catch (e) {
  failures.push(`未捕获异常：${(e as Error).message}`);
}

if (failures.length) {
  console.error(`[SSE-PARSE] ✗ ${failures.length}/${total} 失败`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`[SSE-PARSE] ✓ ${total}/${total} 全部通过`);
