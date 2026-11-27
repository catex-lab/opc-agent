// 必须最先执行：剔除从宿主应用继承的内部环境变量，
// 否则 SDK 启动的 Agent CLI 会抢绑 WorkBuddy 的端口（EADDRINUSE）。
import './env.js';

import express from "express";
import { unstable_v2_createSession, unstable_v2_authenticate } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import crypto from "node:crypto";
import * as db from "./db.js";
// M01：本机 token 鉴权常量（§7.5）。shared 无副作用，四方共用。
import { OPC_HEALTH_PATH, OPC_LOCAL_TOKEN_ENV, OPC_TOKEN_HEADER } from "../shared/harness-protocol.js";
// A98：项目层。命名导入是为了让路由里读起来更直接（`db.` 前缀在
// 这些一次性调用上只是噪音）；`import * as db` 仍然保留给既有调用点。
import {
  backfillSessionProjects,
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
} from "./db.js";
// A220：会话项目归属的唯一推导入口（/api/sessions / PATCH / /api/chat 共用）。
import { projectIdForCwd } from "./project-ownership.js";
import { registry } from "./agents/registry.js";
// A222：登录流全局单飞（探测 / check-login / 显式登录共用一个 CLI）。
// loginFlowStatus / startLoginFlow 的 HTTP 路由已迁 routes/custom-agents.ts（F0-02②）。
import {
  configureLoginFlowHooks,
  isLoginFlowActive,
} from "./agents/loginFlow.js";
import { SDK_LOGIN_WAIT_MS } from "./agents/adapters/sdk.js";
import { scoreAgentSkills, type PermissionMode } from "./agents/types.js";
import { agentAcceptsModel, findDef, registerCustomDefs } from "./agents/definitions.js";
// A155：SDK 产品参数（environment / endpoint / configDir）的唯一展开点。
// 适配器与这里的两个路由共用它，避免「一处修好、另一处仍是 external」。
import { resolveSdkRuntime, sdkAuthChildFor } from "./agents/sdkRuntime.js";
// A211：WorkBuddy 官方产品配置的运行时发现（目录/端点/环境/自定义模型）。
import {
  applyWorkbuddyProfile,
  invalidateWorkbuddyProfile,
  workbuddyCustomModels,
} from "./agents/wbProductProfile.js";
// A212：数据根水位线与续接令牌对账（换根后旧 CLI 会话令牌批量作废）。
import { reconcileWorkbuddyResumeTokens } from "./agents/wbRootEpoch.js";
import {
  createCustomSpec,
  customSpecToDefinition,
  deleteCustomSpec,
  loadCustomSpecs,
  normalizeCustomInput,
  updateCustomSpec,
} from "./agents/customAgents.js";
// A223：手动接入的本地 CLI Agent（分发声明 + 启动验证）。与上面的 HTTP 自建
// 同属「用户自建」，但存储与合成定义完全分开（见模块头注释）。
import {
  createCustomCliSpec,
  customCliSpecToDefinition,
  deleteCustomCliSpec,
  loadCustomCliSpecs,
  normalizeCustomCliInput,
  resolveCustomCliCommand,
  trialCustomCli,
  updateCustomCliSpec,
} from "./agents/customCliAgents.js";
// A224：定时派活。cron 是纯函数解析器；调度器到点后对**本机**聊天路由
// 自取回（self-fetch），与手发消息走同一条链（理由见模块头注释）。
// HTTP 面已迁 server/routes/schedules.ts（F0-02②）；这里只留启动接线。
import { startScheduler, stopScheduler } from "./scheduler.js";
// A228：远程审批的 IM 通知渠道。config 存 data/notify-channels.json，
// 审批走一次性 token 的 GET 链接（IM 卡片里能点的只有链接）。
import {
  approvalBaseOf,
  consumeRemoteToken,
  loadNotifyConfig,
  notifyPermissionRequest,
  notifyTest,
  saveNotifyConfig,
  validateNotifyUrl,
  type NotifyChannelKind,
} from "./notify.js";
import { setPendingPermissionObserver } from "./agents/permissionMeta.js";
// P1 canary 与 P2 登录代管的路由已迁 server/routes/agent-roster.ts（F0-02②）；
// loginRunner 本体仍被「用户自建 Agent」分区的 /login/start·status 使用。
// A224 续：cron 解析与预览（调度器本体在 scheduler.js）
// A225：群聊并行隔离。创建 / 汇合 / 清理都在本模块，路由只管时机与 note。
import {
  cleanupWorktrees,
  createWorktrees,
  isGitWorkTree,
  mergeWorktree,
} from "./worktree.js";
// 生图路由已迁 server/routes/image.ts（F0-02②），image 适配器与缓存符号随迁。
// P2：日志侧的令牌 / 认证 URL 统一脱敏，出参侧的掩码在 agent-credentials.ts。
import { redactSecret, redactUrl } from "./log-redact.js";
// F0-02②：头像路由已迁 server/routes/avatars.ts；这两个符号仍被
// 「用户自建 Agent」分区的 Logo 路由使用，随该分区迁移时一并挪走。
import { clearAgentLogo, deleteAvatarFileIfUnused } from "./avatar-store.js";
import { validateDirectory } from "./workspaceDir.js";
// 验证闭环路由已迁 server/routes/verify.ts（F0-02②），四个模块随迁。
import { loadAgentCredentials } from "./agent-credentials.js";
import { runOrchestration, isInternalPhase, type TurnPhase } from "./orchestrator.js";
import { createTurnRunner } from "./turn-runner.js";
import { runWorkflow, WORKFLOW_TEMPLATE } from "./workflow.js";
import { RunProjector } from "./agents/projector.js";
import { runProfileOf } from "./agents/capability.js";
import { probeCapabilities } from "./agents/capability-probe.js";
import { publishRunEvent, runHub } from "./run-hub.js";
// auth 类错误（401/凭据失效）的自动善后：对该 Agent 立刻 re-probe 一次。
// 与群聊 turn-runner 走同一个模块 —— 单聊、群聊的口径必须一致。
import { maybeReprobeOnAuthError } from "./agents/auth-recovery.js";
// B2：进程级异常兜底 + Express 统一错误中间件。策略「记日志继续跑」由
// 用户拍板（桌面单窗口：进程一退就是白屏，用户没有自救手段）。
import { errorMiddleware, installCrashGuard } from "./crash-guard.js";

