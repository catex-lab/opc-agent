/**
 * A155：WorkBuddy 真正接到 SDK 通道的验收闸门。
 *
 * 要钉的是一件事：**WorkBuddy 这三处调用（对话 / 模型清单 / 登录检查）必须
 * 用同一套产品参数（internal + www.workbuddy.cn + ~/.workbuddy）**。
 *
 * ## 为什么不能只测「模型能拉出来」
 *
 * 因为错误接法**也会成功**：以前三处都写死 `environment: 'external'`，
 * 拉模型、查登录全都不报错 —— 只是接的是 CodeBuddy 国际站，拿回的是另一份
 * 模型清单。这种「静默接错产品」靠一次接口冒烟是看不出来的，所以这里分成三层：
 *
 *   [1] 纯函数层：`resolveSdkRuntime` 的展开规则（~ 展开 / configDir →
 *       CODEBUDDY_CONFIG_DIR / 缺省不臆造值 / env 不串味）；
 *   [2] 源码契约层：四个消费方**不再有任何一处写死 external**，且都走 runtime；
 *   [3] 可选实跑层（OPC_LIVE=1）：真连 WorkBuddy 国内版，断言模型清单里有
 *       WorkBuddy 独有的 id（`hy3-x`），用来证明「接对了产品」而不只是「通了」。
 *
 * 运行：npm run verify:a155-workbuddy-sdk
 * 实跑：OPC_LIVE=1 npm run verify:a155-workbuddy-sdk
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, resolveSdkRuntime } from '../server/agents/sdkRuntime.js';
import { findDef } from '../server/agents/definitions.js';

const ROOT = process.cwd();

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

/**
 * 去掉注释后的源码行。
 *
 * 为什么必须去：本轮改动留了「以前这里写死 `environment: 'external'`」这类
 * 说明性注释 —— 直接在整个文件里搜 external 会把注释算进去，导致 assert
 * 永远红，然后被人改成「注释里不许提 external」这种本末倒置的修法。
 * 只保留真正的代码行，断言的才是「代码里没有硬编码」。
 */
