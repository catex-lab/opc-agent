/**
 * SDK 适配器：把 CodeBuddy / WorkBuddy 的 `query()` 包装成统一事件流。
 *
 * 这是唯一「一等公民」的适配器 —— 其他 CLI 都是它的降级替代。
 * 之所以要包装而不是继续内联在 /api/chat 里，是为了让上层（会话、群聊、
 * 任务分派）只面对一种接口，不必区分「这个 Agent 走 SDK 还是走子进程」。
 */

import { randomUUID } from 'crypto';
import {
  query,
  unstable_v2_authenticate,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type CanUseTool,
  type PermissionResult,
  type SdkSession,
} from '@tencent-ai/agent-sdk';
import { AsyncQueue, PendingReplies, linkAbort } from '../channel.js';
import { decideToolAccess } from '../toolPolicy.js';
import { evaluateToolCall } from '../permission-gate.js';
import { currentPermissionRules } from '../../permission-rules.js';
import { withMemoryContext } from '../../memory.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
  PermissionDecision,
  SendContext,
} from '../types.js';

/** 权限请求等待上限，与前端提示一致 */
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业的 AI 助手，善于帮助用户解决各种问题。请用简洁清晰的方式回答。';

// ============= A107：会话池 =============
//
// 为什么需要它：`query()` 是 one-shot —— 每轮 `send()` 都新建一个 Query，
// 构造即 spawn 24MB 的 CLI 进程，收到第一个 `result` 后 `transport.close()`
// 把进程杀掉（`lib/query.js` createIterator 的 finally）。于是「自我介绍」
// 这种一句话对话，实测也要 13~15s（本机 live：起到 initialize 握手完成
// 14.7s），钱全花在冷启动税上，模型本身反而只要几百毫秒（同机器上
// opencode 免费模型 0.7s 回话，可作对照）。
//
// SDK 同时导出 `unstable_v2_createSession`（SessionImpl，`lib/session.js`）：
// 进程不随 `result` 退出，`send()`/`stream()` 可以一轮轮往下走，还带
// `interrupt()` / `setModel()` / `setPermissionMode()` / `prewarm()`。
// 本池子按「我们的会话 id」缓存会话对象，让第 2 条消息起只付模型推理的钱。
//
// 三条边界（写下来避免以后误判）：
// 1. **同一会话的发送必须串行**。CLI 一个进程同时只跑一个 prompt，且
//    `send()` 里的 `discardPendingMessages()` 会丢弃缓冲消息 —— 并发发两条
//    等于把上一条的回复冲掉。所以每个池条目挂一条 promise 链排队。
// 2. **配置变了分两档处理**。model / permissionMode 是热更新
//    （setModel / setPermissionMode，SDK 未连接时改成 CLI 参数、已连接时发
//    控制请求）；cwd / systemPrompt 变了我们关旧建新，并用旧 CLI session id
//    `resumeSession()` 把上下文接回去 —— 直接丢弃的话用户会觉得「它失忆了」。
// 3. **结构性失败即驱逐**。进程死了 / 会话失效就把条目丢掉，下一条消息
//    自动重建（resumeToken 还在，上下文不丢）。不做轮内重试 —— prompt 可能
//    已经在 CLI 侧执行了一半，重放有双重副作用风险。

/** 池开关：`OPC_SDK_SESSION_POOL=0` 退回旧的 one-shot 路径（发布回退用） */
const SESSION_POOL_ENABLED = process.env.OPC_SDK_SESSION_POOL !== '0';
/**
 * 验证/CI 注入桩 CLI 的钩子（`OPC_CODEBUDDY_CLI=<路径>` → SDK 的
 * `pathToCodebuddyCode`）。A107 的验证脚本靠它把 SDK 指向讲真协议的桩
 * 二进制，从而不起真 CLI 也能跑通池逻辑。生产环境永远不该设置它。
 *
 * ⚠️ 必须是**运行时读取**——模块级常量会在 import 时固化，验证脚本
 * 在 import 之后才设 env，模块级常量永远读不到。
 */
