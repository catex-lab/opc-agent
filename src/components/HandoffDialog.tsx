import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Loader2, X } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { useTranslation, type MessageKey } from '../i18n';
import { api } from '../api';

/**
 * 跨 Agent 会话转交（A226）—— 选接手人的弹窗。
 *
 * ## 为什么是「选人即生效」而不是「选人再确认」
 *
 * 转交是**可逆**的（想换回来再走一遍同一个菜单），而且它不立刻花钱——
 * 真正的下一条指令才发生调用。给一个低风险可逆操作再加一道确认，
 * 用户会开始无脑点确认，确认框就失去意义了。
 *
 * ## 只列在线的
 *
 * 转给一个「未安装」的 Agent，下一轮必然报错——那一轮用户的问题已经
 * 排在队里了。没就绪的条目置灰并标注状态，让用户当场就知道为什么选不了。
 */

interface HandoffDialogProps {
  open: boolean;
  /** 当前正在对话的 Agent（不参与候选） */
  currentAgentId?: string;
  onClose: () => void;
  /**
   * 执行转交。由上层实现（要更新会话的 agentId 与名册状态）。
   * 返回 ok:false 时把 error 显示在弹窗里（弹窗不关，用户可以直接重选）。
   */
  onHandoff: (targetAgentId: string) => Promise<{ ok: boolean; error?: string; targetName?: string }>;
}

interface AgentOption {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  logoUrl?: string;
  availability: string;
  custom?: boolean;
}

export function HandoffDialog({ open, currentAgentId, onClose, onHandoff }: HandoffDialogProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    setKeyword('');
    let cancelled = false;
    api.get('/api/agents')
      .then(r => r.json())
      .then((data: { agents?: AgentOption[] }) => {
        if (cancelled) return;
        setAgents(Array.isArray(data.agents) ? data.agents : []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const candidates = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return agents
      .filter(a => a.id !== currentAgentId)
      .filter(a => !kw || a.name.toLowerCase().includes(kw) || a.id.toLowerCase().includes(kw))
      .sort((a, b) => {
        const ra = a.availability === 'ready' ? 0 : 1;
        const rb = b.availability === 'ready' ? 0 : 1;
        return ra - rb;
      });
  }, [agents, currentAgentId, keyword]);

  const pick = async (agent: AgentOption) => {
    if (pending) return;
    if (agent.availability !== 'ready') {
      setError(t('handoff.notReady', { name: agent.name }));
      return;
    }
    setPending(agent.id);
    setError('');
    const result = await onHandoff(agent.id);
    setPending(null);
    if (result.ok) {
      onClose();
    } else {
      setError(result.error || t('handoff.failed'));
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('handoff.title')}
        data-handoff-dialog
        className="tc-dialog flex max-h-[min(560px,100%)] w-[min(420px,100%)] flex-col overflow-hidden rounded-2xl"
      >
        <div
          className="flex h-[72px] shrink-0 items-center justify-between px-5"
          style={{ borderBottom: '1px solid var(--tc-divider)' }}
        >
          <div className="min-w-0">
            <h3 className="text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {t('handoff.title')}
            </h3>
            <p className="truncate text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {t('handoff.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('handoff.cancel')}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 pt-3">
          <div
            className="flex h-10 w-full items-center gap-2 rounded-full bg-transparent px-3.5 transition-colors focus-within:bg-[var(--tc-fill-hover)]"
            style={{ border: '1px solid var(--tc-divider)' }}
          >
            <Search size={14} style={{ color: 'var(--td-text-color-placeholder)' }} />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder={t('handoff.search')}
              data-handoff-search
              className="w-full bg-transparent text-body outline-none"
              style={{ color: 'var(--td-text-color-primary)' }}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--td-text-color-placeholder)' }} />
            </div>
          ) : candidates.length === 0 ? (
            <p className="px-3 py-8 text-center text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {t('handoff.noCandidate')}
            </p>
          ) : (
            candidates.map(agent => {
              const ready = agent.availability === 'ready';
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => void pick(agent)}
                  disabled={pending !== null}
                  data-handoff-option={agent.id}
                  className="tc-list-item flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--tc-hover-chrome)] disabled:opacity-60"
                >
                  <AgentAvatar
                    id={agent.id}
                    name={agent.name}
                    icon={agent.icon}
                    src={agent.logoUrl}
                    color={agent.color}
                    availability={agent.availability as never}
                    size={36}
                  />
                  <span className="min-w-0 flex-1 truncate text-body" style={{ color: 'var(--td-text-color-primary)' }}>
                    {agent.name}
                  </span>
                  {!ready && (
                    <span className="shrink-0 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      {/* availability 与 status.<key> 文案键一一对应（types.ts 同一套枚举） */}
                      {t(`status.${agent.availability}` as MessageKey)}
                    </span>
                  )}
                  {pending === agent.id && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--td-brand-color)' }} />}
                </button>
              );
            })
          )}
        </div>

        {error && (
          <p className="px-5 pb-3 text-caption" style={{ color: 'var(--tc-status-danger)' }} data-handoff-error>
            {error}
          </p>
        )}
        <p className="px-5 pb-4 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {t('handoff.footnote')}
        </p>
      </div>
    </div>,
    document.body
  );
}
