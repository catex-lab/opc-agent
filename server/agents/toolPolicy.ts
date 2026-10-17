/**
 * 工具白名单的**判据**（P4-5）。
 *
 * 场景声明的 `tools` 是排他白名单（语义见 `shared/scenarios.ts` 的 `ScenarioTool`）。
 * 本模块把它翻译成「这次工具调用该不该放行」，供各适配器在各自的拦截点上调用：
 *
 *   - `sdk.ts`  → `canUseTool` 回调（SDK 每次需要授权的工具调用都会经过它）
 *   - `acp.ts`  → `session/request_permission` 请求（可以自动回 reject）
 *
 * ⚠️ 工具名与类别的对应关系**必须来自实测**，不要凭印象编。
 *    下表的工具名全部取自本机 SDK 包里真实出现的标识符
 *    （`node_modules/@tencent-ai/agent-sdk/cli/dist/codebuddy-headless.js`，
 *    逐个 `grep -o "\"<name>\""` 计数 > 0 才算数）。
 *    新增一个不存在的工具名不会报错，只会让那条规则永远不命中 —— 属于静默失效。
 *
 * ⚠️ 未登记的工具名一律**拒绝**（fail-closed）。
 *    理由：白名单的字面语义就是「没列出的一律不行」。放行未登记项会让
 *    白名单变成「部分保障」，而部分保障最危险 —— 用户以为拦住了，其实没有。
 *    代价是将来 SDK 新增工具时可能被误拦；但那种情况有明确报错文案，
 *    用户能立刻看到并反馈，而不是无声地漏过去。
 */

import type { ScenarioTool } from '../../shared/scenarios.js';
import { describeTools, SCENARIO_TOOL_LABEL } from '../../shared/scenarios.js';

/**
 * 内部分类。
 *
 * `escalation` / `meta` 是**不对外暴露**的两类，不参与场景白名单配置：
 *   - `escalation`：能拉起子代理或加载技能，等于绕开白名单，一律拦
 *   - `meta`：无副作用的状态记账类工具，白名单非空时放行（否则会破坏代理的规划流程）
 */
export type ToolCategory = ScenarioTool | 'escalation' | 'meta';

/** 内部类别的中文名（只用于提示文案） */
const INTERNAL_LABEL: Record<'escalation' | 'meta', string> = {
  escalation: '子代理 / 技能',
  meta: '状态记账',
};

/**
 * 工具名 → 类别。
 *
 * 分组依据是「这个工具能对机器做什么」，不是它叫什么：
 *   - file：本机文件读写与检索（Glob/Grep 是只读检索，归 file 而不是 search）
 *   - shell：执行命令
 *   - search：联网检索
 *   - escalation：会拉子代理 / 加载技能，可绕过白名单
 *   - meta：无副作用的记账（todo、计划模式切换）
 */
const TOOL_CATEGORY: Record<string, ToolCategory> = {
  // ---- 文件 ----
  Read: 'file',
  Write: 'file',
  Edit: 'file',
  MultiEdit: 'file',
  NotebookEdit: 'file',
  NotebookRead: 'file',
  LS: 'file',
  Glob: 'file',
  Grep: 'file',

  // ---- 命令 ----
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Terminal: 'shell',
  TerminalOutput: 'shell',

  // ---- 联网 ----
  WebSearch: 'search',
  WebFetch: 'search',

  // ---- 可绕过白名单的 ----
  Task: 'escalation',
  Agent: 'escalation',
  Skill: 'escalation',

  // ---- 记账类 ----
  TodoWrite: 'meta',
  ExitPlanMode: 'meta',
  SlashCommand: 'meta',
  TaskOutput: 'meta',
};

/** 查一个工具名属于哪一类；未登记返回 null */
export function categorizeTool(toolName: string): ToolCategory | null {
  return TOOL_CATEGORY[toolName] ?? null;
}

/** 已登记的工具名（供验证脚本核对覆盖面） */
export function knownToolNames(): string[] {
  return Object.keys(TOOL_CATEGORY);
}

/**
 * ACP 的 `ToolKind` → 类别。
 *
 * 为什么不复用 `categorizeTool`：ACP 报上来的 `toolCall.title` 是**给人看的标题**
 * （如「读取 package.json」），不是稳定的工具标识符，拿它查表必然全部落空；
 * 而 `toolCall.kind` 是协议里的语义枚举，才是可靠信号。
 *
 * 取值来自 ACP 规范的 ToolKind：read / edit / delete / move / search /
 * execute / think / switch_mode / fetch / other。
 */
