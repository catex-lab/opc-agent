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
 * A233（2026-11-19 真机）：A222 的「挂载即预启动登录流」又造出了一个更糟的
 * 形状 —— 资料页/错误卡一出现就 POST /login/start，而 CLI 每次 authenticate
 * 都会自己 `UrlUtils.openUrl()` 弹系统浏览器。用户什么都没点，浏览器却无限
 * 弹登录；每条新流还会顶掉上一条（`Login was superseded`）。
 *
 * 现行契约：
 *   1. **只有点击才起流**，挂载不再有任何副作用；
 *   2. 服务端侧已给登录子进程注入 `BROWSER=__opc_no_browser__`，CLI 不再自己
 *      弹浏览器 —— 浏览器只由这里打开，点一次开一次；
 *   3. 点击时没有活链接，就先起流，等 authUrl 异步回来再补开（补开走主进程
 *      `opc:open-external`，不受弹窗拦截影响）；
 *   4. 轮询登录结果，成功后由消费方触发「重新探测」；
 *   5. 服务端没有这两条端点（老版本 / 测试夹具）时静默降级：退回 `fallbackUrl`。
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
  const settledRef = useRef(false);
  const pollRef = useRef<number | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  /** 用户点了「去登录」但活链接还没回来：链接一到就替他打开一次 */
  const pendingOpenRef = useRef(false);

  const openLive = useCallback((url: string) => {
    // 优先走主进程 IPC：它不在浏览器弹窗拦截的管辖范围内，异步到达也能打开。
    // 纯浏览器开发态没有这个桥，退回 window.open。
    const bridge = (window as unknown as {
      opc?: { externalOpen?: (target: string) => Promise<boolean> };
    }).opc?.externalOpen;
    if (typeof bridge === 'function') {
      void bridge(url);
      return;
    }
    window.open(url, '_blank', 'noopener');
  }, []);

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
      pendingOpenRef.current = false;
    } else if (isHttpUrl(snap?.authUrl)) {
      const url = snap.authUrl.trim();
      liveUrlRef.current = url;
      setLiveUrl(url);
      // A233：点击后才启动的流，链接异步到达时补开一次 —— 只在用户点过之后开
      if (pendingOpenRef.current) {
        pendingOpenRef.current = false;
        openLive(url);
      }
    }
    // 别的 Agent 占着登录流：这次点击没轮到我们，清掉「待打开」，
    // 避免之后属于别人的 authUrl 被我们补开一次。
    if (next === 'busy') pendingOpenRef.current = false;
    if (TERMINAL.has(next) && !settledRef.current) {
      settledRef.current = true;
      onSettledRef.current?.(next === 'succeeded');
    }
  }, [openLive]);

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

  const start = useCallback(async (): Promise<boolean> => {
    if (!agentId) return false;
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
      if (!res.ok) {
        fallback();
        return false;
      }
      apply((await res.json()) as LoginSnapshot);
      return true;
    } catch {
      fallback();
      return false;
    }
  }, [agentId, apply]);

  const restart = useCallback(() => {
    void start();
    ensurePolling();
  }, [start, ensurePolling]);

  // A233：**不再在挂载时自动起登录流**。旧实现只要资料页/错误卡一出现就
  // POST /login/start，而每一条流都会让 CLI 生成新的 state（并顶掉别的登录），
  // 用户看到的就是「没点任何东西，浏览器一直弹登录」。现在只有点击才起流。
  // 这里只负责卸载时收掉轮询。
  useEffect(
    () => () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    },
    []
  );

  const canOpen = Boolean(liveUrl) || (phase === 'idle' && Boolean(fallbackUrl));

  const openLogin = useCallback(() => {
    // 有活链接直接开（点击手势内，同步一次）。
    const live = liveUrlRef.current;
    if (live) {
      openLive(live);
      return;
    }
    // 没有活链接：起一条流，等它把 authUrl 带回来再替用户打开一次。
    // 绝不把探测留下的 fallbackUrl 当主入口 —— 那是 CLI 早已退出的一次性 state。
    pendingOpenRef.current = true;
    ensurePolling();
    void start().then(accepted => {
      if (accepted || !pendingOpenRef.current) return;
      // 老服务端 / 夹具没有登录端点：保持既有降级，退回 fallbackUrl 打开一次
      pendingOpenRef.current = false;
      const fallback = phaseRef.current === 'idle' ? fallbackUrl : undefined;
      if (fallback) openLive(fallback);
    });
  }, [ensurePolling, fallbackUrl, openLive, start]);

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
