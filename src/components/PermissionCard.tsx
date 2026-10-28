import { useEffect, useState } from 'react';
import { Button } from 'tdesign-react';
import type { PermissionOption } from '../types';
import type { PendingPermission } from '../permissions/permissionStore';
import { formatCountdown, remainingMs } from '../../shared/permissions';
import { getToolConfig, RISK_BADGE, FALLBACK_OPTIONS } from './InlinePermissionCard';

interface PermissionCardProps {
  item: PendingPermission;
  /** 会话显示名，用于「这条是谁的」徽标（非当前会话时必须看得见） */
  sessionLabel: string;
  isCurrentSession: boolean;
  onResolve: (option: PermissionOption) => void;
}

/** 取命令 / 路径：不再截断（截断即假授权 —— 看不清就点了允许）。 */
const commandOf = (input: Record<string, unknown>): string => {
  const v = input.command ?? input.filePath ?? input.path ?? input.target_file;
  if (typeof v === 'string' && v) return v;
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
};

export function PermissionCard({ item, sessionLabel, isCurrentSession, onResolve }: PermissionCardProps) {
  const { request } = item;
  const tool = getToolConfig(request.toolName);
  const cmd = commandOf(request.input);
  const [expanded, setExpanded] = useState(false);
  const [left, setLeft] = useState(() => remainingMs(item.expiresAt, Date.now()));

  useEffect(() => {
    if (typeof item.expiresAt !== 'number') return;
    const t = setInterval(() => setLeft(remainingMs(item.expiresAt, Date.now())), 1000);
    return () => clearInterval(t);
  }, [item.expiresAt]);

  const options = request.options?.length ? request.options : FALLBACK_OPTIONS;
  // 兜底两档**必须保留**：`verify-a128-permission-ui.mjs` 夹具 [5] 钉的就是
  // 「没下发 options → 只画拒绝/允许两档，不凭空补 always」。allow/deny 是协议下限，
  // 每个适配器都兑现得了；always 才是适配器要自己声明的能力。删掉兜底会弄红那条守卫。
  const badge = request.risk === 'risky' || request.risk === 'dangerous' ? RISK_BADGE[request.risk] : null;

  return (
    <div data-permission-card={request.requestId}>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="text-xs font-medium" style={{ color: 'var(--td-text-color-secondary)' }}>
          {sessionLabel}
        </span>
        {badge && (
          <span className="text-xs px-1.5 rounded" style={{ backgroundColor: badge.bg, color: badge.fg }}>
            {badge.text}
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {left === null ? '无超时' : formatCountdown(left)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 px-3 pt-1 text-sm" style={{ color: tool.color }}>
        <span className="flex items-center">{tool.icon}</span>
        <span className="font-medium">{tool.label}</span>
        {!isCurrentSession && (
          <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>· 非当前会话</span>
        )}
      </div>

      {cmd && (
        <div className="px-3 pt-1.5">
          <div
            className="tc-permission-cmd rounded-md"
            data-expanded={expanded}
            data-permission-cmd
            style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-primary)' }}
          >
            {cmd}
          </div>
          <button
            type="button"
            className="mt-1 text-xs"
            style={{ color: 'var(--td-brand-color)' }}
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? '收起' : '展开全部'}
          </button>
        </div>
      )}

      {request.rule && (
        <div className="px-3 pt-1 text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
          命中规则：{request.rule}
        </div>
      )}

      {item.state === 'stale' && (
        <div className="px-3 pt-1 text-xs" style={{ color: 'var(--td-warning-color)' }}>
          这条已经过期了，服务端按拒绝处理
        </div>
      )}
      {item.state === 'failed' && (
        <div className="px-3 pt-1 text-xs" style={{ color: 'var(--td-error-color)' }}>
          答复没被接受：{item.error}
        </div>
      )}

      {/* 操作按钮（P4）：**按服务端下发顺序**渲染，一个循环画完。
          不要按「拒绝 / always / 允许」分三组摆 —— 那样 DOM 顺序会被布局意图
          改写成 reject, reject_always, allow_always, allow_once，与目录不一致
          （`verify:a128-permission-ui` 的 [1] 就是钉这个的）。
          靠右对齐用容器上的 ml-auto，不靠重排子元素。
          颜色 / 字重 / 字号写在 index.css 的 `.tc-permission-option` 里，
          不写内联 —— 全局按钮规则带 !important，内联压不过（A116 的教训）。 */}
      <div className="ml-auto flex items-center gap-2 px-3 py-2.5">
        {options.map(option => {
          const isAllow = option.kind.startsWith('allow');
          const isPrimary = option.kind === 'allow_once';
          const isAlways = option.kind.endsWith('_always');
          return (
            <Button
              key={option.id}
              className="tc-permission-option"
              /* A137：同 InlinePermissionCard —— `.tc-permission-option` 是设计常量档
                 （24 高 / 12px 字号），不是尺寸欠账，别照着 32 单档改它。 */
              size="small"
              theme={isAllow ? 'success' : 'danger'}
              variant={isPrimary ? 'base' : isAlways ? 'outline' : 'text'}
              onClick={() => onResolve(option)}
              title={option.note}
              data-permission-option={option.id}
              data-permission-kind={option.kind}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
