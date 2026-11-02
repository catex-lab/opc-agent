/**
 * 扩展的差异检测（P4）：**本机源文件** 与 **OPC 库** 之间现在差了什么。
 *
 * ## 为什么需要它
 *
 * 导入是一次性的动作：用户在自己客户端里装了新技能、改了某个 SKILL.md、
 * 或者删掉了一条，OPC 这边**不会自己知道**。上一版只有两个出口：
 * ① 手动点「导入」（全量覆盖一遍，看不出发生了什么）
 * ② 在详情页里对单条点「重新导入」（前提是你已经怀疑它变了）
 * 两者都要求用户「先知道有问题」，而 P4 要回答的正是「有没有问题」。
 *
 * ## 口径：只报告，不应用
 *
 * `scanDrift()` 是**纯读**：不写库、不写用户目录。应用是另一个动作
 * （`applyDrift` → `importByName`），走的是与全量导入**同一套**判定
 * （`importOne` 的 added/updated/conflict），所以「差异列表里点应用」
 * 与「点全量导入」对同一条的结论必然一致。
 *
 * ## 四态怎么判
 *
 * | 态 | 判据 | 用户该做什么 |
 * |---|---|---|
 * | `new` | 扫到了这个名字，库里没有 | 应用（收进库） |
 * | `updated` | 指纹不同，且**本地没改过** | 应用（跟上源） |
 * | `conflict` | 指纹不同，但**本地改过** | 决定：以源为准，还是留着本地改的 |
 * | `gone` | 库里有，这次**扫不到了** | 看一眼，然后移除副本（源文件已经不在了） |
 *
 * `conflict` 与 `updated` 必须分开：前者应用了会**丢掉用户的编辑**，
 * 后者不会。混成一个「有更新」的提示，用户点「全部应用」就会静默毁掉自己的改动。
 *
 * ## 为什么不做服务端定时器 / 不缓存
 *
 * 一次扫描 = 读 54 个 SKILL.md + 9 个 MCP 配置文件，实测**几十毫秒**。
 * 缓存能省下这点时间，但要在「导入 / 编辑 / 删除 / 归一化 / 以源为准」
 * 五个写入口都记得失效 —— 漏一个的表现是「明明改了，徽章还是旧的」，
 * 那种不一致比 30ms 贵得多。所以每次都真扫。
 *
 * 同理不挂 `setInterval`：桌面应用大部分时间没人看这一栏，一个只在
 * 有人打开面板时才有意义的扫描不该常驻后台。轮询放在前端（见
 * `useExtensionDrift`），面板关掉就停。
 */

import { findItem, listItems } from './store.js';
import { mcpContentHash, importByName, scanAllMcp, scanAllSkills, skillContentHash } from './import.js';

export type DriftState = 'new' | 'updated' | 'conflict' | 'gone';

export interface DriftEntry {
  kind: 'skill' | 'mcp';
  name: string;
  title: string | null;
  state: DriftState;
  /** 提供新内容的那个 Agent（`gone` 时为 null） */
  agentId: string | null;
  /** 源文件路径（`gone` 时为 null） */
  sourcePath: string | null;
  /** 界面直接显示的一句话，不再让前端自己拼 */
  detail: string;
}

export interface DriftReport {
  /** 扫描时刻（ISO）。前端据此显示「刚刚检查过」 */
  scannedAt: string;
  entries: DriftEntry[];
  counts: { new: number; updated: number; conflict: number; gone: number; total: number };
}

/** 排序权重：先让用户看「会丢东西的」，再看「能一键跟上的」，最后看「已经没了的」。 */
const STATE_ORDER: Record<DriftState, number> = { conflict: 0, updated: 1, new: 2, gone: 3 };

function label(kind: 'skill' | 'mcp'): string {
  return kind === 'skill' ? '技能' : 'MCP';
}

/**
 * 扫描并比较。**纯读**。
 *
 * 排序口径与 `runImport` 完全一致（`agentId` 字典序 → `name`），
 * 否则「差异里说变了」与「导入后说没变」会对不上。
 */
