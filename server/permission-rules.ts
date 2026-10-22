/**
 * 权限规则持久化（A40）。
 *
 * ## 为什么是 JSON 文件而不是数据库表
 *
 * 规则是「配置」，不是「数据」：数量以十条计，读写频率以「改一次用很久」计，
 * 且用户会想直接打开文件看/改。JSON + 启动加载进内存，比加一张表、
 * 写一套迁移省事，也符合 `memory.ts` 已经确立的「data 目录放人可读文件」惯例。
 *
 * ## 与门禁的关系
 *
 * 只负责存取与校验。裁决逻辑全在 `agents/permission-gate.ts`：
 * 这里写错的规则（比如 match 写了半句话）由那边照敞匹配，顶多是「没命中」，
 * 不会把系统搞坏 —— 但校验会挡掉结构性错误（缺 decision、tool 为空）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath } from './paths.js';
import type { PermissionRule } from './agents/permission-gate.js';

export const PERMISSION_RULES_PATH = path.join(dataDirPath, 'permission-rules.json');

/** 门禁内建说明：写进 GET 响应，让前端能提示「还有一层你改不了的规则」 */
export const BUILTIN_NOTE = [
  '内置分类器（23 条危险 + 14 条需确认）不接受自定义，',
  '自定义规则只能在此基础上追加「禁止」或「允许」。',
].join('');

let cache: PermissionRule[] = [];

/** 把任意输入收敛成合法规则数组。坏行丢弃而不是整批拒绝。 */
export function sanitizeRules(input: unknown): PermissionRule[] {
  if (!Array.isArray(input)) return [];
  const out: PermissionRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const tool = typeof r.tool === 'string' ? r.tool.trim() : '';
    if (!tool) continue;
    const decision = r.decision === 'deny' ? 'deny' : r.decision === 'allow' ? 'allow' : null;
    if (!decision) continue;
    const rule: PermissionRule = { tool, decision };
    if (typeof r.match === 'string' && r.match.trim()) rule.match = r.match.trim();
    if (typeof r.note === 'string' && r.note.trim()) rule.note = r.note.trim();
    out.push(rule);
    if (out.length >= 50) break; // 上限：再多就不是给人看的配置了
  }
  return out;
}

/** 读文件并刷新缓存。文件不存在 / 损坏都返回空数组，不让启动失败。 */
export function loadPermissionRules(): PermissionRule[] {
  try {
    if (!fs.existsSync(PERMISSION_RULES_PATH)) {
      cache = [];
      return cache;
    }
    const parsed = JSON.parse(fs.readFileSync(PERMISSION_RULES_PATH, 'utf-8'));
    cache = sanitizeRules(parsed);
  } catch (err) {
    console.warn('[权限规则] 读取失败，按空规则处理:', (err as Error).message);
    cache = [];
  }
  return cache;
}

/** 写入并刷新缓存。原子写：先写临时文件再改名，避免半截 JSON。 */
export function savePermissionRules(rules: unknown): PermissionRule[] {
  const clean = sanitizeRules(rules);
  fs.mkdirSync(path.dirname(PERMISSION_RULES_PATH), { recursive: true });
  const tmp = `${PERMISSION_RULES_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, PERMISSION_RULES_PATH);
  cache = clean;
  return clean;
}

/** 供门禁同步读取（零 IO）。未加载过时先加载一次。 */
export function currentPermissionRules(): readonly PermissionRule[] {
  if (cache.length === 0 && fs.existsSync(PERMISSION_RULES_PATH)) loadPermissionRules();
  return cache;
}
