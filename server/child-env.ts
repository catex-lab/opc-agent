/**
 * Agent 子进程环境：**本机 API token 绝不外传**。
 *
 * harness 主进程把 `OPC_LOCAL_TOKEN` 放进自己的 env，供 server 校验本机请求。
 * 但 CLI / ACP / 探测子进程是「跑用户 Agent 的不可信代码」——提示词注入、
 * 恶意脚本或被劫持的第三方 CLI 都能读自己的 env。若token 顺着
 * `...process.env` 传下去，对方就能直接调全部本机 API（P0-02 的新缺口）。
 *
 * 这里集中收口所有 Agent 子进程的环境构造：先叠加调用方给的变量，
 * **最后**删除 token，避免上层 overlay 又把它带回来。
 *
 * 注意：SDK 通道由厂商 SDK 自己 spawn，不走这里的构造函数；
 * 那条链路的隔离属于遗留风险，见 HANDOFF/TRAPS。
 */
import { OPC_LOCAL_TOKEN_ENV } from '../shared/harness-protocol.js';

/** 构造给 Agent 子进程用的 env：process.env + extra，最后剔除本机 token。 */
export function agentChildEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env[OPC_LOCAL_TOKEN_ENV];
  return env;
}
