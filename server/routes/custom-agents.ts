/**
 * 用户自建 Agent（A114）。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动（整区含注释逐行搬运）。
 * 25 条路由 + 4 个区内局部函数（resolveProviderKey / agentModelsProvenance /
 * workbuddyProfileResponse / rebindWorkbuddyRuntime）随区迁出。
 * 依赖 import 自各自模块；index.ts 独有的可变引用走 deps 注入（如有）。
 */

import type { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db.js';
import { makeProvenance, type Provenance } from '../../shared/provenance.js';
import { agentAcceptsModel, findDef, registerCustomDefs } from '../agents/definitions.js';
import { clearAgentLogo, deleteAvatarFileIfUnused } from '../avatar-store.js';
import { clearCredential, getRawCredentialKey, saveCredential } from '../agent-credentials.js';
import {
  createCustomSpec,
  customSpecToDefinition,
  deleteCustomSpec,
  loadCustomSpecs,
  normalizeCustomInput,
  updateCustomSpec,
} from '../agents/customAgents.js';
import {
  createCustomCliSpec,
  customCliSpecToDefinition,
  deleteCustomCliSpec,
  loadCustomCliSpecs,
  normalizeCustomCliInput,
  resolveCustomCliCommand,
  trialCustomCli,
  updateCustomCliSpec,
} from '../agents/customCliAgents.js';
import { isValidAgentId, registry } from '../agents/registry.js';
import { getCatalogSummary, getDefaultModelForAgent } from '../agents/modelCatalog.js';
import {
  getPinnedProfile,
  invalidateWorkbuddyProfile,
  setPinnedWorkbuddyProfile,
  workbuddyCustomModels,
  workbuddyState,
} from '../agents/wbProductProfile.js';
import { invalidateAllModelCaches } from '../model-cache.js';
import { isProviderDialect } from '../../shared/providerUrl.js';
import { listCliConfiguredModels } from '../agents/cliConfiguredModels.js';
import { listProviderModels, testProvider } from '../agents/providerTest.js';
import { probeAccount } from '../agents/accountProbe.js';
import { probeCapabilities } from '../agents/capability-probe.js';
import { getVerdicts, mergeOfficialExtras, probeModels, readOfficialModels } from '../agents/modelAvailability.js';
import { readAgentConfigModels } from '../agents/agentConfigModels.js';
import { reconcileWorkbuddyResumeTokens } from '../agents/wbRootEpoch.js';
import { loginFlowStatus, startLoginFlow } from '../agents/loginFlow.js';
import { verifyCredential } from '../credential-verify.js';
import { modelRoutesForAgent } from '../modelRoutes.js';
import { routeLabel, routeToValue } from '../../shared/model-route.js';
import { withObservedCapabilities } from './agent-roster.js';


export interface CustomAgentRoutesDeps {
  /** 清空「配置模型归属」缓存（index.ts 的 lookup 闭包持有；重置由 routes 侧触发） */
  resetConfiguredCache: () => void;
  /** 自建定义表统一重灌（index.ts 模块内函数；启动注册块与路由共用同一入口） */
  reloadCustomDefs: () => void;
}

export function registerCustomAgentRoutes(app: Express, deps: CustomAgentRoutesDeps): void {
// ============= 用户自建 Agent（A114）=============
// ⚠️ 这三条必须排在 `/api/agents/:agentId` **之前**注册：Express 按注册顺序
// 匹配，`:agentId` 会把 "custom" 当成一个 agent id 吃掉，返回 404。
// 只列定义、不回传 Key —— 列表接口不该带密钥出门。
app.get("/api/agents/custom", async (_req, res) => {
  try {
    res.json({ agents: loadCustomSpecs() });
  } catch (error: any) {
    console.error("[CustomAgents] List error:", error);
    res.status(500).json({ error: error?.message || "获取自建 Agent 失败" });
  }
});

app.post("/api/agents/custom", async (req, res) => {
  try {
    const norm = normalizeCustomInput(req.body);
    if (!norm.ok) return res.status(400).json({ error: norm.error });
    const apiKey = String((req.body as any)?.apiKey ?? "").trim();
    if (!apiKey) return res.status(400).json({ error: "请填写 API Key" });

    const spec = createCustomSpec(norm.value);
    const def = customSpecToDefinition(spec);
    // 先把定义注册进 definitions，**再**存 Key：saveCredential() 内部要按
    // `findDef(id)?.credential` 找变量名，定义还没注册就找不到，会抛
    // 「该 Agent 不支持在应用内配置凭据」—— 顺序反了创建必然失败。
    deps.reloadCustomDefs();
    registry.registerCustom(def);
    // Key 走既有凭据存储：一份只存定义、一份只存密钥，设置页「登录配置」
    // 因此能直接换 Key，不必删掉重建。saveCredential 内部会顺手把它注入
    // process.env，所以紧接着的探测立刻就能看到「已配置」。
    saveCredential(spec.id, { key: apiKey });
    // 建完立刻探一次：用户下一步就是去点这个 Agent，等 5 分钟 TTL 或手动
    // 刷新才看到「缺 Key / 已就绪」会很困惑。探测只做一次网络往返，不贵。
    const agent = await registry.probeOne(spec.id, true);
    res.json({ agent, id: spec.id });
  } catch (error: any) {
    console.error("[CustomAgents] Create error:", error);
    res.status(500).json({ error: error?.message || "创建自建 Agent 失败" });
  }
});

/**
 * 解析连通性测试要用的 Key。
 *
 * 三级来源：表单里刚填的（还没保存）→ 已保存的（编辑时没重填）→ 进程环境
 * （开发态 export 的）。只对 `custom-` 开头的 id 读已保存值：否则这个接口
 * 就成了「拿内置 Agent 的凭据去打任意地址」的通道。
 */
function resolveProviderKey(body: Record<string, unknown>): { key: string; error?: string } {
  const typed = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (typed) return { key: typed };
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (agentId.startsWith("custom-")) {
    const stored = getRawCredentialKey(agentId);
    if (stored) return { key: stored };
    const envName = findDef(agentId)?.authEnvs?.find(n => (process.env[n] ?? "").trim());
    if (envName) return { key: process.env[envName]!.trim() };
  }
  return { key: "", error: "请填写 API Key" };
}

// 拉模型清单。没保存也能调：用户填完地址和 Key 先看有什么模型，再勾选。
app.post("/api/agents/custom/models", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const baseUrl = String(body.baseUrl ?? "").trim();
    const dialect = isProviderDialect(body.dialect) ? body.dialect : "openai";
    if (!baseUrl) return res.status(400).json({ error: "请填写 API 地址" });
    const { key, error } = resolveProviderKey(body);
    if (error) return res.status(400).json({ error });
    res.json(await listProviderModels({ baseUrl, dialect, apiKey: key }));
  } catch (error: any) {
    console.error("[CustomAgents] List models error:", error);
    res.status(500).json({ error: error?.message || "拉取模型清单失败" });
  }
});