// A38 记忆层（Hermes 式四层记忆）。注入发生在适配器拼 systemPrompt 时
// （见 server/memory.ts 的 withMemoryContext），这里只暴露读写与检索。
import {
  bootMemory,
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
} from "./memory.js";
// A40 权限门禁的自定义规则（JSON 配置，人可读可改）
import {
  BUILTIN_NOTE,
  PERMISSION_RULES_PATH,
  loadPermissionRules,
  savePermissionRules,
} from "./permission-rules.js";
// 持久授权（2026-11-12 变体 A「该 Agent 永久」）：落库 / 撤销 / 命中查询
import { listGrants, addGrant, removeGrant } from "./permission-grants.js";
// 待授权元数据（requestId → agentId + toolName）。落库键必须来自事件流
// 而不是前端回传 —— 见 POST /api/permission-response 里的取用。
import { takePendingPermissionMeta } from "./agents/permissionMeta.js";
import { distillSkill } from "./skill-distill.js";
// A164 扩展（技能 + MCP 的统一管理）。**只读用户的 Agent 目录**，
// 不写任何 `~/.<agent>/` 下的东西 —— 见 PLAN-EXTENSIONS.md §2.1。
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
  type ExtensionKind,
} from "./extensions/store.js";
import { runImport as extRunImport, refreshItem as extRefreshItem, redactConfig, scanAllMcp } from "./extensions/import.js";
import { scanSensitive } from "./extensions/safety.js";
import { applyHits as extApplyHits, normalizeSkillBody } from "./extensions/normalize.js";
// P1 跨 Agent 知识库：独立 data/kb.sqlite，后台回填最近 90 天。
import { bootKnowledgeBase } from "./kb/indexer.js";
import { buildKbInjection } from "./kb/inject.js";
import { registerKbRoutes } from "./kb/routes.js";
// F0-02②：路由分区（绞杀者）。每区一个 register*Routes(app, deps)，
// 依赖显式传入，避免把 index.ts 的模块级闭包偷偷带过去。
import { registerModelCatalogRoutes } from "./routes/model-catalog.js";
import { registerAgentCredentialRoutes } from "./routes/agent-credentials.js";
import { registerUserProfileRoutes } from "./routes/user-profile.js";
import { registerAvatarRoutes } from "./routes/avatars.js";
import { registerPreferencesRoutes } from "./routes/preferences.js";
import { registerAgentRosterRoutes, withObservedCapabilities } from "./routes/agent-roster.js";
import { registerImageRoutes } from "./routes/image.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerCustomAgentRoutes } from "./routes/custom-agents.js";
import { registerModelRouteRoutes } from "./routes/model-routes.js";
import { registerChatRoutes, type ChatRoutesDeps } from "./routes/chat.js";
import { registerVendorComponentRoutes } from "./routes/vendor-components.js";
import { buildMcpConfig, safeAgentId } from "./extensions/distribute.js";
import { applyDrift as extApplyDrift, scanDrift as extScanDrift } from "./extensions/drift.js";
import {
  distributableTargetCount as extDistributableTargetCount,
  MATRIX_STATES as EXT_MATRIX_STATES,
  MODE_LABEL as EXT_MODE_LABEL,
  TARGETS as EXT_TARGETS,
} from "./extensions/targets.js";
import { errorTextOfBlocks, textOfBlocks, toolCallsOfBlocks } from "../shared/blocks.js";
// A207：CLI 会话里的悬空回合识别（切模型/续接前先问用户）。
import { findDanglingTurn, opencodeSessionDirectory, sameDirectory } from "./dangling.js";
// A208：HTTP 直连型 Agent 的历史装配（复用 kb 的 token 估算与预算思路）。
import { assembleHistory, HISTORY_TOKEN_BUDGET, historySummary } from "./history.js";
// CapabilityProfile 类型随名册 helper 迁 server/routes/agent-roster.ts（F0-02②）。
import type { RunEvent } from "../shared/blocks.js";
import {
  resolveModelForAgent,
  resolveStoredModelForAgent,
  setCatalogModelLookup,
  setConfiguredModelLookup,
  setPlatformModelLookup,
  SDK_DEFAULT_MODEL,
  SDK_MODEL_FALLBACK,
} from "./model-routing.js";
import { ensureCatalogLoaded, isCatalogModel } from "./agents/modelCatalog.js";
import { listCliConfiguredModels } from "./agents/cliConfiguredModels.js";
// COMING_SOON_AGENTS 的下发已随名册路由迁 server/routes/agent-roster.ts（F0-02②）。
import {
  beginRunTiming,
  isFirstContentEvent,
  noteFirstContent,
  takeRunTiming,
} from "./agents/runTimingMeta.js";
import { makeProvenance, type Provenance } from "../shared/provenance.js";
// A115/A135：用户资料与界面偏好的 HTTP 读写已迁 server/routes/*；
// 这里只保留 index.html 内联用的 prefsAsInlineScript（A135 首帧同步读取）。
import { prefsAsInlineScript } from "./preferences.js";
// i18n pilot：把系统 locale 一并注入 index.html，前端据此解析默认界面语言。
// 计算放在服务端的原因见 server/system-locale.ts 顶部注释。
import { systemLocaleTag } from "./system-locale.js";
import { mapSdkModels } from "./agents/sdk-models.js";
import { readDeclaredModels } from "./agents/wbProductConfig.js";
import type { ModelOption } from "./agents/modelCatalog.js";
import { getScenario } from "../shared/scenarios.js";
import { parsePermissionBody } from "../shared/permissions.js";

