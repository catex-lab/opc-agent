import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, MessagePlugin, Select, Tag } from 'tdesign-react';
import { Plus } from 'lucide-react';
import { useTranslation, type MessageKey } from '../i18n';
import { api } from '../api';
import { emitModelRoutesChanged } from '../lib/credentialEvents';

/**
 * 「自定义模型路由」设置面板（模型清单分区的子块）。
 *
 * ## 解决什么问题
 *
 * 官方模型清单是各 Agent 自己枚举的，用户手里那些**能跑通但不在官方清单里**
 * 的 provider/model 组合（第三方网关、ACP 会话里现场发现的 provider、配置文件
 * 手填的模型名）过去没有任何地方登记。每次重开都要重新选一遍，选了还因为
 * 归属闸不认而可能被静默换成默认模型。
 *
 * 这一屏让用户把这条路由**显式登记给某个已接入的 Agent**：
 *   - 只存 provider/model 与凭据**引用名**，绝不存 Key（密钥在「登录配置」里）；
 *   - 保存 / 删除后发 `model-routes` 事件，模型菜单立即重取，新路由进入
 *     「已配置模型 → 自定义路由」分组；
 *   - 归属闸、可路由闸、凭据闸仍在服务端跑，这里只是登记，不绕过校验。
 *
 * ## 为什么不新增设置导航分区
 *
 * 设置导航数量被 a28 / a37 钉死。这里作为「模型清单」的子块出现，
 * 与「枚举来源 / 刷新按钮」同屏，用户不需要多找一层。
 */

interface StoredRoute {
  id: string;
  agentId: string;
  providerId?: string;
  modelId: string;
  displayName?: string;
  description?: string;
  credentialRef?: string;
  baseURL?: string;
  dialect?: string;
  deliveryDialect?: 'acp-config' | 'cli-flag' | 'sdk-setModel' | 'http-body';
  origin: string;
  source?: string;
  createdAt: number;
  verified?: boolean;
}

interface AgentOption {
  id: string;
  name: string;
}

interface Draft {
  id: string | null;
  agentId: string;
  providerId: string;
  modelId: string;
  displayName: string;
  description: string;
  baseURL: string;
  dialect: string;
  deliveryDialect: string;
  credentialRef: string;
}

const EMPTY_DRAFT = (agentId: string): Draft => ({
  id: null,
  agentId,
  providerId: '',
  modelId: '',
  displayName: '',
  description: '',
  baseURL: '',
  dialect: '',
  deliveryDialect: '',
  credentialRef: '',
});

/** 下发方言：留空 = 不声明，交给 Agent 的默认通道（能过可路由闸）。 */
const DELIVERY_OPTIONS: Array<{ value: string; labelKey: MessageKey }> = [
  { value: '', labelKey: 'settings.modelRoute.deliveryAuto' },
  { value: 'acp-config', labelKey: 'settings.modelRoute.deliveryAcp' },
  { value: 'cli-flag', labelKey: 'settings.modelRoute.deliveryCli' },
  { value: 'sdk-setModel', labelKey: 'settings.modelRoute.deliverySdk' },
  { value: 'http-body', labelKey: 'settings.modelRoute.deliveryHttp' },
];

function routeLabel(route: StoredRoute): string {
  if (route.displayName) return route.displayName;
  return route.providerId ? `${route.providerId}/${route.modelId}` : route.modelId;
}

function routeKey(route: StoredRoute): string {
  return route.providerId ? `${route.providerId}/${route.modelId}` : route.modelId;
}

