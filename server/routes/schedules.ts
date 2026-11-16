/**
 * A224：定时派活（HTTP 面）。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 * /api/schedules 前缀与 /api/sessions 互不吞并，注册位置只求可读性。
 * 调度器本体（startScheduler/stopScheduler 的启动接线）仍在 index.ts。
 */

import type { Express } from 'express';
import * as db from '../db.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  scheduleRuntimeOf,
  updateSchedule,
  type ScheduleTask,
} from '../scheduler.js';
import { cronIntervalWarning, cronPreview } from '../cron.js';

export function registerScheduleRoutes(app: Express): void {
  app.get("/api/schedules", (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const tasks: Array<ScheduleTask & { runtime: { running: boolean } }> = listSchedules(sessionId).map(t => ({
        ...t,
        runtime: scheduleRuntimeOf(t),
      }));
      res.json({ tasks });
    } catch (error: any) {
      console.error("[Scheduler] List error:", error);
      res.status(500).json({ error: error?.message || "获取定时任务失败" });
    }
  });

  // 预览未来几次触发：表单里选完表达式立即看到「下一次是几点」，用户不必心算 cron
  app.post("/api/schedules/preview", (req, res) => {
    const expr = String((req.body ?? {}).cron ?? '');
    const parsed = cronPreview(expr, 3);
    res.json({ runs: parsed.map(d => d.toISOString()), nextRunAt: parsed[0]?.toISOString() ?? null });
  });

  app.post("/api/schedules", (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = String(body.sessionId ?? '');
      if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' });
      const session = db.getSession(sessionId);
      if (!session) return res.status(404).json({ error: '会话不存在' });
      const cron = String(body.cron ?? '');
      // 高频拒绝放在创建边界：语法合法 ≠ 该跑（每次都是真实调用）
      const warning = cronIntervalWarning(cron);
      if (warning) return res.status(400).json({ error: warning });
      const result = createSchedule(
        {
          sessionId,
          prompt: String(body.prompt ?? ''),
          cron,
          enabled: body.enabled !== false,
          agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
        },
        session
      );
      if ('error' in result) return res.status(400).json({ error: result.error });
      res.json({ task: { ...result, runtime: scheduleRuntimeOf(result) } });
    } catch (error: any) {
      console.error("[Scheduler] Create error:", error);
      res.status(500).json({ error: error?.message || "创建定时任务失败" });
    }
  });

  app.patch("/api/schedules/:id", (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.cron !== undefined) {
        const warning = cronIntervalWarning(String(body.cron));
        if (warning) return res.status(400).json({ error: warning });
      }
      const task = updateSchedule(req.params.id, {
        ...(body.prompt !== undefined ? { prompt: String(body.prompt) } : {}),
        ...(body.cron !== undefined ? { cron: String(body.cron) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      });
      if (!task) return res.status(404).json({ error: '定时任务不存在或参数非法' });
      res.json({ task: { ...task, runtime: scheduleRuntimeOf(task) } });
    } catch (error: any) {
      console.error("[Scheduler] Patch error:", error);
      res.status(500).json({ error: error?.message || "修改定时任务失败" });
    }
  });

  app.delete("/api/schedules/:id", (req, res) => {
    try {
      const removed = deleteSchedule(req.params.id);
      if (!removed) return res.status(404).json({ error: '定时任务不存在' });
      res.json({ ok: true });
    } catch (error: any) {
      console.error("[Scheduler] Delete error:", error);
      res.status(500).json({ error: error?.message || "删除定时任务失败" });
    }
  });
}
