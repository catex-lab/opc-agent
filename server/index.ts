// 必须最先执行：剔除从宿主应用继承的内部环境变量，
// 否则 SDK 启动的 Agent CLI 会抢绑 WorkBuddy 的端口（EADDRINUSE）。
import './env.js';

import express from "express";
import { unstable_v2_createSession, unstable_v2_authenticate } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import * as db from "./db.js";
import { registry } from "./agents/registry.js";
import {
  getImageProvider,
  imageProvidersStatus,
  ImageGenerationError,
  DEFAULT_IMAGE_SIZE,
  IMAGE_SIZES,
  type ImageSize,
} from "./agents/adapters/image.js";
import { cacheImage, imageFilePath } from "./image-store.js";
import { runOrchestration, isInternalPhase, type TurnPhase } from "./orchestrator.js";
import {
  resolveModelForAgent,
  PLATFORM_DEFAULT_MODEL,
} from "./model-routing.js";
import { getScenario } from "../shared/scenarios.js";

const app = express();

/**
 * 解析库里的 JSON 文本列（tool_calls / images）。
 *
 * 用 try/catch 而不是裸 JSON.parse：这两列都可能是历史遗留或被手工改过的
 * 坏值，裸解析一旦抛错，整个 `GET /api/sessions/:id` 会 500 —— 用户看到的
 * 是「会话打不开」，而真实原因只是某一条消息的一个字段坏了。
 * 坏值退化成 null，其余消息照常返回。
 */
function parseJsonColumn(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 监听端口。
 *
 * `PORT=0` 表示「由系统分配一个空闲端口」—— Electron 打包后走这条路径，
 * 避免和用户已经跑着的开发服务器（3000）抢端口。真实端口在 listen
 * 回调里通过 `server.address()` 取回。
 */
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;

// Middleware
app.use(express.json());

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
// 平台默认模型：只对 SDK 类 Agent 有意义。模型路由规则见 model-routing.ts
const defaultModel = PLATFORM_DEFAULT_MODEL;

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 登录方式类型
type LoginMethod = 'env' | 'cli' | 'none';

interface LoginStatusResponse {
  isLoggedIn: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string; // 脱敏后的 API Key
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
}

// 检查 CodeBuddy CLI 登录状态
app.get("/api/check-login", async (req, res) => {
  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };
  
  // 1. 检查环境变量
  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;
  
  if (apiKey || authToken) {
    response.envConfigured = true;
    // 脱敏显示
    if (apiKey) {
      response.envVars!.apiKey = apiKey.slice(0, 8) + '****' + apiKey.slice(-4);
      response.apiKey = response.envVars!.apiKey;
    }
    if (authToken) {
      response.envVars!.authToken = authToken.slice(0, 8) + '****' + authToken.slice(-4);
    }
    if (internetEnv) {
      response.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      response.envVars!.baseUrl = baseUrl;
    }
  }
  
  // 2. 使用 unstable_v2_authenticate 检查登录状态（更可靠）
  try {
    let needsLogin = false;
    
    const result = await unstable_v2_authenticate({
      environment: 'external',
      onAuthUrl: async (authState) => {
        // 如果执行到这个回调，说明未登录
        needsLogin = true;
        console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
        // 将认证 URL 返回给前端（如果需要）
        response.error = '未登录，请先登录 CodeBuddy CLI';
      }
    });
    
    // 如果没有触发 onAuthUrl 回调，说明已登录
    if (!needsLogin && result?.userinfo) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      
      // 判断登录方式
      if (response.envConfigured) {
        response.method = 'env';
      } else {
        response.method = 'cli';
      }
      
      console.log('[Check Login] 已登录用户:', result.userinfo.userName);
    } else if (!needsLogin) {
      // result 存在但没有 userinfo，仍然认为已登录
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    console.error("[Check Login] SDK Error:", error);
    
    // 如果有环境变量配置，仍然认为是登录状态
    if (response.envConfigured) {
      response.isLoggedIn = true;
      response.method = 'env';
    } else {
      response.error = error?.message || String(error);
      response.method = 'none';
    }
  }
  
  res.json(response);
});

