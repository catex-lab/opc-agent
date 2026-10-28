/**
 * 模型选择浮层（A73）。
 *
 * 用户要求「把对话框里的模型选择框设计成如图所示的样式」。截图规格四条：
 *   1. 标题栏「内置模型」+ 一个 ⓘ；
 *   2. 每行 = 字标图标 + 名称 + 角标（免费/限时免费/付费）+ 右侧计费倍率；
 *   3. 选中行右侧一个 ✓；
 *   4. 底部一条通栏「添加模型」。
 *
 * ## 为什么不用 TDesign `<Select>`
 *
 * 原来是 `<Select popupProps={{overlayInnerStyle:{width:340}}}>` + `<Select.Option>`。
 * 那套能做出「名称 + 角标 + 倍率」，但做不出截图里的三样东西：
 *   · **标题栏**：Select 的浮层第一件东西就是选项列表，塞不进一行标题 + ⓘ；
 *   · **底部通栏按钮**：同理，浮层末尾挂一条通栏要么被 Option 的 padding 挤变形，
 *     要么跟着列表一起滚（截图里它是钉在底边的）；
 *   · **选中行的 ✓**：Select 选中态是整行换品牌色，截图是「行内右侧一枚 ✓」，
 *     两者语义不同（后者在行很宽时也能一眼看到选的是哪条）。
 * 所以换成自绘 portal 浮层，写法与附件菜单（`data-attach-menu`）一致。
 *
 * ## 字标图标（A93 已移除）
 *
 * 原来每行左侧有一枚「首字母方块」。它**刻意不上品牌色**，因为 `Model` 类型
 * 只有 `providerName`，没有厂商品牌色字段 —— 按名字哈希出一个颜色看起来像
 * 品牌色但其实不是，用户会拿它去对照官网。
 *
 * 但即便用中性色，这个方块仍然是个**假字标**：同一 provider 下的模型首字母
 * 全一样（OpenCode 的 90+ 条模型都是「O」），既不能区分行，又要占 28px 宽。
 * A93 按用户要求去掉，行的信息层级变成「模型名 → 厂商名 → 倍率」三级，
 * 面板宽度也随之从 340 收到 272。
 *
 * ## 诚实边界
 *
 * · 「添加模型」**不是**在这里新建模型，而是跳「设置 → 模型清单」去刷新枚举。
   浮层里能选的只有厂商已经报上来的模型；摆一个「新增模型」表单是假控件。
 * · 没有 `models` 时调用方根本不渲染本组件（Agent 自己管模型，见 ChatInput）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Info, Plus } from 'lucide-react';
import { Tooltip } from 'tdesign-react';
import type { Model } from '../types';

export interface ModelSelectPopupProps {
  models: Model[];
  value: string;
  onChange: (modelId: string) => void;
  onClose: () => void;
  /** 「添加模型」：去设置页刷新模型清单 */
  onAddModel: () => void;
  /** 触发器的几何：浮层贴在它上方，左边缘对齐 */
  anchor: { left: number; top: number; width: number };
}

/** 面板宽度。
 *
 * A93：340 → 272。原来 340 是按「首字母方块 + 名称 + 角标 + 倍率」四段排的，
 * 去掉方块之后右侧空出近三分之一，一行里有一半是空气。272 是「最长模型名
 * 不被截断」的实测值（DeepSeek V4 Flash Free + 免费角标 + 倍率 + ✓ 共约
 * 250px，另留 20px 余量）；再窄长名就要吃省略号了。
 *
 * A141：272 → 300。上面那句「272 够用」是按当时的模型名估的，**实测不成立**：
 * `DeepSeek-V4.1-Flash (sg)` 那一行（名称 + 付费角标 + 0.03x + ✓）在 272 下
 * `scrollWidth > clientWidth`，名字被截成「DeepSeek-V4.1-Flas…」。
 * 真实清单里最长的还有 `senssenova-6.8-flash-lite`。300 是让这两条都完整
 * 显示的最小值（逐 4px 试出来的），不是拍脑袋的整数。
 *
 * ⚠️ 不要改成「按内容自适应」：浮层是浮在输入区上方的，宽度一跳，
 * 旁边的眼睛会跟着跳（A138 同一条教训：外框不跟内容伸缩）。 */
const PANEL_WIDTH = 300;
/** 列表最高这么高就自己滚，别把输入区顶出屏幕 */
const LIST_MAX_HEIGHT = 320;

/** 角标配色：免费/限时免费 = 成功色，付费 = 中性灰（付费不是坏事，不用警告色） */
function tagStyle(tag: NonNullable<Model['tag']>): React.CSSProperties {
  return tag === '付费'
    ? { color: 'var(--td-text-color-placeholder)', backgroundColor: 'var(--td-bg-color-component)' }
    : { color: 'var(--td-success-color)', backgroundColor: 'var(--td-success-color-1)' };
}

/**
 * 取字标字母：**A93 起不再使用**（浮层里已去掉首字母方块，理由见行内注释）。
 * 保留函数会误导后来者以为还有一处在用，所以直接删掉；这里留一行说明，
 * 免得有人从历史里翻出来又加回去。
 */

