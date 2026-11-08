/**
 * Claude Code SDK 适配器（`@anthropic-ai/claude-agent-sdk`）。
 *
 * ## 为什么把它接成 kind='sdk'
 *
 * 之前 Claude 走的是 CLI 适配器的双向 control 协议（`--input-format stream-json`，
 * 见 `adapters/claude-control.ts`）：协议是我们按 CLI 的 schema 反推的，
 * `can_use_tool` 的信封、`toolUseID` 的落点都得自己拼。官方 SDK 直接给了
 * `canUseTool` 回调与结构化 `SDKMessage`，同一件事少一层手搓协议。
 *
 * 权限语义**不降级**：回调接的是两家 SDK 共用的 `sdkApproval`，
 * 场景白名单 / 高危门禁 / 「始终」记忆的顺序与 WorkBuddy 通道完全一致。
 *
 * ## 事件映射为什么复用 `mapClaudeCodeLine`
 *
 * SDK 的 `assistant` / `user` 消息与 CLI 的 stream-json 行是同一份 schema
 * （content blocks + tool_result），复用定义表里的映射器避免维护两份
 * 「块级」解析 —— 尤其是 `redacted_thinking` 与未知块旁路那几条，
 * 各写一份必然有一处忘记。
 *
 * ## 二进制来自哪里
 *
 * SDK 的 npm 包按平台分发（`claude-agent-sdk-win32-x64` 等），里面带完整
 * `claude` 可执行文件。**不要求用户另装 CLI**，与 Tencent SDK 需要本机 CLI
 * 的情况相反。`OPC_CLAUDE_SDK_BIN` 只用于验收脚本指向桩二进制。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  CanUseTool,
  SDKMessage,
  Options as ClaudeOptions,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { kbMcpServerSpec, KB_MCP_SERVER_NAME } from '../../kb/tool.js';

/**
 * 惰性动态加载 SDK。
 *
 * 这个包的 `exports` 只有 types + default，入口是 `sdk.mjs`（纯 ESM）。
 * 打包态 esbuild 把外置依赖的静态导入降级成 `require()`，CJS require 一个
 * 纯 ESM 入口行为依 Node 版本而定（require(esm)），一旦入口含顶层 await
 * 就直接在**模块加载时**抛错 —— 与 codex-sdk 的 ERR_PACKAGE_PATH_NOT_EXPORTED
 * 同一类「安装包打不开」。动态 `import()` 在两种形态下都稳定。
 */
type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkPromise: Promise<ClaudeSdkModule> | null = null;
function loadSdk(): Promise<ClaudeSdkModule> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}
import { AsyncQueue, PendingReplies, linkAbort } from '../channel.js';
import { toUnpackedPath } from '../sdkRuntime.js';
import { withMemoryContext } from '../../memory.js';
import { withAnswerLanguage } from '../../answer-language.js';
import { withExtensionsContext } from '../../extensions/inject.js';
import { SDK_PERMISSION_OPTIONS } from '../../../shared/permissions.js';
import { createCanUseToolBridge } from './sdkApproval.js';
import {
  createStreamTextState,
  mapStreamTextEvent,
  takeStreamedText,
  takeStreamedThinking,
  takeStreamedTotalText,
  type StreamTextState,
} from './streamText.js';
import { mapClaudeCodeLine } from '../definitions.js';
import {
  inspectClaudeCredentials,
  formatLocalMinute,
  type CredentialVerdict,
} from '../credentialStatus.js';
import { recoveryHintFor } from '../recovery.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
  PermissionDecision,
  SendContext,
} from '../types.js';
import type { AgentDefinition } from '../definitions.js';