/**
 * A223：自建定义表的统一重灌入口。
 *
 * HTTP 自建（A114）与手动 CLI（A223）共用 `registerCustomDefs` 这一张运行时
 * 定义表。曾打算各管各的：但 HTTP 的增删改路由每次都整表重灌——只灌 HTTP
 * 会把已注册的 CLI 定义**静默清掉**（表是替换语义，不是合并语义），
 * 用户建完 CLI 再改一次厂商地址，CLI 就从名册上消失了。
 * 所以所有重灌都必须走这里，任何调用点不许再单独 map 一份。
 */
function reloadCustomDefs(): void {
  const defs = [
    ...loadCustomSpecs().map(customSpecToDefinition),
    ...loadCustomCliSpecs().map(customCliSpecToDefinition),
  ];
  registerCustomDefs(defs);
}

/**
 * 注册用户自建 Agent（HTTP 厂商 + 手动 CLI），再把应用内保存的凭据注入进程环境。
 *
 * **自建注册必须在 loadAgentCredentials() 之前**：那条路要按
 * `findDef(id)?.credential` 找每条 Agent 的变量名，而自建 Agent 的定义
 * 来自 data/custom-agents.json，不先注册进去就找不到 —— 冷启动那一轮
 * 探测会把用户刚建好的 Agent 判成「缺 Key」。
 *
 * **必须在任何探测之前**（registry 的首次探测发生在启动后台任务里）：
 * 否则冷启动那一轮会按「没有 Key」判成 needs-auth，用户得等 TTL 过期或
 * 手动刷新才能看到真实状态。
 */
{
  reloadCustomDefs();
  for (const def of [...loadCustomSpecs().map(customSpecToDefinition), ...loadCustomCliSpecs().map(customCliSpecToDefinition)]) {
    registry.registerCustom(def);
  }
  console.log(
    `[CustomAgents] 已注册 ${loadCustomSpecs().length} 个自建厂商、${loadCustomCliSpecs().length} 个手动 CLI`
  );
}
loadAgentCredentials();

// ════════ A228：远程审批的外发钩子 ════════
// 端口在 listen 回调才有真值（打包态 PORT=0），闭包读变量而不是常量；
// 未监听前（null）观察者直接跳过——那个阶段不该有任何待审批请求。
let serverPort: number | null = null;
{
  setPendingPermissionObserver(meta => {
    const cfg = loadNotifyConfig();
    if (!cfg.enabled || !cfg.url || serverPort === null) return;
    void notifyPermissionRequest(
      {
        requestId: meta.requestId,
        agentId: meta.agentId,
        agentName: registry.get(meta.agentId)?.name || meta.agentId,
        toolName: meta.toolName,
        sessionId: meta.sessionId,
        inputSummary: meta.inputSummary ?? '',
      },
      cfg,
      serverPort
    );
  });
}

const app = express();

// B2：进程级异常兜底。放在 app 创建之前 —— 越早越好，模块加载期的异步错误
// （如 registry 的首次探测）也算在内。幂等，被 import 多次不会重复注册。
installCrashGuard();

/**
 * 监听端口。
 *
 * `PORT=0` 表示「由系统分配一个空闲端口」—— Electron 打包后走这条路径，
 * 避免和用户已经跑着的开发服务器（3000）抢端口。真实端口在 listen
 * 回调里通过 `server.address()` 取回。
 */
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;

// Middleware
//
// A160：头像上传要先于全局解析器挂上更大的体积上限。全局 `express.json()`
// 默认 100kb，而一张 2MB 图片的 base64 约 2.7MB —— 等路由里的解析器接管时
// 全局那一个已经先 413 了；body-parser 用 `req._body` 标记「已解析」，
// 所以这条提前挂上后，下面的全局解析器会自动跳过已解析的请求。
app.use("/api/avatars", express.json({ limit: "4mb" }));
app.use(express.json());

