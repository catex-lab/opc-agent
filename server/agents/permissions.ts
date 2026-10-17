/**
 * 权限模式的**真实强制能力矩阵**。
 *
 * 为什么需要这个文件：`permissionMode` 一直是个「声明式」参数 —— 前端传下去，
 * 但并不是每个适配器都会把它翻译成 CLI 的实际开关。实测（2026-10-17，逐个查
 * `--help`）发现：
 *
 *   | Agent   | 是否真的强制 `plan`（只读）                          |
 *   |---------|------------------------------------------------------|
 *   | workbuddy | ✅ SDK 的 `permissionMode` + `canUseTool` 审批桥     |
 *   | gemini    | ✅ `--approval-mode plan`                            |
 *   | codex     | ❌ 之前完全忽略 → 默认 workspace-write，**能写文件**  |
 *   | opencode  | ❌ 没有只读/沙箱参数                                  |
 *   | hermes    | ❌ ACP 只有交互式审批，没有只读模式                    |
 *   | claude    | ❓ 原生二进制缺失，`--help` 无输出，无法实测           |
 *
 * 也就是说「问答场景 = 只读」这个承诺，在 5 个可用 Agent 里有 3 个是**落不了地**的。
 * 与其继续假装，不如：
 *   1. 能在适配器层落地的（codex）真的落地；
 *   2. 落不了的，把**能力边界如实暴露给 UI**，让用户在选场景/选 Agent 时就看见。
 *
 * ⚠️ 本矩阵的每一条都必须有实测依据（`--help` 输出 / 适配器源码）。**不要凭印象加**：
 * 加一个不存在的开关，就是把「假控件」换成了「假保障」，比不写更糟。
 */

import type { PermissionMode, PermissionSupport } from './types.js';
import { enforcementGap, getScenario } from '../../shared/scenarios.js';

export type { PermissionSupport };

/** codex 的 `-s/--sandbox` 取值（`codex exec --help` 实测） */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * 权限模式 → codex 沙箱策略。
 *
 * `default` 返回 null，表示不传 `-s`，交给 codex 自己的默认策略 ——
 * 替用户挑一个他没要求的沙箱级别属于擅自扩大行为，不做。
 */
export function codexSandboxFor(mode: PermissionMode | undefined): CodexSandbox | null {
  switch (mode) {
    case 'plan':
      // 只读：禁止写文件、禁止执行会改磁盘的命令
      return 'read-only';
    case 'acceptEdits':
      return 'workspace-write';
    case 'bypassPermissions':
      return 'danger-full-access';
    default:
      return null;
  }
}

const FULL: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/**
 * Agent id → 能力矩阵。
 * 未列出的 Agent 一律按「不支持任何强制」处理（保守方向：宁可少承诺）。
 *
 * `toolWhitelist` 单独一列，因为「能强制权限模式」和「能按类别裁剪工具」
 * 是两件事 —— 一个 Agent 可能能进只读沙箱，却没有工具级开关。
 */
