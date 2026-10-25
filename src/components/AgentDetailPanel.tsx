import { ChevronLeft, MessageSquarePlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { AgentDetailSections } from './AgentDetailSections';
import { AVAILABILITY_META, availabilityLabelOf, type RegisteredAgent } from '../types';

interface AgentDetailPanelProps {
  agent: RegisteredAgent;
  onBack: () => void;
  onStartChat: (agentId: string) => void;
  /** 点「同族关系」里的名字直接切到那条资料（A68）。不传则名字不可点。 */
  onSelectAgent?: (agentId: string) => void;
  /** 装完之后的重新探测（A71）。整页场景给，弹窗场景不给 */
  onReprobe?: () => void;
  /** 跳设置页对应凭据行（A71，`method:'key'` 用） */
  onOpenCredential?: (agentId: string) => void;
  /** 删除自建 Agent（A114）。只有 `agent.custom` 为真时才出现 */
  onDeleteCustom?: (agentId: string) => void;
}

/**
 * Agent 详细资料页 —— 通讯录点开某个 Agent 后的二级页面。
 *
 * 参照微信「查看好友资料」的信息层级：
 *   大头像 + 名字 + 在线状态 → 基本信息行 → 擅长领域 → 介绍 → 技术信息 → 底部操作。
 *
 * 之所以把这些从列表行里搬出来：通讯录是「扫一眼谁在线」的地方，
 * 每行塞六种信息会让扫描变成阅读；而「这个 Agent 到底能干什么、
 * 为什么连不上」是低频但需要深看的问题，值得单独一页。
 *
 * ## 为什么没有页标题（A23 用户反馈）
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
  onOpenCredential,
  onDeleteCustom,
}: AgentDetailPanelProps) {
  const avail = agent.status.availability;
  const meta = AVAILABILITY_META[avail];
  const canChat = avail === 'ready';
  // A114：自建 Agent 才有删除。内置条目是编译进应用的，删了也回不来。
  const canDelete = !!agent.custom && !!onDeleteCustom;
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--tc-surface-content)',
        // A103：资料页也是「一栏」，与聊天列同规格的圆角。
        borderRadius: 'var(--tc-column-radius)',
      }}
    >
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
        <div className="mx-auto w-full max-w-[560px] px-4 pb-8 pt-3 sm:px-6">
          {/* 头部：头像 / 名称 / 状态 */}
          <div className="flex flex-col items-center text-center">
            <AgentAvatar
              id={agent.id}
              name={agent.name}
              icon={agent.icon}
              color={agent.color}
              availability={avail}
              size={80}
            />
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
            <div className="mt-2 flex items-center gap-1.5 text-body" style={{ color: meta.color }}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.dot }} />
              {availabilityLabelOf(agent)}
            </div>
          </div>

          {/* 信息区块与「聊天页 ⋯ → Agent 详情」弹窗共用同一份内容，
              见 AgentDetailSections。这里只负责整页的容器与页脚操作。 */}
          <AgentDetailSections
            agent={agent}
            onSelectAgent={onSelectAgent}
            onReprobe={onReprobe}
            onOpenCredential={onOpenCredential}
          />
        </div>
      </div>

      {/* 底部主操作：固定在页脚，滚动时不会跑掉。
          内层与正文同宽同列 —— 正文是 560px 居中的信息列，按钮如果铺满
          整条页脚（1440 窗口下约 1030px），会出现「一根巨长的蓝条托着一个
          窄栏」的割裂感。页脚底色仍然整条铺满，只把按钮收进同一列。 */}
      <div
        className="shrink-0 py-4"
        style={{
          backgroundColor: 'var(--td-bg-color-container)',
          borderTop: '1px solid var(--tc-divider)',
        }}
      >
        {/* 内层补上 px-6，与正文列的内边距一致 —— 否则按钮会比上面的卡片
            左右各宽 24px，看着像没对齐 */}
        <div className="mx-auto w-full max-w-[560px] px-4 sm:px-6">
          {/* A45（用户反馈）：「发消息」原来 `w-full` 铺满 560px 的信息列，
              1440 窗口下是一根 500 多像素的实心长条，比整页任何一块内容都
              抢眼 —— 它只是一个动作按钮，不该占一行的宽度。
              改成按内容自适应、整行居中：宽度跟着「图标 + 四个字」走，
              高度从 py-2.5 收到 py-2，与页脚其他次级按钮同一档。
              外层 flex 是因为 `.tc-btn-brand` 是 inline-flex，
              直接写 mx-auto 对 inline 级元素不生效。 */}
          <div className="flex justify-center">
            <button
              type="button"
              disabled={!canChat}
              onClick={() => onStartChat(agent.id)}
              className="tc-btn-brand px-6 py-2 text-body"
              data-start-chat
            >
              <MessageSquarePlus size={16} />
              {canChat ? '发消息' : '当前不可对话'}
            </button>
          </div>
          {/* 状态原因优先用探测结果自带的 message —— 它已经写清了「去哪儿修」
              （例如「请在设置 → 登录配置 → Agent API Key 填入 …」）。
              早先这里无条件在后面拼一句「· 需要先完成登录或修复」，与
              message 里的话重复，读起来像结巴。只有当探测没给 message 时
              才退回这句通用说明。 */}
          {!canChat && (
            <p className="mt-2 text-center text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {agent.status.message || `${availabilityLabelOf(agent)} · 需要先完成登录或修复`}
            </p>
          )}

          {/* A114：删除自建 Agent。两步确认（点一次出确认条，再点一次才真删）——
              删除不可恢复，而它紧挨着「发消息」，误触一次就没了太容易。
              删掉的只是定义与 Key，**不会**动这个 Agent 参与过的会话记录。 */}
          {canDelete && (
            <div className="mt-3 flex justify-center">
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
                  {/* A115：13 → 14。与页脚「发消息」的 16 只差一档，
                      原来 13 是这一页唯一一个奇数尺寸 */}
                  <Trash2 size={14} />
                  删除这个自建 Agent
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
