/**
 * 动态工作流（A41）—— 「主 agent 写脚本编排子 agent」的最小实现。
 *
 * ## 为什么需要这一层
 *
 * 固定五种编排模式（dispatch / broadcast / relay / debate / mention）覆盖不了
 * 「先派 A 查，再让 B 和 C 并行改，最后 D 汇总」这类真实流程。做法是
 * **让主 agent 写一段 TypeScript，类型检查后在沙箱里跑**，原语是一等公民：
 * 组合方式不再受我们预设的模式集合限制。
 *
 * 这里做同一件事，但把边界说清楚：
 *
 * 1. **`node:vm` 不是安全边界**。它挡住的是误操作（脚本里顺手写了 `process.exit()`
 *    摸不到 `process`），挡不住铁了心的逃逸。威胁模型是「本机用户自己写的脚本」，
 *    不是「不可信第三方上传的代码」—— 后者需要单独的无网络 worker 进程，
 *    本项目里没有，也不假装有。
 * 2. **两种死循环都有对应手段**：纯计算的 `while(true){}` 由 `vm` 的 timeout
 *    直接杀；异步空转（`while(1) await tick()`）杀不掉，但每个原语自身都会和
 *    总截止时间赛跑，一旦超时就抛错，循环最多再转一圈。
 * 3. **只暴露白名单原语**：`require` 存在但只为抛出一句人话。
 *
 * ## 脚本形态
 *
 * 只支持函数式入口（ZCode 也是）：
 *
 * ```ts
 * export default async function run(ctx) {
 *   const a = await ctx.assign('opencode', '把登录页的表单校验补上');
 *   const both = await Promise.all([
 *     ctx.assign('codex', '按上面的结论写单测'),
 *     ctx.assign('gemini', '写迁移文档'),
 *   ]);
 *   ctx.log('完成', a.text.length);
 *   return { ok: true };
 * }
 * ```
 */

import ts from 'typescript';
import vm from 'node:vm';
import { runOrchestration, type TurnPhase } from './orchestrator.js';

/** 一个原语调用的记录（用于回放与测试断言） */
export interface WorkflowStep {
  name: string;
  /** 入参摘要（截断过，不落全量） */
  args: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface WorkflowAgentResult {
  agentId: string;
  text: string;
  error?: string;
}

/** 脚本可用的原语集合 */
export interface WorkflowContext {
  /** 指定某个 Agent 执行，返回其正文 */
  assign(agentId: string, task: string): Promise<WorkflowAgentResult>;
  /** 全员并行作答 */
  broadcast(task: string): Promise<WorkflowAgentResult[]>;
  /** 依次传递：上一个的输出作为下一个的输入（简化版，固定按成员顺序） */
  relay(task: string): Promise<WorkflowAgentResult[]>;
  /** 辩论：正反各 DEBATE_ROUNDS 轮后收敛（复用编排层实现） */
  debate(topic: string): Promise<WorkflowAgentResult>;
  /** 可用成员 id 列表 */
  members(): string[];
  /** 检索长期记忆（A38） */
  memorySearch(query: string, limit?: number): Array<{ key: string; title: string; snippet: string }>;
  /** 打一行日志（会带回给调用方，也会写进工作流记录） */
  log(...args: unknown[]): void;
  /** 给用户看的一条过程说明（前端以系统提示样式渲染） */
  note(text: string): void;
}

export interface WorkflowDeps {
  /** 借用群聊那套「一棒发言」（server/turn-runner.ts） */
  runAgent(
    agentId: string,
    prompt: string,
    phase: TurnPhase,
    round?: number
  ): Promise<{ text: string; error?: string }>;
  /** 可用成员 */
  members: readonly string[];
  /** 记忆检索。缺省时 ctx.memorySearch 返回空数组（不假装有） */
  memorySearch?: (query: string, limit?: number) => Array<{ key: string; title: string; snippet: string }>;
  /** 过程说明出口（group_note） */
  note?: (text: string) => void;
}

export interface WorkflowOutcome {
  ok: boolean;
  /** 脚本 return 的值（结构化克隆失败的会降级为字符串） */
  output?: unknown;
  logs: string[];
  steps: WorkflowStep[];
  error?: string;
  durationMs: number;
  /** 命中超时（脚本可能还在后台跑，见文件头第 2 条） */
  timedOut: boolean;
}

/** 默认总超时。给足多 agent 串行的时间，又不让前端干等 */
export const WORKFLOW_TIMEOUT_MS = 5 * 60 * 1000;

/** 单个原语调用的超时：比总超时短，保证循环里能及时炸掉 */
const STEP_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * 原语截止时间比总 deadline 提前的余量（见 `withDeadline` 里的说明）。
 *
 * 没有它，「卡在原语里」会由看门狗先报出来，错误信息丢掉「是哪个原语」。
 */
const STEP_DEADLINE_MARGIN_MS = 200;

/** 编译：TypeScript → CommonJS。语法错误带行列号原样返回。 */
export function compileWorkflow(source: string): { code: string } | { error: string } {
  if (!source || !source.trim()) return { error: '工作流脚本为空' };
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
    fileName: 'workflow.ts',
  });
  const diags = (out.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (diags.length > 0) {
    const first = diags[0];
    const { line, character } = first.file
      ? first.file.getLineAndCharacterOfPosition(first.start ?? 0)
      : { line: 0, character: 0 };
    const msg = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    return { error: `第 ${line + 1} 行第 ${character + 1} 列：${msg}` };
  }
  return { code: out.outputText };
}

