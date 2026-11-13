/**
 * 定时派活调度器（A224）。
 *
 * ## 它解决什么问题
 *
 * 会话只能由人触发。「每天早九点让某个 Agent 巡检并在群里汇报」这类排班
 * 需求无处安放。调度器把「会话 + prompt + cron 表达式」变成一等公民：
 * 到点把 prompt **当作一条普通消息**投进对应会话，产出按既有消息回流。
 *
 * ## 实现路线：自取回（self-fetch），不复制聊天路由
 *
 * 到点后调度器对本机服务器发起一次真实的 `/api/chat`（或 `/api/group-chat`）
 * 请求并排空 SSE 流。为什么不抽出「纯后台执行」的新路径：聊天路由里叠着
 * 会话落库、续接对账、悬空确认、权限桥、断线宽限、知识库注入、技能沉淀——
 * 复制一份必然漂移（这个项目已经为此交过学费，见 turn-runner.ts 顶部）。
 * 自取回让定时任务与手发消息**走完全同一条链**：权限门照卡、落库照写、
 * 续接照续。代价只是本机一次回环请求，可忽略。
 *
 * ## 边界（写死）
 *
 * - **仅应用运行时调度**：进程退出即停，没有常驻服务。错过窗口不补跑
 *   （启动时统一记 `missed`）——本机应用补跑一整夜的积压是灾难。
 * - 同一任务**不重叠**：上一轮没跑完，本轮跳过并记 `skipped`。
 * - 每轮有总预算（30 分钟）：到点还没完就断开 SSE（断开 → 既有宽限 → 中止）。
 * - 群聊定时任务在创建时**快照成员与编排**：之后群里加减人，定时任务
 *   按快照跑——排班的是「这批人」，不是「这个群的当前名单」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirPath } from './paths.js';
import { cronIntervalWarning, cronNextRun, parseCron } from './cron.js';

export interface ScheduleTask {
  id: string;
  /** 目标会话（direct = 单聊，group = 群聊） */
  sessionId: string;
  sessionKind: 'direct' | 'group';
  /** direct：投递给哪个 Agent。缺省用会话当前绑定的 */
  agentId?: string;
  /** group：创建时的成员快照与编排模式 */
  agentIds?: string[];
  orchestration?: string;
  /** 到点投递的指令 */
  prompt: string;
  /** 5 段 cron（本地时区） */
  cron: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  /** ok = 流正常结束（不代表 Agent 没报错，那是会话里的事实）；error / skipped / missed */
  lastStatus?: 'ok' | 'error' | 'skipped' | 'missed';
  lastError?: string;
  /** 下次触发（epoch ms）。调度与 UI 共用这一份，避免两边各算一遍 */
  nextRunAt?: number;
}

const STORE_PATH = path.join(dataDirPath, 'schedules.json');

/** prompt 上限：这不是聊天输入，是排班指令，够写清一件事即可 */
const MAX_PROMPT_LEN = 4000;
/** 每个会话最多挂多少条定时任务：防脚本式灌入 */
const MAX_TASKS_PER_SESSION = 10;

function readStore(): ScheduleTask[] {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t: unknown): t is ScheduleTask =>
        !!t && typeof t === 'object' &&
        typeof (t as ScheduleTask).id === 'string' &&
        typeof (t as ScheduleTask).sessionId === 'string' &&
        typeof (t as ScheduleTask).prompt === 'string' &&
        typeof (t as ScheduleTask).cron === 'string'
    );
  } catch {
    console.error('[Scheduler] schedules.json 解析失败，按「没有定时任务」处理');
    return [];
  }
}

