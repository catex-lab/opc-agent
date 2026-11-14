/**
 * P1 真实健康度检测（canary）闸门。
 *
 * 四层：
 *   [F] 服务端实跑 —— 临时 data 目录 + node 回声 CLI（A223 的手动接入通道）：
 *       OK / 401（prev ready → auth_expired）/ 429（quota）/ ENOENT（not_installed）/
 *       预算超时（unknown）/ 未安装跳过
 *   [U] 离线单元 —— shouldAutoCanary TTL 判定
 *   [S] 源码契约 —— toAgentInfo 按 at 取最新（canary > 运行期 > 探测）、
 *       canary OK 清掉过期运行期坏消息、频控与开关接线、recordCanary 出口
 *   [P] 反向探针 —— 优先级被拆 / 文本归类被绕过，必须变红
 *
 * 运行：npx tsx scripts/verify-canary.ts [--probe=no-precedence|no-classify]
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
  // 坏形态①：toAgentInfo 不再按 at 取最新，恒用探测派生——运行期/检测事实被掩盖
  'no-precedence': {
    file: 'server/agents/types.ts',
    apply: src =>
      src.replace(
        'candidates.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));',
        '/* probe: precedence removed */'
      ),
  },
  // 坏形态②：canary 失败不再归类，一律 unknown——「额度受限/登录态失效」退化成异常
  'no-classify': {
    file: 'server/agents/canary.ts',
    apply: src => src.replace('const cls = classifyErrorMessage(ev.message);', "const cls = 'unknown' as const;"),
  },
};

