/**
 * WorkBuddy 官方产品配置（`acc-product-config-v3.json`）的读取与补齐。
 *
 * ## 为什么需要这个文件
 *
 * SDK 的 `getAvailableModelsRaw()` 是**实时**清单，官方产品配置是一份**快照**。
 * 两边互补，谁都不能单独当权威：
 *
 * - 本机实测（2026-10-21）：官方实时阵容（宿主 spill 的 10-15 快照）cli 自声明
 *   28 条，SDK 的 30 条全含（多出的 2 条是用户自配的 `custom-local:*` 模型），
 *   缺口为 0 —— SDK 追上了官方。
 * - 但 SDK 会周期性落后：同一台机器 13 天前的旧缓存（10-08 阵容）里，官方 cli
 *   声明 20 条，其中 9 条当时的 SDK 没给（`deep-model` / `hy3-x` / `space-bunny` /
 *   `glm-5.1` / `glm-5v-turbo` / `minimax-m3` / `kimi-k3-1` / `kimi-k2.7` /
 *   `deepseek-v4-pro`），缺口方向是「官方有、SDK 无」。
 * - 官方阵容换血极快：10-08 → 10-15 七天里下线 9 条、上线 12 条
 *   （`gpt-6-*` / `grok-4.7` / `gemini-3.*` 整批替换旧梯队）。
 *
 * 所以补齐的价值是覆盖 **SDK 落后于新鲜配置** 的窗口；而反方向的危险是
 * **拿过期配置补已经下线的模型**——那是假控件（菜单里能选、发了就失败）。
 * 因此补位前必须过新鲜度闸门（见 `MAX_CONFIG_AGE_DAYS`）。
 *
 * ## 路径怎么定（不是我们猜的）
 *
 * 配置文件自己写明了规则，照它的声明取即可：
 *   - `dataFolderName` = `.workbuddy` → 数据根目录
 *   - `productConfigPathEnv` = `ACC_PRODUCT_CONFIG_PATH`（显式指定文件路径，优先）
 *   - `productConfigEnv` = `ACC_PRODUCT_CONFIG_V3` / `_V2` / 无后缀（内联 JSON 内容）
 *   - 缓存文件本身在 `<数据根>/cache/acc-product-config-v3.json`
 *
 * 注意本应用是**独立桌面应用**，脱离官方宿主运行时没有 spill 环境变量，
 * 主路径就是读用户磁盘上的缓存——那份缓存的新鲜度完全取决于用户多久跑一次
 * 官方 app，所以闸门不是可选项。
 *
 * ## 纪律（与 qoder / codex 那套一致）
 *
 * - 这是**明文 JSON 缓存**，官方客户端自己就读它 —— 不像 qoder 的
 *   `catalog-v7`（magic `QMC\x01`、含账号与价格）那样是私有格式，所以不存在逆向问题。
 * - 只补**官方 `cli` agent 自己声明过**的模型。配置的 `models` 数组是全集，
 *   多出来的那些是内部补全模型（`codewise-*` / `hunyuan-3b` / `default-1.1`）
 *   —— 它们不是给用户在对话里选的，列出来就是假控件。
 * - **新鲜度闸门**：配置顶层 `date` 缺失 / 解析不了 / 超过 7 天 → 整个源作废。
 *   下线模型在旧配置里没有任何 deprecated 标记（`deep-model` 的条目看着毫无异样），
 *   日期是唯一可用的新鲜度信号。宁少补（退回 SDK 清单），不补错（假控件）。
 * - 文件不存在 / 读不懂 / 字段缺失 → 返回 null，调用方**静默退回 SDK 清单**。
 *   绝不因为补齐源挂了就让整个模型菜单消失。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SdkRawModel } from './sdk-models.js';

/** 官方 cli agent 声明的模型 id（顺序即官方推荐序），以及可从配置取到的元数据 */
export interface DeclaredModels {
  /** 官方 cli agent 自声明、按声明顺序排列的模型 id */
  declared: string[];
  /** id → 元数据（只收录配置里确实有完整条目的） */
  byId: Map<string, SdkRawModel>;
}

