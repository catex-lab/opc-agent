/**
 * 场景模板 —— 前端入口（实现已迁到 `shared/scenarios.ts`）。
 *
 * 为什么保留这个文件而不让前端直接 import `shared/`：
 * `src/` 里已有 4 处 `from '../scenarios'` 的引用，保留再导出可以让
 * 「数据层搬到共享位置」这件事对 UI 完全透明，改动面最小。
 *
 * 真正的定义、白名单语义与 `enforcementGap()` 都在 `shared/scenarios.ts`，
 * 那边同时也是后端（按 scenarioId 推导工具白名单）读的那一份 ——
 * 这样前后端不可能拿到两份不一致的场景数据。
 */

export * from '../shared/scenarios';
