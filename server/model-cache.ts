/**
 * SDK 模型缓存状态 + 统一失效入口。
 *
 * 从 `server/index.ts` 抽出来是为了让闸门能 import 到函数本体，
 * 断言「凭据变更后三层缓存全清」——内联在 index.ts 里时单测拿不到。
 *
 * ## 三层缓存分别是什么
 *
 * 1. **`cachedModels`** — WorkBuddy SDK `getAvailableModelsRaw()` 返回的模型清单。
 *    全局单值：WorkBuddy 走 OAuth 登录态，不走应用内凭据，所以同一时间只有一份。
 * 2. **`sdkDefaultModel`** — SDK 自己声明的默认模型（`isDefault`），优先于平台常量。
 * 3. **`sdkModelsProbedAt`** — SDK 清单**真正被取过**的时刻（不是 GET 命中缓存的时间）。
 *
 * CLI 目录缓存（`modelCatalog` 的 `state`）不在这里管——它有自己的 `invalidateCatalog()`。
 * `invalidateAllModelCaches()` 把两者串起来，保证凭据变更后不留下半失效。
 */
import type { ModelOption } from "./agents/modelCatalog.js";
import { invalidateCatalog } from "./agents/modelCatalog.js";

/** 缓存可用模型列表（含 description / 免费付费角标，见 agents/sdk-models.ts） */
export let cachedModels: ModelOption[] = [];
/** SDK 自己声明的默认模型（`isDefault`），拿到之后优先于平台常量 */
export let sdkDefaultModel: string | undefined;
/**
 * P0：SDK 清单**真正被取过**的时刻。
 *
 * 不是「上次有人来 GET /api/models 的时间」：命中缓存时清单还是旧的，
 * 把 probedAt 刷成现在，等于每分钟都对用户说「这是刚拉的实时清单」。
 * 只在 `loadSdkModels()` 真的建了 SDK 会话时才更新。
 */
export let sdkModelsProbedAt = 0;

/** 内部 setter：loadSdkModels 取到清单后更新缓存值 */
export function _setSdkCache(models: ModelOption[], defaultMdl?: string): void {
  cachedModels = models;
  if (defaultMdl) sdkDefaultModel = defaultMdl;
}

/** 内部 setter：记录 SDK 取数时刻 */
export function _setSdkProbedAt(ts: number): void {
  sdkModelsProbedAt = ts;
}

/**
 * 统一作废所有模型缓存。
 *
 * 有三处分散的「清一半」路径曾经各清各的：
 *   - `POST /api/env` 改 SDK 凭据 → 只清了 `cachedModels`，没清 CLI 目录；
 *   - `saveCredential()` / `clearCredential()` 改 CLI Agent 凭据 → 只清了
 *     `invalidateCatalog()`，没清 SDK 缓存；
 *   - `POST /api/model-catalog/refresh` 是唯一两边都清的。
 *
 * 凭据变更后「另一半缓存还是旧的」不会立刻报错——它只是让用户以为
 * 「我改了 Key，怎么模型列表没变」，然后等 TTL 自然过期才看到新模型。
 * 统一入口杜绝这种静默的半失效。
 */
export function invalidateAllModelCaches(reason: string): void {
  console.log(`[Models] 缓存全量失效（${reason}）`);
  cachedModels = [];
  sdkDefaultModel = undefined;
  sdkModelsProbedAt = 0;
  invalidateCatalog();
}

/** 测试用：查当前 SDK 缓存是否为空（供闸门断言「失效后确实空了」） */
export function __sdkCacheEmpty(): boolean {
  return cachedModels.length === 0 && sdkDefaultModel === undefined && sdkModelsProbedAt === 0;
}

/** 测试用：手动塞值（供闸门构造「缓存非空」的初始状态） */
export function __setSdkCacheForTest(models: ModelOption[], defaultMdl?: string, probedAt?: number): void {
  cachedModels = models;
  sdkDefaultModel = defaultMdl;
  sdkModelsProbedAt = probedAt ?? 0;
}
