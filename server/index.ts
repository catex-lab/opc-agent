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
import { findDef } from "./agents/definitions.js";
import {
  getImageProvider,
  imageProvidersStatus,
  ImageGenerationError,
  DEFAULT_IMAGE_SIZE,
  IMAGE_SIZES,
  type ImageSize,
} from "./agents/adapters/image.js";
import { cacheImage, imageFilePath } from "./image-store.js";
import { validateDirectory } from "./workspaceDir.js";
import { FS_ERROR_TEXT, listDir, type FsErrorCode } from "./fs.js";
import {
  loadAgentCredentials,
  listCredentials,
  saveCredential,
  clearCredential,
} from "./agent-credentials.js";
import { runOrchestration, isInternalPhase, type TurnPhase } from "./orchestrator.js";
import { createTurnRunner } from "./turn-runner.js";
import { runWorkflow, WORKFLOW_TEMPLATE } from "./workflow.js";
import { RunProjector } from "./agents/projector.js";
import { publishRunEvent, runHub } from "./run-hub.js";

// A38 记忆层（Hermes 式四层记忆）。注入发生在适配器拼 systemPrompt 时
// （见 server/memory.ts 的 withMemoryContext），这里只暴露读写与检索。
import {
  bootMemory,
  deleteSkill,
  listSkills,
  memoryStats,
  readCoreMemory,
  readSkill,
  readUserProfile,
  reindexMemory,
  searchMemory,
  writeCoreMemory,
  writeSkill,
  writeUserProfile,
} from "./memory.js";
// A40 权限门禁的自定义规则（JSON 配置，人可读可改）
import {
  BUILTIN_NOTE,
  PERMISSION_RULES_PATH,
  loadPermissionRules,
  savePermissionRules,
} from "./permission-rules.js";
import { distillSkill } from "./skill-distill.js";
import { textOfBlocks, toolCallsOfBlocks } from "../shared/blocks.js";
import type { RunEvent } from "../shared/blocks.js";
import {
  resolveModelForAgent,
  setCatalogModelLookup,
  PLATFORM_DEFAULT_MODEL,
} from "./model-routing.js";
import { ensureCatalogLoaded, getCatalogSummary, getDefaultModelForAgent, invalidateCatalog, isCatalogModel, loadCatalog } from "./agents/modelCatalog.js";
import { mapSdkModels } from "./agents/sdk-models.js";
import { readDeclaredModels } from "./agents/wbProductConfig.js";
import type { ModelOption } from "./agents/modelCatalog.js";
import { getScenario } from "../shared/scenarios.js";

/**
 * 把应用内保存的 Agent 凭据注入进程环境。
 *
 * **必须在任何探测之前**（registry 的首次探测发生在启动后台任务里）：
 * 否则冷启动那一轮会按「没有 Key」判成 needs-auth，用户得等 TTL 过期或
 * 手动刷新才能看到真实状态。
 */
loadAgentCredentials();

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