// 连通性测试：地址/Key 是否被接受 + 指定模型能否应答。
// 失败也用 200 返回（结果里 ok:false），这是**测试结论**而不是服务端故障。
app.post("/api/agents/custom/test", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const baseUrl = String(body.baseUrl ?? "").trim();
    const dialect = isProviderDialect(body.dialect) ? body.dialect : "openai";
    if (!baseUrl) return res.status(400).json({ error: "请填写 API 地址" });
    const { key, error } = resolveProviderKey(body);
    if (error) return res.status(400).json({ error });
    const model = String(body.model ?? "").trim();
    res.json(await testProvider({ baseUrl, dialect, apiKey: key, model: model || undefined }));
  } catch (error: any) {
    console.error("[CustomAgents] Test error:", error);
    res.status(500).json({ error: error?.message || "连通性测试失败" });
  }
});

// 编辑一条自建厂商。`/test` 与 `/models` 必须注册在它之前吗？不用 ——
// 那两条是精确路径，Express 会先匹配到它们；但 `:agentId` 会吞掉 GET 列表
// 之外的任何两段路径，所以**仍按顺序写在前面**，少一层心智负担。
app.patch("/api/agents/custom/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentId.startsWith("custom-")) {
      return res.status(400).json({ error: "只能修改自建 Agent" });
    }
    const norm = normalizeCustomInput(req.body);
    if (!norm.ok) return res.status(400).json({ error: norm.error });
    const spec = updateCustomSpec(agentId, norm.value);
    if (!spec) return res.status(404).json({ error: "自建 Agent 不存在" });

    // 定义表换新 → 实例换新。顺序不能反：`saveCredential()` 要按新定义找变量名，
    // 而 `registerCustom()` 是幂等的（已存在直接 return），必须先注销再注册。
    deps.reloadCustomDefs();
    registry.unregisterCustom(agentId);
    registry.registerCustom(customSpecToDefinition(spec));

    // Key 留空 = 不换 Key（用户只改了模型清单的情况）
    const apiKey = String((req.body as any)?.apiKey ?? "").trim();
    if (apiKey) saveCredential(agentId, { key: apiKey });
    const agent = await registry.probeOne(agentId, true);
    res.json({ agent, id: agentId });
  } catch (error: any) {
    console.error("[CustomAgents] Update error:", error);
    res.status(500).json({ error: error?.message || "修改自建 Agent 失败" });
  }
});

