/**
 * 应用内 Agent 凭据（A30）断言。
 *
 * 守的是四件容易「看起来对、其实没用」的事：
 *
 *   1. **声明与识别必须一致** —— `credential.keyEnv` 里写的变量名，必须
 *      同时出现在 `authEnvs` 里。否则用户在设置页填了 Key，探测仍然说
 *      「未登录」（它只认 authEnvs），而界面会显示「已配置」—— 两边各说各话。
 *   2. **保存真的落到进程环境** —— 适配器读的是 `process.env`，不是我们的
 *      文件。写完不注入，等于写了个没人读的 JSON。
 *   3. **清除真的把变量删掉** —— 只删文件不删环境变量，界面会回到「未配置」
 *      但调用仍然带着旧 Key，是最难查的一类状态不一致。
 *   4. **宿主继承的全局开关必须净化** —— `NODE_TLS_REJECT_UNAUTHORIZED=0`
 *      会被 SDK 透传给所有 Agent CLI，等于全局关闭 TLS 证书校验（见 [8] 段）。
 *
 * 用临时目录（`OPC_DATA_DIR`），**不碰真实 data/**。
 * 运行：npx tsx scripts/verify-credentials.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cred-'));
process.env.OPC_DATA_DIR = tmp;
// 保证初始状态干净（宿主机可能真的有这些变量）
for (const n of ['ARK_API_KEY', 'DOUBAO_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL']) {
  delete process.env[n];
}

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

// 动态 import：必须在 OPC_DATA_DIR 设好之后（db.ts 在 import 时就定下 dataDir）
const { AGENT_DEFS, findDef } = await import('../server/agents/definitions.js');
const { listCredentials, getCredential, saveCredential, clearCredential } = await import(
  '../server/agent-credentials.js'
);
const {
  inspectCodexCredentials,
  inspectKimiCodeCredentials,
  inspectClaudeCredentials,
  workbuddyKeyblobInfo,
} = await import('../server/agents/credentialStatus.js');
const { resolveCodexCredential } = await import('../server/agents/adapters/codex-sdk.js');
const { resolveKimiCodeCredential } = await import('../server/agents/adapters/cli.js');
const { recoveryHintFor } = await import('../server/agents/recovery.js');

/* [8] 宿主注入的全局 TLS 开关必须在**模块加载时**就被剔除。
   env.ts 是副作用模块（底部 `const removed = sanitizeEnv()`），所以先模拟宿主
   注入再 import：加载完这个变量就该从 process.env 里消失。
   全仓只有 server/index.ts 引用 env.js，本脚本不 import index.ts，
   因此这里拿到的是首次加载，不会被 ESM 缓存跳过。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { describeStrippedVars, sanitizeEnv } = await import('../server/env.js');
const tlsStrippedOnLoad = process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined;

console.log('\n[1] 定义表：凭据声明与识别口径一致');
{
  const withCred = AGENT_DEFS.filter(d => d.credential);
  ok(withCred.length >= 3, '至少声明了 3 个可在应用内配置的 Agent', withCred.map(d => d.descriptor.id).join(','));
  for (const d of withCred) {
    const keyEnv = d.credential!.keyEnv[0];
    // A178：workbuddy 是 kind:'sdk'，走 SdkAdapter，不读 authEnvs（那是 CLI 探测路径）。
    // SDK 型有 credential 但没有 authEnvs 是正确的 —— keyEnv 写进 process.env 后
    // SdkAdapter 直接读，不经过 CLI 的 authEnvs 判定。
    if (d.descriptor.kind === 'sdk') {
      ok(
        !d.authEnvs || d.authEnvs.length === 0,
        `${d.descriptor.id}（SDK 型）不设 authEnvs（它走 SdkAdapter 直读 process.env，不经过 CLI 探测路径）`
      );
      continue;
    }
    ok(
      !!d.authEnvs?.includes(keyEnv),
      `${d.descriptor.id} 的 credential.keyEnv[0]=${keyEnv} 也在 authEnvs 里（否则填了也不认）`
    );
  }
  ok(!!findDef('gemini')?.credential?.baseUrlEnv, 'gemini 支持自定义接入地址（官方端点被墙时的唯一出口）');
  eq(findDef('gemini')?.backendHostOverrideEnv, 'GOOGLE_GEMINI_BASE_URL', 'gemini 的可达性检查按网关地址走');
  ok(!findDef('qoder')?.credential, 'qoder 不提供 Key 输入（它靠 CLI 登录态，填 Key 是假控件）');
  ok(!findDef('codex')?.credential, 'codex 不提供 Key 输入（它靠 chatgpt 登录态）');
  // 2026-11 修正：Kimi Code 的凭据是 credentials/kimi-code.json，不是 config.toml
  ok(
    !!findDef('kimicli')?.authFiles?.includes('.kimi-code/credentials/kimi-code.json'),
    'Kimi Code 探测看真正的凭据文件，而不是 config.toml'
  );
  ok(
    !findDef('kimicli')?.authFiles?.includes('.kimi-code/config.toml'),
    'Kimi Code 不再把 config.toml 当登录凭据'
  );
}

console.log('\n[2] 列表：只列声明过的，且初始为未配置');
{
  const list = listCredentials();
  // A178：workbuddy 也有 credential（CODEBUDDY_API_KEY），列表应包含 4 个
  eq(list.map(c => c.agentId).sort(), ['doubao', 'gemini', 'kimicode', 'workbuddy'], '列表内容');
  const doubao = list.find(c => c.agentId === 'doubao')!;
  eq(doubao.configured, false, '豆包初始未配置');
  eq(doubao.masked, '', '未配置时不返回掩码');
  eq(doubao.fromEnv, false, '初始也不来自环境变量');
  ok(!!doubao.hint, '带填写指引');
}

console.log('\n[3] 保存：落盘 + 注入进程环境');
{
  const view = saveCredential('doubao', { key: 'ark-abcdefghijklmn' });
  ok(view.configured, '保存后标记为已配置');
  ok(view.masked.includes('****'), '只回显掩码', view.masked);
  ok(!view.masked.includes('abcdefghij'), '掩码不泄露中段', view.masked);
  eq(process.env.ARK_API_KEY, 'ark-abcdefghijklmn', 'Key 已注入 process.env（适配器读的就是这里）');

  const file = path.join(tmp, 'agent-credentials.json');
  ok(fs.existsSync(file), '凭据文件已落盘', file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq(raw.doubao.key, 'ark-abcdefghijklmn', '文件里是该 Agent 的 Key');
  ok(!JSON.stringify(raw).includes('chat.db'), '不写进数据库');

  const again = getCredential('doubao')!;
  eq(again.configured, true, '重新读取仍是已配置');
}

console.log('\n[4] 只改接入地址时不清掉 Key');
{
  saveCredential('gemini', { key: 'AIzaTESTKEY1234', baseUrl: 'https://gw.example.com/' });
  eq(process.env.GEMINI_API_KEY, 'AIzaTESTKEY1234', 'gemini Key 已注入');
  eq(process.env.GOOGLE_GEMINI_BASE_URL, 'https://gw.example.com', '接入地址去掉尾部斜杠后注入');

  // 不带 key 的第二次保存（只改 baseUrl）
  const v = saveCredential('gemini', { baseUrl: 'https://gw2.example.com' });
  eq(v.configured, true, '第二次保存（只给 baseUrl）仍保留 Key');
  eq(process.env.GEMINI_API_KEY, 'AIzaTESTKEY1234', 'Key 没被空值覆盖');
  eq(process.env.GOOGLE_GEMINI_BASE_URL, 'https://gw2.example.com', '接入地址已更新');
}

console.log('\n[5] 清除：文件与进程环境一起清');
{
  const v = clearCredential('doubao')!;
  eq(v.configured, false, '清除后为未配置');
  eq(process.env.ARK_API_KEY, undefined, '环境变量已删除（否则调用仍带着旧 Key）');
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'agent-credentials.json'), 'utf8'));
  eq(raw.doubao, undefined, '文件里该条目已删除');
  ok(!!raw.gemini, '其它 Agent 的凭据不受影响');

  clearCredential('gemini');
  eq(process.env.GOOGLE_GEMINI_BASE_URL, undefined, '清除 gemini 时接入地址一起删');
}

console.log('\n[6] 边界：不支持的 Agent 直接拒绝');
{
  let threw = false;
  try {
    saveCredential('qoder', { key: 'x' });
  } catch {
    threw = true;
  }
  ok(threw, '给不支持的 Agent 保存凭据会报错，而不是静默写一个没人读的文件');
  eq(clearCredential('qoder'), null, '清除不支持的 Agent 返回 null');
}

console.log('\n[7] 凭据有效期：过期可预知；有 refresh_token 不判死');
{
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.kimi-code', 'credentials'), { recursive: true });
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });

  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const jwt = (expSeconds: number) =>
    `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`;
  const past = Math.floor(Date.now() / 1000) - 60;

  // Codex：已过期 + refresh_token → 可用（过期待刷新）
  const codexFile = path.join(home, '.codex', 'auth.json');
  fs.writeFileSync(
    codexFile,
    JSON.stringify({ tokens: { id_token: jwt(past), refresh_token: 'r' } })
  );
  ok(
    inspectCodexCredentials(home).state === 'expired-refreshable',
    '★ Codex 过期但有 refresh_token → expired-refreshable'
  );
  const codexResolved = resolveCodexCredential(inspectCodexCredentials(home));
  ok(codexResolved.availability === 'ready', '★ Codex 有 refresh_token 时不得判不可用');
  ok(
    /首次使用会尝试刷新/.test(codexResolved.message ?? ''),
    'Codex 文案是「已过期，首次使用会尝试刷新」',
    codexResolved.message
  );

  // Codex：已过期且没有 refresh_token → 需要重新登录
  fs.writeFileSync(codexFile, JSON.stringify({ tokens: { id_token: jwt(past) } }));
  const codexDead = resolveCodexCredential(inspectCodexCredentials(home));
  ok(codexDead.availability === 'needs-auth', 'Codex 过期且无 refresh_token → needs-auth');
  ok(/需要重新登录/.test(codexDead.message ?? ''), 'Codex 文案写「需要重新登录」');
  ok(/怎么恢复/.test(codexDead.message ?? ''), 'Codex 失败文案带可执行建议');

  // Kimi Code：读取真正的凭据文件；过期 + refresh_token 不判死
  const kimiFile = path.join(home, '.kimi-code', 'credentials', 'kimi-code.json');
  fs.writeFileSync(
    kimiFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: past })
  );
  ok(
    inspectKimiCodeCredentials(home).state === 'expired-refreshable',
    '★ Kimi Code 过期但有 refresh_token → expired-refreshable'
  );
  ok(
    resolveKimiCodeCredential(inspectKimiCodeCredentials(home)).ok,
    '★ Kimi Code 有 refresh_token 时 checkAuth 仍通过'
  );
  fs.writeFileSync(kimiFile, JSON.stringify({ access_token: 'a', expires_at: past }));
  ok(
    !resolveKimiCodeCredential(inspectKimiCodeCredentials(home)).ok,
    'Kimi Code 过期且无 refresh_token → 未登录'
  );

  // Claude：只有 .claude.json 没有 oauthAccount → 不算登录
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ theme: 'dark' }));
  ok(
    inspectClaudeCredentials(home).state === 'absent',
    '★ Claude 只有 .claude.json（无 oauthAccount）→ 未检测到登录凭据'
  );

  // WorkBuddy：keyblob 的 mtime 可得（桌面端活跃不代表它被刷新）
  const blob = path.join(home, '.workbuddy', 'keyblob');
  fs.writeFileSync(blob, 'x');
  const info = workbuddyKeyblobInfo(home);
  ok(info.exists && !!info.mtime, 'WorkBuddy keyblob 的 mtime 可读', info.mtime);

  // 11 个没有凭据入口的 Agent：每个都要有一句「怎么恢复」
  for (const id of [
    'codex',
    'claude',
    'hermes',
    'qoder',
    'qoder-cn',
    'opencode',
    'kimicli',
    'cursor',
    'zcode',
    'pi',
    'antigravity',
  ]) {
    const hint = recoveryHintFor(id);
    ok(hint.trim().length > 0, `${id} 有恢复指引`, hint);
  }
}

// ============= [8] 子进程环境净化：全局 TLS 校验开关不许继承 =============
//
// 宿主（WorkBuddy 桌面端）会注入 NODE_TLS_REJECT_UNAUTHORIZED=0。SDK 构造子进程
// 环境时是 `{ ...process.env, ...options.env }`，不剔除就会一路透传给所有 Agent CLI，
// 等于全局关闭 TLS 证书校验（modelCatalog 的联网抓取也受影响）。
// 静态契约钉清单与「加载即生效」，动态断言钉真的 delete，三种反向探针防止契约变摆设。
console.log('\n[8] 子进程环境净化：全局 TLS 校验开关不许继承');
{
  const envSrc = fs.readFileSync(path.join(process.cwd(), 'server/env.ts'), 'utf8');

  /** 剥注释后按行首锚定取 STRIP_VARS 的 key 列表：注释里写一句 key 不许算接线。 */
  function envSanitizeContract(src: string): boolean {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const block = /const STRIP_VARS[^\n]*=\s*\[([\s\S]*?)\n\];/.exec(code)?.[1] ?? '';
    if (!block) return false;
    const keys = [...block.matchAll(/^\s*key:\s*'([^']+)'/gm)].map(m => m[1]);
    if (!['SERVER__PORT', 'SERVER__HOST', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED']
      .every(k => keys.includes(k))) return false;
    if (!/const removed = sanitizeEnv\(\);/.test(code)) return false;
    if (!/delete process\.env\[key\]/.test(code)) return false;
    return true;
  }

  ok(envSanitizeContract(envSrc),
    '[8] 净化清单含 TLS 变量、原有三条未被挤掉；模块加载即执行且真的 delete');

  // 反向探针：把实现退回坏版本，上面的契约必须变红，否则它自己就是摆设。
  const noTls = envSrc.replace("key: 'NODE_TLS_REJECT_UNAUTHORIZED'", "key: 'NOT_THE_TLS_ONE'");
  ok(!envSanitizeContract(noTls), '[8] 反向探针：清单里删掉 TLS 变量 → 契约判红');
  const noAutoRun = envSrc.replace('const removed = sanitizeEnv();', '// const removed = sanitizeEnv();');
  ok(!envSanitizeContract(noAutoRun), '[8] 反向探针：去掉「加载即净化」→ 契约判红');
  const commentedKey = envSrc.replace(
    "key: 'NODE_TLS_REJECT_UNAUTHORIZED',",
    "// key: 'NODE_TLS_REJECT_UNAUTHORIZED',\n    key: 'NOT_THE_TLS_ONE',"
  );
  ok(!envSanitizeContract(commentedKey), '[8] 反向探针：只在注释里写这个 key → 不算接线');

  const listed = describeStrippedVars();
  ok(listed.some(v => v.key === 'NODE_TLS_REJECT_UNAUTHORIZED'),
    '[8] 净化清单导出里真的有 TLS 变量（读值，不是读源码文本）');
  const tlsReason = listed.find(v => v.key === 'NODE_TLS_REJECT_UNAUTHORIZED')?.reason ?? '';
  ok(/TLS|证书/.test(tlsReason) && /agent|单个请求/.test(tlsReason),
    '[8] 理由写明全局关校验的风险与自签证书的正确做法', tlsReason.slice(0, 40));
  ok(tlsStrippedOnLoad,
    '[8] ★ 宿主注入 NODE_TLS_REJECT_UNAUTHORIZED=0 后，import 即被剔除（SDK 无从透传）');

  // 再设一次直接调 sanitizeEnv()：确认删除动作本身有效，不只是 import 时碰巧没带上。
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const removed = sanitizeEnv();
  ok(removed.includes('NODE_TLS_REJECT_UNAUTHORIZED') &&
     process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined,
    '[8] sanitizeEnv() 真的把它从 process.env 删掉', removed.join(','));
}


// 导入 db.ts 会打开 SQLite 连接（模块副作用），Windows 上 chat.db 被持有，
// 删不掉是**预期**的 —— 不因为清理失败让整个断言脚本红掉。
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录留给系统回收 */
}

console.log(`\n结果：${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