// 保存环境变量配置
app.post("/api/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;
  
  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }
  
  const configuredVars: string[] = [];
  
  // 设置环境变量（仅在当前进程有效）
  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }
  
  // 清除模型缓存，以便重新获取
  cachedModels = [];
  
  res.json({ 
    success: true, 
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// 获取可用模型列表
app.get("/api/models", async (req, res) => {
  try {
    if (cachedModels.length === 0) {
      console.log("[Models] Creating session to fetch available models...");
      
      const session = await unstable_v2_createSession({ 
        cwd: process.cwd()
      });
      
      console.log("[Models] Session created, calling getAvailableModels()...");
      const models = await session.getAvailableModels();
      console.log("[Models] Got", models.length, "models");
      
      if (models && Array.isArray(models)) {
        cachedModels = models;
      }
    }
    
    res.json({ 
      models: cachedModels.length > 0 ? cachedModels : [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
      ],
      defaultModel 
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel,
      error: error?.message || String(error)
    });
  }
});

// ============= Agent 名册 API =============

// 列出全部 Agent（含探测状态）。带 TTL 缓存，不会每次都重探。
app.get("/api/agents", async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    if (force) {
      return res.json({ agents: await registry.probeAll(true) });
    }
    // 冷启动时缓存是空的，此时名册里全是 unknown（前端会显示成「未接入」）。
    // 这里把探测在后台启动起来，本次仍按当前缓存如实返回，由前端轮询补齐。
    registry.ensureProbedInBackground();
    res.json({ agents: registry.list() });
  } catch (error: any) {
    console.error("[Agents] Error:", error);
    res.status(500).json({ error: error?.message || "获取 Agent 列表失败" });
  }
});

// 主动触发全量探测（首次打开名册页时调用）
app.post("/api/agents/probe", async (req, res) => {
  try {
    const agents = await registry.probeAll(true);
    res.json({ agents });
  } catch (error: any) {
    console.error("[Agents] Probe error:", error);
    res.status(500).json({ error: error?.message || "探测失败" });
  }
});

// 单个 Agent 详情
app.get("/api/agents/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    if (req.query.probe === '1') await registry.probeOne(agentId, true);
    const agent = registry.get(agentId);
    if (!agent) return res.status(404).json({ error: "Agent 不存在" });
    res.json({ agent });
  } catch (error: any) {
    console.error("[Agent] Error:", error);
    res.status(500).json({ error: error?.message || "获取 Agent 失败" });
  }
});

// 某个 Agent 上报的可用模型（目前 ACP 类 Agent 会返回）
app.get("/api/agents/:agentId/models", async (req, res) => {
  try {
    const models = registry.modelsFor(req.params.agentId);
    res.json({ models });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取模型列表失败" });
  }
});

// ============= 会话 API =============

// 获取所有会话（包含消息数量）
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 获取单个会话及其消息
app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    const messages = db.getMessagesBySession(sessionId);
    
    // 解析 tool_calls / images 的 JSON。
    // 坏值（历史遗留、手改过库）不能让整个会话打不开，所以逐条兜住。
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: parseJsonColumn(msg.tool_calls),
      images: parseJsonColumn(msg.images),
    }));
    
    res.json({ session, messages: parsedMessages });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 创建新会话
