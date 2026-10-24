/**
 * Qoder Agent SDK 适配器（A76）。
 *
 * ## 为什么要有它
 *
 * `qoder` 原来走 `CliAdapter` + `parse: 'text'` —— 也就是「把 qodercli 的
 * stdout 当纯文本吐出来」。这条路上丢了三样东西：
 *
 *   1. **思考过程**：SDK 协议里 `thinking` 块是原生的
 *      （实测 `{type:'thinking', thinking:'…'}`），文本模式完全拿不到；
 *   2. **工具卡片**：文本模式只有最终回复，工具调用与结果看不见，
 *      于是界面上这个 Agent 永远「没有过程」；
 *   3. **准确的用量**：`result` 里有 `usage` / `total_cost_usd` /
 *      `total_credits` / `modelUsage`，文本模式只能靠字数估。
 *
 * ## 它**不是**一条新的「接入方式」
 *
 * Qoder SDK 的默认 transport 是 Worker（自带 70 MB 运行时），但它同样支持
 * `ProcessTransport` —— **在本机拉起 `qodercli` 子进程**再走 JSONL 双向协议。
 * 底层仍然是那个 CLI，只是协议从「读 stdout」变成「双向说话」。
 * 所以 `descriptor.kind` 保持 `cli` 不变：
 *
 *   - `kind` 决定「默认适配器」，`AgentDefinition.sdk` 是同一 kind 上的
 *     **通道升级**（SDK 优先、失败回退 CLI），不是第二套接入方式；
 *   - 前端有几处按 `kind === 'sdk'` 判「用平台模型列表」（`App.tsx` 的
 *     `activeModels`）。把 qoder 改成 `sdk` 会让它在清单拿不到时回退到
 *     CodeBuddy 的模型名 —— 那些名字 qodercli 一个都不认。
 *
 * ## 两条通道：优先 + 兜底
 *
 * ```
 * send() ──▶ SDK 可用? ──是──▶ query() ──握手成功──▶ 事件流（含 thinking / tool）
 *                │                  └──握手失败──▶ 回退 CliAdapter
 *                └──否──────────────────────────▶ CliAdapter
 * ```
 *
 * 唯一的例外：**用户要的是 `plan`（只读）时不回退**。CLI 通道没有只读沙箱，
 * plan 只能退化成 `dont_ask`（近似只读，不是保证）。为了一句「答得出来」而把
 * 只读承诺悄悄降级，正是本项目一直在防的静默降级 —— 这种情况直接报错。
 *
 * ## 实测依据（2026-10-22，本机 qodercli 1.1.73 + SDK 1.0.55）
 *
 * 事件形状来自两次真实探针（`.tmp/qoder-probe/probe*.mjs`），不是照抄文档：
 *
 * ```
 * system/init                     { session_id, model, permissionMode, tools[50] }
 * system/available_models_update  { models[16], currentModel }
 * system/permission_denied        { tool_name, tool_use_id, message }
 * assistant     { message.content: [ {thinking} | {text} | {tool_use} ] }
 * user          { message.content: [ {type:'tool_result', tool_use_id, content} ] }
 * stream_event  { event: {type:'content_block_delta', delta:{text_delta|thinking_delta}} }
 * result        { subtype, is_error, duration_ms, num_turns, total_cost_usd,
 *                 total_credits, usage, modelUsage, permission_denials }
 * ```
 *
 * ### 一个没采用的「红利」，理由写在这里免得下次有人再试
 *
 * `system/available_models_update` 里有结构化的模型清单（16 条，含
 * `displayName` / `priceFactor` / `availableContextWindows`），看起来正好能
 * 替代 `qodercli --list-models` 的文本解析。**没有采用**，两个原因：
 *
 *   - 这个事件只有**跑完一次真实对话**才会到（本机冷启动 ~65s），而
 *     `--list-models` 只要 7.5s 且有磁盘缓存。拿它当清单源 = 打开模型菜单等一分钟；
 *   - 它只给 `isEnabled: true` 的两条系统模型（qfmodel / dfmodel），
 *     **不含用户自建的自定义模型**（`--list-models` 会列出来）。
 *     换过去等于把用户自己的模型从菜单里弄丢。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncQueue, PendingReplies, linkAbort } from '../channel.js';
import { decideToolAccess } from '../toolPolicy.js';
import { evaluateToolCall } from '../permission-gate.js';
import { currentPermissionRules } from '../../permission-rules.js';
import { withMemoryContext } from '../../memory.js';
import { findExecutable, expandPath, probeVersion } from '../probe.js';
import { probeQoderCn } from '../familyHints.js';
import { CliAdapter } from './cli.js';
import type { AgentDefinition } from '../definitions.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
  PermissionDecision,
  SendContext,
} from '../types.js';

/** 权限请求等待上限，与 SdkAdapter 一致 */
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

