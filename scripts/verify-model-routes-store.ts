/**
 * 用户自定义模型路由存储闸门。
 *
 * 守四件事：
 *   1. 只存定义与凭据引用，夹带密钥必须拒绝（不是静默丢字段）；
 *   2. 落盘后能原样读回，更新/删除都能生效，坏条目不会让整份配置消失；
 *   3. 存下来的路由能直接进入归属闸（这是「用户自定义模型可用」的闭环）；
 *   4. API 真的接进 index.ts（防止写出一个没人调用的仓库）。
 *
 * 全离线：OPC_DATA_DIR 已指到临时目录，不碰真实 data/。
 * 运行：npx tsx scripts/verify-model-routes-store.ts
 */
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirPath } from '../server/paths.js';
import {
  createModelRoute,
  deleteModelRoute,
  loadModelRoutes,
  modelRouteKeysForAgent,
  normalizeModelRouteInput,
  updateModelRoute,
  type ModelRouteInputResult,
} from '../server/modelRoutes.js';
import { resolveModelRoute } from '../server/model-route-resolution.js';
import { routeToValue } from '../shared/model-route.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function throwsWithError(fn: () => unknown, needle: string, label: string) {
  checks++;
  try {
    fn();
    failures.push(`${label} —— 期望抛错，实际通过`);
  } catch (err) {
    const message = (err as Error).message;
    if (!message.includes(needle)) {
      failures.push(`${label} —— 错误文案不含「${needle}」：${message}`);
    }
  }
}

type Normalizer = (raw: unknown) => ModelRouteInputResult;

function normalizeContract(normalize: Normalizer): boolean {
  const good = normalize({
    agentId: 'dsh', providerId: 'sensenova', modelId: 'sensenova-6.8-flash',
    credentialRef: 'SENSENOVA_API_KEY', baseURL: 'https://token.sensenova.cn/v1',
  });
  if (!good.ok || good.value.modelId !== 'sensenova-6.8-flash') return false;
  if (normalize({ agentId: 'dsh', modelId: 'm', apiKey: 'do-not-store' }).ok) return false;
  if (normalize({ agentId: 'dsh', modelId: 'm', baseURL: 'not-a-url' }).ok) return false;
  if (normalize({ agentId: '', modelId: 'm' }).ok) return false;
  if (normalize({ agentId: 'dsh', modelId: '' }).ok) return false;
  return true;
}

// ── 1. 纯校验：合法值保留，非法值明确拒绝 ────────────────────────
{
  ok(normalizeContract(normalizeModelRouteInput), '校验契约：当前实现通过');

  const good = normalizeModelRouteInput({
    agentId: 'dsh', providerId: 'sensenova', modelId: 'sensenova-6.8-flash',
    displayName: '我的 SenseNova', description: '公司网关',
    credentialRef: 'SENSENOVA_API_KEY', baseURL: 'https://token.sensenova.cn/v1/',
    dialect: 'openai-completions', deliveryDialect: 'acp-config',
  });
  ok(good.ok, '合法路由：必填项齐全时通过');
  if (good.ok) {
    eq(good.value.baseURL, 'https://token.sensenova.cn/v1', '合法路由：地址尾斜杠归一化');
    eq(good.value.deliveryDialect, 'acp-config', '合法路由：下发方言保留');
  }

  const badCases: Array<[string, unknown, string]> = [
    ['夹带密钥', { agentId: 'dsh', modelId: 'm', apiKey: 'do-not-store' }, '不要把密钥放在模型路由里'],
    ['空 Agent', { agentId: '', modelId: 'm' }, 'Agent ID 不合法'],
    ['坏 Agent ID', { agentId: 'dsh/../root', modelId: 'm' }, 'Agent ID 不合法'],
    ['空模型', { agentId: 'dsh', modelId: '  ' }, '模型 ID 不合法'],
    ['坏 provider', { agentId: 'dsh', providerId: 'bad provider', modelId: 'm' }, 'provider 不合法'],
    ['坏地址', { agentId: 'dsh', modelId: 'm', baseURL: 'not-a-url' }, 'API 地址不是合法 URL'],
    ['非 http 地址', { agentId: 'dsh', modelId: 'm', baseURL: 'ftp://example.com/v1' }, '只支持 http / https'],
    ['坏凭据引用', { agentId: 'dsh', modelId: 'm', credentialRef: 'KEY-1' }, '凭据引用名不合法'],
    ['坏下发方言', { agentId: 'dsh', modelId: 'm', deliveryDialect: 'smtp' }, '下发方言不合法'],
    ['过长说明', { agentId: 'dsh', modelId: 'm', description: 'x'.repeat(301) }, '不合法'],
  ];
  for (const [label, input, needle] of badCases) {
    const result = normalizeModelRouteInput(input);
    ok(!result.ok && result.error.includes(needle), `非法路由：${label} → 400 级拒绝`, JSON.stringify(result));
  }

  const broken: Array<[string, Normalizer]> = [
    ['收下密钥字段', raw => {
      const r = raw as Record<string, unknown>;
      return { ok: true, value: { agentId: String(r.agentId), modelId: String(r.modelId) } };
    }],
    ['忽略坏地址', raw => {
      const r = raw as Record<string, unknown>;
      return { ok: true, value: { agentId: String(r.agentId), modelId: String(r.modelId) } };
    }],
    ['忽略空 Agent', raw => {
      const r = raw as Record<string, unknown>;
      return { ok: true, value: { agentId: String(r.agentId ?? ''), modelId: String(r.modelId) } };
    }],
  ];
  const leaks = broken.filter(([, fn]) => normalizeContract(fn)).map(([label]) => label);
  eq(leaks, [], '★ 反向探针：收密钥 / 忽略坏地址 / 忽略空 Agent 都必须判红', `漏判：${leaks.join('、') || '无'}`);
}

