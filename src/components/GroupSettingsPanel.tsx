import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check, Trash2, X, LogOut, UserPlus, UserMinus, Plus } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { AgentHoverCard } from './AgentHoverCard';
import { ConfirmDialog } from './ConfirmDialog';
import { useAgentRemarks } from '../agentRemarks';
import {
  groupNickname,
  groupRemark,
  notifyModeOf,
  setGroupAvatar,
  setGroupNickname,
  setGroupRemark,
  setNotifyMode,
  useGroupAvatar,
  type NotifyMode,
} from '../sessionFlags';
import { GroupAvatar, AvatarPickerGrid } from './UserAvatar';
import type { RegisteredAgent } from '../types';

/**
 * 群聊设置面板 —— 群聊头部「⋯」的落点（P7）。
 *
 * ## 为什么从下拉菜单改成右侧滑出面板
 *
 * 原来的「⋯」里只有一项「删除群聊」，用下拉菜单足够。但群设置其实是七八项
 * （成员 / 我的昵称 / 备注 / 置顶 / 免打扰 / 消息接收方式 / 清记录 / 退群），
 * 下拉菜单会变成一根竖条，且**每一项的说明文字都塞不下**。右侧滑出面板是
 * IM 里群设置的通行形态：宽度够放两行说明，滑入滑出
 * 又不打断当前对话 —— 消息区还在原地，关上面板接着看。
 *
 * ## 面板浮在会话之上，不挤占布局
 *
 * 用 portal 挂到 body，`fixed` 定位 + 右侧滑入。不改会话区的宽度，
 * 也就不存在「打开设置把消息顶窄、关了又弹回来」的跳动。
 *
 * ## 2026-10-20 反馈：改成**参与布局的右栏**，与成员栏同宽同起止
 *
 * 上面那条「不挤占布局」是旧的取舍，已被用户推翻：面板 `fixed` 压在会话上，
 * 输入框会被盖掉一截，而右边的成员栏一开却会把输入框挤窄 —— 同是右栏，
 * 两种行为。现在的做法：
 *   · 面板由 ChatPage 渲染成会话区的**兄弟节点**（不再是 portal），
 *     宽度取 `--tc-member-panel-width`，与成员栏完全同宽；
 *   · 因为同在会话区那一行 flex 里，顶边/底边天然与成员栏对齐，
 *     不需要再算「标题栏 + 头部」那两个令牌；
 *   · 宽度 0 → 236 做进退场，左边的会话与输入框跟着一起收放；
 *   · 打开面板时成员栏不渲染（同一块位置只放一个右栏，避免两条 236 并排）。
 *
 * ## 高度与群成员侧栏完全一致（2026-10-18 反馈，现已由布局保证）
 *
 * 早先面板 `inset-y-0` 通高，而成员栏从会话头部底边开始，差 92px 很显眼。
 * 改成 flex 兄弟之后这条自动成立，**不要再手写 top/bottom 的计算**。
 *
 * ## 没有蒙层，开合靠「再点一次按钮」（同日反馈）
 *
 * 早先面板带一层 0.18 的黑色蒙层、点蒙层关闭。既然它现在与成员栏等高、
 * 同属「侧栏」，再压一层蒙层就成了模态对话框的样子，而且用户还得把鼠标
 * 挪到空白处才能关。现在：
 *   · 不画蒙层（背后的消息原样可见，也不拦点击）；
 *   · 头部那颗「⋯」是**开关**：再点一次即收起（见 GroupChatHeader）；
 *   · 面板内的 X、Esc、点面板以外的任意位置，仍然都能关。
 *
 * ⚠️ 点「⋯」时，document 上的 outside-click 会先收到一次 mousedown。
 *    如果不管它，就会「先关 → click 又开」，表现为点了没反应。
 *    所以 outside-click 明确跳过 `[data-chat-more]`（触发按钮自己负责切换）。
 *
 * ## 两档删除，必须分开
 *
 *   - **删除聊天记录**：只删消息，群还在、成员场景绑定都在，清完能继续说话；
 *   - **退出群聊**：整条会话记录消失，列表里再也看不到这个群。
 * 两者都不可恢复，所以各自过一次确认框。两个按钮外观完全一致（中性描边 +
 * 红字），档次差别交给确认框：退出群聊的确认按钮才是红色实心。
 * 早先给退出群聊加红描边，实测反而把它抬成了「页面上最显眼的按钮」，
 * 与「不该被顺手点」的定位相悖（A24 反馈已改回中性描边）。
 *
 * ## 玻璃质感
 *
 * 面板用 `.tc-glass`（半透明 + 背景模糊）：滑过消息区时，底下的消息和图片
 * 会透出一点被模糊过的影子，而不是一块死白的实色板盖住一切。
 */

