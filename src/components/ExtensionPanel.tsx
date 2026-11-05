import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Boxes, Download, RefreshCw, Search, Sparkles, Plug, ShieldAlert, Pencil } from 'lucide-react';
import { ExtensionSwitch } from './ExtensionSwitch';
import { InfoHint, type InfoHintItem } from './InfoHint';
import {
  EXT_DRIFT_LABEL,
  type ExtensionDriftState,
  type ExtensionKind,
  type ExtensionListItem,
  type ExtensionStats,
} from '../types';
import { useExtensionDrift } from '../hooks/useExtensions';

/**
 * 差异四态的取色。
 *
 * `updated` 用品牌色而不是绿色：绿色在这栏里已经被 `×N`（来源数）和
 * 「已就位」占用了，再借一次会让「源变了」看起来像「一切正常」。
 */
const DRIFT_COLOR: Record<ExtensionDriftState, string> = {
  new: 'var(--tc-status-ok)',
  updated: 'var(--td-brand-color)',
  conflict: 'var(--tc-status-warn)',
  gone: 'var(--td-text-color-placeholder)',
};

interface ExtensionPanelProps {
  items: ExtensionListItem[];
  stats: ExtensionStats | null;
  loading: boolean;
  importing: boolean;
  error: string | null;
  /** 当前选中的扩展；`null` = 没选（右侧给空态） */
  selected: { kind: ExtensionKind; name: string } | null;
  onSelect: (kind: ExtensionKind, name: string) => void;
  onImport: () => void;
  onRefresh: () => void;
  onToggleEnabled: (kind: ExtensionKind, name: string, enabled: boolean) => void;
  onToggleKindEnabled: (kind: ExtensionKind, enabled: boolean) => void;
  compact?: boolean;
}

/**
 * 扩展列表栏（A164）。
 *
 * ## 一个入口、两个分组
 *
 * 「Agent 技能」（SKILL.md）和「MCP 服务」（各家 mcp.json / config.toml）在
 * 数据层是两张不同的表，但在用户眼里是同一件事：「我给 Agent 装了哪些能力」。
 * 所以不做两个导航项、不做 Tab —— Tab 会让「一共装了多少」永远看不全，
 * 而这一栏的核心价值恰恰是那份总量。分组标题 + 各自的计数就够。
 *
 * ## 为什么每行都要显示来源数
 *
 * 这个功能的整个卖点是「同一份内容被 5 个 Agent 各存了一遍，我们收成 1 份」。
 * 如果行上不显示 `×5`，用户看不出合并发生过 —— 他会以为自己多了 5 个技能，
 * 而实际上导入前确实是 5 份。来源数就是这个功能的**证据**。
 *
 * ## 三个角标的语义不能混
 *
 * - `×N`（次要色）＝ 从几个 Agent 目录里找到了同一份 —— 信息，不是问题
 * - 盾牌（警告色）＝ 命中敏感内容，正文没落库 —— 提醒，需要用户知情
 * - 铅笔（品牌色）＝ 本地改过，源更新不会自动覆盖 —— 状态，说明「你改的还在」
 */
