/**
 * 自建模型厂商的连通性测试与模型清单拉取（A129）。
 *
 * ## 为什么必须有这两步
 *
 * 用户报的那个 404（`model route not found`）不是代码 bug：地址通、Key 通，
 * 只是他把模型名写成了 `sensenova-6.8-flash`，而该网关实际叫
 * `sensenova-6.8-flash-lite`。创建时不校验，用户唯一的反馈渠道就是第一次
 * 对话报错 —— 而报错里全是上游 JSON，看不出该改哪里。
 *
 * 所以这里做两件事，且在**保存之前**就能跑：
 *   1. `listProviderModels()`  GET /models —— 把可用模型列出来让用户勾选
 *   2. `testProvider()`        一次最小对话 —— 真正确认「这个模型能应答」
 *
 * ## 为什么不用 fetch
 *
 * 与适配器同因：Node 的 undici 不读 HTTP(S)_PROXY。测试必须走**和真实调用
 * 同一条路**，否则会出现「测试通过、对话超时」。所以复用
 * `adapters/http.ts` 导出的 proxyUrl / tunneledTls。
 */

import http from 'node:http';
import https from 'node:https';
import { proxyUrl, tunneledTls } from './adapters/http.js';
import {
  chatUrlOf,
  modelsUrlOf,
  normalizeBaseUrl,
  type ProviderDialect,
} from '../../shared/providerUrl.js';

export interface ProviderTestInput {
  baseUrl: string;
  dialect: ProviderDialect;
  /** 明文 Key。调用方负责从凭据存储取，绝不回传前端 */
  apiKey: string;
  /** 要实测的模型。为空则只测地址与 Key，不发对话 */
  model?: string;
  timeoutMs?: number;
}

export interface ProviderTestStep {
  step: 'models' | 'chat';
  ok: boolean;
  /** 已转成人话的结论（不直接抛上游 JSON） */
  detail: string;
  latencyMs: number;
  /** step === 'models' 时带回来的模型 ID */
  models?: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  baseUrl: string;
  /** 真实会请求的对话地址，界面要展示它 —— 大半 404 是地址少/多了一段 */
  chatUrl: string;
  models: string[];
  steps: ProviderTestStep[];
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/** 对话测试最多等多久。给足上游冷启动时间，但别让界面转一分钟 */
const DEFAULT_TIMEOUT_MS = 20000;

function authHeaders(dialect: ProviderDialect, key: string): Record<string, string> {
  if (dialect === 'anthropic') {
    return {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  }
  if (dialect === 'gemini') {
    return { 'x-goog-api-key': key, 'content-type': 'application/json' };
  }
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

/** 最小对话请求体。max_tokens 压到最小，问一句「ping」即可确认链路 */
function chatBody(dialect: ProviderDialect, model: string): Record<string, unknown> {
  if (dialect === 'anthropic') {
    return { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  }
  if (dialect === 'gemini') {
    return { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] };
  }
  return { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false };
}

interface RawResponse {
  status: number;
  body: string;
  contentType: string;
}

/**
 * 发一次请求并读完整 body。
 *
 * 测试场景不需要流式：整段读完更好判断，也避免「SSE 里其实混着错误」
 * 这种半对半错的状态。
 */
function rawRequest(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown> | undefined,
  timeoutMs: number
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('地址不是合法 URL'));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && parsed.protocol !== 'http:') {
      reject(new Error('只支持 http / https 地址'));
      return;
    }
    const port = Number(parsed.port) || (isHttps ? 443 : 80);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const h: Record<string, string> = { ...headers };
    if (payload) h['content-length'] = String(Buffer.byteLength(payload));

    const proxy = proxyUrl();
    const opts: https.RequestOptions & { agent?: http.Agent | https.Agent } = {
      hostname: parsed.hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: h,
    };
    if (proxy && isHttps) {
      const agent = new https.Agent({ keepAlive: false });
      (agent as unknown as {
        createConnection: (
          o: unknown,
          cb: (e: Error | null, s?: import('node:tls').TLSSocket) => void
        ) => void;
      }).createConnection = (_o, cb) => {
        tunneledTls(proxy, parsed.hostname, port, Math.min(timeoutMs, 15000))
          .then(sock => cb(null, sock))
          .catch(err => cb(err as Error));
      };
      opts.agent = agent;
    } else {
      opts.agent = isHttps ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    }

    const transport = isHttps ? https : http;
    const req = transport.request(opts, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => (raw += c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode ?? 0,
          body: raw,
          contentType: String(res.headers['content-type'] ?? ''),
        });
      });
      res.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error('请求超时'));
    }, timeoutMs);
    timer.unref?.();

    req.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(payload || undefined);
  });
}

