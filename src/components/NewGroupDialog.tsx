import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ChevronDown, ChevronRight, Search, Users, X, Check } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { useAgentRemarks } from '../agentRemarks';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useTranslation } from '../i18n';
import { agentStatusViewOf, availabilityLabelOf, type RegisteredAgent, type Session } from '../types';

/**
 * 发起群聊弹窗（A45 反馈：会话栏的「+」要弹出「发起群聊 / 重新探测」，
 * 点发起群聊后按 IM 的建群弹窗做）。
 *
 * ## 版式（ui-review C-1~C-5，24/25 号效果图）
 *
 * 宽屏（≥1100px）左右两栏、**左边挑人、右边看已选**：
 *   · 左：搜索框 → AGENT 列表（每行「勾选圈 + 头像 + 名字」）。
 *   · 右：标题「发起群聊」+「已选择 N 个 AGENT」+ 已选名单（可逐个 ×）；
 *     未选人时显示引导与建群规则，不再是一大片空白（C-2）。
 *   · 底部操作条横贯整个弹窗：左侧「或打开一个已有群 →」次级文字链（C-4，
 *     原来它折叠在主区顶部，与「发起群聊」主任务混淆），右侧「取消 / 完成」
 *     ——次级在左、主操作在右，与确认框、权限卡同一顺序（C-5）。
 *
 * 窄屏（<1100px）右栏整体收起，只留左栏 + 底部「已选条」：
 *   「已选择 N 个 AGENT」+ 已选头像 chips（C-1）。原来的 `min(880px,100%)`
 *   在 1024×640 的小窗口里占宽 86%、几乎全屏；现在宽度
 *   `min(720px, calc(100vw - 48px))`、高度 `min(600px, calc(100vh - 48px))`，
 *   任何窗口下四周都留 24px。
 *
 * ## Agent 列表的字母分组（C-3）
 *
 * 分组是导航辅助，前提是「分组头比内容少」。6 个 Agent 配 C/G/H/O/W 五个
 * 字母组头是本末倒置，所以 **≤ 12 个时直接平铺**，超过才按首字母分段
 * （中文名落到 `#`，没有引拼音库——为几个名字加一个依赖不值）。
 */
/** C-1：右栏收起为底部已选条的断点（<1100px 单栏） */
const NARROW_QUERY = '(max-width: 1099.98px)';
/** C-3：不超过这个数不显示字母组头，直接平铺 */
const FLAT_LIST_MAX = 12;

