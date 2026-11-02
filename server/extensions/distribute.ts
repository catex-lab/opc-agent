/**
 * 扩展的分发（P2）：把 OPC 库里的 MCP 服务汇成一个**临时配置文件**，
 * 由启动参数指给目标 Agent。**绝不写用户自己的配置文件。**
 *
 * ## 为什么必须回读源文件，而不是用库里的 config_json
 *
 * 库里的 `config_json` 是**脱敏后**的（env 的值换成 `***`，见 `import.ts` 的
 * `redactConfig`）—— 那是为了「库不存密钥」。但分发出去的是**要真跑起来的配置**，
 * 拿 `***` 当 API Key 只会让服务启动失败。
 * 所以：**库只决定「分发哪些、叫什么名字」，值一律从各家配置文件重新读原值。**
 * 附带的好处是不新增任何敏感存储：密钥始终只在用户自己的文件里，
 * 我们只在启动那一刻把它们汇进 `data/extensions/` 下的一个临时 JSON。
 *
 * ## 为什么只分发「目标 Agent 自己没有的」
 *
 * 目标 Agent 自己的配置文件（如 `~/.qoder/mcp.json`）它启动时会自己加载。
 * 我们把同名的再塞一遍，轻则重复加载、重则冲突覆盖 —— 而两边值还可能不同
 * （用户改了那边没重新导入）。
 * 所以这里做**差集**：只把「从别的 Agent 共享过来的」写进文件。
 * 代价是「在 OPC 里禁用某条 qoder 自己的 MCP」目前不生效 —— 那条得等
 * 分发层能接管目标 Agent 的整份配置（P4 之后）再说，这里不假装能做到。
 *
 * ## 文件名带 agentId
 *
 * `mcp-<agentId>.json`。多个 Agent 各自一份，互不覆盖；也方便排查
 * 「这条参数到底指到了什么」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath } from '../paths.js';
import { listItems, listSources } from './store.js';
import { scanAllMcp } from './import.js';
import { targetOf } from './targets.js';
import { mirrorSkill, safeDirName, MIRROR_ROOT } from './inject.js';

export interface McpComputeResult {
  /** 真正写进文件的条目名（空数组 = 没有可分发内容） */
  shared: string[];
  /** 库里有、但源文件里已经找不到的（源被删了 / 换了路径） */
  missing: string[];
  /** 源配置里明确禁用（`enabled = false`）而跳过的 */
  skipped: string[];
  /** 目标 Agent 自己配置文件里已有的名字（不重复写） */
  ownCount: number;
  /** 最终要写入的 servers 映射（仅用于写盘；预览接口只读它也不写任何文件） */
  servers: Record<string, Record<string, unknown>>;
}

export interface DistributeResult {
  /** 生成的文件路径；没有可分发的内容时为 null（此时调用方**不加**任何参数） */
  filePath: string | null;
  /** 本次真正写进文件的条目名 */
  shared: string[];
  /** 库里有、但源文件里已经找不到的（源被删了 / 换了路径） */
  missing: string[];
  /** 源配置里明确禁用（`enabled = false`）而跳过的 */
  skipped: string[];
  /** 目标 Agent 自己配置文件里已有的名字（不重复写） */
  ownCount: number;
}

const DIST_DIR = path.join(dataDirPath, 'extensions');

/**
 * agentId 双重校验：必须在 `targetOf` 白名单里，且只含小写字母 / 数字 / `-`。
 *
 * 曾经被拼进文件名 `mcp-${agentId}.json` 而没有任何校验 —— 传入 `../../evil`
 * 就能把文件写出 `dataDir` 甚至覆盖任意 `.json`。现在把文件名收口到这里，
 * 所有分发相关入口（mcpArgsFor / 预览接口）统一走它，非法一律返回 null。
 */
export function safeAgentId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  if (!targetOf(raw)) return null;
  return raw;
}

/**
 * 纯计算：把「别的 Agent 共享过来的 MCP」汇成一份 servers 映射。**不写任何文件**。
 *
 * 每次发消息前都会重新算：内容很小，而「用户在 OPC 里改了列表之后下一次
 * 就生效」比省几毫秒重要。
 */
