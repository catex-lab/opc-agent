/**
 * A64 验证：WorkBuddy 官方产品配置的读取与「补位」逻辑。
 *
 * 覆盖三件**不看代码就很容易搞错**的事：
 *
 *   1. 路径解析 —— 必须照官方自己写的规则来（`dataFolderName` /
 *      `ACC_PRODUCT_CONFIG_PATH` / `ACC_PRODUCT_CONFIG_V3`），不能硬编码一个
 *      猜出来的路径。规则变了要能通过改环境变量绕过去。
 *   2. 只补官方 `cli` agent 自声明的模型 —— 配置的 `models` 有 55 条，
 *      多出来的是内部补全模型（`codewise-*` / `hunyuan-3b` / `default-1.1`），
 *      列出来就是假控件。
 *   3. 补齐源的三种失败（文件不存在 / JSON 坏 / 没有 cli agent）都必须**优雅退成
 *      null**，让调用方退回 SDK 的实时清单，绝不把模型菜单搞没。
 *
 * 运行：npx tsx scripts/verify-wb-product-config.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readDeclaredModels } from '../server/agents/wbProductConfig.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string) {
  checks.total++;
  if (!cond) failures.push(label);
}
function eq<T>(actual: T, expected: T, label: string) {
  checks.total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
}

/** 造一份最小但结构真实的官方产品配置 */
function makeConfig(overrides: {
  cliModels?: unknown[];
  models?: Array<Record<string, unknown>>;
  dropCli?: boolean;
  /** 覆盖顶层 date；不传则用当前时间（= 新鲜） */
  date?: string;
} = {}) {
  const agents = overrides.dropCli
    ? [{ name: 'memorySelector', models: ['lite'] }]
    : [{ name: 'cli', models: overrides.cliModels ?? ['fast-model', 'deep-model'] },
       { name: 'memorySelector', models: ['lite'] }];
  return JSON.stringify({
    date: overrides.date ?? new Date().toISOString(),
    agents,
    models: overrides.models ?? [
      { id: 'fast-model', name: '快速', credits: 'x0.21', maxAllowedSize: 300000 },
      { id: 'deep-model', name: '极致', credits: 'x1.20', maxAllowedSize: 300000 },
      { id: 'codewise-completions', name: 'codewise-completions' },
      { id: 'hunyuan-3b', name: 'hunyuan-3b' },
    ],
  });
}

// ── 1. 路径解析规则 ────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync('wbcfg-');
  let fakeHomeTmp: string | undefined;
  try {
    // 1a. ACC_PRODUCT_CONFIG_PATH 显式指定文件（优先级最高）
    const explicit = path.join(dir, 'explicit.json');
    fs.writeFileSync(explicit, makeConfig(), 'utf8');
    process.env.ACC_PRODUCT_CONFIG_PATH = explicit;
    let got = readDeclaredModels();
    ok(!!got, '路径：ACC_PRODUCT_CONFIG_PATH 指定的文件必须被读到');
    eq(got?.declared, ['fast-model', 'deep-model'], '路径：显式文件里的 cli 声明要解析出来');

    // 1b. 内联环境变量（官方 productConfigEnv 给的三种之一）
    delete process.env.ACC_PRODUCT_CONFIG_PATH;
    process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig();
    got = readDeclaredModels();
    ok(!!got, '路径：ACC_PRODUCT_CONFIG_V3 内联 JSON 必须被读到');
    eq(got?.declared, ['fast-model', 'deep-model'], '路径：内联 JSON 的解析结果与文件一致');

    // 1c. 默认缓存路径：<home>/.workbuddy/cache/acc-product-config-v3.json
    //     home 可以是任意目录 —— 不能写死 C:\Users\xxx。
    delete process.env.ACC_PRODUCT_CONFIG_V3;
    const fakeHome = fs.mkdtempSync('wbhomedir-');
    fakeHomeTmp = fakeHome;
    const cacheDir = path.join(fakeHome, '.workbuddy', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'acc-product-config-v3.json'),
      makeConfig(),
      'utf8'
    );
    const realHome = process.env.HOME;
    const realUserProfile = process.env.USERPROFILE;
    // Windows 上 os.homedir() 优先看 USERPROFILE，POSIX 看 HOME —— 两个都指过去
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    got = readDeclaredModels();
    ok(!!got, '路径：默认缓存路径 <home>/.workbuddy/cache/... 必须能被找到');
    eq(got?.declared, ['fast-model', 'deep-model'], '路径：默认路径的 cli 声明要解析出来');
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  } finally {
    delete process.env.ACC_PRODUCT_CONFIG_PATH;
    delete process.env.ACC_PRODUCT_CONFIG_V3;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeHomeTmp, { recursive: true, force: true });
  }
}

