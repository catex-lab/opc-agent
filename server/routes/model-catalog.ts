/**
 * 模型清单（目录）状态与刷新。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。两个依赖显式注入：
 * `cachedModelCount` 是 model-cache.ts 可变引用的转发（原因见 index.ts 注释），
 * `loadSdkModels` 是 index.ts 的模块内闭包（依赖 _setSdkCache / sdkRuntimeFor）。
 */

import type { Express } from 'express';
import { getCatalogSummary, loadCatalog } from '../agents/modelCatalog.js';
import { invalidateAllModelCaches } from '../model-cache.js';

export interface ModelCatalogRoutesDeps {
  /** 已缓存的 WorkBuddy（SDK）模型条数；0 表示「还没取过」，不是「没有模型」 */
  cachedModelCount: () => number;
  /** 强制重取 SDK 模型清单（index.ts 的 loadSdkModels） */
  loadSdkModels: (force?: boolean) => Promise<{ models: readonly unknown[]; defaultModel?: string }>;
}

export function registerModelCatalogRoutes(app: Express, deps: ModelCatalogRoutesDeps): void {
  /**
   * 当前模型清单的概况：每个 Agent 枚举到几条 + 上次枚举完成时间。
   *
   * **不触发任何 CLI 子进程**：只读内存里的目录状态。设置页一打开就跑一遍
   * `qodercli`（7.5s）是不可接受的 —— 想真刷新是用户点按钮的动作。
   */
  app.get("/api/model-catalog", async (req, res) => {
    try {
      // 首次访问时把目录带起来（启动预热通常已经完成，这里几乎瞬时返回）
      await loadCatalog();
      res.json({
        ...getCatalogSummary(),
        // WorkBuddy 走 SDK，不在 catalog 里。0 表示「还没取过」，不是「没有模型」
        workbuddyCount: deps.cachedModelCount(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "读取模型清单失败" });
    }
  });

  /**
   * 刷新模型清单（用户主动点）。
   *
   * 两套缓存都要作废，否则会刷新一半：
   *   - `modelCatalog` 的目录（opencode / qoder / codex）→ `invalidateCatalog()`
   *   - `cachedModels`（WorkBuddy 的 SDK 清单）→ 置空后重新问 SDK
   *
   * 会真的跑三个 CLI + 建一次 SDK 会话，实测 10~15s。前端必须给 loading，
   * 别让用户以为点了没反应。
   */
  app.post("/api/model-catalog/refresh", async (req, res) => {
    const startedAt = Date.now();
    try {
      invalidateAllModelCaches('POST /api/model-catalog/refresh 用户手动刷新');

      await loadCatalog(true);

      // WorkBuddy 单独重取：它不在 catalog 里。失败不影响另外三个的结果，
      // 如实回报错误，而不是把「没取到」显示成「0 个模型」。
      let workbuddy: { count: number; error?: string } = { count: 0 };
      try {
        const sdk = await deps.loadSdkModels(true);
        workbuddy = { count: sdk.models.length };
      } catch (e) {
        workbuddy = { count: 0, error: (e as Error)?.message || String(e) };
      }

      const summary = getCatalogSummary();
      const counts = Object.entries(summary.counts)
        .map(([id, n]) => `${id}=${n}`)
        .join(' ');
      console.log(`[ModelCatalog] 用户手动刷新：${counts} workbuddy=${workbuddy.count}，耗时 ${Date.now() - startedAt}ms`);

      res.json({
        ...summary,
        workbuddy,
        tookMs: Date.now() - startedAt,
      });
    } catch (error: any) {
      console.error("[ModelCatalog] 刷新失败:", error);
      res.status(500).json({ error: error?.message || "刷新模型清单失败" });
    }
  });
}
