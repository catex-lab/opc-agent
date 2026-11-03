import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Sparkles, Plug, Save, RotateCw, Trash2, Copy, ShieldAlert,
  Info, Pencil, FolderOpen, Check, Undo2,
} from 'lucide-react';
import { MessagePlugin } from 'tdesign-react';
import type {
  ExtensionListItem,
  ExtensionMatrixState,
  ExtensionMatrixStateMeta,
  ExtensionMountMode,
  ExtensionSourceRef,
  ExtensionTargetSpec,
  ExtensionTargetState,
} from '../types';
import { EXT_MOUNT_LABEL, EXT_NORMALIZE_RULE_LABEL } from '../types';
import { useExtensionNormalize } from '../hooks/useExtensions';
import { ConfirmDialog } from './ConfirmDialog';
import { InfoHint } from './InfoHint';
import { copyText } from '../clipboard';
import { revealInFolder, hasNativeDialogs } from '../workspace';

interface ExtensionDetailProps {
  item: ExtensionListItem | null;
  targets: ExtensionTargetState[];
  /** 15 个 Agent 的完整名册（含没有技能目录的），矩阵按它排 */
  allTargets: ExtensionTargetSpec[];
  /** 六档状态的顺序/文案/可用性 —— 由服务端下发，UI 不硬编码状态顺序 */
  matrixStates: ExtensionMatrixStateMeta[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  /** 返回列表。只在窄屏单栏模式传 */
  onBack?: () => void;
  /** 保存正文/配置后要刷新列表（来源数、本地修改标记都会变） */
  onSaved: () => void;
  onDeleted: () => void;
  onDelete: (kind: string, name: string) => Promise<boolean>;
}

/** 矩阵里一格的状态。六档，见 `matrixState` 的注释。 */
type MatrixState = ExtensionMatrixState;

/**
 * 把「事实(present) × 能力(mode)」两两组合成矩阵里的一格。
 *
 * 四个组合各自回答一个不同的问题，**不能合并**：
 *
 * | present | mode | 状态 | 用户该读到什么 |
 * |---|---|---|---|
 * | ✅ | 有通道 | `ready` 已就位 | 这份已经在它手里了 |
 * | ✅ | 不支持 | `local-only` 仅本机 | 它自己有，但没法共用给别的 Agent |
 * | ❌ | prompt | `injected` 会注入 | 发消息时把清单与路径注入它的提示词（P3 已通） |
 * | ❌ | flag | `planned` 通道已确认 | 通道在，启动时由 OPC 传参挂上（P5-D 的 `--plugin-dir`） |
 * | ❌ | 不支持 | `unsupported` 不支持 | 这个 Agent 没有这条路 |
 *
 * 第二行是最容易被漏掉的：`codex` 有自己的 `~/.codex/skills`，能从里面**读**
 * 出来，但没有把外部技能送进去的通道 —— 它属于「本机已有、不可共享」，
 * 既不是绿的也不是灰的。把它画成绿的会让人以为「codex 也能共享」。
 *
 * 第三行是 A167 补的：P3 之前 `prompt` 态也只能画成 `planned`（「将来能送」），
 * 现在**真的送了**，再画成「将来」就是撒谎。但有一条例外 ——
 * 正文命中敏感内容（`blocked`）的技能不会被镜像，因此注入不了，
 * 那种情况单独画成 `sealed`，免得用户以为「它应该能用却没用」。
 */
function matrixState(present: boolean, mode: ExtensionMountMode, blocked: boolean): MatrixState {
  if (mode === 'unsupported') return present ? 'local-only' : 'unsupported';
  if (present) return 'ready';
  if (mode === 'prompt') return blocked ? 'sealed' : 'injected';
  return 'planned';
}

/**
 * 状态点 / 状态徽标的颜色。
 *
 * `tone` 由服务端 `MATRIX_STATES` 给出，这里只负责把语义档落到 CSS 令牌 ——
 * 文案、顺序、可用性都在数据层，前端不复制一份。
 */
const TONE_COLOR: Record<ExtensionMatrixStateMeta['tone'], string> = {
  ok: 'var(--tc-status-ok)',
  warn: 'var(--tc-status-warn)',
  brand: 'var(--td-brand-color)',
  muted: 'var(--td-text-color-placeholder)',
};

/** 挂载能力的视图筛选。只影响分组里的行，不改变顶部摘要（摘要说的是全量事实）。 */
type MatrixFilter = 'all' | 'available' | 'unavailable';

const MATRIX_FILTER_LABEL: Record<MatrixFilter, string> = {
  all: '全部',
  available: '可用',
  unavailable: '不可用',
};

/**
 * 扩展详情（A164）。
 *
 * ## 这一页最重要的一句话
 *
 * 「**这是 OPC 的副本，改它不会影响源文件**」—— 印在编辑器正上方，永久可见，
 * 不可关闭。用户看到「编辑技能正文」的第一反应必然是「我是不是在改我
 * `~/.claude/skills/xxx/SKILL.md`」，而答案是**不是**。不把这句话钉在眼前，
 * 他要么不敢改，要么改完以为源文件也变了。
 *
 * ## 为什么不显示「同步」按钮
 *
 * 反向同步（OPC → 用户目录）是用户明确禁止的方向（PLAN-EXTENSIONS.md §2.1）。
 * 放一个禁用状态的「同步」按钮等于承诺一个永远不会做的功能，比不放更糟。
 */
export function ExtensionDetail({
  item,
  targets,
  allTargets,
  matrixStates,
  loading,
  error,
  onReload,
  onBack,
  onSaved,
  onDeleted,
  onDelete,
}: ExtensionDetailProps) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /* 分组折叠：默认只收起「不支持」。折叠时组头仍在（计数 + 灰点），
     行留在 DOM 里（`hidden`）—— 既有验证锚点不因折叠而消失。 */
  const [collapsed, setCollapsed] = useState<Set<MatrixState>>(
    () => new Set<MatrixState>(['unsupported'])
  );
  const [matrixFilter, setMatrixFilter] = useState<MatrixFilter>('all');

