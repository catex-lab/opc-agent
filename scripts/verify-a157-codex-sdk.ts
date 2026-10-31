/**
 * A157：Codex SDK 接入验收闸门。
 *
 * ## 与 A156 的差别：这条通道没有「逐次审批」可接
 *
 * `ThreadOptions` 里没有 `canUseTool` 这类回调，只有 `sandboxMode` /
 * `approvalPolicy`。所以这里的验收重点是：
 *
 * 1. **分派换了**：codex 条目 kind='sdk' 且 `sdk.provider='codex'`，
 *    `createProvider` 返回 `CodexSdkAdapter` 而不是通用 `SdkAdapter`；
 * 2. **不假装支持交互审批**：源码里不应出现 `canUseTool`，`approvalPolicy`
 *    固定 `never`（headless 进程没人能应答，用 on-request 只会挂死一轮对话）；
 * 3. **权限真的落到沙箱**：`codexSandboxFor` 的映射与 CLI 通道同一矩阵，
 *    且续接会话不重复传 sandboxMode（`exec resume` 没有这个选项）；
 * 4. **事件映射复用**：SDK 的 item.* 与 CLI `--json` 是同一份 schema，
 *    必须用带状态的 `createCodexLineageMapper` 算增量文本。
 *
 * 运行：npm run verify:a157-codex-sdk
 * 实跑：OPC_LIVE=1 npm run verify:a157-codex-sdk（需 codex login / OPENAI_API_KEY）
 */
import fs from 'node:fs';
import path from 'node:path';
import { findDef } from '../server/agents/definitions.js';
import { createProvider } from '../server/agents/adapters/index.js';
import { CodexSdkAdapter, bundledBinary } from '../server/agents/adapters/codex-sdk.js';
import { SdkAdapter } from '../server/agents/adapters/sdk.js';
import { codexSandboxFor } from '../server/agents/permissions.js';
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

/** 去掉注释后的源码行（理由同 A155） */
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

// ───────────────────── [1] 定义 / 工厂 / 沙箱映射 ─────────────────────
console.log('\n[1] 定义表与工厂：codex 真的走 CodexSdkAdapter');
{
  const def = findDef('codex');
  ok(def?.descriptor.kind === 'sdk', 'codex → kind=sdk', String(def?.descriptor.kind));
  ok(def?.sdk?.provider === 'codex', 'codex → sdk.provider=codex', String(def?.sdk?.provider));
  ok(def?.cli && typeof def.cli.buildArgs === 'function',
    '★ CLI 规格保留（codex debug models 的模型目录仍按它枚举）');

  const provider = def ? createProvider(def) : undefined;
  ok(provider instanceof CodexSdkAdapter, '工厂返回 CodexSdkAdapter');
  ok(!(provider instanceof SdkAdapter), '★ 不再落回通用 SdkAdapter（Tencent SDK）');

  const binary = bundledBinary();
  ok(binary !== null && fs.existsSync(binary), 'SDK 自带 codex 二进制可定位',
    binary ?? '未找到（平台包未安装）');
  /* 与 A156 同一条纪律：asar 内部路径 existsSync 为真、spawn 却 ENOENT，
     只判「能定位」在打包态会假绿。这里钉住「不是 asar 内部路径」。 */
  ok(binary !== null && !/app\.asar(?!\.unpacked)/.test(binary),
    '★ 解析出的二进制不在 asar 内部（否则装完 spawn ENOENT）', binary ?? '');

  // 权限模式 → 沙箱强度：与 CLI 通道的矩阵必须一致
  ok(codexSandboxFor('plan') === 'read-only', 'plan → read-only');
  ok(codexSandboxFor('acceptEdits') === 'workspace-write', 'acceptEdits → workspace-write');
  ok(codexSandboxFor('bypassPermissions') === 'danger-full-access', 'bypass → danger-full-access');
  ok(codexSandboxFor('default') === null, 'default → 不传 sandboxMode（沿用 codex 配置）');
  ok(codexSandboxFor(undefined) === null, 'undefined → 不传 sandboxMode');

  // 模型名空间与 WorkBuddy 不同
  ok(resolveModelForAgent('codex', undefined) === undefined,
    '★ 缺省不塞平台默认模型（交 codex 自己决定）');
  ok(resolveModelForAgent('codex', PLATFORM_DEFAULT_MODEL) === undefined,
    '★ 历史遗留的 claude-sonnet-4 被拦掉');
  ok(resolveModelForAgent('codex', 'gpt-5.4') === 'gpt-5.4', '用户显式模型原样透传');
}

// ───────────────────── [2] 源码契约 ─────────────────────
console.log('\n[2] 源码契约：无假审批 / 续接不传沙箱 / 映射复用');
{
  const codex = codeLines(read('server/agents/adapters/codex-sdk.ts'));
  const factory = codeLines(read('server/agents/adapters/index.ts'));
  const routing = codeLines(read('server/model-routing.ts'));

  // 不假装支持逐次审批：没有 canUseTool 这东西
  ok(!codex.some(l => l.includes('canUseTool')),
    '★ 不出现 canUseTool（Codex SDK 没有这个回调）');
  ok(codex.some(l => l.includes("approvalPolicy: 'never'")),
    '★ approvalPolicy 固定 never（headless 无人应答）');
  ok(codex.some(l => l.includes('skipGitRepoCheck: true')), '跳过 git 仓库检查');

  // 续接时不能传 sandboxMode：exec resume 选项表里没有它
  ok(codex.some(l => l.includes('!ctx.resumeToken') && l.includes('codexSandboxFor(ctx.permissionMode)')),
    '★ 仅新建会话传 sandboxMode，续接沿用原配置');

  ok(codex.some(l => l.includes('createCodexLineageMapper(')),
    '复用带状态的增量映射器');
  ok(codex.some(l => l.includes('new Codex(')), '用官方 SDK 构造');
  ok(codex.some(l => l.includes('runStreamed(')), '用 runStreamed 拿事件流');

  ok(factory.some(l => l.includes("case 'codex'")), '工厂有 codex 分支');
  ok(factory.some(l => l.includes('new CodexSdkAdapter(def)')), '★ 工厂传完整 def 给 CodexSdkAdapter');

  ok(routing.some(l => l.includes("(def.sdk?.provider ?? 'tencent') === 'tencent'")),
    '模型路由只对 Tencent SDK 用平台默认模型');
}

// ───────────────────── [3] 实跑（可选） ─────────────────────
if (process.env.OPC_LIVE === '1') {
  console.log('\n[3] 实跑：真跑一轮 Codex（OPC_LIVE=1）');
  const def = findDef('codex');
  const provider = def ? createProvider(def) : undefined;
  if (!provider) {
    ok(false, '实跑：拿不到 codex provider');
  } else {
    const status = await provider.probe();
    ok(status.installed === true, '实跑：SDK 二进制可用', status.binaryPath ?? status.message);
    if (status.availability !== 'ready') {
      console.log(`  · 未登录 OpenAI，跳过真实对话（${status.message}）`);
    } else {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000);
      const events: AgentEvent[] = [];
      try {
        for await (const ev of provider.send({
          sessionId: 'verify-a157',
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
  console.log('\n[3] 实跑层已跳过（设 OPC_LIVE=1 可开启，需 codex login）');
}

console.log(`\n${failures.length ? '✗' : '✓'} A157 Codex SDK 接入：${pass}/${pass + fail} 通过`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
