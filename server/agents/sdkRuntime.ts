/**
 * SDK 运行参数（A155 / A216）：把定义表里的 `SdkSpec` 展开成 SDK 真正认的
 * `{ environment, endpoint, env }`；A216 起新增官方产品配置路径注入，并让
 * `environment` 与 `endpoint` 按官方口径二选一（见 `planSdkRuntime`）。
 *
 * ## 为什么单独一层，而不是在适配器里拼
 *
 * 这三项目前有两个消费方：
 *   - `adapters/sdk.ts`（对话、探测登录）
 *   - `server/index.ts`（`/api/models` 取模型清单、`/api/check-login` 查登录）
 *
 * 它们原来各写各的：适配器把 environment 写死成 external，`index.ts` 也写死
 * 成 external —— 看起来一致，其实都错了（WorkBuddy 国内版要 internal）。
 * 两处硬编码必然再次分叉，所以收敛到这一个纯函数里：新增/修改产品只改一处。
 *
 * ## 配置根为什么必须指到官方产品目录
 *
 * SDK 内置 CLI 的登录态与设置按 `CODEBUDDY_CONFIG_DIR` 隔离。WorkBuddy 桌面端
 * 的登录在 `~/.workbuddy`，指到默认的 `~/.codebuddy` 等于换了客户端 ——
 * 本机实测会卡在 initialize 超时（174s），而不是给出「未登录」。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { SdkSpec } from './definitions.js';

export interface SdkRuntime {
  /** 产品环境；undefined 时由 CLI 自己（或官方 V3 配置）决定 */
  environment?: string;
  /** 显式端点；undefined 时由 CLI 按环境自己选 */
  endpoint?: string;
  /** 注入给 CLI 子进程的环境变量（只含我们显式要设的，SDK 会与 process.env 合并） */
  env: Record<string, string>;
  /**
   * A231：SDK 会话/one-shot 子进程的设置源。
   *
   * SDK 的 `buildArgs` 在 `settingSources` 未传时**写死 `--setting-sources none`**
   * （process-transport.js），而 CLI 自己的默认是 `user,project,local`（--help 实测）。
   * WorkBuddy CLI 的登录态（keyblob/account）属于 user 设置源 —— `none` 会让
   * CLI「看不见登录态」：官方模型一律 `Authentication required`，自定义模型
   * 不受影响（key 来自 config 目录的 models.json，不走设置源）。
   *
   * 只开 `user`：登录态 + 用户全局设置与桌面端对齐；不带 project/local，
   * 避免会话 cwd 下的项目级设置静默改写 OPC 的对话行为。
   */
  settingSources: Array<'user' | 'project' | 'local'>;
}

/**
 * A216：CLI 侧真正认的网络环境集合。
 *
 * 依据官方 SDK 概览的 `CODEBUDDY_INTERNET_ENVIRONMENT`（`internal` / `ioa` /
 * `cloudhosted` / `selfhosted`，海外版为「不设置」用 `product.json`），以及打包
 * CLI 里 `product.<env>.json` 的实际文件清单 —— 两者恰好一一对应。
 *
 * **`external` 不在这个集合里**：它是 `unstable_v2_authenticate` 的合法取值
 * （表示海外版登录），不是 CLI 的产品配置环境。桌面端产品配置里的
 * `networkEnvironment=external` 属于另一层语义，原样透传就会让 CLI 去找
 * 不存在的 `product.external.json`。
 */
export const CLI_ENVIRONMENTS = ['internal', 'ioa', 'cloudhosted', 'selfhosted'] as const;
export type CliEnvironment = (typeof CLI_ENVIRONMENTS)[number];

export function isCliEnvironment(v: unknown): v is CliEnvironment {
  return typeof v === 'string' && (CLI_ENVIRONMENTS as readonly string[]).includes(v);
}

export interface RuntimePlan {
  /** 是否显式声明 environment；false 时由 CLI / V3 配置自己决定 */
  environment?: string;
  endpoint?: string;
  reason: 'official-v3-config' | 'external-not-cli-env' | 'declared' | 'none';
}

