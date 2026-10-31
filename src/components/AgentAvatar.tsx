import { getAgentLogo, fallbackColor } from '../agentLogos';
import { AVAILABILITY_META, type AgentAvailability } from '../types';

/**
 * Agent 头像。
 *
 * 渲染策略按「官方 logo 是否自带背景」分两种：
 *
 *   1. logo 自带背景（如 workbuddy 的渐变圆角方块）
 *      → 直接铺满圆形，object-fit: cover，不加任何底衬。
 *        圆形裁切后本身就是一枚 app 图标，视觉最干净。
 *
 *   2. logo 是透明底的彩色字形（gemini 五色、doubao 三色、claude 橙、
 *      cursor 立体方块……）
 *      → 垫一层浅色底衬 + 留出内边距，object-fit: contain。
 *        底衬必须**在两个主题下都是浅色**，否则 hermes / zcode / qoder
 *        这类用 `currentColor` 的 logo 在 <img> 里会解析成纯黑，遇到
 *        深色底衬就彻底看不见了。
 *
 * 没有 logo 的 Agent 退化成「品牌色圆 + 首字母」，与上面两种仍是同一套
 * 圆形容器语言，不会显得残缺。
 */

interface AgentAvatarProps {
  /** Agent 标识，用于稳定取兜底色 */
  id: string;
  /** 展示名，用于取首字母 */
  name: string;
  /** logo 标识，对应 AGENT_LOGOS 的键 */
  icon?: string;
  /**
   * A160：用户自己上传的 Logo URL。有值时**完全覆盖** icon，
   * 圆形 cover 铺满 + 主题描边；恢复默认后这个值变空，自动退回 icon。
   */
  src?: string;
  /** 覆盖品牌色（用户自定义或后端下发） */
  color?: string;
  size?: number;
  /** 传了就在右下角显示在线状态点 */
  availability?: AgentAvailability;
  /** 是否显示状态点（默认 true，仅当传了 availability 时生效） */
  showStatus?: boolean;
}

