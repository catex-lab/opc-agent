/**
 * 产品族元数据验证（A68 / PLAN-AGENT-FAMILY.md P0）。
 *
 * 这个脚本守的是「**同一件事别接两遍、不同的事别挤成一条**」。
 *
 * 背景：厂商有 agent / CLI / IDE，有国际版 / 国内版。同一个产品族出现两个条目
 * 到底是「必要的两条」还是「重复接入」，只看名字看不出来 —— 判断依据只有一条：
 * **账号体系是否相同**（`authScope`）。账号不同 → 必须两条（一个子进程只能持一份
 * 凭据）；账号相同、只是形态或区域不同 → 必须合并或加设置项。
 *
 * 所以这里断言的都是**结构性约束**，不是文案：
 *   1. 14 条全部填齐 7 个字段（不许留白，留白就等于「没想过」）；
 *   2. `authScope + surface + region` 三元组唯一 —— 防重复接入同一账号；
 *   3. `surface` 必须与 `kind` 兼容，且**永不出现 `ide`**（本项目不接 IDE）；
 *   4. 同 `family` 的多条目，`authScope` 必须互不相同（否则该合并）；
 *   5. 同 `family` 的 `familyName` 必须一致（同一个族不能两个显示名）；
 *   6. id 集合**冻结** —— 分组靠 `family`，绝不靠改 id
 *      （`sessions.agent_id` 里存着历史值，改名等于把老会话变成孤儿）。
 *
 * 全离线、不碰数据库、不需要任何 Agent 在线。
 * 运行：npx tsx scripts/verify-family.ts
 */
import { AGENT_DEFS } from '../server/agents/definitions.js';
import type { AgentDescriptor } from '../server/agents/types.js';

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

function section(title: string) {
  console.log(`\n— ${title}`);
}

const defs: AgentDescriptor[] = AGENT_DEFS.map(d => d.descriptor);

/**
 * 冻结的 id 集合。
 *
 * 为什么写死：分组、角标、身份小节全部靠 `family` / `region` 这些**新字段**，
 * 一旦有人图省事把 `qoder` 改名成 `qoder-intl` 来表达区域，`sessions.agent_id`
 * 里的历史值就全成了孤儿。这条断言让「改名」必须先改这个文件，
 * 从而在 code review 里被看见。
 */
const FROZEN_IDS = [
  'workbuddy',
  'codex',
  'gemini',
  'opencode',
  'claude',
  'hermes',
  'cursor',
  'qoder',
  // A76：Qoder 国内版。它是**独立条目**而不是 qoder 上的一个设置项 ——
  // 两个产品系列的账号 / Credits / 模型 / 部署全独立，一个子进程只能持一份凭据。
  'qoder-cn',
  'doubao',
  'zcode',
  'kimicode',
  'pi',
  'antigravity',
  'kimicli',
  'trae',
];

/** kind（我们怎么接）→ 允许的 surface（产品形态） */
const KIND_TO_SURFACE: Record<string, string> = {
  sdk: 'sdk',
  cli: 'cli',
  acp: 'acp',
  http: 'http',
};

// ============= [1] 字段齐全 =============
section('[1] 7 个元数据字段全部填齐（不许留白）');
for (const d of defs) {
  const missing: string[] = [];
  if (!d.family) missing.push('family');
  if (!d.familyName) missing.push('familyName');
  if (!d.surface) missing.push('surface');
  if (!d.region) missing.push('region');
  if (!d.regionName) missing.push('regionName');
  if (!d.authScope) missing.push('authScope');
  if (!d.authScopeName) missing.push('authScopeName');
  ok(missing.length === 0, `${d.id} 元数据齐全`, `缺 ${missing.join(', ')}`);
}

// ============= [2] 机器键的形态 =============
section('[2] 机器键的形态（要参与分组 / 唯一性比较，不能有空格与中文）');
for (const d of defs) {
  ok(/^[a-z0-9][a-z0-9.-]*$/.test(d.family ?? ''), `${d.id} family 是合法键`, String(d.family));
  ok(!/\s/.test(d.authScope ?? ''), `${d.id} authScope 不含空白`, String(d.authScope));
  ok((d.familyName ?? '').trim().length > 0, `${d.id} familyName 非空`);
  ok((d.regionName ?? '').trim().length > 0, `${d.id} regionName 非空`);
  ok((d.authScopeName ?? '').trim().length > 0, `${d.id} authScopeName 非空`);
}

