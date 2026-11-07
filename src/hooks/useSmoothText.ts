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
 * 语法保护的兜底时长（ms）。
 *
 * 揭示位置停在一个未闭合结构里时最多等这么久；模型一直不闭合就强制揭示，
 * 宁可露出半截语法，也不能让正文永远卡住。
 */
export const SYNTAX_HOLD_MS = 400;

/** 扫描时压在栈上的未闭合结构 */
type OpenSyntax = {
  kind: 'fence' | 'code' | 'bold' | 'underscore' | 'bracket';
  start: number;
  /** 行内反引号：打开时的长度，闭合要求同长度 */
  len?: number;
};

/**
 * 语法感知的揭示保护（A5 第二版）。
 *
 * 半截语法会改变结构：`**粗` 先被渲染成字面量、闭合后再变成粗体；
 * 未闭合的 ``` 会把后文整段吞进代码块；`[链` 在闭合后会被当成链接。
 * 这里只处理五种**高频**结构 —— `**`、`__`、行内反引号、方括号 `[`、
 * 代码围栏 —— 不试图解析完整 markdown。
 *
 * 返回「可以安全揭示到的长度」：候选位置落在未闭合结构内部时，回退到
 * 该结构的起点（最早的那个）；否则原样返回候选长度。转义字符（`\*`）
 * 与代码内部的符号不参与配对。
 *
 * 只做延迟、不做截断以外的加工：它给 `useSmoothText` 的每帧步长加一道
 * 上限，结构闭合后该怎么快就怎么快。
 */
export function syntaxSafeLength(text: string, candidate: number): number {
  const limit = Math.max(0, Math.min(candidate, text.length));
  const stack: OpenSyntax[] = [];
  let atLineStart = true;

  const popIf = (kind: OpenSyntax['kind']) => {
    const top = stack[stack.length - 1];
    if (top && top.kind === kind) stack.pop();
  };

  for (let i = 0; i < limit; i++) {
    const ch = text[i]!;
    const top = stack[stack.length - 1];

    // 代码围栏内部：只认同字符、行首、≥3 个的闭合围栏，其余原样跳过
    if (top && top.kind === 'fence') {
      if (ch === '\n') {
        atLineStart = true;
        continue;
      }
      if (atLineStart && (ch === '`' || ch === '~')) {
        let j = i;
        while (j < limit && text[j] === ch) j += 1;
        const run = j - i;
        const fenceChar = text[top.start];
        if (run >= 3 && ch === fenceChar) stack.pop();
        i = j - 1;
      }
      if (ch !== ' ' && ch !== '\t') atLineStart = false;
      continue;
    }

    // 行内反引号内部：只等同样长度的反引号串闭合
    if (top && top.kind === 'code') {
      if (ch === '`') {
        let j = i;
        while (j < limit && text[j] === '`') j += 1;
        if (j - i === top.len) stack.pop();
        i = j - 1;
      }
      if (ch === '\n') atLineStart = true;
      else if (ch !== ' ' && ch !== '\t') atLineStart = false;
      continue;
    }

    if (ch === '\n') {
      atLineStart = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') continue; // 行首缩进不改变 atLineStart
    if (ch === '\\') {
      i += 1; // 转义：跳过下一个字符，它不参与配对
      atLineStart = false;
      continue;
    }

    // 行首 ``` / ~~~：代码围栏（≥3）。1–2 个按行内代码处理
    if (atLineStart && (ch === '`' || ch === '~')) {
      let j = i;
      while (j < limit && text[j] === ch) j += 1;
      const run = j - i;
      stack.push(run >= 3 ? { kind: 'fence', start: i } : { kind: 'code', start: i, len: run });
      i = j - 1;
      atLineStart = false;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < limit && text[j] === '`') j += 1;
      stack.push({ kind: 'code', start: i, len: j - i });
      i = j - 1;
      atLineStart = false;
      continue;
    }

    // ** / __：整串标记算一个开关，3 个及以上同上
    if (ch === '*' || ch === '_') {
      let j = i;
      while (j < limit && text[j] === ch) j += 1;
      const run = j - i;
      if (run >= 2) {
        const kind = ch === '*' ? 'bold' : 'underscore';
        if (top && top.kind === kind) stack.pop();
        else stack.push({ kind, start: i });
      }
      i = j - 1;
      atLineStart = false;
      continue;
    }

    if (ch === '[') {
      stack.push({ kind: 'bracket', start: i });
    } else if (ch === ']') {
      popIf('bracket');
    }
    atLineStart = false;
  }

  if (stack.length === 0) return limit;
  // 揭示到最早一个未闭合结构的起点之前
  let earliest = limit;
  for (const open of stack) {
    if (open.start < earliest) earliest = open.start;
  }
  return Math.max(0, earliest);
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
  /** 语法保护：结构未闭合时从何时开始等待 */
  const holdSinceRef = useRef<number | null>(null);
  /** 等待超过 SYNTAX_HOLD_MS 后放行，直到该结构闭合才恢复保护 */
  const bypassSyntaxRef = useRef(false);
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
    holdSinceRef.current = null;
    bypassSyntaxRef.current = false;
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
      let next = nextRevealLength(cur.length, target.length);
      /**
       * A5：语法感知的延迟揭示。
       *
       * 揭示位置落在未闭合的 `**` / `__` / 反引号 / `/`[` / 代码围栏里时，
       * 先停在结构起点，等它闭合再一次性放出来 —— 半截语法会让 Cherry 先
       * 按字面量排版、闭合后再跳成粗体/代码块。
       *
       * 兜底：最多等 {@link SYNTAX_HOLD_MS}。超时后放行（宁可露半截），
       * 并保持放行到该结构闭合为止，避免「等 400ms → 放一帧 → 又卡住」
       * 的抽搐。
       */
      const safe = syntaxSafeLength(target, next);
      if (safe >= next) {
        holdSinceRef.current = null;
        bypassSyntaxRef.current = false;
      } else if (bypassSyntaxRef.current) {
        // 已超时放行：继续揭示，等结构闭合后自动恢复保护
      } else {
        if (holdSinceRef.current == null) holdSinceRef.current = now;
        if (now - holdSinceRef.current >= SYNTAX_HOLD_MS) {
          bypassSyntaxRef.current = true;
        } else {
          next = Math.max(cur.length, safe);
        }
      }
      if (next <= cur.length) return;
      const text = target.slice(0, next);
      shownRef.current = text;
      setShown(text);
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
