/**
 * 用户资料（A115）。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 * 昵称由 registry.stream() 注入 systemPrompt（见 server/user-profile.ts 的
 * withUserIdentity），所以它必须是服务端状态；头像只在本机界面上用，
 * 但两份放在一起存、一起改，用户少一个入口。
 */

import type { Express } from 'express';
import { deleteAvatarFileIfUnused } from '../avatar-store.js';
import { loadUserProfile, saveUserProfile } from '../user-profile.js';

export function registerUserProfileRoutes(app: Express): void {
  app.get("/api/user-profile", (_req, res) => {
    try {
      res.json(loadUserProfile());
    } catch (error: any) {
      console.error("[UserProfile] Get error:", error);
      res.status(500).json({ error: error?.message || "读取用户资料失败" });
    }
  });

  app.put("/api/user-profile", (req, res) => {
    try {
      // 只认这三个字段，别的键一律忽略 —— 免得调用方把整个 req.body 倒进来
      // 把文件撑成谁都不知道形状的东西。
      // A160：avatarImage 只接受 `/api/avatars/<file>` 形状（normalize 里再校验一次）；
      // 旧文件在保存后按「无人引用」清理。
      const { nickname, avatar, avatarImage } = req.body ?? {};
      const prevImage = loadUserProfile().avatarImage;
      const next = saveUserProfile({
        ...(typeof nickname === "string" ? { nickname } : {}),
        ...(typeof avatar === "string" ? { avatar } : {}),
        ...(typeof avatarImage === "string" ? { avatarImage } : {}),
      });
      if (prevImage && prevImage !== next.avatarImage) {
        const oldFile = prevImage.slice("/api/avatars/".length);
        deleteAvatarFileIfUnused(oldFile);
      }
      res.json(next);
    } catch (error: any) {
      console.error("[UserProfile] Save error:", error);
      res.status(500).json({ error: error?.message || "保存用户资料失败" });
    }
  });
}
