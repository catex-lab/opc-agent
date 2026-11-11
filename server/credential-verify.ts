/**
 * 真实只读鉴权校验（#16）。
 *
 * ## 修的是哪一句假话
 *
 * `accountProbe.ts` 的 `verified` 恒为 false 是**诚实**的：它只读本地文件，
 * 从没向服务方发过请求。但「诚实」不等于「有用」—— 用户看到账号卡常年
 * 写着「未校验」，没有任何办法把它变成「已校验」；填完 Key 也只看到
 * 「本地已保存」，并不知道这把 Key 服务端认不认。
 *
 * 这里补的是**唯一一个能把 verified 升成 true 的动作**：拿已保存的 Key，
 * 向该厂商发一次最小只读请求（GET /models），按 HTTP 状态给结论。
 * 不发对话、不花 token、不改任何服务端状态。
 *
 * ## 四条边界（改之前先读完）
 *
 * 1. **绝不假装成功**：401/403 = Key 无效；404/405/501 = 这家没这个只读端点
 *    （`no-readonly-endpoint`，不是「校验失败」也不是「通了」）；5xx/超时/
 *    解析不出模型列表 = 无法判断，一律 `verified:false`。只有 2xx + 能解析出
 *    合法的模型清单响应，才是 `verified:true`。
 * 2. **绝不拿内置凭据打任意地址**：目标 URL 只能来自定义表里的 `http.url`
 *    、用户自己保存的 `baseUrl`，或本文件登记过的官方只读地址。**接口不接受
 *    前端传 URL** —— 否则「填了 Key 的内置 Agent」会变成一个 SSRF 通道。
 * 3. **注入 `fetchImpl`**：夹具用本地 mock，测试绝不打真实外网；生产用
 *    `globalThis.fetch`。响应体只读一次，超时 8 秒，Key 只进 header 不进 URL
 *    （Gemini 官方同样支持 `x-goog-api-key`，不必拼进 query 再被日志记下）。
 * 4. **溯源契约**：`verified` 只能由本次真实请求的结果决定，且随结论一起
 *    返回 `makeProvenance()`；`source` 只写方法 + URL，不含任何密钥。
 */

import { findDef } from './agents/definitions.js';
import { credentialSpecOf, getRawCredential } from './agent-credentials.js';
import {
  modelsUrlOf,
  normalizeBaseUrl,
  type ProviderDialect,
} from '../shared/providerUrl.js';
import { makeProvenance, type Provenance } from '../shared/provenance.js';

