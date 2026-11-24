/**
 * 用户自定义模型路由的本地存储。
 *
 * 它和 `custom-agents.json` 的分工：
 * - 自建厂商定义的是「一个 HTTP 端点 + Key + 一组模型」；
 * - 这里登记的是「某个已有 Agent 可以额外走哪条 provider/model 路由」。
 *
 * 典型场景：DSH 的 sensenova、CLI 的第三方网关、某个 Agent 配置文件里手填的
 * 模型名。它们不是官方清单，但用户确实能跑通，必须能被记住、被选择、被校验。
 *
 * 安全约束：这里只存 `credentialRef`（环境变量 / 凭据引用名），
 * **绝不存 Key / token / 密钥正文**。发现这类字段直接 400，不静默丢掉——
 * 静默丢掉会让用户以为存好了，下一次却因为没凭据失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirPath } from './paths.js';
import { normalizeBaseUrl } from '../shared/providerUrl.js';
import {
  parseModelRouteValue,
  routeKey,
  type ModelRoute,
} from '../shared/model-route.js';

const STORE_PATH = path.join(dataDirPath, 'model-routes.json');

const MAX_AGENT_ID = 64;
const MAX_PROVIDER_LEN = 40;
const MAX_MODEL_LEN = 200;
const MAX_DISPLAY_LEN = 60;
const MAX_DESCRIPTION_LEN = 300;
const MAX_CREDENTIAL_REF = 128;

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DELIVERY_DIALECTS = new Set<NonNullable<ModelRoute['deliveryDialect']>>([
  'acp-config', 'cli-flag', 'sdk-setModel', 'http-body',
]);

/** 落盘记录：路由本体 + 归属 + 稳定 id（删除/edit 用） */
export interface StoredModelRoute extends ModelRoute {
  id: string;
  agentId: string;
  createdAt: number;
}

export interface ModelRouteInput {
  agentId: string;
  providerId?: string;
  modelId: string;
  displayName?: string;
  description?: string;
  credentialRef?: string;
  baseURL?: string;
  dialect?: string;
  deliveryDialect?: ModelRoute['deliveryDialect'];
  verified?: boolean;
}

export type ModelRouteInputResult =
  | { ok: true; value: ModelRouteInput }
  | { ok: false; error: string };

/** 用户提交的原始字段里若夹带密钥，明确拒绝。 */
function hasSecretField(raw: Record<string, unknown>): boolean {
  return ['apiKey', 'api_key', 'key', 'secret', 'token', 'accessToken', 'password']
    .some(field => typeof raw[field] === 'string' && String(raw[field]).trim().length > 0);
}

/** 纯校验，不碰盘：接口层 400 与存储层读取都走这一条规则。 */
export function normalizeModelRouteInput(raw: unknown): ModelRouteInputResult {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (hasSecretField(r)) {
    return { ok: false, error: '不要把密钥放在模型路由里；请在「设置 → 登录配置」填写凭据，这里只填引用名' };
  }

  const agentId = String(r.agentId ?? '').trim();
  if (!AGENT_ID_RE.test(agentId)) {
    return { ok: false, error: `Agent ID 不合法（最多 ${MAX_AGENT_ID} 个字符，字母/数字/_/./-）` };
  }

  const modelId = String(r.modelId ?? '').trim();
  if (!modelId || modelId.length > MAX_MODEL_LEN || /[\u0000-\u001f]/.test(modelId)) {
    return { ok: false, error: `模型 ID 不合法（1–${MAX_MODEL_LEN} 个字符，不能含控制字符）` };
  }

  const providerRaw = String(r.providerId ?? '').trim();
  if (providerRaw && !PROVIDER_RE.test(providerRaw)) {
    return { ok: false, error: `provider 不合法（最多 ${MAX_PROVIDER_LEN} 个字符）` };
  }

  const optionalText = (field: string, max: number): string | undefined => {
    const v = String(r[field] ?? '').trim();
    if (!v) return undefined;
    if (v.length > max || /[\u0000-\u001f]/.test(v)) return '__INVALID__';
    return v;
  };
  const displayName = optionalText('displayName', MAX_DISPLAY_LEN);
  const description = optionalText('description', MAX_DESCRIPTION_LEN);
  if (displayName === '__INVALID__' || description === '__INVALID__') {
    return { ok: false, error: '展示名或说明不合法（含控制字符或过长）' };
  }

  const credentialRef = String(r.credentialRef ?? '').trim();
  if (credentialRef && !CREDENTIAL_REF_RE.test(credentialRef)) {
    return { ok: false, error: '凭据引用名不合法（只能用字母、数字、下划线）' };
  }

  const baseURL = normalizeBaseUrl(String(r.baseURL ?? ''));
  if (baseURL) {
    try {
      const u = new URL(baseURL);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, error: 'API 地址只支持 http / https' };
      }
    } catch {
      return { ok: false, error: 'API 地址不是合法 URL' };
    }
  }

  const dialect = String(r.dialect ?? '').trim();
  const delivery = String(r.deliveryDialect ?? '').trim();
  if (delivery && !DELIVERY_DIALECTS.has(delivery as NonNullable<ModelRoute['deliveryDialect']>)) {
    return { ok: false, error: `下发方言不合法（可选：${[...DELIVERY_DIALECTS].join(' / ')}）` };
  }

  return {
    ok: true,
    value: {
      agentId,
      modelId,
      ...(providerRaw ? { providerId: providerRaw } : {}),
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(credentialRef ? { credentialRef } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(dialect ? { dialect } : {}),
      ...(delivery ? { deliveryDialect: delivery as ModelRoute['deliveryDialect'] } : {}),
      ...(typeof r.verified === 'boolean' ? { verified: r.verified } : {}),
    },
  };
}

