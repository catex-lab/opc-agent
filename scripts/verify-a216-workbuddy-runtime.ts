/**
 * A216 闸门：WorkBuddy SDK 运行环境的「跨层混用」修复。
 *
 * ## 钉的是什么
 *
 * 2026-11-13 真机事故：项目入口新建会话发指令「一直没响应」。CLI 日志里反复出现
 * `Failed to load product config for environment="external" from "product.external.json"
 * (file not found; ... can cause API requests to be routed to the wrong host)`。
 *
 * 根因不是「配置写错」，而是**把两个不同层的词当成了同一个**：
 *   - `external` 是 `unstable_v2_authenticate()` 的登录环境值（表示海外版）；
 *   - CLI 侧的 product config 文件集合是
 *     `product.{internal,ioa,cloudhosted,selfhosted}.json` + 默认 `product.json`，
 *     恰好对应官方 SDK 概览里 `CODEBUDDY_INTERNET_ENVIRONMENT` 的取值。
 *     这里面**没有 external**。
 * 桌面端产品配置快照里的 `networkEnvironment=external` 属于登录层，原样透传给
 * CLI 就等于让它去找一个必然不存在的文件，端点静默回落 → 401 / initialize 卡死。
 *
 * 修法不是「把 external 改成别的」（那是猜），而是**把官方自己的配置交给 CLI**：
 * 官方快照写明 `productConfigPathEnv = "ACC_PRODUCT_CONFIG_PATH"`，打包 CLI 的
 * `resolveAuthoritativeFieldsFromConfigFile()` 会读这个路径里的 `endpoint` /
 * `deploymentType` 作为权威值。注入它之后，我们不再替 CLI 猜环境。
 *
 * ## 三层可观测量
 *
 *   [1]-[2] 纯函数：CLI 环境白名单、planSdkRuntime 的四种决策分支；
 *   [3] 运行时注入：真造一份官方快照，断言 ACC_PRODUCT_CONFIG_PATH 注入且
 *       environment 被省略；快照不存在时诚实回落、不注入不存在的路径；
 *   [4] 接线：applyWorkbuddyProfile 把最新快照路径交给 runtime；
 *   [5] 源码契约（剥注释 + 锚行首）：注入点、二选一、env 透传给 CLI；
 *   [6] 反向探针：把实现退回「透传 external」/「不注入路径」/「env 没传给
 *       CLI」三种坏版本，对应断言必须判红 —— 防止恒绿摆设。
 *
 * 运行：
 *   npx tsx scripts/verify-a216-workbuddy-runtime.ts
 *   npx tsx scripts/verify-a216-workbuddy-runtime.ts --probe=pass-external
 *   npx tsx scripts/verify-a216-workbuddy-runtime.ts --probe=no-config-path
 *   npx tsx scripts/verify-a216-workbuddy-runtime.ts --probe=no-env-forward
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLI_ENVIRONMENTS,
  isCliEnvironment,
  planSdkRuntime,
  resolveSdkRuntime,
} from '../server/agents/sdkRuntime.js';
import {
  applyWorkbuddyProfile,
  invalidateWorkbuddyProfile,
  snapshotFiles,
} from '../server/agents/wbProductProfile.js';
import { findDef } from '../server/agents/definitions.js';

const ARGS = process.argv.slice(2);
const PROBE = ARGS.find(a => a.startsWith('--probe='))?.slice(8) ?? null;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}
function eq<T>(actual: T, expected: T, name: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}
function group(title: string) { console.log(`\n── ${title} ──`); }

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 源码契约专用：剥块注释/行注释，避免注释里的字面量造成假绿 */
function stripComments(s: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of s.replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; out.push(''); continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; out.push(''); continue; }
    if (t.startsWith('//') || t.startsWith('*')) { out.push(''); continue; }
    const cut = raw.indexOf('//');
    out.push(cut >= 0 ? raw.slice(0, cut) : raw);
  }
  return out.join('\n');
}
const code = (rel: string) => stripComments(read(rel));
const hasLine = (src: string, re: RegExp) => src.split('\n').some(l => re.test(l));