export function scanDrift(): DriftReport {
  const entries: DriftEntry[] = [];
  const seen = new Set<string>();

  // ── 技能 ────────────────────────────────────────────────
  const skills = scanAllSkills().sort(
    (a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name)
  );
  const skillPrimary = new Map<string, (typeof skills)[number]>();
  for (const s of skills) {
    seen.add(`skill:${s.name}`);
    if (!skillPrimary.has(s.name)) skillPrimary.set(s.name, s);
  }
  for (const [name, primary] of skillPrimary) {
    const item = findItem('skill', name);
    if (!item) {
      entries.push({
        kind: 'skill',
        name,
        title: primary.title,
        state: 'new',
        agentId: primary.agentId,
        sourcePath: primary.dirPath,
        detail: `在 ${primary.agentId} 里新装的技能`,
      });
      continue;
    }
    if (item.contentHash === skillContentHash(primary)) continue; // 源没变
    entries.push({
      kind: 'skill',
      name,
      title: item.title ?? primary.title,
      state: item.locallyModified ? 'conflict' : 'updated',
      agentId: primary.agentId,
      sourcePath: primary.dirPath,
      detail: item.locallyModified
        ? `${primary.agentId} 里的源变了，但你在 OPC 里改过这条`
        : `${primary.agentId} 里的源文件变了`,
    });
  }

  // ── MCP ────────────────────────────────────────────────
  const mcps = scanAllMcp().sort(
    (a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name)
  );
  const mcpPrimary = new Map<string, (typeof mcps)[number]>();
  for (const m of mcps) {
    seen.add(`mcp:${m.name}`);
    if (!mcpPrimary.has(m.name)) mcpPrimary.set(m.name, m);
  }
  for (const [name, primary] of mcpPrimary) {
    const item = findItem('mcp', name);
    if (!item) {
      entries.push({
        kind: 'mcp',
        name,
        title: name,
        state: 'new',
        agentId: primary.agentId,
        sourcePath: primary.sourcePath,
        detail: `在 ${primary.agentId} 的配置里新出现的服务`,
      });
      continue;
    }
    if (item.contentHash === mcpContentHash(primary)) continue;
    entries.push({
      kind: 'mcp',
      name,
      title: item.title ?? name,
      state: item.locallyModified ? 'conflict' : 'updated',
      agentId: primary.agentId,
      sourcePath: primary.sourcePath,
      detail: item.locallyModified
        ? `${primary.agentId} 的配置变了，但你在 OPC 里改过这条`
        : `${primary.agentId} 的配置里这条变了`,
    });
  }

  // ── 已经扫不到的 ─────────────────────────────────────────
  for (const item of listItems()) {
    if (seen.has(`${item.kind}:${item.name}`)) continue;
    entries.push({
      kind: item.kind,
      name: item.name,
      title: item.title,
      state: 'gone',
      agentId: null,
      sourcePath: null,
      detail: `本机已经找不到这个${label(item.kind)}的源文件`,
    });
  }

  entries.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name)
  );

  const counts = { new: 0, updated: 0, conflict: 0, gone: 0, total: entries.length };
  for (const e of entries) counts[e.state] += 1;

  return { scannedAt: new Date().toISOString(), entries, counts };
}

export interface DriftApplyResult {
  kind: 'skill' | 'mcp';
  name: string;
  /**
   * `importOne` 的结论：`added` / `updated` / `unchanged` / `conflict` / `missing`。
   * `conflict` 表示**没有覆盖本地修改**（这是对的，不是失败）；`missing` 表示
   * 这一轮扫不到源了（源文件在两次扫描之间被删了）。
   */
  outcome: string;
  reason?: string;
}

/**
 * 应用差异：逐条走 `importByName`（与全量导入同一套判定）。
 *
 * **不处理 `conflict`**：`importByName` 遇到本地改过的条目会返回 `conflict`
 * 并原样保留正文。想「以源为准」必须显式走 `accept-source` —— 那条路会
 * 先清掉 `locally_modified` 再刷新，等于用户明确说了「我的改动不要了」。
 * 把这件事藏进「全部应用」里就等于用一个按钮销毁用户的编辑。
 */
export function applyDrift(entries: readonly { kind: 'skill' | 'mcp'; name: string }[]): {
  results: DriftApplyResult[];
  report: DriftReport;
} {
  const results: DriftApplyResult[] = entries.map(e => {
    const r = importByName(e.kind, e.name);
    return {
      kind: e.kind,
      name: e.name,
      outcome: r.outcome,
      ...(r.reason ? { reason: r.reason } : {}),
    };
  });
  // 应用完立刻重扫，返回新的差异 —— 前端不用再发一次请求，也不会出现
  // 「应用成功但徽章还挂着」的中间态。
  return { results, report: scanDrift() };
}
