/**
 * Harness 子进程入口（M01 / 绞杀者第 1 期，设计 §10.1 方案 A）。
 *
 * 职责刻意收窄到「壳」：144 条路由、6 个 SSE 端点、runHub 断线续传全部
 * 原样（startServer() 一行带过来），本文件只补三件跨进程才需要的事：
 *
 *   1. **stdout 握手**：监听成功后打一行 `@@OPC-HARNESS@@ {json}`（真实
 *      端口 + pid）。用前缀而不是裸 JSON，是因为 server 启动横幅与各模块
 *      日志都在往 stdout 打 —— main 只认带前缀的行，其余透传（排障可见）。
 *   2. **父进程死亡监听**：main 经 stdio[3] IPC 通道拉起本进程，通道关闭
 *      （main 正常退出 / 崩溃 / taskkill）→ `disconnect` → 走 shutdown
 *      收口（停调度 + 回收全部 agent 子进程），不留孤儿。这是「主进程
 *      退出时 harness 一并退出」的实现点。
 *   3. **退出清理复用**：SIGINT/SIGTERM 已由 server/index.ts 的 import
 *      注册到同一个 `shutdown()`，这里不重复挂。
 *
 * 启动期清算（runs 台账 interrupted sweep）在 `startServer()` 内部完成，
 * 两个进程形态（内联 / 子进程）语义一致。
 *
 * dev / 闸门：`npx tsx harness/index.ts`（ELECTRON_RUN_AS_NODE 不需要）。
 * 打包态：`dist-electron/harness.cjs` 由 main 以
 * `process.execPath + ELECTRON_RUN_AS_NODE=1` 拉起（照 kb-mcp 先例）。
 */

import { once } from 'node:events';
import { startServer, shutdown } from '../server/index.js';
import { HANDSHAKE_PREFIX, OPC_STDIN_PIPE_ENV } from '../shared/harness-protocol.js';

async function main(): Promise<void> {
  const srv = startServer();
  if (!srv) {
    // startServer 理论上不会返回 null（幂等内直接复用）， defensive：真发生
    // 就是模块初始化炸了，早死比装活好 —— main 的握手超时会接住并重启。
    throw new Error('startServer() 返回空 —— 服务端未能启动');
  }
  if (!srv.listening) await once(srv, 'listening');

  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : Number(process.env.PORT) || 3000;
  process.stdout.write(
    HANDSHAKE_PREFIX + JSON.stringify({ type: 'ready', port, pid: process.pid }) + '\n'
  );
}

// 父进程死亡 / main 主动断通道 → 收口退出。'disconnect' 只在有 IPC 通道且
// 通道关闭时触发（main 与闸门都以 stdio[3]='ipc' 拉起）。Node 在发事件前已把
// process.connected 置 false，事件本身即「通道已关」的事实。
//
// ⚠️ 实测（2026-11-20）：经 tsx 运行时（`tsx harness/index.ts`）'disconnect'
// 永远不触发 —— tsx CLI 会包一层进程，脚本挂在孙进程上，IPC 通道是 tsx 的
// 不是脚本的，stdin 同理。所以父死亡检测**只在打包产物**（harness.cjs，纯
// Node 形态）上生效；闸门因此用 esbuild 现打产物再测，不经 tsx。开发态
// electron:dev 用 dist-electron/harness.cjs（build:electron 先行），同样成立。
process.on('disconnect', () => {
  shutdown('parent-channel-closed');
});

// 兜底（纯 Node 直跑形态）：spawn 方显式声明「stdin 是我握着的管道」
// （OPC_HARNESS_STDIN_PIPE=1，manager 与闸门都会带）才挂监听 —— 管道关闭
// = 父死了。不猜 fd 类型：stdio 'ignore' 时 stdin 指向 /dev/null，'end'
// 会立刻误触发；终端 TTY 由 SIGINT 兜底。这两类都不带这个 env。
if (process.env[OPC_STDIN_PIPE_ENV] === '1' && process.stdin) {
  process.stdin.resume();
  const onGone = () => shutdown('parent-stdin-closed');
  process.stdin.once('end', onGone);
  process.stdin.once('close', onGone);
}

void main().catch(err => {
  console.error('[Harness] 启动失败:', err);
  process.exit(1);
});
