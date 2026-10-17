/**
 * 场景模板（P4 场景包）—— 前后端共享。
 *
 * 一个「场景」= 一组预设：注入的系统提示词 + 推荐 Agent + 工作目录要求 + 权限模式
 * + **工具白名单**。
 *
 * 为什么从 `src/` 搬到 `shared/`：P4-5 要让适配器按场景裁剪工具，
 * 后端就必须读到 `tools`。而 `scenarioId` 本来就随请求发给后端，
 * 让后端**自己按 id 推导**比让前端把白名单塞进请求体更可靠 ——
 * 后者等于「谁来约束」这件事由被约束方自己说了算。
 *
 * ⚠️ 本文件只放纯数据与纯函数，不 import 任何 server/ 或 src/ 模块。
 */

import type { PermissionMode, PermissionSupport } from './types.js';

export type { PermissionMode, PermissionSupport };

/**
 * 场景声明的工具类别。
 *
 * ⚠️ `tools` 数组是**排他白名单**，不是「需要的清单」：
 *   - `['tools']` → 全部放行（不限）
 *   - `[]`        → 全部拒绝（只读 / 不调用工具）
 *   - 其他         → **只**放行列出的类别
 * 所以一个既要读写文件又要联网查文档的场景，必须把 `search` 也列进去。
 */
export type ScenarioTool = 'tools' | 'file' | 'shell' | 'search' | 'image';

/** 类别中文名，用于给用户看的提示文案（前后端共用同一份，避免措辞漂移） */
export const SCENARIO_TOOL_LABEL: Record<ScenarioTool, string> = {
  tools: '全部工具',
  file: '文件',
  shell: '命令',
  search: '联网检索',
  image: '图像',
};

export interface ScenarioTemplate {
  /** 稳定 id，落库到 sessions.scenario_id */
  id: string;
  /** 场景名（场景卡标题） */
  label: string;
  /** 一句话说明（场景卡副标题） */
  description: string;
  /** 注入到会话的系统提示词。发送时**优先于** Agent 自带的 systemPrompt */
  systemPrompt: string;
  /** 该场景允许的工具类别（排他白名单，语义见 `ScenarioTool`） */
  tools: ScenarioTool[];
  /**
   * 推荐的 Agent id。仅作**预选建议** —— UI 必须按注册表兜底：
   * 该 Agent 不在线/不存在时不要预选，也不要阻止用户改选。
   */
  recommendedAgentId?: string;
  /** 建议的权限模式。问答/写作 = 'plan'（只读），开发/代码 = 'acceptEdits'（可读写+命令） */
  permissionMode: PermissionMode;
  /** 是否需要绑定工作目录（开发/代码）。UI 据此提示用户填 cwd */
  needsCwd?: boolean;
  /** 图标键，由 UI 映射到具体图标组件（避免数据层耦合 UI 库） */
  icon: string;
  /** 主题色 */
  color: string;
}

/** 六个场景模板。顺序即 UI 展示顺序。 */
export const SCENARIOS: ScenarioTemplate[] = [
  {
    id: 'work',
    label: '工作',
    description: '通用任务处理，可调用工具',
    systemPrompt:
      '你是通用任务助理。先理解目标，必要时使用工具（读写文件、执行命令、联网检索）完成任务，最后给出清晰结论。',
    tools: ['tools'],
    recommendedAgentId: 'workbuddy',
    permissionMode: 'default',
    icon: 'briefcase',
    color: '#0052D9',
  },
  {
    id: 'qa',
    label: '问答',
    description: '知识问答，只读不改动',
    systemPrompt:
      '你是知识问答助手。只做只读分析与解答，不写文件、不执行命令。回答准确、简洁，不确定时明确说明而不是猜测。',
    tools: [],
    recommendedAgentId: 'workbuddy',
    permissionMode: 'plan',
    icon: 'help-circle',
    color: '#0594FA',
  },
  {
    id: 'dev',
    label: '开发',
    description: '读写文件 + 执行命令，需工作目录',
    systemPrompt:
      '你是开发助手，在本机工作目录内作业。可读写文件、执行命令。改动前先定位相关代码，避免无关重构；完成后说明改了什么、如何验证。',
    // 白名单是排他的：开发时要查文档/报错，所以 search 必须显式列出，
    // 否则会被「只允许 file + shell」拦掉。
    tools: ['file', 'shell', 'search'],
    recommendedAgentId: 'opencode',
    permissionMode: 'acceptEdits',
    needsCwd: true,
    icon: 'wrench',
    color: '#0E7A5F',
  },
  {
    id: 'code',
    label: '代码',
    description: '专注代码生成与审查',
    systemPrompt:
      '你是代码助手，专注代码生成与审查。给出可运行的代码，指出潜在缺陷与边界情况；改动尽量小而聚焦。',
    // Glob/Grep 归入 file 类（都是本机文件操作），所以只列 file 也能检索代码
    tools: ['file'],
    recommendedAgentId: 'opencode',
    permissionMode: 'acceptEdits',
    needsCwd: true,
    icon: 'code',
    color: '#534AB7',
  },
  {
    id: 'write',
    label: '写作',
    description: '长文本创作，不调用工具',
    systemPrompt:
      '你是写作助手，专注长文本创作。不调用工具。结构清晰、语言自然，先给要点再成文。',
    tools: [],
    recommendedAgentId: 'workbuddy',
    permissionMode: 'plan',
    icon: 'pen-line',
    color: '#834EC2',
  },
  {
    id: 'image',
    label: '生图',
    description: '图像生成（走生图 provider）',
    systemPrompt:
      '你是图像生成助手。根据用户描述生成图像，必要时简洁确认风格与比例后产出。',
    tools: ['image'],
    recommendedAgentId: 'hermes',
    permissionMode: 'default',
    icon: 'image',
    color: '#D54941',
  },
];

