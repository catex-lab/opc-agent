/**
 * SDK 适配器：把 CodeBuddy / WorkBuddy 的 `query()` 包装成统一事件流。
 *
 * 这是唯一「一等公民」的适配器 —— 其他 CLI 都是它的降级替代。
 * 之所以要包装而不是继续内联在 /api/chat 里，是为了让上层（会话、群聊、
 * 任务分派）只面对一种接口，不必区分「这个 Agent 走 SDK 还是走子进程」。
 */

import { randomUUID } from 'crypto';
import {
  query,
  unstable_v2_authenticate,
  type CanUseTool,
  type PermissionResult,
} from '@tencent-ai/agent-sdk';
import { AsyncQueue, PendingReplies, linkAbort } from '../channel.js';
import { decideToolAccess } from '../toolPolicy.js';
import { evaluateToolCall } from '../permission-gate.js';
import { currentPermissionRules } from '../../permission-rules.js';
import { withMemoryContext } from '../../memory.js';
import type {
  AgentDescriptor,
  AgentEvent,
  AgentProvider,
  AgentStatus,
  PermissionDecision,
  SendContext,
} from '../types.js';

/** 权限请求等待上限，与前端提示一致 */
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业的 AI 助手，善于帮助用户解决各种问题。请用简洁清晰的方式回答。';

/** 未登录时拿到的登录地址，供前端渲染「去登录」按钮 */
let lastAuthUrl: string | null = null;

export function getLastAuthUrl(): string | null {
  return lastAuthUrl;
}

