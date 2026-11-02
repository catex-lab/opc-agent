/**
 * 知识库脱敏（P1）。
 *
 * 原则是**整段删除，不打码**：`sk-…` 变成空，而不是 `sk-****`。打码会留下
 * 长度、前缀、后缀这些可猜信息，也会让“看起来已经处理过”掩盖真正的泄漏。
 *
 * 两道闸门：
 *   1. 入库前：`redactForStorage()` 清洗后立刻 `assertRedactionClean()`；
 *   2. 出库前：搜索结果再过一次同样的检查，任何残留都 fail-closed。
 *
 * 这里只做文本级清洗，不读 `.env` 文件；能命中 `.env` 正文里的 `KEY=VALUE`。
 */

export class KbRedactionError extends Error {
  readonly code = 'KB_REDACTION_FAILED';
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`脱敏失败：${reasons.join(', ')}`);
    this.name = 'KbRedactionError';
    this.reasons = reasons;
  }
}

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const KNOWN_TOKEN =
  /(?:sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

const BEARER_CREDENTIAL = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]+)?@/gi;

/** 一行 `KEY=VALUE`：`.env` 正文的典型形态。 */
const ENV_LINE = /(^|\n)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)([^\n]*)/g;

/** `key: "value"` / `key='value'` */
const QUOTED_ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*[:=][ \t]*)(["'])([^"'\n]{3,})\3/g;

/** `key=value` / `key: value`（不带引号） */
const BARE_ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*[:=][ \t]*)([^\s,;)\]}"']{4,})/g;

const SECRET_NAME =
  /^(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|refresh[_-]?token|access[_-]?token|session[_-]?token|token|secret|password|passwd|pwd|pass|credential|credentials|authorization|auth|key|private)$/i;

/**
 * 以敏感词结尾的键名（`OPENAI_API_KEY` / `GITHUB_TOKEN` / `DB_PASSWORD` 这类
 * 常见变体）。分隔符必须是词首或 `_` / `-`，避免把 `MONKEY`、`HOTKEY`
 * 这样的普通单词误判成密钥名。
 */
const SECRET_SUFFIX =
  /(?:^|[_-])(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|key|token|secret|password|passwd|pass|credential|credentials|auth|private)$/i;

function isSecretName(name: string): boolean {
  const normalized = name.trim().replace(/[^\w.-]/g, '');
  return SECRET_NAME.test(normalized) || SECRET_SUFFIX.test(normalized);
}

function resetGlobal(re: RegExp): RegExp {
  re.lastIndex = 0;
  return re;
}

/**
 * 入库前脱敏。返回清洗后的文本与删除段数。
 *
 * 顺序很重要：先删私钥块和已知 token 形态，再处理 `.env` 行与键值对，
 * 最后清 URL 里的 userinfo。反过来的话，值先被截断，token 前缀就认不出来了。
 */
export function redactForStorage(input: string): RedactionResult {
  let text = String(input ?? '');
  let redactedCount = 0;

  text = text.replace(resetGlobal(PRIVATE_KEY_BLOCK), () => {
    redactedCount += 1;
    return '';
  });

  text = text.replace(resetGlobal(KNOWN_TOKEN), () => {
    redactedCount += 1;
    return '';
  });

  text = text.replace(BEARER_CREDENTIAL, (_match, scheme: string) => {
    redactedCount += 1;
    return scheme;
  });

  text = text.replace(ENV_LINE, (match, prefix: string, key: string, sep: string, value: string) => {
    if (!value.trim()) return match;
    // 两个条件都成立才删值：
    //   1. 敏感键名（KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL / AUTH …）；
    //   2. 典型 .env 形态（行首 + 紧邻 `=`）。
    // 非敏感的大写键（PORT=8080 / FEATURE_FLAG=true）保留，避免误伤配置说明。
    if (!isSecretName(key)) return match;
    redactedCount += 1;
    return `${prefix}${key}=`;
  });

  text = text.replace(QUOTED_ASSIGNMENT, (match, key: string, sep: string, quote: string) => {
    if (!isSecretName(key)) return match;
    redactedCount += 1;
    return `${key}${sep}${quote}${quote}`;
  });

  text = text.replace(BARE_ASSIGNMENT, (match, key: string, sep: string) => {
    if (!isSecretName(key)) return match;
    redactedCount += 1;
    return `${key}${sep}`;
  });

  text = text.replace(URL_CREDENTIAL, (_match, scheme: string) => {
    redactedCount += 1;
    return scheme;
  });

  return { text, redactedCount };
}

/**
 * 残留扫描。只回答“有没有”，不返回命中的原文 —— 异常信息里带原文
 * 等于把泄漏写进日志。
 */
export function findRedactionResidue(input: string): string[] {
  const text = String(input ?? '');
  const reasons: string[] = [];

  if (resetGlobal(PRIVATE_KEY_BLOCK).test(text)) reasons.push('private-key');
  if (resetGlobal(KNOWN_TOKEN).test(text)) reasons.push('known-token');
  BEARER_CREDENTIAL.lastIndex = 0;
  if (BEARER_CREDENTIAL.test(text)) reasons.push('bearer-credential');
  URL_CREDENTIAL.lastIndex = 0;
  if (URL_CREDENTIAL.test(text)) reasons.push('url-credential');

  ENV_LINE.lastIndex = 0;
  for (const line of text.matchAll(ENV_LINE)) {
    const key = line[2];
    const value = line[4] ?? '';
    if (!value.trim()) continue;
    if (isSecretName(key)) {
      reasons.push('env-value');
      break;
    }
  }

  QUOTED_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_ASSIGNMENT)) {
    if (isSecretName(match[1]) && match[4].trim().length > 0) {
      reasons.push('assignment');
      break;
    }
  }

  BARE_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(BARE_ASSIGNMENT)) {
    if (isSecretName(match[1]) && match[3].trim().length > 0) {
      reasons.push('assignment');
      break;
    }
  }

  return [...new Set(reasons)];
}

export function assertRedactionClean(input: string): void {
  const reasons = findRedactionResidue(input);
  if (reasons.length > 0) throw new KbRedactionError(reasons);
}

/**
 * 入库前完整闸门：清洗 → 残留扫描。任何一步失败都抛 `KbRedactionError`，
 * 调用方据此放弃这条切片，而不是写进去之后再说。
 */
export function redactOrFail(input: string): RedactionResult {
  const result = redactForStorage(input);
  assertRedactionClean(result.text);
  return result;
}