export function ModelSelectPopup({
  models,
  value,
  onChange,
  onClose,
  onAddModel,
  anchor,
}: ModelSelectPopupProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘游标：进浮层时落在当前选中项上（没有选中就落第一项）。
  // 原来 TDesign Select 自带方向键 + 回车，换成自绘后这部分能力不能丢，
  // 否则「只能用鼠标」是一次静默的可用性回退。
  const [cursor, setCursor] = useState(() => {
    const i = models.findIndex(m => m.modelId === value);
    return i >= 0 ? i : 0;
  });

  // 打开时把选中项滚进可见区（列表可能很长，opencode 一家就 90+ 条）
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-model-row="1"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  // 点外面关掉。挂在 document 上而不是 panel 的 onBlur —— panel 里没有可聚焦
  // 表单元素，blur 链不可靠；附件菜单用的是同一套写法。
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      onClose();
    };
    // 用 pointerdown 而不是 click：click 要等松开，期间浮层还挂着，
    // 用户会看到「点了没反应」再到下一步才消失。
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor, onClose]);

  // Esc 关掉。方向键移动游标，回车确认。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(c => {
          const next = e.key === 'ArrowDown' ? c + 1 : c - 1;
          return Math.max(0, Math.min(models.length - 1, next));
        });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const m = models[cursor];
        if (m) onChange(m.modelId);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cursor, models, onChange, onClose]);

  // 左边缘对齐触发器，但不越过右边界
  const left = useMemo(() => {
    const max = window.innerWidth - PANEL_WIDTH - 12;
    return Math.max(12, Math.min(anchor.left, max));
  }, [anchor.left]);
  // 贴在触发器上方（底部工具栏在屏幕底部，向上开）
  const bottom = window.innerHeight - anchor.top + 6;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="内置模型"
      data-model-popup
      className="opc-choice-panel fixed z-[60] flex flex-col overflow-hidden rounded-xl shadow-popup"
      style={{
        left,
        bottom,
        width: PANEL_WIDTH,
        border: '1px solid var(--tc-edge-strong)',
      }}
      onPointerDown={e => e.preventDefault()}
    >
      {/* ── 标题栏 ── */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--tc-divider)' }}
      >
        <span className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          内置模型
        </span>
        <Tooltip
          content={
            <span style={{ fontSize: 'var(--text-secondary)', lineHeight: 1.6 }}>
              这里只列当前 Agent 已经报上来的模型。
              <br />
              清单由各厂商官方接口提供，装好 CLI 后点下方「添加模型」去设置里刷新。
            </span>
          }
          theme="light"
        >
          <Info size={13} style={{ color: 'var(--td-text-color-placeholder)' }} data-model-popup-info />
        </Tooltip>
        <span className="ml-auto text-caption tabular-nums" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {models.length}
        </span>
      </div>

      {/* ── 列表 ── */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto py-1"
        style={{ maxHeight: LIST_MAX_HEIGHT }}
        data-model-popup-list
      >
        {models.map((m, i) => {
          const selected = m.modelId === value;
          return (
            <button
              key={m.modelId}
              type="button"
              role="option"
              aria-selected={selected}
              data-model-row={selected ? '1' : '0'}
              data-model-id={m.modelId}
              onClick={() => onChange(m.modelId)}
              onMouseEnter={() => setCursor(i)}
              /* A75：三件事一次对齐。
               *
               * 1. 悬停底色从 --td-bg-color-component-hover(#eeeeee) 换成
               *    --tc-fill-hover —— 那是**第二套灰**，和自绘菜单行、
               *    权限下拉的行不是一个颜色，同一屏并排能看出来。
               * 2. 选中行补上底色（--tc-fill-selected）。原来这里只有
               *    「文字变品牌色 + 右侧 ✓」，全应用只有这一处弹层的选中行
               *    没有填充，正是用户说的「选中回显态填充色不一致」。
               * 3. 行改成左右内缩 4px + 圆角，与 menuItem.ts 那套菜单行同
               *    外形；否则全宽的直角底色会在浮层的圆角处溢出。 */
              className="mx-1 flex w-[calc(100%_-_8px)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
              style={{
                backgroundColor: selected
                  ? 'var(--tc-fill-selected)'
                  : i === cursor
                    ? 'var(--tc-fill-hover)'
                    : 'transparent',
                color: selected ? 'var(--td-brand-color)' : 'var(--td-text-color-primary)',
              }}
            >
              {/* A93：这一格原来是「provider 首字母方块」。去掉的理由不是审美 ——
                  它是一个**假字标**：`Model` 只有 `providerName`，没有品牌色字段，
                  方块里的字母既不来自厂商也不来自模型名，用户会拿它当品牌标识去对照
                  官网。同一列里 OpenCode 的 90 多个模型全是同一个「O」，区分度为零，
                  却占了 20px + 8px 间距。现在左侧直接是模型名。 */}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-body leading-5">{m.name}</span>
                  {m.tag && (
                    <span
                      className="shrink-0 rounded px-1 text-caption"
                      style={tagStyle(m.tag)}
                    >
                      {m.tag}
                    </span>
                  )}
                </span>
                {m.providerName && (
                  <span
                    className="block truncate text-caption leading-4"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    {m.providerName}
                  </span>
                )}
              </span>

              {/* 倍率右对齐：与官方菜单同款位置，不混进说明文字 */}
              {m.multiplier && (
                <span
                  className="shrink-0 pl-2 text-caption tabular-nums leading-4"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                >
                  {m.multiplier}
                </span>
              )}

              {selected && (
                <Check size={14} className="shrink-0" style={{ color: 'var(--td-brand-color)' }} />
              )}
            </button>
          );
        })}
      </div>

      {/* ── 底部通栏 ── */}
      <div className="shrink-0 p-2" style={{ borderTop: '1px solid var(--tc-divider)' }}>
        <button
          type="button"
          data-model-popup-add
          onClick={onAddModel}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-primary)' }}
        >
          <Plus size={14} />
          添加模型
        </button>
      </div>
    </div>,
    document.body
  );
}
