import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'tdesign-react';
import type { PermissionOption, PermissionRequest } from '../types';
import type { PendingPermission } from '../permissions/permissionStore';
import {
  formatCountdown,
  remainingMs,
} from '../../shared/permissions';
import { useTranslation } from '../i18n';
import { getToolConfig, RISK_BADGE, FALLBACK_OPTIONS } from './InlinePermissionCard';

interface PermissionCardProps {
  item: PendingPermission;
  /** 会话显示名，用于卡头的「{name} 请求」一行（效果稿 16 号图） */
  sessionLabel: string;
  /**
   * 答复出口。`opts.persistAgent` 只在点了「永久允许」时携带 ——
   * 服务端在同一个请求里落库（键取自服务端元数据，与前端传什么都无关）。
   */
  onResolve: (option: PermissionOption, opts?: { persistAgent?: boolean }) => void;
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

/**
 * 会话列表「等待授权」预览的明细段（P-5）：工具人话 + 命令/路径。
 * 与卡头同一套 TOOL_CONFIG，同一个工具在卡上和列表里必须是同一句话。
 */
export function permissionWaitingDetail(request: PermissionRequest): string {
  const label = getToolConfig(request.toolName).label;
  const cmd = commandOf(request.input);
  return [label, cmd].filter(Boolean).join(' ');
}

export function PermissionCard({ item, sessionLabel, onResolve }: PermissionCardProps) {
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

  // ---- P-4：命令 ≤4 行就不渲染「展开全部」----
  // .tc-permission-cmd 的 max-height 是 4 行（令牌算出来的）。是否真的装不下，
  // 只有量过才知道：scrollHeight 超出可视高度才算溢出。展开态恒显按钮
  //（否则展开后内容装得下、按钮自己消失，「收起」就没了）。
  const cmdRef = useRef<HTMLDivElement | null>(null);
  const [cmdOverflows, setCmdOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = cmdRef.current;
    if (!el) return;
    const measure = () => setCmdOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    // 卡片宽度随窗口 / 侧栏变，量一次不够；ResizeObserver 管容器，resize 管窗口。
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cmd, expanded]);

  /**
   * P-2（2026-11-18）：两步决策（先选范围再确认）改成**一次点击**。
   *
   * 「拒绝 / 仅本次允许 / 本会话允许 / 永久允许」并列，无默认选中 ——
   * 摆默认选中就是在替用户预支一个决定，效果稿明确去掉。
   *
   * 铁律的延伸（原三段选择器的同一把尺子）：三个 allow 按钮只在**三档都有
   * 真档位**时渲染 —— 「仅本次允许」对应 allow_once、「本会话 / 永久」对应
   * allow_always。目录里缺任何一档（ACP 只给了一个 always 档、CLI 双向只有
   * allow/deny），就不画合成按钮，退回原样的选项按钮。摆一个点了没用的档 = 假功能。
   * 「永久允许」= allow_always + persistAgent，不是第四种 kind（服务端契约不新增）。
   */
  const allowOnce = options.find(o => o.kind === 'allow_once');
  const allowAlways = options.find(o => o.kind === 'allow_always');
  const scopeSelectable = Boolean(allowOnce && allowAlways);
  /** 拒绝类按钮维持服务端下发顺序原样渲染，不合并不重排；allow 两档由三个动作按钮替代 */
  const renderedOptions = scopeSelectable
    ? options.filter(o => !o.kind.startsWith('allow'))
    : options;

