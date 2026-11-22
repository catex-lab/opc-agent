/**
 * 聊天 API。
 *
 * F0-02②③：从 server/index.ts 原样迁出，行为零改动（整区含注释逐行搬运）。
 * 49 条路由（会话消息流、群聊、工作流、停止/恢复、历史、SSE 投影）。
 * index.ts 模块内的可变状态经 deps 显式注入（见 CustomAgentRoutesDeps 先例）。
 */

import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db.js';
import { startSseHeartbeat } from '../sse-heartbeat.js';
import { REATTACH_GRACE_MS, GROUP_TURN_IDLE_TIMEOUT_MS } from '../../shared/timing.js';
import {
  BUILTIN_NOTE,
  PERMISSION_RULES_PATH,
  loadPermissionRules,
  savePermissionRules,
} from '../permission-rules.js';
import type { ExtensionKind } from '../extensions/store.js';
import {
  acceptSource as extAcceptSource,
  applyNormalized as extApplyNormalized,
  deleteItem as extDeleteItem,
  findItem as extFindItem,
  listItems as extListItems,
  listSources as extListSources,
  listTargets as extListTargets,
  revertNormalized as extRevertNormalized,
  stats as extStats,
  toggleEnabled as extToggleEnabled,
  toggleKindEnabled as extToggleKindEnabled,
  updateLocal as extUpdateLocal,
} from '../extensions/store.js';
import { runImport as extRunImport, refreshItem as extRefreshItem, redactConfig, scanAllMcp } from '../extensions/import.js';
import { applyHits as extApplyHits } from '../extensions/normalize.js';
import { buildMcpConfig, safeAgentId } from '../extensions/distribute.js';
import { applyDrift as extApplyDrift, scanDrift as extScanDrift } from '../extensions/drift.js';
import {
  distributableTargetCount as extDistributableTargetCount,
  MATRIX_STATES as EXT_MATRIX_STATES,
  MODE_LABEL as EXT_MODE_LABEL,
  TARGETS as EXT_TARGETS,
} from '../extensions/targets.js';
import { errorTextOfBlocks, textOfBlocks, toolCallsOfBlocks, type RunEvent } from '../../shared/blocks.js';
import { findDanglingTurn, opencodeSessionDirectory, sameDirectory } from '../dangling.js';
import { getScenario } from '../../shared/scenarios.js';
import { parsePermissionBody } from '../../shared/permissions.js';
import { runHub, publishRunEvent } from '../run-hub.js';
import { beginRunTiming, isFirstContentEvent, noteFirstContent, takeRunTiming } from '../agents/runTimingMeta.js';
import { takePendingPermissionMeta } from '../agents/permissionMeta.js';
import { registry } from '../agents/registry.js';
import { findDef } from '../agents/definitions.js';
import { RunProjector } from '../agents/projector.js';
import { scoreAgentSkills } from '../agents/types.js';
import { resolveStoredModelForAgent } from '../model-routing.js';
import { runProfileOf } from '../agents/capability.js';
import { maybeReprobeOnAuthError } from '../agents/auth-recovery.js';
import { validateDirectory } from '../workspaceDir.js';
import { projectIdForCwd } from '../project-ownership.js';
import { redactSecret } from '../log-redact.js';
import { assembleHistory, assembleGroupTranscript, HISTORY_TOKEN_BUDGET, historySummary } from '../history.js';
import { buildKbInjection } from '../kb/inject.js';
import { reconcileWorkbuddyResumeTokens } from '../agents/wbRootEpoch.js';
import { normalizeSkillBody } from '../extensions/normalize.js';
import { scanSensitive } from '../extensions/safety.js';
import { createTurnRunner } from '../turn-runner.js';
import { runOrchestration, extractMentioned } from '../orchestrator.js';
import { WORKFLOW_TEMPLATE, runWorkflow } from '../workflow.js';
import { createWorktrees, cleanupWorktrees, isGitWorkTree, mergeWorktree } from '../worktree.js';
import { addGrant, listGrants, removeGrant } from '../permission-grants.js';
import {
  NotifyChannelKind,
  approvalBaseOf,
  consumeRemoteToken,
  loadNotifyConfig,
  notifyTest,
  saveNotifyConfig,
  validateNotifyUrl,
} from '../notify.js';
import { distillSkill } from '../skill-distill.js';
import {
  deleteSkill,
  listSkills,
  memoryStats,
  projectMemoryStats,
  projectScope,
  readCoreMemory,
  readSkill,
  readUserProfile,
  reindexMemory,
  searchMemory,
  writeCoreMemory,
  writeSkill,
  writeUserProfile,
} from '../memory.js';
import {
  createProjectTask,
  deleteProject,
  deleteProjectTask,
  getOrCreateProject,
  getProject,
  getProjectByPath,
  isProjectTaskStatus,
  listProjectTasks,
  listProjects,
  renameProject,
  updateProjectTask,
} from '../db.js';

export interface ChatRoutesDeps {
  /** 监听端口（index.ts 模块级；绑定后回填，SSE/审批地址用它拼） */
  serverPort: number | null;
  /** 进程监听端口（PORT 环境变量解析后的模块级常量） */
  port: number;
}

export function registerChatRoutes(app: Express, deps: ChatRoutesDeps): void {
// ============= 聊天 API =============

// ── A244 群聊闸门 ──────────────────────────────────────────────────
// 同一个群上一轮还在执行时，新的 POST 直接 409。以前没有这把锁：同一个群
// 并发两次 POST 会同时跑两套编排——两个 turn-runner、两份用户消息、两套
// worktree 批次互相踩同一个主工作区的 index。
const groupChatBusy = new Set<string>();
/** 单轮里同时跑的棒数上限（A244）。串行模式（分派/接力/辩论）不受影响。 */
const GROUP_MAX_CONCURRENCY = 3;

/**
 * 清空会话的聊天记录（P7 群设置「删除聊天记录」）。
 *
 * 与 DELETE /api/sessions/:id 的分工：那个是「退出群聊 / 删除会话」，
 * 整条记录连同成员、场景绑定一起消失；这个只删消息，会话还在 ——
 * 清完之后群里照样能说话，只是历史要从头开始。
 * 返回删掉几条，让前端能说清「已删除 N 条记录」而不是干巴巴一句成功。
 */
app.delete("/api/sessions/:sessionId/messages", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }
    const deleted = db.deleteMessagesBySession(sessionId);
    console.log(`[Sessions] 已清空 ${sessionId} 的聊天记录（${deleted} 条）`);
    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error("[Clear Messages] Error:", error);
    res.status(500).json({ error: error?.message || "清空聊天记录失败" });
  }
});

/**
 * A33 分支：把「截至某条消息」的会话复制成一个新会话。
 *
 * 复制的是**会话元数据 + 截至该消息的全部消息**（含 blocks / tool_calls /
 * images / 成本统计），在新会话 id 下重新落一遍。`sdk_session_id` 不复制：
 * 各家 Agent 的会话令牌只在原进程里有效，带过去只会让新会话的第一个问题
 * 被拒。这是「另起一炉重开一局」，不是「接着原来的上下文说」。
 */
app.post("/api/sessions/:sessionId/branch", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { messageId } = req.body ?? {};

    const session = db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }

    const all = db.getMessagesBySession(sessionId);
    if (all.length === 0) {
      return res.status(400).json({ error: "空会话无法分支" });
    }

    // 截至该消息（含它自己）。找不到 messageId 时退化为整段历史 ——
    // 宁可按完整会话分支，也不返回 400 让用户白点一次。
    const cut = messageId ? all.findIndex(m => m.id === messageId) : -1;
    const copied = cut >= 0 ? all.slice(0, cut + 1) : all;

    const newId = uuidv4();
    const now = new Date().toISOString();
    db.createSession({
      id: newId,
      title: `${session.title}（分支）`,
      model: session.model,
      agent_id: session.agent_id,
      sdk_session_id: null,
      kind: session.kind,
      agent_ids: session.agent_ids,
      orchestration: session.orchestration,
      cwd: session.cwd,
      // A62：分支要把档位一起带走 —— 同一份上下文才叫分支，
      // 否则分支出来的会话静默回到 CLI 默认，用户以为设过
      reasoning_effort: session.reasoning_effort,
      scenario_id: session.scenario_id,
      system_prompt: session.system_prompt,
      pinned: 0,
      created_at: now,
      updated_at: now,
    });

    db.createMessages(
      copied.map(m => ({
        // 新 id：分支会话与原会话是两条独立的记录，
        // 复制 id 会在同表里撞主键
        id: uuidv4(),
        session_id: newId,
        role: m.role,
        content: m.content,
        model: m.model,
        author_agent_id: m.author_agent_id,
        created_at: m.created_at,
        tool_calls: m.tool_calls,
        images: m.images,
        blocks: m.blocks,
        duration_ms: m.duration_ms,
        cost: m.cost,
        tokens: m.tokens,
      }))
    );

    console.log(`[Sessions] 分支 ${sessionId} → ${newId}（含 ${copied.length} 条消息）`);
    res.json({ success: true, sessionId: newId, messageCount: copied.length });
  } catch (error: any) {
    console.error("[Branch Session] Error:", error);
    res.status(500).json({ error: error?.message || "分支会话失败" });
  }
});

// ════════ A226：跨 Agent 会话转交 ════════
// 单聊会话换人接力：历史摘要存进 handoff_context，下一轮 /api/chat 前置注入后清空。
// 为什么不立刻替用户发一条「接手确认」：转交是用户的决定，新 Agent 开口的第一句
// 应该留给真正的下一条指令——注入摘要只为它服务。
app.post("/api/sessions/:sessionId/handoff", (req, res) => {
  try {
    const { sessionId } = req.params;
    const targetAgentId = String((req.body ?? {}).targetAgentId ?? '').trim();
    if (!targetAgentId) return res.status(400).json({ error: '缺少 targetAgentId' });

    const session = db.getSession(sessionId);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    if (session.kind === 'group') {
      return res.status(400).json({ error: '群聊由成员分工，没有「转交」——把新人拉进群即可' });
    }
    if (session.agent_id === targetAgentId) {
      return res.status(400).json({ error: '这个会话已经在和它对话了' });
    }
    const target = registry.get(targetAgentId);
    if (!target) return res.status(404).json({ error: `未知的 Agent: ${targetAgentId}` });

    const fromName = registry.get(session.agent_id || '')?.name || session.agent_id || '上一任';
    // 摘要在切换**之前**取：消息还是那个对话的完整样子
    let rows: db.DbMessage[] = [];
    try {
      rows = db.getMessagesBySession(sessionId);
    } catch {
      rows = [];
    }
    const summary = historySummary(rows);
    db.updateSession(sessionId, {
      agent_id: targetAgentId,
      // 新 Agent 没有自己的 CLI 会话，清掉前任的续接令牌与档位记账
      sdk_session_id: null,
      sdk_thread_permission: null,
      handoff_context: summary || null,
    });

    console.log(
      `[Sessions] 转交 ${sessionId}: ${session.agent_id} → ${targetAgentId}` +
        `（携带摘要 ${summary.length} 字）`
    );
    res.json({
      ok: true,
      fromAgentId: session.agent_id,
      targetAgentId,
      targetName: target.name,
      carried: summary.length > 0,
    });
  } catch (error: any) {
    console.error("[Handoff] Error:", error);
    res.status(500).json({ error: error?.message || '转交失败' });
  }
});

// ════════ A228：远程审批 ════════
// 配置（设置页）+ 一次性审批链接（IM 卡片里的按钮就是这两个 GET）。

app.get("/api/notify/config", (_req, res) => {
  const cfg = loadNotifyConfig();
  // url 只回「有没有配」与尾段：完整 webhook 里嵌着机器人的密钥，前端不需要它
  res.json({
    kind: cfg.kind,
    enabled: cfg.enabled,
    externalBaseUrl: cfg.externalBaseUrl ?? null,
    hasUrl: !!cfg.url,
    urlTail: cfg.url ? cfg.url.replace(/[?&]([^=&]+)=([^&]*)/g, (_m, k) => `?${k}=***`) : null,
    approvalBase: approvalBaseOf(cfg, deps.serverPort ?? deps.port),
  });
});

app.put("/api/notify/config", (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prev = loadNotifyConfig();
    const kind = (['lark', 'wecom', 'dingtalk', 'generic'] as const).includes(body.kind as never)
      ? (body.kind as NotifyChannelKind)
      : prev.kind;
    // url 传 null / '' = 清空；不传 = 保持原值（编辑其他字段时不必重贴密钥 URL）
    let url = prev.url;
    if (body.url !== undefined) url = String(body.url ?? '').trim();
    const externalBaseUrl =
      body.externalBaseUrl !== undefined ? String(body.externalBaseUrl ?? '').trim() : prev.externalBaseUrl;
    if (url) {
      const err = validateNotifyUrl(url);
      if (err) return res.status(400).json({ error: err });
    }
    if (externalBaseUrl) {
      const err = validateNotifyUrl(externalBaseUrl);
      if (err) return res.status(400).json({ error: `外部可达地址不合法：${err}` });
    }
    const next = {
      url,
      kind,
      enabled: body.enabled === true && !!url,
      ...(externalBaseUrl ? { externalBaseUrl } : {}),
    };
    saveNotifyConfig(next);
    res.json({ ok: true, enabled: next.enabled });
  } catch (error: any) {
    console.error("[Notify] Save error:", error);
    res.status(500).json({ error: error?.message || '保存通知配置失败' });
  }
});

