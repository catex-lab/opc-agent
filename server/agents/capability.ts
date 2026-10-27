/**
 * 能力档的组装（P2）：把「这一轮是谁在跑」翻译成 (引擎 · 模型 · 网关) 三元组，
 * 并附上定义表声明的能力清单。
 *
 * 为什么单独一个模块而不是塞进 registry：投影器要保持纯逻辑（拿夹具就能单测），
 * 而这里要读凭据存储和定义表 —— 都是运行时的东西。让投影器只收一个已经算好的
 * `CapabilityProfile`，它就不必知道网关是怎么推出来的。
 */

import type {
  CapabilityKey,
  CapabilityProfile,
  EventCapability,
} from '../../shared/capabilities.js';
import { getCredential } from '../agent-credentials.js';
import { loadCapabilityProbe } from '../db.js';
import { findDef } from './definitions.js';

/** 从一个 URL 里取主机名；非法输入不抛，原样截断返回 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || url;
  }
}

/**
 * 请求实际走哪条路。
 *
 * 优先级：用户在应用内填的自定义 baseUrl > 定义表的官方端点 > 本地子进程。
 *
 * 自定义 baseUrl 必须排第一：同一个 codex 指向第三方网关时，事件形态取决于
 * **那个网关**，不是厂商。把它算成 official 就等于替网关做了保证。
 */
export function gatewayOf(agentId: string): string {
  const base = (getCredential(agentId)?.baseUrl ?? '').trim();
  if (base) return `custom:${hostOf(base)}`;
  const def = findDef(agentId);
  const hosts = def?.backendHosts ?? [];
  if (hosts.length > 0) return `official:${hosts[0]}`;
  return `local:${def?.descriptor.kind ?? 'unknown'}`;
}

/** 引擎 · 模型 · 网关。模型缺省时只留两段，不写空串冒充「默认模型」 */
export function capabilityKeyOf(agentId: string, model?: string): CapabilityKey {
  return {
    engine: agentId,
    ...(model ? { model } : {}),
    gateway: gatewayOf(agentId),
  };
}

/** 定义表声明的过程能力；缺省（undefined）= 没声明，**不是**「不支持」 */
export function declaredCapabilitiesOf(agentId: string): EventCapability[] | undefined {
  return findDef(agentId)?.descriptor.eventCapabilities;
}

/** 这一轮开始时的能力档：key + declared + 已有标定结果。observed 要等跑完才有 */
export function runProfileOf(agentId: string, model?: string): CapabilityProfile {
  const key = capabilityKeyOf(agentId, model);
  const declared = declaredCapabilitiesOf(agentId);
  // 过期与否不在这里判断：标定事实不会因为过了 7 天就变假，
  // `probe.at` 会一起下发，界面可以写「X 天前实测」。
  // TTL 只决定「下次标定时要不要重跑」（见 capability-probe.ts）。
  const probed = loadCapabilityProbe(key);
  return {
    key,
    ...(declared ? { declared } : {}),
    ...(probed ? { probed } : {}),
  };
}
