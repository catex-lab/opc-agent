import { useEffect, useRef, useState } from 'react';

/* ── 正文的「匀速揭示」（方案 C 配套）────────────────────────────────────
 *
 * ## 为什么需要它
 *
 * 服务端把 token 按网络包切，一帧里可能来 3 个字，也可能一口气来 200 个。
 * 直接把 `block.text` 塞给 markdown，观感是「停一下、窜一截、再停一下」——
 * 文字在跳，不是在流。这里做的是**内容侧的节流**：目标文本照常到达，
 * 但屏幕上只按稳定速率把前缀吐出来，积压越多吐得越快（永不明显落后）。
 *
 * ## 为什么不是给每个字套动画（像 TypingText 那样）
 *
 * 正文是 markdown，渲染出来是一棵树。逐字包 `<span>` 会切断行内标记
 * （`**粗` + `体**`），也会让代码块/表格每帧重建。这里只截字符串前缀，
 * 交给 CherryStream 增量解析 —— 结构始终合法。
 *
 * ## 边界
 *
 *   · 非流式（历史消息 / 一轮已结束）：立刻给全文，不重放。
 *   · 目标被整体替换（重新生成、编辑消息）：不追旧前缀，直接对齐。
 *   · 积压超过 MAX_LAG（断线补帧、粘贴）：跳到尾部附近，不做「慢放」。
 * ────────────────────────────────────────────────────────────────────── */

/** 推进间隔（ms）。32ms ≈ 30fps：比 rAF 慢一档，够顺滑，markdown 解析也扛得住 */
export const SMOOTH_FRAME_MS = 32;
/** 每帧至少推进的字数 —— 再慢也要动，否则慢速模型下会「卡住」 */
const MIN_STEP = 1;
/** 积压 ÷ 这个数 = 每帧推进量。积压越多越快，稳定在 ~0.2s 的滞后 */
const CATCH_UP_DIVISOR = 3;
/** 落后超过这么多字就不再逐字补 */
const MAX_LAG = 400;
/** 跳帧后保留的尾巴长度（留一点让用户看到「在动」） */
const JUMP_TAIL = 120;

/**
 * 下一帧应该揭示到第几个字符。纯函数，供 L1 直接断言。
 *
 * 三条性质（脚本按这三条打靶）：
 *   1. 单调不减、不越过目标；
 *   2. 积压越大单帧推进越多（追得上）；
 *   3. 积压超过 MAX_LAG 时直接跳到尾部附近（不慢放）。
 */
export function nextRevealLength(shownLength: number, targetLength: number): number {
  if (targetLength <= shownLength) return targetLength;
  const backlog = targetLength - shownLength;
  if (backlog > MAX_LAG) return targetLength - JUMP_TAIL;
  return Math.min(
    targetLength,
    shownLength + Math.max(MIN_STEP, Math.ceil(backlog / CATCH_UP_DIVISOR))
  );
}

/**
 * 平滑揭示：`streaming` 时返回已揭示的前缀，否则返回全文。
 *
 * 初始值取传入文本 —— 中途切进一个正在流的会话时，不该把已有内容重打一遍。
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const shownRef = useRef(text);
  const targetRef = useRef(text);
  targetRef.current = text;

  // 非流式：立刻对齐全文。一轮结束时也不留半截（否则用户看到的是「话没说完」）。
  useEffect(() => {
    if (streaming) return;
    if (shownRef.current === targetRef.current) return;
    shownRef.current = targetRef.current;
    setShown(targetRef.current);
  }, [text, streaming]);

  useEffect(() => {
    if (!streaming) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < SMOOTH_FRAME_MS) return;
      last = now;
      const target = targetRef.current;
      const cur = shownRef.current;
      if (cur.length >= target.length) return;
      // 目标被整体替换：旧前缀已经不是新文本的前缀，追它没有意义
      if (!target.startsWith(cur)) {
        shownRef.current = target;
        setShown(target);
        return;
      }
      const next = target.slice(0, nextRevealLength(cur.length, target.length));
      shownRef.current = next;
      setShown(next);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [streaming]);

  // 只在前缀关系成立时才用 shown —— 目标变短的那一帧立刻回到全文
  return streaming && text.startsWith(shown) ? shown : text;
}