// ── 本机 token 鉴权（M01 / 设计 §7.5，必须在所有路由注册之前）──────────────
//
// 只有当环境带 OPC_LOCAL_TOKEN 时才启用 —— 也就是「harness 子进程被 main
// 拉起」这一条链。三个豁免面：
//   · `/api/health` —— main 看门狗与闸门要在**无 token** 时探活；
//   · 静态资源（不在 /api 下）—— 窗口加载的就是本进程托管的页面，
//     页面本身就是同一份信任边界，token 只护 API 数据面；
//   · env 缺省（老路 / 浏览器 dev / 既有闸门）—— 完全不挂中间件，
//     行为与改造前逐字节一致（flag 关闭回归的硬保证）。
//
// 比较用 sha256 后 timingSafeEqual：timingSafeEqual 要求等长输入，直接比
// 会在长度不同时提前抛错泄漏长度信息；先哈希再比既等长又恒时。
const localToken = process.env[OPC_LOCAL_TOKEN_ENV];
if (localToken) {
  const expectedTokenHash = crypto.createHash('sha256').update(localToken).digest();
  app.use('/api', (req, res, next) => {
    if (req.path === OPC_HEALTH_PATH.slice('/api'.length)) return next();
    const got = req.header(OPC_TOKEN_HEADER);
    if (got) {
      const gotHash = crypto.createHash('sha256').update(got).digest();
      if (crypto.timingSafeEqual(gotHash, expectedTokenHash)) return next();
    }
    res.status(401).json({ error: 'unauthorized' });
  });
}

// SDK 模型缓存状态 + 统一失效入口抽在 server/model-cache.ts，
// 让闸门能 import 到函数本体（内联在这里时单测拿不到）。
import {
  cachedModels as _sdkCache,
  sdkDefaultModel as _sdkDefault,
  sdkModelsProbedAt as _sdkProbedAt,
  _setSdkCache,
  _setSdkProbedAt,
  invalidateAllModelCaches,
} from "./model-cache.js";
// C8：SSE 静默心跳。独立文件，闸门可直接 import 函数本体验证。
import { startSseHeartbeat } from "./sse-heartbeat.js";

// cachedModels / sdkDefaultModel / sdkModelsProbedAt 现在是 model-cache.ts 导出的
// `let` 变量。index.ts 里仍需要「读写同一份可变引用」—— 用 getter 转发，
// 避免 `import { cachedModels }` 拿到的是冻结快照（ESM live binding 在 `let`
// reassignment 下不可靠：有的 bundler 会优成 const 引用）。
const cachedModelsGetter = () => _sdkCache;
const sdkDefaultGetter = () => _sdkDefault;
const sdkProbedGetter = () => _sdkProbedAt;

// SDK 未加载时的默认值：用 SDK 自己的默认别名，不用已下线的具体型号。
// 模型路由规则见 model-routing.ts
const defaultModel = SDK_DEFAULT_MODEL;
/** 让「旧会话失效模型」判定拿到当前 SDK 清单（清单未就绪时返回 null） */
setPlatformModelLookup(() => (cachedModelsGetter().length > 0 ? cachedModelsGetter().map(m => m.modelId) : null));

/**
 * A210：把「用户在本机 CLI 配置里自己写的模型名」注入模型路由。
 *
 * 为什么带 10 秒缓存：`resolveModelForAgent()` 每一轮对话都会调一次，
 * 而扫描要读 `~/.claude` / `~/.codex` / `~/.config/opencode` 三处文件。
 * 每轮都扫盘既没必要，也会在配置目录位于网络盘时拖慢首字。
 * 用户改了 CLI 配置后最多 10 秒生效；模型菜单每次打开都会重新扫一遍，
 * 所以界面上不会因为这份缓存显示过期条目。
 *
 * 归属要**二次过滤** `agentAcceptsModel()`：扫描器是零依赖纯模块，
 * 不知道注册表里谁真的吃 `--model`。给不吃模型参数的 Agent 放行，
 * 就等于在菜单里放一条点了必然被忽略的选项。
 */
const CONFIGURED_CACHE_TTL_MS = 10_000;
let configuredCache: { at: number; byAgent: Map<string, Set<string>> } | null = null;
setConfiguredModelLookup((agentId, modelId) => {
  if (!configuredCache || Date.now() - configuredCache.at > CONFIGURED_CACHE_TTL_MS) {
    const byAgent = new Map<string, Set<string>>();
    for (const m of listCliConfiguredModels()) {
      for (const a of m.agentIds) {
        if (!agentAcceptsModel(a)) continue;
        let set = byAgent.get(a);
        if (!set) {
          set = new Set<string>();
          byAgent.set(a, set);
        }
        set.add(m.id);
      }
    }
    /* A211：WorkBuddy 桌面端的自定义模型单独灌进 lookup。
     *
     * 它 `agentAcceptsModel()` 为 false（不吃 CLI `--model`），所以上面的
     * 通用循环会把它滤掉；但 SDK 的 `session.setModel()` 确实认这些 id。
     * 这里登记只影响 `isStaleSdkModel()` —— 不豁免的话用户刚选的自定义模型
     * 会在下一轮被当成「已下线的旧 SDK 模型」静默抹掉，表现为「选完能用，
     * 刷新会话就没了」。它不会让任何 CLI Agent 多拿到一个 --model 参数。 */
    for (const m of workbuddyCustomModels()) {
      let set = byAgent.get('workbuddy');
      if (!set) {
        set = new Set<string>();
        byAgent.set('workbuddy', set);
      }
      set.add(m.id);
    }
    configuredCache = { at: Date.now(), byAgent };
  }
  return configuredCache.byAgent.get(agentId)?.has(modelId) ?? false;
});

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

/**
 * A155：取某个 SDK 类 Agent 的运行参数。
 *
 * 定义表是唯一来源 —— 三项目前在 WorkBuddy 条目上声明（internal /
 * https://www.workbuddy.cn / ~/.workbuddy）。这里不写任何默认值：
 * 条目没声明就按 SDK 自己的默认走（external + ~/.codebuddy），
 * 这样新增 SDK 产品时不会因为「漏配」被悄悄接到别的产品上而看不出来。
 */