/**
 * 面板宽度 —— 与群成员栏同值（`--tc-member-panel-width` = 236px）。
 *
 * 组件内部一律走 CSS 变量，这个常量只给「需要数值断言」的脚本和将来的
 * 窄屏适配用；**不要**在 JSX 里写死它，否则改令牌时这里不会跟着变。
 */
const PANEL_WIDTH = 236;
/** 群消息设置的三档（截图里的下拉选项）。「正常提醒」由免打扰开关表达，不进下拉 */
/**
 * 群消息设置的四档。**四档必须齐全**：
 *
 * `notifyMode` 是四种状态（normal / muted / assistant / blocked），而下拉是它
 * 唯一完整的展示面。漏掉 'normal' 那一档的后果不是「少一项」，而是
 * `find(o => o.mode === notify)` 返回 undefined、掉到兜底文案 ——
 * 用户其实在正常收消息，界面却写着「不提醒」。这与「免打扰开关」也会对不上。
 */
const NOTIFY_OPTIONS: Array<{ mode: NotifyMode; label: string }> = [
  { mode: 'normal', label: '接收消息并提醒' },
  { mode: 'muted', label: '接收消息但不提醒' },
  { mode: 'assistant', label: '收进群助手且不提醒' },
  { mode: 'blocked', label: '屏蔽群消息' },
];

interface GroupSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  members: RegisteredAgent[];
  /**
   * 注册表里的**全部** Agent —— 「邀请」要据此算出谁还没进群。
   * 只传 members 的话，这个面板就只能减人、不能加人。
   */
  allAgents: RegisteredAgent[];
  /** 成员变动（本地 + PATCH 持久化，与成员栏走同一个回调） */
  onMembersChange: (agentIds: string[]) => void;
  sessionId: string | null;
  pinned: boolean;
  onTogglePin: (pinned: boolean) => void;
  /** 清空聊天记录；返回删除条数，-1 表示失败 */
  onClearMessages: (sessionId: string) => Promise<number>;
  /** 退出群聊（删除会话 + 导航） */
  onExitGroup: () => void;
}