export class SdkAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;

  /** 正在运行的调用：sessionId → 中止控制 */
  private active = new Map<string, { abort: () => void }>();
  /** 待答复的权限请求 */
  private replies = new PendingReplies<PermissionDecision>();
  /** 探测缓存（避免每次刷新名册都跑一次鉴权） */
  private status: AgentStatus | null = null;

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor;
  }

  // ============= 探测 =============

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();

    // 环境变量配置的凭据最优先，无需网络往返
    const envOk = Boolean(
      process.env.CODEBUDDY_API_KEY || process.env.CODEBUDDY_AUTH_TOKEN
    );

    try {
      let needsLogin = false;
      const result = await unstable_v2_authenticate({
        environment: 'external',
        onAuthUrl: async (authState: { authUrl?: string }) => {
          needsLogin = true;
          if (authState?.authUrl) lastAuthUrl = authState.authUrl;
        },
      });

      const userinfo = (result as { userinfo?: { userName?: string } } | undefined)?.userinfo;

      if (needsLogin) {
        this.status = {
          availability: 'needs-auth',
          installed: true,
          message: '未登录，请先完成登录',
          // 结构化地址：前端「去登录」按钮直接用它，不从 message 里抠
          ...(lastAuthUrl ? { authUrl: lastAuthUrl } : {}),
          probedAt: now,
        };
      } else {
        lastAuthUrl = null;
        this.status = {
          availability: 'ready',
          installed: true,
          message: userinfo?.userName
            ? `已登录：${userinfo.userName}`
            : envOk
              ? '已通过环境变量配置凭据'
              : '已登录',
          probedAt: now,
        };
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      if (envOk) {
        this.status = {
          availability: 'ready',
          installed: true,
          message: '已通过环境变量配置凭据',
          probedAt: now,
        };
      } else {
        // 鉴权调用本身失败（可能是网络问题，也可能就是未登录）。
        // 把原因如实带上，不假装是「已登录」。
        this.status = lastAuthUrl
          ? {
              availability: 'needs-auth',
              installed: true,
              message: '未登录，请先完成登录',
              authUrl: lastAuthUrl,
              probedAt: now,
            }
          : {
              availability: 'needs-auth',
              installed: true,
              message: `鉴权检查失败：${message}`,
              probedAt: now,
            };
      }
    }

    return this.status;
  }

  // ============= 调用 =============

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const sessionId = ctx.sessionId;
    let aborted = false;

    const abort = () => {
      aborted = true;
      this.replies.clear();
      queue.close();
    };
    this.active.set(sessionId, { abort });
    const unlinkAbort = linkAbort(ctx.signal, abort);

    // ---- 权限桥接：SDK 回调 → 事件流 → 前端答复 ----
    const canUseTool: CanUseTool = async (toolName, input, options) => {
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
        return { behavior: 'deny', message: gate.reason } as PermissionResult;
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
          message: `[权限门禁] ${verdict.reason ?? verdict.rule ?? '高危操作'}`,
        } as PermissionResult;
      }

      // 全放行模式直接过（risky 也不问了 —— 用户已经表态）
      if (ctx.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }

      // 用户规则明示允许（A40 的 auto）：到这一步已经过完高危检查，
      // 不必再为「已经表过态的工具」反复弹窗。内置分类器的 risky 不享受
      // 这个待遇 —— 它只负责解释，不负责免问。
      if (verdict.auto) {
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }

      const requestId = randomUUID();
      queue.push({
        type: 'permission_request',
        requestId,
        toolUseId: (options as { toolUseID?: string })?.toolUseID,
        toolName,
        input: (input ?? {}) as Record<string, unknown>,
        // 弹窗上要显示「为什么问这一句」，否则用户只看到一堵墙
        risk: verdict.risk,
        rule: verdict.rule,
      });

      // 挂起，直到前端 POST /api/permission-response
      const decision = await this.replies.register(
        requestId,
        () => ({ behavior: 'deny', message: '权限请求超时' }) as PermissionDecision,
        PERMISSION_TIMEOUT
      );

      if (decision.behavior === 'allow') {
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }
      return {
        behavior: 'deny',
        message: decision.message || '用户拒绝了此操作',
      } as PermissionResult;
    };

    const started = Date.now();

    // ---- 启动 SDK 流，后台泵入队列 ----
    (async () => {
      try {
        const stream = query({
          prompt: ctx.prompt,
          options: {
            cwd: ctx.cwd || process.cwd(),
            model: ctx.model,
            maxTurns: 10,
            // A38：SDK 这条路的提示词由我们装配，记忆层在这里注入。
            // 先落默认提示词再追加记忆 —— 反过来会在用户没配提示词时
            // 把默认人格整个替换成一段记忆，agent 就「不会说人话」了。
            // A98：带上 cwd，让记忆层把「当前项目」那一层也注入进来
            systemPrompt: withMemoryContext(ctx.systemPrompt || DEFAULT_SYSTEM_PROMPT, ctx.memoryCwd),
            permissionMode: ctx.permissionMode || 'default',
            canUseTool,
            ...(ctx.resumeToken ? { resume: ctx.resumeToken } : {}),
          },
        });

        queue.push({ type: 'init', sessionId, model: ctx.model });

        let currentToolId: string | null = null;
        const openTools: string[] = [];

        for await (const msg of stream) {
          if (aborted) break;
          const m = msg as Record<string, unknown>;

          if (m.type === 'system' && m.subtype === 'init') {
            queue.push({
              type: 'init',
              sessionId,
              model: ctx.model,
              resumeToken: (m.session_id as string) ?? null,
            });
            continue;
          }

          if (m.type === 'assistant') {
            const content = (m.message as { content?: unknown })?.content;
            if (typeof content === 'string') {
              queue.push({ type: 'text', content });
            } else if (Array.isArray(content)) {
              for (const block of content as Array<Record<string, unknown>>) {
                if (block.type === 'text') {
                  queue.push({ type: 'text', content: String(block.text ?? '') });
                } else if (block.type === 'image' && typeof block.source === 'object' && block.source !== null) {
                  const source = block.source as Record<string, unknown>;
                  const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
                  const data = typeof source.data === 'string' ? source.data : undefined;
                  const url = typeof source.url === 'string' ? source.url : undefined;
                  if (data || url) {
                    queue.push({
                      type: 'artifact',
                      id: `sdk-image-${randomUUID()}`,
                      name: '图像产物',
                      mediaType,
                      ...(url ? { uri: url } : {}),
                      ...(data ? { data: { encoding: 'base64', content: data } } : {}),
                      description: '由 Agent SDK 原生消息块返回的图像',
                    });
                  }
                } else if (block.type === 'tool_use') {
                  currentToolId = (block.id as string) || randomUUID();
                  openTools.push(currentToolId);
                  queue.push({
                    type: 'tool',
                    id: currentToolId,
                    name: String(block.name ?? 'unknown'),
                    input: block.input ?? {},
                  });
                }
              }
            }
            continue;
          }

          if (m.type === 'tool_result') {
            const toolId = (m.tool_use_id as string) || currentToolId;
            if (!toolId) continue;
            const raw = m.content;
            const text =
              typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
            queue.push({
              type: 'tool_result',
              toolId,
              content: text,
              isError: Boolean(m.is_error),
            });
            const i = openTools.indexOf(toolId);
            if (i >= 0) openTools.splice(i, 1);
            currentToolId = null;
            continue;
          }

          if (m.type === 'result') {
            // 收尾：把还没拿到结果的工具标记完成，避免前端一直转圈
            for (const toolId of openTools) {
              queue.push({
                type: 'tool_result',
                toolId,
                content: '已完成',
              });
            }
            openTools.length = 0;
            queue.push({
              type: 'done',
              durationMs:
                typeof m.duration === 'number' ? m.duration : Date.now() - started,
              cost: typeof m.cost === 'number' ? m.cost : undefined,
            });
          }
        }

        queue.close();
      } catch (err) {
        queue.fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    try {
      for await (const ev of queue) yield ev;
    } catch (err) {
      yield { type: 'error', message: (err as Error).message || String(err) };
    } finally {
      unlinkAbort();
      this.replies.clear();
      this.active.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    this.active.get(sessionId)?.abort();
    this.active.delete(sessionId);
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.replies.settle(requestId, decision);
  }
}
