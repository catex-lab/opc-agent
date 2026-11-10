/**
 * 「近中性色」判据（共享给 verify-a84 / verify-a115-ui 等视觉闸门）。
 *
 * ## 为什么不是 r === g === b
 *
 * 设计系统的主文字/填充色是**带轻微冷色偏的石墨灰**，不是纯中性：
 *   - 深色正文 `rgb(15, 17, 21)`（#0F1115，`--tc-fill-*` 同源）
 *   - 浅色正文 `rgb(249, 250, 251)`（#F9FAFB）
 * 两者的 R/G/B 各差 1~2，肉眼完全看不出色相，但严格相等判据会把它们
 * 一律判成「彩色」，于是「权限图标黑白化」这条闸门长期假红（a84 0/4、
 * a115-ui 0/4），而同一份日志里「深色底对比度 17.45:1」却是绿的 ——
 * 产品要求本来就满足，是判据把「近中性」误判成「有颜色」。
 *
 * ## 判据：色度（chroma）= 最大通道 − 最小通道
 *
 * 纯中性 chroma = 0；上面两个设计令牌 chroma = 6 / 2；任何肉眼可辨的
 * 彩色都远高于此（品牌绿 #0EC8A9 = 186、Claude 橙 #D97757 = 130）。
 * 阈值取 8：覆盖设计系统全部中性灰并留 2 点余量，同时离真彩色很远。
 * 这个阈值不是「为了变绿而放水」—— 每条使用它的闸门都必须配一条
 * 反向探针，喂已知彩色值断言仍判 false。
 */
export const NEUTRAL_TOLERANCE = 8;

/** 返回色度；无法解析（transparent / 空 / 通道不足）时返回 null */
export function chromaOf(cssColor) {
  if (!cssColor || typeof cssColor !== 'string') return null;
  const s = cssColor.trim();
  if (s === 'transparent') return null;
  const nums = s.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return null;
  const [r, g, b] = nums.slice(0, 3).map(Number);
  if (![r, g, b].every(Number.isFinite)) return null;
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** 近中性：色度不超过阈值。腐败输入一律 false，不许静默通过 */
export function isNearNeutral(cssColor, tolerance = NEUTRAL_TOLERANCE) {
  const c = chromaOf(cssColor);
  return c !== null && c <= tolerance;
}
