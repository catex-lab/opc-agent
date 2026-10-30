/**
 * 答案正文的排版净化（A149）。
 *
 * 用户口径：「正文排版**禁止使用 emoji 表情**」。这句话只能在这一层兑现 ——
 * emoji 是模型自己吐出来的，每个 Agent CLI 各有各的系统提示，OPC 改不到
 * 人家的提示词。渲染层兜底才是确定的：不管哪家模型吐了什么，屏幕上都不出现。
 *
 * ## 三条边界（缺一条就会误伤）
 *
 * 1. **代码块整段不动**。`console.log('✅')` 是程序的一部分，删掉就改了代码，
 *    用户复制出去会直接报错。
 * 2. **行内 code 不动**。同上，只是范围小 —— `--ok "✅"` 这种命令行参数很常见。
 * 3. **标点不算 emoji**。`→ · ± ✓ ✗ ★ ☆ — … ①` 都不是 Extended_Pictographic，
 *    本来就不会被匹配；`© ® ™` 虽然**是** Extended_Pictographic，但它们是
 *    版权/商标符号，删掉会把「© 2026 OPC Agent」变成「 2026 …」，所以显式放行。
 *
 * ## 为什么用 `\p{Extended_Pictographic}` 而不是画码位区间
 *
 * 码位区间（`\u{1F300}-\u{1FAFF}` 之类）永远补不全：旗帜是 `\p{Regional_Indicator}`、
 * 肤色修饰符是 `\p{Emoji_Modifier}`、组合表情靠 `\u200D` 串起来、键帽是
 * `1\uFE0F\u20E3`。属性转义把这些都交给 Unicode 数据表，Node 22 与 Chrome
 * 都已支持（实测 📰😊✅❌🔍👍🏽👨‍💻🇨🇳 全部命中，✓✗★→·± 全部不命中）。
 */

/** 一段 emoji 序列：基础图形 + 可选变体选择符 + 可选肤色 + 任意个 ZWJ 组合 */
const EMOJI_SEQ =
  '(?![\\u00A9\\u00AE\\u2122])' +
  '(?:' +
  '[\\p{Extended_Pictographic}\\p{Regional_Indicator}]' +
  '[\\uFE0F\\uFE0E]?' +
  '\\p{Emoji_Modifier}?' +
  '(?:\\u200D[\\p{Extended_Pictographic}][\\uFE0F\\uFE0E]?\\p{Emoji_Modifier}?)*' +
  ')' +
  // 键帽：1️⃣ #️⃣ *️⃣ —— 基础字符是 ASCII，只能用这个形状单独匹配
  '|[0-9#*]\\uFE0F\\u20E3';

/**
 * emoji **连同它后面的空格**一起删。
 *
 * 只删 emoji 会在行首留一个孤立空格：`📰 最新官方发布` → ` 最新官方发布`，
 * 渲染出来是「段首莫名缩进一格」。带上尾随空格之后变成 `最新官方发布`。
 * 不吃**前面**的空格：那会把 `这是 📰重要` 变成 `这是重要`（中文没事，
 * 英文 `see 📰here` 会粘成一个词）。
 */
const EMOJI_WITH_TRAILING_SPACE = new RegExp(`(?:${EMOJI_SEQ})[ \\t]*`, 'gu');

/** 代码块 / 行内 code —— 这两类整段原样保留 */
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * 去掉文本里的 emoji 表情，代码块与行内 code 原样保留。
 *
 * 纯函数、无副作用，可单独测（`verify:a149` 有 12 条断言钉着）。
 */
export function stripEmoji(text: string): string {
  if (!text) return text;
  // 按代码片段切开，奇数下标是代码 —— 只处理偶数下标（普通文本）
  const parts = text.split(CODE_SPAN);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!.replace(EMOJI_WITH_TRAILING_SPACE, '');
  }
  return parts.join('');
}

export default stripEmoji;
