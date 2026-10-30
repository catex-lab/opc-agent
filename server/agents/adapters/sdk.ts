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
import {
  SDK_PERMISSION_OPTIONS,
  buildDenialMessage,
  reasonCodeOfKind,
} from '../../../shared/permissions.js';
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
/**
 * 预热超时。
 *
 * 预热是「提前 spawn 进程」，正常情况下十几秒内完事（本机实测冷启动
 * 14.7s，代理拖慢时会到 30s+）。但如果 CLI 卡在启动阶段（等鉴权、等网络），
 * 这个 Promise 会一直悬着 —— 而首条消息的 `transport()` 正好会 await 它，
 * 于是「预热」反而把第一条消息拖死。所以超时就丢弃条目（连带杀掉进程），
 * 让首条消息回到「自己起进程」的老路：慢，但一定能出结果。
 */
const PREWARM_TIMEOUT = 60 * 1000;

interface PoolEntry {
  session: SdkSession;
  /** 建池时的配置键（cwd/model/permissionMode/systemPrompt 指纹） */
  configKey: string;
  /** CLI 侧 session id（init 消息带回），跨重启 resume 与保上下文都用它 */
  cliSessionId: string | null;
  /** 正在跑的那一轮的身份牌与中断器；没在跑就是 null */
  inflightToken: object | null;
  inflightInterrupt: (() => void) | null;
}

/**
 * 一个会话的槽位。
 *
 * 为什么「串行链」挂在槽位上而不是条目上（A109）：配置变化需要重建进程时，
 * 重建必须发生在**上一轮跑完之后**。A107 把链挂在条目上，于是新消息一到就
 * 在 `acquireEntry` 里当场关掉旧会话 —— 如果那时正好有一轮在跑，那一轮会被
 * 当成「CLI 进程提前结束」报错，用户看到的是「回答到一半突然断了」。
 * 把链提到会话层，重建就自然落在链里，串行与重建都不再和「正在跑」抢。
 */