/**
 * 第一条消息的超时。
 *
 * 为什么给到 120s：本机 `qodercli` 是 218 MB 的原生二进制，冷启动
 * （首次拉起 + 杀软扫描）到第一帧要 60s 以上（实测整轮 83s / 94s 都出现过）。
 * 给 30s 会变成「每次第一轮对话都误判失败并回退」——比不设超时更糟。
 */
const FIRST_EVENT_TIMEOUT_MS = 120_000;

/** 整轮上限。CLI 通道是 8 分钟，这里放宽：SDK 多了握手与多轮工具往返 */
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000;

/** 单轮最大轮次，与 SdkAdapter 的 maxTurns 对齐 */
const MAX_TURNS = 10;

/**
 * plan 档允许的工具（**只读**）。
 *
 * 名字逐个来自 `system/init` 的 `tools` 数组实测（50 个），不是凭印象编的。
 * 未列入的一律拒绝 —— 白名单的语义就是「没列出的一律不行」。
 *
 * 刻意排除：`Bash`（任意命令）、`Write`/`Edit`/`NotebookEdit`（改磁盘）、
 * `Agent`/`Skill`（能拉子代理或加载技能，等于绕开白名单）、`ImageGen`（落盘）、
 * `TaskCreate`/`TaskUpdate`/`UpdateGoal`（写会话状态，只读场景不需要）、
 * `AskUserQuestion`（headless 下没有可交互终端）。
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TaskList',
  'TaskGet',
]);

/**
 * plan 档的**硬**黑名单。
 *
 * 与上面的白名单是两道不同的闸，不能互相替代：
 *   - 白名单作用在 `canUseTool` 回调里，而**只读工具根本不经过这个回调**
 *     （实测：探针里 `Read` 被自动放行，`permissionCalls` 是 0）；
 *   - `disallowedTools` 是传给 CLI 的硬拒绝名单，不需要经过回调。
 *
 * 所以会改磁盘 / 执行命令的那批工具必须同时出现在这里 —— 否则一个
 * 「不需要授权」的写工具就能从回调的缝隙里过去。
 */
export const PLAN_DENY_TOOLS: readonly string[] = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Agent',
  'Skill',
  'ImageGen',
];

/** SDK 里我们真正用到的三个导出（不引类型，避免对可选包产生编译期依赖） */
interface QoderSdkModule {
  query(params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<unknown>;
  qodercliAuth(): unknown;
  ProcessTransport: new (options: Record<string, unknown>) => unknown;
}

/**
 * 两个产品系列各自的事实。
 *
 * 差异**只有三处**（包名 / PAT 环境变量名 / 显示名）—— 因为两份 README
 * 逐节同构（各 685 行，2026-10-22 核对）。所以一个适配器参数化两次就够。
 */
export interface QoderFlavor {
  /** npm 包名。ESM-only，只能动态 import */
  pkg: string;
  /** 个人访问令牌的环境变量名（两个品牌各一个，由 CLI 自己读取） */
  patEnv: string;
  /** 给人看的品牌名，只用于提示文案 */
  label: string;
}

export const QODER_FLAVORS: Record<string, QoderFlavor> = {
  'qoder-intl': {
    pkg: '@qoder-ai/qoder-agent-sdk',
    patEnv: 'QODER_PERSONAL_ACCESS_TOKEN',
    label: 'Qoder',
  },
  'qoder-cn': {
    pkg: '@qodercn-ai/qodercn-agent-sdk',
    patEnv: 'QODERCN_PERSONAL_ACCESS_TOKEN',
    label: 'Qoder CN',
  },
};

/**
 * 模块加载缓存（按包名）。
 *
 * 失败也缓存：缺包是**环境状态**，不是瞬时故障。每次调用都重试只会让
 * 「没装 SDK」的用户每轮对话多等一次失败的模块解析。
 */
const moduleCache = new Map<string, Promise<QoderSdkModule>>();

function loadSdkModule(pkg: string): Promise<QoderSdkModule> {
  let pending = moduleCache.get(pkg);
  if (!pending) {
    pending = (async () => {
      // 变量形式的动态 import：esbuild 的 `packages: 'external'` 会原样保留它，
      // 不在构建期解析（已实测：CJS 产物里是 `await import(...)`）。
      const mod = (await import(pkg)) as unknown as QoderSdkModule;
      for (const key of ['query', 'qodercliAuth', 'ProcessTransport'] as const) {
        if (typeof (mod as unknown as Record<string, unknown>)[key] !== 'function') {
          throw new Error(`${pkg} 缺少导出 ${key}（版本不匹配？）`);
        }
      }
      return mod;
    })();
    moduleCache.set(pkg, pending);
  }
  return pending;
}

export class QoderSdkAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;

