/**
 * 模型路由（ModelRoute）—— 官方模型与用户自定义模型的统一表示。
 *
 * 为什么需要这一层：OPC 过去把「模型」当成一个裸字符串，但用户真正选的是
 * 「走哪条 provider 路由 + 用哪份凭据」。ACP 的 DSH 实现把模型值编码成
 * `["sensenova","deepseek-v4-flash"]`，CLI 用 `zai/glm-4.7`，SDK 用 `default-model`；
 * 只有把它们收敛成同一个结构，才能让「官方 / 自定义」在同一个菜单里共存。
 *
 * 判据（沿用 A151/A210/A211）：
 * - 「官方有」≠「这个 Agent 能用」，归属由适配层声明，不在这里猜；
 * - 不认的值宁可报错或只读展示，也不静默换成默认模型；
 * - 凭据只以 `credentialRef` 引用，绝不把 Key 或 baseURL 的密钥写进这里。
 *
 * ⚠️ 纯类型 + 纯函数，不 import server/ 或 src/，可被两边与离线闸门共用。
 */

export type ModelRouteOrigin = 'official' | 'user' | 'agent-default' | 'unknown';

export type ModelRouteSource =
  | 'catalog'
  | 'agent-config'
  | 'session-config'
  | 'manual'
  | 'user'
  | 'unknown';

export interface ModelRoute {
  /** 真正的模型 id（传给 CLI / SDK / HTTP 的那一段） */
  modelId: string;
  /** provider / 路由组；省略表示 Agent 自己的默认路由 */
  providerId?: string;
  /** 这条路由从哪来 */
  origin: ModelRouteOrigin;
  /** 发现途径，决定界面上的来源标注 */
  source?: ModelRouteSource;
  /** 展示名；缺省用 `provider/model` 或 `modelId` */
  displayName?: string;
  description?: string;
  /** 只存引用名，凭据正文在 agent-credentials.json */
  credentialRef?: string;
  /** 自定义 provider 的端点（不含密钥） */
  baseURL?: string;
  /** 模型服务协议方言：OpenAI / Anthropic / Gemini */
  dialect?: string;
  /** 下发方言：ACP config / CLI flag / SDK setModel / HTTP body */
  deliveryDialect?: 'acp-config' | 'cli-flag' | 'sdk-setModel' | 'http-body';
  /** 是否向服务方验证过；未验证不等于不可用 */
  verified?: boolean;
}

export interface RouteConfigOption {
  /** DSH 实测给的是 JSON 字符串；裸数组/对象也允许，由 parseModelRouteValue 归一化 */
  value?: unknown;
  name?: string;
  group?: string;
  description?: string;
  /** DSH 实测：model 选项下先按 provider 分组，叶子在 group.options 里 */
  options?: readonly RouteConfigOption[];
}

/** ACP `session/new` 顶层的 configOptions 条目（只列我们真正需要的字段） */
export interface AcpConfigOptionLike {
  id?: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: readonly RouteConfigOption[];
}

const PROVIDER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * 把各种方言的模型值归一化成 ModelRoute。
 *
 * 支持的形状：
 * - `["sensenova","deepseek-v4-flash"]`（ACP configOptions 的值，DSH 实测）
 * - `{"providerId":"sensenova","modelId":"deepseek-v4-flash"}`
 * - `sensenova/deepseek-v4-flash`（CLI 常见的 provider/model）
 * - `gpt-5.4`（普通模型名，providerId 留空）
 */
