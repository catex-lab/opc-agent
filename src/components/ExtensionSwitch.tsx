import { Power } from 'lucide-react';

/**
 * 扩展的统一开关（A164 / 用户确认的绿色方案）。
 *
 * 列表单条、分组头（部分启用 = `mixed`）以及以后详情页的总开关都复用它 ——
 * 三处必须是同一种控件，否则「关着的电源图标」会长出三种样子。
 *
 * ## 为什么图标只有「描边 / 实心」两态
 *
 * 电源图标本身没有「开」和「关」的区别，状态靠这三条线索同时表达：
 *   · 图标从描边变实心（`fill: currentColor`）
 *   · 颜色从中性灰变 `--ext-on`（敏感条目变 `--ext-warn`）
 *   · 外层出现 12% 的淡染底（hover 18%）
 * 颜色只在开启态出现；关闭态没有彩色底，符合「全单色约束」不被这套开关破坏。
 *
 * ## 为什么把 data-* 走单独参数
 *
 * 既有验证契约认的是 `data-ext-row-toggle` / `data-ext-group-toggle` +
 * `data-enabled`。把这些塞进一个显式参数，比给组件开一个任意 props 口子更容易
 * 看清「哪些锚点是刻意保留的」。
 */
export interface ExtensionSwitchProps {
  /** `mixed` = 分组头部分启用（aria-checked 的第三种值） */
  checked: boolean | 'mixed';
  onClick: () => void;
  label: string;
  title?: string;
  /** 含敏感内容的条目用 `warn`；其余用默认 `on` */
  tone?: 'on' | 'warn';
  /**
   * 无可分发目标时置灰。组件保留这一能力，但当前数据层没有把「这一条有没有
   * 可分发目标」下发给列表（只有详情接口才逐 Agent 算），所以列表里暂时用不到。
   */
  disabled?: boolean;
  size?: number;
  /** 既有锚点，如 `{ 'data-ext-row-toggle': '', 'data-enabled': '1' }` */
  dataAttrs?: Record<string, string>;
}

export function ExtensionSwitch({
  checked,
  onClick,
  label,
  title,
  tone = 'on',
  disabled = false,
  size = 14,
  dataAttrs,
}: ExtensionSwitchProps) {
  const ariaChecked = checked === 'mixed' ? 'mixed' : checked ? 'true' : 'false';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={ariaChecked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      title={title}
      onClick={e => {
        /* 列表行本身是按钮：开关点击不能触发行选中 —— 这是开关，不是跳转。 */
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      className="ext-switch"
      {...(tone === 'warn' ? { 'data-tone': 'warn' } : {})}
      {...(dataAttrs ?? {})}
    >
      <Power
        size={size}
        strokeWidth={1.6}
        /* mixed 的半填充由 index.css 的 aria-checked='mixed' 规则给出 */
        style={checked === true ? { fill: 'currentColor' } : undefined}
      />
    </button>
  );
}
