/**
 * #15 多账号 profile · 服务端与接线闸门。
 *
 * 最怕的不是「切不了」，而是**切了但没生效**：active 改了、界面显示新账号，
 * 进程环境里却还是上一把 Key，或残留了上一个账号的网关地址。所以这里的
 * 每条正向断言都同时钉住「落盘形状」「内存 active」「process.env」三层。
 *
 * 另守一条兼容红线：**单账号时仍按旧形状写盘**。老版本读不懂
 * `{active, profiles}`，一旦升级就写新形状，用户降级 / 回滚会直接丢 Key。
 *
 * 反向探针：接线类逐条退回坏版本；运行时用「不切换」的对照组证明
 * 「env 已换成新 Key」不是恒真断言。全程临时 OPC_DATA_DIR，不碰真实 data/。
 * 运行：npx tsx scripts/verify-credential-profiles.ts（已挂进 verify:ui）
 */
// 必须先于所有 server/** import
import './lib/temp-data-dir.js';

import fs from 'node:fs';
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
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const STORE_FILE = path.join(process.env.OPC_DATA_DIR!, 'agent-credentials.json');
const raw = () => JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));

/* ============= [1] 接线契约（含逐条反向探针） ============= */
console.log('\n[1] 接线契约：三个端点 + 统一缓存失效 + 前端动作');
{
  const FILES = {
    index: 'server/index.ts',
    editor: 'src/components/AgentCredentialEditor.tsx',
    store: 'server/agent-credentials.ts',
  } as const;
  type Files = Record<keyof typeof FILES, string>;
  const real: Files = Object.fromEntries(
    Object.entries(FILES).map(([k, p]) => [k, stripComments(read(p))])
  ) as Files;

  /** 取一条 Express 路由的函数体，避免把别的路由里的同名调用算进来。 */
  const routeBody = (s: string, start: string) => {
    const i = s.indexOf(start);
    if (i < 0) return '';
    const j = s.indexOf('\napp.', i + start.length);
    return s.slice(i, j < 0 ? undefined : j);
  };

  const contract = (f: Files) => ({
    saveName: /saveCredential\(agentId, \{[^}]*\bname\b/.test(
      routeBody(f.index, 'app.post("/api/agent-credentials"')
    ),
    // 注意：不能只钉 `switchProfile(` —— 同一条路由里的日志字符串
    // `invalidateAllModelCaches(\`switchProfile(${agentId})\`)` 也含这串，
    // 把真正的调用删掉后正则照样绿（典型的假绿）。必须钉到实参形状。
    switchRoute:
      /switchProfile\(agentId, name\)/.test(routeBody(f.index, 'app.post("/api/agent-credentials/:agentId/switch"')) &&
      /invalidateAllModelCaches\(/.test(routeBody(f.index, 'app.post("/api/agent-credentials/:agentId/switch"')),
    profilesRoute:
      /listProfiles\(/.test(routeBody(f.index, 'app.get("/api/agent-credentials/:agentId/profiles"')),
    deleteRoute:
      /deleteProfile\(agentId, name\)/.test(routeBody(f.index, 'app.delete("/api/agent-credentials/:agentId/profiles/:name"')) &&
      /invalidateAllModelCaches\(/.test(routeBody(f.index, 'app.delete("/api/agent-credentials/:agentId/profiles/:name"')),
    maskedOnly: /mask\(key\)/.test(f.store) && /masked: mask\(/.test(f.store),
    frontend:
      /data-credential-profiles=/.test(f.editor) &&
      /data-credential-profile=/.test(f.editor) &&
      /\/switch/.test(f.editor) &&
      /profiles\//.test(f.editor) &&
      /emitCredentialsChanged\(/.test(f.editor),
  });

  const base = contract(real);
  for (const [k, v] of Object.entries(base)) ok(v, `[1] ${k} 接线成立（肯定式）`);

  const probes: Array<[keyof ReturnType<typeof contract>, keyof Files, string, string]> = [
    ['saveName', 'index', ', name }', ' }'],
    ['switchRoute', 'index', 'switchProfile(agentId, name)', 'listProfiles(agentId)'],
    ['profilesRoute', 'index', 'res.json(listProfiles(agentId))', 'res.json({})'],
    ['deleteRoute', 'index', 'deleteProfile(agentId, name)', 'listProfiles(agentId)'],
    ['maskedOnly', 'store', 'masked: mask(key)', 'masked: key'],
    ['frontend', 'editor', 'data-credential-profiles=', 'data-removed='],
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

/* ============= [2] 运行时：落盘 / active / env 三层 ============= */
const {
  saveCredential,
  clearCredential,
  switchProfile,
  listProfiles,
  deleteProfile,
  getRawCredential,
  loadAgentCredentials,
  __resetCredentialCache,
} = await import('../server/agent-credentials.js');
const { readonlyEndpointOf } = await import('../server/credential-verify.js');

const envBackup = { ...process.env };
const KEY_A = 'ark-account-a-1234567890';
const KEY_B = 'ark-account-b-0987654321';

console.log('\n[2] 旧形状兼容：老数据当 default 账号读，升级不迁移');
{
  __resetCredentialCache();
  fs.writeFileSync(STORE_FILE, JSON.stringify({ doubao: { key: KEY_A, baseUrl: '' } }));
  const list = listProfiles('doubao');
  eq(list.active, 'default', '老数据 active=default');
  eq(list.profiles.map(p => p.name), ['default'], '只有一个账号');
  eq(getRawCredential('doubao').key, KEY_A, '明文读取走 active 账号');
  ok(
    !JSON.stringify(list).includes(KEY_A),
    '账号列表出参不含明文 Key（只有掩码）'
  );
  loadAgentCredentials();
  eq(process.env.ARK_API_KEY, KEY_A, '冷启动注入的是 active 账号的 Key');
}

console.log('\n[3] 单账号仍写旧形状；另存新账号才升级形状');
{
  const v = saveCredential('doubao', { key: KEY_A });
  eq(v.activeProfile, 'default', '普通保存不改账号名');
  eq(v.profileCount, 1, '仍是一个账号');
  ok(
    typeof raw().doubao.key === 'string' && raw().doubao.profiles === undefined,
    '单账号落盘仍是旧形状（老版本可读）',
    JSON.stringify(raw().doubao)
  );

  saveCredential('doubao', { key: KEY_B, name: '工作号' });
  const shape = raw().doubao;
  ok(!!shape.profiles && shape.active === '工作号', '第二个账号落成新形状且立刻激活');
  eq(Object.keys(shape.profiles).sort(), ['default', '工作号'].sort(), '两个账号都在');
  eq(getRawCredential('doubao').key, KEY_B, '原始 Key 读到的是新账号');
  eq(process.env.ARK_API_KEY, KEY_B, '进程环境也换成新账号的 Key');

  // 跨模块肯定式：鉴权校验拿到的必须是当前 active 账号，而不是 default
  const endpoint = readonlyEndpointOf('doubao');
  ok(
    !!endpoint && endpoint.headers.authorization === `Bearer ${KEY_B}`,
    'credential-verify 也读 active 账号（不是旧 default）'
  );
}

console.log('\n[4] 切换：env 与网关地址一起换，旧值不残留');
{
  /** 「切到新账号后 env 真是新 Key」这条断言抽出来给反向探针对照。 */
  const switchedProbe = () =>
    getRawCredential('doubao').key === KEY_A && process.env.ARK_API_KEY === KEY_A;

  const view = switchProfile('doubao', 'default');
  eq(view.activeProfile, 'default', '切回 default');
  eq(getRawCredential('doubao').key, KEY_A, '原始 Key 回到 A');
  eq(process.env.ARK_API_KEY, KEY_A, '进程环境回到 A');
  ok(switchedProbe(), '切换后三层一致（肯定式）');

  // 反向探针：同一条探针在「不切换」时为真、「切到 B」时为假。
  // 少了后半条，「三层一致」可能只是因为环境里本来就一直是 A（恒真断言）。
  ok(switchedProbe(), '反向探针：对照组（仍停在 A）探针为真');
  switchProfile('doubao', '工作号');
  ok(!switchedProbe(), '反向探针：切到 B 后同一探针变红（证明它真盯着切换动作）');
  switchProfile('doubao', 'default');

  // 网关地址残留：profile 有 baseUrl，切到没有 baseUrl 的账号必须清掉
  saveCredential('gemini', { key: 'AIza-GEM-A', baseUrl: 'https://gw-a.example.com', name: 'A' });
  saveCredential('gemini', { key: 'AIza-GEM-B', name: 'default' });
  eq(process.env.GOOGLE_GEMINI_BASE_URL, undefined, '切到没有网关地址的账号时旧网关被清掉');
  switchProfile('gemini', 'A');
  eq(process.env.GOOGLE_GEMINI_BASE_URL, 'https://gw-a.example.com', '切回来网关地址恢复');
  eq(process.env.GEMINI_API_KEY, 'AIza-GEM-A', 'Key 也跟着切回来');
}

console.log('\n[5] 删除：回落 active，最后一个账号不许删');
{
  const before = listProfiles('doubao');
  eq(before.profiles.length, 2, '删除前有两个账号');
  const after = deleteProfile('doubao', '工作号');
  eq(after.active, 'default', '删掉当前账号后回落到 default');
  eq(after.profiles.map(p => p.name), ['default'], '只剩一个账号');
  eq(process.env.ARK_API_KEY, KEY_A, '删除后 env 指向留下的那个账号');
  ok(
    raw().doubao.profiles === undefined,
    '剩一个账号时退回旧形状（再次保证降级可读）'
  );

  let threw = false;
  try {
    deleteProfile('doubao', 'default');
  } catch {
    threw = true;
  }
  ok(threw, '最后一个账号不许删（要全清走「清除」）');

  let switchThrew = false;
  try {
    switchProfile('doubao', '不存在的号');
  } catch {
    switchThrew = true;
  }
  ok(switchThrew, '切换到不存在的账号直接报错，不静默纠正');

  const cleared = clearCredential('doubao');
  eq(cleared?.profileCount, 0, '清除后账号数归零');
  eq(process.env.ARK_API_KEY, undefined, '清除后环境变量也删干净');
}

console.log('\n[6] 非法输入边界');
{
  let threw = false;
  try {
    saveCredential('doubao', { key: KEY_A, name: 'x'.repeat(40) });
  } catch {
    threw = true;
  }
  ok(threw, '超长账号名被拒（不写进文件）');
  ok(raw().doubao === undefined, '被拒的保存没有留下半条数据');
}

for (const k of Object.keys(envBackup)) {
  if (envBackup[k] === undefined) delete process.env[k];
  else process.env[k] = envBackup[k]!;
}
for (const k of Object.keys(process.env)) {
  if (!(k in envBackup)) delete process.env[k];
}
clearCredential('doubao');
clearCredential('gemini');

console.log(`\n=== ${total - failures.length}/${total} 通过 ===`);
if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
