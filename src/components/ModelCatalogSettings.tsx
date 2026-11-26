import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, MessagePlugin } from 'tdesign-react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useTranslation, type MessageKey, type Translate } from '../i18n';
import { api } from '../api';
import { httpErrorText } from '../lib/http-error';

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
 * 这一屏补三件事：
 *   1. **可见** —— 每个 Agent 枚举到几条、上次是什么时候枚举的；
 *   2. **可看** —— 行可展开：所有 Agent 都显示与聊天菜单同源的模型名
 *      （WorkBuddy 走 /api/models，其余走 /api/agents/:id/models，只读），
 *      枚举来源折在展开区，不占主表列；
 *   3. **可催** —— 一个「刷新」按钮，作废两套缓存后重新枚举。
 *
 * ## 交互取舍
 *
 * - **打开不触发枚举**：`GET /api/model-catalog` 只读内存状态。设置页一打开
 *   就跑一遍 `qodercli`（7.5s）会让人以为界面卡死。真枚举只在点按钮时发生。
 * - **必须给 loading**：刷新要跑三个 CLI + 建一次 SDK 会话，实测 10~15s。
 *   没有 loading 的话用户会连点，或者以为按钮坏了。
 * - **如实显示「尚未枚举」**：WorkBuddy 走 SDK，没取过就是「尚未枚举」，
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

/** 固定顺序。来源原文（命令行 / SDK 方法名）不占主表列 —— 收进展开区的
 * 悬停 title，界面只显示人话（sourceKey）。 */
const CATALOG_AGENTS: Array<{
  id: string;
  label: string;
  source: string;
  sourceKey: MessageKey;
}> = [
  { id: 'opencode', label: 'OpenCode', source: 'opencode models', sourceKey: 'settings.models.sourceCli' },
  { id: 'qoder', label: 'Qoder', source: 'qodercli --list-models', sourceKey: 'settings.models.sourceCli' },
  { id: 'qoder-cn', label: 'Qoder CN', source: 'qoderclicn --list-models', sourceKey: 'settings.models.sourceCli' },
  { id: 'codex', label: 'Codex', source: 'codex debug models', sourceKey: 'settings.models.sourceCli' },
  { id: 'cursor', label: 'Cursor', source: 'cursor-agent models', sourceKey: 'settings.models.sourceCli' },
  { id: 'pi', label: 'Pi', source: 'pi --list-models', sourceKey: 'settings.models.sourceCli' },
];

const LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  qoder: 'Qoder',
  'qoder-cn': 'Qoder CN',
  codex: 'Codex',
  cursor: 'Cursor',
  pi: 'Pi',
  workbuddy: 'WorkBuddy',
};

function labelOf(id: string): string {
  return LABELS[id] ?? id;
}

