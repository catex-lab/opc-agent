import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Database, Lock, RotateCcw, Search, X } from 'lucide-react';
import type {
  KbBackfillResult,
  KbScope,
  KbSearchResult,
  KbSessionSummary,
  KbStatus,
  KbToolPolicy,
} from './types';
import {
  KbApiError,
  backfillKb,
  fetchAgentNames,
  fetchKbStatus,
  fetchKbToolPolicy,
  fetchSessionSummaries,
  patchKbPolicy,
  patchKbSession,
  patchKbToolEnabled,
  rebuildKb,
  searchKb,
} from './kbApi';
import {
  KB_SCOPE_LABEL,
  KB_SCOPE_ORDER,
  formatBytes,
  formatShortTime,
  formatTime,
} from './format';
import { KbHitCard } from './KbHitCard';

export const KB_SCOPE_STORAGE_PREFIX = 'opc.kb.scope.';

export function readSavedKbScope(sessionId: string): KbScope {
  try {
    const saved = localStorage.getItem(`${KB_SCOPE_STORAGE_PREFIX}${sessionId}`);
    if (saved === 'session' || saved === 'workspace' || saved === 'project' || saved === 'all') {
      return saved;
    }
  } catch {
    /* localStorage 不可用时回落到默认范围 */
  }
  return 'workspace';
}

const SCOPE_HINT: Record<KbScope, string> = {
  session: '只检索当前这条会话里的对话',
  workspace: '同一工作目录下的会话 · 默认范围',
  project: '当前项目及其子目录下的会话',
  all: '所有项目的全部会话',
};

interface KnowledgeBasePanelProps {
  open: boolean;
  sessionId: string;
  sessionTitle?: string;
  scope: KbScope;
  onScopeChange: (scope: KbScope) => void;
  onClose: () => void;
  onOpenConversation?: (sessionId: string, messageId: string) => void;
}

type BusyKind = '' | 'session' | 'recent' | 'full' | 'rebuild';