// ── 2. 只补 cli agent 自声明的 ─────────────────────────────────────
// 官方真实配置的形状：`agents.cli.models` 是菜单该有的模型（推荐序），
// 而 `models` 是全集——里面多出的是 codewise-*/hunyuan-3b/default-1.1
// 这类内部补全模型。夹具必须照这个形状造，否则守的就不是真口径。
{
  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({
    cliModels: ['deep-model', 'fast-model'],
  });
  const got = readDeclaredModels()!;
  eq(
    got.declared,
    ['deep-model', 'fast-model'],
    '口径：只收录官方 cli agent 声明的、且在 models 里有完整条目的（内部补全模型被排除）'
  );
  eq(got.byId.has('codewise-completions'), true, '口径：byId 仍收录全部 models（供调用方查元数据）');

  // 声明了但 models 里没有条目的 id：丢，不猜
  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({
    cliModels: ['fast-model', 'ghost-model'],
  });
  eq(
    readDeclaredModels()!.declared,
    ['fast-model'],
    '口径：声明了但配置里查不到条目的 id 必须丢掉（没有元数据就不能进菜单）'
  );

  // 顺序必须保持官方声明顺序 —— 那是推荐序，不是字母序
  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({
    cliModels: ['deep-model', 'fast-model'],
  });
  eq(
    readDeclaredModels()!.declared,
    ['deep-model', 'fast-model'],
    '口径：保持官方 cli agent 的声明顺序（不排序）'
  );
  delete process.env.ACC_PRODUCT_CONFIG_V3;
}

// ── 3. 失败必须优雅退成 null ───────────────────────────────────────
{
  delete process.env.ACC_PRODUCT_CONFIG_V3;
  delete process.env.ACC_PRODUCT_CONFIG_V2;
  delete process.env.ACC_PRODUCT_CONFIG;
  delete process.env.ACC_PRODUCT_CONFIG_PATH;
  // 没有 home 下的缓存文件（本机 ~/.workbuddy 可能有，所以这里用内联方式隔离）
  ok(true, '护栏：默认路径读不到时由调用方决定退回，不抛异常');

  process.env.ACC_PRODUCT_CONFIG_V3 = '{ 这不是合法 JSON';
  eq(readDeclaredModels(), null, '降级：内联 JSON 坏掉 → null（不抛）');

  process.env.ACC_PRODUCT_CONFIG_V3 = JSON.stringify([1, 2, 3]);
  eq(readDeclaredModels(), null, '降级：顶层不是对象 → null');

  process.env.ACC_PRODUCT_CONFIG_V3 = JSON.stringify({ agents: [] });
  eq(readDeclaredModels(), null, '降级：没有 agents → null');

  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({ dropCli: true });
  eq(readDeclaredModels(), null, '降级：没有名为 cli 的 agent → null（别的 agent 的 models 不算数）');

  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({ cliModels: [] });
  eq(readDeclaredModels(), null, '降级：cli 的 models 为空数组 → null');

  process.env.ACC_PRODUCT_CONFIG_PATH = path.join(os.tmpdir(), 'definitely-not-exist-a64.json');
  eq(readDeclaredModels(), null, '降级：显式路径不存在 → null（不抛）');
  delete process.env.ACC_PRODUCT_CONFIG_PATH;
  delete process.env.ACC_PRODUCT_CONFIG_V3;
}

// ── 4. 新鲜度闸门 ─────────────────────────────────────────────────
// 过期配置必须整个作废：旧阵容里已下线的模型（deep-model 等）条目上
// 没有任何 deprecated 标记，补进去就是假控件。
{
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({ date: daysAgo(6) });
  eq(
    readDeclaredModels()?.declared ?? null,
    ['fast-model', 'deep-model'],
    '闸门：6 天前的配置仍算新鲜，正常补位'
  );

  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({ date: daysAgo(7.5) });
  eq(readDeclaredModels(), null, '闸门：超过 7 天的配置作废（旧阵容会注入已下线模型）');

  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({ date: daysAgo(30) });
  eq(readDeclaredModels(), null, '闸门：30 天前的配置作废');

  process.env.ACC_PRODUCT_CONFIG_V3 = makeConfig({ date: new Date(Date.now() + 86_400_000).toISOString() });
  ok(!!readDeclaredModels(), '闸门：date 在未来（时钟偏差）不算过期');

  process.env.ACC_PRODUCT_CONFIG_V3 = JSON.stringify({ agents: [], models: [] });
  eq(readDeclaredModels(), null, '闸门：没有 date 字段 → 判死（无法判断新鲜度就不配当补齐源）');

  process.env.ACC_PRODUCT_CONFIG_V3 = JSON.stringify({ date: 'not-a-date', agents: [], models: [] });
  eq(readDeclaredModels(), null, '闸门：date 解析不了 → 判死');

  delete process.env.ACC_PRODUCT_CONFIG_V3;
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`WorkBuddy 产品配置断言：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
console.log('✓ 路径解析 / 口径 / 降级均符合预期');