// 双形态解析基址：开发态是 tsx ESM，import.meta.url 可用；打包态被 esbuild
// 打成 CJS（paths.ts 里写过的约束），import.meta 在 CJS 输出里是空对象，
// 直接用会在进程启动时抛 ERR_INVALID_ARG_VALUE —— 安装包一打开就崩的元凶。
// 此时 Node 的 CJS 包装器提供 __filename（指向 dist-electron/main.cjs），
// 以它为基址 createRequire，node_modules 解析会向上走到 app.asar/node_modules。
// ESM 源码态没有 __filename，但 typeof 不抛异常；declare 只是类型层声明。
declare const __filename: string | undefined;
const require = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url,
);

/** 权限请求等待上限，与 WorkBuddy 通道保持同值 */
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

/**
 * 预热（A-性能）：把「进程启动 + initialize 握手 + MCP 注册」提前到用户
 * 打开会话的时刻。
 *
 * ## 为什么值得
 *
 * 本机实测（`claude` 未登录也能走到 initialize 完成）：
 *   冷进程 init 10.2s（首次从磁盘读 ~几百 MB 的 CLI 包）
 *   温进程 init 3.3s
 *   `startup()` 预置一个 spare 只要 1.8~2.1s
 * 而 `query()` 每轮都新起一个进程 —— 也就是说「首条指令」和「每轮答复」
 * 都在为同一件事付钱。预热后 `WarmQuery.query(prompt)` 直接复用那个已
 * 完成握手的进程，首条消息只剩模型推理。
 *
 * ## 边界
 *
 * 1. **一个 spare 只服务一条消息**（SDK 的 `WarmQuery` 是一次性的）。
 *    所以这里只预热「打开会话后的第一条」，后续消息退回普通 `query()`，
 *    与改造前一致 —— 不引入常驻进程池，避免内存与孤儿进程风险。
 * 2. **宿主级选项在预热时就冻结**（cwd / model / resume / 权限档 /
 *    systemPrompt / MCP）。`warmKeyOf` 把这些全部编进键里；任何一项变了
 *    （例如用户改了模型、或记忆文件变了导致提示词指纹变）就丢弃 spare、
 *    走普通路径。**宁可不用，也不让预热把配置带歪。**
 * 3. 预热是纯优化：`startup()` 失败、超时、SDK 版本不认识该 API，
 *    一律静默回落到 `query()`。
 */
const CLAUDE_PREWARM_TIMEOUT = 60 * 1000;
/** spare 闲置多久后回收（用户打开会话却一直不发消息的情况） */
const CLAUDE_PREWARM_IDLE_MS = 5 * 60 * 1000;

interface ClaudeWarmEntry {
  key: string;
  /** 预热结果；null = 失败/超时/不支持，调用方直接走普通路径 */
  ready: Promise<WarmQuery | null>;
  /** 预热进程自己的中断器：claim 之后 send 的 abort 要能传到它 */
  controller: AbortController;
  /**
   * 审批桥的占位。预热时进程已经建好并冻结了 canUseTool，而真正的桥
   * （绑定本轮 queue）只能在 send 时才存在 —— 所以用一个可变引用转发，
   * 预热期（还没有 prompt）不会有任何审批请求进来。
   */
  bridge: { current: CanUseTool | null };
  stderrLines: string[];
  /** 闲置回收定时器 */
  idleTimer: ReturnType<typeof setTimeout> | null;
}


/**
 * 找 SDK 自带的 claude 可执行文件。
 *
 * 为什么不用 `require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')`：
 * 平台包的 `exports` 里没有 `./package.json`，resolve 会直接抛错；从 SDK 自身
 * 入口往上退一级再按目录扫描，不依赖平台包声明的入口字段。
 */
function bundledBinary(): string | null {
  const override = process.env.OPC_CLAUDE_SDK_BIN;
  if (override) {
    // 用户给的覆盖路径同样可能是 asar 内的：统一走 toUnpackedPath（见该函数注释）
    const p = toUnpackedPath(override);
    return fs.existsSync(p) ? p : null;
  }

  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const parent = path.dirname(sdkDir);
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith('claude-agent-sdk-')) continue;
      const candidate = path.join(parent, name, exe);
      // 打包态：平台包被 smartUnpack 解到 app.asar.unpacked，而这里的路径仍是
      // app.asar 内的 —— existsSync 为 true 但 spawn 会 ENOENT，必须改写。
      if (fs.existsSync(candidate)) return toUnpackedPath(candidate);
    }
  } catch {
    // 打包态下 node_modules 布局可能变；找不到就如实报未安装
  }
  return null;
}