// ═══════════════════════ [1] CLI 环境白名单 ═══════════════════════
group('1. CLI 侧环境集合：external 不属于它');
{
  eq(CLI_ENVIRONMENTS, ['internal', 'ioa', 'cloudhosted', 'selfhosted'],
    '★ 白名单恰好等于 product.<env>.json 的四个后缀');
  ok(!isCliEnvironment('external'), '★ external 被明确排除（登录层取值，不是 CLI 产品配置层）');
  for (const v of CLI_ENVIRONMENTS) ok(isCliEnvironment(v), `${v} 是合法 CLI 环境`);
  ok(!isCliEnvironment('') && !isCliEnvironment(undefined) && !isCliEnvironment(3),
    '否定式配对：空值 / 非字符串不算合法环境');
  // 「白名单不含 external」在「整个函数恒 false」时也会绿，所以配肯定式：
  ok(CLI_ENVIRONMENTS.length === 4 && isCliEnvironment('internal'),
    '肯定式：白名单不是空集、合法值确实放行');
}

// ═══════════════════════ [2] planSdkRuntime 四分支 ═══════════════════════
group('2. 环境/端点决策：有官方配置就不替 CLI 猜环境');
{
  const INTL = 'https://www.workbuddy.ai';
  const official = planSdkRuntime({ environment: 'external', endpoint: INTL, hasProductConfig: true });
  eq(official.reason, 'official-v3-config', '有官方 V3 配置 → 走 authoritative 分支');
  ok(!('environment' in official), '★ 有官方配置时省略 environment（避免 product.external.json）');
  eq(official.endpoint, INTL, '端点仍显式跟随官方声明');

  const fallback = planSdkRuntime({ environment: 'external', endpoint: INTL, hasProductConfig: false });
  eq(fallback.reason, 'external-not-cli-env', '没有官方配置 → 回落分支');
  ok(!('environment' in fallback), '★ 回落时也不透传 external（CLI 没有对应 product 文件）');
  eq(fallback.endpoint, INTL, '回落时端点仍在');

  const declared = planSdkRuntime({ environment: 'internal', endpoint: 'https://www.workbuddy.cn' });
  eq(declared.reason, 'declared', '合法 CLI 环境 → 声明式分支');
  eq(declared.environment, 'internal', '合法 CLI 环境原样保留（A155 兜底路径不变）');

  const none = planSdkRuntime({});
  eq(none.reason, 'none', '什么都没有 → none');
  const onlyEndpoint = planSdkRuntime({ endpoint: INTL });
  eq(onlyEndpoint.reason, 'declared', '只给端点 → declared');
  eq(onlyEndpoint.endpoint, INTL, '只给端点 → 端点保留');
  eq(planSdkRuntime({ endpoint: '   ' }).endpoint, undefined, '空白端点被 trim 成 undefined');

  // 四种 reason 都出现过，才说明不是「某个分支永远走不到」的假实现。
  const reasons = new Set([official, fallback, declared, none, onlyEndpoint].map(p => p.reason));
  ok(reasons.size >= 3, '肯定式：至少三条不同决策分支真的可达', [...reasons].join('/'));
}

// ═══════════════════════ [3] 真实注入 ═══════════════════════
group('3. resolveSdkRuntime：注入官方配置路径，且路径不存在时不硬指');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-a216-'));
{
  const cfg = path.join(TMP, 'acc-product-config-v3-4321-abcd.json');
  fs.writeFileSync(cfg, JSON.stringify({
    productConfigPathEnv: 'ACC_PRODUCT_CONFIG_PATH',
    endpoint: 'https://www.workbuddy.ai',
    networkEnvironment: 'external',
  }), 'utf8');

  const rt = resolveSdkRuntime({
    environment: 'external',
    endpoint: 'https://www.workbuddy.ai',
    configDir: TMP,
    productConfigPath: cfg,
  });
  eq(rt.env.ACC_PRODUCT_CONFIG_PATH, cfg, '★ ACC_PRODUCT_CONFIG_PATH 指向官方快照');
  eq(rt.env.CODEBUDDY_CONFIG_DIR, TMP, 'CODEBUDDY_CONFIG_DIR 仍指向生效数据根');
  eq(rt.endpoint, 'https://www.workbuddy.ai', '端点跟随官方声明');
  ok(!('environment' in rt), '★ 运行时不再给 CLI 一个不存在的 environment');

  // 路径不存在：宁可回落声明式，也不能指一个读不到的文件（CLI 会静默丢权威端点）。
  const missing = path.join(TMP, 'does-not-exist.json');
  const rt2 = resolveSdkRuntime({
    environment: 'internal',
    endpoint: 'https://www.workbuddy.cn',
    productConfigPath: missing,
  });
  ok(!('ACC_PRODUCT_CONFIG_PATH' in rt2.env), '★ 快照不可读时不注入路径（不制造静默失败）');
  eq(rt2.environment, 'internal', '快照不可读时诚实回落到声明式 environment');
  eq(rt2.endpoint, 'https://www.workbuddy.cn', '回落时端点仍在');
}