export function parseModelRouteValue(value: unknown): ModelRoute | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const id = typeof obj.modelId === 'string' ? obj.modelId.trim() : '';
    if (!id) return null;
    const provider = typeof obj.providerId === 'string' ? obj.providerId.trim() : '';
    return {
      modelId: id,
      ...(provider ? { providerId: provider } : {}),
      origin: isRouteOrigin(obj.origin) ? obj.origin : 'official',
      ...(isRouteSource(obj.source) ? { source: obj.source } : {}),
      ...(typeof obj.displayName === 'string' ? { displayName: obj.displayName } : {}),
      ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
      ...(typeof obj.credentialRef === 'string' ? { credentialRef: obj.credentialRef } : {}),
      ...(typeof obj.baseURL === 'string' ? { baseURL: obj.baseURL } : {}),
      ...(typeof obj.dialect === 'string' ? { dialect: obj.dialect } : {}),
      ...(isDeliveryDialect(obj.deliveryDialect) ? { deliveryDialect: obj.deliveryDialect } : {}),
      ...(typeof obj.verified === 'boolean' ? { verified: obj.verified } : {}),
    };
  }
  if (Array.isArray(value)) {
    const [provider, model] = value;
    if (typeof provider !== 'string' || typeof model !== 'string') return null;
    if (!provider.trim() || !model.trim()) return null;
    return { providerId: provider.trim(), modelId: model.trim(), origin: 'official', source: 'session-config' };
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parseModelRouteValue(parsed) : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith('{')) {
    try {
      return parseModelRouteValue(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  const slash = raw.indexOf('/');
  if (slash > 0 && slash < raw.length - 1) {
    const provider = raw.slice(0, slash);
    if (PROVIDER_SEGMENT.test(provider)) {
      return { providerId: provider, modelId: raw.slice(slash + 1), origin: 'official' };
    }
  }
  return { modelId: raw, origin: 'official' };
}

/**
 * 把路由编码回可落库的字符串。provider 存在时用 JSON 数组而不是 `provider/model`，
 * 因为模型 id 自身也可能带斜杠（例如 openrouter 的三段式名字）。
 */
export function routeToValue(route: ModelRoute): string {
  return route.providerId
    ? JSON.stringify([route.providerId, route.modelId])
    : route.modelId;
}

/** 稳定键：用于去重与「当前选中」比较 */
export function routeKey(route: ModelRoute): string {
  return route.providerId ? `${route.providerId}/${route.modelId}` : route.modelId;
}

export function sameRoute(a: ModelRoute | null, b: ModelRoute | null): boolean {
  if (!a || !b) return a === b;
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

export function routeLabel(route: ModelRoute): string {
  if (route.displayName) return route.displayName;
  return route.providerId ? `${route.providerId}/${route.modelId}` : route.modelId;
}

export function isUserRoute(route: ModelRoute): boolean {
  return route.origin === 'user';
}

/**
 * ACP `session/new` 返回的 configOptions[model].options → 路由列表。
 *
 * DSH 0.2.2-rc.5 实测是两层：外层按 provider 分组（`group: 'sensenova'`），
 * 叶子才是 `{ value: '["sensenova","..."]', name, description }`。
 * 只认扁平数组会把全部模型漏掉，所以这里递归下钻，并把 group 作为缺 provider
 * 时的兜底。顺序完全跟随 ACP 原文，去重按 routeKey（provider+model）。
 */
export function parseRouteConfigOptions(options: readonly RouteConfigOption[] | null | undefined): ModelRoute[] {
  const out: ModelRoute[] = [];
  collectRouteOptions(options, out, new Set<string>(), undefined);
  return out;
}

/**
 * 从 ACP 顶层 configOptions 里挑出模型那一项再解析。
 *
 * 不能遍历所有 configOptions 一把抓：DSH 同时返回 reasoning_effort，
 * 它的 `off` / `high` 会被 parseModelRouteValue 当成合法裸模型名。
 * 判据取 id / category（实测分别是 `model` / `model`），名字只作兜底。
 */
export function parseAcpModelConfigOptions(
  configOptions: readonly AcpConfigOptionLike[] | null | undefined
): ModelRoute[] {
  if (!Array.isArray(configOptions)) return [];
  const modelOption = configOptions.find(option =>
    !!option && (option.id === 'model' || option.category === 'model')
  ) ?? configOptions.find(option => {
    if (!option || typeof option !== 'object') return false;
    return String(option.name ?? '').toLowerCase() === 'model';
  });
  return modelOption ? parseRouteConfigOptions(modelOption.options) : [];
}

function collectRouteOptions(
  options: readonly RouteConfigOption[] | null | undefined,
  out: ModelRoute[],
  seen: Set<string>,
  inheritedGroup: string | undefined
): void {
  if (!Array.isArray(options)) return;
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    const group = typeof option.group === 'string' && option.group.trim()
      ? option.group.trim()
      : inheritedGroup;
    if (Array.isArray(option.options) && option.options.length > 0) {
      collectRouteOptions(option.options, out, seen, group);
      continue;
    }
    if (!('value' in option)) continue;
    const route = parseModelRouteValue(option.value);
    if (!route) continue;
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...route,
      source: 'session-config',
      ...(option.name ? { displayName: option.name } : {}),
      ...(group ? { providerId: route.providerId ?? group } : {}),
      ...(option.description ? { description: option.description } : {}),
    });
  }
}

function isRouteOrigin(value: unknown): value is ModelRouteOrigin {
  return value === 'official' || value === 'user' || value === 'agent-default' || value === 'unknown';
}

function isRouteSource(value: unknown): value is ModelRouteSource {
  return value === 'catalog' || value === 'agent-config' || value === 'session-config'
    || value === 'manual' || value === 'user' || value === 'unknown';
}

function isDeliveryDialect(value: unknown): value is ModelRoute['deliveryDialect'] {
  return value === 'acp-config' || value === 'cli-flag'
    || value === 'sdk-setModel' || value === 'http-body';
}
