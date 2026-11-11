/**
 * 聊天里收到 auth 类错误后的**自动善后**。
 *
 * ## 为什么要有这一层
 *
 * 用户报的形态：WorkBuddy 的登录态停在今年 9 月（keyblob 不再刷新），名册
 * 因为探测只读本地缓存而一直挂「在线」，直到发消息必 401 才露馅 —— 而聊天
 * 里那颗红色「调用失败」卡除了报错，什么都不做。探测**无法提前**发现这种
 * 过期（authenticate 只读本地缓存、不发业务请求），但**错误发生后**我们必须
 * 尽快把「这个 Agent 现在拒绝我」反映到名册上，而不是等 5 分钟 TTL 自然过期。
 *
 * 做两件事（单聊 /api/chat 与群聊 turn-runner 都会调）：
 *   1. 判定这条错误是不是 auth 类 —— **复用 recovery.ts 的 classifyFailure**
 *      （AUTH_RE 的唯一口径），在这里抄第二份正则必然漂移；
 *   2. 是 → 对该 Agent 立刻 force re-probe（`probeOne(id, true)` 绕过 5 分钟
 *      TTL —— 刚收到的 401 是比缓存新的事实）。探测若能把状态翻成
 *      needs-auth 就翻；翻不动（比如 WorkBuddy 的本地缓存还「看起来登录着」）
 *      也不谎报 —— 名册会以 `lastError` 带上这次真实收到的 401。
 *
 * ## 边界（刻意不做）
 *
 *   - 不重发消息：prompt 可能已在 CLI 侧执行了一半，重放有双重副作用风险
 *     （与 sdk.ts 的「不做轮内重试」同一理由）；
 *   - 不伪造校验端点：SDK 的 authenticate 没有真实校验能力，探测结果是什么
 *     就呈现什么，`lastError` 才是这次 401 的诚实载体；
 *   - 不碰 `~/.workbuddy`。
 */

import { classifyFailure } from './recovery.js';
import { registry } from './registry.js';

/** 同一 Agent 的 re-probe 防抖窗口：群聊一轮多个成员同时 401 时只探一次 */
const REPROBE_DEBOUNCE_MS = 60_000;

/** 最近一次触发 re-probe 的时刻（agentId → epoch ms） */
const recentReprobe = new Map<string, number>();

/** 这条错误是不是 auth 类（401/403/凭据失效/未登录…口径在 recovery.ts） */
export function isAuthFailure(message: string): boolean {
  return classifyFailure(message ?? '') === 'auth';
}

/**
 * auth 类聊天错误发生时对该 Agent 自动 re-probe 一次。
 *
 * 为什么探测完成后还要 `recordError` 补一次：`startProbe` 会**整份覆盖**
 * 状态缓存，而 `withProbeOutcome` 对 ready 结果会**丢掉** lastError ——
 * WorkBuddy 的探测恰恰很容易返回 ready（本地缓存里还留着账号）。
 * 不补这一笔，刚收到的 401 就被一次「看起来一切正常」的探测抹掉了，
 * 名册会退回「在线、没有上次失败」的自欺状态。
 * `appendFailureAdvice` 幂等，重复记录不会叠加话术。
 *
 * fire-and-forget：善后不该阻塞或打断聊天流；探测失败静默（探测本身
 * 有自己的「探测失败」状态呈现）。
 */
export function maybeReprobeOnAuthError(agentId: string, message: string): void {
  if (!isAuthFailure(message)) return;
  if (!registry.hasAgent(agentId)) return;

  const now = Date.now();
  const last = recentReprobe.get(agentId) ?? 0;
  if (now - last < REPROBE_DEBOUNCE_MS) return;
  recentReprobe.set(agentId, now);

  console.log(`[Auth] ${agentId} 聊天中收到鉴权错误，自动重新探测（绕过 TTL 缓存）`);
  void registry
    .probeOne(agentId, true)
    .then(() => {
      // 探测会覆盖状态缓存；把这次真实收到的 401 补回 lastError，
      // 让名册/详情页的「上次失败」与刚发生的现实一致。
      registry.recordError(agentId, message);
    })
    .catch((err: unknown) => {
      console.error(
        `[Auth] ${agentId} 自动 re-probe 失败（忽略）:`,
        (err as Error)?.message ?? err
      );
    });
}

/** 仅供验证脚本复位防抖状态（生产代码不要调） */
export function resetAuthReprobeDebounceForTest(): void {
  recentReprobe.clear();
}