export function GroupSettingsPanel({
  open,
  onClose,
  title,
  members,
  allAgents,
  onMembersChange,
  sessionId,
  pinned,
  onTogglePin,
  onClearMessages,
  onExitGroup,
}: GroupSettingsPanelProps) {
  /** 面板真正挂在 DOM 上的时机（带动画：进场 + 退场） */
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Agent 备注：成员格子里显示备注优先（与通讯录、消息列表同一套规则） */
  const remarks = useAgentRemarks();

  // 「我在本群的昵称 / 群聊备注」：点一下变成输入框，回车或失焦保存
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [editingRemark, setEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState('');
  const settledRef = useRef(false);

  const [notifyOpen, setNotifyOpen] = useState(false);
  const notifyRef = useRef<HTMLDivElement>(null);

  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);

  /**
   * 邀请区是否展开。
   *
   * 用「就地展开一段候选列表」而不是再叠一层浮层：面板本身已经是滑出的
   * 浮层，在里面再弹一个绝对定位的列表，滚动时会被面板的滚动容器裁掉
   * （成员区不在滚动区顶部时尤其明显）。就地展开跟着内容滚，位置永远对。
   */
  const [inviteOpen, setInviteOpen] = useState(false);

  /** 还没进群的 Agent（在线的排前面，先看到能用的） */
  const inviteCandidates = useMemo(() => {
    const inside = new Set(members.map(m => m.id));
    return allAgents
      .filter(a => !inside.has(a.id))
      .sort((a, b) => {
        const ra = a.status.availability === 'ready' ? 0 : 1;
        const rb = b.status.availability === 'ready' ? 0 : 1;
        return ra - rb;
      });
  }, [allAgents, members]);

  const addMember = (id: string) => {
    if (members.some(m => m.id === id)) return;
    onMembersChange([...members.map(m => m.id), id]);
  };

  const removeMember = (id: string) => {
    // 至少留一位：空群既发不出消息（编排器没有可派对象），也会让用户
    // 从群聊里凭空失去这个会话的入口。按钮本身也会禁用，这里再兜一层。
    if (members.length <= 1) return;
    onMembersChange(members.filter(m => m.id !== id).map(m => m.id));
  };

  const [nickname, setNicknameState] = useState(() => (sessionId ? groupNickname(sessionId) : ''));
  const [remark, setRemarkState] = useState(() => (sessionId ? groupRemark(sessionId) : ''));
  // A115：群头像。**订阅**而不是 useState 快照 —— 用户在别处（比如会话列表
  // 将来也放一个入口）改完，这个面板要立刻跟上；useState 只会在挂载时读一次。
  const groupAvatar = useGroupAvatar(sessionId);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [notify, setNotifyState] = useState<NotifyMode>(() =>
    sessionId ? notifyModeOf(sessionId) : 'normal'
  );

  // ── 开 / 关与退场动画 ──
  useEffect(() => {
    if (open) {
      setMounted(true);
      // 先挂载再置 shown：让浏览器有机会把初始 translate-x-full 算进去，
      // 否则 transition 没有起点，面板会「直接出现」而不是滑进来
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [open]);

  // Esc 关闭；打开时把焦点放到关闭按钮上，屏幕阅读器不会迷失
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 群消息设置下拉：点空白收起（details 元素不会自动收，这里同样要手动补）
  //
  // A118：用 pointerdown 而非 click —— 输入框（t-chat-sender 的 shadow）
  // 会吞掉 mousedown / click，点输入框关不掉这个下拉。见 WorkspaceBadge。
  useEffect(() => {
    if (!notifyOpen) return;
    const onDown = (e: PointerEvent) => {
      if (notifyRef.current && !notifyRef.current.contains(e.target as Node)) {
        setNotifyOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [notifyOpen]);

  /**
   * 点面板以外的地方收起。
   *
   * 三处必须放过，否则会「关错东西」：
   *   1. 面板自己（含它内部的确认框）—— 那是正常操作；
   *   2. 头部的「⋯」—— 它是**开关**，由它自己 toggle；这里若不放过，
   *      mousedown 先关、click 再开，用户会觉得「点了没反应」；
   *   3. 确认框正开着时 —— 那层遮罩是 portal 到 body 的，点它本意是取消
   *      删除/退群，不该顺手把整个设置面板也收了。
   */
  useEffect(() => {
    if (!open) return;
    // A118：pointerdown 而非 mousedown —— 输入框（t-chat-sender 的 shadow）
    // 会吞掉 mousedown / click，导致「点输入框关不掉这个面板」。
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (wrapRef.current?.contains(t)) return;
      if (t.closest?.('[data-chat-more]')) return;
      if (document.querySelector('[data-confirm-dialog]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, onClose]);

  if (!mounted) return null;

  const saveNickname = (save: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditingNickname(false);
    if (!save) return;
    const next = nicknameDraft.trim();
    if (sessionId && next !== nickname) {
      setGroupNickname(sessionId, next);
      setNicknameState(next);
    }
  };

  const saveRemark = (save: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditingRemark(false);
    if (!save) return;
    const next = remarkDraft.trim();
    if (sessionId && next !== remark) {
      setGroupRemark(sessionId, next);
      setRemarkState(next);
    }
  };

  const startEditNickname = () => {
    setNicknameDraft(nickname);
    settledRef.current = false;
    setEditingNickname(true);
  };

  const startEditRemark = () => {
    setRemarkDraft(remark);
    settledRef.current = false;
    setEditingRemark(true);
  };

  const switchNotify = (mode: NotifyMode) => {
    if (!sessionId) return;
    setNotifyMode(sessionId, mode);
    setNotifyState(mode);
    setNotifyOpen(false);
  };

  const notifyLabel = NOTIFY_OPTIONS.find(o => o.mode === notify)?.label ?? '接收消息并提醒';
  const muted = notify !== 'normal';

  return (
    <div
      ref={wrapRef}
      // 宽度 = 群成员栏（`--tc-member-panel-width`），并且**参与布局**：
      // 面板一开，消息区与输入框跟着收窄，和右侧成员栏是完全一样的响应行为。
      //
      // 早先是 portal + `fixed`，压在会话之上 —— 结果输入框被面板盖掉一截
      // （反馈：图三的输入框应该和图四一样跟着收）。改成布局内的右栏之后，
      // 「盖住」这件事从根上不存在了。
      //
      // 窄屏（< lg）成员栏本身是隐藏的，此时退回覆盖式：`absolute` 贴右缘，
      // 不把本来就不宽的消息区再挤掉 236px。
      className="absolute inset-y-0 right-0 z-50 shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:relative lg:inset-y-auto lg:right-auto lg:z-auto"
      style={{
        // 用宽度做进场/退场：宽度会推着左边的会话一起收放，
        // 比 translate 更贴「这一栏打开了」的语义（translate 会先留一块空白）。
        width: shown ? 'var(--tc-member-panel-width)' : 0,
        pointerEvents: shown ? 'auto' : 'none',
      }}
      data-group-settings
      data-open={shown ? 'true' : 'false'}
    >
      <aside
        role="dialog"
        // 没有蒙层、也不拦背景点击 —— 所以不是 aria-modal（那会让读屏
        // 把面板以外的一切都当成不可用，与实际的交互模型不符）
        aria-label="群聊设置"
        className="tc-glass absolute inset-y-0 right-0 flex w-[var(--tc-member-panel-width)] flex-col overflow-hidden shadow-popup"
        style={{
          borderLeft: '1px solid var(--tc-split)',
          // A48（反馈）：这一栏要**直角**。
          //
          // 早先是 A30 的「只圆左侧两角」—— 那时面板还是浮在会话之上的
          // portal 浮层，圆角是为了让它看起来像一张浮起来的卡片。现在它是
          // 布局内的右栏（与会话头部、成员栏同起同止），右侧贴着窗口、左侧
          // 与消息区共用一条分栏线，圆角反而像「这块板被啃掉两个角」。
          // 原话是「把红框这块设计成直角」。
          //
          // ⚠️ 不要再加回 borderTopLeftRadius —— 圆角需要 `overflow-hidden`
          // 配合，而那个 overflow 会顺带裁掉输入区的焦点环。
          borderRadius: 0,
        }}
      >
        {/* 栏头：群名 + 关闭。高度与聊天头部同值 —— 面板顶边已经对齐了
            成员栏，栏头再对齐，两条右栏的第一条横线才会落在同一行 */}
        <div
          className="flex shrink-0 items-center gap-2 px-4"
          style={{ height: 'var(--tc-header-height)', borderBottom: '1px solid var(--tc-divider)' }}
        >
          <span
            className="min-w-0 flex-1 truncate text-body font-semibold"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {title}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭群聊设置"
            className="tc-icon-btn h-7 w-7 shrink-0"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <X size={15} />
          </button>
        </div>

        {/* 内容区做成 flex 列：底部操作行要靠 `mt-auto` 顶到面板底边
            （内容不足一屏时也不会浮在中间）。见下面 sticky 那段的注释。
            `[&>*]:shrink-0` 是必须的 —— flex 列默认会压缩子项来「塞进」
            容器，那样内容就永远不溢出、也就没有滚动条了。 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&>*]:shrink-0">
          {/* ── 群头像（A115，需求「为群聊增加更换头像的功能」）──
              放在最前面：它是这个群的「脸」，比任何一项设置都更该被看见。
              点一下展开 12 个预设的平铺格子，再点一下收起 —— 不做弹窗，
              236px 的面板里弹一层模态反而是倒退。
              「恢复默认」单独一行：没有它，用户选错了只能记住原来那颗
              「多人群」图标长什么样，却没办法真的回去。 */}
          <Section label="群头像" />
          <div className="px-4 pb-3" data-group-avatar-section>
            <div className="flex items-center gap-3">
              <GroupAvatar avatar={groupAvatar} size={44} title={title} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => setAvatarPickerOpen(v => !v)}
                  aria-expanded={avatarPickerOpen}
                  data-group-avatar-toggle
                  className="rounded-lg px-3 py-1.5 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  style={{
                    backgroundColor: 'var(--tc-surface-raised)',
                    color: 'var(--td-text-color-primary)',
                  }}
                >
                  {avatarPickerOpen ? '收起' : '更换头像'}
                </button>
                {groupAvatar && (
                  <button
                    type="button"
                    onClick={() => sessionId && setGroupAvatar(sessionId, '')}
                    data-group-avatar-reset
                    className="rounded-lg px-3 py-1.5 text-left text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    恢复默认
                  </button>
                )}
              </div>
            </div>
            {avatarPickerOpen && (
              <div className="mt-3">
                <AvatarPickerGrid
                  value={groupAvatar}
                  onChange={id => sessionId && setGroupAvatar(sessionId, id)}
                />
              </div>
            )}
          </div>

          {/* ── 群聊成员 ──
              头像悬停出名片（A24 反馈：这里也要有）。与成员栏、通讯录
              共用同一个 AgentHoverCard —— 三处都指向同一份注册表，
              没有理由让用户在某一处「悬停没反应」。

              A30（反馈）：成员后面要有「邀请」和「移出」。
                · 邀请 = 格子末尾那颗虚线「+」格（成员区的通行形态），
                  点开在下方就地展开候选名单；
                · 移出 = 每格头像右上角的 ×。**常驻可见但低对比**（40%），
                  悬停该格才变实 —— 与右侧成员栏的「悬停才出现」不同：
                  这一页是用户专门来「管理成员」的地方，藏起来会让人以为
                  没有这个功能（反馈原话就是「增加移出按钮」）。
                  最后一位成员的 × 禁用（空群发不出消息）。 */}
          <Section label="群聊成员" count={members.length} />
          <div className="grid grid-cols-5 gap-y-3 px-4 pb-3" data-group-members>
            {members.map(m => {
              const lastOne = members.length <= 1;
              return (
                <div
                  key={m.id}
                  className="group/member flex flex-col items-center gap-1"
                  title={m.name}
                  data-settings-member={m.id}
                >
                  <div className="relative">
                    <AgentHoverCard agent={m}>
                      <AgentAvatar
                        id={m.id}
                        name={remarks[m.id] || m.name}
                        icon={m.icon}
                        color={m.color}
                        size={34}
                        availability={m.status.availability}
                      />
                    </AgentHoverCard>
                    <button
                      type="button"
                      disabled={lastOne}
                      onClick={() => removeMember(m.id)}
                      title={lastOne ? '至少保留一位成员' : `将 ${remarks[m.id] || m.name} 移出群聊`}
                      aria-label={lastOne ? '至少保留一位成员' : `将 ${remarks[m.id] || m.name} 移出群聊`}
                      data-settings-remove-member={m.id}
                      className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full opacity-40 shadow-card transition-opacity focus-visible:opacity-100 group-hover/member:opacity-100 hover:!opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                      style={{
                        backgroundColor: 'var(--td-bg-color-container)',
                        // A115 续：控件轮廓走 --tc-edge-strong（7% 墨）——
                        // A83 给「需要明确可点的控件」定的一档，比原来的
                        // --td-component-stroke（10%）淡，但 18px 的小圆钮
                        // 在成员头像上仍然读得出「这是一个可点的东西」。
                        border: '1px solid var(--tc-edge-strong)',
                        color: 'var(--td-text-color-secondary)',
                      }}
                    >
                      <UserMinus size={10} />
                    </button>
                  </div>
                  <span
                    className="w-full truncate px-0.5 text-center text-caption"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    {remarks[m.id] || m.name}
                  </span>
                </div>
              );
            })}

            {/* 邀请格：与成员格同宽同高，只是圆形换成虚线边 */}
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => setInviteOpen(v => !v)}
                aria-expanded={inviteOpen}
                aria-label="邀请成员"
                title="邀请成员"
                data-settings-invite-toggle
                className="flex items-center justify-center rounded-full transition-colors"
                /* A75：底色不写内联（理由同 GroupMemberPanel 的邀请按钮），
                   三态交给 index.css 的 [data-settings-invite-toggle] 规则。 */
                style={{
                  width: 34,
                  height: 34,
                  border: '1px dashed var(--td-component-stroke)',
                  color: inviteOpen ? 'var(--td-brand-color)' : 'var(--td-text-color-placeholder)',
                }}
              >
                <UserPlus size={15} />
              </button>
              <span
                className="w-full truncate px-0.5 text-center text-caption"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                邀请
              </span>
            </div>
          </div>

          {/* 候选名单：就地展开，跟着内容滚（见 inviteOpen 的注释） */}
          {inviteOpen && (
            <div className="px-4 pb-4" data-settings-invite-list>
              {inviteCandidates.length === 0 ? (
                <div
                  className="rounded-lg px-3 py-2.5 text-caption"
                  style={{
                    backgroundColor: 'var(--tc-surface-raised)',
                    color: 'var(--td-text-color-placeholder)',
                  }}
                >
                  所有 Agent 都已在群内
                </div>
              ) : (
                <div
                  className="max-h-[190px] overflow-y-auto rounded-lg py-1"
                  style={{
                    backgroundColor: 'var(--tc-surface-raised)',
                    // A115 续：被动容器的描边走 --tc-edge（4.5% 墨）——
                    // 「边界保险」档。这个浮层有自己的底色，不再需要
                    // 10% 的墨线来声明边界。
                    border: '1px solid var(--tc-edge)',
                  }}
                >
                  {inviteCandidates.map(a => (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 px-2.5 py-1.5"
                      data-settings-invite-item={a.id}
                    >
                      <AgentAvatar
                        id={a.id}
                        name={a.name}
                        icon={a.icon}
                        color={a.color}
                        size={22}
                        availability={a.status.availability}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-secondary"
                        style={{ color: 'var(--td-text-color-primary)' }}
                      >
                        {a.name}
                      </span>
                      {/* 未就绪的标出来：邀请一个连不上的成员，下次编排会因为它不可用而整轮失败 */}
                      {a.status.availability !== 'ready' && (
                        <span
                          className="shrink-0 text-caption"
                          style={{ color: 'var(--td-text-color-placeholder)' }}
                        >
                          {a.status.message?.slice(0, 6) || '未就绪'}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => addMember(a.id)}
                        aria-label={`邀请 ${a.name}`}
                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption transition-colors"
                        style={{
                          color: 'var(--td-brand-color)',
                          backgroundColor: 'var(--td-brand-color-light)',
                        }}
                      >
                        <Plus size={11} />
                        邀请
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <Divider />

          {/* ── 我在本群的昵称 ── */}
          <Section label="我在本群的昵称" />
          <div className="px-4 pb-4">
            {editingNickname ? (
              <input
                autoFocus
                value={nicknameDraft}
                onChange={e => setNicknameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveNickname(true);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    saveNickname(false);
                  }
                }}
                onBlur={() => saveNickname(true)}
                aria-label="我在本群的昵称"
                placeholder="填写昵称"
                className="w-full rounded-lg px-3 py-2 text-body outline-none"
                style={{
                  backgroundColor: 'var(--tc-surface-raised)',
                  border: '1px solid var(--td-brand-color)',
                  color: 'var(--td-text-color-primary)',
                }}
              />
            ) : (
              <button
                type="button"
                onClick={startEditNickname}
                data-group-nickname
                className="w-full rounded-lg px-3 py-2 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
                style={{
                  backgroundColor: 'var(--tc-surface-raised)',
                  color: nickname ? 'var(--td-text-color-primary)' : 'var(--td-text-color-placeholder)',
                }}
              >
                {nickname || '填写昵称'}
              </button>
            )}
          </div>

          {/* ── 群聊备注 ── */}
          <Section label="群聊备注" />
          <div className="px-4 pb-4">
            {editingRemark ? (
              <input
                autoFocus
                value={remarkDraft}
                onChange={e => setRemarkDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveRemark(true);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    saveRemark(false);
                  }
                }}
                onBlur={() => saveRemark(true)}
                aria-label="群聊备注"
                placeholder="填写备注"
                className="w-full rounded-lg px-3 py-2 text-body outline-none"
                style={{
                  backgroundColor: 'var(--tc-surface-raised)',
                  border: '1px solid var(--td-brand-color)',
                  color: 'var(--td-text-color-primary)',
                }}
              />
            ) : (
              <button
                type="button"
                onClick={startEditRemark}
                data-group-remark
                className="w-full rounded-lg px-3 py-2 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
                style={{
                  backgroundColor: 'var(--tc-surface-raised)',
                  color: remark ? 'var(--td-text-color-primary)' : 'var(--td-text-color-placeholder)',
                }}
              >
                {remark || '填写备注'}
              </button>
            )}
          </div>

          <Divider />

          {/* ── 置顶 / 免打扰 两个开关 ── */}
          <ToggleRow
            label="设为置顶"
            checked={pinned}
            onToggle={() => sessionId && onTogglePin(!pinned)}
          />
          <ToggleRow
            label="消息免打扰"
            checked={muted}
            onToggle={() =>
              sessionId && switchNotify(muted ? 'normal' : 'muted')
            }
          />

          {/* ── 群消息设置（三档下拉）──
              与上面的免打扰开关共用 notifyMode：开关是两档快捷方式，
              下拉是完整设置。收进群助手/屏蔽只有下拉能给 —— 一个布尔
              开关表达不了四种状态，硬表达就会出现「开关说不提醒、实际已屏蔽」。 */}
          <div className="px-4 py-3">
            <div className="mb-2 text-body" style={{ color: 'var(--td-text-color-primary)' }}>
              群消息设置
            </div>
            <div ref={notifyRef} className="relative">
              <button
                type="button"
                onClick={() => setNotifyOpen(v => !v)}
                data-notify-trigger
                aria-haspopup="listbox"
                aria-expanded={notifyOpen}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-body transition-colors"
                style={{
                  backgroundColor: 'var(--tc-surface-raised)',
                  color: 'var(--td-text-color-primary)',
                }}
              >
                <span>{notifyLabel}</span>
                <ChevronDown size={14} style={{ color: 'var(--td-text-color-placeholder)' }} />
              </button>
              {notifyOpen && (
                <div
                  role="listbox"
                  className="tc-glass absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg py-1 shadow-popup"
                  /* A115 续：内联描边会压掉 .tc-glass 的 border-color（内联
                     优先级高于 class），所以这里必须显式走 --tc-glass-border，
                     不能删掉了事 —— 删了连 1px 的边框宽度都没有了。 */
                  style={{ border: '1px solid var(--tc-glass-border)' }}
                >
                  {NOTIFY_OPTIONS.map(opt => {
                    const active = opt.mode === notify;
                    return (
                      <button
                        key={opt.mode}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => switchNotify(opt.mode)}
                        className="mx-1 flex w-[calc(100%_-_8px)] items-center justify-between rounded-lg px-2 py-2 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
                        /* A75：选中行补底色。原来这里只有「文字 + 右侧 ✓」，
                           悬停行有底、选中行没底 —— 鼠标一移开，当前是哪个
                           通知模式就只剩一个 14px 的对勾在说。
                           只在选中时写内联，未选中项保持 undefined，
                           否则会压死上面的 hover:bg-[...]（同一坑，见
                           NavRail 与 GroupChatHeader 的注释）。 */
                        style={
                          active
                            ? {
                                color: 'var(--td-text-color-primary)',
                                backgroundColor: 'var(--tc-fill-selected)',
                              }
                            : { color: 'var(--td-text-color-primary)' }
                        }
                      >
                        {opt.label}
                        {active && <Check size={14} style={{ color: 'var(--td-brand-color)' }} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <Divider />

          {/* ── 两个不可恢复的操作：**上下排列**，跟在「群消息设置」后面 ──
              2026-10-20 反馈：不要并排，要竖排；并且要落到「群消息设置」
              下面，得往下滚才看得到 —— 不再钉在面板底边。

              这与 A35 的「sticky 贴底防漂移」是两次相反的取舍，取最新一次：
              · A35 要的是「同一组按钮别在两种内容高度下出现在两个位置」，
                用 sticky 解决，代价是它**永远**占着视线最后一行；
              · 这次用户要的是「别让它一直杵在那儿」—— 危险操作应该藏在
                用户主动往下翻的地方。竖排 + 跟随内容滚动同时满足两条：
                位置只由内容决定（不会漂），又不会被顺手点到。

              ⚠️ 两者都用**中性描边**（A24 反馈：不要红色描边）。
              危险语义靠文字色（`--td-error-color`）和图标表达，不再靠边框 ——
              一条红框在一屏里比文字显眼得多，等于把「这是危险操作」升级成
              「这是主按钮」，与它们不该被顺手点的定位相反。
              真正的红色实心只出现在**确认框**里，那一步才是不可逆的落点。 */}
          <div className="flex flex-col gap-2 px-4 pb-5 pt-3" data-settings-footer>
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              data-clear-messages
              className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-body transition-colors"
              style={{
                color: 'var(--td-error-color)',
                // A115 续：控件轮廓 --tc-edge-strong（7%）。这两个是
                // 「删除 / 退出」这种危险操作，轮廓要比普通按钮明确一档，
                // 但仍然不是 10% 的墨线。
                border: '1px solid var(--tc-edge-strong)',
              }}
            >
              <Trash2 size={15} />
              删除聊天记录
            </button>
            <button
              type="button"
              onClick={() => setConfirmExit(true)}
              data-exit-group
              className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-body transition-colors"
              style={{
                color: 'var(--td-error-color)',
                border: '1px solid var(--tc-edge-strong)',
              }}
            >
              <LogOut size={15} />
              退出群聊
            </button>
          </div>
        </div>
      </aside>

      {/* 两个确认框都不可恢复，各过一次。删除记录是「普通危险」，
          退出群聊是全红实心 —— 档位要比删除记录更高 */}
      <ConfirmDialog
        open={confirmClear}
        title="删除聊天记录"
        confirmText="删除"
        danger
        onConfirm={() => {
          setConfirmClear(false);
          if (sessionId) void onClearMessages(sessionId);
        }}
        onCancel={() => setConfirmClear(false)}
      >
        将清空这个群的全部消息，记录不可恢复。群本身、成员和场景绑定都会保留，
        清空后还能继续发消息。
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmExit}
        title="退出群聊"
        confirmText="退出"
        danger
        onConfirm={() => {
          setConfirmExit(false);
          onExitGroup();
        }}
        onCancel={() => setConfirmExit(false)}
      >
        退出后这个群会从消息列表消失，聊天记录不可恢复。群成员会回到通讯录，
        不会失去 Agent 本身。
      </ConfirmDialog>
    </div>
  );
}

// ── 内部小件 ──────────────────────────────────────────────────────────

function Section({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-1.5 px-4 pb-2 pt-4">
      <span className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
        {label}
      </span>
      {typeof count === 'number' && (
        <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {count}
        </span>
      )}
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px" style={{ backgroundColor: 'var(--tc-divider)' }} />;
}

/** 一行「标签 + 开关」。开启态用主题品牌色实心 */
function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-body" style={{ color: 'var(--td-text-color-primary)' }}>
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className="relative h-[22px] w-[40px] shrink-0 rounded-full transition-colors duration-150"
        style={{
          backgroundColor: checked ? 'var(--td-brand-color)' : 'var(--tc-hover-chrome)',
          // A115 续：未选中态的轮廓走 --tc-edge-strong（7% 墨）—— 开关是
          // 控件，轮廓要比内容卡片明确一档；原来的 10% 在 22px 的小开关
          // 上太抢。
          border: checked ? 'none' : '1px solid var(--tc-edge-strong)',
        }}
      >
        <span
          className="absolute top-1/2 block rounded-full bg-white shadow-sm transition-all duration-150"
          style={{
            width: 18,
            height: 18,
            left: checked ? 20 : 1,
            transform: 'translateY(-50%)',
            backgroundColor: checked ? '#fff' : 'var(--td-bg-color-container)',
          }}
        />
      </button>
    </div>
  );
}

/** 面板宽度。导出它，好让测试脚本与将来的窄屏适配共用同一个数 */
export const GROUP_SETTINGS_WIDTH = PANEL_WIDTH;

