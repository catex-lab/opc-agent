/**
 * 输入框字号对齐正文（A93）。
 *
 * 反馈「输入框的文字太大，应该与正文一致」。正文段落是 15px
 * （见 index.css 里 `.chat-markdown ::part(md_p)`），而输入框实测 16px。
 *
 * ## 为什么必须动 DOM，写 CSS 不行
 *
 * 逐条排除过的三条路，都实测无效：
 *
 * 1. **`::part()` 跨不了两层 shadow**。`t-chat-sender` → `t-textarea` 是两层
 *    shadow root，`t-chat-sender::part(t-textarea__inner)` 改不动里面的字号。
 * 2. **CSS 变量也进不去**。字号来自 shadow 内的
 *    `.t-textarea__inner { font: var(--td-font-body-medium) }`，而那个变量是
 *    **shadow 内部定义的**。在 host 上注入同名变量、甚至在 `:root` 上改，
 *    实测仍然是 16px —— 继承打不过 shadow 里的本地定义。
 * 3. **在 textarea 上写内联 `style.fontSize` 会被抹掉**。组件的 autosize
 *    每次重算都整体重写 `style` 属性（`min-height/height`），内联字号随即消失。
 *
 * 唯一稳定的口子：往那一层 shadow root 里插一条样式表。shadow root 本身不随
 * 重渲染重建，样式表插一次就长期生效，也不受 autosize 重写 style 的影响。
 *
 * ## 边界
 *
 * · 只认第一颗 `t-chat-sender`（全应用同时只渲染一个输入区）。
 * · 组件是异步挂载的，所以带 100ms × 30 次的有限重试；拿不到就静默放弃，
 *   不回退成「字号没改但界面坏了」—— 最坏情况就是维持 TDesign 默认 16px。
 */
import { findSenderTextarea } from './senderEdit';

const MARK = 'data-opc-sender-type';
/** 与正文段落一致（index.css 的 md_p） */
const FONT_SIZE = 15;
/** 正文是 1.72 行高，输入框按 22px 固定：与改动前的盒子高度一致，不跳 */
const LINE_HEIGHT = 22;

function findTextarea(): HTMLTextAreaElement | null {
  return findSenderTextarea();
}

export function applySenderTypography(): () => void {
  let styleEl: HTMLStyleElement | null = null;
  let timer: number | null = null;
  let tries = 0;

  const attempt = () => {
    timer = null;
    const ta = findTextarea();
    if (!ta) {
      if (++tries < 30) timer = window.setTimeout(attempt, 100);
      return;
    }
    const root = ta.getRootNode();
    if (!(root instanceof ShadowRoot)) return;
    // 幂等：已经注入过就不再插第二条
    if (root.querySelector(`style[${MARK}]`)) return;
    styleEl = document.createElement('style');
    styleEl.setAttribute(MARK, '');
    styleEl.textContent =
      `textarea{font-size:${FONT_SIZE}px !important;line-height:${LINE_HEIGHT}px !important}`;
    root.appendChild(styleEl);
  };

  attempt();

  return () => {
    if (timer !== null) clearTimeout(timer);
    styleEl?.remove();
  };
}