/**
 * A222：登录收口后的善后。
 *
 * 不能只靠前端 60 秒的轮询变绿：`GET /api/agents` 只回后端缓存，
 * `ensureProbedInBackground()` 有 probedOnce 闸门，用户不点「重新探测」
 * 就永远停在 needs-auth。所以由服务端在流结束时主动作废官方 profile
 * 缓存并强制重探一次（只有成功才重探，失败不制造新一轮 CLI）。
 */
configureLoginFlowHooks({
  onSettled: (agentId, ok) => {
    invalidateWorkbuddyProfile();
    if (ok) void registry.probeOne(agentId, true).catch(() => {});
  },
});

function sdkRuntimeFor(agentId: string) {
  // A211：WorkBuddy 的三项参数不再吃定义表里的静态快照，而是从官方产品配置
  // 运行时派生（其它 SDK Agent 原样）。与 SdkAdapter 构造器共用同一个函数，
  // 避免两处各自解析再次分叉。
  return resolveSdkRuntime(applyWorkbuddyProfile(findDef(agentId)?.sdk, agentId));
}

// 检查 WorkBuddy（SDK 通道）的登录状态
app.get("/api/check-login", async (req, res) => {
  // A222 契约是「60 秒内必须有应答」。实测（2026-11-24）WorkBuddy CLI 偶发
  // initialize 慢到撞满厂商 SDK 传输层的 60s 硬超时（@tencent-ai/agent-sdk
  // process-transport），我们传的 `timeout: SDK_LOGIN_WAIT_MS` 管不到
  // initialize 阶段 —— 契约靠「CLI 今天心情好」满足。这里加一道 50s 总预算
  // 竞速：无论 CLI 多慢，路由都在闸门红线之前给出诚实错误。
  const CHECK_LOGIN_HARD_CAP_MS = 50_000;
  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };

  // A222：有登录流在跑就**直接让路**。原来这里连 timeout 都没给，一个
  // 「查登录」的 GET 会起一个 300 秒的 CLI 登录流，与探测流互相顶掉会话。
  if (isLoginFlowActive()) {
    response.error = '登录流程进行中，请先在浏览器里完成登录';
    return res.json(response);
  }

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
  // A222：有登录流在跑时上面已经让路；这里只剩 authenticate 一条路，
  // 总预算 = 硬帽竞速。竞速超时后底层 CLI 会自己走到它的 60s 传输层超时，
  // 迟到的 resolve/reject 只影响局部变量（response 已发出），挂 .catch 防未处理拒绝。
  try {
    let needsLogin = false;

    const authPromise = unstable_v2_authenticate({
      // A155：以前写死 environment: 'external' —— 查的是 CodeBuddy 国际站，
      // WorkBuddy 桌面端的登录态在 ~/.workbuddy，这里必须用同一套参数。
      ...sdkRuntimeFor('workbuddy'),
      // A231：authenticate 不透传 settingSources，登录类子进程一律套 shim
      // （SDK 默认 --setting-sources none 会让「已登录」也显示未登录）。
      ...sdkAuthChildFor(sdkRuntimeFor('workbuddy')),
      // A222：显式预算。SDK 默认 300000ms，会让这个 GET 挂 5 分钟并常驻
      // 一个登录 CLI；与探测共用 8 秒口径，需要真登录请走 /login/start。
      timeout: SDK_LOGIN_WAIT_MS,
      onAuthUrl: async (authState) => {
        // 如果执行到这个回调，说明未登录
        needsLogin = true;
        // authUrl 的 query 里带 OAuth state / code，明文入日志等于把一次性凭据写进文件
        console.log('[Check Login] 需要登录，认证 URL:', redactUrl(authState.authUrl));
        // 将认证 URL 返回给前端（如果需要）
        response.error = '未登录，请先登录 WorkBuddy';
      }
    });
    authPromise.catch(() => { /* 竞速超时后的迟到拒绝：response 已发出，吞掉防 unhandled */ });
    const result = await Promise.race([
      authPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`check-login 总预算（${CHECK_LOGIN_HARD_CAP_MS / 1000}s）耗尽：WorkBuddy CLI initialize 过慢`)),
          CHECK_LOGIN_HARD_CAP_MS
        )
      ),
    ]);
    
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
  
  // 凭据/环境变更后两套缓存都要作废，否则用户看到的清单还是旧的
  invalidateAllModelCaches('POST /api/env 环境变量变更');
  
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
  if (!force && cachedModelsGetter().length > 0) {
    return { models: cachedModelsGetter(), defaultModel: sdkDefaultGetter() ?? defaultModel };
  }

  // 真的要问 SDK 了才记时间；命中上面那条缓存分支时保留原始取数时刻
  _setSdkProbedAt(Date.now());
  console.log("[Models] Creating session to fetch available models...");
  const session = await unstable_v2_createSession({
    // A155 / A211：取模型清单必须和对话、登录检查连到**同一个产品版本**。
    // sdkRuntimeFor() 现在按生效 profile 派生三项；写死国内版会在官方把活跃
    // 目录切到 .workbuddy-ai 之后拿回另一套清单，或直接 401。
    ...sdkRuntimeFor('workbuddy'),
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
    _setSdkCache(mapped.models, mapped.defaultModel);
  }

  return { models: cachedModelsGetter(), defaultModel: sdkDefaultGetter() ?? defaultModel };
}

