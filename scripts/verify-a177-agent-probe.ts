/**
 * A177：单 Agent 探测闸门。
 *
 * 这个脚本的重点不是「接口能返回」，而是**隔离性**：
 * 点某个 Agent 的重新探测，不允许顺带探测别人、读别人的配置、写别人的时间戳。
 * 所以这里全部走真实的 registry 代码路径（`probeSingle`），
 * 只把 providers 换成会记录调用的假探测器。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { AgentProvider, AgentStatus } from '../server/agents/types.js';

/**
 * 隔离副作用：registry 的适配器链路会 import db.ts，而 db.ts 在模块加载时就
 * 打开 `data/chat.db`。验证脚本绝不能碰真实用户库，所以先把数据目录指到
 * 临时目录，再动态 import registry（静态 import 会先于本行执行）。
 */
const gateDataDir = path.join(os.tmpdir(), 'opc-a177-gate');
process.env.OPC_DATA_DIR = gateDataDir;

const { classifyProbeFailure, isValidAgentId, registry } = await import(
  '../server/agents/registry.js'
);

const R = registry as any;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const run = (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      failures.push(`${name}: ${(err as Error).message}`);
      console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
    }
  })();
  return run;
}

function readyStatus(version = '1.2.3'): AgentStatus {
  return {
    availability: 'ready',
    installed: true,
    version,
    message: `v${version}`,
    probedAt: new Date().toISOString(),
  };
}

function fakeProvider(
  id: string,
  probe: () => Promise<AgentStatus>,
  kind: 'cli' | 'sdk' | 'acp' | 'http' = 'cli'
): AgentProvider {
  return {
    descriptor: {
      id,
      name: id,
      vendor: 'Fake',
      kind,
      capabilities: ['chat'],
      surface: 'cli',
      install: { method: 'none', requires: 'none' },
    },
    probe,
    // probeSingle 不应该走到 send；真走了就说明串线了
    send: (() => {
      throw new Error('send 不应在探测链路里被调用');
    }) as any,
    dispose: async () => {},
  } as unknown as AgentProvider;
}

interface ProviderSpec {
  probe: () => Promise<AgentStatus>;
  kind?: 'cli' | 'sdk' | 'acp' | 'http';
}

function installProviders(specs: Record<string, ProviderSpec>) {
  const calls: Record<string, number> = {};
  const providers = new Map<string, AgentProvider>();
  for (const [id, spec] of Object.entries(specs)) {
    calls[id] = 0;
    providers.set(
      id,
      fakeProvider(
        id,
        async () => {
          calls[id]++;
          return spec.probe();
        },
        spec.kind
      )
    );
  }
  R.providers = providers;
  R.statuses = new Map<string, AgentStatus>();
  R.probedAt = new Map<string, number>();
  R.inflight = new Map<string, Promise<AgentStatus>>();
  R.probedOnce = false;
  return calls;
}

function seed(id: string, status: AgentStatus, probedAt: number) {
  R.statuses.set(id, status);
  R.probedAt.set(id, probedAt);
}