app.post("/api/sessions", (req, res) => {
  try {
    const {
      model,
      title = "新对话",
      agentId = null,
      kind = "direct",
      agentIds = null,
      orchestration = null,
      // P4：工作目录 + 场景绑定（均可选）
      cwd = null,
      scenarioId = null,
      systemPrompt = null,
    } = req.body;
    const now = new Date().toISOString();

    // 群聊没有单一 Agent，模型按发起时的选择原样落库（成员各自的模型在调用时解析）
    const sessionModel = kind === 'group'
      ? (model || defaultModel)
      : (resolveModelForAgent(agentId ?? '', model) ?? '');

    // 群聊成员统一以 JSON 字符串落库；传进来的可能是数组，也可能已经是字符串
    const agentIdsJson = Array.isArray(agentIds)
      ? JSON.stringify(agentIds.filter((v: unknown) => typeof v === 'string'))
      : (typeof agentIds === 'string' ? agentIds : null);

    const session = db.createSession({
      id: uuidv4(),
      title,
      model: sessionModel,
      // 群聊没有单一归属 Agent，agent_id 留空，成员看 agent_ids
      agent_id: kind === 'group' ? null : agentId,
      // 新建时还没有 SDK 侧会话 id，第一次调用返回 init 事件后才回填
      sdk_session_id: null,
      kind: kind === 'group' ? 'group' : 'direct',
      agent_ids: kind === 'group' ? agentIdsJson : null,
      orchestration: kind === 'group' ? orchestration : null,
      // P4：工作目录与场景绑定随会话一起落库，刷新后仍在
      cwd: typeof cwd === 'string' && cwd ? cwd : null,
      scenario_id: typeof scenarioId === 'string' && scenarioId ? scenarioId : null,
      system_prompt: typeof systemPrompt === 'string' && systemPrompt ? systemPrompt : null,
      created_at: now,
      updated_at: now
    });
    
    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

// 更新会话
app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model, orchestration, agentIds, cwd, scenarioId, systemPrompt, pinned } = req.body;

    const updates: Parameters<typeof db.updateSession>[1] = { title, model };
    // 群聊头部可以随时改编排模式与成员，这里一并支持
    if (typeof orchestration === 'string') updates.orchestration = orchestration;
    if (Array.isArray(agentIds)) {
      updates.agent_ids = JSON.stringify(
        agentIds.filter((v: unknown): v is string => typeof v === 'string')
      );
    }
    // P4：工作目录与场景绑定可随时改（空串表示清除 → 存 null）
    if (typeof cwd === 'string') updates.cwd = cwd || null;
    if (typeof scenarioId === 'string') updates.scenario_id = scenarioId || null;
    if (typeof systemPrompt === 'string') updates.system_prompt = systemPrompt || null;
    // 置顶开关（消息列表右键菜单）。只认布尔，避免 "false" 字符串被当成真
    if (typeof pinned === 'boolean') updates.pinned = pinned ? 1 : 0;

    const success = db.updateSession(sessionId, updates);

    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

// 删除会话
app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = db.deleteSession(sessionId);
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// ============= 聊天 API =============

// 权限响应 API
// 权限请求可能来自任意 Agent（SDK 的 canUseTool、ACP 的 session/request_permission），
// 所以这里不绑定具体 Agent —— 直接问注册表谁能认领这个 requestId。
app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;

  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);

  const decision = {
    behavior: behavior === 'allow' ? 'allow' : 'deny',
    message,
  } as const;

  const ids = ['workbuddy', 'hermes']; // 目前只有这两类会产生权限请求
  const hit = ids.find(id => registry.resolvePermission(id, requestId, decision));

  if (!hit) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }

  res.json({ success: true, agentId: hit });
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

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();

  // 会话里存的模型可能是修复前的历史遗留值：那时所有会话都被写成了平台
  // 默认模型（claude-sonnet-4），对非 SDK Agent 来说那并不是用户的选择。
  // 统一交给 resolveModelForAgent 判断是否该采用。
  const resolvedModel = resolveModelForAgent(
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
      scenario_id: scenarioId || null,
      system_prompt: systemPrompt || null,
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
    if (!session.scenario_id && scenarioId) patch.scenario_id = scenarioId;
    if (!session.system_prompt && systemPrompt) patch.system_prompt = systemPrompt;
    if (Object.keys(patch).length > 0) {
      db.updateSession(session.id, patch);
      session = { ...session, ...patch };
    }
  }

  const selectedModel = resolvedModel;
  const resumeToken = session.sdk_session_id;

  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  try {
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
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 中止信号：客户端断开时通知适配器杀掉子进程
  //
  // 注意这里必须监听 res 而不是 req：对 POST 请求，req 的 'close' 在
  // **请求体被读完**时就触发了（express.json() 一读完就触发），根本等不到
  // 客户端真正断开 —— 实测会导致每次对话刚开始就被误判为「客户端断开」，
  // 子进程当场被杀、一个字都吐不出来。
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[Chat] 客户端断开，中止 ${agentId}`);
      ac.abort();
      registry.abort(agentId, session!.id);
    }
  });

  // 发送 init（携带消息 ID，前端据此挂载流式气泡）
  res.write(`data: ${JSON.stringify({
    type: "init",
    sessionId: session.id,
    userMessageId,
    assistantMessageId,
    model: selectedModel,
    agentId,
  })}\n\n`);

  let fullResponse = "";
  let thinking = "";
  const toolCalls: Array<{
    id: string; name: string; input?: Record<string, unknown>;
    status: string; result?: string; isError?: boolean;
  }> = [];
  let newResumeToken: string | null = null;
  // done 事件的载荷先攒着，等落库之后再发：客户端收到 done 常会立刻
  // 刷新会话，句子还没落库就会在这一瞬丢一条（与群聊 turn_done 同窗口）
  let donePayload: { durationMs?: number; cost?: number } | null = null;

  const stream = registry.stream(agentId, {
    sessionId: session.id,
    prompt: message,
    systemPrompt,
    cwd: cwd || process.cwd(),
    model: selectedModel,
    resumeToken,
    permissionMode: permissionMode || 'default',
    allowedTools: allowedToolsFor(scenarioId, session.scenario_id),
    signal: ac.signal,
  });

  if (!stream) {
    res.write(`data: ${JSON.stringify({ type: "error", message: `Agent ${agentId} 不可用` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    return res.end();
  }

  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case 'init':
          if (ev.resumeToken && ev.resumeToken !== resumeToken) {
            newResumeToken = ev.resumeToken;
            db.updateSession(session.id, { sdk_session_id: ev.resumeToken });
            console.log(`[Chat] 已保存续接令牌: ${ev.resumeToken}`);
          }
          break;

        case 'text':
          fullResponse += ev.content;
          res.write(`data: ${JSON.stringify({ type: "text", content: ev.content })}\n\n`);
          break;

        case 'thinking':
          thinking += ev.content;
          res.write(`data: ${JSON.stringify({ type: "thinking", content: ev.content })}\n\n`);
          break;

        case 'tool': {
          const toolCall = {
            id: ev.id,
            name: ev.name,
            input: ev.input as Record<string, unknown> | undefined,
            status: "running",
          };
          toolCalls.push(toolCall);
          res.write(`data: ${JSON.stringify({
            type: "tool",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            status: toolCall.status,
          })}\n\n`);
          break;
        }

        case 'tool_result': {
          const tool = toolCalls.find(t => t.id === ev.toolId) || toolCalls[toolCalls.length - 1];
          if (tool) {
            tool.status = ev.isError ? "error" : "completed";
            tool.isError = ev.isError;
            tool.result = ev.content;
            res.write(`data: ${JSON.stringify({
              type: "tool_result",
              toolId: tool.id,
              content: ev.content,
              isError: ev.isError ?? false,
            })}\n\n`);
          }
          break;
        }

        case 'permission_request':
          res.write(`data: ${JSON.stringify({
            type: "permission_request",
            requestId: ev.requestId,
            toolUseId: ev.toolUseId,
            toolName: ev.toolName,
            input: ev.input,
            sessionId: session.id,
            timestamp: Date.now(),
          })}\n\n`);
          break;

        case 'error':
          console.error(`[Chat] ${agentId} 报错: ${ev.message}`);
          registry.recordError(agentId, ev.message);
          res.write(`data: ${JSON.stringify({ type: "error", message: ev.message })}\n\n`);
          break;

        case 'done':
          // 只记录载荷，发送挪到落库之后（见上方 donePayload 注释）
          donePayload = { durationMs: ev.durationMs, cost: ev.cost };
          break;
      }
    }
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Name:`, error?.name);
    console.error(`[Chat] Error Message:`, error?.message);
    console.error(`[Chat] Error Stack:`, error?.stack);
    registry.recordError(agentId, error?.message || String(error));
    res.write(`data: ${JSON.stringify({ type: "error", message: error?.message || "处理请求时发生错误" })}\n\n`);
  }

  // 落库助手消息（含思考过程与工具调用）
  // 中止且一个字都没产出时不要落库：否则界面上会多出一个空气泡，
  // 刷新后也还在（用户只会看到一条没有内容的「回复」）。
  const abortedEmpty = ac.signal.aborted && fullResponse.trim() === '' && toolCalls.length === 0;
  if (abortedEmpty) {
    console.log(`[Chat] ${agentId} 被中止且无产出，跳过落库`);
  } else try {
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      // 未指定模型时记 null（而不是把平台默认值写进去冒充它的模型）
      model: selectedModel ?? null,
      // 一对一里这个端点固定只服务一个 Agent，直接记下它；
      // 群聊时同一会话会有多个作者，由编排引擎逐个写入
      author_agent_id: agentId,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    });

    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, {
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel,
      });
    }
  } catch (dbError: any) {
    console.error(`[Chat] 保存助手消息失败:`, dbError);
  }

  if (thinking) {
    console.log(`[Chat] 思考过程 ${thinking.length} 字（未落库）`);
  }

  // 落库之后才发 done：客户端收到 done 可能立刻刷新会话
  if (donePayload) {
    res.write(`data: ${JSON.stringify({
      type: "done",
      duration: donePayload.durationMs,
      cost: donePayload.cost,
    })}\n\n`);
  }

  console.log(`[Chat] 请求完成 ✓ (${agentId})`);
  res.end();
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
    permissionMode,
    // P4：场景模板 id / 会话级系统提示词（可选）
    scenarioId,
    systemPrompt,
  } = req.body;

  if (!message) {
    return res.status(400).json({ error: "消息不能为空" });
  }

  const members: string[] = Array.isArray(agentIds)
    ? agentIds.filter((v: unknown): v is string => typeof v === 'string')
    : [];
  if (members.length === 0) {
    return res.status(400).json({ error: "群聊至少需要一个成员" });
  }

  // 编排层要靠 availability 决定「谁能上」，而状态来自探测缓存。
  // 冷启动或 TTL 过期时缓存是空的，成员会被一律判成不可用、整场群聊直接空转
  // （实测：名册显示 opencode/hermes 在线，群聊却报「没有可用的成员」）。
  // 所以这里必须先确保成员状态是新鲜的 —— 已新鲜的会命中缓存，不会重复起进程。
  await registry.ensureProbed(members);

  const membersJson = JSON.stringify(members);
  const now = new Date().toISOString();

  let session = sessionId ? db.getSession(sessionId) : null;
  if (!session) {
    console.log(`[GroupChat] 创建群聊会话，成员 ${members.join(', ')}`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
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

  // 客户端断开 → 中止**所有**正在跑的成员（群聊可能同时有多个子进程）
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[GroupChat] 客户端断开，中止 ${members.length} 个成员`);
      ac.abort();
      for (const id of members) registry.abort(id, session!.id);
    }
  });

  const sse = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sse({
    type: 'group_init',
    sessionId: session.id,
    orchestration,
    members,
    userMessageId,
  });

  /**
   * 让某个 Agent 就给定 prompt 发言：转发它的流式事件（都带上 agentId）、
   * 落库、并返回聚合正文供编排层使用。
   */
  const runAgent = async (
    agentId: string,
    prompt: string,
    phase: TurnPhase,
    round?: number
  ): Promise<{ text: string; error?: string }> => {
    const messageId = uuidv4();
    // 内部阶段（如 dispatch 的 route）只服务于编排决策：不建气泡、不落库。
    // 用户的可见叙述走 group_note，见 orchestrator.ts 的 INTERNAL_PHASES 注释。
    const internal = isInternalPhase(phase);
    if (!internal) sse({ type: 'turn_start', agentId, messageId, phase, round });

    let text = '';
    let thinking = '';
    let errorMsg: string | undefined;
    const toolCalls: Array<{
      id: string; name: string; input?: Record<string, unknown>;
      status: string; result?: string; isError?: boolean;
    }> = [];

    const stream = registry.stream(agentId, {
      sessionId: session!.id,
      prompt,
      // 逐个成员解析模型：群聊里每个 Agent 的模型命名空间都不同，
      // 统一塞一个全局值必然把其中一部分成员直接打挂
      model: resolveModelForAgent(agentId, model || session!.model || undefined),
      cwd: cwd || process.cwd(),
      permissionMode: permissionMode || 'default',
      // 群聊同样受场景白名单约束：一个成员能做什么，不因为进了群聊就放开
      allowedTools: allowedToolsFor(scenarioId, session!.scenario_id),
      signal: ac.signal,
    });

    if (!stream) {
      errorMsg = `Agent ${agentId} 不可用`;
      sse({ type: 'error', agentId, message: errorMsg });
    } else {
      try {
        for await (const ev of stream) {
          switch (ev.type) {
            case 'text':
              text += ev.content;
              if (!internal) sse({ type: 'text', agentId, content: ev.content });
              break;

            case 'thinking':
              thinking += ev.content;
              if (!internal) sse({ type: 'thinking', agentId, content: ev.content });
              break;

            case 'tool': {
              const toolCall = {
                id: ev.id,
                name: ev.name,
                input: ev.input as Record<string, unknown> | undefined,
                status: 'running',
              };
              toolCalls.push(toolCall);
              if (!internal) {
                sse({
                  type: 'tool',
                  agentId,
                  id: toolCall.id,
                  name: toolCall.name,
                  input: toolCall.input,
                  status: toolCall.status,
                });
              }
              break;
            }

            case 'tool_result': {
              const tool =
                toolCalls.find(t => t.id === ev.toolId) || toolCalls[toolCalls.length - 1];
              if (tool) {
                tool.status = ev.isError ? 'error' : 'completed';
                tool.isError = ev.isError;
                tool.result = ev.content;
                if (!internal) {
                  sse({
                    type: 'tool_result',
                    agentId,
                    toolId: tool.id,
                    content: ev.content,
                    isError: ev.isError ?? false,
                  });
                }
              }
              break;
            }

            case 'permission_request':
              sse({
                type: 'permission_request',
                agentId,
                requestId: ev.requestId,
                toolUseId: ev.toolUseId,
                toolName: ev.toolName,
                input: ev.input,
                sessionId: session!.id,
                timestamp: Date.now(),
              });
              break;

            case 'error':
              errorMsg = ev.message;
              console.error(`[GroupChat] ${agentId} 报错: ${ev.message}`);
              registry.recordError(agentId, ev.message);
              sse({ type: 'error', agentId, message: ev.message });
              break;

            // 群聊不做上下文续接，init 里的 resumeToken 有意忽略（理由见 orchestrator.ts）
            case 'init':
            case 'done':
              break;
          }
        }
      } catch (err: any) {
        errorMsg = err?.message || String(err);
        console.error(`[GroupChat] ${agentId} 异常:`, errorMsg);
        sse({ type: 'error', agentId, message: errorMsg });
      }
    }

    // 先落库、再通报 turn_done：客户端一收到 turn_done 就可能去刷新会话，
    // 顺序反了会在那一瞬丢掉这一棒（探针实测踩过这个窗口）。
    // 内部阶段的原文不落库：刷新后用户不该看到一句没头没尾的 `ROUTE: xxx`
    if (internal) {
      console.log(`[GroupChat] ${agentId} 内部阶段 ${phase} 输出 ${text.length} 字（未落库、未推送）`);
    } else if (ac.signal.aborted && text.trim() === '' && toolCalls.length === 0) {
      // 客户端断开导致这一棒一个字都没产出：不落库，否则是个空气泡
      console.log(`[GroupChat] ${agentId} 被中止且无产出，跳过落库`);
    } else try {
      db.createMessage({
        id: messageId,
        session_id: session!.id,
        role: 'assistant',
        content: text,
        model: model || session!.model,
        author_agent_id: agentId,
        created_at: new Date().toISOString(),
        tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      });
    } catch (dbError: any) {
      console.error(`[GroupChat] 保存 ${agentId} 的消息失败:`, dbError);
    }

    if (!internal) sse({ type: 'turn_done', agentId, messageId });

    if (thinking) {
      console.log(`[GroupChat] ${agentId} 思考过程 ${thinking.length} 字（未落库）`);
    }

    return { text, error: errorMsg };
  };

  try {
    await runOrchestration(
      { mode: orchestration, members, prompt: message },
      {
        runAgent,
        note: text => sse({ type: 'group_note', text }),
        displayName: id => registry.get(id)?.name || id,
        // 只把真正可用的 Agent 纳入编排：把任务派给一个必然失败的人，
        // 只会浪费一轮调用并给用户一个空结果
        isUsable: id => registry.get(id)?.status.availability === 'ready',
      }
    );
  } catch (err: any) {
    console.error(`[GroupChat] 编排失败:`, err);
    sse({ type: 'error', message: err?.message || '编排失败' });
  }

  sse({ type: 'done' });
  console.log(`[GroupChat] 请求完成 ✓ (${orchestration})`);
  res.end();
});

