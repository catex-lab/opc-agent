import { useMemo, useState } from 'react';
import { Boxes, Download, RefreshCw, Search, Sparkles, Plug, ShieldAlert, Pencil } from 'lucide-react';
import type { ExtensionKind, ExtensionListItem, ExtensionStats } from '../types';

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
  compact = false,
}: ExtensionPanelProps) {
  const [keyword, setKeyword] = useState('');

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

  const renderRow = (it: ExtensionListItem) => {
    const active = selected?.kind === it.kind && selected.name === it.name;
    const Icon = it.kind === 'skill' ? Sparkles : Plug;
    return (
      <button
        key={`${it.kind}:${it.name}`}
        type="button"
        onClick={() => onSelect(it.kind, it.name)}
        aria-current={active ? 'page' : undefined}
        className="mb-0.5 flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
        /* A75 的同一条教训：未选中项不能写内联 transparent 底色，否则
           Tailwind 的 hover:bg 被内联样式压死，整栏只有当前项会变色。 */
        style={active ? { backgroundColor: 'var(--tc-fill-selected)' } : undefined}
        data-ext-row={`${it.kind}:${it.name}`}
      >
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor: active ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-component)',
            color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
          }}
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className="truncate text-body"
              style={{ color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-primary)' }}
            >
              {it.title || it.name}
            </span>
            {it.locallyModified && (
              <Pencil
                size={11}
                className="shrink-0"
                style={{ color: 'var(--td-brand-color)' }}
                data-ext-badge-local
              />
            )}
            {it.blocked && (
              <ShieldAlert
                size={11}
                className="shrink-0"
                style={{ color: 'var(--tc-status-warn)' }}
                data-ext-badge-blocked
              />
            )}
          </span>
          <span
            className="mt-0.5 block truncate text-caption"
            style={{ color: 'var(--td-text-color-secondary)' }}
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
          onClick={onRefresh}
          title="重新读取列表"
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
          <p className="px-3 py-6 text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
            正在读取扩展…
          </p>
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
                <GroupLabel label="Agent 技能" count={skills.length} />
                {skills.map(renderRow)}
              </div>
            )}
            {mcps.length > 0 && (
              <div data-ext-group="mcp">
                <GroupLabel label="MCP 服务" count={mcps.length} />
                {mcps.map(renderRow)}
              </div>
            )}
          </>
        )}
      </div>

      {/* 页脚：把「一共多少、合并了多少、几条没落正文」一次说清。
          这三个数就是这一栏存在的理由，不该只藏在详情页里。 */}
      {total > 0 && (
        <div
          className="shrink-0 px-4 py-2 text-caption"
          style={{ color: 'var(--td-text-color-placeholder)', borderTop: '1px solid var(--tc-divider)' }}
          data-ext-footer
        >
          {stats
            ? `${stats.skillCount} 个技能 · ${stats.mcpCount} 个 MCP${
                stats.duplicateCount > 0 ? ` · ${stats.duplicateCount} 条已合并多份` : ''
              }${stats.blockedCount > 0 ? ` · ${stats.blockedCount} 条含敏感内容` : ''}`
            : `${total} 条`}
        </div>
      )}
    </div>
  );
}

/**
 * 分组标题。
 *
 * 不用可折叠：两组各自最多几十行，折叠省下的滚动量抵不上「用户以为列表空了」
 * 的风险 —— 折叠状态不持久化，下次进来又展开，反而像抽风。
 */
function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline gap-1.5 px-2.5 pb-1 pt-3">
      <span className="text-caption font-semibold" style={{ color: 'var(--td-text-color-secondary)' }}>
        {label}
      </span>
      <span className="text-caption tabular-nums" style={{ color: 'var(--td-text-color-placeholder)' }}>
        {count}
      </span>
    </div>
  );
}