interface SessionSlot {
  /** 当前池条目；被驱逐/重建期间为 null */
  entry: PoolEntry | null;
  /** 本会话的发送链：上一轮没跑完，后一轮在这条链上排队 */
  chain: Promise<void>;
  /** 排队中 + 正在跑的轮次数。>0 时这个槽位不能被清扫/LRU 回收 */
  busy: number;
  /** 最后一次有动作的时间（建条目 / 开轮 / 收轮） */
  lastUsedAt: number;
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
  /**
   * 「本会话始终允许 / 始终拒绝」的记忆（P4）。
   *
   * SDK 没有持久化审批决定的 API，只能由适配器自己记住工具名。
   * 作用域是「本会话 + 本次应用运行」—— 界面上每个始终选项的 note 都写了
   * 这条边界，不能让它悄悄跨会话或跨重启生效。
   *
   * 记忆不能跳过门禁：`rm -rf /` 这类高危检查在白名单与记忆**之前**，
   * 所以「始终允许」也不可能放行危险操作。
   */
  private approvalMemory = new Map<
    string,
    { allow: Set<string>; deny: Set<string> }
  >();
  /** 探测缓存（避免每次刷新名册都跑一次鉴权） */
  private status: AgentStatus | null = null;
  /** A107/A109：长驻会话池：我们的会话 id → 槽位（条目 + 串行链） */
  private slots = new Map<string, SessionSlot>();
  /** 空闲清扫定时器（整个适配器一个就够） */
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor;
  }

  // ============= 探测 =============

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();

    // 2026-10-30：内置 CLI 已从安装包排除，需本机自行安装。
    // bootstrap.cjs 会探测并注入 CODEBUDDY_CODE_PATH；没注入就是没找到。
    const hasCli = Boolean(
      process.env.CODEBUDDY_CODE_PATH || process.env.OPC_CODEBUDDY_CLI
    );

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

      // CLI 缺失是独立状态，比「鉴权失败」更前置：用户需要先装 CLI 才能谈登录。
      const cliMissing =
        !hasCli &&
        (message.includes('CodeBuddy CLI not found') ||
          message.includes('CLI not found'));
      if (cliMissing) {
        this.status = {
          availability: 'not-installed',
          installed: false,
          message:
            '未检测到 CodeBuddy CLI。请先安装 CodeBuddy 并确保 codebuddy 在 PATH 中，' +
            '或设置环境变量 CODEBUDDY_CODE_PATH 指向可执行文件。',
          probedAt: now,
        };
        return this.status;
      }

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
      // 只清本会话的待答复项。这张表是**整个适配器共享**的，早先无条件
      // clear() 会把别的会话正在等的权限弹窗一起清掉 —— 而清掉之后那个
      // Promise 永远不兑现（见 PendingReplies.clear 的注释），那一轮就静默挂死。
      this.replies.clear(sessionId);
      // A107：中断 CLI 侧正在跑的这一轮（interrupt 控制请求）。
      // 进程不杀 —— 留给下一条消息复用，这才是池子的意义。
      // 身份牌比对不能省：同一会话的轮次是排队跑的，abort 这一轮时
      // 正在跑着的可能是**另一条** send() 的轮次，不能抢别人的中断。
      const entry = this.slots.get(sessionId)?.entry;
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
        // 两段式：先定性「不是工具故障」，再给替代路径 —— 否则模型会重试
        return {
          behavior: 'deny',
          message: buildDenialMessage('rule_blocked', gate.reason),
        } as PermissionResult;
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
          message: buildDenialMessage('rule_blocked', verdict.reason ?? verdict.rule),
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

      // ---- P4：本会话的「始终」记忆 ----
      // 放在白名单 / 门禁 / bypass / auto 之后：用户点过「始终允许」的工具
      // 不再弹窗，但高危检查已经先行拦过，记忆不能把危险操作放出去。
      const memory = this.approvalMemory.get(sessionId);
      if (memory?.deny.has(toolName)) {
        return {
          behavior: 'deny',
          message: buildDenialMessage('user_denied_always', toolName),
        } as PermissionResult;
      }
      if (memory?.allow.has(toolName)) {
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
        // A132：把服务端的兜底时刻如实带下去，前端才能画倒计时而不是自己猜。
        // 三家都有 PERMISSION_TIMEOUT；ACP 没有，所以 acp.ts 不带这个字段。
        expiresAt: Date.now() + PERMISSION_TIMEOUT,
        // 这些是 SDK 真的能兑现的档位（见 approvalMemory 的注释）
        options: [...SDK_PERMISSION_OPTIONS],
      });

      // 挂起，直到前端 POST /api/permission-response
      const decision = await this.replies.register(
        requestId,
        () => ({ behavior: 'deny', reasonCode: 'timeout' }) as PermissionDecision,
        PERMISSION_TIMEOUT,
        // 归属到会话：别的会话收尾时不能把我的待答复项清掉
        sessionId,
        // 会话结束与超时是两件不同的事，原因码不能互相冒充
        () => ({ behavior: 'deny', reasonCode: 'cancelled' }) as PermissionDecision
      );

      const chosen = decision.optionId
        ? SDK_PERMISSION_OPTIONS.find(o => o.id === decision.optionId)
        : undefined;
      const kind = chosen?.kind;

      if (decision.behavior === 'allow') {
        if (kind === 'allow_always') {
          this.memoryFor(sessionId).allow.add(toolName);
        }
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }

      const code =
        (kind && reasonCodeOfKind(kind)) || decision.reasonCode || 'user_rejected';
      if (code === 'user_denied_always') {
        this.memoryFor(sessionId).deny.add(toolName);
      }
      return {
        behavior: 'deny',
        message: buildDenialMessage(code, decision.message || toolName),
      } as PermissionResult;
    };

    const started = Date.now();

    // ---- A107：池路径（默认）或 one-shot 回退 ----
    // 两条路共用一套消息映射（mapSdkMessage），差别只在「进程复用与否」。
    // 注意：轮次挂在槽位的 promise 链上排队，但**不能** await 它再抽队列 ——
    // 队列必须与轮次并发抽干，否则 SSE 要等整轮结束才吐字，流式就白做了。
    if (SESSION_POOL_ENABLED && typeof unstable_v2_createSession === 'function') {
      const slot = this.slotFor(sessionId);
      // 排队这一刻就算「在用」：清扫与 LRU 都不许在这期间把条目关掉，
      // 否则排队中的轮次醒来会撞上一个已关闭的会话（A109）
      slot.busy += 1;
      slot.lastUsedAt = Date.now();
      const turn = slot.chain.then(() =>
        this.runPooledTurn(slot, ctx, queue, canUseTool, turnToken, () => aborted, started)
      );
      // 链子只承载「排队与跑完」，错误在轮次内部已经转成 error 事件，
      // 这里再 catch 一次只是为了不让链条带 rejected 状态往下传
      slot.chain = turn
        .catch(() => {})
        .finally(() => {
          slot.busy = Math.max(0, slot.busy - 1);
          slot.lastUsedAt = Date.now();
          this.releaseIfIdle(sessionId, slot);
        });
    } else {
      void this.runOneShotTurn(ctx, queue, canUseTool, () => aborted, started);
    }

    try {
      for await (const ev of queue) yield ev;
    } catch (err) {
      yield { type: 'error', message: (err as Error).message || String(err) };
    } finally {
      unlinkAbort();
      this.replies.clear(sessionId);
      // 身份比对：同一会话的第二条消息可能在第一条还没结束时就已经
      // 覆盖了 active 里的中止器。无条件 delete 会把**新那一条**的中止入口
      // 抹掉，用户点停止就毫无反应（群聊/连发时很容易踩到）。
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

  private memoryFor(sessionId: string): { allow: Set<string>; deny: Set<string> } {
    let entry = this.approvalMemory.get(sessionId);
    if (!entry) {
      entry = { allow: new Set(), deny: new Set() };
      this.approvalMemory.set(sessionId, entry);
    }
    return entry;
  }

  /**
   * 进程退出时回收常驻 CLI 进程。
   *
   * 为什么必须有：A107 把「每条消息一个短命进程」换成了「每会话一个常驻
   * 进程」，退出应用时如果没人关，那些进程就会挂在后台（每个 ≈24MB + 一个
   * node），Windows 上父进程退出不会连带杀子进程。以前没有这个问题，是因为
   * one-shot 的进程在 result 后就被 SDK 自己关掉了。
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const key of [...this.slots.keys()]) this.closeEntry(key);
    this.slots.clear();
    this.replies.clear();
    this.approvalMemory.clear();
  }

  // ============= A107/A109：池路径 =============

  /**
   * 预热：把 CLI 进程提前 spawn 起来，让**首条消息**不必再付冷启动税。
   *
   * 为什么值得单独做：A107 的池子只省「第 2 条起」，第一条仍要 14.7s
   * （spawn + V8 编译 24MB + 进程启动）。用户抱怨的「响应慢」恰恰集中在
   * 「打开会话问第一句」。预热把这段与「用户打字」重叠起来。
   *
   * 三条边界：
   * 1. **只 spawn，不做 initialize**（SDK 的 `prewarm()` 就是这个语义）——
   *    握手留给首条消息，因为握手要带 hasPrompt 之类的本轮参数。
   * 2. **有轮次在跑/排队就完全不碰**：条目归轮次管，插一脚只会制造竞态。
   * 3. **失败即静默丢弃**：没装 CLI / 未登录 / 网络不通都不该冒泡到请求层；
   *    超时也丢弃（见 PREWARM_TIMEOUT 的注释）。
   */
  prewarm(ctx: SendContext): void {
    if (!SESSION_POOL_ENABLED || typeof unstable_v2_createSession !== 'function') return;
    const slot = this.slotFor(ctx.sessionId);
    // 有轮次在跑/排队，或者这个会话已经有热进程：都不该动。
    //
    // 尤其「已有条目」这一条：预热的配置是从会话行拼出来的，未必与真正
    // 跑过的那一轮完全一致（比如 systemPrompt 由请求体带、会话里存的是
    // 另一份）。一旦按预热的配置去 diff，就可能把热进程判成「结构性不符」
    // 而重建 —— 每次打开会话白起一个 24MB 进程，纯浪费。
    if (slot.busy > 0 || slot.entry) return;

    const entry = this.createEntry(slot, ctx, ctx.resumeToken ?? null);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 超时：进程可能卡在启动/鉴权上，留着只会把首条消息一起拖死
      this.dropEntry(slot, entry);
    }, PREWARM_TIMEOUT);
    timer.unref?.();

    void entry.session
      .prewarm()
      .then(() => {
        settled = true;
        clearTimeout(timer);
        slot.lastUsedAt = Date.now();
      })
      .catch(() => {
        settled = true;
        clearTimeout(timer);
        // 预热失败不是错误：下一条消息会自己起进程（只是慢一点）
        this.dropEntry(slot, entry);
      });
  }

  /** 取（或建）会话槽位。同步、不碰 IO。 */
  private slotFor(sessionId: string): SessionSlot {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = { entry: null, chain: Promise.resolve(), busy: 0, lastUsedAt: Date.now() };
      this.slots.set(sessionId, slot);
      this.ensureSweep();
    }
    return slot;
  }

  /**
   * 取（或建）这个会话的池条目。**只在轮次链里调用** —— 所以此刻本会话
   * 没有别的轮次在跑，重建（关旧开新）是安全的。
   *
   * SessionImpl 构造不连网，真正的进程 spawn 推迟到第一次 send()/stream()。
   */
  private ensureEntry(slot: SessionSlot, ctx: SendContext): PoolEntry {
    const cfg = configKeyOf(ctx);
    const existing = slot.entry;

    if (existing) {
      const diff = configDiff(existing.configKey, cfg);
      if (diff === 'same') return existing;
      if (diff === 'mode-only') {
        // model / permissionMode 变了：热更新，不重启进程。
        // 具体动作放在轮次里做 —— setModel / setPermissionMode 是异步的，
        // 已连接的会话还要等 CLI 回控制响应。
        existing.configKey = cfg;
        return existing;
      }
      // cwd / systemPrompt 变了：只能重建，但用旧 CLI session id 把上下文
      // 接回去 —— 直接丢弃的话，用户看到的会是「它突然失忆了」。
      const resumeFrom = existing.cliSessionId;
      this.dropEntry(slot, existing);
      return this.createEntry(slot, ctx, resumeFrom);
    }

    // 池里没有：进程重启后的第一条消息带 resumeToken，用它恢复上下文
    return this.createEntry(slot, ctx, ctx.resumeToken ?? null);
  }

  private createEntry(slot: SessionSlot, ctx: SendContext, resumeFrom: string | null): PoolEntry {
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
      inflightToken: null,
      inflightInterrupt: null,
    };
    slot.entry = entry;
    slot.lastUsedAt = Date.now();
    this.ensureSweep();
    this.enforceCap();
    return entry;
  }

  /**
   * 跑一轮（池路径）。queue 由调用方 drain，这里只负责生产与收尾。
   *
   * 条目在**链里**才取（`ensureEntry`）：这样「配置变了要重建」不会撞上
   * 上一轮还在跑的情况 —— 轮到这一轮时上一轮必然已经收尾。
   */
  private async runPooledTurn(
    slot: SessionSlot,
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
    let entry: PoolEntry | null = null;
    try {
      entry = this.ensureEntry(slot, ctx);
      entry.inflightToken = token;
      entry.inflightInterrupt = () => {
        void entry!.session.interrupt().catch(() => {});
      };
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
        this.dropEntry(slot, entry);
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
        this.dropEntry(slot, entry);
        // 这里 push 一条 error 事件再 close，而不是 queue.fail()：
        // A107 当时是因为 fail() 会把错误吞掉才绕开的（close() 用 {done:true}
        // 唤醒挂起的消费者，failure 没人读）。A108 已把 fail() 修成「直接
        // reject 给挂起者」，两条路都能送到；仍然选 push+close，是因为这条
        // 错误的措辞要由我们自己定，且不想让它经过 send() 的 catch 再包一层。
        queue.push({ type: 'error', message: 'CLI 进程提前结束，本轮未返回结果' });
        queue.close();
        return;
      }
      // 被 abort：queue 已由 abort() 关闭，这里什么都不用做
    } catch (err) {
      // 结构性失败（进程死了 / 会话失效 / 控制请求超时）：驱逐 + 报错。
      // 不做轮内重试 —— prompt 可能已在 CLI 侧执行了一半，重放有双重
      // 副作用风险。下一条消息会自动重建（resumeToken 还在，上下文不丢）。
      this.dropEntry(slot, entry ?? undefined);
      queue.fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (entry && entry.inflightToken === token) {
        entry.inflightToken = null;
        entry.inflightInterrupt = null;
      }
      slot.lastUsedAt = Date.now();
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
      let sawResult = false;
      for await (const msg of stream) {
        if (shouldAbort()) break;
        const outcome = mapSdkMessage(msg as Record<string, unknown>, ctx, queue, st);
        if (outcome === 'result') { sawResult = true; break; }
        if (outcome === 'error') {
          // 错误事件 mapSdkMessage 已经推给前端了，这里只记一下别再 fail 一遍，
          // 否则消费者会收到两条 error（一条事件 + 一条异常）
          failed = new Error(String((msg as { error?: unknown }).error ?? 'CLI 返回错误'));
          break;
        }
      }
      if (failed) {
        queue.close();
        return;
      }
      // 回退路径同样要有崩溃检测：流没给出 result 就结束、又不是被 abort，
      // 等于 CLI 提前死了。以前这里直接 close()，前端看到的是「正常结束」，
      // 和 A107 治的「发了消息没响应」是同一个病。
      if (!sawResult && !shouldAbort()) {
        queue.push({ type: 'error', message: 'CLI 进程提前结束，本轮未返回结果' });
      }
      queue.close();
    } catch (err) {
      queue.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 关掉并移出这个槽位的条目。
   *
   * `expect` 用于身份比对：调用方手里那个条目可能已经被重建替换掉了，
   * 此时不能顺手把新的那个关掉（那会让紧随其后的轮次撞上死进程）。
   */
  private dropEntry(slot: SessionSlot, expect?: PoolEntry): void {
    const entry = slot.entry;
    if (!entry) return;
    if (expect && entry !== expect) return;
    slot.entry = null;
    try {
      entry.session.close();
    } catch {
      /* 进程已经死了，忽略 */
    }
  }

  /** 关掉某个会话的条目（按 sessionId，供 dispose / 清扫使用） */
  private closeEntry(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    this.dropEntry(slot);
  }

  /** 没有任何在途轮次、也没有条目了 → 连槽位一起摘掉，别让 Map 长草 */
  private releaseIfIdle(sessionId: string, slot: SessionSlot): void {
    if (slot.busy > 0 || slot.entry) return;
    if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
  }

  /** 启动空闲清扫（整个适配器一个定时器够用） */
  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, slot] of [...this.slots]) {
        // 有轮次在跑或排队就不扫：排队中的轮次也会刷新时间戳，但这里
        // 不靠时间戳兜底 —— busy 才是「真的在用」的判据（A109）
        if (slot.busy > 0) continue;
        if (now - slot.lastUsedAt > SESSION_IDLE_MS) {
          this.dropEntry(slot);
          this.slots.delete(key);
        }
      }
      if (this.slots.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, SESSION_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** LRU 上限：超了就先关最久没用的（有轮次在跑的跳过） */
  private enforceCap(): void {
    const liveCount = () => {
      let n = 0;
      for (const slot of this.slots.values()) if (slot.entry) n++;
      return n;
    };
    while (liveCount() > SESSION_POOL_MAX) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, slot] of this.slots) {
        if (!slot.entry || slot.busy > 0) continue;
        if (slot.lastUsedAt < oldestAt) {
          oldestAt = slot.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return; // 全在跑，超就超吧
      const slot = this.slots.get(oldestKey)!;
      this.dropEntry(slot);
      this.slots.delete(oldestKey);
    }
  }
}