export function NewGroupDialog({
  open,
  agents,
  groups,
  getAgent,
  onClose,
  onCreate,
  onOpenGroup,
}: NewGroupDialogProps) {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  /** 勾选顺序无关，但已选名单按勾选先后排 —— 用户刚点的人在最后，能立刻看到 */
  const [selected, setSelected] = useState<string[]>([]);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(true);
  /** C-1：视口 <1100px 时右栏收起，已选名单落到底部已选条 */
  const narrow = useMediaQuery(NARROW_QUERY);
  const inputRef = useRef<HTMLInputElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);

  const remarks = useAgentRemarks();
  /** 显示名：备注优先 —— 与会话列表、通讯录、聊天头部同一套口径 */
  const nameOf = (a: RegisteredAgent) => remarks[a.id] || a.name;

  // 每次打开都从零开始：上次勾了谁、搜了什么，都不该带进这一次
  useEffect(() => {
    if (!open) return;
    setKeyword('');
    setSelected([]);
    setGroupsOpen(false);
    setContactsOpen(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // 锁定背景滚动；关闭时还原父级原来的值（不要硬写 ''）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // C-4：已有群入口挪到底部文字链后，展开的名单渲染在左栏顶部。
  // 触发点在屏幕底部，展开后把左栏滚回顶部，名单才真的在视线里。
  useEffect(() => {
    if (open && groupsOpen) leftScrollRef.current?.scrollTo({ top: 0 });
  }, [open, groupsOpen]);

  const kw = keyword.trim().toLowerCase();

  const filteredGroups = useMemo(
    () => (kw ? groups.filter(g => (g.title || '').toLowerCase().includes(kw)) : groups),
    [groups, kw]
  );

  const filteredAgents = useMemo(
    () =>
      agents
        .filter(a => (kw ? nameOf(a).toLowerCase().includes(kw) : true))
        // 按显示名排：分组之后每组内部的顺序也该是稳定的
        .slice()
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN')),
    // nameOf 依赖 remarks，remarks 变了要重排
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, kw, remarks]
  );

  /** 首字母分段（只在 Agent 多于 FLAT_LIST_MAX 时用）：拉丁字母归自己，其余归 `#` */
  const buckets = useMemo(() => {
    if (filteredAgents.length <= FLAT_LIST_MAX) return null;
    const map = new Map<string, RegisteredAgent[]>();
    for (const a of filteredAgents) {
      const first = nameOf(a).trim().charAt(0).toUpperCase();
      const key = /[A-Z]/.test(first) ? first : '#';
      const list = map.get(key);
      if (list) list.push(a);
      else map.set(key, [a]);
    }
    // A→Z 在前，`#` 收尾（IM 的惯例）
    return [...map.entries()].sort(([a], [b]) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredAgents, remarks]);

  const toggle = (id: string) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const submit = () => {
    if (selected.length === 0) return;
    onCreate(selected);
  };

  if (!open) return null;

  /** 一行可勾选的 Agent（左栏与字母分组共用同一行结构） */
  const agentRow = (a: RegisteredAgent) => {
    const checked = selected.includes(a.id);
    const meta = agentStatusViewOf(a);
    return (
      <button
        key={a.id}
        type="button"
        onClick={() => toggle(a.id)}
        aria-pressed={checked}
        data-new-group-agent={a.id}
        className="tc-list-item flex w-full items-center gap-2.5 px-5 py-2.5 text-left"
      >
        {/* 勾选圈在**左边**：IM 的建群列表就是「圈 → 头像 → 名字」，
            圈在右边会跟「在线状态」抢行尾那一小块地方 */}
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-colors"
          style={{
            backgroundColor: checked ? 'var(--td-brand-color)' : 'transparent',
            // A115 续：未选中态的勾选框走 --tc-edge-strong
            // （7% 墨）—— 控件轮廓档。1.5px 保留：18px 的
            // 圆圈上 1px 显得太细。
            border: checked ? 'none' : '1.5px solid var(--tc-edge-strong)',
            color: 'var(--tc-on-brand)',
          }}
        >
          {checked && <Check size={11} />}
        </span>
        <AgentAvatar
          id={a.id}
          name={nameOf(a)}
          icon={a.icon}
          src={a.logoUrl}
          color={a.color}
          availability={a.status.availability}
          size={32}
        />
        <span className="min-w-0 flex-1 truncate text-body" style={{ color: 'var(--td-text-color-primary)' }}>
          {nameOf(a)}
        </span>
        {/* 不可用的如实标出来 —— 拉进群也只会得到一条失败回复 */}
        {a.status.availability !== 'ready' && (
          <span className="shrink-0 text-caption" style={{ color: meta.color }}>
            {availabilityLabelOf(a)}
          </span>
        )}
      </button>
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        // 只有点在遮罩本身才关闭：从面板里按下、拖到遮罩上松手不该关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('contacts.newGroup')}
        data-new-group-dialog
        /* A115：统一走 `.tc-dialog` —— 半透明玻璃 + 四层立体影，遮罩是
           `--tc-mask-soft`（与另外四个弹窗同一套语言）。
           C-1：720 上限 + 视口四周 24px（高度同规则），小窗口不再近全屏；
           固定外框（A138：尺寸不许跟内容走），内容多了自己滚。 */
        className="tc-dialog flex h-[min(600px,calc(100vh-48px))] w-[min(720px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl"
      >
        {/* ── 中段：左栏（挑人）+ 宽屏右栏（已选）── */}
        <div className="flex min-h-0 flex-1">
          <div
            className="flex min-w-0 flex-1 flex-col"
            style={{ backgroundColor: 'var(--tc-surface-chrome)' }}
          >
            {/*
              A51（反馈「文字上下左右边距太窄」）：整块内距从 16/12 提到 20/16，
              行内距从 8 提到 10。头部高度**写死 72px**（= 16 + 40 搜索胶囊 + 16），
              宽屏右栏头部用同一个值：不写死的话两条底部分隔线差 16px 对不上。
            */}
            <div
              className="flex h-[72px] shrink-0 items-center px-5"
              style={{ borderBottom: '1px solid var(--tc-divider)' }}
            >
              <div
                // ⚠️ 必须 `w-full`：头部改成 flex 之后，这个胶囊成了 flex 项，
                // 不给宽度就按内容收缩（实测只剩 197px，搜索框窄得没法用）。
                className="flex h-10 w-full items-center gap-2 rounded-full bg-transparent px-3.5 transition-colors focus-within:bg-[var(--tc-fill-hover)]"
              >
                <Search size={14} style={{ color: 'var(--td-text-color-placeholder)' }} />
                <input
                  ref={inputRef}
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  placeholder={t('newGroup.search')}
                  className="w-full bg-transparent text-body outline-none"
                  style={{ color: 'var(--td-text-color-primary)' }}
                  data-new-group-search
                />
              </div>
            </div>

            {/* C-2：列表底部 16px 留白（pb-4），末行不再被裁一半 */}
            <div ref={leftScrollRef} className="min-h-0 flex-1 overflow-y-auto pb-4 pt-1.5">
              {/* 已有群名单（C-4）：入口挪到底部文字链，展开后渲染在左栏顶部。
                  它的用途是「接着上次那个群聊」，不是建群的主路径。 */}
              {groupsOpen && (
                <div className="pb-1" data-existing-groups-section>
                  <div
                    className="flex items-center gap-1.5 px-5 pb-1 pt-2 text-caption"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    {t('newGroup.existingSection')}
                    <span className="ml-auto">{groups.length}</span>
                  </div>
                  {filteredGroups.length === 0 ? (
                    <div className="px-12 py-2.5 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      <p>{groups.length === 0 ? t('newGroup.noGroups') : t('newGroup.noMatchGroups')}</p>
                      {/* 只有「搜出空」才给出口；一条群都没有时清搜索也没用 */}
                      {groups.length > 0 && kw && (
                        <button
                          type="button"
                          onClick={() => setKeyword('')}
                          className="mt-1.5 inline-flex text-caption underline"
                          style={{ color: 'var(--td-brand-color)' }}
                          data-new-group-clear-search
                        >
                          {t('contacts.clearSearch')}
                        </button>
                      )}
                    </div>
                  ) : (
                    filteredGroups.map(g => {
                      const members = (g.agentIds ?? [])
                        .map(id => getAgent(id)?.name)
                        .filter(Boolean) as string[];
                      const memberCount = g.agentIds?.length ?? 0;
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => onOpenGroup(g.id)}
                          data-existing-group={g.id}
                          className="tc-list-item flex w-full items-center gap-2.5 px-5 py-2.5 text-left"
                        >
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                            style={{
                              backgroundColor: 'var(--tc-surface-raised)',
                              color: 'var(--td-text-color-secondary)',
                            }}
                          >
                            <Users size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className="block truncate text-body font-medium"
                              style={{ color: 'var(--td-text-color-primary)' }}
                            >
                              {g.title || members.join('、') || t('contacts.groupFallback')}
                            </span>
                            <span
                              className="block truncate text-caption"
                              style={{ color: 'var(--td-text-color-placeholder)' }}
                            >
                              {t(memberCount === 1 ? 'contacts.memberOne' : 'contacts.memberMany', {
                                n: memberCount,
                              })}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}

              {/* AGENT */}
              <button
                type="button"
                onClick={() => setContactsOpen(v => !v)}
                aria-expanded={contactsOpen}
                className="flex w-full items-center gap-1.5 px-5 py-2.5 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                {contactsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                {t('newGroup.agentSection')}
                <span className="ml-auto text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {filteredAgents.length}
                </span>
              </button>

              {contactsOpen &&
                (filteredAgents.length === 0 ? (
                  <div className="px-12 py-3 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    <p>{t('newGroup.noMatchAgents')}</p>
                    {agents.length > 0 && kw && (
                      <button
                        type="button"
                        onClick={() => setKeyword('')}
                        className="mt-1.5 inline-flex text-caption underline"
                        style={{ color: 'var(--td-brand-color)' }}
                        data-new-group-clear-search
                      >
                        {t('contacts.clearSearch')}
                      </button>
                    )}
                  </div>
                ) : buckets ? (
                  /* C-3：Agent 多于 12 个才按首字母分段 */
                  buckets.map(([letter, list]) => (
                    <div key={letter}>
                      <div
                        className="px-6 pb-1 pt-3 text-caption"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      >
                        {letter}
                      </div>
                      {list.map(agentRow)}
                    </div>
                  ))
                ) : (
                  filteredAgents.map(agentRow)
                ))}
            </div>
          </div>

          {/* ── 宽屏右栏：已选（C-1：<1100px 时整栏收起，落到底部已选条）── */}
          {!narrow && (
            <div
              className="flex w-[320px] shrink-0 flex-col"
              style={{
                // 显式给底色，不靠「父级是白的所以看起来是白的」：深色 + 玻璃态下
                // 父级是半透明的，不给的话右栏会透出弹窗背后那一层，与左栏的实色
                // 并排看就是「一半实、一半虚」。
                backgroundColor: 'var(--tc-surface-content)',
                borderLeft: '1px solid var(--tc-divider)',
              }}
            >
              <div
                className="flex h-[72px] shrink-0 flex-col justify-center gap-0.5 px-5"
                style={{ borderBottom: '1px solid var(--tc-divider)' }}
              >
                <h2 className="text-title-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                  {t('contacts.newGroup')}
                </h2>
                <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {t('newGroup.selectedCount', { n: selected.length })}
                </span>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
                {selected.length === 0 ? (
                  /* C-2：右栏空态 = 操作指令 + 建群规则，不再是约 320×400 的空白 */
                  <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                    {/* A139：把「为什么完成是灰的」写在用户正在看的地方。
                        原来只有「从左侧勾选 AGENT」—— 那是操作指令，
                        没说明「不选会怎样」，于是灰按钮看起来像坏了。 */}
                    <p className="text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                      {t('newGroup.pickFromLeft')}
                    </p>
                    <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                      {t('newGroup.needOne')}
                    </p>
                    <ul className="mt-5 flex flex-col gap-1.5 text-left">
                      <li className="flex items-start gap-1.5 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                        <span aria-hidden="true">·</span>
                        <span>{t('newGroup.ruleEditable')}</span>
                      </li>
                      <li className="flex items-start gap-1.5 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                        <span aria-hidden="true">·</span>
                        <span>{t('newGroup.ruleMention')}</span>
                      </li>
                      <li className="flex items-start gap-1.5 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                        <span aria-hidden="true">·</span>
                        <span>{t('newGroup.ruleVisible')}</span>
                      </li>
                    </ul>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {selected.map(id => {
                      const a = getAgent(id);
                      const name = a ? nameOf(a) : id;
                      return (
                        <div
                          key={id}
                          className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
                          data-new-group-selected={id}
                        >
                          <AgentAvatar
                            id={id}
                            name={name}
                            icon={a?.icon}
                            src={a?.logoUrl}
                            color={a?.color}
                            availability={a?.status.availability}
                            size={32}
                            showStatus={false}
                          />
                          <span
                            className="min-w-0 flex-1 truncate text-body"
                            style={{ color: 'var(--td-text-color-primary)' }}
                          >
                            {name}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggle(id)}
                            title={t('newGroup.remove', { name })}
                            aria-label={t('newGroup.remove', { name })}
                            className="tc-icon-btn h-6 w-6 shrink-0"
                            style={{ color: 'var(--td-text-color-placeholder)' }}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── 窄屏已选条（C-1）：右栏收起后，已选名单从这里看、从这里删 ── */}
        {narrow && (
          <div
            className="flex shrink-0 items-center gap-2.5 px-5 py-2.5"
            style={{ borderTop: '1px solid var(--tc-divider)' }}
            data-new-group-selected-bar
          >
            <span
              className="shrink-0 text-body font-medium"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              {t('newGroup.selectedCount', { n: selected.length })}
            </span>
            {selected.length === 0 ? (
              // A139：窄屏没有右栏空态可写，原因句落在已选条上
              <span className="ml-auto text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                {t('newGroup.needOne')}
              </span>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
                {selected.map(id => {
                  const a = getAgent(id);
                  const name = a ? nameOf(a) : id;
                  return (
                    <span
                      key={id}
                      className="flex shrink-0 items-center gap-0.5 rounded-full py-0.5 pl-1 pr-1"
                      style={{ backgroundColor: 'var(--tc-fill-hover)' }}
                      data-new-group-selected={id}
                    >
                      <AgentAvatar
                        id={id}
                        name={name}
                        icon={a?.icon}
                        src={a?.logoUrl}
                        color={a?.color}
                        availability={a?.status.availability}
                        size={20}
                        showStatus={false}
                      />
                      <button
                        type="button"
                        onClick={() => toggle(id)}
                        title={t('newGroup.remove', { name })}
                        aria-label={t('newGroup.remove', { name })}
                        className="tc-icon-btn h-5 w-5 shrink-0"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── 底部操作条：文字链在左，按钮在右（C-4 / C-5）── */}
        <div
          className="flex shrink-0 items-center gap-2.5 px-5 py-4"
          style={{ borderTop: '1px solid var(--tc-divider)' }}
        >
          <button
            type="button"
            onClick={() => setGroupsOpen(v => !v)}
            aria-expanded={groupsOpen}
            data-existing-groups-toggle
            className="inline-flex items-center gap-1 rounded text-body transition-colors hover:underline"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            {t('newGroup.openExisting')}
            {groupsOpen ? <ChevronDown size={14} /> : <ArrowRight size={14} />}
          </button>
          <div className="ml-auto flex items-center gap-2.5">
            <button type="button" onClick={onClose} className="tc-btn-secondary">
              {t('newGroup.cancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={selected.length === 0}
              /* A139：禁用态必须说明「为什么点不了」。原来只有一颗灰按钮 ——
                 用户（尤其第一次用的人）看不出是「还没选人」还是「坏了」。
                 `title` 是鼠标侧的解释，界面侧的解释写在右栏空态 /
                 窄屏已选条里。 */
              title={selected.length === 0 ? t('newGroup.submitHint') : undefined}
              data-new-group-submit
              className="tc-btn-brand"
            >
              {t('newGroup.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface NewGroupDialogProps {
  open: boolean;
  /** 通讯录里的全部 Agent（可勾选的成员池） */
  agents: RegisteredAgent[];
  /** 已有的群聊会话：底部「或打开一个已有群」展开后就是这份数据 */
  groups: Session[];
  getAgent: (id: string | undefined) => RegisteredAgent | undefined;
  onClose: () => void;
  /** 点「完成」：把勾选到的成员 id 交给上层建群 */
  onCreate: (agentIds: string[]) => void;
  /** 点已有群：直接进那个群，关掉弹窗 */
  onOpenGroup: (sessionId: string) => void;
}
