/**
 * 模型选择浮层（A73）。
 *
 * 需求「把对话框里的模型选择框设计成如图所示的样式」。截图规格四条：
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
 * A93 按需求去掉，行的信息层级变成「模型名 → 厂商名 → 倍率」三级，
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
  /**
   * 只读清单（A151）。
   *
   * 这份清单是从 Agent **自己的配置**里读出来的（目前只有 ZCode），
   * 本应用改不了它 —— 所以能看、能知道现在用的是哪个，但点了不会改。
   * 只读时：行不可点、没有 ✓、底部不出现「添加模型」，改成一句解释。
   */
  readonly?: boolean;
  /** 只读时底部那句解释（后端随清单一起给） */
  note?: string;
  /** 只读时高亮「当前用的是哪一条」 */
  currentId?: string;
  /**
   * 「未验证」模型被点击时先标定一次（A151 / P2）。
   *
   * 为什么不在打开菜单时就批量标定：一条要真起一次 CLI、最长 60s，
   * 十几条就是十几分钟，用户只会看到菜单卡死。改成**点了才验**：
   * 通过就选中，不通过就当场告诉他 CLI 的原话，并且不写进会话。
   *
   * 不传时按「未验证也可直接选」处理（老调用点）。
   */
  onSelectUnverified?: (modelId: string) => Promise<{
    ok: boolean;
    message?: string;
    /**
     * 标定结论。手动模式（P3）要靠它区分两种失败：
     * `invalid` = CLI 明确说没这个名字 → 不许选中；
     * `unknown` = CLI 没给出可判读的回应（超时 / 没装 / 没登录）→
     * 允许用户点「仍然使用」，否则像 claude 这种本机缺二进制的
     * Agent 永远填不进任何模型。
     */
    verdict?: 'ok' | 'routed' | 'invalid' | 'unknown';
  }>;
  /**
   * 手动填模型名模式（P3）。
   *
   * 这一类 Agent（gemini / claude / pi / antigravity / kimicli）接受 `--model`
   * 但没有枚举命令，所以没有列表可点 —— 浮层整块换成「输入框 + 确认」。
   * 与 `readonly` 互斥：只读是「看得到、改不了」，手动是「看不到、能改」。
   */
  manual?: boolean;
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
  readonly = false,
  note,
  currentId,
  onSelectUnverified,
  manual = false,
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

  /** 正在标定的那一条（A151）。同一条在标定期间不接受第二次点击 */
  const [verifying, setVerifying] = useState<string | null>(null);
  /** 标定失败的提示：CLI 的原话，不是我们改写过的解释 */
  const [verifyError, setVerifyError] = useState('');

  /* ── 手动模式（P3）的状态 ──
     这一类 Agent 没有列表，浮层里只有一个输入框。填完先标定一次：
     通过就写进会话；CLI 明确说没这个名字就不许选；CLI 没回应（超时/没装）
     则允许用户点「仍然使用」自己拍板 —— 三种结论的处置必须分开，
     否则像 claude 本机缺 native binary 的情况会被永久锁死。 */
  const [manualValue, setManualValue] = useState(value || '');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMsg, setManualMsg] = useState('');
  const [manualCanForce, setManualCanForce] = useState(false);

  const confirmManual = async () => {
    const v = manualValue.trim();
    if (!v || manualBusy) return;
    if (!onSelectUnverified) {
      onChange(v);
      return;
    }
    setManualBusy(true);
    setManualMsg('');
    setManualCanForce(false);
    try {
      const r = await onSelectUnverified(v);
      if (r.ok) {
        onChange(v);
        return;
      }
      setManualMsg(r.message || 'CLI 没有确认这个模型名');
      setManualCanForce(r.verdict === 'unknown');
    } finally {
      setManualBusy(false);
    }
  };

  const pick = async (m: Model) => {
    if (readonly || verifying) return;
    if (m.verified === false && onSelectUnverified) {
      setVerifying(m.modelId);
      setVerifyError('');
      try {
        const r = await onSelectUnverified(m.modelId);
        if (r.ok) onChange(m.modelId);
        else setVerifyError(r.message || '该模型在本机不可用');
      } finally {
        setVerifying(null);
      }
      return;
    }
    onChange(m.modelId);
  };

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
        // 只读清单没有「确认」这个动作 —— 回车什么也不做，
        // 否则用户会以为选中了（实际什么都没发生）。
        if (readonly) return;
        const m = models[cursor];
        if (m) void pick(m);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // pick 依赖 verifying / onSelectUnverified，一并列进来
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, models, onChange, onClose, readonly, verifying, onSelectUnverified]);

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
      aria-label={manual ? '指定模型' : '内置模型'}
      data-model-popup
      data-model-popup-manual={manual ? '1' : '0'}
      className="opc-choice-panel fixed z-[60] flex flex-col overflow-hidden rounded-xl shadow-popup"
      style={{
        left,
        bottom,
        width: PANEL_WIDTH,
        border: '1px solid var(--tc-edge-strong)',
      }}
      /* 手动模式下不能拦 pointerdown —— 拦了输入框就永远拿不到焦点，
         整个浮层变成一块点不动的图。只读/列表模式才拦（那是为了不抢
         输入框的焦点）。 */
      onPointerDown={manual ? undefined : e => e.preventDefault()}
    >
      {/* ── 标题栏 ── */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--tc-divider)' }}
      >
        <span className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {manual ? '指定模型' : '内置模型'}
        </span>
        <Tooltip
          content={
            <span style={{ fontSize: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {manual ? (
                <>
                  这个 Agent 没有列出模型的命令，但它接受 --model。
                  <br />
                  填一个模型名，会先跑一次确认 CLI 认不认这个名字。
                </>
              ) : (
                <>
                  这里只列当前 Agent 已经报上来的模型。
                  <br />
                  清单由各厂商官方接口提供，装好 CLI 后点下方「添加模型」去设置里刷新。
                </>
              )}
            </span>
          }
          theme="light"
        >
          <Info size={13} style={{ color: 'var(--td-text-color-placeholder)' }} data-model-popup-info />
        </Tooltip>
        <span className="ml-auto text-caption tabular-nums" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {manual ? '手动' : models.length}
        </span>
      </div>

      {manual ? (
        /* ── 手动模式（P3）：输入框 + 确认 ──
           没有列表可点，所以整块换掉。填完先标定一次：通过才写进会话，
           CLI 明确说没这个名字就不许选，CLI 没回应则由用户自己拍板。 */
        <div className="px-3 py-2.5" data-model-manual-form>
          <label
            className="mb-1 block text-caption"
            style={{ color: 'var(--td-text-color-secondary)' }}
            htmlFor="opc-manual-model"
          >
            模型名（原样传给 CLI 的 --model）
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="opc-manual-model"
              data-model-manual-input
              value={manualValue}
              onChange={e => setManualValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void confirmManual();
                }
              }}
              placeholder="例如 gemini-2.5-pro"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg px-2 text-body outline-none"
              style={{
                height: 'var(--tc-btn-height)',
                border: '1px solid var(--tc-edge-strong)',
                backgroundColor: 'var(--tc-surface-content)',
                color: 'var(--td-text-color-primary)',
              }}
            />
            <button
              type="button"
              data-model-manual-confirm
              disabled={manualBusy || !manualValue.trim()}
              onClick={() => void confirmManual()}
              className="tc-btn-brand shrink-0"
            >
              {manualBusy ? '确认中…' : '确认'}
            </button>
          </div>
          {manualMsg && (
            <p
              className="mt-1.5 text-caption leading-4"
              style={{ color: manualCanForce ? 'var(--td-warning-color)' : 'var(--td-error-color)' }}
              data-model-manual-msg
            >
              {manualMsg}
            </p>
          )}
          {manualCanForce && (
            <button
              type="button"
              data-model-manual-force
              onClick={() => onChange(manualValue.trim())}
              className="mt-1.5 w-full rounded-lg py-1.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              仍然使用这个名称
            </button>
          )}
        </div>
      ) : (
        <>
      {/* ── 列表 ── */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto py-1"
        style={{ maxHeight: LIST_MAX_HEIGHT }}
        data-model-popup-list
      >
        {models.map((m, i) => {
          /* 只读时「选中」的语义换成「当前用的是这条」：`value` 是会话里
             真正要传给 CLI 的模型，只读清单根本没有那个值（传下去也不生效），
             所以这里高亮的是 Agent 自己配置里最近用过的那一条。 */
          const isCurrent = readonly && !!currentId && m.modelId === currentId;
          const selected = readonly ? isCurrent : m.modelId === value;
          return (
            <button
              key={m.modelId}
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={readonly || undefined}
              data-model-row={selected ? '1' : '0'}
              data-model-id={m.modelId}
              data-model-readonly={readonly ? '1' : '0'}
              data-model-current={isCurrent ? '1' : '0'}
              onClick={readonly ? undefined : () => void pick(m)}
              onMouseEnter={() => setCursor(i)}
              /* A75：三件事一次对齐。
               *
               * 1. 悬停底色从 --td-bg-color-component-hover(#eeeeee) 换成
               *    --tc-fill-hover —— 那是**第二套灰**，和自绘菜单行、
               *    权限下拉的行不是一个颜色，同一屏并排能看出来。
               * 2. 选中行补上底色（--tc-fill-selected）。原来这里只有
               *    「文字变品牌色 + 右侧 ✓」，全应用只有这一处弹层的选中行
               *    没有填充，正是原话里的「选中回显态填充色不一致」。
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
                // 只读行的鼠标形态要跟着变 —— 手型光标本身就是「点了会生效」的承诺
                cursor: readonly ? 'default' : 'pointer',
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
                  {/* A151：官方清单里有、本机还没打过的那些。
                      不标出来，用户会以为「列出来就是能用」——而实测
                      `Qwen3.7-Plus` 会被 CLI 静默换成别的模型。 */}
                  {m.verified === false && (
                    <span
                      className="shrink-0 rounded px-1 text-caption"
                      style={{
                        color: 'var(--td-text-color-placeholder)',
                        backgroundColor: 'var(--td-bg-color-component)',
                      }}
                      data-model-unverified
                    >
                      {verifying === m.modelId ? '验证中…' : '未验证'}
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

              {isCurrent ? (
                /* 只读时不用 ✓（✓ 表示「已选中并会生效」），改用「当前」两个字：
                   它陈述的是事实，不承诺任何动作。 */
                <span
                  className="shrink-0 rounded px-1 text-caption"
                  style={{ color: 'var(--td-text-color-secondary)', backgroundColor: 'var(--td-bg-color-component)' }}
                  data-model-current-tag
                >
                  当前
                </span>
              ) : !readonly && selected ? (
                <Check size={14} className="shrink-0" style={{ color: 'var(--td-brand-color)' }} />
              ) : null}
            </button>
          );
        })}
      </div>
        </>
      )}

      {/* ── 底部通栏 ── */}
      <div className="shrink-0 p-2" style={{ borderTop: '1px solid var(--tc-divider)' }}>
        {verifyError && (
          /* 标定失败：把 CLI 的原话贴出来。改写过的「不可用」用户没法判断
             是自己账号的问题还是模型名的问题。 */
          <p
            className="mb-1 px-2 text-caption leading-4"
            style={{ color: 'var(--td-error-color)' }}
            data-model-verify-error
          >
            {verifyError}
          </p>
        )}
        {/* A151：先说明「点了会怎样」再让用户点。不写这句，一次 8-20s 的
            无响应会被当成卡死；写了这句，「验证中…」才有出处。 */}
        {!readonly && !verifyError && models.some(m => m.verified === false) && (
          <p
            className="mb-1 px-2 text-caption leading-4"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-model-probe-hint
          >
            带「未验证」的模型选中前会先跑一次 CLI 确认（花少量 token）。
          </p>
        )}
        {readonly || manual ? (
          /* 只读时「添加模型」必须消失：那个按钮指向设置页的刷新枚举，
             而这份清单根本不来自枚举 —— 摆着就是一个点了没用的控件。
             手动模式同理：这类 Agent 永远枚举不出东西，刷新也是空。 */
          <p
            className="px-2 py-1 text-caption leading-4"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-model-popup-note
          >
            {note ||
              (manual
                ? '这个 Agent 没有列出模型的命令。名字填错时 CLI 可能会静默换成默认模型。'
                : '这份清单来自该 Agent 自己的配置，本应用只能读取，不能切换。')}
          </p>
        ) : (
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
        )}
      </div>
    </div>,
    document.body
  );
}