// ============= 生图 API（P4-4） =============
//
// 生图**不走** /api/chat：那个端点的语义是「把 prompt 交给某个 Agent 的
// 会话上下文」，而生图是一次无状态 HTTP 调用、产出的是图像而不是文本。
// 硬塞进去要么污染 AgentEvent，要么得给 /api/chat 加一堆只有生图才用的分支。
// 这里单开一个端点，但**复用同一套 SSE 契约**（init / done / error），
// 前端因此能沿用已有的读流循环，只多认一个 `image` 事件。

/** 生图 provider 的可用性（前端据此在生图场景显示修复指引） */
app.get("/api/image/providers", (req, res) => {
  try {
    res.json({
      providers: imageProvidersStatus(),
      sizes: IMAGE_SIZES,
      defaultSize: DEFAULT_IMAGE_SIZE,
    });
  } catch (error: any) {
    console.error("[Image] Providers error:", error);
    res.status(500).json({ error: error?.message || "获取生图服务列表失败" });
  }
});

/**
 * 本地缓存的生成图片。
 *
 * 必须由服务端托管而不是直接暴露远端 URL：CogView 给的是带签名的临时地址
 * （约 7 天过期），直接把远端 URL 存进消息表，一周后历史图全部裂开。
 * 生成时已抓回本地，这里只做「安全取名 → 发文件」。
 */
