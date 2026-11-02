/**
 * 更新链路的固定配置。
 *
 * ## 为什么 owner/repo 写死成常量
 *
 * 仓库已经开源在 GitHub，发布地址是产品行为的一部分，不该在运行时靠
 * `git remote` 猜 —— 用户机器上没有 .git。这里写常量，同时允许环境变量
 * 覆盖，方便本地对着测试仓库验证整条链路：
 *   · `OPC_UPDATE_REPO`          —— `owner/repo`
 *   · `OPC_UPDATE_MANIFEST_URL`  —— 完整清单地址（仍强制 HTTPS）
 *   · `OPC_UPDATE_PUBLIC_KEY`    —— 验签公钥（base64 SPKI）
 *   · `OPC_UPDATE_CHECK_DELAY_MS` / `OPC_UPDATE_CHECK_INTERVAL_MS` —— 检查节奏
 *   · `OPC_UPDATE_STAGING_DIR`   —— 下载暂存目录（默认系统 temp）
 */

import { UPDATE_MANIFEST_URL, UPDATE_REPO_SLUG } from '../../shared/update.js';

/**
 * 内置 ed25519 公钥（SPKI DER，base64）。
 *
 * 对应私钥**只应存在于 GitHub Secrets（`OPC_UPDATE_PRIVATE_KEY`）**，
 * 不要把它写回仓库。换密钥时用 `npm run update:keygen` 生成，再把这里的
 * 公钥替换掉；旧版本客户端只认旧公钥，所以换密钥等于切断自动更新，
 * 需要发一份新包（详见 DEVELOPMENT.md 的更新发布一节）。
 */
export const UPDATE_PUBLIC_KEY_BASE64 =
  process.env.OPC_UPDATE_PUBLIC_KEY?.trim() ||
  'MCowBQYDK2VwAyEA7coZnabk2Rn/j11TWcR0DYFzm1iJPPvWKdKDkC7/MWw=';

/** 固定清单地址；环境变量用于本地/测试仓库，但仍走 HTTPS */
export function manifestUrl(): string {
  const override = process.env.OPC_UPDATE_MANIFEST_URL?.trim();
  if (override) return override;
  const repo = process.env.OPC_UPDATE_REPO?.trim();
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return `https://github.com/${repo}/releases/latest/download/latest.json`;
  }
  return UPDATE_MANIFEST_URL;
}

/** 当前发布仓库（手动下载链接用） */
export function releasesPageUrl(): string {
  const repo = process.env.OPC_UPDATE_REPO?.trim();
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return `https://github.com/${repo}/releases/latest`;
  }
  return `https://github.com/${UPDATE_REPO_SLUG}/releases/latest`;
}

/** 启动后延迟多久做第一次检查（不阻塞首屏） */
export const CHECK_DELAY_MS = Number(process.env.OPC_UPDATE_CHECK_DELAY_MS ?? 5000) || 5000;

/** 之后每 6 小时检查一次。不自动下载 —— 下载必须由用户点 */
export const CHECK_INTERVAL_MS =
  Number(process.env.OPC_UPDATE_CHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000;

/** 等待「新版本成功启动」的健康文件宽限（超时即自动回滚） */
export const HEALTH_TIMEOUT_MS = 45_000;
