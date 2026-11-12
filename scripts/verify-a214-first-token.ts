/**
 * A214 闸门：SDK 通道首字护栏。
 *
 * ## 要钉的是哪两层
 *
 *   [1]-[4] 行为层：FirstTokenGuard 纯单测（默认值 / 环境覆盖与下限 /
 *       到点触发 / disarm 撤除），60-200ms 级别的真实计时；
 *   [5] 源码契约：sdk.ts 池路径与 one-shot 路径的 race 落点、驱逐动作、
 *       disarm 时机、retryable 报错——按行锚定，退回坏版本会变红；
 *   [6] 反向探针：把源码「退回坏版本」（抹掉护栏 race），确认契约断言
 *       真会变红。
 *
 * 运行：
 *   npx tsx scripts/verify-a214-first-token.ts
 *   npx tsx scripts/verify-a214-first-token.ts --probe=no-guard
 */
// 必须先于所有 server/** import：绝不触碰真实 data/
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIRST_TOKEN_TIMEOUT,
  FirstTokenGuard,
  firstTokenTimeoutMessage,
  resolveFirstTokenTimeoutMs,
} from '../server/agents/adapters/firstTokenGuard.js';

const ARGS = process.argv.slice(2);
const PROBE = ARGS.find(a => a.startsWith('--probe='))?.slice(8) ?? null;

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
/** 反向探针专用：断言「坏版本下这个条件不成立」 */
function okRed(cond: unknown, name: string) {
  if (!cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}
function group(title: string) {
  console.log(`\n── ${title} ──`);
}

// ════════════════════════════ 断言 ════════════════════════════

group('[1] 超时值解析');
delete process.env.OPC_SDK_FIRST_TOKEN_TIMEOUT_MS;
ok(resolveFirstTokenTimeoutMs() === 120_000, '默认 120s');
process.env.OPC_SDK_FIRST_TOKEN_TIMEOUT_MS = '3000';
ok(resolveFirstTokenTimeoutMs() === 15_000, '下限 15s（3s 的请求被抬到 15s）');
process.env.OPC_SDK_FIRST_TOKEN_TIMEOUT_MS = '45000';
ok(resolveFirstTokenTimeoutMs() === 45_000, '环境覆盖生效');
delete process.env.OPC_SDK_FIRST_TOKEN_TIMEOUT_MS;
process.env.OPC_SDK_FIRST_TOKEN_TIMEOUT_MS = 'not-a-number';
ok(resolveFirstTokenTimeoutMs() === 120_000, '非法值回落默认（不 NaN）');
delete process.env.OPC_SDK_FIRST_TOKEN_TIMEOUT_MS;

group('[2] 到点触发');
{
  const guard = new FirstTokenGuard(80);
  const won = await Promise.race([guard.timeout, new Promise<'stub'>(r => setTimeout(() => r('stub'), 2000))]);
  ok(won === FIRST_TOKEN_TIMEOUT, '80ms 后护栏 resolve 出超时哨兵');
}

group('[3] disarm 撤除');
{
  const guard = new FirstTokenGuard(80);
  guard.disarm();
  const won = await Promise.race([guard.timeout, new Promise<'stub'>(r => setTimeout(() => r('stub'), 200))]);
  ok(won === 'stub', 'disarm 后护栏不再触发（stub 先赢）');
}

group('[4] 报错文案');
{
  const msg = firstTokenTimeoutMessage(120_000);
  ok(msg.includes('120'), '文案含秒数');
  ok(msg.includes('重发'), '文案含可执行动作（重发）');
}

group('[5] 源码契约（sdk.ts 两条路径）');
const sdkSrc = fs.readFileSync(
  fileURLToPath(new URL('../server/agents/adapters/sdk.ts', import.meta.url)),
  'utf8'
);
ok(
  /const sendStage = await Promise\.race\(\[\s*entry\.session\.send\(ctx\.prompt\)\.then\(\(\) => null\),\s*guard\.timeout,\s*\]\)/.test(sdkSrc),
  '池路径：send() 与护栏 race'
);
ok(
  /let step = await Promise\.race\(\[iterator\.next\(\), guard\.timeout\]\);/.test(sdkSrc),
  '池路径：首条流事件与护栏 race'
);
ok(
  (sdkSrc.match(/guard\.disarm\(\)/g) ?? []).length === 2,
  '两条路径都是「首字已到才撤护栏」'
);
ok(
  (sdkSrc.match(/firstTokenTimeoutMessage\(guard\.ms\)/g) ?? []).length === 3,
  '三条超时分支（池路径 send / 池路径首事件 / one-shot）都走同一文案'
);
{
  const proj = fs.readFileSync(
    fileURLToPath(new URL('../server/agents/projector.ts', import.meta.url)),
    'utf8'
  );
  ok(
    /timeout\|超时\|排队\|network/.test(proj),
    'A214：投影层 retryable 正则认得中文「超时/排队」（首字护栏文案可触发重试标记）'
  );
  ok(firstTokenTimeoutMessage(120_000).includes('超时'), '护栏文案含「超时」关键词（投影层派生 retryable 依赖它）');
}
ok(
  /void gen\.return\?\.\(undefined\)\.catch\(\(\) => \{\}\);/.test(sdkSrc),
  'one-shot 超时后尽力关掉 generator（带走子进程）'
);
ok(
  /resolveFirstTokenTimeoutMs|OPC_SDK_FIRST_TOKEN_TIMEOUT_MS/.test(
    fs.readFileSync(
      fileURLToPath(new URL('../server/agents/adapters/firstTokenGuard.ts', import.meta.url)),
      'utf8'
    )
  ),
  '超时值可经 OPC_SDK_FIRST_TOKEN_TIMEOUT_MS 调参（文档化）'
);

group('[6] 反向探针');
if (PROBE === 'no-guard') {
  // 模拟退回坏版本：抹掉两处 race 落点 —— 源码契约必须变红
  const bad = sdkSrc
    .replace(/Promise\.race\(\[\s*entry\.session\.send\(ctx\.prompt\)\.then\(\(\) => null\),\s*guard\.timeout,\s*\]\)/g, 'await entry.session.send(ctx.prompt)')
    .replace(/Promise\.race\(\[iterator\.next\(\), guard\.timeout\]\)/g, 'await iterator.next()');
  okRed(
    /Promise\.race\(\[\s*entry\.session\.send/.test(bad) || /Promise\.race\(\[iterator\.next\(\), guard\.timeout\]\)/.test(bad),
    '反向探针(no-guard)：抹掉 race 后「send/首条事件与护栏 race」断言应判红'
  );
} else {
  console.log('  （no-guard 探针未启用，跳过）');
}

// ════════════════════════════ 汇总 ════════════════════════════
console.log(
  `\n${failures.length ? '✗' : '✓'} A214 SDK 首字护栏：${pass}/${pass + fail} 通过` +
    `${PROBE ? `（探针 ${PROBE}）` : ''}`
);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
