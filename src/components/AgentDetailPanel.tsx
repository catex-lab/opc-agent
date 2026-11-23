import { ChevronLeft, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MessagePlugin } from 'tdesign-react';
import { AgentAvatar } from './AgentAvatar';
import { StatusDot } from './StatusDot';
import { AgentDetailSections } from './AgentDetailSections';
import { AvatarCropDialog } from './AvatarCropDialog';
import { removeAgentLogo, uploadAgentLogo } from '../avatarApi';
import { LoginTerminalDialog } from './LoginTerminalDialog';
import { agentStatusViewOf, availabilityLabelOf, type RegisteredAgent } from '../types';
import type { AgentProbeFeedback } from '../agentProbe';
import { describeProbeFeedback } from '../agentProbe';
import { useTranslation } from '../i18n';
import { api } from '../api';

interface AgentDetailPanelProps {
  agent: RegisteredAgent;
  onBack: () => void;
  onStartChat: (agentId: string) => void;
  /** 点「同族关系」里的名字直接切到那条资料（A68）。不传则名字不可点。 */
  onSelectAgent?: (agentId: string) => void;
  /** 装完之后的重新探测（A71/A177）。只探测**当前这一个** Agent */
  onReprobe?: (agentId: string) => void;
  /** 当前 Agent 是否正在探测（按钮 loading + 禁用重复点击） */
  probing?: boolean;
  /** 当前 Agent 最近一次单探测的结果反馈 */
  probeFeedback?: AgentProbeFeedback;
  /** 跳设置页对应凭据行（A71，`method:'key'` 用） */
  onOpenCredential?: (agentId: string) => void;
  /** 删除自建 Agent（A114）。只有 `agent.custom` 为真时才出现 */
  onDeleteCustom?: (agentId: string) => void;
  /** 内置 Agent「从列表移除」（可恢复）。只有非自定义条目才出现 */
  onHideBuiltin?: (agentId: string) => void;
  /** A160：Logo 变更后刷新注册表（列表 / 名片 / 头部一起变） */
  onAvatarChanged?: () => void;
  /** P1：canary 触发后刷新名册（把 checking/结论带回来） */
  onRequestRefresh?: () => void;
}

/**
 * Agent 详细资料页 —— 通讯录点开某个 Agent 后的二级页面。
 *
 * 信息层级按「列表 → 资料页」两级组织：
 *   大头像 + 名字 + 在线状态 → 基本信息行 → 擅长领域 → 介绍 → 技术信息 → 底部操作。
 *
 * 之所以把这些从列表行里搬出来：通讯录是「扫一眼谁在线」的地方，
 * 每行塞六种信息会让扫描变成阅读；而「这个 Agent 到底能干什么、
 * 为什么连不上」是低频但需要深看的问题，值得单独一页。
 *
 * ## 为什么没有页标题（A23 反馈）
 *
 * 早先这里是一条 88px 的 `PanelHeader`：标题「详细资料」+ 副标题「名字·厂商」
 * + 返回键。问题是这三样都是**冗余**的 ——
 *   · 「详细资料」说了等于没说，用户点进来就知道这是资料页；
 *   · 名字与厂商紧接着又在大头像下面出现一次，滚动前是重复的；
 *   · 而这条 88px 把真正的内容（头像、状态、操作）整体压下去一截。
 * 现在只留一颗返回键（52px 的窄条），资料区直接顶上来。
 * 返回键必须保留：这是二级页面，没有它只能靠导航条绕回去。
 */
