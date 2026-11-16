/**
 * API 薄层（绞杀者第 0 期 / SUPER-AGENT-DESIGN §二十二 第 0 期）。
 *
 * 把散落在各处的裸 fetch 收进这一层，为将来统一拦截 / 日志 / 错误形态留一个
 * 口子（设计 §十一 的 API 引擎会复用这里）。
 *
 * ⚠️「只搬家不改行为」：本层**逐字透传** init —— 不自动加 header、不吞错误、
 * 不改 JSON 处理。任何调用方的错误语义（res.ok 检查 / 静默跳过 404 / 直接
 * res.json() / 读 res.body.getReader()）都保持原样，否则 129 处迁移就会引入
 * 行为回归，而 verify:ui 的断言会抓住它们。
 *
 * 唯一被本层接管的是 method：由方法名决定（get/post/put/patch/delete），
 * 调用方不再写 `method` 字段。若 init 里仍有 method（误留），本层以方法名为准，
 * 但不会报错——这是刻意的宽松，避免迁移时漏删 method 直接炸掉。
 */

export interface Api {
  /** GET。init 透传（可带 headers / signal / credentials）。 */
  get(url: string, init?: RequestInit): Promise<Response>;
  /** POST。init 透传，body 由调用方自己 JSON.stringify。 */
  post(url: string, init?: RequestInit): Promise<Response>;
  /** PUT。init 透传。 */
  put(url: string, init?: RequestInit): Promise<Response>;
  /** PATCH。init 透传。 */
  patch(url: string, init?: RequestInit): Promise<Response>;
  /** DELETE。init 透传。 */
  delete(url: string, init?: RequestInit): Promise<Response>;
  /**
   * 原始 fetch（流式 SSE 用）：调用方拿到 Response 后读 res.body.getReader()。
   * 与 get 的区别只是语义标注——本层同样透传，method 由调用方 init 决定。
   */
  stream(url: string, init?: RequestInit): Promise<Response>;
}

const withMethod = (method: string) => (url: string, init?: RequestInit) =>
  fetch(url, { ...init, method });

export const api: Api = {
  get: withMethod('GET'),
  post: withMethod('POST'),
  put: withMethod('PUT'),
  patch: withMethod('PATCH'),
  delete: withMethod('DELETE'),
  stream: (url, init) => fetch(url, init),
};

export default api;
