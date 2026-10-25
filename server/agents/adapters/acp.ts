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
  type LaunchTarget,
} from '../probe.js';
import type { AgentDefinition } from '../definitions.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
  PermissionDecision,
  SendContext,
} from '../types.js';
import { decideAcpToolAccess } from '../toolPolicy.js';
import type { ScenarioTool } from '../../../shared/scenarios.js';

/** ACP 协议版本，实测 Hermes 接受 1 */
const PROTOCOL_VERSION = 1;
const INIT_TIMEOUT = 60_000;
const REQUEST_TIMEOUT = 10 * 60 * 1000;

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

  request(method: string, params: Json, timeoutMs = REQUEST_TIMEOUT): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('ACP 进程未运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 请求超时：${method}`));
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
    { rpcId: unknown; options: Array<{ optionId: string; kind?: string }> }
  >();
  private agentInfo: { name?: string; version?: string } | null = null;
  /** session/new 返回的模型清单，供前端选择 */
  private models: Array<{ modelId: string; name: string; description?: string }> = [];

  constructor(def: AgentDefinition) {
    this.def = def;
    this.descriptor = def.descriptor;
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

  /** 启动 ACP 进程并完成 initialize（幂等） */
  private ensureRpc(): Promise<JsonRpcStdio> {
    if (this.rpc && !this.rpc.isClosed) return Promise.resolve(this.rpc);
    if (this.starting) return this.starting;

    this.starting = (async () => {
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

      const rpc = new JsonRpcStdio(child);
      rpc.onNotification = msg => this.handleNotification(msg);
      rpc.onRequest = msg => this.handleServerRequest(msg);
      rpc.onClose = () => {
        this.rpc = null;
        this.child = null;
        this.starting = null;
        for (const [, q] of this.streams) q.close();
        this.streams.clear();
      };

      // stderr 是 Hermes 的日志通道，仅保留尾部用于报错
      let errTail = '';
      child.stderr?.on('data', (d: string) => {
        errTail += d;
        if (errTail.length > 4000) errTail = errTail.slice(-4000);
      });
      child.on('error', () => { /* 由 onClose 统一处理 */ });

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
        INIT_TIMEOUT
      )) as Json;

      this.agentInfo = (result.agentInfo as { name?: string; version?: string }) ?? null;
      this.rpc = rpc;
      return rpc;
    })();

    // 失败后允许重试
    this.starting.catch(() => {
      this.starting = null;
      this.rpc = null;
    });

    return this.starting;
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
      const options = (params.options ?? []) as Array<{ optionId: string; kind?: string; name?: string }>;

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
        const reject =
          options.find(o => /reject|deny/i.test(o.kind ?? '')) ??
          options.find(o => /reject|deny|no/i.test(o.optionId));
        console.log(
          `[ACP] 工具被场景白名单拦截: ${title} (kind=${String(toolCall.kind ?? '未提供')})`
        );
        this.rpc?.respond(
          msg.id,
          reject
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } }
        );
        return;
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
        message: `未找到 \`${this.def.descriptor.command}\``,
        probedAt: now,
      };
      return this.status;
    }

    // 真正跑一次 initialize —— 这是唯一能确证「ACP 可用」的方式
    try {
      await this.ensureRpc();
      this.status = {
        availability: 'ready',
        installed: true,
        binaryPath: binPath,
        version: this.agentInfo?.version,
        message: this.agentInfo?.version
          ? `ACP 握手成功：${this.agentInfo.name ?? 'agent'} v${this.agentInfo.version}`
          : 'ACP 握手成功',
        probedAt: now,
      };
    } catch (err) {
      this.status = {
        availability: 'needs-setup',
        installed: true,
        binaryPath: binPath,
        message: `ACP 握手失败：${(err as Error).message}`,
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
      try {
        const res = (await rpc.request('session/new', { cwd, mcpServers: [] })) as Json;
        acpSessionId = res.sessionId as string;
        this.acpSessions.set(ctx.sessionId, acpSessionId);

        const available = (res.models as { availableModels?: unknown })?.availableModels;
        if (Array.isArray(available)) {
          this.models = available as Array<{ modelId: string; name: string; description?: string }>;
        }
      } catch (err) {
        yield { type: 'error', message: `创建 ACP 会话失败：${(err as Error).message}` };
        return;
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
      .request('session/prompt', {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: buildPrompt(ctx) }],
      })
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

    if (decision.behavior === 'allow') {
      // 优先选 allow 类选项；找不到就退回第一个选项
      const allow =
        pending.options.find(o => /allow/i.test(o.kind ?? '')) ??
        pending.options.find(o => /allow|yes|approve/i.test(o.optionId)) ??
        pending.options[0];
      if (!allow) {
        this.rpc.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } });
        return true;
      }
      this.rpc.respond(pending.rpcId, {
        outcome: { outcome: 'selected', optionId: allow.optionId },
      });
    } else {
      const reject =
        pending.options.find(o => /reject|deny/i.test(o.kind ?? '')) ??
        pending.options.find(o => /reject|deny|no/i.test(o.optionId));
      this.rpc.respond(
        pending.rpcId,
        reject
          ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      );
    }
    return true;
  }

  /** 进程退出时清理，供 registry 在服务关闭时调用 */
  dispose(): void {
    this.rpc?.notify('session/cancel', {});
    this.child?.kill();
    this.rpc = null;
    this.child = null;
    this.starting = null;
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
  return ctx.systemPrompt
    ? `${ctx.systemPrompt}\n\n${ctx.prompt}`
    : ctx.prompt;
}
