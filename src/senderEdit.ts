/**
 * 输入框（t-chat-sender 内那棵两层 shadow 里的 textarea）的编辑操作。
 *
 * ## 为什么需要这个模块
 *
 * A113：用户要求输入框的右键菜单有完整功能（撤销/重做/剪切/复制/粘贴/全选）。
 * 麻烦在于那一棵 textarea 在 **两层 shadow root** 里：
 *
 *   t-chat-sender → (shadow) → t-textarea → (shadow) → textarea
 *
 * 于是「拿到它」和「对它下命令」都要自己写。更麻烦的是 Chromium 对 shadow
 * 内可编辑元素的原生右键菜单**不总是完整**（实测打包版里没有「粘贴」这一项），
 * 所以必须自己做一份菜单，而不是指望浏览器。
 *
 * ## 三个实现约束
 *
 * 1. **命令走 `document.execCommand`**。它对当前 focused 的可编辑元素生效，
 *    不需要自己算选区，undo/redo 栈也由浏览器维护 —— 自己拼「插入 + 恢复
 *    选区」会把用户的撤销历史打碎。
 * 2. **粘贴不能走 execCommand**。Chromium 明确禁止脚本执行 paste（永远返回
 *    false），只能读 `navigator.clipboard.readText()` 再手动插。插完必须
 *    **派发一个 input 事件**，否则 TDesign 的受控状态不更新，字插进去了
 *    但 React 以为还是空的（下次一渲染就没了）。
 * 3. **拿不到 textarea 就安静失败**。组件是异步挂载的，找不到时什么都别做，
 *    不要抛错把右键菜单搞坏。
 */

/** 在两层 shadow 里找到输入框的 textarea；找不到返回 null */
export function findSenderTextarea(): HTMLTextAreaElement | null {
  const sender = document.querySelector('t-chat-sender');
  if (!sender?.shadowRoot) return null;

  const dig = (root: ShadowRoot, depth: number): HTMLTextAreaElement | null => {
    if (depth > 4) return null;
    const direct = root.querySelector('textarea');
    if (direct) return direct as HTMLTextAreaElement;
    for (const el of root.querySelectorAll('*')) {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) {
        const found = dig(sr, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return dig(sender.shadowRoot, 0);
}

/** 让输入框拿到焦点。右键菜单点任何一项前都要先做这一步 */
function focusTextarea(): HTMLTextAreaElement | null {
  const ta = findSenderTextarea();
  ta?.focus();
  return ta;
}

/** 走 execCommand 的那一组（浏览器原生支持，含 undo/redo 栈） */
function runCommand(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'selectAll'): boolean {
  const ta = focusTextarea();
  if (!ta) return false;
  try {
    return document.execCommand(cmd);
  } catch {
    return false;
  }
}

/**
 * 粘贴：唯一一条不能走 execCommand 的路。
 *
 * `document.execCommand('paste')` 在 Chromium 里被硬禁（脚本没有剪贴板
 * 写权限），永远返回 false。所以自己读剪贴板、自己插。
 *
 * 插入位置用 `selectionStart/selectionEnd` —— textarea 的这两个属性是可靠的
 * （不像 TDesign 某些富文本组件要在 shadow 里算光标）。
 */
async function pasteText(): Promise<boolean> {
  const ta = focusTextarea();
  if (!ta) return false;
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return false;
  }
  if (!text) return false;

  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const next = ta.value.slice(0, start) + text + ta.value.slice(end);
  // 必须走原生 setter + input 事件：直接 `ta.value = next` 不会让 React /
  // TDesign 的受控状态更新，插进去的字下一次渲染就被抹掉
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(ta, next);
  ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

  // 光标落在插入内容之后，和手动粘贴的手感一致
  const caret = start + text.length;
  requestAnimationFrame(() => {
    ta.setSelectionRange(caret, caret);
  });
  return true;
}

export interface SenderEditResult {
  ok: boolean;
  /** 失败原因（给用户看的一句话）；ok 为 true 时为空 */
  note?: string;
}

/** 右键菜单的每一项调用的就是它。返回结果供调用方决定要不要弹提示 */
export async function senderEdit(
  action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'clear'
): Promise<SenderEditResult> {
  if (action === 'paste') {
    return (await pasteText())
      ? { ok: true }
      : { ok: false, note: '读取剪贴板失败，请用 Ctrl+V 粘贴' };
  }

  if (action === 'clear') {
    const ta = focusTextarea();
    if (!ta) return { ok: false, note: '输入框还没就绪' };
    ta.select();
    const ok = runCommand('cut');
    // 剪切在某些环境下也被禁；退化成就地清空（选区已被 select 全选）
    if (!ok) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    return { ok: true };
  }

  const ok = runCommand(action);
  if (ok) return { ok: true };
  // 没选中内容时 cut/copy 会失败 —— 这不是错误，只是「此刻没东西可剪」
  if (action === 'cut' || action === 'copy') {
    return { ok: false, note: '没有选中内容' };
  }
  return { ok: false, note: '当前环境不支持这个操作' };
}
