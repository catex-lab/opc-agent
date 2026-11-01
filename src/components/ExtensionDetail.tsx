import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, Sparkles, Plug, Save, RotateCw, Trash2, Copy, ShieldAlert,
  Info, Pencil, FolderOpen, Check,
} from 'lucide-react';
import { MessagePlugin } from 'tdesign-react';
import type {
  ExtensionListItem,
  ExtensionMountMode,
  ExtensionSourceRef,
  ExtensionTargetSpec,
  ExtensionTargetState,
} from '../types';
import { EXT_MOUNT_LABEL } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { copyText } from '../clipboard';
import { revealInFolder, hasNativeDialogs } from '../workspace';

interface ExtensionDetailProps {
  item: ExtensionListItem | null;
  targets: ExtensionTargetState[];
  /** 15 个 Agent 的完整名册（含没有技能目录的），矩阵按它排 */
  allTargets: ExtensionTargetSpec[];
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

/** 矩阵里一格的状态。四档，见 `matrixState` 的注释。 */
type MatrixState = 'ready' | 'local-only' | 'planned' | 'unsupported';

/**
 * 把「事实(present) × 能力(mode)」两两组合成矩阵里的一格。
 *
 * 四个组合各自回答一个不同的问题，**不能合并**：
 *
 * | present | mode | 状态 | 用户该读到什么 |
 * |---|---|---|---|
 * | ✅ | 有通道 | `ready` 已就位 | 这份已经在它手里了 |
 * | ✅ | 不支持 | `local-only` 仅本机 | 它自己有，但没法共用给别的 Agent |
 * | ❌ | 有通道 | `planned` 通道已确认 | 将来能送进去（分发在 P2/P3） |
 * | ❌ | 不支持 | `unsupported` 不支持 | 这个 Agent 没有这条路 |
 *
 * 第二行是最容易被漏掉的：`codex` 有自己的 `~/.codex/skills`，能从里面**读**
 * 出来，但没有把外部技能送进去的通道 —— 它属于「本机已有、不可共享」，
 * 既不是绿的也不是灰的。把它画成绿的会让人以为「codex 也能共享」。
 */
function matrixState(present: boolean, mode: ExtensionMountMode): MatrixState {
  if (mode === 'unsupported') return present ? 'local-only' : 'unsupported';
  return present ? 'ready' : 'planned';
}

const MATRIX_META: Record<MatrixState, { label: string; color: string; hint: string }> = {
  ready: {
    label: '已就位',
    color: 'var(--tc-status-ok)',
    hint: '该 Agent 自己的目录里就有这一份',
  },
  'local-only': {
    label: '仅本机',
    color: 'var(--td-text-color-secondary)',
    hint: '该 Agent 自己有，但它没有把外部技能送进来的通道，因此这份无法共享给它',
  },
  planned: {
    label: '通道已确认',
    color: 'var(--td-brand-color)',
    hint: '该 Agent 有接入通道，但「把内容真送进去」属于 P2/P3，本期只做收集与编辑',
  },
  unsupported: {
    label: '不支持',
    color: 'var(--td-text-color-placeholder)',
    hint: '该 Agent 没有接入外部技能的通道',
  },
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

  const kind = item?.kind ?? null;
  const name = item?.name ?? null;

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
    return allTargets.map(spec => {
      const row = byAgent.get(spec.agentId);
      const present = row?.present ?? false;
      const mode = row?.mode ?? spec.mode;
      return { spec, row, present, mode, state: matrixState(present, mode) };
    });
  }, [targets, allTargets]);

  const readyCount = matrix.filter(m => m.state === 'ready').length;

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
              readyCount > 0
                ? `${readyCount} / ${matrix.length} 个 Agent 已经拿到这一份`
                : '还没有任何 Agent 拿到这一份'
            }
            attr="data-ext-matrix"
          >
            <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              {matrix.map(({ spec, present, mode, state }) => {
                const meta = MATRIX_META[state];
                return (
                  <div
                    key={spec.agentId}
                    className="flex items-center gap-2 py-1.5"
                    title={`${meta.hint}${spec.note ? `（${spec.note}）` : ''}`}
                    data-ext-matrix-row={spec.agentId}
                    data-ext-matrix-state={state}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: meta.color,
                        /* 未达成的那两档用空心点：实心点会被读成「好了」，
                           而 `planned` / `unsupported` 都不是「好了」。 */
                        boxShadow:
                          state === 'ready' || state === 'local-only'
                            ? undefined
                            : `inset 0 0 0 1.5px ${meta.color}`,
                        ...(state === 'ready' || state === 'local-only'
                          ? {}
                          : { backgroundColor: 'transparent' }),
                      }}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-body"
                      style={{ color: 'var(--td-text-color-primary)' }}
                    >
                      {spec.label}
                    </span>
                    <span
                      className="shrink-0 text-caption"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      {EXT_MOUNT_LABEL[mode]}
                    </span>
                    <span
                      className="w-[68px] shrink-0 text-right text-caption"
                      style={{ color: meta.color }}
                      data-ext-matrix-label
                    >
                      {meta.label}
                    </span>
                    {/* 事实标记：该 Agent 目录里真的有这一份。与状态列分开，
                        因为 `local-only` 那一档也要显示它。 */}
                    {present && (
                      <Check
                        size={12}
                        className="shrink-0"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                        data-ext-matrix-present
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-caption leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
              「通道已确认」≠ 现在就能用：把内容真送进各家 Agent 是 P2/P3，
              本期只做收集与编辑。四档口径见 PLAN-EXTENSIONS.md §9。
            </p>
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
            <p className="mb-2 text-caption leading-5" style={{ color: 'var(--tc-status-warn)' }}>
              正文因命中敏感内容而未落库。你在这里编辑的是 OPC 侧的新副本 ——
              保存前请确认里面没有密钥。
            </p>
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
  action,
  children,
  attr,
}: {
  title: string;
  subtitle?: string;
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
            <span className="min-w-0 truncate text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
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
