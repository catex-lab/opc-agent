/**
 * 「让某个 Agent 就给定 prompt 发言」——抽出来共享的一棒执行器（A41）。
 *
 * ## 为什么抽这一层
 *
 * 这段逻辑原先长在 /api/group-chat 的路由闭包里，踩过的坑都写在注释里：
 * 每一棒要独立 runId（broadcast 时多路并发）、内部阶段静默（route 的
 * `ROUTE: xxx` 不当消息渲染）、先落库再 turn_done（中间窗口会丢气泡）。
 * 抽出来是为了让 **动态工作流**（server/workflow.ts）复用同一套转发/落库/沉淀
 * 管道 —— 否则工作流里的每个 dispatch/broadcast 都要再抄一遍，
 * 抄的这一遍必然和群聊路径行为漂移。
 *
 * ## 与群聊路由的关系
 *
 * 群聊路由现在只负责：参数解析、会话落库、SSE 头、断开宽限。
 * 「这一棒怎么跑」全在这里。两边对同一件事只有一份实现。
 */

import { randomUUID } from 'crypto';
import * as db from './db.js';
import { RunProjector } from './agents/projector.js';
import { registry } from './agents/registry.js';
import { runProfileOf } from './agents/capability.js';
import { resolveModelForAgent } from './model-routing.js';
import type { PermissionMode } from './agents/definitions.js';
import { publishRunEvent, runHub } from './run-hub.js';
import { isInternalPhase, type AgentTurnResult, type TurnPhase } from './orchestrator.js';
import { distillSkill } from './skill-distill.js';
import { getScenario } from '../shared/scenarios.js';
import { textOfBlocks, toolCallsOfBlocks, type RunEvent } from '../shared/blocks.js';

export interface TurnRunnerDeps {
  /** 所属会话（只需要三个字段，但整个 session 对象传进来也行） */
  session: { id: string; model?: string | null; scenario_id?: string | null };
  /** 本次请求指定的模型；缺省时逐 Agent 解析 */
  model?: string;
  /** 工作目录。缺省退到 process.cwd()，与历史行为一致 */
  cwd?: string;
  /**
   * A62：思考强度档位。缺省 = 不显式传，用 CLI 自己的默认。
   *
   * 群聊也要接：否则前端在群聊里摆一个档位下拉就是假控件
   * （选了下拉、参数根本没下去）。合法性同样由调用方按档位表约束。
   */
  reasoningEffort?: string;
  /** 权限模式，原样交给适配器 */
  permissionMode?: PermissionMode;
  /** 场景 id：优先级高于会话绑定的 scenario_id */
  scenarioId?: string | null;
  /** 触发这一轮的原始用户输入 —— A39 技能沉淀靠它判断「这是不是一个可复用手法」 */
  triggerPrompt?: string;
  /** 中止信号：客户端断开时由调用方 abort */
  signal: AbortSignal;
  /**
   * A122：中止**整个请求**（群聊/工作流里一次「停止」要停下所有成员）。
   *
   * 与 signal 分开是因为 signal 只读：按 runId 即时中止的钩子必须能真的
   * 按下 controller，光有 signal 只能等调用方自己发现该断了。
   */
  abortTurn?: () => void;
  /** v2 块事件出口（写 SSE）。传 noop 就是纯后台运行 */
  emitBlocks: (events: RunEvent[]) => void;
  /**
   * 群聊层自定义帧出口（turn_done 这一类）。
   *
   * 为什么和 emitBlocks 分开：turn_done 不是 RunEvent，它是群聊协议的帧，
   * 带的是 `duration` 而不是 `durationMs`。混在一个出口里就得让两边都认
   * 两种字段名，那是 A28 曾经踩过的坑（token 数塞进 cost）。
   */
  emitFrame?: (payload: Record<string, unknown>) => void;
}

export interface TurnRunner {
  runAgent(
    agentId: string,
    prompt: string,
    phase: TurnPhase,
    round?: number
  ): Promise<AgentTurnResult>;
  /** 正在跑的 runId。调用方（断开宽限逻辑）只读它 */
  readonly activeRuns: ReadonlySet<string>;
}

