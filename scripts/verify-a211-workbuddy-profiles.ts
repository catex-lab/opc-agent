/**
 * A211 闸门：WorkBuddy「一个 Agent + 多个运行时 profile」。
 *
 * ## 为什么必须有一套独立闸门
 *
 * 这次事故的 401 不是「没登录」，而是**官方客户端换了活跃数据目录、我们仍读
 * 旧目录的旧 token**。这类 bug 用单点冒烟测不出来：
 *   - 只装国内版时一切正常；
 *   - `unstable_v2_authenticate` 只读本地缓存，永远说「在线」；
 *   - 「重新登录」在新目录生效，旧目录纹丝不动 —— 用户照做多少次都是无效循环。
 * 所以这里把四种安装组合、切换序列、以及「官方以后又改目录名」全部用夹具
 * 摆到台面上，而不是去断言一次真实登录能不能通。
 *
 * ## 三层可观测量（按项目验证纪律）
 *
 *   [1]-[5] 纯函数 / 跨状态序列：临时 home 造官方产品配置快照，断言发现、
 *       活跃度、固定/取消固定、漂移、脱敏、新鲜度；
 *   [6] 源码契约（剥注释 + 锚行首）：HTTP 路由、四段绳重建、模型清单接线、
 *       前端挂载、i18n 双语言键一致；
 *   [7] 反向探针：把实现「退回坏版本」或污染样本，确认对应断言真会变红。
 * 真服务端 + 浏览器点击序列在 `verify-a211-workbuddy-ui.mjs`。
 *
 * 运行：
 *   npx tsx scripts/verify-a211-workbuddy-profiles.ts
 *   npx tsx scripts/verify-a211-workbuddy-profiles.ts --probe=no-pid
 *   npx tsx scripts/verify-a211-workbuddy-profiles.ts --probe=leak
 *   npx tsx scripts/verify-a211-workbuddy-profiles.ts --probe=static-dir
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyWorkbuddyProfile,
  getPinnedProfile,
  invalidateWorkbuddyProfile,
  officialConfigForActive,
  readOfficialConfig,
  readWorkbuddyCustomModels,
  setPinnedWorkbuddyProfile,
  snapshotFiles,
  workbuddyCustomModels,
  workbuddyKeyblobDisplay,
  workbuddyKeyblobPath,
  workbuddyState,
  WB_SNAPSHOT_FRESH_MS,
} from '../server/agents/wbProductProfile.js';
import { resolveSdkRuntime } from '../server/agents/sdkRuntime.js';
import { findDef } from '../server/agents/definitions.js';
import { readDeclaredModels } from '../server/agents/wbProductConfig.js';
import { recoveryHintFor } from '../server/agents/recovery.js';
import {
  isStaleSdkModel,
  setConfiguredModelLookup,
  setPlatformModelLookup,
} from '../server/model-routing.js';

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

/** 探针模式下，被针对的那条断言**必须**判红；否则说明这条断言是恒绿摆设 */
function probeOk(cond: boolean, name: string, probe: string) {
  if (PROBE === probe) ok(!cond, `反向探针(${probe})：${name} 应判红`);
  else ok(cond, name);
}

// ── 夹具 ─────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-a211-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });

// 夹具要完全隔离：`wbProductProfile` 走 OPC_WB_HOME，
// `wbProductConfig` 的 legacy 固定名走 os.homedir()（Windows 读 USERPROFILE）。
process.env.OPC_WB_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
for (const k of ['ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_V2', 'ACC_PRODUCT_CONFIG', 'ACC_PRODUCT_CONFIG_PATH']) {
  delete process.env[k];
}

/** 与 wbProductProfile.ts 里的固定主文件同名（不 import 它，避免为测试开 API） */
const CONFIG_BASENAME = 'acc-product-config-v3.json';
const DAY = 86_400_000;
const NOW = Date.now();
// 两个故意长得像密钥的夹具哨兵：靠它们断言状态对象/脱敏返回值一次都没带出凭据。
const SECRET = 'sk-A211-MUST-NOT-LEAK-7788'; // secret-scan:ignore 测试夹具哨兵，不是真密钥
const SECRET_URL = 'https://secret-gateway.invalid/v1'; // secret-scan:ignore 测试夹具哨兵，不是真密钥