function cliOverride(): string | undefined {
  return process.env.OPC_CODEBUDDY_CLI || undefined;
}
/** 空闲多久后回收 CLI 进程（每个 ≈24MB 内存 + 一个 node 进程） */
const SESSION_IDLE_MS = 10 * 60 * 1000;
/** 池上限：同时活着的 CLI 进程数（LRU 淘汰） */
const SESSION_POOL_MAX = 3;
/** 空闲清扫间隔 */
const SESSION_SWEEP_MS = 60 * 1000;

interface PoolEntry {
  session: SdkSession;
  /** 建池时的配置键（cwd/model/permissionMode/systemPrompt 指纹） */
  configKey: string;
  /** CLI 侧 session id（init 消息带回），跨重启 resume 与保上下文都用它 */
  cliSessionId: string | null;
  lastUsedAt: number;
  /** 同一会话的发送队列：前一轮没跑完，后一轮在这条链上排队 */
  chain: Promise<void>;
  /** 正在跑的那一轮的身份牌与中断器；没在跑就是 null */
  inflightToken: object | null;
  inflightInterrupt: (() => void) | null;
}

/** 配置键：哪一项变了决定「热更新」还是「重建」，所以必须能按项拆。
 *  导出供验证脚本做纯函数层断言（L1）。 */
export function configKeyOf(ctx: SendContext): string {
  const sys = withMemoryContext(ctx.systemPrompt || DEFAULT_SYSTEM_PROMPT, ctx.memoryCwd);
  return [
    ctx.cwd || process.cwd(),
    ctx.model ?? '',
    ctx.permissionMode || 'default',
    // systemPrompt 动辄几百字节，哈希成短指纹；djb2 足够（仅用于判等）
    String(sys.length) + ':' + Array.from(sys).reduce((h, c) => ((h << 5) - h + c.codePointAt(0)!) | 0, 5381).toString(36),
  ].join('\n');
}

/** 两个配置键的差异档位。导出供验证脚本做纯函数层断言（L1）。 */
export function configDiff(oldKey: string, newKey: string): 'same' | 'mode-only' | 'structural' {
  if (oldKey === newKey) return 'same';
  const a = oldKey.split('\n');
  const b = newKey.split('\n');
  // 只有 model / permissionMode 变 → 热更新；cwd / systemPrompt 变 → 重建
  return a[0] === b[0] && a[3] === b[3] ? 'mode-only' : 'structural';
}

/** 未登录时拿到的登录地址，供前端渲染「去登录」按钮 */
let lastAuthUrl: string | null = null;

export function getLastAuthUrl(): string | null {
  return lastAuthUrl;
}