/** 相对时间：只说到「分钟/小时/天」，不显示精确时刻（那需要时区与格式化的取舍） */
function relTime(ts: number, t: Translate): string {
  if (!ts) return t('settings.models.never');
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('settings.models.justNow');
  if (diff < 3_600_000) return t('settings.models.minAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('settings.models.hourAgo', { n: Math.floor(diff / 3_600_000) });
  return t('settings.models.dayAgo', { n: Math.floor(diff / 86_400_000) });
}

interface ModelCatalogSettingsProps {
  /** 刷新成功后通知父级重取模型列表（否则模型菜单还是旧的） */
  onRefreshed?: () => void;
}

interface ModelNameEntry {
  modelId: string;
  name: string;
  verified?: boolean;
}

interface DetailState {
  loading: boolean;
  error: boolean;
  models: ModelNameEntry[] | null;
}

export function ModelCatalogSettings({ onRefreshed }: ModelCatalogSettingsProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<CatalogSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // T6-1（b 方案）：行可展开。展开的行 id（null = 全部收起）。
  const [expanded, setExpanded] = useState<string | null>(null);
  // 目录接口只报条数，模型名走与聊天菜单同源的接口：WorkBuddy 用 /api/models，
  // 其余 Agent 用 /api/agents/:id/models（都是只读，不会触发枚举）。
  // 展开时才拉一次，刷新后整块作废；epoch 防止刷新后旧请求写回新状态。
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const detailEpoch = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/model-catalog');
      if (!res.ok) throw new Error(httpErrorText(res.status));
      setData((await res.json()) as CatalogSummary);
      setError(null);
    } catch (err) {
      setError((err as Error).message || t('settings.models.loadFailedShort'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await api.post('/api/model-catalog/refresh');
      const json = (await res.json()) as CatalogSummary & { error?: string };
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setData(json);
      setError(null);
      // 刷新后目录重算过，展开区缓存的模型名也作废，下次展开重新拉
      detailEpoch.current += 1;
      setDetails({});

      const parts = Object.entries(json.counts ?? {}).map(
        ([id, n]) => `${labelOf(id)} ${n}`
      );
      if (json.workbuddy && !json.workbuddy.error) {
        parts.push(`WorkBuddy ${json.workbuddy.count}`);
      }
      MessagePlugin.success(
        parts.length
          ? t('settings.models.refreshedWith', { parts: parts.join(' · ') })
          : t('settings.models.refreshed')
      );
      onRefreshed?.();
    } catch (err) {
      MessagePlugin.error((err as Error).message || t('settings.models.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

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

  const rows = [
    ...CATALOG_AGENTS.map(a => ({ ...a, count: data?.counts?.[a.id] })),
    // WorkBuddy 不走 CLI 枚举，走 SDK（官方接口）；0 = 还没取过，不是「没有模型」
    {
      id: 'workbuddy',
      label: 'WorkBuddy',
      source: 'SDK getAvailableModelsRaw()',
      sourceKey: 'settings.models.sourceSdk' as MessageKey,
      count: workbuddyCount,
    },
  ];

  const loadDetail = useCallback((agentId: string) => {
    const epoch = detailEpoch.current;
    setDetails(prev =>
      prev[agentId] ? prev : { ...prev, [agentId]: { loading: true, error: false, models: null } }
    );
    const url =
      agentId === 'workbuddy'
        ? '/api/models'
        : `/api/agents/${encodeURIComponent(agentId)}/models`;
    api
      .get(url)
      .then(async res => {
        if (!res.ok) throw new Error(httpErrorText(res.status));
        const json = (await res.json()) as {
          models?: Array<{ modelId?: string; name?: string; verified?: boolean }>;
        };
        const list: ModelNameEntry[] = Array.isArray(json.models)
          ? json.models
              .filter(
                (m): m is { modelId: string; name?: string; verified?: boolean } =>
                  !!m && typeof m.modelId === 'string'
              )
              .map(m => ({
                modelId: m.modelId,
                name: typeof m.name === 'string' && m.name ? m.name : m.modelId,
                verified: m.verified,
              }))
          : [];
        if (epoch !== detailEpoch.current) return;
        setDetails(prev => ({
          ...prev,
          [agentId]: { loading: false, error: list.length === 0, models: list.length ? list : null },
        }));
      })
      .catch(() => {
        if (epoch !== detailEpoch.current) return;
        setDetails(prev => ({
          ...prev,
          [agentId]: { loading: false, error: true, models: null },
        }));
      });
  }, []);

  // 展开哪一行才拉哪一行的名字；尚未枚举过就不发无意义的请求。
  useEffect(() => {
    if (!expanded || details[expanded]) return;
    const count = expanded === 'workbuddy' ? workbuddyCount : data?.counts?.[expanded];
    if (!count) return;
    loadDetail(expanded);
  }, [expanded, details, data, workbuddyCount, loadDetail]);

  return (
    <div className="space-y-3" data-model-catalog>
      {loading ? (
        <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {t('settings.models.loading')}
        </div>
      ) : error ? (
        <div className="text-xs" style={{ color: 'var(--td-error-color)' }}>
          {t('settings.models.loadFailed', { error })}
        </div>
      ) : (
        <div
          className="overflow-hidden rounded-lg"
          style={{
            backgroundColor: 'var(--tc-surface-raised)',
            // A115 续：容器描边 --tc-edge（4.5% 墨）。行与行之间那条
            // 分隔线同理 —— 它们是「列表里的行」，不是栏目的边界。
            border: '1px solid var(--tc-edge)',
          }}
        >
          {/* 表头两列：Agent 名 + 模型数；枚举来源折叠在展开明细里。末格留出展开箭头。 */}
          <div
            className="flex items-center gap-3 px-3 py-2"
            data-catalog-header
            style={{
              borderBottom: '1px solid var(--tc-edge)',
              backgroundColor: 'var(--td-bg-color-component)',
            }}
          >
            <span
              className="w-24 shrink-0 text-caption"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              {t('settings.models.colAgent')}
            </span>
            <span
              className="min-w-0 flex-1 text-right text-caption"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              {t('settings.models.colModels')}
            </span>
            <span aria-hidden style={{ width: 14 }} />
          </div>

          {rows.map((row, i) => {
            const isExpanded = expanded === row.id;
            return (
              <div
                key={row.id}
                style={i > 0 ? { borderTop: '1px solid var(--tc-edge)' } : undefined}
                data-catalog-row={row.id}
              >
                {/* 整行可点展开。展开只是「看」，不改任何枚举行为 ——
                    T6-1 的 (b) 方案：让用户在这里就能看到模型明细。 */}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                  aria-expanded={isExpanded}
                  onClick={() => setExpanded(prev => (prev === row.id ? null : row.id))}
                >
                  <span
                    className="w-24 shrink-0 truncate text-body"
                    style={{ color: 'var(--td-text-color-primary)' }}
                  >
                    {row.label}
                  </span>
                  <span
                    className="min-w-0 flex-1 text-right text-body tabular-nums"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                    data-catalog-count={row.id}
                  >
                    {typeof row.count === 'number'
                      ? t('settings.models.count', { n: row.count })
                      : t('settings.models.never')}
                  </span>
                  <ChevronDown
                    size={14}
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      color: 'var(--td-text-color-placeholder)',
                      transition: 'transform var(--duration-fast) var(--ease-tencent)',
                      transform: isExpanded ? 'rotate(180deg)' : undefined,
                    }}
                  />
                </button>

                {/* 展开明细：所有 Agent 都显示与聊天菜单同源的模型名。
                    目录接口只报条数，名字走只读的模型接口，刷新后重新拉。 */}
                {isExpanded && (
                  <div className="px-3 pb-3" data-catalog-detail={row.id}>
                    {/* 来源不占主表列；展开后才显示，命令原文留在悬停 title。 */}
                    <div
                      className="mb-2 flex min-w-0 items-center gap-1.5 text-caption"
                      style={{ color: 'var(--td-text-color-secondary)' }}
                      title={row.source}
                      data-catalog-source={row.id}
                    >
                      <span className="shrink-0">{t('settings.models.colSource')}</span>
                      <span aria-hidden>·</span>
                      <span className="truncate">{t(row.sourceKey)}</span>
                    </div>
                    {typeof row.count !== 'number' || row.count === 0 ? (
                      <p className="tc-hint">{t('settings.models.never')}</p>
                    ) : (() => {
                      const detail = details[row.id];
                      if (!detail || detail.loading) {
                        return <p className="tc-hint">{t('settings.models.loading')}</p>;
                      }
                      if (detail.error || !detail.models) {
                        return (
                          <p className="tc-hint" style={{ color: 'var(--td-error-color)' }}>
                            {t('settings.models.loadFailedShort')}
                          </p>
                        );
                      }
                      return (
                        <ul className="m-0 list-none p-0">
                          {detail.models.map(m => (
                            <li
                              key={m.modelId}
                              className="flex items-center gap-2 truncate py-1 text-body"
                              style={{ color: 'var(--td-text-color-primary)' }}
                              title={m.modelId}
                              data-catalog-model={m.modelId}
                            >
                              <span className="truncate">{m.name}</span>
                              {m.verified === false && (
                                <span
                                  className="shrink-0 text-caption"
                                  style={{ color: 'var(--td-text-color-placeholder)' }}
                                >
                                  {t('settings.models.unverified')}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-3">
        {/* A137：分区级动作（整块模型清单的唯一操作），与「配置环境变量」
            「添加厂商」同档走 32。它原来 24，同屏下面就是 32 的输入框。 */}
        <Button
          variant="outline"
          loading={refreshing}
          onClick={() => void refresh()}
          data-model-catalog-refresh
        >
          <span className="flex items-center gap-1.5">
            {!refreshing && <RefreshCw size={13} />}
            {t('settings.models.refresh')}
          </span>
        </Button>
        <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {t('settings.models.lastFetched', { time: relTime(data?.fetchedAt ?? 0, t) })}
        </span>
      </div>
    </div>
  );
}