function writeAt(file: string, text: string, at: number) {
  fs.writeFileSync(file, text, 'utf8');
  fs.utimesSync(file, new Date(at), new Date(at));
}

interface RootOpts {
  endpoint: string;
  environment: 'internal' | 'external';
  productName: string;
  /** 产品配置快照的 mtime */
  configAt: number;
  keyblobAt?: number;
  modelsAt?: number;
  customModels?: Array<Record<string, unknown>>;
  /** 官方现在落的是带 PID+UUID 后缀的快照，不再写固定主文件 */
  pidSuffix?: boolean;
  /** 造「date 是发版日、很久以前」但文件刚写的样本 */
  date?: string;
  /** 只写部分字段，用来验多快照合并 */
  partial?: boolean;
}

function makeRoot(folder: string, o: RootOpts): string {
  const root = path.join(HOME, folder);
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  const cfg: Record<string, unknown> = {
    dataFolderName: folder,
    productName: o.productName,
    applicationName: folder,
    endpoint: o.endpoint,
    networkEnvironment: o.environment,
    date: o.date ?? new Date(o.configAt).toISOString(),
    productConfigPathEnv: 'ACC_PRODUCT_CONFIG_PATH',
    authentication: { type: 'account-scoped-external-link' },
  };
  if (!o.partial) {
    cfg.agents = [{ name: 'cli', models: ['fast-model', 'deep-model'] }];
    cfg.models = [
      { id: 'fast-model', name: '快速' },
      { id: 'deep-model', name: '极致' },
      { id: 'codewise-completions', name: '内部补全' },
    ];
  }
  const name = o.pidSuffix
    ? `${CONFIG_BASENAME.replace('.json', '')}-4321-6f0a.json`
    : CONFIG_BASENAME;
  writeAt(path.join(root, 'cache', name), JSON.stringify(cfg), o.configAt);
  if (o.keyblobAt !== undefined) writeAt(path.join(root, 'keyblob'), 'fake-keyblob', o.keyblobAt);
  if (o.customModels) {
    writeAt(path.join(root, 'models.json'), JSON.stringify(o.customModels), o.modelsAt ?? o.configAt);
  }
  return root;
}

const CN = {
  endpoint: 'https://www.workbuddy.cn',
  environment: 'internal' as const,
  productName: 'WorkBuddy',
};
const INTL = {
  endpoint: 'https://www.workbuddy.ai',
  environment: 'external' as const,
  productName: 'WorkBuddy AI',
};
const CUSTOM_MODELS = [
  { id: 'sensenova-6.8-flash-lite', name: '商汤轻量', vendor: 'SenseNova', apiKey: SECRET, url: SECRET_URL },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek Flash', vendor: 'DeepSeek', apiKey: SECRET, url: SECRET_URL },
];

function resetHome(): void {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  // pin 落在 data/workbuddy-profile.json（temp-data-dir 已指到临时目录）
  setPinnedWorkbuddyProfile(null);
  invalidateWorkbuddyProfile();
}

/** 生效 spec + 展开后的 SDK 运行参数，两个消费方共用同一套派生 */
function activeRuntime() {
  const spec = applyWorkbuddyProfile(findDef('workbuddy')?.sdk, 'workbuddy');
  return { spec, rt: resolveSdkRuntime(spec) };
}

