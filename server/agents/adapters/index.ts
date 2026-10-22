/**
 * 适配器工厂：按 Agent 定义里的 kind 选择实现。
 *
 * 这里是「新增一个 Agent」的唯一分叉点。上层业务代码永远只看到 AgentProvider，
 * 不需要知道背后是 SDK、子进程还是 ACP。
 *
 * ## 为什么 `sdk` 规格的分叉写在 kind 之前（A76）
 *
 * `def.sdk` 不是第二种接入方式，而是同一 kind 上的**通道升级**：
 * Qoder SDK 的 `ProcessTransport` 干的事就是「在本机拉起 qodercli 子进程再走
 * 双向 JSONL 协议」—— 底层可执行文件与 `CliAdapter` 完全相同，只是协议不同。
 *
 * 所以它不改 `kind`（改了会让前端按 `kind === 'sdk'` 去用平台模型列表，
 * 见 definitions.ts 里 `SdkSpec` 的说明），而是作为一个可选能力挂在同一条
 * 定义上：有它就先试 SDK，握手失败自动回退 `CliAdapter`。
 */

import { CliAdapter } from './cli.js';
import { SdkAdapter } from './sdk.js';
import { QoderSdkAdapter } from './qoder-sdk.js';
import { AcpAdapter } from './acp.js';
import { HttpAdapter } from './http.js';
import { MockAdapter } from './mock.js';
import type { AgentDefinition } from '../definitions.js';
import type { AgentProvider } from '../types.js';

export function createProvider(def: AgentDefinition): AgentProvider {
  // ① 厂商 SDK 通道（优先）。只有声明了 sdk 规格的条目会走到这里。
  if (def.sdk) return new QoderSdkAdapter(def);

  switch (def.descriptor.kind) {
    case 'sdk':
      return new SdkAdapter(def.descriptor);
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

export { CliAdapter, SdkAdapter, QoderSdkAdapter, AcpAdapter, HttpAdapter, MockAdapter };
