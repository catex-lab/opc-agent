/**
 * 手动标定一个 Agent 的过程能力（P3）。
 *
 * 用法：
 *   npm run probe:capability -- opencode zai/glm-4.7
 *   npm run probe:capability -- codex gpt-5 --force
 *
 * 注意：这会**真起 CLI、真花 token**，所以不是启动时自动做的事。
 * 结果按 (引擎 · 模型 · 网关) 写进缓存，7 天内再次标定会直接命中缓存；
 * `--force` 忽略缓存重跑。
 */

import { probeCapabilities } from '../server/agents/capability-probe.js';
import { capabilityKeyString } from '../shared/capabilities.js';

const raw = process.argv.slice(2);
const force = raw.includes('--force');
const args = raw.filter(a => !a.startsWith('--'));
const agentId = args[0];
const model = args[1];

if (!agentId) {
  console.error('用法: npm run probe:capability -- <agentId> [model] [--force]');
  process.exit(2);
}

const outcome = await probeCapabilities(agentId, model, { force });

if (!outcome.ok) {
  console.error(`✗ 标定失败：${outcome.error}`);
  process.exit(1);
}

const key = outcome.key ?? { engine: agentId, gateway: '?' };
console.log(`✓ 标定完成（${outcome.cached ? '命中缓存' : '本次实跑'}）`);
console.log(`  key: ${capabilityKeyString(key)}`);
console.log(`  能力: ${outcome.probe?.capabilities.length ? outcome.probe.capabilities.join(', ') : '（一项都没有）'}`);
console.log(`  时刻: ${new Date(outcome.probe?.at ?? 0).toISOString()}`);
if (outcome.argv?.length) {
  const last = outcome.argv[outcome.argv.length - 1];
  const shown = outcome.argv.map(a => (a === last ? '<prompt>' : a));
  console.log(`  argv: ${shown.join(' ')}`);
}
