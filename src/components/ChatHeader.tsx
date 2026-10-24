import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, PanelRight } from 'lucide-react';
import { PanelHeader } from './PanelHeader';
import { AgentDetailModal } from './AgentDetailModal';
import { ConfirmDialog } from './ConfirmDialog';
import { WorkspaceBadge } from './WorkspaceBadge';
import { MENU_ITEM_TEXT_CLASS } from './menuItem';
import { AVAILABILITY_META, type RegisteredAgent } from '../types';
import type { ScenarioTemplate } from '../scenarios';
import { useAgentRemarks } from '../agentRemarks';

interface ChatHeaderProps {
  agent: RegisteredAgent | undefined;
  /** 会话已绑定但 Agent 未注册（例如后端已下线该 Agent）时的兜底标题 */
  fallbackTitle: string;
  isLoading: boolean;
  /** P4：会话绑定的场景（有则显示场景标签） */
  scenario?: ScenarioTemplate;
  /** A63：会话的工作目录（undefined = 未指定，Agent 用后端进程目录） */
  cwd?: string;
  /** A63：换工作目录。'' = 清空回默认。不传则栏头不渲染工作区徽标 */
  onCwdChange?: (cwd: string) => void;
  /** A77：工作区文件面板是否展开 */
  workspaceOpen?: boolean;
  /** A77：展开 / 收起工作区文件面板。不传则不渲染开关（窄屏单栏模式） */
  onToggleWorkspace?: () => void;
  onDelete: () => void;
  /** 单栏（窄屏）模式下返回列表；宽屏不传 */
  onBack?: () => void;
}

/**
 * 会话头部（一对一）—— 一行紧凑条。
 *
 * ## 从「88px 联系人卡片」压成「52px 一行」
 *
 * 原来这里是 PanelHeader 的标准规格：头像 + 名字 + 在线状态 + 模型按钮 +
 * 详情 + 删除，88px 高。看着像一张名片，但它每天出现几十次，而**聊天区
 * 才是用户真正要看的地方** —— 一道 88px 的横条压在消息列表上面，
 * 窄窗口里能少看好几条消息。
 *
 * 现在的取舍：
 *   - **不显示头像**：头像在消息流里每条都有，头部再放一个大的属于重复；
 *     名字 + 状态点已经说清「在跟谁说话」。
 *   - **模型选择移出头**：输入框底部本来就有模型下拉（ChatInput 的
 *     footer-prefix），头部再放一个同功能按钮是冗余控件。
 *   - **详情 / 删除收进「⋯」**：两个低频操作不值得常驻右侧。
 *     菜单用原生 details/summary（与群聊的模式选择同一手法）——
 *     点外面自动收起，不用自己管 outside-click。
 *
 * ## 详情是弹窗，不是抽屉
 *
 * 早先点「Agent 详情」会在头部内部展开一块详情区，把消息区整体往下推。
 * 现在改成浮层弹窗（AgentDetailModal）：背后的会话一动不动，点空白即关。
 * 这样头部高度永远是 52px，两栏的分隔线不会跳。
 */
