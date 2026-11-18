import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Pencil, Menu, Workflow, GitBranch } from 'lucide-react';
import { GroupAvatar } from './UserAvatar';
import { PanelHeader } from './PanelHeader';
import { KbScopeChip } from './kb/KbScopeChip';
import { ORCHESTRATION_META, type OrchestrationMode, type RegisteredAgent } from '../types';
import { useGroupWorktree, setGroupWorktree } from '../sessionFlags';

/**
 * 群聊头部。
 *
 * ## 为什么必须复用 PanelHeader
 *
 * 头部规范是全应用统一的（字号 / 内边距 / 底边线高度），全部收敛在
 * PanelHeader 里定义一次。群聊头部的信息量比一对一多（成员头像 +
 * 编排模式 + 人数），但那是**内容**的差异，不是**规格**的差异 ——
 * 所以这里只往 PanelHeader 的 leading / badge / actions
 * 四个槽位里填东西，不自己写 <header>。否则两栏的分隔线立刻对不齐。
 *
 * ## 与一对一头保持同一规格（compact）
 *
 * 一对一头部已压成 52px 单行（见 ChatHeader 的注释）。群聊头部跟着用同一
 * 规格：头像与模式选择保留（那是群聊的识别信息与控制），删除收进「⋯」。
 * 副标题（模式说明）移入模式选择器的下拉里 —— 单行头部没有第二行的位置。
 *
 * ## leading 是三处共用的 GroupAvatar（2026-11-12）
 *
 * 原先这里一份「成员头像负 margin 叠放」、选了预设才换 GroupAvatar；
 * 批准稿把拼贴定为群的默认脸，成员堆叠的职责整个交给 GroupAvatar 的
 * 拼贴档（前 4 位、圆形裁切）。成员格保留 P7 的「点头像看详情」手势。
 *
 * ## 「⋯」是群设置面板，不是下拉菜单（P7）
 *
 * 早先这里挂一个只有「删除群聊」的下拉。群设置其实是七八项
 * （成员 / 我的昵称 / 备注 / 置顶 / 免打扰 / 消息接收方式 / 清记录 / 退群），
 * 下拉塞不下也说不清，改成右侧滑出的 `GroupSettingsPanel` ——
 * 面板本体、每项的交互与文案都在那个文件里，这里只负责开门。
 */

const MODE_ORDER: OrchestrationMode[] = ['dispatch', 'leader', 'broadcast', 'relay', 'debate', 'mention'];

interface GroupChatHeaderProps {
  title: string;
  members: RegisteredAgent[];
  /** 在线成员数（成员里 availability === 'ready' 的） */
  onlineCount: number;
  orchestration: OrchestrationMode;
  onOrchestrationChange: (mode: OrchestrationMode) => void;
  /**
   * 改群名。回车或失焦保存、Esc 取消、空值/没改动都不触发。
   *
   * 群名是唯一一个「用户随手就能改、改完立刻想看到」的群属性，
   * 所以不做成对话框：点一下群名就地变成输入框，回车即生效。
   */
  onRename: (title: string) => void;
  /** 打开 Agent 详情弹窗（点头像） */
  onShowAgentDetail: (agentId: string) => void;
  /**
   * 群设置面板的开关状态。
   *
   * 2026-10-20：状态**上移到 ChatPage**。面板不再是 portal 浮层，而是会话区
   * 右侧的一个布局栏（与成员栏同宽、同起止），必须由会话区的所有者渲染。
   * 头部只负责那颗「⋯」的视觉状态与点击。
   */
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  /** 单栏（窄屏）模式下返回列表；宽屏不传 */
  onBack?: () => void;
  /** A41：打开动态工作流弹窗（写脚本自己组合成员） */
  onOpenWorkflow: () => void;
  /**
   * A115：群头像（头像预设 id）。用户在群设置里换的。
   * 2026-11-12 起是渲染链的一环（image > 预设 > 拼贴），不再单独决定
   * 「显示头像还是成员堆叠」。
   */
  groupAvatar?: string;
  /**
   * 2026-11-12：自定义图片头像（sessionFlags.avatarImage）。最高优先，
   * 空串 = 没上传，落到预设 / 拼贴。
   */
  groupAvatarImage?: string;
  /** 知识库按会话维度开关，群聊同样适用 */
  sessionId?: string;
  /**
   * A225：本群是否具备并行隔离的条件（绑定了目录且是 git 仓库）。
   * false 时开关置灰并说明原因 —— 点了也不会生效的开关是假控件。
   */
  worktreeAvailable?: boolean;
}