app.delete("/api/agents/custom/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    // 只允许删自建条目：拿一个内置 id 来删必须失败，否则用户能删掉 codex
    if (!agentId.startsWith("custom-")) {
      return res.status(400).json({ error: "只能删除自建 Agent" });
    }
    const removed = deleteCustomSpec(agentId);
    if (!removed) return res.status(404).json({ error: "自建 Agent 不存在" });
    // 凭据与内存态一起清：只删定义会让 Key 留在 agent-credentials.json 里
    clearCredential(agentId);
    // A160：自定义 Logo 也一起释放，否则重建同 id 会沿用一张早已删掉的图
    const releasedLogo = clearAgentLogo(agentId);
    if (releasedLogo) deleteAvatarFileIfUnused(releasedLogo);
    registry.unregisterCustom(agentId);
    deps.reloadCustomDefs();
    res.json({ ok: true, id: agentId });
  } catch (error: any) {
    console.error("[CustomAgents] Delete error:", error);
    res.status(500).json({ error: error?.message || "删除自建 Agent 失败" });
  }
});

// ════════ A223：手动接入的本地 CLI Agent ════════
// 路由必须注册在 `/api/agents/:agentId` 之前（与 custom 同一条规矩，
// 见 A177 注释）——`:agentId` 会吞掉任何两段路径。

app.get("/api/agents/custom-cli", (_req, res) => {
  try {
    res.json({ agents: loadCustomCliSpecs() });
  } catch (error: any) {
    console.error("[CustomCli] List error:", error);
    res.status(500).json({ error: error?.message || "获取手动接入 Agent 失败" });
  }
});

// 检测：只做零成本解析（命令能否找到），不拉进程、不花钱。
// 试跑是另一个动作（见下），两者分开——验证一步不该让用户被扣一次额度。
app.post("/api/agents/custom-cli/validate", (req, res) => {
  try {
    const norm = normalizeCustomCliInput(req.body);
    if (!norm.ok) return res.status(400).json({ error: norm.error });
    const resolvedPath = resolveCustomCliCommand(norm.value);
    res.json({ ok: !!resolvedPath, resolvedPath, command: norm.value.command });
  } catch (error: any) {
    console.error("[CustomCli] Validate error:", error);
    res.status(500).json({ error: error?.message || "检测失败" });
  }
});

// 试跑：真的拉起进程发一句 prompt。失败也用 200 返回（结果里 ok:false），
// 这是**测试结论**而不是服务端故障（与 /api/agents/custom/test 同一口径）。
app.post("/api/agents/custom-cli/trial", async (req, res) => {
  try {
    const norm = normalizeCustomCliInput(req.body);
    if (!norm.ok) return res.status(400).json({ error: norm.error });
    const prompt = String((req.body as any)?.prompt ?? "ping").trim() || "ping";
    const spec = { ...norm.value, id: "customcli-trial", createdAt: Date.now() };
    res.json(await trialCustomCli(spec, prompt));
  } catch (error: any) {
    console.error("[CustomCli] Trial error:", error);
    res.status(500).json({ error: error?.message || "试跑失败" });
  }
});

app.post("/api/agents/custom-cli", async (req, res) => {
  try {
    const norm = normalizeCustomCliInput(req.body);
    if (!norm.ok) return res.status(400).json({ error: norm.error });
    // 保存前必须检测得到命令：存一条本机拉不起来的声明没有意义，
    // 用户只会在名册上看到一个永远「未安装」的灰条目。
    if (!resolveCustomCliCommand(norm.value)) {
      return res.status(400).json({
        error: `检测不到命令：${norm.value.command}（不在 PATH 里，路径也不存在）`,
      });
    }
    const spec = createCustomCliSpec(norm.value);
    const def = customCliSpecToDefinition(spec);
    deps.reloadCustomDefs();
    registry.registerCustom(def);
    // 建完立刻探一次：用户下一步就是去点这个 Agent（与 HTTP 自建同口径）
    const agent = await registry.probeOne(spec.id, true);
    res.json({ agent, id: spec.id });
  } catch (error: any) {
    console.error("[CustomCli] Create error:", error);
    res.status(500).json({ error: error?.message || "创建手动接入 Agent 失败" });
  }
});

