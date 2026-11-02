/**
 * 扩展（技能 / MCP）的 Agent 侧映射表。
 *
 * ## 这张表只描述事实，不描述愿望
 *
 * `skillsDir` 必须是**本机实测存在**的目录（2026-11-01 逐个 `ls` 过）。没有的写 `null`，
 * 不写「大概是这个路径」—— 猜错的代价是把别人的技能导进来。
 *
 * ## 两个曾经踩过的坑（写在这里防止后人改回去）
 *
 * 1. **`kimicode` 是 HTTP 类型**（Kimi 开放平台 `api.moonshot.cn`），没有本地目录。
 *    真正的 Kimi CLI 是 `kimicli`，用 `~/.kimi-code`，而它也没有 `skills` 子目录。
 * 2. **`~/.kilocode/skills` 属于 Kilo Code，不是我们支持的任何 Agent。**
 *    曾经把 `kimicode` 错映射到它，那会把 Kilo Code 的技能当成 Kimi 的导入。
 *    **本文件不得出现 `kilocode`。**
 *
 * ## 四态的含义
 *
 * | mode | 含义 | 接通情况 |
 * |---|---|---|
 * | `native` | 该 Agent 自己就读自己的技能目录，目录里有就等于能用 | 是（事实层面） |
 * | `flag` | 需要我们传启动参数才能挂上（零写入） | 是（MCP 走 P2 的 `--mcp-config`，技能走 P5 的 `--plugin-dir`） |
 * | `prompt` | 我们拼系统提示注入（该适配器已有 `withMemoryContext`） | 是（P3，见 `inject.ts`） |
 * | `unsupported` | 既没有目录，也没有挂载接口 | — |
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MountMode = 'native' | 'flag' | 'prompt' | 'unsupported';

export interface TargetSpec {
  agentId: string;
  /** 面向用户的短名 */
  label: string;
  /** 技能目录绝对路径；`null` = 该 Agent 没有技能目录 */
  skillsDir: string | null;
  mode: MountMode;
  /** 界面上那句解释，必须说人话 */
  note: string;
}

/**
 * 扫描起点（用户主目录）。
 *
 * ## 为什么留一个环境变量口子
 *
 * 验证脚本要在**不碰用户真实 `~/.claude` / `~/.qoder` 等目录**的前提下跑完
 * 「导入 → 去重 → 冲突 → 删除」整条链路（见 `verify-a164-extensions.mjs`）。
 * 没有口子的话，测试只能往真实主目录里塞假技能 —— 那既污染用户环境，也让
 * 「只读」这条约束在测试里破功。
 *
 * `OPC_EXT_HOME` **只在被显式设置时生效**，生产路径下不设它 = 行为与
 * `os.homedir()` 完全一致，不引入任何隐藏分支。
 *
 * 它只影响**读**的起点。本模块（及整个 `server/extensions/`）从不写任何
 * Agent 目录，这一点与这个口子无关。
 *
 * ⚠️ `TARGETS` 在模块加载时就调用 `at()` 把路径算死，所以 `OPC_EXT_HOME`
 *    必须在**进程启动前**设好（`import` 之后再改环境变量不会生效）。
 */
export function homeDir(): string {
  return process.env.OPC_EXT_HOME || os.homedir();
}

function at(...seg: string[]): string {
  return path.join(homeDir(), ...seg);
}

/**
 * 15 个受支持 Agent 的完整清单。
 *
 * 顺序刻意按「能用的在前」排：有目录的 9 个 → 只有注入的 4 个 → 什么都不行的。
 * 界面上直接按这个顺序渲染，用户第一眼看到的就是能用的。
 */