// ============= [3] surface 与 kind 兼容，且永不出现 ide =============
section('[3] surface 与 kind 兼容；ide 一律不接');
for (const d of defs) {
  // 这一条是 surface 存在的全部理由：kind 说「我们怎么接」，surface 说「产品是什么」。
  // 同一个产品可以既有 IDE 又有 CLI（qoder / cursor / antigravity / kimi），
  // 我们接的永远是 CLI/ACP/HTTP 那一面 —— 所以 surface 一旦出现 ide，
  // 说明有人把「产品形态」和「我们接的面」搞混了。
  ok(d.surface !== 'ide', `${d.id} 不接 IDE 面（surface ≠ ide）`, String(d.surface));
  eq(d.surface, KIND_TO_SURFACE[d.kind], `${d.id} surface 与 kind 对应（kind=${d.kind}）`);
}

// ============= [4] 不存在「看起来是同一个东西接了两遍」 =============
section('[4] 不存在「同一产品接两遍」（name + authScope + surface + region 四元组唯一）');
{
  // ⚠️ 这里必须是**四元组**，不能是三元组 —— 本脚本第一版就写成三元组，
  // 结果把 `gemini` 与 `antigravity` 判成了重复。它们同厂、同账号、同形态、
  // 同区域，但确实是**两个不同产品**（两个二进制、两套能力，Google 官方明确
  // 建议新一代用 Antigravity）。三元组会把这种合法组合误判成「接了两遍」。
  // 真正要防的是：同一个产品（同 name）在同一账号、同一区域、同一形态下出现两次。
  const seen = new Map<string, string[]>();
  for (const d of defs) {
    const key = `${d.name}|${d.authScope}|${d.surface}|${d.region}`;
    const list = seen.get(key) ?? [];
    list.push(d.id);
    seen.set(key, list);
  }
  for (const [key, ids] of seen) {
    ok(ids.length === 1, `四元组唯一：${key}`, `被这些条目共用：${ids.join(', ')}`);
  }
}

// ============= [5] 同族多条目：能区分、显示名一致 =============
section('[5] 同族多条目：能区分、显示名一致，且关系类型必须说清楚');
{
  const byFamily = new Map<string, AgentDescriptor[]>();
  for (const d of defs) {
    const list = byFamily.get(d.family ?? '') ?? [];
    list.push(d);
    byFamily.set(d.family ?? '', list);
  }

  for (const [family, members] of byFamily) {
    if (members.length === 1) {
      // 单条目族：不需要分组标题，family 合法性在 [2] 已断言
      ok(members.length === 1, `族 ${family} 只有一条，不需要分组标题`);
      continue;
    }

    // 1) 名字必须互不相同 —— 否则分组里会出现两条一模一样的行
    const names = members.map(m => m.name);
    ok(
      new Set(names).size === members.length,
      `同族 ${family} 的 name 互不相同（否则界面上两条看起来一样）`,
      names.join(' / ')
    );

    // 2) 同一个族不能有两个显示名
    const famNames = new Set(members.map(m => m.familyName));
    ok(famNames.size === 1, `同族 ${family} 的 familyName 一致`, `出现多个：${[...famNames].join(' / ')}`);

    // 3) 关系类型只有两种，且都必须能被界面如实说清：
    //    - authScope 相同 → 共用账号（额度同池），差别是**产品/代际**
    //    - authScope 不同 → 账号独立（额度不互通），必须两条
    const scopes = new Set(members.map(m => m.authScope));
    if (scopes.size === 1) {
      console.log(
        `    · ${family}：${members.length} 条**共用**账号 ${[...scopes][0]}` +
          `（${members.map(m => m.name).join(' / ')}）→ 界面要说「共用额度，不是两个账号」`
      );
      ok(true, `族 ${family} 共用账号，属于「同账号不同产品」`);
    } else {
      console.log(
        `    · ${family}：${members.length} 条**账号独立**（${members
          .map(m => `${m.name}=${m.authScope}`)
          .join(' / ')}）→ 界面要说「额度不互通」`
      );
      ok(true, `族 ${family} 账号独立，按 R1 必须是多条`);
    }
  }

  // 至少两个多条目族，否则「分组」这个功能等于没有真实数据覆盖
  const multi = [...byFamily.values()].filter(m => m.length > 1);
  ok(multi.length >= 2, '至少两个产品族有多条目（分组功能有真实数据覆盖）', `实际 ${multi.length} 个`);

  // 两种关系类型都要有真实样本，否则界面只会在一种情况下被验过
  const hasShared = multi.some(m => new Set(m.map(x => x.authScope)).size === 1);
  const hasSplit = multi.some(m => new Set(m.map(x => x.authScope)).size > 1);
  ok(hasShared, '有「同账号不同产品」的真实样本（google）');
  ok(hasSplit, '有「账号独立」的真实样本（kimi）');
}