function toStored(input: ModelRouteInput): StoredModelRoute {
  return {
    ...input,
    id: `mr-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    origin: 'user',
    source: 'user',
    createdAt: Date.now(),
  };
}

function readStore(): StoredModelRoute[] {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[ModelRoutes] model-routes.json 解析失败，按「没有自定义路由」处理');
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: StoredModelRoute[] = [];
  for (const item of parsed) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const normalized = normalizeModelRouteInput(r);
    if (!normalized.ok) continue;
    const id = String(r.id ?? '').trim();
    if (!id) continue;
    out.push({
      ...toStored(normalized.value),
      id,
      createdAt: Number(r.createdAt) || Date.now(),
    });
  }
  return out;
}

function writeStore(list: StoredModelRoute[]): void {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限 */
  }
}

/** 全部自定义路由；传 agentId 时只返回该 Agent 的。 */
export function loadModelRoutes(agentId?: string): StoredModelRoute[] {
  const all = readStore();
  return agentId ? all.filter(route => route.agentId === agentId) : all;
}

/** 只给归属闸用：这个 Agent 显式登记过的路由键。 */
export function modelRouteKeysForAgent(agentId: string): string[] {
  return loadModelRoutes(agentId).map(routeKey);
}

/** 给模型菜单用：剥掉落盘元数据，只留统一路由形状。 */
export function modelRoutesForAgent(agentId: string): ModelRoute[] {
  return loadModelRoutes(agentId).map(route => parseModelRouteValue(route) as ModelRoute);
}

export function createModelRoute(raw: unknown): StoredModelRoute {
  const normalized = normalizeModelRouteInput(raw);
  if (!normalized.ok) throw new Error(normalized.error);
  const stored = toStored(normalized.value);
  const list = readStore();
  if (list.some(item => item.agentId === stored.agentId && routeKey(item) === routeKey(stored))) {
    throw new Error('这条模型路由已存在');
  }
  list.push(stored);
  writeStore(list);
  return stored;
}

export function updateModelRoute(id: string, raw: unknown): StoredModelRoute | null {
  const normalized = normalizeModelRouteInput(raw);
  if (!normalized.ok) throw new Error(normalized.error);
  const list = readStore();
  const i = list.findIndex(route => route.id === id);
  if (i < 0) return null;
  const next: StoredModelRoute = { ...toStored(normalized.value), id, createdAt: list[i].createdAt };
  list[i] = next;
  writeStore(list);
  return next;
}

export function deleteModelRoute(id: string): boolean {
  const list = readStore();
  const next = list.filter(route => route.id !== id);
  if (next.length === list.length) return false;
  writeStore(next);
  return true;
}
