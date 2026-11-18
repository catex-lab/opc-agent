import { useEffect, useMemo, useRef, useState } from 'react';
import { MessagePlugin } from 'tdesign-react';
import { ChevronDown, Check, Trash2, X, LogOut, UserPlus, UserMinus, Plus, CalendarClock } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { AgentHoverCard } from './AgentHoverCard';
import { ConfirmDialog } from './ConfirmDialog';
import { AvatarCropDialog } from './AvatarCropDialog';
import { ScheduleDialog } from './ScheduleDialog';
import { removeGroupAvatar, uploadGroupAvatar } from '../avatarApi';
import { useAgentRemarks } from '../agentRemarks';
import { useOverflowY } from '../hooks/useOverflowY';
import {
  groupNickname,
  groupRemark,
  notifyModeOf,
  setGroupAvatar,
  setGroupAvatarImage,
  setGroupNickname,
  setGroupRemark,
  setNotifyMode,
  useGroupAvatar,
  useGroupAvatarImage,
  type NotifyMode,
} from '../sessionFlags';
import { GroupAvatar, AvatarPickerGrid, groupAvatarMembersOf } from './UserAvatar';
import { useTranslation, type MessageKey } from '../i18n';
import { agentStatusViewOf, availabilityLabelOf, type RegisteredAgent } from '../types';

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
 *     宽度取 PANEL_WIDTH（G-1：260px；成员栏仍是 236 —— 两者不同时渲染）；
 *   · 因为同在会话区那一行 flex 里，顶边/底边天然与成员栏对齐，
 *     不需要再算「标题栏 + 头部」那两个令牌；
 *   · 宽度 0 → 260 做进退场，左边的会话与输入框跟着一起收放；
 *   · 打开面板时成员栏不渲染（同一块位置只放一个右栏，避免两条右栏并排）。
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
 * 面板宽度（G-1，ui-review 17 号图）：236 → 260。
 *
 * 原来与群成员栏共用 `--tc-member-panel-width`（236px），但 8 组内容在
 * 236px 里塞不下、底部「定时任务」被裁一半。加宽到 260 同时把内容区
 * 改成滚动 + 底部钉住定时任务。成员栏（GroupMemberPanel）保持 236 不动
 * —— 两者不同时渲染（打开设置面板时成员栏不出现），不是一个令牌的
 * 两个消费者。
 *
 * 这个常量是宽度的唯一真源（wrapper 与 aside 都引用它）；导出
 * `GROUP_SETTINGS_WIDTH` 给需要数值断言的脚本。
 */
const PANEL_WIDTH = 260;
/**
 * 群消息设置的四档。**四档必须齐全**：
 *
 * `notifyMode` 是四种状态（normal / muted / assistant / blocked），而下拉是它
 * 唯一完整的展示面。漏掉 'normal' 那一档的后果不是「少一项」，而是
 * `find(o => o.mode === notify)` 返回 undefined、掉到兜底文案 ——
 * 用户其实在正常收消息，界面却写着「不提醒」。
 *
 * G-2（ui-review）：「消息免打扰」开关已删 —— 它与这个下拉共用
 * `notifyMode`，是同一状态的两个控件；四档齐的下拉是唯一入口。
 */