  /* 换条目时回到默认视图：展开前四组、只折叠「不支持」、筛选回「全部」。 */
  useEffect(() => {
    setCollapsed(new Set<MatrixState>(['unsupported']));
    setMatrixFilter('all');
  }, [item?.id]);

  const kind = item?.kind ?? null;
  const name = item?.name ?? null;

  /* 归一化（A166 / P1）。**预览是纯读**，只有点「接受」才写库 ——
     PLAN §8.3 的硬要求：归一化不自动应用，必须给人看 diff。 */
  const norm = useExtensionNormalize(kind, name);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  /* 预览换了就默认全选。用 `preview` 整体当依赖而不是 hits.length：
     换条目时可能两条命中数一样，按长度判会留下上一条的勾选状态。 */
  useEffect(() => {
    const hits = norm.preview?.hits ?? [];
    setPicked(new Set(hits.map((_, i) => i)));
  }, [norm.preview]);

  /**
   * 正文/配置的初始值。
   *
   * 依赖 `revision` 而不是 `body`：`revision` 是「本地改过几次」的计数，
   * 保存成功后会 +1，用它当依赖才能在保存后把草稿重新对齐到服务端那份。
   * 只用 `body` 当依赖的话，「保存了但内容没变」不会触发重置 —— 无害；
   * 但「接受了源的覆盖」这种内容变了、草稿却没跟上的情况就会留脏。
   */
  const serverText = item?.kind === 'mcp' ? item.configJson ?? '' : item?.body ?? '';
  const revision = item?.revision ?? 0;
  useEffect(() => {
    setDraft(serverText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, revision]);

  const dirty = draft !== serverText;

  /** 矩阵按「15 个 Agent 的完整名册」排，不是按已有的 target 行 —— 
      没写过 target 的 Agent 也要出现，否则「矩阵」会静默漏掉几个。 */
  const matrix = useMemo(() => {
    const byAgent = new Map(targets.map(t => [t.agentId, t]));
    const blocked = item?.blocked ?? false;
    return allTargets.map(spec => {
      const row = byAgent.get(spec.agentId);
      const present = row?.present ?? false;
      const mode = row?.mode ?? spec.mode;
      return { spec, row, present, mode, state: matrixState(present, mode, blocked) };
    });
  }, [targets, allTargets, item?.blocked]);

  /* ── 摘要 / 分布 / 分组，全部从同一份 matrix + 数据层 meta 算 ───────── */

  /** 状态 meta：按 state 建索引，同时保留 rank 以便排序 */
  const stateMeta = useMemo(() => {
    const byState = new Map<MatrixState, ExtensionMatrixStateMeta>();
    for (const meta of matrixStates) byState.set(meta.state, meta);
    return byState;
  }, [matrixStates]);

  /** 按 rank 排好的状态表（UI 只认 rank，不认自己的顺序） */
  const orderedStates = useMemo(
    () => [...matrixStates].sort((a, b) => a.rank - b.rank),
    [matrixStates]
  );

  /** 每档多少格 —— 摘要、分布、组头计数都从这里取 */
  const stateCounts = useMemo(() => {
    const counts = new Map<MatrixState, number>();
    for (const row of matrix) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
    return counts;
  }, [matrix]);

  const availableCount = useMemo(
    () => matrix.filter(row => stateMeta.get(row.state)?.available).length,
    [matrix, stateMeta]
  );
  const unavailableCount = matrix.length - availableCount;

  /**
   * 分组：先按筛选过滤，再按状态 rank 分组，组内按 Agent 名排序。
   * 组头的计数用**筛选后**的行数 —— 筛选是一个视图，组头说的应是眼前这几行。
   */
  const groups = useMemo(() => {
    const visible = matrix.filter(row => {
      if (matrixFilter === 'all') return true;
      const available = stateMeta.get(row.state)?.available ?? false;
      return matrixFilter === 'available' ? available : !available;
    });
    return orderedStates
      .map(meta => ({
        meta,
        rows: visible
          .filter(row => row.state === meta.state)
          .sort((a, b) => a.spec.label.localeCompare(b.spec.label, 'zh-Hans-CN')),
      }))
      .filter(group => group.rows.length > 0);
  }, [matrix, matrixFilter, orderedStates, stateMeta]);

  /* 接受归一化：只提交用户勾中的那几条（下标数组）。
     空选择直接不提交 —— 后端对空数组返回 400，前端先挡住，
     否则用户会收到一条「没有选中任何一条」的报错弹窗，像是操作失败。 */
  const applyNormalize = async () => {
    const accepted = [...picked].sort((a, b) => a - b);
    if (accepted.length === 0) {
      MessagePlugin.warning('先勾选要替换的条目');
      return;
    }
    const ok = await norm.apply(accepted);
    if (ok) {
      MessagePlugin.success(`已替换 ${accepted.length} 处`);
      onReload();
      onSaved();
    } else {
      MessagePlugin.warning(norm.error || '应用归一化失败');
    }
  };

  const revertNormalize = async () => {
    const ok = await norm.revert();
    if (ok) {
      MessagePlugin.success('已回滚到归一化前的原文');
      onReload();
      onSaved();
    } else {
      MessagePlugin.warning(norm.error || '回滚失败');
    }
  };

  const togglePick = (i: number) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const save = async () => {
    if (!item) return;
    setSaving(true);
    try {
      const payload: Record<string, string> = item.kind === 'mcp'
        ? { configJson: draft }
        : { body: draft };
      const res = await fetch(
        `/api/extensions/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.name)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      MessagePlugin.success('已保存到 OPC 的副本');
      onReload();
      onSaved();
    } catch (e) {
      MessagePlugin.warning((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const refreshFromSource = async () => {
    if (!item) return;
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/extensions/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.name)}/refresh`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      const outcome = (data as { outcome?: string }).outcome;
      if (outcome === 'conflict') {
        MessagePlugin.warning('源已更新，但你在本地改过 —— 没有覆盖，请用「用源的覆盖」确认');
      } else if (outcome === 'unchanged') {
        MessagePlugin.info('源没有变化');
      } else if (outcome === 'missing') {
        MessagePlugin.warning((data as { reason?: string }).reason || '找不到源文件了');
      } else {
        MessagePlugin.success(outcome === 'updated' ? '已按源更新' : '已同步');
      }
      onReload();
      onSaved();
    } catch (e) {
      MessagePlugin.warning((e as Error).message || '刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  const acceptSource = async () => {
    if (!item) return;
    try {
      const res = await fetch(
        `/api/extensions/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.name)}/accept-source`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      MessagePlugin.success('已用源的内容覆盖本地副本');
      onReload();
      onSaved();
    } catch (e) {
      MessagePlugin.warning((e as Error).message || '操作失败');
    }
  };

  /* ── 空态 ─────────────────────────────────────────────────────────── */

  if (loading && !item) {
    return (
      <Shell>
        <p className="text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
          正在读取…
        </p>
      </Shell>
    );
  }

  if (error && !item) {
    return (
      <Shell>
        <p className="text-body" style={{ color: 'var(--td-error-color)' }}>{error}</p>
      </Shell>
    );
  }

  if (!item) {
    return (
      <Shell dataAttr="data-ext-detail-empty">
        <p className="text-body-lg" style={{ color: 'var(--td-text-color-secondary)' }}>
          选一个扩展
        </p>
        <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          左侧点一条，这里会显示它的来源、能力矩阵与正文
        </p>
      </Shell>
    );
  }

  const Icon = item.kind === 'skill' ? Sparkles : Plug;
  const kindLabel = item.kind === 'skill' ? 'Agent 技能' : 'MCP 服务';
  const isMcp = item.kind === 'mcp';

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--tc-surface-content)',
        borderRadius: 'var(--tc-column-radius)',
      }}
      data-ext-detail={`${item.kind}:${item.name}`}
    >
      {/* 头部：与列表栏同高（dense 60px），两块底边线连成一条 */}
      <header
        className="flex shrink-0 items-center gap-3 px-5"
        style={{
          minHeight: 'var(--panel-header-height-dense)',
          borderBottom: '1px solid var(--tc-divider)',
        }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title="返回扩展列表"
            aria-label="返回扩展列表"
            className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-ext-back
          >
            <ChevronLeft size={18} />
          </button>
        )}
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' }}
        >
          <Icon size={16} />
        </span>

        <div className="flex min-w-0 flex-1 flex-col">
          <h1
            className="truncate text-title-lg font-semibold"
            style={{ color: 'var(--td-text-color-primary)' }}
            title={item.name}
            data-ext-title
          >
            {item.title || item.name}
          </h1>
          <p
            className="truncate text-caption"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-ext-subtitle
          >
            {kindLabel}
            {item.sourceCount > 0 ? ` · ${item.sourceCount} 个来源` : ''}
            {item.locallyModified ? ' · 本地改过' : ''}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void refreshFromSource()}
            disabled={refreshing}
            title="重新读一遍源文件，按判定表决定是否更新"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-body transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-60"
            style={{ color: 'var(--td-text-color-secondary)', border: '1px solid var(--tc-edge-strong)' }}
            data-ext-refresh-source
          >
            <RotateCw size={14} className={refreshing ? 'animate-spin' : undefined} />
            重新导入
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-ext-detail-body>
        {/* 状态条：只在「有话说」时出现。三条互斥的话 ——
            敏感内容拦截 / 本地改过 / 冲突。 */}
        {item.blocked && (
          <Banner
            tone="warn"
            icon={<ShieldAlert size={14} />}
            attr="data-ext-blocked-banner"
            title="正文含敏感内容，没有落库"
            text={item.blockedReason ?? '扫描到疑似密钥或本机用户路径，已阻止把正文存进 OPC。'}
          />
        )}
        {item.locallyModified && (
          <Banner
            tone="brand"
            icon={<Pencil size={14} />}
            attr="data-ext-local-banner"
            title="这份副本你改过"
            text="源文件更新时不会自动覆盖你的修改。要用源的内容盖掉本地版本，点下面「用源的覆盖」。"
            action={
              <button
                type="button"
                onClick={() => void acceptSource()}
                className="shrink-0 rounded-md px-2 py-1 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                style={{ color: 'var(--td-brand-color)', border: '1px solid var(--tc-edge-strong)' }}
                data-ext-accept-source
              >
                用源的覆盖
              </button>
            }
          />
        )}