// ───────────────────── [1] 只装国内版 ─────────────────────
group('1. 只装国内版：自动选中，且与定义表兜底值一致');
{
  resetHome();
  const root = makeRoot('.workbuddy', { ...CN, configAt: NOW - 2 * DAY, keyblobAt: NOW - DAY });
  invalidateWorkbuddyProfile();
  const s = workbuddyState(true);
  eq(s.profiles.length, 1, '只检测到一个数据根');
  eq(s.activeId, '.workbuddy', '自动选中 .workbuddy');
  ok(!s.fallback && !s.pinned, '不是兜底、也不是手动固定');
  ok(s.profiles[0].detected && s.profiles[0].complete, '从官方声明读到且四项齐全');
  eq(s.profiles[0].endpoint, CN.endpoint, 'endpoint 跟随官方声明');
  eq(s.profiles[0].environment, 'internal', 'networkEnvironment → internal');
  eq(s.profiles[0].region, 'cn', '区域按 endpoint 判（不是拿网络环境冒充产品身份）');
  eq(s.drift.length, 0, '与定义表内置快照一致 → 无漂移告警');

  const { spec, rt } = activeRuntime();
  eq(spec?.configDir, root, 'configDir 被覆盖成该数据根的绝对路径');
  eq(rt.env.CODEBUDDY_CONFIG_DIR, root, 'SDK 子进程的 CODEBUDDY_CONFIG_DIR 指向它');
  eq(rt.endpoint, CN.endpoint, 'SDK endpoint 跟随官方');
  eq(rt.environment, 'internal', 'SDK environment 跟随官方');
  eq(workbuddyKeyblobPath(), path.join(root, 'keyblob'), 'keyblob 路径跟随生效 profile');
  eq(workbuddyKeyblobDisplay(), '~/.workbuddy/keyblob', '给人看的登录态路径是 ~/ 形态');
  ok(officialConfigForActive() !== null, '模型补齐源指向生效 profile');
}

// ───────────────────── [2] 只装国际版 ─────────────────────
group('2. 只装国际版：三项参数全变 + 漂移告警 + 自定义模型脱敏');
{
  resetHome();
  const root = makeRoot('.workbuddy-ai', {
    ...INTL,
    configAt: NOW - 3 * DAY,
    keyblobAt: NOW - 2 * DAY,
    modelsAt: NOW - 1000,
    customModels: CUSTOM_MODELS,
    pidSuffix: true,
  });
  invalidateWorkbuddyProfile();
  const s = workbuddyState(true);
  eq(s.activeId, '.workbuddy-ai', '自动选中 .workbuddy-ai');
  eq(s.profiles[0].endpoint, INTL.endpoint, 'endpoint=www.workbuddy.ai');
  eq(s.profiles[0].environment, 'external', 'environment=external');
  eq(s.profiles[0].region, 'intl', '区域=intl');
  eq(s.drift.length, 3, 'configDir / endpoint / environment 三项全部漂移');
  eq(s.drift.map(d => d.field).sort(), ['configDir', 'endpoint', 'environment'], '漂移字段名齐全');
  const dirDrift = s.drift.find(d => d.field === 'configDir');
  eq(dirDrift?.official, '~/.workbuddy-ai', '漂移的 official 写成 ~/ 形态，不带本机绝对路径');
  ok(!JSON.stringify(s).includes(TMP), '★ 整个状态对象不含本机临时绝对路径');

  const { rt } = activeRuntime();
  eq(rt.env.CODEBUDDY_CONFIG_DIR, root, '★ SDK 配置根切到 .workbuddy-ai（401 的直接修复点）');
  eq(rt.endpoint, INTL.endpoint, 'SDK endpoint 切到国际站');
  eq(workbuddyKeyblobDisplay(), '~/.workbuddy-ai/keyblob', '恢复话术里的登录态路径跟着换');

  eq(s.customModels.length, 2, '读到桌面端两条自定义模型');
  eq(s.customModels.map(m => m.id), CUSTOM_MODELS.map(m => m.id), '模型 id 原样保留（交给 SDK setModel）');
  eq(s.customModels[0].agentIds, ['workbuddy'], '归属只有 workbuddy');
  ok(s.customModels[0].source.includes('SenseNova'), 'vendor 作为展示来源带出');
  const serialized = JSON.stringify(s.customModels);
  ok(!serialized.includes(SECRET) && !serialized.includes(SECRET_URL), '★ 状态对象里没有 apiKey / url');
  // 否定式必须配肯定式：上面那条在「整个读取器坏掉、返回 []」时也会绿。
  ok(workbuddyCustomModels().length === 2, '肯定式：脱敏清单确实读到了两条模型');

  const raw = readWorkbuddyCustomModels(root);
  /* 反向探针 leak：模拟「实现退回会把整条模型对象原样带出去」的坏版本。
     只在探针模式往样本里塞一条带密钥的记录；正常模式样本就是真实返回值。
     这样隐私断言在正常模式验实现、在探针模式验「断言本身不是恒绿」。 */
  const sample = PROBE === 'leak'
    ? [...raw, { id: 'leak', label: 'leak', source: `${SECRET}|${SECRET_URL}`, agentIds: ['workbuddy'] }]
    : raw;
  probeOk(
    !JSON.stringify(sample).includes(SECRET) && !JSON.stringify(sample).includes(SECRET_URL),
    '★ 脱敏读取器的返回值里没有 apiKey / url',
    'leak'
  );
  if (PROBE === 'leak') {
    ok(JSON.stringify(sample).includes(SECRET), '反向探针(leak)：污染样本确实含密钥');
  }
}