  private readonly def: AgentDefinition;
  private readonly flavor: QoderFlavor;
  /** CLI 兜底通道（`def.cli` 一定存在，见 definitions.ts 的 qoder 条目） */
  private readonly fallback: CliAdapter;

  /** 正在运行的调用：sessionId → 中止控制 */
  private active = new Map<string, { abort: () => void }>();
  /** 待答复的权限请求 */
  private replies = new PendingReplies<PermissionDecision>();
  /** 探测缓存 */
  private status: AgentStatus | null = null;
  /** 最近一次探测解析到的 CLI 绝对路径 */
  private cliPath: string | null = null;

  constructor(def: AgentDefinition) {
    const flavorKey = def.sdk?.flavor;
    const flavor = flavorKey ? QODER_FLAVORS[flavorKey] : undefined;
    if (!flavor) {
      throw new Error(`QoderSdkAdapter 需要 sdk.flavor（收到 ${String(flavorKey)}）`);
    }
    if (!def.cli) {
      throw new Error(`QoderSdkAdapter 需要 cli 规格做兜底: ${def.descriptor.id}`);
    }
    this.def = def;
    this.descriptor = def.descriptor;
    this.flavor = flavor;
    this.fallback = new CliAdapter(def);
  }

  // ============= 探测 =============

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();

    // ① 先找 CLI —— ProcessTransport 要的就是这个可执行文件的绝对路径。
    //    没有它 SDK 也起不来（除非用 70 MB 的 Worker 运行时，本项目不用）。
    const binPath = this.resolveCli();
    if (!binPath) {
      this.status = {
        availability: 'not-installed',
        installed: false,
        message: this.notInstalledHint(),
        probedAt: now,
      };
      return this.status;
    }
    this.cliPath = binPath;

    // ② 凭据：PAT 环境变量或 CLI 自己写下的登录态文件
    const auth = this.checkAuth();

    // ③ SDK 包能不能加载（缺包不致命：还能走 CLI）
    const sdkErr = await this.sdkLoadError();

    const { version } = await probeVersion(binPath);

    if (!auth.ok) {
      this.status = {
        availability: 'needs-auth',
        installed: true,
        binaryPath: binPath,
        version,
        message: auth.hint,
        probedAt: now,
      };
      return this.status;
    }

