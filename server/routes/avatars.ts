/**
 * 头像图片（A160）。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 * 用户头像、Agent Logo 与群自定义头像共用一套「内容哈希落盘」的仓库，
 * 见 server/avatar-store.ts。写接口都只收 dataUrl（前端裁成 320×320 WebP），
 * 服务端嗅探文件头再落盘。
 * 群头像（2026-11-12）：引用关系按 sessionId 登记在 group-avatars.json ——
 * 群的 URL 存前端 localStorage，服务端若不知道「这个群在用这张图」，
 * 用户头像 / Agent Logo 移除同内容图片时会把群头像一起回收掉。
 */

import type { Express } from 'express';
import {
  agentAppearanceSnapshot,
  clearAgentLogo,
  clearGroupAvatarFile,
  deleteAvatarFileIfUnused,
  groupAvatarSnapshot,
  setAgentLogo,
  setGroupAvatarFile,
  storeAvatar,
} from '../avatar-store.js';
import { avatarFilePath } from '../avatar-file.js';
import { loadUserProfile, saveUserProfile } from '../user-profile.js';
import { registry } from '../agents/registry.js';

export function registerAvatarRoutes(app: Express): void {
  app.post("/api/avatars", (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = body.kind;
      if (kind !== "user" && kind !== "agent" && kind !== "group") {
        return res.status(400).json({ error: "kind 必须是 user、agent 或 group" });
      }
      const { url, file } = storeAvatar(body.dataUrl);
      if (kind === "user") {
        const prev = loadUserProfile().avatarImage;
        saveUserProfile({ avatarImage: url });
        if (prev && prev !== url) deleteAvatarFileIfUnused(prev.slice("/api/avatars/".length));
        return res.json({ url, profile: loadUserProfile() });
      }
      if (kind === "group") {
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId) return res.status(400).json({ error: "缺少 sessionId" });
        // 换图时把上一张按「无人引用」清掉（别的群 / 用户头像可能正用着同一张图，
        // deleteAvatarFileIfUnused 自会判）。旧映射必须在 setGroupAvatarFile 之前读。
        const prevFile = groupAvatarSnapshot()[sessionId]?.logo;
        const groupUrl = setGroupAvatarFile(sessionId, file);
        if (prevFile && prevFile !== file) deleteAvatarFileIfUnused(prevFile);
        return res.json({ url: groupUrl, sessionId });
      }
      const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
      if (!agentId) return res.status(400).json({ error: "缺少 agentId" });
      // 只允许改**真实存在**的 Agent：否则这张图永远没人引用，只会占磁盘
      if (!registry.get(agentId)) return res.status(404).json({ error: "Agent 不存在" });
      // 换 Logo 时把上一张按「无人引用」清掉（用户头像可能正用着同一张图）。
      // 旧映射必须在 setAgentLogo **之前**读 —— 之后就只剩新文件了。
      const prevFile = agentAppearanceSnapshot()[agentId]?.logo;
      const logoUrl = setAgentLogo(agentId, file);
      if (prevFile && prevFile !== file) deleteAvatarFileIfUnused(prevFile);
      res.json({ url: logoUrl, agentId });
    } catch (error: any) {
      console.error("[Avatars] Upload error:", error);
      res.status(400).json({ error: error?.message || "保存头像失败" });
    }
  });

  app.delete("/api/avatars", (_req, res) => {
    try {
      const prev = loadUserProfile().avatarImage;
      const next = saveUserProfile({ avatarImage: "" });
      if (prev) deleteAvatarFileIfUnused(prev.slice("/api/avatars/".length));
      res.json({ ok: true, profile: next });
    } catch (error: any) {
      console.error("[Avatars] Delete user error:", error);
      res.status(500).json({ error: error?.message || "移除头像失败" });
    }
  });

  // 移除群自定义头像：解除引用登记，文件本体按「无人引用」回收。
  // 前端在移除 / 恢复默认 / 换回预设时调用；渲染层的 URL 由 sessionFlags 清空。
  app.delete("/api/avatars/group/:sessionId", (req, res) => {
    try {
      const released = clearGroupAvatarFile(req.params.sessionId);
      if (released) deleteAvatarFileIfUnused(released);
      res.json({ ok: true, sessionId: req.params.sessionId });
    } catch (error: any) {
      console.error("[Avatars] Delete group error:", error);
      res.status(500).json({ error: error?.message || "移除头像失败" });
    }
  });

  // 恢复某个 Agent 的内置 Logo。只删映射，不动定义表。
  app.delete("/api/agents/:agentId/logo", (req, res) => {
    try {
      const { agentId } = req.params;
      if (!registry.get(agentId)) return res.status(404).json({ error: "Agent 不存在" });
      const released = clearAgentLogo(agentId);
      if (released) deleteAvatarFileIfUnused(released);
      res.json({ ok: true, agentId });
    } catch (error: any) {
      console.error("[Avatars] Delete agent logo error:", error);
      res.status(500).json({ error: error?.message || "恢复默认 Logo 失败" });
    }
  });

  // 头像文件。内容哈希命名 → 内容永不变，可以放心长缓存。
  app.get("/api/avatars/:file", (req, res) => {
    let filePath: string;
    try {
      filePath = avatarFilePath(req.params.file);
    } catch {
      return res.status(404).json({ error: "头像不存在" });
    }
    res.sendFile(
      filePath,
      { headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
      err => {
        if (err && !res.headersSent) res.status(404).json({ error: "头像不存在" });
      }
    );
  });
}
