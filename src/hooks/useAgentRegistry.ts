import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RegisteredAgent } from '../types';

/**
 * Agent 注册表 hook。
 *
 * 数据来自后端 /api/agents。后端在进程内缓存探测结果（TTL 5 分钟），
 * 所以这里可以放心地在挂载时直接拉一次；只有用户点「重新探测」时才
 * 走 POST /api/agents/probe 强制刷新。
 */
export function useAgentRegistry() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  /** 强制重新探测（会真的去跑 ACP 握手 / 鉴权，耗时约 20 秒） */
  const probe = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/probe', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(Array.isArray(data.agents) ? data.agents : []);
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
    getAgent,
  };
}

export type AgentRegistry = ReturnType<typeof useAgentRegistry>;
