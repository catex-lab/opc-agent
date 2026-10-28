import { Button } from 'tdesign-react';
import {
  Terminal,
  File,
  FolderOpen,
  Search,
  Code,
  PencilLine,
  Trash2,
} from 'lucide-react';
import { PermissionRequest } from '../types';
import type { PermissionOption } from '../types';

/**
 * A132：组件本体 `InlinePermissionCard` 已不再被渲染（审批改走右下角浮层，
 * 见 `PermissionDock.tsx`）。按 AGENTS §6「不得删除已有文件」不删。
 *
 * `TOOL_CONFIG` / `getToolConfig` / `RISK_BADGE` / `FALLBACK_OPTIONS` 四个映射
 * 被 `PermissionCard` 复用 —— 同一个工具在气泡里和审批卡上必须是同一个颜色、
 * 同一句人话、同一套兜底档位。抄两份必然漂移，所以这里是唯一来源。
 */

interface InlinePermissionCardProps {
  request: PermissionRequest;
  /**
   * 用户选了某一档（P4）。
   *
   * 只回传选项本身，翻译成 behavior / 原因码由 hook 统一做 —— 卡片不碰
   * 网络，也不替适配器决定「始终允许」能不能落地。
   */
  onResolve: (option: PermissionOption) => void;
}

/**
 * 服务端没下发目录时的兜底（历史路径）。
 *
 * 只有两档：没有 always 的承诺，就不摆 always 的按钮。带 always 的选项
 * 必须由真正能记住决定的适配器声明。
 */
export const FALLBACK_OPTIONS: PermissionOption[] = [
  { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
  { id: 'allow_once', kind: 'allow_once', label: '允许' },
];

// 工具名称到图标和颜色的映射
// 颜色走 index.css 的 --tool-color-* 语义变量（腾讯调色板），
// 与 ToolCallsCollapse 里的分类色保持一一对应，避免同一工具
// 在「气泡里」和「权限卡里」显示成两种颜色。
export const TOOL_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  'Bash': { icon: <Terminal />, color: 'var(--tool-color-danger)', label: '执行命令' },
  'Write': { icon: <PencilLine />, color: 'var(--tool-color-file)', label: '写入文件' },
  'Edit': { icon: <PencilLine />, color: 'var(--tool-color-file)', label: '编辑文件' },
  'Read': { icon: <File />, color: 'var(--tool-color-shell)', label: '读取文件' },
  'ReadFile': { icon: <File />, color: 'var(--tool-color-shell)', label: '读取文件' },
  'ListDir': { icon: <FolderOpen />, color: 'var(--tool-color-file)', label: '列出目录' },
  'Search': { icon: <Search />, color: 'var(--tool-color-search)', label: '搜索' },
  'Grep': { icon: <Search />, color: 'var(--tool-color-search)', label: '文本搜索' },
  'Delete': { icon: <Trash2 />, color: 'var(--tool-color-danger)', label: '删除文件' },
  'DeleteFile': { icon: <Trash2 />, color: 'var(--tool-color-danger)', label: '删除文件' },
};

// 获取工具配置
export const getToolConfig = (toolName: string) => {
  return TOOL_CONFIG[toolName] || { 
    icon: <Code />, 
    color: 'var(--td-text-color-secondary)', 
    label: toolName 
  };
};

// 获取文件路径或主要信息
const getMainInfo = (toolName: string, input: Record<string, unknown>): string => {
  if (toolName === 'Bash' && input.command) {
    const cmd = String(input.command);
    return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
  }
  if (input.filePath) {
    return String(input.filePath);
  }
  if (input.path) {
    return String(input.path);
  }
  if (input.target_file) {
    return String(input.target_file);
  }
  // 返回第一个有意义的参数值
  for (const [, value] of Object.entries(input)) {
    if (value && typeof value === 'string') {
      return value.length > 60 ? value.slice(0, 60) + '...' : value;
    }
  }
  return '';
};

