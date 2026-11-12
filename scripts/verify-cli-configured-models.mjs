/**
 * 闸门：CLI 配置模型自动发现（server/agents/cliConfiguredModels.ts）。
 *
 * 覆盖：
 *  - 纯函数：临时 home 造四类配置，断言能发现模型名、白名单清洗、去重、
 *    稳定排序、坏 JSON / 缺文件静默降级、.jsonc 注释容忍；
 *  - 凭据隔离：返回值里绝不含 API Key 的值（否定式），配「确实读到了模型」
 *    的肯定式兜底（防止整条链坏掉时否定断言恒绿）；
 *  - 归属：claude 配置只归 claude、env 模型归多个 cli Agent、
 *    configuredModelIdsFor / isConfiguredModelForAgent 行为；
 *  - 前端源码契约：App 读平级字段 data.configured、ModelSelectPopup 的
 *    data-configured-group / data-configured-selectable="1"；
 *  - 反向断言：server/index.ts 里 agent-config 档 selectable: false 仍在
 *    （证明没放开只读档），ChatInput 里 readonly 字面量未改；
 *  - 反向探针 `--probe leak-key`：故意把「不读 apiKey 值」判据对应的样本
 *    污染，确认那条断言会变红（证明它不是恒真的摆设），退出码仍为 0。
 *
 * 运行：
 *   node scripts/verify-cli-configured-models.mjs
 *   node scripts/verify-cli-configured-models.mjs --probe leak-key
 *
 * 脚本会用 node --import tsx 自我拉起一次，以便动态 import 服务端 .ts 模块；
 * 因此两种调用方式都不必手动带 loader。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SELF = fileURLToPath(import.meta.url);
const ARGS = process.argv.slice(2);
const PROBE = ARGS.includes('leak-key') || ARGS.includes('--probe=leak-key');
const KEY = 'sk-SECRET-LEAK-999';

// ── 自我拉起：动态 import .ts 需要 tsx loader ─────────────────────────────
// 父进程只负责用 --import tsx 重跑自己并透传退出码；所有断言都在子进程里做。
if (!process.env.__CLI_CFG_TSX_CHILD) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF, ...ARGS], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, __CLI_CFG_TSX_CHILD: '1' },
  });
  process.exit(r.status == null ? 1 : r.status);
}

// 走到这里，必定带着 --import tsx；可以安全 import 服务端 TS 模块了。
const mod = await import('../server/agents/cliConfiguredModels.ts');
const {
  listCliConfiguredModels,
  configuredModelIdsFor,
  isConfiguredModelForAgent,
  CLI_CONFIG_AGENT_MAP,
  CLI_CONFIG_MODEL_ENV_KEYS,
} = mod;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}

// ── 夹具 ─────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-models-'));
const HOME = path.join(TMP, 'home');
const BAD_HOME = path.join(TMP, 'badhome');
const EMPTY_HOME = path.join(TMP, 'emptyhome');
function w(rel, content) {
  const f = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content, 'utf8');
}
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

const LONG = 'x'.repeat(250);
w('.claude/settings.json', JSON.stringify({
  model: 'claude-opus-4-5',
  env: {
    ANTHROPIC_API_KEY: KEY,                       // 值绝不许出现在返回值里
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',             // 空串 → 丢
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'has space',  // 含空白 → 丢
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku',
    ANTHROPIC_SMALL_FAST_MODEL: LONG,             // >200 → 丢
  },
}, null, 2));
w('.codex/config.toml', [
  'model = "gpt-5.1-codex-max"',
  'model_provider = "custom-gw"',              // provider 选择器，不是模型名
  '',
  '[model_providers.custom-gw.models.gpt-5.1-mini]',
  'name = "mini"',                              // 配置键，不是模型名
  '',
].join('\n'));
w('.config/opencode/opencode.json', JSON.stringify({
  model: 'anthropic/claude-sonnet-4-5',
  provider: { mygw: { models: { 'gpt-4o': {}, 'deepseek-chat': {} } } },
}, null, 2));
w('.config/opencode/opencode.jsonc', [
  '{',
  ' // line comment',
  ' "model": "zen/jsonc-model",',
  ' "provider": { "zen": { /* block */ "models": { "jsonc-only-model": {} } } }',
  '}',
].join('\n'));

