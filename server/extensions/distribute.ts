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
import { listItems } from './store.js';
import { scanAllMcp } from './import.js';

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
 * 生成（覆盖写）目标 Agent 的 MCP 配置文件。
 *
 * 每次发消息前都会重新生成：文件很小（几条服务），而「用户在 OPC 里改了
 * 列表之后下一次就生效」比省几毫秒重要。
 */
export function buildMcpConfig(agentId: string): DistributeResult {
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

  if (shared.length === 0) {
    // 没有可共享的：不生成文件，调用方也不加参数 —— 保持 Agent 原样
    return { filePath: null, shared, missing, skipped, ownCount: own.size };
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const filePath = path.join(DIST_DIR, `mcp-${agentId}.json`);
  /* 写 `{ "mcpServers": { … } }` 而不是裸的 `{ name: cfg }`：
     Claude Code 系（qodercli 与它同构）的 `--mcp-config` 认这个外壳。 */
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');

  return { filePath, shared, missing, skipped, ownCount: own.size };
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
