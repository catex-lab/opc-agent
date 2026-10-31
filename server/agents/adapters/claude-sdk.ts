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
import { createRequire } from 'node:module';
import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

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
import { SDK_PERMISSION_OPTIONS } from '../../../shared/permissions.js';
import { createCanUseToolBridge } from './sdkApproval.js';
import { mapClaudeCodeLine } from '../definitions.js';
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

/** 本机是否已有 Anthropic 凭据（不做在线校验，只做「有没有」的快速判断） */
function hasCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const home = os.homedir();
  return ['.claude/.credentials.json', '.claude.json'].some(f =>
    fs.existsSync(path.join(home, f))
  );
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

    if (hasCredentials()) {
      this.status = {
        availability: 'ready',
        installed: true,
        binaryPath: binary,
        message: '已检测到本机 Anthropic 凭据（未做在线校验）',
        probedAt: now,
      };
    } else {
      this.status = {
        availability: 'needs-auth',
        installed: true,
        binaryPath: binary,
        message: '未检测到 Anthropic 凭据，请运行 claude 后执行 /login，或设置 ANTHROPIC_API_KEY',
        probedAt: now,
      };
    }
    return this.status;
  }

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const sessionId = ctx.sessionId;
    let aborted = false;
    const controller = new AbortController();

    const abort = () => {
      aborted = true;
      this.replies.clear(sessionId);
      controller.abort();
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
    const extraPrompt = withMemoryContext(ctx.systemPrompt ?? '', ctx.memoryCwd);

    void (async () => {
      let tokens = 0;
      let cost: number | undefined;
      try {
        const { query } = await loadSdk();
        const q = query({
          prompt: ctx.prompt,
          options: {
            cwd: ctx.cwd || process.cwd(),
            ...(ctx.model ? { model: ctx.model } : {}),
            ...(ctx.resumeToken ? { resume: ctx.resumeToken } : {}),
            ...claudePermissionMode(ctx),
            ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
            abortController: controller,
            canUseTool,
            systemPrompt: extraPrompt
              ? { type: 'preset', preset: 'claude_code', append: extraPrompt }
              : { type: 'preset', preset: 'claude_code' },
            stderr: (data: string) => {
              // 只留最后几行：CLI 的诊断经常带整段堆栈，全存会把日志撑爆
              stderrLines.push(data);
              if (stderrLines.length > 30) stderrLines.shift();
            },
          },
        });

        for await (const msg of q) {
          const mapped = mapClaudeSdkMessage(msg, ctx, queue);
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
          const detail = stderrLines.join('').trim();
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

  abort(sessionId: string): void {
    this.active.get(sessionId)?.abort();
    this.active.delete(sessionId);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.replies.settle(requestId, decision);
  }

  dispose(): void {
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
function mapClaudeSdkMessage(
  msg: SDKMessage,
  ctx: SendContext,
  queue: AsyncQueue<AgentEvent>
): 'continue' | 'result' {
  const m = msg as unknown as {
    type?: string;
    subtype?: string;
    session_id?: string;
    model?: string;
    message?: unknown;
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

  if (m.type === 'assistant' || m.type === 'user') {
    const events = mapClaudeCodeLine(m);
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
export { bundledBinary, hasCredentials };