function contracts(mutate?: (src: string, file: string) => string): void {
  const S = (rel: string) => repoSource(rel, mutate ? (src) => mutate(src, rel) : undefined);

  if (!probe || probe === 'no-precedence') {
    check('toAgentInfo：三源按 at 取最新（canary > 运行期 > 探测 是结果不是写死顺序）', () => {
      const src = S('server/agents/types.ts');
      assert.match(src, /candidates\.sort\(/, '缺少按 at 排序的优先级合并');
      assert.match(src, /lastCanary/, 'toAgentInfo 未消费 canary 事实');
    });
    check('canary OK 必须清掉比它旧的运行期坏消息（更新的好消息顶掉旧坏消息）', () => {
      assert.match(S('server/agents/types.ts'), /canary\.state === 'ok'/, '缺少 OK 清理分支');
    });
  }
  if (!probe || probe === 'no-classify') {
    check('canary 失败必须走诊断归类（不许一律 unknown）', () => {
      assert.match(S('server/agents/canary.ts'), /classifyErrorMessage\(/, 'canary 未调用分类器');
      assert.match(S('server/agents/canary.ts'), /authDiagnosticFor\(/, 'auth 细分缺失');
    });
    check('自动触发必须吃总开关（canaryEnabled=false 时不跑）', () => {
      assert.match(S('server/agents/canary.ts'), /canaryEnabled === false/, '缺少开关判定');
    });
    check('GET /api/agents 必须触发自动补跑；手动端点必须存在', () => {
      const idx = S('server/index.ts');
      assert.ok(idx.includes('scheduleAutoCanaries('), 'GET /api/agents 缺自动触发');
      assert.ok(idx.includes('/api/agents/canary'), '缺手动端点');
    });
  }
}

async function units(): Promise<void> {
  if (probe) return;
  console.log('\n[U] 离线单元');
  const { shouldAutoCanary, CANARY_TTL_MS } = await import('../server/agents/canary.js');
  const now = 1_000_000_000;
  check('TTL：没有记录 → 要跑；TTL 内 → 不跑；过期 → 要跑', () => {
    assert.equal(shouldAutoCanary(undefined, now), true);
    assert.equal(shouldAutoCanary(now - 1000, now), false);
    assert.equal(shouldAutoCanary(now - CANARY_TTL_MS - 1, now), true);
  });
}

async function serverRoundTrip(): Promise<void> {
  if (probe) return;
  console.log('\n[F] 服务端实跑（临时 data 目录 + node 回声 CLI）');

  const { registry } = await import('../server/agents/registry.js');
  const { registerCustomDefs } = await import('../server/agents/definitions.js');
  const {
    createCustomCliSpec,
    customCliSpecToDefinition,
    deleteCustomCliSpec,
  } = await import('../server/agents/customCliAgents.js');
  const { runCanary } = await import('../server/agents/canary.js');

  const node = process.execPath;
  const specs = [
    {
      key: 'ok',
      name: '回声好',
      args: ['-e', 'console.log(JSON.stringify({type:"text",content:"pong"}))'],
    },
    {
      key: 'auth',
      name: '回声401',
      args: ['-e', 'console.error("401 Unauthorized"); process.exit(1)'],
    },
    {
      key: 'quota',
      name: '回声429',
      args: ['-e', 'console.log(JSON.stringify({type:"error",message:"429 Too Many Requests"}))'],
    },
    {
      key: 'enoent',
      name: '回声缺文件',
      args: ['-e', 'console.log(JSON.stringify({type:"error",message:"spawn git ENOENT: not found"}))'],
    },
    {
      key: 'slow',
      name: '回声慢',
      args: ['-e', 'setTimeout(()=>{},60000)'],
    },
  ] as const;

  const ids: Record<string, string> = {};
  for (const sp of specs) {
    const spec = createCustomCliSpec({
      name: sp.name,
      command: node,
      args: [...sp.args],
      stdin: false,
      protocol: 'jsonl',
      capabilities: ['chat'],
    });
    ids[sp.key] = spec.id;
    registerCustomDefs([
      ...loadAll().map(def => def),
    ]);
    registry.registerCustom(customCliSpecToDefinition(spec));
    await registry.probeOne(spec.id, true); // node 在位 → ready（wasReady=true 的上下文）
  }
  function loadAll() {
    // registerCustomDefs 需要「整表」；闸门里只注册这一批
    return (specs as readonly { key: string }[]).map(() =>
      customCliSpecToDefinition({
        id: 'customcli-x',
        name: 'x',
        command: node,
        args: [],
        stdin: false,
        protocol: 'jsonl',
        capabilities: ['chat'],
        createdAt: 0,
      })
    );
  }

  await checkAsync('canary：正常回声 → ok', async () => {
    const d = await runCanary(ids.ok!);
    assert.equal(d.class, 'ok');
    const info = registry.get(ids.ok!);
    assert.equal(info?.status.lastCanary?.state, 'ok');
  });

  await checkAsync('canary：401（prev ready）→ auth_expired', async () => {
    const d = await runCanary(ids.auth!);
    assert.equal(d.class, 'auth_expired', `实际 ${d.class} / ${d.detail ?? ''}`);
  });

  await checkAsync('canary：429 → quota', async () => {
    const d = await runCanary(ids.quota!);
    assert.equal(d.class, 'quota', `实际 ${d.class} / ${d.detail ?? ''}`);
  });

  await checkAsync('canary：ENOENT → not_installed', async () => {
    const d = await runCanary(ids.enoent!);
    assert.equal(d.class, 'not_installed', `实际 ${d.class} / ${d.detail ?? ''}`);
  });

  await checkAsync('canary：预算超时 → unknown（短预算 2s，不真等 30s）', async () => {
    const d = await runCanary(ids.slow!, { budgetMs: 2000 });
    assert.equal(d.class, 'unknown', `实际 ${d.class} / ${d.detail ?? ''}`);
  });

  await checkAsync('canary：未安装 → 跳过（不标 checking，结论沿用探测）', async () => {
    const d = await runCanary('ghost-agent');
    assert.equal(d.class, 'unknown'); // Agent 不存在 → unknown 结论
    assert.equal(registry.get(ids.ok!)!.status.lastCanary!.state !== 'checking', true);
  });

  await checkAsync('canary 结论清理：OK 后过期运行期坏消息被顶掉（toAgentInfo）', async () => {
    const { toAgentInfo } = await import('../server/agents/types.js');
    // 造一颗运行期坏消息（真实链路里由 recordError 写入）
    registry.recordError(ids.auth!, '401 Unauthorized');
    const withErr = registry.get(ids.auth!)!;
    assert.equal(withErr.diagnostic?.class, 'auth_expired', '前置：运行期 401 已在诊断出口');
    // 一次更新的 canary OK（at 更新）→ 顶掉旧坏消息
    registry.recordCanary(ids.auth!, { state: 'ok', at: new Date(Date.parse(withErr.diagnostic!.at) + 5000).toISOString() });
    const merged = toAgentInfo(withErr, registry.get(ids.auth!)!.status);
    assert.equal(merged.diagnostic.class, 'ok', '更新的 canary OK 必须顶掉旧的 401');
  });

  // 清理
  for (const key of Object.keys(ids)) void deleteCustomCliSpec(ids[key]!);
}

async function run(): Promise<void> {
  console.log(probe ? `P1 canary 闸门（探针模式：${probe}）` : 'P1 真实健康度检测（canary）闸门');
  const mutation = probe ? MUTATIONS[probe] : undefined;
  if (probe && !mutation) {
    console.error(`未知探针：${probe}（可用：${Object.keys(MUTATIONS).join(' / ')}）`);
    process.exit(2);
  }
  contracts(mutation ? (src, file) => (file === mutation.file ? mutation.apply(src) : src) : undefined);
  await units();
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
}

void run();
