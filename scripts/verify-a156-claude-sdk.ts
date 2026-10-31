/**
 * A156：Claude Agent SDK 接入验收闸门。
 *
 * ## 这条闸门要钉住的三件事
 *
 * 1. **分派真的换了**：claude 条目 kind 是 'sdk' 且 `sdk.provider='claude'`，
 *    `createProvider` 返回 `ClaudeSdkAdapter` 而不是通用 `SdkAdapter`。
 *    只断言 kind='sdk' 是不够的 —— 改造前所有 SDK 条目都落进 SdkAdapter，
 *    这正是「标记改了、实现没换」的静默失败。
 *
 * 2. **连带假设没被带歪**：claude 不吃平台默认模型。`claude-sonnet-4` 是
 *    WorkBuddy 的命名空间，塞给 Claude 会被当成非法模型；同时 CLI 规格必须
 *    保留，A106 的双向协议断言与 A127 的能力标定都直接读 `def.cli`。
 *
 * 3. **权限不降级**：Claude 与 WorkBuddy 共用 `sdkApproval` 的四道闸门
 *    （场景白名单 → 高危门禁 → bypass → 「始终」记忆）。两家各写一份，
 *    任何一次调整漏掉一处都会让另一条通道悄悄变松。
 *
 * 运行：npm run verify:a156-claude-sdk
 * 实跑：OPC_LIVE=1 npm run verify:a156-claude-sdk（需 Anthropic 凭据）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDef } from '../server/agents/definitions.js';
import { createProvider } from '../server/agents/adapters/index.js';
import { ClaudeSdkAdapter, bundledBinary, hasCredentials } from '../server/agents/adapters/claude-sdk.js';
import { SdkAdapter } from '../server/agents/adapters/sdk.js';
import { toUnpackedPath } from '../server/agents/sdkRuntime.js';
import { resolveModelForAgent, PLATFORM_DEFAULT_MODEL } from '../server/model-routing.js';
import type { AgentEvent } from '../server/agents/types.js';

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

/** 去掉注释后的源码行（理由同 A155：注释里会提到旧写法，不能算进断言） */
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

// ───────────────────── [1] 定义 / 工厂 / 二进制 ─────────────────────
console.log('\n[1] 定义表与工厂：claude 真的走 ClaudeSdkAdapter');
{
  const def = findDef('claude');
  ok(def?.descriptor.kind === 'sdk', 'claude → kind=sdk', String(def?.descriptor.kind));
  ok(def?.sdk?.provider === 'claude', 'claude → sdk.provider=claude', String(def?.sdk?.provider));
  ok(def?.cli && typeof def.cli.buildArgs === 'function',
    '★ CLI 规格保留（A106/A127 的标定基线还在）');

  const provider = def ? createProvider(def) : undefined;
  ok(provider instanceof ClaudeSdkAdapter, '工厂返回 ClaudeSdkAdapter');
  ok(!(provider instanceof SdkAdapter), '★ 不再落回通用 SdkAdapter（Tencent SDK）');
  ok(provider?.descriptor.id === 'claude', 'descriptor 透传正确', String(provider?.descriptor.id));

  const binary = bundledBinary();
  ok(binary !== null && fs.existsSync(binary), 'SDK 自带 claude 二进制可定位',
    binary ?? '未找到（平台包未安装）');

  /* 打包态：平台包被 electron-builder 的 smartUnpack 解到 app.asar.unpacked，
     而 require.resolve/readdir 拿到的仍是 app.asar 内的路径。Electron 的 fs 垫片
     让 existsSync 对那条路径**返回 true**，spawn 却 ENOENT —— 所以「能定位」这条
     断言在打包态会假绿。这里再钉一条：解析结果不能是 asar 内部路径。
     反面证据（2026-10-31 实测 release/win-unpacked）：
       app.asar/.../claude.exe          existsSync=true  spawn=ENOENT
       app.asar.unpacked/.../claude.exe existsSync=true  spawn=0 */
  ok(binary !== null && !/app\.asar(?!\.unpacked)/.test(binary),
    '★ 解析出的二进制不在 asar 内部（否则装完 spawn ENOENT）', binary ?? '');

  // toUnpackedPath 是纯函数，用真实临时目录验两侧：解包存在时改写、不存在时原样
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a156-'));
    const unpacked = path.join(tmp, 'app.asar.unpacked');
    fs.mkdirSync(unpacked, { recursive: true });
    fs.writeFileSync(path.join(unpacked, 'tool.exe'), 'stub');
    const hit = toUnpackedPath(path.join(tmp, 'app.asar', 'tool.exe'));
    ok(hit === path.join(unpacked, 'tool.exe'), 'toUnpackedPath：解包存在时改写', hit);
    const miss = toUnpackedPath(path.join(tmp, 'app.asar', 'absent.exe'));
    ok(miss === path.join(tmp, 'app.asar', 'absent.exe'), 'toUnpackedPath：解包不存在时原样', miss);
    const plain = path.join(tmp, 'plain', 'tool.exe');
    ok(toUnpackedPath(plain) === plain, 'toUnpackedPath：无 asar 的路径不动');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  ok(typeof hasCredentials() === 'boolean', '凭据检测返回布尔值', String(hasCredentials()));

  // 模型路由：claude 的名字空间与 WorkBuddy 不同，绝不能落到平台默认模型
  ok(resolveModelForAgent('claude', undefined) === undefined,
    '★ 缺省不塞平台默认模型（交 Claude 自己决定）');
  ok(resolveModelForAgent('claude', PLATFORM_DEFAULT_MODEL) === undefined,
    '★ 历史遗留的 claude-sonnet-4 被拦掉');
  ok(resolveModelForAgent('claude', 'claude-opus-4') === 'claude-opus-4',
    '用户显式模型原样透传');
}