/**
 * P0：WorkBuddy（SDK）模型清单的溯源。
 *
 * `verified` 恒为 false：SDK 会话是在本机创建的，清单来自它自己的元数据，
 * 我们**没有**拿当前账号去校验哪些模型真的还有积分 / 在体验套餐内。
 * 界面把这句话写出来，用户才不会拿输入框里的名字当成实时的权益事实。
 * 还没取过就返回 null —— 前端会显示「数据来源与时间未知」，不编一个时间。
 */
function sdkModelsProvenance(): Provenance | null {
  if (!sdkProbedGetter()) return null;
  return makeProvenance("WorkBuddy SDK getAvailableModelsRaw() + 官方产品配置补齐", {
    probedAt: sdkProbedGetter(),
    verified: false,
    note:
      cachedModelsGetter().length > 0
        ? "清单来自 SDK 会话，未校验当前账号的积分 / 体验套餐是否可用"
        : "这次没取到清单，界面显示的是内置兜底项，不代表当前账号可用",
  });
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
      // 兜底只给 SDK 自己的默认别名，不硬编码具体型号 ——
      // 否则 SDK 加载失败时界面会冒出已下线的假选项。
      models: models.length > 0 ? models : [...SDK_MODEL_FALLBACK],
      defaultModel: sdkDefaultGetter() ?? defaultModel,
      provenance: sdkModelsProvenance()
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [...SDK_MODEL_FALLBACK],
      defaultModel: sdkDefaultGetter() ?? defaultModel,
      provenance: sdkModelsProvenance(),
      error: error?.message || String(error)
    });
  }
});

// ============= Agent 名册 API =============
// F0-02②：名册 / 登录代管 / canary 七条路由 + 两个合并 helper 已原样迁往
// server/routes/agent-roster.ts（行为零改动）。`withObservedCapabilities`
// 仍被下面「用户自建 Agent」分区的详情路由使用，从 routes 文件导入。
// ⚠️ 注册顺序不变：login-terminal 必须仍先于 /api/agents/:agentId 注册。
registerAgentRosterRoutes(app);

// ============= 厂商运行组件（瘦身批次 2）=============
// Codex / Claude 的平台二进制不再随安装包分发，改为按需下载到 data/vendor/。
// 与名册分开：这是「机器上有没有这个文件」，不是 Agent 的登录/可用状态。
registerVendorComponentRoutes(app);

// ============= 用户资料（A115）/ 头像图片（A160）/ 界面偏好（A135）=============
// F0-02②：三个分区已原样迁往 server/routes/*（行为零改动），注册顺序与拆分前一致。
registerUserProfileRoutes(app);
registerAvatarRoutes(app);
registerPreferencesRoutes(app);

// ============= 用户自建 Agent（A114）=============
// F0-02②：25 条自建/登录/账户/能力路由已原样迁 server/routes/custom-agents.ts
//（行为零改动）。注册顺序与拆分前一致（仍在名册之后、模型清单之前）。
// configuredCache 与 reloadCustomDefs 是 index.ts 模块内状态，经 deps 注入：
// 前者由 routes 侧重置，后者是启动注册块与路由共用的唯一重灌入口。
registerCustomAgentRoutes(app, {
  resetConfiguredCache: () => {
    configuredCache = null;
  },
  reloadCustomDefs,
});

// ============= 模型清单（目录）状态与刷新 =============
// F0-02②：已迁至 server/routes/model-catalog.ts。`cachedModels` 是可变引用、
// `loadSdkModels` 是模块内闭包，两者用 deps 显式注入。
registerModelCatalogRoutes(app, {
  cachedModelCount: () => cachedModelsGetter().length,
  loadSdkModels,
});

// ============= Agent 凭据（应用内登录）=============
// F0-02②：已迁至 server/routes/agent-credentials.ts。
registerAgentCredentialRoutes(app);

// 用户自定义模型路由：与凭据分离，只存 provider/model 与引用名。
registerModelRouteRoutes(app);


// ============= 会话 API =============
// F0-02②：12 条会话/目录/文件面板/CDP 路由已原样迁 server/routes/sessions.ts
//（行为零改动，parseJsonColumn 与 FS_STATUS 随迁）。注册顺序与拆分前一致。
registerSessionRoutes(app);

// ============= 聊天 API =============
// F0-02③：49 条聊天/群聊/工作流/历史路由已原样迁 server/routes/chat.ts（行为零改动）。
// 注册顺序与拆分前一致（会话之后、生图之前）。
const CHAT_ROUTES_DEPS: ChatRoutesDeps = {
  serverPort,
  port: PORT,
};
registerChatRoutes(app, CHAT_ROUTES_DEPS);

registerImageRoutes(app);

// ============= 静态资源：打包后由本进程直接托管前端 =============
//
// 开发态前端跑在 Vite dev server 上（`/api` 由 Vite 反向代理到本进程），
// 这里找不到 dist 就自动跳过；打包后 dist 随 asar 一起分发，改由本进程托管。
// 两种形态下前端访问的都是 `http://<host>/api/...`，**同一条 HTTP 通路**，
// 所以前端代码完全不需要知道自己跑在浏览器还是 Electron 里。
// ============= 验证闭环（A97）=============
// F0-02②：四条验证/核对路由已原样迁 server/routes/verify.ts（行为零改动）。
registerVerifyRoutes(app);

