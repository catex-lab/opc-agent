/**
 * 用户自建模型厂商（A114 起，A129 扩展为「一个厂商 = 一组模型」）。
 *
 * ## 它解决什么问题
 *
 * 内置的十几条覆盖的是「有 CLI / 官方 SDK」的 Agent。但用户手上往往还有另一类
 * 东西：一个 OpenAI / Anthropic / Gemini 兼容的 HTTP 端点 —— DeepSeek、智谱、
 * SiliconFlow、OpenRouter、公司内网网关、本地 Ollama / vLLM。它们没有 CLI，
 * 也不在收录名单里。
 *
 * ## 为什么一个厂商带一组模型
 *
 * A114 当初是「一条配置 = 一个模型」，结果同一个网关接两个模型就在通讯录里
 * 多出两条几乎一样的联系人（用户实测：`商汤` 和 `测试` 指向同一个地址）。
 * 模型名是子资源，不是身份。现在定义里存 `models[]`，通讯录一条厂商，
 * 输入框上方的模型下拉列出它全部模型。
 *
 * ## 为什么复用 http 适配器
 *
 * 自建厂商的形态与豆包 / Kimi **完全同构**：地址 + Key + 模型名。适配器已经
 * 处理了三种方言、SSE 解析、代理隧道、超时与取消。这里只负责把用户输入
 * 合成 `AgentDefinition`，**适配器零分叉** —— 改动越少，两条链路行为分叉的
 * 机会越少。
 *
 * ## 为什么 Key 不落在本文件里
 *
 * `custom-agents.json` 只存**定义**（名称 / 地址 / 方言 / 模型），Key 一律进
 * `agent-credentials.json`（`saveCredential()`）。一份纯定义的文件可以备份、
 * 可以发给别人看，不带密钥。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirPath } from '../paths.js';
import type { AgentDefinition } from './definitions.js';
import {
  chatUrlOf,
  dialectLabel,
  isProviderDialect,
  normalizeBaseUrl,
  type ProviderDialect,
} from '../../shared/providerUrl.js';

/** 一条自建厂商的定义（**不含 Key**） */
export interface CustomAgentSpec {
  /** `custom-<uuid 前 8 位>`。同时作为 id 与凭据变量名后缀，必须稳定 */
  id: string;
  name: string;
  /** 归一化后的根地址，不带尾斜杠。例：`https://api.deepseek.com/v1` */
  baseUrl: string;
  dialect: ProviderDialect;
  /** 该厂商可用的模型 ID。第一条同时作为默认模型 */
  models: string[];
  createdAt: number;
}

/** 落盘位置。与 agent-credentials.json 同目录：密钥之外的配置也归 data/ 管 */
const STORE_PATH = path.join(dataDirPath, 'custom-agents.json');

/** 名称上限：通讯录一行放不下更长的，超了会被截成省略号 */
const MAX_NAME_LEN = 20;
/** 一个厂商最多挂多少个模型：够覆盖常见网关，又不至于把下拉撑爆 */
const MAX_MODELS = 50;
/** 单个模型 ID 的长度上限。真实的 ID 很少有超过 80 字符的 */
const MAX_MODEL_LEN = 200;

/**
 * 每条自建厂商专属的 Key 变量名。
 *
 * 必须是合法环境变量名：uuid 里的连字符换成下划线并转大写。
 * 之所以每条一个名字而不是复用固定名（如 `CUSTOM_API_KEY`）：固定名只能持一把
 * Key，用户加第二个厂商就会把第一个的顶掉 —— 而这种覆盖是静默的。
 */
