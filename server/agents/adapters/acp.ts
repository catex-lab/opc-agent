/**
 * ACP 适配器：接入实现了 Agent Client Protocol 的 Agent（目前是 Hermes）。
 *
 * ACP 是 stdio 上的换行分隔 JSON-RPC 2.0。实测确认的交互序列：
 *
 *   client → initialize      { protocolVersion, clientCapabilities, clientInfo }
 *   agent  ← { agentCapabilities, agentInfo, authMethods }
 *   client → session/new     { cwd, mcpServers }
 *   agent  ← { sessionId, models: { availableModels } }
 *   client → session/prompt  { sessionId, prompt: [{ type:'text', text }] }
 *   agent  ← session/update × N   （流式：agent_message_chunk / agent_thought_chunk /
 *                                   tool_call / tool_call_update / usage_update）
 *   agent  ← { stopReason, usage }
 *
 * 与 CLI 适配器的根本区别：CLI 是「一问一答起进程」，ACP 是「长驻进程 + 多会话」，
 * 所以这里维护一个常驻子进程和一张 sessionId 映射表。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { AsyncQueue, linkAbort } from '../channel.js';
import {
  findExecutable,
  resolveAnyLaunchTarget,
  isUnresolvedShim,
  isIdeLauncher,
  expandPath,
  killProcessTree,
  type LaunchTarget,
} from '../probe.js';
import type { AgentDefinition } from '../definitions.js';
import { kbMcpServerSpec, KB_MCP_SERVER_NAME } from '../../kb/tool.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
  PermissionDecision,
  SendContext,
} from '../types.js';
import { decideAcpToolAccess } from '../toolPolicy.js';
// 「该 Agent 永久」的落库查询（2026-11-12 变体 A）：命中即在弹卡前自动放行
import { hasAgentGrant } from '../../permission-grants.js';
import { appendFailureAdvice, recoveryHintFor } from '../recovery.js';
import { withAnswerLanguage } from '../../answer-language.js';
import type { ScenarioTool } from '../../../shared/scenarios.js';
import {
  normalizePermissionOptions,
  behaviorOfKind,
  type PermissionOption,
} from '../../../shared/permissions.js';

/**
 * 从 ACP 归一化后的选项里挑一个回给服务端。
 *
 * 为什么单独抽成纯函数：选择规则是这一段里最容易悄悄出错的地方 ——
 * 早先的实现在 allow 时「找不到 allow 就退回第一个选项」，而 ACP 的
 * 选项顺序由服务端决定，第一个很可能是 reject。用户点了允许，工具却被
 * 拒了，日志里看不出来。现在找不到就返回 null，调用方回 cancelled。
 */
export function selectAcpOption(
  options: readonly PermissionOption[],
  decision: { behavior: 'allow' | 'deny'; optionId?: string }
): PermissionOption | null {
  if (decision.optionId) {
    const exact = options.find(o => o.id === decision.optionId);
    if (exact) return exact;
  }
  const want = decision.behavior;
  return options.find(o => behaviorOfKind(o.kind) === want) ?? null;
}

/** ACP 协议版本，实测 Hermes 接受 1 */
const PROTOCOL_VERSION = 1;
const INIT_TIMEOUT = 60_000;
/**
 * 单个 RPC 请求的默认超时：90 秒（产品默认值）。
 *
 * 为什么要短：实测事故里 hermes-acp 骑在用户常驻 gateway 上，session/new
 * 确定性挂起 —— 更长的默认会让「上百秒级无反馈卡顿」变成干等。90 秒让
 * 挂死变成可感知的快速失败；已有的超时自愈逻辑（杀树重建、重试一次）原样保留。
 *
 * 可用两种方式覆盖（闸门仍通过 options / `OPC_ACP_REQUEST_TIMEOUT_MS`
 * 注入 ~1.5s 测真超时路径，别让测试真等 90 秒）：
 *   1. 构造参数 `new AcpAdapter(def, { requestTimeoutMs: 1500 })`（优先）；
 *   2. 环境变量 `OPC_ACP_REQUEST_TIMEOUT_MS`（闸门 / 诊断用，不用改调用方）。
 * 非法值（非数字 / ≤0）一律回落默认 —— 配置错了不能把超时变成「永不超时」。
 */
