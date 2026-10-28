import { useCallback, useEffect, useState } from 'react';
import { Button, Input, MessagePlugin, Tag } from 'tdesign-react';
import { KeyRound, ChevronDown, Check } from 'lucide-react';

/**
 * 「Agent API Key」—— 应用内的凭据入口（A30）。
 *
 * ## 为什么必须存在
 *
 * 名册上的「豆包 / Gemini 未登录」在打包版里是个**死结**：`authEnvs` 只认
 * 进程环境变量，而用户双击图标启动时，进程环境里不会有 `ARK_API_KEY`。
 * 界面上又没有任何地方能填 —— 于是提示永远停在「未登录」，用户无从下手。
 *
 * 这里补的就是那个入口：填完立刻落盘 + 立刻重探，名册上的状态马上变。
 *
 * ## 交互取舍
 *
 * - **默认收起**：Key 是敏感信息，三行常驻输入框会让整页看起来很吓人；
 *   收起时只显示「已配置 + 掩码」。
 * - **不回填明文**：已保存的 Key 只回显掩码。要换就直接填新的（覆盖），
 *   要删就点「清除」—— 不做「把密钥读回输入框」，那等于给肩窥留一扇窗。
 * - **保存后回调**：父组件据此重新拉 `/api/agents`，否则通讯录还是旧状态。
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

interface AgentCredentialSettingsProps {
  /** 保存/清除成功后通知父级刷新 Agent 名册 */
  onSaved?: () => void;
}

export function AgentCredentialSettings({ onSaved }: AgentCredentialSettingsProps) {
  const [list, setList] = useState<CredentialView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 当前展开编辑的 Agent */
  const [editing, setEditing] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agent-credentials');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setList(Array.isArray(data.credentials) ? data.credentials : []);
    } catch (err) {
      setError((err as Error).message || '读取凭据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (item: CredentialView) => {
    setEditing(item.agentId);
    setDraftKey('');
    setDraftBaseUrl(item.baseUrl || '');
  };

  const save = async (item: CredentialView) => {
    setBusy(item.agentId);
    try {
      const res = await fetch('/api/agent-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: item.agentId,
          // 空串 = 不改动已保存的 Key（只改接入地址时不该把 Key 清掉）
          ...(draftKey.trim() ? { key: draftKey.trim() } : {}),
          baseUrl: draftBaseUrl.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success(`${item.name} 凭据已保存`);
      setEditing(null);
      setDraftKey('');
      await load();
      onSaved?.();
    } catch (err) {
      MessagePlugin.error((err as Error).message || '保存失败');
    } finally {
      setBusy(null);
    }
  };

  const clear = async (item: CredentialView) => {
    setBusy(item.agentId);
    try {
      const res = await fetch(`/api/agent-credentials/${item.agentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      MessagePlugin.success(`${item.name} 凭据已清除`);
      setEditing(null);
      await load();
      onSaved?.();
    } catch (err) {
      MessagePlugin.error((err as Error).message || '清除失败');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
        正在读取凭据…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs" style={{ color: 'var(--td-error-color)' }}>
        读取凭据失败：{error}
      </div>
    );
  }

  if (list.length === 0) return null;

  return (
    <div className="space-y-2" data-agent-credentials>
      {list.map(item => {
        const isEditing = editing === item.agentId;
        const configured = item.configured;
        return (
          <div
            key={item.agentId}
            className="rounded-lg"
            style={{
              backgroundColor: 'var(--tc-surface-raised)',
              // A115 续：行卡片描边 --tc-edge（4.5% 墨）—— 这些行排在
              // 设置页内容面上，靠 raised 底色已经能分出层次，描边只作
              // 「边界保险」。
              border: '1px solid var(--tc-edge)',
            }}
            data-credential-row={item.agentId}
          >
            <button
              type="button"
              onClick={() => (isEditing ? setEditing(null) : startEdit(item))}
              aria-expanded={isEditing}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
              data-credential-toggle={item.agentId}
            >
              <KeyRound size={14} style={{ color: 'var(--td-text-color-secondary)' }} />
              <span
                className="min-w-0 flex-1 truncate text-sm"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                {item.name}
              </span>
              {configured ? (
                <Tag size="small" variant="light" theme="success" icon={<Check size={11} />}>
                  {item.masked}
                </Tag>
              ) : item.fromEnv ? (
                <Tag size="small" variant="light" theme="primary">
                  环境变量已配置
                </Tag>
              ) : (
                <Tag size="small" variant="light">
                  未配置
                </Tag>
              )}
              <ChevronDown
                size={14}
                style={{
                  color: 'var(--td-text-color-placeholder)',
                  transform: isEditing ? 'rotate(180deg)' : 'none',
                  transition: 'transform 150ms',
                }}
              />
            </button>

            {isEditing && (
              /* A137：展开区是**表单**（带 label 的输入 + 保存/清除），走 32 档。
                 折叠头那一行是列表行，不在此列 —— 行内动作仍留 24。
                 与「设置 → 登录配置」的环境变量表单同一套判断，别在这里另立一档。 */
              <div className="space-y-2 px-3 pb-3">
                <div>
                  <label
                    className="mb-1 block text-xs"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    {item.keyEnvs.join(' / ')}
                    {configured && '（已配置，留空则保持不变）'}
                  </label>
                  <Input
                    type="password"
                    value={draftKey}
                    onChange={v => setDraftKey(v as string)}
                    placeholder={configured ? '留空则保持现有 Key' : '粘贴 API Key'}
                    data-credential-key={item.agentId}
                  />
                </div>

                {item.baseUrlEnv && (
                  <div>
                    <label
                      className="mb-1 block text-xs"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      {item.baseUrlEnv}（可选，指向兼容网关）
                    </label>
                    <Input
                      value={draftBaseUrl}
                      onChange={v => setDraftBaseUrl(v as string)}
                      placeholder="留空则用官方端点"
                      data-credential-baseurl={item.agentId}
                    />
                  </div>
                )}

                {item.hint && (
                  <p className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {item.hint}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    theme="primary"
                    loading={busy === item.agentId}
                    onClick={() => void save(item)}
                  >
                    保存
                  </Button>
                  {configured && (
                    <Button
                      variant="text"
                      theme="danger"
                      disabled={busy === item.agentId}
                      onClick={() => void clear(item)}
                    >
                      清除
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
