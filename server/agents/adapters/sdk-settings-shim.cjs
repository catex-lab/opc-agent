#!/usr/bin/env node
/**
 * A231：`--setting-sources none → user` 设置源改写 shim。
 *
 * ## 为什么存在这个文件
 *
 * SDK 的 `unstable_v2_authenticate` **不透传 `settingSources`**（auth.js 只
 * 解构 environment/endpoint/methodId/onAuthUrl/timeout/pathToCodebuddyCode/
 * env/executable/executableArgs 十个字段），所以登录类子进程永远拿 SDK 默认
 * 的 `--setting-sources none` 跑 —— 而 WorkBuddy CLI 的登录态（keyblob /
 * account）属于 **user 设置源**，none 会让 CLI「看不见登录态」：
 * 官方模型一律 `Authentication required`，探测永远报「未登录」。
 *
 * 会话类子进程不需要它（`settingSources: ['user']` 由 resolveSdkRuntime 显式
 * 传参即可，见 server/agents/sdkRuntime.ts）。只有 authenticate 一族的子进程
 * 走这里：通过 `executable/executableArgs`（SDK 唯一支持的透传入口）把我们
 * 自己包在 CLI 前面，在 argv 层把 SDK 默认值改回 CLI 自己的默认值
 * （--help 实测 CLI 默认 user,project,local）。
 *
 * ## 调用形态
 *
 * SDK spawn：`node shim.cjs <cliJs> [--原有的全部参数]`。
 * shim 重写 argv 后 `require(cliJs)` 原样执行：CLI 的 __dirname/__filename
 * 来自它自己的 CJS 包装器，不受 require 方影响；bundle 入口无 require.main
 * 守卫（已核对 dist/codebuddy-headless.js），启动链路与直接执行一致。
 *
 * ## 为什么不做成 TS / 不放进 bundle
 *
 * 它必须是一个**真实存在的脚本文件**（node/打包态 electron 要 spawn 它），
 * 不能被 esbuild 内联；同 kb-mcp.cjs 的处置：源码一份，build-electron.mjs
 * 拷到 dist-electron/，electron-builder.yml 的 asarUnpack 放行（见两处注释）。
 */
'use strict';

const [, , cliJs, ...rest] = process.argv;
if (!cliJs) {
  // 参数形状不对就大声失败，绝不静默放行 —— 静默放行等于回到「探测永远未登录」
  process.stderr.write('[sdk-settings-shim] 缺少 CLI 入口参数，期望 <cliJs> [args...]\n');
  process.exit(1);
}

// 只改写 --setting-sources（含 =none 形式），其余参数原样传递。
// 万一未来 SDK 修好默认值、不再传 none，这里不改写任何东西，shim 自动透明。
const args = [];
let sawSettingSources = false;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--setting-sources') {
    sawSettingSources = true;
    args.push(a, 'user');
    i += 1; // 吞掉 SDK 给的值（none）
    continue;
  }
  if (a.startsWith('--setting-sources=')) {
    sawSettingSources = true;
    args.push('--setting-sources=user');
    continue;
  }
  args.push(a);
}
// 防御：SDK 未来若以其它形式传 none（理论上不会走到），补一个显式 user 兜底
if (!sawSettingSources) {
  args.push('--setting-sources=user');
}

process.argv = [process.argv[0], cliJs, ...args];
require(cliJs);