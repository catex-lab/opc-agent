/**
 * 真实健康度检测（canary）—— 接入架构收敛方案 P1。
 *
 * ## 它解决什么问题
 *
 * 名册状态过去来自探测启发式（二进制在不在、凭据文件在不在、版本号能不能
 * 打出来），它与「真实可用」是两套真相：A222 的登录态失效、A155 的 initialize
 * 超时、antigravity 的钥匙串——全是「猜错」的实例。canary 把状态的定义改成
 * **最近一次真实最小调用**：发一条 `ping`，等首个内容事件即判 OK；失败按
 * 诊断契约（shared/diagnostics）归类。
 *
 * ## 边界（写死）
 *
 * - **消息不落库**：canary 不经过 /api/chat，不写 chat.db。各 CLI 自己的
 *   会话文件由厂商写（每次 canary 会多一个微小会话，TTL 30 分钟限制了量级）；
 * - **工具全拒**：ping 不需要工具，`allowedTools: []` 全部拒绝（SendContext
 *   的排他语义），杜绝「检测时顺手改了用户文件」；
 * - **首个内容事件即中止**：拿到「活着」的证据后立刻 abort，不再烧 token；
 * - **frequency**：自动触发每 Agent 每 TTL 至多一次；手动「重新检测」不受限；
 * - **不假装实时**：两次 canary 之间名册显示的是上次结果，UI 会带时间。
 */

import type { Diagnostic, DiagnosticClass } from '../../shared/diagnostics.js';
import { classifyErrorMessage, authDiagnosticFor, isAcpSessionTimeout } from '../../shared/diagnostics.js';
import { registry } from './registry.js';
import { loadPrefs } from '../preferences.js';

/** 自动检测的缓存期。TTL 内不重复烧用户的额度 */
export const CANARY_TTL_MS = 30 * 60 * 1000;
/** 自动检测的并发上限（与探测的 2 并发同一纪律，避免冷启动风暴） */
const AUTO_CONCURRENCY = 2;

/** 各通道的检测预算。SDK 冷启动慢（A214 首字护栏 120s），预算对齐防误报 */
function budgetFor(kind: string): number {
  switch (kind) {
    case 'sdk':
      return 120_000;
    case 'acp':
      return 45_000;
    case 'http':
      return 30_000;
    case 'cli':
    default:
      return 30_000;
  }
}

/** 纯函数：该 Agent 现在是否需要跑自动 canary（闸门直接测） */
export function shouldAutoCanary(
  lastCanaryAt: number | undefined,
  now: number,
  ttlMs: number = CANARY_TTL_MS
): boolean {
  return lastCanaryAt === undefined || now - lastCanaryAt >= ttlMs;
}

/** 正在跑的 canary（agentId → promise）。防同 Agent 重入 */
const inflight = new Map<string, Promise<Diagnostic>>();

/** 上次自动触发时刻（频控）。手动触发不写这里 */
const lastAutoAt = new Map<string, number>();

/**
 * 跑一次真实检测。失败不抛——结论（含失败）就是返回值，调用方只管呈现。
 */