/**
 * 凭据检测结论 → 名册状态。
 *
 * 注意：`.claude.json` 只是应用配置，**不再单独作为已登录证据**。
 * 真正的证据是 `.claude/.credentials.json` 里的 token，或 `.claude.json`
 * 里的 `oauthAccount`（两者都没有 → 未检测到登录凭据）。
 */
export function resolveClaudeCredential(
  verdict: CredentialVerdict
): Pick<AgentStatus, 'availability' | 'message' | 'probeState'> {
  switch (verdict.state) {
    case 'absent':
      return {
        availability: 'needs-auth',
        message: `未检测到 Anthropic 登录凭据。怎么恢复：${recoveryHintFor('claude')}`,
      };
    case 'unreadable':
      return {
        availability: 'needs-auth',
        message: `Anthropic 凭据文件无法解析（${verdict.reason}），请重新登录。怎么恢复：${recoveryHintFor('claude')}`,
        probeState: 'credential-invalid',
      };
    case 'expired-needs-login':
      return {
        availability: 'needs-auth',
        message: `Anthropic 登录态已过期（${formatLocalMinute(
          new Date(verdict.expiresAt).toISOString()
        )}），且没有可用的刷新令牌，需要重新登录。怎么恢复：${recoveryHintFor('claude')}`,
        probeState: 'credential-invalid',
      };
    case 'expired-refreshable':
      return {
        // 硬要求：有 refresh_token 不判不可用
        availability: 'ready',
        message: `已检测到 Anthropic 登录态，但已过期（${formatLocalMinute(
          new Date(verdict.expiresAt).toISOString()
        )}）；首次使用会尝试刷新（未校验）`,
      };
    case 'present':
      return {
        availability: 'ready',
        message: verdict.expiresAt
          ? `已检测到本机 Anthropic 凭据（未校验，有效期至 ${formatLocalMinute(
              new Date(verdict.expiresAt).toISOString()
            )}）`
          : '已检测到本机 Anthropic 凭据（未校验）',
      };
  }
}

/** 权限模式 → Claude SDK 的 `PermissionMode` */
function claudePermissionMode(ctx: SendContext): {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  allowDangerouslySkipPermissions?: boolean;
} {
  switch (ctx.permissionMode) {
    case 'plan':
      return { permissionMode: 'plan' };
    case 'acceptEdits':
      return { permissionMode: 'acceptEdits' };
    case 'bypassPermissions':
      // SDK 要求 bypass 必须显式确认，否则直接拒绝启动；
      // 这里的「确认」不是绕过门禁：canUseTool 里高危检查仍在 bypass 之前
      return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };
    default:
      return { permissionMode: 'default' };
  }
}