export function ModelRouteSettings() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [routes, setRoutes] = useState<StoredRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  /** 只列**已接入**的 Agent：API 用 findDef 校验归属，comingSoon 的条目存不进去，
   *  列出来只会让用户填完拿到 400。与名册同源，去掉隐藏项之外的重复 id。 */
  const loadAgents = useCallback(async () => {
    try {
      const res = await api.get('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all: AgentOption[] = [
        ...(Array.isArray(data.agents) ? data.agents : []),
        ...(Array.isArray(data.hiddenAgents) ? data.hiddenAgents : []),
      ]
        .filter((a: any) => a && typeof a.id === 'string' && typeof a.name === 'string')
        .map((a: any) => ({ id: a.id as string, name: a.name as string }));
      const seen = new Set<string>();
      const unique = all.filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });
      setAgents(unique);
      // 默认选第一个，让「添加路由」一进来就有归属，不用先填 Agent
      setSelectedAgent(prev => prev || unique[0]?.id || '');
    } catch {
      // 名册拉不到不该挡住本面板：用户仍可看已有路由（按上次选择过滤）
      setAgents([]);
    }
  }, []);

  const loadRoutes = useCallback(async (agentId: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = agentId
        ? `/api/model-routes?agentId=${encodeURIComponent(agentId)}`
        : '/api/model-routes';
      const res = await api.get(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRoutes(Array.isArray(data.routes) ? data.routes : []);
    } catch (err) {
      setError((err as Error).message || t('settings.modelRoute.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    void loadRoutes(selectedAgent);
    // 切筛选 Agent 时关掉编辑器，避免留着上一个人的草稿
    setDraft(null);
    setConfirmingDelete(null);
  }, [selectedAgent, loadRoutes]);

  const agentName = useMemo(() => {
    const map = new Map(agents.map(a => [a.id, a.name]));
    return (id: string) => map.get(id) ?? id;
  }, [agents]);

  const openCreate = () => setDraft(EMPTY_DRAFT(selectedAgent));

  const openEdit = (route: StoredRoute) => {
    setDraft({
      id: route.id,
      agentId: route.agentId,
      providerId: route.providerId ?? '',
      modelId: route.modelId,
      displayName: route.displayName ?? '',
      description: route.description ?? '',
      baseURL: route.baseURL ?? '',
      dialect: route.dialect ?? '',
      deliveryDialect: route.deliveryDialect ?? '',
      credentialRef: route.credentialRef ?? '',
    });
    setConfirmingDelete(null);
  };

  const closeEditor = () => {
    setDraft(null);
    setError(null);
  };

  const patch = (next: Partial<Draft>) =>
    setDraft(prev => (prev ? { ...prev, ...next } : prev));

  /** 只发非空字段：服务端对空字符串有「视作未提供」的语义，
   *  但显式省略更不容易把 `''` 误存成 provider / 凭据引用。 */
  const buildBody = (d: Draft) => ({
    agentId: d.agentId,
    modelId: d.modelId.trim(),
    ...(d.providerId.trim() ? { providerId: d.providerId.trim() } : {}),
    ...(d.displayName.trim() ? { displayName: d.displayName.trim() } : {}),
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(d.baseURL.trim() ? { baseURL: d.baseURL.trim() } : {}),
    ...(d.dialect.trim() ? { dialect: d.dialect.trim() } : {}),
    ...(d.deliveryDialect ? { deliveryDialect: d.deliveryDialect as Draft['deliveryDialect'] } : {}),
    ...(d.credentialRef.trim() ? { credentialRef: d.credentialRef.trim() } : {}),
  });

  const notifyAndReload = async (agentId: string) => {
    // 事件总线让当前 Agent 的 modelsEpoch 与平台清单都重取；模型菜单里
    // 「已配置模型 → 自定义路由」随之出现这条路由。
    emitModelRoutesChanged(agentId);
    await loadRoutes(selectedAgent);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.agentId) {
      setError(t('settings.modelRoute.needAgent'));
      return;
    }
    if (!draft.modelId.trim()) {
      setError(t('settings.modelRoute.needModel'));
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const init = {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(draft)),
      };
      const res = await (draft.id
        ? api.put(`/api/model-routes/${encodeURIComponent(draft.id)}`, init)
        : api.post('/api/model-routes', init));
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success(draft.id ? t('settings.modelRoute.updated') : t('settings.modelRoute.added'));
      const savedAgent = draft.agentId;
      closeEditor();
      await notifyAndReload(savedAgent);
    } catch (err) {
      setError((err as Error).message || t('settings.modelRoute.saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string, agentId: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await api.delete(`/api/model-routes/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success(t('settings.modelRoute.deleted'));
      setConfirmingDelete(null);
      await notifyAndReload(agentId);
    } catch (err) {
      setError((err as Error).message || t('settings.modelRoute.deleteFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3" data-model-route-settings>
      <div>
        <h4 className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {t('settings.modelRoute.title')}
        </h4>
        <p className="tc-hint mt-1">{t('settings.modelRoute.hint')}</p>
      </div>

      {/* Agent 筛选：列表按它过滤，新增也默认归到它 */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {t('settings.modelRoute.pickAgent')}
        </span>
        <div className="min-w-0 flex-1" data-model-route-agent-picker>
          <Select
            value={selectedAgent}
            onChange={v => setSelectedAgent(String(v ?? ''))}
            placeholder={t('settings.modelRoute.needAgent')}
          >
            {agents.map(a => (
              <Select.Option key={a.id} value={a.id}>
                {a.name}（{a.id}）
              </Select.Option>
            ))}
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {t('settings.modelRoute.loading')}
        </div>
      ) : error ? (
        <div className="text-xs" style={{ color: 'var(--td-error-color)' }}>
          {error}
        </div>
      ) : routes.length === 0 && !draft ? null : (
        <div className="space-y-2">
          {routes.map(route => (
            <div
              key={route.id}
              className="flex items-center gap-2 rounded-lg px-3 py-2.5"
              style={{
                backgroundColor: 'var(--tc-surface-raised)',
                border: '1px solid var(--tc-edge)',
              }}
              data-model-route-row={route.id}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="truncate text-sm"
                    style={{ color: 'var(--td-text-color-primary)' }}
                    title={routeKey(route)}
                  >
                    {routeLabel(route)}
                  </span>
                  {route.deliveryDialect && (
                    <Tag size="small" variant="light">{route.deliveryDialect}</Tag>
                  )}
                  {route.credentialRef && (
                    <span className="truncate text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      {t('settings.modelRoute.credentialTag', { ref: route.credentialRef })}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {agentName(route.agentId)}
                  {route.baseURL ? ` · ${route.baseURL}` : ''}
                </div>
              </div>
              <Button
                variant="text"
                disabled={busy !== null}
                onClick={() => openEdit(route)}
                data-model-route-edit={route.id}
              >
                {t('settings.modelRoute.edit')}
              </Button>
              {confirmingDelete === route.id ? (
                <>
                  <Button
                    theme="danger"
                    variant="text"
                    loading={busy === route.id}
                    onClick={() => void remove(route.id, route.agentId)}
                    data-model-route-delete-confirm={route.id}
                  >
                    {t('settings.modelRoute.confirmDelete')}
                  </Button>
                  <Button variant="text" onClick={() => setConfirmingDelete(null)}>
                    {t('settings.common.cancel')}
                  </Button>
                </>
              ) : (
                <Button
                  theme="danger"
                  variant="text"
                  disabled={busy !== null}
                  onClick={() => setConfirmingDelete(route.id)}
                  data-model-route-delete={route.id}
                >
                  {t('settings.modelRoute.delete')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {!draft && (
        <Button
          variant="outline"
          icon={<Plus size={14} />}
          onClick={openCreate}
          data-model-route-add
        >
          {t('settings.modelRoute.add')}
        </Button>
      )}

      {draft && (
        <div
          className="space-y-3 rounded-lg p-3"
          style={{
            backgroundColor: 'var(--tc-surface-raised)',
            border: '1px solid var(--tc-edge)',
          }}
          data-model-route-editor
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {draft.id ? t('settings.modelRoute.editTitle') : t('settings.modelRoute.addTitle')}
            </span>
            <Button variant="text" onClick={closeEditor}>
              {t('settings.modelRoute.collapse')}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('settings.modelRoute.providerLabel')}
              </label>
              <Input
                value={draft.providerId}
                onChange={v => patch({ providerId: v as string })}
                placeholder={t('settings.modelRoute.providerPlaceholder')}
                data-model-route-field="providerId"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('settings.modelRoute.modelLabel')}
              </label>
              <Input
                value={draft.modelId}
                onChange={v => patch({ modelId: v as string })}
                placeholder={t('settings.modelRoute.modelPlaceholder')}
                data-model-route-field="modelId"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('settings.modelRoute.displayNameLabel')}
              </label>
              <Input
                value={draft.displayName}
                onChange={v => patch({ displayName: v as string })}
                placeholder={t('settings.modelRoute.displayNamePlaceholder')}
                data-model-route-field="displayName"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('settings.modelRoute.deliveryLabel')}
              </label>
              <div data-model-route-field="deliveryDialect">
                <Select
                  value={draft.deliveryDialect}
                  onChange={v => patch({ deliveryDialect: String(v ?? '') })}
                >
                  {DELIVERY_OPTIONS.map(o => (
                    <Select.Option key={o.value} value={o.value}>
                      {t(o.labelKey)}
                    </Select.Option>
                  ))}
                </Select>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {t('settings.modelRoute.baseUrlLabel')}
            </label>
            <Input
              value={draft.baseURL}
              onChange={v => patch({ baseURL: v as string })}
              placeholder={t('settings.modelRoute.baseUrlPlaceholder')}
              data-model-route-field="baseURL"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('settings.modelRoute.dialectLabel')}
              </label>
              <Input
                value={draft.dialect}
                onChange={v => patch({ dialect: v as string })}
                placeholder={t('settings.modelRoute.dialectPlaceholder')}
                data-model-route-field="dialect"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('settings.modelRoute.credentialRefLabel')}
              </label>
              <Input
                value={draft.credentialRef}
                onChange={v => patch({ credentialRef: v as string })}
                placeholder={t('settings.modelRoute.credentialRefPlaceholder')}
                data-model-route-field="credentialRef"
              />
            </div>
          </div>

          {/* 安全语义必须显眼：这一条是本面板最重要的约束，不是可有可无的提示 */}
          <div
            className="rounded px-2 py-1.5 text-xs"
            style={{
              color: 'var(--td-warning-color)',
              backgroundColor: 'var(--td-warning-color-1)',
            }}
            data-model-route-secret-hint
          >
            {t('settings.modelRoute.noSecretHint')}
          </div>

          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {t('settings.modelRoute.descriptionLabel')}
            </label>
            <Input
              value={draft.description}
              onChange={v => patch({ description: v as string })}
              placeholder={t('settings.modelRoute.descriptionPlaceholder')}
              data-model-route-field="description"
            />
          </div>

          {error && (
            <div className="text-xs" style={{ color: 'var(--td-error-color)' }}>
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              loading={busy === 'save'}
              onClick={() => void save()}
              data-model-route-save
            >
              {t('settings.modelRoute.save')}
            </Button>
            <Button variant="text" onClick={closeEditor}>
              {t('settings.common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
