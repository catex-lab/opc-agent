/**
 * 输入框 URL 高亮（2026-11-20，用户反馈：输入框里的链接要能一眼认出来）。
 *
 * 需求 vs 现实：输入框是 TDesign `t-chat-sender` → `t-textarea` → 原生
 * `<textarea>`（两层 shadow），textarea 里的文字**没法按子串着色**。业界
 * 成熟做法是「透明文字 + 背后镜像层」：原生 textarea 的文字变成透明，同一
 * 位置垫一个内容逐字相同的镜像 div，URL 子串在镜像里染成链接色。插入符、
 * 选择、键盘、IME 全都在原生 textarea 上，行为零变化。
 *
 * ## 为什么必须往 shadow 里注入（与 senderTextarea.ts 同一条血泪线）
 *
 * 镜像层要和 textarea 的文字逐像素对齐（同字体/行高/padding/滚动），只能
 * 挂在同一层 shadow root 里、以 `offsetLeft/offsetTop` 复刻 textarea 的盒子。
 * CSS 从外面穿不进两层 shadow，组件的 autosize 又会重写 textarea 的 style，
 * 所以全部注入物都带幂等标记、几何每次从 computed style 现算。
 *
 * ## 边界
 *
 * · 镜像层 pointer-events:none —— 点击/选择永远落在 textarea 上，「打开链接」
 *   走输入框已有的右键菜单（findUrlAt + ChatInput 里的菜单项），不在镜像层上
 *   做点击命中。
 * · 只认第一颗 `t-chat-sender`；拿不到就有限重试后静默放弃（最坏 = 没有高亮，
 *   绝不是输入框坏了）。
 */
import { findSenderTextarea } from './senderEdit';

const STYLE_MARK = 'data-opc-sender-highlight-style';
const MIRROR_MARK = 'data-opc-sender-highlight';

/** http(s):// 与裸 www. 两类；长度不限，遇到空白/引号收尾 */
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

/** 镜像层内容：与 textarea 逐字相同（先转义），URL 子串包上着色 span */
function renderMirror(value: string): string {
  URL_RE.lastIndex = 0;
  return escapeHtml(value).replace(URL_RE, m => `<span class="opc-url">${m}</span>`);
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
    const ta = findSenderTextarea();
    if (!ta) {
      if (++tries < 30) timer = window.setTimeout(attempt, 100);
      return;
    }
    const root = ta.getRootNode();
    if (!(root instanceof ShadowRoot)) return;

    // 透明化之前先取原色 —— 注入后 computed color 变 transparent，拿不到基准色
    const cs = getComputedStyle(ta);
    const baseColor = cs.color;
    const font = `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
    const letterSpacing = cs.letterSpacing;
    const pad = {
      top: px(cs.borderTopWidth) + px(cs.paddingTop),
      right: px(cs.borderRightWidth) + px(cs.paddingRight),
      bottom: px(cs.borderBottomWidth) + px(cs.paddingBottom),
      left: px(cs.borderLeftWidth) + px(cs.paddingLeft),
    };

    // 1) 样式表：textarea 文字透明 + 光标保留 + 占位符还原；镜像层排版基线
    const styleEl = document.createElement('style');
    styleEl.setAttribute(STYLE_MARK, '');
    styleEl.textContent = `
textarea {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  caret-color: var(--td-text-color-primary) !important;
  background: transparent !important;
}
textarea::placeholder {
  color: var(--td-text-color-placeholder) !important;
  -webkit-text-fill-color: var(--td-text-color-placeholder) !important;
}
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
  color: ${baseColor};
}
[data-opc-sender-highlight] .opc-url {
  color: var(--td-brand-color);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
`;
    root.appendChild(styleEl);

    // 2) 镜像层：垫在 textarea 正下方（DOM 前一位 + z-index 0）
    const mirror = document.createElement('div');
    mirror.setAttribute(MIRROR_MARK, '');
    if (ta.parentNode) ta.parentNode.insertBefore(mirror, ta);

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
  };

  attempt();

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    cleanup?.();
  };
}
