/**
 * 界面偏好（A135）。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 * 主题 / 透明度 / 两侧栏宽 / 工作区开关 / 光斑 / 默认模型。
 *
 * 前端**启动时不读这个接口** —— 它读的是 index.html 里内联的
 * `window.__OPC_PREFS__`（见 index.ts 的 sendIndexHtml）。留 GET 是为了
 * 闸门能直接对账「磁盘上到底是什么」，以及将来别处（比如移动端壳）
 * 需要一个正常接口。
 */

import type { Express } from 'express';
import { loadPrefs, savePrefs, validatePrefsPatch } from '../preferences.js';

export function registerPreferencesRoutes(app: Express): void {
  app.get("/api/preferences", (_req, res) => {
    try {
      res.json(loadPrefs());
    } catch (error: any) {
      console.error("[Preferences] Get error:", error);
      res.status(500).json({ error: error?.message || "读取界面偏好失败" });
    }
  });

  app.patch("/api/preferences", (req, res) => {
    // 校验失败一律 400 并回原文，**不夹紧、不忽略未知字段**：
    // 静默纠正会让「设了但没生效」这种问题只能靠肉眼发现。
    const result = validatePrefsPatch(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    try {
      res.json(savePrefs(result.patch));
    } catch (error: any) {
      console.error("[Preferences] Save error:", error);
      res.status(500).json({ error: error?.message || "保存界面偏好失败" });
    }
  });
}