// ───────────────────── [2] 源码契约 ─────────────────────
console.log('\n[2] 源码契约：共享审批桥 / 事件映射复用 / 权限映射');
{
  const claude = codeLines(read('server/agents/adapters/claude-sdk.ts'));
  const sdk = codeLines(read('server/agents/adapters/sdk.ts'));
  const approval = codeLines(read('server/agents/adapters/sdkApproval.ts'));
  const factory = codeLines(read('server/agents/adapters/index.ts'));
  const routing = codeLines(read('server/model-routing.ts'));
  const registry = codeLines(read('server/agents/registry.ts'));
  const app = codeLines(read('src/App.tsx'));

  ok(approval.some(l => l.includes('export function createCanUseToolBridge')),
    'sdkApproval 导出共享审批桥');
  ok(claude.some(l => l.includes('createCanUseToolBridge(')),
    'Claude 适配器走共享审批桥');
  ok(sdk.some(l => l.includes('createCanUseToolBridge(')),
    '★ WorkBuddy 与 Claude 用同一个审批桥（没有各写一份）');

  // 事件映射必须复用 CLI 的那份：SDK 与 stream-json 是同一份块级 schema
  ok(claude.some(l => l.includes('mapClaudeCodeLine')),
    '复用 CLI 的块级映射器');
  ok(!claude.some(l => l.includes('PLATFORM_DEFAULT_MODEL')),
    '适配器里没有平台默认模型的硬编码');

  // bypass 必须显式确认，否则 SDK 拒绝启动
  ok(claude.some(l =>
    l.includes("permissionMode: 'bypassPermissions'") &&
    l.includes('allowDangerouslySkipPermissions: true')),
  '★ bypass 模式显式 allowDangerouslySkipPermissions');
  ok(claude.some(l => l.includes("permissionMode: 'plan'")), 'plan → permissionMode=plan');
  ok(claude.some(l => l.includes("permissionMode: 'acceptEdits'")), 'acceptEdits → permissionMode=acceptEdits');

  ok(factory.some(l => l.includes("case 'claude'")), '工厂有 claude 分支');
  ok(factory.some(l => l.includes('new ClaudeSdkAdapter(def)')), '★ 工厂传完整 def 给 ClaudeSdkAdapter');
  ok(factory.some(l => l.includes('sdkProvider(def)')), 'kind=sdk 统一走 provider 分派');

  // 模型路由与前端兜底都必须认「只有 Tencent SDK 吃平台模型」
  ok(routing.some(l => l.includes("(def.sdk?.provider ?? 'tencent') === 'tencent'")),
    '模型路由只对 Tencent SDK 用平台默认模型');
  ok(registry.some(l => l.includes('sdkProvider')), '名册下发 sdkProvider');
  ok(app.some(l => l.includes("currentAgent.sdkProvider ?? 'tencent'")),
    '前端只对 Tencent SDK 兜平台模型清单');
}

// ───────────────────── [3] 实跑（可选） ─────────────────────
if (process.env.OPC_LIVE === '1') {
  console.log('\n[3] 实跑：真跑一轮 Claude（OPC_LIVE=1）');
  const def = findDef('claude');
  const provider = def ? createProvider(def) : undefined;
  if (!provider) {
    ok(false, '实跑：拿不到 claude provider');
  } else {
    const status = await provider.probe();
    ok(status.installed === true, '实跑：SDK 二进制可用', status.binaryPath ?? status.message);
    if (status.availability !== 'ready') {
      console.log(`  · 无 Anthropic 凭据，跳过真实对话（${status.message}）`);
    } else {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000);
      const events: AgentEvent[] = [];
      try {
        for await (const ev of provider.send({
          sessionId: 'verify-a156',
          prompt: '只回答两个字：正常',
          cwd: process.cwd(),
          permissionMode: 'plan',
          signal: ac.signal,
        })) {
          events.push(ev);
        }
      } catch (e) {
        ok(false, '实跑：一轮对话', (e as Error)?.message || String(e));
      } finally {
        clearTimeout(timer);
      }
      ok(events.some(e => e.type === 'init'), '实跑：收到 init 事件');
      ok(events.some(e => e.type === 'done'), '实跑：正常收尾（done）');
    }
  }
} else {
  console.log('\n[3] 实跑层已跳过（设 OPC_LIVE=1 可开启，需 Anthropic 凭据）');
}

console.log(`\n${failures.length ? '✗' : '✓'} A156 Claude Agent SDK 接入：${pass}/${pass + fail} 通过`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