app.get("/api/images/:file", (req, res) => {
  let filePath: string;
  try {
    // 白名单 + 目录穿越校验都在这里，非法名字直接抛
    filePath = imageFilePath(db.imagesDir, req.params.file);
  } catch {
    return res.status(404).json({ error: "图片不存在" });
  }
  // 内容哈希命名 → 内容永不变，可以放心长缓存
  res.sendFile(filePath, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } }, err => {
    if (err && !res.headersSent) res.status(404).json({ error: "图片不存在" });
  });
});

/**
 * 生成图像。
 *
 * 与 /api/chat 的差异：
 *   - 不是流式产出，而是一次调用得到一张图；SSE 只用来承载
 *     init（挂载气泡）→ image（出图）→ done 三个节点
 *   - 失败时**不落库助手消息**：失败没有图，落一条空气泡只会让人困惑
 */
app.post("/api/image", async (req, res) => {
  const {
    sessionId,
    prompt,
    size,
    imageModel,
    providerId,
    // 会话归属（用于头像/身份）；生图本身与这个 Agent 无关
    agentId = 'workbuddy',
    cwd,
    scenarioId,
    systemPrompt,
  } = req.body;

  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) {
    return res.status(400).json({ error: "生图提示词不能为空" });
  }

  const provider = getImageProvider(providerId);
  if (!provider) {
    return res.status(404).json({ error: `未知的生图服务: ${providerId}` });
  }

  // 缺密钥时**不进入 SSE**：直接 400 带修复指引，前端能立刻给出可操作提示，
  // 而不是先挂一个气泡再在里面显示错误。
  const status = provider.status();
  if (status.availability !== 'ready') {
    return res.status(400).json({
      error: status.message || "生图服务不可用",
      availability: status.availability,
      provider: provider.id,
    });
  }

  const normalizedSize: ImageSize = (IMAGE_SIZES as readonly string[]).includes(size)
    ? (size as ImageSize)
    : DEFAULT_IMAGE_SIZE;
  const model =
    typeof imageModel === 'string' && imageModel.trim() ? imageModel.trim() : provider.defaultModel;

  const now = new Date().toISOString();

  // 会话：与 /api/chat 同一套「首条消息落库时建会话」的语义
  let session = sessionId ? db.getSession(sessionId) : null;
  if (!session) {
    console.log(`[Image] 创建生图会话，provider=${provider.id} model=${model} size=${normalizedSize}`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: `生图：${text.slice(0, 24)}${text.length > 24 ? '...' : ''}`,
      // 生图会话的「模型」就是生图模型（与文本会话同一列，语义自洽）
      model,
      agent_id: agentId,
      sdk_session_id: null,
      kind: 'direct',
      agent_ids: null,
      orchestration: null,
      cwd: cwd || null,
      scenario_id: scenarioId || null,
      system_prompt: systemPrompt || null,
      created_at: now,
      updated_at: now,
    });
  } else {
    // 老会话/从文本场景切过来的会话：缺什么补什么（与 /api/chat 一致）
    const patch: Parameters<typeof db.updateSession>[1] = {};
    if (!session.agent_id && agentId) patch.agent_id = agentId;
    if (!session.cwd && cwd) patch.cwd = cwd;
    if (!session.scenario_id && scenarioId) patch.scenario_id = scenarioId;
    if (!session.system_prompt && systemPrompt) patch.system_prompt = systemPrompt;
    if (Object.keys(patch).length > 0) {
      db.updateSession(session.id, patch);
      session = { ...session, ...patch };
    }
  }

  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: text,
      model: null,
      author_agent_id: null,
      created_at: now,
      tool_calls: null,
    });
  } catch (dbError: any) {
    console.error(`[Image] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[Image] 客户端断开，中止生图`);
      ac.abort();
    }
  });

  const sse = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sse({
    type: "init",
    sessionId: session.id,
    userMessageId,
    assistantMessageId,
    model,
    agentId,
    provider: provider.id,
  });

  const startedAt = Date.now();
  try {
    const img = await provider.generate({
      prompt: text,
      model,
      size: normalizedSize,
      signal: ac.signal,
    });

    // 立刻把字节抓回本地 —— 远端 URL 约 7 天后失效
    const cached = await cacheImage(img.url, db.imagesDir);
    if (!cached) {
      console.warn(`[Image] 本地缓存失败，将保留远端 URL（会过期）`);
    }

    const block = {
      // 缓存成功 → 指向本地（永久有效）；失败 → 退回远端 URL
      url: cached ? `/api/images/${cached.file}` : img.url,
      sourceUrl: img.url,
      prompt: img.prompt,
      size: img.size,
      model: img.model,
      provider: img.provider,
      alt: img.prompt.slice(0, 80),
    };

    try {
      db.createMessage({
        id: assistantMessageId,
        session_id: session.id,
        role: 'assistant',
        // 正文留空：图像本身就是内容，再写一遍提示词会在气泡里重复
        content: '',
        model: img.model,
        author_agent_id: agentId,
        created_at: new Date().toISOString(),
        tool_calls: null,
        images: JSON.stringify([block]),
      });
    } catch (dbError: any) {
      console.error(`[Image] 保存图片消息失败:`, dbError);
    }

    sse({ type: "image", images: [block], cached: !!cached });
    sse({ type: "done", duration: Date.now() - startedAt });
    console.log(`[Image] 生成成功 ✓ ${img.size} ${img.model}（缓存${cached ? '成功' : '失败'}）`);
  } catch (error: any) {
    const message =
      error instanceof ImageGenerationError
        ? error.message
        : error?.message || "生图失败";
    console.error(`[Image] 生成失败:`, message);
    sse({ type: "error", message });
  }

  res.end();
});