function summarize(value: unknown, max = 120): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    s = '[unserializable]';
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 沙箱里能摸到的全局。刻意没有 process / require / Buffer / global。 */
const SAFE_GLOBALS = ['console', 'JSON', 'Math', 'Date', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set', 'Error', 'TypeError', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent'];

export async function runWorkflow(
  source: string,
  deps: WorkflowDeps,
  opts: { timeoutMs?: number } = {}
): Promise<WorkflowOutcome> {
  const started = Date.now();
  const logs: string[] = [];
  const steps: WorkflowStep[] = [];
  const deadline = started + (opts.timeoutMs ?? WORKFLOW_TIMEOUT_MS);

  const compiled = compileWorkflow(source);
  if ('error' in compiled) {
    return { ok: false, logs, steps, error: `编译失败：${compiled.error}`, durationMs: 0, timedOut: false };
  }

  // ---- 原语（每个都记 step、都和截止时间赛跑）----
  const withDeadline = async <T,>(fn: () => Promise<T>, step: Omit<WorkflowStep, 'durationMs' | 'ok' | 'error'>): Promise<T> => {
    const t0 = Date.now();
    const remaining = deadline - Date.now();
    /**
     * 原语的截止时间要比总 deadline **早一点**。
     *
     * 为什么必须留余量：两者相等时谁先 fire 取决于定时器注册顺序，
     * 实测是看门狗先响 —— 于是「卡在某个原语里」报出来的是
     * 「工作流超过 2000ms 未结束」，用户完全看不出是哪个原语卡住了，
     * 而这条信息正是排查卡死的唯一线索。
     *
     * 200ms 足够跑完 `catch` 里的记账（把 step 标成失败），又短到不会
     * 让人等出差别。
     */
    const left = Math.max(
      1,
      Math.min(STEP_TIMEOUT_MS, remaining - STEP_DEADLINE_MARGIN_MS)
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`原语 ${step.name} 超过 ${left}ms 未返回`)), left);
        }),
      ]);
      steps.push({ ...step, ok: true, durationMs: Date.now() - t0 });
      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      steps.push({ ...step, ok: false, durationMs: Date.now() - t0, error: msg });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const ctx: WorkflowContext = {
    assign: (agentId, task) =>
      withDeadline(
        async () => {
          if (!deps.members.includes(agentId)) {
            throw new Error(`成员 ${agentId} 不在本会话可用名单里（可用：${deps.members.join(', ') || '无'}）`);
          }
          const r = await deps.runAgent(agentId, task, 'work');
          return { agentId, text: r.text ?? '', error: r.error };
        },
        { name: 'assign', args: `${agentId}: ${summarize(task)}` }
      ),

    broadcast: task =>
      withDeadline(
        async () =>
          Promise.all(
            deps.members.map(async id => {
              const r = await deps.runAgent(id, task, 'broadcast');
              return { agentId: id, text: r.text ?? '', error: r.error };
            })
          ),
        { name: 'broadcast', args: summarize(task) }
      ),

    relay: task =>
      withDeadline(
        async () => {
          const out: WorkflowAgentResult[] = [];
          let carry = task;
          for (const id of deps.members) {
            const r = await deps.runAgent(id, carry, 'relay', out.length + 1);
            const item = { agentId: id, text: r.text ?? '', error: r.error };
            out.push(item);
            // 下一棒的输入：上一棒的正文（为空就沿用原任务，别把空串传下去）
            carry = r.text?.trim() ? `${task}\n\n上一棒（${id}）的结论：\n${r.text}` : task;
          }
          return out;
        },
        { name: 'relay', args: summarize(task) }
      ),

    debate: topic =>
      withDeadline(
        async () => {
          // 直接复用编排层的辩论（和群里点「辩论」同一条路），
          // 用包装过的 runAgent 把最后一棒（converge）的正文收回来。
          // 少于 2 位成员时编排层会自行退化为单独作答并 note 出来。
          let lastText = '';
          const wrapped = async (
            agentId: string,
            prompt: string,
            phase: TurnPhase,
            round?: number
          ) => {
            const r = await deps.runAgent(agentId, prompt, phase, round);
            if (r.text) lastText = r.text;
            return r;
          };
          await runOrchestration(
            { mode: 'debate', members: [...deps.members], prompt: topic },
            {
              runAgent: wrapped,
              note: t => ctx.note(t),
              displayName: id => id,
              isUsable: () => true,
            }
          );
          return { agentId: 'debate', text: lastText, error: undefined };
        },
        { name: 'debate', args: summarize(topic) }
      ),

    members: () => [...deps.members],

    memorySearch: (query, limit = 10) => {
      if (!deps.memorySearch) return [];
      return deps.memorySearch(query, limit);
    },

    log: (...args) => {
      // 一律过 summarize：脚本很可能 `log(某个 agent 的全文)`，
      // 不截断等于把几百 KB 的正文塞进内存里的日志数组
      const line = args.map(a => summarize(a, 300)).join(' ');
      logs.push(line);
    },

    note: text => deps.note?.(String(text)),
  };

  // ---- 沙箱 ----
  const moduleObj = { exports: {} as Record<string, unknown> };
  const sandbox: Record<string, unknown> = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: (name: string) => {
      throw new Error(`工作流脚本不能用 require("${name}")：可用能力都在 ctx 上（assign / broadcast / relay / debate / members / memorySearch / log / note）`);
    },
    console: { log: (...a: unknown[]) => ctx.log(...a), warn: (...a: unknown[]) => ctx.log(...a), error: (...a: unknown[]) => ctx.log(...a) },
    setTimeout: undefined, // 显式置空：宁可没有也不给一个能摸到真实事件循环的
    setInterval: undefined,
    fetch: undefined,
    process: undefined,
    Buffer: undefined,
  };
  // SAFE_GLOBALS 里的都是从当前 realm 透传的安全内置件
  const globalObj = globalThis as Record<string, unknown>;
  for (const name of SAFE_GLOBALS) {
    if (name in globalObj) sandbox[name] = globalObj[name];
  }

  const context = vm.createContext(sandbox);
  let timedOut = false;
  let watchdog: NodeJS.Timeout | undefined;

  /**
   * 入口必须在 vm **里面**调用。
   *
   * 曾经写成「runInContext 只加载模块，再在宿主导出函数」—— 这样入口函数
   * 体的同步代码（`while(true){}`）跑在宿主的调用栈上，`vm` 的 timeout
   * 根本管不到，实测整个进程被拖死、验证脚本只能靠 SIGTERM 收场。
   * 现在把「加载 + 找入口 + 调用」包成一段源码一次性在 vm 里跑：
   * 入口体的同步部分自然落在 timeout 的管辖范围里。
   * （异步空转仍杀不掉，靠每个原语自身的截止时间兜底 —— 见文件头第 2 条。）
   */
  const runner = `
"use strict";
(() => {
  const __mod = { exports: {} };
  const module = __mod, exports = __mod.exports;
${compiled.code}
  const __entry = __mod.exports.default ?? __mod.exports.run ?? (typeof __mod.exports === "function" ? __mod.exports : undefined);
  if (typeof __entry !== "function") {
    const err = new Error("__NO_ENTRY__");
    throw err;
  }
  return Promise.resolve(__entry(__workflow_ctx)).then(
    value => ({ __ok: true, value }),
    err => ({ __ok: false, value: err })
  );
})()
`;
  sandbox.__workflow_ctx = ctx;

  try {
    const promise = vm.runInContext(runner, context, {
      timeout: Math.max(1000, deadline - Date.now()),
      filename: 'workflow.js',
    }) as Promise<{ __ok: boolean; value: unknown }>;

    // 异步部分的看门狗：到点没结束就报超时（脚本可能还在后台跑，见文件头）
    const timeoutPill = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => {
        timedOut = true;
        reject(new Error(`工作流超过 ${opts.timeoutMs ?? WORKFLOW_TIMEOUT_MS}ms 未结束`));
      }, Math.max(1000, deadline - Date.now()));
    });

    const settled = await Promise.race([promise, timeoutPill]);
    if (!settled.__ok) {
      const err = settled.value as Error;
      if (err?.message === '__NO_ENTRY__') {
        return {
          ok: false,
          logs,
          steps,
          error: '脚本没有导出可执行入口：请 `export default async function run(ctx) { … }`',
          durationMs: Date.now() - started,
          timedOut,
        };
      }
      return {
        ok: false,
        logs,
        steps,
        error: `运行失败：${err?.message || String(err)}`,
        durationMs: Date.now() - started,
        timedOut,
      };
    }
    return {
      ok: true,
      output: settled.value === undefined ? null : settled.value,
      logs,
      steps,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg === '__NO_ENTRY__') {
      return {
        ok: false,
        logs,
        steps,
        error: '脚本没有导出可执行入口：请 `export default async function run(ctx) { … }`',
        durationMs: Date.now() - started,
        timedOut,
      };
    }
    return {
      ok: false,
      logs,
      steps,
      error: timedOut ? `工作流超时：${msg}` : `运行失败：${msg}`,
      durationMs: Date.now() - started,
      timedOut,
    };
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

/** 给 UI 的示例脚本（设置页里「填入示例」用） */
export const WORKFLOW_TEMPLATE = `export default async function run(ctx) {
  // 先让主力把任务拆开
  const plan = await ctx.assign('workbuddy', '把下面这个需求拆成 2 个可以并行的子任务：' + ctx.memorySearch('当前迭代')[0]?.title);

  // 两个子 agent 并行开工
  const results = await Promise.all([
    ctx.assign('opencode', '按上面的拆解执行子任务一'),
    ctx.assign('workbuddy', '按上面的拆解执行子任务二'),
  ]);

  ctx.log('两路都跑完了', results.map(r => r.text.length).join(','));
  return {
    ok: true,
    summary: results.map(r => ({ agent: r.agentId, chars: r.text.length })),
  };
}
`;