// ───────────────────── [3] 两个都装：跨状态序列 ─────────────────────
group('3. 两个都装：活跃度 → 固定 → 切回自动，且官方改目录名也认');
{
  resetHome();
  const cnRoot = makeRoot('.workbuddy', { ...CN, configAt: NOW - 10 * DAY, keyblobAt: NOW - 9 * DAY });
  const intlRoot = makeRoot('.workbuddy-ai', {
    ...INTL, configAt: NOW - 3 * DAY, keyblobAt: NOW - 2 * DAY, customModels: CUSTOM_MODELS,
  });
  invalidateWorkbuddyProfile();
  let s = workbuddyState(true);
  eq(s.profiles.length, 2, '两个数据根都被发现');
  eq(s.activeId, '.workbuddy-ai', '自动选最近活跃的那个（不是名字排序、不是写死国内版）');
  ok(s.reason.includes('2 个版本'), '状态说明如实写出检测到几个版本');

  // 序列 1：让国内版的 keyblob 变成最新 → 自动选择必须跟着变。
  // 刻意比脚本基准 NOW 早 1 分钟：序列 5 还要造一个「NOW 写入」的第三目录，
  // 时间戳撞平时的稳定排序会保留旧顺序，那测的就不是活跃度了。
  writeAt(path.join(cnRoot, 'keyblob'), 'refreshed', NOW - 60_000);
  invalidateWorkbuddyProfile();
  s = workbuddyState(true);
  eq(s.activeId, '.workbuddy', '★ 跨状态：活跃度变了，自动选择跟着变');
  eq(activeRuntime().rt.env.CODEBUDDY_CONFIG_DIR, cnRoot, 'SDK 配置根也跟着换');

  // 序列 2：固定到较不活跃的国际版 → 活跃度不再覆盖用户选择。
  const pinned = setPinnedWorkbuddyProfile('.workbuddy-ai');
  ok(pinned.ok, '固定到已检测到的 id 成功');
  eq(getPinnedProfile(), '.workbuddy-ai', '固定值落盘');
  invalidateWorkbuddyProfile();
  s = workbuddyState(true);
  eq(s.activeId, '.workbuddy-ai', '★ 固定后不再被活跃度抢走');
  ok(s.pinned && s.reason.includes('已固定'), '状态明确标注「已固定」');
  eq(activeRuntime().rt.endpoint, INTL.endpoint, '运行时三项真的切到国际版');
  eq(workbuddyKeyblobPath(), path.join(intlRoot, 'keyblob'), 'keyblob 路径也切过去');

  // 序列 3：非法 id 必须拒绝，且不能悄悄改掉当前选择。
  const bad = setPinnedWorkbuddyProfile('.workbuddy-mars');
  ok(!bad.ok && !!bad.reason, '★ 固定到不存在的 id 被拒绝（不制造指向空气的开关）');
  invalidateWorkbuddyProfile();
  eq(workbuddyState(true).activeId, '.workbuddy-ai', '被拒绝后生效 profile 不变');

  // 序列 4：取消固定 → 回到按活跃度自动（国内版），不是停留在最后一次固定值。
  ok(setPinnedWorkbuddyProfile(null).ok, '取消固定成功');
  invalidateWorkbuddyProfile();
  s = workbuddyState(true);
  eq(s.activeId, '.workbuddy', '★ 取消固定后回到活跃度最高的那个');
  ok(!s.pinned, 'pinned 标记复位');

  // 序列 5：官方以后改目录名 / 新增第三个版本，不写死名单也能认。
  const euRoot = makeRoot('.workbuddy-eu', {
    ...INTL, productName: 'WorkBuddy EU', endpoint: 'https://www.workbuddy.eu',
    configAt: NOW, keyblobAt: NOW, pidSuffix: true,
  });
  invalidateWorkbuddyProfile();
  s = workbuddyState(true);
  const all = s.profiles.map(p => p.id);
  // 反向探针 static-dir：模拟「只认两个写死目录名」的坏实现。
  const seenIds = PROBE === 'static-dir'
    ? all.filter(id => id === '.workbuddy' || id === '.workbuddy-ai')
    : all;
  probeOk(seenIds.includes('.workbuddy-eu'), '★ 第三个任意命名的数据根被自动发现', 'static-dir');
  if (PROBE === 'static-dir') {
    ok(!seenIds.includes('.workbuddy-eu'), '反向探针(static-dir)：写死名单的坏实现确实看不见第三个');
  } else {
    eq(s.activeId, '.workbuddy-eu', '新目录最活跃时自动切过去（不用改代码）');
    eq(activeRuntime().rt.env.CODEBUDDY_CONFIG_DIR, euRoot, '新目录的 SDK 配置根生效');
  }

  // 非 workbuddy 的 Agent 绝不能被腾讯产品的规则误伤。
  const other = findDef('claude')?.sdk;
  ok(applyWorkbuddyProfile(other, 'claude') === other, '非 workbuddy：spec 原样返回（引用相等）');
  ok(applyWorkbuddyProfile(undefined, 'claude') === undefined, '非 workbuddy：undefined 原样返回');
}

