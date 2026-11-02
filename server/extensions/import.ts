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
import { findItem, hashOf, importOne, listItems, listSources, pruneSources, registerSource, upsertTarget, type ImportPayload } from './store.js';
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
    //
    // 重要：Node.js 22 起，Windows 上 junction 在 readdirSync 里返回
    // isDirectory=false + isSymbolicLink=true。此时 path.join(junction, 'SKILL.md')
    // 不会被当作「跟到 junction 目录里再拼 SKILL.md」，而是直接把 junction 当文件处理，
    // readFileSync 抛 ENOENT —— 于是整条链接技能从清单里**静默消失**。
    // 修：遇到 symlink/junction 时先用 realpathSync 解析到真实目录再继续。
    let dir = path.join(skillsDir, e.name);
    if (e.isSymbolicLink()) {
      try {
        dir = fs.realpathSync.native?.(dir) ?? fs.realpathSync(dir);
      } catch {
        continue; // 坏链接（目标不存在）：跳过，不要崩
      }
    }
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

/**
 * 深度脱敏：递归遍历对象与数组，所有字符串值过 `scanSensitive`。
 * 数组**不只是**递归子元素，数组里的字符串本身也要扫——旧实现只走了 `forEach(walk)`，
 * 字符串类型的元素到 `walk` 里直接被 `typeof node !== 'object'` 挡掉，导致
 * `args: ['--api-key','sk-xxx']` 这种数组形式的密钥原样入库（A 安全缺陷 #2）。
 */
export function redactConfig(config: Record<string, unknown>): { config: Record<string, unknown>; hits: string[] } {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const hits = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string') {
          const found = scanSensitive(v);
          if (found.length > 0) {
            found.forEach(f => hits.add(f));
            node[i] = '***';
          }
        } else {
          walk(v);
        }
      }
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
 * 内容指纹。**唯一实现**，`drift.ts` 也用它比较「源变没变」。
 *
 * 之所以单独导出而不是内联进 payload：差异检测与应用是两条独立的路，
 * 但必须对「什么算变了」有完全相同的答案。各写一份 `hashOf(...)` 的后果
 * 不是报错，而是「差异列表说变了、点了应用却说没变」这种没法排查的现象。
 */
export function skillContentHash(s: { raw: string }): string {
  return hashOf(s.raw);
}

/** MCP 的指纹按**原始配置**（脱敏前）算：脱敏是我们展示层的处理，不该影响「源变没变」。 */
export function mcpContentHash(m: { config: Record<string, unknown> }): string {
  return hashOf(JSON.stringify(m.config));
}

/**
 * 一条扫描到的技能 → 落库载荷。
 *
 * 抽出来是为了让 `runImport` 与 `importByName`（A168 的差异应用）用**同一份**
 * 判定：脱敏规则、指纹算法、blocked 口径一旦分两处写，必然有一天只改好一处 ——
 * 表现是「全量导入会拦密钥、单条导入不会」这种没人会去查的分叉。
 */
function skillPayload(s: ScannedSkill): ImportPayload {
  const hits = scanSensitive(s.raw);
  const blocked = hits.length > 0;
  return {
    kind: 'skill',
    name: s.name,
    /* blocked 时 title/description 也脱敏：它们可能从 frontmatter 原样带进密钥
       （比如某条技能的 description 是 `sk-xxx 专用`）。旧实现只把 body 置空，
       标题和描述仍按原文落库，详情页/接口响应就会露出密钥。 */
    title: blocked ? null : s.title,
    description: blocked ? null : s.description,
    // 命中敏感内容 ⇒ 正文不落库
    body: blocked ? null : s.body,
    configJson: null,
    contentHash: skillContentHash(s),
    blocked,
    blockedReason: blocked ? blockedReason(hits) : null,
    agentId: s.agentId,
    sourcePath: s.dirPath,
  };
}

/**
 * 一条扫描到的 MCP → 落库载荷。脱敏（值换 `***`）而不是整条丢弃。
 * description 必须从**脱敏后的 config** 取 command/url——旧实现直接读 m.config，
 * 等于把我们为 config_json 做的脱敏绕开了，接口响应和详情页能看到密钥原文。
 */