function snapshot(id: string): string {
  return JSON.stringify({
    status: R.statuses.get(id),
    probedAt: R.probedAt.get(id),
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function main() {
  console.log('A177 单 Agent 探测闸门\n');
  const realProbeAll = registry.probeAll.bind(registry);
  let probeAllCalls = 0;
  registry.probeAll = (async (force?: boolean) => {
    probeAllCalls++;
    return realProbeAll(force);
  }) as typeof registry.probeAll;

  let getCalls = 0;
  let listCalls = 0;
  const realGet = registry.get.bind(registry);
  const realList = registry.list.bind(registry);
  registry.get = ((id: string) => {
    getCalls++;
    return realGet(id);
  }) as typeof registry.get;
  registry.list = (() => {
    listCalls++;
    return realList();
  }) as typeof registry.list;

  console.log('1) 单 Agent 探测成功：只动目标，其余逐字段不变');

  await check('目标 Agent 探测成功，其余 Agent 的 probe 调用计数为 0', async () => {
    const calls = installProviders({
      alpha: { probe: async () => readyStatus('1.0.0') },
      beta: { probe: async () => readyStatus('2.0.0') },
      gamma: { probe: async () => readyStatus('3.0.0') },
    });
    seed('beta', readyStatus('2.0.0'), 111_111);
    seed('gamma', readyStatus('3.0.0'), 222_222);
    const betaBefore = snapshot('beta');
    const gammaBefore = snapshot('gamma');

    probeAllCalls = 0;
    getCalls = 0;
    listCalls = 0;

    const result = await registry.probeSingle('alpha', { timeoutMs: 1500 });

    assert.equal(probeAllCalls, 0, '单探测不允许调用全量探测函数');
    assert.equal(getCalls, 0, '单探测不允许走 get()/toInfo()（会顺带读同族配置）');
    assert.equal(listCalls, 0, '单探测不允许 list() 组装全量名册');
    assert.equal(calls.alpha, 1, '目标 Agent 应恰好探测一次');
    assert.equal(calls.beta, 0, 'beta 不应被探测');
    assert.equal(calls.gamma, 0, 'gamma 不应被探测');
    assert.ok(result, '应返回探测结果');
    assert.equal(result!.ok, true);
    assert.equal(result!.status.availability, 'ready');
    assert.equal(result!.status.version, '1.0.0');
    assert.equal(snapshot('beta'), betaBefore, 'beta 的状态与探测时间戳必须完全未变');
    assert.equal(snapshot('gamma'), gammaBefore, 'gamma 的状态与探测时间戳必须完全未变');
    assert.ok(R.probedAt.get('alpha') > 0, 'alpha 应写入自己的时间戳');
  });

  console.log('2) 并发去重：同一 Agent 重复点击只起一次探测，不同 Agent 不受影响');

  await check('同一 agentId 并发两次只调用一次 probe，且两个 Promise 都成功', async () => {
    const d = deferred<AgentStatus>();
    const calls = installProviders({
      alpha: { probe: () => d.promise },
      beta: { probe: async () => readyStatus() },
    });
    seed('beta', readyStatus(), 333_333);
    const betaBefore = snapshot('beta');

    const first = registry.probeSingle('alpha', { timeoutMs: 1500 });
    const second = registry.probeSingle('alpha', { timeoutMs: 1500 });
    d.resolve(readyStatus('9.0.0'));
    const [a, b] = await Promise.all([first, second]);

    assert.equal(calls.alpha, 1, '同一 Agent 的并发探测必须复用同一个进行中 Promise');
    assert.equal(calls.beta, 0);
    assert.equal(a!.status.version, '9.0.0');
    assert.equal(b!.status.version, '9.0.0');
    assert.equal(snapshot('beta'), betaBefore);
  });

  await check('不同 agentId 的并发探测互不影响', async () => {
    const dA = deferred<AgentStatus>();
    const dB = deferred<AgentStatus>();
    const calls = installProviders({
      alpha: { probe: () => dA.promise },
      beta: { probe: () => dB.promise },
    });
    const pA = registry.probeSingle('alpha', { timeoutMs: 1500 });
    const pB = registry.probeSingle('beta', { timeoutMs: 1500 });
    dA.resolve(readyStatus('a'));
    dB.resolve(readyStatus('b'));
    const [a, b] = await Promise.all([pA, pB]);
    assert.equal(calls.alpha, 1);
    assert.equal(calls.beta, 1);
    assert.equal(a!.status.version, 'a');
    assert.equal(b!.status.version, 'b');
  });

  console.log('3) 探测超时：返回 timeout，其他 Agent 完全不动');

  await check('超时返回 reason=timeout，且只写目标 Agent', async () => {
    const calls = installProviders({
      alpha: { probe: () => new Promise<AgentStatus>(() => {}) },
      beta: { probe: async () => readyStatus() },
    });
    seed('beta', readyStatus('2.0.0'), 444_444);
    const betaBefore = snapshot('beta');

    const result = await registry.probeSingle('alpha', { timeoutMs: 60 });
    assert.ok(result);
    assert.equal(result!.ok, false);
    assert.equal(result!.reason, 'timeout');
    assert.equal(result!.status.probeState, 'timeout');
    assert.match(result!.status.message ?? '', /探测超时/);
    assert.ok(result!.durationMs >= 50 && result!.durationMs < 1200, `耗时应接近预算，实际 ${result!.durationMs}ms`);
    assert.equal(calls.alpha, 1);
    assert.equal(calls.beta, 0);
    assert.equal(snapshot('beta'), betaBefore);
    // 清理被超时留下的 in-flight（底层 Promise 永不返回）
    R.inflight.delete('alpha');
  });

  console.log('4) 失败原因分类：timeout / not-found / permission / unknown');

  await check('EACCES → permission', async () => {
    installProviders({
      perm: {
        probe: async () => {
          throw new Error('EACCES: permission denied, open C:\\secret');
        },
      },
    });
    const r = await registry.probeSingle('perm', { timeoutMs: 1500 });
    assert.equal(r!.reason, 'permission');
  });

  await check('ENOENT → not-found', async () => {
    installProviders({
      missing: {
        probe: async () => {
          throw new Error('ENOENT: no such file or directory');
        },
      },
    });
    const r = await registry.probeSingle('missing', { timeoutMs: 1500 });
    assert.equal(r!.reason, 'not-found');
  });

  await check('未知异常 → unknown', async () => {
    installProviders({
      boom: {
        probe: async () => {
          throw new Error('something exploded');
        },
      },
    });
    const r = await registry.probeSingle('boom', { timeoutMs: 1500 });
    assert.equal(r!.reason, 'unknown');
  });

  await check('探测成功但 Agent 未安装 → not-found（不算探测动作失败）', async () => {
    installProviders({
      absent: {
        probe: async () => ({
          availability: 'not-installed',
          installed: false,
          message: 'CLI 未安装',
          probedAt: new Date().toISOString(),
        }),
      },
    });
    const r = await registry.probeSingle('absent', { timeoutMs: 1500 });
    assert.equal(r!.reason, 'not-found');
    assert.equal(r!.ok, true, 'not-installed 是探测完成的结果，不是超时/崩溃');
  });

  await check('classifyProbeFailure 对 timeout 的识别优先于 availability', () => {
    assert.equal(
      classifyProbeFailure({
        availability: 'needs-auth',
        installed: true,
        message: 'Request timeout: initialize',
        probeState: 'timeout',
        probedAt: new Date().toISOString(),
      }),
      'timeout'
    );
  });

  console.log('5) 全量探测仍然可用（证明拆分没有破坏全量路径）');

  await check('显式 probeAll(true) 覆盖所有 Agent，每个恰好一次', async () => {
    const calls = installProviders({
      alpha: { probe: async () => readyStatus('1') },
      beta: { probe: async () => readyStatus('2') },
      gamma: { probe: async () => readyStatus('3') },
    });
    const infos = await registry.probeAll(true);
    assert.equal(infos.length, 3);
    assert.equal(calls.alpha, 1);
    assert.equal(calls.beta, 1);
    assert.equal(calls.gamma, 1);
    assert.ok(infos.every(i => i.status.availability === 'ready'));
  });

  console.log('6) agentId 校验：路径穿越与非法字符一律拒绝');

  await check('合法 id 通过', () => {
    for (const id of ['workbuddy', 'custom-abc123', 'a1', 'x']) {
      assert.equal(isValidAgentId(id), true, `${id} 应通过`);
    }
  });

  await check('路径穿越/斜杠/盘符/编码/大写/超长一律拒绝', () => {
    const bad = [
      '',
      '..',
      '../etc/passwd',
      '..\\..\\windows\\win.ini',
      'a/b',
      'a\\b',
      'C:/tmp/x',
      '%2e%2e%2f',
      'WORKBUDDY',
      '-abc',
      'abc def',
      'abc..def',
      'a'.repeat(65),
    ];
    for (const id of bad) {
      assert.equal(isValidAgentId(id), false, `${JSON.stringify(id)} 应被拒绝`);
    }
  });

  await check('非法/不存在的 id 不会触发任何探测', async () => {
    const calls = installProviders({
      alpha: { probe: async () => readyStatus() },
    });
    const r = await registry.probeSingle('../alpha', { timeoutMs: 1000 });
    assert.equal(r, undefined);
    assert.equal(calls.alpha, 0);
  });

  console.log(`\nA177 结果：通过 ${passed}，失败 ${failed}`);
  if (failed > 0) {
    console.log('失败项：');
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
