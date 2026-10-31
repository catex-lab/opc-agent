/**
 * 适配器工厂：按 Agent 定义里的 kind 选择实现。
 *
 * 这里是「新增一个 Agent」的唯一分叉点。上层业务代码永远只看到 AgentProvider，
 * 不需要知道背后是 SDK、子进程还是 ACP。
 */

import { CliAdapter } from './cli.js';
import { SdkAdapter } from './sdk.js';
import { ClaudeSdkAdapter } from './claude-sdk.js';
import { CodexSdkAdapter } from './codex-sdk.js';
import { AcpAdapter } from './acp.js';
import { HttpAdapter } from './http.js';
import { MockAdapter } from './mock.js';
import type { AgentDefinition } from '../definitions.js';
import type { AgentProvider } from '../types.js';

/**
 * A156：SDK 通道按 `def.sdk.provider` 选工厂。
 *
 * 为什么不能只靠 kind：kind 是「接入形态」（sdk / cli / acp / http），
 * 而 claude / codex 用的是**不同厂商的 SDK**，各有自己的包、纸质与生命周期。
 * 把它们都塞进 SdkAdapter 就得在那个文件里再分叉一次，那才是真正的乱。
 * 缺省 `tencent` 保留旧行为：没写 provider 的条目仍然走 CodeBuddy/WorkBuddy SDK。
 *
 * 没写 provider 却声明了别的厂商 —— 不可能，类型上 provider 是显式联合；
 * 走到 default 说明定义表写错了，回退 tencent 至少还能让人看见它。
 */
function sdkProvider(def: AgentDefinition): AgentProvider {
  switch (def.sdk?.provider) {
    case 'claude':
      return new ClaudeSdkAdapter(def);
    case 'codex':
      return new CodexSdkAdapter(def);
    case 'tencent':
    default:
      return new SdkAdapter(def);
  }
}

export function createProvider(def: AgentDefinition): AgentProvider {
  switch (def.descriptor.kind) {
    case 'sdk':
      // A155：传完整 def —— 适配器要读 `def.sdk`（environment / endpoint /
      // configDir），只传 descriptor 就拿不到产品规格，会退回被写死的
      // external + 默认配置根，把 WorkBuddy 接到 CodeBuddy 国际站上去。
      return sdkProvider(def);
    case 'cli':
      // 声明了 cli 却拿不到调用规格，只能降级为占位
      return def.cli ? new CliAdapter(def) : new MockAdapter(def);
    case 'acp':
      return new AcpAdapter(def);
    case 'http':
      // 同理：没给 http 规格就不能真的去发请求
      return def.http ? new HttpAdapter(def) : new MockAdapter(def);
    case 'mock':
    default:
      return new MockAdapter(def);
  }
}

export { CliAdapter, SdkAdapter, AcpAdapter, HttpAdapter, MockAdapter };
