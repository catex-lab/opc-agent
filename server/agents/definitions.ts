/**
 * 本机 Agent 定义表。
 *
 * 每个 Agent 的静态信息（名称、厂商、能力、调用方式）集中在这里。
 * 新增一个 Agent = 在 AGENT_DEFS 里加一条 + （若需要新适配器）实现一个 adapter。
 */

import type { AgentDescriptor, AgentEvent, SendContext } from './types.js';
import { codexSandboxFor } from './permissions.js';

/** 权限模式 → 各 CLI 的审批参数 */
export type PermissionMode = NonNullable<SendContext['permissionMode']>;

/** CLI 调用规格 */
export interface CliSpec {
  /** PATH 中查找的命令名 */
  bin: string;
  /** 构造 argv（不含命令本身与垫片前缀参数） */
  buildArgs(prompt: string, ctx: SendContext): string[];
  /** stdout 解析方式 */
  parse: 'text' | 'jsonl';
  /** jsonl 模式下把一行 JSON 映射为统一事件；返回 null 表示该行无输出价值 */
  mapLine?(obj: unknown): AgentEvent | null;
  /** 从一行 JSON 中提取续接上下文的令牌 */
  extractResumeToken?(obj: unknown): string | null;
  /**
   * 整体超时（毫秒）。默认 8 分钟。
   *
   * 为什么必须有：这些 CLI 在遇到网络故障时会**无限重连**而不是退出
   * （codex 实测会一直打印 "Reconnecting... waiting for network"）。
   * 没有超时的话，一次对话就能把 HTTP 请求永久挂住。
   */
  timeoutMs?: number;
  /**
   * stderr 命中该模式即判定为不可恢复，立即终止并报错。
   * 用于把「会一直重试但永远不会成功」的情况快速失败。
   */
  fatalStderrPattern?: RegExp;
}

/** 一个 Agent 的完整定义 */
export interface AgentDefinition {
  descriptor: AgentDescriptor;
  /** kind === 'cli' 时必填 */
  cli?: CliSpec;
  /** 已知的不可用原因（用于 GUI-only 之类） */
  unsupportedReason?: string;
  /**
   * 凭据检查：环境变量名。命中任一即认为已配置。
   * 用于在名册页直接显示「未登录」而不是等第一次调用才报错。
   */
  authEnvs?: string[];
  /** 凭据检查：相对 home 目录的凭据文件路径 */
  authFiles?: string[];
  /**
   * 额外搜索目录（支持 `%LOCALAPPDATA%` 这类模板）。
   * 用于装在 PATH 之外的工具，例如 Hermes 的 bin 目录。
   */
  extraPaths?: string[];
  /**
   * 运行时必须能访问到的后端主机（不含协议，可带端口，默认 443）。
   *
   * 判定规则：**全部**主机都不可达时，才把该 Agent 标为 `unreachable`。
   * 之所以取「全不可达」而非「任一不可达」，是为了不产生误报 ——
   * 只要有一条路通，就说明网络层没被整体切断，不该替 Agent 下结论。
   *
   * 探测走的是与 CLI 子进程完全相同的链路（有代理就走代理），
   * 否则会出现「探测说通、真调用不通」的偏差。
   */
  backendHosts?: string[];
  /**
   * 该 Agent 可选的模型列表（CLI 类 Agent 用）。
   *
   * 为什么必须在定义表里显式声明：模型名是**各 Agent 私有的命名空间**。
   * opencode 认 `zai/glm-4.7` 这种 `provider/model` 形式，codex 认 `gpt-5.4`，
   * 而平台的默认模型（如 `claude-sonnet-4`）对它们全都无意义 ——
   * 注入过去只会让调用直接失败。有了这个白名单，后端就能把
   * 「用户选的模型是否属于这个 Agent」判断清楚。
   */
  models?: string[];
  /** 未显式选择模型时使用的模型（通常取 models[0] 中已验证可用的那个） */
  defaultModel?: string;
  /**
   * 模型选择权在谁手上。
   *
   * - `'agent'`（默认）：Agent 自己决定用哪个模型，客户端**不提供**选择器。
   *   这不是偷懒 —— hermes 这类 ACP Agent 虽然会在 `session/new` 里上报
   *   几百个模型，但实测它的 `session/set_model` 对任意 modelId
   *   （包括 `__nonsense_model__`）都返回 ok，既不校验也不生效。
   *   照上报列表做个下拉，就是给用户一个**假控件**：选完毫无变化，
   *   还会把无意义的 model 值写进会话记录，让人误以为切换成功过。
   * - `'client'`：确认过客户端调用 `session/set_model` 真能生效后才设。
   *   在此之前一律保持 `'agent'`。
   */
  modelSelection?: 'client' | 'agent';
}