const MATRIX: Record<string, PermissionSupport> = {
  // SDK 适配器把 permissionMode 原样交给 SDK，并用 canUseTool 回调做逐次审批
  workbuddy: {
    enforced: FULL,
    toolWhitelist: {
      enforced: true,
      // 说明边界而不是含糊过去：SDK 对**不需要授权**的只读工具（如 Read/Grep）
      // 可能直接放行、不经过 canUseTool。这不影响白名单的有效性 ——
      // 需要拦的是会改磁盘/执行命令的那批工具，而它们恰恰必须走授权回调。
      limitation: '仅对会触发授权的工具生效（只读工具由 SDK 自动放行，不在拦截目标内）',
    },
  },

  // definitions.ts 的 geminiApproval() 映射到 --approval-mode（--help 实测四个取值都存在）
  //
  // ⚠️ 但 `default` 并没有被忠实映射：geminiApproval() 把它也归到 `plan`（只读），
  // 理由是 `-p` 非交互模式下无法应答审批提示。这是个**更严格**的退化，不是安全漏洞，
  // 但会造成「工作场景 + gemini → 让它改文件改不了」的困惑。
  // 所以这里不把 `default` 算作「能强制」：让 UI 如实提示，而不是假装一切正常。
  gemini: {
    enforced: ['acceptEdits', 'plan', 'bypassPermissions'],
    limitation:
      '非交互（-p）模式无法应答审批提示，default 会退化为只读 plan（见 geminiApproval()）',
    // 「做不到」与「做成了别的」要分开记：default 不是没实现，是被换成了只读，
    // 属于功能性偏差，必须让 UI 提示，否则用户会以为「让它改文件改不了」是 bug。
    deviates: ['default'],
    toolWhitelist: {
      enforced: false,
      // `gemini --help` 里确实有 --allowed-tools，但已被标注 DEPRECATED；
      // 且本机 gemini 处于 needs-auth，改了无法实测。不声称支持。
      limitation: '`--allowed-tools` 在 gemini 中已标记废弃，且本机不可达无法实测，故未采用',
    },
  },

  // 本次新增：映射到 -s/--sandbox（--help 实测 read-only/workspace-write/danger-full-access）
  codex: {
    enforced: FULL,
    toolWhitelist: {
      enforced: false,
      // codex 只有沙箱级别（管写盘/网络），没有「允许哪些工具」的开关
      limitation: 'codex 只有沙箱级别（-s），没有工具级白名单，只能约束写盘与网络',
    },
  },

  opencode: {
    enforced: ['default'],
    limitation:
      'opencode 没有只读或沙箱参数（`opencode run --help` 实测只有 --auto / --agent），无法强制只读',
    toolWhitelist: {
      enforced: false,
      limitation: 'opencode 没有工具级开关（`opencode run --help` 实测无相关参数）',
    },
  },

  hermes: {
    enforced: ['default'],
    limitation:
      'ACP 只提供交互式审批（session/request_permission），没有只读模式；工具是否放行取决于 Hermes 自身策略',
    toolWhitelist: {
      enforced: true,
      // ACP 的授权请求是我们回的包，所以能在这一层直接拒绝；
      // 但「不发起授权请求」的工具（如纯思考）无从拦截。
      limitation: '仅对发起 session/request_permission 的工具生效',
    },
  },

  claude: {
    enforced: [],
    limitation: '原生二进制缺失，未能实测其权限参数，因此不声称支持任何强制',
    toolWhitelist: {
      enforced: false,
      limitation: '原生二进制缺失，未能实测，因此不声称支持',
    },
  },
};

/** 取某个 Agent 的能力矩阵。未知 Agent → 不支持任何强制。 */
export function permissionSupportFor(agentId: string): PermissionSupport {
  return MATRIX[agentId] ?? { enforced: [], limitation: '未知 Agent，不声称支持任何强制' };
}

/** 该 Agent 能否真的强制某个权限模式 */
export function canEnforce(agentId: string, mode: PermissionMode): boolean {
  return permissionSupportFor(agentId).enforced.includes(mode);
}

/**
 * 「这个场景要求的约束，当前 Agent 落不了地」时的提示文案；能落地则返回 null。
 *
 * ⚠️ 判据**不在本文件实现**，而是直接复用 `shared/scenarios.ts` 的
 *    `enforcementGap()` —— 场景定义已经前后端共享，UI 与后端调用的就是同一个函数。
 *
 * 之前这里是**第二份实现**（因为前端不能 import server 模块），靠
 * `verify:permission` 做逐字比对来防漂移。现在共享层消除了根因：
 * 只有一份实现，就不存在「两份写得不一样」的可能。
 */
export function describeEnforcementGap(
  agentId: string,
  scenarioId: string | undefined
): string | null {
  return enforcementGap(getScenario(scenarioId), permissionSupportFor(agentId));
}
