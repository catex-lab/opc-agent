/**
 * Agent 凭据（应用内登录）与多账号 profile。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 * 所有存取都走 agent-credentials.ts，路由只负责校验入参与「保存后立刻重探」。
 */

import type { Express } from 'express';
import {
  clearCredential,
  deleteProfile,
  listCredentials,
  listProfiles,
  saveCredential,
  switchProfile,
} from '../agent-credentials.js';
import { findDef } from '../agents/definitions.js';
import { registry } from '../agents/registry.js';
import { invalidateAllModelCaches } from '../model-cache.js';

export function registerAgentCredentialRoutes(app: Express): void {
  /**
   * 列出可在应用内配置凭据的 Agent。
   *
   * 只返回「声明了 credential 的」——没声明的（走 OAuth / 登录态文件的）
   * 在这里列出来只会让用户填一个不生效的 Key。
   */
  app.get("/api/agent-credentials", (req, res) => {
    try {
      res.json({ credentials: listCredentials() });
    } catch (error: any) {
      console.error("[Credentials] list error:", error);
      res.status(500).json({ error: error?.message || "读取凭据失败" });
    }
  });

  /**
   * 保存凭据并**立刻重探该 Agent**。
   *
   * 不重探的话，用户填完 Key 界面上仍是「未登录」（探测结果有 5 分钟 TTL），
   * 会以为没保存成功 —— 而这条路径最需要的就是即时反馈。
   */
  app.post("/api/agent-credentials", async (req, res) => {
    try {
      const { agentId, key, baseUrl, name } = req.body ?? {};
      if (typeof agentId !== 'string' || !agentId) {
        return res.status(400).json({ error: "缺少 agentId" });
      }
      if (key !== undefined && typeof key !== 'string') {
        return res.status(400).json({ error: "key 必须是字符串" });
      }
      if (baseUrl !== undefined && typeof baseUrl !== 'string') {
        return res.status(400).json({ error: "baseUrl 必须是字符串" });
      }
      // #15：name 给了就是「另存为一个账号」。不传 = 改当前账号（老前端零改动）
      if (name !== undefined && typeof name !== 'string') {
        return res.status(400).json({ error: "name 必须是字符串" });
      }

      const credential = saveCredential(agentId, { key, baseUrl, name });
      // 新 Key 可能让 `opencode models` 多出若干个 provider 的模型：
      // 目录缓存必须跟着作废，否则用户填完 Key 还要等 24 小时才看见新模型。
      // SDK 缓存也一起清：虽然 SDK 走 OAuth 不经这条路径，但从「凭据变更后
      // 所有模型缓存都应该是干净的」这个不变量来看，统一失效更安全。
      invalidateAllModelCaches(`saveCredential(${agentId})`);
      const agent = await registry.probeOne(agentId, true);
      res.json({ credential, agent });
    } catch (error: any) {
      console.error("[Credentials] save error:", error);
      res.status(400).json({ error: error?.message || "保存凭据失败" });
    }
  });

  // 清除某个 Agent 在应用内保存的凭据
  app.delete("/api/agent-credentials/:agentId", async (req, res) => {
    try {
      const credential = clearCredential(req.params.agentId);
      if (!credential) return res.status(404).json({ error: "该 Agent 不支持应用内凭据" });
      // 清掉 Key 后对应 provider 的模型会从 CLI 清单里消失，目录同样要重算
      invalidateAllModelCaches(`clearCredential(${req.params.agentId})`);
      const agent = await registry.probeOne(req.params.agentId, true);
      res.json({ credential, agent });
    } catch (error: any) {
      console.error("[Credentials] clear error:", error);
      res.status(500).json({ error: error?.message || "清除凭据失败" });
    }
  });

  /* #15：多账号 profile。三个端点都只回掩码视图，明文 Key 绝不出现在响应里。 */

  app.get("/api/agent-credentials/:agentId/profiles", (req, res) => {
    try {
      const agentId = req.params.agentId;
      if (!findDef(agentId)) return res.status(404).json({ error: "未知 Agent" });
      res.json(listProfiles(agentId));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "读取账号列表失败" });
    }
  });

  app.post("/api/agent-credentials/:agentId/switch", async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const name = req.body?.name;
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: "缺少 name" });
      }
      const credential = switchProfile(agentId, name);
      // 换账号 = 换了可见的 provider / 模型，缓存必须一起作废（P1 统一失效入口）
      invalidateAllModelCaches(`switchProfile(${agentId})`);
      const agent = await registry.probeOne(agentId, true);
      res.json({ credential, agent });
    } catch (error: any) {
      console.error("[Credentials] switch error:", error);
      res.status(400).json({ error: error?.message || "切换账号失败" });
    }
  });

  app.delete("/api/agent-credentials/:agentId/profiles/:name", async (req, res) => {
    try {
      const { agentId, name } = req.params;
      const profiles = deleteProfile(agentId, name);
      invalidateAllModelCaches(`deleteProfile(${agentId})`);
      const agent = await registry.probeOne(agentId, true);
      res.json({ profiles, agent });
    } catch (error: any) {
      console.error("[Credentials] delete profile error:", error);
      res.status(400).json({ error: error?.message || "删除账号失败" });
    }
  });
}
