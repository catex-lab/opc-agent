/**
 * 同厂「其他版本」与「上次请求」探测的验证（A69 / PLAN-AGENT-FAMILY §6 P1+P2）。
 *
 * ## 为什么这个脚本必须自己造夹具
 *
 * 被测模块（`server/agents/familyHints.ts`）**全部靠文件系统判断**。
 * 如果直接对 `os.homedir()` 断言，结果就取决于「跑脚本这台机器碰巧装了什么」——
 * 换台机器全绿或全红，等于没测。所以每个用例都在临时目录里造一个假 home：
 *
 *   home/
 *     .qoder-cn/bin/qoder-cn-computer-use      → 桌面端，没有 CLI
 *     .qoder-cn/bin/qodercli                   → 有 CLI（另一种分支）
 *     .workbuddy-ai/cache/acc-product-config-v3.json
 *     .kimi-code/region
 *     .zcode/cli/db/db.sqlite                  → 真的建一张 model_usage 表
 *
 * ## 守的三条纪律（对应模块头部的三条）
 *
 * 1. **只报探测到的事实**：读不到就不返回，不返回「未知」占位；
 * 2. **不猜区域**：`~/.workbuddy-ai` 存在但没有 `networkEnvironment=external`
 *    时，**不许**说「国际版」；
 * 3. **不提供接入按钮**：只给文字。`blockedBy`（缺什么）与 `nextStep`（有了之后
 *    怎么做）是互补的两层，可以同时出现；不允许的是两个都空（等于什么都没说）。
 *
 * 运行：npx tsx scripts/verify-family-hints.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  probeFamilyHints,
  probeKimiRegion,
  probeQoderCn,
  probeWorkbuddyIntl,
  readZcodeLastRequest,
  resetFamilyHintsCache,
} from '../server/agents/familyHints.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(detail ? `${label} —— ${detail}` : label);
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label} — 实际 ${a}，期望 ${e}`);
    failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
  }
}

function section(title: string) {
  console.log(`\n— ${title}`);
}

/** 造一个空 home；用完即删（在系统临时目录里，不碰用户文件） */
const homes: string[] = [];
function makeHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'opc-hints-'));
  homes.push(h);
  return h;
}
function touch(home: string, rel: string, content = '') {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** 真建一张 zcode 的 model_usage 表 —— 不 mock sqlite，测的就是真读 */
function makeZcodeDb(home: string, rows: Array<[string, string, number]>) {
  const p = join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  mkdirSync(dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec(
    'CREATE TABLE model_usage (id TEXT, provider_id TEXT, model_id TEXT, started_at INTEGER)'
  );
  const ins = db.prepare('INSERT INTO model_usage (id, provider_id, model_id, started_at) VALUES (?,?,?,?)');
  rows.forEach(([pid, mid, at], i) => ins.run(`u${i}`, pid, mid, at));
  db.close();
}

// ============= [1] 空 home：一个提示都不该有 =============
section('[1] 空 home：不返回任何提示（不造「未知」占位）');
{
  const home = makeHome();
  resetFamilyHintsCache();
  const hints = probeFamilyHints(home);
  eq(hints.size, 0, '什么都没装时 Map 为空');
  ok(probeQoderCn(home) === null, '没有 ~/.qoder-cn 就不返回');
  ok(probeWorkbuddyIntl(home) === null, '没有 ~/.workbuddy-ai 就不返回');
  ok(probeKimiRegion(home) === null, '没有 ~/.kimi-code/region 就不返回');
  ok(readZcodeLastRequest(home) === null, '没有 zcode 数据库就不返回（不抛异常）');
}

// ============= [2] Qoder CN：桌面端 vs 有 CLI =============
section('[2] Qoder CN：有没有 CLI 决定「接不了」还是「要准备什么」');
{
  const desktop = makeHome();
  touch(desktop, '.qoder-cn/bin/qoder-cn-computer-use');
  const a = probeQoderCn(desktop);
  ok(a !== null, '检测到 ~/.qoder-cn 就返回');
  eq(a?.id, 'qoder-cn', 'id 用 qoder-cn（与 PLAN 候选一致）');
  eq(a?.regionName, '国内版', '区域用厂商官方口径「国内版」');
  ok(!!a?.blockedBy, '只有桌面端时给「未接入」的具体原因', a?.blockedBy);
  ok(a?.nextStep === undefined, '接不了的时候不给「要准备什么」（互斥，不画空头支票）');
  ok(/qoder-cn-computer-use/.test(a?.evidence || ''), '证据里点名 bin 下实际有什么', a?.evidence);

  const withCli = makeHome();
  touch(withCli, '.qoder-cn/bin/qoder-cn-computer-use');
  touch(withCli, '.qoder-cn/bin/qodercli');
  const b = probeQoderCn(withCli);
  ok(!b?.blockedBy, '有 qodercli 时不再说「接不了」', String(b?.blockedBy));
  ok(!!b?.nextStep, '有 CLI 时给「要准备什么」', b?.nextStep);
  ok(/qodercli/.test(b?.evidence || ''), '证据里给出 CLI 的完整路径', b?.evidence);
}

// ============= [3] WorkBuddy 国际版：必须读到 external 才敢说 =============
section('[3] WorkBuddy：目录存在 ≠ 国际版，要看 networkEnvironment');
{
  const intl = makeHome();
  touch(
    intl,
    '.workbuddy-ai/cache/acc-product-config-v3.json',
    JSON.stringify({
      productName: 'WorkBuddy AI',
      networkEnvironment: 'external',
      endpoint: 'https://www.workbuddy.ai',
    })
  );
  const a = probeWorkbuddyIntl(intl);
  eq(a?.name, 'WorkBuddy AI', 'name 用官方 productName');
  eq(a?.regionName, '国际版', 'networkEnvironment=external 才叫国际版');
  ok(/www\.workbuddy\.ai/.test(a?.evidence || ''), '证据里带 endpoint', a?.evidence);
  ok(!!a?.blockedBy, '国际版必须说清「要另备一份凭据」', a?.blockedBy);

  const bare = makeHome();
  mkdirSync(join(bare, '.workbuddy-ai'), { recursive: true });
  const b = probeWorkbuddyIntl(bare);
  ok(b !== null, '只有目录时仍然提示「检测到配置根」');
  ok(b?.regionName !== '国际版', '但**不下**国际版结论（读不到产品配置）', String(b?.regionName));
  ok(/没有读到产品配置/.test(b?.evidence || ''), '如实说没读到', b?.evidence);

  const cnCfg = makeHome();
  touch(
    cnCfg,
    '.workbuddy-ai/cache/acc-product-config-v3.json',
    JSON.stringify({ productName: 'WorkBuddy', networkEnvironment: 'internal', endpoint: 'https://www.workbuddy.cn' })
  );
  const c = probeWorkbuddyIntl(cnCfg);
  ok(c?.regionName !== '国际版', 'networkEnvironment=internal 时更不许说国际版', String(c?.regionName));
}

// ============= [4] Kimi 区域：只在中国站时才提国际站 =============
section('[4] Kimi Code：region=mainland-cn 才提示国际站');
{
  const cn = makeHome();
  touch(cn, '.kimi-code/region', 'mainland-cn\n');
  const a = probeKimiRegion(cn);
  eq(a?.id, 'kimi-intl', '提示的是「国际站」这条线');
  ok(/mainland-cn/.test(a?.evidence || ''), '证据里写出实际 region 值', a?.evidence);
  ok(!!a?.blockedBy, '说清「两套账号，额度不互通」', a?.blockedBy);

  const global = makeHome();
  touch(global, '.kimi-code/region', 'global');
  ok(probeKimiRegion(global) === null, '已经在国际站时不再提示（不推荐用户装他已经有的东西）');
}

// ============= [5] ZCode：上次实际请求 =============
section('[5] ZCode：从 model_usage 读「上次实际请求」，不猜当前设置');
{
  const home = makeHome();
  const now = Date.now();
  makeZcodeDb(home, [
    ['builtin:bigmodel-start-plan', 'GLM-5.3', now - 86_400_000],
    ['account:zai-start-plan', 'GLM-5.3-Flash', now - 60_000],
  ]);
  const a = readZcodeLastRequest(home);
  eq(a?.account, 'zai', '取**最新**那一行（不是第一条）');
  eq(a?.accountLabel, 'Z.ai 套餐', 'account 映射成官方套餐名');
  eq(a?.model, 'GLM-5.3-Flash', '模型名原样给出');
  ok(/不是当前设置/.test(a?.source || ''), '来源里必须写明「不是当前设置」', a?.source);
  ok(Math.abs(Date.parse(a!.at) - (now - 60_000)) < 1000, '时间就是那一行的 started_at');

  const big = makeHome();
  makeZcodeDb(big, [['builtin:bigmodel-start-plan', 'GLM-5.3', Date.now()]]);
  eq(readZcodeLastRequest(big)?.account, 'bigmodel', 'bigmodel 的 provider_id 判成 BigModel');
  eq(readZcodeLastRequest(big)?.accountLabel, 'BigModel 套餐', 'BigModel 的显示名');

  const custom = makeHome();
  makeZcodeDb(custom, [['5fb5879d-a559-4a04-b380-d6fb6d9c06ea', 'deepseek-v4-pro', Date.now()]]);
  eq(readZcodeLastRequest(custom)?.account, 'custom', 'UUID 形式的 provider 判成「自定义」');
  eq(readZcodeLastRequest(custom)?.accountLabel, '自定义 provider', '自定义 provider 的显示名');

  const empty = makeHome();
  const p = join(empty, '.zcode', 'cli', 'db', 'db.sqlite');
  mkdirSync(dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('CREATE TABLE other (x TEXT)');
  db.close();
  ok(readZcodeLastRequest(empty) === null, '没有 model_usage 表时返回 null（不抛）');
}

// ============= [6] 汇总：按 agent id 归档 + 缓存 =============
section('[6] 汇总与缓存');
{
  const home = makeHome();
  touch(home, '.qoder-cn/bin/qoder-cn-computer-use');
  touch(home, '.workbuddy-ai/cache/acc-product-config-v3.json', JSON.stringify({ networkEnvironment: 'external', productName: 'WorkBuddy AI' }));
  touch(home, '.kimi-code/region', 'mainland-cn');
  makeZcodeDb(home, [['account:zai-start-plan', 'GLM-5.3-Flash', Date.now()]]);

  resetFamilyHintsCache();
  const m = probeFamilyHints(home);

  // A76：`qoder-cn` 已经是名册里的真实条目，不能再作为「检测到但没接入」挂在
  // qoder 上 —— 那句话现在是假的。这一条守着「占位变成真条目」时的收尾动作。
  ok(m.get('qoder') === undefined, 'qoder 上不再挂 qoder-cn（它已是独立条目）');
  ok(m.get('qoder-cn') === undefined, 'qoder-cn 自己也不需要「兄弟」提示');

  ok(m.get('workbuddy')?.localSiblings?.length === 1, 'workbuddy-intl 挂在 workbuddy 上');
  ok(m.get('kimicli')?.localSiblings?.length === 1, 'kimi-intl 挂在 kimicli 上');
  ok(m.get('kimicode')?.localSiblings === undefined, '**不**挂到 kimicode 上（那是另一套账号体系）');
  ok(m.get('zcode')?.lastRequest !== undefined, 'zcode 带上次请求');
  ok(m.get('gemini') === undefined, '没有提示的 Agent 不在 Map 里（不是空对象）');

  // 缓存：同一个 home 第二次直接命中，改了文件也看不到变化。
  // 用 workbuddy 的 regionName 做观察点（qoder 那条已经没有兄弟可看了）。
  touch(home, '.workbuddy-ai/cache/acc-product-config-v3.json', JSON.stringify({ networkEnvironment: 'internal' }));
  const again = probeFamilyHints(home);
  ok(
    again.get('workbuddy')?.localSiblings?.[0]?.regionName === '国际版',
    '30 秒内命中缓存（改了配置也不会立刻改变结论）',
    String(again.get('workbuddy')?.localSiblings?.[0]?.regionName)
  );
  resetFamilyHintsCache();
  const fresh = probeFamilyHints(home).get('workbuddy')?.localSiblings?.[0];
  ok(
    fresh?.regionName === '区域未确认',
    '清缓存后立刻反映新事实',
    String(fresh?.regionName)
  );
}

// ============= [7] 真实 home：只要求「不炸 + 结构合法」 =============
section('[7] 真实 home：不抛异常，结构合法（不断言具体内容）');
{
  resetFamilyHintsCache();
  let err: string | null = null;
  let m: ReturnType<typeof probeFamilyHints> | null = null;
  try {
    m = probeFamilyHints();
  } catch (e) {
    err = (e as Error).message;
  }
  ok(err === null, '在本机真实 home 上不抛异常', err || 'ok');
  const bad: string[] = [];
  for (const [id, h] of m ?? []) {
    for (const s of h.localSiblings ?? []) {
      if (!s.id || !s.name || !s.detectedPath || !s.evidence) bad.push(`${id}: 字段缺失`);
      // 两个字段是互补的（缺什么 / 有了之后怎么做），允许同时出现；
      // 真正要守的是「不能什么都不说」—— 那样这一块就只是占地方。
      if (!s.blockedBy && !s.nextStep) bad.push(`${id}: blockedBy 与 nextStep 都为空（没说清为什么没接）`);
    }
    if (h.lastRequest && !/不是当前设置/.test(h.lastRequest.source)) {
      bad.push(`${id}: lastRequest.source 没写明「不是当前设置」`);
    }
  }
  ok(bad.length === 0, '所有提示字段完整、至少说清了「为什么没接」', bad.join(' | ') || `共 ${m?.size ?? 0} 个 Agent 有提示`);

  // 把本机真实探测结果打出来 —— 这一行是给人看的：换台机器时能立刻看出差异，
  // 而不是「脚本绿了但界面上什么都没有」。
  for (const [id, h] of m ?? []) {
    for (const sib of h.localSiblings ?? []) {
      console.log(`  · ${id} → ${sib.name}（${sib.regionName}）${sib.blockedBy ? `｜${sib.blockedBy}` : ''}`);
    }
    if (h.lastRequest) {
      console.log(`  · ${id} → 上次请求 ${h.lastRequest.accountLabel} / ${h.lastRequest.model}`);
    }
  }
}

// ============= 清理 =============
for (const h of homes) {
  try {
    rmSync(h, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败（共 ${checks.total} 项）：\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks.total}/${checks.total} 全部通过`);
