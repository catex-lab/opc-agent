/**
 * 凭据「检测」与「有效期」的共享判定。
 *
 * 这里只回答一个问题：**本机有没有凭据，若有，能不能预知它已经过期**。
 * 它**不代表**凭据一定还能用 —— 所以所有成功态文案都必须带「（未校验）」。
 *
 * 三条硬规则（与产品约定一致）：
 *   1. 有 refresh_token 的过期凭据**不判死**：下次使用会尝试刷新，状态仍是可用；
 *      只是文案改成「已过期，首次使用会尝试刷新」。
 *   2. 没有 refresh_token 的过期凭据才判 `needs-auth`。
 *   3. 文件不存在 = 没有凭据；文件存在但解析不出任何 token = 也当没有（
 *      `.claude.json` 这种「存在不代表登录」的文件就是这条规则的由来）。
 *
 * 为什么单独一个模块：Codex、Claude、Kimi Code 三个适配器都要读不同形状的
 * 凭据文件，但「过期是否可预知 / 有刷新令牌就不判死」的判定必须只有一份。
 * 各写一份迟早出现「Codex 说有刷新、Claude 说没有」这种自相矛盾。
 */

import fs from 'fs';
import os from 'os';
import { workbuddyKeyblobPath } from './wbProductProfile.js';
import { findDef } from './definitions.js';
import path from 'path';

/** 一次凭据检测的结论。`expiresAt` 一律是 epoch 毫秒。 */
export type CredentialVerdict =
  /** 没找到凭据文件，或文件里没有任何可识别的 token */
  | { state: 'absent' }
  /** 有凭据；能读到有效期时一并给出 */
  | { state: 'present'; expiresAt?: number }
  /** 已过期，但带 refresh_token —— 下次使用会尝试刷新，不能判不可用 */
  | { state: 'expired-refreshable'; expiresAt: number }
  /** 已过期且没有 refresh_token —— 需要重新登录 */
  | { state: 'expired-needs-login'; expiresAt: number }
  /** 文件在，但读不懂（损坏 / 非 JSON） */
  | { state: 'unreadable'; reason: string };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 把秒 / 毫秒 / ISO 字符串统一成 epoch 毫秒；认不出来就返回 null */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 2026 年的秒级时间戳约 1.7e9，毫秒级约 1.7e12。小于 1e12 按秒处理。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) return toEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 从 JWT 的 payload 里取 `exp`。
 *
 * Codex 的 `tokens.id_token` 是标准 JWT（本机实测 2026-11-04 的解码结果里有
 * `exp`），所以这里**只解码 payload，不验签** —— 我们要的是「会不会过期」，
 * 不是「这张票是不是伪造的」。
 */
export function decodeJwtExpiry(token: unknown): number | null {
  if (!nonEmpty(token)) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return toEpochMs(payload?.exp);
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function quietStat(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function decide(expiresAt: number | null, hasRefresh: boolean): CredentialVerdict {
  if (!expiresAt) return { state: 'present' };
  if (expiresAt > Date.now()) return { state: 'present', expiresAt };
  return hasRefresh
    ? { state: 'expired-refreshable', expiresAt }
    : { state: 'expired-needs-login', expiresAt };
}

/**
 * Codex：`~/.codex/auth.json`。
 * 结构（本机实测）：`tokens.id_token` / `tokens.refresh_token` / `OPENAI_API_KEY`。
 */
export function inspectCodexCredentials(home = os.homedir()): CredentialVerdict {
  const file = path.join(home, '.codex', 'auth.json');
  if (!quietStat(file)) return { state: 'absent' };
  try {
    const raw = readJson(file) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { id_token?: unknown; refresh_token?: unknown };
    };
    if (nonEmpty(raw?.OPENAI_API_KEY)) return { state: 'present' };
    const expiresAt = decodeJwtExpiry(raw?.tokens?.id_token);
    const hasRefresh = nonEmpty(raw?.tokens?.refresh_token);
    // 文件在、但连 id_token 都读不到 —— 不能当「已登录」的证据
    if (!expiresAt && !hasRefresh) return { state: 'absent' };
    return decide(expiresAt, hasRefresh);
  } catch (err) {
    return { state: 'unreadable', reason: (err as Error)?.message || String(err) };
  }
}

/**
 * Kimi Code：`~/.kimi-code/credentials/kimi-code.json`。
 *
 * 之前探测看的是 `config.toml` —— 那是配置，不是凭据；登录后它不会变，
 * 退出登录后也不会被删，所以「存在」既会误判已登录，也会漏掉过期。
 * 结构（本机实测）：`access_token` / `refresh_token` / `expires_at`（秒）。
 */
export function inspectKimiCodeCredentials(home = os.homedir()): CredentialVerdict {
  const file = path.join(home, '.kimi-code', 'credentials', 'kimi-code.json');
  if (!quietStat(file)) return { state: 'absent' };
  try {
    const raw = readJson(file) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
    };
    const hasToken = nonEmpty(raw?.access_token) || nonEmpty(raw?.refresh_token);
    if (!hasToken) return { state: 'absent' };
    return decide(toEpochMs(raw?.expires_at), nonEmpty(raw?.refresh_token));
  } catch (err) {
    return { state: 'unreadable', reason: (err as Error)?.message || String(err) };
  }
}