app.patch("/api/agents/custom-cli/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentId.startsWith("customcli-")) {
      return res.status(400).json({ error: "只能修改手动接入的 Agent" });
    }
    const norm = normalizeCustomCliInput(req.body);
    if (!norm.ok) return res.status(400).json({ error: norm.error });
    const spec = updateCustomCliSpec(agentId, norm.value);
    if (!spec) return res.status(404).json({ error: "手动接入的 Agent 不存在" });
    // 定义表换新 → 实例换新（顺序与 HTTP 自建一致：先注销再注册）
    registry.unregisterCustom(agentId);
    deps.reloadCustomDefs();
    registry.registerCustom(customCliSpecToDefinition(spec));
    const agent = await registry.probeOne(agentId, true);
    res.json({ agent, id: agentId });
  } catch (error: any) {
    console.error("[CustomCli] Update error:", error);
    res.status(500).json({ error: error?.message || "修改手动接入 Agent 失败" });
  }
});

app.delete("/api/agents/custom-cli/:agentId", (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentId.startsWith("customcli-")) {
      return res.status(400).json({ error: "只能删除手动接入的 Agent" });
    }
    const removed = deleteCustomCliSpec(agentId);
    if (!removed) return res.status(404).json({ error: "手动接入的 Agent 不存在" });
    // CLI 不存凭据（用用户自己的登录态），但自定义 Logo 同样要释放（A160 同款）
    const releasedLogo = clearAgentLogo(agentId);
    if (releasedLogo) deleteAvatarFileIfUnused(releasedLogo);
    registry.unregisterCustom(agentId);
    deps.reloadCustomDefs();
    res.json({ ok: true, id: agentId });
  } catch (error: any) {
    console.error("[CustomCli] Delete error:", error);
    res.status(500).json({ error: error?.message || "删除手动接入 Agent 失败" });
  }
});

/**
 * A177：只探测**一个** Agent。
 *
 * 为什么单独开一个 POST 而不是给 `/api/agents?probe=1` 加参数：
 * 全量探测会起 N 个进程（ACP 还有 Python），用户点某个 Agent 的「重新探测」
 * 时不应该顺带把别人的进程也拉起来。这个接口的调用链被刻意收窄为
 * `probeSingle → 目标 provider.probe()`，没有 `probeAll()` 兜底分支。
 *
 * `agentId` 只走字符集校验（内置 id、自建 `custom-xxxxxxxx` 都满足），
 * 不参与任何路径拼接，因此不存在路径穿越面。
 */
/**
 * A222：显式登录流的两条端点。
 *
 * 为什么不复用 `POST /api/agents/:id/probe`：探测是**只读判断**（8 秒预算），
 * 登录是**有副作用的长等待**（300 秒，要有人接浏览器回调）。混在一条链里
 * 就是 21:44 那张死链接的来历 —— 8 秒后 CLI 退出，URL 却留在名册上。
 *
 * 两条都同步返回、不挂请求：start 立刻给快照，前端轮询 status 拿 authUrl
 * 与最终结果。单飞在 loginFlow 模块里，重复点击不会起第二个 CLI。
 * 必须注册在 `/api/agents/:agentId` 之前（与 custom 路由同一条规矩）。
 */
app.post("/api/agents/:agentId/login/start", async (req, res) => {
  try {
    const agentId = String(req.params.agentId ?? "");
    if (!isValidAgentId(agentId)) {
      return res.status(400).json({ error: "agentId 非法" });
    }
    const agent = registry.get(agentId);
    if (!agent) return res.status(404).json({ error: "Agent 不存在" });
    if (agent.kind !== "sdk") {
      return res.status(400).json({ error: "该 Agent 不支持浏览器登录流" });
    }
    const snapshot = startLoginFlow(agentId);
    res.json({ ok: snapshot.state !== "busy", ...snapshot });
  } catch (error: any) {
    console.error("[Agent] Login start error:", error);
    res.status(500).json({ error: error?.message || "启动登录失败" });
  }
});

app.get("/api/agents/:agentId/login/status", async (req, res) => {
  try {
    const agentId = String(req.params.agentId ?? "");
    if (!isValidAgentId(agentId)) {
      return res.status(400).json({ error: "agentId 非法" });
    }
    if (!registry.hasAgent(agentId)) {
      return res.status(404).json({ error: "Agent 不存在" });
    }
    res.json(loginFlowStatus(agentId));
  } catch (error: any) {
    console.error("[Agent] Login status error:", error);
    res.status(500).json({ error: error?.message || "读取登录状态失败" });
  }
});

