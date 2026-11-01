/**
 * 扩展的扫描与导入。
 *
 * ## 只读，永远只读
 *
 * 本文件只 `fs.readFile` / `fs.readdir` 用户的 Agent 目录，**一个字节都不写**。
 * 目标目录全部来自 `targets.ts` 的实测清单，没有猜测路径。
 *
 * ## 技能与 MCP 的读法不同
 *
 * - **技能**：目录形态，`<skillsDir>/<name>/SKILL.md`，读文本 + 解析 frontmatter。
 * - **MCP**：配置形态，各家文件格式不同（JSON / TOML），字段语义一致
 *   （`command` / `args` / `env`，或 `url`）。所以这里按格式分派，最后归一成同一个形状。
 *
 * ## 敏感内容的口径（技能与 MCP 不一样）
 *
 * - 技能：命中就**不落正文**（正文本身就是要保护的东西），只登记类型。
 * - MCP：命中就**脱敏后落库**——把 env 里的值换成 `***`，保留 `command` / `args` 的结构，
 *   否则一条 MCP 记录会变得毫无信息量。两种都标 `blocked = 1`，界面上如实提示。
 */

import fs from 'node:fs';
import path from 'node:path';
import { findItem, hashOf, importOne, listItems, listSources, pruneSources, upsertTarget, type ImportPayload } from './store.js';
import { MODE_LABEL, TARGETS, homeDir, scannableTargets, targetOf } from './targets.js';
import { blockedReason, scanSensitive } from './safety.js';

/* ══════════════ frontmatter ══════════════ */

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

/**
 * 极简 YAML frontmatter 解析。
 *
 * 只认 `key: value` 单行（技能文件里全是这种），不处理嵌套 / 数组 / 多行块 ——
 * 引一个 YAML 库只为读 3 个字段不值得，而真正的嵌套（`metadata: {author}`）
 * 对我们没有用处，跳过即可。
 */
export function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    // 缩进行属于上一条键的子结构，跳过
    if (/^\s/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

/* ══════════════ 技能 ══════════════ */

export interface ScannedSkill {
  agentId: string;
  name: string;
  dirPath: string;
  /** 原始 SKILL.md 全文，用于算指纹 */
  raw: string;
  body: string;
  title: string | null;
  description: string | null;
}

/**
 * 扫一个 Agent 的技能目录。
 *
 * 跳过 `.` 开头的条目：`~/.codex/skills/.system` 是引擎自带的系统技能，
 * 不是用户装的，导进来会让列表里混进一堆「不是你装的东西」。
 */
export function scanSkillDir(agentId: string, skillsDir: string): ScannedSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 / 没权限：静默跳过，不是错误
  }
  const out: ScannedSkill[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    // 符号链接也要跟（`~/.claude/skills/agently-mail` 就是一条 symlink）
    const dir = path.join(skillsDir, e.name);
    const file = path.join(dir, 'SKILL.md');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 没有 SKILL.md 的目录不算技能
    }
    const { meta, body } = parseFrontmatter(raw);
    out.push({
      agentId,
      name: meta.name || e.name,
      dirPath: dir,
      raw,
      body,
      title: meta.name || e.name,
      description: meta.description ?? null,
    });
  }
  return out;
}

export function scanAllSkills(): ScannedSkill[] {
  const out: ScannedSkill[] = [];
  for (const t of scannableTargets()) {
    if (!t.skillsDir) continue;
    out.push(...scanSkillDir(t.agentId, t.skillsDir));
  }
  return out;
}

/* ══════════════ MCP ══════════════ */

export interface ScannedMcp {
  agentId: string;
  name: string;
  sourcePath: string;
  config: Record<string, unknown>;
}

/** 各家 MCP 配置文件（实测存在才写进来；不存在的会在读取时静默跳过） */
const MCP_FILES: ReadonlyArray<{ agentId: string; file: string; format: 'json' | 'toml' }> = [
  { agentId: 'claude', file: '.claude.json', format: 'json' },
  { agentId: 'claude', file: '.claude/settings.json', format: 'json' },
  { agentId: 'qoder', file: '.qoder/mcp.json', format: 'json' },
  { agentId: 'qoder-cn', file: '.qoder-cn/mcp.json', format: 'json' },
  { agentId: 'cursor', file: '.cursor/mcp.json', format: 'json' },
  { agentId: 'gemini', file: '.gemini/settings.json', format: 'json' },
  { agentId: 'codex', file: '.codex/config.toml', format: 'toml' },
];