/**
 * 由场景推导工具白名单。
 *
 * 为什么在**后端**推导：白名单是约束，由被约束方自己声明就等于没有约束。
 * 优先级：sceneId > 会话里绑定的 scenario_id；都没有 → undefined（不限制）。
 */
function allowedToolsFor(scenarioId: string | undefined, sessionScenarioId?: string | null) {
  return getScenario(scenarioId || sessionScenarioId || undefined)?.tools;
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const activeRuns = new Set<string>();
  const { session } = deps;

  const runAgent = async (
    agentId: string,
    prompt: string,
    phase: TurnPhase,
    round?: number
  ): Promise<AgentTurnResult> => {
    const messageId = randomUUID();
    // 内部阶段（如 dispatch 的 route）只服务于编排决策：不建气泡、不落库。
    // 用户的可见叙述走 group_note，见 orchestrator.ts 的 INTERNAL_PHASES 注释。
    const internal = isInternalPhase(phase);
    const resolvedModel = resolveModelForAgent(agentId, deps.model || session.model || undefined);

    /**
     * 每一棒一个独立的 run（E1）。
     *
     * 同一时刻可能有多路事件在跑（broadcast、以及 A41 工作流里的 waitAll），
     * 所以块序列必须按 run 隔离。`messageId` 就是气泡 id：前端靠 run_start
     * 把它和 runId 绑定，后续所有 block_* 事件只带 runId。
     */
    const runId = randomUUID();
    const projector = new RunProjector({
      runId,
      sessionId: session.id,
      messageId,
      agentId,
      model: resolvedModel,
      // A100：事件来源（纯文本解析 vs 结构化输出 vs 原生协议）。
      // 群聊里每一棒可能换人，所以每个棒单独取一次，不能在外层取一遍。
      source: registry.eventSourceOf(agentId),
      // P2：能力档按 (引擎 · 模型 · 网关) 记，每一棒单独算 —— 群聊成员
      // 用的是同一个网关但不同模型，折叠成一个档就分不清是谁的问题。
      capabilities: runProfileOf(agentId, resolvedModel),
    });
    if (!internal) {
      runHub.create(runId);
      activeRuns.add(runId);
      // A122：这一棒的即时中止入口（界面点「停止」）。群聊一次可能有几路
      // 同时在跑，所以每路单独注册：停一路只杀那一路的子进程，
      // abortTurn 负责让编排引擎别再往下派发。
      runHub.setAbortHandler(runId, () => {
        deps.abortTurn?.();
        registry.abort(agentId, session.id);
      });
    }

    let errorMsg: string | undefined;
    // 这一棒的耗时/费用/token。曾经这里把 done 事件整个忽略，
    // 于是群聊回复永远没有成本数据 —— 同样的模型消耗，进了群聊就「免费」了。
    let turnDone: { durationMs?: number; cost?: number; tokens?: number } | null = null;

    /** 下发一条 v2 事件（内部阶段静默：既不推流也不进重连缓冲） */
    const emit = (events: RunEvent[]) => {
      if (internal) return;
      for (const e of events) {
        // 客户端已断开也要继续跑完并落库：事件仍在 runHub 里等重连
        try {
          deps.emitBlocks([e]);
        } catch {
          // 写 SSE 失败不该中断这一棒
        }
        publishRunEvent(e);
      }
    };

    const stream = registry.stream(agentId, {
      sessionId: session.id,
      prompt,
      // 逐个成员解析模型：每个 Agent 的模型命名空间都不同，
      // 统一塞一个全局值必然把其中一部分成员直接打挂
      model: resolvedModel,
      cwd: deps.cwd || process.cwd(),
      reasoningEffort: deps.reasoningEffort,
      permissionMode: deps.permissionMode || 'default',
      // 群聊/工作流同样受场景白名单约束：进了群不等于放开
      allowedTools: allowedToolsFor(deps.scenarioId || undefined, session.scenario_id),
      signal: deps.signal,
    });

    if (!stream) {
      errorMsg = `Agent ${agentId} 不可用`;
      emit(projector.push({ type: 'error', message: errorMsg }));
    } else {
      // run_start 额外带上 phase/round：前端据此把「路由/执行/汇总」区分开
      emit(
        projector
          .push({ type: 'init', sessionId: session.id, model: resolvedModel })
          .map(e => (e.type === 'run_start' ? { ...e, phase, round } : e))
      );

      try {
        for await (const ev of stream) {
          if (ev.type === 'done') {
            turnDone = { durationMs: ev.durationMs, cost: ev.cost, tokens: ev.tokens };
          }
          if (ev.type === 'error') {
            errorMsg = ev.message;
            console.error(`[Turn] ${agentId} 报错: ${ev.message}`);
            registry.recordError(agentId, ev.message);
          }
          emit(projector.push(ev));
        }
      } catch (err: any) {
        errorMsg = err?.message || String(err);
        console.error(`[Turn] ${agentId} 异常:`, errorMsg);
        emit(projector.push({ type: 'error', message: errorMsg ?? '未知错误' }));
      }
    }

    const status = deps.signal.aborted ? 'aborted' : errorMsg ? 'error' : 'ok';
    const { closes, end } = projector.finish(status, turnDone ?? undefined);
    emit(closes);
    // P2：内部阶段的"能力"不是用户看到的这一轮，不记；
    // 其余每一棒都记 —— 群聊里谁给得出思考，正是这里最想知道的事。
    if (!internal && end.type === 'run_end' && end.capabilities) {
      try {
        db.saveCapabilityProfile(end.capabilities);
      } catch (e: any) {
        console.error('[Capability] 保存观测结果失败:', e?.message ?? e);
      }
    }

    const blocks = projector.blockList;
    const text = textOfBlocks(blocks);

    // 先落库、再通报 turn_done：客户端一收到 turn_done 就可能去刷新会话，
    // 顺序反了会在那一瞬丢掉这一棒（探针实测踩过这个窗口）。
    // 内部阶段的原文不落库：刷新后用户不该看到一句没头没尾的 `ROUTE: xxx`
    if (internal) {
      console.log(`[Turn] ${agentId} 内部阶段 ${phase} 输出 ${text.length} 字（未落库、未推送）`);
    } else if (deps.signal.aborted && blocks.length === 0) {
      // 客户端断开导致这一棒一个字都没产出：不落库，否则是个空气泡
      console.log(`[Turn] ${agentId} 被中止且无产出，跳过落库`);
    } else try {
      const tools = toolCallsOfBlocks(blocks);
      db.createMessage({
        id: messageId,
        session_id: session.id,
        role: 'assistant',
        content: text,
        model: resolvedModel || null,
        author_agent_id: agentId,
        created_at: new Date().toISOString(),
        tool_calls: tools.length > 0 ? JSON.stringify(tools) : null,
        blocks: blocks.length > 0 ? JSON.stringify(blocks) : null,
        duration_ms: turnDone?.durationMs ?? null,
        cost: turnDone?.cost ?? null,
        tokens: turnDone?.tokens ?? null,
      });

      // A39：沉淀技能。内部阶段（ROUTE / 评审）不沉淀 ——
      // 那是编排器的中间话术，学它等于学一套黑话。
      if (!internal) {
        try {
          const r = distillSkill({
            prompt: deps.triggerPrompt ?? '',
            blocks,
            durationMs: turnDone?.durationMs ?? null,
            agentId,
            aborted: deps.signal.aborted,
            hadError: !!errorMsg,
          });
          if (r.status === 'created') console.log(`[Skill] 沉淀新技能：${r.name}`);
          else if (r.status === 'reused') console.log(`[Skill] 命中已有技能：${r.name}（第 ${r.uses} 次）`);
        } catch (e: any) {
          console.error('[Skill] 沉淀失败（不影响发言）:', e?.message ?? e);
        }
      }
    } catch (dbError: any) {
      console.error(`[Turn] 保存 ${agentId} 的消息失败:`, dbError);
    }

    if (!internal) {
      activeRuns.delete(runId);
      deps.emitFrame?.({
        type: 'turn_done',
        agentId,
        messageId,
        runId,
        duration: turnDone?.durationMs,
        cost: turnDone?.cost,
        tokens: turnDone?.tokens,
      });
    }

    return { text, error: errorMsg };
  };

  return { runAgent, activeRuns };
}