export function ChatHeader({
  agent,
  fallbackTitle,
  // isLoading 仍留在 props 里（调用方与 UI 探针都用它表达「正在生成」），
  // 但头部不再渲染任何「正在输入」的字样 —— 见上面 badge 里的注释。
  scenario,
  cwd,
  onCwdChange,
  workspaceOpen,
  onToggleWorkspace,
  onDelete,
  onBack,
}: ChatHeaderProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const moreRef = useRef<HTMLDetailsElement>(null);
  /** 备注优先：列表里显示什么名字，头部就显示什么名字，不能两处不一致 */
  const remarks = useAgentRemarks();
  const displayName = (agent && remarks[agent.id]) || agent?.name || fallbackTitle;

  const avail = agent?.status.availability;
  const meta = avail ? AVAILABILITY_META[avail] : null;

  const closeMore = () => {
    if (moreRef.current) moreRef.current.open = false;
  };

  // details 元素不会自动在点击空白处收起，需要手动补
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = moreRef.current;
      if (el?.open && !el.contains(e.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <PanelHeader
      compact
      surface="content"
      className="relative"
      onBack={onBack}
      backLabel="返回消息列表"
      title={displayName}
      badge={
        <>
          {/* 在线状态紧贴名字：IM 里「在跟谁说话 / 他能不能回」是同一眼要读到的信息 */}
          {meta ? (
            <span
              className="flex items-center gap-1 text-secondary"
              style={{ color: meta.color }}
              title={agent?.status.message || meta.label}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.dot }} />
              {meta.label}
            </span>
          ) : (
            <span className="text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
              离线
            </span>
          )}
          {scenario && (
            <span
              className="rounded px-1.5 py-[1px] text-caption"
              style={{ backgroundColor: `${scenario.color}1f`, color: scenario.color }}
              title={`场景：${scenario.description}`}
            >
              {scenario.label}
            </span>
          )}
          {/* A35（用户反馈）：这里原来还有一个「正在输入…」小徽标，删掉了。
              理由有二：
                1. 它是**假的** —— 这个位置跟的是「对方正在敲键盘」这个 IM 语义，
                   而 Agent 不会先敲再发，请求一发出去就已经在生成；
                2. 它是**多余的** —— 消息流末尾的状态行（正在处理 / 正在思考 /
                   正在调用工具）比这里更准确，还会走进度秒数。两处同时闪，
                   等于同一件事说两遍。 */}
        </>
      }
      actions={
        <>
          {/* A63：工作区徽标。最左 —— 它表达的是「当前在哪儿干活」，
              是随时要看的状态；删除是低频操作，继续躲在 ⋯ 里。 */}
          {onCwdChange && <WorkspaceBadge cwd={cwd} onChange={onCwdChange} />}
          {/* A82（用户要求）：工作区开关紧贴「⋯」的**左侧**。

              原先它在整行最左边，和 ⋯ 之间隔着工作区徽标 —— 两个都是
              28px 的图标按钮，却被一条文字徽标隔开，看着像两组无关的控件。
              现在右侧这一组是「面板开关 + 更多」，内容状态徽标在它们左边：
              同一类的东西挨着，人才不用在脑子里给它们分组。

              A84（用户要求）：**面板展开后这里不再出现这个按钮** ——
              展开态下同一枚按钮已经搬到工作区栏头的原「×」位置，由它自己
              充当收起入口。两处同时留一个「收起工作区」，等于同一件事说两遍；
              而且栏头的那个离面板本体更近，符合「收起谁就点谁」的直觉。
              另外去掉它常驻的 --tc-active-chrome 底色：这个按钮从来不是
              「选中项」，只是一个开关，常驻底色会让人误读成已激活状态。 */}
          {onToggleWorkspace && !workspaceOpen && (
            <button
              type="button"
              onClick={onToggleWorkspace}
              title="展开工作区"
              aria-label="展开工作区"
              data-workspace-toggle="expand"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-transparent transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              <PanelRight size={16} />
            </button>
          )}
          <details ref={moreRef} className="relative" data-chat-more>
          <summary
            className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg bg-transparent transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
            title="更多"
            aria-label="更多操作"
          >
            <MoreHorizontal size={16} />
          </summary>

          <div
            className="tc-glass absolute right-0 top-full z-30 mt-1 w-[160px] overflow-hidden rounded-xl py-1 shadow-popup"
            data-chat-more-menu
            /* P2：给浮层哨兵一个识别点。这个菜单是自绘的（不是 TDesign 弹层），
                       不加这个属性，浏览器预览视图会把它盖住 —— 用户看到的是
                       「点了 ⋯ 没反应」。 */
            data-opc-overlay
          >
            <button
              type="button"
              onClick={() => {
                closeMore();
                setShowDetail(true);
              }}
              className={MENU_ITEM_TEXT_CLASS}
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              Agent 详情
            </button>
            <button
              type="button"
              onClick={() => {
                closeMore();
                setConfirmDelete(true);
              }}
              className={MENU_ITEM_TEXT_CLASS}
              style={{ color: 'var(--td-error-color)' }}
            >
              删除会话
            </button>
          </div>
        </details>
        </>
      }
    >
      {/* 详情改成浮层弹窗：不再往下顶消息区，点空白即关 */}
      <AgentDetailModal open={showDetail} agent={agent} onClose={() => setShowDetail(false)} />

      {/* 删除确认：与会话列表同一个对话框（两步确认，不误删） */}
      <ConfirmDialog
        open={confirmDelete}
        title="删除会话"
        confirmText="删除"
        danger
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      >
        删除后聊天记录不可恢复。删除的只是这个会话，不会影响 Agent 本身。
      </ConfirmDialog>
    </PanelHeader>
  );
}
