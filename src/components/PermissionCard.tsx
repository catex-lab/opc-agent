import { useEffect, useRef, useState } from 'react';
import { Button } from 'tdesign-react';
import type { PermissionOption } from '../types';
import type { PendingPermission } from '../permissions/permissionStore';
import {
  formatCountdown,
  remainingMs,
  type PermissionScopeKind,
} from '../../shared/permissions';
import { useTranslation, type MessageKey } from '../i18n';
import { getToolConfig, RISK_BADGE, FALLBACK_OPTIONS } from './InlinePermissionCard';

interface PermissionCardProps {
  item: PendingPermission;
  /** 会话显示名，用于「这条是谁的」徽标（非当前会话时必须看得见） */
  sessionLabel: string;
  isCurrentSession: boolean;
  /**
   * 答复出口。`opts.persistAgent` 只在授权范围选了「该 Agent 永久」时携带 ——
   * 服务端在同一个请求里落库（键取自服务端元数据，与前端传什么都无关）。
   */
  onResolve: (option: PermissionOption, opts?: { persistAgent?: boolean }) => void;
  /**
   * 授权范围（2026-11-12 变体 A）。状态由 Dock 持有而不是卡片自持：
   * Enter 快捷键在 Dock 上，它必须按**当前选中**的范围答复，两处各抄一份
   * 迟早漂移。卡片挂载新请求时由 Dock 负责重置为「仅本次」。
   */
  scope: PermissionScopeKind;
  onScopeChange: (scope: PermissionScopeKind) => void;
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

/** 三段选择器的段定义。segment 与选项 kind 的映射见各段的 option 解析。 */
const SCOPE_SEGMENTS: Array<{
  kind: PermissionScopeKind;
  titleKey: MessageKey;
  descKey: MessageKey;
}> = [
  { kind: 'once', titleKey: 'permission.scope.once', descKey: 'permission.scope.onceDesc' },
  { kind: 'session', titleKey: 'permission.scope.session', descKey: 'permission.scope.sessionDesc' },
  { kind: 'agent', titleKey: 'permission.scope.agent', descKey: 'permission.scope.agentDesc' },
];

export function PermissionCard({
  item,
  sessionLabel,
  isCurrentSession,
  onResolve,
  scope,
  onScopeChange,
}: PermissionCardProps) {
  const { t } = useTranslation();
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

  /**
   * 授权范围选择器（2026-11-12 变体 A）。
   *
   * 铁律的延伸：选择器只在**三段都有真档位**时渲染 —— 「仅本次」对应
   * allow_once、「本会话 / 该 Agent 永久」对应 allow_always。目录里缺任何
   * 一档（ACP 只给了一个 always 档、CLI 双向只有 allow/deny），就不画，
   * 退回原样的选项按钮。摆一个点了没用的段 = 假功能。
   */
  const allowOnce = options.find(o => o.kind === 'allow_once');
  const allowAlways = options.find(o => o.kind === 'allow_always');
  const scopeSelectable = Boolean(allowOnce && allowAlways);
  /** 选中的段实际回传的那一档：仅本次 → allow_once，其余两段 → allow_always */
  const confirmOption = (scope === 'once' ? allowOnce : allowAlways) ?? null;
  const confirmLabel =
    scope === 'agent'
      ? t('permission.scope.confirmAgent')
      : scope === 'session'
        ? t('permission.scope.confirmSession')
        : t('permission.scope.confirmOnce');
  /** 拒绝类按钮维持服务端下发顺序原样渲染，不合并不重排；allow 两档由选择器替代 */
  const renderedOptions = scopeSelectable
    ? options.filter(o => !o.kind.startsWith('allow'))
    : options;

  // ---- 三段选择器的键盘无障碍（radiogroup 语义）----
  // 方向键在段间循环并把焦点跟着移过去（roving tabindex：选中段 tabIndex=0，
  // 其余 -1）；空格选中焦点所在段。与骨架行 / 焦点陷阱同一套 a11y 档。
  const segRefs = useRef<Array<HTMLDivElement | null>>([]);
  const onScopeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const focusedKind = target?.getAttribute?.('data-permission-scope-option');
    let next: PermissionScopeKind | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = scope === 'agent' ? 'once' : scope === 'once' ? 'session' : 'agent';
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = scope === 'once' ? 'agent' : scope === 'session' ? 'once' : 'session';
    } else if (e.key === ' ') {
      // 空格 = 选中焦点所在段（radio 惯例），没有焦点段就不吞
      if (focusedKind === 'once' || focusedKind === 'session' || focusedKind === 'agent') {
        e.preventDefault();
        onScopeChange(focusedKind);
      }
      return;
    } else {
      return;
    }
    e.preventDefault();
    onScopeChange(next);
    segRefs.current[SCOPE_SEGMENTS.findIndex(s => s.kind === next)]?.focus();
  };

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

      {/* 授权范围三段选择器（2026-11-12 变体 A）：只在三段都有真档位时渲染。
          样式按效果稿 .seg：三格并排、每格两行（12px semibold 标题 + caption
          说明）、选中 1.5px 品牌描边 + --tc-fill-hover 底、圆角 6、高 44、间距 6。
          说明行用 --text-caption(11px) 而不是效果稿的 10px —— DESIGN-SYSTEM
          的 8 档字号里没有 10px，不为一张卡片新造第九档。 */}
      {scopeSelectable && (
        <div className="px-3 pt-2.5" data-permission-scope>
          <div
            className="text-caption font-semibold"
            style={{
              color: 'var(--td-text-color-secondary)',
              letterSpacing: '0.3px',
              marginBottom: 6,
            }}
          >
            {t('permission.scope.title')}
          </div>
          <div
            className="flex gap-1.5"
            role="radiogroup"
            aria-label={t('permission.scope.title')}
            onKeyDown={onScopeKeyDown}
          >
            {SCOPE_SEGMENTS.map((seg, index) => {
              const selected = scope === seg.kind;
              return (
                <div
                  key={seg.kind}
                  ref={el => {
                    segRefs.current[index] = el;
                  }}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  data-permission-scope-option={seg.kind}
                  onClick={() => onScopeChange(seg.kind)}
                  style={{
                    flex: 1,
                    height: 44,
                    borderRadius: 'var(--td-radius-default)',
                    border: selected
                      ? '1.5px solid var(--td-brand-color)'
                      : '1px solid var(--td-component-stroke)',
                    background: selected
                      ? 'var(--tc-fill-hover)'
                      : 'var(--tc-surface-raised)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1,
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      fontSize: 'var(--text-secondary)',
                      fontWeight: 600,
                      color: selected ? 'var(--td-brand-color)' : 'var(--td-text-color-primary)',
                    }}
                  >
                    {t(seg.titleKey)}
                  </span>
                  <span style={{ fontSize: 'var(--text-caption)', color: 'var(--td-text-color-placeholder)' }}>
                    {t(seg.descKey)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 操作按钮（P4）：**按服务端下发顺序**渲染，一个循环画完。
          不要按「拒绝 / always / 允许」分三组摆 —— 那样 DOM 顺序会被布局意图
          改写成 reject, reject_always, allow_always, allow_once，与目录不一致
          （`verify-a128-permission-ui` 的 [1] 就是钉这个的）。
          靠右对齐用容器上的 ml-auto，不靠重排子元素。
          颜色 / 字重 / 字号写在 index.css 的 `.tc-permission-option` 里，
          不写内联 —— 全局按钮规则带 !important，内联压不过（A116 的教训）。
          2026-11-12 变体 A：目录同时含 allow_once/allow_always 时，allow 两档
          由上方三段选择器 + 确认主按钮替代（拒绝类按钮原样保留）；否则整行
          照旧渲染 —— CLI 两档、ACP 单 always 档、无 options 兜底都不变。 */}
      <div className="ml-auto flex items-center gap-2 px-3 py-2.5">
        {renderedOptions.map(option => {
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
        {scopeSelectable && confirmOption && (
          <Button
            /* 确认主按钮：文案随范围变化。走 `.tc-btn-brand` 32 档 ——
               它是这一行的提交级动作，不再是行内选项。锚点沿用
               data-permission-option（= 当前选中段的选项 id），
               Dock 的队列打靶与快捷键都按它定位。 */
            className="tc-btn-brand"
            onClick={() =>
              onResolve(confirmOption, scope === 'agent' ? { persistAgent: true } : undefined)
            }
            title={allowAlways?.note}
            data-permission-option={confirmOption.id}
            data-permission-kind={confirmOption.kind}
            data-permission-confirm="1"
          >
            {confirmLabel}
          </Button>
        )}
      </div>

      {/* 选「该 Agent 永久」才出现的边界说明：持久化意味着可撤销 + 门禁仍在 */}
      {scopeSelectable && scope === 'agent' && (
        <div
          className="px-3 pb-2 text-secondary"
          data-permission-scope-hint
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          {t('permission.scope.agentHint')}
        </div>
      )}
    </div>
  );
}
