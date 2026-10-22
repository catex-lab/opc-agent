/**
 * 应用内 Agent 凭据（A30）断言。
 *
 * 守的是三件容易「看起来对、其实没用」的事：
 *
 *   1. **声明与识别必须一致** —— `credential.keyEnv` 里写的变量名，必须
 *      同时出现在 `authEnvs` 里。否则用户在设置页填了 Key，探测仍然说
 *      「未登录」（它只认 authEnvs），而界面会显示「已配置」—— 两边各说各话。
 *   2. **保存真的落到进程环境** —— 适配器读的是 `process.env`，不是我们的
 *      文件。写完不注入，等于写了个没人读的 JSON。
 *   3. **清除真的把变量删掉** —— 只删文件不删环境变量，界面会回到「未配置」
 *      但调用仍然带着旧 Key，是最难查的一类状态不一致。
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

console.log('\n[1] 定义表：凭据声明与识别口径一致');
{
  const withCred = AGENT_DEFS.filter(d => d.credential);
  ok(withCred.length >= 3, '至少声明了 3 个可在应用内配置的 Agent', withCred.map(d => d.descriptor.id).join(','));
  for (const d of withCred) {
    const keyEnv = d.credential!.keyEnv[0];
    ok(
      !!d.authEnvs?.includes(keyEnv),
      `${d.descriptor.id} 的 credential.keyEnv[0]=${keyEnv} 也在 authEnvs 里（否则填了也不认）`
    );
  }
  ok(!!findDef('gemini')?.credential?.baseUrlEnv, 'gemini 支持自定义接入地址（官方端点被墙时的唯一出口）');
  eq(findDef('gemini')?.backendHostOverrideEnv, 'GOOGLE_GEMINI_BASE_URL', 'gemini 的可达性检查按网关地址走');
  ok(!findDef('qoder')?.credential, 'qoder 不提供 Key 输入（它靠 CLI 登录态，填 Key 是假控件）');
  ok(!findDef('codex')?.credential, 'codex 不提供 Key 输入（它靠 chatgpt 登录态）');
}

console.log('\n[2] 列表：只列声明过的，且初始为未配置');
{
  const list = listCredentials();
  eq(list.map(c => c.agentId).sort(), ['doubao', 'gemini', 'kimicode'], '列表内容');
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

// 收尾：临时目录尽力清理即可。
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