export function AgentAvatar({
  id,
  name,
  icon,
  src,
  color,
  size = 40,
  availability,
  showStatus = true,
}: AgentAvatarProps) {
  const customSrc = src?.trim();
  const logo = getAgentLogo(icon);
  const initial = (name || '?').trim().charAt(0).toUpperCase();

  // 状态点大小随头像等比缩放，最小 8px 以保证可见
  const dotSize = Math.max(8, Math.round(size * 0.26));
  const meta = availability ? AVAILABILITY_META[availability] : null;

  /**
   * 状态点的**外切偏移**：让圆点贴着头像圆边摆，不压在头像上。
   *
   * 去掉描边之后暴露了一个新问题：WorkBuddy 的 logo 本身就是绿色，
   * 在线绿点压在它右下角等于消失（截图实测：完全看不见）。
   * 描边原本就是用来「切」出这个边界的，既然不能用描边，就改位置 ——
   * 把圆点挪到圆的外侧，让它的边缘与头像圆相切：
   *
   *     圆心到点心的距离 = R + r（R = size/2，r = dotSize/2）
   *     对角线方向各分量 = (R + r) / √2
   *     点的右/下边距 = 该分量 − R + r
   *
   * 结果：圆点 100% 落在头像之外，底色是行背景（浅灰），
   * 无论 logo 什么颜色都看得清，而且不需要任何描边。
   */
  const dotGap =
    (size + dotSize) / (2 * Math.SQRT2) - size / 2 + dotSize / 2;

  // 自带底衬的 logo 留白：太小会顶到圆边，太大会显得 logo 发虚
  const inset = logo && logo.tile === 'light' ? Math.round(size * 0.16) : 0;

  const surface = customSrc
    ? 'var(--agent-logo-tile)'
    : logo
      ? logo.tile === 'light'
        ? 'var(--agent-logo-tile)'
        : 'transparent'
      : color || fallbackColor(id);

  // 透明底衬的 logo 是浅色，深色主题下需要一圈浅描边勾轮廓；
  // 浅色底衬则相反，用深色细边把圆从同色背景里分出来
  const ring = customSrc
    ? 'inset 0 0 0 1px var(--agent-logo-tile-ring)'
    : logo?.tile === 'light'
      ? 'inset 0 0 0 1px var(--agent-logo-tile-ring)'
      : 'inset 0 0 0 1px rgba(255,255,255,0.14)';

  return (
    <div
      className="relative shrink-0 select-none"
      style={{ width: size, height: size }}
      title={`${name}${meta ? ` · ${meta.label}` : ''}`}
    >
      <div
        className="h-full w-full overflow-hidden rounded-full"
        // 打靶钩子：verify-surface 要能单独认出「这是 Agent 头像」并把它列进
        // 实色块白名单（logo 保留原色是有意为之，不是漏改）
        data-agent-avatar
        style={{
          backgroundColor: surface,
          boxShadow: ring,
          // A26：品牌 logo 只降 15%，不改成淡底。
          //
          // 用户头像那种「淡底 + 同色图标」的做法在这里不适用：WorkBuddy 的绿、
          // Claude 的橙是它们的**身份**，改成淡底会毁掉「一眼认出是谁」。
          // 这类块的性质是内容而不是装饰 —— 不会因为「要透明」就把用户发的
          // 图片调透明，同理也不该把 logo 调没。
          //
          // 0.85 是为了让它跟周围已经虚化的表面协调，不是为了让「看不见它」。
          // 非玻璃模式下 --tc-logo-alpha 是 1，等于没改。
          opacity: 'var(--tc-logo-alpha, 1)',
          // 显式钉死为浅色配色方案：hermes / zcode / qoder 的官方 SVG 用
          // currentColor，而 <img> 里的 SVG 是按**嵌入元素**的 color-scheme
          // 解析 currentColor 的。一旦将来有人给 .dark 加上 color-scheme: dark，
          // 这三个 logo 会悄悄变成白色，在浅色底衬上直接消失。
          colorScheme: 'light',
        }}
      >
        {customSrc ? (
          <img
            src={customSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            data-agent-avatar-image
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              // 用户上传的图按圆形裁切铺满：头像位是固定方框，留白会让
              // 不同尺寸的原图看起来大小不一
              objectFit: 'cover',
            }}
          />
        ) : logo ? (
          <img
            src={logo.src}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              objectFit: logo.fit,
              // padding 落在 img 的 border box 内，object-fit 作用于 content box，
              // 因此「留白 + 居中」一次搞定，不需要额外的 wrapper
              padding: inset,
            }}
          />
        ) : (
          <span
            className="flex h-full w-full items-center justify-center font-semibold text-white"
            style={{ fontSize: Math.round(size * 0.42), lineHeight: 1 }}
          >
            {initial}
          </span>
        )}
      </div>

      {/* 状态点：**不描边**，靠「外切定位」保证可辨识。
       *
       * 原先这里有一圈 `2px solid var(--td-bg-color-container)`，作用是把圆点
       * 从头像边缘「切」出来 —— 但代价是圆点看起来像贴了一枚带白边的贴纸，
       * 尤其在玻璃态下，那圈描边是实色，透出来的桌面在它旁边会被硬生生挡住，
       * 像一圈小补丁。用户明确要求去掉。
       *
       * 去掉描边后靠两点保证可辨识：
       *   1. 位置在头像圆**外侧**且与圆相切（见上面 dotGap 的推导）——
       *      底色是行背景而不是 logo，绿点压在绿色 logo 上消失的问题没有了；
       *   2. 颜色本身是饱和的语义色（在线绿 / 未登录橙 / 故障红）。
       * 未接入类的灰点（#C6C6C6）在浅色下偏淡，但它对应的是「这个 Agent 不可用」，
       * 弱一点反而符合语义，不需要再加回来。 */}
      {showStatus && meta && (
        <span
          className="absolute rounded-full"
          data-status-dot
          data-status={meta.label}
          style={{
            width: dotSize,
            height: dotSize,
            right: -dotGap,
            bottom: -dotGap,
            backgroundColor: meta.dot,
          }}
        />
      )}
    </div>
  );
}