// 门禁分级（A40）。safe 不显示徽标；risky/dangerous 由服务端判定后带下来。
// 注意：risk 缺失不等于 safe —— 说明这条请求没经过门禁（CLI/ACP 适配器），
// 此时退回按工具名猜，并且要在气泡上写清楚「未经服务端门禁判定」。
export const RISK_BADGE: Record<'risky' | 'dangerous', { text: string; bg: string; fg: string }> = {
  risky: {
    text: '需确认',
    bg: 'var(--td-warning-color-1)',
    fg: 'var(--td-warning-color)',
  },
  dangerous: {
    text: '高危',
    bg: 'var(--td-error-color-2)',
    fg: 'var(--td-error-color)',
  },
};

export function InlinePermissionCard({ request, onResolve }: InlinePermissionCardProps) {
  const toolConfig = getToolConfig(request.toolName);
  const mainInfo = getMainInfo(request.toolName, request.input);
  // 服务端给了几档就画几档，不补齐 —— 摆了做不到的档位就是假功能
  const options = request.options?.length ? request.options : FALLBACK_OPTIONS;
  // 老口径只按工具名猜；门禁给了结论就以门禁为准
  const nameLooksDangerous = request.toolName === 'Bash' || request.toolName === 'Delete' || request.toolName === 'DeleteFile';
  const gateVerdict = request.risk === 'risky' || request.risk === 'dangerous' ? RISK_BADGE[request.risk] : null;
  const badge = gateVerdict
    ? { ...gateVerdict, note: request.rule }
    : request.risk === undefined && nameLooksDangerous
      ? { text: '⚠️ 危险操作', bg: 'var(--td-error-color-2)', fg: 'var(--td-error-color)', note: '未经服务端门禁判定，按工具名称提示' }
      : null;
  const reason = request.rule && gateVerdict ? `命中规则：${request.rule}` : null;
  return (
    <div className="animate-fade-in flex items-center gap-3 flex-wrap py-2">
      {/* 工具图标和标签
          A84：原先是一枚 `${color}15` 的淡色胶囊。同色低透明度的底把同色图标
          糊成一团，而这行字本来就是「哪个工具要执行」的关键信息，不该被削弱。
          去掉底后只剩彩色图标 + 文字，颜色自己就完成了分类。 */}
      <div
        className="flex items-center gap-2 px-0 py-1.5"
        style={{ color: toolConfig.color }}
      >
        <span className="flex items-center text-base">{toolConfig.icon}</span>
        <span className="text-sm font-medium">{toolConfig.label}</span>
      </div>
      
      {/* 文件路径/命令 */}
      {mainInfo && (
        <code 
          className="text-sm px-2.5 py-1 rounded-md font-mono truncate max-w-[400px]"
          style={{ 
            backgroundColor: 'var(--td-bg-color-component)',
            color: 'var(--td-text-color-primary)'
          }}
          title={mainInfo}
        >
          {mainInfo}
        </code>
      )}
      
      {/* 门禁分级徽标 + 命中规则 */}
      {badge && (
        <span
          className="text-xs px-2 py-0.5 rounded"
          title={badge.note}
          style={{
            backgroundColor: badge.bg,
            color: badge.fg,
          }}
        >
          {badge.text}
        </span>
      )}
      {reason && (
        <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
          {reason}
        </span>
      )}
      
      {/* 操作按钮（P4）：按服务端下发顺序渲染。
          颜色 / 字重 / 字号写在 index.css 的 `.tc-permission-option` 里，
          不写内联 —— 全局按钮规则带 !important，内联压不过（A116 的教训）。 */}
      <div className="flex items-center gap-2 ml-auto">
        {options.map(option => {
          const isAllow = option.kind.startsWith('allow');
          const isPrimary = option.kind === 'allow_once';
          const isAlways = option.kind.endsWith('_always');
          return (
            <Button
              key={option.id}
              className="tc-permission-option"
              /* A137：这一档**刻意**是 24/12px，不是欠账。
                 它是 `.tc-permission-option` 设计常量（index.css 2868 起，12px 字号
                 + 500 字重 + 6px 圆角），由 `verify-a128-permission-ui` 逐项量着。
                 审批选项是叠在气泡里的多颗并排，32 会把卡片撑高一倍。 */
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
