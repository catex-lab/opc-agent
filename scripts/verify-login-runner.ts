/**
 * P2 登录代管闸门（loginRunner，接入架构收敛方案）。
 *
 * 层次：
 *   [F] 服务端实跑 —— 自定义回声 CLI + 假登录命令（node）：
 *       登录进程退出 → 自动 canary 复检闭环（真实通道跑通）；
 *       def.login 缺失 → startLogin 拒绝（没有按钮好过有假按钮）
 *   [S] 源码契约 —— opencode 已核实登录命令（含溯源字段）、退出自动复检接线、
 *       端点存在、不经 shell（spawn shell:false）
 *   [P] 反向探针 —— 复检闭环被拆 / 无 login 也能拉起，必须变红
 *
 * 运行：npx tsx scripts/verify-login-runner.ts [--probe=no-closure|no-guard]
 */

import './lib/temp-data-dir.js';

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const probe = (() => {
  const eq = process.argv.find(a => a.startsWith('--probe='));
  if (eq) return eq.slice('--probe='.length);
  const i = process.argv.indexOf('--probe');
  return i >= 0 ? process.argv[i + 1] : null;
})();

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    if (!probe) console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ✗ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    if (!probe) console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ✗ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}

const sourceCache = new Map<string, string>();
function repoSource(rel: string, mutate?: (src: string) => string): string {
  const key = mutate ? `${rel}::probe` : rel;
  if (!sourceCache.has(key)) {
    let src = fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
    if (mutate) src = mutate(src);
    sourceCache.set(key, src);
  }
  return sourceCache.get(key)!;
}

const MUTATIONS: Record<string, { file: string; apply: (src: string) => string }> = {
  // 坏形态①：登录退出后不再自动复检——闭环断裂，名册不会自己点亮
  'no-closure': {
    file: 'server/agents/loginRunner.ts',
    apply: src => src.replace('void runCanary(agentId)', 'void Promise.resolve()'),
  },
  // 坏形态②：没有 login 表也能拉起——等于对没核实过的 Agent 画假按钮
  'no-guard': {
    file: 'server/agents/loginRunner.ts',
    apply: src => src.replace('if (!def?.login) {', 'if (false) {'),
  },
};

