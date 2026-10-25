/**
 * 用户自建 Agent（A114）。
 *
 * ## 它解决什么问题
 *
 * 内置的 14 条覆盖的是「有 CLI / 官方 SDK」的 Agent。但用户手上往往还有另一类
 * 东西：一个 OpenAI 兼容的 HTTP 端点 —— DeepSeek、智谱、SiliconFlow、
 * OpenRouter、公司内网网关、本地 Ollama / vLLM。它们没有 CLI，也不在收录名单里，
 * 于是「我想让这个模型也出现在通讯录里」这件事此前完全做不到。
 *
 * ## 为什么复用 http 适配器，而不是新写一条链路
 *
 * 自建 Agent 的形态与豆包 / Kimi **完全同构**：一个 baseUrl + 一把 Key + 一个
 * 模型名，走 OpenAI chat/completions。`adapters/http.ts` 已经处理了方言、SSE
 * 解析、代理隧道、超时与取消。所以这里只做「把用户的输入合成一条
 * `AgentDefinition`」，**适配器零改动** —— 改动越少，两条链路行为分叉的机会越少。
 *
 * ## 为什么只支持 OpenAI 兼容方言
 *
 * Anthropic 原生协议的请求体要 `max_tokens`（无默认值）、消息结构与 OpenAI
 * 不通用，Gemini 的 URL 要把模型名嵌进路径（与「用户可填任意模型」冲突）。
 * 三种里只有 OpenAI 形态是事实标准，绝大多数平台都提供 `/v1/chat/completions`。
 * 剩下两种留到真有需求时再加 —— 现在硬上只会多两条没验证过的路径。
 *
 * ## 为什么 Key 不落在本文件里
 *
 * `custom-agents.json` 只存**定义**（名称 / 地址 / 模型），Key 一律进
 * `agent-credentials.json`（`saveCredential()`），由既有的
 * `loadAgentCredentials()` 在启动时注入 `process.env`。两个理由：
 *   1. 一份纯定义的文件可以备份、可以发给别人看，不带密钥；
 *   2. 设置页「登录配置」分区因此能直接编辑自建 Agent 的 Key ——
 *      换 Key 不必删掉重建，那条路上已经有完整的保存 / 清除 / 掩码逻辑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirPath } from '../paths.js';
import type { AgentDefinition } from './definitions.js';

/** 一条自建 Agent 的定义（**不含 Key**） */
export interface CustomAgentSpec {
  /** `custom-<uuid 前 8 位>`。同时作为 id 与凭据变量名后缀，必须稳定 */
  id: string;
  name: string;
  /** 归一化后的根地址，不带尾斜杠。例：`https://api.deepseek.com/v1` */
  baseUrl: string;
  model: string;
  createdAt: number;
}

/** 落盘位置。与 agent-credentials.json 同目录：密钥之外的配置也归 data/ 管 */
const STORE_PATH = path.join(dataDirPath, 'custom-agents.json');

/** 名称上限：通讯录一行放不下更长的，超了会被截成省略号 */
const MAX_NAME_LEN = 20;

/**
 * 每条自建 Agent 专属的 Key 变量名。
 *
 * 必须是合法环境变量名：uuid 里的连字符换成下划线并转大写。
 * 之所以每条一个名字而不是复用固定名（如 `CUSTOM_API_KEY`）：固定名只能持一把
 * Key，用户加第二个自建 Agent 就会把第一个的顶掉 —— 而这种覆盖是静默的。
 */
