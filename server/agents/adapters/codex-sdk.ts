/**
 * Codex SDK 适配器（`@openai/codex-sdk`）。
 *
 * ## 换 SDK 换来什么
 *
 * 原来走 `codex exec --json` 子进程：argv 自己拼、stdin/stdout 自己解析、
 * 续接靠 `exec resume` 子命令。官方 SDK 把这些包成 `Codex.startThread()` /
 * `resumeThread()` + `runStreamed()`，事件是 TypeScript 联合类型
 * （`ThreadEvent`），不需要再从 stdout 里猜行。
 *
 * ## 事件映射为什么复用 `createCodexLineageMapper`
 *
 * SDK 的 `item.started / item.updated / item.completed` 与 CLI 的
 * `--json` 输出是同一份 schema（Trae 同族也共用它）。**文本是累积值**，
 * 必须靠那个带状态的映射器算增量；另写一份只会多一处漏掉 delta。
 *
 * ## 权限：没有交互式审批，只有沙箱
 *
 * `ThreadOptions` 里没有 `canUseTool` 这类回调，只有 `sandboxMode` /
 * `approvalPolicy`。所以：
 *   - 权限模式落到沙箱（与 CLI 通道的 `codexSandboxFor` 同一矩阵）；
 *   - `approvalPolicy` 固定 `never` —— headless 进程没人能应答审批，
 *     用 `on-request` 只会把一轮对话挂死；
 *   - **没有**「本会话始终允许」与逐次门禁回调，这一点不假装支持。
 *
 * ## 二进制
 *
 * SDK 依赖 `@openai/codex`，后者按平台分发自带 `codex` 可执行文件；
 * 不需要用户另装 CLI。`OPC_CODEX_SDK_BIN` 只给验收脚本指向桩进程。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk';

/**
 * 惰性动态加载 SDK。
 *
 * 为什么不能静态 `import { Codex }`：这个包的 `exports` 只声明了 **import**
 * 条件，没有 require/default。开发态（tsx ESM）没事；打包态 esbuild 把外置
 * 依赖的静态导入降级成 `require()`，CJS 解析直接抛
 * ERR_PACKAGE_PATH_NOT_EXPORTED —— 进程**模块加载时**就崩，安装包打不开。
 * 动态 `import()` 走 import 条件（esbuild 对 node 目标原样保留 import()），
 * 两种形态都能解析；而且只有真正发消息才需要 SDK，顺带省启动耗时。
 */
type CodexSdkModule = typeof import('@openai/codex-sdk');
let sdkPromise: Promise<CodexSdkModule> | null = null;
function loadSdk(): Promise<CodexSdkModule> {
  sdkPromise ??= import('@openai/codex-sdk');
  return sdkPromise;
}
import { AsyncQueue, linkAbort } from '../channel.js';
import { toUnpackedPath } from '../sdkRuntime.js';
import { createCodexLineageMapper } from '../definitions.js';
import { codexSandboxFor } from '../permissions.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
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

/**
 * 找 SDK 自带的 codex 可执行文件（平台包里的 vendor/<triple>/bin/codex）。
 *
 * 为什么不 `require.resolve('@openai/codex-sdk')`：那个包的 `exports` 只声明了
 * `"."` 的 **import** 条件，`createRequire` 解析会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * （实测 A157 第一版就红在这里）。但 `@openai/codex` 没有 exports 字段，
 * 它的 `package.json` 可以正常解析；从它所在的 `@openai` 目录扫同级平台包，
 * 与 SDK 自己的 `resolveCodexExecutable` 一样不依赖入口文件布局。
 */
function bundledBinary(): string | null {
  const override = process.env.OPC_CODEX_SDK_BIN;
  if (override) {
    // 用户给的覆盖路径同样可能是 asar 内的：统一走 toUnpackedPath（见该函数注释）
    const p = toUnpackedPath(override);
    return fs.existsSync(p) ? p : null;
  }

  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  try {
    const codexPkgJson = require.resolve('@openai/codex/package.json');
    const parent = path.dirname(path.dirname(codexPkgJson)); // node_modules/@openai
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith('codex-')) continue;
      const vendor = path.join(parent, name, 'vendor');
      if (!fs.existsSync(vendor)) continue;
      for (const triple of fs.readdirSync(vendor)) {
        const candidate = path.join(vendor, triple, 'bin', exe);
        // 打包态：平台包被 smartUnpack 解到 app.asar.unpacked，路径必须改写，
        // 否则 existsSync 为 true 而 spawn ENOENT（实测见 toUnpackedPath 注释）
        if (fs.existsSync(candidate)) return toUnpackedPath(candidate);
      }
    }
  } catch {
    // 打包态布局不同就如实报未安装，不猜路径
  }
  return null;
}

