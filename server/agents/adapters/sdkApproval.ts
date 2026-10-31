/**
 * SDK 系适配器共用的工具审批桥。
 *
 * ## 为什么抽成一处
 *
 * `@tencent-ai/agent-sdk` 与 `@anthropic-ai/claude-agent-sdk` 都提供
 * `canUseTool` 回调，形状几乎一致（toolName / input / options →
 * allow|deny）。审批逻辑里夹着四道**安全闸门**：
 *
 *   1. 场景工具白名单（`toolPolicy`）
 *   2. 高危门禁与用户规则（`permission-gate`）
 *   3. bypass 模式放行（只表示「不弹窗」，不等于「连高危也放」）
 *   4. 本会话的「始终允许 / 始终拒绝」记忆
 *
 * 顺序本身就是安全约束（记忆必须在门禁之后，bypass 必须在白名单之后）。
 * 如果两个适配器各写一份，任何一次调整只改到其中一处都会让另一条通道
 * 悄悄变松 —— 这类分叉在生产里表现为「同一个场景，换个 Agent 就能删库」。
 * 所以收敛到这一个函数，两家 SDK 只负责把回调接进来。
 *
 * ## 返回值为什么用本地类型
 *
 * 两家的 `PermissionResult` 都兼容 `{behavior:'allow'|'deny', ...}`，
 * 但各自还带一堆自家字段。这里只产出公共子集，调用方按自己的类型收窄，
 * 避免把某一家 SDK 的类型泄漏进通用层。
 */

import { randomUUID } from 'node:crypto';
import type { AsyncQueue, PendingReplies } from '../channel.js';
import { decideToolAccess } from '../toolPolicy.js';
import { evaluateToolCall } from '../permission-gate.js';
import { currentPermissionRules } from '../../permission-rules.js';
import {
  buildDenialMessage,
  reasonCodeOfKind,
  type PermissionOption,
} from '../../../shared/permissions.js';
import type { AgentEvent, PermissionDecision, SendContext } from '../types.js';

/** 两家 SDK 都认的最小审批结果 */
export type ToolApproval =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string };

/** 「本会话始终允许 / 始终拒绝」的记忆槽 */
export interface ApprovalMemory {
  allow: Set<string>;
  deny: Set<string>;
}

export interface ApprovalBridgeDeps {
  queue: AsyncQueue<AgentEvent>;
  replies: PendingReplies<PermissionDecision>;
  memory: ApprovalMemory;
  ctx: SendContext;
  sessionId: string;
  /** 前端可选的答复档位（WorkBuddy 与 Claude 用同一套 SDK 档位） */
  options: readonly PermissionOption[];
  /** 等待上限；与前端倒计时一致 */
  expiresInMs: number;
}

/**
 * 建一个 `canUseTool` 处理器。
 *
 * 调用方每次 send() 建一个（闭包里的 queue 与 ctx 都是本轮专属），
 * 但 memory 由适配器按会话持有 —— 跨轮生效正是「始终允许」的语义。
 */
export function createCanUseToolBridge(
  deps: ApprovalBridgeDeps
): (toolName: string, input: Record<string, unknown>, options?: { toolUseID?: string }) => Promise<ToolApproval> {
  const { queue, replies, memory, ctx, sessionId, options, expiresInMs } = deps;

  return async (toolName, input, toolOptions) => {
    // ---- P4-5 工具白名单：先于任何放行判断 ----
    //
    // 顺序很关键：白名单是**场景约束**，`bypassPermissions` 只是「不弹审批」。
    // 若把 bypass 放在前面，用户选了「问答」（白名单为空）再切到全放行，
    // 就等于白名单形同虚设。
    const gate = decideToolAccess(ctx.allowedTools, toolName);
    if (!gate.allowed) {
      console.log(
        `[SDK] 工具被场景白名单拦截: ${toolName} (category=${gate.category ?? 'unlisted'})`
      );
      // 两段式：先定性「不是工具故障」，再给替代路径 —— 否则模型会重试
      return {
        behavior: 'deny',
        message: buildDenialMessage('rule_blocked', gate.reason),
      };
    }

    // ---- A40 权限门禁（规则匹配 + Bash 分类器 + 路径越界）----
    // 放在 bypass 判断**之前**：全放行的含义是「不弹窗问人」，
    // 不是「连 rm -rf / 也照跑」。后者由门禁的 dangerous 一档负责，
    // 任何模式都拦。
    const verdict = evaluateToolCall({
      toolName,
      input: (input ?? {}) as Record<string, unknown>,
      cwd: ctx.cwd,
      rules: currentPermissionRules(),
    });
    if (verdict.decision === 'deny') {
      console.log(`[SDK] 门禁拦截 ${toolName}: ${verdict.rule} — ${verdict.reason ?? ''}`);
      return {
        behavior: 'deny',
        message: buildDenialMessage('rule_blocked', verdict.reason ?? verdict.rule),
      };
    }

    // 全放行模式直接过（risky 也不问了 —— 用户已经表态）
    if (ctx.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input };
    }

    // 用户规则明示允许（A40 的 auto）：到这一步已经过完高危检查，
    // 不必再为「已经表过态的工具」反复弹窗。内置分类器的 risky 不享受
    // 这个待遇 —— 它只负责解释，不负责免问。
    if (verdict.auto) {
      return { behavior: 'allow', updatedInput: input };
    }

    // ---- P4：本会话的「始终」记忆 ----
    // 放在白名单 / 门禁 / bypass / auto 之后：用户点过「始终允许」的工具
    // 不再弹窗，但高危检查已经先行拦过，记忆不能把危险操作放出去。
    if (memory.deny.has(toolName)) {
      return {
        behavior: 'deny',
        message: buildDenialMessage('user_denied_always', toolName),
      };
    }
    if (memory.allow.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const requestId = randomUUID();
    queue.push({
      type: 'permission_request',
      requestId,
      toolUseId: toolOptions?.toolUseID,
      toolName,
      input: (input ?? {}) as Record<string, unknown>,
      // 弹窗上要显示「为什么问这一句」，否则用户只看到一堵墙
      risk: verdict.risk,
      rule: verdict.rule,
      // A132：把服务端的兜底时刻如实带下去，前端才能画倒计时而不是自己猜。
      expiresAt: Date.now() + expiresInMs,
      options: [...options],
    });

    // 挂起，直到前端 POST /api/permission-response
    const decision = await replies.register(
      requestId,
      () => ({ behavior: 'deny', reasonCode: 'timeout' }) as PermissionDecision,
      expiresInMs,
      // 归属到会话：别的会话收尾时不能把我的待答复项清掉
      sessionId,
      // 会话结束与超时是两件不同的事，原因码不能互相冒充
      () => ({ behavior: 'deny', reasonCode: 'cancelled' }) as PermissionDecision
    );

    const chosen = decision.optionId
      ? options.find(o => o.id === decision.optionId)
      : undefined;
    const kind = chosen?.kind;

    if (decision.behavior === 'allow') {
      if (kind === 'allow_always') memory.allow.add(toolName);
      return { behavior: 'allow', updatedInput: input };
    }

    const code =
      (kind && reasonCodeOfKind(kind)) || decision.reasonCode || 'user_rejected';
    if (code === 'user_denied_always') memory.deny.add(toolName);
    return {
      behavior: 'deny',
      message: buildDenialMessage(code, decision.message || toolName),
    };
  };
}
