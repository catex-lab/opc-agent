/**
 * HTTP 适配器：把「只有 HTTP API、没有 CLI」的模型接进来。
 *
 * ## 它解决什么问题
 *
 * 豆包、Kimi 这类 Agent 没有无头 CLI，但都有官方 HTTP API。没有这个适配器，
 * 它们只能待在 mock 里显示「本机未安装」—— 而实际情况是**装也没用**，
 * 因为它们从来不发布 CLI。这条路径填的是那个空。
 *
 * ## 三个必须说清的边界
 *
 * 1. **没有工具调用循环**。这是纯 chat completion，不实现 function calling。
 *    所以走这条路的 Agent 只能标 `chat` / `write` 能力，**不能**标 `code` /
 *    `tools` —— 标了就是谎称能读写文件、能跑命令。
 *
 * 2. **人设完全由我们给**。`systemPrompt` 由调用方传入（或留空即模型的
 *    公共助手人格）。这与 CLI 类「用人家原生人格」是两条路，UI 上必须
 *    区分开：这类 Agent 叫「模型直连」而不是「Agent」。
 *
 * 3. **上下文不自动续接**。和 CLI 类一样，服务器不拼历史消息；但这里连
 *    resume token 都没有 —— 每次调用都是独立的一问一答。要让多轮生效，
 *    必须由上层把历史塞进 messages（本轮不做）。
 *
 * ## 为什么不用 fetch
 *
 * Node 内置 fetch（undici）**不读** HTTP_PROXY / HTTPS_PROXY 环境变量，
 * 必须显式配 EnvHttpProxyAgent。而这个项目的探测链路（probe.ts）是走代理的，
 * 若调用链路直连，就会出现「探测说通、真调用不通」的反常偏差
 * （agent Reminders 里明确记着这个坑）。所以这里用 node:https 手写，
 * 有代理就自己建 CONNECT 隧道，保证探测与调用走**同一条路**。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { AsyncQueue, linkAbort } from '../channel.js';
import type { AgentDefinition, HttpSpec } from '../definitions.js';
import { withMemoryContext } from '../../memory.js';
import { checkHostReachable } from '../probe.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentStatus,
  AgentDescriptor,
  SendContext,
} from '../types.js';

/** 整体超时。HTTP 调用没有「无限重连」的毛病，但不设上限仍可能挂住请求。 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** 取协议；url 畸形时返回空串而不是抛异常（探测不能因为配置写错而崩） */
function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/** 读环境代理，规则与 probe.ts 的 proxyUrl 完全一致（否则两条链路会分叉） */
function proxyUrl(): URL | null {
  const raw =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * 经代理建立到目标的 TLS 连接（CONNECT 隧道 + TLS 握手）。
 *
 * 复用 probe.ts `reachViaProxy` 的相同做法：先 CONNECT 拿裸 socket，
 * 再在上面包 TLS。返回可直接交给 https.request 的 TLSSocket。
 */
function tunneledTls(
  proxy: URL,
  host: string,
  port: number,
  timeoutMs: number
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理服务器拒绝连接（${res.statusCode}）`));
        return;
      }
      const tlsSock = tls.connect({ socket, servername: host });
      tlsSock.once('secureConnect', () => resolve(tlsSock));
      tlsSock.once('error', reject);
    });
    req.once('timeout', () => {
      req.destroy();
      reject(new Error('代理连接超时'));
    });
    req.once('error', reject);
    req.end();
  });
}

/** SSE 事件处理器：吃进一段已解码的 data 载荷， yield 出统一事件 */
type SseHandler = (payload: unknown, emit: (ev: AgentEvent) => void) => void;

/** 把 OpenAI 风格的 choices[].delta.content 抽出来 */
function openaiSse(payload: unknown, emit: (ev: AgentEvent) => void): void {
  const o = payload as {
    choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
    error?: { message?: string };
  };
  if (o.error) {
    emit({ type: 'error', message: o.error.message || '模型返回错误' });
    return;
  }
  const content = o.choices?.[0]?.delta?.content;
  if (typeof content === 'string' && content) emit({ type: 'text', content });
}

/** Anthropic 的 event/data 两行式：只顺着 data 行解析，type 字段在 data 里 */
function anthropicSse(payload: unknown, emit: (ev: AgentEvent) => void): void {
  const o = payload as {
    type?: string;
    delta?: { type?: string; text?: string };
    usage?: { output_tokens?: number };
    error?: { message?: string };
  };
  if (o.type === 'error') {
    emit({ type: 'error', message: o.error?.message || '模型返回错误' });
    return;
  }
  if (o.type === 'content_block_delta' && o.delta?.type === 'text_delta' && o.delta.text) {
    emit({ type: 'text', content: o.delta.text });
  }
}

/** Gemini：candidates[].content.parts[].text；出错时顶层是 error */
function geminiSse(payload: unknown, emit: (ev: AgentEvent) => void): void {
  const o = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string; status?: string };
  };
  if (o.error) {
    emit({ type: 'error', message: o.error.message || o.error.status || '模型返回错误' });
    return;
  }
  const text = (o.candidates?.[0]?.content?.parts ?? [])
    .map(p => p.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('');
  if (text) emit({ type: 'text', content: text });
}

export class HttpAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;

  private readonly def: AgentDefinition;
  private readonly spec: HttpSpec;
  private status: AgentStatus | null = null;
  /** 进行中的请求：sessionId → req（abort 时 destroy） */
  private running = new Map<string, http.ClientRequest>();

  constructor(def: AgentDefinition) {
    if (!def.http) throw new Error(`HttpAdapter 需要 http 规格: ${def.descriptor.id}`);
    this.def = def;
    this.descriptor = def.descriptor;
    this.spec = def.http;
  }

  // ============= 探测 =============

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();

    if (this.def.unsupportedReason) {
      this.status = {
        availability: 'unsupported',
        installed: false,
        message: this.def.unsupportedReason,
        probedAt: now,
      };
      return this.status;
    }

    // 密钥只从环境变量取。不落盘、不进 db —— 一个要用户到处粘贴的密钥
    // 一旦写进本地数据库，泄露面就从「环境变量」扩大到「整个应用数据」。
    //
    // A30：设置页填的 Key 由 server/agent-credentials.ts 注入 process.env，
    // 所以这里读到的仍然是「环境变量」—— 适配器不需要知道它从哪来。
    const keyEnv = this.def.authEnvs?.find(n => (process.env[n] ?? '').trim().length > 0);
    if (!keyEnv) {
      const how = this.def.credential
        ? `请在「设置 → 登录配置 → Agent API Key」填入 ${this.def.credential.keyEnv.join(' 或 ')}（也支持环境变量）`
        : `请设置环境变量 ${this.def.authEnvs?.join(' 或 ') ?? '(未声明)'}，然后重启应用`;
      this.status = {
        availability: 'needs-auth',
        installed: false,
        message: `未配置 API Key：${how}`,
        probedAt: now,
      };
      return this.status;
    }

    // 后端可达性。**只对 https 目标做**，且必须是 send 真正会走的那条链路：
    // send 里「有代理」只在 `protocol === 'https:'` 时才建隧道（http 走直连），
    // 所以对 http 目标做带代理的可达性检查，就会出现代理不可用时
    // 「探测说不通、调用却通」的反常偏差 —— 这正是 probe.ts 明令避免的。
    // 顺带也避开了「代理 CONNECT 到 127.0.0.1」这种没有意义的检查。
    const protocol = safeProtocol(this.spec.url);
    const host = this.spec.host;
    if (host && protocol === 'https:') {
      const ok = await checkHostReachable(host);
      if (!ok) {
        this.status = {
          availability: 'unreachable',
          installed: true,
          message: `后端网络不可达：${host}（本机与代理均连不上）。该模型无法调用，请检查网络或代理设置。`,
          probedAt: now,
        };
        return this.status;
      }
    }

    this.status = {
      availability: 'ready',
      installed: true,
      message: `已配置密钥（环境变量 ${keyEnv}）`,
      probedAt: now,
    };
    return this.status;
  }

  // ============= 调用 =============

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    if (!this.status) await this.probe();

    const keyName = this.def.authEnvs?.find(n => (process.env[n] ?? '').trim().length > 0);
    if (!keyName) {
      yield { type: 'error', message: this.status?.message || '未配置 API Key' };
      return;
    }
    const key = process.env[keyName]!.trim();

    yield { type: 'init', sessionId: ctx.sessionId, model: ctx.model ?? this.spec.defaultModel };

    const queue = new AsyncQueue<AgentEvent>();
    const started = Date.now();
    const timeoutMs = this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const emit = (ev: AgentEvent) => queue.push(ev);
    const handler: SseHandler =
      this.spec.dialect === 'openai'
        ? openaiSse
        : this.spec.dialect === 'anthropic'
          ? anthropicSse
          : geminiSse;

    let killed = false;
    // 用 holder 而不是裸 let：TS 的控制流分析收窄不到「只在 try 里赋值」
    // 的变量，在 finally 里会把它当作 never，于是 `unlinkAbort?.()` 编译不过。
    const abortLink: { off: (() => void) | null } = { off: null };
    let errDetail = '';

    const finish = (errMessage?: string) => {
      if (errMessage) {
        errDetail = errMessage;
        emit({ type: 'error', message: errMessage });
      }
      emit({ type: 'done', durationMs: Date.now() - started });
      queue.close();
    };

    // 请求在后台跑，结果通过 finish() 汇入 queue；主协程只负责把 queue
    // 逐条 yield 出去。**不要写成 `await new Promise(...)` 再 yield** ——
    // 那样所有事件都会堆在 queue 里没人消费，前端只看到 init 就结束了
    // （verify-agent-access 第一次跑就是这么挂的）。
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
        const parsed = new URL(this.spec.url);
        const isHttps = parsed.protocol === 'https:';
        const port = Number(parsed.port) || (isHttps ? 443 : 80);

        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          // User-Agent 按Node的默认，不伪装成浏览器（也没必要）
        };
        let body: Record<string, unknown> = {};
        // A38：模型直连这条路的系统提示**完全由我们给**（见文件头边界说明），
        // 所以它是记忆层最自然的注入点。CLI/ACP 类的提示词在人家 harness 里，
        // 塞不进去也不该塞。
        const systemPrompt = withMemoryContext(ctx.systemPrompt);

        if (this.spec.dialect === 'openai') {
          headers.authorization = `Bearer ${key}`;
          const messages: Array<{ role: string; content: string }> = [
            { role: 'user', content: ctx.prompt },
          ];
          if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt });
          body = {
            model: ctx.model ?? this.spec.defaultModel,
            messages,
            stream: true,
          };
          if (this.spec.temperature !== undefined) body.temperature = this.spec.temperature;
        } else if (this.spec.dialect === 'anthropic') {
          headers['x-api-key'] = key;
          headers['anthropic-version'] = '2023-06-01';
          body = {
            model: ctx.model ?? this.spec.defaultModel,
            max_tokens: this.spec.maxTokens ?? 8192,
            messages: [{ role: 'user', content: ctx.prompt }],
            stream: true,
          };
          if (systemPrompt) body.system = systemPrompt;
        } else {
          headers['x-goog-api-key'] = key;
          body = { contents: [{ role: 'user', parts: [{ text: ctx.prompt }] }] };
          if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
        }

        const payload = JSON.stringify(body);
        headers['content-length'] = String(Buffer.byteLength(payload));

        const proxy = proxyUrl();
        const requestOnce = (useTunnel: boolean) => {
          const opts: https.RequestOptions & { createConnection?: unknown } = {
            hostname: parsed.hostname,
            port,
            path: `${parsed.pathname}${parsed.search}`,
            method: 'POST',
            headers,
          };
          let agent: https.Agent | http.Agent;
          if (useTunnel && proxy && isHttps) {
            agent = new https.Agent({ keepAlive: false });
            (agent as unknown as { createConnection: (o: unknown, cb: (e: Error | null, s?: tls.TLSSocket) => void) => void }).createConnection =
              (_options, cb) => {
                tunneledTls(proxy, parsed.hostname, port, Math.min(timeoutMs, 15000))
                  .then(sock => cb(null, sock))
                  .catch(err => cb(err as Error));
              };
          } else {
            agent = isHttps ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
          }
          (opts as { agent: http.Agent | https.Agent }).agent = agent;

          const transport = isHttps ? https : http;
          const req = transport.request(opts, res => {
            const code = res.statusCode ?? 0;
            if (code < 200 || code >= 300) {
              // 非 2xx：读完整 body 当错误信息。各家把真正的理由放在 body 里
              // （限流、模型名写错、key 无效……），只看状态码等于浪费一次排查。
              let buf = '';
              res.setEncoding('utf8');
              res.on('data', c => (buf += c));
              res.on('end', () => {
                if (code === 401 || code === 403) {
                  this.status = {
                    ...(this.status as AgentStatus),
                    availability: 'needs-auth',
                    lastError: buf.slice(0, 400),
                  };
                }
                reject(new Error(`HTTP ${code}：${buf.slice(0, 400) || res.statusMessage}`));
              });
              return;
            }

            const onLine = (line: string) => {
              const s = line.trim();
              if (!s.startsWith('data:')) return;
              const data = s.slice(5).trim();
              if (!data || data === '[DONE]') return;
              try {
                handler(JSON.parse(data), emit);
              } catch {
                // 单行解析失败不该中断整条流：SSE 里常见心跳/注释行
              }
            };

            res.setEncoding('utf8');
            let lineBuf = '';
            res.on('data', chunk => {
              lineBuf += chunk;
              const lines = lineBuf.split(/\r?\n/);
              lineBuf = lines.pop() ?? '';
              for (const l of lines) onLine(l);
            });
            res.on('end', () => {
              if (lineBuf.trim()) onLine(lineBuf);
              resolve();
            });
            res.on('error', reject);
          });

          const timer = setTimeout(() => {
            killed = true;
            req.destroy(new Error('请求超时'));
          }, timeoutMs);
          timer.unref?.();

          req.on('error', (err: Error) => reject(err));
          this.running.set(ctx.sessionId, req);
          req.end(payload);
        };

        // 有代理就先走隧道；隧道本身失败（代理挂了）时退回直连一次，
        // 避免「代理不可用」被误判成「模型不可用」。
        if (proxy && isHttps) {
          requestOnce(true);
        } else {
          requestOnce(false);
        }

        // 中止信号。**必须在 Promise 之外注册、在主协程的 finally 里注销**：
        // 写在 new Promise 的执行体里的话，promise 完成后就没机会再调用它，
        // abort signal 上的 listener 会随每次对话泄漏一个。
        abortLink.off = linkAbort(ctx.signal, () => {
          killed = true;
          const req = this.running.get(ctx.sessionId);
          req?.destroy(new Error('已取消'));
        });
        });
        // 正常走完（没有异常）也要 finish()：它负责 emit done 并 close queue。
        // 少了这一句，stream-json 全收完了但队列永不关闭，前端会一直等。
        // （重构时漏过一次，症状是"只有 init、然后永久挂住"。）
        finish();
      } catch (err) {
        const msg = (err as Error).message || String(err);
        // 主动取消不当作错误播报：调用方已经走了，没人听
        if (killed && /已取消/.test(msg)) {
          queue.close();
          return;
        }
        this.status = this.status
          ? { ...this.status, lastError: msg.slice(0, 400) }
          : this.status;
        finish(msg);
      }
    })().catch((err: Error) => {
      // 兜底：后台协程的异常绝不能变成 unhandled rejection
      finish(err?.message || '请求失败');
    });
    try {
      for await (const ev of queue) yield ev;
    } finally {
      abortLink.off?.();
      this.running.delete(ctx.sessionId);
    }
  }

  abort(sessionId: string): void {
    const req = this.running.get(sessionId);
    if (req && !req.destroyed) {
      req.destroy(new Error('已取消'));
      this.running.delete(sessionId);
    }
  }
}