// ============= 静态资源：打包后由本进程直接托管前端 =============
//
// 开发态前端跑在 Vite dev server 上（`/api` 由 Vite 反向代理到本进程），
// 这里找不到 dist 就自动跳过；打包后 dist 随 asar 一起分发，改由本进程托管。
// 两种形态下前端访问的都是 `http://<host>/api/...`，**同一条 HTTP 通路**，
// 所以前端代码完全不需要知道自己跑在浏览器还是 Electron 里。
const webDir = process.env.OPC_WEB_DIR
  ? path.resolve(process.env.OPC_WEB_DIR)
  : path.join(process.cwd(), 'dist');

if (fs.existsSync(path.join(webDir, 'index.html'))) {
  app.use(express.static(webDir));
  // SPA 兜底：非 /api 的路径一律回 index.html。
  // 必须注册在所有 /api 路由**之后**，否则会把接口请求一起吃掉。
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });
  console.log(`[Web] 静态资源目录: ${webDir}`);
} else {
  console.log(`[Web] 未找到前端产物（${webDir}），仅提供 API —— 开发态由 Vite 托管前端`);
}

// 启动服务器
const server = app.listen(PORT, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ API 服务器已启动                      ║
║                                            ║
║     地址: http://localhost:${actualPort}            ║
║     数据库: SQLite (${process.env.OPC_DATA_DIR ? 'userData' : 'data'}/chat.db)          ║
║                                            ║
╚════════════════════════════════════════════╝
  `);

  // 启动后立刻在后台探一轮。
  //
  // 不 await：ACP 握手 20 秒以上，会拖住启动。但不做又不行 —— 探测只发生在
  // 「用户点重新探测」时的话，冷启动后整个通讯录都是「未探测」，群聊也会因为
  // 拿不到可用成员而空转。这里只负责把探测跑起来，结果由前端轮询取回。
  console.log('[Registry] 启动后台探测...');
  registry
    .probeAll()
    .then(agents => {
      const ready = agents.filter(a => a.status.availability === 'ready');
      console.log(
        `[Registry] 探测完成：${ready.length}/${agents.length} 就绪` +
          (ready.length ? `（${ready.map(a => a.name).join('、')}）` : '')
      );
    })
    .catch(err => console.error('[Registry] 启动探测失败:', (err as Error).message));
});

// 导出给 Electron 主进程用：主进程需要等 `listening` 事件拿到真实端口，
// 再决定把窗口指向哪个地址。
export { app, server };

// 退出时回收 ACP 等长驻子进程，避免留下孤儿 Python 进程
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] 收到 ${signal}，正在清理...`);
  try {
    registry.disposeAll();
  } catch (err) {
    console.error('[Server] 清理失败:', (err as Error).message);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