// ═══════════════════════ [4] profile → spec 接线 ═══════════════════════
group('4. applyWorkbuddyProfile 把最新快照交下去');
{
  const HOME = path.join(TMP, 'home');
  fs.mkdirSync(HOME, { recursive: true });
  process.env.OPC_WB_HOME = HOME;
  const root = path.join(HOME, '.workbuddy-ai');
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  const older = path.join(root, 'cache', 'acc-product-config-v3-1111-old.json');
  const newer = path.join(root, 'cache', 'acc-product-config-v3-2222-new.json');
  const cfg = {
    dataFolderName: '.workbuddy-ai', productName: 'WorkBuddy AI',
    endpoint: 'https://www.workbuddy.ai', networkEnvironment: 'external',
    productConfigPathEnv: 'ACC_PRODUCT_CONFIG_PATH',
  };
  fs.writeFileSync(older, JSON.stringify(cfg), 'utf8');
  fs.writeFileSync(newer, JSON.stringify(cfg), 'utf8');
  const t = Date.now();
  fs.utimesSync(older, new Date(t - 60_000), new Date(t - 60_000));
  fs.utimesSync(newer, new Date(t), new Date(t));

  invalidateWorkbuddyProfile();
  const spec = applyWorkbuddyProfile(findDef('workbuddy')?.sdk, 'workbuddy');
  eq(spec?.productConfigPath, snapshotFiles(root)[0], '★ 交下去的是 mtime 最新的那份快照');
  eq(spec?.productConfigPath, newer, '最新快照 = newer（不是按文件名排序）');
  eq(spec?.configDir, root, 'configDir 同源于生效数据根');

  const rt = resolveSdkRuntime(spec);
  eq(rt.env.ACC_PRODUCT_CONFIG_PATH, newer, '★ 端到端：官方配置路径真的到了 CLI 环境里');
  ok(!('environment' in rt), '★ 端到端：external 没有透传给 CLI');

  const other = findDef('claude')?.sdk;
  ok(applyWorkbuddyProfile(other, 'claude') === other,
    '非 workbuddy 不受影响（引用相等）');
  delete process.env.OPC_WB_HOME;
  invalidateWorkbuddyProfile();
}

