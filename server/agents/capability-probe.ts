/**
 * 真实标定（P3）—— 跑一条极短的 CLI 任务，数它**实际**给出了哪些过程事件。
 *
 * ## 为什么必须真跑
 *
 * P2 把能力档拆成 declared / observed 两档，但 observed 只覆盖「这一轮碰巧用了
 * 什么」：用户问一句「你好」，投影器照样得到 `observed: []` —— 这不能说明
 * 它不会思考。要回答「这个 (引擎 · 模型 · 网关) 到底会不会给思考」，只有一条路：
 * 用一条**注定需要推理**的任务去跑它，看它回来什么。
 *
 * ## 与观测的三条边界
 *
 * 1. **只跑一次、只跑短任务**：标定不是压测。任务里明确要求不写代码、不调工具，
 *    既避免改用户文件，也把花费压在一条短回答的量级。
 * 2. **失败不写缓存**：网络断、没登录、超时 —— 这些都没有回答「它会不会思考」。
 *    写进缓存等于把环境故障记成能力缺失，正是这张表要防的事。
 * 3. **成功但零能力要写**：「跑通了，一条过程事件都没给」是结论；
 *    和「从没标定过」必须能分开。所以这里不把空数组当成失败。
 */

import type {
  CapabilityKey,
  CapabilityProbe,
  EventCapability,
} from '../../shared/capabilities.js';
import { CAPABILITY_PROBE_TTL_MS, sortCapabilities } from '../../shared/capabilities.js';
import { loadCapabilityProbe, saveCapabilityProbe } from '../db.js';
import type { LaunchTarget } from './probe.js';
import {
  expandPath,
  findExecutable,
  isIdeLauncher,
  isUnresolvedShim,
  resolveAnyLaunchTarget,
  runCapture,
  type ExecResult,
} from './probe.js';
import { capabilityKeyOf } from './capability.js';
import { findDef } from './definitions.js';
import { childEnv } from './adapters/cli.js';
import type { AgentEvent } from './types.js';

/**
 * 标定任务。
 *
 * 选「为什么」而不是算术题：算术题对小模型来说可能一眼出答案、根本不思考；
 * 而「解释一个结论」几乎一定会产生推理过程。末尾两句是安全边界 ——
 * 标定不应该改用户仓库，也不应该花工具调用的钱。
 */
export const CAPABILITY_PROBE_PROMPT =
  '不要写代码、不要调用任何工具。请先在心里认真推演，然后用一句话回答：任意三个连续整数之和为什么一定能被 3 整除？';

const DEFAULT_TIMEOUT_MS = 180_000;

export type ProbeSpawn = (
  target: LaunchTarget,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; env: NodeJS.ProcessEnv }
) => Promise<ExecResult>;

export interface ProbeOptions {
  /** 跳过 TTL 缓存，强制重跑 */
  force?: boolean;
  now?: () => number;
  timeoutMs?: number;
  cwd?: string;
  /** 测试注入：直接给启动目标，跳过 PATH 查找与垫片解析 */
  target?: LaunchTarget;
  /** 测试注入：替代 runCapture */
  spawn?: ProbeSpawn;
  loadProbe?: (key: CapabilityKey) => CapabilityProbe | undefined;
  saveProbe?: (key: CapabilityKey, probe: CapabilityProbe) => void;
}

export interface ProbeOutcome {
  ok: boolean;
  /** 本次是否直接用了缓存 */
  cached?: boolean;
  /** 标定结论（缓存命中时也返回） */
  probe?: CapabilityProbe;
  key?: CapabilityKey;
  /** 便于排障：实际 argv（prompt 本身不敏感，但也不回传，避免刷屏） */
  argv?: string[];
  error?: string;
}

/**
 * 从归一化事件数出能力。
 *
 * 纯函数，与投影器的 observed 判定保持同一套口径（P2）：思考按 format 分两档、
 * 用量与费用分开、工具结果与增量输出都算 tool_output —— 两处口径不一致的话，
 * 同一个模型会出现「标定说有、实跑观测没有」的假矛盾。
 */
export function capabilitiesFromEvents(events: Iterable<AgentEvent>): EventCapability[] {
  const set = new Set<EventCapability>();
  for (const ev of events) {
    switch (ev.type) {
      case 'thinking':
        set.add(ev.format === 'summary' ? 'thinking_summary' : 'thinking');
        break;
      case 'tool':
        set.add('tool');
        break;
      case 'tool_output':
      case 'tool_result':
        set.add('tool_output');
        break;
      case 'permission_request':
        set.add('permission');
        break;
      case 'usage':
      case 'done':
        if (ev.tokens != null) set.add('usage');
        if (ev.cost != null) set.add('cost');
        break;
    }
  }
  return sortCapabilities(set);
}

/** 逐行解析 NDJSON，交给该 Agent 的映射器归一化；返回事件与被识别的行数 */
export function eventsFromOutput(
  stdout: string,
  mapLine: (obj: unknown) => AgentEvent | AgentEvent[] | null
): { events: AgentEvent[]; parsedLines: number } {
  const events: AgentEvent[] = [];
  let parsedLines = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      continue; // 非 JSON 行（横幅、日志）不参与标定
    }
    parsedLines++;
    const mapped = mapLine(obj);
    if (!mapped) continue;
    if (Array.isArray(mapped)) events.push(...mapped);
    else events.push(mapped);
  }
  return { events, parsedLines };
}