export class SdkAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;

  /** 正在运行的调用：sessionId → 中止控制 */
  private active = new Map<string, { abort: () => void }>();
  /** 待答复的权限请求 */
  private replies = new PendingReplies<PermissionDecision>();
  /** 探测缓存（避免每次刷新名册都跑一次鉴权） */
  private status: AgentStatus | null = null;
  /** A107：长驻会话池：我们的会话 id → CLI 进程封装 */
  private pool = new Map<string, PoolEntry>();
  /** 空闲清扫定时器（整个适配器一个就够） */
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor;
  }

  // ============= 探测 =============

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();

    // 环境变量配置的凭据最优先，无需网络往返
    const envOk = Boolean(
      process.env.CODEBUDDY_API_KEY || process.env.CODEBUDDY_AUTH_TOKEN
    );

    try {
      let needsLogin = false;
      const result = await unstable_v2_authenticate({
        environment: 'external',
        onAuthUrl: async (authState: { authUrl?: string }) => {
          needsLogin = true;
          if (authState?.authUrl) lastAuthUrl = authState.authUrl;
        },
      });

      const userinfo = (result as { userinfo?: { userName?: string } } | undefined)?.userinfo;

      if (needsLogin) {
        this.status = {
          availability: 'needs-auth',
          installed: true,
          message: '未登录，请先完成登录',
          // 结构化地址：前端「去登录」按钮直接用它，不从 message 里抠
          ...(lastAuthUrl ? { authUrl: lastAuthUrl } : {}),
          probedAt: now,
        };
      } else {
        lastAuthUrl = null;
        this.status = {
          availability: 'ready',
          installed: true,
          message: userinfo?.userName
            ? `已登录：${userinfo.userName}`
            : envOk
              ? '已通过环境变量配置凭据'
              : '已登录',
          probedAt: now,
        };
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      if (envOk) {
        this.status = {
          availability: 'ready',
          installed: true,
          message: '已通过环境变量配置凭据',
          probedAt: now,
        };
      } else {
        // 鉴权调用本身失败（可能是网络问题，也可能就是未登录）。
        // 把原因如实带上，不假装是「已登录」。
        this.status = lastAuthUrl
          ? {
              availability: 'needs-auth',
              installed: true,
              message: '未登录，请先完成登录',
              authUrl: lastAuthUrl,
              probedAt: now,
            }
          : {
              availability: 'needs-auth',
              installed: true,
              message: `鉴权检查失败：${message}`,
              probedAt: now,
            };
      }
    }

    return this.status;
  }

  // ============= 调用 =============

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const sessionId = ctx.sessionId;
    let aborted = false;

    // 这一轮的身份牌：abort 时用来确认「正在跑的是不是我这轮」。
    // 必须声明在 abort 闭包**之前** —— linkAbort 遇到「信号已中止」会
    // 同步立刻调 handler，闭包后声明会踩 TDZ。
    const turnToken = {};

    const abort = () => {
      aborted = true;
      this.replies.clear();
      // A107：中断 CLI 侧正在跑的这一轮（interrupt 控制请求）。
      // 进程不杀 —— 留给下一条消息复用，这才是池子的意义。
      // 身份牌比对不能省：同一会话的轮次是排队跑的，abort 这一轮时
      // 正在跑着的可能是**另一条** send() 的轮次，不能抢别人的中断。
      const entry = this.pool.get(sessionId);
      if (entry && entry.inflightToken === turnToken && entry.inflightInterrupt) {
        const interrupt = entry.inflightInterrupt;
        entry.inflightInterrupt = null;
        entry.inflightToken = null;
        interrupt();
      }
      queue.close();
    };
    this.active.set(sessionId, { abort });
    const unlinkAbort = linkAbort(ctx.signal, abort);

    // ---- 权限桥接：SDK 回调 → 事件流 → 前端答复 ----
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      // ---- P4-5 工具白名单：先于任何放行判断 ----
      //
      // 顺序很关键：白名单是**场景约束**，`bypassPermissions` 只是「不弹审批」。
      // 若把 bypass 放在前面，用户选了「问答」（白名单为空）再切到全放行，
      // 就等于白名单形同虚设。
      const gate = decideToolAccess(ctx.allowedTools, toolName);
      if (!gate.allowed) {
        console.log(
          `[SDK] 工具被场景白名单拦截: ${toolName} (category=${gate.category ?? 'unlisted'})`
        );
        return { behavior: 'deny', message: gate.reason } as PermissionResult;
      }

      // ---- A40 权限门禁（规则匹配 + Bash 分类器 + 路径越界）----
      // 放在 bypass 判断**之前**：全放行的含义是「不弹窗问人」，
      // 不是「连 rm -rf / 也照跑」。后者由门禁的 dangerous 一档负责，
      // 任何模式都拦。
      const verdict = evaluateToolCall({
        toolName,
        input: (input ?? {}) as Record<string, unknown>,
        cwd: ctx.cwd,
        rules: currentPermissionRules(),
      });
      if (verdict.decision === 'deny') {
        console.log(`[SDK] 门禁拦截 ${toolName}: ${verdict.rule} — ${verdict.reason ?? ''}`);
        return {
          behavior: 'deny',
          message: `[权限门禁] ${verdict.reason ?? verdict.rule ?? '高危操作'}`,
        } as PermissionResult;
      }

      // 全放行模式直接过（risky 也不问了 —— 用户已经表态）
      if (ctx.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }

      // 用户规则明示允许（A40 的 auto）：到这一步已经过完高危检查，
      // 不必再为「已经表过态的工具」反复弹窗。内置分类器的 risky 不享受
      // 这个待遇 —— 它只负责解释，不负责免问。
      if (verdict.auto) {
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }

      const requestId = randomUUID();
      queue.push({
        type: 'permission_request',
        requestId,
        toolUseId: (options as { toolUseID?: string })?.toolUseID,
        toolName,
        input: (input ?? {}) as Record<string, unknown>,
        // 弹窗上要显示「为什么问这一句」，否则用户只看到一堵墙
        risk: verdict.risk,
        rule: verdict.rule,
      });

      // 挂起，直到前端 POST /api/permission-response
      const decision = await this.replies.register(
        requestId,
        () => ({ behavior: 'deny', message: '权限请求超时' }) as PermissionDecision,
        PERMISSION_TIMEOUT
      );

      if (decision.behavior === 'allow') {
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }
      return {
        behavior: 'deny',
        message: decision.message || '用户拒绝了此操作',
      } as PermissionResult;
    };

    const started = Date.now();

    // ---- A107：池路径（默认）或 one-shot 回退 ----
    // 两条路共用一套消息映射（mapSdkMessage），差别只在「进程复用与否」。
    // 注意：轮次挂在池条目自己的 promise 链上排队，但**不能** await 它再抽
    // 队列 —— 队列必须与轮次并发抽干，否则 SSE 要等整轮结束才吐字，
    // 流式就白做了。
    if (SESSION_POOL_ENABLED && typeof unstable_v2_createSession === 'function') {
      const entry = this.acquireEntry(ctx);
      const turn = entry.chain.then(() =>
        this.runPooledTurn(entry, ctx, queue, canUseTool, turnToken, () => aborted, started)
      );
      // 链子只承载「排队与跑完」，错误在轮次内部已经转成 error 事件，
      // 这里再 catch 一次只是为了不让链条带 rejected 状态往下传
      entry.chain = turn.catch(() => {});
    } else {
      void this.runOneShotTurn(ctx, queue, canUseTool, () => aborted, started);
    }

    try {
      for await (const ev of queue) yield ev;
    } catch (err) {
      yield { type: 'error', message: (err as Error).message || String(err) };
    } finally {
      unlinkAbort();
      this.replies.clear();
      this.active.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    this.active.get(sessionId)?.abort();
    this.active.delete(sessionId);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.replies.settle(requestId, decision);
  }

  // ============= A107：池路径 =============

  /**
   * 取（或建）这个会话的池条目。同步的 —— SessionImpl 构造不连网，
   * 真正的进程 spawn 推迟到第一次 send()/stream() 里的 transport()。
   */
  private acquireEntry(ctx: SendContext): PoolEntry {
    const cfg = configKeyOf(ctx);
    const existing = this.pool.get(ctx.sessionId);

    if (existing) {
      const diff = configDiff(existing.configKey, cfg);
      if (diff === 'same') {
        existing.lastUsedAt = Date.now();
        return existing;
      }
      if (diff === 'mode-only') {
        // model / permissionMode 变了：热更新，不重启进程。
        // 具体动作放在轮次里做 —— setModel / setPermissionMode 是异步的，
        // 已连接的会话还要等 CLI 回控制响应。
        existing.configKey = cfg;
        existing.lastUsedAt = Date.now();
        return existing;
      }
      // cwd / systemPrompt 变了：只能重建，但用旧 CLI session id 把上下文
      // 接回去 —— 直接丢弃的话，用户看到的会是「它突然失忆了」。
      const resumeFrom = existing.cliSessionId;
      this.closeEntry(ctx.sessionId, existing);
      return this.createEntry(ctx, resumeFrom);
    }

    // 池里没有：进程重启后的第一条消息带 resumeToken，用它恢复上下文
    return this.createEntry(ctx, ctx.resumeToken ?? null);
  }

  private createEntry(ctx: SendContext, resumeFrom: string | null): PoolEntry {
    const options = {
      cwd: ctx.cwd || process.cwd(),
      model: ctx.model,
      maxTurns: 10,
      // A38/A98：提示词装配与 one-shot 路径完全一致（记忆层在这里注入）
      systemPrompt: withMemoryContext(ctx.systemPrompt || DEFAULT_SYSTEM_PROMPT, ctx.memoryCwd),
      permissionMode: ctx.permissionMode || 'default',
      // 占位 handler：每一轮 send 前都会 setCanUseTool 覆盖掉它。
      // fail-closed —— 万一哪轮忘了覆盖，也不至于放行未知工具。
      canUseTool: (async () => ({
        behavior: 'deny',
        message: '权限处理器未就绪',
      })) as CanUseTool,
      ...(cliOverride() ? { pathToCodebuddyCode: cliOverride() } : {}),
    };
    let session: SdkSession;
    try {
      session = resumeFrom
        ? unstable_v2_resumeSession(resumeFrom, options)
        : unstable_v2_createSession(options);
    } catch {
      // resume 构造失败（构造阶段不连网，正常不该抛；防的是 SDK 升级
      // 改了签名）。退回全新会话 —— 丢上下文也比不可用强。
      session = unstable_v2_createSession(options);
    }
    const entry: PoolEntry = {
      session,
      configKey: configKeyOf(ctx),
      // SessionImpl 把这个 id 通过 --session-id 递给 CLI，CLI 采纳它 ——
      // 所以它就是 CLI 侧会话 id，不等 init 消息也能当 resume 令牌用
      //（init 流消息可能被 send() 的 discardPendingMessages() 冲掉）。
      cliSessionId: session.sessionId,
      lastUsedAt: Date.now(),
      chain: Promise.resolve(),
      inflightToken: null,
      inflightInterrupt: null,
    };
    this.pool.set(ctx.sessionId, entry);
    this.ensureSweep();
    this.enforceCap();
    return entry;
  }

  /** 跑一轮（池路径）。queue 由调用方 drain，这里只负责生产与收尾。 */
  private async runPooledTurn(
    entry: PoolEntry,
    ctx: SendContext,
    queue: AsyncQueue<AgentEvent>,
    canUseTool: CanUseTool,
    token: object,
    shouldAbort: () => boolean,
    started: number
  ): Promise<void> {
    // 排队期间被中止：这一轮直接作废，不发给 CLI
    if (shouldAbort()) {
      queue.close();
      return;
    }
    // 轮次真正开始才刷新空闲计时 —— 否则排队中的轮次会被清扫误杀
    entry.lastUsedAt = Date.now();
    entry.inflightToken = token;
    entry.inflightInterrupt = () => {
      void entry.session.interrupt().catch(() => {});
    };
    try {
      // 每轮换上当轮的权限 handler（白名单/门禁/弹窗判定都绑在 ctx 上）
      entry.session.setCanUseTool(canUseTool);

      // model / permissionMode 热更新。配置键只在 mode-only 时被改写，
      // 所以这里对比的是「CLI 当前状态」与「这一轮要求的状态」。
      if (ctx.model && entry.session.getModel?.() !== ctx.model) {
        await entry.session.setModel(ctx.model);
      }
      const wantMode = ctx.permissionMode || 'default';
      if (entry.session.getPermissionMode?.() !== wantMode) {
        await entry.session.setPermissionMode(wantMode);
      }

      queue.push({
        type: 'init',
        sessionId: ctx.sessionId,
        model: ctx.model,
        // 见 createEntry：令牌不等 CLI 的 init 消息，直接上报
        resumeToken: entry.cliSessionId,
        source: 'native',
      });

      await entry.session.send(ctx.prompt);

      const st: TurnState = { currentToolId: null, openTools: [], started };
      // 本轮是怎么收尾的：'result' 正常结束 / 'error' CLI 报了错 / null 还没
      // 收尾。null 且不是被 abort 打断 = CLI 进程提前结束（崩溃/被杀），
      // 必须当失败处理并驱逐，否则下一条消息会复用死进程而静默无响应。
      let finished: 'result' | 'error' | null = null;
      for await (const msg of entry.session.stream()) {
        if (shouldAbort()) break;
        const m = msg as Record<string, unknown>;
        // CLI 回报的 session id 若与 SDK 侧不一致，以 CLI 为准
        if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
          entry.cliSessionId = m.session_id;
        }
        const outcome = mapSdkMessage(m, ctx, queue, st);
        if (outcome === 'result') { finished = 'result'; break; }
        if (outcome === 'error') { finished = 'error'; break; }
      }
      if (finished === 'error') {
        // error 事件已在 mapSdkMessage 推给前端；进程可能已不可用，驱逐避免
        // 复用死进程（真实 CLI 报 EADDRINUSE 这类致命错时复用会再次吊死）。
        // 不再 queue.fail()——否则前端会收到两条 error（mapSdkMessage 已推过）。
        this.closeEntry(ctx.sessionId, entry);
        queue.close();
        return;
      }
      if (finished === 'result') {
        queue.close();
        return;
      }
      // 既没 result 也没 error，且不是被 abort 打断：CLI 进程八成已经崩了或
      // 被杀（stdout 直接关闭）。不报出来就会像以前一样「发了消息没响应」。
      if (!shouldAbort()) {
        this.closeEntry(ctx.sessionId, entry);
        // 必须 push 一条 error 事件再 close，不能只用 queue.fail()：
        // AsyncQueue.fail() 先设 failure 再 close()，而 close() 会把「已经在
        // waiters 里挂着的消费者」用 {done:true} 唤醒（channel.ts 的 next()
        // 里 items 为空时先返回 failure，但消费者此刻已经在等，拿到的是 done）
        // ——于是 failure 永远没人读到，消费者看到的是「静默成功」，正是 A107
        // 要治的病。push 走的是 waiters.shift()→resolve(item)，消费者先拿到
        // error 事件，再下一轮 next() 才看到 closed→done。
        queue.push({ type: 'error', message: 'CLI 进程提前结束，本轮未返回结果' });
        queue.close();
        return;
      }
      // 被 abort：queue 已由 abort() 关闭，这里什么都不用做
    } catch (err) {
      // 结构性失败（进程死了 / 会话失效 / 控制请求超时）：驱逐 + 报错。
      // 不做轮内重试 —— prompt 可能已在 CLI 侧执行了一半，重放有双重
      // 副作用风险。下一条消息会自动重建（resumeToken 还在，上下文不丢）。
      this.closeEntry(ctx.sessionId, entry);
      queue.fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (entry.inflightToken === token) {
        entry.inflightToken = null;
        entry.inflightInterrupt = null;
      }
      entry.lastUsedAt = Date.now();
    }
  }

  /**
   * one-shot 回退路径（`OPC_SDK_SESSION_POOL=0` 或 SDK 没有会话 API 时）。
   * 就是 A107 之前的逻辑：每条消息新建 Query，进程用完即弃。
   */
  private async runOneShotTurn(
    ctx: SendContext,
    queue: AsyncQueue<AgentEvent>,
    canUseTool: CanUseTool,
    shouldAbort: () => boolean,
    started: number
  ): Promise<void> {
    try {
      const stream = query({
        prompt: ctx.prompt,
        options: {
          cwd: ctx.cwd || process.cwd(),
          model: ctx.model,
          maxTurns: 10,
          systemPrompt: withMemoryContext(ctx.systemPrompt || DEFAULT_SYSTEM_PROMPT, ctx.memoryCwd),
          permissionMode: ctx.permissionMode || 'default',
          canUseTool,
          ...(cliOverride() ? { pathToCodebuddyCode: cliOverride() } : {}),
          ...(ctx.resumeToken ? { resume: ctx.resumeToken } : {}),
        },
      });

      queue.push({ type: 'init', sessionId: ctx.sessionId, model: ctx.model, source: 'native' });

      const st: TurnState = { currentToolId: null, openTools: [], started };
      let failed: Error | null = null;
      for await (const msg of stream) {
        if (shouldAbort()) break;
        const outcome = mapSdkMessage(msg as Record<string, unknown>, ctx, queue, st);
        if (outcome === 'result') break;
        if (outcome === 'error') {
          failed = new Error(String((msg as { error?: unknown }).error ?? 'CLI 返回错误'));
          break;
        }
      }
      if (failed) queue.fail(failed);
      else queue.close();
    } catch (err) {
      queue.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 关掉并移出一个条目。expect 用于身份比对，避免关掉已经被替换的新条目。 */
  private closeEntry(key: string, expect?: PoolEntry): void {
    const entry = this.pool.get(key);
    if (!entry) return;
    if (expect && entry !== expect) return;
    this.pool.delete(key);
    try {
      entry.session.close();
    } catch {
      /* 进程已经死了，忽略 */
    }
  }

  /** 启动空闲清扫（整个适配器一个定时器够用） */
  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of [...this.pool]) {
        // 正在跑一轮的条目不扫；刚结束的轮次会在 finally 里刷新时间戳
        if (entry.inflightToken) continue;
        if (now - entry.lastUsedAt > SESSION_IDLE_MS) this.closeEntry(key);
      }
      if (this.pool.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, SESSION_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** LRU 上限：超了就先关最久没用的（正在跑的跳过） */
  private enforceCap(): void {
    while (this.pool.size > SESSION_POOL_MAX) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, entry] of this.pool) {
        if (entry.inflightToken) continue;
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return; // 全在跑，超就超吧
      this.closeEntry(oldestKey);
    }
  }
}