const DEFAULT_REQUEST_TIMEOUT = 90 * 1000;
const REQUEST_TIMEOUT_ENV = 'OPC_ACP_REQUEST_TIMEOUT_MS';

/**
 * 超时自愈耗尽后的用户文案。
 *
 * 实测事故（3 次）：hermes-acp 骑在用户常驻的 Hermes gateway 上，gateway 在
 * session.create 路径确定性挂起（永不回复；默认 90 秒后超时）。适配器现在会在第一次超时后
 * 自动杀树重建并重试一次；第二次仍超时才报错 —— 文案必须短、可执行、不甩锅，
 * 并且诚实说明「已经自动重启过」，引导用户做唯一剩下的那步动作。
 */
const SESSION_TIMEOUT_EXHAUSTED_MESSAGE =
  'Hermes 会话无响应（其 gateway 可能已挂起）。已自动重启连接并重试仍失败——请重启 Hermes 桌面端后重试。';

export interface AcpAdapterOptions {
  /**
   * 单个 RPC 请求的超时毫秒数。缺省读环境变量 `OPC_ACP_REQUEST_TIMEOUT_MS`，
   * 再缺省 90 秒（产品默认值）。
   */
  requestTimeoutMs?: number;
  /** initialize 握手超时毫秒数。缺省 60s。 */
  initTimeoutMs?: number;
}

function resolveTimeoutMs(optionValue: number | undefined, fallback: number): number {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue > 0) {
    return optionValue;
  }
  const raw = process.env[REQUEST_TIMEOUT_ENV];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/**
 * 请求超时专用错误。自愈逻辑靠 `instanceof` 区分「超时」（可自愈）与
 * 「进程退出 / 协议错误」（走各自的既有路径），不能靠解析错误字符串。
 */
export class AcpRequestTimeoutError extends Error {
  constructor(method: string) {
    super(`ACP 请求超时：${method}`);
    this.name = 'AcpRequestTimeoutError';
  }
}

type Json = Record<string, unknown>;

/** 极简 JSON-RPC 2.0 stdio 客户端（换行分隔，非 LSP 的 Content-Length 分帧） */
class JsonRpcStdio {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buf = '';
  private closed = false;

