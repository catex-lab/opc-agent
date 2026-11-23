/**
 * API 薄层（绞杀者第 0 期 / SUPER-AGENT-DESIGN §二十二 第 0 期）。
 *
 * 把散落在各处的裸 fetch 收进这一层，为将来统一拦截 / 日志 / 错误形态留一个
 * 口子（设计 §十一 的 API 引擎会复用这里）。
 *
 * ⚠️「只搬家不改行为」：本层**逐字透传** init —— 不吞错误、不改 JSON 处理。
 * 任何调用方的错误语义（res.ok 检查 / 静默跳过 404 / 直接 res.json() / 读
 * res.body.getReader()）都保持原样，否则 129 处迁移就会引入行为回归，而
 * verify:ui 的断言会抓住它们。
 *
 * 唯一被本层接管的是 method：由方法名决定（get/post/put/patch/delete），
 * 调用方不再写 `method` 字段。若 init 里仍有 method（误留），本层以方法名为准，
 * 但不会报错——这是刻意的宽松，避免迁移时漏删 method 直接炸掉。
 *
 * ⚠️ M01 例外（鉴权头，§7.5 Antumi 范式）：这是本层**唯一**自动加的 header。
 * harness 进程壳启用时（preload 的 getApiToken 有值），每个 /api 请求带
 * `x-opc-token`；浏览器开发态 window.opc 不在 → null → 一个头都不加，
 * 与改造前逐字节一致。token 只活在这一层的模块级缓存里，**不落 localStorage**
 * —— 它随每次 harness 拉起轮换，持久化明文等于白给。调用方传了自己的
 * headers 时原样保留（鉴权头追加，不覆盖调用方字段）。
 */

/** preload 暴露的桥（本层只关心 token 一颗；完整签名见 workspace.ts） */
interface OpcBridgeForToken {
  getApiToken?(): Promise<string | null>;
}

let tokenPromise: Promise<string | null> | null = null;

/** 拉一次 token 并缓存（null = 浏览器开发态 / 老路 / Node 闸门环境，不做鉴权） */
function localApiToken(): Promise<string | null> {
  if (!tokenPromise) {
    // typeof 守卫：闸门在 Node/tsx 里直接 import 本层测透传语义，那里没有 window
    const opc =
      typeof window === 'undefined'
        ? undefined
        : (window as unknown as { opc?: OpcBridgeForToken }).opc;
    tokenPromise = Promise.resolve(opc?.getApiToken?.() ?? null).catch(() => null);
  }
  return tokenPromise;
}

async function withAuth(init?: RequestInit): Promise<RequestInit | undefined> {
  const token = await localApiToken();
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set('x-opc-token', token);
  return { ...init, headers };
}

const withMethod = (method: string) => async (url: string, init?: RequestInit) => {
  const authed = await withAuth(init);
  return fetch(url, { ...authed, method });
};

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

export const api: Api = {
  get: withMethod('GET'),
  post: withMethod('POST'),
  put: withMethod('PUT'),
  patch: withMethod('PATCH'),
  delete: withMethod('DELETE'),
  stream: async (url, init) => fetch(url, await withAuth(init)),
};

export default api;
