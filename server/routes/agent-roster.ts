/**
 * Agent 名册 API。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 * 包含名册查询/探测、登录代管（P2）、真实健康度检测（P1 canary）。
 *
 * ⚠️ 注册顺序：本文件的 login-terminal 路由必须注册在「用户自建 Agent」
 * 分区的 `/api/agents/:agentId`（参数路由）之前 —— index.ts 的接线顺序
 * 与拆分前一致，别调换。
 */

import type { Express } from 'express';
import * as db from '../db.js';
import { registry } from '../agents/registry.js';
import { COMING_SOON_AGENTS } from '../agents/comingSoon.js';
import { runCanary, scheduleAutoCanaries } from '../agents/canary.js';
import { getLoginState, startLogin, stopLogin, writeLogin } from '../agents/loginRunner.js';
import type { CapabilityProfile } from '../../shared/capabilities.js';

/**
 * 给名册条目挂上「最近一次观测到的过程能力」（P2）。
 *
 * 为什么不并进 `registry.toInfo()`：那层不碰数据库（探测要能被纯单测驱动），
 * 而这份数据在 SQLite 里。放这里合并，注册表仍然只回答「声明了什么」。
 *
 * 导出而非文件内私有：「用户自建 Agent」分区的 `/api/agents/:agentId`
 * 详情路由也用同一份合并逻辑（index.ts 迁出前就是这个形状）。
 */
export function withObservedCapabilities<T extends { id: string }>(
  agents: T[]
): Array<T & { observedCapabilities?: CapabilityProfile }> {
  return agents.map(a => {
    try {
      const observed = db.latestCapabilityProfileFor(a.id);
      return observed ? { ...a, observedCapabilities: observed } : a;
    } catch {
      // 老库还没建这张表 / 读失败：不挂字段。界面按「未观察到」显示，
      // 比挂一个空对象冒充「观察到零项」更诚实。
      return a;
    }
  });
}

/**
 * A210「即将接入」占位清单：以**平级字段**下发，`agents` 数组原样不动。
 *
 * 为什么平级：所有 `agents.map/filter` 消费方（联系人、新建会话选择器、
 * 权限门）都不可能把占位条目当成可选 Agent。塞进 `agents` 数组就等于
 * 让它被后台探测、被选中发消息，还会被 `isInstallable()` 画出一个装不上的
 * 安装按钮 —— 比不展示更伤。
 *
 * 与已注册 Agent 同 id 的自动剔除：真接入时用同一个 id 进 `AGENT_DEFS`
 * 即可「转正」，不需要前端再改一行。
 */
function comingSoonList(): Array<(typeof COMING_SOON_AGENTS)[number]> {
  const registered = new Set(registry.list().map(a => a.id));
  return COMING_SOON_AGENTS.filter(a => !registered.has(a.id));
}

export function registerAgentRosterRoutes(app: Express): void {
  // ════════ P2：登录代管（可见终端 + 退出自动 canary 复检）════════
  // 路由必须注册在 /api/agents/:agentId 之前（既有规矩）。

  app.post("/api/agents/login-terminal/start", (req, res) => {
    try {
      const agentId = String((req.body ?? {}).agentId ?? '');
      if (!agentId) return res.status(400).json({ error: '缺少 agentId' });
      const result = startLogin(agentId);
      if ('error' in result) return res.status(400).json({ error: result.error });
      res.json({ ok: true, ...result });
    } catch (error: any) {
      console.error('[LoginRunner] Start error:', error);
      res.status(500).json({ error: error?.message || '启动登录失败' });
    }
  });

  app.get("/api/agents/login-terminal/state", (_req, res) => {
    res.json(getLoginState());
  });

  app.post("/api/agents/login-terminal/write", (req, res) => {
    const data = String((req.body ?? {}).data ?? '');
    if (!data) return res.status(400).json({ error: '缺少 data' });
    writeLogin(data.includes('\n') ? data : data + '\r');
    res.json({ ok: true });
  });

  app.post("/api/agents/login-terminal/stop", (_req, res) => {
    stopLogin();
    res.json({ ok: true });
  });

  // P1：手动「真实检测」。force = 不受 TTL 频控（用户点了按钮就要有动作）；
  // agentId 缺省 = 全部可检测的都测一遍。fire-and-forget：检测最长要等 SDK
  // 冷启动（2 分钟预算），挂住 HTTP 请求只会让前端转圈——结果由轮询收回。
  app.post("/api/agents/canary", (req, res) => {
    try {
      const target = typeof (req.body ?? {}).agentId === 'string' ? (req.body as any).agentId : null;
      const ids = target
        ? [target]
        : registry
            .list()
            .filter(a => a.status.availability !== 'not-installed' && a.status.availability !== 'unsupported')
            .map(a => a.id);
      if (target && !registry.hasAgent(target)) {
        return res.status(404).json({ error: `未知的 Agent: ${target}` });
      }
      for (const id of ids) void runCanary(id);
      res.json({ ok: true, started: ids.length });
    } catch (error: any) {
      console.error("[Canary] Start error:", error);
      res.status(500).json({ error: error?.message || '启动真实检测失败' });
    }
  });

  // 列出全部 Agent（含探测状态）。带 TTL 缓存，不会每次都重探。
  app.get("/api/agents", async (req, res) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      if (force) {
        return res.json({
          agents: withObservedCapabilities(await registry.probeAll(true)),
          comingSoon: comingSoonList(),
        });
      }
      // 冷启动时缓存是空的，此时名册里全是 unknown（前端会显示成「未接入」）。
      // 这里把探测在后台启动起来，本次仍按当前缓存如实返回，由前端轮询补齐。
      registry.ensureProbedInBackground();
      // P1：名册打开 = 自动 canary 的触发点。TTL/频控/开关都在 canary 模块内，
      // fire-and-forget——本次响应如实返回当前状态，前端既有轮询收回结果。
      scheduleAutoCanaries(registry.list().map(a => a.id));
      res.json({
        agents: withObservedCapabilities(registry.list()),
        comingSoon: comingSoonList(),
      });
    } catch (error: any) {
      console.error("[Agents] Error:", error);
      res.status(500).json({ error: error?.message || "获取 Agent 列表失败" });
    }
  });

  // 主动触发全量探测（首次打开名册页时调用）
  app.post("/api/agents/probe", async (req, res) => {
    try {
      const agents = await registry.probeAll(true);
      res.json({ agents: withObservedCapabilities(agents), comingSoon: comingSoonList() });
    } catch (error: any) {
      console.error("[Agents] Probe error:", error);
      res.status(500).json({ error: error?.message || "探测失败" });
    }
  });
}