// ============= [6] id 集合冻结 =============
section('[6] id 集合冻结（分组靠 family，绝不靠改 id）');
{
  const ids = defs.map(d => d.id);
  eq(ids.slice().sort(), FROZEN_IDS.slice().sort(), 'id 集合与冻结清单完全一致');
  for (const id of ids) {
    ok(FROZEN_IDS.includes(id), `${id} 在冻结清单里（新增条目要同时更新本脚本）`);
  }
  // 反向：清单里的都在（防有人删条目却不改清单）
  for (const id of FROZEN_IDS) {
    ok(ids.includes(id), `冻结清单里的 ${id} 仍然存在`);
  }
}

// ============= [7] 与 PLAN-AGENT-FAMILY.md 的审计表一致 =============
section('[7] 与 PLAN 审计表的关键判定一致（防止文档与代码漂移）');
{
  const byId = new Map(defs.map(d => [d.id, d]));
  // 这两组是「判定正确、必须保持两条」的教科书案例，钉死它们
  eq(byId.get('kimicode')?.family, 'kimi', 'kimicode 属 Kimi 族');
  eq(byId.get('kimicli')?.family, 'kimi', 'kimicli 属 Kimi 族');
  ok(
    byId.get('kimicode')?.authScope !== byId.get('kimicli')?.authScope,
    'kimicode 与 kimicli 账号体系不同（开放平台 Key ≠ Kimi Code Key）',
    `${byId.get('kimicode')?.authScope} vs ${byId.get('kimicli')?.authScope}`
  );
  eq(byId.get('gemini')?.family, 'google', 'gemini 属 Google 族');
  eq(byId.get('antigravity')?.family, 'google', 'antigravity 属 Google 族');
  eq(byId.get('gemini')?.authScope, byId.get('antigravity')?.authScope, 'gemini 与 antigravity 同账号（只是代际不同）');

  // qoder 是国际版 —— 这条一旦被改成 cn，说明有人凭印象改了
  eq(byId.get('qoder')?.region, 'intl', 'qoder 是国际版（本机 .qoder-app-status.json: product="qoder"）');

  // A76：国内版必须与它同族、同显示名、**账号体系不同**。
  // 三条一起才有意义：同族 = 界面能分组；同 familyName = 分组标题一致；
  // authScope 不同 = 必须两条（否则就是「切了等于没切」的假控件）。
  eq(byId.get('qoder-cn')?.family, 'qoder', 'qoder-cn 属 Qoder 族');
  eq(byId.get('qoder-cn')?.familyName, 'Qoder', 'qoder-cn 与 qoder 共用族名');
  eq(byId.get('qoder-cn')?.region, 'cn', 'qoder-cn 是国内版');
  ok(
    byId.get('qoder-cn')?.authScope !== byId.get('qoder')?.authScope,
    'qoder 与 qoder-cn 账号体系不同（额度不互通，必须两条）',
    `${byId.get('qoder')?.authScope} vs ${byId.get('qoder-cn')?.authScope}`
  );
  // workbuddy 是国内版
  eq(byId.get('workbuddy')?.region, 'cn', 'workbuddy 是国内版（acc-product-config: endpoint=www.workbuddy.cn）');
}

// ============= 结果 =============
console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败（共 ${checks.total} 项）：\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks.total}/${checks.total} 全部通过`);
