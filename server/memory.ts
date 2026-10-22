/**
 * 记忆层（A38）—— 四层记忆的最小可用实现。
 *
 * ## 为什么需要这一层
 *
 * 核心主张是 "the agent that grows
 * with you"：它把记忆分成四层，且**记忆是结构化 Markdown，不是嵌入向量** ——
 * 人能读、能改、能审。我们此前完全没有跨会话记忆：会话是持久的，但
 * 「用户的偏好 / 项目规范 / 踩过的坑」每次都要重新交代。
 *
 * ## 四层在本仓库的落点
 *
 * | Hermes | 这里 | 容量策略 |
 * |---|---|---|
 * | L1 核心记忆 `MEMORY.md` | `data/memory/MEMORY.md` | ≤800 token，会话启动时冻结注入 |
 * | L2 用户画像 `USER.md` | `data/memory/USER.md` | ≈500 token，同上 |
 * | L3 技能记忆 `skills/` | `data/memory/skills/*.md` | 不限量，A39 自动沉淀，索引进 FTS5 |
 * | L4 长期存储 | `memory_fts`（SQLite FTS5） | 语义检索 + 全文检索，按需召回 |
 *
 * ## 两个必须说清的边界
 *
 * 1. **只注入我们自己的装配链路**（`sdk` 适配器与 `http` 模型直连）。
 *    CLI / ACP 类 agent 的系统提示是它们自己的 harness 拼的，我们塞不进去；
 *    硬塞只会得到「改了人家的 prompt」。这一条在 UI 上如实标注。
 * 2. **token 估算是粗粒度**（没有真的分词器）。用「CJK 字符≈1 token、
 *    其他≈4 字符 1 token」的加权公式 —— 它的作用只是**给编辑框一个刻度**，
 *    让用户知道「快到顶了」，不是给模型做精确计费。
 */

import fs from 'node:fs';
import path from 'node:path';
import db from './db';
import { dataDirPath } from './db';

export const MEMORY_DIR = path.join(dataDirPath, 'memory');
export const CORE_MEMORY_PATH = path.join(MEMORY_DIR, 'MEMORY.md');
export const USER_PROFILE_PATH = path.join(MEMORY_DIR, 'USER.md');
export const SKILLS_DIR = path.join(MEMORY_DIR, 'skills');

/** L1 预算（token）。Hermes 也是 800，超过就说明把「日记」写进核心记忆了。 */
export const CORE_MEMORY_BUDGET = 800;
/** L2 预算（token）。画像要短，长了就等于没画像。 */
export const USER_PROFILE_BUDGET = 500;

const FTS_TABLE = 'memory_fts';

/**
 * CJK 连续段：表意文字 + 中文标点 + 日文假名。
 * （标点也算进来，是为了让「连接池。」这类带尾缀的句子整段被切碎重组。）
 */
const CJK_RUN_RE = /[\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]+/g;

/**
 * 把 CJK 连续段切成「单字 + 相邻双字」再交给 FTS5。
 *
 * ## 为什么必须自己切（这坑值一条注释）
 *
 * SQLite 的 `unicode61` 分词器（3.51.2 实测）**不把表意文字当 token 字符**：
 * 直接索引「连接池」会得到零个 token，整段中文在索引里等于不存在 ——
 * 实测连单字「周」都检索不到，而同样的 `Postgres` 一查就中。
 * 这是分词器的字符分类决定的，换 `tokenize=` 选项绕不过去。
 * 所以在写入与查询两侧都先过这个函数：单字保证「周」能中，双字保证
 * 「周报」这个完整词能中（且不会把「周」和「报」强行变成同义词）。
 */
function cjkGrams(text: string): string {
  return text.replace(CJK_RUN_RE, run => {
    const grams: string[] = [...run];
    for (let i = 0; i + 1 < run.length; i += 1) grams.push(run.slice(i, i + 2));
    return grams.join(' ');
  });
}

// ── 目录与默认文件 ────────────────────────────────────────────────────────