/** 一轮对话的映射状态（工具开闭跟踪） */
export interface TurnState {
  currentToolId: string | null;
  openTools: string[];
  started: number;
}

/**
 * 把一条 SDK 消息映射成统一事件。池路径与 one-shot 路径共用 ——
 * 两条路的差别只该是「进程复用与否」，不该是「事件长什么样」。
 *
 * 导出是为了能直接断言「未知消息不会消失」（scripts/verify-a111）。
 * 这条链路的失败模式是静默的，只能靠直接喂消息来验。
 *
 * @returns 'continue' 还有下文；'result' 本轮结束；'error' CLI 报了错
 */
export function mapSdkMessage(
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
        } else if (block.type === 'thinking') {
          // A111：思考块以前在这里被**静默丢弃** —— 这个循环只认 text / image /
          // tool_use，`{type:'thinking', thinking:'…'}` 落不到任何分支，然后就没了。
          // 而 workbuddy 的 eventCapabilities 里明明写着 `thinking`：清单在撒谎。
          //
          // 这正是「多报 = 伪造」那类缺陷 —— 声明了能力、界面照着声明去画折叠条，
          // 可适配器一次都没往那儿送过东西。修法是让适配器兑现清单，而不是
          // 把清单改小：能力本来就有，是我们没接。
          const think = String(block.thinking ?? '');
          if (think) queue.push({ type: 'thinking', content: think });
        } else if (block.type === 'redacted_thinking') {
          // 厂商把这段思考加密了：正文拿不到，但「确实想过一段」是事实。
          // 以前它掉进下面的 raw 旁路，界面上只剩一条看不懂的原生事件；
          // 现在落成一个「已隐去」的思考块 —— 不伪造内容，也不假装没发生。
          queue.push({ type: 'thinking', content: '', redacted: true });
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
        } else {
          // A111：**内容块级**的旁路。
          //
          // 消息级兜底（本函数末尾那段）管的是「整条消息不认识」，管不到
          // 「消息认识、但里面某个块不认识」——`assistant` 是认识的，所以
          // 一个 `server_tool_use` / 未来新增的块类型会安静地消失在 885 行
          // 这个循环里，连消息级兜底都摸不到它。
          //
          // channel 用 `sdk:block:<type>`：与消息级的 `sdk:<type>` 分开，
          // 排障时一眼能看出「是块没映射」还是「整条消息没映射」。
          queue.push({
            type: 'raw',
            channel: `sdk:block:${String(block.type ?? 'unknown')}`,
            payload: block,
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

  // A111：走到这里说明上面**没有一个分支认识它**。
  //
  // 以前这是一句裸的 `return 'continue'` —— 消息就此蒸发，界面上看不出任何异常。
  // 新版 CLI 加了 `stream_event`、`compact_boundary`、`rate_limit` 这类消息时，
  // 我们只能从「它怎么没反应」里猜。现在原样送进 raw 旁路：投影器收进一个
  // RawBlock，UI 折叠展示，既不干扰正文，也永不静默丢弃。
  //
  // channel 用 `sdk:<type>[/<subtype>]` 而不是只写 type：`system` 底下有十几个
  // subtype（status / compact_boundary / …），只报 type 等于没报。
  queue.push({
    type: 'raw',
    channel: `sdk:${String(m.type ?? 'unknown')}${m.subtype ? `/${String(m.subtype)}` : ''}`,
    payload: m,
  });
  return 'continue';
}
