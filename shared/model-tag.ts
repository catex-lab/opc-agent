/**
 * 模型角标的**语义分类**。
 *
 * 现状：`ModelTag = '免费' | '限时免费' | '付费'` 既是接口字段，也是直接上屏的
 * 文案。两处逻辑（浮层角标配色、目录排序）直接拿中文字面量做判断 ——
 * 一旦把标签翻译成英文，这两处判断就会静默失效。
 *
 * 这里把「判断依据」从文案里拆出来：逻辑只问 `modelTagKind()`，中文标签退回
 * 成纯展示值。这样后续翻译标签时，只需要换展示映射，不会改行为。
 *
 * 暂时保留中文标签作为 wire 值（不改 API/夹具），所以本文件是**唯一**允许
 * 出现这三个中文字面量的地方；新增判断请调函数，不要再写 `tag === '付费'`。
 */
export type ModelTagKind = 'free' | 'promo' | 'paid';

export function modelTagKind(tag: string | null | undefined): ModelTagKind | undefined {
  switch (tag) {
    case '免费':
      return 'free';
    case '限时免费':
      return 'promo';
    case '付费':
      return 'paid';
    default:
      return undefined;
  }
}
