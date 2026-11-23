/**
 * Claude SDK 本体的「用户自装」定位（2026-11-23，合规改造）。
 *
 * ## 为什么需要这个模块
 *
 * `@anthropic-ai/claude-agent-sdk` 本体是专有许可（All rights reserved），
 * 为规避再分发风险，已从安装包排除，改为**用户自行 `npm i` 安装**。
 * 应用全程不碰副本、不代下载，只在运行时定位用户已装的那一份。
 *
 * ## 为什么动态 import 找不到它
 *
 * `import('@anthropic-ai/claude-agent-sdk')` 按 Node 模块解析走 node_modules，
 * 而用户全局装的包不在 app.asar/node_modules 里；ESM 的 import() 又不认
 * NODE_PATH。所以必须先解析出 `sdk.mjs` 的**绝对路径**，再用 file:// URL import。
 *
 * ## 探测顺序（先显式、后自动）
 *
 *   1. `OPC_CLAUDE_SDK_PATH` 环境变量 —— 用户显式指定，最可靠，也覆盖任意位置；
 *   2. `npm root -g` 的全局 node_modules —— `npm i -g` 的标准落点；
 *   3. 若干常见本地目录的 node_modules —— 用户在项目里 `npm i` 的情况。
 *
 * 每一项都验证 `sdk.mjs` 真实存在才返回，绝不凭目录存在就当已安装（假绿）。
 * 所有探测逻辑集中在 `claudeSdkEntryCandidates()` 纯函数里，`locateClaudeSdk()`
 * 只负责执行 stat —— 便于闸门用临时目录穷举各分支。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** SDK 包名（与 package.json / 引导文案一致） */
export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
/** 包内 ESM 入口（package.json 的 main 字段，2026-11-23 实测） */
const SDK_ENTRY = 'sdk.mjs';

/**
 * 纯函数：按优先级列出所有候选入口路径（绝对路径，未验证存在）。
 *
 * @param opts.home 用户主目录（探测本地 node_modules 用）
 * @param opts.cwd  当前工作目录（用户在项目里 npm i 的情况）
 * @param opts.explicit 环境变量指定的路径（可指向 sdk.mjs 或包目录）
 * @param opts.globalRoot `npm root -g` 的输出；传 null 表示探测不到/不探测
 */
export function claudeSdkEntryCandidates(opts: {
  home?: string;
  cwd?: string;
  explicit?: string | null;
  globalRoot?: string | null;
}): string[] {
  const out: string[] = [];
  const push = (p: string) => { if (p && !out.includes(p)) out.push(p); };

  // 1. 显式指定：既接受直接指向 sdk.mjs，也接受指向包目录
  if (opts.explicit) {
    const e = path.resolve(opts.explicit);
    push(path.basename(e) === SDK_ENTRY ? e : path.join(e, SDK_ENTRY));
  }

  // 2. 全局 node_modules
  if (opts.globalRoot) {
    push(path.join(opts.globalRoot, CLAUDE_SDK_PACKAGE, SDK_ENTRY));
  }

  // 3. 常见本地位置：cwd 与 home 下若干约定目录
  const locals = [
    opts.cwd,
    opts.cwd && path.join(opts.cwd, 'node_modules'),
    opts.home && path.join(opts.home, 'node_modules'),
    opts.home && path.join(opts.home, '.opc', 'node_modules'),
  ].filter(Boolean) as string[];
  for (const base of locals) {
    // 兼容两种写法：base 已是 node_modules，或 base 是包父目录
    push(path.join(base, CLAUDE_SDK_PACKAGE, SDK_ENTRY));
    if (path.basename(base) !== 'node_modules') {
      push(path.join(base, 'node_modules', CLAUDE_SDK_PACKAGE, SDK_ENTRY));
    }
  }
  return out;
}

/** 运行 `npm root -g`，失败/超时返回 null（不抛，探测失败不是错误） */
function detectGlobalRoot(): string | null {
  try {
    return execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['root', '-g'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 定位用户自装的 SDK 入口，返回可用于 import() 的 file:// URL。
 * 找不到返回 null —— 调用方据此给出「请先安装」引导，而非崩溃。
 */
let cached: { entry: string; url: string } | null | undefined;

export function locateClaudeSdk(): { entry: string; url: string } | null {
  if (cached !== undefined) return cached;
  const candidates = claudeSdkEntryCandidates({
    home: process.env.USERPROFILE || process.env.HOME,
    cwd: process.cwd(),
    explicit: process.env.OPC_CLAUDE_SDK_PATH,
    globalRoot: detectGlobalRoot(),
  });
  for (const entry of candidates) {
    try {
      if (fs.statSync(entry).isFile()) {
        cached = { entry, url: pathToFileURL(entry).href };
        return cached;
      }
    } catch { /* 不存在就试下一个 */ }
  }
  // 不缓存「未找到」：用户装好 SDK 后无需重启，下一次探测会重新找。
  // npm root -g 有 3s 超时，但这只发生在真正未安装时，属可接受的探测成本。
  return null;
}

/** 仅供闸门/测试：清空定位缓存 */
export function resetClaudeSdkCache(): void {
  cached = undefined;
}

/** 给引导文案用的安装命令（用户在自己机器上执行，应用不代劳） */
export const CLAUDE_SDK_INSTALL_HINT = `npm install -g ${CLAUDE_SDK_PACKAGE}`;
