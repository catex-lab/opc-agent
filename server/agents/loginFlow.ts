/**
 * A222：WorkBuddy 登录流的**全局单点持有者**。
 *
 * ## 为什么必须有这一层
 *
 * 2026-11-13 真机复盘（见当天工作日志）：用户桌面端已经登录，OPC Agent 却一直
 * 显示「未登录」，点「去登录」完成网页登录后仍不变。日志里 21:39–21:46 有
 * 10+ 个不同 pid 同时 `Opening auth URL`（每个 state 都不同）、反复
 * `AuthRefresh failed (401 / account list is empty)`、`userId -> <empty>` 和
 * `Login was superseded by a concurrent logout`。根因不是「桌面端没登录」，
 * 而是我们自己的三条链路各自 `unstable_v2_authenticate()`：
 *
 *   1. `SdkAdapter.probe()` —— 8 秒预算，收到 authUrl 就把一次性 URL 存进
 *      **模块级全局** `lastAuthUrl`；8 秒后 CLI 已死，URL 却还在名册里。
 *   2. `GET /api/check-login` —— 连显式 timeout 都没给，走 SDK 默认 300 秒，
 *      于是一个「查登录」的 GET 就会起一个并发登录流并挂住 5 分钟。
 *   3. 用户点的「去登录」按钮 —— 只是 `window.open` 那个早已失效的 URL，
 *      既不重开登录流，也不在登录完成后重新探测。
 *
 * 三者共用 `~/.workbuddy-ai` 一份会话文件，谁的成功都会被别人的 logout 顶掉。
 *
 * ## 这里的三条硬规矩
 *
 * - **全局单飞**：整个进程同一时刻只跑一个 `unstable_v2_authenticate`。探测与
 *   `/api/check-login` 看到有流在跑就**直接让路**（`isLoginFlowActive()`），
 *   绝不再起第二个 CLI。跨 Agent 也只让一个：`workbuddy` 与 `codebuddy` 共用
 *   官方配置根时，两个流一样会互相顶掉。
 * - **URL 归活着的进程**：`authUrl` 由这条 300 秒长等待的流自己生成，只在它
 *   还活着的时候才有效；流结束后快照仍可读（前端要拿到 succeeded），但
 *   `isLoginFlowActive()` 立刻为 false，别人不会再拿旧 URL 当入口。
 * - **成功即作废缓存**：`invalidateWorkbuddyProfile()` 让下一次探测重新读官方
 *   产品配置，`onSettled` 钩子再触发强制重探 —— 不靠前端 60 秒的「只重拉
 *   缓存」自己变绿。
 *
 * ## 可注入的 authenticate（供闸门做行为级验证）
 *
 * 默认用真 SDK；闸门通过 `authenticateImpl` 注入一个会按脚本 emit authUrl /
 * resolve / reject 的假实现，就能在没有真 CLI、没有网络的情况下把整条状态机
 * 跑一遍，并用反向探针证明断言不是恒绿。生产代码永远不传这个参数。
 */
import { unstable_v2_authenticate } from '@tencent-ai/agent-sdk';
import { findDef } from './definitions.js';
import { applyWorkbuddyProfile, invalidateWorkbuddyProfile } from './wbProductProfile.js';
import { resolveSdkRuntime, type SdkRuntime } from './sdkRuntime.js';

/** 与 SDK 默认 300000 对齐：给用户在浏览器里完成登录留出真实时间 */
export const LOGIN_FLOW_TIMEOUT_MS = 300_000;

export type LoginFlowState =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'timed-out'
  | 'busy';

export interface LoginFlowSnapshot {
  agentId: string | null;
  state: LoginFlowState;
  /** 只有 http(s) 地址才会被下发；一次性 state 绝不写日志 */
  authUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** state=busy 时告诉调用方是谁占着 */
  busyAgentId?: string;
}

