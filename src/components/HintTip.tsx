/**
 * 说明提示图标（A37）。
 *
 * 原话：「『界面透明度 / 鼠标光斑 / 光斑大小 / 光斑亮度』下方的解释性小字
 * 分别收进对应的一个提示图标内，保证页面干净整洁」。
 *
 * 为什么是 Tooltip 而不是 Popover：这些说明都是**一两句话**，读完就关；
 * Popover 要点击、要占一块浮层、要处理「点到外面关掉」，成本远大于收益。
 * 鼠标悬停（或键盘聚焦）即出，移开即走。
 *
 * 图标选 `Info`（圆圈里的 i）而不是 `HelpCircle`（问号）：问号暗示
 * 「这里有个问题需要解决」，而这里只是「参数是什么意思」。
 *
 * ⚠️ 必须用 `<button>` 而不是 `<span>`：TDesign 的 Tooltip 需要子节点能接 ref，
 * 且键盘用户要能 Tab 到它（`aria-label` 给出可读的名字）。
 */
import { Info } from 'lucide-react';
import { Tooltip } from 'tdesign-react';

export function HintTip({
  text,
  label = '说明',
  /** 警示态：用于「当前不可用」这类需要被看见的说明 */
  warn = false,
}: {
  text: string;
  /** 无障碍名称，例如「界面透明度说明」 */
  label?: string;
  warn?: boolean;
}) {
  return (
    <Tooltip content={text} placement="top" showArrow>
      <button
        type="button"
        className="tc-hint-tip"
        data-hint-tip={label}
        aria-label={label}
        data-warn={warn ? '1' : undefined}
      >
        <Info size={13} />
      </button>
    </Tooltip>
  );
}

export default HintTip;