/** 按 id 取场景模板 */
export function getScenario(id: string | undefined): ScenarioTemplate | undefined {
  if (!id) return undefined;
  return SCENARIOS.find(s => s.id === id);
}

/** 白名单是否构成实际限制（`['tools']` 等于不限，空数组等于全禁） */
export function isRestrictiveWhitelist(tools: readonly ScenarioTool[]): boolean {
  return !tools.includes('tools');
}

/**
 * 该白名单是否在**限制危险能力**（写文件 / 执行命令）。
 *
 * 用途只有一个：决定要不要为用户提示「白名单落不了地」。
 * `['file','shell','search']`（开发场景）虽然也是排他白名单，但它把危险能力
 * 都放进来了，落不落地对用户没有实际影响 —— 提示它只会变成噪音。
 * 真正值得提醒的是「这个场景刻意不让 Agent 碰 shell/文件写，但拦不住」。
 */
export function restrictsDangerousTools(tools: readonly ScenarioTool[]): boolean {
  if (tools.includes('tools')) return false;
  return !(tools.includes('file') && tools.includes('shell'));
}

/** 把类别列表拼成给用户看的文字，如「文件 / 命令」 */
export function describeTools(tools: readonly ScenarioTool[]): string {
  if (tools.length === 0) return '无';
  return tools.map(t => SCENARIO_TOOL_LABEL[t] ?? t).join(' / ');
}

/**
 * 场景要求的约束，当前 Agent 能否**真的**强制。
 *
 * 返回 `null` 表示能强制（或场景没约束）；否则返回给用户看的提示文案。
 *
 * 为什么必须把这个差异显式说出来：`permissionMode` / `tools` 都只是声明，
 * 是否落地取决于适配器有没有把它翻译成 CLI 开关。实测 5 个可用 Agent 里有 3 个
 * 连只读都落不了地（见 `server/agents/permissions.ts` 的矩阵与依据）。
 * 不提示的话，用户会以为选了「问答」就真的只读 —— 那是个假保障，比没有更危险。
 *
 * ⚠️ 这是**唯一实现**。`server/agents/permissions.ts` 的 `describeEnforcementGap()`
 *    只是按 scenarioId 取场景后调用本函数，不再另写一份判据 ——
 *    P4-5 之前前后端各有一份、靠逐字比对防漂移，共享层建立后这个根因已经消除。
 */
export function enforcementGap(
  scenario: ScenarioTemplate | undefined,
  support: PermissionSupport | undefined
): string | null {
  if (!scenario) return null;

  const mode = scenario.permissionMode;
  const modeEnforced = support?.enforced?.includes(mode) === true;
  const toolsEnforced = support?.toolWhitelist?.enforced === true;
  const modeReason = support?.limitation ?? '该 Agent 未声明权限强制能力';

  /**
   * 权限模式这一侧，什么时候算「需要提示的缺口」？
   *
   *   - `plan`（只读）落不了地 → **安全性缺口**，必须提示；
   *   - Agent 有已知偏离（如 gemini 把 default 退化成只读）→ **功能性偏差**，必须提示；
   *   - 其他模式（`default` / `acceptEdits` / `bypassPermissions`）落不了地
   *     → 只是「没有对应的沙箱开关」，而这些模式的默认行为本来就是放行，
   *       提示它属于噪音（例如「开发」场景配 opencode 会顶着一条无意义的警告）。
   */
  const modeGap = !modeEnforced && (mode === 'plan' || support?.deviates?.includes(mode) === true);

  // ① 只读场景：承诺「不调用工具」，可执行手段是 permissionMode = plan
  if (scenario.tools.length === 0) {
    if (!modeGap) return null;
    return `该场景承诺「只读 / 不调用工具」，但 ${modeReason}。`;
  }

  // ② 无限制 / 不限制危险能力：只关心权限模式
  if (!restrictsDangerousTools(scenario.tools)) {
    if (!modeGap) return null;
    return `该 Agent 无法强制「${mode}」权限：${modeReason}。`;
  }

  // ③ 部分白名单（且确实在限制危险能力）：权限模式与工具白名单任一落不了地都要说
  if (!modeGap && toolsEnforced) return null;
  const parts: string[] = [];
  if (!toolsEnforced) {
    const reason = support?.toolWhitelist?.limitation ?? '该 Agent 不支持按类别裁剪工具';
    parts.push(`该场景只允许「${describeTools(scenario.tools)}」类工具，但 ${reason}`);
  }
  if (modeGap) {
    parts.push(`无法强制「${mode}」权限：${modeReason}`);
  }
  return `${parts.join('；')}。`;
}
