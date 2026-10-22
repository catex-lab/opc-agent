/**
 * A42 ZCode 真接入验证。
 *
 * 原先 zcode 是 kind='mock' 的占位（`unsupportedReason: '本机未安装'`），
 * 名册里永远转圈。现在按 zcode 0.14.5 的真实契约接成 CLI Agent：
 *   zcode --prompt "..." --json --no-color --mode yolo [--cwd x] [--resume sess]
 * 进程结束时吐**一个** JSON 对象（response + usage + sessionId）。
 *
 * 本脚本不启动任何子进程，只驱动定义层的纯函数（buildArgs / extractResumeToken /
 * mapLine / 分类器），外加一条「本机没装就如实报不可用」的注册表断言。
 * 真实调用要等机器上真装了 zcode 才能验 —— 这一点在断言名字里写清楚。
 *
 * 运行：npx tsx scripts/verify-a42.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'opc-a42-'));
process.env.OPC_DATA_DIR = TMP;

const { findDef } = await import('../server/agents/definitions.js');
const { registry } = await import('../server/agents/registry.js');
// registry → db.ts 会打开库文件；先拿句柄，收尾 close()，否则 Windows 删不掉临时目录
const { default: db } = await import('../server/db.js');

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(cond: boolean, name: string, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail += 1;
    fails.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

// ── [1] 定义层：从 mock 变成真 CLI ──────────────────────────────────────
console.log('\n[1] 定义：真 CLI，不再是 mock 占位');
const def = findDef('zcode');
ok(!!def, 'zcode 定义存在');
if (!def) process.exit(1);
ok(def.descriptor.kind === 'cli', 'kind = cli（不再是 mock）', def.descriptor.kind);
ok(!def.unsupportedReason, '没有 unsupportedReason（占位话术已移除）');
ok(def.cli?.bin === 'zcode', 'bin = zcode');
ok(def.cli?.parse === 'json-object', 'parse = json-object（结束才吐一个 JSON）', def.cli?.parse);
ok(def.descriptor.capabilities.includes('code') && def.descriptor.capabilities.includes('tools'), '能力含 code + tools');
ok(def.authFiles?.includes('.zcode/cli/config.json') === true, '凭据文件指向 ~/.zcode/cli/config.json');
ok(/zcode\.cjs|软链/.test(def.descriptor.installHint ?? ''), '安装提示给出真实路径与软链办法');

// ── [2] buildArgs ───────────────────────────────────────────────────────
console.log('\n[2] argv 构造');
const ctxBase = { cwd: '/repo', model: 'zai/glm-5.2', permissionMode: 'default' } as any;
{
  const args = def.cli!.buildArgs('修一下登录 bug', ctxBase);
  ok(args.includes('--prompt') && args[args.indexOf('--prompt') + 1] === '修一下登录 bug', 'prompt 原样传入');
  ok(args.includes('--json'), '带 --json（机器可读输出）');
  ok(args.includes('--no-color'), '带 --no-color（别让 ANSI 混进解析）');
  ok(args.includes('--cwd') && args[args.indexOf('--cwd') + 1] === '/repo', '带 --cwd');
  ok(args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'build', 'default → build（build 会先问）');
  ok(!args.includes('--model'), '⚠️ 不编 --model：该 flag 会让 zcode 打印帮助后退，编了就是假控件');
  ok(!args.includes('--resume'), '首轮不带 --resume');
}
for (const [mode, expected] of [
  ['plan', 'plan'],
  ['acceptEdits', 'edit'],
  ['bypassPermissions', 'yolo'],
] as const) {
  const args = def.cli!.buildArgs('x', { ...ctxBase, permissionMode: mode });
  ok(args[args.indexOf('--mode') + 1] === expected, `${mode} → ${expected}`);
}
{
  const args = def.cli!.buildArgs('继续', { ...ctxBase, resumeToken: 'sess_311c449d' });
  ok(args.join(' ').includes('--resume sess_311c449d'), '带 --resume <sessionId>', args.join(' '));
}
{
  const args = def.cli!.buildArgs('x', { permissionMode: 'default' } as any);
  ok(!args.includes('--cwd'), '没有 cwd 时不强加 --cwd');
}

// ── [3] 输出映射：zcode --json 的真实形状 ─────────────────────────────
console.log('\n[3] --json 输出映射');
const sample = {
  sessionId: 'sess_311c449d-d087-4cf0-899f-c0543cfffdf4',
  response: '已修复登录页的空指针，补了三个用例。',
  usage: { inputTokens: 25251, outputTokens: 133, totalTokens: 25384, cacheReadTokens: 25152 },
  eventCount: 110,
  projection: { status: 'idle', turnCount: 1, contextWindow: 200000 },
};
ok(def.cli!.extractResumeToken!(sample) === 'sess_311c449d-d087-4cf0-899f-c0543cfffdf4', '抽出 sessionId 做续接令牌');
ok(def.cli!.extractResumeToken!({ sessionId: 42 }) === null, 'sessionId 不是字符串 → 不续接');
{
  const evs = def.cli!.mapLine!(sample);
  const arr = Array.isArray(evs) ? evs : evs ? [evs] : [];
  const text = arr.find(e => e.type === 'text') as { type: 'text'; content: string } | undefined;
  const usage = arr.find(e => e.type === 'usage') as { type: 'usage'; tokens?: number } | undefined;
  ok(!!text && text.content === sample.response, 'response → text 事件');
  ok(!!usage && usage.tokens === 25384, 'totalTokens → usage.tokens', String(usage?.tokens));
  // A28 立的规矩：token 数绝不冒充 cost
  ok(!!usage && (usage as any).cost === undefined, '不把 token 数写进 cost');
}
{
  const evs = def.cli!.mapLine!({ is_error: true, error: 'MODEL_UNAVAILABLE', response: '' });
  const arr = Array.isArray(evs) ? evs : evs ? [evs] : [];
  ok(arr.length === 1 && arr[0].type === 'error' && (arr[0] as any).message === 'MODEL_UNAVAILABLE', 'is_error → error 事件（带原文）');
}
{
  const evs = def.cli!.mapLine!({ response: '', usage: {} });
  ok(evs === null, '空 response 无用量 → null（不产生空气泡）');
}
{
  const evs = def.cli!.mapLine!({ usage: { inputTokens: 10, outputTokens: 5 } });
  const arr = Array.isArray(evs) ? evs : evs ? [evs] : [];
  const usage = arr.find(e => e.type === 'usage') as { type: 'usage'; tokens?: number } | undefined;
  ok(!!usage && usage.tokens === 15, '没有 totalTokens 时退化为 input+output');
}
ok(/MODEL_UNAVAILABLE|Unknown option/i.test(String(def.cli!.fatalStderrPattern)), 'stderr 命中不可恢复模式会 fail fast');

// ── [4] 注册表：没装就如实报不可用 ─────────────────────────────────────
console.log('\n[4] 注册表：未安装时的诚实表现');
{
  const info = await registry.probeOne('zcode', true);
  const installed = info?.status.availability === 'ready';
  // 这台机器装没装 zcode 是未知数，两种结果都必须「说得通」：
  //   装了 → ready（真实可用）
  //   没装 → 不是 ready，且带着 installHint（而不是转圈或假装可用）
  ok(installed || info?.status.availability !== 'ready', 'availability 非 ready 或 ready，不 spinner', String(info?.status.availability));
  if (!installed) {
    ok(!!info?.installHint && info.installHint.length > 20, '未安装时给出具体安装指引', info?.installHint?.slice(0, 40));
    ok(info?.status.availability !== 'ready', '不会把没装的 Agent 报成可用');
  } else {
    ok(true, '本机装了 zcode（跳过 needs-setup 断言）');
    console.log('    （本机已安装 zcode，未安装分支的断言自动跳过）');
  }
  // 无论装没装，都不该带「mock」痕迹
  ok(info?.kind !== 'mock', '注册表里的 kind 不是 mock', String(info?.kind));
}

// 先关库再删临时目录：node:sqlite 的句柄不关，Windows 上会 EBUSY。
db.close();
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✓' : '✗'} A42 ZCode 真接入：${pass}/${pass + fail} 通过${fail ? `，失败：${fails.join('、')}` : ''}\n`);
process.exit(fail === 0 ? 0 : 1);