function writeStore(list: ScheduleTask[]): void {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

export function listSchedules(sessionId?: string): ScheduleTask[] {
  const all = readStore();
  return sessionId ? all.filter(t => t.sessionId === sessionId) : all;
}

export interface CreateScheduleInput {
  sessionId: string;
  prompt: string;
  cron: string;
  enabled?: boolean;
  agentId?: string;
}

export function createSchedule(
  input: CreateScheduleInput,
  session: { kind?: string | null; agent_id?: string | null; agent_ids?: string | null; orchestration?: string | null }
): ScheduleTask | { error: string } {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) return { error: '请填写到点要执行的指令' };
  if (prompt.length > MAX_PROMPT_LEN) return { error: `指令不能超过 ${MAX_PROMPT_LEN} 字` };
  // 高频拦截放在**模块层**而不是路由层：调度器未来可能有第二个入口
  // （工作流脚本、导入），漏一处就是放血入口
  const freqError = cronIntervalWarning(input.cron ?? '');
  if (freqError) return { error: freqError };
  const parsed = parseCron(input.cron ?? '');
  if (!parsed.ok) return { error: parsed.error };
  const next = cronNextRun(input.cron);
  if (!next) return { error: '这条表达式不会再触发（检查日期/星期组合）' };

  const all = readStore();
  if (all.filter(t => t.sessionId === input.sessionId).length >= MAX_TASKS_PER_SESSION) {
    return { error: `一个会话最多挂 ${MAX_TASKS_PER_SESSION} 条定时任务` };
  }

  const kind = session.kind === 'group' ? 'group' : 'direct';
  let agentIds: string[] | undefined;
  let orchestration: string | undefined;
  if (kind === 'group') {
    try {
      agentIds = session.agent_ids ? (JSON.parse(session.agent_ids) as string[]) : undefined;
    } catch {
      agentIds = undefined;
    }
    orchestration = session.orchestration || 'dispatch';
    if (!agentIds || agentIds.length === 0) return { error: '群聊没有成员快照，无法排班' };
  }

  const task: ScheduleTask = {
    id: `sched-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    sessionId: input.sessionId,
    sessionKind: kind,
    ...(kind === 'direct'
      ? { agentId: input.agentId || session.agent_id || undefined }
      : { agentIds, orchestration }),
    prompt,
    cron: input.cron.trim().replace(/\s+/g, ' '),
    enabled: input.enabled !== false,
    createdAt: Date.now(),
    nextRunAt: next.getTime(),
  };
  all.push(task);
  writeStore(all);
  return task;
}

export function updateSchedule(
  id: string,
  patch: { prompt?: string; cron?: string; enabled?: boolean }
): ScheduleTask | null {
  const all = readStore();
  const i = all.findIndex(t => t.id === id);
  if (i < 0) return null;
  const next = { ...all[i] };
  if (patch.prompt !== undefined) {
    const prompt = String(patch.prompt).trim();
    if (!prompt) return null;
    next.prompt = prompt;
  }
  if (patch.cron !== undefined) {
    const parsed = parseCron(patch.cron);
    if (!parsed.ok) return null;
    next.cron = patch.cron.trim().replace(/\s+/g, ' ');
    const following = cronNextRun(next.cron);
    next.nextRunAt = following ? following.getTime() : undefined;
  }
  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled === true;
    if (next.enabled) {
      const following = cronNextRun(next.cron);
      next.nextRunAt = following ? following.getTime() : undefined;
    }
  }
  all[i] = next;
  writeStore(all);
  return next;
}

export function deleteSchedule(id: string): boolean {
  const all = readStore();
  const next = all.filter(t => t.id !== id);
  if (next.length === all.length) return false;
  writeStore(next);
  return true;
}

// ════════ 运行时 ════════

/** 正在跑的任务 id：防同一任务重叠（30 分钟预算内下一棒直接跳过） */
const running = new Set<string>();
/** 单轮总预算。到点断流 → 既有 20s 宽限 → 中止链（与手发消息同一套善后） */
const RUN_BUDGET_MS = 30 * 60 * 1000;
/** 轮询间隔：分钟级任务 20s 足够，也保证「错过窗口」判定足够紧 */
const TICK_MS = 20_000;

let timer: NodeJS.Timeout | null = null;

interface SchedulerDeps {
  /** 本机服务端口（listen 回调里的 actualPort） */
  port: number;
  host?: string;
}

/**
 * 启动调度循环。启动时先做一次「错过窗口」对账：
 * 应用没跑的那段时间里到期的任务 → 记 `missed`、不补跑、重算 nextRunAt。
 */
export function startScheduler(deps: SchedulerDeps): void {
  const tasks = readStore();
  const now = Date.now();
  let dirty = false;
  for (const t of tasks) {
    if (!t.enabled) continue;
    if (t.nextRunAt && t.nextRunAt < now - TICK_MS) {
      t.lastStatus = 'missed';
      t.lastError = '应用当时没有运行，本轮已跳过（不补跑）';
      const following = cronNextRun(t.cron);
      t.nextRunAt = following ? following.getTime() : undefined;
      dirty = true;
    }
  }
  if (dirty) writeStore(tasks);

  if (timer) clearInterval(timer);
  timer = setInterval(() => tick(deps), TICK_MS);
  timer.unref?.();
  console.log(`[Scheduler] 已启动（${tasks.filter(t => t.enabled).length} 条启用中，预算 ${RUN_BUDGET_MS / 60000} 分钟/轮）`);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function tick(deps: SchedulerDeps): void {
  const now = Date.now();
  const tasks = readStore();
  for (const task of tasks) {
    if (!task.enabled) continue;
    if (!task.nextRunAt || task.nextRunAt > now) continue;
    if (running.has(task.id)) {
      // 上一轮还没跑完：本轮跳过（不重算 nextRunAt——下一棒按表走）
      task.lastStatus = 'skipped';
      task.lastError = '上一轮还在执行，本轮跳过';
      writeStore(tasks);
      continue;
    }
    fire(deps, task);
  }
}

function fire(deps: SchedulerDeps, task: ScheduleTask): void {
  // 先推进 nextRunAt 再跑：跑到一半崩溃也不至于原地死循环
  const all = readStore();
  const i = all.findIndex(t => t.id === task.id);
  if (i < 0) return;
  const following = cronNextRun(task.cron);
  all[i].nextRunAt = following ? following.getTime() : undefined;
  writeStore(all);

  running.add(task.id);
  const started = Date.now();
  console.log(`[Scheduler] 触发 ${task.id}（${task.sessionKind} → ${task.sessionId}）`);
  runScheduledTurn(deps, task)
    .then(ok => {
      const list = readStore();
      const j = list.findIndex(t => t.id === task.id);
      if (j >= 0) {
        list[j].lastRunAt = started;
        list[j].lastStatus = ok ? 'ok' : 'error';
        if (!ok) list[j].lastError = '执行未正常结束（超时或连接中断），详情看会话记录';
      }
      writeStore(list);
    })
    .catch((err: unknown) => {
      const list = readStore();
      const j = list.findIndex(t => t.id === task.id);
      if (j >= 0) {
        list[j].lastRunAt = started;
        list[j].lastStatus = 'error';
        list[j].lastError = (err as Error)?.message || '执行失败';
      }
      writeStore(list);
    })
    .finally(() => running.delete(task.id));
}

/** 排空 SSE 流并遵守总预算。返回 true = 流正常走到 done */
async function runScheduledTurn(deps: SchedulerDeps, task: ScheduleTask): Promise<boolean> {
  const host = deps.host || '127.0.0.1';
  const base = `http://${host}:${deps.port}`;
  const ac = new AbortController();
  const budget = setTimeout(() => ac.abort(), RUN_BUDGET_MS);
  budget.unref?.();

  try {
    const url = task.sessionKind === 'group' ? `${base}/api/group-chat` : `${base}/api/chat`;
    const body =
      task.sessionKind === 'group'
        ? {
            sessionId: task.sessionId,
            message: task.prompt,
            agentIds: task.agentIds ?? [],
            orchestration: task.orchestration || 'dispatch',
          }
        : {
            sessionId: task.sessionId,
            message: task.prompt,
            ...(task.agentId ? { agentId: task.agentId } : {}),
          };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      console.error(`[Scheduler] ${task.id} 请求失败: ${res.status} ${detail.slice(0, 200)}`);
      return false;
    }
    // 排空流。完成判定按路径区分结束帧：
    //   direct：/api/chat 是 v2 块协议，最后一帧 run_end（落在库之后）；
    //   group ：/api/group-chat 最后发 done 帧——**不能**认 run_end，
    //           群里第一个成员跑完就会发 run_end，提前收读会掐断断线宽限、
    //           连带中止还没跑完的成员（实测踩过：单聊只认 done 会全程误报失败）。
    const endFrame = task.sessionKind === 'group' ? '"type":"done"' : '"type":"run_end"';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawDone = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(endFrame)) {
        sawDone = true;
        break;
      }
      if (buf.length > 4 * 1024 * 1024) break; // 兜底：异常情况下不无限吞
    }
    try {
      await reader.cancel();
    } catch {
      /* 已结束 */
    }
    return sawDone;
  } finally {
    clearTimeout(budget);
  }
}

/** 汇总给 UI 的运行态（是否在跑）。列表接口顺手带上 */
export function scheduleRuntimeOf(task: ScheduleTask): { running: boolean } {
  return { running: running.has(task.id) };
}
