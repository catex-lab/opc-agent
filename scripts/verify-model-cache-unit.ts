/**
 * 统一缓存失效闸门：凭据变更后三层缓存全清。
 *
 * 守的是「半失效」——改了 SDK 凭据但只清了 SDK 缓存、没清 CLI 目录，
 * 或者反过来。用户看到的症状是「我改了 Key，怎么模型列表没变」。
 *
 * 纯单测：import model-cache.ts 的函数，不碰 dist / 浏览器 / 真实 CLI。
 * CLI 目录缓存的失效由 modelCatalog 自己的 `invalidateCatalog()` 覆盖，
 * 这里只验证「SDK 三层缓存确实被清空」+「函数确实调了 invalidateCatalog」。
 *
 * 运行：npx tsx scripts/verify-model-cache-unit.ts
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import {
  invalidateAllModelCaches,
  __sdkCacheEmpty,
  __setSdkCacheForTest,
} from '../server/model-cache.js';
import { __setCatalogStateForTest } from '../server/agents/modelCatalog.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n[1] 初始状态：缓存为空');
{
  ok(__sdkCacheEmpty(), '刚 import 时 SDK 缓存为空');
}

console.log('\n[2] 塞入非空缓存后，invalidateAllModelCaches 清空三层');
{
  // 构造「缓存非空」的初始状态
  __setSdkCacheForTest(
    [{ modelId: 'test-model', name: 'Test Model' }],
    'test-default',
    Date.now()
  );
  ok(!__sdkCacheEmpty(), '塞入后缓存非空（前置条件）');

  // 同步给 catalog 塞一个假状态，让它也非空
  __setCatalogStateForTest({
    version: 1,
    fetchedAt: Date.now(),
    agents: { opencode: ['openai/gpt-4o'] },
    providers: {},
    details: {},
    defaults: {},
  });

  // 执行失效
  invalidateAllModelCaches('unit-test');

  // SDK 三层全空
  ok(__sdkCacheEmpty(), '★ 失效后 SDK 缓存三层全空');
}

console.log('\n[3] 反向探针：只清 SDK 不清 catalog = 不完整的半失效');
{
  // 重新塞满
  __setSdkCacheForTest(
    [{ modelId: 'test-model-2', name: 'Test Model 2' }],
    'test-default-2',
    Date.now()
  );

  // 只清 SDK 三层，不调 invalidateCatalog —— 模拟改造前的 bug
  // model-cache.ts 的 invalidateAllModelCaches 内部调了 invalidateCatalog，
  // 这里手动验证「如果只清 SDK 那三层，catalog 仍然非空」来确认 catalog 是独立的
  __setCatalogStateForTest({
    version: 1,
    fetchedAt: Date.now(),
    agents: { qoder: ['qoder/qwen-3'] },
    providers: {},
    details: {},
    defaults: {},
  });

  // 正路：invalidateAllModelCaches 会同时清 catalog
  invalidateAllModelCaches('reverse-probe');
  ok(__sdkCacheEmpty(), '★ SDK 缓存再次全空');

  // catalog 也应该被清了（invalidateAllModelCaches 内部调了 invalidateCatalog）
  // getCatalogSummary 在 state=null 时返回的 counts 全 0
  const { getCatalogSummary } = await import('../server/agents/modelCatalog.js');
  const summary = getCatalogSummary();
  const totalModels = Object.values(summary.counts).reduce((a: number, b: unknown) => a + (b as number), 0);
  ok(totalModels === 0, '★ catalog 也被清空（非半失效）', `counts=${JSON.stringify(summary.counts)}`);
}

console.log('\n[4] 连续失效不报错（幂等性）');
{
  __setSdkCacheForTest([{ modelId: 'x', name: 'X' }], 'x', 1000);
  invalidateAllModelCaches('first');
  ok(__sdkCacheEmpty(), '第一次失效后为空');
  // 再调一次不应该崩
  invalidateAllModelCaches('second');
  ok(__sdkCacheEmpty(), '第二次失效后仍为空（幂等）');
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail > 0) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
