/**
 * 模型路由（ModelRoute）纯函数闸门。
 *
 * 要守的是这一轮改造的根：OPC 过去把「模型」当裸字符串，结果官方模型、
 * CLI 自定义模型、ACP 自定义 provider 全挤在一个字段里，菜单能选但下发时
 * 又会被静默换成默认值。这里先把**数据与方言边界**钉住：
 *
 *   1. DSH ACP 的 `["sensenova","deepseek-v4-flash"]` 必须解析成 provider+model；
 *   2. 旧字符串（`provider/model` / 裸模型名）仍要兼容，不能一刀切；
 *   3. 编码要能往返，模型 id 自带斜杠时也不能把路由拼坏；
 *   4. 空值 / 半截数组 / 坏 JSON 必须返回 null，绝不静默造一个默认模型；
 *   5. ACP `configOptions[model].options` 要带来源和展示名，并且去重。
 *
 * 反向探针直接对「坏实现」调用同一份契约：把二元组压成字符串、给非法值兜底、
 * 编码时丢掉 provider、configOptions 不去重 / 丢来源，都必须判红。
 *
 * 全离线：不读用户配置、不起 CLI、不碰数据库。
 * 运行：npx tsx scripts/verify-model-route.ts
 */
import {
  isUserRoute,
  parseAcpModelConfigOptions,
  parseModelRouteValue,
  parseRouteConfigOptions,
  routeKey,
  routeLabel,
  routeToValue,
  sameRoute,
  type AcpConfigOptionLike,
  type ModelRoute,
  type RouteConfigOption,
} from '../shared/model-route.js';
import {
  applyModelRoute,
  resolveModelRoute,
  type ResolveRouteContext,
  type RouteResolutionResult,
} from '../server/model-route-resolution.js';

const failures: string[] = [];
let checks = 0;