/** 内置 Agent 若没有 http 定义，这里登记官方公开的只读根地址。 */
const OFFICIAL_READONLY_BASE: Record<string, string> = {
  // https://ai.google.dev/gemini-api/docs/models · GET /v1beta/models
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

const TIMEOUT_MS = 8000;

/** 为什么没验成。前端据此给一句能行动的话，而不是笼统的「失败」。 */
export type VerifyReason =
  | 'no-credential'
  | 'no-readonly-endpoint'
  | 'invalid-key'
  | 'rate-limited'
  | 'upstream-error'
  | 'unexpected-response'
  | 'network-error';

export interface CredentialVerification {
  verified: boolean;
  /** 这次校验发生的时刻（epoch ms），与 provenance.probedAt 一致 */
  checkedAt: number;
  agentId: string;
  family: string;
  /** 实际请求的 URL（已去掉任何密钥），也是 provenance 的 source */
  source: string;
  reason?: VerifyReason;
  /** 给人看的一句话结论 */
  error?: string;
  /** 2xx 时顺带带回的前几个模型 ID，只作提示 */
  models?: string[];
  provenance: Provenance;
}

/** 与 `globalThis.fetch` 同形；夹具返回标准 `Response` 即可。 */
export type FetchLike = typeof globalThis.fetch;

interface ReadonlyEndpoint {
  url: string;
  headers: Record<string, string>;
  dialect: ProviderDialect;
}

/**
 * 解析「这次该打哪儿」。
 *
 * 返回 null = 这家没有可用来校验的只读端点（SDK 登录态、OAuth 类 CLI 都属
 * 此类）。调用方必须如实说 `no-readonly-endpoint`，不许退化成「通了」。
 */
export function readonlyEndpointOf(agentId: string): ReadonlyEndpoint | null {
  const def = findDef(agentId);
  const spec = credentialSpecOf(agentId);
  if (!def || !spec) return null;

  const saved = getRawCredential(agentId);
  const rawBase =
    normalizeBaseUrl(saved.baseUrl) ||
    normalizeBaseUrl(def.http?.url ?? '') ||
    normalizeBaseUrl(OFFICIAL_READONLY_BASE[agentId] ?? '');
  if (!rawBase) return null;

  let url: string;
  try {
    url = modelsUrlOf(rawBase);
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  // 环境变量也算「已配置」：开发态 export 的 Key 同样应该能被校验。
  const key = saved.key || spec.keyEnv.map(n => (process.env[n] ?? '').trim()).find(Boolean) || '';
  if (!key) return null;

  const dialect: ProviderDialect = def.http?.dialect ?? (agentId === 'gemini' ? 'gemini' : 'openai');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (dialect === 'gemini') headers['x-goog-api-key'] = key;
  else if (dialect === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${key}`;

  return { url, headers, dialect };
}

/** 2xx 的 body 必须是「像模型清单的 JSON」，否则不许升格成已校验。 */
export function parseModelsBody(raw: string, dialect: ProviderDialect): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.error !== undefined) return null;
  // OpenAI 兼容给 data[]，Gemini 给 models[]；两家都允许空数组（有权限但没列条目）。
  const arr = dialect === 'gemini' ? obj.models : obj.data;
  if (!Array.isArray(arr)) return null;
  const ids = arr
    .map(m => {
      if (!m || typeof m !== 'object') return '';
      const one = m as Record<string, unknown>;
      const id = typeof one.id === 'string' ? one.id : typeof one.name === 'string' ? one.name : '';
      return dialect === 'gemini' ? id.replace(/^models\//, '') : id;
    })
    .filter((id): id is string => !!id);
  return Array.from(new Set(ids));
}

const REASON_TEXT: Record<VerifyReason, string> = {
  'no-credential': '没有可用的 API Key，无法校验',
  'no-readonly-endpoint': '该服务没有可校验的只读端点，无法证明凭据有效',
  'invalid-key': '服务端拒绝了这把 Key（401/403），凭据无效或已失效',
  'rate-limited': '请求被限流（429），本次无法判断凭据是否有效',
  'upstream-error': '服务暂时不可用，本次无法判断凭据是否有效',
  'unexpected-response': '服务端返回的不是模型清单，本次无法判断凭据是否有效',
  'network-error': '网络请求失败，本次无法判断凭据是否有效',
};

/** 一次响应的结论。单独导出，闸门可直接逐状态覆盖。 */
export interface VerifyDecision {
  verified: boolean;
  reason?: VerifyReason;
  models?: string[];
}

/** 状态 + body → 结论。纯函数，不碰网络、不碰凭据。 */
export function decideVerification(
  status: number,
  body: string,
  dialect: ProviderDialect
): VerifyDecision {
  if (status === 401 || status === 403) return { verified: false, reason: 'invalid-key' };
  if (status === 429) return { verified: false, reason: 'rate-limited' };
  if (status === 404 || status === 405 || status === 501) {
    return { verified: false, reason: 'no-readonly-endpoint' };
  }
  if (status < 200 || status >= 300) return { verified: false, reason: 'upstream-error' };
  const models = parseModelsBody(body, dialect);
  if (!models) return { verified: false, reason: 'unexpected-response' };
  return { verified: true, models: models.slice(0, 20) };
}

/**
 * 校验一把已保存的凭据。任何失败都返回 `verified:false` 的**结论**，
 * 不抛异常 —— 这是「测试结论」而不是服务端故障（与 `/agents/custom/test` 同口径）。
 *
 * 第三个参数是**反向探针注入点**：闸门会塞一个「401 也说成功」的坏决定函数，
 * 用来证明「无效 Key 判红」那条断言真的盯着 `verified`，而不是碰巧绿。
 */
export async function verifyCredential(
  agentId: string,
  fetchImpl: FetchLike = globalThis.fetch,
  decide: typeof decideVerification = decideVerification
): Promise<CredentialVerification> {
  const checkedAt = Date.now();
  const family = findDef(agentId)?.descriptor.family ?? 'unknown';
  const base = { agentId, family, checkedAt };

  const finish = (
    verified: boolean,
    source: string,
    reason?: VerifyReason,
    models?: string[]
  ): CredentialVerification => ({
    ...base,
    verified,
    source,
    ...(reason ? { reason, error: REASON_TEXT[reason] } : {}),
    ...(models ? { models } : {}),
    provenance: makeProvenance(source ? `GET ${source}` : '未发起校验请求', {
      probedAt: checkedAt,
      verified,
      ...(reason ? { note: REASON_TEXT[reason] } : { note: '只读模型清单端点返回的真实鉴权结果' }),
    }),
  });

  const endpoint = readonlyEndpointOf(agentId);
  if (!endpoint) {
    // 区分「没存 Key」与「这家压根没有只读端点」：用户对该做的事不同。
    const stored = getRawCredential(agentId);
    const spec = credentialSpecOf(agentId);
    const hasKey =
      !!stored.key ||
      !!spec?.keyEnv.map(n => (process.env[n] ?? '').trim()).find(Boolean);
    return finish(false, '', hasKey ? 'no-readonly-endpoint' : 'no-credential');
  }

  let status: number;
  let body: string;
  try {
    const res = await fetchImpl(endpoint.url, {
      method: 'GET',
      headers: endpoint.headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    body = await res.text();
  } catch {
    return finish(false, endpoint.url, 'network-error');
  }

  const decision = decide(status, body, endpoint.dialect);
  return finish(
    decision.verified,
    endpoint.url,
    decision.reason,
    decision.models
  );
}