/** 从内联环境变量或磁盘读原始 JSON。读不到返回 null */
function readRawConfig(): Record<string, unknown> | null {
  const inline =
    process.env.ACC_PRODUCT_CONFIG_V3 ??
    process.env.ACC_PRODUCT_CONFIG_V2 ??
    process.env.ACC_PRODUCT_CONFIG;
  if (inline && inline.trim()) {
    try {
      const parsed = JSON.parse(inline);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  const explicit = process.env.ACC_PRODUCT_CONFIG_PATH;
  const candidates = explicit
    ? [explicit]
    : [path.join(os.homedir(), '.workbuddy', 'cache', 'acc-product-config-v3.json')];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // 读不懂就试下一个（或整体放弃），不抛
    }
  }
  return null;
}

/**
 * 配置快照的新鲜度上限（天）。
 *
 * 定 7 天的依据是本机两份真实配置的对照：
 *   - 5 天前的 spill（10-15 阵容）：cli 声明 28 条，与当时的实时 SDK 清单
 *     完全一致（缺口 0，无一条已下线）；
 *   - 13 天前的缓存（10-08 阵容）：cli 声明 20 条，其中 9 条已被官方下线
 *     （`deep-model` 等），而它们的条目在旧配置里毫无 deprecated 标记。
 * 官方阵容约按周换血，7 天落在「还能用」与「已换血」的实测边界内。
 * 方向性取舍：闸门判死的代价是退回 SDK 清单（少几个可选模型），
 * 闸门放行的代价是往菜单里注入下线模型（假控件，选了就失败）——
 * 后者更坏，所以宁可保守。
 */
const MAX_CONFIG_AGE_DAYS = 7;

/** 配置快照是否够新鲜。没有可用 date 一律判死（无法判断新鲜度就不配当补齐源） */
function isFreshConfig(cfg: Record<string, unknown>): boolean {
  const raw = cfg.date;
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return false;
  const ageDays = (Date.now() - t) / 86_400_000;
  // 时钟偏差导致 date 在未来也算通过（ageDays 为负）
  return ageDays <= MAX_CONFIG_AGE_DAYS;
}

/**
 * 取「官方 cli agent 自声明」的模型集合。
 *
 * `agents` 里每个 agent 都有自己的 `models` 数组，口径各不相同
 * （`terminalTitleGenerator` 只要 1 个、`memorySelector` 只要 `lite`）。
 * 我们只要 `name === 'cli'` 那一份 —— 它对应终端里的 Agent 本体，
 * 也就是用户在对话里真正能选的那些。
 */
export function readDeclaredModels(): DeclaredModels | null {
  const cfg = readRawConfig();
  if (!cfg) return null;
  if (!isFreshConfig(cfg)) return null;

  const agents = Array.isArray(cfg.agents) ? cfg.agents : [];
  const cli = agents.find(
    (a): a is Record<string, unknown> =>
      !!a && typeof a === 'object' && (a as Record<string, unknown>).name === 'cli'
  );
  const declaredRaw = cli && Array.isArray(cli.models) ? cli.models : [];

  const modelsRaw = Array.isArray(cfg.models) ? cfg.models : [];
  const byId = new Map<string, SdkRawModel>();
  for (const m of modelsRaw) {
    const entry = m as SdkRawModel;
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    byId.set(entry.id, entry);
  }

  // 声明了但配置里查不到条目的（不该发生，但不猜）：直接丢，不进清单
  const declared: string[] = [];
  for (const id of declaredRaw) {
    if (typeof id !== 'string' || !id) continue;
    if (!byId.has(id)) continue;
    if (!declared.includes(id)) declared.push(id);
  }
  if (declared.length === 0) return null;
  return { declared, byId };
}
