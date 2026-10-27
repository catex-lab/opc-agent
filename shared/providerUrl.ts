/**
 * 自定义模型厂商的地址规则（前后端共用）。
 *
 * ## 为什么单独一份
 *
 * 设置页要在保存前回显「最终请求地址」，服务端要按同一套规则真正发请求。
 * 两处各写一份拼接逻辑，迟早会出现「界面显示 A、实际请求 B」—— 而这类
 * 偏差没有报错，只有一个 404。所以纯逻辑放在 shared/，两端 import 同一份。
 *
 * ## 为什么要「剥掉端点后缀」
 *
 * 用户会从文档里直接复制完整端点（`.../v1/chat/completions`）。如果原样
 * 存下来再拼一次，就变成 `.../chat/completions/chat/completions`。所以
 * 入库前统一剥到「版本号那一层」（`.../v1`），后续只拼一次。
 */

export type ProviderDialect = 'openai' | 'anthropic' | 'gemini';

/** 三家方言在界面上的名字 */
export function dialectLabel(dialect: ProviderDialect): string {
  if (dialect === 'anthropic') return 'Anthropic Messages';
  if (dialect === 'gemini') return 'Gemini';
  return 'OpenAI Chat';
}

export function isProviderDialect(v: unknown): v is ProviderDialect {
  return v === 'openai' || v === 'anthropic' || v === 'gemini';
}

/**
 * 已知的端点后缀，按「越长越先」排列。
 *
 * 顺序有意义：`/chat/completions` 必须先于 `/completions` 匹配，否则会剥成
 * `.../chat`；Gemini 的 `/models/<id>:generateContent` 必须先于 `/models`。
 */
const ENDPOINT_SUFFIXES = [
  /\/chat\/completions$/i,
  /\/messages$/i,
  /\/responses$/i,
  /\/completions$/i,
  /\/models\/[^/]+(?::[A-Za-z]+)?$/i,
  /\/models$/i,
];

/**
 * 把用户填的地址归一化成「版本号那一层」。
 *
 * 只做字符串处理，不校验协议 —— 校验留给调用方（服务端要能返回具体错误，
 * 前端要能边输边预览）。
 */
export function normalizeBaseUrl(raw: string): string {
  let v = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!v) return '';
  for (const re of ENDPOINT_SUFFIXES) {
    if (re.test(v)) {
      v = v.replace(re, '').replace(/\/+$/, '');
      break;
    }
  }
  return v;
}

/** 模型清单地址。三家都是 `{base}/models`。 */
export function modelsUrlOf(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

/**
 * 对话请求的最终 URL。
 *
 * @param stream true = 应用实际调用（Gemini 走 SSE 端点）；false = 表单预览 /
 *   连通性测试（Gemini 用非流式 generateContent）。
 */
export function chatUrlOf(
  baseUrl: string,
  dialect: ProviderDialect,
  model: string,
  stream = false
): string {
  const base = normalizeBaseUrl(baseUrl);
  if (dialect === 'anthropic') return `${base}/messages`;
  if (dialect === 'gemini') {
    // Gemini 的模型名在路径里，这是它和另外两家最大的结构差异。
    const id = model || '{model}';
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `${base}/models/${encodeURIComponent(id)}:${action}`;
  }
  return `${base}/chat/completions`;
}