export class ClaudeSdkAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;
  private status: AgentStatus | null = null;
  private active = new Map<string, { abort: () => void }>();
  private replies = new PendingReplies<PermissionDecision>();
  /**
   * 「本会话始终允许 / 始终拒绝」的记忆。
   * 作用域与 WorkBuddy 通道一致：本会话 + 本次应用运行。
   */
  private approvalMemory = new Map<string, { allow: Set<string>; deny: Set<string> }>();
  /** 当前的预热 spare（只留一个：同时打开多个会话时以最后一次为准） */
  private warm: ClaudeWarmEntry | null = null;

  constructor(def: AgentDefinition) {
    this.descriptor = def.descriptor;
  }

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();
    const binary = bundledBinary();
    if (!binary) {
      this.status = {
        availability: 'not-installed',
        installed: false,
        message:
          '未找到 SDK 自带的 claude 可执行文件（平台包可能没装上）。' +
          '可执行 `npm i @anthropic-ai/claude-agent-sdk-<平台>-<架构>` 补齐。',
        probedAt: now,
      };
      return this.status;
    }

    const envConfigured = Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
    );
    this.status = {
      ...(envConfigured
        ? { availability: 'ready' as const, message: '已通过环境变量配置凭据（未校验）' }
        : resolveClaudeCredential(inspectClaudeCredentials())),
      installed: true,
      binaryPath: binary,
      probedAt: now,
    };
    return this.status;
  }

  /**
   * 用前校验：只读 `~/.claude` 下的凭据文件，不发网络请求。
   * 由注册表在「本会话第一次发消息」时调一次。
   */
  refreshCredential(): AgentStatus | null {
    if (!this.status?.installed) return null;
    const now = new Date().toISOString();
    const resolved: Pick<AgentStatus, 'availability' | 'message' | 'probeState'> =
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? { availability: 'ready', message: '已通过环境变量配置凭据（未校验）' }
        : resolveClaudeCredential(inspectClaudeCredentials());
    const next: AgentStatus = {
      ...this.status,
      availability: resolved.availability,
      message: resolved.message,
      probedAt: now,
    };
    if (resolved.probeState) next.probeState = resolved.probeState;
    else delete next.probeState;
    if (resolved.availability === 'ready') delete next.lastError;
    this.status = next;
    return next;
  }

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const sessionId = ctx.sessionId;
    let aborted = false;
    const controller = new AbortController();
    /** 命中预热时指向 spare 自己的中断器（声明必须在 abort 之前：linkAbort 可能同步触发） */
    let warmController: AbortController | null = null;

    const abort = () => {
      aborted = true;
      this.replies.clear(sessionId);
      controller.abort();
      warmController?.abort();
      queue.close();
    };
    this.active.set(sessionId, { abort });
    const unlinkAbort = linkAbort(ctx.signal, abort);

    const canUseTool = createCanUseToolBridge({
      queue,
      replies: this.replies,
      memory: this.memoryFor(sessionId),
      ctx,
      sessionId,
      options: SDK_PERMISSION_OPTIONS,
      expiresInMs: PERMISSION_TIMEOUT,
    }) as unknown as CanUseTool;

    const started = Date.now();
    const binary = bundledBinary();
    const stderrLines: string[] = [];

    // 人设与记忆：用 preset 而不是替换 systemPrompt ——
    // 替换会把 Claude Code 自己的工具使用规范一起抹掉，模型行为会明显退化。
    // A167：技能清单叠在记忆之后（P3，只对 prompt 态 Agent 生效）。
    // A209：回答语言追加在最末；`append` 语义天然不覆盖 preset 自带的工具规范。
    const extraPrompt = withAnswerLanguage(
      withExtensionsContext(
        withMemoryContext(ctx.systemPrompt ?? '', ctx.memoryCwd),
        this.descriptor.id
      ),
      ctx.answerLanguage
    );
    const warmEntry = this.takeWarm(ctx, binary, extraPrompt);

    void (async () => {
      let tokens = 0;
      let cost: number | undefined;
      let claimed: ClaudeWarmEntry | null = null;
      try {
        const sdk = await loadSdk();
        let q: AsyncIterable<SDKMessage> | null = null;

        // 预热命中：进程已完成 initialize 与 MCP 握手，claim 后只剩推理。
        if (warmEntry) {
          const spare = await warmEntry.ready;
          if (spare) {
            warmEntry.bridge.current = canUseTool;
            warmController = warmEntry.controller;
            claimed = warmEntry;
            q = spare.query(ctx.prompt);
          }
        }

        if (!q) {
          q = sdk.query({
            prompt: ctx.prompt,
            options: this.claudeOptions(ctx, extraPrompt, binary, controller, canUseTool, data => {
              // 只留最后几行：CLI 的诊断经常带整段堆栈，全存会把日志撑爆
              stderrLines.push(data);
              if (stderrLines.length > 30) stderrLines.shift();
            }),
          });
        }

        const streamState = createStreamTextState();
        for await (const msg of q) {
          const mapped = mapClaudeSdkMessage(msg, ctx, queue, streamState);
          if (mapped === 'result') {
            const r = msg as {
              subtype?: string;
              is_error?: boolean;
              result?: string;
              duration_ms?: number;
              total_cost_usd?: number;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (r.subtype !== 'success' || r.is_error) {
              queue.push({
                type: 'error',
                message: String(r.result ?? 'Claude 执行失败'),
              });
            }
            tokens =
              Number(r.usage?.input_tokens ?? 0) + Number(r.usage?.output_tokens ?? 0);
            cost = typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined;
          }
        }

        if (!aborted) {
          queue.push({
            type: 'done',
            durationMs: Date.now() - started,
            ...(tokens > 0 ? { tokens } : {}),
            ...(cost != null ? { cost } : {}),
          });
        }
      } catch (err) {
        if (!aborted) {
          const detail = (claimed?.stderrLines ?? stderrLines).join('').trim();
          queue.push({
            type: 'error',
            message: `${(err as Error)?.message || String(err)}${detail ? `（stderr: ${detail.slice(-500)}）` : ''}`,
          });
        }
      } finally {
        queue.close();
      }
    })();

    try {
      for await (const ev of queue) yield ev;
    } catch (err) {
      yield { type: 'error', message: (err as Error).message || String(err) };
    } finally {
      unlinkAbort();
      this.replies.clear(sessionId);
      if (this.active.get(sessionId)?.abort === abort) this.active.delete(sessionId);
    }
  }

  /**
   * 预热：起一个已完成 initialize/MCP 握手的 spare，供下一条消息 claim。
   *
   * 由注册表在「打开会话 / 新建会话」时调用（见 `registry.prewarm`）。
   * 失败、超时、旧版 SDK 不认 `startup()` 都只是「没有 spare」，
   * 不影响任何一次真实发送。
   */
  prewarm(ctx: SendContext): void {
    try {
      const binary = bundledBinary();
      if (!binary) return;
      const extraPrompt = withAnswerLanguage(
        withExtensionsContext(
          withMemoryContext(ctx.systemPrompt ?? '', ctx.memoryCwd),
          this.descriptor.id
        ),
        ctx.answerLanguage
      );
      const key = this.warmKeyOf(ctx, binary, extraPrompt);
      if (this.warm?.key === key) return;
      this.closeWarm();

      const controller = new AbortController();
      const bridge: { current: CanUseTool | null } = { current: null };
      const stderrLines: string[] = [];
      const entry: ClaudeWarmEntry = {
        key,
        ready: Promise.resolve(null),
        controller,
        bridge,
        stderrLines,
        idleTimer: null,
      };

      /* canUseTool 在预热时就冻结进进程，但真正的审批桥依赖本轮 queue。
         用一个可变引用转发：预热期不会有任何审批请求（还没有 prompt）；
         claim 后 send 立刻把真正的桥写进来。 */
      const proxy = ((
        toolName: string,
        input: Record<string, unknown>,
        options: unknown
      ) => {
        const fn = bridge.current;
        if (!fn) {
          return Promise.resolve({
            behavior: 'deny' as const,
            message: '预热进程尚未绑定审批通道',
            interrupt: false,
          });
        }
        return (fn as (...a: unknown[]) => Promise<unknown>)(toolName, input, options);
      }) as unknown as CanUseTool;

      entry.ready = loadSdk()
        .then(sdk => {
          if (typeof sdk.startup !== 'function') return null;
          return sdk.startup({
            options: this.claudeOptions(ctx, extraPrompt, binary, controller, proxy, data => {
              stderrLines.push(data);
              if (stderrLines.length > 30) stderrLines.shift();
            }),
            initializeTimeoutMs: CLAUDE_PREWARM_TIMEOUT,
          });
        })
        .then(handle => {
          if (this.warm !== entry || !handle) {
            handle?.close();
            return null;
          }
          entry.idleTimer = setTimeout(() => {
            if (this.warm === entry) this.closeWarm();
          }, CLAUDE_PREWARM_IDLE_MS);
          entry.idleTimer.unref?.();
          return handle;
        })
        .catch(() => null);

      this.warm = entry;
    } catch {
      /* 预热纯优化：任何异常都不该冒到请求层 */
    }
  }

  /** 取走可用的 spare；配置键对不上就丢弃（宁可重起，也不让 spare 带旧配置跑） */
  private takeWarm(
    ctx: SendContext,
    binary: string | null,
    extraPrompt: string
  ): ClaudeWarmEntry | null {
    const entry = this.warm;
    if (!entry) return null;
    if (!binary || entry.key !== this.warmKeyOf(ctx, binary, extraPrompt)) {
      this.closeWarm();
      return null;
    }
    this.warm = null;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    return entry;
  }

  private closeWarm(): void {
    const entry = this.warm;
    this.warm = null;
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    void entry.ready.then(handle => handle?.close()).catch(() => {
      /* 已经死掉的 spare：忽略 */
    });
  }

  /**
   * 预热键。必须覆盖 `claudeOptions` 在预热时就冻结的**所有**宿主级选项：
   * 少一项就可能让 spare 带着旧配置接客（例如换了模型却仍用旧进程）。
   */
  private warmKeyOf(ctx: SendContext, binary: string, extraPrompt: string): string {
    return [
      this.descriptor.id,
      binary,
      ctx.cwd || '',
      ctx.model || '',
      ctx.resumeToken || '',
      ctx.permissionMode || 'default',
      ctx.sessionId,
      createHash('sha1').update(extraPrompt).digest('hex').slice(0, 16),
    ].join('\u0001');
  }

  /** `query()` 与 `startup()` 共用的选项构造（两处必须完全一致，否则预热白做） */
  private claudeOptions(
    ctx: SendContext,
    extraPrompt: string,
    binary: string | null,
    abortController: AbortController,
    canUseTool: CanUseTool,
    stderr: (data: string) => void
  ): ClaudeOptions {
    return {
      cwd: ctx.cwd || process.cwd(),
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.resumeToken ? { resume: ctx.resumeToken } : {}),
      ...claudePermissionMode(ctx),
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      abortController,
      canUseTool,
      // P1：0.3.316 的 Options 已支持该字段；打开后才会收到 `stream_event`
      // （SDKPartialAssistantMessage），正文才能逐块而不是整条到达。
      includePartialMessages: true,
      // A176：知识库检索是只读能力，sessionId 由宿主塞进子进程环境；
      // 工具的权限放行在 sdkApproval 里按 mcp__kb__ 前缀单独处理。
      mcpServers: {
        [KB_MCP_SERVER_NAME]: kbMcpServerSpec(ctx.sessionId, this.descriptor.id),
      },
      systemPrompt: extraPrompt
        ? { type: 'preset', preset: 'claude_code', append: extraPrompt }
        : { type: 'preset', preset: 'claude_code' },
      stderr,
    };
  }

  abort(sessionId: string): void {
    this.active.get(sessionId)?.abort();
    this.active.delete(sessionId);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.replies.settle(requestId, decision);
  }

  dispose(): void {
    this.closeWarm();
    for (const entry of this.active.values()) entry.abort();
    this.active.clear();
    this.replies.clear();
    this.approvalMemory.clear();
  }

  private memoryFor(sessionId: string): { allow: Set<string>; deny: Set<string> } {
    let entry = this.approvalMemory.get(sessionId);
    if (!entry) {
      entry = { allow: new Set(), deny: new Set() };
      this.approvalMemory.set(sessionId, entry);
    }
    return entry;
  }
}