/**
 * Claude：`~/.claude/.credentials.json`（OAuth）或 `~/.claude.json` 的 `oauthAccount`。
 *
 * 原判定只看 `.claude.json` 是否存在 —— 但那个文件是**应用配置**，
 * 任何人跑过一次 `claude` 就会有，内容里根本没有账号（本机实测无 `oauthAccount`）。
 * 用它当「已登录」的证据，必然会显示一个绿点，然后一用就 401。
 */
export function inspectClaudeCredentials(home = os.homedir()): CredentialVerdict {
  const credFile = path.join(home, '.claude', '.credentials.json');
  if (quietStat(credFile)) {
    try {
      const raw = readJson(credFile) as Record<string, unknown> & {
        claudeAiOauth?: Record<string, unknown>;
        oauth?: Record<string, unknown>;
      };
      const oauth = raw?.claudeAiOauth ?? raw?.oauth ?? raw;
      const accessToken = oauth?.accessToken ?? oauth?.access_token;
      const refreshToken = oauth?.refreshToken ?? oauth?.refresh_token;
      const expiresAt = toEpochMs(oauth?.expiresAt ?? oauth?.expires_at);
      if (nonEmpty(accessToken) || nonEmpty(refreshToken) || expiresAt) {
        return decide(expiresAt, nonEmpty(refreshToken));
      }
    } catch {
      // 读坏了就继续看 .claude.json，不把一次读盘失败直接判成未登录
    }
  }

  const configFile = path.join(home, '.claude.json');
  if (quietStat(configFile)) {
    try {
      const raw = readJson(configFile) as { oauthAccount?: Record<string, unknown> };
      const account = raw?.oauthAccount;
      if (
        account &&
        typeof account === 'object' &&
        (nonEmpty(account.emailAddress) ||
          nonEmpty(account.email) ||
          nonEmpty(account.accountUuid) ||
          nonEmpty(account.organizationUuid))
      ) {
        return { state: 'present' };
      }
    } catch {
      // 同上：不因为配置文件读不动就判「没有登录凭据」
    }
  }

  return { state: 'absent' };
}

/**
 * WorkBuddy 的登录态文件 `~/.workbuddy/keyblob` 的 mtime。
 *
 * 为什么展示 mtime：我们核实过 SDK 没有「只读校验账号」的接口 ——
 * `unstable_v2_authenticate` 与 `Query.accountInfo()` 都只是发 initialize
 * 控制请求，把 CLI 本地缓存的 account 返回（`auth.js:50-60`），不发业务请求，
 * 也不证明这张凭据现在还能用。于是「桌面端活跃」与「keyblob 被刷新」是两件事，
 * 必须让用户看见时间差，而不是给一个假绿点。
 */
export function workbuddyKeyblobInfo(home?: string): {
  path: string;
  exists: boolean;
  mtime?: string;
} {
  /**
   * A211：运行时（不传 home）必须跟着生效 profile 走。官方客户端把活跃目录
   * 从 `~/.workbuddy` 换到 `~/.workbuddy-ai` 之后，继续显示旧文件的 mtime，
   * 「重新登录桌面端」就会变成一条永远刷不到我们读的那份文件的无效指引。
   *
   * 显式传 home 的是只读诊断 / 验证夹具：语义是「在指定主目录下按定义表的
   * 默认数据目录查」，不受运行时 profile 影响（目录名同样从定义表派生，不写死）。
   */
  const defaultFolder = path.basename(
    (findDef('workbuddy')?.sdk?.configDir ?? '~/.workbuddy').replace(/^~[\\/]/, '')
  );
  const file = home ? path.join(home, defaultFolder, 'keyblob') : workbuddyKeyblobPath();
  const st = quietStat(file);
  return { path: file, exists: Boolean(st), ...(st ? { mtime: st.mtime.toISOString() } : {}) };
}

/** 本地时间（给用户看的「最后更新」），只到分钟 */
export function formatLocalMinute(iso?: string): string {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