export function customKeyEnv(id: string): string {
  return `OPC_CUSTOM_KEY_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** 用户提交的原始字段（创建时用） */
export interface CustomAgentInput {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type NormalizeResult =
  | { ok: true; value: Omit<CustomAgentInput, 'apiKey'> }
  | { ok: false; error: string };

/**
 * 校验并归一化用户输入（不含 Key —— Key 单独验，因为它要进另一份存储）。
 *
 * 单独抽成纯函数（不碰盘）是为了让验证脚本能直接跑边界用例：
 * 空名称、坏 URL、缺模型、尾斜杠、http 与 https 混用。
 */
export function normalizeCustomInput(raw: unknown): NormalizeResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = String(r.name ?? '').trim();
  const baseUrl = String(r.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(r.model ?? '').trim();

  if (!name) return { ok: false, error: '请填写名称' };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `名称不能超过 ${MAX_NAME_LEN} 个字` };
  }
  if (!baseUrl) return { ok: false, error: '请填写 API 地址' };
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'API 地址只支持 http / https' };
    }
    if (!u.hostname) return { ok: false, error: 'API 地址缺少主机名' };
  } catch {
    return { ok: false, error: 'API 地址不是合法 URL' };
  }
  if (!model) return { ok: false, error: '请填写模型名' };
  return { ok: true, value: { name, baseUrl, model } };
}

function readStore(): CustomAgentSpec[] {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    // 文件不存在 = 还没建过。**不要**因此覆盖原文件 —— 解析失败时用户配的
    // Agent 还在，覆盖等于静默销毁它（与 agent-credentials 同一处理）。
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[CustomAgents] custom-agents.json 解析失败，按「没有自建 Agent」处理');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // 逐条校验，坏条目跳过而不是整份作废：一条写坏了不该让其他自建 Agent 全部消失
  const out: CustomAgentSpec[] = [];
  for (const item of parsed) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = String(r.id ?? '').trim();
    const name = String(r.name ?? '').trim();
    const baseUrl = String(r.baseUrl ?? '').trim().replace(/\/+$/, '');
    const model = String(r.model ?? '').trim();
    if (!id || !name || !baseUrl || !model) continue;
    out.push({ id, name, baseUrl, model, createdAt: Number(r.createdAt) || Date.now() });
  }
  return out;
}

function writeStore(list: CustomAgentSpec[]): void {
  // 先写临时文件再 rename：半路崩掉不会把原文件截断成空
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，失败不影响功能 */
  }
}

/** 全部自建 Agent 的定义 */
export function loadCustomSpecs(): CustomAgentSpec[] {
  return readStore();
}

/** 新建一条并落盘。Key 由调用方走 `saveCredential()` 另外存 */
export function createCustomSpec(input: Omit<CustomAgentInput, 'apiKey'>): CustomAgentSpec {
  const spec: CustomAgentSpec = {
    id: `custom-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    ...input,
    createdAt: Date.now(),
  };
  const list = readStore();
  list.push(spec);
  writeStore(list);
  return spec;
}

/** 删除一条。返回是否真的删掉了（幂等：删不存在的东西不算错误） */
export function deleteCustomSpec(id: string): boolean {
  const list = readStore();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  writeStore(next);
  return true;
}

/**
 * 把一条自建配置合成 `AgentDefinition`。
 *
 * 形态刻意对齐豆包 / Kimi 那两条 http 条目：`kind: 'http'`、只标 chat/write、
 * `eventCapabilities: []`。**不能**标 code / tools —— 没有工具调用循环，
 * 标了就是谎称能读写文件、能跑命令（adapters/http.ts 顶部第一条边界）。
 */
export function customSpecToDefinition(spec: CustomAgentSpec): AgentDefinition {
  const host = new URL(spec.baseUrl).hostname;
  const keyEnv = customKeyEnv(spec.id);
  return {
    descriptor: {
      id: spec.id,
      name: spec.name,
      vendor: '自建',
      kind: 'http',
      // 名册页据此给一个「删除」入口，并把 Key 输入框指向「登录配置」分区
      custom: true,
      capabilities: ['chat', 'write'],
      eventCapabilities: [],
      description: `自建 Agent：${spec.model}（OpenAI 兼容接口）`,
      color: '#6C8CFF',
      command: 'HTTP API',
      installHint: '在通讯录「+ → 自定义 Agent」里创建；删除后可在同一入口重建',
    },
    http: {
      dialect: 'openai',
      url: `${spec.baseUrl}/chat/completions`,
      host,
      defaultModel: spec.model,
    },
    authEnvs: [keyEnv],
    backendHosts: [host],
    models: [spec.model],
    defaultModel: spec.model,
    credential: {
      keyEnv: [keyEnv],
      hint: '创建时填写的 API Key，也可在「登录配置」分区随时更换',
    },
  };
}