const NOTIFY_OPTIONS: Array<{ mode: NotifyMode; labelKey: MessageKey }> = [
  { mode: 'normal', labelKey: 'groupSettings.notifyNormal' },
  { mode: 'muted', labelKey: 'groupSettings.notifyMuted' },
  { mode: 'assistant', labelKey: 'groupSettings.notifyAssistant' },
  { mode: 'blocked', labelKey: 'groupSettings.notifyBlocked' },
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
  // G-1：内容区改成滚动后，溢出要给「还有更多」的信号（A134 硬规矩：
  // Windows 的 overlay 滚动条静止时不画，被硬切的一行字读起来像渲染坏了）
  const { ref: scrollRef, overflowing: contentOverflowing } = useOverflowY<HTMLDivElement>();

  // 「我在本群的昵称 / 群聊备注」：点一下变成输入框，回车或失焦保存
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [editingRemark, setEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState('');
  const settledRef = useRef(false);

  const [notifyOpen, setNotifyOpen] = useState(false);
  const notifyRef = useRef<HTMLDivElement>(null);

  const [confirmClear, setConfirmClear] = useState(false);
  // A224：群定时任务对话框
  const [scheduleOpen, setScheduleOpen] = useState(false);
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
  // 2026-11-12：自定义图片头像（覆盖层，优先于预设与拼贴）。同一套订阅口径。
  const groupAvatarImage = useGroupAvatarImage(sessionId);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [notify, setNotifyState] = useState<NotifyMode>(() =>
    sessionId ? notifyModeOf(sessionId) : 'normal'
  );
  const { t } = useTranslation();
  // 上传走 A160 同款「选文件 → 裁剪 → dataUrl」流程
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  /** 服务的图片引用登记也要跟着清： presets/图片/默认三态切换都从这里走 */
  const releaseImage = (sid: string) => {
    void removeGroupAvatar(sid).catch(err =>
      MessagePlugin.error(
        t('groupAvatar.removeFailed', { error: err instanceof Error ? err.message : String(err) })
      )
    );
    setGroupAvatarImage(sid, '');
  };

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
   * 必须放过的：
   *   1. 面板自己（含它内部的确认框）—— 那是正常操作；
   *   2. 头部的「⋯」—— 它是**开关**，由它自己 toggle；这里若不放过，
   *      mousedown 先关、click 再开，用户会觉得「点了没反应」；
   *   3. 从本面板打开、**portal 到 body 的弹层**（确认框 / 头像裁切 /
   *      定时任务）—— 它们的点击在 DOM 树上不在面板里，但语义上是
   *      「面板内操作」。2026-11-14 实测踩过：裁切弹层居中到窗口中央后，
   *      点「使用这张图」把整个设置面板关掉了。
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
      if (t.closest?.('[data-confirm-dialog]')) return;
      if (t.closest?.('[data-avatar-crop]')) return;
      if (t.closest?.('[data-schedule-dialog]')) return;
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

  const notifyLabel = t(
    NOTIFY_OPTIONS.find(o => o.mode === notify)?.labelKey ?? 'groupSettings.notifyNormal'
  );

  return (
    <div
      ref={wrapRef}
      // 宽度 = PANEL_WIDTH（G-1：260px），并且**参与布局**：
      // 面板一开，消息区与输入框跟着收窄，和右侧成员栏是完全一样的响应行为。
      //
      // 早先是 portal + `fixed`，压在会话之上 —— 结果输入框被面板盖掉一截
      // （反馈：图三的输入框应该和图四一样跟着收）。改成布局内的右栏之后，
      // 「盖住」这件事从根上不存在了。
      //
      // 窄屏（< lg）成员栏本身是隐藏的，此时退回覆盖式：`absolute` 贴右缘，
      // 不把本来就不宽的消息区再挤掉 260px。
      className="absolute inset-y-0 right-0 z-50 shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:relative lg:inset-y-auto lg:right-auto lg:z-auto"
      style={{
        // 用宽度做进场/退场：宽度会推着左边的会话一起收放，
        // 比 translate 更贴「这一栏打开了」的语义（translate 会先留一块空白）。
        width: shown ? PANEL_WIDTH : 0,
        pointerEvents: shown ? 'auto' : 'none',
      }}
      data-group-settings
      data-open={shown ? 'true' : 'false'}
    >
      <aside
        role="dialog"
        // 没有蒙层、也不拦背景点击 —— 所以不是 aria-modal（那会让读屏
        // 把面板以外的一切都当成不可用，与实际的交互模型不符）
        aria-label={t('groupSettings.panelAria')}
        className="tc-glass absolute inset-y-0 right-0 flex flex-col overflow-hidden shadow-popup"
        style={{
          width: PANEL_WIDTH,
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
            title={t('groupSettings.close')}
            aria-label={t('groupSettings.closeAria')}
            className="tc-icon-btn h-7 w-7 shrink-0"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <X size={15} />
          </button>
        </div>

        {/* 内容区做成 flex 列：底部「定时任务」已钉到面板底边的固定栏（G-1），
            这块滚动区自己管剩下的所有内容。`[&>*]:shrink-0` 是必须的 ——
            flex 列默认会压缩子项来「塞进」容器，那样内容就永远不溢出、
            也就没有滚动条了。溢出时挂 `.tc-scroll-fade`（A134 硬规矩）。 */}
        <div
          ref={scrollRef}
          className="tc-scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto [&>*]:shrink-0"
          data-fade={contentOverflowing ? '1' : undefined}
        >
          {/* ── 群头像（A115；2026-11-12 加自定义图片与成员拼贴；2026-11-14 重排）──
              放在最前面：它是这个群的「脸」，比任何一项设置都更该被看见。
              重排（用户反馈：解释文字冗余、上传后裁切弹层在窄栏里显示不全）：
              · 解释文字全删——「当前是什么」头像本身就在眼前，「怎么换」hover
                遮罩已经说了；格式与 2MB 约束收进头像的悬停 title，越权输入由
                服务端校验 + 错误提示兜底（原有链路）。
              · 居中 88px 大头像 + 双按钮横排；纠正动作收敛为一行小链接
                （有自定义图 → 移除图片；只有预设 → 恢复默认拼贴）。
              · 裁切弹层 portal 到 body（见 AvatarCropDialog 顶部说明）——
                fixed 在玻璃拟态祖先里会被困住，这是显示不全的根因。 */}
          <Section label={t('groupSettings.avatar')} />
          <div className="px-4 pb-3" data-group-avatar-section>
            <AvatarCropDialog
              file={cropFile}
              title={t('groupAvatar.hoverChange')}
              onCancel={() => setCropFile(null)}
              onConfirm={dataUrl => {
                setCropFile(null);
                if (!sessionId) return;
                setUploadingImage(true);
                void uploadGroupAvatar(sessionId, dataUrl)
                  .then(url => setGroupAvatarImage(sessionId, url))
                  .catch(err =>
                    MessagePlugin.error(
                      t('groupAvatar.uploadFailed', {
                        error: err instanceof Error ? err.message : String(err),
                      })
                    )
                  )
                  .finally(() => setUploadingImage(false));
              }}
            />
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              data-group-avatar-file
              onChange={e => {
                const f = e.target.files?.[0] ?? null;
                // 清空 value：同一张图再选一次也要能触发 onChange
                e.target.value = '';
                if (f) setCropFile(f);
              }}
            />
            <div className="flex flex-col">
              {/* 头像：居中 88px。hover 整圆遮罩就是「怎么换」的全部说明 */}
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  data-group-avatar-preview
                  title={t('groupAvatar.uploadHint')}
                  aria-label={t('groupAvatar.hoverChange')}
                  className="group/av relative shrink-0 rounded-full"
                  style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                >
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
                    size={88}
                    title={title}
                  />
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 flex items-center justify-center rounded-full text-secondary opacity-0 transition-opacity group-hover/av:opacity-100"
                    style={{ backgroundColor: 'var(--tc-mask-soft)', color: '#fff' }}
                  >
                    {t('groupAvatar.hoverChange')}
                  </span>
                </button>
              </div>
              {/* G-4（ui-review）：两个动作上下堆叠全宽 —— 236→260 加宽了，
                  但横排在窄栏里仍然拥挤，竖排后每个按钮都有完整的可点宽度 */}
              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={uploadingImage}
                  data-group-avatar-upload
                  className="tc-btn-brand w-full"
                >
                  {uploadingImage ? t('groupAvatar.uploading') : t('groupAvatar.upload')}
                </button>
                <button
                  type="button"
                  onClick={() => setAvatarPickerOpen(v => !v)}
                  aria-expanded={avatarPickerOpen}
                  data-group-avatar-toggle
                  className="tc-btn-secondary w-full"
                >
                  {t('groupAvatar.usePreset')}
                </button>
              </div>
              {/* 纠正动作：一行居中小链接。
                  · 有自定义图 → 「移除自定义」（覆盖层语义：图盖在预设上，先揭图）；
                  · 有预设 → 「恢复默认（成员拼贴）」一键清空图片与预设（B7 契约）。
                  两者都设时并存；都没有时不渲染——没有「撤销没做过的选择」的按钮。 */}
              {(groupAvatarImage || groupAvatar) && (
                <div className="mt-2 flex items-center justify-center gap-3">
                  {groupAvatarImage && (
                    <button
                      type="button"
                      onClick={() => sessionId && releaseImage(sessionId)}
                      data-group-avatar-remove-image
                      className="text-caption underline-offset-2 transition-opacity hover:opacity-80 hover:underline"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      {t('groupAvatar.remove')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (!sessionId) return;
                      if (groupAvatarImage) releaseImage(sessionId);
                      setGroupAvatar(sessionId, '');
                    }}
                    data-group-avatar-reset
                    className="text-caption underline-offset-2 transition-opacity hover:opacity-80 hover:underline"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    {t('groupAvatar.reset')}
                  </button>
                </div>
              )}
            </div>
            {avatarPickerOpen && (
              <div className="mt-3">
                <AvatarPickerGrid
                  value={groupAvatar}
                  onChange={id => {
                    if (!sessionId) return;
                    setGroupAvatar(sessionId, id);
                    // A160 同款覆盖层语义：改选预设 = 放弃自定义图片。
                    // 只清标记的话，服务端的引用登记会留着一张永远无人显示的图。
                    if (groupAvatarImage) releaseImage(sessionId);
                  }}
                />
              </div>
            )}
          </div>

          {/* ── 群聊成员 ──
              头像悬停出名片（A24 反馈：这里也要有）。与成员栏、通讯录
              共用同一个 AgentHoverCard —— 三处都指向同一份注册表，
              没有理由让用户在某一处「悬停没反应」。

              A30（反馈）：成员后面要有「邀请」和「移出」。
                · 邀请 = 成员列表末尾的虚线「+ 邀请成员」行（G-3 竖排后
                  与成员行同形），点开在下方就地展开候选名单；
                · 移出 = 每行头像右上角的 ×。**常驻可见但低对比**（40%），
                  悬停该行才变实 —— 与右侧成员栏的「悬停才出现」不同：
                  这一页是用户专门来「管理成员」的地方，藏起来会让人以为
                  没有这个功能（反馈原话就是「增加移出按钮」）。
                  最后一位成员的 × 禁用（空群发不出消息）。 */}
          <Section label={t('groupSettings.members')} count={members.length} />
          {/* G-3（ui-review）：成员改竖排列表 —— 横排格子里名字截成「Clau…」，
              看不出是谁。每行「头像 + 全名 + 状态」，头像悬停仍有名片，
              移出 × 仍挂在头像角上（常驻低对比、悬停变实）。 */}
          <div className="flex flex-col px-4 pb-3" data-group-members>
            {members.map(m => {
              const lastOne = members.length <= 1;
              const mMeta = agentStatusViewOf(m);
              return (
                <div
                  key={m.id}
                  className="group/member flex items-center gap-2.5 rounded-lg px-1 py-1.5"
                  title={m.name}
                  data-settings-member={m.id}
                >
                  <div className="relative shrink-0">
                    <AgentHoverCard agent={m}>
                      <AgentAvatar
                        id={m.id}
                        name={remarks[m.id] || m.name}
                        icon={m.icon}
                        src={m.logoUrl}
                        color={m.color}
                        size={34}
                        availability={m.status.availability}
                      />
                    </AgentHoverCard>
                    <button
                      type="button"
                      disabled={lastOne}
                      onClick={() => removeMember(m.id)}
                      title={
                        lastOne
                          ? t('groupSettings.lastMember')
                          : t('groupSettings.removeMember', { name: remarks[m.id] || m.name })
                      }
                      aria-label={
                        lastOne
                          ? t('groupSettings.lastMember')
                          : t('groupSettings.removeMember', { name: remarks[m.id] || m.name })
                      }
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
                  <div className="min-w-0 flex-1">
                    {/* 全名：竖排之后不再截断 */}
                    <span
                      className="block truncate text-body"
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      {remarks[m.id] || m.name}
                    </span>
                    {/* 状态词与通讯录/资料页同一口径（labelKey 优先） */}
                    <span
                      className="block truncate text-caption"
                      style={{ color: mMeta.color }}
                    >
                      {mMeta.labelKey ? t(mMeta.labelKey as never) : availabilityLabelOf(m)}
                    </span>
                  </div>
                </div>
              );
            })}

            {/* 邀请行：与成员行同高同形，圆标换成虚线边（G-3 竖排后的落点） */}
            <button
              type="button"
              onClick={() => setInviteOpen(v => !v)}
              aria-expanded={inviteOpen}
              aria-label={t('groupSettings.inviteAria')}
              title={t('groupSettings.inviteAria')}
              data-settings-invite-toggle
              className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 text-left transition-colors"
            >
              <span
                className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full transition-colors"
                /* A75：底色不写内联（理由同 GroupMemberPanel 的邀请按钮），
                   三态交给 index.css 的 [data-settings-invite-toggle] 规则。 */
                style={{
                  border: '1px dashed var(--td-component-stroke)',
                  color: inviteOpen ? 'var(--td-brand-color)' : 'var(--td-text-color-placeholder)',
                }}
              >
                <UserPlus size={15} />
              </span>
              <span
                className="text-body"
                style={{
                  color: inviteOpen ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                }}
              >
                {t('groupSettings.inviteAria')}
              </span>
            </button>
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
                  {t('groupSettings.allInGroup')}
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
                        src={a.logoUrl}
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
                          {a.status.message?.slice(0, 6) || t('groupSettings.notReady')}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => addMember(a.id)}
                        aria-label={t('groupSettings.inviteOne', { name: a.name })}
                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption transition-colors"
                        style={{
                          color: 'var(--td-brand-color)',
                          backgroundColor: 'var(--td-brand-color-light)',
                        }}
                      >
                        <Plus size={11} />
                        {t('groupSettings.invite')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <Divider />

          {/* ── 我在本群的昵称（G-5：下方加说明小字，与「群聊备注」区分开）── */}
          <Section label={t('groupSettings.nickname')} />
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
                aria-label={t('groupSettings.nickname')}
                placeholder={t('groupSettings.nicknamePlaceholder')}
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
                {nickname || t('groupSettings.nicknamePlaceholder')}
              </button>
            )}
            {/* G-5：一行小字说明可见范围 —— 昵称与备注原来只有 placeholder，
                用户分不清两者差在哪 */}
            <p className="tc-hint mt-1.5">{t('groupSettings.nicknameHint')}</p>
          </div>

          {/* ── 群聊备注 ── */}
          <Section label={t('groupSettings.remark')} />
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
                aria-label={t('groupSettings.remark')}
                placeholder={t('groupSettings.remarkPlaceholder')}
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
                {remark || t('groupSettings.remarkPlaceholder')}
              </button>
            )}
            <p className="tc-hint mt-1.5">{t('groupSettings.remarkHint')}</p>
          </div>

          <Divider />

          {/* ── 置顶开关 ──
              G-2（ui-review）：「消息免打扰」开关已删 —— 它与下面的
              「群消息设置」下拉共用 notifyMode，是同一状态的两个控件，
              改一处另一处跟着变。四档齐的下拉是唯一入口。 */}
          <ToggleRow
            label={t('groupSettings.pin')}
            checked={pinned}
            onToggle={() => sessionId && onTogglePin(!pinned)}
          />

          {/* ── 群消息设置（四档下拉）──
              notifyMode 的唯一完整展示面。收进群助手/屏蔽只有下拉能给 ——
              一个布尔开关表达不了四种状态，硬表达就会出现
              「开关说不提醒、实际已屏蔽」。 */}
          <div className="px-4 py-3">
            <div className="mb-2 text-body" style={{ color: 'var(--td-text-color-primary)' }}>
              {t('groupSettings.notifyTitle')}
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
                        {t(opt.labelKey)}
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
              {t('groupSettings.clearHistory')}
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
              {t('groupSettings.exitGroup')}
            </button>
          </div>
        </div>

        {/* ── 定时任务：钉在底部固定栏（G-1）──
            群排班是与「置顶 / 免打扰」同层的会话配置。原来它是滚动内容的一员，
            内容一溢出就被裁一半（236px 窄栏 + 8 组内容的直接后果）。
            它只有一个入口动作、且是这页除关闭外唯一「跳出面板」的动作 ——
            钉在底部永远完整可见。危险操作（删记录 / 退群）仍留在滚动区深处，
            「不能被顺手点到」的取舍（2026-10-20 反馈）不变。 */}
        <div
          className="shrink-0 px-4 pb-4 pt-3"
          style={{ borderTop: '1px solid var(--tc-divider)' }}
          data-group-schedule-section
        >
          <button
            type="button"
            onClick={() => setScheduleOpen(true)}
            data-group-schedule
            className="tc-btn-secondary w-full"
          >
            <CalendarClock size={15} />
            {t('chat.schedule')}
          </button>
        </div>
      </aside>

      {/* A224：群定时任务。与单聊共用同一个对话框（管理的是同一个会话的任务） */}
      {sessionId && (
        <ScheduleDialog
          open={scheduleOpen}
          session={{ id: sessionId, title, kind: 'group' }}
          onClose={() => setScheduleOpen(false)}
        />
      )}

      {/* 两个确认框都不可恢复，各过一次。删除记录是「普通危险」，
          退出群聊是全红实心 —— 档位要比删除记录更高 */}
      <ConfirmDialog
        open={confirmClear}
        title={t('groupSettings.clearHistory')}
        confirmText={t('groupSettings.confirmDelete')}
        danger
        onConfirm={() => {
          setConfirmClear(false);
          if (sessionId) void onClearMessages(sessionId);
        }}
        onCancel={() => setConfirmClear(false)}
      >
        {t('groupSettings.clearDesc')}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmExit}
        title={t('groupSettings.exitGroup')}
        confirmText={t('groupSettings.confirmExit')}
        danger
        onConfirm={() => {
          setConfirmExit(false);
          onExitGroup();
        }}
        onCancel={() => setConfirmExit(false)}
      >
        {t('groupSettings.exitDesc')}
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