export const TARGETS: readonly TargetSpec[] = [
  // ── 有技能目录的 9 个 ──────────────────────────────────────────────
  { agentId: 'claude', label: 'claude', skillsDir: at('.claude', 'skills'), mode: 'prompt', note: '有技能目录；OPC 侧走 claude-sdk 提示词注入' },
  { agentId: 'qoder', label: 'qoder', skillsDir: at('.qoder', 'skills'), mode: 'flag', note: '技能走 --plugin-dir、MCP 走 --mcp-config（P2/P5 已接通）' },
  { agentId: 'qoder-cn', label: 'qoder-cn', skillsDir: at('.qoder-cn', 'skills'), mode: 'flag', note: '与 qoder 同构：--plugin-dir + --mcp-config（P2/P5 已接通）' },
  { agentId: 'gemini', label: 'gemini', skillsDir: at('.gemini', 'skills'), mode: 'unsupported', note: '只能读它自己的目录；官方 skills link 会写 ~/.gemini，违反零写入' },
  { agentId: 'codex', label: 'codex', skillsDir: at('.codex', 'skills'), mode: 'unsupported', note: '有目录；codex-sdk 尚未接提示词注入（需先验证它接受 systemPrompt）' },
  { agentId: 'cursor', label: 'cursor', skillsDir: at('.cursor', 'skills'), mode: 'unsupported', note: '有目录，未查到外部挂载接口' },
  { agentId: 'opencode', label: 'opencode', skillsDir: at('.opencode', 'skills'), mode: 'unsupported', note: '有目录，未查到外部挂载接口' },
  { agentId: 'zcode', label: 'zcode', skillsDir: at('.zcode', 'skills'), mode: 'unsupported', note: '有目录，无 --model 类外部接口' },
  { agentId: 'workbuddy', label: 'workbuddy', skillsDir: at('.workbuddy', 'skills'), mode: 'prompt', note: '有技能目录；OPC 侧走腾讯 SDK 提示词注入' },

  // ── 没有技能目录，但能注入提示词的 ─────────────────────────────────
  { agentId: 'kimicode', label: 'kimicode', skillsDir: null, mode: 'prompt', note: 'HTTP 类型（开放平台），无本地目录，只能提示词注入' },
  { agentId: 'doubao', label: 'doubao', skillsDir: null, mode: 'prompt', note: 'HTTP 类型，无本地目录，只能提示词注入' },

  // ── 什么都没有的 ────────────────────────────────────────────────────
  { agentId: 'kimicli', label: 'kimicli', skillsDir: null, mode: 'unsupported', note: '~/.kimi-code 存在但无 skills 子目录' },
  { agentId: 'hermes', label: 'hermes', skillsDir: null, mode: 'unsupported', note: '无技能目录，无挂载接口' },
  { agentId: 'pi', label: 'pi', skillsDir: null, mode: 'unsupported', note: '无技能目录，无挂载接口' },
  { agentId: 'antigravity', label: 'antigravity', skillsDir: null, mode: 'unsupported', note: '无技能目录，无挂载接口' },
];

export function targetOf(agentId: string): TargetSpec | undefined {
  return TARGETS.find(t => t.agentId === agentId);
}

/**
 * 这一条扩展「还有几个 Agent 真的能收到」。
 *
 * 口径 = 能力矩阵 × 本机实存目录，两条同时满足才算一个目标：
 *
 * 1. **通道**：技能看 `prompt`（提示词注入）与 `flag`（`--plugin-dir`）；
 *    MCP 只有 `flag`（`--mcp-config`，见 `definitions.ts` 的 `mcpArgsFor`）。
 *    `unsupported` 一律不算 —— 画在矩阵上只是如实承认没路。
 * 2. **本机实存**：`skillsDir` 必须真的在磁盘上。没有目录的 Agent（kimicode /
 *    doubao 这类 HTTP 型，或根本没装的）不参与分发，算进去就是承诺做不到的事。
 * 3. **差集**：该 Agent 自己目录/配置里已经有这一份的不算 —— 分发层本来就会跳过
 *    目标 Agent 自己的条目（见 `distribute.ts` 的差集注释），重复算会把「没东西可送」
 *    说成「有目标」。
 *
 * 返回 0 表示「无可分发目标」：开关置灰，而不是让用户点了没反应。
 *
 * ⚠️ **不看 `blocked`**：敏感正文不落库是「这条存不下」的另一种事实，
 * 由行内「敏感」标记与琥珀态告知；它仍然有通道、有目标，开关不该因此被锁死
 * （用户还要能把它关掉，让它在清单里彻底消失）。
 */
