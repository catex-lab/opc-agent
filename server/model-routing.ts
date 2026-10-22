/**
 * 模型路由：决定「这次调用该把哪个模型名交给这个 Agent」。
 *
 * 为什么需要独立一层：模型名是**各 Agent 私有的命名空间**，不能跨 Agent 复用。
 *   - WorkBuddy SDK 认 `claude-sonnet-4`
 *   - opencode 认 `zai/glm-4.7`（provider/model 形式）
 *   - codex 认 `gpt-5.4`
 *   - hermes（ACP）由会话自己选
 *
 * 平台默认模型只对 SDK 类有意义。把 `claude-sonnet-4` 塞给 opencode 会直接
 * 触发 `Error: Invalid model reference` —— 实测会让 opencode 完全不可用，
 * 而且报错发生在 Agent 内部，看起来像 Agent 坏了而不是参数传错了。
 *
 * 所以这里做三件事：
 *   1. SDK 类：沿用请求值，缺省用平台默认模型
 *   2. 声明了 models 白名单的：请求值命中才采用，否则回退该 Agent 自己的默认值
 *   3. 其余：只在请求值不是平台默认模型时才透传
 */

import { findDef } from './agents/definitions.js';

/** 平台的默认模型（仅对 SDK 类 Agent 有意义） */
export const PLATFORM_DEFAULT_MODEL = 'claude-sonnet-4';

/**
 * 「这个模型是否属于该 Agent 的动态目录」的查表函数。
 *
 * 为什么用注入而不是直接 import `modelCatalog`：目录模块要读 `data/` 路径、
 * 会拉起 CLI 子进程，而本文件是**纯判定逻辑**，被离线验证脚本直接调用。
 * 反过来 import 会把这些副作用带进 `verify:routing`（顺带打开真实数据库）。
 * 由 `index.ts` 在启动时把 `isCatalogModel` 注册进来。
 */
export type CatalogModelLookup = (agentId: string, modelId: string) => boolean;

let catalogLookup: CatalogModelLookup | null = null;

/** 注册/清除动态目录查表（传 null 可复位，供测试使用） */
export function setCatalogModelLookup(fn: CatalogModelLookup | null): void {
  catalogLookup = fn;
}

/**
 * 解析要传给某个 Agent 的模型。
 *
 * @param agentId   Agent 标识
 * @param requested 调用方（前端 / 编排层 / 会话记录）给的模型名
 * @returns 要传给 Agent 的模型；`undefined` 表示「交给 Agent 自己决定」
 */
export function resolveModelForAgent(
  agentId: string,
  requested?: string | null
): string | undefined {
  const def = findDef(agentId);
  if (!def) return requested || undefined;

  if (def.descriptor.kind === 'sdk') {
    return requested || PLATFORM_DEFAULT_MODEL;
  }

  const allowed = def.models;
  if (allowed && allowed.length > 0) {
    if (requested && allowed.includes(requested)) return requested;
    // 动态目录里的模型同样是真的能跑的（清单由 CLI 自己枚举出来）。
    // 不认这一条，用户在模型菜单里选了 `opencode/glm-5.3-flash-free`
    // 会被静默换成默认模型 —— 菜单看起来能选，实际没生效。
    if (requested && catalogLookup?.(agentId, requested)) return requested;
    return def.defaultModel ?? allowed[0];
  }

  // 没有白名单可依据：只能拦住「平台默认模型」这一个明确的错误值。
  // 会话里存的模型也可能是修复前的历史遗留值，所以这一步不能省。
  if (!requested || requested === PLATFORM_DEFAULT_MODEL) return undefined;
  return requested;
}