/** 上游把真正的理由写在 body 里，只取 message 一行给人看 */
function upstreamMessage(raw: string): string {
  try {
    const o = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const m =
      typeof o.error === 'string'
        ? o.error
        : o.error?.message ?? o.message ?? '';
    if (typeof m === 'string' && m.trim()) return m.trim().replace(/\s+/g, ' ').slice(0, 220);
  } catch {
    /* 不是 JSON：退回原文 */
  }
  return raw.trim().replace(/\s+/g, ' ').slice(0, 220);
}

/** 网络层异常的翻译。用户看到的应该是「域名解析失败」而不是 `ENOTFOUND` */
function explainNetworkError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code ?? '';
  const msg = `${code} ${err.message}`;
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return '域名解析失败：地址可能写错了，或本机 DNS 不通';
  if (/ECONNREFUSED/.test(msg)) return '连接被拒绝：端口没开，或地址指向了本机未启动的服务';
  if (/ECONNRESET|socket hang up/i.test(msg)) return '连接被对方重置：可能是代理或网关拦截';
  if (/ETIMEDOUT|timeout|超时/i.test(msg)) return '连接超时：网络不通，或代理没有生效';
  if (/CERT|TLS|SSL/i.test(msg)) return 'TLS 握手失败：证书不受信任，或被代理替换过';
  return err.message;
}

/** 状态码 → 人话。404 单独给「检查地址」的提示，这是最高频的坑 */
function explainStatus(status: number, raw: string, dialect: ProviderDialect): string {
  const detail = upstreamMessage(raw);
  const suffix = detail ? `：${detail}` : '';
  if (status === 401) return `API Key 无效或已过期（401）${suffix}`;
  if (status === 403) return `Key 无权访问该地址或该模型（403）${suffix}`;
  if (status === 404) {
    const hint =
      dialect === 'gemini'
        ? 'Gemini 的地址要带版本段，例如 https://generativelanguage.googleapis.com/v1beta'
        : '多数服务需要 /v1 结尾，例如 https://api.deepseek.com/v1；也请确认模型名在清单里';
    return `地址或模型不存在（404）${suffix}。${hint}`;
  }
  if (status === 405) return `该地址不接受这种请求（405）${suffix}。请确认地址指向 API 根，而不是网页`;
  if (status === 429) return `请求被限流或额度不足（429）${suffix}`;
  if (status >= 500) return `厂商服务异常（${status}）${suffix}`;
  return `请求失败（${status}）${suffix}`;
}

