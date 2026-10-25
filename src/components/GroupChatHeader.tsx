import { useEffect, useRef, useState } from 'react';
import { Users, ChevronDown, Check, Pencil, Menu, Workflow } from 'lucide-react';
import { GroupAvatar } from './UserAvatar';
import { AgentAvatar } from './AgentAvatar';
import { PanelHeader } from './PanelHeader';
import { ORCHESTRATION_META, type OrchestrationMode, type RegisteredAgent } from '../types';

/**
 * 群聊头部。
 *
 * ## 为什么必须复用 PanelHeader
 *
 * 头部规范是全应用统一的（字号 / 内边距 / 底边线高度），全部收敛在
 * PanelHeader 里定义一次。群聊头部的信息量比一对一多（成员头像堆叠 +
 * 编排模式 + 人数），但那是**内容**的差异，不是**规格**的差异 ——
 * 所以这里只往 PanelHeader 的 leading / badge / actions
 * 四个槽位里填东西，不自己写 <header>。否则两栏的分隔线立刻对不齐。
 *
 * ## 与一对一头保持同一规格（compact）
 *
 * 一对一头部已压成 52px 单行（见 ChatHeader 的注释）。群聊头部跟着用同一
 * 规格：头像堆叠与模式选择保留（那是群聊的识别信息与控制），删除收进「⋯」。
 * 副标题（模式说明）移入模式选择器的下拉里 —— 单行头部没有第二行的位置。
 *
 * ## 头像堆叠而不是平铺
 *
 * 群成员可能很多，平铺会占掉整行。用 IM 通用的负 margin 叠放，
 * 超过 4 个就收成「…+N」；点开成员列表可以看到全部。
 *
 * ## 「⋯」是群设置面板，不是下拉菜单（P7）
 *
 * 早先这里挂一个只有「删除群聊」的下拉。群设置其实是七八项
 * （成员 / 我的昵称 / 备注 / 置顶 / 免打扰 / 消息接收方式 / 清记录 / 退群），
 * 下拉塞不下也说不清，改成右侧滑出的 `GroupSettingsPanel` ——
 * 面板本体、每项的交互与文案都在那个文件里，这里只负责开门。
 */

const MODE_ORDER: OrchestrationMode[] = ['dispatch', 'broadcast', 'relay', 'debate', 'mention'];

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
   * 有值时就以它作为头部 leading（替代成员堆叠）—— 换头像的目的就是
   * 「让这个群有个自己的脸」，不显示等于没换。
   * 空串 = 沿用成员堆叠。
   */
  groupAvatar?: string;
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
}: GroupChatHeaderProps) {
  /** 正在就地改群名 */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * 一次编辑是否已经收尾。
   *
   * 回车保存后输入框失焦会再触发一次 onBlur —— 没有这个标记，回车
   * 会保存两次（第二次因为 `editing` 还是闭包里的旧值而漏过判断）。
   * Esc 取消同理：取消之后失焦不该又把内容存进去。
   */
  const settledRef = useRef(false);
  const shown = members.slice(0, 4);
  const rest = members.length - shown.length;
  const modeMeta = ORCHESTRATION_META[orchestration];

  const startRename = () => {
    setDraft(title);
    settledRef.current = false;
    setEditing(true);
  };

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
      // A103（用户要求）：与 ChatHeader 同步 —— 会话头部改用框架面 chrome，
      // 和左边消息列表栏同色。一对一与群聊是同一个位置的两副内容，
      // 只有一套配色，不能一个白一个灰。
      surface="chrome"
      onBack={onBack}
      backLabel="返回消息列表"
      // 头像堆叠作为标题的 leading：一眼看出「这是一群人在说话」。
      // 每枚头像都是按钮 —— 点它弹出该 Agent 的详情（P7，与消息流里的头像同一手势）
      leading={
        <div className="flex flex-shrink-0 items-center">
          {/* A115：换过头像就只显示它。成员堆叠是「谁在群里」的答案，
              而头像已经是「这是哪个群」的答案 —— 两个并排会互相解释，
              还多占 30px。要看成员可以点右侧成员栏。 */}
          {groupAvatar ? (
            <GroupAvatar avatar={groupAvatar} size={36} title={title} />
          ) : shown.length === 0 ? (
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: 'var(--tc-hover-chrome)' }}
            >
              <Users size={18} style={{ color: 'var(--td-text-color-placeholder)' }} />
            </div>
          ) : (
            shown.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onShowAgentDetail(m.id)}
                data-member-avatar={m.id}
                title={`${m.name} · 查看详情`}
                aria-label={`查看 ${m.name} 的详情`}
                className="rounded-full transition-transform hover:scale-105"
                style={{
                  // 负 margin 叠放；越靠后越在上层，形成从左到右的堆叠
                  marginLeft: i === 0 ? 0 : -10,
                  zIndex: shown.length - i,
                  // 描边用容器底色：深色主题下也接得住
                  boxShadow: '0 0 0 2px var(--tc-surface-content)',
                }}
              >
                <AgentAvatar
                  id={m.id}
                  name={m.name}
                  icon={m.icon}
                  color={m.color}
                  size={30}
                  availability={m.status.availability}
                />
              </button>
            ))
          )}
          {rest > 0 && (
            <span
              className="ml-[-10px] flex h-[30px] w-[30px] items-center justify-center rounded-full text-caption font-medium"
              style={{
                zIndex: 0,
                backgroundColor: 'var(--tc-hover-chrome)',
                color: 'var(--td-text-color-secondary)',
                boxShadow: '0 0 0 2px var(--tc-surface-content)',
              }}
            >
              +{rest}
            </span>
          )}
        </div>
      }
      // 群名后面直接带人数（QQ 的「群名（N）」），比单独一个徽标更容易一眼读到。
      // 群名本身是个按钮：点一下就地改名（见 onRename 的注释）。
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
            className="group/name -mx-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
          >
            <span className="min-w-0 truncate">{title}</span>
            <span
              className="shrink-0 text-body font-normal"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              {/* 一个模板字符串而不是 `（{n}）`：后者会拆成三个文本节点，
                  取 innerText 时变成「（ 2 ）」，对断言和读屏都更糟 */}
              {`（${members.length}）`}
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
      badge={
        /* A84：这里原来铺一层 `--tc-hover-chrome`，一颗「N 人在线」的灰胶囊。
           它只是状态读数，不是可点的东西，常驻底色让它看起来像一枚按钮。
           去掉底后是小圆点 + 文字，与单聊栏头那个「在线」读数同一形态。 */
        <span
          className="flex items-center gap-1 rounded px-1.5 py-[1px] text-caption"
          style={{ color: 'var(--td-text-color-secondary)' }}
          title={`${onlineCount} 个成员在线`}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: onlineCount > 0 ? '#00A870' : '#C6C6C6' }}
          />
          {onlineCount} 在线
        </span>
      }
      actions={
        <>
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
                 A84（用户要求）：关着的时候不再保留那层「常态浅底」。原来的
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