  /** 服务端主动发来的请求（需要回包，如 session/request_permission） */
  onRequest: ((msg: Json) => void) | null = null;
  /** 服务端主动发来的通知（如 session/update） */
  onNotification: ((msg: Json) => void) | null = null;
  onClose: ((code: number | null) => void) | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.feed(chunk));
    child.on('close', code => {
      this.closed = true;
      const err = new Error(`ACP 进程已退出（code=${code}）`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.onClose?.(code);
    });
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        continue; // 非 JSON 行（个别库会把日志混进 stdout）
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json): void {
    // 响应包
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { message?: string; code?: number };
        p.reject(new Error(`ACP 错误 ${e.code ?? ''}: ${e.message ?? '未知'}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // 服务端 → 客户端的请求（有 id，需要回包）
    if (msg.method && msg.id !== undefined) {
      this.onRequest?.(msg);
      return;
    }
    // 通知（无 id）
    if (msg.method) this.onNotification?.(msg);
  }

  request(method: string, params: Json, timeoutMs = DEFAULT_REQUEST_TIMEOUT): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('ACP 进程未运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpRequestTimeoutError(method));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: unknown, result: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: unknown, code: number, message: string): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(obj: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* 进程已死，忽略 */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export class AcpAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;

  private readonly def: AgentDefinition;
  private target: LaunchTarget | null = null;
  private status: AgentStatus | null = null;

  /** 常驻 ACP 进程 */
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: JsonRpcStdio | null = null;
  private starting: Promise<JsonRpcStdio> | null = null;

  /** 本应用的会话 ID → ACP 的 sessionId */
  private acpSessions = new Map<string, string>();
  /** ACP sessionId → 当前正在消费的事件队列 */
  private streams = new Map<string, AsyncQueue<AgentEvent>>();
  /**
   * ACP sessionId → 该轮对话的场景工具白名单。
   *
   * 权限请求是**服务端主动发来**的（`session/request_permission`），
   * 那时手里只有 acpSessionId，拿不到当初的 SendContext，
   * 所以必须在这里按会话存一份，否则白名单在 ACP 上无从判断。
   */
  private allowlists = new Map<string, ScenarioTool[] | undefined>();
  /** 待答复的权限请求：requestId → { rpcId, acpSessionId, options } */
  private pendingPerms = new Map<
    string,
    { rpcId: unknown; options: PermissionOption[] }
  >();
  private agentInfo: { name?: string; version?: string } | null = null;
  /** session/new 返回的模型清单，供前端选择 */
  private models: Array<{ modelId: string; name: string; description?: string }> = [];

  /** 单个 RPC 请求的超时（可注入；默认 90 秒 = 产品默认值） */
  private readonly requestTimeoutMs: number;
  /** initialize 握手超时（可注入；默认 60s） */
  private readonly initTimeoutMs: number;
  /**
   * 超时自愈的重试预算：硬编码 1 —— 第一次超时杀树重建再试一次，
   * 第二次仍超时就把诚实文案交给用户。
   *
   * 为什么不做成配置项：这个数字一旦可调，「无限重试把用户拖死」就会
   * 回来（旧实现没有自愈，挂死进程让每次重试都拖满一个默认超时窗口，
   * 现产品默认 90 秒）。预算锁死在适配器内部，闸门反向探针会临时改它
   * 来验证预算行为。
   */
  private retryBudget = 1;

  constructor(def: AgentDefinition, options: AcpAdapterOptions = {}) {
    this.def = def;
    this.descriptor = def.descriptor;
    this.requestTimeoutMs = resolveTimeoutMs(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT);
    this.initTimeoutMs = resolveTimeoutMs(options.initTimeoutMs, INIT_TIMEOUT);
  }

  get availableModels() {
    return this.models;
  }

  // ============= 进程管理 =============

  private resolveBin(): string | null {
    return findExecutable(
      this.def.descriptor.command || 'hermes-acp',
      (this.def.extraPaths ?? []).map(expandPath)
    );
  }

  /** 启动 ACP 进程并完成 initialize（幂等；initialize 超时自愈：杀树重建后重试一次） */
  private ensureRpc(): Promise<JsonRpcStdio> {
    if (this.rpc && !this.rpc.isClosed) return Promise.resolve(this.rpc);
    if (this.starting) return this.starting;

    this.starting = this.startRpcWithRetry();

    // 失败后允许重试
    this.starting.catch(() => {
      this.starting = null;
      this.rpc = null;
    });

    return this.starting;
  }

  /**
   * 带自愈预算的启动：initialize 超时 → 杀树重建再试一次（预算 1）。
   *
   * 实测事故里 gateway 挂起同样会卡死 initialize（hermes-acp 起来后
   * 第一句握手就骑在 gateway 上），所以自愈必须覆盖这里，而不只是
   * session/new。第二次仍超时，报 SESSION_TIMEOUT_EXHAUSTED_MESSAGE。
   * 预算耗尽时的非超时错误（如进程秒退）原样上抛，走「进程退出」文案。
   */
  private async startRpcWithRetry(): Promise<JsonRpcStdio> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.startRpcOnce();
      } catch (err) {
        if (!(err instanceof AcpRequestTimeoutError)) throw err;
        if (attempt >= this.retryBudget) {
          throw attempt > 0
            ? new Error(SESSION_TIMEOUT_EXHAUSTED_MESSAGE)
            : err; // 预算为 0：没重建过，诚实报原始超时，不谎称「已重启」
        }
        console.error('[ACP] initialize 超时，自动重启连接并重试一次');
      }
    }
  }

  /** 单次「spawn + initialize」。失败时回收这次拉起的进程（超时挂死进程不回收 = 每次重试都再拖满超时）。 */
  private async startRpcOnce(): Promise<JsonRpcStdio> {
    const binPath = this.resolveBin();
    if (!binPath) throw new Error(`未找到 ${this.def.descriptor.command}`);

    this.target = resolveAnyLaunchTarget(binPath);
    if (isUnresolvedShim(this.target, binPath)) {
      throw new Error('无法解析 ACP 启动垫片（不退回 shell 执行）');
    }
    // A119：IDE 启动器守卫。ACP 是长连接，接错目标不会「报错」而是
    // 拉起一个 IDE 窗口然后 stdin 永远等不到 initialize 应答 ——
    // 表现成握手超时，比 CLI 那边更难定位。见 isIdeLauncher()。
    if (isIdeLauncher(this.target)) {
      throw new Error(
        `${binPath} 是 IDE 的命令行入口，不是 ACP agent（它会拉起 IDE 窗口而不是走 stdio 协议）`
      );
    }

    const child = spawn(this.target.command, this.target.prefixArgs, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    // stderr 是 Hermes 的日志通道，仅保留尾部用于报错。
    // 必须挂在 onClose 之前声明：onClose 的报错文案要引用它。
    let errTail = '';
    child.stderr?.on('data', (d: string) => {
      errTail += d;
      if (errTail.length > 4000) errTail = errTail.slice(-4000);
    });
    child.on('error', () => { /* 由 onClose 统一处理 */ });

    const rpc = new JsonRpcStdio(child);
    rpc.onNotification = msg => this.handleNotification(msg);
    rpc.onRequest = msg => this.handleServerRequest(msg);
    rpc.onClose = code => {
      // 只清理「还是当前连接」的进程：超时自愈会杀旧起新，旧进程的
      // close 事件迟到时绝不能把新连接打掉（否则重建被自己拆掉）。
      if (this.rpc !== rpc) return;
      this.rpc = null;
      this.child = null;
      this.starting = null;
      const tail = errTail.trim();
      // 进程死亡是异常结束，必须 fail 而不是 close：close 会把正在等的
      // 那轮当成「正常结束的空回复」（channel.ts 的 A108 注释）。
      // 退出码 + stderr 尾部一起给到，用户看到的不是静默空结束。
      const err = new Error(
        `ACP 进程已退出（code=${code}）${tail ? `：${tail.slice(-800)}` : ''}`
      );
      for (const [, q] of this.streams) q.fail(err);
      this.streams.clear();
      // 进程没了，会话映射与待答复的权限请求全部作废。
      // 留着它们，下次 send 会拿死 sessionId 去 prompt。
      this.acpSessions.clear();
      this.allowlists.clear();
      this.pendingPerms.clear();
    };

    try {
      const result = (await rpc.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'opc-agent', version: '0.1.0' },
        },
        this.initTimeoutMs
      )) as Json;

      this.agentInfo = (result.agentInfo as { name?: string; version?: string }) ?? null;
      this.rpc = rpc;
      return rpc;
    } catch (err) {
      // 握手失败：这次拉起的进程必须回收。旧实现只在 onClose 里清理，
      // 而「活着但挂死」的进程永远不会触发 onClose —— 于是它一直占着
      // this.child，下一次重试复用它，再拖满一个完整超时。
      this.rpc = null;
      this.child = null;
      killProcessTree(child.pid);
      throw err;
    }
  }

  /**
   * 超时自愈：杀整棵进程树 → 清空内部映射 → 重建连接。
   *
   * 「杀整棵树」用 taskkill /T（probe.ts 的 killProcessTree）：本机
   * hermes-acp 是 .EXE，它会再拉起 python 子进程 —— 只杀直接子进程会留
   * 下一棵挂死的进程树，继续占着 gateway 连接。
   *
   * 清空映射的口径与 dispose/onClose 一致：进程没了，acpSessions 里的
   * sessionId、正在消费的 streams、场景工具 allowlists、待答复的权限
   * 请求全部作废。留着它们，重建后 send 会拿死 sessionId 去 prompt。
   */
  private destroyConnection(): void {
    const child = this.child;
    this.rpc = null;
    this.child = null;
    this.starting = null;
    killProcessTree(child?.pid);
    // 其他会话还在这个进程上的在飞轮次：立刻告诉它们连接没了，
    // 而不是让它们各自等到自己的超时。
    for (const [, q] of this.streams) {
      q.fail(new Error('ACP 连接已重置（请求超时后自动重启进程），请重试'));
    }
    this.streams.clear();
    this.acpSessions.clear();
    this.allowlists.clear();
    this.pendingPerms.clear();
  }

  /** 超时后的自动重建：旧连接作废 + 全新进程 + 重新 initialize。 */
  private async recoverRpc(): Promise<JsonRpcStdio> {
    this.destroyConnection();
    return await this.ensureRpc();
  }

  // ============= 服务端消息处理 =============

  private handleNotification(msg: Json): void {
    if (msg.method !== 'session/update') return;
    const params = msg.params as { sessionId?: string; update?: Json } | undefined;
    const sessionId = params?.sessionId;
    const update = params?.update;
    if (!sessionId || !update) return;

    const queue = this.streams.get(sessionId);
    if (!queue) return;

    const ev = mapUpdate(update);
    if (Array.isArray(ev)) ev.forEach(item => queue.push(item));
    else if (ev) queue.push(ev);
  }

  private handleServerRequest(msg: Json): void {
    const params = (msg.params ?? {}) as Json;

    if (msg.method === 'session/request_permission') {
      const acpSessionId = params.sessionId as string | undefined;
      const queue = acpSessionId ? this.streams.get(acpSessionId) : undefined;
      const toolCall = (params.toolCall ?? {}) as Json;
      // P4：选项先归一化再使用。认不出的 kind 直接丢，不按 allow/deny 猜；
      // 归一化结果既用于回包选择，也原样发给前端渲染。
      const options = normalizePermissionOptions(params.options);

      // ---- P4-5 工具白名单：不满足就直接回 reject，不再打扰用户 ----
      //
      // 用 toolCall.kind（协议语义枚举）而不是 title（人话标题）来分类，
      // 见 toolPolicy.ts 的 ACP_KIND_CATEGORY。
      const title = String(toolCall.title ?? toolCall.kind ?? 'tool');
      const gate = decideAcpToolAccess(
        acpSessionId ? this.allowlists.get(acpSessionId) : undefined,
        toolCall.kind as string | undefined,
        title
      );
      if (!gate.allowed) {
        const reject = selectAcpOption(options, { behavior: 'deny' });
        console.log(
          `[ACP] 工具被场景白名单拦截: ${title} (kind=${String(toolCall.kind ?? '未提供')})`
        );
        this.rpc?.respond(
          msg.id,
          reject
            ? { outcome: { outcome: 'selected', optionId: reject.id } }
            : { outcome: { outcome: 'cancelled' } }
        );
        return;
      }

      // ---- 2026-11-12 持久授权（「该 Agent 永久」）----
      // 白名单之后、弹卡之前：命中即按协议的**正常 allow 应答路径**回选
      // allow 档，不向客户端发 permission_request；轨迹里留一条叙述可审计。
      // 授权只能省「问用户」，省不掉前面的白名单 —— 上面那道闸没被挪动。
      // 没有 allow 档可回选时照旧弹卡：授权存在但协议回不去，绝不假装放行。
      if (hasAgentGrant(this.descriptor.id, title)) {
        const autoAllow = selectAcpOption(options, { behavior: 'allow' });
        if (autoAllow) {
          console.log(`[ACP] 持久授权命中，自动放行: ${this.descriptor.id} · ${title}`);
          if (queue) {
            queue.push({
              type: 'note',
              text: `权限：已授权范围自动放行（${this.descriptor.id} · ${title}）`,
              level: 'info',
            });
          }
          this.rpc?.respond(
            msg.id,
            { outcome: { outcome: 'selected', optionId: autoAllow.id } }
          );
          return;
        }
      }

      const requestId = randomUUID();
      this.pendingPerms.set(requestId, { rpcId: msg.id, options });

      if (queue) {
        queue.push({
          type: 'permission_request',
          requestId,
          toolUseId: toolCall.toolCallId as string | undefined,
          toolName: String(toolCall.title ?? toolCall.kind ?? 'tool'),
          input: (toolCall.rawInput ?? {}) as Record<string, unknown>,
          // 服务端一个选项都没给时保持缺省，UI 退回两按钮兜底
          ...(options.length ? { options } : {}),
        });
      } else {
        // 没有消费者就直接拒绝，避免 ACP 侧永久挂起
        this.rpc?.respond(msg.id, { outcome: { outcome: 'cancelled' } });
        this.pendingPerms.delete(requestId);
      }
      return;
    }

    // 我们声明了 fs / terminal 能力为 false，理论上不该收到这些请求；
    // 收到就明确回错，而不是静默挂起。
    if (msg.method === 'fs/read_text_file' || msg.method === 'fs/write_text_file') {
      this.rpc?.respondError(msg.id, -32601, '本客户端未启用文件系统能力');
      return;
    }
    if (msg.method === 'terminal/create' || String(msg.method).startsWith('terminal/')) {
      this.rpc?.respondError(msg.id, -32601, '本客户端未启用终端能力');
      return;
    }

    this.rpc?.respondError(msg.id, -32601, `未实现的方法：${msg.method}`);
  }

  // ============= 探测 =============

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();
    const binPath = this.resolveBin();

    if (!binPath) {
      this.status = {
        availability: 'not-installed',
        installed: false,
        message: `未找到 \`${this.def.descriptor.command}\`。怎么恢复：${
          this.def.descriptor.installHint ?? recoveryHintFor(this.descriptor.id)
        }`,
        probedAt: now,
      };
      return this.status;
    }

    // 真正跑一次 initialize —— 这是唯一能确证「ACP 进程可用」的方式。
    // 但 initialize 只证明「进程会说话」，它不验证凭据、也不验证
    // session/new 能不能建出会话 —— 实测事故里 gateway 挂死时 initialize
    // 一样能过，于是 probe 报「在线」而第一次发消息挂满默认 90 秒超时。
    // 为什么不在这里真跑一次 session/new 验证：会真的建出 ACP 会话
    // （泄漏），而 probe 只该问「活着吗」。所以把能力边界写进文案。
    try {
      await this.ensureRpc();
      this.status = {
        availability: 'ready',
        installed: true,
        binaryPath: binPath,
        version: this.agentInfo?.version,
        message: this.agentInfo?.version
          ? `ACP 握手成功（凭据未校验；会话创建未验证）：${this.agentInfo.name ?? 'agent'} v${this.agentInfo.version}`
          : 'ACP 握手成功（凭据未校验；会话创建未验证）',
        probedAt: now,
      };
    } catch (err) {
      this.status = {
        availability: 'needs-setup',
        installed: true,
        binaryPath: binPath,
        message: appendFailureAdvice(
          this.descriptor.id,
          `ACP 握手失败：${(err as Error).message}`
        ),
        probedAt: now,
      };
    }
    return this.status;
  }

  // ============= 调用 =============

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    const started = Date.now();

    let rpc: JsonRpcStdio;
    try {
      rpc = await this.ensureRpc();
    } catch (err) {
      yield { type: 'error', message: `无法连接 ACP Agent：${(err as Error).message}` };
      return;
    }

    // 取得（或新建）ACP 会话
    let acpSessionId = this.acpSessions.get(ctx.sessionId);
    const cwd = ctx.cwd || process.cwd();

    if (!acpSessionId) {
      // A176：ACP 的 stdio MCP 配置（env 必须是 [{name,value}] 数组）。
      // 会话 id 随进程环境注入，工具侧不接受调用方传 sessionId。
      const kbSpec = kbMcpServerSpec(ctx.sessionId, this.descriptor.id);
      const mcpServers = [
        {
          name: KB_MCP_SERVER_NAME,
          command: kbSpec.command,
          args: kbSpec.args,
          env: Object.entries(kbSpec.env).map(([name, value]) => ({ name, value })),
        },
      ];

      // 超时自愈循环：第一次超时 → 杀整棵进程树 + 清映射 + 重建连接，再试一次
      //（预算 retryBudget=1，防死循环）。第二次仍超时才把诚实文案交给用户，
      // 并把这次重建出来、确认挂死的进程也收掉 —— 不留挂死进程给下次重试复用。
      // 旧实现超时只是 reject：挂死进程原样留着，下一次重试复用它再拖满
      // 一个默认超时窗口（现产品默认 90 秒）—— 用户干等一轮超时才得到
      // 一句死板报错，而且越试越糟。
      for (let attempt = 0; ; attempt++) {
        try {
          const res = (await rpc.request('session/new', { cwd, mcpServers }, this.requestTimeoutMs)) as Json;
          acpSessionId = res.sessionId as string;
          this.acpSessions.set(ctx.sessionId, acpSessionId);

          const available = (res.models as { availableModels?: unknown })?.availableModels;
          if (Array.isArray(available)) {
            this.models = available as Array<{ modelId: string; name: string; description?: string }>;
          }
          break;
        } catch (err) {
          const timeout = err instanceof AcpRequestTimeoutError;
          if (timeout && attempt < this.retryBudget) {
            console.error('[ACP] session/new 超时，自动重启连接（杀进程树）并重试一次');
            try {
              rpc = await this.recoverRpc();
            } catch (recoverErr) {
              yield {
                type: 'error',
                message: `无法连接 ACP Agent：${(recoverErr as Error).message}`,
              };
              return;
            }
            continue;
          }
          if (timeout && attempt > 0) {
            // 重试过的那次进程同样挂死：它上面不可能有别的会话（重建时
            // 映射已清空），收掉它，别把挂死状态留给下一次 send。
            this.destroyConnection();
            yield { type: 'error', message: SESSION_TIMEOUT_EXHAUSTED_MESSAGE };
            return;
          }
          yield {
            type: 'error',
            message: `创建 ACP 会话失败：${(err as Error).message}`,
          };
          return;
        }
      }
    }

    yield {
      type: 'init',
      sessionId: ctx.sessionId,
      model: ctx.model,
      resumeToken: acpSessionId,
      source: 'native',
    };

    const queue = new AsyncQueue<AgentEvent>();
    this.streams.set(acpSessionId, queue);
    this.allowlists.set(acpSessionId, ctx.allowedTools);

    const acpSession = acpSessionId;
    // ACP 的中止方式是发 session/cancel 通知（linkAbort 会处理「信号已中止」）
    const unlinkAbort = linkAbort(ctx.signal, () => {
      rpc.notify('session/cancel', { sessionId: acpSession });
      queue.close();
    });

    // prompt 的返回是「整轮结束」，流式内容走 session/update 通知
    rpc
      .request(
        'session/prompt',
        {
          sessionId: acpSessionId,
          prompt: [{ type: 'text', text: buildPrompt(ctx) }],
        },
        this.requestTimeoutMs
      )
      .then(res => {
        const usage = (res as Json)?.usage as Json | undefined;
        queue.push({
          type: 'done',
          durationMs: Date.now() - started,
          // ACP 只给 token 数，不给钱 —— 放进 tokens，别塞进 cost
          tokens: typeof usage?.totalTokens === 'number' ? (usage.totalTokens as number) : undefined,
        });
        queue.close();
      })
      .catch(err => {
        queue.push({ type: 'error', message: (err as Error).message });
        queue.push({ type: 'done', durationMs: Date.now() - started });
        queue.close();
      });

    try {
      for await (const ev of queue) yield ev;
    } finally {
      unlinkAbort();
      this.streams.delete(acpSessionId);
      this.allowlists.delete(acpSessionId);
    }
  }

  abort(sessionId: string): void {
    const acpSessionId = this.acpSessions.get(sessionId);
    if (acpSessionId && this.rpc) {
      this.rpc.notify('session/cancel', { sessionId: acpSessionId });
      this.streams.get(acpSessionId)?.close();
    }
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPerms.get(requestId);
    if (!pending || !this.rpc) return false;
    this.pendingPerms.delete(requestId);

    // 按 id 精确回选；没带 id 就按行为找第一档；找不到一律 cancelled。
    // 绝不能「退回第一个选项」—— 服务端给的顺序里第一个可能是 reject。
    const picked = selectAcpOption(pending.options, decision);
    this.rpc.respond(
      pending.rpcId,
      picked
        ? { outcome: { outcome: 'selected', optionId: picked.id } }
        : { outcome: { outcome: 'cancelled' } }
    );
    return true;
  }

  /** 进程退出时清理，供 registry 在服务关闭时调用 */
  dispose(): void {
    const rpc = this.rpc;
    if (rpc && !rpc.isClosed) rpc.notify('session/cancel', {});
    // 复用自愈的清理口：taskkill /T 杀整棵树（hermes-acp 的 python 子进程
    // 一并回收，不留残留），映射清空口径与自愈 / onClose 一致。
    this.destroyConnection();
  }
}