interface Flow {
  agentId: string;
  state: Exclude<LoginFlowState, 'idle' | 'busy'>;
  authUrl?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface LoginFlowHooks {
  /** 流拿到可用登录地址（可用来把名册里的 URL 换成活的） */
  onAuthUrlReady?: (agentId: string, authUrl: string) => void;
  /** 流结束；ok=true 表示拿到了登录结果 */
  onSettled?: (agentId: string, ok: boolean) => void;
}

type AuthenticateImpl = (options: {
  environment?: string;
  endpoint?: string;
  env?: Record<string, string>;
  timeout?: number;
  onAuthUrl?: (state: { authUrl?: string }) => void | Promise<void>;
}) => Promise<unknown>;

export interface StartLoginFlowOptions {
  /** 闸门注入桩；生产不传 */
  authenticateImpl?: AuthenticateImpl;
  /** 闸门注入运行参数，避免读真实官方配置 */
  runtime?: SdkRuntime;
  /** 闸门注入更短的预算 */
  timeoutMs?: number;
}

let hooks: LoginFlowHooks = {};
/** 最近一次（或正在进行的）流。终态保留快照，供前端轮询读结果 */
let current: Flow | null = null;

export function configureLoginFlowHooks(next: LoginFlowHooks): void {
  hooks = { ...hooks, ...next };
}

/** 仅供验证脚本复位单例状态（生产代码不要调） */
export function resetLoginFlowForTest(): void {
  current = null;
}

const TERMINAL: ReadonlySet<LoginFlowState> = new Set(['succeeded', 'failed', 'timed-out']);

/** 是否有一个**正在进行**的登录流（终态不算，否则成功后永远让路） */
export function isLoginFlowActive(agentId?: string): boolean {
  if (!current || TERMINAL.has(current.state)) return false;
  return agentId ? current.agentId === agentId : true;
}

/** 活着的流才配发 URL：终态的 authUrl 是过期的一次性 state，绝不复用 */
export function activeLoginFlowAuthUrl(agentId?: string): string | null {
  if (!isLoginFlowActive(agentId)) return null;
  return current?.authUrl ?? null;
}

function snapshotOf(flow: Flow): LoginFlowSnapshot {
  // A222：终态的 authUrl 是已退出 CLI 的一次性 state。状态快照保留它是给前端
  // 「读结果」用的，不该顺手把死链接再发一次 —— 否则失败/超时后重试就又点回旧地址。
  const live = !TERMINAL.has(flow.state);
  return {
    agentId: flow.agentId,
    state: flow.state,
    ...(live && flow.authUrl ? { authUrl: flow.authUrl } : {}),
    startedAt: flow.startedAt,
    ...(flow.finishedAt ? { finishedAt: flow.finishedAt } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  };
}

/**
 * 读取登录流状态。传了 agentId 但当前流属于别人时返回 `busy`，
 * 前端据此显示「另一个登录正在进行」而不是再开一个。
 */
export function loginFlowStatus(agentId?: string): LoginFlowSnapshot {
  if (!current) return { agentId: agentId ?? null, state: 'idle' };
  if (agentId && current.agentId !== agentId && !TERMINAL.has(current.state)) {
    return { agentId, state: 'busy', busyAgentId: current.agentId };
  }
  if (agentId && current.agentId !== agentId) {
    return { agentId, state: 'idle' };
  }
  return snapshotOf(current);
}

/**
 * 启动（或复用）登录流。**同步返回快照**，不把 HTTP 请求挂到 300 秒：
 * 前端靠 `GET /login/status` 轮询状态与 authUrl。
 *
 * 单飞语义：同一 Agent 重复调用直接返回同一个流；别的 Agent 正在登录时
 * 返回 `busy`，不新建进程。
 */
export function startLoginFlow(
  agentId: string,
  options: StartLoginFlowOptions = {}
): LoginFlowSnapshot {
  if (isLoginFlowActive()) return loginFlowStatus(agentId);

  const runtime =
    options.runtime ??
    resolveSdkRuntime(applyWorkbuddyProfile(findDef(agentId)?.sdk, agentId));
  const timeoutMs = options.timeoutMs ?? LOGIN_FLOW_TIMEOUT_MS;
  const authenticate =
    options.authenticateImpl ??
    (unstable_v2_authenticate as unknown as AuthenticateImpl);

  const flow: Flow = {
    agentId,
    state: 'starting',
    startedAt: new Date().toISOString(),
  };
  current = flow;

  let settled = false;
  const settle = (state: 'succeeded' | 'failed' | 'timed-out', error?: string) => {
    if (settled) return;
    settled = true;
    flow.state = state;
    flow.finishedAt = new Date().toISOString();
    if (error) flow.error = error;
    if (state === 'succeeded') invalidateWorkbuddyProfile();
    hooks.onSettled?.(agentId, state === 'succeeded');
  };

  // 看门狗：SDK 自己有 timeout，但 CLI 卡死时 transport 可能不兑现；
  // 到点强制收口并释放单飞，别让「登录中」永久占着锁。
  const watchdog = setTimeout(() => {
    settle('timed-out', `登录等待超过 ${Math.round(timeoutMs / 1000)} 秒`);
  }, timeoutMs + 5_000);
  watchdog.unref?.();

  void (async () => {
    try {
      await authenticate({
        ...runtime,
        timeout: timeoutMs,
        onAuthUrl: async authState => {
          const url = authState?.authUrl;
          if (!url || !/^https?:\/\//i.test(url)) return;
          flow.authUrl = url;
          if (flow.state === 'starting') flow.state = 'waiting';
          hooks.onAuthUrlReady?.(agentId, url);
        },
      });
      settle('succeeded');
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      settle(/timed?\s*out|超时/i.test(message) ? 'timed-out' : 'failed', message);
    } finally {
      clearTimeout(watchdog);
    }
  })();

  return snapshotOf(flow);
}

// ============= 纯函数：给闸门做行为断言，不依赖 SDK / 网络 =============

/** 面向用户的登录流文案。tone 只用于配色，不引入第三套颜色令牌。 */
export function loginFlowView(snapshot: LoginFlowSnapshot): {
  label: string;
  tone: 'idle' | 'pending' | 'success' | 'error';
} {
  switch (snapshot.state) {
    case 'starting':
      return { label: '正在准备登录链接…', tone: 'pending' };
    case 'waiting':
      return { label: '等待浏览器完成登录…', tone: 'pending' };
    case 'succeeded':
      return { label: '登录完成，正在刷新状态…', tone: 'success' };
    case 'failed':
      return { label: '登录未完成，请重试', tone: 'error' };
    case 'timed-out':
      return { label: '登录等待超时，请重试', tone: 'error' };
    case 'busy':
      return { label: '另一个登录正在进行…', tone: 'pending' };
    default:
      return { label: '', tone: 'idle' };
  }
}

/**
 * 点「去登录」时该开哪个地址：**只认活着的流**。
 *
 * `fallback` 是探测侧给的老地址，只在流还没准备好（或服务端是旧版本 /
 * 夹具没实现 login 端点）时才用 —— 它是一次性 state，不能当主入口。
 */
export function resolveLoginUrl(
  live: string | null | undefined,
  fallback: string | null | undefined
): string | null {
  const clean = (v: string | null | undefined): string | null =>
    typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
  return clean(live) ?? clean(fallback);
}
