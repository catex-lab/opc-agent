/**
 * `@tencent-ai/agent-sdk` 的本地类型声明。
 *
 * 为什么需要它：npm 上发布的 0.3.x 包只带了 `lib/*.d.ts.map`，却没有对应的
 * `.d.ts` 本体（`find node_modules/@tencent-ai/agent-sdk/lib -name '*.d.ts'`
 * 结果为空），于是 `package.json` 里的 `"typings": "lib/index.d.ts"` 指向了
 * 一个不存在的文件。
 *
 * 后果不只是「没有提示」：在 `strict` 下整个模块会退化成 `any`，调用处传入的
 * 回调参数随之变成隐式 `any`，直接报 TS7006 —— 编译不过。
 *
 * 这里按**实际用到的导出**补上签名，其余导出保持宽松类型。宁可宽松也不
 * 编造字段：写错的类型比 `any` 更危险，因为它会骗过调用方。
 *
 * 上游补齐 `.d.ts` 之后，删掉本文件即可。
 */
declare module '@tencent-ai/agent-sdk' {
  // ============= 流式消息 =============

  /**
   * SDK 流式返回的消息。字段随 `type` 不同而不同，所以这里只列出我们用到的
   * 几个，并留索引签名兜住其余。
   */
  export interface SdkMessage {
    type?: string;
    subtype?: string;
    /** 会话 id，`type === 'system' && subtype === 'init'` 时带回，用于 resume */
    session_id?: string;
    message?: { content?: unknown };
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
    duration?: number;
    cost?: number;
    [key: string]: unknown;
  }

  // ============= 权限 =============

  export interface PermissionResultAllow {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
  }

  export interface PermissionResultDeny {
    behavior: 'deny';
    message?: string;
    interrupt?: boolean;
  }

  export type PermissionResult = PermissionResultAllow | PermissionResultDeny;

  export interface CanUseToolOptions {
    signal?: AbortSignal;
    /** 与本次工具调用配对的 id，前端用来把权限请求挂回正确的工具卡片 */
    toolUseID?: string;
    [key: string]: unknown;
  }

  export type CanUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions
  ) => Promise<PermissionResult>;

  // ============= query =============

  export interface QueryOptions {
    cwd?: string;
    model?: string;
    maxTurns?: number;
    systemPrompt?: string;
    permissionMode?: string;
    canUseTool?: CanUseTool;
    /** 上一次调用拿到的 session id，用于续接上下文 */
    resume?: string;
    env?: Record<string, string>;
    [key: string]: unknown;
  }

  export interface QueryParams {
    prompt: string;
    options?: QueryOptions;
  }

  export function query(params: QueryParams): AsyncIterable<SdkMessage>;

  // ============= 鉴权 =============

  export interface AuthState {
    authUrl?: string;
    [key: string]: unknown;
  }

  export interface AuthenticateOptions {
    environment?: 'external' | 'internal' | (string & {});
    /** A155：显式端点；缺省由 CLI 按 environment 自己选 */
    endpoint?: string;
    /** A155：注入给 CLI 子进程的环境变量（SDK 会与 process.env 合并） */
    env?: Record<string, string>;
    /** 只有「未登录」时才会被调用，因此回调触发本身就是未登录的信号 */
    onAuthUrl?: (state: AuthState) => void | Promise<void>;
    [key: string]: unknown;
  }

  export interface AuthenticateResult {
    userinfo?: { userName?: string; [key: string]: unknown };
    [key: string]: unknown;
  }

  export function unstable_v2_authenticate(
    options?: AuthenticateOptions
  ): Promise<AuthenticateResult | undefined>;

  export function unstable_v2_logout(...args: unknown[]): Promise<void>;

  // ============= 会话 =============

  export interface AvailableModel {
    modelId: string;
    name: string;
    description?: string;
  }

  /**
   * A107：长驻会话（`unstable_v2_createSession` 的返回）。
   *
   * 为什么值得单用这套 API 而不是继续 `query()`：`query()` 是 one-shot ——
   * 收到第一个 `result` 就 `transport.close()` 把 24MB 的 CLI 进程杀掉，
   * 下一条消息整套冷启动（实测 ≈15s）重付一遍。会话对象把进程攥在手里，
   * `send()`/`stream()` 可以一轮轮往下走。
   *
   * 字段按 `lib/session.js`（SessionImpl）实际实现列，宁缺毋滥。
   */
  export interface SdkSession {
    /** 立即可用：resumeSessionId > options.sessionId > 自动生成的 uuidv7 */
    readonly sessionId: string;
    /** 发一条用户消息；内部会确保 transport 已 initialize */
    send(message: string): Promise<void>;
    /** 读这一轮的回复；到 `result` 自行结束 */
    stream(): AsyncIterable<SdkMessage>;
    /** 中止当前轮：abort 本地控制器 + 给 CLI 发 interrupt 控制请求 */
    interrupt(): Promise<void>;
    /** 未连接时改 transport options（变成 CLI 参数）；已连接则发控制请求 */
    setPermissionMode(mode: string): Promise<void>;
    getPermissionMode(): string;
    setModel(model: string): Promise<void>;
    getModel(): string | undefined;
    /** 运行时替换 canUseTool（QueryController 的 getter 是惰性的，立即生效） */
    setCanUseTool(handler: CanUseTool): void;
    /** 只 spawn + boot，不发 initialize —— 用来提前热身 */
    prewarm(): Promise<void>;
    close(): void;
    getAvailableModels(): Promise<AvailableModel[]>;
    [key: string]: unknown;
  }

  export function unstable_v2_createSession(options?: {
    cwd?: string;
    model?: string;
    maxTurns?: number;
    systemPrompt?: string;
    permissionMode?: string;
    canUseTool?: CanUseTool;
    /** A155：产品环境（WorkBuddy 国内版是 internal） */
    environment?: 'external' | 'internal' | (string & {});
    /** A155：显式端点，缺省由 CLI 按 environment 自己选 */
    endpoint?: string;
    /** A155：注入给 CLI 子进程的环境变量（与 process.env 合并） */
    env?: Record<string, string>;
    /** 显式端口等透传参数（对象 → `--flag value`） */
    extraArgs?: Record<string, string | null>;
    [key: string]: unknown;
  }): SdkSession;

  export function unstable_v2_resumeSession(
    sessionId: string,
    options?: {
      cwd?: string;
      model?: string;
      maxTurns?: number;
      systemPrompt?: string;
      permissionMode?: string;
      canUseTool?: CanUseTool;
      environment?: 'external' | 'internal' | (string & {});
      endpoint?: string;
      env?: Record<string, string>;
      extraArgs?: Record<string, string | null>;
      [key: string]: unknown;
    }
  ): SdkSession;

  // ============= 其余导出（保持宽松，用到时再收窄） =============

  export const Query: unknown;
  export const EXIT_REASONS: Record<string, string>;
  export const HOOK_EVENTS: readonly string[];

  export class ExecutionError extends Error {}
  export class CLIStartupError extends Error {}
  export class AbortError extends Error {}

  export function tool(...args: unknown[]): unknown;
  export function createSdkMcpServer(...args: unknown[]): unknown;
  export function installPlugin(...args: unknown[]): Promise<unknown>;
  export function enablePlugin(...args: unknown[]): Promise<unknown>;
  export function disablePlugin(...args: unknown[]): Promise<unknown>;
  export function installMarketplace(...args: unknown[]): Promise<unknown>;
  export function removeMarketplace(...args: unknown[]): Promise<unknown>;
}
