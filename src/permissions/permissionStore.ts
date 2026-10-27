import { useSyncExternalStore, useMemo } from 'react';
import type { PermissionOption, PermissionRequest } from '../types';
import {
  behaviorOfKind,
  classifyPermissionAck,
  reasonCodeOfKind,
  sortPendingPermissions,
} from '../../shared/permissions';

/**
 * 待授权队列 —— A132，全局单一事实源。
 *
 * ## 为什么不是又一个 useState
 *
 * 原来 `useChat` 与 `useGroupChat` 各攥一个单值 `permissionRequest`，还要从
 * `App.tsx` 一路透传到 `ChatPage` 再到 `ChatMessages`。后果有三个：
 *   1. 并行会话后来的顶掉前一条（用户同时跑六个 Agent，这是常态）；
 *   2. 渲染条件只判非空、不校验 `request.sessionId`，切会话可能显示别人的卡；
 *   3. `kind → behavior` 的翻译在两个 hook 里各抄了一份逐行相同的代码。
 *
 * 队列本身不解决「看不见」，但它是队列的**前提**：有了它才谈得上角标、倒计时、
 * 当前会话优先。所以先换地基，再谈落点。
 *
 * ## 归属是硬约束
 *
 * 每条都带 `request.sessionId` 记账。Dock 挂在 App 层、不随会话卸载，
 * 所以切走会话时未答复项继续留着 —— 这正是想要的行为：那条流还在服务端挂着等。
 *
 * ## 顶层不许碰 window
 *
 * 这个模块会被脱机脚本（`npx tsx scripts/verify-a132-permission-dock.ts`）直接 import，
 * 那里没有 window。需要浏览器能力的地方（系统通知）一律走动态 import，见 Task 8。
 */

export type PermissionSource = 'single' | 'group';

/** `failed` = 服务端明确拒绝了这个请求体（前端构造错了，属于 bug 现场，要留证据） */
export type PermissionState = 'pending' | 'stale' | 'failed';

export interface PendingPermission {
  request: PermissionRequest;
  /**
   * 与 `request.sessionId` 同值，**提到顶层**是为了让排序与计数不必穿过 `request`。
   * 单一来源：只在 `push()` 里从 `request.sessionId` 赋值一次，不存在两处各传一份。
   */
  sessionId: string;
  source: PermissionSource;
  receivedAt: number;
  /** 缺省 = 该适配器没有超时兜底（ACP）。不许伪造 */
  expiresAt?: number;
  state: PermissionState;
  error?: string;
}

export interface RecentDecision {
  requestId: string;
  sessionId: string;
  label: string;
  kind: PermissionOption['kind'];
  at: number;
}

export interface PermissionSnapshot {
  items: PendingPermission[];
  recent: RecentDecision[];
}

const RECENT_MAX = 5;
/** 404 之后这条在界面上停留多久（够看清，又不会永远占位） */
const STALE_LINGER_MS = 1500;

const items = new Map<string, PendingPermission>();
const recent: RecentDecision[] = [];
const listeners = new Set<() => void>();
let snapshot: PermissionSnapshot = { items: [], recent: [] };

/**
 * 会话 id → 标题。store 拿不到会话列表（那是 App 的事），由 App 注册进来。
 *
 * 为什么不照计划那样把 `request.sessionId` 当标题传下去：那会把一串 UUID
 * 写进系统通知的标题里 —— 六个会话并行时，通知完全帮不上「这是谁在等」。
 */
let titleResolver: ((sessionId: string) => string) | null = null;

export function setSessionTitleResolver(fn: ((sessionId: string) => string) | null): void {
  titleResolver = fn;
}

/**
 * 快照必须是**缓存过的同一引用**：`useSyncExternalStore` 每帧比对快照身份，
 * 每次新建数组会变成无限重渲染。
 */