/**
 * 极简 TOML 解析：只取 `[mcp_servers.NAME]` 与 `[mcp_servers.NAME.env]`。
 *
 * 不引 TOML 库的理由同上：我们只需要 command / args / env / url 四个字段，
 * 而 codex 的 config.toml 里其余内容（模型、审批策略）与 MCP 无关。
 */
/**
 * TOML 标量转换（字符串 / 布尔 / 数字）。数组见 `parseTomlArray`。
 *
 * 抽出来的理由：数组元素和顶层值用的是同一套规则，两处各写一遍必然漂移
 * （`["a", "b"]` 里元素该去引号、顶层 `"a"` 也该去，漏一处就是「数组里带引号、
 * 单值不带」这种诡异结果）。
 */
function tomlScalar(raw: string): unknown {
  const s = raw.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/**
 * TOML 数组：`["a", "b"]` / `[]` / `[1, 2]`。
 *
 * **为什么必须解析它**：codex 的 `config.toml` 里 `args = ["--foo", "bar"]`
 * 是**数组**，只按标量处理会得到字符串 `"[\"--foo\", \"bar\"]"` ——
 * 原样交给 MCP 客户端就是一个参数（还是带方括号的），服务直接起不来。
 * 实测本机 `node_repl` 的 `args` / `env_vars` 都踩了这个。
 *
 * 逐字符扫描而不是 `split(',')`：元素本身可能含逗号
 * （`["--path", "a,b"]`），按逗号切会把一个参数劈成两个。
 */
function parseTomlArray(text: string): unknown[] {
  const inner = text.trim().slice(1, -1).trim();
  if (!inner) return [];
  const out: unknown[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\' && i + 1 < inner.length) {
        cur += ch + inner[++i];
        continue;
      }
      if (ch === quote) quote = '';
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      out.push(tomlScalar(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(tomlScalar(cur));
  return out;
}

export function parseTomlMcpServers(text: string): Array<{ name: string; config: Record<string, unknown> }> {
  const out = new Map<string, Record<string, unknown>>();
  let cur: Record<string, unknown> | null = null;
  let inEnv = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      const parts = sec[1].split('.').map(s => s.trim());
      if (parts[0] === 'mcp_servers' && parts[1]) {
        const name = parts[1];
        if (!out.has(name)) out.set(name, {});
        cur = out.get(name)!;
        inEnv = parts[2] === 'env';
        if (inEnv) cur.env = {};
      } else {
        cur = null;
        inEnv = false;
      }
      continue;
    }
    if (!cur) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const s = kv[2].trim();
    const v: unknown =
      s.startsWith('[') && s.endsWith(']') ? parseTomlArray(s) : tomlScalar(s);
    if (inEnv) {
      (cur.env as Record<string, unknown>)[kv[1]] = v;
    } else {
      cur[kv[1]] = v;
    }
  }
  return [...out.entries()].map(([name, config]) => ({ name, config }));
}

/** 从 JSON 配置里挖出 mcpServers（兼容 `{"mcpServers":{...}}` 与 `{"mcp":{...}}`） */
export function pickMcpServers(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const rec = obj as Record<string, unknown>;
  const direct = rec.mcpServers ?? rec.mcp;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  return {};
}

export function scanAllMcp(): ScannedMcp[] {
  const out: ScannedMcp[] = [];
  // 与技能共用同一个扫描起点，别各写一份（曾经这里用 USERPROFILE、
  // targets.ts 用 os.homedir()，在 Windows 上是同一个值纯属巧合）。
  const home = homeDir();
  if (!home) return out;
  for (const spec of MCP_FILES) {
    const full = path.join(home, spec.file);
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (spec.format === 'toml') {
      for (const s of parseTomlMcpServers(text)) {
        out.push({ agentId: spec.agentId, name: s.name, sourcePath: full, config: s.config });
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const servers = pickMcpServers(parsed);
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === 'object') {
        out.push({ agentId: spec.agentId, name, sourcePath: full, config: cfg as Record<string, unknown> });
      }
    }
  }
  return out;
}

/** env 里的值命中敏感规则就换成 `***`，保留键名（用户才知道这条服务要哪些变量） */
export function redactConfig(config: Record<string, unknown>): { config: Record<string, unknown>; hits: string[] } {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const hits = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === 'string') {
        const found = scanSensitive(v);
        if (found.length > 0) {
          found.forEach(f => hits.add(f));
          rec[k] = '***';
        }
      } else {
        walk(v);
      }
    }
  };
  walk(clone);
  return { config: clone, hits: [...hits] };
}

