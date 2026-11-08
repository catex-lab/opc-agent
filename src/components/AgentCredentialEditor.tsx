import { useCallback, useEffect, useState } from 'react';
import { Button, Input, MessagePlugin, Tag } from 'tdesign-react';
import { Check, KeyRound, Network, RefreshCw, Trash2 } from 'lucide-react';
import type { AgentAvailability } from '../types';
import { useTranslation, type MessageKey } from '../i18n';

/**
 * 单个 Agent 的凭据编辑器（取 / 存 / 清 + 连通性 + 模型清单）。
 *
 * ## 为什么从 AgentCredentialSettings 里抽出来
 *
 * 原来只有设置页的「登录配置」能填 Key；Agent 详情页点「填写 API Key」
 * 会把人弹过去，上下文断掉。抽成独立组件后，详情页能就地展开一个一模一样
 * 的表单 —— 两处是**同一块代码、同一份数据**（都打 `/api/agent-credentials`），
 * 不存在"两边不同步"的问题：数据层本来就只有一份。
 *
 * ## 三个动作的边界
 *
 * - **保存**：写盘 + 立刻重探该 Agent（复用 `POST /api/agent-credentials` 已有的行为）。
 * - **检测连通性**：复用 `GET /api/agents/:id?probe=1`，把探测的真实状态
 *   （就绪 / 未登录 / 网络不通 …）吐出来，不写"连接成功"这种空话。
 * - **获取模型**：复用 `GET /api/agents/:id/models`，就地列清单。
 *   保存 Key 后服务端已 `invalidateCatalog()`，这里拿到的是新结果。
 *
 * 「检测连通性」与「获取模型」只在**已配置凭据**时出现 —— 没 Key 测了也
 * 只会是"未登录"，徒增一次无意义的等待。
 */

interface CredentialView {
  agentId: string;
  name: string;
  keyEnv: string;
  keyEnvs: string[];
  baseUrlEnv?: string;
  hint?: string;
  configured: boolean;
  masked: string;
  baseUrl: string;
  fromEnv: boolean;
}

interface ModelOption {
  modelId: string;
  name: string;
  description?: string;
  provider?: string;
  providerName?: string;
}

interface AgentCredentialEditorProps {
  agentId: string;
  /** 保存/清除成功后通知父级刷新名册等 */
  onSaved?: () => void;
}

const AVAILABILITY_KEY: Record<AgentAvailability, MessageKey> = {
  ready: 'settings.credential.availability.ready',
  'needs-auth': 'settings.credential.availability.needsAuth',
  'needs-setup': 'settings.credential.availability.needsSetup',
  unreachable: 'settings.credential.availability.unreachable',
  'not-installed': 'settings.credential.availability.notInstalled',
  unsupported: 'settings.credential.availability.unsupported',
  unknown: 'settings.credential.availability.unknown',
};

