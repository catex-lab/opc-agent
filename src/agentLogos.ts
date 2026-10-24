/**
 * Agent 官方 Logo 清单。
 *
 * 来源：https://asvg.app —— 每个条目的 `source` 字段记录了原始页面，
 * 便于日后核对版本或重新下载。
 *
 * 为什么用资源文件 + <img> 而不是把 path 内联进 JS：
 *   1. 这些是**彩色 logo**（gemini 5 色、doubao 3 色、workbuddy/codex 用渐变），
 *      内联成单条 path 并强制填充白色会丢掉品牌识别度；
 *   2. SVG 内部有 `url(#paint0_linear_...)` 这类渐变引用，若把多个 SVG
 *      内联进同一份 DOM，这些 id 会**互相冲突**，导致渲染串色。
 *      走 <img> 时每个 SVG 处于独立文档上下文，天然隔离；
 *   3. 浏览器可缓存，且支持任意 viewBox 与宽高比（object-fit 处理）。
 *
 * 商标归属各家厂商所有，此处仅用于标识对应的 Agent。
 */

import workbuddyLogo from './assets/agent-logos/workbuddy.svg';
import codexLogo from './assets/agent-logos/codex.svg';
import geminiLogo from './assets/agent-logos/gemini.svg';
import opencodeLogo from './assets/agent-logos/opencode.svg';
import claudeLogo from './assets/agent-logos/claude.svg';
import hermesLogo from './assets/agent-logos/hermes.svg';
import cursorLogo from './assets/agent-logos/cursor.svg';
import qoderLogo from './assets/agent-logos/qoder.svg';
import doubaoLogo from './assets/agent-logos/doubao.svg';
import zcodeLogo from './assets/agent-logos/zcode.svg';
import kimicodeLogo from './assets/agent-logos/kimicode.svg';
import traeLogo from './assets/agent-logos/trae.svg';
import piLogo from './assets/agent-logos/pi.png';
import antigravityLogo from './assets/agent-logos/antigravity.png';

export interface AgentLogo {
  /** Vite 解析后的资源地址 */
  src: string;
  /**
   * 底衬：
   *   'light' —— logo 本身透明或深色，需要浅色底才看得清
   *   'none'  —— logo 自带背景（圆角方块/渐变），直接铺满头像
   */
  tile: 'light' | 'none';
  /**
   * 图形的铺法：
   *   'contain' —— 居中留白，适合不规则图形
   *   'cover'   —— 铺满并裁成圆形，适合自带方形底的 logo
   */
  fit: 'contain' | 'cover';
  /** 品牌主色，用于兜底首字母色块与强调色 */
  hex: string;
  /** 原始页面，便于核对 */
  source: string;
}

/** key 与 Agent 的 id 对齐，前端按 id 直接取用 */
export const AGENT_LOGOS: Record<string, AgentLogo> = {
  workbuddy: {
    src: workbuddyLogo,
    // 自带青绿渐变圆角方块，铺满裁圆后本身就是一枚 app 图标
    tile: 'none',
    fit: 'cover',
    hex: '#0EC8A9',
    source: 'https://asvg.app/icons/workbuddy',
  },
  codex: {
    src: codexLogo,
    // 自带白色圆角方块 + 蓝紫渐变字形；放在浅色底上只剩字形，干净
    tile: 'light',
    fit: 'contain',
    hex: '#3941FF',
    source: 'https://asvg.app/icons/codex',
  },
  gemini: {
    src: geminiLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#3186FF',
    source: 'https://asvg.app/icons/gemini',
  },
  opencode: {
    src: opencodeLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#211E1E',
    source: 'https://asvg.app/icons/opencode',
  },
  claude: {
    src: claudeLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#D97757',
    source: 'https://asvg.app/icons/claude-code',
  },
  hermes: {
    src: hermesLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#5F5E5A',
    source: 'https://asvg.app/icons/hermes-agent',
  },
  cursor: {
    src: cursorLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#43413C',
    source: 'https://asvg.app/icons/cursor',
  },
  qoder: {
    src: qoderLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#2ADB5C',
    source: 'https://asvg.app/icons/qoder',
  },
  doubao: {
    src: doubaoLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#1E37FC',
    source: 'https://asvg.app/icons/doubao',
  },
  zcode: {
    src: zcodeLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#534AB7',
    source: 'https://asvg.app/icons/zcode',
  },
  kimicode: {
    src: kimicodeLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#1783FF',
    source: 'https://asvg.app/icons/kimi-code',
  },
  trae: {
    src: traeLogo,
    // A104：补上 Trae 的官方符号（绿色「C 形机脸 + 双菱形眼」）。
    // 之前 descriptor 里 `icon` 刻意留空、走首字母色块，是因为拿不到官方
    // 素材；现在从 asvg.app 取到官方 SVG（与 favicon 同色 #32F08C，
    // 已对照 trae.com.cn 的 favicon.png 核对过），不再需要那个兜底。
    //
    // 走 `light` 底衬而不是把 favicon 的深色底烤进去：项目里 11/13 个 logo
    // 都是这条路径（浅色底衬 + contain），绿色符号在浅底上与 qoder 同档，
    // 而一枚近黑圆点会是一片浅灰头像里最重的一块。官方深色版本见
    // trae.com.cn 的 favicon，品牌识别由符号本身承担。
    tile: 'light',
    fit: 'contain',
    hex: '#32F08C',
    source: 'https://asvg.app/icons/trae',
  },
  pi: {
    src: piLogo,
    // 单色 logomark（官方只提供 mono 版本），浅底才看得清
    tile: 'light',
    fit: 'contain',
    hex: '#3F3F46',
    source: 'https://asvg.app/icons/pi',
  },
  antigravity: {
    src: antigravityLogo,
    tile: 'light',
    fit: 'contain',
    hex: '#4285F4',
    source: 'https://asvg.app/icons/google-antigravity',
  },
};

/** 按 key 取 logo；取不到返回 undefined，由调用方走首字母兜底 */
export function getAgentLogo(icon?: string): AgentLogo | undefined {
  if (!icon) return undefined;
  return AGENT_LOGOS[icon];
}

/** 无 logo 时的兜底底色，按 id 稳定取色，保证同一个 Agent 每次颜色一致 */
const FALLBACK_PALETTE = [
  '#0052D9', '#0594FA', '#834EC2', '#0E7A5F',
  '#D54941', '#E37318', '#4B5EAA', '#B23A6B',
];

export function fallbackColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}
