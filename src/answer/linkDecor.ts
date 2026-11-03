/**
 * A174：正文外链的**行内装饰层**。
 *
 * ## 为什么是 DOM 装饰，不是 React 组件
 *
 * 答案正文由 ChatMarkdown（Cherry）渲染在 `t-chat-md-content` 的 **shadow DOM**
 * 里。从外面只能拿到 `host` 和几个 `::part()`（`md_a` 已导出，所以颜色 /
 * 下划线可以直接用 CSS 表达），但「链接文字后面跟一个 11px 外链图标」和
 * 「hover 出完整地址」都需要**额外节点**，CSS 做不到（`::part()` 不能接
 * `::after` 造元素）。
 *
 * 所以这里只补两件 CSS 补不到的事：
 *   1. 给每个 http(s) 链接插一个 11px 单色线形外链图标（`<a>` 内联子节点）；
 *   2. 行内 `[推测]` 标记换成细边框文字标签。
 * 链接的颜色 / 下划线 / offset 由 `index.css` 的 `::part(md_a)` 负责，
 * 不在 JS 里写样式（否则浅深主题会各写一套）。
 *
 * 和 `cherryCodeIcon.ts` 同一套做法：Cherry 每次重渲染都会整段重建 shadow
 * 内容，装饰必然被冲掉 —— 所以挂 MutationObserver，用逐节点标记位做幂等，
 * 用 rAF 合帧，避免流式输出时每个 token 扫一遍。
 *
 * ## 协议白名单
 *
 * 装饰**之前**先过 `sanitizeHttpUrl()`：`javascript:` / `data:` 一律去掉 href
 * 并标记 `data-opc-link-blocked`（保留文字，不给点击面）。这一步是渲染侧
 * 的收口；主进程 `opc:open-external` 还会再收一次（见 `electron/main.ts`）。
 */
import { parseLinkLine, sanitizeHttpUrl } from './renderPlan';
import { openAnswerLink, readLinkOpenMode } from './linkRouter';

/** lucide `external-link`（ISC，见 THIRD-PARTY.md），11px 单色线形 */
const EXT_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;' +
  'width:11px;height:11px;margin-left:3px;vertical-align:-1px;pointer-events:none;opacity:.9">' +
  '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

const GUESS_MARKER = '[推测]';
const GUESS_LABEL = '推测';

/** 行内「推测」标签：细边框，只用文字，不加虚线框（设计稿的建议） */
function makeGuessTag(): HTMLSpanElement {
  const tag = document.createElement('span');
  tag.setAttribute('data-guess-tag', '1');
  tag.textContent = GUESS_LABEL;
  tag.style.cssText =
    'display:inline-block;margin-right:6px;padding:0 4px;border:1px solid var(--tc-edge);' +
    'border-radius:3px;font-size:10px;line-height:16px;letter-spacing:.08em;' +
    'color:var(--td-text-color-secondary);vertical-align:1px;user-select:none;';
  return tag;
}

function decorateAnchors(root: ParentNode): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
    if (a.hasAttribute('data-opc-link')) return;
    // 链接卡是块级元素、自己接管点击，行内那套「图标 + 下划线」对它没有意义 ——
    // 再插一枚外链图标就会在卡里多出一行孤零零的图标
    if (a.hasAttribute('data-answer-link-card')) return;
    const safe = sanitizeHttpUrl(a.getAttribute('href'));
    a.setAttribute('data-opc-link', '1');
    if (!safe) {
      // 非 http/https：抽掉 href，但保留可读文字。`data-opc-link-blocked`
      // 是给闸门和样式用的（样式在 index.css，不在 JS 里写死颜色）
      a.removeAttribute('href');
      a.removeAttribute('target');
      a.setAttribute('data-opc-link-blocked', '1');
      // shadow DOM 里拿不到外部样式表，只能写行内；颜色仍走令牌
      a.style.color = 'var(--td-text-color-secondary)';
      a.style.textDecoration = 'none';
      a.style.cursor = 'default';
      return;
    }
    a.setAttribute('href', safe);
    a.setAttribute('data-opc-extlink', '1');
    a.setAttribute('data-opc-url', safe);
    a.setAttribute('rel', 'noopener noreferrer');
    const icon = document.createElement('span');
    icon.setAttribute('data-opc-extlink-icon', '1');
    icon.innerHTML = EXT_ICON_SVG;
    // shadow DOM 内拿不到外部 class，但自定义属性（var）会跨影子边界继承
    const svg = icon.firstElementChild as SVGElement | null;
    if (svg) svg.style.color = 'var(--td-text-color-secondary)';
    a.appendChild(icon);
    // hover 时图标从 secondary 提到 primary —— `::part(md_a):hover` 只管得到
    // 文字颜色（伪类不能穿透到子节点），图标只能挂这两个监听
    a.addEventListener('mouseenter', () => {
      const svg = icon.firstElementChild as SVGElement | null;
      if (svg) svg.style.color = 'var(--td-text-color-primary)';
    });
    a.addEventListener('mouseleave', () => {
      const svg = icon.firstElementChild as SVGElement | null;
      if (svg) svg.style.color = 'var(--td-text-color-secondary)';
    });
  });
}