export function AgentCredentialEditor({ agentId, onSaved }: AgentCredentialEditorProps) {
  const { t } = useTranslation();
  const [item, setItem] = useState<CredentialView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draftKey, setDraftKey] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);

  const [probe, setProbe] = useState<{
    loading: boolean;
    availability?: AgentAvailability;
    message?: string;
  }>({ loading: false });

  const [models, setModels] = useState<{
    loading: boolean;
    fetched: boolean;
    list: ModelOption[];
    note?: string;
  }>({ loading: false, fetched: false, list: [] });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agent-credentials');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: CredentialView[] = Array.isArray(data.credentials) ? data.credentials : [];
      const found = list.find(c => c.agentId === agentId);
      setItem(found ?? null);
      if (found) {
        setDraftBaseUrl(found.baseUrl || '');
        setDraftKey('');
      }
    } catch (err) {
      setError((err as Error).message || t('settings.credential.loadFailedShort'));
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!item) return;
    setBusy('save');
    try {
      const res = await fetch('/api/agent-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          // 空串 = 不改动已保存的 Key（只改接入地址时不该把 Key 清掉）
          ...(draftKey.trim() ? { key: draftKey.trim() } : {}),
          baseUrl: draftBaseUrl.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success(t('settings.credential.saved', { name: item.name }));
      setDraftKey('');
      // 保存后探测结果与模型清单都可能变，清掉旧的，让用户重新点
      setProbe({ loading: false });
      setModels({ loading: false, fetched: false, list: [] });
      await load();
      onSaved?.();
    } catch (err) {
      MessagePlugin.error((err as Error).message || t('settings.credential.saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (!item) return;
    setBusy('clear');
    try {
      const res = await fetch(`/api/agent-credentials/${agentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success(t('settings.credential.cleared', { name: item.name }));
      setProbe({ loading: false });
      setModels({ loading: false, fetched: false, list: [] });
      await load();
      onSaved?.();
    } catch (err) {
      MessagePlugin.error((err as Error).message || t('settings.credential.clearFailed'));
    } finally {
      setBusy(null);
    }
  };

  const testConnectivity = async () => {
    setProbe({ loading: true });
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}?probe=1`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const status = data?.agent?.status;
      setProbe({
        loading: false,
        availability: status?.availability,
        message: status?.message || status?.lastError,
      });
    } catch (err) {
      setProbe({ loading: false, message: (err as Error).message });
    }
  };

  const fetchModels = async () => {
    setModels(prev => ({ ...prev, loading: true }));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/models`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setModels({ loading: false, fetched: true, list: data.models ?? [], note: data.note });
    } catch (err) {
      setModels({ loading: false, fetched: true, list: [], note: (err as Error).message });
    }
  };

  if (loading) {
    return (
      <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
        {t('settings.credential.loading')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-xs" style={{ color: 'var(--td-error-color)' }}>
        {t('settings.credential.loadFailed', { error })}
      </div>
    );
  }
  if (!item) {
    return (
      <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
        {t('settings.credential.noInAppEntry')}
      </div>
    );
  }

  const configured = item.configured;
  const canProbe = configured || item.fromEnv;

  return (
    <div
      data-credential-editor={agentId}
      className="space-y-2"
    >
      {/* 配置状态行：已配置则显示掩码，否则显示「未配置」 */}
      <div className="flex items-center gap-2">
        <KeyRound size={14} style={{ color: 'var(--td-text-color-secondary)' }} />
        <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>
          {item.name}
        </span>
        {configured ? (
          <Tag size="small" variant="light" theme="success" icon={<Check size={11} />}>
            {item.masked}
          </Tag>
        ) : item.fromEnv ? (
          <Tag size="small" variant="light" theme="primary">
            {t('settings.credential.fromEnv')}
          </Tag>
        ) : (
          <Tag size="small" variant="light">
            {t('settings.credential.notConfigured')}
          </Tag>
        )}
      </div>

      {/* API Key */}
      <div>
        <label
          className="mb-1 block text-xs"
          style={{ color: 'var(--td-text-color-placeholder)' }}
        >
          {item.keyEnvs.join(' / ')}
          {configured && t('settings.credential.keyConfiguredHint')}
        </label>
        <Input
          type="password"
          value={draftKey}
          onChange={v => setDraftKey(v as string)}
          placeholder={
            configured ? t('settings.credential.keyKeepPlaceholder') : t('settings.credential.keyPlaceholder')
          }
          data-credential-key={agentId}
        />
      </div>

      {/* Base URL（仅支持自定义网关的 Agent） */}
      {item.baseUrlEnv && (
        <div>
          <label
            className="mb-1 block text-xs"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            {item.baseUrlEnv}
            {t('settings.credential.baseUrlOptional')}
          </label>
          <Input
            value={draftBaseUrl}
            onChange={v => setDraftBaseUrl(v as string)}
            placeholder={t('settings.credential.baseUrlPlaceholder')}
            data-credential-baseurl={agentId}
          />
        </div>
      )}

      {item.hint && (
        <p className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {item.hint}
        </p>
      )}

      {/* 保存 / 清除 */}
      <div className="flex items-center gap-2">
        <Button theme="primary" loading={busy === 'save'} onClick={() => void save()}>
          {t('settings.credential.save')}
        </Button>
        {configured && (
          <Button
            variant="text"
            theme="danger"
            disabled={busy !== null}
            onClick={() => void clear()}
          >
            <Trash2 size={14} />
            {t('settings.credential.clear')}
          </Button>
        )}
      </div>

      {/* 已配置后才出现：检测连通性 / 获取模型 */}
      {canProbe && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2" style={{ borderColor: 'var(--tc-edge)' }}>
          <Button variant="outline" loading={probe.loading} onClick={() => void testConnectivity()}>
            <Network size={14} />
            {t('settings.credential.testConnectivity')}
          </Button>
          <Button variant="outline" loading={models.loading} onClick={() => void fetchModels()}>
            <RefreshCw size={14} />
            {t('settings.credential.fetchModels')}
          </Button>
        </div>
      )}

      {/* 连通性结果：只显示真实状态，不写「成功」」 */}
      {(probe.availability || probe.message) && !probe.loading && (
        <div
          className="rounded-md px-2.5 py-2 text-xs leading-relaxed"
          style={{
            backgroundColor: 'var(--td-bg-color-component)',
            color:
              probe.availability === 'ready'
                ? 'var(--td-success-color, #2BA471)'
                : 'var(--td-text-color-secondary)',
          }}
          data-connectivity-result
        >
          {probe.availability && (
            <span style={{ fontWeight: 600 }}>
              {AVAILABILITY_KEY[probe.availability]
                ? t(AVAILABILITY_KEY[probe.availability])
                : probe.availability}
            </span>
          )}
          {probe.message && (
            <span className="ml-2" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {probe.message}
            </span>
          )}
        </div>
      )}

      {/* 模型清单：点过「获取模型」后一定给反馈 —— 有清单列清单，
          没有就给一句实话（HTTP 类通常没有预设模型，要手动填接入点）。 */}
      {models.fetched && (
        <div
          className="rounded-md px-2.5 py-2"
          style={{ backgroundColor: 'var(--td-bg-color-component)' }}
          data-models-result
        >
          <div
            className="mb-1 text-xs"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            {t('settings.credential.modelCount', { n: models.list.length })}
          </div>
          {models.list.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {models.list.slice(0, 30).map(m => (
                  <Tag key={m.modelId} size="small" variant="light">
                    {m.name || m.modelId}
                  </Tag>
                ))}
              </div>
              {models.list.length > 30 && (
                <div
                  className="mt-1 text-xs"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  {t('settings.credential.modelsHidden', { n: models.list.length - 30 })}
                </div>
              )}
            </>
          ) : (
            <div
              className="text-xs leading-relaxed"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              {models.note || t('settings.credential.noPresetModels')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
