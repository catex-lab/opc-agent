import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RegisteredAgent } from '../types';
import {
  createSingleProbeRunner,
  probeFeedbackFromResult,
  type AgentProbeFeedback,
} from '../agentProbe';

/**
 * Agent 注册表 hook。
 *
 * 数据来自后端 /api/agents。后端在进程内缓存探测结果（TTL 5 分钟），
 * 所以这里可以放心地在挂载时直接拉一次；只有用户点「重新探测」时才
 * 走 POST /api/agents/probe 强制刷新。
 *
 * A177：单个 Agent 的「重新探测」走 `probeOne()`（POST /api/agents/:id/probe），
 * 不再顺带全量。全量按钮仍然保留在通讯录顶部，语义没有变。
 */
export function useAgentRegistry() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在探测中的 agentId 集合：按钮据此进入 loading 并禁用 */
  const [probingIds, setProbingIds] = useState<Set<string>>(new Set());
  /** 每个 Agent 最近一次单探测的反馈（时间戳 / 耗时 / 失败原因） */
  const [probeFeedback, setProbeFeedback] = useState<Record<string, AgentProbeFeedback>>({});
  /** 避免 StrictMode 下重复请求 */
  const fetchedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch (err) {
      setError((err as Error).message || '获取 Agent 列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 单 Agent 探测协调器。
   *
   * `onSuccess` 只改一个条目（按 agentId 精确匹配），因此其他 Agent 的
   * 状态、探测时间戳、顺序全部原样保留 —— 这是「单探测隔离性」的 UI 侧保证。
   */
  const singleProbeRunner = useMemo(
    () =>
      createSingleProbeRunner({
        onStart: agentId => {
          setProbingIds(prev => {
            const next = new Set(prev);
            next.add(agentId);
            return next;
          });
          setProbeFeedback(prev => ({ ...prev, [agentId]: { state: 'probing' } }));
        },
        onSuccess: (agentId, data) => {
          setAgents(prev =>
            prev.map(agent => (agent.id === agentId ? { ...agent, status: data.status } : agent))
          );
          setProbeFeedback(prev => ({ ...prev, [agentId]: probeFeedbackFromResult(data) }));
          setProbingIds(prev => {
            if (!prev.has(agentId)) return prev;
            const next = new Set(prev);
            next.delete(agentId);
            return next;
          });
        },
        onFailure: (agentId, feedback) => {
          setProbeFeedback(prev => ({ ...prev, [agentId]: feedback }));
          setProbingIds(prev => {
            if (!prev.has(agentId)) return prev;
            const next = new Set(prev);
            next.delete(agentId);
            return next;
          });
        },
      }),
    []
  );

  /** 只重新探测指定的一个 Agent（同一 Agent 并发点击复用同一个请求） */
  const probeOne = useCallback(
    (agentId: string) => singleProbeRunner(agentId),
    [singleProbeRunner]
  );

  /** 强制重新探测（会真的去跑 ACP 握手 / 鉴权，耗时约 20 秒） */
  const probe = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/probe', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(Array.isArray(data.agents) ? data.agents : []);
      setProbeFeedback({});
    } catch (err) {
      setError((err as Error).message || '探测失败');
    } finally {
      setProbing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void load();
  }, [load]);

  /**
   * 探测在后端是**后台**跑的（ACP 握手 20 秒以上，不能把首次请求挂住），
   * 所以第一次拉到的状态可能还是 unknown。这里轮询补齐，避免通讯录一直
   * 停在「未探测」——那会让用户以为所有 Agent 都没接上。
   */
  const pollCount = useRef(0);
  useEffect(() => {
    const hasUnknown = agents.some(a => a.status.availability === 'unknown');
    if (!hasUnknown) {
      pollCount.current = 0;
      return;
    }
    if (pollCount.current >= 20) return; // 上限约 60 秒，避免探测一直失败时空转
    const timer = setTimeout(() => {
      pollCount.current += 1;
      void load();
    }, 3000);
    return () => clearTimeout(timer);
  }, [agents, load]);

  const getAgent = useCallback(
    (id: string | undefined) => (id ? agents.find(a => a.id === id) : undefined),
    [agents]
  );

  /**
   * 低频重拉（只读缓存，不触发新的探测）。
   *
   * 为什么需要：Codex / Claude / Kimi Code 的「用前校验」发生在**发送第一条
   * 消息时**，结果只写回后端名册缓存；前端不重拉就看不到绿点撤回。
   * 60 秒只是兜底节奏 —— 用户打开通讯录或手动重新探测都会立刻刷新。
   */
  useEffect(() => {
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  /** 按状态分组，供通讯录展示 */
  const grouped = useMemo(() => {
    const ready: RegisteredAgent[] = [];
    const actionNeeded: RegisteredAgent[] = [];
    const unavailable: RegisteredAgent[] = [];
    for (const a of agents) {
      const s = a.status.availability;
      if (s === 'ready') ready.push(a);
      // unreachable 也归入「待处理」：它已安装、凭据也可能齐全，
      // 用户要做的动作是查网络/代理 —— 属于「可处理」，不是「本机没这个东西」
      else if (s === 'needs-auth' || s === 'needs-setup' || s === 'unreachable') {
        actionNeeded.push(a);
      } else unavailable.push(a);
    }
    return { ready, actionNeeded, unavailable };
  }, [agents]);

  const readyCount = grouped.ready.length;

  return {
    agents,
    grouped,
    readyCount,
    loading,
    probing,
    error,
    load,
    probe,
    probeOne,
    probingIds,
    probeFeedback,
    getAgent,
  };
}

export type AgentRegistry = ReturnType<typeof useAgentRegistry>;
