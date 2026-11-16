import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation, type MessageKey } from './i18n';
import { api } from './api';

/**
 * A222：把「去登录」从「打开一个一次性死链接」升级成「跟一条活着的登录流对话」。
 *
 * 旧形状（2026-11-13 真机）：按钮只是 `window.open(agent.status.authUrl)`，
 * 而那个 URL 是 8 秒探测留下的、CLI 早已退出的 state；浏览器里登录成功了，
 * 没人接回调，也没有任何地方重新探测 ⇒ 名册永远「未登录」。
 *
 * 现在：
 *   1. 出现 needs-auth 入口时**预先**向服务端要一条长等待的登录流（单飞，
 *      重复挂载不会起第二个 CLI），拿到活链接后按钮优先开它；
 *   2. 轮询登录结果，成功后由消费方触发「重新探测」；
 *   3. `window.open` 仍在**点击回调里同步调用一次** —— 既满足浏览器/Electron
 *      的用户手势要求，也保持既有的产品契约（夹具正是从参数层断言它）。
 *
 * 服务端没有这两条端点（老版本 / 测试夹具）时静默降级：按钮照旧打开
 * `fallbackUrl`，不报错、不阻塞主流程。
 */
export type LoginPhase =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'timed-out'
  | 'busy';

const TERMINAL = new Set<LoginPhase>(['succeeded', 'failed', 'timed-out']);

const LABEL_KEY: Record<LoginPhase, MessageKey | ''> = {
  idle: '',
  starting: 'agent.login.starting',
  waiting: 'agent.login.waiting',
  succeeded: 'agent.login.succeeded',
  failed: 'agent.login.failed',
  'timed-out': 'agent.login.timeout',
  busy: 'agent.login.busy',
};

interface LoginSnapshot {
  state?: string;
  authUrl?: string;
  error?: string;
}

export interface AgentLoginController {
  phase: LoginPhase;
  label: string;
  terminal: boolean;
  ok: boolean;
  /**
   * 现在是否有一个**能收回调**的地址可开。
   *
   * 关键：探测留下的 `fallbackUrl` 是 8 秒探测的一次性 state，那条 CLI
   * 早就退出了。登录流已经启动却还没拿到活链接时，宁可把按钮短暂禁用，
   * 也绝不把用户送回那个死地址 —— 这正是 21:44 那张「登录后仍显示未登录」
   * 的截图来源。只有「根本没有登录流」（老服务端 / 夹具）才允许退回旧地址。
   */
  canOpen: boolean;
  /** 在点击回调里同步打开一次登录页 */
  openLogin: () => void;
  /** 流结束后重新要一条活链接 */
  restart: () => void;
}

const isHttpUrl = (v: unknown): v is string =>
  typeof v === 'string' && /^https?:\/\//i.test(v.trim());

export function useAgentLogin(
  agentId: string | undefined,
  fallbackUrl: string | undefined,
  onSettled?: (ok: boolean) => void
): AgentLoginController {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<LoginPhase>('idle');
  const phaseRef = useRef<LoginPhase>('idle');
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const liveUrlRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const settledRef = useRef(false);
  const pollRef = useRef<number | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const apply = useCallback((snap: LoginSnapshot | null) => {
    const raw = typeof snap?.state === 'string' ? snap.state : '';
    const valid = TERMINAL.has(raw as LoginPhase) ||
      ['idle', 'starting', 'waiting', 'busy'].includes(raw);
    const next: LoginPhase = valid ? (raw as LoginPhase) : 'idle';
    phaseRef.current = next;
    setPhase(next);
    // A222：终态那条 CLI 已经退出，它留下的 authUrl 是死链接。哪怕服务端快照
    // 里还带着，也必须当场清掉 —— 否则失败/超时后再点一次「去登录」又会被送回
    // 过期 state，正是这次真机问题里最刺眼的一步。
    if (TERMINAL.has(next)) {
      liveUrlRef.current = null;
      setLiveUrl(null);
    } else if (isHttpUrl(snap?.authUrl)) {
      liveUrlRef.current = snap.authUrl.trim();
      setLiveUrl(snap.authUrl.trim());
    }
    if (TERMINAL.has(next) && !settledRef.current) {
      settledRef.current = true;
      onSettledRef.current?.(next === 'succeeded');
    }
  }, []);

  const poll = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await api.get(
        `/api/agents/${encodeURIComponent(agentId)}/login/status`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      apply((await res.json()) as LoginSnapshot);
    } catch {
      // 老服务端 / 夹具没有这条端点：保持 idle，按钮用 fallbackUrl
    }
  }, [agentId, apply]);

  const ensurePolling = useCallback(() => {
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => {
      void poll();
      if (TERMINAL.has(phaseRef.current) && pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 1500);
  }, [poll]);

  const start = useCallback(async () => {
    if (!agentId) return;
    settledRef.current = false;
    liveUrlRef.current = null;
    setLiveUrl(null);
    // 乐观置为 starting：POST 还在飞的那几十毫秒里也不许打开旧的死链接。
    // 服务端不支持登录流时立刻回落 idle，夹具 / 老版本照旧用 fallbackUrl。
    phaseRef.current = 'starting';
    setPhase('starting');
    const fallback = () => {
      phaseRef.current = 'idle';
      setPhase('idle');
    };
    try {
      const res = await api.post(
        `/api/agents/${encodeURIComponent(agentId)}/login/start`,
        {
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }
      );
      if (!res.ok) return fallback();
      apply((await res.json()) as LoginSnapshot);
    } catch {
      fallback();
    }
  }, [agentId, apply]);

  const restart = useCallback(() => {
    void start();
    ensurePolling();
  }, [start, ensurePolling]);

  useEffect(() => {
    if (!agentId || !fallbackUrl || startedRef.current) return;
    startedRef.current = true;
    void start();
    ensurePolling();
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [agentId, fallbackUrl, start, ensurePolling]);

  const canOpen = Boolean(liveUrl) || (phase === 'idle' && Boolean(fallbackUrl));

  const openLogin = useCallback(() => {
    // 同步、恰好一次：Electron 的 setWindowOpenHandler 会把它转交系统浏览器。
    // 只有 idle（没有登录流）才允许用 fallbackUrl；流在跑但链接还没回来时
    // 什么都不开，等下一次轮询把活链接带回来。
    const url =
      liveUrlRef.current ??
      (phaseRef.current === 'idle' ? fallbackUrl : undefined);
    if (url) window.open(url, '_blank', 'noopener');
    // 点过一次之后流已结束（超时/失败）→ 顺便重新要一条活链接，
    // 用户再点「去登录」时打开的就是新的 state。
    if (TERMINAL.has(phaseRef.current)) restart();
  }, [fallbackUrl, restart]);

  const key = LABEL_KEY[phase];
  return {
    phase,
    label: key ? t(key) : '',
    terminal: TERMINAL.has(phase),
    ok: phase === 'succeeded',
    canOpen,
    openLogin,
    restart,
  };
}
