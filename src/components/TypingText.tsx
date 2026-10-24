import { useEffect, useRef } from 'react';

/**
 * 打字机文本：新增字符带「高斯模糊渐显 + 字符错开」，已显示过的字符保持静态。
 *
 * ## 为什么不是「每次渲染都给整段套动画」
 *
 * 流式输出时这段文本每秒会更新十几次。如果每次更新都让整段重新做一遍
 * 淡入，用户看到的是整段文字持续闪烁 —— 那不是打字机，是故障。
 * 所以组件维护一个「已经落定到多少字」的游标，**只给增量**套动画：
 *
 *   上一帧： 已经想好了怎么改            ← 纯文本，不再参与动画
 *   本帧：   ，先看令牌定义             ← 只有这几个字做 blur → 0
 *
 * ## 游标为什么放在 effect 里推进
 *
 * 项目开了 StrictMode，渲染函数会被连调两次。若在 render 里推进游标，
 * 第二次渲染拿到的增量就是空字符串 —— 动画直接不出现（而且只在开发态
 * 消失，打包后正常，是最难查的一类 bug）。放在 useEffect 里推进，
 * 两次渲染看到的是同一个「上一帧」，输出稳定。
 *
 * ## 分块规则
 *
 * 不能无脑按字符切：
 *   · 中文按**字**切（每个字都是独立的断行单位，错开显现才有「逐字」感）；
 *   · 拉丁/数字按**词**切 —— 逐字母切会把 "streaming" 拆成 9 个 inline-block，
 *     单词中间可以被断行，还会让字距看起来散架；
 *   · 空白单独成块并保留（`white-space: pre`），否则连续空格会被折叠，
 *     流式过程中段落会左右跳。
 *
 * ## 性能
 *
 * 错开的延迟封顶在 `maxStagger` 块（默认 8）：断线重连或补帧时一次可能
 * 冲进来 100 个字，若按 14ms × 100 排队，最后几个字要 1.4 秒后才出现，
 * 明显落后于流。封顶后超出部分同批出现，视觉上仍是「一涌而出」。
 */

interface TypingTextProps {
  text: string;
  /**
   * 是否播放动画。**只在该文本确实在增长时传 true** ——
   * 历史消息、已完成的思考块传 false，否则打开旧会话会看到满屏文字
   * 一起「重打一遍」。
   */
  animate?: boolean;
  className?: string;
  /** 错开的最大块数（超出部分同批出现） */
  maxStagger?: number;
  /** 相邻块的延迟（ms） */
  staggerMs?: number;
  /**
   * 单帧最多做多少个动画块。
   *
   * 流式正常增量是 3–20 个字，但**补帧 / 断线续传 / 粘贴**会一次冲进来
   * 上千个字。给每个字都套 inline-block + filter，等于一帧创建上千个
   * 合成层，长会话里直接掉帧。超过上限的部分退化成纯文本（立即出现，
   * 不参与动画）—— 用户看到的是「一大段一起出现」，而不是界面卡住。
   */
  maxAnimated?: number;
}

/** CJK 与全角标点：这些按字切 */
const CJK = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF\uF900-\uFAFF]/;

/**
 * 把一段文本切成「显现单元」。
 *
 * 中文/全角标点/空白各自成块；其余连续字符（拉丁字母、数字、半角标点）
 * 合成一块，保证英文单词不会被拆断。
 */
export function segmentForReveal(text: string): string[] {
  const out: string[] = [];
  let word = '';
  for (const ch of Array.from(text)) {
    const atomic = CJK.test(ch) || /\s/.test(ch);
    if (atomic) {
      if (word) {
        out.push(word);
        word = '';
      }
      out.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) out.push(word);
  return out;
}

export function TypingText({
  text,
  animate = true,
  className,
  maxStagger = 8,
  staggerMs = 14,
  maxAnimated = 60,
}: TypingTextProps) {
  const prevRef = useRef('');

  // 渲染期只读不写（StrictMode 双调用下必须幂等）
  const prev = prevRef.current;
  const continues = text.startsWith(prev);
  const committed = continues ? prev.length : 0;
  const delta = text.slice(committed);

  useEffect(() => {
    prevRef.current = text;
  }, [text]);

  // 不需要动画（或没有增量）时输出纯文本：不产生任何额外 span
  if (!animate || !delta) {
    return <span className={className}>{text}</span>;
  }

  const all = segmentForReveal(delta);
  // 超长增量：前面的直接落定，只让最后 maxAnimated 块参与动画
  const animated = all.length > maxAnimated ? all.slice(all.length - maxAnimated) : all;
  const plainDelta = all.length > maxAnimated ? all.slice(0, all.length - maxAnimated).join('') : '';

  return (
    <span className={className}>
      {committed > 0 && text.slice(0, committed)}
      {plainDelta}
      {animated.map((chunk, i) => (
        <span
          key={`${committed}:${i}`}
          className="tc-type-char"
          style={{ animationDelay: `${Math.min(i, maxStagger) * staggerMs}ms` }}
        >
          {chunk}
        </span>
      ))}
    </span>
  );
}