/**
 * Claude SDK 消息 → 统一事件。
 *
 * 返回 `'result'` 表示这轮结束（用量由调用方统一收尾，避免 done 发两次）。
 * `system/init` 之外的 system 子类型（status / compact_boundary / …）走
 * raw 旁路，与 WorkBuddy 通道的「不静默丢弃」保持一致。
 */
/**
 * 整条 assistant 消息到达时，把「增量已经推出去的部分」剪掉再交给块级映射。
 * 不剪的话，同一段正文会先按 delta 推一遍、再按整条消息推一遍，直接翻倍。
 * 空块直接丢弃，避免产生空 text/thinking 节点。
 */
function dedupeAssistant(message: Record<string, unknown>, stream: StreamTextState): Record<string, unknown> {
  const payload = message.message;
  if (!payload || typeof payload !== 'object') return message;
  const content = (payload as { content?: unknown }).content;
  if (typeof content === 'string') {
    return { ...message, message: { ...payload, content: takeStreamedTotalText(stream, content) } };
  }
  if (!Array.isArray(content)) return message;
  const next = content
    .map((block, index) => {
      if (!block || typeof block !== 'object') return block;
      const item = block as Record<string, unknown>;
      if (item.type === 'text') {
        const text = takeStreamedText(stream, index, String(item.text ?? ''));
        return text ? { ...item, text } : null;
      }
      if (item.type === 'thinking') {
        const thinking = takeStreamedThinking(stream, index, String(item.thinking ?? ''));
        return thinking ? { ...item, thinking } : null;
      }
      return item;
    })
    .filter((block) => block !== null);
  return { ...message, message: { ...payload, content: next } };
}

