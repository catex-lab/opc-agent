/**
 * 正文匀速揭示（方案 C 配套）—— L1 纯函数验收。
 *
 * 为什么单独一层：`useSmoothText` 的观感（顺不顺、追不追得上）靠肉眼，
 * 但它**能不能收敛**是个纯数学问题 —— 步长算错会让正文永远差几个字，
 * 表现是「最后一句话永远少半截」，而这类 bug 在截图里几乎看不出来。
 *
 * 这里只打靶 `nextRevealLength` 的三条性质：
 *   1. 单调不减、不越过目标（不多吐一个字）；
 *   2. 积压越大单帧推进越多（跟得上快模型）；
 *   3. 积压超过上限时直接跳到尾部（断线补帧不慢放）。
 *
 * 运行：npx tsx scripts/verify-smooth-text.ts
 */
import { nextRevealLength, SMOOTH_FRAME_MS } from '../src/hooks/useSmoothText';

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    fails.push(label);
  }
}

console.log('\n[1] 单调不减、不越过目标');
{
  let prev = 0;
  let violations = 0;
  let overshoot = 0;
  // 目标以「不规则增量」推进：模拟网络包的忽大忽小
  const chunks = [3, 1, 1, 12, 2, 40, 5, 1, 1, 1, 90, 7];
  let target = 0;
  for (const c of chunks) {
    target += c;
    for (let i = 0; i < 30; i++) {
      const next = nextRevealLength(prev, target);
      if (next < prev) violations++;
      if (next > target) overshoot++;
      prev = next;
    }
  }
  ok(violations === 0, '从不回退', String(violations));
  ok(overshoot === 0, '从不越过目标（不会多吐字）', String(overshoot));
  ok(prev === target, '最终收敛到全文（不会永远差几个字）', `${prev}/${target}`);
}

console.log('\n[2] 积压越大推进越快');
{
  const small = nextRevealLength(100, 104) - 100; // 积压 4
  const mid = nextRevealLength(100, 130) - 100; // 积压 30
  const big = nextRevealLength(100, 340) - 100; // 积压 240
  ok(small >= 1, '积压 4 字时也在推进（慢模型不会看起来卡住）', String(small));
  ok(mid > small, '积压 30 字比积压 4 字推进得多', `${mid} > ${small}`);
  ok(big > mid, '积压 240 字推进得更多', `${big} > ${mid}`);
  // 30fps 下的吞吐：积压 30 字时一帧 10 字 ≈ 300 字/秒，够追上主流模型
  ok((mid / SMOOTH_FRAME_MS) * 1000 >= 200, '积压 30 字时吞吐 ≥ 200 字/秒', String(Math.round((mid / SMOOTH_FRAME_MS) * 1000)));
}

console.log('\n[3] 大积压不慢放');
{
  const shown = 100;
  const target = 3000; // 断线补帧一次冲进来
  const next = nextRevealLength(shown, target);
  ok(target - next <= 200, '积压 2900 字时直接跳到尾部附近（不做 3 分钟的慢放）', String(target - next));
  ok(next > shown, '跳帧仍然向前', `${shown} → ${next}`);
  // 跳完之后继续正常收敛
  let cur = next;
  for (let i = 0; i < 200 && cur < target; i++) cur = nextRevealLength(cur, target);
  ok(cur === target, '跳帧后仍在有限帧内收敛', String(cur));
}

console.log('\n[4] 边界');
{
  ok(nextRevealLength(0, 0) === 0, '空文本返回 0');
  ok(nextRevealLength(10, 10) === 10, '已追平时返回目标（幂等）');
  ok(nextRevealLength(20, 10) === 10, '目标变短时对齐目标（重新生成不卡住）', String(nextRevealLength(20, 10)));
  ok(nextRevealLength(0, 1) === 1, '只差 1 个字也要吐出来', String(nextRevealLength(0, 1)));
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.error(`\n失败：\n - ${fails.join('\n - ')}`);
  process.exit(1);
}