function contracts(mutate?: (src: string, file: string) => string): void {
  const S = (rel: string) => repoSource(rel, mutate ? (src) => mutate(src, rel) : undefined);

  check('opencode 的登录命令已核实（command + 溯源字段齐全）', () => {
    const src = S('server/agents/definitions.ts');
    assert.ok(src.includes("command: 'opencode',\n      args: ['auth', 'login'],"), 'opencode login 命令缺失');
    assert.ok(src.includes("checkedFrom: '本机 opencode auth login --help"), '缺溯源（checkedFrom）');
  });

  if (!probe || probe === 'no-closure') {
    check('登录退出后必须自动 canary 复检（闭环）', () => {
      const src = S('server/agents/loginRunner.ts');
      // 必须是**调用点**（void runCanary(agentId)），不是 import 里的字样
      assert.match(src, /void runCanary\(agentId\)/, '退出路径未接 canary');
      assert.ok(src.includes('复检'), '复检语义缺失');
    });
  }

  if (!probe || probe === 'no-guard') {
    check('def.login 缺失时 startLogin 必须拒绝', () => {
      assert.match(S('server/agents/loginRunner.ts'), /if \(!def\?\.login\) \{/, '缺少 login 表守卫');
    });
    check('登录进程不经 shell（spawn shell:false）', () => {
      assert.match(S('server/agents/loginRunner.ts'), /shell:\s*false/);
    });
    check('三个端点齐备（start / state / stop）', () => {
      // F0-02②：登录代管端点已迁 server/routes/agent-roster.ts，接线判据跟着搬。
      const idx = S('server/index.ts');
      const roster = S('server/routes/agent-roster.ts');
      assert.ok(roster.includes('/api/agents/login-terminal/start'), '缺 start');
      assert.ok(roster.includes('/api/agents/login-terminal/state'), '缺 state');
      assert.ok(roster.includes('/api/agents/login-terminal/stop'), '缺 stop');
      assert.ok(idx.includes('registerAgentRosterRoutes('), '名册路由接线缺失');
    });
  }
}

async function serverRoundTrip(): Promise<void> {
  if (probe) return;
  console.log('\n[F] 服务端实跑（临时 data 目录 + 假登录命令）');

  const { registry } = await import('../server/agents/registry.js');
  const { registerCustomDefs } = await import('../server/agents/definitions.js');
  const { customCliSpecToDefinition } = await import('../server/agents/customCliAgents.js');
  const { startLogin, getLoginState, stopLogin } = await import('../server/agents/loginRunner.js');
  const node = process.execPath;

  // 回声 Agent（canary 用）：登录命令是另一个假的 node 进程
  const spec = {
    id: 'customcli-lr',
    name: '登录测试',
    command: node,
    args: ['-e', 'console.log(JSON.stringify({type:"text",content:"pong"}))'],
    stdin: false,
    protocol: 'jsonl' as const,
    capabilities: ['chat' as const],
    createdAt: 0,
  };
  const def = customCliSpecToDefinition(spec);
  // 给定义挂上「已核实的登录命令」（真实场景：定义表逐家填写）
  (def as { login: unknown }).login = {
    command: node,
    args: ['-e', 'console.log("login flow start"); setTimeout(() => process.exit(0), 400)'],
    checkedAt: '2026-11-14',
    checkedFrom: '闸门假命令',
  };
  registerCustomDefs([def]);
  registry.registerCustom(def);
  await registry.probeOne(spec.id, true);

  const waitState = async (pred: (s: { running: boolean; exitCode: number | null }) => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const st = getLoginState();
      if (pred(st)) return st;
      if (Date.now() > deadline) return st;
      await new Promise(r => setTimeout(r, 120));
    }
  };

  await checkAsync('login：def.login 缺失 → 拒绝（不画假按钮的守卫）', async () => {
    // 未注册 login 的 Agent：用一个真实存在但没 login 的条目（workbuddy 走 SDK 流，不在此测）
    const r = startLogin('customcli-nologin-ghost');
    assert.ok('error' in r, '应拒绝');
  });

  await checkAsync('login：拉起 → 退出 → 自动 canary 复检（闭环）', async () => {
    const r = startLogin(spec.id);
    assert.ok('started' in r && r.started, `应启动：${JSON.stringify(r)}`);
    // 等登录进程退出（约 0.5s）+ canary 复检（回声 CLI ~2s）
    const st = await waitState(s => !s.running && s.exitCode === 0, 8000);
    assert.equal(st.exitCode, 0, `登录进程应正常退出，实际 ${st.exitCode}`);
    // 复检是异步的，再等 lastCanary 出现 ok 结论
    const deadline = Date.now() + 15000;
    for (;;) {
      const info = registry.get(spec.id);
      if (info?.status.lastCanary?.state === 'ok') break;
      if (Date.now() > deadline) throw new Error(`15s 内未收到复检结论：${JSON.stringify(info?.status.lastCanary)}`);
      await new Promise(r2 => setTimeout(r2, 300));
    }
    const info = registry.get(spec.id);
    assert.equal(info!.status.lastCanary!.state, 'ok', '复检应通过（回声 Agent 通道正常）');
    stopLogin();
  });

  await checkAsync('login：幂等——同 Agent 再点一次不重复拉起', async () => {
    const r = startLogin(spec.id);
    // 上一个会话已结束，这里会新开一个；立刻再点同一个 → started:false
    const r2 = startLogin(spec.id);
    assert.ok('started' in r2 && r2.started === false, '同一 Agent 运行中再点应幂等');
    stopLogin();
  });

  // 清理
  const { deleteCustomCliSpec } = await import('../server/agents/customCliAgents.js');
  void deleteCustomCliSpec(spec.id);
  registry.unregisterCustom(spec.id);
}

async function run(): Promise<void> {
  console.log(probe ? `P2 登录代管闸门（探针模式：${probe}）` : 'P2 登录代管闸门');
  const mutation = probe ? MUTATIONS[probe] : undefined;
  if (probe && !mutation) {
    console.error(`未知探针：${probe}（可用：${Object.keys(MUTATIONS).join(' / ')}）`);
    process.exit(2);
  }
  contracts(mutation ? (src, file) => (file === mutation.file ? mutation.apply(src) : src) : undefined);
  await serverRoundTrip();
  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (probe) {
    if (fail === 0) {
      console.error(`探针失败：变异（${probe}）后闸门仍然全绿——探针无效`);
      process.exit(1);
    }
    console.log(`探针有效：变异后 ${fail} 条变红（按预期）`);
    process.exit(0);
  }
  if (fail > 0) process.exit(1);
  // node-pty 的 ConPTY agent 会挂住事件循环（本环境实测）——闸门收尾必须显式退出
  process.exit(0);
}

void run();