function parseModelIds(raw: string, dialect: ProviderDialect): string[] {
  try {
    const o = JSON.parse(raw) as {
      data?: Array<{ id?: string; name?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const arr = dialect === 'gemini' ? o.models : o.data;
    if (!Array.isArray(arr)) return [];
    const ids = arr
      .map(m => (typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : ''))
      .filter((id): id is string => !!id)
      .map(id => (dialect === 'gemini' ? id.replace(/^models\//, '') : id));
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
}

/**
 * 拉模型清单。
 *
 * 有的网关不提供 `/models`（或要额外权限）。那种情况**不是错误**：用户仍可
 * 手动填模型名。这里用 `ok: true + 空清单` 表示「地址通了但列不出来」，
 * 与「地址/Key 有问题」区分开。
 */
export async function listProviderModels(
  input: Omit<ProviderTestInput, 'model'>
): Promise<ModelListResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!baseUrl) return { ok: false, models: [], error: '请填写 API 地址' };
  if (!input.apiKey) return { ok: false, models: [], error: '请填写 API Key' };

  let res: RawResponse;
  try {
    res = await rawRequest(
      'GET',
      modelsUrlOf(baseUrl),
      authHeaders(input.dialect, input.apiKey),
      undefined,
      timeoutMs
    );
  } catch (err) {
    return { ok: false, models: [], error: explainNetworkError(err as Error) };
  }

  if (res.status >= 200 && res.status < 300) {
    const models = parseModelIds(res.body, input.dialect);
    return { ok: true, models };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    // 不提供清单：给空列表，让用户手动填
    return { ok: true, models: [] };
  }
  return {
    ok: false,
    models: [],
    error: explainStatus(res.status, res.body, input.dialect),
  };
}

/** 只测对话（给已保存的厂商做「测试连接」用，顺带验证当前模型） */
export async function testProvider(input: ProviderTestInput): Promise<ProviderTestResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chatUrl = chatUrlOf(baseUrl, input.dialect, input.model || '{model}', false);
  const steps: ProviderTestStep[] = [];
  const models: string[] = [];

  if (!baseUrl) {
    return {
      ok: false,
      baseUrl,
      chatUrl,
      models,
      steps: [{ step: 'models', ok: false, detail: '请填写 API 地址', latencyMs: 0 }],
    };
  }
  if (!input.apiKey) {
    return {
      ok: false,
      baseUrl,
      chatUrl,
      models,
      steps: [{ step: 'models', ok: false, detail: '请先填写 API Key', latencyMs: 0 }],
    };
  }

  // 第一步：地址 + Key 是否被接受（顺便把模型清单带回去）
  const t0 = Date.now();
  let listOk = false;
  try {
    const res = await rawRequest(
      'GET',
      modelsUrlOf(baseUrl),
      authHeaders(input.dialect, input.apiKey),
      undefined,
      timeoutMs
    );
    if (res.status >= 200 && res.status < 300) {
      listOk = true;
      models.push(...parseModelIds(res.body, input.dialect));
      steps.push({
        step: 'models',
        ok: true,
        detail: models.length ? `地址可用，读到 ${models.length} 个模型` : '地址可用（该服务未返回模型清单）',
        latencyMs: Date.now() - t0,
        models: [...models],
      });
    } else if (res.status === 404 || res.status === 405 || res.status === 501) {
      // 清单接口不存在不代表地址不对，交给对话那一步定论
      listOk = true;
      steps.push({
        step: 'models',
        ok: true,
        detail: '该服务不提供模型清单，已跳过（不影响对话测试）',
        latencyMs: Date.now() - t0,
      });
    } else {
      steps.push({
        step: 'models',
        ok: false,
        detail: explainStatus(res.status, res.body, input.dialect),
        latencyMs: Date.now() - t0,
      });
    }
  } catch (err) {
    steps.push({
      step: 'models',
      ok: false,
      detail: explainNetworkError(err as Error),
      latencyMs: Date.now() - t0,
    });
  }

  // 没有模型就没法发对话：地址/Key 的结论已经够用户行动了
  if (!input.model) {
    return { ok: listOk, baseUrl, chatUrl, models, steps };
  }

  // 第二步：真发一次最小对话
  const t1 = Date.now();
  try {
    const res = await rawRequest(
      'POST',
      chatUrlOf(baseUrl, input.dialect, input.model, false),
      authHeaders(input.dialect, input.apiKey),
      chatBody(input.dialect, input.model),
      timeoutMs
    );
    if (res.status >= 200 && res.status < 300) {
      steps.push({
        step: 'chat',
        ok: true,
        detail: `模型 ${input.model} 已应答`,
        latencyMs: Date.now() - t1,
      });
    } else {
      steps.push({
        step: 'chat',
        ok: false,
        detail: explainStatus(res.status, res.body, input.dialect),
        latencyMs: Date.now() - t1,
      });
    }
  } catch (err) {
    steps.push({
      step: 'chat',
      ok: false,
      detail: explainNetworkError(err as Error),
      latencyMs: Date.now() - t1,
    });
  }

  return {
    ok: steps.every(s => s.ok),
    baseUrl,
    chatUrl,
    models,
    steps,
  };
}