app.post("/api/agents/:agentId/probe", async (req, res) => {
  try {
    const agentId = String(req.params.agentId ?? "");
    if (!isValidAgentId(agentId)) {
      return res.status(400).json({ error: "agentId 非法" });
    }
    if (!registry.hasAgent(agentId)) {
      return res.status(404).json({ error: "Agent 不存在" });
    }

    // 允许测试/排障时收窄预算，但上限 180 秒，避免请求永久挂住
    const raw =
      (req.body as any)?.timeoutMs ??
      (req.query as any)?.timeoutMs;
    const timeoutMs = raw == null ? undefined : Number(raw);
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return res.status(400).json({ error: "timeoutMs 非法" });
    }

    const result = await registry.probeSingle(agentId, { timeoutMs });
    if (!result) return res.status(404).json({ error: "Agent 不存在" });
    res.json(result);
  } catch (error: any) {
    console.error("[Agent] Single probe error:", error);
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
    res.json({ agent: withObservedCapabilities([agent])[0] });
  } catch (error: any) {
    console.error("[Agent] Error:", error);
    res.status(500).json({ error: error?.message || "获取 Agent 失败" });
  }
});

/**
 * P0：Agent 级模型清单的溯源。
 *
 * 配置文件 / 「没有清单」这两类来源没有自己的快照时间，`probedAt` 用本次
 * 读取时刻；`verified` 恒为 false —— 我们只是读了文件或查了本地目录，
 * 从没拿当前账号去问过服务方「这些模型现在还能不能用」。
 */
function agentModelsProvenance(source: string, note: string): Provenance {
  return makeProvenance(source, { probedAt: Date.now(), verified: false, note });
}

