/**
 * Agent 路由与可用性判定验证脚本。
 *
 * 覆盖两块**不看代码就很容易搞错**的判定逻辑：
 *
 *   1. 模型路由 —— 模型名是各 Agent 私有的命名空间，跨 Agent 复用必然失败。
 *      这里逐条断言「什么样的请求值会被采用 / 被拦下 / 回退成什么」。
 *   2. 后端可达性 —— 「全部不可达」才判 unreachable。这条规则的方向搞反
 *      （改成「任一不可达」）就会把好用的 Agent 误报成不可用，必须钉死。
 *
 * 运行：npx tsx scripts/verify-agent-routing.ts
 */
import net from 'net';
import { resolveModelForAgent, PLATFORM_DEFAULT_MODEL } from '../server/model-routing.js';
import { allHostsUnreachable, checkHostReachable } from '../server/agents/probe.js';
import { findDef } from '../server/agents/definitions.js';

const failures: string[] = [];
const checks = { total: 0 };

function eq<T>(actual: T, expected: T, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// ── 1. 前置：定义表里该声明的都声明了 ───────────────────────────
{
  const oc = findDef('opencode');
  ok(!!oc?.models?.length, 'opencode 应声明模型白名单（否则无法判断请求值是否合法）');
  ok(
    !!oc?.defaultModel && oc.models!.includes(oc.defaultModel),
    'opencode 的 defaultModel 必须落在自己的白名单内',
    `defaultModel=${oc?.defaultModel}`
  );

  // 已知后端不可达的 Agent 必须声明 backendHosts，否则会假报「在线」
  ok(!!findDef('codex')?.backendHosts?.length, 'codex 应声明 backendHosts');
  ok(!!findDef('gemini')?.backendHosts?.length, 'gemini 应声明 backendHosts');
}

// ── 2. 模型路由 ─────────────────────────────────────────────────
{
  const D = PLATFORM_DEFAULT_MODEL;

  // SDK 类：平台默认模型只对它有意义
  eq(resolveModelForAgent('workbuddy', 'claude-opus-4'), 'claude-opus-4', 'SDK：应沿用显式请求值');
  eq(resolveModelForAgent('workbuddy', undefined), D, 'SDK：缺省应回落到平台默认模型');
  eq(resolveModelForAgent('workbuddy', ''), D, 'SDK：空串应视作未指定');

  // 白名单类（opencode）：只有命中白名单才采用
  const oc = findDef('opencode')!;
  eq(resolveModelForAgent('opencode', oc.defaultModel!), oc.defaultModel!, '白名单：命中的请求值应被采用');
  eq(
    resolveModelForAgent('opencode', oc.models![2]),
    oc.models![2],
    '白名单：白名单里的其它项也应被采用'
  );
  // 这是本次修复的核心：平台默认模型曾被原样注入 opencode，直接报
  // Invalid model reference 让它完全不可用
  eq(
    resolveModelForAgent('opencode', D),
    oc.defaultModel!,
    '白名单：平台默认模型应被拦下并回退到该 Agent 自己的默认模型'
  );
  eq(
    resolveModelForAgent('opencode', 'gpt-5.4'),
    oc.defaultModel!,
    '白名单：别的 Agent 的模型名也应被拦下'
  );
  eq(
    resolveModelForAgent('opencode', undefined),
    oc.defaultModel!,
    '白名单：未指定时应回退到该 Agent 自己的默认模型'
  );

  // 无白名单类（hermes ACP）：只能拦住平台默认模型
  eq(resolveModelForAgent('hermes', 'hermes-own-model'), 'hermes-own-model', 'ACP：非平台默认值应透传');
  eq(resolveModelForAgent('hermes', D), undefined, 'ACP：平台默认模型应被拦下，交给 Agent 自选');
  eq(resolveModelForAgent('hermes', undefined), undefined, 'ACP：未指定时交给 Agent 自选');
  eq(resolveModelForAgent('hermes', ''), undefined, 'ACP：空串应视作未指定');

  // 未知 Agent：不猜，原样透传（有值才有意义）
  eq(resolveModelForAgent('不存在的-agent', 'x/y'), 'x/y', '未知 Agent：有值应透传');
  eq(resolveModelForAgent('不存在的-agent', undefined), undefined, '未知 Agent：无值应为 undefined');
}

// ── 3. 后端可达性判定（自建本地服务，不依赖外网） ────────────────
async function reachabilitySuite() {
  // 探测默认会走代理（CLI 子进程也走代理）。测本地端口必须摘掉代理，
  // 否则 CONNECT 请求会被代理拒绝，测出假的「不可达」。
  const saved: Record<string, string | undefined> = {};
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }

  // 起一个只监听本地端口的服务作为「可达」样本
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  try {
    ok(await checkHostReachable(`127.0.0.1:${port}`), '可达性：本地监听端口应判为可达');
    ok(!(await checkHostReachable('127.0.0.1:1')), '可达性：无人监听的端口应判为不可达');

    eq(
      await allHostsUnreachable([`127.0.0.1:${port}`, '127.0.0.1:1']),
      null,
      '可达性：只要有一个可达就不该判为不可达（宁漏报不误报）'
    );
    eq(
      await allHostsUnreachable(['127.0.0.1:1', '127.0.0.1:2']),
      ['127.0.0.1:1', '127.0.0.1:2'],
      '可达性：全部不可达时应返回完整主机列表'
    );
    eq(await allHostsUnreachable([]), null, '可达性：空列表应直接返回 null（不适用）');
  } finally {
    server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

await reachabilitySuite();

// ── 4. 模型选择权归属（ACP 的假控件防线）──────────────────────
{
  // hermes 会在 session/new 上报 485 个模型，但实测它的 session/set_model
  // 对任意 modelId（含 `__nonsense_model__`）都返回 ok，既不校验也不生效。
  // 所以：不显式声明 modelSelection: 'client' 的 ACP Agent 一律不得把
  // 上报列表当成可切换的下拉 —— 那是个选完毫无变化、还会污染会话记录的假控件。
  for (const id of ['hermes', 'cursor', 'qoder']) {
    const def = findDef(id);
    if (!def) continue;
    eq(
      def.modelSelection ?? 'agent',
      'agent',
      `${id}：未经证实 set_model 生效前，模型选择权必须留在 Agent 侧`
    );
    ok(
      !def.models?.length,
      `${id}：不应声明 models 白名单（它并不接受客户端指定的模型）`
    );
  }
  // 真正该暴露白名单的是 CLI 类：参数是我们传的，当然能选
  ok(!!findDef('opencode')?.models?.length, 'opencode：CLI 的模型由我们传入，应暴露白名单');
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`Agent 路由断言：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 模型路由的采用/拦截/回退，以及后端可达性的「全不可达才判死」均符合预期');