/** 一轮对话的映射状态（工具开闭跟踪） */
interface TurnState {
  currentToolId: string | null;
  openTools: string[];
  started: number;
}

/**
 * 把一条 SDK 消息映射成统一事件。池路径与 one-shot 路径共用 ——
 * 两条路的差别只该是「进程复用与否」，不该是「事件长什么样」。
 *
 * @returns 'continue' 还有下文；'result' 本轮结束；'error' CLI 报了错
 */
function mapSdkMessage(
  m: Record<string, unknown>,
  ctx: SendContext,
  queue: AsyncQueue<AgentEvent>,
  st: TurnState
): 'continue' | 'result' | 'error' {
  if (m.type === 'system' && m.subtype === 'init') {
    queue.push({
      type: 'init',
      sessionId: ctx.sessionId,
      model: ctx.model,
      resumeToken: (m.session_id as string) ?? null,
      source: 'native',
    });
    return 'continue';
  }

  if (m.type === 'assistant') {
    const content = (m.message as { content?: unknown })?.content;
    if (typeof content === 'string') {
      queue.push({ type: 'text', content });
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text') {
          queue.push({ type: 'text', content: String(block.text ?? '') });
        } else if (block.type === 'image' && typeof block.source === 'object' && block.source !== null) {
          const source = block.source as Record<string, unknown>;
          const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
          const data = typeof source.data === 'string' ? source.data : undefined;
          const url = typeof source.url === 'string' ? source.url : undefined;
          if (data || url) {
            queue.push({
              type: 'artifact',
              id: `sdk-image-${randomUUID()}`,
              name: '图像产物',
              mediaType,
              ...(url ? { uri: url } : {}),
              ...(data ? { data: { encoding: 'base64', content: data } } : {}),
              description: '由 Agent SDK 原生消息块返回的图像',
            });
          }
        } else if (block.type === 'tool_use') {
          st.currentToolId = (block.id as string) || randomUUID();
          st.openTools.push(st.currentToolId);
          queue.push({
            type: 'tool',
            id: st.currentToolId,
            name: String(block.name ?? 'unknown'),
            input: block.input ?? {},
          });
        }
      }
    }
    return 'continue';
  }

  if (m.type === 'tool_result') {
    const toolId = (m.tool_use_id as string) || st.currentToolId;
    if (!toolId) return 'continue';
    const raw = m.content;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    queue.push({
      type: 'tool_result',
      toolId,
      content: text,
      isError: Boolean(m.is_error),
    });
    const i = st.openTools.indexOf(toolId);
    if (i >= 0) st.openTools.splice(i, 1);
    st.currentToolId = null;
    return 'continue';
  }

  if (m.type === 'result') {
    // 收尾：把还没拿到结果的工具标记完成，避免前端一直转圈
    for (const toolId of st.openTools) {
      queue.push({ type: 'tool_result', toolId, content: '已完成' });
    }
    st.openTools.length = 0;
    queue.push({
      type: 'done',
      durationMs: typeof m.duration === 'number' ? m.duration : Date.now() - st.started,
      cost: typeof m.cost === 'number' ? m.cost : undefined,
    });
    return 'result';
  }

  // A107：CLI 的 error 消息以前会穿透所有分支、什么都不推，然后流继续
  // 死等到进程自然死亡 —— 用户侧看到的就是「发了消息没响应」。
  // （实测：本机 CLI 报 EADDRINUSE 时，query() 流空转 300s 直到超时）
  if (m.type === 'error') {
    queue.push({
      type: 'error',
      message: String(m.error ?? m.message ?? 'CLI 返回错误'),
    });
    return 'error';
  }

  return 'continue';
}
