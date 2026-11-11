/**
 * 日志脱敏（P2 加固）。
 *
 * 出参侧已有 `agent-credentials.ts` 的掩码：它露头尾 6+4 位，是给用户在设置页
 * 确认「填的是哪一把 Key」用的。日志的读者不同 —— 排查问题时只需要知道
 * 「有没有这个值」「两次是不是同一个值」「URL 走到了哪个主机」，**不需要**看到
 * 明文，也不需要看到够还原明文的前缀。
 *
 * 所以这里给的是长度 + 8 位短指纹（sha256 截前 8 个十六进制字符）：
 * 同一个令牌每次打出来都一样，可以跨日志行追踪；不同令牌指纹不同；
 * 但任何一行日志都不足以还原原文。URL 额外保留 origin + path 便于确认
 * 走到了哪个端点，query / fragment 里的 OAuth `state` / `code` 一律丢掉。
 *
 * 适用场景：续接令牌（resumeToken）、认证 URL 这类"服务端内部值"。
 * 不要用于用户消息正文 —— 那不是秘密，也不该被改写得看不懂。
 */

import { createHash } from 'node:crypto';

/** 敏感值 → `<redacted len=… fp=…>`。空值单独标出，别和「没走这条分支」混淆。 */
export function redactSecret(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!raw) return '<redacted:empty>';
  const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `<redacted len=${raw.length} fp=${fingerprint}>`;
}

/** URL → 只留 `协议//主机/路径`，query 与 fragment 明确标注已移除。解析失败时退化成指纹。 */
export function redactUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!raw) return '<redacted:empty-url>';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}<query-redacted>`;
  } catch {
    // 不是合法 URL（可能是 SDK 返回的某种自定义串）：宁可只给指纹，也别原样打出来
    return redactSecret(raw);
  }
}
