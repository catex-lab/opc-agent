/**
 * 会话的**本地**标记：免打扰、手动标记未读，以及群聊设置里的几项个人偏好。
 *
 * ## 为什么不落库
 *
 * 这些都是「我这台机器上怎么显示」的偏好，不是会话本身的属性：
 * 免打扰不影响后端怎么跑，标记未读更只是一个视觉提醒，群昵称/群备注
 * 只有本人看得见。落库要动 `sessions` 表（加列 + 迁移 + PATCH 接口），
 * 而收益只是「换台机器也记得」—— 这是个单机桌面应用，这个收益不存在。
 *
 * 已有的 `pinned` 之所以落库，是因为它改变的是**会话排序**，属于数据。
 *
 * ## 为什么要有 subscribe
 *
 * 右键菜单改完标记后，列表必须立刻重画。用 `useSyncExternalStore` 订阅一个
 * 模块级快照，比「把状态提到 App 再一层层传下去」改动面小得多，也不会因为
 * 忘了透传某个中间层而出现「点了没反应」。
 *
 * ## `muted` 与 `notifyMode` 的关系（P7 群设置）
 *
 * 群消息设置有四种状态（正常提醒 / 不提醒 / 收进群助手且不提醒 / 屏蔽），
 * 但满世界都在读的 `isMuted()` 是个布尔。所以：
 *   - `notifyMode` 是**唯一事实来源**；
 *   - `muted` 是它的投影（`muted = notifyMode !== 'normal'`），
 *     为了让老代码与列表里的静音图标继续工作而保留。
 * 写 `muted` 的旧入口（`toggleMuted`）会同步把 `notifyMode` 归位，
 * 不会出现「开关显示不提醒、下拉却显示正常」的分裂。
 */

import { useSyncExternalStore } from 'react';

const KEY = 'opc:sessionFlags';

/** 群消息接收方式。P7 群聊设置面板的「群消息设置」下拉 */
export type NotifyMode = 'normal' | 'muted' | 'assistant' | 'blocked';

export interface SessionFlags {
  /** 消息免打扰：不弹未读红点，只留一个静音图标。= `notifyMode !== 'normal'` 的投影 */
  muted?: boolean;
  /** 手动标记未读（打开会话即清除） */
  unread?: boolean;
  /** 我在本群的昵称（群聊设置里改；空 = 用不着，不显示） */
  nickname?: string;
  /** 群聊备注：自己给这个群写的一行说明 */
  remark?: string;
  /**
   * 群头像（A115）：头像预设 id，空 = 用「多人群」图标兜底。
   *
   * 为什么和 nickname / remark 一样只存本地：这三项都是「我这台机器上
   * 这个群长什么样」，不是群本身的数据（群的数据是成员与编排模式，
   * 它们在服务端）。落库要给 sessions 表加一列 + 迁移 + PATCH 接口，
   * 收益只是「换台机器也记得」—— 单机桌面应用上没有这个场景。
   * 真要多端同步的那天，把它挪进 sessions 表即可，前端只改读写处。
   */
  avatar?: string;
  /** 群消息接收方式；缺省等同 'normal' */
  notifyMode?: NotifyMode;
}

type FlagMap = Record<string, SessionFlags>;

function read(): FlagMap {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as FlagMap) : {};
  } catch {
    // localStorage 被禁用 / 内容损坏：当作没有标记，不要让列表挂掉
    return {};
  }
}

/** 当前快照。每次写入都换一个新对象 —— useSyncExternalStore 靠引用比较 */
let snapshot: FlagMap = read();

const listeners = new Set<() => void>();

function write(next: FlagMap): void {
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不下就算了：本次会话内仍然生效，只是重启后丢 */
  }
}

