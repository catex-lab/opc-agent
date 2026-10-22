/**
 * 「场景/权限模式的约束，当前 Agent 落不了地」的提示条。
 *
 * 从 NewChatView 抽出来共用：这个提示以前只在新建对话页出现，
 * 但同一件事在会话里也会发生 —— 会话中切换权限模式、群聊分派成员，
 * 承诺都可能落不了地。各入口共用这一个组件，样式与措辞不会漂移。
 */
import { AlertTriangle } from 'lucide-react';

export interface PermissionGapNoticeProps {
  /** 提示文案；null / 空字符串 = 不渲染 */
  message: string | null | undefined;
  /** 测试定位用（NewChatView 那条一直是 data-permission-gap）*/
  testId?: string;
}

export function PermissionGapNotice({ message, testId = 'permission-gap' }: PermissionGapNoticeProps) {
  if (!message) return null;
  return (
    <div
      data-permission-gap={testId}
      className="mb-3 flex items-start gap-1.5 rounded-lg px-3 py-2 text-caption"
      style={{
        backgroundColor: 'var(--td-warning-color-1)',
        color: 'var(--tc-warning-text)',
        border: '1px solid var(--td-warning-color-2)',
      }}
    >
      <AlertTriangle size={14} className="mt-[1px] flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}