export function customKeyEnv(id: string): string {
  return `OPC_CUSTOM_KEY_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** 用户提交的原始字段（创建/编辑时用） */
export interface CustomAgentInput {
  name: string;
  baseUrl: string;
  dialect: ProviderDialect;
  models: string[];
  apiKey?: string;
}

export type NormalizeResult =
  | { ok: true; value: Omit<CustomAgentInput, 'apiKey'> }
  | { ok: false; error: string };

/** 模型清单既接受数组，也接受「一行一个 / 逗号分隔」的字符串 */
function parseModels(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\n,]+/)
      : [];
  const out: string[] = [];
  for (const item of items) {
    const v = String(item ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 校验并归一化用户输入（不含 Key —— Key 单独验，因为它要进另一份存储）。
 *
 * 单独抽成纯函数（不碰盘）是为了让验证脚本能直接跑边界用例：
 * 空名称、坏 URL、缺模型、尾斜杠、完整端点、http 与 https 混用。
 */
export function normalizeCustomInput(raw: unknown): NormalizeResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = String(r.name ?? '').trim();
  const baseUrl = normalizeBaseUrl(String(r.baseUrl ?? ''));
  const dialect = isProviderDialect(r.dialect) ? r.dialect : 'openai';
  const models = parseModels(r.models ?? r.model);

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
  if (models.length === 0) return { ok: false, error: '请至少添加一个模型' };
  if (models.length > MAX_MODELS) {
    return { ok: false, error: `单个厂商最多 ${MAX_MODELS} 个模型` };
  }
  if (models.some(m => m.length > MAX_MODEL_LEN)) {
    return { ok: false, error: `模型 ID 不能超过 ${MAX_MODEL_LEN} 个字符` };
  }
  return { ok: true, value: { name, baseUrl, dialect, models } };
}

function readStore(): CustomAgentSpec[] {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    // 文件不存在 = 还没建过。**不要**因此覆盖原文件 —— 解析失败时用户配的
    // 厂商还在，覆盖等于静默销毁它（与 agent-credentials 同一处理）。
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[CustomAgents] custom-agents.json 解析失败，按「没有自建厂商」处理');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // 逐条校验，坏条目跳过而不是整份作废：一条写坏了不该让其他厂商全部消失。
  const out: CustomAgentSpec[] = [];
  for (const item of parsed) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = String(r.id ?? '').trim();
    const name = String(r.name ?? '').trim();
    const baseUrl = normalizeBaseUrl(String(r.baseUrl ?? ''));
    const dialect = isProviderDialect(r.dialect) ? r.dialect : 'openai';
    // A114 的旧记录只有 `model`（单数）。不迁移的话，升级后用户的厂商会
    // 整条消失 —— 这是「读的时候兼容」而不是「写回时改写」，旧文件保持原样。
    const models = parseModels(r.models ?? r.model);
    if (!id || !name || !baseUrl || models.length === 0) continue;
    out.push({ id, name, baseUrl, dialect, models, createdAt: Number(r.createdAt) || Date.now() });
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

/** 全部自建厂商的定义 */
export function loadCustomSpecs(): CustomAgentSpec[] {
  return readStore();
}

/** 新建一条并落盘。Key 由调用方走 `saveCredential()` 另外存 */
export function createCustomSpec(input: Omit<CustomAgentInput, 'apiKey'>): CustomAgentSpec {
  const spec: CustomAgentSpec = {
    id: `custom-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    name: input.name,
    baseUrl: input.baseUrl,
    dialect: input.dialect,
    models: input.models,
    createdAt: Date.now(),
  };
  const list = readStore();
  list.push(spec);
  writeStore(list);
  return spec;
}

/**
 * 编辑一条。返回更新后的定义；id 不存在时返回 null。
 *
 * id 与 createdAt 不可改：id 同时是凭据变量名后缀，改了等于把 Key 丢掉。
 */
export function updateCustomSpec(
  id: string,
  input: Omit<CustomAgentInput, 'apiKey'>
): CustomAgentSpec | null {
  const list = readStore();
  const i = list.findIndex(s => s.id === id);
  if (i < 0) return null;
  const next: CustomAgentSpec = {
    ...list[i],
    name: input.name,
    baseUrl: input.baseUrl,
    dialect: input.dialect,
    models: input.models,
  };
  list[i] = next;
  writeStore(list);
  return next;
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
 * 标了就是谎称能读写文件、能跑命令。
 *
 * `http.baseUrl` 是给适配器的：Gemini 的模型名在路径里，切模型时必须重新
 * 拼 URL，不能复用创建时那一条。
 */
export function customSpecToDefinition(spec: CustomAgentSpec): AgentDefinition {
  const host = new URL(spec.baseUrl).hostname;
  const keyEnv = customKeyEnv(spec.id);
  const first = spec.models[0];
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
      description:
        spec.models.length === 1
          ? `自建厂商：${first}（${dialectLabel(spec.dialect)}）`
          : `自建厂商：${spec.models.length} 个模型（${dialectLabel(spec.dialect)}）`,
      color: '#6C8CFF',
      command: 'HTTP API',
      installHint: '在「设置 → 登录配置 → 自定义模型厂商」里添加或修改',
    },
    http: {
      dialect: spec.dialect,
      url: chatUrlOf(spec.baseUrl, spec.dialect, first, true),
      baseUrl: spec.baseUrl,
      host,
      defaultModel: first,
    },
    authEnvs: [keyEnv],
    backendHosts: [host],
    models: spec.models,
    defaultModel: first,
    credential: {
      keyEnv: [keyEnv],
      hint: '创建时填写的 API Key，也可在「登录配置」分区随时更换',
    },
  };
}