// 知识库接口：范围/回填/重建/会话开关。界面在 P1 之外单独做。
registerKbRoutes(app);

// ════════ A224：定时派活 ════════
// F0-02②：五条 /api/schedules 路由已原样迁 server/routes/schedules.ts（行为零改动）；
// 调度器本体（startScheduler/stopScheduler）的启动接线仍在下方 startServer() 内。
registerScheduleRoutes(app);

const webDir = process.env.OPC_WEB_DIR
  ? path.resolve(process.env.OPC_WEB_DIR)
  : path.join(process.cwd(), 'dist');

/**
 * 返回 index.html，并把界面偏好**内联**进 `<head>`（A135）。
 *
 * ## 为什么内联，而不是让前端 `fetch('/api/preferences')`
 *
 * 透明度与栏宽必须在**首帧之前**写到 `<html>` 上，否则启动会先按默认值画一遍
 * 再跳过去（界面先实色一下、列表栏先窄后宽）。fetch 是异步的，赶不上首帧。
 *
 * ## 为什么不改成 `<script src="/api/preferences.js">`
 *
 * 那会多一个请求，而 `verify:*` 的浏览器闸门普遍把 `**\/api/**` 全量拦成夹具
 * JSON —— 脚本标签拿到 JSON 会当 JS 解析、在控制台报语法错，而多条闸门
 * （`verify:p6-ui` 等）断言「控制台无错误」。内联不产生任何额外请求。
 *
 * ## 为什么不缓存
 *
 * 这份 HTML 每个进程只生成一次、内容随偏好变。缓存住等于「改了偏好要清缓存
 * 才生效」，而这个文件只有几十 KB、又是启动时唯一一次请求。
 */
function sendIndexHtml(res: express.Response) {
  const indexPath = path.join(webDir, 'index.html');
  let html: string;
  try {
    html = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    // 产物被删了一半：退回 sendFile 让浏览器拿到正常的 404/500，
    // 而不是这里抛出去把进程带崩。
    res.sendFile(indexPath);
    return;
  }
  const prefsSrc = prefsAsInlineScript();
  // 系统 locale 与偏好同一个内联脚本：多一个 <script> 就要多算一条 CSP hash，
  // 合并后只保留既有那一处 inline 豁免。`<` 仍需转义（标签来自环境变量）。
  const localeSrc = `window.__OPC_SYSTEM_LOCALE__=${JSON.stringify(systemLocaleTag()).replace(
    /</g,
    '\\u003c'
  )};`;
  const inlineSrc = prefsSrc + localeSrc;
  const script = `<script>${inlineSrc}</script>`;
  // 没有 </head> 的 HTML 不合法，但真遇到也不该整页打不开 —— 那就退化成
  // 「没注入」，前端会回落到 localStorage（见 src/prefs.ts 的读取顺序）。
  const injected = html.includes('</head>')
    ? html.replace('</head>', `${script}</head>`)
    : html;
  res.setHeader('Cache-Control', 'no-store');
  // CSP（公开前 A145）：主窗口只有本地服务这一个 origin，静态资源全走 `self`。
  //   · 内联的偏好脚本是唯一一处 inline，用 SHA-256 精确放行，不开放 `unsafe-inline`；
  //   · `style-src 'unsafe-inline'` 保留 —— React 组件大量 `style={{…}}`，
  //     这是 SPA 的常规低风险豁免（样式注入的危险性远低于脚本注入）；
  //   · SSE 流（EventSource / fetch）走同源，`connect-src 'self'` 即覆盖。
  const cspHash = 'sha256-' + crypto.createHash('sha256').update(inlineSrc, 'utf8').digest('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; ` +
      `script-src 'self' '${cspHash}'; ` +
      `style-src 'self' 'unsafe-inline'; ` +
      `img-src 'self' data: blob:; ` +
      `font-src 'self' data:; ` +
      `connect-src 'self'; ` +
      `object-src 'none'; ` +
      `base-uri 'self'; ` +
      `frame-ancestors 'none'; ` +
      `form-action 'self'`
  );
  res.type('html').send(injected);
}

if (fs.existsSync(path.join(webDir, 'index.html'))) {
  // 必须先于 express.static 注册：静态中间件会把 `/` 直接吃成未注入的 index.html。
  app.get(['/', '/index.html'], (_req, res) => sendIndexHtml(res));
  app.use(express.static(webDir));
  // SPA 兜底：非 /api 的路径一律回 index.html。
  // 必须注册在所有 /api 路由**之后**，否则会把接口请求一起吃掉。
  app.get(/^(?!\/api\/).*/, (_req, res) => sendIndexHtml(res));
  console.log(`[Web] 静态资源目录: ${webDir}`);
} else {
  console.log(`[Web] 未找到前端产物（${webDir}），仅提供 API —— 开发态由 Vite 托管前端`);
}

// ════════ B2：统一错误出口（必须在所有路由与静态/SPA 兜底之后）════════
// 四条路由分区各自 try/catch 过的错误不会走到这里；漏接的异步错误（`next(err)`
// 或 `async` handler 抛错）会落到这里，统一转成 500 JSON，不泄露 stack。
// 放在 static/SPA 之后：静态请求出错也应返回 JSON 而不是被当成页面路径。
app.use(errorMiddleware);