function decorateGuessTags(root: ParentNode): void {
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.nodeValue;
    if (text && text.indexOf(GUESS_MARKER) >= 0) {
      const parent = node.parentElement;
      // 代码块 / 链接文字里不改：那是原文，改了会误导「复制」的结果
      if (parent && !parent.closest('pre, code, a, [data-guess-tag]')) hits.push(node as Text);
    }
    node = walker.nextNode();
  }
  hits.forEach(textNode => {
    const parts = textNode.nodeValue?.split(GUESS_MARKER) ?? [];
    if (parts.length < 2) return;
    const frag = document.createDocumentFragment();
    parts.forEach((part, idx) => {
      if (part) frag.appendChild(document.createTextNode(part));
      if (idx < parts.length - 1) frag.appendChild(makeGuessTag());
    });
    textNode.replaceWith(frag);
  });
}

/* ── 悬浮提示（完整地址 + 次要动作）──────────────────────────────────────
 *
 * tooltip 挂在 `document.body` 的**light DOM** 里，而不是塞进 shadow：
 * 气泡祖先可能有 `overflow: hidden`，塞进去会被裁；挂在 body 还能直接复用
 * index.css 的令牌（`position: fixed` + 视口夹取）。
 */

const TIP_CLASS = 'tc-answer-linktip';
let tipEl: HTMLDivElement | null = null;
let hideTimer: number | null = null;
let tipUrl = '';

function cancelHide(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideTip(): void {
  cancelHide();
  if (tipEl) tipEl.setAttribute('data-show', '0');
}

function ensureTip(): HTMLDivElement {
  if (tipEl && tipEl.isConnected) return tipEl;
  const el = document.createElement('div');
  el.className = TIP_CLASS;
  el.setAttribute('data-answer-link-tip', '1');
  el.setAttribute('data-show', '0');
  el.innerHTML =
    '<div class="tc-answer-linktip-url" data-link-tip-url></div>' +
    '<div class="tc-answer-linktip-actions">' +
    '<button type="button" class="tc-answer-linktip-btn" data-link-action="in-app">在应用内打开</button>' +
    '<button type="button" class="tc-answer-linktip-btn" data-link-action="external">用系统浏览器打开</button>' +
    '</div>';
  el.addEventListener('mouseenter', cancelHide);
  el.addEventListener('mouseleave', () => scheduleHide());
  el.addEventListener('click', ev => {
    const btn = (ev.target as Element | null)?.closest?.('[data-link-action]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const action = btn.getAttribute('data-link-action');
    if (!tipUrl) return;
    void openAnswerLink(tipUrl, action === 'in-app' ? 'in-app' : 'system');
    hideTip();
  });
  document.body.appendChild(el);
  tipEl = el;
  return el;
}

function placeTip(el: HTMLDivElement, anchor: Element): void {
  const a = anchor.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - box.width - margin);
  const left = Math.min(Math.max(a.left, margin), maxLeft);
  const above = a.top - box.height - margin;
  const top = above >= margin ? above : Math.min(a.bottom + margin, window.innerHeight - box.height - margin);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function showTip(anchor: Element): void {
  const url = anchor.getAttribute('data-opc-url');
  if (!url) return;
  cancelHide();
  const el = ensureTip();
  tipUrl = url;
  const urlNode = el.querySelector('[data-link-tip-url]');
  if (urlNode) urlNode.textContent = url;
  el.setAttribute('data-show', '1');
  placeTip(el, anchor);
}

function scheduleHide(): void {
  cancelHide();
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    hideTip();
  }, 160);
}