/** 改一个会话的标记；空值字段会被顺手清掉，避免 localStorage 里堆积空壳 */
function patch(sessionId: string, next: SessionFlags): void {
  const merged: FlagMap = { ...snapshot };
  const flags: SessionFlags = { ...snapshot[sessionId], ...next };
  if (!flags.muted) delete flags.muted;
  if (!flags.unread) delete flags.unread;
  if (!flags.nickname) delete flags.nickname;
  if (!flags.remark) delete flags.remark;
  // A115：群头像同理 —— 空串不占位
  if (!flags.avatar) delete flags.avatar;
  // 'normal' 是该字段的缺省值，不必占位
  if (!flags.notifyMode || flags.notifyMode === 'normal') delete flags.notifyMode;

  if (Object.keys(flags).length === 0) delete merged[sessionId];
  else merged[sessionId] = flags;

  write(merged);
  // A115（用户反馈）：「右键菜单改完标记后列表必须立刻重画」这句话只在
  // **右键菜单**那条路上成立 —— `patch()` 原先只写文件、不通知订阅者，
  // 于是会话行点击里的 `setManuallyUnread(id, false)` 是**静默**的：
  // 红点要等下一次无关重渲染才消失（有时一直挂着）。
  // 现在每次写入都通知一次，谁写谁生效，不再依赖「碰巧有个别的 state 变了」。
  for (const fn of listeners) fn();
}

export function subscribeSessionFlags(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getSnapshot = (): FlagMap => snapshot;

/** 列表组件订阅用 */
export function useSessionFlags(): FlagMap {
  return useSyncExternalStore(subscribeSessionFlags, getSnapshot, getSnapshot);
}

/** 真实接收方式（缺省 normal） */
export function notifyModeOf(sessionId: string): NotifyMode {
  return snapshot[sessionId]?.notifyMode ?? 'normal';
}

export function isMuted(sessionId: string): boolean {
  return notifyModeOf(sessionId) !== 'normal';
}

export function isManuallyUnread(sessionId: string): boolean {
  return !!snapshot[sessionId]?.unread;
}

export function groupNickname(sessionId: string): string {
  return snapshot[sessionId]?.nickname ?? '';
}

export function groupRemark(sessionId: string): string {
  return snapshot[sessionId]?.remark ?? '';
}

/**
 * 切换免打扰，返回切换后的状态。
 *
 * 只做 normal ↔ muted 两档切换（列表右键菜单的快捷开关）；
 * 要切到 assistant / blocked 请用 `setNotifyMode`。
 */
export function toggleMuted(sessionId: string): boolean {
  const next: NotifyMode = notifyModeOf(sessionId) === 'normal' ? 'muted' : 'normal';
  patch(sessionId, { notifyMode: next, muted: next !== 'normal' });
  return next !== 'normal';
}

/** 设置群消息接收方式，并同步 `muted` 投影 */
export function setNotifyMode(sessionId: string, mode: NotifyMode): void {
  patch(sessionId, { notifyMode: mode, muted: mode !== 'normal' });
}

export function setGroupNickname(sessionId: string, nickname: string): void {
  patch(sessionId, { nickname: nickname.trim() });
}

export function setGroupRemark(sessionId: string, remark: string): void {
  patch(sessionId, { remark: remark.trim() });
}

/** A115：换群头像（群聊设置里改）。空串 = 回到「多人群」图标兜底 */
export function setGroupAvatar(sessionId: string, avatar: string): void {
  patch(sessionId, { avatar: avatar.trim() });
}

/** A115：读群头像预设 id，没有时返回空串（非 Hook，供事件回调里读） */
export function groupAvatar(sessionId: string): string {
  return snapshot[sessionId]?.avatar ?? '';
}

/**
 * A115：同上，但**订阅式** —— 组件用它才能在「换头像」后立刻重画。
 *
 * 为什么不直接 `useSessionFlags()[id]?.avatar`：那个 Hook 返回整张表，
 * 任何一个会话的任何标记变化都会让所有消费者重渲染。这里只订一个键，
 * 语义也更直白（「我要的是这个群的头像」）。
 */
export function useGroupAvatar(sessionId: string | null | undefined): string {
  return useSyncExternalStore(
    subscribeSessionFlags,
    () => (sessionId ? snapshot[sessionId]?.avatar ?? '' : ''),
    () => ''
  );
}

export function setManuallyUnread(sessionId: string, unread: boolean): void {
  patch(sessionId, { unread });
}
