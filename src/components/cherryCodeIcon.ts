/**
 * A56：修 Cherry 代码块「复制」按钮的图标（方框叉号 → 复制图标）。
 *
 * ## 现象与根因
 *
 * 用户看到代码块右上角是一个「方框里叉号」。Cherry 的复制按钮是**字体图标**：
 *   `<div class="cherry-copy-code-block"><i class="ch-icon ch-icon-copy"></i></div>`
 * `ch-icon` 字体的 @font-face 声明在 `cherry-markdown.css` 里，而应用只引了
 * cherry 的 JS 包（`cherry-markdown.stream.esm.js`，内联注入的样式里没有
 * font-face）—— 字体从未加载，字形渲染成豆腐块。
 *
 * ## 做法：换图标，不换按钮
 *
 * 不动 Cherry 按钮本身（位置、大小、悬停显隐、点击复制的行为全部保留），
 * 只在它出现时把里面的 `<i>` 换成内联 SVG 复制图标。这样不依赖字体管线，
 * 也不依赖 Cherry 的内部样式细节。
 *
 * 两个难点：
 *  1. 按钮在 `t-chat-md-content` 的 **shadow DOM** 里 —— 必须从
 *     `host.shadowRoot` 进去找；
 *  2. 它是 **hover 代码块时才创建** 的（`$showBtn` 每次 hover 重建）——
 *     所以挂 MutationObserver 持续盯着：消息容器（新消息 → 新影子根）
 *     与每个影子根（hover 重建按钮）各一路。
 */

/**
 * lucide「复制」图标的 SVG（尺寸与操作行的 15px 图标视觉对齐）。
 *
 * 来源：lucide（https://lucide.dev），**ISC 许可**，与 `lucide-react` 同一套图标。
 * 这里内联而不是用 `<Copy />` 组件，是因为目标节点在 Cherry 的 **shadow DOM** 里 ——
 * React 组件没法跨影子根插入，只能拿 path 数据手工造一个节点。
 * 许可见 THIRD-PARTY.md。
 */
const COPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" style="display:block"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
  '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

/** 把一个 `.cherry-copy-code-block` 的字体图标换成 SVG（幂等） */
function patchButton(btn: Element): void {
  if (btn.hasAttribute('data-a56-icon')) return;
  const icon = btn.querySelector('i.ch-icon');
  if (!icon) return;
  const span = document.createElement('span');
  span.className = 'tc-cherry-copy-icon';
  span.innerHTML = COPY_SVG;
  icon.replaceWith(span);
  // 原字体图标没有可读名称，补上 title，键盘 / 读屏用户也知道这是干嘛的
  btn.setAttribute('title', '复制代码');
  btn.setAttribute('data-a56-icon', '1');
}

/** 在一个根（文档 / 影子根）里修补所有已存在的按钮 */
function patchIn(root: Document | ShadowRoot | Element): void {
  root.querySelectorAll('.cherry-copy-code-block').forEach(patchButton);
}

/**
 * 在消息容器上安装图标修补，返回卸载函数。
 *
 * `root` 是聊天消息列表的容器（`.chat-markdown` 们的共同祖先）。
 */
export function installCherryCodeIconFix(root: HTMLElement): () => void {
  const observedShadows = new Set<ShadowRoot>();
  const observers: MutationObserver[] = [];
  /** scan 可能被流式输出高频触发，用 rAF 合帧，避免每个 token 都全量扫一遍 */
  let raf = 0;

  const observeShadow = (sr: ShadowRoot) => {
    if (observedShadows.has(sr)) return;
    observedShadows.add(sr);
    patchIn(sr);
    const mo = new MutationObserver(() => patchIn(sr));
    mo.observe(sr, { childList: true, subtree: true });
    observers.push(mo);
  };

  const scan = () => {
    patchIn(root);
    root.querySelectorAll('t-chat-md-content').forEach(host => {
      const sr = (host as HTMLElement).shadowRoot;
      if (sr) observeShadow(sr);
    });
  };

  const scheduleScan = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      scan();
    });
  };

  scan();
  const containerMo = new MutationObserver(scheduleScan);
  containerMo.observe(root, { childList: true, subtree: true });

  return () => {
    if (raf) cancelAnimationFrame(raf);
    containerMo.disconnect();
    observers.forEach(mo => mo.disconnect());
  };
}