export function computeMcpConfig(agentId: string): McpComputeResult {
  const all = scanAllMcp();

  /* 同一个服务名可能出现在多家配置里，值还可能不同（各自的 API Key）。
     口径与 import.ts 的「第一个来源为准」保持一致：按 agentId 字典序取第一个，
     确定性优先，不按「谁先扫到」。 */
  const sorted = [...all].sort((a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name));
  const rawByName = new Map<string, Record<string, unknown>>();
  for (const m of sorted) {
    if (!rawByName.has(m.name)) rawByName.set(m.name, m.config);
  }

  // 目标 Agent 自己已经有的名字：不重复写（它自己会加载）
  const own = new Set(all.filter(m => m.agentId === agentId).map(m => m.name));

  const servers: Record<string, Record<string, unknown>> = {};
  const shared: string[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];

  for (const item of listItems('mcp')) {
    if (!item.enabled) continue;
    if (own.has(item.name)) continue;
    const cfg = rawByName.get(item.name);
    if (!cfg) {
      // 源文件里已经没有这条了（用户在客户端里删了 / 改了名）
      missing.push(item.name);
      continue;
    }
    /* 源配置里**明确禁用**的不要推给别人。
       codex 的 `config.toml` 用 `enabled = false` 关掉一条服务 —— 那是用户的
       决定，我们把它导进库只是为了让用户看得见，不代表要替用户重新打开它。
       实测本机 `cua_repl` 就是 `enabled: false`，原样分发等于「用户关掉的东西
       被我们悄悄打开了」。 */
    if (cfg.enabled === false) {
      skipped.push(item.name);
      continue;
    }
    servers[item.name] = cfg;
    shared.push(item.name);
  }

  return { shared, missing, skipped, ownCount: own.size, servers };
}

/**
 * 写盘：把纯计算结果落到 `data/extensions/mcp-<agentId>.json`。
 *
 * 文件结构 `{ "mcpServers": { … } }`：Claude Code 系（qodercli 与它同构）
 * 的 `--mcp-config` 认这个外壳。
 *
 * 只有当 `r.shared.length > 0` 时才生成文件；否则返回 `{ filePath: null, ... }`
 * 让调用方决定「不加参数」—— 保持 Agent 原样。
 */
