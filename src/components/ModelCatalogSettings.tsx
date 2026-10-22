import { useCallback, useEffect, useState } from 'react';
import { Button, MessagePlugin } from 'tdesign-react';
import { RefreshCw } from 'lucide-react';

/**
 * 「模型清单」设置分区。
 *
 * ## 为什么需要这个入口
 *
 * 模型菜单不是一张内置表 —— 它是运行时从各 Agent 自己的 CLI/SDK 枚举出来的，
 * 结果在内存 + `data/model-catalog.json` 里缓存 **24 小时**。
 * 官方上新模型后，最坏情况下用户要等一天才能看见，而界面上**没有任何地方**
 * 能说明这件事、也没有任何办法催它一下。
 *
 * 这一屏补两件事：
 *   1. **可见** —— 每个 Agent 枚举到几条、上次是什么时候枚举的、数据从哪来；
 *   2. **可催** —— 一个「刷新」按钮，作废两套缓存后重新枚举。
 *
 * ## 交互取舍
 *
 * - **打开不触发枚举**：`GET /api/model-catalog` 只读内存状态。设置页一打开
 *   就跑一遍 `qodercli`（7.5s）会让人以为界面卡死。真枚举只在点按钮时发生。
 * - **必须给 loading**：刷新要跑三个 CLI + 建一次 SDK 会话，实测 10~15s。
 *   没有 loading 的话用户会连点，或者以为按钮坏了。
 * - **如实显示「未加载」**：WorkBuddy 走 SDK，没取过就是「—」，
 *   不写成「0 个模型」——那会被读成「这个 Agent 没有模型」。
 */

interface CatalogSummary {
  /** 这轮枚举完成的时间戳（0 = 还没枚举过） */
  fetchedAt: number;
  /** agentId → 枚举到几条 */
  counts: Record<string, number>;
  /** WorkBuddy 的 SDK 清单条数（0 表示还没取过，不是「没有模型」） */
  workbuddyCount?: number;
  /** 仅刷新接口返回：WorkBuddy 重取的结果 */
  workbuddy?: { count: number; error?: string };
  /** 仅刷新接口返回：本次耗时 */
  tookMs?: number;
}

/** 固定顺序 + 数据来源。来源写出来，是因为「清单从哪来」正是这一屏要回答的 */
const CATALOG_AGENTS = [
  { id: 'opencode', label: 'OpenCode', source: 'opencode models' },
  { id: 'qoder', label: 'Qoder', source: 'qodercli --list-models' },
  { id: 'codex', label: 'Codex', source: 'codex debug models' },
];

const LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  qoder: 'Qoder',
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
};

function labelOf(id: string): string {
  return LABELS[id] ?? id;
}

/** 相对时间：只说到「分钟/小时/天」，不显示精确时刻（那需要时区与格式化的取舍） */
function relTime(ts: number): string {
  if (!ts) return '尚未枚举';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

interface ModelCatalogSettingsProps {
  /** 刷新成功后通知父级重取模型列表（否则模型菜单还是旧的） */
  onRefreshed?: () => void;
}

export function ModelCatalogSettings({ onRefreshed }: ModelCatalogSettingsProps) {
  const [data, setData] = useState<CatalogSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/model-catalog');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as CatalogSummary);
      setError(null);
    } catch (err) {
      setError((err as Error).message || '读取模型清单失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/model-catalog/refresh', { method: 'POST' });
      const json = (await res.json()) as CatalogSummary & { error?: string };
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setData(json);
      setError(null);

      const parts = Object.entries(json.counts ?? {}).map(
        ([id, n]) => `${labelOf(id)} ${n}`
      );
      if (json.workbuddy && !json.workbuddy.error) {
        parts.push(`WorkBuddy ${json.workbuddy.count}`);
      }
      MessagePlugin.success(
        parts.length ? `模型清单已刷新：${parts.join(' · ')}` : '模型清单已刷新'
      );
      onRefreshed?.();
    } catch (err) {
      MessagePlugin.error((err as Error).message || '刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  const rows = CATALOG_AGENTS.map(a => ({
    ...a,
    count: data?.counts?.[a.id],
  }));

  /**
   * WorkBuddy 的条数有两种来源，字段名不一样：
   *   - `GET  /api/model-catalog`         → `workbuddyCount`（只报缓存里已有的）
   *   - `POST /api/model-catalog/refresh` → `workbuddy: { count }`（真的重取了）
   * 只认前一个的话，点完刷新这一行会从「30 个」变成「—」，看起来像刷新把数据弄丢了。
   */
  const workbuddyCount = data?.workbuddy
    ? data.workbuddy.error
      ? undefined
      : data.workbuddy.count
    : data?.workbuddyCount;

  return (
    <div className="space-y-3" data-model-catalog>
      <p className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
        清单由各 Agent 自己的命令行 / SDK 实时枚举，官方上新后会跟着变；
        结果缓存 24 小时，过期自动重取。想立刻看到最新清单就点「刷新」。
      </p>

      {loading ? (
        <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          正在读取模型清单…
        </div>
      ) : error ? (
        <div className="text-xs" style={{ color: 'var(--td-error-color)' }}>
          读取失败：{error}
        </div>
      ) : (
        <div
          className="overflow-hidden rounded-lg"
          style={{
            backgroundColor: 'var(--tc-surface-raised)',
            border: '1px solid var(--td-component-stroke)',
          }}
        >
          {rows.map((row, i) => (
            <div
              key={row.id}
              className="flex items-center gap-3 px-3 py-2.5"
              style={i > 0 ? { borderTop: '1px solid var(--td-component-stroke)' } : undefined}
              data-catalog-row={row.id}
            >
              <span
                className="w-24 shrink-0 truncate text-sm"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                {row.label}
              </span>
              <code
                className="min-w-0 flex-1 truncate text-xs"
                style={{
                  color: 'var(--td-text-color-placeholder)',
                  fontFamily: 'var(--td-font-family-mono, ui-monospace, monospace)',
                }}
              >
                {row.source}
              </code>
              <span
                className="shrink-0 text-sm tabular-nums"
                style={{ color: 'var(--td-text-color-secondary)' }}
                data-catalog-count={row.id}
              >
                {typeof row.count === 'number' ? `${row.count} 个` : '—'}
              </span>
            </div>
          ))}

          {/* WorkBuddy 单独一行：它不走 CLI 枚举，走 SDK */}
          <div
            className="flex items-center gap-3 px-3 py-2.5"
            style={{ borderTop: '1px solid var(--td-component-stroke)' }}
            data-catalog-row="workbuddy"
          >
            <span
              className="w-24 shrink-0 truncate text-sm"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              WorkBuddy
            </span>
            <code
              className="min-w-0 flex-1 truncate text-xs"
              style={{
                color: 'var(--td-text-color-placeholder)',
                fontFamily: 'var(--td-font-family-mono, ui-monospace, monospace)',
              }}
            >
              SDK getAvailableModelsRaw()
            </code>
            <span
              className="shrink-0 text-sm tabular-nums"
              style={{ color: 'var(--td-text-color-secondary)' }}
              data-catalog-count="workbuddy"
            >
              {workbuddyCount ? `${workbuddyCount} 个` : '—'}
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          size="small"
          variant="outline"
          loading={refreshing}
          onClick={() => void refresh()}
          data-model-catalog-refresh
        >
          <span className="flex items-center gap-1.5">
            {!refreshing && <RefreshCw size={13} />}
            刷新模型清单
          </span>
        </Button>
        <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          上次枚举：{relTime(data?.fetchedAt ?? 0)}
        </span>
      </div>
    </div>
  );
}
