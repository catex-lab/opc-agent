/**
 * 复制到剪贴板（A139）。
 *
 * ## 为什么新开一个模块，而不是再写第四份
 *
 * 项目里已经有三份内联实现，口径还不一致：
 *   · `ChatMessages.copyPlainText` —— 有 execCommand 兜底，失败时 reject；
 *   · `ConversationList.copyText` —— 只试 clipboard API，失败静默吞掉；
 *   · `InstallCard.copyText` —— 有兜底，返回 boolean。
 *
 * 三者都被各自的闸门断言着。本轮**不去改那三处**：它们与本次要修的
 * 「项目路径复制」没有因果关系，顺手改只会把验证面撑大，收益为零。
 * 新代码统一走这里，返回「到底复制成功没有」—— 复制路径失败必须让用户知道，
 * 静默失败会让人以为剪贴板里是新路径，粘出来是上一次的旧值。
 *
 * ## 为什么保留 execCommand 兜底
 *
 * Electron 里页面是 `http://127.0.0.1:<port>`（安全上下文），`navigator.clipboard`
 * 通常可用；但纯静态预览（`file://`）与部分权限策略下会被拒，
 * 而 `execCommand('copy')` 往往还能用。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 —— 权限被拒时 execCommand 往往还能用 */
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    // 固定在视口外 + 透明：不能在文档流里插入一个可见的文本框（会顶一下布局）
    el.style.position = 'fixed';
    el.style.top = '-1000px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const done = document.execCommand('copy');
    document.body.removeChild(el);
    return done;
  } catch {
    return false;
  }
}
