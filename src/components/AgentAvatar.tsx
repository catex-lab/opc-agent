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
  color,
  size = 40,
  availability,
  showStatus = true,
}: AgentAvatarProps) {
  const logo = getAgentLogo(icon);
  const initial = (name || '?').trim().charAt(0).toUpperCase();

  // 状态点大小随头像等比缩放，最小 8px 以保证可见
  const dotSize = Math.max(8, Math.round(size * 0.26));
  const meta = availability ? AVAILABILITY_META[availability] : null;

  // 自带底衬的 logo 留白：太小会顶到圆边，太大会显得 logo 发虚
  const inset = logo && logo.tile === 'light' ? Math.round(size * 0.16) : 0;

  const surface = logo
    ? logo.tile === 'light'
      ? 'var(--agent-logo-tile)'
      : 'transparent'
    : color || fallbackColor(id);

  // 透明底衬的 logo 是浅色，深色主题下需要一圈浅描边勾轮廓；
  // 浅色底衬则相反，用深色细边把圆从同色背景里分出来
  const ring =
    logo?.tile === 'light'
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
        style={{
          backgroundColor: surface,
          boxShadow: ring,
          // 显式钉死为浅色配色方案：hermes / zcode / qoder 的官方 SVG 用
          // currentColor，而 <img> 里的 SVG 是按**嵌入元素**的 color-scheme
          // 解析 currentColor 的。一旦将来有人给 .dark 加上 color-scheme: dark，
          // 这三个 logo 会悄悄变成白色，在浅色底衬上直接消失。
          colorScheme: 'light',
        }}
      >
        {logo ? (
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

      {showStatus && meta && (
        <span
          className="absolute rounded-full"
          style={{
            width: dotSize,
            height: dotSize,
            right: -1,
            bottom: -1,
            backgroundColor: meta.dot,
            border: '2px solid var(--td-bg-color-container)',
          }}
        />
      )}
    </div>
  );
}