/** 整体解析一个 JSON 对象（`parse: 'json-object'` 的 CLI，如 ZCode） */
export function eventsFromJsonObject(
  stdout: string,
  mapLine: (obj: unknown) => AgentEvent | AgentEvent[] | null
): { events: AgentEvent[]; parsedLines: number } {
  const text = stdout.trim();
  if (!text) return { events: [], parsedLines: 0 };
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { events: [], parsedLines: 0 };
  }
  const mapped = mapLine(obj);
  if (!mapped) return { events: [], parsedLines: 1 };
  return { events: Array.isArray(mapped) ? mapped : [mapped], parsedLines: 1 };
}

/** 从 PATH / extraPaths 找可执行文件（与 CliAdapter 的常规查找一致） */
function locateBin(agentId: string): { bin?: string; error?: string } {
  const def = findDef(agentId);
  if (!def?.cli) return { error: `${agentId} 不是 CLI 接入，无法用 CLI 标定` };
  const dirs = (def.extraPaths ?? []).map(expandPath);
  const bin = findExecutable(def.cli.bin, dirs, def.cli.binExts ?? []);
  if (!bin) {
    const label = Array.isArray(def.cli.bin) ? def.cli.bin.join(' / ') : def.cli.bin;
    return { error: `PATH 中未找到 \`${label}\`。${def.descriptor.installHint ?? ''}`.trim() };
  }
  return { bin };
}

/**
 * 标定一个 (引擎 · 模型 · 网关)。
 *
 * 缓存按三元组精确命中：换了模型或换了网关，旧的标定结果**不能**复用 ——
 * 那正是 P2 把能力拆成三元组的理由。
 */
export async function probeCapabilities(
  agentId: string,
  model: string | undefined,
  options: ProbeOptions = {}
): Promise<ProbeOutcome> {
  const def = findDef(agentId);
  if (!def) return { ok: false, error: `未知 Agent: ${agentId}` };
  if (!def.cli) return { ok: false, error: `${def.descriptor.name} 不是 CLI 接入，无法用 CLI 标定` };
  if (def.cli.parse !== 'jsonl' && def.cli.parse !== 'json-object') {
    return {
      ok: false,
      error: `${def.descriptor.name} 走纯文本解析，事件流里没有可标定的过程事件`,
    };
  }

  const now = options.now ?? Date.now;
  const loadProbe = options.loadProbe ?? loadCapabilityProbe;
  const saveProbe = options.saveProbe ?? saveCapabilityProbe;
  const key = capabilityKeyOf(agentId, model);

  if (!options.force) {
    const cached = loadProbe(key);
    if (cached && now() - cached.at >= 0 && now() - cached.at < CAPABILITY_PROBE_TTL_MS) {
      return { ok: true, cached: true, probe: cached, key };
    }
  }

  let target = options.target;
  if (!target) {
    const { bin, error } = locateBin(agentId);
    if (!bin) return { ok: false, key, error };
    target = resolveAnyLaunchTarget(bin);
    if (isUnresolvedShim(target, bin)) {
      return { ok: false, key, error: '无法解析该命令的启动垫片，已跳过（不退回 shell 执行）' };
    }
    if (target.problem) return { ok: false, key, error: target.problem };
    if (isIdeLauncher(target)) {
      return { ok: false, key, error: '找到的是 IDE 命令行入口，不是 agent CLI' };
    }
  }

  const argv = def.cli.buildArgs(CAPABILITY_PROBE_PROMPT, {
    sessionId: 'capability-probe',
    prompt: CAPABILITY_PROBE_PROMPT,
    model,
    // 只读：标定任务明确不调工具，但万一模型不听，沙箱要能兜住写入
    permissionMode: 'plan',
  });

  const spawn = options.spawn ?? runCapture;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await spawn(target, argv, {
    timeoutMs,
    cwd: options.cwd,
    env: childEnv(),
  });

  if (res.timedOut) {
    return { ok: false, key, argv, error: `标定超时（${timeoutMs}ms），未写入缓存` };
  }
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim().slice(-300);
    return {
      ok: false,
      key,
      argv,
      error: `CLI 退出码 ${res.code ?? 'null'}${detail ? `：${detail}` : ''}`,
    };
  }

  const mapLine = def.cli.createMapper?.() ?? def.cli.mapLine;
  if (!mapLine) return { ok: false, key, argv, error: '该 Agent 没有事件映射器，无法标定' };

  const { events, parsedLines } =
    def.cli.parse === 'json-object'
      ? eventsFromJsonObject(res.stdout, mapLine)
      : eventsFromOutput(res.stdout, mapLine);
  const errorEvent = events.find(e => e.type === 'error');
  if (errorEvent && errorEvent.type === 'error') {
    return { ok: false, key, argv, error: `CLI 报告错误：${errorEvent.message}` };
  }
  if (parsedLines === 0) {
    return {
      ok: false,
      key,
      argv,
      error: '退出码为 0，但没有解析到任何结构化事件（该 CLI 可能未按预期输出 JSON）',
    };
  }

  const probe: CapabilityProbe = {
    capabilities: capabilitiesFromEvents(events),
    at: now(),
  };
  saveProbe(key, probe);
  return { ok: true, cached: false, probe, key, argv };
}
