/**
 * 前后端共享的类型（只有类型，没有任何运行时依赖）。
 *
 * 为什么需要这一层：`PermissionMode` 与 `PermissionSupport` 原本在
 * `src/types.ts` 与 `server/agents/types.ts` 里**各写一份**。当初是刻意的
 * （前端不能 import server 模块），但代价是两份定义会漂移 —— 而 P4-5 之后
 * 前端要靠 `PermissionSupport` 判断「这个场景的约束落不落得了地」，
 * 后端要靠同一份数据决定怎么下发，**两边必须严格同构**。
 *
 * 所以收敛到这里，两边各自 `export type { … }` 再导出，外部 import 路径不变。
 *
 * ⚠️ 本文件只允许放**类型与纯常量**，不许 import 任何 server/ 或 src/ 模块，
 *    否则会重新引入环依赖。
 */

/** 权限模式，映射到各 CLI 的审批/沙箱参数 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * 工具白名单的强制能力（P4-5）。
 *
 * 「工具白名单」= 场景声明只允许某几类工具时，适配器能不能真的拦住其余工具。
 * 这和 `PermissionSupport.enforced`（权限模式）是两件事：
 * 一个 Agent 可能能强制只读，却不能按类别裁剪工具。
 */
export interface ToolWhitelistSupport {
  /** 是否真的能按场景声明的类别拦截工具调用 */
  enforced: boolean;
  /** 不能强制时给用户看的一句话（必须写明依据） */
  limitation?: string;
}

/**
 * 某个 Agent 的**真实**强制能力（P4-5）。
 *
 * 声明它而不是默默忽略，是因为「忽略」会让用户以为约束已生效。
 * 具体数值由 `server/agents/permissions.ts` 维护，且每条都要有实测依据。
 */
export interface PermissionSupport {
  /** 真正能强制生效的权限模式；未列出的模式会被适配器忽略 */
  enforced: PermissionMode[];
  /** 无法完整强制时给用户看的一句话 */
  limitation?: string;
  /**
   * 会**偏离**请求语义的模式（不是「做不到」，而是「做成了别的」）。
   *
   * 典型例子：gemini 在非交互模式下把 `default` 退化成只读 `plan`。
   * 这和「没实现」不同 —— 用户要求能改文件，实际改不了，属于功能性偏差，
   * 必须提示；而 `acceptEdits` 落不了地只是「没有沙箱参数」，
   * 默认行为本来就是放行，提示它反而是噪音。
   */
  deviates?: PermissionMode[];
  /** 工具白名单的强制能力；缺省视为「不能强制」 */
  toolWhitelist?: ToolWhitelistSupport;
}