app.post("/api/notify/test", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prev = loadNotifyConfig();
    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : prev.url;
    const kind = (['lark', 'wecom', 'dingtalk', 'generic'] as const).includes(body.kind as never)
      ? (body.kind as NotifyChannelKind)
      : prev.kind;
    if (!url) return res.status(400).json({ error: '先填写 webhook 地址' });
    res.json(await notifyTest({ ...prev, url, kind, enabled: true }));
  } catch (error: any) {
    console.error("[Notify] Test error:", error);
    res.status(500).json({ error: error?.message || '测试发送失败' });
  }
});

// 审批兑现。GET：IM 卡片里能点的只有链接；响应是一个极小的 HTML 结果页
// （手机浏览器打开要给人看一个结果，JSON 没有这个体验）。
app.get("/api/remote-approve/:token", (req, res) => {
  const token = String(req.params.token ?? '');
  const decision = req.query.decision === 'deny' ? 'deny' : 'allow';
  const page = (title: string, detail: string) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5">` +
    `<div style="text-align:center;padding:32px;border-radius:16px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08)">` +
    `<h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#666">${detail}</p></div></body>`;
  try {
    const hit = consumeRemoteToken(token);
    if (!hit) {
      res.status(404).send(page('链接已失效', '这条审批链接已被使用或已过期，请回应用内处理'));
      return;
    }
    // token 与 decision 是成对铸造的：allow 链接只允许 allow——防止「点错链接前改参数」
    if (hit.decision !== decision) {
      res.status(400).send(page('链接与操作不符', '这条链接只对应一种操作，请使用卡片里的对应按钮'));
      return;
    }
    const hitAgent = registry.resolvePermissionAnywhere(hit.requestId, {
      behavior: decision,
      ...(decision === 'deny' ? { reasonCode: 'user_rejected' as const } : {}),
    });
    if (!hitAgent) {
      res.status(404).send(page('请求已处理', '这条审批请求已被答复（本机应用内或另一条链接），无需重复处理'));
      return;
    }
    console.log(`[Permission] Remote approve: requestId=${hit.requestId} → ${decision}（${hitAgent}）`);
    res.send(page(decision === 'allow' ? '已放行' : '已拒绝', '可以关闭这个页面，回到应用继续查看'));
  } catch (error: any) {
    console.error("[Notify] Approve error:", error);
    res.status(500).send(page('处理失败', error?.message || '服务端错误，请回应用内处理'));
  }
});

// 权限响应 API
// 权限请求可能来自任意 Agent（SDK 的 canUseTool、ACP 的 session/request_permission），
// 所以这里不绑定具体 Agent —— 直接问注册表谁能认领这个 requestId。
app.post("/api/permission-response", (req, res) => {
  const parsed = parsePermissionBody(req.body);
  if (!parsed.ok) {
    // 非法 behavior 静默改成 deny，用户会看到「我点了允许，它却拒了」，
    // 而日志里一切正常 —— 必须在边界上报错（与 A119/A123 的口径一致）
    return res.status(400).json({ error: parsed.error });
  }

  const { requestId } = req.body ?? {};
  if (typeof requestId !== 'string' || !requestId.trim()) {
    return res.status(400).json({ error: 'requestId 必须是非空字符串' });
  }

  const { decision } = parsed;
  console.log(
    `[Permission] Response: requestId=${requestId}, behavior=${decision.behavior}`
    + (decision.optionId ? `, option=${decision.optionId}` : '')
    + (decision.reasonCode ? `, reason=${decision.reasonCode}` : '')
  );

  // 「该 Agent 永久」（2026-11-12 变体 A）：与 allow 答复**同一个请求**里落库，
  // 避免前端分两次调用造成竞态（先答后存之间工具可能已经再次触发）。
  // 落库键取自服务端待答复元数据（permission_request 事件经过投影器时记下），
  // **不信前端传来的任何 agentId / toolName** —— 授权键的来源只能是事件流。
  let persisted = false;
  if (decision.behavior === 'allow' && parsed.persistAgent) {
    const meta = takePendingPermissionMeta(requestId.trim());
    if (meta) {
      persisted = addGrant(meta.agentId, meta.toolName);
      console.log(
        `[Permission] 持久授权落库: ${meta.agentId} · ${meta.toolName}（persisted=${persisted}）`
      );
    } else {
      // 元数据缺失（老事件路径 / 重复答复）：答复照常生效，但诚实说明没存
      console.warn(`[Permission] persistAgent 请求找不到待答复元数据: ${requestId}（未落库）`);
    }
  }

  const hit = registry.resolvePermissionAnywhere(requestId.trim(), decision);

  if (!hit) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }

  // 无论是否持久化，待答复元数据都已消费完毕，顺手清掉防泄漏
  takePendingPermissionMeta(requestId.trim());

  res.json({ success: true, agentId: hit, ...(persisted ? { persisted: true } : {}) });
});

// 持久授权管理（2026-11-12 变体 A）：设置→权限管理 的数据源。
// 只列 agentId+toolName 粒度的持久档；会话级授权在适配器内存里，
// 重启即失效，不在此列（设置页如实说明，不假装能列出）。
app.get("/api/permission-grants", (_req, res) => {
  res.json({ grants: listGrants() });
});

app.delete("/api/permission-grants", (req, res) => {
  // agentId + toolName：query 优先（撤销链接可收藏），JSON body 兜底
  const q = req.query as Record<string, unknown>;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const agentId = typeof q.agentId === 'string' && q.agentId.trim()
    ? q.agentId
    : typeof b.agentId === 'string' ? b.agentId : '';
  const toolName = typeof q.toolName === 'string' && q.toolName.trim()
    ? q.toolName
    : typeof b.toolName === 'string' ? b.toolName : '';
  if (!agentId.trim() || !toolName.trim()) {
    return res.status(400).json({ error: 'agentId 与 toolName 都不能为空' });
  }
  const removed = removeGrant(agentId, toolName);
  if (!removed) {
    return res.status(404).json({ error: '授权不存在（可能已撤销）' });
  }
  console.log(`[Permission] 持久授权已撤销: ${agentId.trim()} · ${toolName.trim()}`);
  res.json({ success: true });
});

/**
 * 由场景推导本轮的工具白名单（P4-5）。
 *
 * 为什么在**后端**推导，而不是让前端把 `allowedTools` 塞进请求体：
 * 白名单是约束，由被约束方自己声明就等于没有约束。前端只负责给出
 * `scenarioId`，真正的 `tools` 从前后端共享的场景定义里查（`shared/scenarios.ts`）。
 *
 * 优先级：本次请求带的 scenarioId > 会话里已绑定的 scenario_id。
 * 两者都没有 → 返回 undefined（不做限制，保持历史行为）。
 */
function allowedToolsFor(
  scenarioId: string | undefined,
  sessionScenarioId?: string | null
) {
  return getScenario(scenarioId || sessionScenarioId || undefined)?.tools;
}

/**
 * 发送消息并获取流式响应。
 *
 * 关键：这里**不再**区分 Agent 类型。所有 Agent 都通过 registry.stream()
 * 拿到同一套 AgentEvent 流，本函数只负责「事件 → SSE → 落库」的翻译。
 * 新增一个 Agent 时这个文件不需要改。
 */