export function KnowledgeBasePanel({
  open,
  sessionId,
  sessionTitle,
  scope,
  onScopeChange,
  onClose,
  onOpenConversation,
}: KnowledgeBasePanelProps) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingScope, setPendingScope] = useState<KbScope | null>(null);
  const [sessions, setSessions] = useState<Record<string, KbSessionSummary>>({});
  const [agents, setAgents] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KbSearchResult | null>(null);
  const [searchError, setSearchError] = useState('');
  const [busy, setBusy] = useState<BusyKind>('');
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [toolPolicy, setToolPolicy] = useState<KbToolPolicy | null>(null);
  const [toolBusy, setToolBusy] = useState('');
  const [toolFeedback, setToolFeedback] = useState('');
  const seqRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    const seq = ++seqRef.current;
    const next = await fetchKbStatus();
    if (seq !== seqRef.current) return null;
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSearchResult(null);
    setSearchError('');
    setFeedback(null);
    setConfirmRebuild(false);
    setToolFeedback('');
    (async () => {
      try {
        const [nextStatus, sessionList, agentMap, toolPolicyNext] = await Promise.all([
          fetchKbStatus(),
          fetchSessionSummaries(),
          fetchAgentNames(),
          fetchKbToolPolicy(),
        ]);
        if (cancelled) return;
        setStatus(nextStatus);
        setSessions(
          Object.fromEntries(sessionList.map(item => [item.id, item]))
        );
        setAgents(agentMap);
        setToolPolicy(toolPolicyNext);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '读取索引状态失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  // 策略没打开时，已保存的范围必须退回本工作区，避免界面显示一个实际检索不到的范围。
  useEffect(() => {
    if (!status) return;
    if (scope === 'project' && !status.policy.allowProject) onScopeChange('workspace');
    if (scope === 'all' && !status.policy.allowAll) onScopeChange('workspace');
  }, [status, scope, onScopeChange]);

  // 范围变了之后旧结果不再具代表性，清掉避免「范围写 A、结果来自 B」。
  useEffect(() => {
    setSearchResult(null);
    setSearchError('');
  }, [scope]);

  const applyScope = useCallback(
    (next: KbScope) => {
      onScopeChange(next);
      try {
        localStorage.setItem(`${KB_SCOPE_STORAGE_PREFIX}${sessionId}`, next);
      } catch {
        /* 忽略存储失败，范围仍在本次会话内生效 */
      }
      setPendingScope(null);
    },
    [onScopeChange, sessionId]
  );

  const selectScope = useCallback(
    (next: KbScope) => {
      const locked =
        (next === 'project' && !status?.policy.allowProject) ||
        (next === 'all' && !status?.policy.allowAll);
      if (locked) {
        setPendingScope(next);
        return;
      }
      applyScope(next);
    },
    [applyScope, status]
  );

  const confirmPendingScope = useCallback(async () => {
    if (!pendingScope) return;
    setBusy('session');
    setFeedback(null);
    try {
      const patch =
        pendingScope === 'project' ? { allowProject: true } : { allowAll: true };
      await patchKbPolicy(patch);
      await refreshStatus();
      applyScope(pendingScope);
    } catch (e) {
      setFeedback({ kind: 'err', text: e instanceof KbApiError ? e.message : '范围策略保存失败' });
    } finally {
      setBusy('');
    }
  }, [applyScope, pendingScope, refreshStatus]);

  const disabledInfo = status?.disabledSessions.find(item => item.sessionId === sessionId);

  const toggleSession = useCallback(
    async (indexed: boolean) => {
      if (!sessionId) return;
      setBusy('session');
      setFeedback(null);
      try {
        await patchKbSession(sessionId, indexed);
        await refreshStatus();
        setFeedback({
          kind: 'ok',
          text: indexed ? '已恢复该会话的索引，新消息会继续记录。' : '已停止索引该会话，此前的切片已删除。',
        });
      } catch (e) {
        setFeedback({
          kind: 'err',
          text: e instanceof KbApiError ? e.message : '会话索引状态保存失败',
        });
      } finally {
        setBusy('');
      }
    },
    [refreshStatus, sessionId]
  );

  const toggleAgentTool = useCallback(
    async (agentId: string, enabled: boolean) => {
      setToolBusy(agentId);
      setToolFeedback('');
      try {
        const next = await patchKbToolEnabled(agentId, enabled);
        setToolPolicy(next);
        setToolFeedback(
          enabled
            ? '已开启：该 Agent 本轮可直接检索，最多 2 次。'
            : '已关闭：该 Agent 不再主动检索，首轮自动注入仍生效。'
        );
      } catch (e) {
        setToolFeedback(e instanceof KbApiError ? e.message : '工具开关保存失败');
      } finally {
        setToolBusy('');
      }
    },
    []
  );

  const runBackfill = useCallback(
    async (mode: 'recent' | 'full') => {
      setBusy(mode);
      setFeedback(null);
      setError('');
      try {
        const result = await backfillKb(mode);
        await refreshStatus();
        setFeedback({ kind: 'ok', text: describeBackfill(result, mode) });
      } catch (e) {
        setFeedback({
          kind: 'err',
          text: e instanceof KbApiError ? e.message : '回填失败，请重试',
        });
      } finally {
        setBusy('');
      }
    },
    [refreshStatus]
  );

  const runRebuild = useCallback(async () => {
    setConfirmRebuild(false);
    setBusy('rebuild');
    setFeedback(null);
    try {
      const result = await rebuildKb();
      await refreshStatus();
      setFeedback({ kind: 'ok', text: describeBackfill(result, 'full', true) });
    } catch (e) {
      setFeedback({
        kind: 'err',
        text: e instanceof KbApiError ? e.message : '重建失败，请重试',
      });
    } finally {
      setBusy('');
    }
  }, [refreshStatus]);

  const runSearch = useCallback(async () => {
    const keyword = query.trim();
    if (!keyword || !sessionId) return;
    setSearching(true);
    setSearchError('');
    setSearchResult(null);
    try {
      const result = await searchKb({ query: keyword, sessionId, scope, topK: 4 });
      setSearchResult(result);
    } catch (e) {
      setSearchError(e instanceof KbApiError ? e.message : '检索失败，请重试');
    } finally {
      setSearching(false);
    }
  }, [query, scope, sessionId]);

  const openConversation = useCallback(
    (targetSessionId: string, messageId: string) => {
      if (onOpenConversation) {
        onOpenConversation(targetSessionId, messageId);
      } else {
        navigate(`/chat/${targetSessionId}#msg-${messageId}`);
      }
      onClose();
    },
    [navigate, onClose, onOpenConversation]
  );

  if (!open) return null;

  const notIndexed = !!status && status.chunkCount === 0;
  const sessionDisabled = !!disabledInfo;
  const autoStopped = disabledInfo?.reason === 'auto_failure';

  return (
    <div className="kb-overlay" data-kb-panel-overlay onClick={onClose}>
      <section
        className="kb-panel"
        role="dialog"
        aria-modal="true"
        aria-label="知识库"
        data-kb-panel
        onClick={event => event.stopPropagation()}
      >
        <header className="kb-head">
          <div className="kb-head-main">
            <span className="kb-kicker">
              <Database size={14} strokeWidth={1.5} aria-hidden="true" />
              跨 Agent 知识库
            </span>
            <h2 className="kb-title">检索与索引</h2>
            <p className="kb-sub">
              {sessionTitle || (sessionId ? `会话 ${sessionId.slice(0, 8)}` : '当前会话')}
            </p>
          </div>
          <button type="button" className="kb-icon-btn" onClick={onClose} aria-label="关闭知识库">
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        <div className="kb-body">
          {loading ? <p className="kb-loading">正在读取索引状态…</p> : null}
          {error ? (
            <div className="kb-error" role="alert">
              <AlertTriangle size={14} strokeWidth={1.5} aria-hidden="true" />
              {error}
              <button
                type="button"
                className="kb-link"
                onClick={() => {
                  setError('');
                  void refreshStatus().catch(err =>
                    setError(err instanceof Error ? err.message : '读取索引状态失败')
                  );
                }}
              >
                重试
              </button>
            </div>
          ) : null}

          {status ? (
            <>
              <div className="kb-stats" data-kb-stats>
                <div className="kb-stat" data-kb-stat="chunks">
                  <span className="kb-stat-label">已索引切片</span>
                  <span className="kb-stat-value">{status.chunkCount.toLocaleString('zh-CN')}</span>
                </div>
                <div className="kb-stat" data-kb-stat="size">
                  <span className="kb-stat-label">索引体积</span>
                  <span className="kb-stat-value">{formatBytes(status.sizeBytes)}</span>
                </div>
                <div className="kb-stat" data-kb-stat="last">
                  <span className="kb-stat-label">最近索引</span>
                  <span
                    className="kb-stat-value"
                    title={formatTime(status.lastBackfillAt)}
                  >
                    {formatShortTime(status.lastBackfillAt)}
                  </span>
                </div>
                <div className="kb-stat" data-kb-stat="scope">
                  <span className="kb-stat-label">范围策略</span>
                  <span className="kb-stat-value">{KB_SCOPE_LABEL[scope]}</span>
                </div>
                <div className="kb-stat" data-kb-stat="enabled">
                  <span className="kb-stat-label">运行状态</span>
                  <span className="kb-stat-value">
                    {sessionDisabled ? '本会话已停' : status.initialized ? '已启用' : '未建索引'}
                  </span>
                </div>
              </div>

              {notIndexed ? (
                <div className="kb-empty" data-kb-empty>
                  <Database size={20} strokeWidth={1.5} aria-hidden="true" />
                  <div>
                    <h3 className="kb-empty-title">还没有建立索引</h3>
                    <p className="kb-empty-text">
                      先回填近 90 天的对话生成第一批切片。索引只保存脱敏后的摘要，不会改动聊天记录。
                    </p>
                    <button
                      type="button"
                      className="kb-btn kb-btn-primary"
                      data-kb-empty-action
                      disabled={!!busy}
                      onClick={() => void runBackfill('recent')}
                    >
                      {busy === 'recent' ? '正在建索引…' : '先建索引'}
                    </button>
                  </div>
                </div>
              ) : null}

              <section className="kb-section" data-kb-scope-section>
                <div className="kb-section-head">
                  <h3 className="kb-section-title">检索范围</h3>
                  <p className="kb-section-desc">默认只在本工作区内检索，跨范围需要你显式打开。</p>
                </div>
                <div className="kb-scope-list" role="radiogroup" aria-label="检索范围">
                  {KB_SCOPE_ORDER.map(item => {
                    const locked =
                      (item === 'project' && !status.policy.allowProject) ||
                      (item === 'all' && !status.policy.allowAll);
                    return (
                      <button
                        key={item}
                        type="button"
                        role="radio"
                        aria-checked={scope === item}
                        data-kb-scope={item}
                        data-kb-scope-locked={locked ? 'true' : 'false'}
                        className={`kb-scope-row${scope === item ? ' is-active' : ''}${locked ? ' is-locked' : ''}`}
                        onClick={() => selectScope(item)}
                      >
                        <span className="kb-radio" aria-hidden="true" />
                        <span className="kb-scope-text">
                          <span className="kb-scope-label">
                            {KB_SCOPE_LABEL[item]}
                            {item === 'workspace' ? <span className="kb-tag">默认</span> : null}
                          </span>
                          <span className="kb-scope-hint">{SCOPE_HINT[item]}</span>
                        </span>
                        {locked ? (
                          <span className="kb-lock">
                            <Lock size={12} strokeWidth={1.5} aria-hidden="true" />
                            需显式开启
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                {pendingScope ? (
                  <div className="kb-notice" data-kb-scope-notice>
                    <p>
                      打开「{KB_SCOPE_LABEL[pendingScope]}」后，其他会话内容可被检索。本操作会写入范围策略，
                      之后仍可在同一位置关闭。
                    </p>
                    <div className="kb-inline-actions">
                      <button type="button" className="kb-btn" onClick={() => setPendingScope(null)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="kb-btn kb-btn-primary"
                        disabled={busy === 'session'}
                        onClick={() => void confirmPendingScope()}
                      >
                        {busy === 'session' ? '正在开启…' : '开启并切换'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="kb-section" data-kb-session-section>
                <div className="kb-section-head">
                  <h3 className="kb-section-title">当前会话</h3>
                  <p className="kb-section-desc">关闭后不再写入新切片，已有切片会被删除，聊天记录不受影响。</p>
                </div>
                <div className="kb-session-row">
                  <div className="kb-session-main">
                    {sessionDisabled ? (
                      <>
                        <span
                          className={`kb-badge${autoStopped ? ' kb-badge-warn' : ' kb-badge-quiet'}`}
                          data-kb-stop-reason={autoStopped ? 'auto' : 'user'}
                        >
                          {autoStopped ? '自动停' : '你手动关'}
                        </span>
                        <p className="kb-session-text">
                          {autoStopped
                            ? `连续失败 ${disabledInfo?.consecutiveFailures ?? 3} 次，系统已自动停止索引。`
                            : '你手动关闭了这条会话的索引。'}
                        </p>
                        {autoStopped && disabledInfo?.lastError ? (
                          <p className="kb-session-error">{disabledInfo.lastError}</p>
                        ) : null}
                      </>
                    ) : notIndexed ? (
                      <>
                        <span className="kb-badge" data-kb-stop-reason="none">
                          待建索引
                        </span>
                        <p className="kb-session-text">建立索引后，新消息才会持续写入切片。</p>
                      </>
                    ) : (
                      <>
                        <span className="kb-badge" data-kb-stop-reason="none">
                          索引中
                        </span>
                        <p className="kb-session-text">新消息会持续写入切片，可在下方随时关闭。</p>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="kb-btn"
                    data-kb-session-action
                    disabled={busy === 'session'}
                    onClick={() => void toggleSession(sessionDisabled)}
                  >
                    {busy === 'session' ? '保存中…' : sessionDisabled ? '恢复索引' : '不索引此会话'}
                  </button>
                </div>
              </section>

              {toolPolicy ? (
                <section className="kb-section" data-kb-tool-section>
                  <div className="kb-section-head">
                    <h3 className="kb-section-title">Agent 主动检索</h3>
                    <p className="kb-section-desc">
                      工具默认关闭。开启后该 Agent 可在回答中主动检索并引用历史会话；
                      每个 Agent 每轮最多 {toolPolicy.maxPerTurn} 次，首轮自动注入不受开关影响。
                    </p>
                  </div>
                  <div className="kb-agent-list" data-kb-tool-agents>
                    {toolPolicy.agents.map(agent => (
                      <div className="kb-agent-row" data-kb-tool-agent={agent.id} key={agent.id}>
                        <div className="kb-agent-main">
                          <span className="kb-agent-name">{agent.name || agent.id}</span>
                          <span className="kb-agent-hint">
                            {agent.supported
                              ? '开启后该 Agent 可在回答中主动检索并引用历史会话'
                              : '该通道不支持工具调用，仅享受首轮自动注入'}
                          </span>
                        </div>
                        {agent.supported ? (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={agent.enabled}
                            aria-label={`${agent.name || agent.id} 主动检索`}
                            className={`kb-switch${agent.enabled ? ' is-on' : ''}`}
                            data-kb-tool-toggle
                            data-kb-tool-enabled={agent.enabled ? 'true' : 'false'}
                            disabled={toolBusy === agent.id}
                            onClick={() => void toggleAgentTool(agent.id, !agent.enabled)}
                          >
                            <span className="kb-switch-track" aria-hidden="true">
                              <span className="kb-switch-thumb" />
                            </span>
                            <span className="kb-switch-text">
                              {toolBusy === agent.id
                                ? '保存中…'
                                : agent.enabled
                                  ? '已开启'
                                  : '已关闭'}
                            </span>
                          </button>
                        ) : (
                          <span className="kb-agent-unsupported">仅自动注入</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {toolFeedback ? (
                    <p className="kb-feedback" data-kb-tool-feedback role="status">
                      {toolFeedback}
                    </p>
                  ) : null}
                </section>
              ) : null}

              <section className="kb-section" data-kb-search-section>
                <div className="kb-section-head">
                  <h3 className="kb-section-title">检索</h3>
                  <p className="kb-section-desc">在「{KB_SCOPE_LABEL[scope]}」范围内搜索对话，来源卡只读脱敏摘要。</p>
                </div>
                <div className="kb-search">
                  <input
                    className="kb-input"
                    data-kb-search-input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') void runSearch();
                    }}
                    placeholder={notIndexed ? '建立索引后可检索' : '搜索对话内容'}
                    disabled={notIndexed || searching}
                  />
                  <button
                    type="button"
                    className="kb-btn kb-btn-primary"
                    data-kb-search-action
                    disabled={notIndexed || searching || !query.trim()}
                    onClick={() => void runSearch()}
                  >
                    <Search size={14} strokeWidth={1.5} aria-hidden="true" />
                    {searching ? '检索中…' : '检索'}
                  </button>
                </div>
                {searchError ? <p className="kb-inline-error">{searchError}</p> : null}
                {searchResult ? (
                  <div className="kb-results" data-kb-results>
                    <p className="kb-results-meta">
                      返回 {searchResult.hits.length} 条 · 注入 {searchResult.tokensUsed} tokens
                      {searchResult.filteredOut > 0
                        ? ` · 过滤 ${searchResult.filteredOut} 条`
                        : ''}
                    </p>
                    {searchResult.hits.length === 0 ? (
                      <p className="kb-empty-hits">没有检索到相关记录，可以换关键词或放宽范围。</p>
                    ) : (
                      searchResult.hits.map((hit, index) => (
                        <KbHitCard
                          key={hit.citationId}
                          hit={hit}
                          index={index}
                          agentName={
                            agents[hit.authorAgentId || hit.agentId || ''] ||
                            hit.authorAgentId ||
                            hit.agentId ||
                            '未记录 Agent'
                          }
                          sessionTitle={
                            sessions[hit.sessionId]?.title ||
                            (sessions[hit.sessionId] ? '未命名会话' : `会话 ${hit.sessionId.slice(0, 8)}`)
                          }
                          onOpenConversation={openConversation}
                        />
                      ))
                    )}
                  </div>
                ) : null}
              </section>

              <section className="kb-section" data-kb-maintenance>
                <div className="kb-section-head">
                  <h3 className="kb-section-title">回填与重建</h3>
                  <p className="kb-section-desc">回填只补历史切片；重建会清空索引后重新生成，均不影响聊天记录。</p>
                </div>
                <div className="kb-row-actions">
                  <button
                    type="button"
                    className="kb-btn"
                    data-kb-backfill="recent"
                    disabled={!!busy}
                    onClick={() => void runBackfill('recent')}
                  >
                    <RotateCcw size={14} strokeWidth={1.5} aria-hidden="true" />
                    {busy === 'recent' ? '正在回填…' : '近 90 天回填'}
                  </button>
                  <button
                    type="button"
                    className="kb-btn"
                    data-kb-backfill="full"
                    disabled={!!busy}
                    onClick={() => void runBackfill('full')}
                  >
                    {busy === 'full' ? '正在全量回填…' : '全量回填'}
                  </button>
                  <button
                    type="button"
                    className="kb-btn kb-btn-danger"
                    data-kb-rebuild
                    disabled={!!busy}
                    onClick={() => setConfirmRebuild(true)}
                  >
                    {busy === 'rebuild' ? '正在重建…' : '重建索引'}
                  </button>
                </div>
                {confirmRebuild ? (
                  <div className="kb-notice kb-notice-danger" data-kb-rebuild-confirm>
                    <p>重建只会重新生成索引，不影响聊天记录。已有检索结果会在重建期间暂时不可用。</p>
                    <div className="kb-inline-actions">
                      <button type="button" className="kb-btn" onClick={() => setConfirmRebuild(false)}>
                        取消
                      </button>
                      <button type="button" className="kb-btn kb-btn-danger" onClick={() => void runRebuild()}>
                        确认重建
                      </button>
                    </div>
                  </div>
                ) : null}
                {feedback ? (
                  <p
                    className={`kb-feedback${feedback.kind === 'err' ? ' is-error' : ''}`}
                    data-kb-feedback
                    role={feedback.kind === 'err' ? 'alert' : 'status'}
                  >
                    {feedback.kind === 'ok' ? (
                      <Check size={13} strokeWidth={1.5} aria-hidden="true" />
                    ) : (
                      <AlertTriangle size={13} strokeWidth={1.5} aria-hidden="true" />
                    )}
                    {feedback.text}
                  </p>
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function describeBackfill(
  result: KbBackfillResult,
  mode: 'recent' | 'full',
  rebuilt = false
): string {
  const prefix = rebuilt ? '重建完成' : mode === 'recent' ? '近 90 天回填完成' : '全量回填完成';
  const skipped = result.skippedSessions > 0 ? ` · 跳过 ${result.skippedSessions} 个会话` : '';
  return `${prefix}：${result.indexedSessions} 个会话，${result.chunks} 个切片${skipped}`;
}
