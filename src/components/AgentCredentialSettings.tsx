import { useCallback, useEffect, useState } from 'react';
import { Tag } from 'tdesign-react';
import { Check, ChevronDown, KeyRound } from 'lucide-react';
import { AgentCredentialEditor } from './AgentCredentialEditor';

/**
 * 「Agent API Key」列表 —— 设置页的批量管理视图。
 *
 * 单行的**编辑表单**已经抽到 `AgentCredentialEditor` 里（详情页也用同一份），
 * 这里只负责：列出行、收起/展开、把展开后的那一行交给 Editor。
 *
 * 这样「设置 → 登录配置」与「Agent 详情页 → 填写 API Key」是同一块代码、
 * 同一份数据（都打 `/api/agent-credentials`），改一个等于改两个。
 */

interface CredentialView {
  agentId: string;
  name: string;
  keyEnvs: string[];
  configured: boolean;
  masked: string;
  fromEnv: boolean;
}

interface AgentCredentialSettingsProps {
  onSaved?: () => void;
}

export function AgentCredentialSettings({ onSaved }: AgentCredentialSettingsProps) {
  const [list, setList] = useState<CredentialView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

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
        return (
          <div
            key={item.agentId}
            className="rounded-lg"
            style={{
              backgroundColor: 'var(--tc-surface-raised)',
              border: '1px solid var(--tc-edge)',
            }}
            data-credential-row={item.agentId}
          >
            <button
              type="button"
              onClick={() => setEditing(isEditing ? null : item.agentId)}
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
              {item.configured ? (
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
              <div className="px-3 pb-3">
                <AgentCredentialEditor
                  agentId={item.agentId}
                  onSaved={() => {
                    onSaved?.();
                    void load();
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
