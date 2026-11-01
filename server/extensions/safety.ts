/**
 * 敏感内容扫描 —— 导入前的最后一道闸。
 *
 * ## 为什么必须有这一道
 *
 * 技能文件是别人写的 markdown，里面完全可能带着作者自己的 API Key、内网地址、
 * 本机绝对路径。我们把它们原样抄进 `data/chat.db`，就等于**替用户备份了别人的密钥**，
 * 而且以后还会被注入进提示词、被写进日志。
 *
 * 所以口径是：**命中就整份不落库**，只登记「这个技能含敏感内容」，正文留空。
 * 宁可少导一个，不要把别人的密钥搬进我们的库。
 *
 * ## 一个硬规矩：命中时只返回「类型」，绝不返回命中的原文
 *
 * 返回值是 `['API Key', '本机绝对路径']` 这种标签。如果把 `sk-xxx…` 打进日志或
 * 界面上，那这次扫描本身就成了泄漏源。
 */

interface Rule {
  /** 面向用户的类型名，不要出现具体值 */
  label: string;
  re: RegExp;
}

const RULES: readonly Rule[] = [
  { label: 'API Key（sk- 开头）', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { label: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // 本项目自己的加密信封前缀（见 A153）：出现即说明原文里嵌了密文
  { label: '加密信封 enc:v1', re: /\benc:v1:/ },
  // 本机绝对路径：会泄漏用户名 / 目录结构
  { label: 'Windows 用户路径', re: /\b[A-Za-z]:\\Users\\/ },
  { label: 'macOS 用户路径', re: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: 'Linux 家目录路径', re: /\/home\/[A-Za-z0-9._-]+\// },
];

/**
 * 扫描一段文本，返回命中的**类型**列表（去重，保持规则顺序）。
 * 空数组 = 干净。
 */
export function scanSensitive(text: string): string[] {
  if (!text) return [];
  const hit: string[] = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) hit.push(rule.label);
  }
  return hit;
}

/** 给界面用的一句话 */
export function blockedReason(hits: readonly string[]): string {
  if (hits.length === 0) return '';
  return `含敏感内容（${hits.join('、')}），已阻止导入正文`;
}