app.post("/api/chat", async (req, res) => {
  const {
    sessionId,
    message,
    model,
    systemPrompt,
    cwd,
    permissionMode,
    agentId = 'workbuddy',
    // P4：场景模板 id（可选）
    scenarioId,
    // A62：思考强度档位（可选）。前端只在模型真有档位表时才发，
    // 发 null / 不发的语义不同：null = 用户选了「CLI 默认」（要清掉旧值），
    // undefined = 这一项不碰。
    reasoningEffort,
    // A33 重新生成：为 true 时 message 是「会话里最后一条 user 消息」的内容，
    // 它已经在库里了 —— 这一轮不再重复落一条；同时把被顶掉的那条 assistant
    // 回复删掉，否则刷新后会看到同一问两答。
    regenerate = false,
    // 被重新生成顶掉的那条 assistant 消息 id（regenerate 时必带）
    replaceMessageId,
    // A207：用户对「上一轮指令未完成」确认框的答复。
    // 'continue' = 就在原 CLI 会话上继续；'fresh' = 清掉续接令牌、新建会话。
    resumeChoice: rawResumeChoice,
    // A210：前端 fetch 发出的时刻（epoch ms）。老客户端不带这个字段时
    // 服务端把 t0 回落成 t1 —— 宁可少一段「请求在途」，也不编时间基准。
    clientSentAt,
  } = req.body;

  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] Agent: ${agentId}`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);

  if (!message) {
    return res.status(400).json({ error: "消息不能为空" });
  }

  const provider = registry.getProvider(agentId);
  if (!provider) {
    return res.status(404).json({ error: `未知的 Agent: ${agentId}` });
  }

  // A63：工作目录在**建会话 / 起流之前**就校验。确定不存在的直接 400，
  // 报错说成「工作目录不存在」—— 而不是让用户等流式开始后看到一句
  // 裸的 spawn ENOENT，那时候他早就忘了自己改过工作目录。
  if (typeof cwd === 'string' && cwd && validateDirectory(cwd) === 'not-found') {
    return res.status(400).json({ error: `工作目录不存在：${cwd}` });
  }

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();

  // 会话里存的模型可能是修复前的历史遗留值：那时所有会话都被写成了平台
  // 默认模型（claude-sonnet-4），对非 SDK Agent 来说那并不是用户的选择。
  // `resolveStoredModelForAgent` 还会把 Tencent SDK 清单里已下线的旧名回退成
  // undefined（不传 --model，交给 SDK 默认）。
  const resolvedModel = resolveStoredModelForAgent(
    agentId,
    model || session?.model || undefined
  );

  if (!session) {
    console.log(`[Chat] 创建新会话`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      // '' 表示「由 Agent 自行决定」—— model 列是 NOT NULL，
      // 而用平台默认值占位会把别的 Agent 的模型名谎报成它的模型
      model: resolvedModel ?? '',
      // 首条消息发出时才真正落库，此时必须带上 agentId，
      // 否则刷新后前端无法还原会话属于哪个 Agent
      agent_id: agentId,
      sdk_session_id: null,
      // 这个端点只服务一对一；群聊走 /api/group-chat
      kind: 'direct',
      agent_ids: null,
      orchestration: null,
      // P4：工作目录与场景绑定随首条消息落库（刷新后仍在）
      cwd: cwd || null,
      reasoning_effort: reasoningEffort || null,
      scenario_id: scenarioId || null,
      system_prompt: systemPrompt || null,
      // A220：项目归属必须与 `POST /api/sessions` 同源。项目入口新建的是前端
      // 本地空壳，首条消息才在这里落库；以前没写 project_id，而项目视图按
      // `s.projectId === selectedProject.id` 过滤（App.tsx），于是刚建的会话
      // 在下次启动 `backfillSessionProjects()` 之前根本不出现在项目里。
      // 走唯一推导入口：与回填共用 getOrCreateProject / 路径归一化，
      // cwd 为空时不建项目（纯问答不属于任何项目）；目录不存在已由本路由
      // 上方的 validateDirectory(cwd) === 'not-found' 挡成 400，不会走到这里。
      project_id: projectIdForCwd(cwd),
      created_at: now,
      updated_at: now,
    });
  } else {
    // 兼容历史数据/老会话：缺什么补什么，用户不必清库。
    // agent_id 决定 IM 身份层（头像/状态）；cwd / scenario / system_prompt 是 P4 新增，
    // 老会话为 NULL，首次带值对话时补上。
    const patch: Parameters<typeof db.updateSession>[1] = {};
    if (!session.agent_id && agentId) patch.agent_id = agentId;
    if (!session.cwd && cwd) patch.cwd = cwd;
    // 档位与 cwd 不同：它是**随时可改的会话设置**，不是「建会话时定死」。
    // 所以只要前端显式带了值就覆盖（含 null = 回到 CLI 默认），
    // 而不是 cwd 那种「只在为空时补」。
    if (reasoningEffort !== undefined) patch.reasoning_effort = reasoningEffort || null;
    if (!session.scenario_id && scenarioId) patch.scenario_id = scenarioId;
    if (!session.system_prompt && systemPrompt) patch.system_prompt = systemPrompt;
    if (Object.keys(patch).length > 0) {
      db.updateSession(session.id, patch);
      session = { ...session, ...patch };
    }
  }

  const selectedModel = resolvedModel;
  // A212：先对账再取令牌 —— 换根后旧令牌已被批量作废（含本会话行），本轮
  // 直接新建 CLI 会话，不把 `No conversation found` 暴露给用户。workbuddy
  // 之外的对账没有意义（水位线只属于 workbuddy），memo 短路后热路径零开销。
  const wbEpoch = agentId === 'workbuddy' ? reconcileWorkbuddyResumeTokens() : null;
  let resumeToken = wbEpoch && wbEpoch.invalidated > 0 ? null : session.sdk_session_id;

  // A123：生效顺序与 cwd / 档位一致 —— 请求体 > 会话里存的值 > 'default'。
  // 放在续接判定之前算，因为下面要用它决定「旧线程还能不能续」。
  const effectivePermissionMode = permissionMode || session.permission_mode || 'default';

  /**
   * Codex 的特殊约束：`codex exec resume` 没有 `--sandbox` 选项。
   *
   * 续接只能沿用**线程创建时**定下的沙箱，没法在 resume 时改档；而本应用
   * 允许每轮换权限档。所以创建线程时把当时的档位记在会话上，本轮档位与
   * 记录不一致就丢掉续接令牌、强制新建线程 —— 代价是丢一次上下文，换来
   * 「界面上选的权限 = 实际跑的沙箱」，而不是静默错配。
   *
   * 老库没有这一列（NULL）：按 'default' 兜底比较。早期会话绝大多数就是
   * 默认档，只有真换了档的才会被强制新建一次。
   *
   * 只管 codex：别的适配器每轮都能重新传权限参数，没必要为了记账丢上下文。
   */
  if (
    agentId === 'codex' &&
    resumeToken &&
    (session.sdk_thread_permission ?? 'default') !== effectivePermissionMode
  ) {
    console.log(
      `[Chat] Codex 权限档变更（${session.sdk_thread_permission ?? '未记录'} → ${effectivePermissionMode}），丢弃续接令牌并新建线程`
    );
    db.updateSession(session.id, {
      sdk_session_id: null,
      sdk_thread_permission: null,
    });
    resumeToken = null;
  }

  /**
   * A207：切模型 / 重发之前先确认「CLI 会话里是否留着没答完的指令」。
   *
   * 为什么必须挡在落库之前：确认请求一旦返回，这一轮就不存在 ——
   * 先写 user 消息再问，用户选「新建会话」时库里会多出一条没有对应回复的提问，
   * 刷新后就是新的悬空回合。
   *
   * 判定分两层：
   *   · 本地 chat.db 只看「最后一条助手消息是否失败」，健康会话不解锁额外开销；
   *   · opencode 能读到自己的会话库，就以它的结构为准（已答完的不打扰用户）。
   * 判定为权威的那份理由会写进确认文案，用户能看出是额度、超时还是别的原因。
   */
  // 'skip' = 用户跳过确认，按安全默认继续（等同新建会话，不续接旧 CLI 会话）
  const resumeChoice: 'continue' | 'fresh' | 'skip' | null =
    rawResumeChoice === 'fresh' || rawResumeChoice === 'skip'
      ? rawResumeChoice
      : rawResumeChoice === 'continue'
        ? 'continue'
        : null;

  let historyRows: db.DbMessage[] = [];
  try {
    historyRows = db.getMessagesBySession(session.id);
  } catch {
    historyRows = [];
  }

  let freshSummary = '';
  if (resumeToken && !resumeChoice && runHub.activeRuns().every(r => r.sessionId !== session.id)) {
    const dangling = findDanglingTurn(agentId, resumeToken, historyRows);
    if (dangling) {
      const preview =
        dangling.userText.replace(/\s+/g, ' ').trim().slice(0, 90)
        || '（无法读取指令原文）';
      const lastAssistant = [...historyRows].reverse().find(r => r.role === 'assistant');
      const fromModel = lastAssistant?.model || session.model || '';
      const modelChanged = !!fromModel && !!selectedModel && fromModel !== selectedModel;
      const effectiveCwd = cwd || session.cwd || process.cwd();
      // 归属目录只有 opencode 读得到；别的 CLI 拿不到就如实不提示，不瞎猜。
      const tokenCwd = agentId === 'opencode' ? opencodeSessionDirectory(resumeToken) : null;
      const cwdMismatch =
        tokenCwd && !sameDirectory(tokenCwd, effectiveCwd)
          ? { tokenCwd, sessionCwd: effectiveCwd }
          : null;

      const lines = [
        dangling.askTool
          ? '上一轮尝试向你提问，但问题没有送达（非交互运行），模型随后可能按自己的假设继续了。'
          : '这条会话的 CLI 里还留着一条没有得到完整回复的指令。直接续接时，新模型可能会把它当成待办事项重新执行。',
        `未完成的指令：${preview}`,
        `判定依据：${dangling.reason}`,
      ];
      if (modelChanged) {
        lines.push(`上一轮使用的模型是 ${fromModel}，本轮将使用 ${selectedModel}。`);
      }
      if (cwdMismatch) {
        lines.push(
          `该 CLI 会话属于目录 ${cwdMismatch.tokenCwd}，与当前工作目录 ${cwdMismatch.sessionCwd} 不一致。` +
          '本轮不会自动改写；新建会话会从当前工作目录开始。'
        );
      }
      // 契约：在用户作答之前，这一轮不会启动；任何选项都是显式选择，
      // 模型没有机会自己批准执行有副作用的操作。
      lines.push('在你作答前这一轮不会开始，也不会自动执行安装、删除、写入这类操作。');

      const recommendReason = cwdMismatch
        ? '该 CLI 会话属于另一个目录，续接会带上那个目录的上下文'
        : modelChanged
          ? '续接会把旧指令直接交给新模型，容易重放'
          : dangling.askTool
            ? '上一轮没等到你回答就继续了，续接可能再次越过确认'
            : '不续接旧 CLI 会话，旧指令不会被重放';

      console.log(`[Chat] 发现悬空 CLI 回合（${dangling.source}），等待用户确认`);
      return res.status(409).json({
        confirm: {
          kind: 'dangling-cli-turn',
          title: '上一轮指令未完成',
          detail: lines.join('\n'),
          userText: preview,
          reason: dangling.reason,
          source: dangling.source,
          askTool: dangling.askTool ?? null,
          modelChanged,
          fromModel: fromModel || null,
          toModel: selectedModel || null,
          cwdMismatch,
          /** 安全默认：不续接（避免旧指令被重放），并向用户说明依据 */
          recommended: 'fresh',
          recommendReason,
          options: [
            { action: 'continue', label: '继续那一条' },
            { action: 'fresh', label: '新建会话（带历史摘要）' },
            { action: 'skip', label: '跳过' },
          ],
        },
      });
    }
  }

  /**
   * 用户选了「新建会话」：清掉续接令牌，下一轮 CLI 自己起新会话。
   *
   * 只清令牌、不改 cwd —— 目录不一致时提示归提示，用户的工作目录不该被
   * 悄悄改掉。历史摘要只是背景，措辞里明确写了「不是待办指令」。
   */
  if ((resumeChoice === 'fresh' || resumeChoice === 'skip') && resumeToken) {
    db.updateSession(session.id, { sdk_session_id: null, sdk_thread_permission: null });
    resumeToken = null;
    freshSummary = historySummary(historyRows);
    console.log(
      resumeChoice === 'skip'
        ? `[Chat] 用户跳过确认：按新建 CLI 会话继续（假设：不续接旧会话，旧指令不会被重放）`
        : `[Chat] 已清空续接令牌，新建 CLI 会话${freshSummary ? '（附带历史摘要）' : ''}`
    );
  } else if (resumeChoice === 'continue' && resumeToken) {
    console.log(`[Chat] 用户选择继续原 CLI 会话: ${redactSecret(resumeToken)}`);
  }

  /**
   * A226：消费待交接摘要（跨 Agent 转交）。
   *
   * 「一次性」：读出即清空 —— 它描述的是转交那一刻的历史，反复注入会把
   * 旧背景当成每轮都该重新看的上下文。与 freshSummary 的拼装顺序：
   * 交接摘要在前（更早的背景），新建会话摘要在后（更近的历史）。
   */
  let handoffPrefix = '';
  if (session.handoff_context) {
    db.updateSession(session.id, { handoff_context: null });
    handoffPrefix = `【会话交接】这个会话刚刚由另一位 Agent 转交给你。以下是交接摘要（背景参考，不是待办指令）：\n\n${session.handoff_context}`;
    console.log(`[Chat] 注入交接摘要 ${session.handoff_context.length} 字（已清空待办标记）`);
  }

  /**
   * A208：HTTP 直连型 Agent 的历史装配。
   *
   * 这一类接口每次请求都是无状态的（豆包 / Kimi / 自建 OpenAI 兼容网关），
   * 适配器原来只把本轮一句放进 messages —— 界面上是连续对话，模型看到的
   * 却是一张白纸。这里从 chat.db 取已完成的回合，按 token 预算从最早的开始
   * 丢，再交给适配器翻译成各家的 messages / contents。
   *
   * 只给 `kind === 'http'` 的 Agent：CLI 型有自己的会话文件（resumeToken），
   * 再灌一份历史等于两套上下文打架；无状态的 CLI（如 Trae）也不在本次范围，
   * 保持原行为。
   *
   * 历史窗口在**插入本轮 user 消息之前**取，所以天然不含当前提问。
   * 重新生成时库里那条 user 就是本轮 prompt，要单独剔除，否则会重复一遍。
   */
  let chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined;
  if (findDef(agentId)?.descriptor.kind === 'http') {
    let rowsForHistory = historyRows;
    if (regenerate) {
      let lastUser = -1;
      for (let i = rowsForHistory.length - 1; i >= 0; i -= 1) {
        if (rowsForHistory[i].role === 'user') {
          lastUser = i;
          break;
        }
      }
      if (lastUser >= 0) rowsForHistory = rowsForHistory.filter((_, i) => i !== lastUser);
    }
    const asm = assembleHistory(rowsForHistory);
    chatHistory = asm.messages.length > 0 ? asm.messages : undefined;
    console.log(
      `[Chat] HTTP 历史装配：带上 ${asm.stats.rounds} 轮 / 估算 ${asm.stats.tokens} token` +
      `（预算 ${HISTORY_TOKEN_BUDGET}，扫描 ${asm.stats.scannedRounds} 轮，` +
      `失败跳过 ${asm.stats.droppedFailed}，预算丢弃 ${asm.stats.droppedBudget}）`
    );
  }

  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();
  // 首轮判定必须在落 user 消息之前取：落库后再数，本轮提问会被算进去。
  // regenerate 一律不注入 —— 那条提问已有历史，注入会让「重试」变成另一问。
  let isFirstTurn = false;
  try {
    isFirstTurn = !regenerate && db.getMessagesBySession(session.id).length === 0;
  } catch {
    isFirstTurn = false;
  }

  try {
    // 重新生成不重复落 user 消息：那条提问已在库里，再写一条会让刷新后的
    // 历史与界面不一致（界面只有一问，库里有两问）。
    if (!regenerate) {
      db.createMessage({
        id: userMessageId,
        session_id: session.id,
        role: 'user',
        content: message,
        model: null,
        // 用户消息没有作者 Agent
        author_agent_id: null,
        created_at: now,
        tool_calls: null,
      });
    } else if (replaceMessageId) {
      // 被顶掉的旧回复要真的删掉：只把新回复加在它后面，库里就会留下
      // 同一问的两条答案，且前端刷新后还多出一条用户没见过的历史。
      db.deleteMessage(replaceMessageId);
    }
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // C8：静默期心跳，唤醒前端 reader 的重连看门狗（注释帧，前端不解析）
  startSseHeartbeat(res);

  // 中止信号：客户端断开时通知适配器杀掉子进程
  //
  // 注意这里必须监听 res 而不是 req：对 POST 请求，req 的 'close' 在
  // **请求体被读完**时就触发了（express.json() 一读完就触发），根本等不到
  // 客户端真正断开 —— 实测会导致每次对话刚开始就被误判为「客户端断开」，
  // 子进程当场被杀、一个字都吐不出来。
  const ac = new AbortController();
  /**
   * 断线宽限（E5）。
   *
   * 以前客户端一断就立刻杀子进程 —— 于是「网络抖一下」等于「这次回答作废」。
   * 现在留 20 秒：前端可以用 `GET /api/runs/:id/stream?after=N` 接回来，
   * 期间事件一直进 runHub 的缓冲。宽限期内没人接才真的中止。
   * H-04：宽限值已搬 shared/timing.ts（REATTACH_GRACE_MS），群聊/工作流两处
   * 内联 20_000 也统一引用它——登记册「同语义不同形态」冲突项。
   */
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    console.log(`[Chat] 客户端断开，${REATTACH_GRACE_MS / 1000}s 内可重连`);
    const timer = setTimeout(() => {
      if (runHub.subscriberCount(runId) > 0) return; // 已经有人接回去了
      if (!ac.signal.aborted) {
        console.log(`[Chat] 重连窗口结束，中止 ${agentId}`);
        ac.abort();
        registry.abort(agentId, session!.id);
      }
    }, REATTACH_GRACE_MS);
    timer.unref?.();
  });

  /**
   * 本轮的事件投影器（E1）。
   *
   * 从这里开始，前端收到的不再是「一堆扁平事件」，而是 block 生命周期：
   *   block_open / block_delta / block_patch / block_close / run_end
   * 顺序、思考位置、工具配对全部由它一处决定 —— 群聊与刷新还原共用同一套。
   */
  const runId = uuidv4();
  // A210：t1 = 服务端收到请求的时刻；t0 由前端随 body 带来。
  // 必须先于 run_start，否则首个正文事件进来时还没有这一轮的旁路记录。
  beginRunTiming(runId, clientSentAt);
  /** 客户端是否已断开：断开后继续跑（等重连），但不再往死连接里写 */
  let clientGone = false;
  runHub.create(runId);
  // M01：run 台账落一行（「进行中的回合记中断」依赖它 —— 助手消息只在收尾
  // 落库，崩溃的回合没有任何痕迹可查）。台账失败绝不影响聊天主链路。
  try {
    db.markRunStarted(runId, session.id, agentId);
  } catch (e) {
    console.warn('[Runs] 台账落行失败（不影响对话）:', (e as Error).message);
  }
  // A122：界面上的「停止」按 runId 即时中止。断开宽限那条路要等 20 秒，
  // 而「停止」的语义是「现在就别跑了」——子进程继续跑等于继续花用户的额度。
  runHub.setAbortHandler(runId, () => {
    if (!ac.signal.aborted) ac.abort();
    registry.abort(agentId, session!.id);
  });
  const projector = new RunProjector({
    runId,
    sessionId: session.id,
    messageId: assistantMessageId,
    agentId,
    model: selectedModel,
    /* P1：把「真正生效的模型」显式盖章给前端回显。`selectedModel` 就是
       `resolveStoredModelForAgent()` 的结果，可能是被白名单换掉的默认值、
       也可能是空串（不传 --model，由 Agent 自己决定）。前端只认这个字段，
       不拿 `model` 元信息反推 —— 老夹具仍带 `model`，但不会触发回显。 */
    modelEffective: selectedModel ?? '',
    // A100：事件来源。纯文本解析出来的工具事件与 SDK 原生事件在界面上
    // 长得一样，必须让用户能分辨。
    source: registry.eventSourceOf(agentId),
    // P2：过程能力档的 key 是 (引擎 · 模型 · 网关)，不是 Agent —— 同一个 codex
    // 接官方模型与接第三方网关是两种事件形态。
    capabilities: runProfileOf(agentId, selectedModel),
  });

  /** 写一条 v2 事件：带 SSE id（断线重放按它续传） */
  const writeEvent = (event: RunEvent) => {
    // A210：t2 = 首个正文事件进入 SSE 的时刻。thinking / 工具块不算首字；
    // 客户端断线时事件仍会进 runHub 供重连重放，这个时间点同样是事实。
    if (isFirstContentEvent(event)) noteFirstContent(runId);
    if (!clientGone) {
      try {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        clientGone = true;
      }
    }
    publishRunEvent(event);
  };
  const writeEvents = (events: RunEvent[]) => {
    for (const e of events) writeEvent(e);
  };

  // 先发 run_start：前端据此把流式气泡挂到真正的 messageId 上。
  // 不能等 adapter 的 init —— 有的适配器要起进程几秒才吐第一行，
  // 那几秒里界面会停在「发送中」且无法挂载任何块。
  writeEvents(projector.push({ type: 'init', sessionId: session.id, model: selectedModel }));

  // A175：会话首轮把知识库 top-k 检索结果前置到这一轮的 prompt。
  // 只影响发给适配器的输入，**不改 message**（它已经在上面落库了）；
  // 失败/无库/无命中都不阻断对话，零命中只注入一行状态。
  const kbInjection = isFirstTurn ? buildKbInjection(session.id, message) : null;
  if (kbInjection) {
    writeEvent(projector.kbRefs(kbInjection.citations));
  }
  // A207：新建 CLI 会话时把历史摘要前置（仅背景，措辞已注明不是指令）。
  // 顺序：交接摘要 → 知识库前缀 → 历史摘要 → 本轮提问；三者都是纯文本，CLI 侧无结构要求。
  const backgroundParts = [handoffPrefix, freshSummary].filter(Boolean);
  const promptWithHistory = backgroundParts.length > 0 ? `${backgroundParts.join('\n\n')}\n\n${message}` : message;
  const promptForAgent = kbInjection ? `${kbInjection.promptPrefix}\n\n${promptWithHistory}` : promptWithHistory;

  let newResumeToken: string | null = null;
  // done 事件的载荷先攒着，等落库之后再发：客户端收到 run_end 常会立刻
  // 刷新会话，句子还没落库就会在这一瞬丢一条（与群聊 turn_done 同窗口）
  let donePayload: { durationMs?: number; cost?: number; tokens?: number } | null = null;
  let hadError = false;

  const stream = registry.stream(agentId, {
    sessionId: session.id,
    prompt: promptForAgent,
    systemPrompt,
    // A63：生效顺序 请求体 > 会话里存的值 > 后端进程目录。
    // 中间那一级是这轮补上的：前端每轮都会带 session.cwd，但万一哪个客户端
    // （或重新生成一类的内部路径）没带，会话里 PATCH 过的工作目录仍然该生效，
    // 而不是悄悄退回后端进程目录 —— 那正是「会话里改了工作区却不生效」的 bug。
    cwd: cwd || session.cwd || process.cwd(),
    // A98：记忆作用域**不做回落** —— 只认会话自己绑定的目录。
    // 上面那行为了工具能跑会退到 process.cwd()，但记忆不能跟着退：
    // 否则没绑目录的纯问答会话会吃进「后端进程所在仓库」的项目记忆。
    memoryCwd: session.cwd || undefined,
    model: selectedModel,
    // A62：档位值。老会话分支已经把本次请求 patch 进 session 了
    // （`session = { ...session, ...patch }`），所以这里读 session 即最新值；
    // 新会话分支则读请求体。`|| undefined` 把 '' → undefined，
    // 免得给 CLI 传一个空串档位。
    reasoningEffort: (session.reasoning_effort ?? undefined) || undefined,
    resumeToken,
    // A208：只有无状态 HTTP 适配器会用；CLI 适配器忽略
    history: chatHistory,
    // A123：生效顺序与 cwd / 档位一致 —— 请求体 > 会话里存的值 > 'default'。
    // 中间那一级是这轮补上的：以前这一档只活在请求体里，而前端读的是会话对象，
    // 于是「芯片显示全放行、发出去的是 default」—— 会话里存了也没人看。
    permissionMode: effectivePermissionMode,
    allowedTools: allowedToolsFor(scenarioId, session.scenario_id),
    signal: ac.signal,
  });

  if (!stream) {
    res.write(`data: ${JSON.stringify({ type: "error", message: `Agent ${agentId} 不可用` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    /* 必须补一条 run_end。
       上面 writeEvents(init) 已经把 run_start 发出去了，runHub 里这条 run 因此
       带着 sessionId 挂在 activeRuns 里；这里直接 return 会让它 finishedAt
       永远是 null —— 后台任务胶囊会一直显示「1 个运行中」，要等 MAX_AGE_MS
       （30 分钟）sweep 才消失。客户端多收一条 run_end 是正确行为：这一轮确实结束了。 */
    /* closes 也必须发：finish() 会把开着的块置为终态并生成 block_close，
       只发 .end 会让客户端的 thinking 块永远停在 streaming（永久转圈）。
       这个早退分支此刻通常还没有开着的块，但收尾契约不该在这里分岔。 */
    const early = projector.finish('error', undefined, takeRunTiming(runId) ?? undefined);
    writeEvents(early.closes);
    writeEvent(early.end);
    return res.end();
  }

  try {
    for await (const ev of stream) {
      // A217：零产出失败（initialize / 首字护栏超时）时，适配器要求作废它
      // 本轮刚写下的 cliSessionId —— 那个令牌对应的 CLI 转录是空的，下一轮
      // 拿它去 resume 会稳定报 "No conversation found with session ID"。
      // 只清「本轮写的」：newResumeToken 为空说明这轮没改过令牌，误清会把
      // 上一轮的有效上下文抹掉。控制事件不进投影器，界面上不会多出一块。
      if (ev.type === 'init' && ev.invalidateResumeToken) {
        if (newResumeToken) {
          db.updateSession(session.id, { sdk_session_id: null });
          console.log(`[Chat] A217：作废本轮半空续接令牌 ${redactSecret(newResumeToken)}`);
          newResumeToken = null;
        }
        continue;
      }

      // 续接令牌要在投影之前处理：它属于会话状态，不是可渲染的块
      if (ev.type === 'init' && ev.resumeToken && ev.resumeToken !== resumeToken) {
        newResumeToken = ev.resumeToken;
        db.updateSession(session.id, {
          sdk_session_id: ev.resumeToken,
          // 新建线程时把**实际生效**的权限档记下。Codex resume 没有 sandbox
          // 选项，下一轮只能靠这条记录判断「档位变了就得新建线程」。
          ...(agentId === 'codex'
            ? { sdk_thread_permission: effectivePermissionMode }
            : {}),
        });
        console.log(`[Chat] 已保存续接令牌: ${redactSecret(ev.resumeToken)}`);
      }

      if (ev.type === 'done') {
        donePayload = { durationMs: ev.durationMs, cost: ev.cost, tokens: ev.tokens };
      }

      if (ev.type === 'error') {
        hadError = true;
        console.error(`[Chat] ${agentId} 报错: ${ev.message}`);
        registry.recordError(agentId, ev.message);
        // 401/凭据失效 → 名册不该继续挂「在线」：立刻 force re-probe 一次
        maybeReprobeOnAuthError(agentId, ev.message);
      }

      writeEvents(projector.push(ev));
    }
  } catch (error: any) {
    hadError = true;
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Name:`, error?.name);
    console.error(`[Chat] Error Message:`, error?.message);
    console.error(`[Chat] Error Stack:`, error?.stack);
    registry.recordError(agentId, error?.message || String(error));
    // 抛出型失败同样可能是鉴权错误（SDK 在握手期直接 throw 401）
    maybeReprobeOnAuthError(agentId, error?.message || String(error));
    writeEvents(
      projector.push({ type: 'error', message: error?.message || "处理请求时发生错误" })
    );
  }

  // 收尾：关闭所有打开的块（文本/思考/工具），先于落库
  const runStatus = ac.signal.aborted ? 'aborted' : hadError ? 'error' : 'ok';
  // M01：run 台账收行（ok→finished / error→failed / aborted→stopped）。
  // 只有走到这里的 run 才有"正常结束"可言；harness 崩溃走不到，由下次启动清算成 interrupted。
  try {
    db.markRunFinished(runId, runStatus === 'ok' ? 'finished' : runStatus === 'error' ? 'failed' : 'stopped');
  } catch (e) {
    console.warn('[Runs] 台账收行失败（不影响对话）:', (e as Error).message);
  }
  // A210：取走这一轮的服务端时间戳挂到 run_end 上。取走即清理，
  // 不留残骸；没有正文时 t2=null，前端据此显示「—」而不是 0ms。
  const { closes, end } = projector.finish(
    runStatus,
    donePayload ?? undefined,
    takeRunTiming(runId) ?? undefined
  );
  writeEvents(closes);

  // 落库助手消息（E2：整条块序列一次写入，刷新后与流式中同一份数据）
  // 中止且一个字都没产出时不要落库：否则界面上会多出一个空气泡，
  // 刷新后也还在（用户只会看到一条没有内容的「回复」）。
  const blocks = projector.blockList;
  const abortedEmpty = ac.signal.aborted && blocks.length === 0;
  if (abortedEmpty) {
    console.log(`[Chat] ${agentId} 被中止且无产出，跳过落库`);
  } else try {
    const toolCalls = toolCallsOfBlocks(blocks);
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      // content 仍是纯文本摘要（列表预览、搜索、老组件都靠它）
      // A206：失败回合往往只有错误块、没有正文，这里用错误文案兜底，
      // 否则列表预览/老组件看到的是一条空白消息。
      content: textOfBlocks(blocks) || errorTextOfBlocks(blocks),
      // 未指定模型时记 null（而不是把平台默认值写进去冒充它的模型）
      model: selectedModel ?? null,
      // 一对一里这个端点固定只服务一个 Agent，直接记下它；
      // 群聊时同一会话会有多个作者，由编排引擎逐个写入
      author_agent_id: agentId,
      created_at: new Date().toISOString(),
      // tool_calls 保留：老版本前端/导出逻辑仍读它
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      // 真正驱动渲染的是这一列（顺序、思考位置、工具状态都在里面）
      blocks: blocks.length > 0 ? JSON.stringify(blocks) : null,
      // P6 成本统计：耗时/费用/token 跟着这条消息一起落库。
      duration_ms: donePayload?.durationMs ?? null,
      cost: donePayload?.cost ?? null,
      tokens: donePayload?.tokens ?? null,
    });

    // A39：技能自动沉淀。放在落库之后 —— 只有**真正留下来的**轨迹才值得学。
    // 整段包 try：它只是聊天流程的副产品，任何一个异常都不该让这轮回复失败。
    try {
      const r = distillSkill({
        prompt: message,
        blocks,
        durationMs: donePayload?.durationMs ?? null,
        agentId,
        aborted: ac.signal.aborted,
        hadError,
      });
      if (r.status === 'created') console.log(`[Skill] 沉淀新技能：${r.name}`);
      else if (r.status === 'reused') console.log(`[Skill] 命中已有技能：${r.name}（第 ${r.uses} 次）`);
    } catch (e: any) {
      console.error('[Skill] 沉淀失败（不影响聊天）:', e?.message ?? e);
    }

    const messages = db.getMessagesBySession(session.id);
    // 重新生成不改标题：那条权重判据只对「新会话的第一轮」有意义
    if (!regenerate && messages.length <= 2) {
      db.updateSession(session.id, {
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel,
      });
    }
  } catch (dbError: any) {
    console.error(`[Chat] 保存助手消息失败:`, dbError);
  }

  // 落库之后才发 run_end：客户端收到它可能立刻刷新会话
  // P2：能力档的 observed 只在 run_end 上是事实，跟着这一条一起落库。
  if (end.type === 'run_end' && end.capabilities) {
    try {
      db.saveCapabilityProfile(end.capabilities);
    } catch (e: any) {
      // 能力档是过程统计，写失败不该让已经完成的这一轮变成失败
      console.error('[Capability] 保存观测结果失败:', e?.message ?? e);
    }
  }
  writeEvent(end);

  console.log(`[Chat] 请求完成 ✓ (${agentId})`);
  res.end();
});

/**
 * 后台任务：还在跑、但用户可能已经离开的那些 run（A36）。
 *
 * 只读、无副作用。前端每 5 秒拉一次，用它在消息列表底部显示
 * 「N 个后台任务运行中」——在此之前，切到别的会话之后，原来那轮
 * 是死是活界面上完全看不出来。
 *
 * 注意路由顺序：这条必须写在 `/api/runs/:runId/stream` **之前**也没关系
 * （路径段数不同，不会互相吞），但放在一起更便于对照阅读。
 */
/**
 * 记忆总览：MEMORY / USER / skills 列表 + 预算统计。
 *
 * A98：带 `?cwd=` 时额外返回 `project` 段（该项目的记忆与统计）。
 * **顶层字段仍然只表示全局层** —— 这样既有的设置页一行都不用改，
 * 新增的项目层由前端按需读取。
 */
app.get("/api/memory", (req, res) => {
  try {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    const project = projectScope(cwd);
    res.json({
      core: readCoreMemory(),
      user: readUserProfile(),
      skills: listSkills().map(s => ({ name: s.name, title: s.title, tokens: s.tokens })),
      stats: memoryStats(),
      project: project
        ? {
            cwd,
            key: project.key,
            name: getProjectByPath(cwd)?.name ?? cwd,
            core: readCoreMemory(cwd),
            skills: listSkills(cwd)
              .filter(s => s.scope === "project")
              .map(s => ({ name: s.name, title: s.title, tokens: s.tokens })),
            stats: projectMemoryStats(cwd),
          }
        : null,
    });
  } catch (error: any) {
    console.error("[Memory] read error:", error);
    res.status(500).json({ error: error?.message || "读取记忆失败" });
  }
});

/**
 * 保存 MEMORY / USER。
 *
 * 超预算**照样保存**、只在注入时截断：在保存时就砍内容，
 * 用户会在编辑框里静默丢掉刚写的后半段（Hermes 也是冻结快照语义）。
 *
 * A98：`scope: 'project'` + `cwd` 时写项目层。**默认仍是 global** ——
 * 老前端不传 scope 的行为必须一字不差，否则用户在设置页存一次全局记忆
 * 会莫名其妙写进某个项目里。
 * `user`（画像）不接受项目作用域：它描述「这个人」，不随仓库变。
 */
app.put("/api/memory", (req, res) => {
  try {
    const { core, user, cwd, scope } = req.body ?? {};
    const isProject = scope === "project";
    if (isProject && (typeof cwd !== "string" || !cwd.trim())) {
      res.status(400).json({ error: "scope=project 时必须提供 cwd" });
      return;
    }
    const out: Record<string, unknown> = {};
    if (typeof core === "string") out.core = writeCoreMemory(core, isProject ? cwd : null);
    if (typeof user === "string") out.user = writeUserProfile(user);
    res.json({
      ok: true,
      ...out,
      stats: memoryStats(),
      projectStats: isProject ? projectMemoryStats(cwd) : null,
    });
  } catch (error: any) {
    console.error("[Memory] write error:", error);
    res.status(500).json({ error: error?.message || "保存记忆失败" });
  }
});

/** 全文检索（FTS5）。查询词做语法转义，输入减号也不会炸。 */
app.post("/api/memory/search", (req, res) => {
  try {
    const { query, limit, cwd } = req.body ?? {};
    if (typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "query 不能为空" });
      return;
    }
    // 带 cwd 时搜「全局 + 该项目」；不带只搜全局（见 searchMemory 的说明）
    const hits = searchMemory(query, Math.min(Number(limit) || 10, 50), typeof cwd === "string" ? cwd : null);
    res.json({ hits });
  } catch (error: any) {
    console.error("[Memory] search error:", error);
    res.status(500).json({ error: error?.message || "检索失败" });
  }
});

const skillCwd = (req: { query: Record<string, unknown>; body?: any }): string | null => {
  const fromQuery = typeof req.query.cwd === "string" ? req.query.cwd : "";
  const fromBody = typeof req.body?.cwd === "string" ? req.body.cwd : "";
  return fromQuery || fromBody || null;
};

app.get("/api/memory/skills/:name", (req, res) => {
  const skill = readSkill(req.params.name, skillCwd(req));
  if (!skill) {
    res.status(404).json({ error: "技能不存在" });
    return;
  }
  res.json(skill);
});

app.put("/api/memory/skills/:name", (req, res) => {
  const { body } = req.body ?? {};
  if (typeof body !== "string") {
    res.status(400).json({ error: "body 不能为空" });
    return;
  }
  const r = writeSkill(req.params.name, body, skillCwd(req));
  if ("error" in r) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, name: r.name, stats: memoryStats() });
});

app.delete("/api/memory/skills/:name", (req, res) => {
  if (!deleteSkill(req.params.name, skillCwd(req))) {
    res.status(404).json({ error: "技能不存在" });
    return;
  }
  res.json({ ok: true, stats: memoryStats() });
});

// ── 扩展（A164）──────────────────────────────────────────────────────────
//
// 只读用户目录、只写自己的库。**删除只删 OPC 的副本，源文件一律不动。**
// kind 只认 skill / mcp，非法值一律 400 —— 不静默纠正（见 AGENTS.md §2 的四步法）。

function parseExtKind(raw: string): ExtensionKind | null {
  return raw === "skill" || raw === "mcp" ? raw : null;
}

app.get("/api/extensions", (_req, res) => {
  const items = extListItems().map(it => {
    const sources = extListSources(it.id);
    /* 「还有几个 Agent 真的能收到」：通道 × 本机实存目录 × 差集（不由自己持有）。
       0 ⇒ 开关置灰。口径见 server/extensions/targets.ts 的 distributableTargetCount。 */
    const targetCount = extDistributableTargetCount({
      kind: it.kind,
      presentAgentIds: sources.map(s => s.agentId),
    });
    return {
      ...it,
      sources,
      sourceCount: sources.length,
      targetCount,
      distributable: targetCount > 0,
    };
  });
  res.json({
    items,
    stats: extStats(),
    // 15 个 Agent 的完整清单（含没有技能目录的），前端按它渲染矩阵
    targets: EXT_TARGETS,
    modeLabel: EXT_MODE_LABEL,
    /* 六档状态的 label / rank / available / tone / hint。
       **排序键只在数据层定义一处**：前端按 rank 分组，不自己写状态顺序。 */
    matrixStates: EXT_MATRIX_STATES,
  });
});

/* 分发预览（P2）：告诉界面「这条会被送进哪些 Agent、以什么形态」。
   只读 —— 真正的配置文件在发消息时生成（见 distribute.ts）。

   ⚠️ 必须注册在 `/api/extensions/:kind/:name` **之前**：否则 Express 会把它
   当成 kind='distribute' / name='preview' 匹配走，parseExtKind 直接 400。 */
app.get("/api/extensions/distribute/preview", (req, res) => {
  const agentId = safeAgentId(req.query.agentId);
  if (!agentId) {
    res.status(400).json({ error: "缺少或非法 agentId" });
    return;
  }
  try {
    /* 预览会实际生成 `data/extensions/mcp-<agentId>.json` —— 调用方（qoder 启动）
       需要这个文件路径，而不仅仅是 servers 映射。写盘路径由 `safeAgentId` 约束
       只能落在 dataDir 内（原来的路径穿越缺陷已修）。 */
    const r = buildMcpConfig(agentId);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "生成分发预览失败" });
  }
});

/* ══════════ A168 / P4：差异检测（本机源文件 vs OPC 库）══════════
 *
 * `GET` 只读扫描，`POST /apply` 逐条应用（走与全量导入同一套判定）。
 *
 * ⚠️ 两条都**必须注册在 `/api/extensions/:kind/:name` 之前**：否则 `drift`
 * 会被当成 `kind` 匹配走，`parseExtKind` 直接 400 —— 表现为「差异接口永远
 * 返回 400，看着像参数写错了」。（`distribute/preview` 踩过同一个坑。）
 */
app.get("/api/extensions/drift", (_req, res) => {
  try {
    res.json(extScanDrift());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "扫描差异失败" });
  }
});

app.post("/api/extensions/drift/apply", (req, res) => {
  const raw = (req.body ?? {}).entries;
  if (!Array.isArray(raw) || raw.length === 0) {
    res.status(400).json({ error: "entries 必须是非空数组" });
    return;
  }
  if (raw.length > 200) {
    res.status(400).json({ error: "一次最多应用 200 条" });
    return;
  }
  const entries: Array<{ kind: "skill" | "mcp"; name: string }> = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    const kind = parseExtKind(typeof e?.kind === "string" ? e.kind : "");
    if (!kind) {
      res.status(400).json({ error: `kind 只能是 skill 或 mcp：${String(e?.kind)}` });
      return;
    }
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name 不能为空" });
      return;
    }
    entries.push({ kind, name });
  }
  try {
    res.json(extApplyDrift(entries));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "应用差异失败" });
  }
});

app.get("/api/extensions/:kind/:name", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  const item = extFindItem(kind, req.params.name);
  if (!item) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  res.json({
    item,
    sources: extListSources(item.id),
    targets: extListTargets(item.id),
    modeLabel: EXT_MODE_LABEL,
  });
});

app.put("/api/extensions/:kind/:name", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  const b = req.body ?? {};
  const patch: { body?: string; title?: string; description?: string; configJson?: string } = {};
  // 逐字段判存在：`undefined` = 不动，传空串 = 明确清空（与 updateSession 同一口径）
  if (typeof b.body === "string") {
    /* 正文（技能）过敏感扫描：命中则置空并带 blockedReason，与导入时的口径一致。
       PUT 编辑是用户主动写副本，但副本也不能存密钥 —— 否则本地数据库就是密钥库。
       接口响应里也必须把命中情况告诉用户，不然他会以为保存成功、实则内容被清了。 */
    const hits = scanSensitive(b.body);
    if (hits.length > 0) {
      patch.body = ""; // 置空，不存原文
      // 同时 title/description 如果也带敏感内容一并清（与 skillPayload blocked 口径对齐）
      if (typeof b.title === "string" && scanSensitive(b.title).length > 0) patch.title = "";
      if (typeof b.description === "string" && scanSensitive(b.description).length > 0) patch.description = "";
      const updated = extUpdateLocal(kind, req.params.name, patch);
      res.status(400).json({
        error: "正文命中敏感内容，已拒绝落库",
        hits,
        item: updated,
      });
      return;
    }
    patch.body = b.body;
  }
  if (typeof b.title === "string") patch.title = b.title;
  if (typeof b.description === "string") patch.description = b.description;
  if (typeof b.configJson === "string") {
    // MCP 配置必须是合法 JSON，否则存进去界面就打不开了
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(b.configJson);
    } catch {
      res.status(400).json({ error: "configJson 不是合法 JSON" });
      return;
    }
    /* MCP 配置走 redactConfig 深度脱敏：value 命中敏感规则换成 `***`（不是拒绝），
       与导入口径一致——MCP 结构需要保留才能用，只是密钥不能明文存库。 */
    const { config, hits } = redactConfig(parsed);
    patch.configJson = JSON.stringify(config, null, 2);
    if (hits.length > 0) {
      const updated = extUpdateLocal(kind, req.params.name, patch);
      res.json({ ok: true, item: updated, redacted: true, hits });
      return;
    }
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "没有可更新的字段" });
    return;
  }
  const updated = extUpdateLocal(kind, req.params.name, patch);
  if (!updated) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  res.json({ ok: true, item: updated });
});

app.delete("/api/extensions/:kind/:name", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  if (!extDeleteItem(kind, req.params.name)) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  res.json({ ok: true, stats: extStats() });
});

/* ══════════ B：enabled 开关（单条 + 整批）══════════
 *
 * 关闭后：
 * - 技能：`skillsForAgent()` 遍历条目时会跳过 `!enabled` 的（注入层已实现）
 * - MCP：`buildMcpConfig()` 遍历条目时会跳过 `!enabled` 的（分发层已实现）
 * - 会话启动时 argv / systemPrompt 里不会出现这条，省 token、省运行开销
 *
 * 两个路由同时支持 `PATCH /.../enabled`（单条）和 `PATCH /.../kind-enabled`（整批），
 * 前者在详情页的单条开关触发，后者在列表页的 kind 级开关触发。 */
app.patch("/api/extensions/:kind/:name/enabled", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  const on = !!(req.body && req.body.enabled);
  const updated = extToggleEnabled(kind, req.params.name, on);
  if (!updated) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  res.json({ ok: true, item: updated });
});

app.patch("/api/extensions/:kind/kind-enabled", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  const on = !!(req.body && req.body.enabled);
  /* 只改有分发目标的条目；`skipped` 是无目标被跳过的数量，
     由前端翻译成「已跳过 N 条无可分发」——静默跳过等于假装改过了。 */
  const { changed, skipped } = extToggleKindEnabled(kind, on);
  res.json({ ok: true, kind, enabled: on, changed, skipped, stats: extStats() });
});

app.post("/api/extensions/import", (_req, res) => {
  try {
    res.json(extRunImport());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "导入失败" });
  }
});

app.post("/api/extensions/:kind/:name/refresh", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  const r = extRefreshItem(kind, req.params.name);
  const item = extFindItem(kind, req.params.name);
  res.json({ ...r, item, targets: item ? extListTargets(item.id) : [] });
});

// 冲突三选一里的「用源的覆盖」
app.post("/api/extensions/:kind/:name/accept-source", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  /* 顺序：先**只读**确认源还在磁盘上 → 清 locally_modified → refreshItem。
     旧顺序是 accept → refresh：accept 先清标志，refresh 再换正文。但如果 refresh
     因「源没了」返回 missing，用户的本地编辑已经丢了。
     新顺序必须分三步：
     1. 先只查源文件在不在（读盘，不写库）；
     2. 源不在 → 409，保留本地编辑让用户自己决定；
     3. 源在 → 清 locally_modified → refreshItem 把正文换成源的样子。
     这样 importOne 就不会因 locally_modified=1 返回 conflict 了。 */
  const item = extFindItem(kind, req.params.name);
  if (!item) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  const sources = extListSources(item.id);
  if (sources.length === 0) {
    res.status(409).json({ ok: false, error: '没有来源记录' });
    return;
  }
  // 只读验证源还在（不碰库）
  let sourcePresent = false;
  try {
    if (kind === 'skill') {
      for (const s of sources) {
        const fp = path.join(s.path, 'SKILL.md');
        if (fs.existsSync(fp)) { sourcePresent = true; break; }
      }
    } else {
      // MCP：重扫一遍配置文件看这条名字还在不在
      const all = scanAllMcp();
      sourcePresent = all.some(m => m.name === req.params.name);
    }
  } catch { /* 异常算源不在，保守点 */ }
  if (!sourcePresent) {
    res.status(409).json({ ok: false, error: '源文件已不在磁盘上，无法接受源覆盖' });
    return;
  }
  if (!extAcceptSource(kind, req.params.name)) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  const r = extRefreshItem(kind, req.params.name);
  const updated = extFindItem(kind, req.params.name);
  res.json({ ok: true, ...r, item: updated });
});

/* ══════════ A166 / P1：归一化（预览 → 逐条确认 → 回滚）══════════
 *
 * 三步分开是刻意的：**归一化绝不自动应用**（PLAN-EXTENSIONS.md §8.3）。
 * 预览是纯函数，不碰库；应用要用户明确传 `accepted`；
 * 回滚靠 `body_original` 这一列。
 *
 * 只有技能有正文，MCP 是配置（归一化对它没有意义）—— 对 mcp 一律 400，
 * 不静默返回空 diff（那会让前端以为「这条不需要归一化」）。
 */
app.get("/api/extensions/:kind/:name/normalize", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  if (kind !== "skill") {
    res.status(400).json({ error: "只有技能正文可以归一化，MCP 是配置不是正文" });
    return;
  }
  const item = extFindItem(kind, req.params.name);
  if (!item) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  if (item.body == null) {
    res.status(409).json({
      error: "这条没有正文可归一化",
      reason: item.blocked ? "命中敏感内容，正文未落库" : "正文为空",
    });
    return;
  }
  const r = normalizeSkillBody(item.body, item.name);
  res.json({
    changed: r.changed,
    hits: r.hits,
    summary: r.summary,
    // 全文预览（前端可以直接铺 diff 视图）
    preview: r.text,
    // 已经归一化过的话告诉前端「能回滚」
    hasOriginal: item.bodyOriginal != null,
  });
});

app.post("/api/extensions/:kind/:name/normalize", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  if (kind !== "skill") {
    res.status(400).json({ error: "只有技能正文可以归一化，MCP 是配置不是正文" });
    return;
  }
  const item = extFindItem(kind, req.params.name);
  if (!item) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  if (item.body == null) {
    res.status(409).json({ error: "这条没有正文可归一化" });
    return;
  }
  const r = normalizeSkillBody(item.body, item.name);
  if (!r.changed) {
    res.status(409).json({ error: "没有可归一化的内容", summary: r.summary });
    return;
  }
  /* `accepted` 是 hit 的下标数组（「逐条确认」）；不传 = 全部接受。
     传了空数组是明确错误 —— 那等于「点了接受但一条都不选」，
     静默写回原文会让用户以为操作成功。 */
  const body = req.body ?? {};
  let selected: number[] | undefined;
  if (Array.isArray(body.accepted)) {
    const list: number[] = body.accepted
      .filter((n: unknown) => Number.isInteger(n))
      .map(Number);
    if (list.length === 0) {
      res.status(400).json({ error: "accepted 为空数组：没有选中任何一条" });
      return;
    }
    const bad = list.find((n: number) => n < 0 || n >= r.hits.length);
    if (bad !== undefined) {
      res.status(400).json({ error: `accepted 下标越界：${bad}（共 ${r.hits.length} 条）` });
      return;
    }
    /* 去重：`accepted: [0,0]` 只改 1 条，`applied` 也必须报 1。
       报数字比实际做的多是「撒谎」，用户会以为漏改了。 */
    selected = [...new Set(list)];
  }
  const nextBody = extApplyHits(item.body, r.hits, selected);
  const updated = extApplyNormalized(kind, req.params.name, nextBody);
  res.json({ ok: true, applied: selected ? selected.length : r.hits.length, item: updated });
});

app.post("/api/extensions/:kind/:name/revert-normalize", (req, res) => {
  const kind = parseExtKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind 只能是 skill 或 mcp" });
    return;
  }
  const item = extFindItem(kind, req.params.name);
  if (!item) {
    res.status(404).json({ error: "扩展不存在" });
    return;
  }
  if (item.bodyOriginal == null) {
    res.status(409).json({ error: "这条没有归一化记录，无可回滚" });
    return;
  }
  res.json({ ok: true, item: extRevertNormalized(kind, req.params.name) });
});

// ── 项目（A98）──────────────────────────────────────────────────────────
//
// 项目由「目录」唯一确定：path 存归一化后的路径，同一个目录永远只有一行。
// 前端不需要先建项目再用 —— POST 一个路径就会「取或建」。

app.get("/api/projects", (_req, res) => {
  try {
    const projects = listProjects();
    // 顺带带上每个项目的会话数，前端分组时不用再逐个项目查一遍
    const counts = new Map<string, number>();
    for (const s of db.getAllSessions()) {
      if (s.project_id) counts.set(s.project_id, (counts.get(s.project_id) ?? 0) + 1);
    }
    res.json({
      projects: projects.map(p => ({
        ...p,
        sessionCount: counts.get(p.id) ?? 0,
        memory: projectMemoryStats(p.path),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "读取项目失败" });
  }
});

app.post("/api/projects", (req, res) => {
  const { cwd, name } = req.body ?? {};
  if (typeof cwd !== "string" || !cwd.trim()) {
    res.status(400).json({ error: "cwd 不能为空" });
    return;
  }
  // 与建会话时同一把尺子：不存在的目录不落库
  if (validateDirectory(cwd) === "not-found") {
    res.status(400).json({ error: `工作目录不存在：${cwd}` });
    return;
  }
  const project = getOrCreateProject(cwd, typeof name === "string" ? name : undefined);
  if (!project) {
    res.status(400).json({ error: "无法从该路径推导项目" });
    return;
  }
  res.json({ project });
});

app.patch("/api/projects/:id", (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name 不能为空" });
    return;
  }
  if (!renameProject(req.params.id, name)) {
    res.status(404).json({ error: "项目不存在" });
    return;
  }
  res.json({ ok: true, project: getProject(req.params.id) });
});

app.delete("/api/projects/:id", (req, res) => {
  // 只删项目行并解绑会话，**不删记忆文件** —— 那是用户的真实内容。
  // 项目任务会被外键级联删掉（PRAGMA foreign_keys 已开）：任务是「这个项目
  // 还要做什么」，项目没了它就没有归属，留着只会变成查不到的孤儿行。
  if (!deleteProject(req.params.id)) {
    res.status(404).json({ error: "项目不存在" });
    return;
  }
  res.json({ ok: true });
});

// ── 项目任务（A119）──────────────────────────────────────────────────────
//
// 挂在项目下而不是会话下：任务跨会话存在，绑会话会随会话删除一起消失。
// 状态三档 todo / doing / done，非法值一律 400 —— 见 updateProjectTask 的注释。

app.get("/api/projects/:id/tasks", (req, res) => {
  // 项目不存在时给 404 而不是空数组：空数组会让界面显示「还没有任务」，
  // 用户以为自己删光了，实际是深链指向了一个已删的项目。
  if (!getProject(req.params.id)) {
    res.status(404).json({ error: "项目不存在" });
    return;
  }
  res.json({ tasks: listProjectTasks(req.params.id) });
});

app.post("/api/projects/:id/tasks", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!title) {
    res.status(400).json({ error: "任务内容不能为空" });
    return;
  }
  if (!getProject(req.params.id)) {
    res.status(404).json({ error: "项目不存在" });
    return;
  }
  res.json({ task: createProjectTask(req.params.id, title) });
});

app.patch("/api/tasks/:taskId", (req, res) => {
  const { title, status } = req.body ?? {};
  if (status !== undefined && !isProjectTaskStatus(status)) {
    res.status(400).json({ error: `无效的任务状态：${String(status)}` });
    return;
  }
  // A229：指派 / 改派。**不校验** agentId 是否在名册里——名册是动态的，
  // 指给一个「还没装」的 Agent 是合法的排班动作，装好即生效。
  const assignee =
    req.body?.assigneeAgentId === null
      ? null // 明确传 null = 撤销指派
      : typeof req.body?.assigneeAgentId === "string" && req.body.assigneeAgentId.trim()
        ? req.body.assigneeAgentId.trim()
        : undefined; // 不传 = 不动
  const task = updateProjectTask(req.params.taskId, {
    title: typeof title === "string" ? title : undefined,
    status,
    assignee,
  });
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ task });
});

app.delete("/api/tasks/:taskId", (req, res) => {
  if (!deleteProjectTask(req.params.taskId)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ ok: true });
});

/** 手动重建索引（改坏了索引或外部动过 skills/ 时用）。 */
app.post("/api/memory/reindex", (_req, res) => {
  try {
    res.json({ ok: true, ...reindexMemory(), stats: memoryStats() });
  } catch (error: any) {
    console.error("[Memory] reindex error:", error);
    res.status(500).json({ error: error?.message || "重建索引失败" });
  }
});

/** 权限规则读取（A40）。 */
app.get("/api/permission-rules", (_req, res) => {
  try {
    res.json({ rules: loadPermissionRules(), note: BUILTIN_NOTE, path: PERMISSION_RULES_PATH });
  } catch (error: any) {
    console.error("[PermissionRules] read error:", error);
    res.status(500).json({ error: error?.message || "读取权限规则失败" });
  }
});

/** 权限规则保存。整份覆盖提交（规则量小，不必做增量）。 */
app.put("/api/permission-rules", (req, res) => {
  try {
    const rules = savePermissionRules(req.body?.rules ?? []);
    res.json({ ok: true, rules });
  } catch (error: any) {
    console.error("[PermissionRules] write error:", error);
    res.status(500).json({ error: error?.message || "保存权限规则失败" });
  }
});

app.get("/api/runs/active", (req, res) => {
  const exclude = typeof req.query.exclude === "string" ? req.query.exclude : "";
  const runs = runHub.activeRuns().filter(r => r.sessionId !== exclude);
  res.json({ runs });
});

/**
 * 即时停止一个还在跑的 run（A122）。
 *
 * 为什么必须有这么一个接口，而不是让前端直接把 fetch 掐掉：
 * 断线后的子进程**故意**继续跑 20 秒（E5 的断线宽限，为了网络抖动时能接回来），
 * 而「点了停止」不是网络抖动 —— 让它等 20 秒等于用户的 Agent 还在改文件、还在烧额度。
 *
 * 语义：只对「还在跑且注册过中止动作」的 run 有效。已结束 / 不存在的 run 回 404，
 * 因为这里没有任何东西可停；不返回 200 假装成功，否则前端会以为停过了一次已结束的对话。
 */
app.post("/api/runs/:runId/stop", (req, res) => {
  const { runId } = req.params;
  const stopped = runHub.stop(runId);
  if (!stopped) {
    return res.status(404).json({ error: "该运行已结束或不存在，无需中止" });
  }
  console.log(`[Stop] 已中止 run ${runId}`);
  res.json({ ok: true, runId });
});

/**
 * 断线重放的流端点（E5）。
 *
 * 前端在流中断后带着 `after=<最后收到的 seq>` 重新连上来：
 *   - 缓冲里还有这段 → 补发缺的事件
 *   - 已经滚出缓冲 → 只发 snapshot（当前全部块，已覆盖到最新 seq）；再回放缓冲会重复正文
 *   - run 已过期/不存在 → 404，前端退回「重新拉一次会话」
 *
 * 与 POST 的区别：这里只读，不触发任何 Agent 调用，也不会因为断开而中止运行。
 */
app.get("/api/runs/:runId/stream", (req, res) => {
  const { runId } = req.params;
  const after = Number(req.query.after) || 0;

  const backlog = runHub.replay(runId, after);
  if (!backlog) {
    return res.status(404).json({ error: "该运行已结束或不存在" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  startSseHeartbeat(res);

  let closed = false;
  const write = (ev: RunEvent) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    } catch {
      closed = true;
    }
  };

  for (const ev of backlog) write(ev);

  if (runHub.isFinished(runId)) {
    res.end();
    return;
  }

  let unsubscribe: (() => void) | null = null;
  const cleanup = () => {
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  unsubscribe = runHub.subscribe(runId, ev => {
    write(ev);
    if (ev.type === 'run_end') {
      cleanup();
      if (!res.writableEnded) res.end();
    }
  });

  // 订阅失败（run 在 replay 与 subscribe 之间被清理）：直接结束，前端会走 404 兜底
  if (!unsubscribe) {
    res.end();
    return;
  }

  res.on('close', cleanup);
});

/**
 * 群聊编排端点。
 *
 * 与 /api/chat 的分工：那个端点服务一对一（单 Agent、可续接上下文）；
 * 这个端点服务群聊（多 Agent、按编排模式调度、不做上下文续接）。
 * 两者共用同一套 AgentEvent 协议，只是群聊的每个内容事件都多带一个
 * `agentId`，前端据此把不同 Agent 的输出分流到各自的流式气泡里。
 *
 * 新增的 SSE 事件（一对一里不会出现）：
 *   group_init  —— 开场：成员名单与编排模式
 *   turn_start  —— 某个 Agent 开始发言（前端新建一个气泡）
 *   turn_done   —— 该 Agent 发言结束
 *   group_note  —— 编排过程说明（谁被跳过、主控选了谁、第几棒）
 */
app.post("/api/group-chat", async (req, res) => {
  const {
    sessionId,
    message,
    agentIds = [],
    orchestration = 'dispatch',
    model,
    cwd,
    // A62：思考强度档位。群聊的每个成员都可能是 CLI Agent，
    // 这一档对它们同样成立（档位表不同，见 modelCatalog）
    reasoningEffort,
    permissionMode,
    // P4：场景模板 id / 会话级系统提示词（可选）
    scenarioId,
    systemPrompt,
    // A225：群聊并行隔离（git worktree）。三态（A244）：
    //   true  = 强制开（任何模式，只要绑定了 git 目录）；
    //   false = 强制关（用户明确不要隔离）；
    //   undefined = 自动——并行模式（广播/带队/@多人）+ git 仓库 → 开，
    //   其余情况不开。前端未动过开关时不发这个字段，走自动。
    worktree,
    // A244：主控成员（dispatch 的路由者 / leader 的队长）。缺省 = 成员列表第一个
    controllerAgentId,
    // 群名。用户可能在建群后、发第一条消息之前就改过群名 ——
    // 那时会话还没落库（前端是本地空壳），改名只能攒着，随首条消息一起带上。
    // 不带的话，落库时会用「首条消息前 30 字」把用户起的名字盖掉。
    title,
  } = req.body;

  if (!message) {
    return res.status(400).json({ error: "消息不能为空" });
  }

  // A244：成员去重。以前重复 id 会让同一 Agent 并发跑两次——两个子进程
  // 写同一个检出（worktree 槽位还按 agentId 收敛成一个 Map，第二批覆盖第一批）。
  const members: string[] = [...new Set(
    (Array.isArray(agentIds) ? agentIds : []).filter((v: unknown): v is string => typeof v === 'string')
  )];
  if (members.length === 0) {
    return res.status(400).json({ error: "群聊至少需要一个成员" });
  }

  // 编排层要靠 availability 决定「谁能上」，状态来自探测缓存。
  // P1：探测必须放在 SSE 头之后 —— 冷启动时 SDK 单探最长 120 秒，
  // 放在头之前会让前端「点发送后零帧」。这里只记录意图，真正等待挪到下面。
  const needsProbe = registry.needsProbe(members);

  const membersJson = JSON.stringify(members);
  const now = new Date().toISOString();

  let session = sessionId ? db.getSession(sessionId) : null;
  if (!session) {
    console.log(`[GroupChat] 创建群聊会话，成员 ${members.join(', ')}`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      // 有用户起的群名就用它，否则退回首条消息的截断
      title:
        (typeof title === 'string' && title.trim()) ||
        message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      // 群聊没有单一模型：每个成员在调用时各自解析。'' = 未指定
      model: model || '',
      // 群聊没有单一归属 Agent
      agent_id: null,
      sdk_session_id: null,
      kind: 'group',
      agent_ids: membersJson,
      orchestration,
      // P4：群聊同样可绑定工作目录/场景
      cwd: cwd || null,
      // A62：群聊也存档位（turn-runner 会真的传给每个成员）
      reasoning_effort: reasoningEffort || null,
      scenario_id: scenarioId || null,
      system_prompt: systemPrompt || null,
      created_at: now,
      updated_at: now,
    });
  } else {
    // 成员与模式以本次请求为准 —— 用户可能刚在群聊头部改过
    db.updateSession(session.id, { agent_ids: membersJson, orchestration });
    session = { ...session, agent_ids: membersJson, orchestration };
  }

  // ── A244 群互斥锁：同一群上一轮还在执行时直接 409 ─────────────────
  // 检查与占位必须落在用户消息落库之前：被拒的请求不能留下半条记录。
  // 锁的释放只在本函数唯一的 finally 里（所有早退路径都会经过）。
  if (groupChatBusy.has(session.id)) {
    return res.status(409).json({
      error: '该群上一轮还在执行中（可在界面点「停止」中止）。稍候再发，或换一个群。',
    });
  }
  groupChatBusy.add(session.id);
  try {
    // 落库用户消息（无作者）
    const userMessageId = uuidv4();
    try {
      db.createMessage({
        id: userMessageId,
        session_id: session.id,
        role: 'user',
        content: message,
        model: null,
        author_agent_id: null,
        created_at: now,
        tool_calls: null,
      });
    } catch (dbError: any) {
      console.error(`[GroupChat] 保存用户消息失败:`, dbError);
      return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
    }

    // SSE 头
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    startSseHeartbeat(res);

    const sse = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    /** 成员展示名（note 与交接物里都用人话；查不到就退回 id） */
    const displayNameOf = (id: string) => registry.get(id)?.name || id;

    // 客户端断开 → 宽限 20 秒后中止**所有**正在跑的成员（群聊可能同时有多个子进程）。
    // 宽限期内前端可以用各 run 的重放端点接回来（E5），期间事件不会丢。
    const ac = new AbortController();
    res.on('close', () => {
      if (res.writableEnded) return;
      console.log(`[GroupChat] 客户端断开，20s 内可重连`);
      const timer = setTimeout(() => {
        const reattached = [...turn.activeRuns].some(id => runHub.subscriberCount(id) > 0);
        if (reattached || ac.signal.aborted) return;
        console.log(`[GroupChat] 重连窗口结束，中止 ${members.length} 个成员`);
        ac.abort();
        for (const id of members) registry.abort(id, session!.id);
      }, REATTACH_GRACE_MS);
      timer.unref?.();
    });

    /**
     * 「让某个 Agent 就给定 prompt 发言」搬到了 server/turn-runner.ts（A41）：
     * 动态工作流的 dispatch/broadcast/relay/debate 走的是同一份实现，
     * 群聊路由只留下 SSE 与断开口。
     */
    // A225：worktree 批次。在下面按需创建；createTurnRunner 的 cwdFor 用闭包取值
    let wtBatch: Awaited<ReturnType<typeof createWorktrees>> | null = null;
    const turn = createTurnRunner({
      session,
      model,
      // A244：请求体 > 会话里存的目录（与一对一 /api/chat 同一口径）。
      // 以前群聊只认请求体，会话里 PATCH 过的目录在第二轮就悄悄失效，
      // 兜底直接退到服务进程目录——在那里写文件是事故。
      cwd: cwd || session.cwd || undefined,
      // A225：worktree 隔离时按成员取各自的检出目录。wtBatch 在下面才创建，
      // 用闭包取值（未启用时恒为 undefined，回落共享目录）
      cwdFor: agentId => wtBatch?.slots.get(agentId)?.dir,
      reasoningEffort: reasoningEffort || session.reasoning_effort || undefined,
      // A123：每一棒也要吃会话里存的权限档（请求体没带时兜住），与一对一同一口径
      permissionMode: permissionMode || session.permission_mode || undefined,
      scenarioId,
      triggerPrompt: message,
      signal: ac.signal,
      // A244 闸门：并发信号量（默认 3 棒）+ 单棒空闲超时（shared/timing.ts，
      // env OPC_GROUP_IDLE_TIMEOUT_MS 可覆盖——env 在消费方读，shared 常量
      // 要跟客户端 watchdog 同文件打包，浏览器里没有 process）。
      maxConcurrency: GROUP_MAX_CONCURRENCY,
      idleTimeoutMs: Number(process.env.OPC_GROUP_IDLE_TIMEOUT_MS) || GROUP_TURN_IDLE_TIMEOUT_MS,
      // A122：界面上的「停止」走这里按下 controller
      abortTurn: () => {
        if (!ac.signal.aborted) ac.abort();
      },
      emitBlocks: events => {
        for (const e of events) {
          try {
            res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          } catch {
            // 客户端已断开：继续跑完并落库，事件仍在 runHub 里等重连
          }
        }
      },
      emitFrame: sse,
    });
    const runAgent = turn.runAgent;

    sse({
      type: 'group_init',
      sessionId: session.id,
      orchestration,
      members,
      userMessageId,
    });

    // P1：先让前端拿到 group_init，再等探测。
    // 缓存热时不发 note，避免每轮都多一条噪声。
    if (needsProbe) {
      sse({ type: 'group_note', text: '正在检查成员状态，首次启动可能需要几秒…' });
      await registry.ensureProbed(members);
      // 探测期间用户可能已经点了停止/关掉面板；别再对着已关闭的 SSE 跑一整场。
      if (ac.signal.aborted) {
        console.log('[GroupChat] 探测期间客户端离开，跳过本轮');
        return res.end();
      }
    }

    // A244：群聊背景转录。取本轮提问之前的已完成发言（末尾悬空的 user 就是
    // 本轮提问，装配器会跳过它），带 token 预算截断；读不到就不注入。
    // 这解决「把刚才那个再改一下」里「刚才」无据可依的问题；
    // CLI 会话续接依旧不做（取舍见 orchestrator.ts 头注释）。
    let messageForOrchestration = message;
    try {
      const transcript = assembleGroupTranscript(db.getMessagesBySession(session.id), displayNameOf);
      if (transcript) {
        messageForOrchestration = `${transcript}\n\n【本次请求】\n${message}`;
        console.log(`[GroupChat] 注入群聊背景转录 ${transcript.length} 字`);
      }
    } catch (e: any) {
      console.warn('[GroupChat] 群聊背景读取失败（不影响本轮）:', e?.message ?? e);
    }

    try {
      // ── A225/A244：worktree 隔离的创建 ────────────────────────────
      // 三态语义（见上文解构处注释）：
      //   worktree === true   → 强制开（任何模式，只要绑定了 git 目录）；
      //   worktree === false  → 强制关（用户明确不要隔离）；
      //   undefined（前端没动过开关时不发这个字段）→ 自动：并行模式 +
      //     git 仓库才开。并行 = 广播 / 带队 / @ 到多个成员；分派、接力、
      //     辩论是串行的，不会同时写目录，不值得为它们建检出。
      // 单成员的「群」没有并行互踩问题，同样跳过。
      const isParallelMode =
        orchestration === 'broadcast' ||
        orchestration === 'leader' ||
        (orchestration === 'mention' &&
          extractMentioned(message, members, displayNameOf).length > 1);
      const wantWorktree =
        (worktree === true || (worktree === undefined && isParallelMode)) &&
        members.length > 1 &&
        typeof session.cwd === 'string' &&
        !!session.cwd;
      if (wantWorktree) {
        // wantWorktree 已确认 session.cwd 是非空字符串；TS 的收尾进不了分支，这里收一次
        const repoDir = session.cwd as string;
        const isRepo = await isGitWorkTree(repoDir);
        if (!isRepo) {
          sse({
            type: 'group_note',
            text: isParallelMode
              ? `并行执行但没有隔离可用（${repoDir} 不是 git 仓库）：成员将同时写同一目录，输出可能互相覆盖。` +
                '建议先把目录提交进 git，或改用接力、分派这类串行模式'
              : `已开启并行隔离，但工作目录不是 git 仓库（${repoDir}），本轮退回共享目录执行`,
          });
        } else {
          wtBatch = await createWorktrees(repoDir, members, session.id);
          for (const f of wtBatch.failures) {
            sse({ type: 'group_note', text: `${displayNameOf(f.agentId)} 的隔离检出创建失败（${f.reason}），退回共享目录` });
          }
          if (wtBatch.hadLeftovers) {
            sse({ type: 'group_note', text: `上次保留的隔离检出还在 ${wtBatch.root}（本轮用新检出，旧目录原样不动）` });
          }
          const made = wtBatch.slots.size;
          if (made > 0) {
            sse({ type: 'group_note', text: `已开启并行隔离：${made} 位成员各在独立检出中执行，结束后逐个汇合（绝不自动 push）` });
          }
        }
      } else if (worktree === false && isParallelMode && members.length > 1 && session.cwd) {
        // 用户明确关了隔离却要并行写目录：如实提醒一句（不是错误——
        // 用户可能就是要对比式问答，多数成员并不会写文件）
        sse({ type: 'group_note', text: '并行隔离已关闭：并行成员将在同一目录执行，写文件时可能互相覆盖' });
      }

      // 成员完成标记：汇合时只处理真的跑完编排的成员（中止/失败的不汇合——
      // 半途而废的改动也可能是有用的，但它没有走完编排，由用户自己在检出里看）
      let orchestrationFinished = false;
      try {
        await runOrchestration(
          {
            mode: orchestration,
            members,
            prompt: messageForOrchestration,
            // A244：主控可指定；不合法（不在成员列表）时编排层自行回落第一个成员
            controllerAgentId:
              typeof controllerAgentId === 'string' && controllerAgentId.trim()
                ? controllerAgentId.trim()
                : undefined,
          },
          {
            runAgent,
            note: text => sse({ type: 'group_note', text }),
            displayName: displayNameOf,
            skillScore: id => {
              const agent = registry.get(id);
              return agent ? scoreAgentSkills(agent.skills ?? [], message) : 0;
            },
            // 只把真正可用的 Agent 纳入编排：把任务派给一个必然失败的人，
            // 只会浪费一轮调用并给用户一个空结果
            isUsable: id => registry.get(id)?.status.availability === 'ready',
          }
        );
        orchestrationFinished = !ac.signal.aborted;
      } finally {
        // A244 清理规则（反转后）：只有 merged / clean 的槽位被清（在
        // mergeWorktree 内部完成）；failed / conflict 进 keep——分支与检出
        // 原样保留。中止 / 异常路径一个槽位都不删。
        if (wtBatch) {
          if (orchestrationFinished) {
            // 串行汇合：并发 merge 会互相踩主区的 index
            const keep = new Set<string>();
            for (const [agentId, slot] of wtBatch.slots) {
              const outcome = await mergeWorktree(wtBatch, slot, displayNameOf(agentId));
              switch (outcome.kind) {
                case 'merged':
                  sse({
                    type: 'group_note',
                    text: `已汇合 ${displayNameOf(agentId)} 的改动（${outcome.files} 个文件）`,
                  });
                  break;
                case 'clean':
                  sse({ type: 'group_note', text: `${displayNameOf(agentId)} 没有文件改动` });
                  break;
                case 'conflict':
                  // 冲突现场保留：分支与检出都留着，用户自己去解
                  keep.add(agentId);
                  sse({
                    type: 'group_note',
                    text:
                      `${displayNameOf(agentId)} 的改动与主工作区冲突：${outcome.files.join('、')}。` +
                      `已停止自动汇合，改动保留在分支 ${outcome.branch}（检出：${outcome.dir}），解完后自行合并或删除`,
                  });
                  break;
                case 'failed':
                  // A244：失败也保留。以前这里不进 keep，cleanupWorktrees 会把
                  // 分支与检出连成果一起删掉（提交身份缺失 / 钩子拒绝 / 主区脏
                  // 都会走到这里）。现在原样留下并告诉用户在哪。
                  keep.add(agentId);
                  sse({
                    type: 'group_note',
                    text: `汇合 ${displayNameOf(agentId)} 的改动失败：${outcome.reason}。` +
                      `改动已原样保留——分支 ${slot.branch}，检出 ${slot.dir}；可自行取回或删除`,
                  });
                  break;
              }
            }
            await cleanupWorktrees(wtBatch, keep);
          } else {
            // A244：被中止 / 编排抛异常——以前这里把所有检出连成果一起清掉。
            // 现在一个都不删：现场原样保留，note 告诉用户去哪找。
            if (wtBatch.slots.size > 0) {
              sse({
                type: 'group_note',
                text: `${ac.signal.aborted ? '本轮已中止' : '编排异常中断'}：${wtBatch.slots.size} 个隔离检出与分支未合并、未删除，` +
                  `原样保留在 ${wtBatch.root}，可自行取回或清理`,
              });
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`[GroupChat] 编排失败:`, err);
      sse({ type: 'error', message: err?.message || '编排失败' });
    }

    sse({ type: 'done' });
    console.log(`[GroupChat] 请求完成 ✓ (${orchestration})`);
    res.end();
  } finally {
    // A244：互斥锁只在真正结束时释放（探测期间离开、500、编排异常全都会经过）
    groupChatBusy.delete(session.id);
  }
});

/**
 * 工作流示例脚本（给设置/编辑器里的「填入示例」用）。
 * 单独一个端点而不是写死在前端：示例要和服务端原语的真实签名一起演进。
 */
app.get("/api/workflow/template", (_req, res) => {
  res.json({ template: WORKFLOW_TEMPLATE });
});

/**
 * 动态工作流端点（A41）。
 *
 * 与 /api/group-chat 的分工：那个端点把用户的一句话交给**固定五种编排模式**之一；
 * 这个端点把一段用户/主 agent 写的脚本（TypeScript）在沙箱里跑起来，
 * 脚本自己决定怎么组合 assign / broadcast / relay / debate。
 *
 * 复用的是同一套「一棒发言」（server/turn-runner.ts），所以脚本里每一次
 * 工具调用都会以正常的 Agent 气泡出现在会话里，断线重放、落库、A39 沉淀
 * 全部照旧 —— 工作流不是另一条暗道。
 *
 * 协议：不发明新帧。`ctx.note()` → group_note；最终结论 → group_note；
 * 失败 → error；结束 → done。前端零改动即可显示。
 */
app.post("/api/workflow/run", async (req, res) => {
  const {
    sessionId,
    source,
    agentIds = [],
    model,
    cwd,
    // A62：同群聊 —— 工作流的每一棒都真的把档位传给对应成员
    reasoningEffort,
    permissionMode,
    scenarioId,
    systemPrompt,
    title,
  } = req.body ?? {};

  // A244：与群聊同口径——成员去重（重复 id 会让同一 Agent 并发跑两次）
  const members: string[] = [...new Set(
    (Array.isArray(agentIds) ? agentIds : []).filter((v: unknown): v is string => typeof v === 'string')
  )];

  if (!sessionId) {
    return res.status(400).json({ error: "工作流必须挂在既有群会话上（缺 sessionId）" });
  }
  if (members.length === 0) {
    return res.status(400).json({ error: "工作流至少需要一个成员" });
  }
  if (typeof source !== 'string' || !source.trim()) {
    return res.status(400).json({ error: "工作流脚本不能为空" });
  }

  const session = db.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "会话不存在，请先建群再跑工作流" });
  }

  // P1：同群聊 —— 探测放在 SSE 头之后，前端先拿到反馈再等状态。
  const needsProbe = registry.needsProbe(members);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  startSseHeartbeat(res);

  const sse = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const ac = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return;
    const timer = setTimeout(() => {
      if (ac.signal.aborted) return;
      console.log('[Workflow] 重连窗口结束，中止');
      ac.abort();
      for (const id of members) registry.abort(id, session.id);
    }, REATTACH_GRACE_MS);
    timer.unref?.();
  });

  // 触发词写明了这是工作流：A39 沉淀时能区分「一句话」和「一整段流程」
  const triggerPrompt = `[工作流] ${String(source).slice(0, 200)}`;

  const turn = createTurnRunner({
    session,
    model,
    // A244：与群聊同口径——请求体 > 会话里存的目录；工作流不启用群聊的
    // 并发/空闲闸门（保持原行为，串行原语为主）
    cwd: cwd || session.cwd || undefined,
    reasoningEffort: reasoningEffort || session.reasoning_effort || undefined,
    // A123：同群聊
    permissionMode: permissionMode || session.permission_mode || undefined,
    scenarioId,
    triggerPrompt,
    signal: ac.signal,
    // A122：工作流与群聊同一个停止入口
    abortTurn: () => {
      if (!ac.signal.aborted) ac.abort();
    },
    emitBlocks: events => {
      for (const e of events) {
        try {
          res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        } catch {
          // 断开也跑完：事件在 runHub 里等重连
        }
      }
    },
    emitFrame: sse,
  });

  sse({ type: 'group_init', sessionId: session.id, orchestration: 'workflow', members, userMessageId: null });
  if (needsProbe) {
    sse({ type: 'group_note', text: '正在检查成员状态，首次启动可能需要几秒…' });
    await registry.ensureProbed(members);
    if (ac.signal.aborted) {
      console.log('[Workflow] 探测期间客户端离开，跳过本轮');
      return res.end();
    }
  }
  sse({ type: 'group_note', text: '工作流开始执行' });

  try {
    const outcome = await runWorkflow(source, {
      runAgent: turn.runAgent,
      members,
      memorySearch: (query, limit) =>
        searchMemory(query, limit).map(h => ({ key: h.key, title: h.title, snippet: h.snippet })),
      note: text => sse({ type: 'group_note', text }),
    });

    if (outcome.ok) {
      const brief = outcome.steps.map(s => `${s.name}(${s.args})`).slice(0, 8).join(' → ') || '（没有调用任何原语）';
      const summary = [
        `工作流完成，用时 ${(outcome.durationMs / 1000).toFixed(1)}s`,
        `调用链：${brief}`,
        outcome.output !== null && outcome.output !== undefined
          ? `返回值：${JSON.stringify(outcome.output).slice(0, 300)}`
          : '',
        outcome.logs.length ? `日志：${outcome.logs.slice(0, 5).join('；')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      sse({ type: 'group_note', text: summary });
    } else {
      sse({ type: 'error', message: outcome.error ?? '工作流失败' });
    }
  } catch (err: any) {
    console.error('[Workflow] 运行失败:', err);
    sse({ type: 'error', message: err?.message || '工作流运行失败' });
  }

  sse({ type: 'done' });
  console.log('[Workflow] 请求完成 ✓');
  res.end();
});

// ============= 生图 API（P4-4） =============
// F0-02②：三条生图路由已原样迁 server/routes/image.ts（行为零改动），
// 注册位置与拆分前一致（先于静态资源与验证闭环）。
}
