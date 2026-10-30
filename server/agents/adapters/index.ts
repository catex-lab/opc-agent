/**
 * 适配器工厂：按 Agent 定义里的 kind 选择实现。
 *
 * 这里是「新增一个 Agent」的唯一分叉点。上层业务代码永远只看到 AgentProvider，
 * 不需要知道背后是 SDK、子进程还是 ACP。
 */

import { CliAdapter } from './cli.js';
import { SdkAdapter } from './sdk.js';
import { AcpAdapter } from './acp.js';
import { HttpAdapter } from './http.js';
import { MockAdapter } from './mock.js';
import type { AgentDefinition } from '../definitions.js';
import type { AgentProvider } from '../types.js';

export function createProvider(def: AgentDefinition): AgentProvider {
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

export { CliAdapter, SdkAdapter, AcpAdapter, HttpAdapter, MockAdapter };