function emit(): void {
  snapshot = { items: [...items.values()], recent: [...recent] };
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSnapshot(): PermissionSnapshot {
  return snapshot;
}

/** 幂等：同一个 requestId 只记一次（SSE 重放或重复帧不该翻倍计数） */
export function push(request: PermissionRequest, source: PermissionSource, receivedAt: number): void {
  if (items.has(request.requestId)) return;
  items.set(request.requestId, {
    request,
    sessionId: request.sessionId,
    source,
    receivedAt,
    ...(typeof request.expiresAt === 'number' ? { expiresAt: request.expiresAt } : {}),
    state: 'pending',
  });
  // 交给桌面壳判定（是否在前台、同会话是否已提醒过），store 自己不做节流。
  // 必须动态 import：本模块会被 `npx tsx` 脱机脚本直接加载，
  // 而 `desktopNotify` 是浏览器侧的东西。
  void import('./desktopNotify')
    .then(({ notifyDesktop }) => {
      notifyDesktop(request, titleResolver?.(request.sessionId) ?? '会话');
    })
    .catch(() => { /* 提醒失败不能影响入队 —— 卡片已经在屏幕上了 */ });
  emit();
}

export function countFor(sessionId: string): number {
  let n = 0;
  for (const it of items.values()) {
    if (it.sessionId === sessionId && it.state === 'pending') n++;
  }
  return n;
}

/**
 * 本轮结束（`done` / `error` / 用户点停止）。
 *
 * 服务端 `PendingReplies.clear(scope)` 已经按 cancelled 兑现了，前端再留一张卡
 * 就是永远批不掉的僵尸卡。这里必须跟着摘。
 *
 * 只摘 `pending`：`stale` 有 1.5s 自动清理，`failed` 是 bug 现场（服务端拒绝了
 * 我们发的 body），留着才有证据可看 —— 两者都不该被「收尾」顺手抹掉。
 */
export function markSessionEnded(sessionId: string): void {
  let hit = false;
  for (const [id, it] of [...items]) {
    if (it.sessionId !== sessionId || it.state !== 'pending') continue;
    items.delete(id);
    hit = true;
  }
  if (hit) emit();
}

export function remove(requestId: string): void {
  if (items.delete(requestId)) emit();
}

/**
 * 唯一的答复出口（单聊与群聊共用）。
 *
 * `requestId` 是全局唯一 UUID，服务端 `registry.resolvePermissionAnywhere()` 本来就
 * 遍历所有 provider 认领、不区分来源 —— 所以合并成一个出口不需要动后端。
 *
 * **答复送达 ≠ 答复生效**：只有 200 才摘卡。404 说明服务端已经没有这条了
 * （超时或被别处兑现），必须让用户看见「这条没生效」而不是静默清掉。
 */
export async function answer(requestId: string, option: PermissionOption): Promise<void> {
  const item = items.get(requestId);
  if (!item) return;

  const behavior = behaviorOfKind(option.kind);
  const reasonCode = reasonCodeOfKind(option.kind);

  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        behavior,
        ...(option.id ? { optionId: option.id } : {}),
        ...(reasonCode ? { reasonCode } : {}),
      }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    status = 0;
  }

  const ack = classifyPermissionAck(status, body);
  if (ack.kind === 'settled') {
    items.delete(requestId);
    recent.unshift({ requestId, sessionId: item.sessionId, label: option.label, kind: option.kind, at: Date.now() });
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
    emit();
    return;
  }
  if (ack.kind === 'stale') {
    item.state = 'stale';
    emit();
    setTimeout(() => {
      // 只在它仍是 stale 时摘：期间用户可能已经重发并拿到了新的待办
      if (items.get(requestId)?.state === 'stale') {
        items.delete(requestId);
        emit();
      }
    }, STALE_LINGER_MS);
    return;
  }
  item.state = 'failed';
  item.error = ack.error;
  emit();
}

export function usePermissionSnapshot(): PermissionSnapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snap;
}

/** 队首排序：当前会话优先，组内先来先批。见 `sortPendingPermissions` 的理由。 */
export function useVisiblePermissions(currentSessionId: string | null): PendingPermission[] {
  const { items: all } = usePermissionSnapshot();
  return useMemo(() => sortPendingPermissions(all, currentSessionId), [all, currentSessionId]);
}

/** 测试钩子（照 `registry.resetCacheForTests()` 的先例） */
export function __resetForTests(): void {
  items.clear();
  recent.length = 0;
  emit();
}
