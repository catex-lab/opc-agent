import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '../i18n';
import type { WorkbuddyProfileState } from '../types';

/**
 * A211：「WorkBuddy 产品版本」设置区。
 *
 * ## 为什么是「一个 Agent + 多个 profile」而不是 qoder / qoder-cn 式双条目
 *
 * 官方国内版与国际版共用同一个 SDK 与同一份 CLI，差别只在数据根 / endpoint /
 * 网络环境。一个常驻 CLI 进程一次只能持一份凭据，拆成两个 Agent 条目只会得到
 * 「两个都显示在线、点开一个必然 401」的幽灵条目。所以名册里始终只有一个
 * `workbuddy`，这里负责选它此刻接的是哪一份官方数据目录。
 *
 * ## 这一屏要回答的三件事
 *
 * 1. 现在接的是哪个版本、为什么是它（`reason` 由服务端按活跃度 / 固定值算出）；
 * 2. 本机还检测到哪些版本、各自的登录态新旧与自定义模型数量；
 * 3. 接错了能不能一键改回来（固定 / 取消固定 / 官方换目录后重新检测）。
 *
 * 诚实时态：`fallback` 明确写「用的是内置默认值」，`drift` 明确写「已自动跟随
 * 官方」，`detected=false` 的行明确写「只检测到目录」。任何一项都不许显示成
 * 「已接上」—— 401 那次事故的根因就是把旧目录的假在线当成了真凭据。
 *
 * ## 切换为什么一定要通知父级
 *
 * 服务端切 profile 时会重建 SDK 适配器、清掉两套模型缓存；前端这边平台模型
 * 清单（`useModels`）与当前 Agent 清单（`modelsEpoch`）是另外两份 state。
 * `onChanged` 走的是 #16 那条既有的事件总线，一次切换只重取一轮，不新造机制。
 */

interface WorkbuddyProfileSettingsProps {
  /** 切换 / 重扫成功后通知父级刷新名册与模型清单 */
  onChanged?: () => void;
}

/** POST 与 GET 顶层同形，额外字段平级挂着（见 index.ts 的 rebindWorkbuddyRuntime） */
type ActionResponse = WorkbuddyProfileState & {
  changed?: boolean;
  replaced?: boolean;
  agentError?: string;
  error?: string;
};

function timeLabel(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

/**
 * 响应形状校验：`{}` / HTML 错误页 / 半截 JSON 一律当读取失败。
 *
 * 不能只靠 TypeScript —— `as WorkbuddyProfileState` 编译期就被擦掉，对 `{}`
 * 照样放行；下面 render 里 `state.profiles.filter(...)` 一抛，React 会把
 * **整个设置页**交给 ErrorBoundary，连左侧八个分区导航都一起消失。
 * 夹具兜底 `json({})`、反向代理返回错误页、新旧服务端混用都会走到这条
 * （A211 第一次整链在 `verify:a28` 红的就是这个，两条「没有 X」的否定式
 * 断言还一起假绿）。宁可只显示一行错误，也绝不白屏。
 */
function isProfileState(v: unknown): v is WorkbuddyProfileState {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r.profiles) &&
    Array.isArray(r.drift) &&
    Array.isArray(r.customModels) &&
    typeof r.activeId === 'string' &&
    typeof r.reason === 'string' &&
    typeof r.pinned === 'boolean' &&
    typeof r.fallback === 'boolean' &&
    (r.pinnedId === null || typeof r.pinnedId === 'string')
  );
}

