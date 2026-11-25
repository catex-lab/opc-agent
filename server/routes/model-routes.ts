/**
 * 用户自定义模型路由 API。
 *
 * 这里只暴露「定义 + 引用名」，没有明文密钥。写入前一律走
 * `normalizeModelRouteInput()`：非法值 400，不静默纠正
 * （沿用会话级设置的 A123 纪律）。
 */
import type { Express } from 'express';
import { findDef } from '../agents/definitions.js';
import {
  createModelRoute,
  deleteModelRoute,
  loadModelRoutes,
  updateModelRoute,
} from '../modelRoutes.js';

export function registerModelRouteRoutes(app: Express): void {
  app.get("/api/model-routes", (req, res) => {
    try {
      const raw = String(req.query.agentId ?? '').trim();
      res.json({ routes: raw ? loadModelRoutes(raw) : loadModelRoutes() });
    } catch (error: any) {
      console.error('[ModelRoutes] List error:', error);
      res.status(500).json({ error: error?.message || '获取自定义模型路由失败' });
    }
  });

  app.post("/api/model-routes", (req, res) => {
    try {
      const agentId = String(req.body?.agentId ?? '').trim();
      if (!findDef(agentId)) {
        return res.status(400).json({ error: `未知的 Agent：${agentId}` });
      }
      const route = createModelRoute(req.body);
      res.status(201).json({ route });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || '保存自定义模型路由失败' });
    }
  });

  app.put("/api/model-routes/:id", (req, res) => {
    try {
      const agentId = String(req.body?.agentId ?? '').trim();
      if (!findDef(agentId)) {
        return res.status(400).json({ error: `未知的 Agent：${agentId}` });
      }
      const route = updateModelRoute(req.params.id, req.body);
      if (!route) return res.status(404).json({ error: '自定义模型路由不存在' });
      res.json({ route });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || '更新自定义模型路由失败' });
    }
  });

  app.delete("/api/model-routes/:id", (req, res) => {
    try {
      const ok = deleteModelRoute(req.params.id);
      if (!ok) return res.status(404).json({ error: '自定义模型路由不存在' });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || '删除自定义模型路由失败' });
    }
  });
}
