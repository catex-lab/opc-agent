/**
 * SSE 静默看门狗闸门（C8 / SUPER-AGENT-DESIGN §八 8.2）。
 *
 * 看门狗是「不报错的错」高发区：
 *   · 不触发 → 用户对着静止的气泡无限等（原缺陷）；
 *   · 误触发 → 正常慢回合被反复掐断重连；
 *   · 重复触发 → 重连风暴；
 *   · 写了模块没接进 useChat → 等于没做。
 * 用假时钟精确钉每一项，并静态断言 useChat 确实组装了。
 *
 * 运行：npx tsx scripts/verify-sse-watchdog.ts
 */
import './lib/temp-data-dir.js';
import { readFileSync } from 'node:fs';
import {
  createSilenceWatchdog,
  SILENCE_TIMEOUT_MS,
  DEFAULT_CHECK_INTERVAL_MS,
} from '../src/lib/sse-watchdog.js';

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

/** 假时钟 + 假定时器：手动推进时间，确定性地跑检查 */
function fakeClock() {
  let now = 1_000;
  let fn: (() => void) | null = null;
  const timer = {
    setInterval: (f: () => void) => { fn = f; return 1; },
    clearInterval: () => { fn = null; },
  };
  return {
    get now() { return now; },
    timer,
    advance(ms: number) { now += ms; },
    tick() { fn?.(); },
    hasTimer() { return fn !== null; },
  };
}

function main() {
  // [1] 默认值符合设计 §8.2（60s 静默、5s 检查）
  ok(SILENCE_TIMEOUT_MS === 60_000, '默认静默阈值 60s', String(SILENCE_TIMEOUT_MS));
  ok(DEFAULT_CHECK_INTERVAL_MS === 5_000, '默认检查间隔 5s', String(DEFAULT_CHECK_INTERVAL_MS));

  // [2] 达到阈值触发一次
  {
    const c = fakeClock();
    let fired = 0;
    const w = createSilenceWatchdog({ onSilent: () => fired++, now: () => c.now, timer: c.timer });
    w.start();
    c.advance(59_000); c.tick();
    ok(fired === 0, '59s 未触发', String(fired));
    c.advance(2_000); c.tick();
    ok(fired === 1, '61s 触发一次', String(fired));
    ok(w.isSilent(), '触发后进入 silent 态');
  }

  // [3] touch 刷新计时（心跳帧让看门狗不误触发）
  {
    const c = fakeClock();
    let fired = 0;
    const w = createSilenceWatchdog({ onSilent: () => fired++, now: () => c.now, timer: c.timer });
    w.start();
    for (let i = 0; i < 5; i++) { c.advance(30_000); w.touch(); c.tick(); } // 每 30s 一次心跳
    ok(fired === 0, '每 30s touch 时 150s 都不误触发', String(fired));
    c.advance(61_000); c.tick();
    ok(fired === 1, '心跳停止后 61s 正常触发', String(fired));
  }

  // [4] latch 后不重复触发 + 自动清定时器
  {
    const c = fakeClock();
    let fired = 0;
    const w = createSilenceWatchdog({ onSilent: () => fired++, now: () => c.now, timer: c.timer });
    w.start();
    c.advance(61_000); c.tick();
    c.advance(61_000); c.tick();
    ok(fired === 1, 'latch 后不再重复触发', String(fired));
    ok(!c.hasTimer(), '触发后自动清掉检查定时器');
    const last = w.lastTouchAt();
    w.touch();
    ok(w.lastTouchAt() === last, 'latch 后 touch 无效（不复活）');
  }

  // [5] stop 后不再触发
  {
    const c = fakeClock();
    let fired = 0;
    const w = createSilenceWatchdog({ onSilent: () => fired++, now: () => c.now, timer: c.timer });
    w.start(); w.stop();
    c.advance(120_000); c.tick();
    ok(fired === 0, 'stop 后不再触发', String(fired));
    ok(!c.hasTimer(), 'stop 清掉定时器');
  }

  // [6] 反向探针：不 touch 就会触发（证明 touch 断言不是恒真）
  {
    const c = fakeClock();
    let fired = 0;
    const w = createSilenceWatchdog({ onSilent: () => fired++, now: () => c.now, timer: c.timer });
    w.start();
    c.advance(61_000); c.tick();
    ok(fired === 1, '反向探针：无心跳必触发（touch 断言有效）');
  }

  // [7] 静态闸门：useChat 真的把看门狗接进了收发链路（只写模块=没做）
  const chat = readFileSync(new URL('../src/hooks/useChat.ts', import.meta.url), 'utf8');
  ok(chat.includes('createSilenceWatchdog'), 'useChat 引入看门狗');
  ok(/watchdog\.touch\(\)/.test(chat), '读到字节时 touch');
  ok(/controller\.abort\(\)/.test(chat) && /onSilent/.test(chat), '静默时 abort 当前流');
  ok(/silentReconnect/.test(chat) && /runId && lastSeq > 0/.test(chat), '静默走按 seq 重连路径');
  ok(/reconnecting: true/.test(chat), '重连时给用户可见提示');
  ok(/watchdog\.start\(\)/.test(chat) && /watchdog\.stop\(\)/.test(chat), '看门狗有 start/stop 生命周期');

  // [8] 静态闸门：UI 渲染重连提示 + i18n 两语对齐
  const cm = readFileSync(new URL('../src/components/ChatMessages.tsx', import.meta.url), 'utf8');
  ok(/data-reconnecting/.test(cm), 'StreamStatus 有 data-reconnecting 断言锚点');
  const zh = readFileSync(new URL('../src/i18n/zh.ts', import.meta.url), 'utf8');
  const en = readFileSync(new URL('../src/i18n/en.ts', import.meta.url), 'utf8');
  ok(zh.includes("'chat.status.reconnecting'") && en.includes("'chat.status.reconnecting'"), '中英双语都有重连文案');

  if (failures.length) {
    console.error(`[WATCHDOG] ✗ ${failures.length}/${total} 失败`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`[WATCHDOG] ✓ ${total}/${total} 全部通过`);
}
main();
