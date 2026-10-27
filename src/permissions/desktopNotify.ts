import type { PermissionRequest } from '../types';

/**
 * 桌面壳提醒的渲染进程侧（A132）。
 *
 * 浏览器开发态没有 `window.opc`（纯 vite 起的页面），全部走可选链静默降级 ——
 * 这不是兜底装样子：开发态本来就没有任务栏可闪，Dock 该弹还是弹。
 *
 * 这个模块只能被**动态 import**（见 `permissionStore.push()` 的注释）：
 * 它顶层摸 `window`，而 store 会被 `npx tsx` 脱机脚本直接 import。
 */

interface OpcBridge {
  notifyPermission?: (payload: {
    requestId: string;
    sessionId: string;
    title?: string;
    body?: string;
  }) => void;
}

export function notifyDesktop(request: PermissionRequest, sessionTitle: string): void {
  // `typeof window` 而不是 `window?.`：Node 里 `window` 这个标识符根本不存在，
  // 直接引用是 ReferenceError 而不是 undefined —— 脱机脚本会被这一行当场炸掉。
  if (typeof window === 'undefined') return;
  const opc = (window as unknown as { opc?: OpcBridge }).opc;
  opc?.notifyPermission?.({
    requestId: request.requestId,
    sessionId: request.sessionId,
    // 文案不写完整命令：Windows 通知有长度上限，且系统层不该带上用户的路径。
    // 「要执行 Bash」已经够用户判断「要不要切回去看」。
    title: `OPC Agent · ${sessionTitle} 等待授权`,
    body: `要执行「${request.toolName}」，不回复会自动拒绝`,
  });
}