function eq<T>(actual: T, expected: T, label: string) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function ok(cond: boolean, label: string, detail?: string) {
  checks++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

interface RouteApi {
  parse: (value: unknown) => ModelRoute | null;
  encode: (route: ModelRoute) => string;
  parseOptions: (options: readonly RouteConfigOption[] | null | undefined) => ModelRoute[];
  parseAcp: (options: readonly AcpConfigOptionLike[] | null | undefined) => ModelRoute[];
}

/** DSH 0.2.2-rc.5 的 session/new 实测形状：先按 provider 分组，叶子才是模型值 */
const DSH_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options: [
      {
        group: 'deepseek-official',
        name: 'DeepSeek',
        options: [
          { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
          { value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
          { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding' },
        ],
      },
      {
        group: 'deepseek-account',
        name: 'DeepSeek Account',
        options: [
          { value: '["deepseek-account","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
          { value: '["deepseek-account","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
        ],
      },
      {
        group: 'sensenova',
        name: 'sensenova',
        options: [
          { value: '["sensenova","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
          { value: '["sensenova","sensenova-6.8-flash"]', name: 'sensenova-6.8-flash' },
          { value: '["sensenova","deepseek-v4.1-flash"]', name: 'deepseek-v4.1-flash' },
        ],
      },
    ],
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
      { value: 'max', name: 'Max' },
    ],
  },
] as const satisfies readonly AcpConfigOptionLike[];

const real: RouteApi = {
  parse: parseModelRouteValue,
  encode: routeToValue,
  parseOptions: parseRouteConfigOptions,
  parseAcp: parseAcpModelConfigOptions,
};

/** 供正向断言与反向探针共用的紧凑契约。坏实现必须在这里被判红。 */
function routeContract(api: RouteApi): boolean {
  const tuple = api.parse(['sensenova', 'deepseek-v4-flash']);
  if (!tuple || tuple.providerId !== 'sensenova' || tuple.modelId !== 'deepseek-v4-flash') return false;
  if (tuple.source !== 'session-config') return false;

  const tupleText = api.parse('["sensenova","sensenova-6.8-flash"]');
  if (!tupleText || tupleText.providerId !== 'sensenova' || tupleText.modelId !== 'sensenova-6.8-flash') return false;

  const slash = api.parse('zai/glm-4.7');
  if (!slash || slash.providerId !== 'zai' || slash.modelId !== 'glm-4.7') return false;

  const plain = api.parse('gpt-5.4');
  if (!plain || plain.providerId !== undefined || plain.modelId !== 'gpt-5.4') return false;

  const tricky: ModelRoute = {
    providerId: 'openrouter',
    modelId: 'vendor/model:preview',
    origin: 'user',
    source: 'user',
    credentialRef: 'OR_KEY',
  };
  const round = api.parse(api.encode(tricky));
  if (!round || round.providerId !== tricky.providerId || round.modelId !== tricky.modelId) return false;

  for (const bad of [null, undefined, 0, '', '   ', {}, [], ['', 'm'], ['p', ''], ['p'], '{broken']) {
    if (api.parse(bad) !== null) return false;
  }

  const options = [
    { value: '["sensenova","deepseek-v4-flash"]', name: 'DeepSeek V4 Flash', group: 'sensenova', description: '自定义' },
    { value: '["sensenova","deepseek-v4-flash"]', name: '重复项' },
    { value: 'gpt-5.4', name: '官方模型' },
    { value: '   ', name: '空值' },
    {},
  ] as unknown as readonly RouteConfigOption[];
  const routes = api.parseOptions(options);
  if (routes.length !== 2) return false;
  if (routes[0]?.providerId !== 'sensenova' || routes[0]?.modelId !== 'deepseek-v4-flash') return false;
  if (routes[0]?.source !== 'session-config' || routes[0]?.displayName !== 'DeepSeek V4 Flash') return false;
  if (routes[1]?.providerId !== undefined || routes[1]?.modelId !== 'gpt-5.4') return false;
  if (api.parseOptions(null).length !== 0) return false;

  const acpRoutes = api.parseAcp(DSH_CONFIG_OPTIONS);
  if (acpRoutes.length !== 8) return false;
  if (!acpRoutes.some(route =>
    route.providerId === 'sensenova' && route.modelId === 'sensenova-6.8-flash'
  )) return false;
  if (api.parseAcp([
    { id: 'reasoning_effort', category: 'thought_level', options: [{ value: 'high', name: 'High' }] },
  ]).length !== 0) return false;

  return true;
}

// ── 1. DSH ACP 二元组：本轮真正的缺口 ─────────────────────────────
{
  const tuple = parseModelRouteValue(['sensenova', 'deepseek-v4-flash']);
  eq(
    tuple && { providerId: tuple.providerId, modelId: tuple.modelId, source: tuple.source },
    { providerId: 'sensenova', modelId: 'deepseek-v4-flash', source: 'session-config' },
    '解析：ACP configOptions 的 provider/model 二元组必须原样保留两段'
  );

  const tupleText = parseModelRouteValue('["sensenova","sensenova-6.8-flash"]');
  eq(
    tupleText && { providerId: tupleText.providerId, modelId: tupleText.modelId },
    { providerId: 'sensenova', modelId: 'sensenova-6.8-flash' },
    '解析：ACP 也可能把二元组编码成 JSON 字符串'
  );
  eq(tupleText?.origin, 'official', '来源：ACP 报出来的路由默认按官方来源展示，不冒充用户自定义');
}

// ── 2. 旧格式兼容：不能因为引入新结构就打断既有会话 ────────────────
{
  const slash = parseModelRouteValue('zai/glm-4.7');
  eq(
    slash && { providerId: slash.providerId, modelId: slash.modelId },
    { providerId: 'zai', modelId: 'glm-4.7' },
    '解析：CLI 的 provider/model 仍然切成两段'
  );

  const plain = parseModelRouteValue('  gpt-5.4  ');
  eq(
    plain && { providerId: plain.providerId, modelId: plain.modelId },
    { providerId: undefined, modelId: 'gpt-5.4' },
    '解析：裸模型名去空格后照旧可用，providerId 留空（表示走 Agent 默认路由）'
  );

  const obj = parseModelRouteValue({
    modelId: 'deepseek-v4-flash',
    providerId: 'sensenova',
    origin: 'user',
    source: 'manual',
    credentialRef: 'SENSENOVA_API_KEY',
    baseURL: 'https://token.sensenova.cn/v1',
    dialect: 'openai-completions',
    deliveryDialect: 'http-body',
    verified: false,
  });
  eq(
    obj && {
      providerId: obj.providerId,
      modelId: obj.modelId,
      origin: obj.origin,
      source: obj.source,
      credentialRef: obj.credentialRef,
      baseURL: obj.baseURL,
      dialect: obj.dialect,
      deliveryDialect: obj.deliveryDialect,
      verified: obj.verified,
    },
    {
      providerId: 'sensenova',
      modelId: 'deepseek-v4-flash',
      origin: 'user',
      source: 'manual',
      credentialRef: 'SENSENOVA_API_KEY',
      baseURL: 'https://token.sensenova.cn/v1',
      dialect: 'openai-completions',
      deliveryDialect: 'http-body',
      verified: false,
    },
    '解析：对象形态必须把凭据引用与方言都带上，但不带密钥正文'
  );

  const jsonObj = parseModelRouteValue('{"modelId":"m","providerId":"p","origin":"user"}');
  eq(jsonObj?.origin, 'user', '解析：JSON 字符串形态同样支持（落库的路由值可能先被序列化）');
}

// ── 3. 编码往返：模型 id 自带斜杠也不能拼坏 ───────────────────────
{
  const tricky: ModelRoute = {
    providerId: 'openrouter',
    modelId: 'vendor/model:preview',
    origin: 'user',
    credentialRef: 'OR_KEY',
  };
  const encoded = routeToValue(tricky);
  const back = parseModelRouteValue(encoded);
  eq(
    back && { providerId: back.providerId, modelId: back.modelId },
    { providerId: 'openrouter', modelId: 'vendor/model:preview' },
    '编码：带斜杠的模型 id 必须能往返（不能简单拼成 provider/model）'
  );
  eq(routeToValue({ modelId: 'gpt-5.4', origin: 'official' }), 'gpt-5.4', '编码：无 provider 时退回旧字符串格式');
}

// ── 4. 比较与展示 ────────────────────────────────────────────────
{
  const user = parseModelRouteValue(['sensenova', 'sensenova-6.8-flash'])!;
  eq(routeKey(user), 'sensenova/sensenova-6.8-flash', '去重键：provider 与 model 都在');
  eq(routeLabel(user), 'sensenova/sensenova-6.8-flash', '展示名：没有 displayName 时用 provider/model');
  ok(sameRoute(user, parseModelRouteValue(routeToValue(user))), '比较：编码往返后仍视为同一条路由');
  ok(!sameRoute(user, parseModelRouteValue('sensenova-6.8-flash')), '比较：少了 provider 就是另一条路由，不许当成同一个');
  ok(isUserRoute({ ...user, origin: 'user' }), '来源：用户自定义路由要能被识别');
  ok(!isUserRoute(user), '来源：ACP 默认路由不能冒充用户自定义');
  eq(routeLabel({ ...user, displayName: '我的模型' }), '我的模型', '展示名：有 displayName 时优先用它');
}

// ── 5. 非法值：宁可没有，也不许造出一个假模型 ─────────────────────
{
  const badValues: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['数字', 42],
    ['空串', ''],
    ['纯空格', '   '],
    ['空对象', {}],
    ['空数组', []],
    ['缺模型的数组', ['p']],
    ['空 provider', ['', 'm']],
    ['空 model', ['p', '']],
    ['坏 JSON', '{broken'],
    ['数组里混数字', ['p', 7]],
  ];
  for (const [label, value] of badValues) {
    ok(parseModelRouteValue(value) === null, `非法值：${label} 必须返回 null（不静默造默认模型）`);
  }
}

// ── 6. ACP configOptions：来源、展示名、去重 ──────────────────────
{
  const options = [
    { value: '["sensenova","deepseek-v4-flash"]', name: 'DeepSeek V4 Flash', group: 'sensenova', description: '自定义 provider' },
    { value: '["sensenova","deepseek-v4-flash"]', name: '重复项' },
    { value: 'gpt-5.4', name: '官方模型' },
    { value: '   ', name: '空值' },
    {},
  ] as unknown as readonly RouteConfigOption[];

  const routes = parseRouteConfigOptions(options);
  eq(routes.length, 2, 'ACP 选项：重复项合并、非法项丢弃');
  eq(
    routes[0] && { providerId: routes[0].providerId, modelId: routes[0].modelId, displayName: routes[0].displayName, description: routes[0].description },
    { providerId: 'sensenova', modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', description: '自定义 provider' },
    'ACP 选项：展示名与说明按 ACP 原文透出'
  );
  eq(routes[0]?.source, 'session-config', 'ACP 选项：必须标记为 session-config（菜单据此知道这是会话现场发现的）');
  eq(routes[1]?.modelId, 'gpt-5.4', 'ACP 选项：官方模型仍在，自定义不是替换而是共存');

  const groupOnly = parseRouteConfigOptions([
    { value: 'flash', group: 'sensenova', name: 'Flash' },
  ]);
  eq(groupOnly[0]?.providerId, 'sensenova', 'ACP 选项：value 是裸名字时允许用 group 补 provider');

  eq(parseRouteConfigOptions(null).length, 0, 'ACP 选项：没有 configOptions 时返回空数组（不抛错）');
  eq(parseRouteConfigOptions(undefined).length, 0, 'ACP 选项：undefined 同样返回空数组');
}

// ── 6b. DSH 实测形状：分组嵌套 + 只挑 model 那一项 ─────────────────
{
  const routes = parseAcpModelConfigOptions(DSH_CONFIG_OPTIONS);
  eq(routes.length, 8, 'DSH：三个 provider 分组共 8 条模型，嵌套分组必须全部下钻');
  eq(
    routes.map(route => route.providerId),
    [
      'deepseek-official', 'deepseek-official', 'deepseek-official',
      'deepseek-account', 'deepseek-account',
      'sensenova', 'sensenova', 'sensenova',
    ],
    'DSH：provider 分组原样保留，顺序跟随 ACP 原文'
  );
  eq(
    routes.find(route => route.providerId === 'sensenova' && route.modelId === 'sensenova-6.8-flash')?.displayName,
    'sensenova-6.8-flash',
    'DSH：用户自定义 provider 的模型出现在菜单数据里'
  );
  eq(
    routes.find(route => route.providerId === 'deepseek-official' && route.modelId === 'deepseek-v4-pro')?.description,
    'Stronger agentic coding',
    'DSH：官方描述透传，不改写'
  );
  ok(
    routes.every(route => route.source === 'session-config'),
    'DSH：所有从 ACP 现场发现的路由都标 session-config'
  );

  eq(
    parseAcpModelConfigOptions([
      { id: 'reasoning_effort', category: 'thought_level', options: [{ value: 'high', name: 'High' }] },
    ]).length,
    0,
    'DSH：reasoning_effort 的 off/high 不是模型，不许混进菜单'
  );
  eq(parseAcpModelConfigOptions(null).length, 0, 'DSH：没有 configOptions 时返回空数组');
}

// ── 7. 三闸解析与四种下发方言 ────────────────────────────────────
type Resolver = (requested: unknown, ctx: ResolveRouteContext) => RouteResolutionResult;

function resolutionContract(resolve: Resolver): boolean {
  const route = parseModelRouteValue(['sensenova', 'sensenova-6.8-flash'])!;
  const ctx: ResolveRouteContext = {
    agentId: 'dsh',
    availableRoutes: [route],
    supportedDialects: ['acp-config'],
  };

  const good = resolve(routeToValue(route), ctx);
  if (!good.ok || good.route.providerId !== 'sensenova') return false;

  const unowned = resolve(routeToValue(route), { ...ctx, availableRoutes: [] });
  if (unowned.ok || unowned.code !== 'not-owned') return false;

  const garbage = resolve('   ', ctx);
  if (garbage.ok || garbage.code !== 'not-a-route') return false;

  const credentialed: ModelRoute = { ...route, credentialRef: 'SENSENOVA_API_KEY' };
  const noKey = resolve(credentialed, { ...ctx, availableRoutes: [credentialed] });
  if (noKey.ok || noKey.code !== 'credential-missing') return false;
  const withKey = resolve(credentialed, {
    ...ctx,
    availableRoutes: [credentialed],
    credentialAvailable: ref => ref === 'SENSENOVA_API_KEY',
  });
  if (!withKey.ok) return false;

  const otherDialect: ModelRoute = { ...route, deliveryDialect: 'http-body' };
  const badDialect = resolve(otherDialect, { ...ctx, availableRoutes: [otherDialect] });
  if (badDialect.ok || badDialect.code !== 'dialect-unsupported') return false;

  return true;
}

{
  const route = parseModelRouteValue(['sensenova', 'sensenova-6.8-flash'])!;
  const ctx: ResolveRouteContext = {
    agentId: 'dsh',
    availableRoutes: [route],
    supportedDialects: ['acp-config'],
  };

  const good = resolveModelRoute(routeToValue(route), ctx);
  ok(good.ok, '解析闸门：现场发现的路由能通过三道闸');
  eq(good.ok && good.route.modelId, 'sensenova-6.8-flash', '解析闸门：通过后拿到的是结构化路由');

  const unowned = resolveModelRoute(['other', 'm'], ctx);
  ok(!unowned.ok && unowned.code === 'not-owned', '归属闸：不是这个 Agent 发现的路由必须拦下');
  ok(
    !unowned.ok && unowned.message.includes('dsh') && unowned.message.includes('other/m'),
    '归属闸：拒绝原因要说清是谁、哪条路由（不能只报「失败」）'
  );

  const garbage = resolveModelRoute({ modelId: '' }, ctx);
  ok(!garbage.ok && garbage.code === 'not-a-route', '入参闸：空路由值不许被当成「交给 Agent 默认」');

  const credentialed: ModelRoute = { ...route, credentialRef: 'SENSENOVA_API_KEY' };
  const noKey = resolveModelRoute(credentialed, { ...ctx, availableRoutes: [credentialed] });
  ok(!noKey.ok && noKey.code === 'credential-missing', '凭据闸：声明了引用但没查到凭据必须拒绝');
  const withKey = resolveModelRoute(credentialed, {
    ...ctx,
    availableRoutes: [credentialed],
    credentialAvailable: ref => ref === 'SENSENOVA_API_KEY',
  });
  ok(withKey.ok, '凭据闸：查到凭据后放行（不是一律禁掉自定义路由）');

  const otherDialect: ModelRoute = { ...route, deliveryDialect: 'http-body' };
  const badDialect = resolveModelRoute(otherDialect, { ...ctx, availableRoutes: [otherDialect] });
  ok(!badDialect.ok && badDialect.code === 'dialect-unsupported', '可路由闸：不支持的方言必须拒绝');

  eq(
    applyModelRoute(route, 'acp-config'),
    { dialect: 'acp-config', method: 'session/set_config_option', params: { configId: 'model', value: '["sensenova","sensenova-6.8-flash"]' } },
    '下发：ACP 用 DSH 实测的 JSON 数组 configOption 值'
  );
  eq(
    applyModelRoute(route, 'cli-flag'),
    { dialect: 'cli-flag', flag: '--model', value: 'sensenova/sensenova-6.8-flash' },
    '下发：CLI 用扁平 provider/model'
  );
  eq(
    applyModelRoute(route, 'sdk-setModel'),
    { dialect: 'sdk-setModel', modelId: 'sensenova-6.8-flash' },
    '下发：SDK 只认 modelId，不塞 provider'
  );
  eq(
    applyModelRoute(credentialed, 'http-body'),
    { dialect: 'http-body', modelId: 'sensenova-6.8-flash', credentialRef: 'SENSENOVA_API_KEY' },
    '下发：HTTP 带凭据引用但不带密钥正文'
  );

  ok(resolutionContract(resolveModelRoute), '★ 解析契约自检：当前实现通过三道闸判据');
  const brokenResolvers: Array<[string, Resolver]> = [
    ['去掉归属闸', (requested, context) => {
      const parsed = parseModelRouteValue(requested);
      if (!parsed) return { ok: false, code: 'not-a-route', message: '无法解析' };
      return { ok: true, route: parsed };
    }],
    ['去掉凭据闸', (requested, context) =>
      resolveModelRoute(requested, { ...context, credentialAvailable: () => true })],
    ['去掉方言闸', (requested, context) =>
      resolveModelRoute(requested, {
        ...context,
        supportedDialects: ['acp-config', 'cli-flag', 'sdk-setModel', 'http-body'],
      })],
  ];
  const resolutionLeaks = brokenResolvers
    .filter(([, resolve]) => resolutionContract(resolve))
    .map(([label]) => label);
  eq(resolutionLeaks, [], '★ 反向探针：三道闸各拆掉一个都必须判红', `漏判：${resolutionLeaks.join('、') || '无'}`);
}

// ── 8. 反向探针：坏实现必须被同一份契约判红 ───────────────────────
{
  ok(routeContract(real), '★ 契约自检：当前实现通过紧凑契约');

  const broken: Array<[string, RouteApi]> = [
    ['ACP 二元组被压成字符串', {
      ...real,
      parse(value) {
        if (Array.isArray(value)) return { modelId: JSON.stringify(value), origin: 'official' };
        return real.parse(value);
      },
    }],
    ['非法值被静默兜底成默认模型', {
      ...real,
      parse(value) {
        return real.parse(value) ?? { modelId: 'default', origin: 'official' };
      },
    }],
    ['编码丢掉 provider（落库后路由降级成默认）', {
      ...real,
      encode(route) {
        return route.modelId;
      },
    }],
    ['ACP 选项不去重', {
      ...real,
      parseOptions(options) {
        return (options ?? [])
          .map(option => real.parse(option?.value))
          .filter((route): route is ModelRoute => route !== null);
      },
    }],
    ['ACP 选项丢掉来源', {
      ...real,
      parseOptions(options) {
        return real.parseOptions(options).map(route => {
          const copy: ModelRoute = { ...route };
          delete copy.source;
          return copy;
        });
      },
    }],
    ['DSH 的 provider 分组不下钻', {
      ...real,
      parseAcp(options) {
        const model = (options ?? []).find(option => option?.id === 'model' || option?.category === 'model');
        return parseRouteConfigOptions((model?.options ?? []).filter(option => 'value' in option));
      },
    }],
    ['把所有 configOption 都当模型', {
      ...real,
      parseAcp(options) {
        return (options ?? []).flatMap(option => parseRouteConfigOptions(option?.options));
      },
    }],
  ];

  const leaked = broken.filter(([, api]) => routeContract(api)).map(([label]) => label);
  eq(leaked, [], '★ 反向探针：七种坏实现都必须判红', `漏判：${leaked.join('、') || '无'}`);
}

console.log(`模型路由断言：${checks - failures.length}/${checks} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
console.log('✓ provider/model 二元组、旧字符串兼容、非法值拒绝与 ACP 选项解析均符合预期');
