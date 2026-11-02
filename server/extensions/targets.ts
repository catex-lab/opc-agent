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
 * | `flag` | 需要我们传启动参数或调用它的官方命令才能挂上 | MCP 是（P2）；技能待 P5 |
 * | `prompt` | 我们拼系统提示注入（该适配器已有 `withMemoryContext`） | 是（P3，见 `inject.ts`） |
 * | `unsupported` | 既没有目录，也没有挂载接口 | — |
 */

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
  { agentId: 'qoder', label: 'qoder', skillsDir: at('.qoder', 'skills'), mode: 'flag', note: '支持 --config-dir / 官方 skills link（P2 接通）' },
  { agentId: 'qoder-cn', label: 'qoder-cn', skillsDir: at('.qoder-cn', 'skills'), mode: 'flag', note: '与 qoder 同构（P2 接通）' },
  { agentId: 'gemini', label: 'gemini', skillsDir: at('.gemini', 'skills'), mode: 'flag', note: '官方 skills link 可用（需你批准后再调用）' },
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
