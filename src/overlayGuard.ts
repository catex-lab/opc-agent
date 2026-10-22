/**
 * 浮层哨兵 —— P2 浏览器预览视图的可见性依据。
 *
 * ## 它解决什么问题
 *
 * `WebContentsView` 是**原生层，永远盖在 DOM 之上**。任何 React 弹窗、
 * 下拉、Toast 只要和预览区域重叠，就会被它盖住 —— 用户看到的是「菜单点了
 * 没反应」，而实际上菜单弹出来了，只是被一张网页糊住了。
 *
 * 这是 P2 最大的坑，也是估 2–3 天而不是 1 天的原因（见
 * `PLAN-WORKSPACE-PANEL.md` §2.2）。两种解法：
 *
 *   1. 每个浮层打开时显式通知预览视图隐藏 —— 要改每一个浮层组件，
 *      漏一个就是一个bug，且新人加浮层时不会想起这件事；
 *   2. **哨兵**：有一个浮层正处于可见状态时，预览视图整体隐藏。
 *
 * 这里选 2。代价是「浮层打开时预览会闪一下不见」，收益是不必记住任何
 * 新组件 —— 而预览被盖住是静默故障，比闪一下严重得多。
 *
 * ## 怎么算「浮层可见」
 *
 * 认两类选择器：
 *   · `[data-opc-overlay]` —— 我们自己的浮层（自绘菜单、弹出面板）。
 *     这是**约定**：新增自绘浮层时给它加这个属性，哨兵才认。
 *   · `[class*="t-popup"]` / `[class*="t-dialog"]` / `[class*="t-message"]`
 *     —— TDesign 的弹层容器，它们渲染在 `document.body` 下。
 *
 * 判定用 `getClientRects().length > 0` 而不是「在 DOM 里」：
 * `<details>` 收起时子节点仍在 DOM 中（只是 `display:none`），
 * 只看存在性会得到「一直有浮层」的假象，预览就再也不显示了。
 */

const OVERLAY_SELECTOR =
  '[data-opc-overlay], [class*="t-popup"], [class*="t-dialog"], [class*="t-message"]';

/** 当前是否有任何浮层真的占着屏幕。 */
export function isOverlayVisible(): boolean {
  if (typeof document === 'undefined') return false;
  const nodes = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as HTMLElement;
    // getClientRects 对 display:none / 未挂载 / 0 尺寸的节点都返回空数组，
    // 是「真的画出来了」最省事的判据。
    if (el.getClientRects().length > 0) return true;
  }
  return false;
}

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let lastState = false;

function ensureObserver(): void {
  if (observer || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(() => {
    const now = isOverlayVisible();
    if (now === lastState) return;
    lastState = now;
    for (const fn of listeners) fn();
  });
  // childList + subtree：浮层大多动态插入 body。
  // attributes：浮层内的显隐常由 class/style 切换（TDesign 的进场动画）。
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'open'],
  });
}

/**
 * 订阅浮层显隐变化。返回取消订阅函数（React effect 清理用）。
 *
 * 订阅时会立刻同步一次当前状态：挂载瞬间可能已经有浮层开着
 * （例如从浮层里点的按钮渲染出了这个组件）。
 */
export function subscribeOverlay(fn: () => void): () => void {
  listeners.add(fn);
  ensureObserver();
  lastState = isOverlayVisible();
  return () => {
    listeners.delete(fn);
  };
}