// ───────────────────── [4] 一个都没装 ─────────────────────
group('4. 一个都没装：诚实降级，不假绿');
{
  resetHome();
  invalidateWorkbuddyProfile();
  const s = workbuddyState(true);
  eq(s.profiles.length, 1, '给一个明确标注的内置兜底项');
  ok(s.fallback, '★ fallback=true');
  ok(!s.profiles[0].detected && !s.profiles[0].complete, '兜底项明确标「没检测到 / 不完整」');
  ok(s.reason.includes('内置默认值'), '状态说明承认用的是内置默认值');
  const spec = findDef('workbuddy')?.sdk;
  ok(applyWorkbuddyProfile(spec, 'workbuddy') === spec, '★ 没检测到官方配置时不动定义表（原样返回）');
  eq(workbuddyKeyblobDisplay(), '~/.workbuddy/keyblob', '兜底时恢复话术仍指得到登录态文件');
  const hint = recoveryHintFor('workbuddy');
  ok(hint.includes('~/.workbuddy') && hint.includes('CODEBUDDY_API_KEY'), '恢复话术仍可执行（含路径与 Key 字段名）');
}

// ───────────────────── [5] 快照形状与新鲜度 ─────────────────────
group('5. 带 PID 后缀的快照、多快照合并、mtime 而非发版日');
{
  resetHome();
  // 只落带 PID 后缀的快照，且发版日是 60 天前、文件是刚写的。
  const root = makeRoot('.workbuddy-ai', {
    ...INTL, configAt: NOW - 1000, keyblobAt: NOW - 1000,
    date: new Date(NOW - 60 * DAY).toISOString(), pidSuffix: true,
  });
  invalidateWorkbuddyProfile();
  const files = snapshotFiles(root);
  eq(files.length, 1, '★ 带 PID+UUID 后缀的快照能被枚举到');
  // 反向探针 no-pid：模拟「只读固定主文件」的旧实现。
  const seenFiles = PROBE === 'no-pid'
    ? files.filter(f => path.basename(f) === CONFIG_BASENAME)
    : files;
  probeOk(
    seenFiles.length > 0,
    '★ 没有固定主文件时仍找得到官方声明（旧实现只读固定名会恒 null）',
    'no-pid'
  );
  if (PROBE === 'no-pid') {
    eq(seenFiles.length, 0, '反向探针(no-pid)：只读固定名的坏实现确实拿到空列表');
  }
  const merged = readOfficialConfig(root);
  ok(merged !== null && merged.cfg.dataFolderName === '.workbuddy-ai', '合并后读得到 dataFolderName');

  // 关键：cfg.date 是发版日，不是本机最后使用时间。按 date 判会把刚写的配置判死。
  const declared = readDeclaredModels();
  ok(declared !== null, '★ 60 天前的发版日 + 刚写的 mtime：补齐源仍有效');
  eq(declared?.declared, ['fast-model', 'deep-model'], '补的是 cli agent 自声明的两条');

  // 反向：文件也真的过期了，闸门必须判死（否则会把下线模型补进菜单）。
  const staleFile = snapshotFiles(root)[0];
  fs.utimesSync(staleFile, new Date(NOW - (WB_SNAPSHOT_FRESH_MS + DAY)), new Date(NOW - (WB_SNAPSHOT_FRESH_MS + DAY)));
  invalidateWorkbuddyProfile();
  eq(readDeclaredModels(), null, '★ 文件 mtime 超过 7 天时补齐源作废（新鲜度闸门仍在）');

  // 多快照字段互补：新的一份缺 networkEnvironment，旧的一份补上它。
  resetHome();
  const root2 = makeRoot('.workbuddy', { ...CN, configAt: NOW - 4 * DAY, partial: true });
  const cache = path.join(root2, 'cache');
  const older = path.join(cache, 'acc-product-config-v3-1111-aaaa.json');
  writeAt(older, JSON.stringify({
    networkEnvironment: 'internal',
    productConfigEnv: 'ACC_PRODUCT_CONFIG_V3',
    dataFolderName: '.workbuddy',
  }), NOW - 5 * DAY);
  invalidateWorkbuddyProfile();
  const cfg2 = readOfficialConfig(root2)?.cfg ?? {};
  eq(cfg2.networkEnvironment, 'internal', '★ 合并：旧快照补上缺失的 networkEnvironment');
  eq(cfg2.productConfigEnv, 'ACC_PRODUCT_CONFIG_V3', '合并：只补缺失键，不丢另一份的字段');
  eq(cfg2.endpoint, CN.endpoint, '合并：先到先占，新快照的 endpoint 不被旧值覆盖');
}

