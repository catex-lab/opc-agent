/**
 * 子进程环境净化。
 *
 * 本服务通常被 WorkBuddy 桌面应用以子进程方式启动，因此会继承一批
 * 「应用内部专用」的环境变量。这些变量会被 SDK 再次透传给它启动的
 * Agent CLI 子进程，导致端口抢占、工具链异常等问题。
 *
 * 原理：SDK 在 process-transport.js 中以
 *   const env = { ...process.env, ...this.options.env }
 * 的方式构造子进程环境，所以必须在任何 SDK 调用之前从 process.env 中剔除。
 *
 * 本模块有副作用，必须作为 server/index.ts 的第一个 import。
 */

/**
 * 必须剔除的环境变量及其原因。
 */
const STRIP_VARS: Array<{ key: string; reason: string }> = [
  {
    key: 'SERVER__PORT',
    reason: 'WorkBuddy 内部服务端口，透传后 Agent CLI 会抢绑同一端口（EADDRINUSE）',
  },
  {
    key: 'SERVER__HOST',
    reason: '同上，配套的监听地址',
  },
  {
    key: 'NODE_OPTIONS',
    reason: '注入了 node-language-shim，会 hook fs.rm 等 API，破坏子进程工具链',
  },
];

/**
 * 从 process.env 中剔除应用内部变量。
 * @returns 实际被剔除的变量名
 */
export function sanitizeEnv(): string[] {
  const removed: string[] = [];
  for (const { key } of STRIP_VARS) {
    if (process.env[key] !== undefined) {
      delete process.env[key];
      removed.push(key);
    }
  }
  return removed;
}

/** 返回被管理变量的说明，供前端/接口展示 */
export function describeStrippedVars(): Array<{ key: string; reason: string }> {
  return STRIP_VARS.map(v => ({ ...v }));
}

// —— 模块加载即生效 ——
const removed = sanitizeEnv();
if (removed.length > 0) {
  console.log(`[Env] 已剔除继承的应用内部环境变量: ${removed.join(', ')}`);
}

export default sanitizeEnv;
