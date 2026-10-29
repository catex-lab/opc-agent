/**
 * 应用标记：**彩色徽章**（`build/logo-source.png` → `src/assets/app-logo.png`）。
 *
 * ## 2026-10-29：从「同人卦几何」换成「位图」
 *
 * 上一版这里用 `<svg>` 手画天火同人六爻，靠 `currentColor` 跟随主题
 * （浅色黑爻、深色白爻）。用户要求改用设计稿里的彩色徽章，于是这里只剩
 * 一个 `<img>` —— 位图没有 `currentColor`，也就没有「随主题反转」这件事了。
 *
 * 为什么不再需要明暗两套：
 *   源图自带**深蓝描边**，轮廓不依赖背景色。实测在 #FFFFFF / #1A1A1A /
 *   #808080 三种底色上都能读出来，深色底反而对比更强（白毛 vs 深底）。
 *   所以一张图吃两种主题，只在暗色下做一点点提亮，见 `index.css` 的
 *   `:root.dark [data-app-logo] img`。
 *
 * 为什么用 `<img>` 而不是把图内联成 SVG / base64：
 *   图由 Vite 处理（`import` 会产出带 hash 的 URL，进 `dist/assets`），
 *   随前端产物一起打包，不存在「打包态路径失效」的问题 —— 这正是
 *   TitleBar 那段注释里担心的情形（`build/` 不进 app.asar）。
 *
 * ⚠️ 18px 以下这个尺寸，彩色插画**只能看出「蓝环 + 白脸」**，胡须与瞳孔
 *   会被抗锯齿抹平（实测：16px 一团、24px 能辨五官、32px 起清晰）。
 *   这是位图的物理限制，不是缩放参数没调好。要更清楚只能换更简单的图形。
 */
import logoUrl from '../assets/app-logo.png';

export function AppLogo({ size = 16 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block', width: size, height: size }}
    />
  );
}