/** 是否已有 OpenAI 凭据（`codex login` 写 ~/.codex/auth.json，或环境变量） */
function hasCredentials(): boolean {
  if (process.env.OPENAI_API_KEY) return true;
  return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
}

export class CodexSdkAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;
  private status: AgentStatus | null = null;
  private active = new Map<string, { abort: () => void }>();

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
        message: '未找到 SDK 自带的 codex 可执行文件（平台包可能没装上）',
        probedAt: now,
      };
      return this.status;
    }
    this.status = hasCredentials()
      ? {
          availability: 'ready',
          installed: true,
          binaryPath: binary,
          message: '已检测到 OpenAI 登录态或 API Key',
          probedAt: now,
        }
      : {
          availability: 'needs-auth',
          installed: true,
          binaryPath: binary,
          message: '未检测到 OpenAI 凭据，请运行 codex login 或设置 OPENAI_API_KEY',
          probedAt: now,
        };
    return this.status;
  }

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const sessionId = ctx.sessionId;
    let aborted = false;
    const controller = new AbortController();

    const abort = () => {
      aborted = true;
      controller.abort();
      queue.close();
    };
    this.active.set(sessionId, { abort });
    const unlinkAbort = linkAbort(ctx.signal, abort);

    const started = Date.now();
    // 每轮新建映射器：累积文本的游标不能跨会话串味
    const mapper = createCodexLineageMapper('Codex');

    void (async () => {
      let tokens = 0;
      try {
        const { Codex } = await loadSdk();
        const codex = new Codex(bundledPathOption());
        // 续接时**不传** sandboxMode：`codex exec resume` 没有这个选项，
        // 传了只会让续接失败；沿用创建会话时的沙箱（与 CLI 通道一致）。
        const threadOptions: ThreadOptions = {
          workingDirectory: ctx.cwd || process.cwd(),
          // headless 没人能应答审批；沙箱才是真正的约束
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
          ...(ctx.model ? { model: ctx.model } : {}),
          ...(ctx.reasoningEffort
            ? { modelReasoningEffort: ctx.reasoningEffort as ThreadOptions['modelReasoningEffort'] }
            : {}),
          ...(!ctx.resumeToken && codexSandboxFor(ctx.permissionMode)
            ? { sandboxMode: codexSandboxFor(ctx.permissionMode)! }
            : {}),
        };

        const thread = ctx.resumeToken
          ? codex.resumeThread(ctx.resumeToken, threadOptions)
          : codex.startThread(threadOptions);

        const { events } = await thread.runStreamed(ctx.prompt, { signal: controller.signal });

        for await (const event of events) {
          if (aborted) break;
          if (event.type === 'thread.started') {
            queue.push({
              type: 'init',
              sessionId: ctx.sessionId,
              model: ctx.model,
              resumeToken: event.thread_id,
              source: 'native',
            });
            continue;
          }
          if (event.type === 'turn.completed') {
            const u = event.usage;
            tokens = Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0);
          }
          // 未知事件走原生旁路，保证「不折损」
          const mapped = mapper(event as unknown);
          if (Array.isArray(mapped)) {
            for (const ev of mapped) queue.push(ev);
          } else if (mapped) {
            queue.push(mapped);
          } else if (
            event.type !== 'turn.started' &&
            event.type !== 'turn.completed' &&
            event.type !== 'item.started' &&
            event.type !== 'item.updated' &&
            event.type !== 'item.completed'
          ) {
            queue.push({
              type: 'raw',
              channel: `sdk:${String((event as ThreadEvent).type)}`,
              payload: event,
            });
          }
        }

        if (!aborted) {
          queue.push({
            type: 'done',
            durationMs: Date.now() - started,
            ...(tokens > 0 ? { tokens } : {}),
          });
        }
      } catch (err) {
        if (!aborted) {
          queue.push({
            type: 'error',
            message: (err as Error)?.message || String(err),
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
      if (this.active.get(sessionId)?.abort === abort) this.active.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    this.active.get(sessionId)?.abort();
    this.active.delete(sessionId);
  }

  dispose(): void {
    for (const entry of this.active.values()) entry.abort();
    this.active.clear();
  }
}

/** SDK 构造参数：有桩二进制时指过去，否则让它自己解析平台包 */
function bundledPathOption(): { codexPathOverride?: string } {
  const binary = bundledBinary();
  return binary ? { codexPathOverride: binary } : {};
}

export { bundledBinary, hasCredentials };
