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

  export interface SdkSession {
    getAvailableModels(): Promise<AvailableModel[]>;
    [key: string]: unknown;
  }

  export function unstable_v2_createSession(options?: {
    cwd?: string;
    [key: string]: unknown;
  }): Promise<SdkSession>;

  export function unstable_v2_resumeSession(
    ...args: unknown[]
  ): Promise<SdkSession>;

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