// 某个 Agent 上报的可用模型（动态目录：CLI 枚举 + models.dev 元数据）
app.get("/api/agents/:agentId/models", async (req, res) => {
  try {
    const agentId = req.params.agentId;
    /**
     * A210：本机 CLI 配置里发现的自定义模型，以**平级字段**下发。
     *
     * 绝不塞进 `models` 数组：那会改变 `list.length > 0` 的判定，把
     * `unknown` / `manual` 两档挤成 `catalog`，A151 的四档闸门会全线变红。
     * 归属只认「这个 Agent 真的接受 --model」，不吃模型参数的 Agent
     * （zcode 的只读档）拿到空数组 —— 给它选项就是点了不生效的假控件。
     */
    const baseConfigured = agentAcceptsModel(agentId)
      ? listCliConfiguredModels().filter(m => m.agentIds.includes(agentId))
      /* A211：WorkBuddy 是唯一「不吃 --model、但能切模型」的例外。
         SDK 走 `session.setModel()` 热更新，桌面端 `models.json` 里的自定义
         模型 id 原样传过去就能用（本机实测官方客户端正是这么用的）。
         所以它不是 A210 注释里警惕的「点了不生效的假控件」；仍放平级字段，
         不碰 `models` 数组，A151 的四档语义原样保留。 */
      : agentId === 'workbuddy' ? workbuddyCustomModels() : [];
    /* 用户显式登记的自定义路由走同一条「平级可选组」通道，不进 `models` 数组：
       它是 A151 四档语义之外的第五类，混进去会把 unknown/manual 误判成 catalog。
       id 用可逆编码，选中后服务端能还原成 provider+model 三闸校验。 */
    const userRoutes = modelRoutesForAgent(agentId).map(route => ({
      id: routeToValue(route),
      label: route.displayName ?? routeLabel(route),
      source: `用户自定义路由 · ${route.providerId ?? route.modelId}`,
      agentIds: [agentId],
    }));
    const configuredIds = new Set(baseConfigured.map(m => m.id));
    const configured = [
      ...baseConfigured,
      ...userRoutes.filter(route => !configuredIds.has(route.id)),
    ];
    const models = await registry.modelsFor(agentId);
    // 一并给出该 Agent 自己的默认模型：列表按 provider 分组后，第一条
    // 不再等于「默认模型」（opencode 的默认是 zai/glm-4.7，而列表第一条
    // 是 OpenCode Zen 的免费模型）。前端据此选初始值，不靠下标猜。
    //
    // 两级来源：定义表里写死的（opencode）优先，其次是 CLI **自己声明的**
    // （codex 的 `~/.codex/config.toml`）。都没有就不给，前端退化成列表第一条。
    const defaultModel =
      findDef(agentId)?.defaultModel ?? (await getDefaultModelForAgent(agentId));

    // 目录为空时，再问一次「这个 Agent 自己的配置里写了什么」。
    //
    // 为什么要有这一档（A151）：ZCode 没有枚举命令、也没有 --model，
    // 但它把模型清单写在 `~/.zcode/v2/*.json` 里。不读这一层，
    // 界面就只剩一句「模型由 Agent 决定」——用户以为连清单都没有。
    // 读出来的是**只读**清单：`selectable: false` 必须原样透给前端，
    // 否则就成了「点了不生效」的假控件。
    if (models.length === 0) {
      const fromConfig = readAgentConfigModels(agentId);
      if (fromConfig) {
        return res.json({
          models: fromConfig.models,
          configured,
          defaultModel: fromConfig.currentModel ?? defaultModel ?? "",
          source: "agent-config",
          // ZCode 这类改不了（只读展示），Kimi Code 的 --model 真会生效；
          // 由配置读取层声明，避免把「能切」的也锁死。
          selectable: fromConfig.selectable ?? false,
          note: fromConfig.note,
          provenance: agentModelsProvenance(
            `${agentId} 自己的本地配置（只读）`,
            "这份清单从配置文件读出，本应用不能切换；未向服务方校验套餐/额度"
          ),
        });
      }

      /* P3：没有清单、也没有配置文件，但它**真的接受** `--model`。
         这里**不再提前返回**：CLI 枚举为空时，官方文案表里的模型仍要参与
         下面的合并（qoder 安装后 CLI 未落盘/失效时，用户不该只看到一句
         「模型由 Agent 决定」）。手动输入语义挪到合并之后再判 —— 合并完
         仍然没有清单时才退回 manual。判据不是手写表，是 buildArgs 自己
         （见 agentAcceptsModel 的注释）。 */
    }

    /* qoder 家族：`--list-models` 只吐账号自己的 3 条，而官方文案表里
       还有十几个真模型。两边合并，并按**实测标定结果**过滤：
       标过且被判 invalid 的直接丢掉（放上去就是点了被静默替换的假控件），
       没标过的标 `verified: false`，界面标「未验证」、选之前先标定。 */
    let list = models;
    let unverified: string[] = [];
    if (agentId === "qoder" || agentId === "qoder-cn") {
      const official = readOfficialModels(agentId);
      if (official.length > 0) {
        const merged = mergeOfficialExtras(list, official, getVerdicts(agentId));
        list = merged.models;
        unverified = merged.unverified;
      }
    }

    /* P3：合并完仍然没有清单，但它真的接受 `--model` → 退回手动输入。
       判据仍来自 buildArgs 自己（agentAcceptsModel），不是一张手写表。 */
    if (list.length === 0 && agentAcceptsModel(agentId)) {
      return res.json({
        models: [],
        configured,
        defaultModel: defaultModel ?? "",
        source: "manual",
        selectable: true,
        manual: true,
        note: "这个 Agent 没有列出模型的命令，但它接受 --model：手动填一个模型名即可，填完会先跑一次确认。",
        provenance: agentModelsProvenance(
          "本机没有可枚举的模型清单（手动指定）",
          "名字原样传给 CLI，能否路由取决于当前账号的权益；未向服务方校验"
        ),
      });
    }

    res.json({
      models: list,
      configured,
      defaultModel,
      source: list.length > 0 ? "catalog" : "unknown",
      selectable: list.length > 0,
      unverified,
      provenance:
        list.length > 0
          ? (getCatalogSummary().provenance ??
              agentModelsProvenance("模型目录尚未加载", "先去「设置 → 模型清单」刷新一次"))
          : agentModelsProvenance(
              "本机没有可用的模型清单",
              "这个 Agent 没有枚举命令，也没有配置文件清单；模型由它自己决定"
            ),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取模型列表失败" });
  }
});

/* ══════════════════ A211：WorkBuddy 运行时 profile ══════════════════
 *
 * 一个 `workbuddy` Agent id，多个官方数据根（国内版 / 国际版 / 未来的第三个）。
 * 端点、网络环境、配置根、登录态、自定义模型全部跟随**生效的那个 profile**。
 * 用户只装一个 → 自动选中；两个都装 → 按活跃度自动选，可固定或一键切换；
 * 一个都没装 → 用定义表兜底并明确标 `fallback`，绝不假装接上了。
 *
 * 与 `qoder` / `qoder-cn` 的区别：那俩是两个独立 CLI、账号与 Credits 全独立，
 * 所以拆两条；WorkBuddy 是同一个 SDK，一个子进程一次只能持一份凭据，
 * 拆两条只会得到「两个都在线、点一个必然 401」的幽灵条目。
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * 下发给页面的状态。
 *
 * `profiles[].root` 是本机的绝对路径，只在服务端用来定位文件；页面只需要
 * `dataFolderName` / `productName`。这里显式剔除，不把用户目录广播出去。
 * `drift[].official` 也已经在发现层写成了 `~/目录名` 形态。
 */
function workbuddyProfileResponse(force = false) {
  const state = workbuddyState(force);
  return {
    ...state,
    profiles: state.profiles.map(p => {
      const { root, ...rest } = p;
      void root;
      return rest;
    }),
    pinnedId: getPinnedProfile(),
  };
}

/**
 * A212 的对账逻辑与事故复盘见 `server/agents/wbRootEpoch.ts`（水位线 +
 * 批量作废，方案 A）。这里只挂三个调用点：启动、切换/重扫、发送路径。
 */

/**
 * 切版本 / 重扫之后必须做的四件事，少一件就是「界面切了、实际没切」。
 *
 * ① 发现层缓存作废 —— SdkAdapter 构造器必须在这次重读之后才执行；
 * ② 换 provider —— 常驻 CLI 进程继承的是**启动那一刻**的
 *    CODEBUDDY_CONFIG_DIR 与 token，只改前端 state 等于什么都没做；
 * ③ 模型缓存全套作废 —— 平台清单与自定义模型清单都随 profile 变；
 * ④ 立即重探 —— 名册上的「已登录」不能停留在旧版本的判断。
 */
async function rebindWorkbuddyRuntime(reason: string, beforeId: string, forceRebuild = false) {
  invalidateWorkbuddyProfile();
  const state = workbuddyProfileResponse(true);
  // A212：此刻 profile 缓存已刷新，立即对账一次 —— 换根的代价（旧令牌作废）
  // 在切换动作里当场结清，不等下一条消息才暴露成一次报错。
  reconcileWorkbuddyResumeTokens();
  const changed = state.activeId !== beforeId;
  // 只在真的换了数据根时重建：dispose 会关掉整个会话池（正在跑的对话会中断），
  // 用户只是把「自动」重新点一下不该付出这个代价。重扫则一律强制重建 ——
  // 用户点「重新检测」通常正是因为刚在桌面端重登、旧进程还揣着旧 token。
  const replaced = changed || forceRebuild ? registry.replaceProvider('workbuddy') : false;
  deps.resetConfiguredCache();
  invalidateAllModelCaches(reason);

  let agent: unknown;
  let agentError: string | undefined;
  try {
    agent = await registry.probeOne('workbuddy', true);
  } catch (err) {
    // 探测失败不该把「切换已生效」变成一次 500；状态已经写盘并重建，
    // 如实把错误带出去让界面显示「重探失败」即可。
    agentError = (err as Error)?.message || String(err);
  }
  // 与 GET 同形：state 的字段展开在顶层，附加字段平级挂着。前端只用一套类型。
  return { ...state, changed, replaced, agent, ...(agentError ? { agentError } : {}) };
}

app.get("/api/workbuddy-profiles", (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(workbuddyProfileResponse(force));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '读取 WorkBuddy 产品版本失败' });
  }
});