// 缓存可用模型列表（含 description / 免费付费角标，见 agents/sdk-models.ts）
let cachedModels: ModelOption[] = [];
/** SDK 自己声明的默认模型（`isDefault`），拿到之后优先于平台常量 */
let sdkDefaultModel: string | undefined;
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
  sdkDefaultModel = undefined;
  
  res.json({ 
    success: true, 
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

/**
 * 取 WorkBuddy（SDK 类）的模型清单，带内存缓存。
 *
 * 抽成函数是为了「刷新模型清单」能复用同一条路径 —— 之前这段逻辑内联在
 * GET 处理里，刷新入口就只能自己再写一份，两份迟早走偏。
 *
 * `force = true` 时忽略缓存重新问 SDK。返回的 `models` 可能是空数组
 * （未登录 / SDK 不给清单），**兜底用的假数据只留在 GET 处理里** ——
 * 让这个函数如实返回「没拿到」，调用方才知道该显示「未加载」还是「30 条」。
 */
async function loadSdkModels(force = false): Promise<{
  models: ModelOption[];
  defaultModel?: string;
}> {
  if (!force && cachedModels.length > 0) {
    return { models: cachedModels, defaultModel: sdkDefaultModel ?? defaultModel };
  }

  console.log("[Models] Creating session to fetch available models...");
  const session = await unstable_v2_createSession({
    cwd: process.cwd()
  });

  let mapped: { models: ModelOption[]; defaultModel?: string } = { models: [] };
  try {
    // `getAvailableModelsRaw()` 在 SDK 的 d.ts 里没有声明（标了 experimental，
    // 只有运行时实现），所以这里显式收窄类型，而不是 any 满天飞。
    const rawSession = session as unknown as {
      getAvailableModelsRaw(): Promise<unknown[]>;
    };
    const raw = await rawSession.getAvailableModelsRaw();
    if (Array.isArray(raw) && raw.length > 0) {
      // A64：SDK 的实时清单比官方产品配置旧，会把官方 cli agent 仍在用的模型漏掉
      // （本机少 9 条，含档位阶梯最顶层的「极致」deep-model）。两边互补：
      // 以 SDK 为主，只用官方配置补它没给的那些 —— 元数据也各取自己有的那份，
      // 重叠 id 一律以 SDK 为准（它的倍率更新：fast-model 在配置里还是 x0.21）。
      // 官方配置读不到就静默只用 SDK，绝不因此让菜单变空。
      let merged: unknown[] = raw;
      let filled = 0;
      const declared = readDeclaredModels();
      if (declared) {
        const have = new Set(
          raw.map(m => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
        );
        const gap = declared.declared
          .filter(id => !have.has(id))
          .map(id => declared.byId.get(id))
          .filter((m): m is NonNullable<typeof m> => !!m);
        if (gap.length > 0) {
          merged = [...raw, ...gap];
          filled = gap.length;
        }
      }
      mapped = mapSdkModels(merged);
      console.log("[Models] raw 元数据:", raw.length, "条，其中免费",
        mapped.models.filter(m => m.tag === '限时免费' || m.tag === '免费').length, "条",
        filled > 0 ? `；按官方产品配置补齐 ${filled} 条（共 ${mapped.models.length}）` : "");
    }
  } catch (e) {
    console.warn("[Models] getAvailableModelsRaw 不可用，退回 thin 列表：", (e as Error)?.message);
  }

  if (mapped.models.length === 0) {
    const models = await session.getAvailableModels();
    console.log("[Models] Got", models?.length ?? 0, "models (thin)");
    if (models && Array.isArray(models)) {
      mapped = { models: models.map(m => ({ modelId: m.modelId, name: m.name })) };
    }
  }

  if (mapped.models.length > 0) {
    cachedModels = mapped.models;
    // SDK 自己声明了默认模型（isDefault，本机是 `default-model` / Auto）。
    // 不用平台常量 `claude-sonnet-4` 冒充 —— 那个名字已经不在清单里了。
    if (mapped.defaultModel) sdkDefaultModel = mapped.defaultModel;
  }

  return { models: cachedModels, defaultModel: sdkDefaultModel ?? defaultModel };
}

// 获取可用模型列表
//
// 用 `getAvailableModelsRaw()` 而不是 `getAvailableModels()`：后者只给
// `{ modelId, name }`，把 credits（→ 免费/付费）、中文简介、上下文长度全丢了，
// 模型菜单因此只剩名字（与 opencode 的 A57 是同一类问题）。
// raw 拿不到时退回 thin，行为与改造前一致。
app.get("/api/models", async (req, res) => {
  try {
    const { models } = await loadSdkModels();
    res.json({
      models: models.length > 0 ? models : [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
      ],
      defaultModel: sdkDefaultModel ?? defaultModel
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel: sdkDefaultModel ?? defaultModel,
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

// 某个 Agent 上报的可用模型（动态目录：CLI 枚举 + models.dev 元数据）
app.get("/api/agents/:agentId/models", async (req, res) => {
  try {
    const agentId = req.params.agentId;
    const models = await registry.modelsFor(agentId);
    // 一并给出该 Agent 自己的默认模型：列表按 provider 分组后，第一条
    // 不再等于「默认模型」（opencode 的默认是 zai/glm-4.7，而列表第一条
    // 是 OpenCode Zen 的免费模型）。前端据此选初始值，不靠下标猜。
    //
    // 两级来源：定义表里写死的（opencode）优先，其次是 CLI **自己声明的**
    // （codex 的 `~/.codex/config.toml`）。都没有就不给，前端退化成列表第一条。
    const defaultModel =
      findDef(agentId)?.defaultModel ?? (await getDefaultModelForAgent(agentId));
    res.json({ models, defaultModel });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取模型列表失败" });
  }
});

// ============= 模型清单（目录）状态与刷新 =============

/**
 * 当前模型清单的概况：每个 Agent 枚举到几条 + 上次枚举完成时间。
 *
 * **不触发任何 CLI 子进程**：只读内存里的目录状态。设置页一打开就跑一遍
 * `qodercli`（7.5s）是不可接受的 —— 想真刷新是用户点按钮的动作。
 */
app.get("/api/model-catalog", async (req, res) => {
  try {
    // 首次访问时把目录带起来（启动预热通常已经完成，这里几乎瞬时返回）
    await loadCatalog();
    res.json({
      ...getCatalogSummary(),
      // WorkBuddy 走 SDK，不在 catalog 里。0 表示「还没取过」，不是「没有模型」
      workbuddyCount: cachedModels.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "读取模型清单失败" });
  }
});

/**
 * 刷新模型清单（用户主动点）。
 *
 * 两套缓存都要作废，否则会刷新一半：
 *   - `modelCatalog` 的目录（opencode / qoder / codex）→ `invalidateCatalog()`
 *   - `cachedModels`（WorkBuddy 的 SDK 清单）→ 置空后重新问 SDK
 *
 * 会真的跑三个 CLI + 建一次 SDK 会话，实测 10~15s。前端必须给 loading，
 * 别让用户以为点了没反应。
 */
app.post("/api/model-catalog/refresh", async (req, res) => {
  const startedAt = Date.now();
  try {
    invalidateCatalog();
    cachedModels = [];
    sdkDefaultModel = undefined;

    await loadCatalog(true);

    // WorkBuddy 单独重取：它不在 catalog 里。失败不影响另外三个的结果，
    // 如实回报错误，而不是把「没取到」显示成「0 个模型」。
    let workbuddy: { count: number; error?: string } = { count: 0 };
    try {
      const sdk = await loadSdkModels(true);
      workbuddy = { count: sdk.models.length };
    } catch (e) {
      workbuddy = { count: 0, error: (e as Error)?.message || String(e) };
    }

    const summary = getCatalogSummary();
    const counts = Object.entries(summary.counts)
      .map(([id, n]) => `${id}=${n}`)
      .join(' ');
    console.log(`[ModelCatalog] 用户手动刷新：${counts} workbuddy=${workbuddy.count}，耗时 ${Date.now() - startedAt}ms`);

    res.json({
      ...summary,
      workbuddy,
      tookMs: Date.now() - startedAt,
    });
  } catch (error: any) {
    console.error("[ModelCatalog] 刷新失败:", error);
    res.status(500).json({ error: error?.message || "刷新模型清单失败" });
  }
});

// ============= Agent 凭据（应用内登录）=============

/**
 * 列出可在应用内配置凭据的 Agent。
 *
 * 只返回「声明了 credential 的」——没声明的（走 OAuth / 登录态文件的）
 * 在这里列出来只会让用户填一个不生效的 Key。
 */
app.get("/api/agent-credentials", (req, res) => {
  try {
    res.json({ credentials: listCredentials() });
  } catch (error: any) {
    console.error("[Credentials] list error:", error);
    res.status(500).json({ error: error?.message || "读取凭据失败" });
  }
});

/**
 * 保存凭据并**立刻重探该 Agent**。
 *
 * 不重探的话，用户填完 Key 界面上仍是「未登录」（探测结果有 5 分钟 TTL），
 * 会以为没保存成功 —— 而这条路径最需要的就是即时反馈。
 */
app.post("/api/agent-credentials", async (req, res) => {
  try {
    const { agentId, key, baseUrl } = req.body ?? {};
    if (typeof agentId !== 'string' || !agentId) {
      return res.status(400).json({ error: "缺少 agentId" });
    }
    if (key !== undefined && typeof key !== 'string') {
      return res.status(400).json({ error: "key 必须是字符串" });
    }
    if (baseUrl !== undefined && typeof baseUrl !== 'string') {
      return res.status(400).json({ error: "baseUrl 必须是字符串" });
    }

    const credential = saveCredential(agentId, { key, baseUrl });
    // 新 Key 可能让 `opencode models` 多出若干个 provider 的模型：
    // 目录缓存必须跟着作废，否则用户填完 Key 还要等 24 小时才看见新模型。
    invalidateCatalog();
    const agent = await registry.probeOne(agentId, true);
    res.json({ credential, agent });
  } catch (error: any) {
    console.error("[Credentials] save error:", error);
    res.status(400).json({ error: error?.message || "保存凭据失败" });
  }
});

// 清除某个 Agent 在应用内保存的凭据
app.delete("/api/agent-credentials/:agentId", async (req, res) => {
  try {
    const credential = clearCredential(req.params.agentId);
    if (!credential) return res.status(404).json({ error: "该 Agent 不支持应用内凭据" });
    // 清掉 Key 后对应 provider 的模型会从 CLI 清单里消失，目录同样要重算
    invalidateCatalog();
    const agent = await registry.probeOne(req.params.agentId, true);
    res.json({ credential, agent });
  } catch (error: any) {
    console.error("[Credentials] clear error:", error);
    res.status(500).json({ error: error?.message || "清除凭据失败" });
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
    
    // 解析 tool_calls / images / blocks 的 JSON。
    // 坏值（历史遗留、手改过库）不能让整个会话打不开，所以逐条兜住。
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: parseJsonColumn(msg.tool_calls),
      images: parseJsonColumn(msg.images),
      // 有序块序列（E2）。老消息为 NULL，前端会退回旧字段还原
      blocks: parseJsonColumn(msg.blocks),
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
      // A62：思考强度档位（可选）。只在该模型真有档位表时才由前端下发，
      // 后端不校验合法性（见 SendContext.reasoningEffort 的说明）。
      reasoningEffort = null,
      scenarioId = null,
      systemPrompt = null,
    } = req.body;
    const now = new Date().toISOString();

    // A63：与 PATCH /api/sessions/:id 同一把尺子 —— 确定不存在的目录不落库。
    if (typeof cwd === 'string' && cwd && validateDirectory(cwd) === 'not-found') {
      return res.status(400).json({ error: `工作目录不存在：${cwd}` });
    }

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
      reasoning_effort: typeof reasoningEffort === 'string' && reasoningEffort ? reasoningEffort : null,
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

/**
 * A63：校验工作目录（cwd）是不是一个真能进去的目录。
 *
 * 实现在 `server/workspaceDir.ts`（拆开是为了让验证脚本能单测它 ——
 * import 本文件会连带启动服务）。三种结局的语义见那里的注释：
 * 只对**确定不存在**的值说不，查不明白的放过。
 */

// 更新会话
app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model, orchestration, agentIds, cwd, reasoningEffort, scenarioId, systemPrompt, pinned } = req.body;

    const updates: Parameters<typeof db.updateSession>[1] = { title, model };
    // 群聊头部可以随时改编排模式与成员，这里一并支持
    if (typeof orchestration === 'string') updates.orchestration = orchestration;
    if (Array.isArray(agentIds)) {
      updates.agent_ids = JSON.stringify(
        agentIds.filter((v: unknown): v is string => typeof v === 'string')
      );
    }
    // P4：工作目录与场景绑定可随时改（空串表示清除 → 存 null）
    // A63：非空值先过目录校验，确定不存在的直接 400 —— 不把坏值写进库，
    // 也不等用户发消息时才在 spawn ENOENT 里发现。
    if (typeof cwd === 'string') {
      if (cwd && validateDirectory(cwd) === 'not-found') {
        return res.status(400).json({ error: `工作目录不存在：${cwd}` });
      }
      updates.cwd = cwd || null;
    }
    // A62：思考强度同理。null = 清空档位、回到 CLI 自己的默认
    if (typeof reasoningEffort === 'string') updates.reasoning_effort = reasoningEffort || null;
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

/**
 * A63：最近用过的目录（工作区面板的「最近目录」）。
 *
 * 数据源就是 sessions.cwd 本身（见 db.getRecentDirectories 的口径注释）：
 * 用过才算，不另建表、不记「选过没用过」的幽灵条目。目录被所有会话放弃后
 * 自然从列表消失 —— 两份数据不可能各说各话。
 *
 * 这个端点**不校验目录是否还存在**：一个曾经用过、现在被删掉的目录出现在
 * 最近列表里是有信息量的（用户大概想找回它），点了再由前端的校验给反馈。
 */
app.get("/api/recent-directories", (_req, res) => {
  try {
    const directories = db.getRecentDirectories();
    res.json({ directories });
  } catch (error: any) {
    console.error("[Recent Directories] Error:", error);
    res.status(500).json({ error: error?.message || "获取最近目录失败" });
  }
});

/**
 * A77：工作区文件面板 —— 列出会话工作目录下的某一层。
 *
 * ## 为什么不接受「传一个绝对路径进来」
 *
 * 路径的根必须由**服务端**从 `session.cwd` 取，前端只能传相对路径。
 * 让前端传绝对路径，等于把「能看哪里」的决定权交给被约束方 —— 那正是
 * `shared/scenarios.ts` 里「谁约束谁」那条注释在防的事。
 *
 * ## 为什么没有 cwd 时是 409 而不是退回进程目录
 *
 * 退回 `process.cwd()` 会把应用自己的安装目录（打包态是 resources 里）
 * 当成用户的项目展示出来，看起来像「你的项目只有一堆 asar」。宁可明确
 * 说「这个会话还没绑工作目录」，也不给一个错误的根。
 */
const FS_STATUS: Record<FsErrorCode, number> = {
  "no-root": 404,
  "not-found": 404,
  "not-dir": 400,
  escape: 403,
  denied: 403,
};

app.get("/api/fs/list", (req, res) => {
  try {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!sessionId) {
      return res.status(400).json({ error: "缺少 sessionId" });
    }

    const session = db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }
    if (!session.cwd) {
      return res.status(409).json({
        error: "该会话未绑定工作目录",
        code: "no-cwd",
      });
    }

    const result = listDir(session.cwd, rel);
    if ("error" in result) {
      return res.status(FS_STATUS[result.error]).json({
        error: FS_ERROR_TEXT[result.error],
        code: result.error,
      });
    }

    res.json(result);
  } catch (error: any) {
    console.error("[Fs List] Error:", error);
    res.status(500).json({ error: error?.message || "读取目录失败" });
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
      reasoning_effort: reasoningEffort || null,
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
  const resumeToken = session.sdk_session_id;

  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

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
   */
  const REATTACH_GRACE_MS = 20_000;
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
  /** 客户端是否已断开：断开后继续跑（等重连），但不再往死连接里写 */
  let clientGone = false;
  runHub.create(runId);
  const projector = new RunProjector({
    runId,
    sessionId: session.id,
    messageId: assistantMessageId,
    agentId,
    model: selectedModel,
  });

  /** 写一条 v2 事件：带 SSE id（断线重放按它续传） */
  const writeEvent = (event: RunEvent) => {
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

  let newResumeToken: string | null = null;
  // done 事件的载荷先攒着，等落库之后再发：客户端收到 run_end 常会立刻
  // 刷新会话，句子还没落库就会在这一瞬丢一条（与群聊 turn_done 同窗口）
  let donePayload: { durationMs?: number; cost?: number; tokens?: number } | null = null;
  let hadError = false;

  const stream = registry.stream(agentId, {
    sessionId: session.id,
    prompt: message,
    systemPrompt,
    // A63：生效顺序 请求体 > 会话里存的值 > 后端进程目录。
    // 中间那一级是这轮补上的：前端每轮都会带 session.cwd，但万一哪个客户端
    // （或重新生成一类的内部路径）没带，会话里 PATCH 过的工作目录仍然该生效，
    // 而不是悄悄退回后端进程目录 —— 那正是「会话里改了工作区却不生效」的 bug。
    cwd: cwd || session.cwd || process.cwd(),
    model: selectedModel,
    // A62：档位值。老会话分支已经把本次请求 patch 进 session 了
    // （`session = { ...session, ...patch }`），所以这里读 session 即最新值；
    // 新会话分支则读请求体。`|| undefined` 把 '' → undefined，
    // 免得给 CLI 传一个空串档位。
    reasoningEffort: (session.reasoning_effort ?? undefined) || undefined,
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
      // 续接令牌要在投影之前处理：它属于会话状态，不是可渲染的块
      if (ev.type === 'init' && ev.resumeToken && ev.resumeToken !== resumeToken) {
        newResumeToken = ev.resumeToken;
        db.updateSession(session.id, { sdk_session_id: ev.resumeToken });
        console.log(`[Chat] 已保存续接令牌: ${ev.resumeToken}`);
      }

      if (ev.type === 'done') {
        donePayload = { durationMs: ev.durationMs, cost: ev.cost, tokens: ev.tokens };
      }

      if (ev.type === 'error') {
        hadError = true;
        console.error(`[Chat] ${agentId} 报错: ${ev.message}`);
        registry.recordError(agentId, ev.message);
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
    writeEvents(
      projector.push({ type: 'error', message: error?.message || "处理请求时发生错误" })
    );
  }

  // 收尾：关闭所有打开的块（文本/思考/工具），先于落库
  const runStatus = ac.signal.aborted ? 'aborted' : hadError ? 'error' : 'ok';
  const { closes, end } = projector.finish(runStatus, donePayload ?? undefined);
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
      content: textOfBlocks(blocks),
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
 */
app.get("/api/memory", (_req, res) => {
  try {
    res.json({
      core: readCoreMemory(),
      user: readUserProfile(),
      skills: listSkills().map(s => ({ name: s.name, title: s.title, tokens: s.tokens })),
      stats: memoryStats(),
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
 */
app.put("/api/memory", (req, res) => {
  try {
    const { core, user } = req.body ?? {};
    const out: Record<string, unknown> = {};
    if (typeof core === "string") out.core = writeCoreMemory(core);
    if (typeof user === "string") out.user = writeUserProfile(user);
    res.json({ ok: true, ...out, stats: memoryStats() });
  } catch (error: any) {
    console.error("[Memory] write error:", error);
    res.status(500).json({ error: error?.message || "保存记忆失败" });
  }
});

/** 全文检索（FTS5）。查询词做语法转义，输入减号也不会炸。 */
app.post("/api/memory/search", (req, res) => {
  try {
    const { query, limit } = req.body ?? {};
    if (typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "query 不能为空" });
      return;
    }
    res.json({ hits: searchMemory(query, Math.min(Number(limit) || 10, 50)) });
  } catch (error: any) {
    console.error("[Memory] search error:", error);
    res.status(500).json({ error: error?.message || "检索失败" });
  }
});

app.get("/api/memory/skills/:name", (req, res) => {
  const skill = readSkill(req.params.name);
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
  const r = writeSkill(req.params.name, body);
  if ("error" in r) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, name: r.name, stats: memoryStats() });
});

app.delete("/api/memory/skills/:name", (req, res) => {
  if (!deleteSkill(req.params.name)) {
    res.status(404).json({ error: "技能不存在" });
    return;
  }
  res.json({ ok: true, stats: memoryStats() });
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
 * 断线重放的流端点（E5）。
 *
 * 前端在流中断后带着 `after=<最后收到的 seq>` 重新连上来：
 *   - 缓冲里还有这段 → 补发缺的事件
 *   - 已经滚出缓冲 → 先发 snapshot（当前全部块），再发缓冲里的增量
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
    // 群名。用户可能在建群后、发第一条消息之前就改过群名 ——
    // 那时会话还没落库（前端是本地空壳），改名只能攒着，随首条消息一起带上。
    // 不带的话，落库时会用「首条消息前 30 字」把用户起的名字盖掉。
    title,
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

  const sse = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

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
    }, 20_000);
    timer.unref?.();
  });

  /**
   * 「让某个 Agent 就给定 prompt 发言」搬到了 server/turn-runner.ts（A41）：
   * 动态工作流的 dispatch/broadcast/relay/debate 走的是同一份实现，
   * 群聊路由只留下 SSE 与断开口。
   */
  const turn = createTurnRunner({
    session,
    model,
    cwd,
    reasoningEffort: reasoningEffort || session.reasoning_effort || undefined,
    permissionMode,
    scenarioId,
    triggerPrompt: message,
    signal: ac.signal,
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

  const members: string[] = Array.isArray(agentIds)
    ? agentIds.filter((v: unknown): v is string => typeof v === 'string')
    : [];

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

  await registry.ensureProbed(members);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

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
    }, 20_000);
    timer.unref?.();
  });

  // 触发词写明了这是工作流：A39 沉淀时能区分「一句话」和「一整段流程」
  const triggerPrompt = `[工作流] ${String(source).slice(0, 200)}`;

  const turn = createTurnRunner({
    session,
    model,
    cwd,
    reasoningEffort: reasoningEffort || session.reasoning_effort || undefined,
    permissionMode,
    scenarioId,
    triggerPrompt,
    signal: ac.signal,
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
    // A33 重新生成（与 /api/chat 同一套语义）
    regenerate = false,
    replaceMessageId,
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
      // A62：生图 provider 不是 CLI，没有推理档位这个东西 ——
      // 存 null 而不是存一个「看起来设过」的值
      reasoning_effort: null,
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
    // 重新生成（A33）与 /api/chat 同一套口径：不重复落 user 消息，
    // 并把被顶掉的那条旧图删掉
    if (!regenerate) {
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
    } else if (replaceMessageId) {
      db.deleteMessage(replaceMessageId);
    }
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
//
// ⚠️ **必须绑回环地址**，不能只写 `app.listen(PORT)`。
// 不传 host 时 Node 绑的是 `0.0.0.0`（所有网卡），Windows 防火墙会因此
// 每次都弹「是否允许公用/专用网络访问此应用」—— 每换一个打包目录启动就弹一次。
// 这个应用是纯本地的（前端由本进程托管，或开发态走 Vite 代理），
// 没有任何理由监听外网卡；绑 `127.0.0.1` 之后弹窗不再出现，
// 顺带把「同局域网内别的机器能访问你的会话接口」这个面也收掉了。
// 前端加载地址本来就是 `http://127.0.0.1:<port>`（见 electron/main.ts），
// vite 的 proxy target 也已同步改成 `127.0.0.1`。
const HOST = process.env.OPC_HOST || '127.0.0.1';
// A38：索引自愈。文件是唯一事实来源，索引随时可重建，失败不阻断启动。
bootMemory();
// A40：权限规则预热。门禁每次工具调用都读内存缓存，这里负责先填上。
loadPermissionRules();
// A57：模型目录。
//  1) 把「动态目录」注册进模型路由 —— 否则用户从菜单里选的
//     `opencode/glm-5.3-flash-free` 不在静态白名单里，会被静默换成默认模型；
//  2) 后台预热一次（CLI 枚举约 2 秒），让第一次打开模型菜单不必等。
setCatalogModelLookup(isCatalogModel);
ensureCatalogLoaded();

const server = app.listen(PORT, HOST, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ API 服务器已启动                      ║
║                                            ║
║     地址: http://${HOST}:${actualPort}            ║
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
