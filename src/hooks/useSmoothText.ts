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
 * 一轮结束后的「收尾追赶」时长（ms）。
 *
 * 以前 `streaming` 落假就立刻换全文：屏幕上攒着的那截尾巴会在一帧内补完，
 * 多出一行，贴底的消息再被拽一下。现在改成固定时长线性追完 ——
 * 取 160ms（需求给的是 120–200ms），理由：
 *   · 约 5 个 32ms 小帧，肉眼看得出「在收尾」，又不会让人觉得回合还没完；
 *   · 典型收尾积压只有几十字，160ms 下每帧推进量与流式稳态同量级，
 *     不会出现「最后一段突然窜出来」；
 *   · 再短就接近瞬补，再长会和「状态行收起 / 操作行出现」抢注意力。
 * 这段时间里高度仍由消息区的贴底逻辑兜住，追完才撤光标占位。
 */
export const SMOOTH_SETTLE_MS = 160;

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
 * 平滑揭示：`streaming` 或收尾追赶中返回已揭示的前缀，否则返回全文。
 *
 * 初始值取传入文本 —— 中途切进一个正在流的会话时，不该把已有内容重打一遍。
 *
 * 一轮结束时不再瞬补：把剩下的字在 {@link SMOOTH_SETTLE_MS} 内线性追完，
 * 期间 `settling` 为真（调用方据此保留光标占位，追完再撤）。
 */
export function useSmoothText(
  text: string,
  streaming: boolean
): { shown: string; settling: boolean } {
  const [shown, setShown] = useState(text);
  const [settling, setSettling] = useState(false);
  const shownRef = useRef(text);
  const targetRef = useRef(text);
  const prevStreamingRef = useRef(streaming);
  targetRef.current = text;

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (streaming) {
      if (settling) setSettling(false);
      return;
    }

    const target = targetRef.current;
    const cur = shownRef.current;
    /** 直接对齐：目标被整体替换 / 变短 / 不是前缀时，追旧前缀没有意义 */
    const align = () => {
      shownRef.current = target;
      setShown(target);
      setSettling(false);
    };
    if (target.length <= cur.length || !target.startsWith(cur)) {
      align();
      return;
    }
    // 不是「刚流完」的文本变化（如非流式消息被替换、重新生成）：不重放
    if (!wasStreaming) {
      align();
      return;
    }

    // 收尾追赶：固定时长线性，保证「话一定说完」且不在一帧内补完
    const startLen = cur.length;
    const budget = target.length - startLen;
    const startedAt = performance.now();
    let raf = 0;
    setSettling(true);
    const tick = (now: number) => {
      const p = Math.min(1, (now - startedAt) / SMOOTH_SETTLE_MS);
      const next = target.slice(0, Math.min(target.length, startLen + Math.ceil(budget * p)));
      if (next !== shownRef.current) {
        shownRef.current = next;
        setShown(next);
      }
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setSettling(false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
  return {
    shown: (streaming || settling) && text.startsWith(shown) ? shown : text,
    settling,
  };
}
