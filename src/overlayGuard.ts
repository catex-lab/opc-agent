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
 *
 * ## A86：上面那条判据在 Electron 44 上是**错的**（真事故）
 *
 * 用户报「浏览器标签输入网址打不开」，实测：`browserLoad('https://example.com')`
 * 返回 true、调试目标里页面真的加载了，但原生视图永远不显示。
 *
 * 原因是 `<details>` 收起时子元素**不再**是 `display:none` —— Chromium 改成了
 * `content-visibility: hidden` 语义，元素仍有布局盒。实测聊天头部「⋯」菜单
 * （`data-opc-overlay`、w-[160px]、在 `<details>` 里、`open === false`）：
 * `getClientRects().length === 1`、`getBoundingClientRect()` 是 160×79、
 * `display:block`、`visibility:visible`。
 *
 * 于是 `isOverlayVisible()` **恒为 true** → `setBrowserVisible(false)` 恒定 →
 * `WebContentsView` 永远停在隐藏状态。一块网页被自己的哨兵永久判成「被浮层盖住」。
 *
 * 现在的判据是三条「与」：不在收起的 `<details>` 里、`checkVisibility` 通过、
 * 有非零尺寸。三条都抽成 `isVisibleOverlayElement`，让验证脚本能用假元素单测
 * （DOM 行为在 Node 里造不出来，但这条纯函数可以）。
 */

const OVERLAY_SELECTOR =
  '[data-opc-overlay], [class*="t-popup"], [class*="t-dialog"], [class*="t-message"]';

/** `checkVisibility` 在部分环境下不存在，按可选能力用。 */
interface MaybeCheckVisibility {
  checkVisibility?: (options?: {
    checkOpacity?: boolean;
    checkVisibilityCSS?: boolean;
  }) => boolean;
}

/**
 * 单个节点是否**真的**占着屏幕。
 *
 * 三条缺一不可，顺序按「代价从小到大」：
 *   1. 祖先里有收起的 `<details>` → 不可见（A86 的实际命中原因）；
 *   2. 有 `checkVisibility` 就再问一次（覆盖 display:none / visibility:hidden /
 *      opacity:0，比手工拼 computedStyle 稳）；
 *   3. 最后要一个非零盒子（`content-visibility: hidden` 下可能得到 0 尺寸）。
 *
 * 导出是为了可测：验证脚本传假元素进来就能断言三条分支，不需要真 DOM。
 */
export function isVisibleOverlayElement(el: Element): boolean {
  const details = el.closest('details');
  if (details && !details.open) return false;

  const probe = el as Element & MaybeCheckVisibility;
  if (typeof probe.checkVisibility === 'function') {
    try {
      if (!probe.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } catch {
      /* 参数不被支持（老 Chromium）：跳过这条，靠另外两条 */
    }
  }

  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/** 当前是否有任何浮层真的占着屏幕。 */
export function isOverlayVisible(): boolean {
  if (typeof document === 'undefined') return false;
  const nodes = document.querySelectorAll(OVERLAY_SELECTOR);
  for (let i = 0; i < nodes.length; i++) {
    if (isVisibleOverlayElement(nodes[i])) return true;
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
