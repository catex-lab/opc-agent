/**
 * SDK 运行参数（A155）：把定义表里的 `SdkSpec` 展开成 SDK 真正认的
 * `{ environment, endpoint, env }`。
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
  /** 产品环境；undefined 时由 CLI 按默认（external）处理 */
  environment?: 'internal' | 'external';
  /** 显式端点；undefined 时由 CLI 按环境自己选 */
  endpoint?: string;
  /** 注入给 CLI 子进程的环境变量（只含我们显式要设的，SDK 会与 process.env 合并） */
  env: Record<string, string>;
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
  return {
    ...(spec?.environment ? { environment: spec.environment } : {}),
    ...(spec?.endpoint ? { endpoint: spec.endpoint } : {}),
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