export function distributableTargetCount(opts: {
  kind: 'skill' | 'mcp';
  /** 这条扩展已经存在于哪些 Agent 自己的目录 / 配置里 */
  presentAgentIds: readonly string[];
}): number {
  const present = new Set(opts.presentAgentIds);
  let count = 0;
  for (const t of TARGETS) {
    /* 只有真的装了（目录存在）的 Agent 才可能收到。HTTP 型没有目录，
       它们的注入不写盘 —— 但也没有可靠的本机存在信号，按「不算目标」处理。 */
    if (!t.skillsDir || !fs.existsSync(t.skillsDir)) continue;
    if (present.has(t.agentId)) continue;
    if (opts.kind === 'mcp') {
      if (t.mode === 'flag') count++;
    } else if (t.mode === 'flag' || t.mode === 'prompt') {
      count++;
    }
  }
  return count;
}

/** 有技能目录的那些（扫描时只走这批） */
export function scannableTargets(): TargetSpec[] {
  return TARGETS.filter(t => t.skillsDir !== null);
}

/** 四态 → 界面文案。集中在这里，避免前端各处自己写一套。 */
export const MODE_LABEL: Record<MountMode, string> = {
  native: '原生',
  flag: '启动参数',
  prompt: '提示词',
  unsupported: '不支持',
};

/* ── 能力矩阵的六档状态（A164 / 方案 A）─────────────────────────── */

/**
 * 「这一份技能对某个 Agent 能不能用」的六档结论。
 *
 * 它不是 `MountMode` 的别名：mode 说的是**通道**，这里的 state 说的是
 * **这一份**在**这个 Agent** 上的结果。同一个 prompt 通道，
 * 正文没被拦是 `injected`，被拦了就是 `sealed`。
 */
export type MatrixState =
  | 'ready'
  | 'injected'
  | 'sealed'
  | 'planned'
  | 'local-only'
  | 'unsupported';

export interface MatrixStateMeta {
  state: MatrixState;
  label: string;
  /**
   * 组顺序的唯一来源：`rank` 越小越靠前。
   *
   * UI **不得**自己写一份状态顺序 —— 摘要、分组、图例全部按这里的 rank 排，
   * 否则加一档状态时必然有地方漏掉。
   */
  rank: number;
  /** 这份能不能被该 Agent 用上。摘要的「N 可用 / M 不可用」按它算 */
  available: boolean;
  /** 状态点取哪一类语义色；具体色值由前端令牌负责 */
  tone: 'ok' | 'warn' | 'brand' | 'muted';
  /** 悬停/说明浮层里的定义，必须说人话 */
  hint: string;
}

/**
 * 六档状态表，按 `rank` 升序排列。
 *
 * 梯度刻意是「可用程度」而不是字典序：
 *   已就位 → 会注入 → 含敏感内容 → 通道已确认 → 仅本机 → 不支持
 *
 * `sealed` 排在 `injected` 之后：它只会在正文被敏感内容拦截时出现，
 * 替代本该出现的 `injected`，因此放在同一段梯度里最不易误读。
 */
export const MATRIX_STATES: readonly MatrixStateMeta[] = [
  {
    state: 'ready',
    label: '已就位',
    rank: 0,
    available: true,
    tone: 'ok',
    hint: '该 Agent 自己的目录里就有这一份',
  },
  {
    state: 'injected',
    label: '会注入',
    rank: 1,
    available: true,
    tone: 'ok',
    hint: '该 Agent 目录里没有这一份，但发消息时会把技能清单与路径注入它的提示词（正文镜像在 OPC 自己的数据目录里，不动它的目录）',
  },
  {
    state: 'sealed',
    label: '含敏感内容',
    rank: 2,
    available: false,
    tone: 'warn',
    hint: '这份正文命中敏感内容、没有落库，所以不会注入给该 Agent；它自己目录里本来有的话仍可用',
  },
  {
    state: 'planned',
    label: '通道已确认',
    rank: 3,
    available: false,
    tone: 'brand',
    hint: '该 Agent 有启动参数类通道：OPC 启动它时会用 --plugin-dir 把这份技能挂上去（不写它的目录）',
  },
  {
    state: 'local-only',
    label: '仅本机',
    rank: 4,
    available: false,
    tone: 'muted',
    hint: '该 Agent 自己有，但它没有把外部技能送进来的通道，因此这份无法共享给它',
  },
  {
    state: 'unsupported',
    label: '不支持',
    rank: 5,
    available: false,
    tone: 'muted',
    hint: '该 Agent 没有接入外部技能的通道',
  },
];