const ACP_KIND_CATEGORY: Record<string, ToolCategory> = {
  read: 'file',
  edit: 'file',
  delete: 'file',
  move: 'file',
  execute: 'shell',
  search: 'search',
  fetch: 'search',
  // 纯思考与模式切换没有副作用
  think: 'meta',
  switch_mode: 'meta',
  other: 'meta',
};

/** ACP 的工具授权请求 → 放行判定 */
export function decideAcpToolAccess(
  allowed: readonly ScenarioTool[] | undefined,
  kind: string | undefined,
  title: string
): ToolDecision {
  // 没有 kind 就退回按标题猜（大概率落空 → fail-closed），
  // 但白名单未声明时仍然放行，不改变历史行为。
  const category =
    (kind ? ACP_KIND_CATEGORY[kind.toLowerCase()] : undefined) ??
    categorizeTool(title);

  if (allowed === undefined) return { allowed: true, category };
  if (allowed.includes('tools')) return { allowed: true, category };

  if (allowed.length === 0) {
    return {
      allowed: false,
      category,
      reason: `当前场景承诺不调用工具，已拦截「${title}」。`,
    };
  }

  if (category === null) {
    return {
      allowed: false,
      category: null,
      reason:
        `当前场景只允许「${describeTools(allowed)}」类工具，` +
        `「${title}」无法归类（kind=${kind ?? '未提供'}），已按保守策略拦截。`,
    };
  }
  if (category === 'meta') return { allowed: true, category };
  if (category === 'escalation') {
    return {
      allowed: false,
      category,
      reason: `当前场景只允许「${describeTools(allowed)}」类工具，「${title}」可绕过白名单，已拦截。`,
    };
  }
  if (allowed.includes(category)) return { allowed: true, category };

  return {
    allowed: false,
    category,
    reason:
      `当前场景只允许「${describeTools(allowed)}」类工具，` +
      `「${title}」属于「${SCENARIO_TOOL_LABEL[category]}」类，已拦截。`,
  };
}

export interface ToolDecision {
  allowed: boolean;
  /** 拒绝原因（会作为 tool_result 交给模型，也可能显示给用户） */
  reason?: string;
  /** 归类结果；null = 未登记的工具名 */
  category: ToolCategory | null;
}

/**
 * 判断一次工具调用是否放行。
 *
 * @param allowed 场景声明的白名单；`undefined` 表示未声明 → 不做限制
 * @param toolName SDK / ACP 报上来的工具名
 */
export function decideToolAccess(
  allowed: readonly ScenarioTool[] | undefined,
  toolName: string
): ToolDecision {
  const category = categorizeTool(toolName);

  // ① 未声明白名单 → 保持历史行为，不限制
  if (allowed === undefined) return { allowed: true, category };

  // ② 全部放行
  if (allowed.includes('tools')) return { allowed: true, category };

  // ③ 只读场景：一个都不许
  if (allowed.length === 0) {
    return {
      allowed: false,
      category,
      reason: `当前场景承诺不调用工具，已拦截「${toolName}」。`,
    };
  }

  // ④ 未登记工具：fail-closed，但把话说明白
  if (category === null) {
    return {
      allowed: false,
      category: null,
      reason:
        `当前场景只允许「${describeTools(allowed)}」类工具，` +
        `「${toolName}」未登记在白名单映射表中，已按保守策略拦截。`,
    };
  }

  // ⑤ 记账类无副作用，放行（否则代理无法维护 todo / 退出计划模式）
  if (category === 'meta') return { allowed: true, category };

  // ⑥ 子代理 / 技能可以绕开白名单，一律拦
  if (category === 'escalation') {
    return {
      allowed: false,
      category,
      reason:
        `当前场景只允许「${describeTools(allowed)}」类工具，` +
        `「${toolName}」属于「${INTERNAL_LABEL.escalation}」类（可绕过白名单），已拦截。`,
    };
  }

  // ⑦ 正常归类判断
  if (allowed.includes(category)) return { allowed: true, category };

  return {
    allowed: false,
    category,
    reason:
      `当前场景只允许「${describeTools(allowed)}」类工具，` +
      `「${toolName}」属于「${SCENARIO_TOOL_LABEL[category]}」类，已拦截。`,
  };
}