        {/* ── 能力矩阵（仅技能）────────────────────────────────────────
            MCP 不画：`TARGETS` 里的 mode 描述的是技能通道，照抄到 MCP 上
            就是编数据。见 server/extensions/import.ts 的 rebuildTargets。 */}
        {!isMcp && (
          <Section
            title="挂载能力"
            subtitle={
              matrix.length > 0
                ? `${availableCount} 可用 · ${unavailableCount} 不可用`
                : undefined
            }
            subtitleAttr="data-ext-matrix-summary"
            attr="data-ext-matrix"
            action={
              /* 原来占三行的图例收进这一枚 ⓘ：悬停/点击展开，键盘可聚焦。
                 文案全部来自服务端 MATRIX_STATES，与分组/摘要同一事实源。 */
              <InfoHint
                label="挂载能力说明"
                title="六档状态"
                items={orderedStates.map(meta => ({ term: meta.label, definition: meta.hint }))}
                note="六档口径见 PLAN-EXTENSIONS.md §9。"
              />
            }
          >
            {/* 状态分布：与组头、摘要同一份 stateCounts */}
            <div
              className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption"
              data-ext-matrix-dist
            >
              {orderedStates.map(meta => {
                const count = stateCounts.get(meta.state) ?? 0;
                /* 「含敏感内容」只在真有被拦的条目时出现，否则它会把普通的
                   「会注入」挤出视线。其余五档常驻，0 也如实显示。 */
                if (meta.state === 'sealed' && count === 0) return null;
                return (
                  <span
                    key={meta.state}
                    className="flex items-center gap-1"
                    title={meta.hint}
                    data-ext-matrix-dist-state={meta.state}
                    data-count={count}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: TONE_COLOR[meta.tone] }}
                    />
                    <span style={{ color: 'var(--td-text-color-secondary)' }}>{meta.label}</span>
                    <span className="tabular-nums" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      {count}
                    </span>
                  </span>
                );
              })}
            </div>

