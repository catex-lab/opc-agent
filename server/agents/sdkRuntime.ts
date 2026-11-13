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
  return {
    ...(plan.environment ? { environment: plan.environment } : {}),
    ...(plan.endpoint ? { endpoint: plan.endpoint } : {}),
    env,
  };
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