/**
 * C1 / 绞杀者第 0 期：后端启动收敛到显式函数。
 *
 * import 本模块不再自启动 —— harness 可独立测试/重启；electron 主进程显式调用
 * startServer()。直接执行本文件（npm run dev:server / tsx watch server/index.ts）
 * 时由文件末尾的自启动守卫调用，行为与改造前完全一致。
 *
 * server 是模块级 live binding：electron/main.ts import 的 server 在 startServer()
 * 赋值后即可见（ESM let 导出是活绑定）。
 */
export let server: ReturnType<typeof app.listen> | null = null;

/** 启动 HTTP 服务 + 全部启动期副作用，返回 server。可重复调用（幂等：已监听则直接返回）。 */
export function startServer() {
  // 幂等：listen 是异步的，server 一创建就要挡住第二次调用，
  // 不能等 listening=true（否则两次调用间隔内会 EADDRINUSE）。
  if (server) return server;

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
// M01：上一代进程没来得及收尾的 run 一律记 interrupted（「进行中的回合记
// 中断、不假装完成」的落库终点）。老库没有 runs 表时这里也安全（CREATE
// TABLE IF NOT EXISTS 已在建表块里）。失败不阻断启动。
try {
  const swept = db.sweepInterruptedRuns();
  if (swept > 0) console.log(`[Runs] 启动清算：${swept} 条进行中回合已记为中断`);
} catch (e) {
  console.warn('[Runs] 启动清算失败（不影响启动）:', (e as Error).message);
}
// A38：索引自愈。文件是唯一事实来源，索引随时可重建，失败不阻断启动。
bootMemory();
// P1 知识库：建库 + 挂消息落库监听 + 后台回填最近 90 天。
// 失败只告警，不影响聊天主链路 —— `chat.db` 才是用户数据的唯一事实来源。
try {
  bootKnowledgeBase();
} catch (e) {
  console.warn('[KB] 知识库初始化失败（不影响启动）:', (e as Error).message);
}
// A98：老会话按 cwd 回填项目归属。幂等，失败不阻断启动 ——
// 回填不上只会退化成「这个会话用全局记忆」，与改造前的行为一致。
// A131：明细日志挪进 `backfillSessionProjects()` —— 只有它知道跳过了几个已不存在的目录。
try {
  backfillSessionProjects();
} catch (e) {
  console.warn('[DB] 项目回填失败（不影响启动）:', (e as Error).message);
}
// A40：权限规则预热。门禁每次工具调用都读内存缓存，这里负责先填上。
loadPermissionRules();
// A212：WorkBuddy 续接令牌纪元对账。应用关着时官方也可能换数据根 ——
// 启动这一次保证「开箱第一条消息」就不会撞上旧纪元令牌。失败不阻断启动。
try {
  reconcileWorkbuddyResumeTokens();
} catch (e) {
  console.warn('[WB] 续接令牌对账失败（不影响启动）:', (e as Error).message);
}
// A57：模型目录。
//  1) 把「动态目录」注册进模型路由 —— 否则用户从菜单里选的
//     `opencode/glm-5.3-flash-free` 不在静态白名单里，会被静默换成默认模型；
//  2) 后台预热一次（CLI 枚举约 2 秒），让第一次打开模型菜单不必等。
setCatalogModelLookup(isCatalogModel);
ensureCatalogLoaded();

server = app.listen(PORT, HOST, () => {
  // 回调在 listen 成功后才触发，此时模块级 server 必已赋值；TS 闭包内不追值，
  // 这里显式断言（startServer 内部，非 null）。
  const srv = server!;
  const addr = srv.address();
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

  // A224：定时派活。必须在拿到真实端口之后启动（打包态 PORT=0，
  // 自取回要按 actualPort 回环请求）。
  serverPort = actualPort;
  startScheduler({ port: actualPort, host: HOST });

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

  return server;
}

// 导出给 Electron 主进程用：主进程需要等 `listening` 事件拿到真实端口，
// 再决定把窗口指向哪个地址。
export { app };

// 退出时回收 ACP 等长驻子进程，避免留下孤儿 Python 进程
let shuttingDown = false;
/**
 * 优雅退出（M01 起导出给 harness 入口复用）：停调度 + 回收全部 agent
 * 子进程。幂等；SIGINT/SIGTERM 与 harness 的「父进程死亡」都汇到这一处。
 */
export function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] 收到 ${signal}，正在清理...`);
  try {
    // A224：先停调度循环，避免清理期间又触发一轮
    stopScheduler();
    registry.disposeAll();
  } catch (err) {
    console.error('[Server] 清理失败:', (err as Error).message);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * 自启动守卫：只在「直接执行本文件」时启动（dev:server / node server/index.ts）。
 * 被 import（electron 主进程 / 闸门）时不自启动——由调用方显式 startServer()。
 *
 * ⚠️ CJS 兼容（build-electron.mjs 把本模块内联进 main.cjs，format:'cjs'）：
 * esbuild 的 empty-import-meta 会把 `import.meta` 替换成 `{}`，此时
 * `import.meta.url` 是 undefined。若直接 fileURLToPath(import.meta.url) 会在
 * **模块加载期**抛 TypeError，拖垮打包态主进程（startServer 都还没机会跑）。
 * 这里判字符串：CJS 里 url 不是 string → 跳过自启动（electron 已显式调用），
 * 只留 ESM 直接运行路径（tsx watch server/index.ts）生效。
 */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
{
  const selfUrl = (import.meta as { url?: unknown }).url;
  if (typeof selfUrl === 'string') {
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
    const self = realpathSync(fileURLToPath(selfUrl));
    if (entry === self) startServer();
  }
}