const DEFAULT_CORE = [
  '# 核心记忆',
  '',
  '写跨会话必须知道的事实：项目规范、环境约定、长期在做的任务。',
  '每行一条，控制在 800 token 内 —— 超长会被截断，优先级从上到下。',
  '',
].join('\n');

const DEFAULT_USER = [
  '# 用户画像',
  '',
  '- 技术栈偏好：',
  '- 沟通风格：（简洁 / 详细）',
  '- 长期目标：',
  '',
].join('\n');

function ensureDirs(): void {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
  if (!fs.existsSync(CORE_MEMORY_PATH)) fs.writeFileSync(CORE_MEMORY_PATH, DEFAULT_CORE, 'utf8');
  if (!fs.existsSync(USER_PROFILE_PATH)) fs.writeFileSync(USER_PROFILE_PATH, DEFAULT_USER, 'utf8');
}

// ── L4：FTS5 全文检索 ─────────────────────────────────────────────────────

function ensureSchema(): void {
  // FTS5 是 Node 22 `node:sqlite` 编译进来的（实测可建表）。
  // 用**独立表**而不是 external content：删除一行就是 `DELETE ... WHERE key=?`，
  // 不需要维护影子表，对一个记忆索引来说是更划算的复杂度。
  //
  // 列的排布是为了同时满足「可读」与「可检索中文」：
  //   2 title    原文      —— SELECT 出来直接给人看
  //   3 title_grams 切碎    —— 让标题里的中文可被检索
  //   4 body     切碎       —— 检索用
  //   5 raw      原文       —— snippet() 取第 6 列，摘要才是人话
  // 见 cjkGrams 的注释：unicode61 不索引表意文字，所以中文必须切碎了才存在。
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE}
    USING fts5(kind, key, title, title_grams, body, raw, tokenize='unicode61');
  `);
  // A38 内部结构从 4 列改成 6 列时留下的旧表：直接重建。
  // 记忆文件是唯一事实来源，索引随时可再生，所以这里可以放心删。
  const cols = db.prepare(`PRAGMA table_info(${FTS_TABLE})`).all() as unknown as Array<{ name: string }>;
  if (cols.length && cols.length !== 6) {
    db.exec(`DROP TABLE ${FTS_TABLE}`);
    ensureSchema();
  }
}

/**
 * 把一份文档写进全文索引。同 key 先删后插，保证「一次写入一条」。
 */
export function indexMemory(kind: string, key: string, title: string, body: string): void {
  ensureSchema();
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE key = ?`).run(key);
  // 原文进 title / raw（给人看），切碎版进 title_grams / body（给检索）。
  db.prepare(
    `INSERT INTO ${FTS_TABLE} (kind, key, title, title_grams, body, raw)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(kind, key, title, cjkGrams(title), cjkGrams(body), body);
}

export function deleteMemory(key: string): number {
  ensureSchema();
  const r = db.prepare(`DELETE FROM ${FTS_TABLE} WHERE key = ?`).run(key);
  return Number(r.changes ?? 0);
}

export interface MemoryHit {
  key: string;
  kind: string;
  title: string;
  snippet: string;
}

/**
 * 全文检索。查询词先做 FTS5 语法转义，再按「OR」拼接 ——
 * 直接透传用户输入会让 `"` / `-` / `NEAR` 变成语法错误，
 * 检索框输入一个减号就白屏（这是 FTS5 的经典坑）。
 */
export function searchMemory(query: string, limit = 10): MemoryHit[] {
  ensureSchema();
  const terms = String(query)
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return [];
  // 查询侧同样切词，否则「周报」在索引里是 `周 周报 报` 三个 token，
  // 而查询只有一个 `周报`，匹配不上（写入与查询必须用同一套切分）。
  const match = terms
    .map(t => cjkGrams(t).split(/\s+/).filter(Boolean).map(g => `"${g}"`).join(' '))
    .filter(Boolean)
    .join(' OR ');
  // node:sqlite 把行推断成 `Record<string, SQLOutputValue>`，
  // 这里 `as unknown as` 是**必须的**双重断言（直接断言会被 TS 以
  // 「类型不充分重叠」拒绝）。snippet 的长度由 FTS5 的第 6 个参数控制。
  // snippet 取第 6 列（raw，原文），不是切碎列 ——
  // 否则摘要会是一串「…周… …报…」，人读不了。
  const rows = db
    .prepare(
      `SELECT key, kind, title, snippet(${FTS_TABLE}, 5, '…', '…', '…', 14) AS snippet
       FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(match, limit) as unknown as MemoryHit[];
  return rows;
}

/** 全量重建索引（MEMORY / USER / skills/*.md → FTS5）。启动时与保存后调用。 */
export function reindexMemory(): { core: number; user: number; skills: number } {
  ensureDirs();
  // ⚠️ 必须先建表再全删：全新环境里 memory_fts 还不存在，
  // 而 `DELETE FROM` 不像 CREATE VIRTUAL TABLE 有 IF NOT EXISTS 兜底。
  ensureSchema();
  db.prepare(`DELETE FROM ${FTS_TABLE}`).run();
  let skills = 0;
  for (const f of listSkills()) {
    indexMemory('skill', `skill:${f.name}`, f.name, f.body);
    skills += 1;
  }
  indexMemory('core', 'core:MEMORY.md', '核心记忆', readCoreMemory());
  indexMemory('user', 'user:USER.md', '用户画像', readUserProfile());
  return { core: 1, user: 1, skills };
}

// ── L1 / L2 / L3 读写 ─────────────────────────────────────────────────────

export function readCoreMemory(): string {
  ensureDirs();
  return fs.readFileSync(CORE_MEMORY_PATH, 'utf8');
}

export function readUserProfile(): string {
  ensureDirs();
  return fs.readFileSync(USER_PROFILE_PATH, 'utf8');
}

interface WriteResult {
  ok: boolean;
  tokens: number;
  budget: number;
  /** 超预算时给出的事实：写入成功了，但注入时会被截断。 */
  overBudget: boolean;
}

function writeFile(path: string, text: string, budget: number): WriteResult {
  ensureDirs();
  const tokens = estimateTokens(text);
  // 注意：**超预算也照样写盘**。截断只发生在「注入」那一刻 ——
  // 在保存时就砍内容，用户会在编辑框里丢失自己刚写的后半段，
  // 而这种丢失是静默的（Hermes 也是「冻结快照注入」而非保存时截断）。
  fs.writeFileSync(path, text, 'utf8');
  return { ok: true, tokens, budget, overBudget: tokens > budget };
}

export function writeCoreMemory(text: string): WriteResult {
  const r = writeFile(CORE_MEMORY_PATH, text, CORE_MEMORY_BUDGET);
  indexMemory('core', 'core:MEMORY.md', '核心记忆', readCoreMemory());
  return r;
}

export function writeUserProfile(text: string): WriteResult {
  const r = writeFile(USER_PROFILE_PATH, text, USER_PROFILE_BUDGET);
  indexMemory('user', 'user:USER.md', '用户画像', readUserProfile());
  return r;
}

export interface SkillFile {
  name: string;
  title: string;
  body: string;
  tokens: number;
}

export function listSkills(): SkillFile[] {
  ensureDirs();
  return fs
    .readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const body = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8');
      return {
        name: f.replace(/\.md$/, ''),
        title: firstHeading(body) || f,
        body,
        tokens: estimateTokens(body),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name: string): SkillFile | null {
  const safe = path.basename(name).replace(/\.md$/, '') + '.md';
  const p = path.join(SKILLS_DIR, safe);
  if (!fs.existsSync(p)) return null;
  const body = fs.readFileSync(p, 'utf8');
  return { name: path.basename(safe, '.md'), title: firstHeading(body), body, tokens: estimateTokens(body) };
}

/** 写技能文件。名字做 basename + 白名单过滤，挡掉 `../../etc/passwd`。 */
export function writeSkill(name: string, body: string): { ok: boolean; name: string } | { error: string } {
  const clean = String(name).trim().replace(/\.md$/, '');
  if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(clean)) {
    return { error: '技能名只能用字母/数字/下划线/连字符，最多 64 字符' };
  }
  ensureDirs();
  fs.writeFileSync(path.join(SKILLS_DIR, `${clean}.md`), body, 'utf8');
  indexMemory('skill', `skill:${clean}`, firstHeading(body) || clean, body);
  return { ok: true, name: clean };
}

export function deleteSkill(name: string): boolean {
  const clean = path.basename(String(name).replace(/\.md$/, '')) + '.md';
  const p = path.join(SKILLS_DIR, clean);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  deleteMemory(`skill:${clean.replace(/\.md$/, '')}`);
  return true;
}

// ── 预算与装配 ────────────────────────────────────────────────────────────

/**
 * 粗粒度 token 估算：CJK 一字≈1 token，其余约 4 字符≈1 token。
 * 只用于「给用户一个刻度」，不用于计费。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]/g) ?? []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/** 按预算截断：保留头部（越靠前优先级越高），并留一行截断提示。 */
export function truncateToBudget(text: string, budget: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= budget) return { text, truncated: false };
  const lines = text.split('\n');
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return {
    text: out.join('\n') + `\n\n（以上为核心记忆前 ${used} token，已按预算截断；完整内容见「设置 → 记忆」）`,
    truncated: true,
  };
}

export interface MemoryStats {
  coreTokens: number;
  coreBudget: number;
  userTokens: number;
  userBudget: number;
  skillCount: number;
  skillTokens: number;
  indexedDocs: number;
}

export function memoryStats(): MemoryStats {
  ensureDirs();
  const skills = listSkills();
  let indexed = 0;
  try {
    indexed = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get() as unknown as { n: number }).n
    );
  } catch {
    indexed = 0;
  }
  return {
    coreTokens: estimateTokens(readCoreMemory()),
    coreBudget: CORE_MEMORY_BUDGET,
    userTokens: estimateTokens(readUserProfile()),
    userBudget: USER_PROFILE_BUDGET,
    skillCount: skills.length,
    skillTokens: skills.reduce((s, k) => s + k.tokens, 0),
    indexedDocs: indexed,
  };
}

/**
 * 装配注入上下文。**会话启动时冻结一次**：
 * 一轮对话中途改了 MEMORY.md，不影响正在跑的这轮 —— 否则同一个会话里
 * 前后两次工具调用看到的世界观不一致，比没有记忆更难排查。
 */
export function assembleMemoryContext(opts: { includeUser?: boolean } = {}): string {
  ensureDirs();
  const includeUser = opts.includeUser !== false;
  const core = truncateToBudget(readCoreMemory(), CORE_MEMORY_BUDGET);
  const parts = ['## 用户长期记忆（跨会话生效，只读，来自 opc-agent 记忆层）', '', core.text];
  if (includeUser) {
    const user = truncateToBudget(readUserProfile(), USER_PROFILE_BUDGET);
    parts.push('', '## 用户偏好画像', '', user.text);
  }
  return parts.join('\n');
}

function firstHeading(md: string): string {
  const m = md.split('\n').find(l => /^#{1,3}\s+/.test(l));
  return m ? m.replace(/^#{1,3}\s+/, '').trim() : '';
}

/**
 * 给调用方的 systemPrompt 追加记忆上下文。
 *
 * 被 `sdk` 与 `http` 两个适配器在**拼请求体之前**调用 ——
 * 放在这里而不是塞进 `assembleMemoryContext`，是因为「原提示词为空时
 * 用默认提示词还是直接用记忆」这个决定属于适配器，不属于记忆层。
 */
export function withMemoryContext(systemPrompt: string | undefined): string {
  const base = (systemPrompt ?? '').trim();
  const mem = assembleMemoryContext();
  return base ? `${base}\n\n${mem}` : mem;
}

// ── 启动时自愈 ────────────────────────────────────────────────────────────

let booted = false;
export function bootMemory(): void {
  if (booted) return;
  booted = true;
  try {
    reindexMemory();
  } catch (e) {
    // 索引失败不阻断启动：记忆文件是唯一事实来源，索引随时可重建。
    console.error('[memory] 索引重建失败（不影响启动）:', (e as Error).message);
  }
}
