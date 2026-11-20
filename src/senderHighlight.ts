/**
 * 输入框 URL 高亮（2026-11-20，用户反馈：输入框里的链接要能一眼认出来）。
 *
 * ## 形态（v2，v1 的教训必须记住）
 *
 * v1 把 textarea 文字 `color: transparent`、镜像层垫底显示正文 —— 镜像几何
 * /颜色任何一步没对上，**用户输入的字就整个消失**（暗色模式实测踩雷）。
 * v2 反过来：**textarea 一个字都不动**，镜像层只画「链接色下划线 + 淡底」，
 * 自己的字全是 transparent（装饰与文字由两层叠加而成）。失败模式从
 * 「看不见字」降级为「下划线歪一两个像素」，文字永远可见。
 *
 * ## 为什么必须往 shadow 里注入（与 senderTextarea.ts 同一条血泪线）
 *
 * 镜像层要和 textarea 的文字逐字对齐（同字体/行高/padding/滚动），只能挂在
 * 同一层 shadow root 里、以 offsetLeft/offsetTop 复刻 textarea 的盒子。CSS
 * 从外面穿不进两层 shadow，组件的 autosize 又会重写 textarea 的 style，所以
 * 全部注入物都带幂等标记、几何每次从 computed style 现算。
 *
 * ## 边界
 *
 * · 镜像层 pointer-events:none —— 点击/选择永远落在 textarea 上，「打开链接」
 *   走输入框已有的右键菜单（findUrlAt + ChatInput 里的菜单项）。
 * · 整个装配包在 try/catch 里：任何一步失败 → 全部拆掉并放弃，绝不碰
 *   textarea 本身。
 * · 只认第一颗 `t-chat-sender`；拿不到就有限重试后静默放弃。
 */
import { findSenderTextarea } from './senderEdit';

const STYLE_MARK = 'data-opc-sender-highlight-style';
const MIRROR_MARK = 'data-opc-sender-highlight';

/** http(s):// 与裸 www. 两类；遇到空白/引号收尾 */
const URL_RE = /https?:\/\/[^\s<>"]+|(?:^|[\s(])www\.[^\s<>"]+/gi;

/** 找光标（selectionStart）所在或紧邻其右的 URL；没有返回 null。供右键菜单用 */
export function findUrlAt(ta: HTMLTextAreaElement, index: number): string | null {
  const value = ta.value ?? '';
  URL_RE.lastIndex = 0;
  for (const m of value.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (index >= start && index <= start + m[0].length) return m[0];
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 镜像层内容：与 textarea 逐字相同的**透明**文字，URL 区间只画出下划线 + 淡底 */
function renderMirror(value: string): string {
  URL_RE.lastIndex = 0;
  return escapeHtml(value).replace(
    URL_RE,
    m => `<span class="opc-url-wash">${m}</span>`
  );
}

function px(v: string): number {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function applySenderHighlight(): () => void {
  let timer: number | null = null;
  let tries = 0;
  let disposed = false;
  let cleanup: (() => void) | null = null;

  const attempt = () => {
    timer = null;
    if (disposed) return;
    try {
      const ta = findSenderTextarea();
      if (!ta) {
        if (++tries < 30) timer = window.setTimeout(attempt, 100);
        return;
      }
      const root = ta.getRootNode();
      if (!(root instanceof ShadowRoot)) return;

      const cs = getComputedStyle(ta);
      const font = `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
      const letterSpacing = cs.letterSpacing;
      const pad = {
        top: px(cs.borderTopWidth) + px(cs.paddingTop),
        right: px(cs.borderRightWidth) + px(cs.paddingRight),
        bottom: px(cs.borderBottomWidth) + px(cs.paddingBottom),
        left: px(cs.borderLeftWidth) + px(cs.paddingLeft),
      };

      // 样式表：只定义镜像层自己 —— **textarea 一个属性都不碰**
      const styleEl = document.createElement('style');
      styleEl.setAttribute(STYLE_MARK, '');
      styleEl.textContent = `
[data-opc-sender-highlight] {
  position: absolute;
  margin: 0;
  border: 0;
  box-sizing: border-box;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font: ${font};
  letter-spacing: ${letterSpacing};
  color: transparent;
  caret-color: transparent;
}
[data-opc-sender-highlight] .opc-url-wash {
  color: transparent;
  text-decoration: underline;
  text-decoration-color: var(--td-brand-color);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--td-brand-color) 14%, transparent);
}
`;
      root.appendChild(styleEl);

      // 镜像层垫在 textarea 正下方（DOM 前一位；两个都非定位元素时按 DOM 序
      // 绘制，装饰层先画、原生文字后画，互不遮挡）
      const mirror = document.createElement('div');
      mirror.setAttribute(MIRROR_MARK, '');
      if (!ta.parentNode) return;
      ta.parentNode.insertBefore(mirror, ta);

      const paint = () => {
        mirror.style.left = `${ta.offsetLeft}px`;
        mirror.style.top = `${ta.offsetTop}px`;
        mirror.style.width = `${ta.offsetWidth}px`;
        mirror.style.height = `${ta.offsetHeight}px`;
        mirror.style.padding = `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`;
        mirror.innerHTML = renderMirror(ta.value);
        mirror.scrollTop = ta.scrollTop;
      };
      paint();

      const ro = new ResizeObserver(paint);
      ro.observe(ta);
      const onScroll = () => {
        mirror.scrollTop = ta.scrollTop;
      };
      const onInput = () => paint();
      ta.addEventListener('scroll', onScroll);
      ta.addEventListener('input', onInput);

      cleanup = () => {
        ro.disconnect();
        ta.removeEventListener('scroll', onScroll);
        ta.removeEventListener('input', onInput);
        mirror.remove();
        styleEl.remove();
      };
    } catch (e) {
      // 任何一步失败：把已注入的拆干净并放弃 —— 高亮是装饰，绝不能碰坏输入框
      console.warn('[senderHighlight] 装配失败，已放弃（输入框保持原样）:', e);
      cleanup?.();
      cleanup = null;
    }
  };

  attempt();

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    cleanup?.();
  };
}