    this.status = {
      availability: 'ready',
      installed: true,
      binaryPath: binPath,
      version,
      // 通道写进 message：名册上就能看出这一条现在走哪条路。
      // 措辞必须区分「SDK」与「CLI 回退」—— 两者的 plan 保证强度不同。
      message: sdkErr ? `就绪（CLI 通道：SDK 不可用 — ${sdkErr}）` : '就绪（SDK 通道）',
      probedAt: now,
    };
    return this.status;
  }

  private resolveCli(): string | null {
    return findExecutable(
      this.def.cli!.bin,
      (this.def.extraPaths ?? []).map(expandPath)
    );
  }

  /** 没装 CLI 时怎么把它弄上机器 */
  private notInstalledHint(): string {
    const base = `PATH 中未找到命令 \`${this.def.cli!.bin}\``;
    const hint = this.def.descriptor.installHint ? `。${this.def.descriptor.installHint}` : '';

    // 国内版补一句「本机到底有什么」：`~/.qoder-cn` 里往往只有桌面端，
    // 「PATH 里没这个命令」和「你装的是桌面端，bin 下只有 computer-use」
    // 对用户是两条完全不同的信息。
    let evidence = '';
    if (this.def.sdk?.flavor === 'qoder-cn') {
      try {
        const sib = probeQoderCn(os.homedir());
        if (sib) evidence = `。本机探测：${sib.evidence}`;
      } catch {
        // 探测失败不加这句 —— 不写「未知」
      }
    }

    return `${base}${hint}${evidence}`;
  }

  private async sdkLoadError(): Promise<string | null> {
    try {
      await loadSdkModule(this.flavor.pkg);
      return null;
    } catch (err) {
      return (err as Error)?.message || String(err);
    }
  }

  /**
   * 低成本凭据检查。
   *
   * 与 `CliAdapter.checkAuth` 同一套判据，但**不含** `credential`（A30）那一支：
   * Qoder 两个系列都是「CLI 自己存登录态」，没有可填的 API Key 表单。
   * 没声明任何凭据来源时一律按可用处理 —— 让第一次真实调用去暴露问题，
   * 而不是靠一个检测不到的启发式判「未登录」。
   */
  private checkAuth(): { ok: boolean; hint: string } {
    const pat = process.env[this.flavor.patEnv];
    if (typeof pat === 'string' && pat.trim().length > 0) {
      return { ok: true, hint: `已通过环境变量 ${this.flavor.patEnv} 配置凭据` };
    }

    const files = this.def.authFiles ?? [];
    if (files.length === 0) return { ok: true, hint: '' };

    const home = os.homedir();
    const hit = files.find(rel => {
      try {
        return fs.statSync(path.join(home, rel)).isFile();
      } catch {
        return false;
      }
    });
    if (hit) return { ok: true, hint: `已找到凭据文件 ~/${hit}` };

    return {
      ok: false,
      hint:
        `未找到登录态（~/${files[0]}）。先执行 \`${this.def.cli!.bin} login\`，` +
        `或设置环境变量 ${this.flavor.patEnv}`,
    };
  }

  // ============= 调用 =============

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    const mod = await this.tryLoadModule();

    if (!mod) {
      // SDK 不可用 → CLI 兜底。plan 档不许兜底（见文件头说明）。
      if (ctx.permissionMode === 'plan') {
        yield {
          type: 'error',
          message:
            `${this.flavor.label} 的只读（plan）模式需要 Agent SDK 通道，` +
            `而 SDK 当前不可用。请检查依赖是否安装完整，或改用其它 Agent。`,
        };
        return;
      }
      yield* this.fallback.send(ctx);
      return;
    }

    const queue = new AsyncQueue<AgentEvent>();
    const sessionId = ctx.sessionId;
    let aborted = false;
    /** 已经吐出去的「有内容」事件数（init 不算），用于判断握手是否失败 */
    let contentEvents = 0;

    const abort = () => {
      aborted = true;
      this.replies.clear();
      queue.close();
    };
    this.active.set(sessionId, { abort });
    const unlinkAbort = linkAbort(ctx.signal, abort);
    const started = Date.now();

    // ---- 后台泵：把 SDK 的 AsyncIterable 灌进队列 ----
    void (async () => {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => ac.abort(),
        FIRST_EVENT_TIMEOUT_MS
      );
      let firstSeen = false;
      const stderrBuf: string[] = [];

      try {
        const cli = this.cliPath ?? this.resolveCli();
        if (!cli) throw new Error(`PATH 中未找到 \`${this.def.cli!.bin}\``);
        this.cliPath = cli;

        const stream = mod.query({
          prompt: ctx.prompt,
          options: this.buildOptions(ctx, cli, ac, stderrBuf, mod, ev => {
            contentEvents++;
            queue.push(ev);
          }),
        });

        /**
         * 事件映射器。
         *
         * 抽成独立的工厂函数（而不是内联在这个循环里）有两个理由：
         *   1. 它是整个适配器里**唯一需要逐字核对**的部分 —— 抽出来才能用
         *      真实录到的事件做断言（`scripts/verify-qoder-sdk.ts`），
         *      否则验一次就要真跑 90 秒的模型调用；
         *   2. 它是有状态的（未闭合的工具、本轮是否已经吐过增量），
         *      每次调用新建一份，不会在并发会话之间串味。
         */
        const map = createQoderMapper({
          sessionId,
          model: ctx.model,
          startedAt: started,
          permissionMode: ctx.permissionMode,
        });

        for await (const raw of stream) {
          if (aborted) break;

          if (!firstSeen) {
            firstSeen = true;
            if (timer) clearTimeout(timer);
            // 握手完成 → 换成整轮上限
            timer = setTimeout(() => ac.abort(), TOTAL_TIMEOUT_MS);
          }

          for (const ev of map(raw)) {
            // init 不算「有内容」—— 它在我们开始迭代之前就已经发过一次了，
            // 拿它当证据会让握手失败的判断失效。
            if (ev.type !== 'init') contentEvents++;
            queue.push(ev);
          }
        }

        queue.close();
      } catch (err) {
        if (aborted) {
          queue.close();
          return;
        }
        const msg = (err as Error)?.message || String(err);
        const tail = stderrBuf.join('').trim().slice(-400);
        queue.fail(
          new Error(
            ac.signal.aborted
              ? `超时或已取消（${msg}）`
              : tail
                ? `${msg}｜stderr: ${tail}`
                : msg
          )
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    // ---- 前台：先给一个 init，再转发队列 ----
    //
    // 为什么先发一个「合成 init」：SDK 的第一个真实事件要等 CLI 冷启动
    // （实测 60s+），期间前端连消息气泡都不会出现。`SdkAdapter` 也是这么做的。
    // 它不参与 `contentEvents` 计数，所以握手失败时仍然可以安全回退。
    yield { type: 'init', sessionId, model: ctx.model };

    try {
      for await (const ev of queue) {
        yield ev;
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);

      // 一个内容事件都没发出去 = 握手阶段就失败了，消费者什么都没看到，
      // 这时回退 CLI 是**不可见**的，可以安全做（plan 除外）。
      if (contentEvents === 0 && !aborted) {
        console.warn(`[qoder-sdk] 握手失败，回退 CLI：${message}`);
        if (ctx.permissionMode === 'plan') {
          yield {
            type: 'error',
            message:
              `Qoder 的只读（plan）模式需要 SDK 通道，但握手失败：${message}。` +
              `已拒绝降级到 CLI —— 那条通道没有只读沙箱。`,
          };
          return;
        }
        yield* this.fallback.send(ctx);
        return;
      }

      yield { type: 'error', message };
    } finally {
      unlinkAbort();
      this.replies.clear();
      this.active.delete(sessionId);
    }
  }

  private async tryLoadModule(): Promise<QoderSdkModule | null> {
    try {
      return await loadSdkModule(this.flavor.pkg);
    } catch (err) {
      console.warn(`[qoder-sdk] ${this.flavor.pkg} 不可用：${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 组装 `query()` 的 options。
   *
   * 字段逐个对应 `Options` 类型（SDK 的 `dist/types/options.d.ts`）。
   * 只有实测过或类型注释明确写了的才写进来 —— 没把握的一律不猜。
   *
   * ⚠️ `public` 只是为了 `scripts/verify-qoder-sdk.ts` 能直接断言产出：
   * 这是整个适配器里最容易「悄悄写错一个字段名」的地方（写错了 SDK 不报错，
   * 只是那个能力不生效）。上层业务代码**不应**调用它。
   */
  buildOptions(
    ctx: SendContext,
    cliPath: string,
    ac: AbortController,
    stderrBuf: string[],
    mod: QoderSdkModule,
    push: (ev: AgentEvent) => void
  ): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      // 复用本机 `qodercli login` 写下的登录态（实测可用）。
      // PAT 环境变量不用在这里翻译 —— 它是 **CLI 自己的**变量，
      // 子进程继承环境后自然读到，SDK 只负责把 CLI 拉起来。
      auth: mod.qodercliAuth(),
      transport: new mod.ProcessTransport({
        pathToQoderCLIExecutable: cliPath,
        cwd: ctx.cwd || process.cwd(),
        stderr: 'pipe',
      }),
      cwd: ctx.cwd || process.cwd(),
      permissionMode: permissionModeOf(ctx.permissionMode),
      abortController: ac,
      maxTurns: MAX_TURNS,
      // 不开它，正文会整块到达（逐字流式变成「等半天然后一整段」）
      includePartialMessages: true,
      stderr: (data: string) => {
        // 只留尾部：CLI 的 stderr 有大量启动噪音
        stderrBuf.push(data);
        if (stderrBuf.length > 40) stderrBuf.shift();
      },
    };

    if (ctx.model) opts.model = ctx.model;
    if (ctx.resumeToken) opts.resume = ctx.resumeToken;

    // 思考强度：SDK 的 Options 里**没有** reasoning 字段（逐字段翻过），
    // 只能靠 `extraArgs` 透传给 qodercli（注释原文 "Additional qodercli flags"）。
    // 实测传 `{'reasoning-effort':'low'}` 不报错；合法值域与 CLI 一致
    // （auto/none/low/medium/high/xhigh/max/ultracode，来自 CLI 报错原文）。
    if (ctx.reasoningEffort) {
      opts.extraArgs = { 'reasoning-effort': ctx.reasoningEffort };
    }

    // 系统提示词：**追加**到 qodercli 的预设上，不替换。
    //
    // 为什么不能像 SdkAdapter 那样直接传字符串：qodercli 的预设提示词里带着
    // 工具定义与使用规则，整段替换掉模型就不会调工具了 —— 表现是「这个 Agent
    // 突然只会聊天」。`{type:'preset', preset:'qodercli', append}` 才是官方给
    // 「要加自己的规则」留的口子。
    // A98：带上 cwd，让记忆层把「当前项目」那一层也注入进来
    const extra = withMemoryContext(ctx.systemPrompt, ctx.memoryCwd).trim();
    if (extra) {
      opts.systemPrompt = { type: 'preset', preset: 'qodercli', append: extra };
    }

    // 只读：两道闸都要上（见 PLAN_DENY_TOOLS 的说明）
    if (ctx.permissionMode === 'plan') {
      opts.disallowedTools = PLAN_DENY_TOOLS;
    }

    if (ctx.permissionMode === 'bypassPermissions') {
      // SDK 要求这个开关与 bypassPermissions 成对出现，否则模式不生效。
      opts.allowDangerouslySkipPermissions = true;
    }

    opts.canUseTool = this.makeCanUseTool(ctx, push);
    return opts;
  }

  /**
   * 权限桥：SDK 回调 → 事件流 → 前端答复。
   *
   * 判定顺序与 `SdkAdapter` 一致，理由是同一套：
   *   场景白名单（场景约束）→ 高危门禁（任何模式都拦）→ bypass → 用户规则 → 弹窗
   */
  private makeCanUseTool(
    ctx: SendContext,
    push: (ev: AgentEvent) => void
  ): (
    toolName: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<unknown> {
    return async (toolName, input, options) => {
      // ① plan 档：只读白名单。放行集之外的**一律拒绝**，
      //    不给「问用户」的机会 —— 用户选的是只读，不是「逐次审批」。
      if (ctx.permissionMode === 'plan' && !READ_ONLY_TOOLS.has(toolName)) {
        console.log(`[qoder-sdk] plan 档拦截工具: ${toolName}`);
        return {
          behavior: 'deny',
          message: `只读模式不允许使用「${toolName}」（可用：${[...READ_ONLY_TOOLS].join(', ')}）。`,
        };
      }

      // ② 场景白名单（P4-5）
      const gate = decideToolAccess(ctx.allowedTools, toolName);
      if (!gate.allowed) {
        console.log(
          `[qoder-sdk] 工具被场景白名单拦截: ${toolName} (category=${gate.category ?? 'unlisted'})`
        );
        return { behavior: 'deny', message: gate.reason };
      }

      // ③ 高危门禁（A40）。放在 bypass 之前：全放行的含义是「不弹窗问人」，
      //    不是「连 rm -rf / 也照跑」。
      const verdict = evaluateToolCall({
        toolName,
        input: (input ?? {}) as Record<string, unknown>,
        cwd: ctx.cwd,
        rules: currentPermissionRules(),
      });
      if (verdict.decision === 'deny') {
        console.log(
          `[qoder-sdk] 门禁拦截 ${toolName}: ${verdict.rule} — ${verdict.reason ?? ''}`
        );
        return {
          behavior: 'deny',
          message: `[权限门禁] ${verdict.reason ?? verdict.rule ?? '高危操作'}`,
        };
      }

      // ④ 全放行
      if (ctx.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }

      // ⑤ 用户规则明示允许
      if (verdict.auto) {
        return { behavior: 'allow', updatedInput: input };
      }

      // ⑥ 弹窗问人
      const requestId = randomUUID();
      push({
        type: 'permission_request',
        requestId,
        toolUseId: typeof options?.toolUseID === 'string' ? options.toolUseID : undefined,
        toolName,
        input: (input ?? {}) as Record<string, unknown>,
        risk: verdict.risk,
        rule: verdict.rule,
      });

      const decision = await this.replies.register(
        requestId,
        () => ({ behavior: 'deny', message: '权限请求超时' }) as PermissionDecision,
        PERMISSION_TIMEOUT
      );

      if (decision.behavior === 'allow') {
        return { behavior: 'allow', updatedInput: input };
      }
      return {
        behavior: 'deny',
        message: decision.message || '用户拒绝了此操作',
      };
    };
  }

  abort(sessionId: string): void {
    this.active.get(sessionId)?.abort();
    this.active.delete(sessionId);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.replies.settle(requestId, decision);
  }
}

/**
 * 把一条 SDK 消息映射成 0..n 个统一事件。
 *
 * 形状全部来自真实探针（见文件头的实测清单）。这里刻意**只认认得的**：
 * 认不出的 `system` 子类型（hooks / models / artifacts / command_lifecycle…）
 * 一律忽略 —— 把它们塞进 thinking 会变成「假思考过程」，比不显示更糟。
 *
 * 有状态的两处，都是为了「不重复、不丢」：
 *   - `openTools`：发出 tool 事件后登记，拿到 tool_result 才移除；
 *     整轮结束时（result）统一补一个「已完成」，否则前端一直转圈。
 *   - `sawTextDelta` / `sawThinkingDelta`：开了 `includePartialMessages` 之后，
 *     正文会先以增量到达、再以 assistant 整块到达。两边都发就是**双倍重复**。
 *     所以增量优先；整块只在「本轮没收到过增量」时兜底（某些模型/网关
 *     可能不返回增量，那时整块就是唯一来源）。
 */
export interface QoderMapperOptions {
  sessionId: string;
  model?: string;
  /** 调用开始时刻（毫秒）：`result` 没给 `duration_ms` 时用它算墙钟耗时 */
  startedAt?: number;
  /** 请求的权限档位，仅用于 init 那一条的核对日志 */
  permissionMode?: SendContext['permissionMode'];
}

export function createQoderMapper(
  opts: QoderMapperOptions
): (msg: unknown) => AgentEvent[] {
  const openTools: string[] = [];
  let sawTextDelta = false;
  let sawThinkingDelta = false;
  /**
   * 是否已经发过 init。
   *
   * 实测（2026-10-22 端到端）：一轮调用里 CLI 会发**两次** `system/init`，
   * 两次的 `session_id` / `model` 完全相同。再加上 `send()` 开头那个合成的
   * init，前端会收到 3 个 —— 虽然前端是幂等的，但事件流里重复三次属于噪音，
   * 排查时也会误以为「握手了三次」。这里只认第一次。
   */
  let initEmitted = false;

  return (msg: unknown): AgentEvent[] => {
    const out: AgentEvent[] = [];
    const m = msg as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') return out;
    const type = m.type as string | undefined;

    // ---- system ----
    if (type === 'system') {
      const subtype = m.subtype as string | undefined;

      if (subtype === 'init') {
        // 重复的 init 直接丢掉（CLI 实测会发两次，见 initEmitted 的说明）。
        // 放在核对日志之前：否则同一句告警会打两遍。
        if (initEmitted) return out;
        initEmitted = true;

        // 只读模式的**如实核对**：我们请求 plan，CLI 自己报的是什么？
        // 不一致就记一行日志（不编造界面事件）—— 这是排查
        // 「plan 到底生效没有」的唯一线索。
        if (opts.permissionMode === 'plan' && m.permissionMode !== 'plan') {
          console.warn(
            `[qoder-sdk] 请求 plan，但 CLI 回报 permissionMode=${String(m.permissionMode)}；` +
              `只读由工具白名单 + 黑名单兜底`
          );
        }
        out.push({
          type: 'init',
          sessionId: opts.sessionId,
          model: typeof m.model === 'string' ? m.model : opts.model,
          resumeToken: typeof m.session_id === 'string' ? m.session_id : null,
        });
        return out;
      }

      // CLI 侧拒绝（白名单 / 黑名单命中）。映射成工具结果，否则前端一直转圈。
      if (subtype === 'permission_denied') {
        const toolId = typeof m.tool_use_id === 'string' ? m.tool_use_id : '';
        if (toolId) {
          out.push({
            type: 'tool_result',
            toolId,
            content: typeof m.message === 'string' ? m.message : '工具调用被拒绝',
            isError: true,
          });
          const i = openTools.indexOf(toolId);
          if (i >= 0) openTools.splice(i, 1);
        }
        return out;
      }

      return out;
    }

    // ---- 流式增量 ----
    if (type === 'stream_event') {
      const ev = m.event as Record<string, unknown> | undefined;
      if (!ev) return out;

      if (ev.type === 'message_start') {
        sawTextDelta = false;
        sawThinkingDelta = false;
        return out;
      }
      if (ev.type !== 'content_block_delta') return out;

      const delta = ev.delta as Record<string, unknown> | undefined;
      if (!delta) return out;

      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        sawTextDelta = true;
        out.push({ type: 'text', content: delta.text });
      } else if (
        delta.type === 'thinking_delta' &&
        typeof delta.thinking === 'string' &&
        delta.thinking
      ) {
        sawThinkingDelta = true;
        out.push({ type: 'thinking', content: delta.thinking });
      }
      // input_json_delta：工具参数的碎片，**不发** ——
      // 完整的 tool_use 块马上会到（带解析好的 input），发碎片只会让卡片乱跳。
      return out;
    }

    // ---- assistant：工具块 + 正文兜底 ----
    if (type === 'assistant') {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return out;

      for (const rawBlock of content as Array<Record<string, unknown>>) {
        const bt = rawBlock.type;

        if (bt === 'tool_use') {
          const id = String(rawBlock.id ?? randomUUID());
          openTools.push(id);
          out.push({
            type: 'tool',
            id,
            name: String(rawBlock.name ?? 'unknown'),
            input: rawBlock.input ?? {},
          });
          continue;
        }

        if (bt === 'text' && !sawTextDelta) {
          const text = String(rawBlock.text ?? '');
          if (text) out.push({ type: 'text', content: text });
        } else if (bt === 'thinking' && !sawThinkingDelta) {
          const think = String(rawBlock.thinking ?? '');
          if (think) out.push({ type: 'thinking', content: think });
        }
      }
      return out;
    }

    // ---- user：工具结果 ----
    if (type === 'user') {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return out;

      for (const rawBlock of content as Array<Record<string, unknown>>) {
        if (rawBlock.type !== 'tool_result') continue;
        const toolId = String(rawBlock.tool_use_id ?? '');
        if (!toolId) continue;

        out.push({
          type: 'tool_result',
          toolId,
          content: flattenToolResult(rawBlock.content),
          isError: Boolean(rawBlock.is_error),
        });
        const resultParts = Array.isArray(rawBlock.content) ? rawBlock.content : [];
        for (const [index, partValue] of resultParts.entries()) {
          if (!partValue || typeof partValue !== 'object') continue;
          const part = partValue as Record<string, unknown>;
          if (part.type === 'image' && typeof part.data === 'string') {
            const mimeType = typeof part.mimeType === 'string' ? part.mimeType : 'image/png';
            out.push({
              type: 'artifact',
              id: `qoder-image-${toolId}-${index}`,
              name: `图像产物 ${index + 1}`,
              mediaType: mimeType,
              data: { encoding: 'base64', content: part.data },
              description: '由 Qoder SDK 工具结果返回的图像数据',
            });
          } else if (part.type === 'resource_link' && typeof part.uri === 'string') {
            out.push({
              type: 'artifact',
              id: `qoder-resource-${toolId}-${index}`,
              name: String(part.name ?? `资源 ${index + 1}`),
              mediaType: String(part.mimeType ?? 'application/octet-stream'),
              uri: part.uri,
              ...(typeof part.description === 'string' ? { description: part.description } : {}),
            });
          }
        }
        const i = openTools.indexOf(toolId);
        if (i >= 0) openTools.splice(i, 1);
      }
      return out;
    }

    // ---- result：收尾 ----
    if (type === 'result') {
      // 还没拿到结果的工具先标完成，避免前端一直转圈
      for (const toolId of openTools) {
        out.push({ type: 'tool_result', toolId, content: '已完成' });
      }
      openTools.length = 0;

      if (m.is_error) {
        const reason =
          typeof m.result === 'string' && m.result
            ? m.result
            : `执行失败（${String(m.subtype ?? 'unknown')}）`;
        out.push({ type: 'error', message: reason });
        return out;
      }

      const usage = usageOf(m);
      out.push({
        type: 'done',
        ...(typeof m.duration_ms === 'number'
          ? { durationMs: m.duration_ms }
          : opts.startedAt !== undefined
            ? { durationMs: Date.now() - opts.startedAt }
            : {}),
        ...usage,
      });
      return out;
    }

    // 其余类型（command_lifecycle 等）与界面无关，忽略。
    return out;
  };
}

/** 我们的权限档位 → SDK 的 `PermissionMode`（两边取值域同名，不需要翻译表） */
function permissionModeOf(mode: SendContext['permissionMode']): string {
  switch (mode) {
    case 'acceptEdits':
      return 'acceptEdits';
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
    case 'default':
    default:
      return 'default';
  }
}

/** 工具结果的内容可能是字符串，也可能是 content block 数组 */
function flattenToolResult(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map(b => {
        const block = b as { text?: unknown; content?: unknown };
        if (typeof block?.text === 'string') return block.text;
        if (typeof block?.content === 'string') return block.content;
        return '';
      })
      .join('');
  }
  return JSON.stringify(raw ?? '');
}

/**
 * 从 `result` 事件里取用量。
 *
 * 三条纪律：
 *   - 拿不到就**不填**，不写 0 —— 界面上「$0.0000」和「没有数据」是两件事；
 *   - `total_cost_usd` 是平台账单口径，`total_credits` 是积分，两者不能混。
 *     `done.cost` 的语义是「美元」，所以只认前者；
 *   - token 数取 usage 里几个字段的和，全 0 时当作「没报」。
 *
 * 本机实测：这个账号是积分制，`total_cost_usd` 与 `usage.*_tokens` 全是 0，
 * 只有 `usage.context_usage_ratio`（0.25）是真值。所以不填是**正确**的，
 * 而不是把 0 当成「免费」。
 */
function usageOf(m: Record<string, unknown>): { cost?: number; tokens?: number } {
  const out: { cost?: number; tokens?: number } = {};

  const cost = m.total_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) out.cost = cost;

  const u = m.usage as Record<string, unknown> | undefined;
  if (u) {
    const total =
      Number(u.input_tokens ?? 0) +
      Number(u.output_tokens ?? 0) +
      Number(u.cache_read_input_tokens ?? 0) +
      Number(u.cache_creation_input_tokens ?? 0);
    if (Number.isFinite(total) && total > 0) out.tokens = total;
  }

  return out;
}