/** body: `{ id: string | null }`；null = 取消固定，回到按活跃度自动选择 */
app.post("/api/workbuddy-profiles/switch", async (req, res) => {
  try {
    const { id } = req.body ?? {};
    // 非法值 400，不静默纠正成「自动」（与会话级设置的约定一致）。
    if (id !== null && (typeof id !== 'string' || !id.trim())) {
      return res.status(400).json({ error: 'id 必须是已检测到的版本 id，或 null（恢复自动选择）' });
    }
    const beforeId = workbuddyState().activeId;
    const pinned = setPinnedWorkbuddyProfile(id === null ? null : id.trim());
    if (!pinned.ok) return res.status(400).json({ error: pinned.reason });
    const out = await rebindWorkbuddyRuntime(
      `switchWorkbuddyProfile(${id === null ? 'auto' : id})`, beforeId
    );
    res.json(out);
  } catch (error: any) {
    console.error('[WorkbuddyProfiles] switch error:', error);
    res.status(500).json({ error: error?.message || '切换 WorkBuddy 产品版本失败' });
  }
});

/** 桌面端刚重登 / 刚换了活跃目录时手动重扫，强制重建常驻 CLI 进程 */
app.post("/api/workbuddy-profiles/refresh", async (req, res) => {
  try {
    const beforeId = workbuddyState().activeId;
    const out = await rebindWorkbuddyRuntime(
      'POST /api/workbuddy-profiles/refresh', beforeId, true
    );
    res.json(out);
  } catch (error: any) {
    console.error('[WorkbuddyProfiles] refresh error:', error);
    res.status(500).json({ error: error?.message || '重新检测 WorkBuddy 产品版本失败' });
  }
});

/**
 * 某个 Agent 的账号与权益（**只读**）。
 *
 * 为什么单开一个接口、不并进 `/api/agents`：账号数据来自各 Agent 的
 * 凭据与配置文件，读写都要小心（zcode 的 credentials.json 是加密信封），
 * 而名册接口每 30 秒就被调一次。单开 + 详情页按需拉，才能把「只读」这件事
 * 收在一个适配层里（见 `agents/accountProbe.ts`）。
 *
 * `account: null` = 这个 Agent 没有可读的账号/权益数据 —— 前端据此整块不渲染，
 * 而不是摆一行「未知」。
 */