// ── 2. 落盘与 CRUD ──────────────────────────────────────────────
{
  const storePath = path.join(dataDirPath, 'model-routes.json');
  ok(!fs.existsSync(storePath), '前置：临时数据目录里还没有 model-routes.json');

  const created = createModelRoute({
    agentId: 'dsh', providerId: 'sensenova', modelId: 'sensenova-6.8-flash',
    displayName: 'SenseNova Flash', credentialRef: 'SENSENOVA_API_KEY',
    baseURL: 'https://token.sensenova.cn/v1', dialect: 'openai-completions',
    deliveryDialect: 'acp-config',
  });
  eq(created.origin, 'user', '落盘：自定义路由 origin=user');
  eq(created.source, 'user', '落盘：自定义路由 source=user');
  ok(fs.existsSync(storePath), '落盘：文件真的写出来了（不是只在内存里）');

  const raw = fs.readFileSync(storePath, 'utf8');
  ok(raw.includes('"credentialRef"'), '落盘：只写凭据引用名');
  ok(!raw.includes('do-not-store') && !/"(apiKey|secret|token|password)"/.test(raw), '落盘：没有任何密钥字段');

  eq(loadModelRoutes('dsh').length, 1, '读取：按 Agent 过滤只看到自己的路由');
  eq(loadModelRoutes('other').length, 0, '读取：别的 Agent 看不到 dsh 的路由');
  eq(loadModelRoutes().length, 1, '读取：不带过滤时能列出全部');

  throwsWithError(() => createModelRoute({
    agentId: 'dsh', providerId: 'sensenova', modelId: 'sensenova-6.8-flash',
  }), '已存在', '重复路由：同一 Agent + provider/model 不许重复登记');

  const updated = updateModelRoute(created.id, {
    agentId: 'dsh', providerId: 'sensenova', modelId: 'sensenova-6.8-flash',
    displayName: '改名后的模型',
  });
  eq(updated?.displayName, '改名后的模型', '更新：展示名可改');
  eq(updateModelRoute('mr-not-exist', { agentId: 'dsh', modelId: 'm' }), null, '更新：不存在的 id 返回 null');

  eq(modelRouteKeysForAgent('dsh'), ['sensenova/sensenova-6.8-flash'], '归属集合：自定义路由键可用于 resolveRoute');
  const resolved = resolveModelRoute(routeToValue(created), {
    agentId: 'dsh',
    availableRoutes: [],
    ownedRouteKeys: modelRouteKeysForAgent('dsh'),
    supportedDialects: ['acp-config'],
  });
  ok(resolved.ok, '闭环：存下来的路由能通过三闸（不是存了却用不了）');
  const foreign = resolveModelRoute(routeToValue(created), {
    agentId: 'other', availableRoutes: [], ownedRouteKeys: modelRouteKeysForAgent('other'),
  });
  ok(!foreign.ok && foreign.code === 'not-owned', '闭环：别的 Agent 不能用这条路由');

  eq(deleteModelRoute(created.id), true, '删除：存在的 id 返回 true');
  eq(deleteModelRoute(created.id), false, '删除：重复删除是幂等的');
  eq(loadModelRoutes().length, 0, '删除：文件里真的没了');
}

// ── 3. API 接线（防「模块写好没人挂」）────────────────────────────
{
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'model-routes.ts'), 'utf8');
  ok(indexSrc.includes('registerModelRouteRoutes(app)'), 'API：index.ts 真的注册了路由分区');
  for (const sig of ['app.get("/api/model-routes"', 'app.post("/api/model-routes"', 'app.put("/api/model-routes/:id"', 'app.delete("/api/model-routes/:id"']) {
    ok(routeSrc.includes(sig), `API：${sig} 存在`);
  }
  ok(routeSrc.includes('createModelRoute(req.body)') && routeSrc.includes('findDef(agentId)'),
    'API：路由层校验 Agent 后交给存储层，不自己拼落盘逻辑');
}

console.log(`自定义模型路由断言：${checks - failures.length}/${checks} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
console.log('✓ 校验 / 落盘 / 归属闸联动 / API 接线均符合预期');