fs.mkdirSync(path.join(BAD_HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(BAD_HOME, '.claude', 'settings.json'), '{ this is not json', 'utf8');
fs.mkdirSync(EMPTY_HOME, { recursive: true });

const env = {
  OPENAI_MODEL: 'dedup-env-model',
  OPENROUTER_MODEL: 'dedup-env-model',     // 与上行重复 → 去重
  OLLAMA_MODEL: 'llama3.2:latest',
  ANTHROPIC_MODEL: 'env-anthropic-model',
  AZURE_OPENAI_DEPLOYMENT: 'azure-dep',
  OPENAI_BASE_URL: 'https://internal-gw.example/v1',  // 端点提示，不造模型、不返回值
};
const opts = { env, home: HOME };

const list = listCliConfiguredModels(opts);
const ids = list.map(m => m.id);
const serialized = JSON.stringify(list);
const find = id => list.find(m => m.id === id);

// ── [probe] 反向探针：确认「不读 apiKey 值」判据不是恒真的摆设 ──────────
// 不对产品代码动手：脚本内部对同一份含 key 的样本做「干净解析」与
// 「故意污染的解析」两种结果，用同一条判据比对，看污染样本是否变红。
if (PROBE) {
  console.log('\n──── [probe leak-key] 反向探针：判据自检 ────');
  const noLeak = x => !JSON.stringify(x).includes(KEY);   // 产品用的那条否定判据
  // 故意污染：模拟一个错误实现，把 apiKey 的值当模型塞进了返回值
  const tampered = [
    ...list,
    { id: KEY, label: KEY, source: `env:ANTHROPIC_API_KEY=${KEY}`, agentIds: ['claude'] },
  ];
  const cleanVerdict = noLeak(list);
  const tamperedVerdict = noLeak(tampered);
  console.log(`  干净样本   → 判据 ${cleanVerdict ? 'GREEN(放行)' : 'RED(拒绝)'}`);
  console.log(`  被污染样本 → 判据 ${tamperedVerdict ? 'GREEN(放行)' : 'RED(拒绝)'}`);
  const valid = cleanVerdict === true && tamperedVerdict === false;
  console.log(
    valid
      ? '  ✓ 判据有效：干净样本放行、污染样本变红 —— 「不读 apiKey 值」能真正抓到泄露'
      : '  ✗ 判据失效：无法区分干净/污染样本，断言抓不到泄露'
  );
  // 「对应断言变红」是探针的预期结果，不是测试失败：判据有效时退出码仍为 0。
  console.log('\n=== 探针机制自检：' + (valid ? '通过' : '失败') + ' ===');
  cleanup();
  process.exit(valid ? 0 : 1);
}

// ── [1] 纯函数：确实发现了四类来源的模型名 ──────────────────────────────
console.log('\n[1] 纯函数：四类来源的模型名发现');
ok(Array.isArray(list), '[1] 返回数组');
ok(list.length > 0, '[1] 确实读到了模型（肯定式兜底）', `共 ${list.length} 条`);
for (const id of [
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku',           // Claude
  'gpt-5.1-codex-max', 'gpt-5.1-mini',                              // Codex
  'anthropic/claude-sonnet-4-5', 'gpt-4o', 'deepseek-chat',          // OpenCode json
  'zen/jsonc-model', 'jsonc-only-model',                             // OpenCode jsonc
  'dedup-env-model', 'llama3.2:latest', 'env-anthropic-model', 'azure-dep', // env
]) {
  ok(ids.includes(id), `[1] 发现模型 ${id}`);
}

// ── [2] 模型名清洗 / 去重 / 排序 ─────────────────────────────────────────
console.log('\n[2] 清洗 / 去重 / 稳定排序');
ok(!ids.includes(''), '[2] 空串被丢弃');
ok(!ids.includes('has space'), '[2] 含空白的值被丢弃');
ok(!ids.some(x => x.length > 200), '[2] 超长 >200 的值被丢弃');
ok(!ids.includes('custom-gw'), '[2] model_provider 选择器不被当成模型');
ok(!ids.includes('mini'), '[2] provider 段的 name 配置键不被当成模型');
ok(ids.filter(x => x === 'dedup-env-model').length === 1, '[2] 同 id 去重（OPENAI_MODEL + OPENROUTER_MODEL 只留一条）');
const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
eq(ids, sorted, '[2] 结果按 id 稳定排序');
ok(find('dedup-env-model')?.source.startsWith('env:'), '[2] 去重后 source 取先命中的来源', find('dedup-env-model')?.source);

// ── [3] 凭据隔离：返回值里绝不含 API Key 的值 ────────────────────────────
console.log('\n[3] 凭据隔离');
ok(!serialized.includes(KEY), '[3] 返回值里不含 API Key 的值（否定式）');
ok(!serialized.includes('https://internal-gw.example/v1'), '[3] 返回值里不含 BASE_URL 的值');
ok(ids.includes('claude-opus-4-5') && ids.includes('gpt-5.1-codex-max'), '[3] 肯定式：确实读到了模型（否定断言非恒绿）');
ok(find('claude-opus-4-5')?.source.includes('配了自定义网关'), '[3] 只看 API_KEY 键存在性，给来源提示但不取值');
ok(find('gpt-5.1-codex-max')?.source.includes('配了自定义 provider'), '[3] 只看 model_provider 键存在性');
ok(find('dedup-env-model')?.source.includes('已配置自定义端点'), '[3] 只看 BASE_URL 键存在性');

// ── [4] 坏文件 / 缺文件：静默降级，绝不抛 ────────────────────────────────
console.log('\n[4] 坏文件 / 缺文件静默降级');
let badResult, badThrew = false;
try { badResult = listCliConfiguredModels({ env: {}, home: BAD_HOME }); } catch { badThrew = true; }
ok(!badThrew, '[4] 坏 JSON 不抛异常');
ok(Array.isArray(badResult) && badResult.length === 0, '[4] 坏 JSON 返回空数组');
let emptyResult, emptyThrew = false;
try { emptyResult = listCliConfiguredModels({ env: {}, home: EMPTY_HOME }); } catch { emptyThrew = true; }
ok(!emptyThrew && Array.isArray(emptyResult) && emptyResult.length === 0, '[4] 配置文件全不存在返回空数组');

// ── [5] 归属 + 导出的两个查询函数 ────────────────────────────────────────
console.log('\n[5] 归属与查询函数');
eq(find('claude-opus-4-5')?.agentIds, ['claude'], '[5] Claude 配置只归 claude');
eq(find('gpt-5.1-codex-max')?.agentIds, ['codex'], '[5] Codex 配置只归 codex');
const envAgents = find('dedup-env-model')?.agentIds ?? [];
ok(envAgents.length > 1 && ['claude', 'codex', 'gemini', 'opencode'].every(a => envAgents.includes(a)), '[5] env 模型归多个 cli Agent', envAgents.join(','));
ok(Array.isArray(CLI_CONFIG_MODEL_ENV_KEYS) && CLI_CONFIG_MODEL_ENV_KEYS.includes('OPENAI_MODEL'), '[5] 导出 CLI_CONFIG_MODEL_ENV_KEYS 供闸门断言');
ok(CLI_CONFIG_AGENT_MAP && Array.isArray(CLI_CONFIG_AGENT_MAP.env) && CLI_CONFIG_AGENT_MAP.env.length > 0, '[5] 导出 CLI_CONFIG_AGENT_MAP');
const forClaude = configuredModelIdsFor('claude', opts);
ok(forClaude.includes('claude-opus-4-5'), '[5] configuredModelIdsFor(claude) 含 Claude 模型');
ok(!forClaude.includes('gpt-5.1-codex-max'), '[5] configuredModelIdsFor(claude) 不含 Codex 专属模型');
ok(isConfiguredModelForAgent('codex', 'gpt-5.1-codex-max', opts) === true, '[5] isConfiguredModelForAgent 命中返回 true');
ok(isConfiguredModelForAgent('codex', 'claude-opus-4-5', opts) === false, '[5] isConfiguredModelForAgent 跨 Agent 返回 false');
ok(isConfiguredModelForAgent('', 'anything', opts) === false, '[5] 空 agentId 返回 false');
ok(isConfiguredModelForAgent('claude', 'has space', opts) === false, '[5] 不像模型名的 modelId 返回 false');

// ── [6] 前端源码契约 ─────────────────────────────────────────────────────
console.log('\n[6] 前端源码契约');
const rd = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const app = rd('src/App.tsx');
const popup = rd('src/components/ModelSelectPopup.tsx');
const chatInput = rd('src/components/ChatInput.tsx');
const chatPage = rd('src/pages/ChatPage.tsx');
const types = rd('src/types.ts');
const serverIndex = rd('server/index.ts');

ok(/Array\.isArray\(data\.configured\)/.test(app), '[6] App 读取平级字段 data.configured 并 Array.isArray 校验');
ok(/agentIds\.includes\(currentAgentId\)/.test(app), '[6] App 按当前 Agent 过滤 configured');
ok((app.match(/setConfiguredModels\(\[\]\)/g) || []).length >= 3, '[6] App 切 Agent / 无 Agent / catch 三处都清空');
ok(app.includes('configuredModels={configuredModels}'), '[6] App 把 configuredModels 作为新 prop 下传');
ok(popup.includes('data-configured-group'), '[6] ModelSelectPopup 有 data-configured-group 独立分组');
ok(popup.includes('data-configured-selectable="1"'), '[6] ModelSelectPopup 有可点行标记 data-configured-selectable="1"');
ok(popup.includes('data-configured-model') && popup.includes('data-model-id={m.id}'), '[6] 每行标记 data-configured-model / data-model-id');
ok(/onClick=\{\(\) => onChange\(m\.id\)\}/.test(popup), '[6] 点击调 onChange(id)');
ok(popup.includes('!readonly && configuredModels.length > 0'), '[6] readonly / 空分组时不渲染可点分组');
ok(popup.includes('未验证'), '[6] 行标「未验证」');
ok(chatInput.includes('configuredModels={configuredModels}'), '[6] ChatInput 转发 configuredModels 给浮层');
ok(chatInput.includes('readonly={!canPickModel && !manualModel}'), '[6] ChatInput 既有 readonly 字面量未改（反向断言）');
ok(chatPage.includes('configuredModels={configuredModels}'), '[6] ChatPage 转发，prop 链闭合');
ok(/export interface CliConfiguredModel \{/.test(types), '[6] types.ts 追加了 CliConfiguredModel');
const obIdx = chatInput.indexOf('onChange={v => {');
const obSlice = obIdx >= 0 ? chatInput.slice(obIdx, obIdx + 220) : '';
ok(obSlice.includes('setOpenSelect(null)') && obSlice.includes('onModelChange(v)'), '[6] 选中后 onChange 回调 onModelChange 并关闭浮层');

// ── [7] 反向断言：没动只读档 ─────────────────────────────────────────────
console.log('\n[7] 反向断言：agent-config 只读档仍在');
ok(serverIndex.includes('selectable: false'), '[7] server/index.ts 里 selectable: false 仍在（没放开只读档）');

cleanup();
console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
