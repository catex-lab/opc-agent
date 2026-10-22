/**
 * 安装前置条件的本机探测（A71）。
 *
 * ## 为什么需要它
 *
 * `npm i -g @openai/codex` 这条命令在**没有 Node 的机器上必然失败**。而本应用
 * 的安装包里不带 node（打包产物 `resources/` 只有 app.asar 与 elevate.exe，
 * 已实查），所以「新用户装完应用 → 点复制命令 → 粘到终端 → 报 command not found」
 * 是默认路径，不是边缘情况。
 *
 * 与其让用户撞一次墙，不如在按钮旁边就写清楚「本机没有 Node，先装 Node」。
 *
 * ## 为什么**不**起子进程取版本号
 *
 * 第一版用 `probeVersion()` 跑 `node -v`，想着「Node v22.22.2」比一个布尔值有用。
 * 实测把这个特性整个拖死了：探测要起子进程，一旦 spawn 不返回（权限被拦、
 * 安全策略拒绝、终端环境异常），`detect()` 就**永远不 settle** ——
 * `installEnv()` 的 promise 挂着，缓存永远不写，`installEnvCache` 一直是 undefined，
 * 于是「本机没有 Node」这行提示一次都没出现，而且**没有任何报错**。
 *
 * 一个"可选的美化信息"把"必要的功能"拖死，是最差的交换。所以这里只做
 * **PATH 查找**（纯文件系统，必然立即返回）：
 *   - 界面上要回答的问题只是"这条命令跑不跑得起来"，不是"你装的是哪个版本"；
 *   - 真要显示版本，让用户自己在终端跑 `node -v`，我们不承担这个风险。
 *
 * ## 三条纪律
 *
 * 1. **只探两样东西**：`node` 与 `powershell`。这两样决定 `requires` 的三种取值，
 *    多探一样就多一份开销（每次刷新名册都会问）。
 * 2. **探测结果有缓存**（60s）。`/api/agents` 会被反复拉取，不缓存等于每次刷新名册
 *    都扫一遍 PATH。
 * 3. **探不到就说探不到**，不猜。`ok:false` 只表示"PATH 里没找到"，
 *    界面上要这么写，不能写成"你没有装 Node"（可能只是没进 PATH）。
 */

import { findExecutable } from './probe.js';
import type { InstallEnv } from './types.js';

/** 缓存有效期：60s。装完 Node 之后用户点「重新检测」不必等太久 */
const TTL_MS = 60_000;

let cache: { at: number; env: InstallEnv } | null = null;

function detect(): InstallEnv {
  // 纯文件系统查找，不起任何子进程 —— 保证这个函数必然立即返回。
  // `powershell` 找不到时再试 `pwsh`（PowerShell 7 的可执行名），
  // 非 Windows 上两个都没有，如实报 false。
  return {
    node: { ok: Boolean(findExecutable('node')) },
    powershell: { ok: Boolean(findExecutable('powershell') ?? findExecutable('pwsh')) },
  };
}

/**
 * 取本机安装环境（带 60s 缓存）。
 *
 * 同步、**不 reject**、不可能挂住：`detect()` 只做 PATH 查找。最坏情况返回
 * 「都没有」，界面上表现为「没有这行提示」—— 探测失败不该让名册接口挂掉，
 * 更不该让界面上出现一个猜出来的结论。
 *
 * 不再需要 inflight 去重：探测便宜到没有并发问题（第一版要起子进程才需要）。
 */
export function installEnv(): InstallEnv {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.env;
  const env = detect();
  cache = { at: Date.now(), env };
  return env;
}

/** 只给测试用：清掉缓存，让下一次调用重新探测 */
export function resetInstallEnvCache(): void {
  cache = null;
}