export function GroupChatHeader({
  title,
  members,
  onlineCount,
  orchestration,
  onOrchestrationChange,
  onRename,
  onShowAgentDetail,
  settingsOpen,
  onSettingsOpenChange,
  onBack,
  onOpenWorkflow,
  groupAvatar,
  groupAvatarImage,
  sessionId,
  worktreeAvailable = false,
}: GroupChatHeaderProps) {
  /** 正在就地改群名 */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * S2-1（审查报告）：点禁用态「隔离」时弹出的原因浮层。
   * 禁用原因原来只藏在 title 悬停里（A08/A17：禁用原因属于必要反馈），
   * 触屏 / 不悬停的用户永远看不到。现在点一下就给一行原因 +「去绑定」入口。
   */
  const [isolateHintOpen, setIsolateHintOpen] = useState(false);
  const isolateHintRef = useRef<HTMLDivElement>(null);
  // A225：并行隔离开关（sessionFlags 本机偏好，随每轮请求下发）
  const worktreeOn = useGroupWorktree(sessionId);
  /**
   * 一次编辑是否已经收尾。
   *
   * 回车保存后输入框失焦会再触发一次 onBlur —— 没有这个标记，回车
   * 会保存两次（第二次因为 `editing` 还是闭包里的旧值而漏过判断）。
   * Esc 取消同理：取消之后失焦不该又把内容存进去。
   */
  const settledRef = useRef(false);
  const modeMeta = ORCHESTRATION_META[orchestration];

  const startRename = () => {
    setDraft(title);
    settledRef.current = false;
    setEditing(true);
  };

  // S2-1：原因浮层的点外关闭（与 ModePicker 的 outside-click 同一手法）
  useEffect(() => {
    if (!isolateHintOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!isolateHintRef.current?.contains(e.target as Node)) setIsolateHintOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [isolateHintOpen]);

  const settleRename = (save: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
    if (!save) return;
    const next = draft.trim();
    // 空名字等于「把群名删了」—— 群在列表里就没了标题，只能退回成员名拼接。
    // 与其留下一个更难认的群，不如什么都不做。
    if (next && next !== title) onRename(next);
  };

  return (
    <PanelHeader
      compact
      // 与一对一头部共用同一套「按行宽降级」的容器查询（见 kb-ui.css 的
      // .chat-row）。群聊这一行同样会因右侧面板展开而变窄，媒体查询只认
      // 窗口宽度，裁掉的会是群名 —— 所以容器要挂在这一行，而不是 header。
      rowClassName="chat-row"
      // A103（需求）：与 ChatHeader 同步 —— 会话头部改用框架面 chrome，
      // 和左边消息列表栏同色。一对一与群聊是同一个位置的两副内容，
      // 只有一套配色，不能一个白一个灰。
      surface="chrome"
      onBack={onBack}
      backLabel="返回消息列表"
      // leading 一律是三处共用的 GroupAvatar（2026-11-12 批准稿）：
      // 自定义图片 > 预设 > 成员拼贴（前 4 位）> Users 兜底，渲染链收在
      // GroupAvatar 一处。头部这一颗用 28px 小档（效果稿的 mini-gav）；
      // 成员格仍是按钮，点头像看该成员详情（P7 手势保留，p7 闸门按
      // data-member-avatar 点）。
      leading={
        <GroupAvatar
          avatar={groupAvatar}
          image={groupAvatarImage}
          members={members.map(m => ({
            id: m.id,
            name: m.name,
            icon: m.icon,
            src: m.logoUrl,
            color: m.color,
          }))}
          size={28}
          title={title}
          onMemberClick={onShowAgentDetail}
        />
      }
      // 群名后面直接带人数与在线数（S2-2 / 审查报告：「群名（2 人 · 2 在线）」
      // 一处说完，不再「（2）」+ 右侧「● 2 在线」两处分述）。群名本身是个
      // 按钮：点一下就地改名（见 onRename 的注释）。
      title={
        editing ? (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                settleRename(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                // 别让 Esc 冒到上层（会话页/弹窗也监听 Esc）
                e.stopPropagation();
                settleRename(false);
              }
            }}
            onBlur={() => settleRename(true)}
            aria-label="群聊名称"
            className="w-[180px] rounded-md px-1.5 py-0.5 text-title-lg font-semibold outline-none"
            style={{
              backgroundColor: 'var(--tc-surface-raised)',
              border: '1px solid var(--td-brand-color)',
              color: 'var(--td-text-color-primary)',
            }}
          />
        ) : (
          <button
            type="button"
            onClick={startRename}
            title="点击修改群名"
            aria-label={`群名：${title}，点击修改`}
            className="group/name -mx-1 flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
          >
            {/* 群名允许截断，但截断后的全名要能读回来（原生悬停提示）。
                h1 自带 truncate，这里再套一层只为挂 title —— 与单聊头部一致。 */}
            <span className="min-w-0 truncate" title={title}>{title}</span>
            <span
              data-chat-status
              className="shrink-0 whitespace-nowrap text-body font-normal"
              style={{ color: 'var(--td-text-color-placeholder)' }}
              title={`${onlineCount} 个成员在线`}
            >
              {/* 一个模板字符串而不是 `（{n}）`：后者会拆成三个文本节点，
                  取 innerText 时变成「（ 2 ）」，对断言和读屏都更糟 */}
              {`（${members.length} 人 · ${onlineCount} 在线）`}
            </span>
            {/* 铅笔只在悬停时出现：常驻的话，52px 的头部会多出一个
                看起来能点的图标，而它其实是「点群名」这个动作的注解 */}
            <Pencil
              size={12}
              className="shrink-0 opacity-0 transition-opacity group-hover/name:opacity-100"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            />
          </button>
        )
      }
      actions={
        <>
          {/* 知识库入口：范围只在当前会话内生效，群聊同样给会话级开关 */}
          {sessionId && <KbScopeChip sessionId={sessionId} sessionTitle={title} />}
          {/* A41：动态工作流入口。放在模式切换旁边 —— 两者是同一层东西的
              两种选择：「固定模式一句话」与「写脚本自由编排」。 */}
          <button
            type="button"
            onClick={onOpenWorkflow}
            data-chat-workflow
            title="动态工作流：写一段脚本自己组合成员"
            aria-label="动态工作流"
            className="flex h-8 items-center gap-1 rounded-lg bg-transparent px-2 text-xs transition-colors hover:bg-[var(--tc-fill-hover)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <Workflow size={14} />
            工作流
          </button>

          {/* A225：并行隔离开关。与工作流按钮同规格；选中态与 ModePicker 同档
              （品牌色浅底）。开关状态在 sessionFlags（本机偏好），随请求下发。
              不满足条件（没绑 git 目录）时置灰 —— S2-1（审查报告）：置灰的
              原因原来只藏在 title 悬停里，点了没反应也没解释；现在点击禁用态
              会弹出 1 行原因 +「去绑定」入口（下方浮层）。按钮本身保持可点
              （点=说明原因），用 aria-disabled 语义标记不可用。 */}
          <div className="relative" ref={isolateHintRef}>
            <button
              type="button"
              onClick={() => {
                if (sessionId && worktreeAvailable) {
                  setIsolateHintOpen(false);
                  setGroupWorktree(sessionId, !worktreeOn);
                } else {
                  setIsolateHintOpen(v => !v);
                }
              }}
              aria-disabled={!worktreeAvailable}
              aria-pressed={worktreeAvailable ? worktreeOn : undefined}
              aria-expanded={!worktreeAvailable ? isolateHintOpen : undefined}
              data-chat-worktree
              data-chat-worktree-available={worktreeAvailable ? '1' : '0'}
              title={
                worktreeAvailable
                  ? worktreeOn
                    ? '并行隔离已开：本轮每个成员在独立检出中执行，结束后汇合'
                    : '并行隔离已关：各成员在共享目录执行'
                  : '先在群里绑定一个 git 仓库目录，才能开启并行隔离'
              }
              aria-label="并行隔离"
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs transition-colors hover:bg-[var(--tc-fill-hover)]"
              style={{
                backgroundColor: worktreeOn ? 'var(--td-brand-color-light)' : undefined,
                color: worktreeOn
                  ? 'var(--td-brand-color)'
                  : 'var(--td-text-color-secondary)',
                opacity: worktreeAvailable ? 1 : 0.45,
                cursor: worktreeAvailable ? 'pointer' : 'not-allowed',
              }}
            >
              <GitBranch size={14} />
              隔离
            </button>
            {isolateHintOpen && !worktreeAvailable && (
              /* 单行原因浮层：锚定在「隔离」下方。工作流 / 分派的首次使用
                  副说明也走同一 pattern（静态引导，见效果图 02 的 NOTES）。 */
              <div
                data-chat-worktree-hint
                role="status"
                className="tc-glass tc-pop-in absolute right-0 top-full z-30 mt-1 flex w-[300px] items-center gap-2 rounded-xl px-3 py-2 shadow-popup"
              >
                <span className="min-w-0 flex-1 text-caption leading-4" style={{ color: 'var(--td-text-color-secondary)' }}>
                  先在群里绑定一个 git 仓库目录，才能开启并行隔离。
                </span>
                {onSettingsOpenChange && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                    style={{ color: 'var(--td-brand-color)' }}
                    data-chat-worktree-bind
                    onClick={() => {
                      setIsolateHintOpen(false);
                      onSettingsOpenChange(true);
                    }}
                  >
                    去绑定
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 编排模式切换：群聊的核心控制，放在头部操作区 */}
          <div className="relative">
            <ModePicker
              value={orchestration}
              onChange={onOrchestrationChange}
              label={modeMeta.label}
            />
          </div>

          {/* 「⋯」→ 群聊设置面板（右侧滑出）。不再是下拉菜单：
              群设置有七八项，下拉既塞不下也说不清。

              这颗按钮是**开关**：点一次开、再点一次关。用户明确要求
              「再次点击群聊设置按钮即可消失，无需点击空白处」——
              以前它只会 `setSettingsOpen(true)`，关只能靠点蒙层或 X。 */}
          <button
            type="button"
            onClick={() => onSettingsOpenChange(!settingsOpen)}
            data-chat-more
            title={settingsOpen ? '关闭群聊设置' : '群聊设置'}
            aria-label={settingsOpen ? '关闭群聊设置' : '群聊设置'}
            aria-expanded={settingsOpen}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-transparent transition-colors hover:bg-[var(--tc-fill-hover)]"
            style={{
              /* A75：展开态 = 选中回显，走 selected 档（与导航、会话行、下拉
                 选中同一档）。
                 A84（需求）：关着的时候不再保留那层「常态浅底」。原来的
                 理由是「它在一片白里是唯一入口，看不见就等于没有」—— 但图标
                 本身（16px 的齿轮描边，secondary 色）在浅底上本来就看得见，
                 垫一块灰只是让它看起来像已经被按下了。真正需要「显形」的是
                 hover 那一刻，所以底色只在 hover / 展开时出现。 */
              /* 非展开态留 undefined 而不是 'transparent'：内联 transparent 会压死
                 类名里的 hover:bg-[...]（A75 在 NavRail 踩过同一个坑）。 */
              backgroundColor: settingsOpen ? 'var(--tc-fill-selected)' : undefined,
              color: settingsOpen
                ? 'var(--td-text-color-primary)'
                : 'var(--td-text-color-secondary)',
            }}
          >
            {/* 三横线（Menu）：与左侧导航条的设置入口同一视觉语言。
                原来是齿轮，但面板展开的是一列分区，汉堡菜单更贴切。 */}
            <Menu size={16} />
          </button>
        </>
      }
    >
    </PanelHeader>
  );
}

/**
 * 编排模式选择器。
 *
 * 用原生 details/summary 而不是 TDesign Select：选项只有 5 个且每项都要
 * 带一句说明，Select 的窄下拉塞不下两行文字。
 * 注意：details 不会自动在点击空白处收起，需要手动补 outside-click。
 */
function ModePicker({
  value,
  onChange,
  label,
}: {
  value: OrchestrationMode;
  onChange: (mode: OrchestrationMode) => void;
  label: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    // A118：用 pointerdown 而非 click —— 输入框（t-chat-sender 的 shadow）
    // 会吞掉 mousedown / click，导致「点输入框关不掉这个下拉」。
    // 实测与完整说明见 WorkspaceBadge。
    const onDown = (e: PointerEvent) => {
      const el = detailsRef.current;
      if (el?.open && !el.contains(e.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  return (
    <details ref={detailsRef} className="relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-1 rounded-lg bg-transparent px-2.5 py-1.5 text-secondary transition-colors hover:bg-[var(--tc-fill-hover)]"
        style={{ color: 'var(--td-text-color-secondary)' }}
        title="切换编排模式"
      >
        <span className="font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {label}
        </span>
        <ChevronDown size={13} />
      </summary>

      <div
        className="tc-glass absolute right-0 top-full z-30 mt-1 w-[280px] overflow-hidden rounded-xl py-1 shadow-popup"
        data-orchestration-menu
      >
        {MODE_ORDER.map(mode => {
          const meta = ORCHESTRATION_META[mode];
          const active = mode === value;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onChange(mode)}
              // A50：与 menuItem.ts 同一套外形 —— 自己带圆角 + 左右内缩 4px，
              // 否则「当前模式」那块底色会从浮层圆角处溢出成直角。
              // 顺带补上 hover 反馈：这一列原来只有选中态，鼠标划过去毫无反应。
              // 选中项走内联 backgroundColor（优先级高于 hover 类），保持品牌色。
              className="mx-1 block w-[calc(100%_-_8px)] rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
              // 只有选中项写内联底色。⚠️ 非选中项**不能**写
              // `backgroundColor: 'transparent'` —— 内联样式优先级高于
              // hover 类，会把上面那句 hover 反馈整个压死（实测：五项里
              // 四项 hover 不变色）。
              style={active ? { backgroundColor: 'var(--td-brand-color-light)' } : undefined}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="text-body font-medium"
                  style={{ color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-primary)' }}
                >
                  {meta.label}
                </span>
                {active && <Check size={13} style={{ color: 'var(--td-brand-color)' }} />}
              </div>
              <div
                className="mt-0.5 text-caption leading-4"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                {meta.description}
              </div>
            </button>
          );
        })}
      </div>
    </details>
  );
}
