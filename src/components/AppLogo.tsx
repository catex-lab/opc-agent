/**
 * 应用标记：**同人卦**（天火同人，周易第十三卦）六爻。
 *
 * 自上而下：上三爻为乾（☰，三实线）—— 主控、纲领；下三爻为离（☲，
 * 实-断-实）—— 众 Agent 各有所长、炎上汇聚，中虚为火。《彖》曰「唯君子
 * 为能通天下之志」：把本机多个 Agent 的意志连通，即这个应用的编排之事。
 *
 * 两种用法：
 *   • 界面内：`fill="currentColor"` 跟随 CSS color，明暗主题自动适配
 *     （TitleBar 把它放在黑白徽章上，色令牌见 index.css 的 --tc-logo-*）；
 *   • 独立文件：src/assets/app-logo.svg 与 public/favicon.svg 由
 *     scripts/make-icons.mjs 生成，内部用 prefers-color-scheme 明暗自适应
 *     （浅下黑、深下白）。
 *
 * ⚠️ 这里的几何常量与 scripts/make-icons.mjs 的 GEOM 是**两份手写实现**，
 *    scripts/verify-logo.mjs 有逐字段契约断言 —— 改一处必须改另一处，
 *    否则图标资产与界面标记会慢慢漂移（而这种漂移肉眼极难发现）。
 */

/** 标准几何（128 画布） */
const STD = { x0: 16, w: 96, stroke: 10, gap: 8, brokenGap: 14 };
/** 小尺寸变体：缺口加宽。16px 以下标准几何的断爻会被抗锯齿抹平 */
const WIDE = { stroke: 9, gap: 12, brokenGap: 16 };
const CANVAS = 128;
/** 六爻虚实：true = 阳爻（实线）。同人 = 上乾下离 */
const LINES = [true, true, true, true, false, true];

function lineRects(g: { x0: number; w: number; stroke: number; gap: number; brokenGap: number }) {
  const total = 6 * g.stroke + 5 * g.gap;
  const top = (CANVAS - total) / 2;
  const segW = (g.w - g.brokenGap) / 2;
  return LINES.map((solid, i) => {
    const y = top + i * (g.stroke + g.gap);
    return solid
      ? [[g.x0, y, g.w, g.stroke]]
      : [
          [g.x0, y, segW, g.stroke],
          [g.x0 + segW + g.brokenGap, y, segW, g.stroke],
        ];
  });
}

export function AppLogo({ size = 16 }: { size?: number }) {
  // ≤16px 切宽缺口几何：任务栏 16px、托盘 16px 场景「断」必须看得见
  const wide = size <= 16;
  const rects = lineRects(wide ? { ...STD, ...WIDE } : STD).flat();
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {rects.map(([x, y, w, h]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx={2} fill="currentColor" />
      ))}
    </svg>
  );
}