function codeLines(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

// ───────────────────── [1] 纯函数：runtime 展开 ─────────────────────
console.log('\n[1] resolveSdkRuntime：把定义表的 SdkSpec 展开成 SDK 认的形态');
{
  const home = os.homedir();

  // ~ 展开：只认 `~` / `~/` / `~\`，其它原样返回（不猜、不替用户做决定）
  ok(expandHome('~') === home, '~ → 主目录');
  ok(expandHome('~/x') === path.join(home, 'x'), '~/x → 主目录/x');
  ok(expandHome('~\\x') === path.join(home, 'x'), '~\\x → 主目录/x（Windows 写法）');
  ok(expandHome('C:/Users/me') === 'C:/Users/me', '绝对路径原样返回');
  ok(expandHome('relative/x') === 'relative/x', '相对路径不臆造（不拼 home）');

  // 没声明 spec：不塞任何默认值 —— 「缺配」应该由 SDK 自己的默认接管，
  // 我们兜一个 external 只会掩盖「这个 Agent 没配产品参数」。
  const empty = resolveSdkRuntime(undefined);
  ok(!('environment' in empty), 'undefined → 不带 environment');
  ok(!('endpoint' in empty), 'undefined → 不带 endpoint');
  ok(Object.keys(empty.env).length === 0, 'undefined → env 为空（不悄悄塞配置根）');

  // 空 spec 与 undefined 等价
  const emptySpec = resolveSdkRuntime({});
  ok(!('environment' in emptySpec) && !('endpoint' in emptySpec) && Object.keys(emptySpec.env).length === 0,
    '空 spec 与 undefined 等价');

  // WorkBuddy 实配：三项都要在，且配置根指向官方产品目录
  const def = findDef('workbuddy');
  const rt = resolveSdkRuntime(def?.sdk);
  ok(rt.environment === 'internal', 'WorkBuddy → environment=internal', String(rt.environment));
  ok(rt.endpoint === 'https://www.workbuddy.cn', 'WorkBuddy → endpoint=workbuddy.cn', String(rt.endpoint));
  ok(rt.env.CODEBUDDY_CONFIG_DIR === path.join(home, '.workbuddy'),
    '★ WorkBuddy → CODEBUDDY_CONFIG_DIR=~/.workbuddy（复用桌面端登录）',
    rt.env.CODEBUDDY_CONFIG_DIR);

  // env 的自定义项要保留，且 configDir 落到 env（不覆盖已有键以外的东西）
  const mixed = resolveSdkRuntime({ environment: 'internal', env: { FOO: 'bar' }, configDir: '~/p' });
  ok(mixed.env.FOO === 'bar', '自定义 env 项保留');
  ok(mixed.env.CODEBUDDY_CONFIG_DIR === path.join(home, 'p'), 'configDir 与自定义 env 合并');

  // 展开结果必须是新对象：调用方改写不能污染定义表（否则第二个实例会串味）
  const specEnv = { A: '1' };
  const r1 = resolveSdkRuntime({ env: specEnv });
  r1.env.A = '2';
  ok(specEnv.A === '1', '★ 返回的 env 是副本（改它不影响定义表）');
}

// ───────────────────── [2] 源码契约：四个消费方 ─────────────────────
console.log('\n[2] 源码契约：适配器与 HTTP 路由都走同一份 runtime，无硬编码 external');
{
  const sdk = codeLines(read('server/agents/adapters/sdk.ts'));
  const idx = codeLines(read('server/index.ts'));
  const factory = codeLines(read('server/agents/adapters/index.ts'));
  const defs = read('server/agents/definitions.ts');
  const dts = read('server/types/tencent-agent-sdk.d.ts');

  // 硬编码 external 必须清零（注释已排除）；拿它做「接错的静默失败」的哨兵
  const hardcoded = [...sdk, ...idx].filter(l => /environment:\s*'external'/.test(l));
  ok(hardcoded.length === 0, '★ 适配器与 index.ts 都没有写死 environment: external',
    hardcoded.length ? hardcoded.slice(0, 2).join(' | ') : '0 处');

  // 适配器三处调用都要带 runtime：probe / createEntry / runOneShotTurn
  const runtimeSpreads = sdk.filter(l => l.includes('...this.runtime')).length;
  ok(runtimeSpreads === 3, '★ 适配器三处（探测 / 池会话 / 回退 query）都注入 runtime',
    `n=${runtimeSpreads}`);
  ok(sdk.some(l => l.includes('resolveSdkRuntime(def.sdk)')),
    '适配器构造器从 def.sdk 展开运行参数');
  ok(sdk.some(l => l.includes('constructor(def: AgentDefinition)')),
    '适配器构造器收的是完整 AgentDefinition（不是只收 descriptor）');

  // 工厂必须把 def 传进去，否则 def.sdk 拿不到
  ok(factory.some(l => /new SdkAdapter\(def\)/.test(l)), '工厂传完整 def 给 SdkAdapter');
  ok(!factory.some(l => /new SdkAdapter\(def\.descriptor\)/.test(l)),
    '工厂不再只传 def.descriptor');

  // index.ts：模型清单与登录检查各一处
  const runtimeCalls = idx.filter(l => l.includes("...sdkRuntimeFor('workbuddy')")).length;
  ok(runtimeCalls === 2, '★ index.ts 两处（/api/models、/api/check-login）都用 runtime',
    `n=${runtimeCalls}`);
  ok(idx.some(l => l.includes('function sdkRuntimeFor')), 'index.ts 的 runtime 由同一辅助函数产出');

  // 定义表：三项都声明在 workbuddy 条目里
  ok(/environment:\s*'internal'/.test(defs), '定义表：workbuddy 声明 environment=internal');
  ok(/endpoint:\s*'https:\/\/www\.workbuddy\.cn'/.test(defs), '定义表：workbuddy 声明官方端点');
  ok(/configDir:\s*'~\/\.workbuddy'/.test(defs), '定义表：workbuddy 声明配置根');

  // 登录/未登录文案要改口径，不能再对 WorkBuddy 用户说「登录 CodeBuddy CLI」
  ok(!idx.some(l => l.includes('请先登录 CodeBuddy CLI')), '登录检查文案已改 WorkBuddy 口径');
  ok(idx.some(l => l.includes('请先登录 WorkBuddy')), '文案明确说「请先登录 WorkBuddy」');

  // 安装说明必须如实：2026-10-31 起 SDK 的 CLI 已随安装包分发，
  // 所以文案要写「已随应用分发」，且**不能**再要求用户另装 CLI。
  // 只切 workbuddy 这一条 —— 切宽了会把 doubao 的「不需要安装」算进来。
  const installStart = defs.indexOf('  workbuddy: {');
  const installEnd = defs.indexOf('  doubao: {', installStart);
  const installBlock = defs.slice(installStart, installEnd > 0 ? installEnd : installStart + 600);
  ok(installStart > 0 && !installBlock.includes('不需要安装'), '安装说明不再声称「不需要安装」');
  ok(installBlock.includes('已随应用分发'), '安装说明写明 CLI 已随应用分发');
  ok(!installBlock.includes('需要本机安装'), '安装说明不再要求用户另装 CLI');

  // d.ts：三个字段要显式声明，否则调用方只能靠索引签名，写错了也不报
  const createOpts = dts.slice(dts.indexOf('unstable_v2_createSession'), dts.indexOf('unstable_v2_resumeSession'));
  ok(/environment\?:/.test(createOpts) && /endpoint\?:/.test(createOpts) && /env\?:/.test(createOpts),
    'd.ts：createSession 显式声明 environment/endpoint/env');
  ok(/environment\?:/.test(dts.slice(0, dts.indexOf('unstable_v2_createSession'))),
    'd.ts：authenticate 显式声明 environment');
}

// ───────────────────── [3] 实跑（可选） ─────────────────────
if (process.env.OPC_LIVE === '1') {
  console.log('\n[3] 实跑：真连 WorkBuddy 国内版（OPC_LIVE=1）');
  const { unstable_v2_authenticate, unstable_v2_createSession } = await import('@tencent-ai/agent-sdk');
  const rt = resolveSdkRuntime(findDef('workbuddy')?.sdk);

  const timeout = (ms: number) => new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`超时 ${ms}ms`)), ms).unref?.());

  try {
    const auth = await Promise.race([
      unstable_v2_authenticate({ ...rt }),
      timeout(90000),
    ]);
    const user = (auth as { userinfo?: { userName?: string } } | undefined)?.userinfo?.userName;
    ok(Boolean(user), '实跑：复用已有登录（拿到用户名）', user || '未返回 userinfo');
  } catch (e) {
    ok(false, '实跑：登录检查', (e as Error)?.message || String(e));
  }

  try {
    const session = await Promise.race([
      unstable_v2_createSession({ ...rt, cwd: process.cwd() }),
      timeout(90000),
    ]);
    const raw = await (session as unknown as {
      getAvailableModelsRaw(): Promise<unknown[]>;
    }).getAvailableModelsRaw();
    const ids = (raw || [])
      .map(m => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((x): x is string => typeof x === 'string');
    ok(ids.length >= 10, '实跑：模型清单条数 >= 10', `n=${ids.length}`);
    // hy3-x 只在 WorkBuddy 国内版的清单里出现；拿它区分「接对了产品」
    ok(ids.includes('hy3-x'), '★ 实跑：清单含 WorkBuddy 独有模型 hy3-x', ids.slice(0, 5).join(','));
    (session as unknown as { close?: () => void }).close?.();
  } catch (e) {
    ok(false, '实跑：模型清单', (e as Error)?.message || String(e));
  }
} else {
  console.log('\n[3] 实跑层已跳过（设 OPC_LIVE=1 可开启，需本机 CodeBuddy CLI + 已登录 WorkBuddy）');
}

console.log(`\n${failures.length ? '✗' : '✓'} A155 WorkBuddy SDK 接入：${pass}/${pass + fail} 通过`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
