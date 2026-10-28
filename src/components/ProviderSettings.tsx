import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, MessagePlugin, Select, Tag } from 'tdesign-react';
import { Check, Plus, RefreshCw, X, Zap } from 'lucide-react';
import {
  chatUrlOf,
  dialectLabel,
  modelsUrlOf,
  type ProviderDialect,
} from '../../shared/providerUrl';

/**
 * 「自定义模型厂商」（A129）。
 *
 * ## 为什么放在登录配置里
 *
 * 原先的入口是通讯录右上角「+ → 自定义 Agent」，与设置页的「Agent API Key」
 * 是同一件事的两半：前者存地址+模型，后者存 Key。用户实际遇到的问题是
 * 「我有 Key 和地址，但不知道模型叫什么」，而那个弹窗不告诉他。合并之后，
 * 地址、Key、模型清单、连通性都在一处，且**保存前**就能验证。
 *
 * ## 一个厂商 = 一组模型
 *
 * A114 的「一条配置一个模型」会让同一个网关在通讯录里出现多条联系人。
 * 现在模型是厂商下的子资源：拉一次清单，勾选多个，输入框的模型下拉里
 * 全部可选。
 *
 * ## 为什么显示「最终请求地址」
 *
 * 用户填 `https://token.sensenova.cn/v1` 还是 `.../v1/chat/completions`，
 * 拼出来的请求地址完全不同。大半 404 都出在这半段或那半段。把真正会
 * 请求的 URL 回显出来，用户当场就能发现自己少写了 `/v1`。
 */

interface ProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  dialect: ProviderDialect;
  models: string[];
  createdAt: number;
}

interface TestStep {
  step: 'models' | 'chat';
  ok: boolean;
  detail: string;
  latencyMs: number;
  models?: string[];
}

interface TestResult {
  ok: boolean;
  baseUrl: string;
  chatUrl: string;
  models: string[];
  steps: TestStep[];
}

interface Draft {
  id: string | null;
  name: string;
  baseUrl: string;
  dialect: ProviderDialect;
  apiKey: string;
  models: string[];
  manualModel: string;
}

const EMPTY_DRAFT = (): Draft => ({
  id: null,
  name: '',
  baseUrl: '',
  dialect: 'openai',
  apiKey: '',
  models: [],
  manualModel: '',
});

interface Preset {
  key: string;
  label: string;
  baseUrl: string;
  dialect: ProviderDialect;
}

/**
 * 预设只填地址与格式，**不填模型**：模型必须从清单里拉或用户自己写。
 * 写死模型名正是 A114 那个 404 的来源（预设里的模型可能已下线）。
 */
