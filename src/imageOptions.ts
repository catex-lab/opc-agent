/**
 * 生图选项（P4-4）。
 *
 * ⚠️ 这些常量与 `server/agents/adapters/image.ts` 里的**同源**。
 * 之所以在前端再写一份而不是从 server/ 导入：`server/` 下的模块属于后端层，
 * 前端直接 import 会把后端模块图拉进浏览器产物（今天是零依赖所以看着无害，
 * 但只要将来那个文件多一行 `import fs`，构建就会炸）。
 *
 * 因此这里选择「显式重复 + 用断言钉住」：`scripts/verify-image.ts` 会逐项
 * 比对两边是否一致，任何一边漂移都会让验证失败。
 */

export const IMAGE_SIZES = [
  '1024x1024',
  '1344x768',
  '768x1344',
  '1440x720',
  '1024x1536',
] as const;

export type ImageSizeOption = (typeof IMAGE_SIZES)[number];

/** 尺寸的中文说明，与后端 IMAGE_SIZE_LABELS 对齐 */
export const IMAGE_SIZE_LABELS: Record<string, string> = {
  '1024x1024': '正方形 1024×1024',
  '1344x768': '横版 1344×768',
  '768x1344': '竖版 768×1344',
  '1440x720': '宽屏 1440×720',
  '1024x1536': '长竖版 1024×1536',
};

export const DEFAULT_IMAGE_SIZE: ImageSizeOption = '1024x1024';

/**
 * 可选生图模型。
 *
 * 默认 flash：本机实测唯一**免费且立即可用**的模型。把需要付费资源包的
 * 模型放在默认位，会让新用户第一次点生图就撞上「余额不足」。
 */
export const IMAGE_MODELS: Array<{ id: string; name: string; note?: string }> = [
  { id: 'cogview-3-flash', name: 'CogView-3-Flash', note: '免费（带水印）' },
  { id: 'cogview-4', name: 'CogView-4', note: '更高质量，需资源包' },
  { id: 'cogview-3-plus', name: 'CogView-3-Plus', note: '需资源包' },
];

export const DEFAULT_IMAGE_MODEL = 'cogview-3-flash';
