/**
 * 闸门：API 薄层（绞杀者第 0 期）。
 *
 * 钉死 `src/api.ts` 的「只搬家不改行为」红线：
 *   1. method 由方法名决定（get/post/put/patch/delete）；
 *   2. init **逐字透传**（headers / body / signal / credentials），不自动加 header；
 *   3. 流式（api.stream）返回原始 Response，调用方自己读 getReader；
 *   4. 反向探针：若未来有人把「不自动加 header」改成「自动 JSON」，本闸门要变红。
 *
 * 用 mock fetch 注入，不发起真实网络请求；纯函数级验证，无副作用。
 */

// —— 内联断言（照 verify-start-server.ts 惯例）——
const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// —— 捕获真实 fetch，替换成 mock ——
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];
globalThis.fetch = (async (url: any, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return { ok: true, status: 200 } as Response;
}) as typeof fetch;

const { api } = await import('../src/api.js');

function reset() {
  calls.length = 0;
}

try {
  // [1] method 由方法名决定
  await api.get('/a');
  ok(calls[0].init?.method === 'GET', 'get → GET');
  await api.post('/b');
  ok(calls[1].init?.method === 'POST', 'post → POST');
  await api.put('/c');
  ok(calls[2].init?.method === 'PUT', 'put → PUT');
  await api.patch('/d');
  ok(calls[3].init?.method === 'PATCH', 'patch → PATCH');
  await api.delete('/e');
  ok(calls[4].init?.method === 'DELETE', 'delete → DELETE');

  // [2] init 逐字透传：headers / body / signal / credentials 原样到达
  reset();
  const signal = new AbortController().signal;
  await api.post('/f', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: 1 }),
    signal,
    credentials: 'include',
  });
  ok(calls[0].init?.headers?.['Content-Type'] === 'application/json', 'headers 透传');
  ok(calls[0].init?.body === JSON.stringify({ x: 1 }), 'body 透传');
  ok(calls[0].init?.signal === signal, 'signal 透传');
  ok(calls[0].init?.credentials === 'include', 'credentials 透传');

  // [3] 不自动加 header：get 无 init 时 headers 为 undefined（反向探针锚点）
  reset();
  await api.get('/g');
  ok(calls[0].init?.headers === undefined, 'get 不自动加 Content-Type');

  // [4] 流式：返回原始 Response（不 JSON 包装）
  reset();
  const r = await api.stream('/h', { method: 'POST' });
  ok(r.status === 200 && r.ok === true, 'stream 返回原始 Response');
  ok(calls[0].init?.method === 'POST', 'stream 的 method 由 init 决定');

  // [5] 方法名覆盖 init 里误留的 method（宽松，不炸）
  reset();
  await api.post('/i', { method: 'GET' } as RequestInit);
  ok(calls[0].init?.method === 'POST', '方法名优先于 init 里的 method');
} finally {
  globalThis.fetch = realFetch;
}

if (failures.length) {
  console.error(`[API] ✗ ${failures.length}/${total} 失败`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`[API] ✓ ${total}/${total} 全部通过`);