/**
 * A216：决定「environment / endpoint 怎么给」，纯函数，便于闸门单测。
 *
 * 两条硬规矩（都有官方依据）：
 * 1. **二选一**：TypeScript SDK 参考里 `unstable_v2_authenticate` 的
 *    `environment` 与 `endpoint` 明确二选一；同时传会让 CLI 在
 *    `ClientInternetEnviromentProductProvider` 里判定冲突（它自己会打
 *    `internet environment conflict` 并指出 V3 优先）。
 * 2. **有官方 V3 配置就别再替 CLI 猜环境**：注入 `ACC_PRODUCT_CONFIG_PATH`
 *    后，CLI 从配置自身读 `networkEnvironment` 和 authoritative `endpoint`
 *    （provider 优先级 20000 > 6005），我们再传一份 environment 只会制造冲突。
 *
 * 没有官方配置时才退回声明式（定义表兜底快照）：这时保留原有两者并传，
 * 因为 A155 实测过「只改环境/端点、不指配置根 → initialize 超时 174s」，
 * 兜底路径不能凭文档推断就改掉。
 */
export function planSdkRuntime(input: {
  environment?: string;
  endpoint?: string;
  hasProductConfig?: boolean;
}): RuntimePlan {
  const endpoint = input.endpoint?.trim() || undefined;
  if (input.hasProductConfig) {
    return { endpoint, reason: 'official-v3-config' };
  }
  if (input.environment === 'external') {
    // 没有 V3 配置可依，CLI 又没有 product.external.json：只给端点，
    // 让它用默认 product.json，而不是找一个必然不存在的文件。
    return { endpoint, reason: 'external-not-cli-env' };
  }
  if (input.environment) {
    return { environment: input.environment, endpoint, reason: 'declared' };
  }
  return { endpoint, reason: endpoint ? 'declared' : 'none' };
}

/** `~` / `~/xxx` → 用户主目录。其它路径原样返回（不猜、不做 %VAR% 展开） */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function resolveSdkRuntime(spec?: SdkSpec): SdkRuntime {
  const env: Record<string, string> = { ...(spec?.env ?? {}) };
  if (spec?.configDir) env.CODEBUDDY_CONFIG_DIR = expandHome(spec.configDir);

  // A216：优先让 CLI 读官方自己的产品配置。变量名不是我们猜的 —— 官方配置
  // 快照里 `productConfigPathEnv` 写死了 `ACC_PRODUCT_CONFIG_PATH`，打包 CLI
  // 的 `resolveAuthoritativeFieldsFromConfigFile()` 也确实按它读文件。
  // 读不到就**不注入**（并告警）：指一个不存在的文件比不指更糟，CLI 会静默
  // 拿不到 authoritative endpoint，又退回按 environment 猜 product 文件。
  const configPath = spec?.productConfigPath ? expandHome(spec.productConfigPath) : null;
  const hasProductConfig = Boolean(configPath && fs.existsSync(configPath));
  if (hasProductConfig && configPath) {
    env.ACC_PRODUCT_CONFIG_PATH = configPath;
  } else if (spec?.productConfigPath) {
    console.warn('[SDK] A216：官方产品配置快照不可读，回落到声明式 environment/endpoint');
  }

  const plan = planSdkRuntime({
    environment: spec?.environment,
    endpoint: spec?.endpoint,
    hasProductConfig,
  });
  // A231-C：WorkBuddy 模型网关按 UA 区分客户端形态，对 SDK 注入的
  // `User-Agent: CodeBuddy Agent SDK/...` 一律回 401 Authentication required
  // （2026-11-15 真机二分：换 CLI 自己的 UA / 任意非 SDK UA 均通过）。
  // transport 的 buildArgs 只会在我们已有的值**前面**前缀 SDK UA，而 CLI 的
  // parseCustomHeaders 按「同名后出现者覆盖」解析 —— 给一个 CLI 形态的 UA
  // 就能顶掉 SDK UA，把模型请求伪装回官方网关认识的普通 CLI。
  // 只在 spec 真的配置了产品身份时注入；空 spec / undefined 保持 env 干净
  // （a155 断言：不悄悄塞任何东西）。
  if (spec?.env || spec?.configDir || spec?.productConfigPath) {
    env.CODEBUDDY_CUSTOM_HEADERS = 'User-Agent: CodeBuddy Code/2.184.0';
  }
  return {
    ...(plan.environment ? { environment: plan.environment } : {}),
    ...(plan.endpoint ? { endpoint: plan.endpoint } : {}),
    env,
    // A231：见 SdkRuntime.settingSources 注释。SDK 不传时写死 none，必须显式给。
    settingSources: ['user'],
  };
}