function anchorFromEvent(ev: Event): HTMLElement | null {
  const path = ev.composedPath?.() ?? [];
  for (const el of path) {
    if (!(el instanceof Element)) continue;
    if (el.hasAttribute('data-opc-extlink')) return el as HTMLElement;
  }
  return null;
}

/* ── 安装 / 卸载 ─────────────────────────────────────────────────────── */

let installed = 0;

function bindDocument(): () => void {
  const onOver = (ev: Event) => {
    const anchor = anchorFromEvent(ev);
    if (anchor) showTip(anchor);
    else if ((ev.target as Element | null)?.closest?.('[data-answer-link-tip]')) cancelHide();
  };
  const onOut = (ev: Event) => {
    const anchor = anchorFromEvent(ev);
    if (anchor) scheduleHide();
  };
  const onFocus = (ev: Event) => {
    const anchor = anchorFromEvent(ev);
    if (anchor) showTip(anchor);
  };
  const onBlur = (ev: Event) => {
    if (anchorFromEvent(ev)) scheduleHide();
  };
  const onClick = (ev: MouseEvent) => {
    const anchor = anchorFromEvent(ev);
    if (!anchor) return;
    // 链接在 shadow DOM 里、Cherry 又给了 target=_blank —— 不拦会被
    // window.open 抢走（Electron 里就是另开一个窗口）。所以捕获阶段拦死。
    ev.preventDefault();
    ev.stopPropagation();
    const url = anchor.getAttribute('data-opc-url');
    hideTip();
    if (url) void openAnswerLink(url, readLinkOpenMode());
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') hideTip();
  };

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onBlur, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('focusout', onBlur, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    hideTip();
  };
}

/**
 * 在消息容器上安装行内装饰，返回卸载函数。
 *
 * `root` 是聊天消息列表容器（`.chat-markdown` 们的共同祖先）。
 */
export function installAnswerLinkDecor(root: HTMLElement): () => void {
  installed += 1;
  const unbind = installed === 1 ? bindDocument() : () => {};
  const observedShadows = new Set<ShadowRoot>();
  const observers: MutationObserver[] = [];
  let raf = 0;

  const decorate = (scope: ParentNode) => {
    decorateAnchors(scope);
    decorateGuessTags(scope);
  };

  const observeShadow = (sr: ShadowRoot) => {
    if (observedShadows.has(sr)) return;
    observedShadows.add(sr);
    decorate(sr);
    const mo = new MutationObserver(() => schedule());
    mo.observe(sr, { childList: true, subtree: true, characterData: true });
    observers.push(mo);
  };

  const scan = () => {
    // 本容器里没有走 shadow 的部分（链接卡 / 证据块）也要扫：推测标签在
    // 正文里，卡片标题里也可能出现。
    decorate(root);
    root.querySelectorAll('t-chat-md-content').forEach(host => {
      const sr = (host as HTMLElement).shadowRoot;
      if (sr) observeShadow(sr);
    });
  };

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      scan();
    });
  };

  schedule();
  const containerMo = new MutationObserver(schedule);
  containerMo.observe(root, { childList: true, subtree: true });

  return () => {
    installed -= 1;
    if (raf) cancelAnimationFrame(raf);
    containerMo.disconnect();
    observers.forEach(mo => mo.disconnect());
    if (installed === 0) unbind();
  };
}

/** 给闸门用：从一段 markdown 里挑出「会变成卡」的行（与 planAnswer 同口径） */
export function isCardLinkLine(line: string): boolean {
  return parseLinkLine(line) !== null;
}
