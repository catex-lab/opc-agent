/**
 * 黄金样本回放的共享库（P3，接入架构收敛方案）。
 *
 * ## 它解决什么问题
 *
 * 「修好这个另一个坏」的结构化解法：把每家 CLI 的**真实原始输出**录成样本，
 * CI 里用**当前解析代码**重放，事件序列必须与录制时的期望一致——CLI 升级
 * 破坏解析 → CI 红灯先于用户。
 *
 * ## 为什么纯函数就够
 *
 * 13 条 CLI 全部是 `jsonl` / `json-object`（A163 收编了最后的 text）——解析
 * 入口就是定义表里的 `createMapper / mapLine / extractResumeToken`，喂原始
 * JSON 行即可，**不需要真的起进程**。argv/flags 的漂移不在此网内（那是
 * canary 的活：真实调用失败会以诊断分类浮出）。
 *
 * ## 样本格式（fixtures/golden/<agentId>-<version>.jsonl，JSONL）
 *
 *   第 1 行  {"golden":1,"agent":…,"cliVersion":…,"recordedAt":…,"prompt":…,"parse":"jsonl"}
 *   中间 N 行 {"dir":"stdout"|"stderr","line":"…"}  ← 原始输出，逐行保真
 *   最后一行 {"expect":{"eventTypes":[…],"resumeToken":bool,"stderrLines":n}}
 *
 * 期望由**录制当时**的解析代码产出；回放时用当前代码重放并与期望比对。
 */

import type { AgentDefinition } from '../server/agents/definitions.js';
import type { AgentEvent } from '../server/agents/types.js';

export interface GoldenLine {
  dir: 'stdout' | 'stderr';
  line: string;
}

export interface GoldenExpectation {
  eventTypes: string[];
  resumeToken: boolean;
  stderrLines: number;
}

export interface GoldenFixture {
  golden: 1;
  agent: string;
  cliVersion: string;
  recordedAt: string;
  prompt: string;
  parse: 'jsonl' | 'json-object';
}

/**
 * 把原始输出行喂给定义表的解析层，产出事件类型序列与续接令牌出现与否。
 * 纯函数：不起进程、不碰盘——CI 与录制工具共用这一份回放口径。
 */
export function feedLines(
  def: Pick<AgentDefinition, 'cli'>,
  lines: GoldenLine[]
): { eventTypes: string[]; resumeToken: boolean; stderrLines: number } | null {
  const cli = def.cli;
  if (!cli) return null;
  if (cli.parse !== 'jsonl' && cli.parse !== 'json-object') return null; // text 通道无可回放的解析

  const stateful = cli.createMapper?.() ?? null;
  const map = (obj: unknown): AgentEvent | AgentEvent[] | null =>
    stateful ? stateful(obj) : (cli.mapLine ? cli.mapLine(obj) : null);

  const eventTypes: string[] = [];
  let resumeToken = false;
  let stderrLines = 0;

  if (cli.parse === 'json-object') {
    // 整段 stdout 是一个 JSON 对象：攒齐后整体喂（zcode 形态）
    const buf = lines
      .filter(l => l.dir === 'stdout')
      .map(l => l.line)
      .join('\n');
    stderrLines = lines.filter(l => l.dir === 'stderr' && l.line.trim()).length;
    let obj: unknown;
    try {
      obj = JSON.parse(buf);
    } catch {
      return { eventTypes: [], resumeToken, stderrLines };
    }
    const token = cli.extractResumeToken?.(obj);
    if (token) resumeToken = true;
    const mapped = map(obj);
    if (mapped) {
      for (const ev of Array.isArray(mapped) ? mapped : [mapped]) eventTypes.push(ev.type);
    }
    return { eventTypes, resumeToken, stderrLines };
  }

  for (const l of lines) {
    if (l.dir === 'stderr') {
      if (l.line.trim()) stderrLines += 1;
      continue;
    }
    const trimmed = l.line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 与适配器同口径：不是 JSON 的行按纯文本走，这里无文本通道可模拟
    }
    const token = cli.extractResumeToken?.(obj);
    if (token) resumeToken = true;
    const mapped = map(obj);
    if (!mapped) continue;
    for (const ev of Array.isArray(mapped) ? mapped : [mapped]) eventTypes.push(ev.type);
  }
  return { eventTypes, resumeToken, stderrLines };
}
