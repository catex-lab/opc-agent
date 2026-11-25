/**
 * 模型路由解析与下发（纯函数层）。
 *
 * `shared/model-route.ts` 解决「怎么表示一条路由」；这一层解决「能不能用、
 * 怎么交给 Agent」。三道闸缺一不可：
 *
 *   1. 归属闸：路由必须来自这个 Agent 现场发现的清单，或显式登记给它的用户路由；
 *   2. 可路由闸：这条路由的方言必须是该 Agent 支持的，否则就是假控件；
 *   3. 凭据闸：路由声明了 credentialRef 就必须有对应凭据，绝不带着空 Key 发出去。
 *
 * 任何一闸不过都返回明确的拒绝原因，调用方必须报错或只读展示，
 * **不许静默换成默认模型**——那正是旧模型字符串时代最难查的假绿。
 *
 * 这里刻意不 import definitions / agent-credentials / 任何 I/O：
 * 归属集合、能力集合、凭据查询全部由调用方注入，便于离线闸门直接验证。
 */
import {
  parseModelRouteValue,
  routeKey,
  routeToValue,
  type ModelRoute,
} from '../shared/model-route.js';

export type RouteDialect = 'acp-config' | 'cli-flag' | 'sdk-setModel' | 'http-body';

export type RouteRejectCode =
  | 'not-a-route'
  | 'not-owned'
  | 'dialect-unsupported'
  | 'credential-missing';

export interface ResolveRouteContext {
  /** 调用方 Agent；只用于错误信息，不在这里查定义表 */
  agentId: string;
  /** ACP session/new 现场发现的路由 */
  availableRoutes?: readonly ModelRoute[];
  /** 显式登记给该 Agent 的用户路由键（provider/model） */
  ownedRouteKeys?: readonly string[];
  /** 该 Agent 支持的下发方言 */
  supportedDialects?: readonly RouteDialect[];
  /** 凭据可用性查询；返回 false 即拒绝 */
  credentialAvailable?: (credentialRef: string) => boolean;
}

export type RouteResolutionResult =
  | { ok: true; route: ModelRoute }
  | { ok: false; code: RouteRejectCode; message: string };

/** 把字符串 / 二元组 / 对象统一解析后再过三道闸。 */
export function resolveModelRoute(
  requested: unknown,
  ctx: ResolveRouteContext
): RouteResolutionResult {
  const route = parseModelRouteValue(requested);
  if (!route) {
    return { ok: false, code: 'not-a-route', message: '模型路由值无法解析' };
  }

  // ① 归属：不认的路由宁可报错，也不许借用别的 Agent 的 provider。
  const owned = new Set<string>([
    ...(ctx.availableRoutes ?? []).map(routeKey),
    ...(ctx.ownedRouteKeys ?? []),
  ]);
  if (!owned.has(routeKey(route))) {
    return {
      ok: false,
      code: 'not-owned',
      message: `${ctx.agentId} 没有这条模型路由：${routeKey(route)}`,
    };
  }

  // ② 可路由：路由自带下发方言时必须被 Agent 支持；没声明的按通用路由处理。
  // 注意 `dialect` 是服务端协议（OpenAI / Anthropic），不是下发方式。
  if (route.deliveryDialect && !ctx.supportedDialects?.includes(route.deliveryDialect)) {
    return {
      ok: false,
      code: 'dialect-unsupported',
      message: `${ctx.agentId} 不支持 ${route.deliveryDialect} 方言的模型路由`,
    };
  }

  // ③ 凭据：声明了引用就必须查得到。没有查询函数时 fail-closed。
  if (route.credentialRef && ctx.credentialAvailable?.(route.credentialRef) !== true) {
    return {
      ok: false,
      code: 'credential-missing',
      message: `模型 ${routeKey(route)} 需要凭据 ${route.credentialRef}`,
    };
  }

  return { ok: true, route };
}

export type RouteApplication =
  | {
      dialect: 'acp-config';
      method: 'session/set_config_option';
      params: { configId: 'model'; value: string };
    }
  | { dialect: 'cli-flag'; flag: '--model'; value: string }
  | { dialect: 'sdk-setModel'; modelId: string }
  | { dialect: 'http-body'; modelId: string; credentialRef?: string };

/**
 * 按方言生成下发描述。**不执行任何 I/O**，调用方拿到的只是「该发什么」。
 *
 * - ACP 用 JSON 数组：DSH 实测的 configOption 值就是 `["provider","model"]`；
 * - CLI 用 `provider/model`：各家 CLI 的 --model 是扁平字符串；
 * - SDK / HTTP 只认 modelId，provider 与凭据在别处表达。
 */
export function applyModelRoute(route: ModelRoute, dialect: RouteDialect): RouteApplication {
  switch (dialect) {
    case 'acp-config':
      return {
        dialect,
        method: 'session/set_config_option',
        params: { configId: 'model', value: routeToValue(route) },
      };
    case 'cli-flag':
      return { dialect, flag: '--model', value: routeKey(route) };
    case 'sdk-setModel':
      return { dialect, modelId: route.modelId };
    case 'http-body':
      return {
        dialect,
        modelId: route.modelId,
        ...(route.credentialRef ? { credentialRef: route.credentialRef } : {}),
      };
  }
}