/** 把统一的权限模式映射到 gemini 的 approval-mode */
function geminiApproval(mode: PermissionMode | undefined): string {
  switch (mode) {
    case 'acceptEdits':
      return 'auto_edit';
    case 'bypassPermissions':
      return 'yolo';
    case 'plan':
    case 'default':
    default:
      return 'plan'; // 只读，最安全
  }
}

// ============= 定义表 =============

export const AGENT_DEFS: AgentDefinition[] = [
  // ---------- 首批就绪 ----------
  {
    descriptor: {
      id: 'workbuddy',
      name: 'WorkBuddy',
      vendor: 'Tencent',
      kind: 'sdk',
      capabilities: ['chat', 'code', 'write', 'tools', 'search', 'image'],
      description: '全能型主控 Agent，可读写文件、执行命令、联网检索，适合担任群聊的调度中枢',
      icon: 'workbuddy',
      color: '#0EC8A9',
      installHint: '通过 CodeBuddy CLI 登录，或在设置页填入 API Key',
    },
  },
  {
    descriptor: {
      id: 'codex',
      name: 'Codex',
      vendor: 'OpenAI',
      kind: 'cli',
      capabilities: ['chat', 'code', 'tools'],
      description: 'OpenAI 官方编码 Agent，擅长代码生成、重构与仓库级修改',
      icon: 'codex',
      color: '#1F1F1F',
      command: 'codex',
      installHint: 'npm i -g @openai/codex，然后 codex login',
    },
    cli: {
      bin: 'codex',
      buildArgs: (prompt, ctx) => {
        const args = ['exec', '--skip-git-repo-check'];
        if (ctx.model) args.push('-m', ctx.model);
        // P4-5：权限模式必须落到 codex 的沙箱策略上。
        // 之前这里完全忽略 permissionMode —— 于是「问答」场景（plan = 只读）配 codex 时，
        // codex 仍以默认沙箱运行、照样能改文件，「只读」是个空承诺。
        // `-s/--sandbox` 的三个取值由 `codex exec --help` 实测确认。
        const sandbox = codexSandboxFor(ctx.permissionMode);
        if (sandbox) args.push('-s', sandbox);
        args.push(prompt);
        return args;
      },
      parse: 'text',
      // 实测：codex 在连不上 chatgpt.com 时会无限重连，必须主动判死
      fatalStderrPattern: /waiting for network/i,
    },
    // 实测：codex 唯一的后端 chatgpt.com 被代理以 502 拒绝（CONNECT tunnel
    // failed），而 0.161.0 又移除了 wire_api="chat"，无法改指向任何
    // OpenAI 兼容端点 —— 于是凭据有效却一次都调不通，必须如实上报。
    backendHosts: ['chatgpt.com', 'api.openai.com'],
    // 本机实测：~/.codex/auth.json 内含 auth_mode / tokens / last_refresh
    authEnvs: ['OPENAI_API_KEY'],
    authFiles: ['.codex/auth.json'],
  },
  {
    descriptor: {
      id: 'gemini',
      name: 'Gemini',
      vendor: 'Google',
      kind: 'cli',
      capabilities: ['chat', 'code', 'write', 'search'],
      description: 'Google 官方 CLI Agent，上下文窗口大，适合长文档分析与方案评审',
      icon: 'gemini',
      color: '#3C3489',
      command: 'gemini',
      installHint: 'npm i -g @google/gemini-cli，并设置 GEMINI_API_KEY',
    },
    cli: {
      bin: 'gemini',
      buildArgs: (prompt, ctx) => {
        const args = ['-p', prompt, '--approval-mode', geminiApproval(ctx.permissionMode)];
        if (ctx.model) args.push('-m', ctx.model);
        return args;
      },
      parse: 'text',
    },
    // 实测：generativelanguage.googleapis.com 同样被代理 502 拒绝
    backendHosts: ['generativelanguage.googleapis.com'],
    // 本机实测：~/.gemini/settings.json 声明了 selectedType=gemini-api-key，
    // 但 GEMINI_API_KEY 未设置、也无 oauth_creds.json → 判定为未登录
    authEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    authFiles: ['.gemini/oauth_creds.json'],
  },
  {
    descriptor: {
      id: 'opencode',
      name: 'OpenCode',
      vendor: 'SST',
      kind: 'cli',
      capabilities: ['chat', 'code', 'tools'],
      description: '开源终端编码 Agent，支持多模型provider，适合本地仓库内作业',
      icon: 'opencode',
      color: '#085041',
      command: 'opencode',
      installHint: 'npm i -g opencode-ai，并配置至少一个 provider 的 API Key',
    },
    cli: {
      bin: 'opencode',
      buildArgs: (prompt, ctx) => {
        const args = ['run'];
        if (ctx.model) args.push('-m', ctx.model);
        args.push(prompt);
        return args;
      },
      parse: 'text',
    },
    // 本机实测：~/.local/share/opencode 下只有 opencode.db，无 auth.json。
    //
    // 但它并不需要 auth.json —— `opencode auth list` 显示它直接从**环境变量**
    // 读取各 provider 的凭据（DeepSeek / GitHub Copilot / Z.AI / Zhipu /
    // SenseNova 均已就绪）。只认 OPENCODE_API_KEY 会造成「明明能用却报未登录」
    // 的假阴性，所以这里列全它实际会消费的变量名。
    authEnvs: [
      'OPENCODE_API_KEY',
      'DEEPSEEK_API_KEY',
      'ZHIPU_API_KEY',
      'GLM_API_KEY',
      'GITHUB_TOKEN',
      'COPILOT_GITHUB_TOKEN',
      'SENSENOVA_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'DASHSCOPE_API_KEY',
      'KIMI_API_KEY',
      'MOONSHOT_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
    ],
    authFiles: ['.local/share/opencode/auth.json'],
    // 逐个真实调用验证过能返回文本的模型（`opencode run -m <id>`）。
    // 只列验证过的：列一个跑不通的，等于把失败甩给用户。
    models: [
      'zai/glm-4.7',
      'zhipuai/glm-4.7',
      'sensenova/glm-5.2',
      'opencode/deepseek-v4.1-flash-free',
    ],
    defaultModel: 'zai/glm-4.7',
  },

  // ---------- 待接入 ----------
  {
    descriptor: {
      id: 'claude',
      name: 'Claude Code',
      vendor: 'Anthropic',
      kind: 'cli',
      capabilities: ['chat', 'code', 'write', 'tools'],
      description: 'Anthropic 官方编码 Agent，长文本与代码理解见长',
      icon: 'claude',
      color: '#993C1D',
      command: 'claude',
      // 实测：bin/claude.exe 只有 500 字节，内容就是「native binary not installed」
      // 的报错脚本 —— 平台原生可选依赖 @anthropic-ai/claude-code-win32-x64 没装上
      installHint:
        '原生二进制缺失。修复：在 claude-code 包目录下执行 node install.cjs（或不用 --ignore-scripts / --omit=optional 重装）',
    },
    cli: {
      bin: 'claude',
      buildArgs: (prompt, ctx) => {
        const args = ['-p', prompt, '--output-format', 'text'];
        if (ctx.model) args.push('--model', ctx.model);
        return args;
      },
      parse: 'text',
    },
    authEnvs: ['ANTHROPIC_API_KEY'],
    authFiles: ['.claude/.credentials.json', '.claude.json'],
  },
  {
    descriptor: {
      id: 'hermes',
      name: 'Hermes',
      kind: 'acp',
      // 实测：ACP initialize 时注册了 image_gen / web 插件，
      // session/new 返回了 60+ 个可用模型，能力比最初估计的强
      capabilities: ['chat', 'code', 'write', 'tools', 'image', 'search'],
      description: 'Hermes Agent，通过 ACP 协议接入。自带图像生成与联网检索插件，模型选择丰富',
      icon: 'hermes',
      color: '#5F5E5A',
      command: 'hermes-acp',
      installHint: 'Hermes 通过 ACP（stdio JSON-RPC）接入，需 hermes-acp 可执行文件',
    },
    // Hermes 的 bin 目录不在 PATH 中，需要显式加入搜索
    extraPaths: ['%LOCALAPPDATA%\\hermes\\bin'],
    authFiles: ['AppData/Local/hermes/auth.json', '.hermes/auth.json'],
  },
  {
    descriptor: {
      id: 'cursor',
      name: 'Cursor',
      kind: 'mock',
      capabilities: ['code'],
      description: 'Cursor IDE，仅提供图形界面，无 headless 调用方式',
      icon: 'cursor',
      color: '#2C2C2A',
      command: 'cursor',
      installHint: 'Cursor 本体仅 GUI；如需接入请额外安装 cursor-agent CLI',
    },
    unsupportedReason: '仅 GUI，无无头调用方式',
  },
  {
    descriptor: {
      id: 'qoder',
      name: 'Qoder',
      kind: 'mock',
      capabilities: ['code'],
      description: 'Qoder IDE，仅提供图形界面，无 headless 调用方式',
      icon: 'qoder',
      color: '#444441',
      command: 'qoder',
      installHint: 'Qoder 本体仅 GUI；如需接入请确认其是否提供 CLI',
    },
    unsupportedReason: '仅 GUI，无无头调用方式',
  },
  {
    descriptor: {
      id: 'doubao',
      name: '豆包',
      vendor: 'ByteDance',
      kind: 'mock',
      capabilities: ['chat', 'write', 'image'],
      description: '字节跳动豆包，需安装 CLI 或接入 API',
      icon: 'doubao',
      color: '#B0479E',
      installHint: '未在本机找到可执行文件；可接入火山方舟 API',
    },
    unsupportedReason: '本机未安装',
  },
  {
    descriptor: {
      id: 'zcode',
      name: 'ZCode',
      kind: 'mock',
      capabilities: ['chat', 'code'],
      description: 'ZCode，需安装 CLI 或接入 API',
      icon: 'zcode',
      color: '#534AB7',
      installHint: '未在本机找到可执行文件',
    },
    unsupportedReason: '本机未安装',
  },
  {
    descriptor: {
      id: 'kimicode',
      name: 'KimiCode',
      vendor: 'Moonshot',
      kind: 'mock',
      capabilities: ['chat', 'code', 'write'],
      description: '月之暗面 Kimi，需安装 CLI 或接入 API',
      icon: 'kimicode',
      color: '#26215C',
      installHint: '未在本机找到可执行文件；可接入 Moonshot API',
    },
    unsupportedReason: '本机未安装',
  },
];

/** 按 id 快速查找 */
export function findDef(id: string): AgentDefinition | undefined {
  return AGENT_DEFS.find(d => d.descriptor.id === id);
}