export function mapClaudeSdkMessage(
  msg: SDKMessage,
  ctx: SendContext,
  queue: AsyncQueue<AgentEvent>,
  stream: StreamTextState
): 'continue' | 'result' {
  const m = msg as unknown as {
    type?: string;
    subtype?: string;
    session_id?: string;
    model?: string;
    message?: unknown;
    event?: unknown;
    /** 子 Agent 的流带这个字段；它的增量不能和主回答共用一份去重缓存 */
    parent_tool_use_id?: string | null;
  };

  if (m.type === 'system' && m.subtype === 'init') {
    queue.push({
      type: 'init',
      sessionId: ctx.sessionId,
      model: m.model ?? ctx.model,
      resumeToken: m.session_id ?? null,
      source: 'native',
    });
    return 'continue';
  }

  if (m.type === 'result') return 'result';

  // P1：`includePartialMessages` 打开后，正文先以流事件到达。
  // 能识别的直接下发；不能识别的继续落到 raw 旁路。
  if (m.type === 'stream_event') {
    // 子 Agent（Task 工具）的流事件也带 type='stream_event'，但和主回答是
    // 两段独立正文。混进同一份缓存会让 message_start 清掉主回答的进度，
    // 整条消息随后又被重发一遍 —— 正是要防的翻倍。子流不取增量：
    // 它随后的整条 assistant 消息按原样下发（与打开 includePartialMessages 前一致）。
    if (m.parent_tool_use_id) return 'continue';
    const events = mapStreamTextEvent(m, stream);
    if (events) {
      for (const ev of events) queue.push(ev);
      return 'continue';
    }
  }

  if (m.type === 'assistant' || m.type === 'user') {
    const payload = m.type === 'assistant' && !m.parent_tool_use_id ? dedupeAssistant(m, stream) : m;
    const events = mapClaudeCodeLine(payload);
    if (Array.isArray(events)) {
      for (const ev of events) queue.push(ev);
    } else if (events) {
      queue.push(events);
    }
    return 'continue';
  }

  // 未映射的原生消息原样旁路（SDKMessage 有四十多种，逐个手写只会漏）
  queue.push({
    type: 'raw',
    channel: `sdk:${String(m.type ?? 'unknown')}${m.subtype ? `/${String(m.subtype)}` : ''}`,
    payload: msg,
  });
  return 'continue';
}

// 供验收脚本复用探测逻辑（与 sdk.ts 的 getLastAuthUrl 同属探测辅助）
export { bundledBinary };