// ============= 协议 → 统一事件 映射 =============

/**
 * 把 ACP 的 session/update 映射成统一事件；返回 null 表示无需呈现
 *（空 chunk 这类「确实没内容」的情况，与「不认识」是两件事）。
 *
 * 导出是为了能直接断言「未知 update 走 raw 而不是被丢掉」（scripts/verify-a111）。
 */
export function mapUpdate(update: Json): AgentEvent | AgentEvent[] | null {
  const kind = update.sessionUpdate as string | undefined;

  switch (kind) {
    case 'agent_message_chunk': {
      const text = extractText(update.content);
      return text ? { type: 'text', content: text } : null;
    }
    case 'agent_thought_chunk': {
      const text = extractText(update.content);
      return text ? { type: 'thinking', content: text } : null;
    }
    case 'tool_call': {
      return {
        type: 'tool',
        id: String(update.toolCallId ?? randomUUID()),
        name: String(update.title ?? update.kind ?? 'tool'),
        input: (update.rawInput ?? {}) as Record<string, unknown>,
      };
    }
    case 'tool_call_update': {
      const status = String(update.status ?? '');
      if (status !== 'completed' && status !== 'failed') return null;
      const events: AgentEvent[] = [{
        type: 'tool_result',
        toolId: String(update.toolCallId ?? ''),
        content: stringifyToolOutput(update),
        isError: status === 'failed',
      }];
      if (status === 'completed' && Array.isArray(update.content)) {
        for (const [index, item] of update.content.entries()) {
          if (!item || typeof item !== 'object') continue;
          const content = item as Json;
          if (content.type === 'resource_link' && typeof content.uri === 'string') {
            events.push({
              type: 'artifact',
              id: `acp-resource-${String(update.toolCallId ?? 'tool')}-${index}`,
              name: String(content.name ?? `资源 ${index + 1}`),
              mediaType: String(content.mimeType ?? 'application/octet-stream'),
              uri: content.uri,
              ...(typeof content.description === 'string' ? { description: content.description } : {}),
            });
          }
          if (content.type === 'image' && typeof content.data === 'string') {
            const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'image/png';
            events.push({
              type: 'artifact',
              id: `acp-image-${String(update.toolCallId ?? 'tool')}-${index}`,
              name: `图像产物 ${index + 1}`,
              mediaType: mimeType,
              data: { encoding: 'base64', content: content.data },
              description: '由 ACP 工具结果返回的图像数据',
            });
          }
        }
      }
      return events;
    }
    // A111：这里以前是 `return null`，注释写着「usage_update / availableCommands /
    // plan / current_mode_update 等暂不呈现」—— 「暂不呈现」在实现上就是**丢掉**，
    // 而丢掉的恰恰是 ACP 的原生能力：
    //   plan                → agent 自己的任务清单
    //   availableCommands   → 斜杠命令表
    //   current_mode_update → 权限模式变化
    //   usage_update        → 上下文用量
    // 现在全部走 raw 旁路，UI 折叠展示，一条都不丢。
    //
    // 为什么**不**顺手把 usage_update 映射成 `usage`：ACP 报的是「上下文占用」，
    // 本项目的 `usage.tokens` 语义是「本轮消耗」，两者混在一起会让成本统计变成
    // 假数据 —— types.ts 里记过同一个坑（ACP 曾把 token 数塞进 cost，于是
    // 12000 个 token 显示成 $12000）。语义没对齐就不硬映射，先原样留着。
    default:
      return {
        type: 'raw',
        channel: `acp:${kind || 'unknown'}`,
        payload: update,
      };
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => extractText(c))
      .filter(Boolean)
      .join('');
  }
  if (content && typeof content === 'object') {
    const c = content as Json;
    if (c.type === 'text' && typeof c.text === 'string') return c.text;
    if (c.type === 'resource_link') return `[${c.name ?? c.uri ?? 'link'}]`;
  }
  return '';
}

function stringifyToolOutput(update: Json): string {
  const out = update.rawOutput ?? update.content;
  if (out === undefined || out === null) return '已完成';
  if (typeof out === 'string') return out;
  const text = extractText(out);
  return text || JSON.stringify(out).slice(0, 4000);
}

/** ACP 没有独立的 system prompt 概念，需要时并入用户消息 */
function buildPrompt(ctx: SendContext): string {
  // A209：ACP 同样没有系统提示参数，回答语言并入「提示段」末尾；
  // 自动档下 withAnswerLanguage 原样返回 ctx.systemPrompt（含 undefined）。
  const system = withAnswerLanguage(ctx.systemPrompt, ctx.answerLanguage);
  return system
    ? `${system}\n\n${ctx.prompt}`
    : ctx.prompt;
}