function mcpPayload(m: ScannedMcp): ImportPayload {
  const { config, hits } = redactConfig(m.config);
  const descCmd = typeof config.command === 'string' ? config.command : null;
  const descUrl = typeof config.url === 'string' ? config.url : null;
  return {
    kind: 'mcp',
    name: m.name,
    title: m.name,
    description:
      descCmd && !scanSensitive(descCmd).length
        ? `stdio: ${descCmd}`
        : descUrl && !scanSensitive(descUrl).length
          ? `http: ${descUrl}`
          : null,
    body: null,
    configJson: JSON.stringify(config, null, 2),
    contentHash: mcpContentHash(m),
    blocked: hits.length > 0,
    blockedReason: hits.length > 0 ? `含敏感内容（${hits.join('、')}），已脱敏` : null,
    agentId: m.agentId,
    sourcePath: m.sourcePath,
  };
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
    const payload = skillPayload(primary);
    const r = importOne(payload);
    if (r.outcome === 'added') report.added += 1;
    else if (r.outcome === 'updated') report.updated += 1;
    else if (r.outcome === 'unchanged') report.unchanged += 1;
    else if (r.outcome === 'conflict') report.conflicts.push({ kind: 'skill', name });
    if (payload.blocked) report.blocked.push({ kind: 'skill', name, reason: payload.blockedReason ?? '' });

    // 其余来源只登记，不改正文；**存它们自己的指纹**，否则差异检测看不出副本变了
    for (const extra of list.slice(1)) {
      registerSource('skill', name, extra.agentId, extra.dirPath, skillContentHash(extra));
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
    // MCP 命中敏感内容时**脱敏后落库**（保留结构，值换 ***），不是整条丢弃
    const payload = mcpPayload(primary);
    const r = importOne(payload);
    if (r.outcome === 'added') report.added += 1;
    else if (r.outcome === 'updated') report.updated += 1;
    else if (r.outcome === 'unchanged') report.unchanged += 1;
    else if (r.outcome === 'conflict') report.conflicts.push({ kind: 'mcp', name });
    if (payload.blocked) report.blocked.push({ kind: 'mcp', name, reason: payload.blockedReason ?? '' });

    for (const extra of list.slice(1)) {
      registerSource('mcp', name, extra.agentId, extra.sourcePath, mcpContentHash(extra));
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
      const r = importOne(
        skillPayload({
          agentId: s.agentId,
          name,
          dirPath: s.path,
          raw,
          body,
          title: meta.name || name,
          description: meta.description ?? null,
        })
      );
      rebuildTargets(item.id, 'skill');
      return { outcome: r.outcome };
    }
    return { outcome: 'missing', reason: '源文件已不在磁盘上' };
  }

  // MCP：重扫一遍配置文件，按名字找
  const found = scanAllMcp().find(m => m.name === name);
  if (!found) return { outcome: 'missing', reason: '源配置里已没有这条服务' };
  const r = importOne(mcpPayload(found));
  rebuildTargets(item.id, 'mcp');
  return { outcome: r.outcome };
}

/**
 * 按名字导入/更新**一条**（A168 差异应用用）。
 *
 * 与 `refreshItem` 的分工：
 * - `refreshItem` 只看这条**自己记录的来源**（详情页的「重新导入」按钮）。
 *   它的前提是「条目已经存在」。
 * - `importByName` 会**全量扫一遍**再挑出这个名字 —— 因为它要能处理 `new`
 *   （条目还不存在，没有任何来源记录可读），也顺带发现「这条在别家也有副本」。
 *
 * 返回值里的 `missing` 表示「这次扫不到它了」（源文件被删 / 改名），
 * 调用方据此提示「源已经不在本机」，**不要**把它当成失败。
 */
export function importByName(
  kind: 'skill' | 'mcp',
  name: string
): { outcome: string; reason?: string } {
  if (kind === 'skill') {
    const list = scanAllSkills()
      .filter(s => s.name === name)
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    if (list.length === 0) return { outcome: 'missing', reason: '源文件已不在本机' };
    const primary = list[0];
    const payload = skillPayload(primary);
    const r = importOne(payload);
    // 其余来源只登记，不改正文（与 runImport 一致；存各自的指纹）
    for (const extra of list.slice(1)) {
      registerSource('skill', name, extra.agentId, extra.dirPath, skillContentHash(extra));
    }
    pruneSources(r.itemId, list.map(s => s.dirPath));
    rebuildTargets(r.itemId, 'skill');
    return { outcome: r.outcome };
  }

  const list = scanAllMcp()
    .filter(m => m.name === name)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
  if (list.length === 0) return { outcome: 'missing', reason: '源配置里已没有这条服务' };
  const primary = list[0];
  const payload = mcpPayload(primary);
  const r = importOne(payload);
  for (const extra of list.slice(1)) {
    registerSource('mcp', name, extra.agentId, extra.sourcePath, mcpContentHash(extra));
  }
  pruneSources(r.itemId, list.map(m => m.sourcePath));
  rebuildTargets(r.itemId, 'mcp');
  return { outcome: r.outcome };
}
