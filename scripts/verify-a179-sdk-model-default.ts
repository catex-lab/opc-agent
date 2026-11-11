/**
 * A179：WorkBuddy / Tencent SDK 的默认模型与失效模型回退。
 *
 * 钉死三件事：
 *   1. `/api/models` 的兜底只给 SDK 默认别名，不再出现已下线的具体型号；
 *   2. 没有显式模型时交给 SDK 的 `default-model`（Auto）；
 *   3. 旧会话里已下线的模型名在发请求前回退 undefined，不原样传下去。
 *
 * 运行：npx tsx scripts/verify-a179-sdk-model-default.ts
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveModelForAgent,
  resolveStoredModelForAgent,
  isStaleSdkModel,
  setPlatformModelLookup,
  SDK_DEFAULT_MODEL,
  SDK_MODEL_FALLBACK,
  PLATFORM_DEFAULT_MODEL,
} from '../server/model-routing.js';

const root = path.resolve(import.meta.dirname, '..');
const failures: string[] = [];
let total = 0;

function eq<T>(actual: T, expected: T, label: string) {
  total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// ── 1. 兜底清单：只允许 SDK 默认别名 ──────────────────────────────
{
  eq(SDK_MODEL_FALLBACK, [{ modelId: 'default-model', name: 'Auto' }], '兜底清单应只有 default-model / Auto');
  ok(!JSON.stringify(SDK_MODEL_FALLBACK).includes('claude-sonnet-4'), '兜底清单不得含 claude-sonnet-4');
  ok(!JSON.stringify(SDK_MODEL_FALLBACK).includes('claude-opus-4'), '兜底清单不得含 claude-opus-4');
}

// ── 2. 无显式模型：传 SDK 默认 ────────────────────────────────────
{
  eq(resolveModelForAgent('workbuddy', undefined), 'default-model', '无显式模型应传 default-model');
  eq(resolveModelForAgent('workbuddy', ''), 'default-model', '空串应视作未指定');
  ok(PLATFORM_DEFAULT_MODEL === 'claude-sonnet-4', '旧平台常量保留，仅作历史值过滤哨兵');
}

// ── 3. 清单就绪后：有效值沿用、失效值回退 ────────────────────────
{
  setPlatformModelLookup(() => ['default-model', 'hy3', 'deepseek-v4.1-flash']);

  eq(resolveModelForAgent('workbuddy', 'hy3'), 'hy3', '清单内的显式模型应原样采用');
  eq(resolveStoredModelForAgent('workbuddy', 'hy3'), 'hy3', '旧会话里的有效模型应沿用');
  eq(resolveStoredModelForAgent('workbuddy', 'default-model'), 'default-model', '旧会话里的默认别名应沿用');

  eq(isStaleSdkModel('workbuddy', 'claude-sonnet-4'), true, 'claude-sonnet-4 应判定为失效');
  eq(isStaleSdkModel('workbuddy', 'claude-opus-4'), true, 'claude-opus-4 应判定为失效');
  eq(
    resolveStoredModelForAgent('workbuddy', 'claude-sonnet-4'),
    undefined,
    '旧会话失效模型应回退 undefined（交给 SDK 默认）'
  );
  eq(
    resolveStoredModelForAgent('workbuddy', 'claude-opus-4'),
    undefined,
    '另一个失效旧模型也应回退 undefined'
  );
  eq(resolveStoredModelForAgent('workbuddy', undefined), 'default-model', '旧会话没有模型时仍走 SDK 默认');

  // 非 Tencent SDK 不受这份清单影响（claude 自己的命名空间另有规则）
  eq(isStaleSdkModel('claude', 'claude-opus-4'), false, '非 Tencent SDK 不做失效判定');
  eq(resolveStoredModelForAgent('hermes', PLATFORM_DEFAULT_MODEL), undefined, 'ACP 仍拦截旧平台默认值');

  // 清单未就绪时不能乱丢用户显式选择
  setPlatformModelLookup(() => null);
  eq(isStaleSdkModel('workbuddy', 'claude-sonnet-4'), false, '清单未就绪时不做失效判定');
  eq(resolveStoredModelForAgent('workbuddy', 'claude-sonnet-4'), 'claude-sonnet-4', '清单未就绪时应原样沿用');
  setPlatformModelLookup(null);
}

// ── 4. 源码契约：入口与兜底不能再写旧型号 ────────────────────────
{
  const index = readFileSync(path.join(root, 'server/index.ts'), 'utf8');
  const runner = readFileSync(path.join(root, 'server/turn-runner.ts'), 'utf8');

  ok(!index.includes('"claude-sonnet-4"'), 'server/index.ts 不得再硬编码 claude-sonnet-4');
  ok(!index.includes('"claude-opus-4"'), 'server/index.ts 不得再硬编码 claude-opus-4');
  ok(index.includes('SDK_MODEL_FALLBACK'), '/api/models 兜底必须走 SDK_MODEL_FALLBACK');
  ok(index.includes('const defaultModel = SDK_DEFAULT_MODEL'), 'defaultModel 初值必须是 SDK 默认别名');
  ok(index.includes('resolveStoredModelForAgent'), '发消息路由必须走失效模型回退');
  ok(runner.includes('resolveStoredModelForAgent'), 'turn-runner 必须走失效模型回退');
  ok(!runner.includes('resolveModelForAgent('), 'turn-runner 不得绕过失效模型回退');
}

console.log(`A179 结果：通过 ${total - failures.length}，失败 ${failures.length}`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ SDK 默认模型、兜底清单与旧会话失效模型回退均符合预期');