app.get("/api/agents/:agentId/account", async (req, res) => {
  try {
    res.json({ account: probeAccount(req.params.agentId) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "读取账号信息失败" });
  }
});

/**
 * P0：显式刷新账号与权益（详情页「重新探测」按钮顺带触发）。
 *
 * `probeAccount()` 本来就是每次真读盘，没有内存缓存可失效 —— 这个入口的
 * 价值是**把「用户主动要求重读」变成一个可观察、可断言的动作**：GET 可能
 * 被浏览器缓存，也可能只是切会话时顺带拉一次；只有 POST 这条明确表示
 * 「现在，按当前磁盘上的文件重新给一份」，响应里的 `probedAt` 也因此是
 * 这次刷新自己的时间。前端不得把它接到自动轮询上。
 */
app.post("/api/agents/:agentId/account/refresh", async (req, res) => {
  try {
    res.json({
      account: probeAccount(req.params.agentId),
      probedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "刷新账号信息失败" });
  }
});

/**
 * #16：真实鉴权校验（显式动作，绝不挂自动轮询）。
 *
 * 与上面 `/account/refresh` 分工不同：那条只是**重读本地文件**（verified 仍是
 * false），这条会拿已保存的 Key 向厂商发一次只读请求。两者都带溯源，
 * 但只有这里可能给出 `verified:true`。
 *
 * 失败一律用 200 + `verified:false` 返回：这是「测试结论」而非服务端故障，
 * 与 `/api/agents/custom/test` 同口径。URL 只能由服务端从定义表 / 已保存的
 * 接入地址推导，接口不接受前端传地址。
 */
app.post("/api/agents/:agentId/credential/verify", async (req, res) => {
  try {
    const agentId = req.params.agentId;
    if (!findDef(agentId)) return res.status(404).json({ error: "未知 Agent" });
    const verification = await verifyCredential(agentId);
    res.json({ verification });
  } catch (error: any) {
    console.error("[CredentialVerify] error:", error);
    res.status(500).json({ error: error?.message || "校验凭据失败" });
  }
});

/**
 * 模型可用性标定（A151 / P2）——**显式动作**。
 *
 * 每一条都要真起一次 CLI、真花 token，所以不挂在任何自动路径上。
 * 不传 `models` 时只标定「官方清单里还没验过」的那些（上限 8 条，
 * 一条最长 60s，再多人就等不住了 —— 剩下的由用户自己点）。
 */
app.post("/api/agents/:agentId/models/probe", async (req, res) => {
  try {
    const agentId = req.params.agentId;
    const def = findDef(agentId);
    if (!def) return res.status(404).json({ error: "未知 Agent" });

    const requested = Array.isArray(req.body?.models)
      ? (req.body.models as unknown[]).filter((x): x is string => typeof x === "string" && !!x)
      : [];
    let ids = requested;
    if (ids.length === 0) {
      const official = readOfficialModels(agentId);
      const verdicts = getVerdicts(agentId);
      ids = official
        .map(m => m.modelId)
        .filter(id => {
          const rec = verdicts[id];
          return !rec || rec.verdict === "unknown";
        })
        .slice(0, 8);
    }
    if (ids.length === 0) {
      return res.json({ results: {}, probed: 0 });
    }
    if (ids.length > 8) {
      return res.status(400).json({ error: "一次最多标定 8 个模型（每条最长 60s）" });
    }

    const results = await probeModels(agentId, ids);
    res.json({ results, probed: ids.length });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "模型标定失败" });
  }
});

// 真实标定：跑一条极短的 CLI 任务，数它实际给出哪些过程事件（P3）。
//
// 这是**显式动作**，不挂在任何自动路径上：标定会真起 CLI、真花 token，
// 不能在打开资料页或启动应用时偷偷跑。force=true 才忽略 TTL 重跑。
app.post("/api/agents/:agentId/capabilities/probe", async (req, res) => {
  try {
    const agentId = req.params.agentId;
    if (!findDef(agentId)) return res.status(404).json({ error: "Agent 不存在" });
    const body = (req.body ?? {}) as { model?: unknown; force?: unknown };
    const model =
      typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const outcome = await probeCapabilities(agentId, model, { force: body.force === true });
    if (!outcome.ok) {
      return res.status(400).json({ error: outcome.error, key: outcome.key, argv: outcome.argv });
    }
    res.json(outcome);
  } catch (error: any) {
    console.error("[Capability] 标定失败:", error);
    res.status(500).json({ error: error?.message || "标定失败" });
  }
});

}
