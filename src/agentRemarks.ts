/**
 * Agent 的**本地备注**（别名）。
 *
 * ## 为什么是本地、不落库
 *
 * 备注是「我这台机器上想怎么称呼它」，不是 Agent 本身的属性：
 * 同一个 Agent 在别人那里就叫原名。落库要动注册表、加迁移、还要处理
 * 「后端改名后备注是否失效」，收益只是「换台机器也记得」—— 单机桌面应用
 * 没有这个收益。与 `sessionFlags.ts` 同一套理由，也同一套实现方式。
 *
 * ## 为什么用 useSyncExternalStore 而不是 Context
 *
 * 读备注的地方有四五个（会话列表、通讯录、聊天头部、悬停名片），
 * 写到的地方有两处（两个列表的右键菜单）。把状态提到 App 再一层层传，
 * 中间任何一层忘了透传就出现「改了没反应」；模块级快照 + 订阅则改一处、
 * 到处同步。
 *
 * ## 备注与原名的关系
 *
 * 备注**替换**显示名（与 QQ 一致），不是并列显示两行 —— 用户写备注的
 * 目的就是「我不想再看到那个又长又难记的原名」。需要看原名的地方
 * （悬停名片、资料页）仍然显示原名，备注作为副标题出现。
 */

import { useSyncExternalStore } from 'react';

const KEY = 'opc:agentRemarks';

type RemarkMap = Record<string, string>;

function read(): RemarkMap {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as RemarkMap) : {};
  } catch {
    // localStorage 被禁用 / 内容损坏：当作没有备注，别让列表挂掉
    return {};
  }
}

/** 当前快照。每次写入都换一个新对象 —— useSyncExternalStore 靠引用比较 */
let snapshot: RemarkMap = read();

const listeners = new Set<() => void>();

function write(next: RemarkMap): void {
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不下就算了：本次会话内仍然生效，只是重启后丢 */
  }
  listeners.forEach(fn => fn());
}

export function subscribeAgentRemarks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getSnapshot = (): RemarkMap => snapshot;

/** 组件订阅用：返回 agentId → 备注 的映射 */
export function useAgentRemarks(): RemarkMap {
  return useSyncExternalStore(subscribeAgentRemarks, getSnapshot, getSnapshot);
}

/** 非组件环境（事件回调里）读单条 */
export function agentRemark(agentId?: string): string {
  return agentId ? (snapshot[agentId] ?? '') : '';
}

/**
 * 写备注。传空字符串等于删除 —— 空壳条目不该留在 localStorage 里，
 * 否则 `Object.keys(map).length` 会永远大于 0，将来想加「有没有自定义过」
 * 的判断会被这些空串骗到。
 */
export function setAgentRemark(agentId: string, remark: string): void {
  if (!agentId) return;
  const text = remark.trim();
  if (snapshot[agentId] === text) return;
  const next: RemarkMap = { ...snapshot };
  if (text) next[agentId] = text;
  else delete next[agentId];
  write(next);
}
