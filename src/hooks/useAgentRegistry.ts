import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComingSoonAgent, RegisteredAgent } from '../types';
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
  /**
   * A210「即将接入」占位清单。**与 agents 完全隔离的独立 state**：
   * 它不参与 grouped / readyCount / getAgent / 轮询判定，因此不可能被
   * 当成可选 Agent，也不可能被画出一个装不上的安装按钮。
   */
  const [comingSoon, setComingSoon] = useState<ComingSoonAgent[]>([]);
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
      setComingSoon(Array.isArray(data.comingSoon) ? data.comingSoon : []);
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
      setComingSoon(Array.isArray(data.comingSoon) ? data.comingSoon : []);
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
    // P1：canary「检测中」同样驱动轮询——SDK 冷启动预算 120s，给足 50 拍（约 2.5 分钟）
    const hasChecking = agents.some(a => a.status.lastCanary?.state === 'checking');
    if (!hasUnknown && !hasChecking) {
      pollCount.current = 0;
      return;
    }
    if (pollCount.current >= (hasUnknown ? 20 : 50)) return;
    const timer = setTimeout(() => {
      pollCount.current += 1;
      void load();
    }, 3000);
    return () => clearTimeout(timer);
  }, [agents, load]);

  /**
   * P1：手动「真实检测」。force = 服务端不受 TTL 频控。
   * 立刻拉一次把 checking 状态带回来，后续由上面的 checking-aware 轮询收回结果。
   */
  const canaryAll = useCallback(async () => {
    try {
      await fetch('/api/agents/canary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      /* 结果轮询会兜底 */
    }
    void load();
  }, [load]);

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

  /**
   * A222：从系统浏览器登录完回到应用时立刻重拉名册。
   *
   * 这里**只重拉、不重新探测**：探测的强制重探已由服务端在登录流
   * `onSettled` 时做过一次（`configureLoginFlowHooks`），再在前端每个焦点
   * 事件上 probe 一次只会重新起 CLI、把刚写好的会话又搅一遍。
   * 后端缓存是新的，重拉就够让绿点回来。
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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
    comingSoon,
    grouped,
    readyCount,
    loading,
    probing,
    error,
    load,
    probe,
    canaryAll,
    probeOne,
    probingIds,
    probeFeedback,
    getAgent,
  };
}

export type AgentRegistry = ReturnType<typeof useAgentRegistry>;
