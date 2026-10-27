import { useEffect, useState } from 'react';

/**
 * 判断一个纵向滚动容器**当前是否真的有内容溢出**。
 *
 * ## 为什么需要它
 *
 * 只在真的溢出时才给滚动区画「底边渐隐」，否则短内容末尾会莫名其妙变虚 ——
 * 那是把「还有更多」这个信号画在了一个没有更多的地方。
 *
 * 这个信号在 Windows 上不是可选的：Chrome 用的是 overlay 滚动条，静止时
 * 完全不画。用户看到的是一个被**硬切**在半个字上的分组标题，读起来像渲染
 * 坏掉，而不是「下面还有」。（A134 获取 Agent 弹窗，内容 890px 装进 712px
 * 的容器，第 4 组的标题只露出 16.73/34px。）
 *
 * ## 为什么用 callback ref 而不是 useRef + 依赖数组
 *
 * 滚动容器经常是**后挂上**的：折叠面板展开那一帧、弹窗内容异步到位那一帧，
 * 元素还不存在。用 `useRef` + `useEffect(..., [])` 会在元素为 null 的那一次
 * 就把 effect 跑完，之后再也不会观察它 —— 遮罩永远算不出来。
 * callback ref 在元素真正挂上/卸载时才调用，effect 依赖它，天然跟着重跑。
 *
 * ## 为什么要两种观察器
 *
 * · `ResizeObserver` 只在**容器自身尺寸**变化时触发（窗口缩放、弹窗改高）；
 * · 内容变多（Agent 名册晚到、步骤追加）时容器尺寸**不变**，只有
 *   `MutationObserver` 能看见。
 * 少任何一个都会出现「内容确实溢出了但遮罩没出来」的假阴性。
 *
 * 不观察 attributes：`data-fade` 就是本 hook 的输出，观察它会让回写自己
 * 触发自己（虽然值相同会被 React 挡掉，但没必要留这个环）。
 *
 * 返回值同时给 `ref`（挂到元素上）与 `el`（元素本身，供需要命令式滚动的
 * 调用方用）。只给 `ref` 的话，调用方想 `el.scrollTop = el.scrollHeight`
 * 还得再挂一个 `useRef`，两个 ref 拼在一个元素上纯属自找麻烦。
 */
export function useOverflowY<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!el) return;
    // +2 是给亚像素留的余量：小数高度下 scrollHeight 可能比 clientHeight
    // 大 1px 却没有任何可滚内容，那时弹遮罩只会闪一下。
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 2);
    check();

    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [el]);

  return { ref: setEl, el, overflowing };
}