  return (
    <div data-permission-card={request.requestId}>
      {/* 卡头：工具 + 「谁在请求」+ 右侧状态。
          P-3：右角不再是「无超时」—— 没有超时兜底的适配器（ACP）写「等待你的决定」，
          不把「没有超时」当成需要用户操心的信息；有真实兜底的仍显示倒计时
          （不伪造，见 verify-a132 的 remainingMs 契约）。 */}
      <div className="flex items-center gap-2" data-permission-head>
        <span className="flex items-center gap-1.5" style={{ color: tool.color }}>
          <span className="flex items-center">{tool.icon}</span>
          <span className="text-body-lg font-medium">{tool.label}</span>
        </span>
        {sessionLabel && (
          <span
            className="min-w-0 truncate text-secondary"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            {t('permission.card.requester', { name: sessionLabel })}
          </span>
        )}
        {badge && (
          <span className="text-caption px-1.5 rounded" style={{ backgroundColor: badge.bg, color: badge.fg }}>
            {badge.text}
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-secondary tabular-nums"
          data-permission-decision-state
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          {left === null ? t('permission.waitingDecision') : formatCountdown(left)}
        </span>
      </div>

      {cmd && (
        <div className="pt-2">
          <div
            ref={cmdRef}
            className="tc-permission-cmd rounded-md"
            data-expanded={expanded}
            data-permission-cmd
            style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-primary)' }}
          >
            {cmd}
          </div>
          {(expanded || cmdOverflows) && (
            <button
              type="button"
              className="mt-1 text-secondary"
              data-permission-cmd-toggle
              style={{ color: 'var(--td-brand-color)' }}
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? '收起' : '展开全部'}
            </button>
          )}
        </div>
      )}

      {request.rule && (
        <div className="pt-1 text-secondary" style={{ color: 'var(--td-text-color-secondary)' }}>
          命中规则：{request.rule}
        </div>
      )}

      {item.state === 'stale' && (
        <div className="pt-1 text-secondary" style={{ color: 'var(--td-warning-color)' }}>
          这条已经过期了，服务端按拒绝处理
        </div>
      )}
      {item.state === 'failed' && (
        <div className="pt-1 text-secondary" style={{ color: 'var(--td-error-color)' }}>
          答复没被接受：{item.error}
        </div>
      )}

      {/* 操作行（P-2）：**按服务端下发顺序**渲染拒绝类，一个循环画完。
          不要按「拒绝 / always / 允许」分三组摆 —— 那样 DOM 顺序会被布局意图
          改写，与目录不一致（`verify-a128-permission-ui` 的顺序断言钉这个）。
          颜色 / 字重 / 字号写在 index.css 的 `.tc-permission-option` 里，
          不写内联 —— 全局按钮规则带 !important，内联压不过（A116 的教训）。
          2026-11-18：目录同时含 allow_once/allow_always 时，allow 两档由
          「仅本次允许 / 本会话允许 / 永久允许」三颗一次点击按钮替代（原两步的
          三段选择器 + 确认按钮退役）；否则整行照旧渲染 —— CLI 两档、ACP 单
          always 档、无 options 兜底都不变。 */}
      {/* 效果稿 16 号图的提示行：说明这一行是一次点击即生效的范围决策。
          只在三个合成动作在场时渲染（CLI 两档 / ACP 单档 / 兜底不加这段话）。 */}
      {scopeSelectable && (
        <div
          className="mt-2.5 text-body"
          data-permission-scope-title
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          {t('permission.scope.title')}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2" data-permission-actions>
        {renderedOptions.map(option => {
          const isAllow = option.kind.startsWith('allow');
          const isAlways = option.kind.endsWith('_always');
          return (
            <Button
              key={option.id}
              className="tc-permission-option"
              /* 2026-11-18：不再用 small 档。四颗决策按钮是这张卡的提交级动作，
                 走 A124 的 32 档（几何由 .tc-permission-option 引用 --tc-btn-* 令牌）。 */
              theme={isAllow ? 'success' : 'danger'}
              variant={isAlways ? 'outline' : 'text'}
              onClick={() => onResolve(option)}
              title={option.note}
              data-permission-option={option.id}
              data-permission-kind={option.kind}
            >
              {option.label}
            </Button>
          );
        })}
        {scopeSelectable && allowOnce && (
          <Button
            className="tc-permission-option"
            variant="outline"
            onClick={() => onResolve(allowOnce)}
            title={allowOnce.note}
            data-permission-option={allowOnce.id}
            data-permission-kind="allow_once"
            data-permission-action="once"
          >
            {t('permission.action.once')}
          </Button>
        )}
        {scopeSelectable && allowAlways && (
          <Button
            className="tc-permission-option"
            variant="outline"
            onClick={() => onResolve(allowAlways)}
            title={allowAlways.note}
            data-permission-option={allowAlways.id}
            data-permission-kind="allow_always"
            data-permission-action="session"
          >
            {t('permission.action.session')}
          </Button>
        )}
        {scopeSelectable && allowAlways && (
          <Button
            className="tc-permission-option"
            /* 「永久允许」是一次点击里最重的一档：title 带持久化边界说明
               （可撤销 + 门禁仍在）。没有两步流程可展开说明，悬停就是唯一位置。 */
            variant="outline"
            onClick={() => onResolve(allowAlways, { persistAgent: true })}
            title={t('permission.scope.agentHint')}
            data-permission-option={allowAlways.id}
            data-permission-kind="allow_always"
            data-permission-action="agent"
            data-permission-persist="1"
          >
            {t('permission.action.agent')}
          </Button>
        )}
      </div>
    </div>
  );
}