export function ExtensionPanel({
  items,
  stats,
  loading,
  importing,
  error,
  selected,
  onSelect,
  onImport,
  onRefresh,
  onToggleEnabled,
  onToggleKindEnabled,
  compact = false,
}: ExtensionPanelProps) {
  const [keyword, setKeyword] = useState('');
  /**
   * 差异检测（A168 / P4）。面板挂载时才轮询，切走就停 —— 见 `useExtensionDrift`。
   */
  const drift = useExtensionDrift();
  const [driftOpen, setDriftOpen] = useState(false);
  const driftCounts = drift.report?.counts;
  /** 能一键跟上的：`new` / `updated`。`conflict` 不在里面（会丢用户的编辑），`gone` 也不在。 */
  const applicable = useMemo(
    () => (drift.report?.entries ?? []).filter(e => e.state === 'new' || e.state === 'updated'),
    [drift.report]
  );
  /** 徽章上只放得下「N 处变化」，分类明细进 title —— 侧栏就这么宽，塞不下四段文案 */
  const driftBreakdown = useMemo(() => {
    if (!driftCounts) return '';
    const parts: string[] = [];
    if (driftCounts.new) parts.push(`新发现 ${driftCounts.new}`);
    if (driftCounts.updated) parts.push(`源已更新 ${driftCounts.updated}`);
    if (driftCounts.conflict) parts.push(`有冲突 ${driftCounts.conflict}`);
    if (driftCounts.gone) parts.push(`源已消失 ${driftCounts.gone}`);
    return parts.join(' · ');
  }, [driftCounts]);

  const applyDrift = async (entries: Array<{ kind: string; name: string }>) => {
    const results = await drift.apply(entries);
    // 只有真写进去了才重拉列表 —— `conflict` / `missing` 什么都没改，
    // 重拉一次会让列表闪一下却没变化。
    if (results?.some(r => r.outcome === 'added' || r.outcome === 'updated')) onRefresh();
  };

  /** 栏头的「重新读取」= 列表 + 差异一起刷新。分开两个按钮只会让人猜哪个管什么。 */
  const handleRefresh = () => {
    onRefresh();
    void drift.reload();
  };

  /**
   * 全量导入结束的那一刻重扫一次差异。
   *
   * 不做的话：点完「导入」，列表已经是最新的，但差异徽章还挂着导入前的结论
   * （最长 60 秒）。用户会以为「导入没生效」，然后再点一次。
   * 用 `importing` 的**下降沿**触发，而不是在 `onImport` 里 setTimeout ——
   * 后者是猜导入要多久，猜短了扫到旧状态，猜长了白等。
   */
  const wasImporting = useRef(importing);
  useEffect(() => {
    if (wasImporting.current && !importing) void drift.reload(true);
    wasImporting.current = importing;
  }, [importing, drift]);

  const visible = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return items;
    return items.filter(
      it =>
        it.name.toLowerCase().includes(k) ||
        (it.title ?? '').toLowerCase().includes(k) ||
        (it.description ?? '').toLowerCase().includes(k)
    );
  }, [items, keyword]);

  const skills = visible.filter(it => it.kind === 'skill');
  const mcps = visible.filter(it => it.kind === 'mcp');
  const total = items.length;

  /* 页脚常驻的长句收进 ⓘ；标题行只留「N 个技能 · M 个 MCP」这一句摘要。 */
  const statHintItems: InfoHintItem[] = stats
    ? [
        {
          term: '条目',
          definition: `${stats.skillCount} 条 Agent 技能、${stats.mcpCount} 条 MCP 服务。`,
        },
        ...(stats.duplicateCount > 0
          ? [
              {
                term: '已合并多份',
                definition: `${stats.duplicateCount} 条：同一份内容出现在多个 Agent 目录里，已按内容去重成一条。`,
              },
            ]
          : []),
        ...(stats.blockedCount > 0
          ? [
              {
                term: '含敏感内容',
                definition: `${stats.blockedCount} 条：正文命中疑似密钥或本机用户路径，OPC 不保存正文，也不会分发或注入。`,
              },
            ]
          : []),
        {
          term: '开关',
          definition: '关闭后这条不再参与分发或提示词注入，随时可以开回来。',
        },
      ]
    : [];

  const renderRow = (it: ExtensionListItem) => {
    const active = selected?.kind === it.kind && selected.name === it.name;
    const Icon = it.kind === 'skill' ? Sparkles : Plug;
    /* disabled 的条目让视觉退化：文字灰 30%、图标轮廓，告诉用户「这条不参与
       分发/注入」但它还在库里（一键能开回来）。不是删除，只是停用。 */
    const rowDisabled = !it.enabled;
    /* 老后端不下发 `distributable` 时按「可分发」处理，避免把开关误锁死。 */
    const noTargets = it.distributable === false;
    return (
      <button
        key={`${it.kind}:${it.name}`}
        type="button"
        onClick={() => onSelect(it.kind, it.name)}
        aria-current={active ? 'page' : undefined}
        aria-disabled={rowDisabled || undefined}
        className="mb-0.5 flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
        /* A75 的同一条教训：未选中项不能写内联 transparent 底色，否则
           Tailwind 的 hover:bg 被内联样式压死，整栏只有当前项会变色。 */
        style={active ? { backgroundColor: 'var(--tc-fill-selected)' } : undefined}
        data-ext-row={`${it.kind}:${it.name}`}
      >
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor: active
              ? 'var(--td-brand-color-light)'
              : rowDisabled
                ? 'var(--td-bg-color-component)'
                : 'var(--td-bg-color-component)',
            color: active
              ? 'var(--td-brand-color)'
              : rowDisabled
                ? 'var(--td-text-color-placeholder)'
                : 'var(--td-text-color-secondary)',
          }}
        >
          <Icon size={16} style={rowDisabled ? { opacity: 0.6 } : undefined} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className="truncate text-body"
              style={{
                color: rowDisabled
                  ? 'var(--td-text-color-placeholder)'
                  : active
                    ? 'var(--td-brand-color)'
                    : 'var(--td-text-color-primary)',
              }}
            >
              {it.title || it.name}
            </span>
            {it.locallyModified && !rowDisabled && (
              <Pencil
                size={11}
                className="shrink-0"
                style={{ color: 'var(--td-brand-color)' }}
                data-ext-badge-local
              />
            )}
            {/* 敏感内容：图标 + 行内「敏感」短标记。风险告知不能只说一个图标，
                更不能只藏在 hover 里 —— 详情收进页脚的 ⓘ 浮层。 */}
            {it.blocked && (
              <span
                className="flex shrink-0 items-center gap-0.5"
                style={{ color: 'var(--tc-status-warn)' }}
              >
                <ShieldAlert size={11} data-ext-badge-blocked />
                <span className="text-caption" data-ext-badge-blocked-text>
                  敏感
                </span>
              </span>
            )}
          </span>
          <span
            className="mt-0.5 block truncate text-caption"
            style={{ color: rowDisabled ? 'var(--td-text-color-placeholder)' : 'var(--td-text-color-secondary)' }}
            title={it.description ?? it.name}
          >
            {it.description || it.name}
          </span>
        </span>
        {/* 来源数：同一份内容被几个 Agent 目录各存了一遍。>1 才显示 ——
            全是 1 的时候显示「×1」是噪声，反而看不出「合并过」。 */}
        {it.sourceCount > 1 && (
          <span
            className="mt-1 shrink-0 text-caption tabular-nums"
            style={{ color: 'var(--td-text-color-secondary)' }}
            title={`在 ${it.sourceCount} 个 Agent 目录里找到同一份：${it.sources
              .map(s => s.agentId)
              .join('、')}`}
            data-ext-source-count={it.sourceCount}
          >
            ×{it.sourceCount}
          </span>
        )}
        {/* 单条开关：统一到 ExtensionSwitch（绿色开启 / 敏感条目琥珀）。
            `distributable === false` 时置灰 —— 这条没有任何 Agent 能收到，
            置灰比「点了没反应」诚实；两种禁用语义分开说（见下方短标记）。 */}
        <span className="mt-0.5 flex shrink-0 flex-col items-end gap-0.5">
          <ExtensionSwitch
            checked={it.enabled}
            onClick={() => onToggleEnabled(it.kind, it.name, !it.enabled)}
            label={noTargets ? '无可分发目标，开关不可用' : it.enabled ? '关闭此条扩展' : '启用此条扩展'}
            title={
              noTargets
                ? '无可分发目标：本机没有能接收这一条的 Agent（目标目录不存在或没有挂载通道），或这些 Agent 自己已经有了'
                : it.enabled
                  ? '关闭后此条扩展不再参与分发或提示词注入，节省 token'
                  : '重新启用此条扩展'
            }
            tone={it.blocked ? 'warn' : 'on'}
            disabled={noTargets}
            dataAttrs={{ 'data-ext-row-toggle': '', 'data-enabled': it.enabled ? '1' : '0' }}
          />
          {/* 短标记常驻：说明「不是开关坏了」。口径（为什么没有目标）在 title / 详情浮层。 */}
          {noTargets && (
            <span
              className="text-caption leading-none"
              style={{ color: 'var(--td-text-color-placeholder)' }}
              title="本机没有能接收这一条的 Agent（目标目录不存在或没有挂载通道）"
              data-ext-no-target
            >
              无可分发
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div
      className={`flex flex-col ${compact ? 'w-full' : 'shrink-0'}`}
      style={{
        backgroundColor: 'var(--tc-surface-chrome)',
        width: compact ? undefined : 'var(--tc-sidebar-width)',
        borderRadius: 'var(--tc-column-radius)',
      }}
      data-ext-panel
    >
      {/* 栏头：标题 + 计数 + 导入/刷新。高度与项目栏一致（dense 60px），
          右侧详情页头部同高，两块底边线连成一条。 */}
      <header
        className="flex shrink-0 items-center gap-2 px-4"
        style={{
          minHeight: 'var(--panel-header-height-dense)',
          borderBottom: '1px solid var(--tc-divider)',
        }}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="truncate font-semibold text-title-lg" style={{ color: 'var(--td-text-color-primary)' }}>
            扩展
          </h2>
          <span className="shrink-0 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
            {total}
          </span>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          title="重新读取列表并检查本机源文件有没有变化"
          aria-label="重新读取列表"
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
          data-ext-refresh
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
        <button
          type="button"
          onClick={onImport}
          disabled={importing}
          title="扫描本机所有 Agent 目录，把技能与 MCP 收进 OPC"
          aria-label="从本机 Agent 导入"
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:cursor-not-allowed disabled:opacity-60"
          style={{ color: 'var(--td-brand-color)' }}
          data-ext-import
        >
          <Download size={15} className={importing ? 'animate-pulse' : undefined} />
          {importing ? '导入中' : '导入'}
        </button>
      </header>

      {/* ── 差异提示（A168 / P4）──────────────────────────────────────
          只在「真扫到了变化」时出现。没有变化时一个字都不占 ——
          常驻一条「一切正常」的横幅会把真正要紧的提示淹掉。
          侧栏很窄，所以徽章只放总数，明细收进「查看」。 */}
      {driftCounts && driftCounts.total > 0 && (
        <div className="shrink-0 px-3 pt-2" data-ext-drift data-ext-drift-total={driftCounts.total}>
          <div
            className="rounded-xl px-2.5 py-2"
            style={{
              backgroundColor: 'var(--td-bg-color-component)',
              border: '1px solid var(--tc-divider)',
            }}
          >
            <div className="flex items-center gap-1.5">
              <AlertCircle size={14} className="shrink-0" style={{ color: 'var(--tc-status-warn)' }} />
              <span
                className="min-w-0 flex-1 truncate text-body"
                style={{ color: 'var(--td-text-color-primary)' }}
                title={driftBreakdown}
                data-ext-drift-summary
              >
                {driftCounts.total} 处变化
              </span>
              <button
                type="button"
                onClick={() => setDriftOpen(v => !v)}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                style={{ color: 'var(--td-brand-color)' }}
                data-ext-drift-toggle
              >
                {driftOpen ? '收起' : '查看'}
              </button>
            </div>

            {driftOpen && (
              <div className="mt-2" data-ext-drift-list>
                <ul className="space-y-1.5">
                  {(drift.report?.entries ?? []).map(e => (
                    <li
                      key={`${e.kind}:${e.name}`}
                      className="flex items-start gap-1.5"
                      data-ext-drift-row={`${e.kind}:${e.name}`}
                      data-ext-drift-state={e.state}
                    >
                      <span className="shrink-0 text-caption" style={{ color: DRIFT_COLOR[e.state] }}>
                        {EXT_DRIFT_LABEL[e.state]}
                      </span>
                      <span
                        className="min-w-0 flex-1 text-caption leading-5"
                        style={{ color: 'var(--td-text-color-secondary)' }}
                      >
                        <span style={{ color: 'var(--td-text-color-primary)' }}>{e.name}</span>
                        {' · '}
                        {e.detail}
                      </span>
                      {e.state === 'new' || e.state === 'updated' ? (
                        <button
                          type="button"
                          disabled={drift.applying}
                          onClick={() => void applyDrift([{ kind: e.kind, name: e.name }])}
                          className="shrink-0 rounded-md px-1.5 py-0.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-50"
                          style={{ color: 'var(--td-brand-color)' }}
                          data-ext-drift-apply={`${e.kind}:${e.name}`}
                        >
                          应用
                        </button>
                      ) : (
                        /* 冲突和「源已消失」都不该一键处理：前者会丢用户的编辑，
                           后者要用户先看一眼再决定删不删。只给一个「查看」。 */
                        <button
                          type="button"
                          onClick={() => onSelect(e.kind, e.name)}
                          className="shrink-0 rounded-md px-1.5 py-0.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                          style={{ color: 'var(--td-text-color-secondary)' }}
                          data-ext-drift-open={`${e.kind}:${e.name}`}
                        >
                          查看
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {applicable.length > 1 && (
                  <button
                    type="button"
                    disabled={drift.applying}
                    onClick={() => void applyDrift(applicable.map(e => ({ kind: e.kind, name: e.name })))}
                    className="mt-2 w-full rounded-md py-1 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-50"
                    style={{ color: 'var(--td-brand-color)' }}
                    data-ext-drift-apply-all
                  >
                    {drift.applying ? '应用中…' : `全部应用（${applicable.length}）`}
                  </button>
                )}
                {drift.error && (
                  <p className="mt-1 text-caption" style={{ color: 'var(--td-error-color)' }} data-ext-drift-error>
                    {drift.error}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 搜索：技能动辄几十个，没有它只能靠滚。没有条目时不渲染 ——
          对着空列表摆一个搜索框是纯装饰。 */}
      {total > 0 && (
        <div className="shrink-0 px-3 pb-2 pt-2">
          <div
            className="flex h-9 items-center gap-2 rounded-full px-3"
            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
          >
            <Search size={14} style={{ color: 'var(--td-text-color-placeholder)' }} />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="搜索名称或描述"
              className="min-w-0 flex-1 bg-transparent text-body outline-none"
              style={{ color: 'var(--td-text-color-primary)' }}
              data-ext-search
            />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-ext-list>
        {error ? (
          <p className="px-3 py-6 text-body" style={{ color: 'var(--td-error-color)' }}>
            {error}
          </p>
        ) : loading && total === 0 ? (
          /* D3：读取扩展要扫描本机多个 Agent 目录，冷启时列表会空 1–2 秒。
             原先只有一行灰字，看起来像「加载失败后的残留」；骨架屏先把
             列表的形态给出来（头像 + 两行 + 右侧开关），再被真实行替换。 */
          <div className="tc-ext-skeleton" role="status" aria-label="正在读取扩展…" data-ext-skeleton>
            {[0, 1, 2, 3].map(index => (
              <div className="tc-ext-skel-row" aria-hidden="true" key={index}>
                <span className="tc-ext-skel-avatar" />
                <span className="tc-ext-skel-lines">
                  <span className="tc-ext-skel-line" />
                  <span className="tc-ext-skel-line is-short" />
                </span>
                <span className="tc-ext-skel-toggle" />
              </div>
            ))}
          </div>
        ) : total === 0 ? (
          /* 空态必须说清「这些条目从哪来」。用户第一反应会是「怎么装」，
             而这里的正确答案是「装在你自己的 Agent 里，然后点导入」。 */
          <div className="px-3 py-8 text-center" data-ext-empty>
            <Boxes size={28} className="mx-auto mb-2" style={{ color: 'var(--td-text-color-placeholder)' }} />
            <p className="text-body" style={{ color: 'var(--td-text-color-secondary)' }}>
              还没有导入任何扩展
            </p>
            <p className="mt-1 text-caption leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
              这一栏读的是你本机各家 Agent 已有的技能与 MCP，
              <br />
              不往它们的目录里写任何东西。
            </p>
            <button
              type="button"
              onClick={onImport}
              disabled={importing}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-body transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-60"
              style={{ color: 'var(--td-brand-color)', border: '1px solid var(--tc-edge)' }}
              data-ext-empty-import
            >
              <Download size={14} />
              {importing ? '正在扫描…' : '从本机 Agent 导入'}
            </button>
          </div>
        ) : visible.length === 0 ? (
          /* 搜出空态要给出口（A139 的同一条教训）：只写「没有匹配」的话，
             用户得自己回去把搜索框的字删掉。 */
          <div className="px-3 py-6" data-ext-search-empty>
            <p className="text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
              没有匹配「{keyword}」的扩展
            </p>
            <button
              type="button"
              onClick={() => setKeyword('')}
              className="mt-1.5 inline-flex text-caption underline"
              style={{ color: 'var(--td-brand-color)' }}
              data-ext-clear-search
            >
              清除搜索
            </button>
          </div>
        ) : (
          <>
            {skills.length > 0 && (
              <div data-ext-group="skill">
                <GroupLabel
                  label="Agent 技能"
                  count={skills.length}
                  disabledCount={skills.filter(s => !s.enabled).length}
                  distributableCount={skills.filter(s => s.distributable !== false).length}
                  distributableDisabledCount={
                    skills.filter(s => s.distributable !== false && !s.enabled).length
                  }
                  kind="skill"
                  onToggleKindEnabled={onToggleKindEnabled}
                />
                {skills.map(renderRow)}
              </div>
            )}
            {mcps.length > 0 && (
              <div data-ext-group="mcp">
                <GroupLabel
                  label="MCP 服务"
                  count={mcps.length}
                  disabledCount={mcps.filter(s => !s.enabled).length}
                  distributableCount={mcps.filter(s => s.distributable !== false).length}
                  distributableDisabledCount={
                    mcps.filter(s => s.distributable !== false && !s.enabled).length
                  }
                  kind="mcp"
                  onToggleKindEnabled={onToggleKindEnabled}
                />
                {mcps.map(renderRow)}
              </div>
            )}
          </>
        )}
      </div>

      {/* 页脚：标题行只留精简摘要，明细（合并 / 敏感 / 开关）收进右侧 ⓘ 浮层。
          摘要仍在，统计不会「整行消失」。 */}
      {total > 0 && (
        <div
          className="flex shrink-0 items-center gap-1 px-4 py-2 text-caption"
          style={{ color: 'var(--td-text-color-placeholder)', borderTop: '1px solid var(--tc-divider)' }}
          data-ext-footer
        >
          <span className="min-w-0 flex-1 truncate" data-ext-footer-summary>
            {stats ? `${stats.skillCount} 个技能 · ${stats.mcpCount} 个 MCP` : `${total} 条`}
          </span>
          {stats && <InfoHint label="扩展统计说明" title="扩展统计" items={statHintItems} />}
        </div>
      )}
    </div>
  );
}

/**
 * 分组标题 + kind 级整批开关。
 *
 * 开关的三态：
 * - 全部启用 → 正常色
 * - 部分停用 → 绿色描边 + 半填充（mixed）+ `disabledCount/N` 徽章
 * - 全部停用 → 占位色
 *
 * **三态只按「可分发」的那几条算**：批量操作会跳过零目标条目，
 * 拿全组算会让组头显示 mixed（还有几条没开），可点下去却什么都变不了。
 * `· 关 N` 徽章仍报全组真实关闭数，不隐藏任何一条的状态。
 *
 * 点击开关 = 反向：可分发条目全部启用时关掉；否则全部打开（零目标自动跳过并提示）。
 */
function GroupLabel({
  label,
  count,
  disabledCount,
  distributableCount,
  distributableDisabledCount,
  kind,
  onToggleKindEnabled,
}: {
  label: string;
  count: number;
  /** 全组已关闭条数（含零目标条目，只用于徽章） */
  disabledCount: number;
  /** 这一组里还有分发目标的条目数；整组为 0 时组头开关置灰（不是 mixed） */
  distributableCount: number;
  /** 可分发条目里已关闭的条数 —— 组头三态只看它 */
  distributableDisabledCount: number;
  kind: ExtensionKind;
  onToggleKindEnabled: (kind: ExtensionKind, enabled: boolean) => void;
}) {
  const allEnabled = distributableDisabledCount === 0;
  const someDisabled = disabledCount > 0 && disabledCount < count;
  const allDisabled = distributableDisabledCount === distributableCount;
  /* 整组都没有可接收的 Agent：一键开关同样没有对象，置灰而不是半填充 ——
     半填充读作「部分启用」，会让人以为点点就能生效。 */
  const noneDistributable = distributableCount === 0;
  return (
    <div className="flex items-baseline justify-between gap-2 px-2.5 pb-1 pt-3">
      <div className="flex items-baseline gap-1.5">
        <span className="text-caption font-semibold" style={{ color: 'var(--td-text-color-secondary)' }}>
          {label}
        </span>
        <span className="text-caption tabular-nums" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {count}
        </span>
        {someDisabled && (
          <span
            className="text-caption tabular-nums"
            style={{ color: 'var(--td-text-color-secondary)' }}
            title={`${disabledCount} 条已关闭，不参与分发或注入`}
            data-ext-group-disabled
          >
            · 关 {disabledCount}
          </span>
        )}
      </div>
      {/* 部分启用 = mixed：绿色描边 + 图标半填充，不新增第三种颜色。
          整组无可分发目标 ⇒ 关闭态 + disabled（灰描边），不给 mixed。 */}
      <ExtensionSwitch
        checked={noneDistributable ? false : allEnabled ? true : allDisabled ? false : 'mixed'}
        onClick={() => onToggleKindEnabled(kind, !allEnabled)}
        label={
          noneDistributable
            ? `${label}整组无可分发目标，开关不可用`
            : allEnabled
              ? `关闭全部${label}`
              : `启用全部${label}`
        }
        title={
          noneDistributable
            ? `整组都没有能接收的 Agent（目标目录不存在或没有挂载通道），一键开关暂不可用`
            : allEnabled
              ? `一键关闭全部${label}（共 ${distributableCount} 条可分发，零目标的跳过）`
              : `一键启用全部${label}（共 ${distributableCount} 条可分发，零目标的跳过）`
        }
        disabled={noneDistributable}
        size={13}
        dataAttrs={{ 'data-ext-group-toggle': '', 'data-enabled': allEnabled ? '1' : '0' }}
      />
    </div>
  );
}
