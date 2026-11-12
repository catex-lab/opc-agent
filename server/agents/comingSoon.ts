/**
 * 「即将接入」占位清单（A210）。
 *
 * ## 为什么这份清单绝不能放进 AGENT_DEFS
 *
 * `registry.ts` 构造时遍历 `AGENT_DEFS` 逐个 `createProvider()`，
 * `list()` / `probeAll()` / `get()` 都从同一个 Map 派生。塞进去就等于：
 * 被实例化、被后台探测、能被选中发消息。更糟的是
 * `GetAgentsDialog.tsx:74` 的 `isInstallable()` 会把 `not-installed`
 * 判成「可安装」并画出安装按钮 —— 点了装不上，比不展示更伤。
 *
 * 也不要复用 `RETIRED_AGENT_IDS`：那是「定义保留、registry 跳过」的
 * **下架**机制，定义仍在 `AGENT_DEFS` 里，`findDef()` 与模型目录仍会撞上，
 * 语义正好相反。
 *
 * ## 正确形态
 *
 * 纯展示数据，由 `GET /api/agents` 以**平级字段** `comingSoon` 下发，
 * `agents` 数组原样不动 —— 所有 `agents.map/filter` 消费方都不可能把
 * 占位条目当成可选 Agent（A151：判有没有要看后端给的归属，不看数组长度）。
 *
 * 真接入时用**同一个 id** 转正：从本清单移除、进 AGENT_DEFS，用户能看到
 * 条目从灰变亮。因此 id 命名要与未来定义一致，别用临时的 `soon-*` 前缀。
 *
 * ## 口径
 *
 * 不写日期、不写目标版本：这是规划展示，不是交付承诺。
 * `status: 'soon'` = 接入方式已确证、只差适配；`'planned'` = 已规划但形态仍需验证。
 */

export type ComingSoonTier = 'acp' | 'stream-json' | 'evaluating';

export interface ComingSoonAgent {
  /** 与未来真实接入的 AGENT_DEFS 条目同 id，转正时不用改前端 */
  id: string;
  name: string;
  vendor: string;
  tier: ComingSoonTier;
  status: 'soon' | 'planned';
  /** 一句话依据，只写调研已确证的事实 */
  reason: string;
  /** 字母色块用（与 AGENT_DEFS.color 同性质的数据字段） */
  color: string;
}

export const COMING_SOON_TIER_LABEL: Record<ComingSoonTier, string> = {
  acp: '原生 ACP',
  'stream-json': '流式输出',
  evaluating: '评估中',
};

export const COMING_SOON_STATUS_LABEL: Record<ComingSoonAgent['status'], string> = {
  soon: '即将接入',
  planned: '规划中',
};

/**
 * 精选 10 家：全部来自 2026-11-12 生态调研中**有第一方证据**的条目。
 * 不含项目已接入的 16 条，不含「只有 IDE 插件 / 只有云 API / 无流式输出」
 * 的厂商（那些放进来等于承诺一个做不到的形态）。
 */
export const COMING_SOON_AGENTS: readonly ComingSoonAgent[] = [
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    vendor: 'GitHub · Microsoft',
    tier: 'acp',
    status: 'soon',
    reason: '官方 public preview：copilot --acp --stdio，NDJSON 会话更新',
    color: '#185FA5',
  },
  {
    id: 'kiro-cli',
    name: 'Kiro CLI',
    vendor: 'AWS',
    tier: 'acp',
    status: 'soon',
    reason: '官方 kiro-cli acp，支持 session/load 与工具调用流式',
    color: '#0F6E56',
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    vendor: 'xAI',
    tier: 'acp',
    status: 'soon',
    reason: '官方声明原生 ACP，另有 streaming-json 输出',
    color: '#5F5E5A',
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    tier: 'acp',
    status: 'soon',
    reason: 'dsh --profile acp（ACP 是 profile，不是独立命令）',
    color: '#378ADD',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    vendor: '阿里巴巴',
    tier: 'stream-json',
    status: 'planned',
    reason: 'qwen -p --output-format stream-json；ACP 入口是 qwen serve',
    color: '#534AB7',
  },
  {
    id: 'codebuddy-code',
    name: 'CodeBuddy Code',
    vendor: '腾讯',
    tier: 'stream-json',
    status: 'planned',
    reason: 'CLI/ACP 形态，与现有 SDK 通道不同账号',
    color: '#1D9E75',
  },
  {
    id: 'comate-cli',
    name: 'Comate CLI',
    vendor: '百度',
    tier: 'stream-json',
    status: 'planned',
    reason: 'comatecli -d delta-stream|event-stream，需另写解析器',
    color: '#993C1D',
  },
  {
    id: 'mimo-code',
    name: 'MiMo Code',
    vendor: '小米',
    tier: 'acp',
    status: 'planned',
    reason: 'mimo acp；无 -p，流式格式与 Claude Code 不同构',
    color: '#BA7517',
  },
  {
    id: 'minimax-code',
    name: 'MiniMax Code',
    vendor: 'MiniMax',
    tier: 'acp',
    status: 'planned',
    reason: 'mcode acp；另有官方 SDK 可 stream/resume',
    color: '#993556',
  },
  {
    id: 'devin-cli',
    name: 'Devin CLI',
    vendor: 'Cognition',
    tier: 'evaluating',
    status: 'planned',
    reason: '已收录 ACP Registry，本机调用形态待验证',
    color: '#444441',
  },
];

/** 闸门用：不允许占位 id 与已注册 Agent 撞车 */
export function comingSoonIds(): string[] {
  return COMING_SOON_AGENTS.map(a => a.id);
}
