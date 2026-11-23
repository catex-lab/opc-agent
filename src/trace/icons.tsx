/**
 * 过程流图标映射（2026-11-22，参考页 §4 图标表）。
 *
 * 规则：图标只表达**形状**（类型），颜色只表达**状态**（完成灰 / 运行中品牌 /
 * 失败红 / 等待确认琥珀）。所以这里只做「类型 → 图标」的纯函数，颜色由
 * CSS 的 `.pf-step.is-*` / `.pf-panel-row.is-*` 控制。
 *
 * 未知工具名回退 Terminal，绝不报错 —— CLI 的工具名各家不一，回退是常态。
 */
import {
  Brain,
  FileText,
  Search,
  Globe,
  Pencil,
  FilePlus,
  FlaskConical,
  Terminal,
  Bot,
  Plug,
  ShieldAlert,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react';
import { VERIFY_CMD_RE } from '../../shared/trace';

/**
 * @param kind     thinking = 思考，tool = 工具
 * @param toolName 小写工具名
 * @param cmd      shell 工具的 command（判 test/lint/build 归「验证」）
 */
export function flowIcon(kind: 'thinking' | 'tool', toolName: string, cmd = ''): LucideIcon {
  if (kind === 'thinking') return Brain;
  const n = toolName;
  if (n === 'task') return Bot;
  if (n === 'read' || n === 'readfile' || n === 'read_file') return FileText;
  if (n === 'grep' || n === 'glob' || n === 'search') return Search;
  if (n === 'websearch' || n === 'webfetch') return Globe;
  if (n === 'edit' || n === 'editfile' || n === 'multiedit' || n === 'str_replace_editor') return Pencil;
  if (n === 'write' || n === 'writefile' || n === 'create_file') return FilePlus;
  if (n === 'bash' || n === 'shell' || n === 'execute') {
    return VERIFY_CMD_RE.test(cmd) ? FlaskConical : Terminal;
  }
  if (/mcp/i.test(n)) return Plug;
  if (/permission|approval|authoriz/i.test(n)) return ShieldAlert;
  return Terminal;
}

/** 是否「等待确认」（权限类工具）：图标用盾牌 + 琥珀色 */
export function isWaitingTool(kind: 'thinking' | 'tool', toolName: string): boolean {
  return kind === 'tool' && /permission|approval|authoriz/i.test(toolName);
}

export { MessageSquare };