            {/* 筛选 chip：只过滤分组里的行；摘要仍说全量事实 */}
            <div className="mb-1 flex items-center gap-1.5" data-ext-matrix-filter-bar>
              {(['all', 'available', 'unavailable'] as const).map(key => {
                const active = matrixFilter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMatrixFilter(key)}
                    className="rounded-full px-2.5 py-1 text-caption transition-colors"
                    style={{
                      color: active ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
                      backgroundColor: active ? 'var(--tc-fill-selected)' : 'var(--td-bg-color-component)',
                      border: '1px solid var(--tc-edge)',
                    }}
                    data-ext-matrix-filter={key}
                  >
                    {MATRIX_FILTER_LABEL[key]}
                  </button>
                );
              })}
            </div>

            {/* 分组：顺序 = 数据层 rank；组内按 Agent 名；两列按列优先读。
                xl 起才分两条 lane —— 1024 一带内容宽度放不下两条 lane 的
                固定通道/状态列，此时降为单列（不压窄列宽）。 */}
            <div className="flex flex-col gap-2" data-ext-matrix-groups>
              {groups.map(({ meta, rows }) => {
                const isCollapsed = collapsed.has(meta.state);
                const color = TONE_COLOR[meta.tone];
                const half = Math.ceil(rows.length / 2);
                const columns = [rows.slice(0, half), rows.slice(half)];
                return (
                  <div key={meta.state} data-ext-matrix-group={meta.state}>
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed(prev => {
                          const next = new Set(prev);
                          if (next.has(meta.state)) next.delete(meta.state);
                          else next.add(meta.state);
                          return next;
                        })
                      }
                      title={meta.hint}
                      className="ext-matrix-head w-full rounded-lg text-left transition-colors hover:bg-[var(--tc-hover-chrome)]"
                      data-ext-matrix-group-toggle
                    >
                      <ChevronRight
                        size={12}
                        className={isCollapsed ? undefined : 'rotate-90'}
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      />
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        /* 折叠时统一变灰点 —— 表示这一组还在，只是被收起了 */
                        style={{
                          backgroundColor: isCollapsed
                            ? 'var(--td-text-color-placeholder)'
                            : color,
                        }}
                      />
                      <span
                        className="text-caption font-semibold"
                        style={{ color: 'var(--td-text-color-primary)' }}
                      >
                        {meta.label}
                      </span>
                      <span
                        className="text-caption tabular-nums"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                        data-ext-matrix-group-count
                      >
                        {rows.length}
                      </span>
                    </button>

                    {/* 行留在 DOM 里（折叠时 hidden），既有 data-ext-matrix-row 锚点
                        不会因为默认折叠而消失。 */}
                    <div
                      className={
                        isCollapsed
                          ? 'hidden'
                          : 'grid grid-cols-1 gap-x-6 xl:grid-cols-2'
                      }
                      data-ext-matrix-rows
                    >
                      {columns.map((column, index) => (
                        <div
                          key={index}
                          className="flex min-w-0 flex-col"
                          data-ext-matrix-lane={index}
                        >
                          {column.map(({ spec, present, mode, state }) => {
                            const rowMeta = stateMeta.get(state);
                            const rowColor = rowMeta
                              ? TONE_COLOR[rowMeta.tone]
                              : 'var(--td-text-color-placeholder)';
                            /* 实心点 = 这一份确实已经在该 Agent 手里（自己目录里有，
                               或被注入）。`sealed` / `planned` / `unsupported` 用空心。 */
                            const filled =
                              state === 'ready' || state === 'local-only' || state === 'injected';
                            return (
                              <div
                                key={spec.agentId}
                                className="ext-matrix-row"
                                title={`${rowMeta?.hint ?? ''}${spec.note ? `（${spec.note}）` : ''}`}
                                data-ext-matrix-row={spec.agentId}
                                data-ext-matrix-state={state}
                              >
                                {/* 第 1 列：Agent 名。吃掉剩余宽度，超长省略 */}
                                <span
                                  className="min-w-0 truncate text-body"
                                  style={{ color: 'var(--td-text-color-primary)' }}
                                  data-ext-matrix-agent
                                >
                                  {spec.label}
                                </span>
                                {/* 第 2 列：通道说明。固定 80px，中性灰，不参与状态配色 */}
                                <span
                                  className="ext-matrix-channel text-caption"
                                  style={{ color: 'var(--td-text-color-placeholder)' }}
                                  data-ext-matrix-channel
                                >
                                  {EXT_MOUNT_LABEL[mode]}
                                </span>
                                {/* 第 3 列：状态。固定 120px、左对齐同一起点 ——
                                    状态点 + 文案 + 可选的事实 ✓ 都在这一列内，
                                    ✓ 不再把状态文案往左推。 */}
                                <span
                                  className="ext-matrix-status text-caption"
                                  style={{ color: rowColor }}
                                  data-ext-matrix-status
                                >
                                  <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{
                                      backgroundColor: rowColor,
                                      boxShadow: filled ? undefined : `inset 0 0 0 1.5px ${rowColor}`,
                                      ...(filled ? {} : { backgroundColor: 'transparent' }),
                                    }}
                                  />
                                  <span data-ext-matrix-label>{rowMeta?.label ?? state}</span>
                                  {present && (
                                    <Check
                                      size={12}
                                      className="shrink-0"
                                      style={{ color: 'var(--td-text-color-placeholder)' }}
                                      data-ext-matrix-present
                                    />
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* ── 来源 ───────────────────────────────────────────────────── */}
        <Section
          title="来源"
          subtitle={`从 ${item.sourceCount} 个 Agent 目录里读到同一份${
            item.sourceCount > 1 ? '，已按内容去重为一条' : ''
          }`}
          attr="data-ext-sources"
          action={
            item.sources.length > 0 ? (
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyText(item.sources.map(s => s.path).join('\n'));
                  if (ok) MessagePlugin.success('已复制路径');
                  else MessagePlugin.warning('复制失败');
                }}
                title="复制全部来源路径"
                className="flex h-7 items-center gap-1 rounded-md px-2 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)]"
                style={{ color: 'var(--td-text-color-secondary)' }}
                data-ext-copy-paths
              >
                <Copy size={12} />
                复制路径
              </button>
            ) : undefined
          }
        >
          {item.sources.length === 0 ? (
            <p className="text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
              没有来源记录。这条可能是手工加的，或者来源目录已被删除。
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {item.sources.map(s => (
                <SourceRow key={`${s.agentId}:${s.path}`} source={s} />
              ))}
            </ul>
          )}
        </Section>

        {/* ── 归一化（A166 / P1）──────────────────────────────────────── */}
        {!isMcp && (
          <Section
            title="归一化"
            subtitle="把写死的家目录路径换成占位符，让同一份技能在任何 Agent 的目录下都能用"
            attr="data-ext-normalize"
            action={
              item.bodyOriginal != null ? (
                <button
                  type="button"
                  onClick={() => void revertNormalize()}
                  disabled={norm.applying}
                  className="flex h-7 items-center gap-1 rounded-md px-2.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ color: 'var(--td-text-color-secondary)', border: '1px solid var(--tc-edge-strong)' }}
                  data-ext-revert-normalize
                >
                  <Undo2 size={12} />
                  回滚到原文
                </button>
              ) : norm.preview?.changed ? (
                <button
                  type="button"
                  onClick={() => void applyNormalize()}
                  disabled={picked.size === 0 || norm.applying}
                  className="flex h-7 items-center gap-1 rounded-md px-2.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ color: 'var(--td-brand-color)', border: '1px solid var(--tc-edge-strong)' }}
                  data-ext-apply-normalize
                >
                  <Check size={12} />
                  {norm.applying ? '应用中' : `接受选中的 ${picked.size} 条`}
                </button>
              ) : undefined
            }
          >
            {item.bodyOriginal != null ? (
              <>
                <p className="text-caption leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
                  已归一化。正文里现在是 <code>{'{{SKILL_DIR}}'}</code> /{' '}
                  <code>{'{{SKILLS_ROOT}}'}</code> 这类占位符 ——
                  <strong>分发时会替换成目标 Agent 的实际路径</strong>，替换本身属于 P3。
                  原文已保留，随时可以回滚。
                </p>
                <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  OPC 不会把归一化后的正文写回你任何 Agent 的目录。
                </p>
              </>
            ) : norm.loading ? (
              <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                正在生成预览…
              </p>
            ) : norm.error ? (
              <p className="text-caption" style={{ color: 'var(--td-error-color)' }}>
                {norm.error}
              </p>
            ) : norm.preview?.changed ? (
              <>
                <p className="mb-2 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                  共 {norm.preview.hits.length} 处
                  {(['home-path', 'tool-name'] as const).map(r =>
                    norm.preview!.summary[r] > 0 ? (
                      <span key={r}>
                        {' · '}
                        {EXT_NORMALIZE_RULE_LABEL[r]} {norm.preview!.summary[r]}
                      </span>
                    ) : null
                  )}
                  <span style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {' '}
                    · 勾选后点「接受」，只改勾中的那几条
                  </span>
                </p>
                <ul
                  className="tc-scroll-fade max-h-[240px] overflow-y-auto rounded-lg"
                  style={{ border: '1px solid var(--tc-edge-strong)' }}
                  data-ext-normalize-hits
                >
                  {norm.preview.hits.map((h, i) => (
                    <li
                      key={`${h.start}-${i}`}
                      className="flex items-start gap-2 px-2.5 py-1.5"
                      style={{
                        borderTop: i === 0 ? undefined : '1px solid var(--tc-edge-strong)',
                        backgroundColor: picked.has(i) ? 'var(--td-bg-color-component)' : undefined,
                      }}
                      data-ext-normalize-hit={i}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(i)}
                        onChange={() => togglePick(i)}
                        className="mt-1 shrink-0"
                        aria-label={`第 ${h.line} 行：${h.before}`}
                        data-ext-normalize-pick
                      />
                      <span
                        className="shrink-0 font-mono text-caption"
                        style={{ color: 'var(--td-text-color-placeholder)', width: 38 }}
                      >
                        L{h.line}
                      </span>
                      <span className="min-w-0 flex-1 break-all font-mono text-caption leading-5">
                        <span style={{ color: 'var(--td-error-color)' }}>{h.before}</span>
                        <span style={{ color: 'var(--td-text-color-placeholder)' }}> → </span>
                        <span style={{ color: 'var(--tc-status-ok)' }}>{h.after}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-caption leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
                这条正文里没有写死的家目录路径，也没有明确的工具名引用，不需要归一化。
              </p>
            )}
          </Section>
        )}

        {/* ── 正文 / 配置 ────────────────────────────────────────────── */}
        <Section
          title={isMcp ? '配置' : '正文'}
          subtitle={isMcp ? 'MCP 服务的配置 JSON' : 'SKILL.md 的正文（不含 frontmatter）'}
          attr="data-ext-editor"
          action={
            <div className="flex items-center gap-1.5">
              {dirty && (
                <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  未保存
                </span>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="flex h-7 items-center gap-1 rounded-md px-2.5 text-caption transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: 'var(--td-brand-color)', border: '1px solid var(--tc-edge-strong)' }}
                data-ext-save
              >
                <Save size={12} />
                {saving ? '保存中' : '保存'}
              </button>
            </div>
          }
        >
          {/* 永久提示，不可关闭。理由见文件头。 */}
          <div
            className="mb-2 flex items-start gap-1.5 rounded-lg px-2.5 py-2"
            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
            data-ext-copy-notice
          >
            <Info size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--td-text-color-secondary)' }} />
            <p className="text-caption leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
              这是 OPC 的副本，改它<strong>不会</strong>影响源文件；
              也<strong>不会</strong>被写回你任何 Agent 的目录。
            </p>
          </div>

          {item.blocked && (
            /* 风险告知不藏进 hover：行内保留「敏感」短标记，详情收进 ⓘ。 */
            <div className="mb-2 flex items-center gap-1.5" data-ext-sensitive-note>
              <span
                className="text-caption font-semibold"
                style={{ color: 'var(--tc-status-warn)' }}
              >
                敏感
              </span>
              <span className="text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
                正文未落库
              </span>
              <InfoHint
                label="敏感内容的处理说明"
                items={[
                  {
                    term: '为什么拦',
                    definition: '正文命中疑似密钥或本机用户路径，OPC 不把它存进库。',
                  },
                  {
                    term: '还能用吗',
                    definition: '该 Agent 自己目录里本来有这一份的话仍可用；OPC 不会注入未落库的正文。',
                  },
                  {
                    term: '编辑后保存',
                    definition: '你在这里编辑的是 OPC 侧的新副本，保存前请确认里面没有密钥。',
                  },
                ]}
              />
            </div>
          )}

          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            placeholder={isMcp ? '{\n  "command": "npx",\n  "args": []\n}' : '（这份技能没有正文）'}
            className="min-h-[240px] w-full resize-y rounded-lg px-3 py-2 font-mono text-caption leading-6 outline-none"
            style={{
              color: 'var(--td-text-color-primary)',
              backgroundColor: 'var(--td-bg-color-component)',
              border: '1px solid var(--tc-edge-strong)',
            }}
            data-ext-editor-input
          />
          <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {draft.length} 字符 · 本地第 {revision} 版
            {isMcp ? ' · 保存时会校验 JSON 合法性' : ''}
          </p>
        </Section>

        {/* ── 危险区 ─────────────────────────────────────────────────── */}
        <Section title="移除" attr="data-ext-danger">
          <div className="flex items-center justify-between gap-3">
            <p className="text-caption leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
              只删 OPC 里的这一份副本。你本机各 Agent 目录下的源文件<strong>不会被删</strong>，
              下次点「导入」还会被读回来。
            </p>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-body transition-colors hover:bg-[var(--tc-hover-chrome)]"
              style={{ color: 'var(--td-error-color)', border: '1px solid var(--tc-edge-strong)' }}
              data-ext-delete
            >
              <Trash2 size={14} />
              移除副本
            </button>
          </div>
        </Section>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`移除「${item.title || item.name}」？`}
        danger
        confirmText="移除副本"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          const ok = await onDelete(item.kind, item.name);
          if (ok) {
            MessagePlugin.success('已移除 OPC 的副本，源文件未动');
            onDeleted();
          }
        }}
      >
        <p>只删 OPC 库里的这一条。你本机各 Agent 目录下的源文件不会被删，也不会被改。</p>
        <p className="mt-2">
          当前有 {item.sourceCount} 个来源指向它 —— 下次点「导入」会重新读回来。
        </p>
      </ConfirmDialog>
    </div>
  );
}

/* ── 小零件 ─────────────────────────────────────────────────────────── */

function Shell({ children, dataAttr }: { children: React.ReactNode; dataAttr?: string }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2"
      style={{
        backgroundColor: 'var(--tc-surface-content)',
        borderRadius: 'var(--tc-column-radius)',
      }}
      {...(dataAttr ? { [dataAttr]: '' } : {})}
    >
      {children}
    </div>
  );
}

function Section({
  title,
  subtitle,
  subtitleAttr,
  action,
  children,
  attr,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** 给副标题加锚点，便于验证脚本按名字定位（如 data-ext-matrix-summary） */
  subtitleAttr?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  attr?: string;
}) {
  return (
    <section className="mb-5" {...(attr ? { [attr]: '' } : {})}>
      <div className="mb-2 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="text-body-lg font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
            {title}
          </h2>
          {subtitle && (
            <span
              className="min-w-0 truncate text-caption"
              style={{ color: 'var(--td-text-color-secondary)' }}
              {...(subtitleAttr ? { [subtitleAttr]: '' } : {})}
            >
              {subtitle}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Banner({
  tone,
  icon,
  title,
  text,
  action,
  attr,
}: {
  tone: 'warn' | 'brand';
  icon: React.ReactNode;
  title: string;
  text: string;
  action?: React.ReactNode;
  attr?: string;
}) {
  const color = tone === 'warn' ? 'var(--tc-status-warn)' : 'var(--td-brand-color)';
  return (
    <div
      className="mb-4 flex items-start gap-2 rounded-xl px-3 py-2.5"
      style={{ border: `1px solid ${color}` }}
      {...(attr ? { [attr]: '' } : {})}
    >
      <span className="mt-0.5 shrink-0" style={{ color }}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-body" style={{ color }}>{title}</p>
        <p className="mt-0.5 text-caption leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
          {text}
        </p>
      </div>
      {action}
    </div>
  );
}

/**
 * 一条来源路径。
 *
 * 带「在文件夹中显示」—— 但只在真有原生对话框时才给按钮。浏览器开发态与
 * 验证脚本里没有 `window.opc`，留一颗点了没反应的按钮就是假控件
 * （ProjectPanel 里踩过同一条）。
 */
function SourceRow({ source }: { source: ExtensionSourceRef }) {
  const native = hasNativeDialogs();
  return (
    <li
      className="flex items-center gap-2 rounded-lg px-2 py-1.5"
      style={{ backgroundColor: 'var(--td-bg-color-component)' }}
      data-ext-source-row={source.agentId}
    >
      <span
        className="shrink-0 rounded px-1.5 py-0.5 text-caption"
        style={{
          color: 'var(--td-text-color-secondary)',
          backgroundColor: 'var(--tc-fill-selected)',
        }}
      >
        {source.agentId}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-caption"
        style={{ color: 'var(--td-text-color-secondary)' }}
        title={source.path}
      >
        {source.path}
      </span>
      {native && (
        <button
          type="button"
          onClick={() => revealInFolder(source.path)}
          title="在文件夹中显示"
          aria-label="在文件夹中显示"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
          data-ext-reveal
        >
          <FolderOpen size={12} />
        </button>
      )}
    </li>
  );
}
