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
 *   | codex     | ✅ `-s/--sandbox read-only`（2026-10-17 修复）        |
 *   | opencode  | ❌ 没有只读/沙箱参数                                  |
 *   | hermes    | ❌ ACP 只有交互式审批，没有只读模式                    |
 *   | claude    | ✅ `--permission-mode plan`（二进制补齐后 10-17 实测） |
 *
 * 也就是说「问答场景 = 只读」这个承诺，在 5 个可用 Agent 里有 3 个是**落不了地**的。
 * 与其继续假装，不如：
 *   1. 能在适配器层落地的（codex）真的落地；
 *   2. 落不了的，把**能力边界如实暴露给 UI**，让用户在选场景/选 Agent 时就看见。
 *
 * ⚠️ 本矩阵的每一条都必须有实测依据（`--help` 输出 / 适配器源码）。**不要凭印象加**：
 * 加一个不存在的开关，就是把「假控件」换成了「假保障」，比不写更糟。
 *
 * ## A40 之后新增的一层（`permission-gate.ts`）
 *
 * 危险命令分类器与自定义规则只作用在 **SDK 适配器的 `canUseTool` 回调**上：
 * 那是唯一一个「每次工具调用都回到我们代码里」的位置。CLI / ACP 的子进程
 * 一旦拉起，参数之外的行为我们看不见也拦不住，所以那两类 Agent 的强度
 * 仍以本矩阵的启动参数为准 —— 门禁对它们是**不生效**，不是「也生效」。
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

  // definitions.ts 的 geminiApproval() 映射到 --approval-mode。
  // gemini 0.63.0 --help 实测四值：default=逐次询问 / auto_edit=自动批编辑 /
  // yolo=全放行 / plan=只读，四档一一对应，含 default。
  //
  // 曾经的 bug（2026-10-17 修复）：default 被映射成 plan（只读），造成
  // 「工作场景 + gemini → 改不了文件」的困惑。已按 gemini 自己的语义修正。
  // 运行期注意：`-p` 非交互子进程无法应答审批提示，gemini 对 default 档位
  // 自行 fail-closed（需要审批的不放行）—— 那是 CLI 的行为，我们不再替它改语义。
  gemini: {
    enforced: FULL,
    toolWhitelist: {
      enforced: false,
      // `gemini --help` 里确实有 --allowed-tools，但已被标注 DEPRECATED；
      // 且本机 gemini 后端不可达（代理拦截），改了无法实测。不声称支持。
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

  // qodercli 1.1.73 --help 实测 `--permission-mode` 五值：
  // default / accept_edits / bypass_permissions / dont_ask / auto。
  //
  // A76 之后这一条分两种通道，**保证强度不同**，所以必须写清楚：
  //   - SDK 通道（默认）：`permissionMode: 'plan'` 是 SDK 自己的档位（取值域里
  //     确实有 plan），再叠 `disallowedTools` 硬拒写盘/命令类工具，再叠
  //     `canUseTool` 的只读白名单 —— 三层，所以 plan 记为已强制；
  //   - CLI 回退通道：没有只读沙箱，plan 退化成 dont_ask（不询问即拒绝，
  //     近似只读但不是沙箱级保证）。只在 SDK 包缺失/握手失败时发生，
  //     名册的状态文案会写明当前是哪条通道。
  //
  // ⚠️ 这里不玩「反正大多数时候是 SDK」的模糊话术：用户在「问答」场景下
  //    拿到的只读承诺，取决于运行期走的是哪条路，而这件事界面上能看见。
  qoder: {
    enforced: FULL,
    limitation:
      'SDK 通道：permissionMode=plan + disallowedTools 硬拒写盘/命令工具 + 审批回调只读白名单三层强制；若 SDK 不可用退化为 CLI 通道，plan 降级为 dont_ask（近似只读，非沙箱级保证），状态文案会标注当前通道',
    toolWhitelist: {
      enforced: true,
      // 只读工具（Read/Grep/Glob）实测**不经过** canUseTool，由 SDK 自动放行。
      // 所以类别白名单只能拦住「会触发授权」的那批；要拦只读场景的写盘，
      // 靠的是 disallowedTools（硬拒绝，不需要回调）。
      limitation:
        '仅对会触发授权的工具生效（只读工具由 SDK 自动放行）；只读场景另用 disallowedTools 硬拒 Bash/Write/Edit 等',
    },
  },

  // 国内版：同一套适配器、同一套判定，**但本机没有 CN 账号，运行期未实测**。
  // 矩阵描述的是「代码能强制什么」，所以与上面一致；不确定性写进 limitation，
  // 而不是含糊地少写一条 —— 少写一条会让 UI 在能强制的情况下也提示缺口。
  'qoder-cn': {
    enforced: FULL,
    limitation:
      '与国际版同一套适配器（SDK 三层强制 + CLI 回退）；本机无 Qoder CN 账号，运行期未实测',
    toolWhitelist: {
      enforced: true,
      limitation:
        '仅对会触发授权的工具生效（只读工具由 SDK 自动放行）；只读场景另用 disallowedTools 硬拒 Bash/Write/Edit 等。CN 通道未实测',
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

  // claude 2.1.291 --help 实测：--permission-mode 有 acceptEdits / auto /
  // bypassPermissions / manual / dontAsk / plan 六值，四档权限模式全部可落地
  // （default → manual，语义同为「逐次询问」）；--allowedTools 收 variadic 工具名，
  // 工具名逐个在 claude.exe 里 grep 验证过（Read/Write/Edit/Glob/Grep/
  // NotebookEdit/Bash/WebSearch/WebFetch）。
  //
  // ⚠️ 运行期未经真实验证：本机 claude 未登录（需 `claude` → `/login`），
  // 无法发起一次真实调用；声称的依据是 --help 证据 + buildArgs 反证断言
  // （verify:permission 逐条核对产出参数）。登录后建议补一次真机冒烟。
  claude: {
    enforced: FULL,
    toolWhitelist: {
      enforced: true,
      limitation:
        'argv 无法表达「一个工具都不许」（空名单跳过 --allowedTools，由只读模式兜底）；["tools"] 按语义不限制；运行期未真实验证（本机未登录）',
    },
  },

  // agy 1.1.20 `--help` + 官方 headless 文档实测四档全落地：
  //   plan → --mode plan（只读）／acceptEdits → --mode accept-edits／
  //   bypassPermissions → --dangerously-skip-permissions／default → 不传
  //   （它的默认就是 request-review，headless 下拿不到审批的工具一律 soft-deny）。
  // ⚠️ soft-deny 的表现是「工具被拒但进程 exit 0」，比我们的 default 更严，
  //    不是更松 —— 所以记作已强制，但把这条差异写进 limitation。
  antigravity: {
    enforced: FULL,
    limitation:
      'default 档在 headless 下是 request-review：需要审批的工具会被 soft-deny（拒绝但不报错、进程 exit 0），比「逐次询问」更严',
    toolWhitelist: {
      enforced: false,
      limitation:
        'agy 的工具白名单只能写在 ~/.gemini/antigravity-cli/settings.json 的 permissions.allow 里，argv 无法按场景传入',
    },
  },

  // pi 0.82.1 `--help` 实测：有 --tools / --exclude-tools（工具名白名单）与
  // --no-tools，但**没有只读沙箱**；plan 模式来自 plan-mode 扩展（不保证装了）。
  // 因此不声称能强制任何权限档位 —— 只读承诺在 pi 上落不了地，UI 如实提示。
  pi: {
    enforced: [],
    limitation:
      'pi 没有只读沙箱（plan 模式依赖可选扩展）；只有 --tools 工具名白名单，无法表达「只读」',
    toolWhitelist: {
      enforced: false,
      limitation:
        'pi 的 --tools 收的是工具名，与场景类别（file/shell/search）的映射未实测，不声称支持',
    },
  },

  // kimi 官方 flag 冲突规则逐字：`--prompt` 不能与 --yolo / --auto / --plan 同时使用，
  // 非交互模式固定 auto 权限。也就是说在 `kimi -p` 这条链路上，权限档位
  // **一个都落不了地** —— 传了 CLI 直接拒绝启动，所以一个都不传。
  kimicli: {
    enforced: [],
    limitation:
      '`kimi -p` 不能与 --plan / --yolo / --auto 组合（官方冲突规则），非交互模式固定 auto 权限；要只读只能走交互式 TUI',
    toolWhitelist: {
      enforced: false,
      limitation: 'kimi 没有 argv 级工具白名单（审批与放行规则在配置文件里）',
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
