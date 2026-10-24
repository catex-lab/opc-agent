/**
 * A106：claude `-p --input-format stream-json` 的 control 协议 —— 客户端侧。
 *
 * 协议真源：**本机** `@anthropic-ai/claude-code` 2.1.291（claude.exe 内嵌的
 * zod schema，逐字提取），不是文档转抄。已核实的事实：
 *
 *   信封（两端共用，换行分隔 JSON）：
 *     请求  {"type":"control_request","request_id":"<己方生成，in-flight 内唯一>",
 *             "request":{...}}
 *     成功  {"type":"control_response","response":{"subtype":"success",
 *             "request_id":"<回抄来的 id>","response":<载荷>}}
 *     失败  {"type":"control_response","response":{"subtype":"error",
 *             "request_id":"<回抄来的 id>","error":"<可读原因>"}}
 *
 *   can_use_tool 请求载荷（CLI → 我们）：
 *     {subtype:"can_use_tool", tool_name, input,
 *      tool_use_id?, mcp_server?, permission_suggestions?,
 *      blocked_path?, decision_reason?}
 *   can_use_tool 成功载荷（我们 → CLI）：
 *     {behavior:"allow", updatedInput?, toolUseID?}
 *     {behavior:"deny",  message, interrupt?, toolUseID?}
 *
 *   interrupt 请求载荷：{subtype:"interrupt", cancel_queued?}
 *     成功载荷带 still_queued（异步消息的存活清单）—— 本端不需要，忽略。
 *
 * 覆盖边界：只实现 can_use_tool 与 interrupt 两种 subtype。遇到别的
 * （request_user_dialog 等）一律回 error —— 绝不让 CLI 挂在一个
 * 永远没有回复的请求上（超时是 8 分钟级的，用户等不起）。
 */

/** CLI 主动发来的 can_use_tool 权限请求（已归一化） */
export interface CanUseToolAsk {
  kind: 'can_use_tool';
  /** 回抄进 control_response 的 id */
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** CLI 侧的 tool_use id（有则回抄进响应，便于它对账） */
  toolUseId?: string;
}

/** CLI 主动发来的 interrupt 询问（本端没请求过中断，直接确认即可） */
export interface InterruptAsk {
  kind: 'interrupt';
  requestId: string;
}

/** 认识但未实现的 subtype —— 调用方应回 error */
export interface UnknownAsk {
  kind: 'unknown';
  requestId: string;
  subtype: string;
}

export type ControlAsk = CanUseToolAsk | InterruptAsk | UnknownAsk;

/**
 * stdin 用户消息。
 *
 * 本机实测（2026-10-24，claude 2.1.291）：这个形状被接受，CLI 随即回
 * system/init（带真实 session_id）并开始处理。`session_id:"default"` 的
 * 含义是「当前会话」——新会话由 CLI 分配真实 id 后在 init 里给出，
 * `--resume` 续接时同理指向被续接的那条。
 */
export function buildStdinUserMessage(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
    parent_tool_use_id: null,
    session_id: 'default',
  });
}

/**
 * 把一行 stdout JSON 归类成控制请求；不是控制消息返回 null。
 *
 * 与普通事件流的分流点：普通事件没有 `type:"control_request"`，
 * 控制消息也没有 `type:"assistant"/"result"`，两者不会误判。
 */
export function classifyControlMessage(obj: unknown): ControlAsk | null {
  const o = obj as {
    type?: unknown;
    request_id?: unknown;
    request?: { subtype?: unknown; tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
  };
  if (!o || typeof o !== 'object') return null;
  if (o.type !== 'control_request') return null;
  if (typeof o.request_id !== 'string') return null;

  const req = o.request ?? {};
  const subtype = typeof req.subtype === 'string' ? req.subtype : '';

  if (subtype === 'can_use_tool') {
    return {
      kind: 'can_use_tool',
      requestId: o.request_id,
      toolName: typeof req.tool_name === 'string' ? req.tool_name : 'tool',
      input:
        req.input && typeof req.input === 'object'
          ? (req.input as Record<string, unknown>)
          : {},
      ...(typeof req.tool_use_id === 'string' ? { toolUseId: req.tool_use_id } : {}),
    };
  }
  if (subtype === 'interrupt') {
    return { kind: 'interrupt', requestId: o.request_id };
  }
  return { kind: 'unknown', requestId: o.request_id, subtype: subtype || '(缺失)' };
}

/** 成功应答。载荷形状由各 subtype 自己定义，这里只负责信封。 */
export function buildControlResponse(requestId: string, payload: unknown): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: payload },
  });
}

/** 失败应答。用于「不认识的 subtype」这类无法作答的请求。 */
export function buildControlError(requestId: string, message: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error: message },
  });
}

/**
 * 主动中断当前轮次。
 *
 * 本机 init 事件的 capabilities 含 `interrupt_receipt_v1` /
 * `interrupt_cancel_queued_v1`（2.1.291 实测），说明这个控制请求被支持。
 * request_id 每次新生成：CLI 只要求 in-flight 内唯一。
 */
export function buildInterruptRequest(): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: `opc-interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    request: { subtype: 'interrupt' },
  });
}