function writeMcpConfig(agentId: string, r: McpComputeResult): DistributeResult {
  if (r.shared.length === 0) {
    return { filePath: null, shared: r.shared, missing: r.missing, skipped: r.skipped, ownCount: r.ownCount };
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const filePath = path.join(DIST_DIR, `mcp-${agentId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: r.servers }, null, 2), 'utf8');
  return { filePath, shared: r.shared, missing: r.missing, skipped: r.skipped, ownCount: r.ownCount };
}

/**
 * 生成（覆盖写）目标 Agent 的 MCP 配置文件。只有被 `safeAgentId` 放行的 agentId
 * 才会走到写盘；非法一律返回 `{ filePath: null }`，调用方不加任何参数。
 */
export function buildMcpConfig(agentId: string): DistributeResult {
  const safe = safeAgentId(agentId);
  if (!safe) {
    return { filePath: null, shared: [], missing: [], skipped: [], ownCount: 0 };
  }
  return writeMcpConfig(safe, computeMcpConfig(safe));
}

/**
 * 给某个 Agent 的启动参数里补 MCP 相关项。
 *
 * 目前只有 qoder 实测过（`--mcp-config <file>`）。**不加 `--strict-mcp-config`**：
 * 那个开关会「只用 --mcp-config 里的、忽略其余来源」，于是用户自己配的、
 * 还没在 OPC 里导入的 MCP 会**突然失效** —— 为了一个功能去关掉用户已有的能力，
 * 代价太大。我们只做加法。
 */
export function mcpArgsFor(agentId: string): string[] {
  const r = buildMcpConfig(agentId);
  if (!r.filePath) return [];
  return ['--mcp-config', r.filePath];
}

// ============================================================
// P5-D：技能分发（flag 态 Agent，零写入）
// ============================================================

/**
 * 支持 `--plugin-dir` 来加载技能的 Agent 集合。
 *
 * qoder / qoder-cn 实测（`qodercli --help` 1.1.78）有 `--plugin-dir <dir>`，
 * plugin 根目录下放 `skills/<skill-name>/SKILL.md` 就能被发现。
 * Gemini CLI 的 help 里**没有**技能目录启动参数（gemini skills 子命令
 * 只有 link/enable/disable，link 会写用户目录，违反硬约束），所以 gemini
 * 暂不支持——skillArgsFor 对它返回空数组，如实承认边界。
 *
 * 将来 gemini 或其他 flag 态 Agent 有了技能目录参数，在这里追加即可。
 */
const PLUGIN_DIR_AGENTS = new Set(['qoder', 'qoder-cn']);

/** 聚合 plugin 壳根（data/extensions/opc-skill-plugin/）。 */
const SKILL_PLUGIN_ROOT = path.join(dataDirPath, 'extensions', 'opc-skill-plugin');
/** plugin 壳内部 skills 子目录（qoder 会扫这里）。 */
const PLUGIN_SKILLS_DIR = path.join(SKILL_PLUGIN_ROOT, 'skills');
/** plugin manifest 路径。 */
const PLUGIN_MANIFEST_DIR = path.join(SKILL_PLUGIN_ROOT, '.qoder-plugin');
const PLUGIN_MANIFEST_PATH = path.join(PLUGIN_MANIFEST_DIR, 'plugin.json');

/**
 * 确保 plugin 壳存在且包含正确的技能目录。
 *
 * 壳结构（qoder 能认得）：
 *
 * ```
 * opc-skill-plugin/
 * ├── .qoder-plugin/plugin.json   ← 最小 manifest
 * └── skills/                     ← qoder 自动扫这个
 *     ├── agently-mail/           ← 镜像目录的拷贝
 *     └── design-system/
 * ```
 *
 * 每个技能目录都是 `inject.ts` 的 `mirrorSkill` 产出镜像的**拷贝**。
 *
 * ## 为什么不用 junction
 *
 * 之前用 junction 省磁盘，但 2026-11-02 真机验证时发现判断不了 qoder 是否会
 * 跟随 junction：qodercli 是独立的 bun 可执行文件，而本机受限文件系统会把
 * junction 目标改写成内部路径，Node 自己都读不到（`symlinkSync` 不报错，
 * `lstat` 却是 ENOENT）。「链接建成功但消费端读不到」的表现是技能**静默消失**，
 * 这种只能靠用户发现的故障不值得用一个链接去换磁盘。技能目录很小
 * （SKILL.md + scripts），拷贝的代价低得多，而且 qoder 读到的是普通目录，
 * 怎么处理链接都与我们无关了。
 *
 * 拷贝是幂等的：目标 `SKILL.md` 的 size + mtime 与镜像一致就跳过，不每轮重拷。
 *
 * ## 差集：只给「目标 Agent 自己没有的」
 *
 * 如果目标 Agent 自己的 `~/.qoder/skills/` 里已经有 agently-mail，OPC 不再塞。
 * 与 MCP 分发的理由相同：重复加载轻则冗余、重则冲突覆盖。
 */
function ensureSkillPlugin(agentId: string): { pluginRoot: string | null; count: number } {
  if (!PLUGIN_DIR_AGENTS.has(agentId)) return { pluginRoot: null, count: 0 };

  const target = targetOf(agentId);
  if (!target) return { pluginRoot: null, count: 0 };

  // 1. 准备 plugin 壳基础结构
  try {
    fs.mkdirSync(PLUGIN_SKILLS_DIR, { recursive: true });
    fs.mkdirSync(PLUGIN_MANIFEST_DIR, { recursive: true });
    if (!fs.existsSync(PLUGIN_MANIFEST_PATH)) {
      fs.writeFileSync(
        PLUGIN_MANIFEST_PATH,
        JSON.stringify(
          {
            name: 'opc-skill-plugin',
            version: '0.0.1',
            description: 'OPC managed shared skills plugin',
          },
          null,
          2
        ),
        'utf8'
      );
    }
  } catch (e) {
    console.error('[extensions] 准备技能 plugin 壳失败:', (e as Error).message);
    return { pluginRoot: null, count: 0 };
  }

  // 2. 计算需要分发的技能集合
  //    条件：enabled && !blocked && 目标 agent 自己没有这条
  const needed = new Map<string, { item: ReturnType<typeof listItems>[number]; mirrorDir: string }>();
  const skillItems = listItems('skill');

  for (const item of skillItems) {
    if (!item.enabled || item.blocked) continue;

    // 目标 Agent 自己的目录里就有这条 → 跳过（它自己会加载）
    const sources = listSources(item.id);
    const own = sources.find(s => {
      if (s.agentId !== agentId) return false;
      try {
        return fs.existsSync(path.join(s.path, 'SKILL.md'));
      } catch {
        return false;
      }
    });
    if (own) continue;

    // 确保 mirror 已存在（mirrorSkill 幂等：已经有同一签名的 marker 就直接返回路径）
    const srcDir = sources.map(s => s.path).find(p => {
      try {
        return fs.existsSync(path.join(p, 'SKILL.md'));
      } catch {
        return false;
      }
    }) ?? null;

    const body = item.body ?? (srcDir ? readSkillBody(srcDir) : null);
    if (!body) continue;

    const mirrorDir = mirrorSkill({
      name: item.name,
      body,
      srcDir,
      signature: [item.contentHash, item.bodyHash, item.revision].join('|'),
    });
    if (!mirrorDir) continue;

    needed.set(item.name, { item, mirrorDir });
  }

  // 3. 对比现有目录，补缺失、删多余
  try {
    for (const name of fs.readdirSync(PLUGIN_SKILLS_DIR)) {
      const full = path.join(PLUGIN_SKILLS_DIR, name);
      if (!needed.has(name)) {
        // 这条技能不再需要（禁用/删除/目标 Agent 自己已有）→ 删掉壳里的拷贝
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch {
          /* 删不掉就算了，下次再说 */
        }
      }
    }
  } catch {
    /* skills 目录不存在，readdir 抛错——我们 mkdir 已经建过了，这里只是兜底 */
  }

  for (const [name, { mirrorDir }] of needed) {
    const safeName = safeDirName(name);
    if (!safeName) continue;
    try {
      syncSkillDir(path.join(PLUGIN_SKILLS_DIR, safeName), mirrorDir);
    } catch (e) {
      console.error('[extensions] 同步技能目录失败，跳过:', name, (e as Error).message);
    }
  }

  return { pluginRoot: SKILL_PLUGIN_ROOT, count: needed.size };
}

/** 目标目录已经是镜像的那一份？（普通目录，按 `SKILL.md` 的 size + mtime 判） */
function skillDirSynced(destPath: string, mirrorDir: string): boolean {
  try {
    const dest = fs.statSync(path.join(destPath, 'SKILL.md'));
    const source = fs.statSync(path.join(mirrorDir, 'SKILL.md'));
    return dest.size === source.size && Math.abs(dest.mtimeMs - source.mtimeMs) < 1;
  } catch {
    return false; // 不存在 / 没有 SKILL.md
  }
}

/**
 * 把镜像目录拷进 plugin 壳；已经是同一份就跳过（幂等）。
 *
 * `preserveTimestamps: true` 是幂等判据的前提：不快照 mtime 的话，每次拷贝都会
 * 生成新的 mtime，`skillDirSynced` 永远为 false，等于每轮全量重拷。
 */
function syncSkillDir(destPath: string, mirrorDir: string): void {
  if (skillDirSynced(destPath, mirrorDir)) return;
  try {
    fs.rmSync(destPath, { recursive: true, force: true });
  } catch {
    /* 删不掉就让 cpSync 直接报出来 */
  }
  fs.cpSync(mirrorDir, destPath, { recursive: true, preserveTimestamps: true });
}

function readSkillBody(srcDir: string): string | null {
  try {
    return fs.readFileSync(path.join(srcDir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 给 flag 态 Agent 的启动参数里补技能目录。
 *
 * 目前只对 qoder / qoder-cn 生效（它们的 --plugin-dir 能发现 skills/ 子目录）。
 * 对 gemini 等暂不支持的 flag 态 Agent 返回空数组——不假装支持。
 */
export function skillArgsFor(agentId: string): string[] {
  const safe = safeAgentId(agentId);
  if (!safe) return [];
  const { pluginRoot, count } = ensureSkillPlugin(safe);
  if (!pluginRoot || count === 0) return [];
  return ['--plugin-dir', pluginRoot];
}
