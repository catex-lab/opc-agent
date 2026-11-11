/**
 * #16 真实只读鉴权校验 + 前端刷新链路 · 服务端/源码闸门。
 *
 * 守的是「不报错的错」：
 *   1. 校验结论只能来自一次真实请求 —— 401 不能说成成功、404 不能说成
 *      「这家没 Key」、200 但返回登录页 HTML 也不能算验过。
 *   2. 接线真的接上：路由调了 verifyCredential，前端四处刷新链路都订阅/发事件。
 *      只写脚本不接线，是最典型的静默假绿。
 *   3. 溯源契约：`verified` 与 `provenance.verified` 必须同真同假，source 不含密钥。
 *   4. 反向探针：每条关键断言都把实现退回坏版本重跑，确认它真的会红。
 *
 * 全程用临时 OPC_DATA_DIR + 注入的 mock fetch，**不发任何真实外网请求**。
 * 运行：npx tsx scripts/verify-credential-verify.ts（已挂进 verify:ui）
 */
// 必须先于所有 server/** import：绝不触碰真实 data/
import './lib/temp-data-dir.js';

import { readFileSync } from 'node:fs';
import path from 'node:path';

let total = 0;
const failures: string[] = [];
function ok(cond: unknown, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
/** 只剥块注释与行首行注释；`https://` 在字符串里，不会被误伤。 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ============= [1] 接线契约（钉不变量，不钉实现字面量） ============= */
console.log('\n[1] 接线契约：路由与前端四处刷新链路');
{
  const FILES = {
    index: 'server/index.ts',
    verify: 'server/credential-verify.ts',
    bus: 'src/lib/credentialEvents.ts',
    useModels: 'src/hooks/useModels.ts',
    detail: 'src/components/AgentDetailSections.tsx',
    app: 'src/App.tsx',
    settings: 'src/components/SettingsPage.tsx',
    editor: 'src/components/AgentCredentialEditor.tsx',
  } as const;
  type Files = Record<keyof typeof FILES, string>;
  const real: Files = Object.fromEntries(
    Object.entries(FILES).map(([k, p]) => [k, stripComments(read(p))])
  ) as Files;

  /** 纯函数：给定一份源码副本，返回每条接线是否成立。 */
  const contract = (f: Files) => ({
    route:
      /app\.post\("\/api\/agents\/:agentId\/credential\/verify"/.test(f.index) &&
      /await verifyCredential\(/.test(f.index),
    noClientUrl:
      /credentialSpecOf\(/.test(f.verify) &&
      /getRawCredential\(/.test(f.verify) &&
      !/req\.body\??\.baseUrl/.test(f.verify),
    bus: /subscribeCredentialChanges/.test(f.bus) && /emitCredentialsChanged/.test(f.bus),
    useModels: /subscribeCredentialChanges\(/.test(f.useModels) && /fetchRef\.current\(\)/.test(f.useModels),
    account:
      /subscribeCredentialChanges\(/.test(f.detail) && /refreshKey/.test(f.detail),
    app: /emitCredentialsChanged\(/.test(f.app) && /setModelsEpoch\(/.test(f.app),
    settings: /emitEnvChanged\(/.test(f.settings),
    editorEmit: /emitCredentialsChanged\(agentId\)/.test(f.editor),
    editorVerify:
      /credential\/verify/.test(f.editor) &&
      /data-credential-verify-result/.test(f.editor) &&
      /data-verified=/.test(f.editor),
  });

  const base = contract(real);
  for (const [k, v] of Object.entries(base)) ok(v, `[1] ${k} 接线成立（肯定式）`);

  /** 反向探针：只把一条接线退回坏版本，那条必须变红，其余仍须全绿。 */
  const probes: Array<[keyof ReturnType<typeof contract>, keyof Files, string, string]> = [
    ['route', 'index', 'await verifyCredential(agentId)', 'await probeAccount(agentId)'],
    ['noClientUrl', 'verify', 'getRawCredential(', '/* 故意不读凭据 */ getRawCredentialKey('],
    ['bus', 'bus', 'subscribeCredentialChanges', 'subscribeNothing'],
    ['useModels', 'useModels', 'subscribeCredentialChanges(', '/* 掉线 */ subscribeNothing('],
    ['account', 'detail', 'subscribeCredentialChanges(', '/* 掉线 */ subscribeNothing('],
    ['app', 'app', 'emitCredentialsChanged();', '/* 不发事件 */'],
    ['settings', 'settings', 'emitEnvChanged();', '/* 不发事件 */'],
    ['editorEmit', 'editor', 'emitCredentialsChanged(agentId)', '/* 不发事件 */'],
    ['editorVerify', 'editor', 'data-credential-verify-result', 'data-removed'],
  ];
  for (const [key, file, from, to] of probes) {
    const bad: Files = { ...real, [file]: real[file].split(from).join(to) };
    const got = contract(bad);
    ok(
      got[key] === false && Object.entries(got).every(([k, v]) => k === key || v === true),
      `[1] 反向探针：退回 ${String(key)} 后只有这一条变红`,
      `others=${Object.entries(got).filter(([k, v]) => k !== key && !v).map(([k]) => k).join(',') || 'ok'}`
    );
  }
}

/* ============= [2] 纯函数：响应 → 结论 ============= */
const {
  parseModelsBody,
  decideVerification,
  verifyCredential,
  readonlyEndpointOf,
} = await import('../server/credential-verify.js');
const { saveCredential, clearCredential, __resetCredentialCache } = await import(
  '../server/agent-credentials.js'
);
const { mergeCredentialChanges } = await import('../src/lib/credentialEvents.ts');

console.log('\n[2] 纯函数：只有「2xx + 真模型清单」才允许 verified:true');
{
  eq(parseModelsBody(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }] }), 'openai'), ['m1', 'm2'], 'OpenAI 去重');
  eq(parseModelsBody(JSON.stringify({ models: [{ name: 'models/gemini-2' }] }), 'gemini'), ['gemini-2'], 'Gemini 剥前缀');
  eq(parseModelsBody('<html>login</html>', 'openai'), null, '登录页 HTML 不算清单');
  eq(parseModelsBody(JSON.stringify({ error: { message: 'no' } }), 'openai'), null, '带 error 的 JSON 不算清单');
  eq(parseModelsBody(JSON.stringify({ data: [] }), 'openai'), [], '空清单仍是合法响应');

  const good = JSON.stringify({ data: [{ id: 'a' }] });
  eq(decideVerification(200, good, 'openai'), { verified: true, models: ['a'] }, '200 → 已校验');
  eq(decideVerification(401, '', 'openai'), { verified: false, reason: 'invalid-key' }, '401 → Key 无效');
  eq(decideVerification(403, '', 'openai'), { verified: false, reason: 'invalid-key' }, '403 → Key 无效');
  eq(decideVerification(404, '', 'openai'), { verified: false, reason: 'no-readonly-endpoint' }, '404 → 没端点，不是「通了」');
  eq(decideVerification(429, '', 'openai'), { verified: false, reason: 'rate-limited' }, '429 → 限流，不下结论');
  eq(decideVerification(500, '', 'openai'), { verified: false, reason: 'upstream-error' }, '5xx → 上游故障');
  eq(decideVerification(200, '<html/>', 'openai'), { verified: false, reason: 'unexpected-response' }, '200 HTML → 不许升格');
}

console.log('\n[3] 事件总线：同 tick 合并，一次保存只重拉一轮');
{
  eq(mergeCredentialChanges([]), [], '空批次');
  const merged = mergeCredentialChanges([
    { kind: 'credentials', agentId: 'doubao' },
    { kind: 'credentials', agentId: 'doubao' },
    { kind: 'credentials' },
    { kind: 'credentials', agentId: 'gemini' },
    { kind: 'env' },
  ]);
  eq(merged, [{ kind: 'credentials' }, { kind: 'env' }], '全局事件吸收同类定向事件');
  const perAgent = mergeCredentialChanges([
    { kind: 'credentials', agentId: 'doubao' },
    { kind: 'credentials', agentId: 'gemini' },
    { kind: 'profiles', agentId: 'doubao' },
  ]);
  eq(perAgent.length, 3, '不同 Agent 的定向事件不被合并');
}

console.log('\n[4] 真行为：注入 mock fetch，绝不打真实外网');
{
  // 关键：夹具 Key 只存在于临时 data/ 与进程环境，测试结束清掉
  const KEY = 'ark-fixture-key-1234567890';
  const envBackup = { ...process.env };
  saveCredential('doubao', { key: KEY });

  type MockFetch = typeof globalThis.fetch;
  const respond = (status: number, body: string): MockFetch =>
    (async () => new Response(body, { status })) as unknown as MockFetch;

  const endpoint = readonlyEndpointOf('doubao');
  ok(!!endpoint, 'doubao 能从定义表推出只读端点');
  ok(
    !!endpoint && endpoint.url.endsWith('/api/v3/models') && endpoint.url.startsWith('https://'),
    '端点剥掉了 /chat/completions 后缀',
    endpoint?.url
  );
  ok(!!endpoint && !endpoint.url.includes(KEY), 'URL 里绝不带 Key');
  ok(
    !!endpoint && endpoint.headers.authorization === `Bearer ${KEY}`,
    'Key 确实进了鉴权头（否则「不进 URL」可能只是压根没发）'
  );

  const good = JSON.stringify({ data: [{ id: 'doubao-pro' }, { id: 'ep-xxx' }] });
  const okCase = await verifyCredential('doubao', respond(200, good));
  ok(okCase.verified === true, '200 + 真清单 → verified:true');
  eq(okCase.models, ['doubao-pro', 'ep-xxx'], '顺带回传模型 ID');
  ok(okCase.provenance.verified === true, 'provenance.verified 与结论同真');
  ok(okCase.provenance.source.includes('GET ') && !okCase.provenance.source.includes(KEY), '溯源 source 不含密钥');
  ok(okCase.checkedAt === okCase.provenance.probedAt, 'checkedAt 与 probedAt 是同一时刻');

  /** 「无效 Key 判红」这条断言抽成函数，供反向探针复用。 */
  const invalidKeyProbe = (r: { verified: boolean; reason?: string; provenance: { verified: boolean } }) =>
    r.verified === false && r.reason === 'invalid-key' && r.provenance.verified === false;

  const badCase = await verifyCredential('doubao', respond(401, ''));
  ok(invalidKeyProbe(badCase), '401 + verified:false + provenance 也 false（肯定式）');

  // 反向探针：塞一个「401 也说成功」的坏决定函数，确认上面那条断言真的变红
  const brokenDecide = (() => ({ verified: true, models: ['fake'] })) as typeof decideVerification;
  const brokenCase = await verifyCredential('doubao', respond(401, ''), brokenDecide);
  ok(brokenCase.verified === true, '反向探针：坏实现确实把 401 说成成功');
  ok(!invalidKeyProbe(brokenCase), '反向探针：无效 Key 断言随之变红（不是假绿）');

  const cases: Array<[number, string, string]> = [
    [404, '', 'no-readonly-endpoint'],
    [429, '', 'rate-limited'],
    [500, '', 'upstream-error'],
    [200, '<html/>', 'unexpected-response'],
  ];
  for (const [status, body, reason] of cases) {
    const r = await verifyCredential('doubao', respond(status, body));
    ok(r.verified === false && r.reason === reason, `${status} → ${reason} 且不假装成功`);
    ok(!!r.error && r.error.length > 0, `${status} 给得出人话结论`);
  }

  const netFail = await verifyCredential(
    'doubao',
    (async () => { throw new Error('offline'); }) as unknown as MockFetch
  );
  ok(netFail.verified === false && netFail.reason === 'network-error', '网络异常 → 无法判断，不抛错');

  // 显式给一个 env Key，让「没有只读端点」与「没有凭据」这两种原因不混淆
  process.env.CODEBUDDY_API_KEY = 'sdk-fixture-key';
  const noEndpoint = await verifyCredential('workbuddy', respond(200, good));
  ok(
    noEndpoint.verified === false && noEndpoint.reason === 'no-readonly-endpoint',
    'SDK 登录态类没有只读端点 → 如实说验不了'
  );

  clearCredential('doubao');
  for (const n of ['ARK_API_KEY', 'DOUBAO_API_KEY']) delete process.env[n];
  const noKey = await verifyCredential('doubao', respond(200, good));
  ok(noKey.verified === false && noKey.reason === 'no-credential', '没存 Key → 不发起请求、不假装校验');

  // 环境变量也算已配置：开发态 export 的 Key 同样能被校验
  process.env.ARK_API_KEY = KEY;
  __resetCredentialCache();
  const fromEnv = await verifyCredential('doubao', respond(200, good));
  ok(fromEnv.verified === true, '环境变量里的 Key 也能校验（fromEnv 不是死路）');

  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k]!;
  }
  for (const k of Object.keys(process.env)) {
    if (!(k in envBackup)) delete process.env[k];
  }
  clearCredential('doubao');
}

console.log(`\n=== ${total - failures.length}/${total} 通过 ===`);
if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