export async function runCanary(
  agentId: string,
  opts?: { budgetMs?: number }
): Promise<Diagnostic> {
  const existing = inflight.get(agentId);
  if (existing) return existing;

  const job = (async (): Promise<Diagnostic> => {
    const info = registry.get(agentId);
    if (!info) return failure('unknown', 'Agent 不存在');

    // 未安装 / 形态不支持：跑不了真实调用，结论直接沿用探测侧
    // （这两类没有「真实调用」可言，硬跑只会得到 spawn ENOENT 的噪音）
    if (info.status.availability === 'not-installed') {
      return { class: 'not_installed', at: new Date().toISOString(), source: 'canary', detail: '未安装，无法真实检测' };
    }
    if (info.status.availability === 'unsupported') {
      return { class: 'binary_broken', at: new Date().toISOString(), source: 'canary', detail: '本机形态无法无头调用' };
    }

    const kind = info.kind;
    const wasReady = info.status.availability === 'ready';
    registry.recordCanary(agentId, { state: 'checking', at: new Date().toISOString() });

    const sessionId = `canary:${agentId}:${Date.now()}`;
    const ac = new AbortController();
    // 预算可注入（闸门用短预算测超时路径，不真等 30s）
    const budget = opts?.budgetMs ?? budgetFor(kind);
    const timer = setTimeout(() => ac.abort(), budget);
    timer.unref?.();

    try {
      const stream = registry.stream(agentId, {
        sessionId,
        prompt: 'ping',
        permissionMode: 'default',
        // ping 不需要任何工具：[] = 全部拒绝（SendContext 的排他语义）
        allowedTools: [],
        answerLanguage: 'auto',
        signal: ac.signal,
      });
      if (!stream) {
        return finish(agentId, failure('binary_broken', '通道不可用（provider 未注册或已下架）'));
      }
      for await (const ev of stream) {
        if (ev.type === 'error') {
          const cls = classifyErrorMessage(ev.message);
          const final = cls === 'auth_expired' ? authDiagnosticFor(wasReady) : cls;
          // ACP 的会话创建超时：握手已通过，只是对方 gateway 不回包 ——
          // 记「部分受限」而不是「存在异常」，否则用户会被引去重装/重登。
          const diagClass = isAcpSessionTimeout(ev.message) ? 'degraded' : final;
          return finish(agentId, failure(diagClass, ev.message));
        }
        // 首个内容事件 = 通道活着、凭据被接受、模型开始产出 → 结论 OK，
        // 立刻中止省 token（ping 的答案没人看）
        if (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool') {
          return finish(agentId, { class: 'ok', at: new Date().toISOString(), source: 'canary' });
        }
        // init / usage / raw 等继续等
      }
      // 流正常结束却没有任何内容事件：零产出（A217 的形态）——诚实记 unknown
      return finish(agentId, failure('unknown', `检测超时或零产出（预算 ${Math.round(budget / 1000)}s）`));
    } catch (err) {
      return finish(agentId, failure('unknown', (err as Error)?.message || '检测异常'));
    } finally {
      clearTimeout(timer);
      // 无论结论如何都要收尸：abort 该 canary 会话的子进程/连接
      try {
        registry.abort(agentId, sessionId);
      } catch {
        /* 已退出 */
      }
    }
  })();

  inflight.set(agentId, job);
  try {
    return await job;
  } finally {
    inflight.delete(agentId);
  }

  function failure(cls: DiagnosticClass, detail: string): Diagnostic {
    return { class: cls, at: new Date().toISOString(), source: 'canary', detail };
  }
  /** 结论落名册（checking 由入口先写）。落完返回 diagnostic 供调用方用 */
  function finish(agentId: string, diagnostic: Diagnostic): Diagnostic {
    registry.recordCanary(agentId, {
      state: diagnostic.class === 'ok' ? 'ok' : 'failed',
      at: diagnostic.at,
      ...(diagnostic.class === 'ok' ? {} : { diagnostic }),
    });
    return diagnostic;
  }
}

/**
 * 自动触发一批 canary（打开名册 / 登录完成后调用）。
 *
 * 规则：总开关（prefs.canaryEnabled，默认开）→ 每 Agent TTL 内不重复 →
 * 同 Agent 在跑不重复 → 未安装/不支持的跳过（没有可检测的真实调用）。
 * fire-and-forget：调用方（GET /api/agents）不等它，前端靠既有轮询收回结果。
 */
export function scheduleAutoCanaries(agentIds: string[]): void {
  if (loadPrefs().canaryEnabled === false) return;
  const now = Date.now();
  const runnable = agentIds.filter(id => {
    if (inflight.has(id)) return false;
    const info = registry.get(id);
    if (!info) return false;
    if (info.status.availability === 'not-installed' || info.status.availability === 'unsupported') {
      return false;
    }
    if (info.status.lastCanary?.state === 'checking') return false;
    return shouldAutoCanary(parseAt(info.status.lastCanary?.at), now);
  });
  // 并发上限：串行分批，简单且足够
  const queue = [...runnable];
  const workers = Array.from({ length: Math.min(AUTO_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      if (!shouldAutoCanary(lastAutoAt.get(id), Date.now())) continue;
      lastAutoAt.set(id, Date.now());
      try {
        await runCanary(id);
      } catch {
        /* runCanary 不抛；这里兜一层防御 */
      }
    }
  });
  void Promise.all(workers);
}

function parseAt(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** 仅供验证脚本复位频控状态 */
export function resetCanaryForTest(): void {
  inflight.clear();
  lastAutoAt.clear();
}
