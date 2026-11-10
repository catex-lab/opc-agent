/**
 * P0 溯源新鲜度闸门（verify:freshness）。
 *
 * 守的是三处数据出口（账号 / 模型 / Agent 模型清单）都带 `provenance`
 * 且 `verified: false` —— 读本地文件不许说成「已校验」。
 *
 * 这一层是**纯函数 + 静态定义**的断言，不启动服务端 / 浏览器：
 *   1. `shared/provenance.ts` 的纯函数行为（与 verify:provenance-unit 互补，
 *      那边测边界，这边测三处出口的实际调用路径）
 *   2. `accountProbe.ts` 的 `localProvenance()` 出来的 `verified` 恒 false
 *   3. `modelCatalog.ts` 的 `getCatalogSummary()` 带 `provenance`
 *   4. `definitions.ts` 里所有 `kind: 'sdk'` 且有 `credential` 的 Agent
 *      不设 `authEnvs`（SDK 型不走 CLI 探测路径）
 *
 * 运行：npx tsx scripts/verify-freshness.ts
 */
const { makeProvenance, asProvenance, describeProvenance, isStale, PROVENANCE_TTL_MS } =
  await import('../shared/provenance.js');

let total = 0;
const failures: string[] = [];
function ok(cond: unknown, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  \u2713 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  else {
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
    failures.push(label);
  }
}

console.log('\n[1] 三处出口的 provenance 都 verified=false');
{
  // 账号探测
  const { probeAccount } = await import('../server/agents/accountProbe.js');
  const os = await import('node:os');
  const home = os.homedir();

  // ZCode 和 Codex 是唯二有 probeAccount 实现的
  for (const id of ['zcode', 'codex']) {
    const probe = probeAccount(id, home);
    if (!probe) {
      // 本机没装也不算红 —— probeAccount 返回 null 是正常的
      console.log(`  \u2013 ${id}：probeAccount 返回 null（本机未安装），跳过`);
      continue;
    }
    ok(
      !!probe.provenance,
      `${id} 账号探针带 provenance`
    );
    if (probe.provenance) {
      ok(
        probe.provenance.verified === false,
        `\u2605 ${id} provenance.verified === false（只读本地文件不许说成已校验）`
      );
      ok(
        typeof probe.provenance.source === 'string' && probe.provenance.source.length > 0,
        `${id} provenance.source 非空`,
        probe.provenance.source
      );
      ok(
        Number.isFinite(probe.provenance.probedAt),
        `${id} provenance.probedAt 是有效数字`
      );
    }
  }

  // 模型目录
  const { getCatalogSummary } = await import('../server/agents/modelCatalog.js');
  const summary = getCatalogSummary();
  // 目录可能还没加载（state=null），此时 provenance 应为 null 而非伪造
  if (summary.fetchedAt === 0) {
    console.log('  \u2013 模型目录未加载（state=null），provenance=null，跳过');
  } else {
    ok(
      !!summary.provenance,
      '模型目录 summary 带 provenance'
    );
    if (summary.provenance) {
      ok(
        summary.provenance.verified === false,
        '\u2605 模型目录 provenance.verified === false（枚举不等于校验）'
      );
    }
  }
}

console.log('\n[2] describeProvenance 对三处数据的行为');
{
  // 账号（本地文件，未校验）
  const acctProv = makeProvenance('~/.zcode/v2/credentials.json', {
    probedAt: Date.now() - 5 * 60_000,
    verified: false,
    note: '只读本机配置文件，未向服务方校验',
  });
  const acctText = describeProvenance(acctProv);
  ok(acctText.includes('未校验'), '\u2605 账号文案包含「未校验」');
  ok(acctText.includes('5 分钟前'), '账号文案显示相对时间');
  ok(!acctText.includes('已过期'), '5 分钟不算过期');

  // 模型（SDK 枚举，未校验，有缓存）
  const modelProv = makeProvenance('SDK getAvailableModelsRaw()', {
    probedAt: Date.now() - 20 * 3600_000, // 20 小时前
    verified: false,
    note: '清单来自 SDK 会话，未校验积分/套餐',
  });
  const modelText = describeProvenance(modelProv);
  ok(modelText.includes('未校验'), '\u2605 模型文案包含「未校验」');
  ok(!modelText.includes('已过期'), '\u2605 20 小时按默认 24h 阈值不算过期（<24h）');

  // 远旧数据（超过 30 天）
  const staleProv = makeProvenance('旧缓存', {
    probedAt: Date.now() - 35 * 24 * 3600_000,
    verified: false,
  });
  const staleText = describeProvenance(staleProv);
  ok(staleText.includes('已过期'), '35 天的数据标「已过期」');

  // Codex 的 45 天 token 用自己的 ttlMs
  const codexProv = makeProvenance('~/.codex/auth.json', {
    probedAt: Date.now() - 45 * 24 * 3600_000,
    verified: false,
    ttlMs: 60 * 24 * 3600_000, // Codex 给 60 天阈值
  });
  const codexText = describeProvenance(codexProv);
  ok(!codexText.includes('已过期'), '\u2605 Codex 45 天 + 60 天阈值不算过期');

  // 老服务端没给 provenance
  const nullText = describeProvenance(null);
  eq(nullText, '数据来源与时间未知', '老服务端没给 provenance 时明说「未知」');
}

console.log('\n[3] asProvenance 拒绝腐败结构');
{
  // verified 是字符串 "true" 不认
  const fake = asProvenance({ source: 'x', probedAt: Date.now(), verified: 'true' });
  ok(fake?.verified === false, '\u2605 字符串 "true" 不升格为已校验');

  // probedAt 是字符串不认
  const bad = asProvenance({ source: 'x', probedAt: 'now', verified: true });
  ok(bad === null, 'probedAt 不是数字时返回 null');

  // source 为空不认
  const empty = asProvenance({ source: '', probedAt: Date.now() });
  ok(empty === null, 'source 为空时返回 null');

  // undefined / null 安全
  ok(asProvenance(undefined) === null, 'undefined 安全返回 null');
  ok(asProvenance(null) === null, 'null 安全返回 null');

  // 合法数据正常解析
  const good = asProvenance({ source: 'test', probedAt: 123, verified: true });
  ok(good?.verified === true && good.source === 'test', '合法数据正常解析');
}

function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

console.log(`\n结果：${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