export function AgentDetailPanel({
  agent,
  onBack,
  onStartChat,
  onSelectAgent,
  onReprobe,
  probing,
  probeFeedback,
  onOpenCredential,
  onDeleteCustom,
  onHideBuiltin,
  /** P1：canary 触发后刷新名册（把 checking/结论带回来） */
  onRequestRefresh,
  onAvatarChanged,
}: AgentDetailPanelProps) {
  const { t } = useTranslation();
  const avail = agent.status.availability;
  const meta = agentStatusViewOf(agent);
  const canChat = avail === 'ready';
  /**
   * D1-1（审查报告）：「在线」与「还没做过真实检测」自相矛盾 ——
   * 在线是未经验证的在线。从未跑过真实检测（lastCanary 为空）时，
   * 即便探测说它 ready，状态也只写「未验证」（灰），不写「在线」（绿）；
   * 点过「真实检测」之后才回到绿点「在线」。不是 ready 的条目
   * （未登录 / 未安装…）状态词本来就诚实，不需要这层覆盖。
   */
  const unverifiedReady = canChat && !agent.status.lastCanary;
  // A114：自建 Agent 才有删除。内置条目是编译进应用的，只能从列表移除
  //（隐藏状态可恢复，可在「+ → 获取 Agent」里加回来）。
  const canDelete = !!agent.custom && !!onDeleteCustom;
  const canHide = !agent.custom && !!onHideBuiltin;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  // A160：Logo 上传（裁剪 → 上传 → 刷新注册表）
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  // P1：canary 手动触发的本地态。canary.at 变化 = 服务端已有新结论，解除转圈
  const [canaryArmedAt, setCanaryArmedAt] = useState<string | null>(null);
  // P2：登录终端对话框
  const [loginOpen, setLoginOpen] = useState(false);
  const canaryArmed = canaryArmedAt !== null && agent.canary?.at === canaryArmedAt;
  useEffect(() => {
    if (canaryArmedAt && agent.canary?.at !== canaryArmedAt) setCanaryArmedAt(null);
  }, [agent.canary?.at, canaryArmedAt]);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      /* 打靶锚点：资料页是**内嵌栏**不是弹窗（弹窗版是 AgentDetailModal），
         没有这个属性的话脚本只能靠「返回通讯录」按钮反推容器，很脆。 */
      data-agent-detail-page
      style={{
        backgroundColor: 'var(--tc-surface-content)',
        // A103：资料页也是「一栏」，与聊天列同规格的圆角。
        borderRadius: 'var(--tc-column-radius)',
      }}
    >
      <AvatarCropDialog
        file={cropFile}
        title={`更换 ${agent.name} 的 Logo`}
        onCancel={() => setCropFile(null)}
        onConfirm={dataUrl => {
          setCropFile(null);
          setUploadingLogo(true);
          void uploadAgentLogo(agent.id, dataUrl)
            .then(() => onAvatarChanged?.())
            .catch(err => MessagePlugin.error(`Logo 上传失败：${err instanceof Error ? err.message : String(err)}`))
            .finally(() => setUploadingLogo(false));
        }}
      />
      {/* 只有返回键的窄条。高度与别处的 compact 头部同值（--tc-header-height），
          这样切栏时这条底边线跟通讯录栏头落在同一行。 */}
      <div
        className="flex shrink-0 items-center px-3"
        style={{
          height: 'var(--tc-header-height)',
          borderBottom: '1px solid var(--tc-divider)',
        }}
      >
        <button
          type="button"
          onClick={onBack}
          title="返回通讯录"
          aria-label="返回通讯录"
          data-detail-back
          className="tc-icon-btn h-8 w-8"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <ChevronLeft size={20} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* pt-3：窄条已经把标题栏省掉了，这里再留 32px 会把「上提」抵消掉 */}
        <div className="mx-auto w-full max-w-[760px] px-4 pb-8 pt-3 sm:px-6" data-agent-detail-col>
          {/* 头部：头像 / 名称 / 状态 */}
          <div className="flex flex-col items-center text-center">
            {/* D1-4（审查报告）：「更换 Logo」原来是一条夹在状态与基本信息
                之间的文字链，位置随意。改成头像右下角的编辑角标按钮 ——
                「改这张图」的动作长在图上。上传流程不变（角标 → 裁剪 → 上传）。 */}
            <div className="relative">
              <AgentAvatar
                id={agent.id}
                name={agent.name}
                icon={agent.icon}
                src={agent.logoUrl}
                color={agent.color}
                availability={avail}
                /* A124（需求）：详情页头像不再挂右下角状态点。
                   这颗点与下面那行「● 在线」说的是同一件事，同屏两个状态码
                   只会让人怀疑两者会不会不一致 —— 保留带文字的那一个。
                   列表 / 名片 / 头部那些小头像仍然带点（那里没有文字状态行）。 */
                showStatus={false}
                size={80}
              />
              <button
                type="button"
                title={uploadingLogo ? '上传中…' : '更换 Logo'}
                aria-label={uploadingLogo ? '上传中…' : '更换 Logo'}
                disabled={uploadingLogo}
                data-agent-logo-upload
                onClick={() => logoInputRef.current?.click()}
                className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-60"
                style={{
                  backgroundColor: 'var(--tc-surface-content)',
                  borderColor: 'var(--tc-edge-strong)',
                  color: 'var(--td-text-color-secondary)',
                }}
              >
                <Pencil size={13} />
              </button>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                data-agent-logo-file
                onChange={e => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  if (f) setCropFile(f);
                }}
              />
            </div>
            <h2
              className="mt-4 text-title-lg font-semibold"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {agent.name}
            </h2>
            {agent.vendor && (
              <p className="mt-1 text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {agent.vendor}
              </p>
            )}
            {/* D1-1：从未真实检测过时状态写「未验证」（灰），不写「在线」（绿） */}
            {unverifiedReady ? (
              <div
                className="mt-2 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption"
                style={{
                  color: 'var(--td-text-color-secondary)',
                  backgroundColor: 'var(--td-bg-color-component)',
                }}
                data-agent-verify-badge="unverified"
              >
                <StatusDot
                  color="var(--td-text-color-placeholder)"
                  shape="hollow"
                  size={8}
                  statusLabel="未验证"
                />
                未验证
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-1.5 text-body" style={{ color: meta.color }}>
                <StatusDot color={meta.dot} shape={meta.dotShape} size={8} statusLabel={meta.label} />
                {/* P1：状态词以诊断事实为准（labelKey 优先），与通讯录同一口径 */}
                {meta.labelKey ? t(meta.labelKey as never) : availabilityLabelOf(agent)}
              </div>
            )}
            {/* P1：真实检测——上次时间 + 手动触发。这是名册状态的唯一可信源 */}
            <div className="mt-2 flex items-center justify-center gap-2 text-caption" data-agent-canary>
              <span style={{ color: 'var(--td-text-color-placeholder)' }}>
                {agent.status.lastCanary
                  ? t('canary.lastAt', {
                      time: new Date(agent.status.lastCanary.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    })
                  : t('canary.never')}
              </span>
              {agent.login && (
                <button
                  type="button"
                  className="underline underline-offset-2"
                  style={{ color: 'var(--td-brand-color)' }}
                  data-agent-open-login
                  onClick={() => setLoginOpen(true)}
                >
                  {t('login.terminal.open')}
                </button>
              )}
              <button
                type="button"
                className="underline underline-offset-2"
                style={{ color: 'var(--td-brand-color)' }}
                disabled={canaryArmed}
                data-agent-canary-run
                onClick={() => {
                  const at = new Date().toISOString();
                  setCanaryArmedAt(at);
                  void api.post('/api/agents/canary', {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentId: agent.id }),
                  })
                    .catch(() => undefined)
                    .finally(() => onRequestRefresh?.());
                }}
              >
                {canaryArmed ? t('canary.running') : t('canary.run')}
              </button>
            </div>
            {/* A160：「恢复默认」只删映射，不改定义表，内置条目也能随时回到
                官方 logo。D1-4 后它不再与「更换 Logo」并排 —— 上传入口已
                收进头像角标，这里只留这条低调的文字链（有自定义图才出现）。 */}
            {agent.logoUrl && (
              <button
                type="button"
                className="mt-1.5 text-caption underline underline-offset-2"
                style={{ color: 'var(--td-text-color-placeholder)' }}
                data-agent-logo-reset
                onClick={() => {
                  void removeAgentLogo(agent.id)
                    .then(() => onAvatarChanged?.())
                    .catch(err =>
                      MessagePlugin.error(
                        `恢复默认 Logo 失败：${err instanceof Error ? err.message : String(err)}`
                      )
                    );
                }}
              >
                恢复默认
              </button>
            )}
            {/* D1-3（审查报告）：「发消息」原来是独占一条底栏的黑按钮，
                视觉重量比整页任何资料块都大 —— 而这一页的主任务是「看资料」。
                改成资料区下方的次级描边按钮；不可对话时保持禁用 + 原因句。
                data-start-chat 锚点不变。 */}
            <button
              type="button"
              disabled={!canChat}
              onClick={() => onStartChat(agent.id)}
              className="tc-btn-secondary mt-4"
              data-start-chat
            >
              <MessageSquarePlus size={16} />
              {canChat ? '发消息' : '当前不可对话'}
            </button>
            {!canChat && (
              <p
                className="mt-2 max-w-[420px] text-center text-secondary"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                {agent.status.message
                  ? `${availabilityLabelOf(agent)} · ${agent.status.message}`
                  : `${availabilityLabelOf(agent)} · 需要先完成登录或修复`}
              </p>
            )}
          </div>

          {/* 信息区块与「聊天页 ⋯ → Agent 详情」弹窗共用同一份内容，
              见 AgentDetailSections。这里只负责整页的容器与页脚操作。 */}
          <AgentDetailSections
            agent={agent}
            onSelectAgent={onSelectAgent}
            onReprobe={onReprobe}
            probing={probing}
            probeFeedback={probeFeedback}
            onOpenCredential={onOpenCredential}
          />

          {/* A114：删除自建 Agent。两步确认（点一次出确认条，再点一次才真删）——
              删除不可恢复，而它紧挨着「发消息」，误触一次就没了太容易。
              删掉的只是定义与 Key，**不会**动这个 Agent 参与过的会话记录。
              D1-3 后页脚整条撤掉，这块收进正文信息列的末尾（低频且危险，
              放在所有资料读完后正好）。 */}
          {canDelete && (
            <div className="mt-6 flex justify-center">
              {confirmDelete ? (
                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-secondary"
                  style={{
                    color: 'var(--td-error-color)',
                    backgroundColor: 'var(--td-error-color-light)',
                  }}
                  data-custom-delete-confirm
                >
                  <span>删除后不可恢复，会话记录会保留</span>
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteCustom?.(agent.id);
                      setConfirmDelete(false);
                    }}
                    className="font-medium underline"
                    data-custom-delete-ok
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-secondary transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                  data-custom-delete
                >
                  <Trash2 size={14} />
                  删除这个自建 Agent
                </button>
              )}
            </div>
          )}

          {/* 内置 Agent：只从列表移除（可恢复）。文案必须说清「还能加回来」，
              否则用户会以为内置条目被卸载了。 */}
          {canHide && (
            <div className="mt-6 flex justify-center">
              {confirmHide ? (
                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-secondary"
                  style={{
                    color: 'var(--td-error-color)',
                    backgroundColor: 'var(--td-error-color-light)',
                  }}
                  data-hide-agent-confirm
                >
                  <span>{t('contacts.hideAgentFromDetailConfirm')}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onHideBuiltin?.(agent.id);
                      setConfirmHide(false);
                    }}
                    className="font-medium underline"
                    data-hide-agent-ok
                  >
                    {t('contacts.confirmHide')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmHide(false)}
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    {t('addcli.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmHide(true)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-secondary transition-colors hover:bg-[var(--tc-hover-chrome)]"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                  data-hide-agent
                >
                  <Trash2 size={14} />
                  {t('contacts.hideAgentFromDetail')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* P2：登录代管终端（portal 到 body，DOM 位置无关；退出后自动 canary 复检） */}
      {loginOpen && agent.login && (
        <LoginTerminalDialog agent={agent} onClose={() => setLoginOpen(false)} />
      )}
    </div>
  );
}