// ───────────────────── [6] 自定义模型不会被下一轮抹掉 ─────────────────────
group('6. 模型路由：自定义模型 id 不被当成「已下线的旧 SDK 模型」');
{
  setPlatformModelLookup(() => ['official-a', 'official-b']);
  setConfiguredModelLookup((agentId, modelId) =>
    agentId === 'workbuddy' && modelId === 'sensenova-6.8-flash-lite');
  ok(!isStaleSdkModel('workbuddy', 'official-a'), '平台清单里的模型不算失效');
  ok(!isStaleSdkModel('workbuddy', 'sensenova-6.8-flash-lite'), '★ 本机自定义模型不算失效（否则刷新会话就没了）');
  ok(isStaleSdkModel('workbuddy', 'removed-old-model'), '★ 否定式配对：真正不在两处的旧模型仍判失效');
  ok(!isStaleSdkModel('claude', 'anything'), '非腾讯 SDK 不参与平台清单失效判断');
  setPlatformModelLookup(null);
  setConfiguredModelLookup(null);
}

// ───────────────────── [7] 源码契约 ─────────────────────
group('7. 源码契约：剥注释 + 锚行首 + 反向探针');
{
  function stripComments(s: string): string {
    const out: string[] = [];
    let inBlock = false;
    for (const raw of s.replace(/\r\n/g, '\n').split('\n')) {
      const t = raw.trim();
      if (inBlock) {
        if (t.includes('*/')) inBlock = false;
        out.push('');
        continue;
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true;
        out.push('');
        continue;
      }
      if (t.startsWith('//') || t.startsWith('*')) { out.push(''); continue; }
      const cut = raw.indexOf('//');
      out.push(cut >= 0 ? raw.slice(0, cut) : raw);
    }
    return out.join('\n');
  }
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  const code = (rel: string) => stripComments(read(rel));
  const hasLine = (src: string, re: RegExp) => src.split('\n').some(l => re.test(l));

  const idx = code('server/index.ts');
  const profile = code('server/agents/wbProductProfile.ts');
  const routing = code('server/model-routing.ts');
  const settings = code('src/components/SettingsPage.tsx');
  const popup = code('src/components/ModelSelectPopup.tsx');

  ok(hasLine(idx, /app\.get\("\/api\/workbuddy-profiles"/), 'GET 状态接口已挂');
  ok(hasLine(idx, /app\.post\("\/api\/workbuddy-profiles\/switch"/), 'POST 切换接口已挂');
  ok(hasLine(idx, /app\.post\("\/api\/workbuddy-profiles\/refresh"/), 'POST 重扫接口已挂');
  ok(hasLine(idx, /registry\.replaceProvider\('workbuddy'\)/),
    '★ 切换时重建 SDK 适配器（否则常驻 CLI 仍持旧 token）');
  ok(hasLine(idx, /invalidateAllModelCaches\(reason\)/), '★ 切换时清模型缓存');
  ok(hasLine(idx, /configuredCache = null/), '★ 切换时清 A210 lookup 缓存');
  ok(hasLine(idx, /registry\.probeOne\('workbuddy', true\)/), '★ 切换后立即重探');
  ok(hasLine(idx, /workbuddyCustomModels\(\)/), '模型清单接口下发脱敏自定义模型');
  // 四段绳反向探针：删掉重建那一段，契约必须判红。
  const broken = idx.replace(/registry\.replaceProvider\('workbuddy'\)/g, 'void 0');
  ok(!hasLine(broken, /registry\.replaceProvider\('workbuddy'\)/),
    '反向探针：把重建删掉后「切换会重建适配器」契约判红（不是恒绿）');

  ok(hasLine(profile, /f\.startsWith\(`\$\{CONFIG_PREFIX\}-\`\)/),
    '★ 快照枚举认 PID 后缀（旧实现只读固定名）');
  ok(!/\bm\.apiKey\b|\bm\.url\b/.test(profile),
    '★ 自定义模型读取器不碰 apiKey / url 键（否定式，配上面的隐私肯定式）');
  ok(hasLine(routing, /configuredLookup\?\.\(agentId, modelId\)/),
    'isStaleSdkModel 放行了本机配置模型');
  ok(hasLine(settings, /<WorkbuddyProfileSettings onChanged=\{onCredentialsSaved\}/),
    '设置页真的挂了产品版本组件，并复用 #16 刷新总线');
  ok(hasLine(popup, /wbOnlyGroup \? 'WorkBuddy 自定义模型' : '本机 CLI 配置'/),
    '模型菜单对纯 WorkBuddy 自定义模型显示正确分组标题');

  // 「坏响应不白屏」：夹具兜底 json({}) / 反代错误页 / 旧服务端都会给不完整 JSON。
  // 只靠 `as WorkbuddyProfileState` 是编译期擦掉的，render 里 state.profiles.filter
  // 一抛就会把整个设置页交给 ErrorBoundary（A211 整链在 verify:a28 红的就是这个）。
  const wbSettings = code('src/components/WorkbuddyProfileSettings.tsx');
  ok(hasLine(wbSettings, /function isProfileState\(v: unknown\): v is WorkbuddyProfileState/),
    '★ 产品版本组件对响应做运行时形状校验（不是只靠 TS 类型断言）');
  ok((wbSettings.match(/if \(!isProfileState\(parsed\)\)/g) ?? []).length === 2,
    '★ GET 与 POST 两条路径都过形状校验（缺一条仍会白屏）');
  ok(!/setState\(\(await res\.json\(\)\) as WorkbuddyProfileState\)/.test(wbSettings),
    '★ 不再把未校验响应直接断言成 State（否定式，配上面的肯定式）');
  const noGuard = wbSettings.replace(/if \(!isProfileState\(parsed\)\) throw new Error\([^;]+\);/g, '');
  ok(!/isProfileState\(parsed\)/.test(noGuard),
    '反向探针：删掉两处校验后「两条路径都过校验」契约判红（不是恒绿）');

  // i18n 两份键集合必须一致，否则英文界面会掉回 key 名。
  const keysOf = (rel: string) => [...read(rel).matchAll(/'(settings\.wbProfile\.[^']+)':/g)].map(m => m[1]).sort();
  const zhKeys = keysOf('src/i18n/zh.ts');
  const enKeys = keysOf('src/i18n/en.ts');
  ok(zhKeys.length >= 15, '中文资源补齐了产品版本文案', String(zhKeys.length));
  eq(enKeys, zhKeys, '★ 中英键集合完全一致');
}

console.log(`\n${failures.length ? '✗' : '✓'} A211 WorkBuddy 产品版本：${pass}/${pass + fail} 通过${PROBE ? `（探针 ${PROBE}）` : ''}`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
console.log('✓ 四种安装组合 / 切换序列 / 脱敏 / 新鲜度 / 接线均符合预期');