/* ══════════════ 导入 ══════════════ */

export interface ImportReport {
  added: number;
  updated: number;
  unchanged: number;
  conflicts: Array<{ kind: string; name: string }>;
  blocked: Array<{ kind: string; name: string; reason: string }>;
  skillScanned: number;
  mcpScanned: number;
}

/**
 * 全量导入一次。
 *
 * 去重口径：**同名即同一份**（`(kind, name)` 唯一）。内容不同也归一条，
 * 多出来的来源写进 `extension_source`，界面上显示「N 处重复」。
 * 以第一个来源（按 agentId 字典序）为准 —— 确定性优先，不按「谁先扫到」。
 */
export function runImport(): ImportReport {
  const report: ImportReport = {
    added: 0,
    updated: 0,
    unchanged: 0,
    conflicts: [],
    blocked: [],
    skillScanned: 0,
    mcpScanned: 0,
  };

  const skills = scanAllSkills().sort((a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name));
  report.skillScanned = skills.length;

  /** 每个 name 收集所有来源，最后统一 upsert */
  const byName = new Map<string, ScannedSkill[]>();
  for (const s of skills) {
    const arr = byName.get(s.name) ?? [];
    arr.push(s);
    byName.set(s.name, arr);
  }

  const touchedItems = new Map<string, string[]>();

  for (const [name, list] of byName) {
    const primary = list[0];
    const hits = scanSensitive(primary.raw);
    const payload: ImportPayload = {
      kind: 'skill',
      name,
      title: primary.title,
      description: primary.description,
      // 命中敏感内容 ⇒ 正文不落库
      body: hits.length > 0 ? null : primary.body,
      configJson: null,
      contentHash: hashOf(primary.raw),
      blocked: hits.length > 0,
      blockedReason: hits.length > 0 ? blockedReason(hits) : null,
      agentId: primary.agentId,
      sourcePath: primary.dirPath,
    };
    const r = importOne(payload);
    if (r.outcome === 'added') report.added += 1;
    else if (r.outcome === 'updated') report.updated += 1;
    else if (r.outcome === 'unchanged') report.unchanged += 1;
    else if (r.outcome === 'conflict') report.conflicts.push({ kind: 'skill', name });
    if (hits.length > 0) report.blocked.push({ kind: 'skill', name, reason: blockedReason(hits) });

    // 其余来源只登记，不改正文
    for (const extra of list.slice(1)) {
      importOne({ ...payload, agentId: extra.agentId, sourcePath: extra.dirPath });
    }
    touchedItems.set(name, list.map(s => s.dirPath));
  }

  const mcps = scanAllMcp().sort((a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name));
  report.mcpScanned = mcps.length;
  const mcpByName = new Map<string, ScannedMcp[]>();
  for (const m of mcps) {
    const arr = mcpByName.get(m.name) ?? [];
    arr.push(m);
    mcpByName.set(m.name, arr);
  }

  for (const [name, list] of mcpByName) {
    const primary = list[0];
    const { config, hits } = redactConfig(primary.config);
    const payload: ImportPayload = {
      kind: 'mcp',
      name,
      title: name,
      description: typeof primary.config.command === 'string'
        ? `stdio: ${primary.config.command}`
        : typeof primary.config.url === 'string'
          ? `http: ${primary.config.url}`
          : null,
      body: null,
      // MCP 命中敏感内容时**脱敏后落库**（保留结构，值换 ***），不是整条丢弃
      configJson: JSON.stringify(config, null, 2),
      contentHash: hashOf(JSON.stringify(primary.config)),
      blocked: hits.length > 0,
      blockedReason: hits.length > 0 ? `含敏感内容（${hits.join('、')}），已脱敏` : null,
      agentId: primary.agentId,
      sourcePath: primary.sourcePath,
    };
    const r = importOne(payload);
    if (r.outcome === 'added') report.added += 1;
    else if (r.outcome === 'updated') report.updated += 1;
    else if (r.outcome === 'unchanged') report.unchanged += 1;
    else if (r.outcome === 'conflict') report.conflicts.push({ kind: 'mcp', name });
    if (hits.length > 0) report.blocked.push({ kind: 'mcp', name, reason: payload.blockedReason ?? '' });

    for (const extra of list.slice(1)) {
      importOne({ ...payload, agentId: extra.agentId, sourcePath: extra.sourcePath });
    }
    touchedItems.set(`mcp:${name}`, list.map(m => m.sourcePath));
  }

  // 清理本次没见到的旧来源 + 重算能力矩阵
  for (const item of listItems()) {
    const key = item.kind === 'mcp' ? `mcp:${item.name}` : item.name;
    const seen = touchedItems.get(key);
    if (seen) pruneSources(item.id, seen);
    rebuildTargets(item.id, item.kind);
  }

  return report;
}