// ═══════════════════════ [5] 源码契约 ═══════════════════════
group('5. 源码契约：剥注释 + 锚行首 + 反向探针');
{
  const runtime = code('server/agents/sdkRuntime.ts');
  const profile = code('server/agents/wbProductProfile.ts');
  const defs = code('server/agents/definitions.ts');
  const sdk = code('server/agents/adapters/sdk.ts');

  /**
   * 同一套判据，对「给定源码」求值。反向探针不是另写一条断言，而是把
   * 实现退回坏版本后**重跑这同一套判据**，要求被针对的那条真变红 ——
   * 否则「改坏了也能全绿」就是恒绿摆设。
   */
  const probeSrc = (rt: string, sk: string) => ({
    /** 有官方配置时省略 environment（return 对象里不带 environment） */
    noExternal: /return \{ endpoint, reason: 'official-v3-config' \};/.test(rt),
    /** 注入语句真的在，不是只写了常量名 */
    injectPath: hasLine(rt, /env\.ACC_PRODUCT_CONFIG_PATH = configPath;/),
    /** 注入前先校验快照可读 */
    existsCheck: hasLine(rt, /fs\.existsSync\(configPath\)/),
    /** 官方声明的变量名出现在运行时 */
    envName: hasLine(rt, /ACC_PRODUCT_CONFIG_PATH/),
    /** 池路径与 one-shot 路径都展开了 runtime（env 能到 CLI） */
    envForward: (sk.match(/\.\.\.this\.runtime,/g) ?? []).length >= 2,
  });

  const good = probeSrc(runtime, sdk);
  ok(good.noExternal, '★ 有官方配置时 return 对象里没有 environment（environment/endpoint 二选一）');
  ok(good.injectPath, '★ ACC_PRODUCT_CONFIG_PATH 注入语句确实在');
  ok(good.existsCheck, '注入前先校验快照可读（不指不存在的文件）');
  ok(good.envName, '运行时使用了官方声明的变量名');
  ok(good.envForward, '★ 池路径与 one-shot 路径都展开了 this.runtime（env 能到 CLI）');

  ok(hasLine(profile, /productConfigPath: configPath/),
    '★ applyWorkbuddyProfile 把快照路径写进 spec');
  ok(hasLine(profile, /snapshotFiles\(active\.root\)\[0\]/), '取的是最新一份快照');
  ok(hasLine(defs, /productConfigPath\?: string/), 'SdkSpec 声明了该字段');
  // 否定式配肯定式：上面「规格声明存在」在整份文件被换成空串时也红，
  // 但「白名单」那节的纯函数肯定式保证了实现没有被整个删掉。

  // ── 三个坏版本，各自退回一段实现 ──────────────────────────────
  const badPassExternal = probeSrc(
    runtime.replace("return { endpoint, reason: 'official-v3-config' };",
      "return { environment: input.environment, endpoint, reason: 'official-v3-config' };"),
    sdk
  );
  // 坏版本刻意保留变量名、只删掉赋值：模拟「注释/常量都写了，但没真的
  // 注入 env」这种最容易骗过静态检查的实现。若整行换成 void 0;，会连带
  // 让 envName 一起变红，反而测不出「局部退化」。
  const badNoPath = probeSrc(
    runtime.replace(/env\.ACC_PRODUCT_CONFIG_PATH = configPath;/g,
      'void env.ACC_PRODUCT_CONFIG_PATH;'),
    sdk
  );
  const badNoForward = probeSrc(runtime, sdk.replace(/\.\.\.this\.runtime,/g, 'void 0,'));

  /** 被针对的那条必须判红；其余判据不受影响（证明退化是局部的、不是整段删掉） */
  function probeRed(which: string, key: keyof ReturnType<typeof probeSrc>, bad: ReturnType<typeof probeSrc>) {
    if (PROBE !== which) { console.log(`  （${which} 探针未启用，跳过）`); return; }
    ok(!bad[key], `反向探针(${which})：退回坏版本后「${key}」判据真变红`);
    const others = (Object.keys(good) as Array<keyof typeof good>).filter(k => k !== key);
    ok(others.every(k => bad[k] === good[k]),
      `反向探针(${which})：其余判据仍为原值（退化是局部的，不是整段删掉）`);
    ok(good[key], `反向探针(${which})：正式实现下该判据为绿（否定式配肯定式）`);
  }
  probeRed('pass-external', 'noExternal', badPassExternal);
  probeRed('no-config-path', 'injectPath', badNoPath);
  probeRed('no-env-forward', 'envForward', badNoForward);

  // 纯函数层也配一条真实的反向：把 hasProductConfig 关掉，决策必须换分支。
  const withCfg = planSdkRuntime({ environment: 'external', endpoint: 'x', hasProductConfig: true });
  const withoutCfg = planSdkRuntime({ environment: 'external', endpoint: 'x', hasProductConfig: false });
  ok(withCfg.reason !== withoutCfg.reason && !('environment' in withCfg),
    '★ 纯函数反向：hasProductConfig 一关，决策分支就变（不是恒返回同一个对象）');
}

// ═══════════════════════ 汇总 ═══════════════════════
console.log(`\n${failures.length ? '✗' : '✓'} A216 WorkBuddy 运行环境：${pass}/${pass + fail} 通过${PROBE ? `（探针 ${PROBE}）` : ''}`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