export function WorkbuddyProfileSettings({ onChanged }: WorkbuddyProfileSettingsProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<WorkbuddyProfileState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在执行的操作：'auto' / 'refresh' / 某个 profile id；单值即可，这些入口互斥 */
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/workbuddy-profiles');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed: unknown = await res.json();
      if (!isProfileState(parsed)) throw new Error(t('settings.wbProfile.badResponse'));
      setState(parsed);
      setError(null);
    } catch (err) {
      setError(t('settings.wbProfile.loadFailed', { error: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (path: string, body: unknown | undefined, key: string) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const parsed: unknown = await res.json();
      if (!res.ok) {
        const detail =
          parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).error === 'string'
            ? String((parsed as Record<string, unknown>).error)
            : `HTTP ${res.status}`;
        throw new Error(detail);
      }
      // POST 与 GET 同形，多出来的 changed/replaced/agent 是平级附加字段；
      // 形状不完整时同样不能 setState，否则下一次 render 会带崩整个设置页。
      if (!isProfileState(parsed)) throw new Error(t('settings.wbProfile.badResponse'));
      const json = parsed as ActionResponse;
      setState(json);
      // 切换本身已成功落盘/重建；重探失败只是「名册状态暂时没刷新」，
      // 不当成失败，但要把原话显示出来，别让用户以为探测也一起绿了。
      if (json.agentError) setError(json.agentError);
      onChanged?.();
    } catch (err) {
      setError(t('settings.wbProfile.switchFailed', { error: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }} data-wb-loading>
        {t('settings.wbProfile.loading')}
      </div>
    );
  }
  if (!state) {
    return (
      <div className="text-xs" style={{ color: 'var(--td-error-color)' }} data-wb-error>
        {error || t('settings.wbProfile.loadFailed', { error: 'empty response' })}
      </div>
    );
  }

  const detectedCount = state.profiles.filter(p => p.detected).length;

  return (
    <div className="space-y-3" data-workbuddy-profile-section>
      <div
        className="rounded-lg px-3 py-2.5 text-xs leading-5"
        style={{
          backgroundColor: 'var(--tc-surface-raised)',
          border: '1px solid var(--tc-edge)',
          color: 'var(--td-text-color-secondary)',
        }}
        data-wb-state
        data-active-id={state.activeId}
        data-fallback={state.fallback ? '1' : '0'}
        data-pinned={state.pinned ? '1' : '0'}
        data-detected-count={detectedCount}
      >
        {state.reason}
      </div>

      {/* 诚实降级 / 漂移：只有真的发生了才渲染，空状态不画一个恒绿的框 */}
      {state.fallback && (
        <p className="text-xs leading-5" style={{ color: 'var(--td-warning-color)' }} data-wb-fallback>
          {t('settings.wbProfile.fallback')}
        </p>
      )}
      {state.drift.length > 0 && (
        <p className="text-xs leading-5" style={{ color: 'var(--td-warning-color)' }} data-wb-drift>
          {t('settings.wbProfile.drift')} ·{' '}
          {state.drift.map(d => `${d.field}: ${d.hardcoded} → ${d.official}`).join('；')}
        </p>
      )}

      <div
        className="overflow-hidden rounded-lg"
        style={{
          backgroundColor: 'var(--tc-surface-raised)',
          border: '1px solid var(--tc-edge)',
        }}
      >
        {state.profiles.map((p, i) => {
          const active = p.id === state.activeId;
          return (
            <div
              key={p.id}
              className="flex items-center gap-3 px-3 py-2.5"
              style={i > 0 ? { borderTop: '1px solid var(--tc-edge)' } : undefined}
              data-wb-profile-row
              data-profile-id={p.id}
              data-active={active ? '1' : '0'}
              data-detected={p.detected ? '1' : '0'}
            >
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="truncate text-sm"
                    style={{ color: 'var(--td-text-color-primary)' }}
                  >
                    {p.productName}
                  </span>
                  <code
                    className="shrink-0 text-xs"
                    style={{
                      color: 'var(--td-text-color-placeholder)',
                      fontFamily: 'var(--td-font-family-mono, ui-monospace, monospace)',
                    }}
                  >
                    {p.dataFolderName}
                  </code>
                  {active && (
                    <span
                      className="shrink-0 rounded px-1 text-caption"
                      style={{
                        color: 'var(--td-success-color)',
                        backgroundColor: 'var(--td-bg-color-component)',
                      }}
                      data-wb-active-badge
                    >
                      {t('settings.wbProfile.active')}
                    </span>
                  )}
                  {state.pinned && state.pinnedId === p.id && (
                    <span
                      className="shrink-0 rounded px-1 text-caption"
                      style={{
                        color: 'var(--td-text-color-secondary)',
                        backgroundColor: 'var(--td-bg-color-component)',
                      }}
                    >
                      {t('settings.wbProfile.pinned')}
                    </span>
                  )}
                </span>
                <span
                  className="block truncate text-xs leading-5"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  {p.endpoint} · {p.environment} ·{' '}
                  {p.keyblobAt
                    ? t('settings.wbProfile.keyblobAt', { time: timeLabel(p.keyblobAt) })
                    : t('settings.wbProfile.noKeyblob')}
                  {active && state.customModels.length > 0 &&
                    ` · ${t('settings.wbProfile.customModels', { count: state.customModels.length })}`}
                  {!p.detected && ` · ${t('settings.wbProfile.notDetected')}`}
                </span>
              </span>
              <button
                type="button"
                className="tc-btn-secondary"
                data-wb-switch
                data-switch-id={p.id}
                disabled={busy !== null || active}
                onClick={() => void run('/api/workbuddy-profiles/switch', { id: p.id }, p.id)}
              >
                {t('settings.wbProfile.switchTo')}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="tc-btn-secondary"
          data-wb-auto
          disabled={busy !== null || !state.pinned}
          onClick={() => void run('/api/workbuddy-profiles/switch', { id: null }, 'auto')}
        >
          {t('settings.wbProfile.auto')}
        </button>
        <button
          type="button"
          className="tc-btn-secondary"
          data-wb-refresh
          disabled={busy !== null}
          onClick={() => void run('/api/workbuddy-profiles/refresh', undefined, 'refresh')}
        >
          <RefreshCw size={14} />
          {busy === 'refresh'
            ? t('settings.wbProfile.refreshing')
            : t('settings.wbProfile.refresh')}
        </button>
        <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {t('settings.wbProfile.autoNote')}
        </span>
      </div>

      {/* 切换会 dispose 整个会话池 —— 先把代价说清楚，别让用户以为只是换了个标签 */}
      <p
        className="text-xs leading-5"
        style={{ color: 'var(--td-text-color-placeholder)' }}
        data-wb-warning
      >
        {t('settings.wbProfile.switchWarning')}
      </p>
      {error && (
        <p className="text-xs leading-5" style={{ color: 'var(--td-error-color)' }} data-wb-error>
          {error}
        </p>
      )}
    </div>
  );
}