/**
 * 重算某个能力的「能力矩阵」。
 *
 * `present` 是**事实**（该 Agent 自己的目录里有这份），`mode` 是**能力**（能不能送进去）。
 * 两者分开存，界面上也要分开显示 —— 合成一个字段就会出现「明明是同一个东西，
 * 有的地方说有、有的地方说没有」。
 *
 * ## 为什么只给 skill 算，mcp 直接返回
 *
 * `TARGETS` 里的 `mode` 描述的是**技能的挂载通道**（`gemini skills link` /
 * `qodercli --add-dir` / 提示词注入）。MCP 是另一套东西（`--mcp-config` /
 * `mcp.json`），我们**没有测过**每个 Agent 的 MCP 接入能力。
 *
 * 如果这里照抄 `t.mode`，MCP 条目就会显示「codex · 启动参数」—— 而 codex
 * 的「启动参数」说的是它连技能目录的通道，与 MCP 毫无关系。一句编出来的
 * 矩阵比没有矩阵更糟：用户会照着它去排查一个不存在的能力。
 *
 * 所以 mcp 一律不写 target 行，详情页也就不渲染矩阵（见 ExtensionDetail）。
 * 等 P2 真测过再补，别先占位。
 */
export function rebuildTargets(itemId: string, kind: string): void {
  if (kind !== 'skill') return;
  const present = new Set(listSources(itemId).map(s => s.agentId));
  for (const t of TARGETS) {
    upsertTarget(itemId, t.agentId, t.mode, present.has(t.agentId), `${MODE_LABEL[t.mode]}${t.note ? ` · ${t.note}` : ''}`);
  }
}

export function targetSpec(agentId: string) {
  return targetOf(agentId);
}

/**
 * 重新读**一个**能力的源，按 §7.1 的判定表决定 added/updated/conflict。
 *
 * 与全量 `runImport()` 的区别：只碰这一条，不重扫所有 Agent。
 * 界面上「重新导入」按钮用它，用户点哪个就只刷哪个。
 */
export function refreshItem(kind: 'skill' | 'mcp', name: string): { outcome: string; reason?: string } {
  const item = findItem(kind, name);
  if (!item) return { outcome: 'missing', reason: '条目不存在' };
  const sources = listSources(item.id);
  if (sources.length === 0) return { outcome: 'missing', reason: '没有来源记录' };

  if (kind === 'skill') {
    // 优先读还在磁盘上的那个来源
    for (const s of sources) {
      const file = path.join(s.path, 'SKILL.md');
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(raw);
      const hits = scanSensitive(raw);
      const r = importOne({
        kind: 'skill',
        name,
        title: meta.name || name,
        description: meta.description ?? null,
        body: hits.length > 0 ? null : body,
        configJson: null,
        contentHash: hashOf(raw),
        blocked: hits.length > 0,
        blockedReason: hits.length > 0 ? blockedReason(hits) : null,
        agentId: s.agentId,
        sourcePath: s.path,
      });
      rebuildTargets(item.id, 'skill');
      return { outcome: r.outcome };
    }
    return { outcome: 'missing', reason: '源文件已不在磁盘上' };
  }

  // MCP：重扫一遍配置文件，按名字找
  const found = scanAllMcp().find(m => m.name === name);
  if (!found) return { outcome: 'missing', reason: '源配置里已没有这条服务' };
  const { config, hits } = redactConfig(found.config);
  const r = importOne({
    kind: 'mcp',
    name,
    title: name,
    description: typeof found.config.command === 'string' ? `stdio: ${found.config.command}` : null,
    body: null,
    configJson: JSON.stringify(config, null, 2),
    contentHash: hashOf(JSON.stringify(found.config)),
    blocked: hits.length > 0,
    blockedReason: hits.length > 0 ? `含敏感内容（${hits.join('、')}），已脱敏` : null,
    agentId: found.agentId,
    sourcePath: found.sourcePath,
  });
  rebuildTargets(item.id, 'mcp');
  return { outcome: r.outcome };
}