/**
 * A231：`unstable_v2_authenticate` 一族子进程的启动参数。
 *
 * 会话/one-shot 的 `settingSources` 能走选项透传，但 auth.js 只解构十个字段，
 * 不透传它 —— 登录类子进程仍按 SDK 默认 `--setting-sources none` 跑，登录态
 * 照样看不见。所以探测 / 登录流 / check-login 的 authenticate 调用一律改用
 * `executable/executableArgs` 指向设置源 shim（sdk-settings-shim.cjs），由它在
 * argv 层把 none 改回 user —— 与 CLI 自己默认的 user,project,local 对齐。
 *
 * `ELECTRON_RUN_AS_NODE=1` 与 kb-mcp 同一处置：打包态下 process.execPath 是
 * 应用 exe，必须让它以 Node 模式跑 shim；普通 node 进程里该变量无副作用。
 */
export function sdkAuthChildFor(runtime: SdkRuntime): {
  executable: string;
  executableArgs: string[];
  env: Record<string, string>;
} {
  return {
    executable: process.execPath,
    executableArgs: [resolveSdkSettingsShim()],
    env: { ...runtime.env, ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * 定位设置源 shim 的真实路径。三级回退，与 kb-mcp 的解析同构：
 *   1. 打包态：`resources/app.asar.unpacked/dist-electron/sdk-settings-shim.cjs`；
 *   2. 开发态已构建：仓库 `dist-electron/sdk-settings-shim.cjs`；
 *   3. 开发态未构建：源码 `server/agents/adapters/sdk-settings-shim.cjs`。
 */
export function resolveSdkSettingsShim(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const unpacked = resources
    ? path.join(resources, 'app.asar.unpacked', 'dist-electron', 'sdk-settings-shim.cjs')
    : null;
  const candidates = [
    ...(unpacked ? [unpacked] : []),
    path.join(process.cwd(), 'dist-electron', 'sdk-settings-shim.cjs'),
    path.join(process.cwd(), 'server', 'agents', 'adapters', 'sdk-settings-shim.cjs'),
  ];
  const hit = candidates.find(p => fs.existsSync(p));
  if (!hit) {
    // 大声失败：静默回退会让探测重新变成「永远未登录」的假象
    throw new Error(`[SDK] sdk-settings-shim.cjs 未找到（已依次尝试：${candidates.join('、')}）`);
  }
  return hit;
}

/**
 * 把 asar 内的路径改写成它在磁盘上的真实位置（`app.asar` → `app.asar.unpacked`）。
 *
 * ## 为什么必须做这一步
 *
 * SDK 自带的平台二进制（`claude.exe` / `codex.exe`）体积大、且要自己 spawn
 * 同目录的兄弟进程，electron-builder 的 smartUnpack 会把**整个模块目录**解到
 * `app.asar.unpacked/`。但解析那一侧（`require.resolve` + `readdirSync`）拿到的
 * 仍是 `app.asar/...` 路径，而 Electron 的 fs 垫片让 `existsSync` 对这类路径
 * **返回 true** —— 于是「探测」认为装好了，「执行」却直接 ENOENT。
 *
 * 本机实测（release/win-unpacked，2026-10-31）：
 * ```
 * app.asar/node_modules/@anthropic-ai/.../claude.exe   existsSync=true   spawn=ENOENT
 * app.asar.unpacked/node_modules/.../claude.exe        existsSync=true   spawn=0 → "2.1.316 (Claude Code)"
 * ```
 * 这就是「dev 能用、装完不能用」的典型形状：开发态没有 asar，一切正常。
 *
 * 只在目标路径真的存在时才改写，否则原样返回 —— 打包配置里没解包的文件
 * 不该被凭空指到一个不存在的路径上。
 */
export function toUnpackedPath(p: string): string {
  if (!p.includes('app.asar')) return p;
  const candidate = p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (candidate === p) return p;
  try {
    return fs.existsSync(candidate) ? candidate : p;
  } catch {
    return p;
  }
}