const PRESETS: Preset[] = [
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', dialect: 'openai' },
  { key: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', dialect: 'openai' },
  { key: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', dialect: 'openai' },
  { key: 'sensenova', label: '商汤', baseUrl: 'https://token.sensenova.cn/v1', dialect: 'openai' },
  { key: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', dialect: 'gemini' },
  { key: 'ollama', label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', dialect: 'openai' },
];

const DIALECT_OPTIONS: Array<{ value: ProviderDialect; label: string }> = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'gemini', label: 'Gemini' },
];

interface ProviderSettingsProps {
  /** 增删改成功后通知父级重拉 Agent 名册（通讯录与模型下拉都依赖它） */
  onChanged?: () => void;
  /** 从通讯录「+」进来时直接打开新增表单并滚到可见处 */
  autoOpen?: boolean;
}

export function ProviderSettings({ onChanged, autoOpen }: ProviderSettingsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<ProviderSpec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/custom');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setList(Array.isArray(data.agents) ? data.agents : []);
    } catch (err) {
      setError((err as Error).message || '读取厂商列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 从通讯录「+ → 添加模型厂商」过来时，用户的心智已经停在「我要填表」，
  // 落在「登录配置」顶部还要自己往下找。直接把表单打开并滚过去。
  useEffect(() => {
    if (!autoOpen) return;
    setDraft(EMPTY_DRAFT());
    setFetched([]);
    setFetchNote(null);
    setTestResult(null);
    setError(null);
    const timer = window.setTimeout(() => {
      rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [autoOpen]);

  const openCreate = () => {
    setDraft(EMPTY_DRAFT());
    setFetched([]);
    setFetchNote(null);
    setTestResult(null);
    setError(null);
  };

  const openEdit = (item: ProviderSpec) => {
    setDraft({
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
      dialect: item.dialect,
      apiKey: '',
      models: [...item.models],
      manualModel: '',
    });
    setFetched([]);
    setFetchNote(null);
    setTestResult(null);
    setError(null);
  };

  const closeEditor = () => {
    setDraft(null);
    setFetched([]);
    setFetchNote(null);
    setTestResult(null);
    setError(null);
  };

  const patch = (next: Partial<Draft>) => {
    setDraft(prev => (prev ? { ...prev, ...next } : prev));
    // 改了地址/格式，之前拉到的清单和测试结论就不再对应当前配置
    if (next.baseUrl !== undefined || next.dialect !== undefined) {
      setFetched([]);
      setFetchNote(null);
      setTestResult(null);
    }
  };

  const availableModels = useMemo(() => {
    if (!draft) return [];
    return Array.from(new Set([...fetched, ...draft.models]));
  }, [draft, fetched]);

  const toggleModel = (model: string, checked: boolean) => {
    if (!draft) return;
    setDraft({
      ...draft,
      models: checked ? [...draft.models, model] : draft.models.filter(m => m !== model),
    });
  };

  const addManualModel = () => {
    if (!draft) return;
    const v = draft.manualModel.trim();
    if (!v) return;
    if (!draft.models.includes(v)) setDraft({ ...draft, models: [...draft.models, v], manualModel: '' });
    else setDraft({ ...draft, manualModel: '' });
  };

  const removeModel = (model: string) => {
    if (!draft) return;
    setDraft({ ...draft, models: draft.models.filter(m => m !== model) });
  };

  const authBody = () =>
    draft
      ? {
          baseUrl: draft.baseUrl.trim(),
          dialect: draft.dialect,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          ...(draft.id ? { agentId: draft.id } : {}),
        }
      : {};

  const fetchModels = async () => {
    if (!draft) return;
    setBusy('fetch');
    setError(null);
    setFetchNote(null);
    try {
      const res = await fetch('/api/agents/custom/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authBody()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const models: string[] = Array.isArray(data.models) ? data.models : [];
      setFetched(models);
      if (models.length === 0) {
        setFetchNote('该服务没有返回模型清单，请在下方手动填写模型名。');
      } else if (draft.models.length === 0) {
        // 清单拉到了但还没选：默认全选，省掉逐个勾。用户可取消不要的。
        setDraft({ ...draft, models });
      }
    } catch (err) {
      setError((err as Error).message || '拉取模型清单失败');
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!draft) return;
    if (draft.models.length === 0) {
      setError('请先添加至少一个模型，再测试连接');
      return;
    }
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      const res = await fetch('/api/agents/custom/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...authBody(), model: draft.models[0] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setTestResult(data as TestResult);
    } catch (err) {
      setError((err as Error).message || '连通性测试失败');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    setError(null);
    try {
      const res = await fetch(
        draft.id ? `/api/agents/custom/${encodeURIComponent(draft.id)}` : '/api/agents/custom',
        {
          method: draft.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draft.name.trim(),
            baseUrl: draft.baseUrl.trim(),
            dialect: draft.dialect,
            models: draft.models,
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success(draft.id ? '厂商已更新' : '厂商已添加');
      closeEditor();
      await load();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message || '保存失败');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/agents/custom/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success('厂商已删除');
      setConfirmingDelete(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message || '删除失败');
    } finally {
      setBusy(null);
    }
  };

  const finalUrl = draft
    ? chatUrlOf(draft.baseUrl, draft.dialect, draft.models[0] ?? '{model}', false)
    : '';

  return (
    <div className="space-y-3" data-provider-settings ref={rootRef}>
      {/* 已有厂商 */}
      {loading ? (
        <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          正在读取厂商…
        </div>
      ) : list.length === 0 && !draft ? (
        <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          还没有自定义厂商。添加后，通讯录里会出现一条联系人，模型下拉列出它全部模型。
        </div>
      ) : (
        <div className="space-y-2">
          {list.map(item => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-lg px-3 py-2.5"
              style={{
                backgroundColor: 'var(--tc-surface-raised)',
                border: '1px solid var(--tc-edge)',
              }}
              data-provider-row={item.id}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="truncate text-sm"
                    style={{ color: 'var(--td-text-color-primary)' }}
                  >
                    {item.name}
                  </span>
                  <Tag size="small" variant="light">
                    {dialectLabel(item.dialect)}
                  </Tag>
                  <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {item.models.length} 个模型
                  </span>
                </div>
                <div
                  className="truncate text-xs"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  {item.baseUrl}
                </div>
              </div>
              <Button
                size="small"
                variant="text"
                disabled={busy !== null}
                onClick={() => openEdit(item)}
                data-provider-edit={item.id}
              >
                编辑
              </Button>
              {confirmingDelete === item.id ? (
                <>
                  <Button
                    size="small"
                    theme="danger"
                    variant="text"
                    loading={busy === item.id}
                    onClick={() => void remove(item.id)}
                    data-provider-delete-confirm={item.id}
                  >
                    确认删除
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => setConfirmingDelete(null)}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  size="small"
                  theme="danger"
                  variant="text"
                  disabled={busy !== null}
                  onClick={() => setConfirmingDelete(item.id)}
                  data-provider-delete={item.id}
                >
                  删除
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {!draft && (
        /* A137：列表底部的主入口，不是列表行内动作 —— 走 32 档（A124 单档）。
           行内那颗「编辑/删除」仍是 24，两者不同档是**故意的层级区分**：
           进得来（主入口）要显眼，进来后的逐条操作要收着。 */
        <Button
          variant="outline"
          icon={<Plus size={14} />}
          onClick={openCreate}
          data-provider-add
        >
          添加厂商
        </Button>
      )}

      {/* 编辑器 */}
      {draft && (
        <div
          className="space-y-3 rounded-lg p-3"
          style={{
            backgroundColor: 'var(--tc-surface-raised)',
            border: '1px solid var(--tc-edge)',
          }}
          data-provider-editor
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {draft.id ? '编辑厂商' : '添加厂商'}
            </span>
            <Button size="small" variant="text" onClick={closeEditor}>
              收起
            </Button>
          </div>

          {!draft.id && (
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(p => (
                <Button
                  key={p.key}
                  size="small"
                  variant="outline"
                  onClick={() => {
                    // 换预设时名称跟着换，但**只在它还是空或上一个预设名时** ——
                    // 用户自己敲的名字不能被覆盖。原先写成 `draft.name || p.label`，
                    // 连点两个预设就会出现「名字 DeepSeek、地址 Google」的组合。
                    const wasPresetName =
                      !draft.name.trim() || PRESETS.some(x => x.label === draft.name);
                    setDraft({
                      ...draft,
                      name: wasPresetName ? p.label : draft.name,
                      baseUrl: p.baseUrl,
                      dialect: p.dialect,
                    });
                  }}
                  data-provider-preset={p.key}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          )}

          {/* A137：名称 / 上游格式 / 地址 / Key 四颗都是**表单字段**，按 DESIGN-SYSTEM
              §4「输入框尺寸」走 32 档 —— 与编辑器底部的保存/测试连接同高。
              同一行里 24 的输入框配 32 的按钮是最刺眼的错配。 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                className="mb-1 block text-xs"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                名称（通讯录里显示）
              </label>
              <Input
                value={draft.name}
                maxlength={20}
                onChange={v => patch({ name: v as string })}
                placeholder="例如：商汤"
                data-provider-field="name"
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                上游格式
              </label>
              {/* TDesign 的 Select 不透传 data-*，标记挂外层容器 */}
              <div data-provider-field="dialect">
                <Select
                  value={draft.dialect}
                  onChange={v => patch({ dialect: v as ProviderDialect })}
                >
                  {DIALECT_OPTIONS.map(o => (
                    <Select.Option key={o.value} value={o.value}>
                      {o.label}
                    </Select.Option>
                  ))}
                </Select>
              </div>
            </div>
          </div>

          <div>
            <label
              className="mb-1 block text-xs"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              API 地址（填到版本号那一层即可）
            </label>
            <Input
              value={draft.baseUrl}
              onChange={v => patch({ baseUrl: v as string })}
              placeholder="例如：https://api.deepseek.com/v1"
              data-provider-field="baseUrl"
            />
            {draft.baseUrl.trim() && (
              <div
                className="mt-1 truncate text-xs"
                style={{ color: 'var(--td-text-color-placeholder)' }}
                data-provider-final-url
                title={finalUrl}
              >
                模型清单：{modelsUrlOf(draft.baseUrl)}
                <br />
                对话请求：{finalUrl}
              </div>
            )}
          </div>

          <div>
            <label
              className="mb-1 block text-xs"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              API Key{draft.id ? '（已保存，留空则保持不变）' : ''}
            </label>
            <Input
              type="password"
              value={draft.apiKey}
              onChange={v => patch({ apiKey: v as string })}
              placeholder={draft.id ? '留空则保持现有 Key' : '粘贴 API Key'}
              data-provider-field="apiKey"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                模型{draft.models.length > 0 ? `（已选 ${draft.models.length}）` : ''}
              </label>
              <div className="flex items-center gap-1">
                <Button
                  size="small"
                  variant="text"
                  loading={busy === 'fetch'}
                  disabled={!draft.baseUrl.trim() || busy === 'test' || busy === 'save'}
                  onClick={() => void fetchModels()}
                  data-provider-fetch-models
                >
                  <RefreshCw size={12} className="mr-1" />
                  拉取模型
                </Button>
                {availableModels.length > 0 && (
                  <>
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => setDraft({ ...draft, models: availableModels })}
                    >
                      全选
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => setDraft({ ...draft, models: [] })}
                    >
                      清空
                    </Button>
                  </>
                )}
              </div>
            </div>

            {availableModels.length > 0 && (
              <div
                className="max-h-40 flex flex-col gap-1 overflow-y-auto rounded p-2"
                style={{ backgroundColor: 'var(--td-bg-color-container)' }}
              >
                {availableModels.map(m => (
                  <Checkbox
                    key={m}
                    checked={draft.models.includes(m)}
                    onChange={(checked: boolean) => toggleModel(m, checked)}
                    data-provider-model={m}
                  >
                    <span className="text-xs" style={{ color: 'var(--td-text-color-primary)' }}>
                      {m}
                    </span>
                  </Checkbox>
                ))}
              </div>
            )}

            {fetchNote && (
              <div className="mt-1 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {fetchNote}
              </div>
            )}

            {draft.models.filter(m => !fetched.includes(m)).length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {draft.models
                  .filter(m => !fetched.includes(m))
                  .map(m => (
                    <Tag
                      key={m}
                      size="small"
                      closable
                      onClose={() => removeModel(m)}
                      data-provider-manual-model={m}
                    >
                      {m}
                    </Tag>
                  ))}
              </div>
            )}

            <div className="mt-1.5 flex items-center gap-1.5">
              <Input
                size="small"
                value={draft.manualModel}
                onChange={v => patch({ manualModel: v as string })}
                onEnter={addManualModel}
                placeholder="清单里没有？手动输入模型名后回车"
                data-provider-field="model"
              />
              <Button size="small" variant="outline" onClick={addManualModel}>
                添加
              </Button>
            </div>
          </div>

          {testResult && (
            <div className="space-y-1" data-provider-result={testResult.ok ? 'ok' : 'fail'}>
              {testResult.steps.map((s, i) => (
                <div
                  key={`${s.step}-${i}`}
                  className="flex items-start gap-1.5 text-xs"
                  data-provider-step={s.step}
                >
                  {s.ok ? (
                    <Check size={12} style={{ color: 'var(--td-success-color)', marginTop: 2 }} />
                  ) : (
                    <X size={12} style={{ color: 'var(--td-error-color)', marginTop: 2 }} />
                  )}
                  <span style={{ color: 'var(--td-text-color-primary)' }}>{s.detail}</span>
                  <span style={{ color: 'var(--td-text-color-placeholder)' }}>{s.latencyMs}ms</span>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="text-xs" style={{ color: 'var(--td-error-color)' }} data-provider-error>
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            {/* A137：这两颗原来是 size="small"（实测 24px / 内边距 7 / 字号 12），
                而全站动作按钮是 32/15/14 单档（A124 定，`--tc-btn-height`）。
                自建厂商表单是 A129 才搬进设置页的，整块漏了这道规范。
                这里只修**表单提交类**的两颗；同文件里其余 small 是字段级控件
                （输入框、模型 chip、移除键），它们和 24px 的 Input 同高，不该升。 */}
            <Button
              theme="primary"
              loading={busy === 'save'}
              disabled={busy === 'test' || busy === 'fetch'}
              onClick={() => void save()}
              data-provider-save
            >
              保存
            </Button>
            <Button
              variant="outline"
              loading={busy === 'test'}
              disabled={busy === 'save' || busy === 'fetch'}
              onClick={() => void runTest()}
              data-provider-test
              /* A137：图标原来手写在 children 里（`<Zap size={12} className="mr-1" />`），
                 不受 TDesign 的按钮内部布局管，实测中心比按钮中心高 5px。
                 改走 `icon` prop —— 它会被放进 `.t-button__icon`，垂直居中由组件保证
                 （「刷新」「添加规则」那几颗一直这么写，所以它们从来没过这条断言）。 */
              icon={<Zap size={12} />}
            >
              测试连接
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
