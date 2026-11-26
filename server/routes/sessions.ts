/**
 * 会话 API。
 *
 * F0-02②：从 server/index.ts 原样迁出，行为零改动。
 * 含会话 CRUD、最近目录（A63/A131）、工作区文件面板（A77/A86）、
 * CDP 端点查询（P3）。`parseJsonColumn` 与 `FS_STATUS` 只被本分区使用，
 * 随分区迁出；`defaultModel` 的取值口径（SDK_DEFAULT_MODEL）改为直接 import，
 * 与 index.ts 的同一常量同源。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db.js';
import { getOrCreateProject, getSessionProject } from '../db.js';
import { projectIdForCwd } from '../project-ownership.js';
import { registry } from '../agents/registry.js';
import type { PermissionMode } from '../agents/types.js';
import { runHub } from '../run-hub.js';
import { resolveModelForAgent, SDK_DEFAULT_MODEL } from '../model-routing.js';
import { AUTO_SESSION_TITLE } from '../../shared/session-title.js';
import { PERMISSION_MODE_LABEL } from '../../shared/scenarios.js';
import { validateDirectory } from '../workspaceDir.js';
import { dismissedCount, dismiss, restoreAllDismissed } from '../dismissed-dirs.js';
import { dataDirPath } from '../paths.js';
import { FS_ERROR_TEXT, listDir, readFileInside, type FsErrorCode } from '../fs.js';

/** 见 index.ts 迁出前的注释：坏 JSON 列退化成 null，不让一条坏消息拖垮整个会话。 */
function parseJsonColumn(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * A109：打开/新建会话时预热常驻 CLI 进程。
 *
 * 为什么值得单独做：冷启动实测 14.7s（spawn + V8 编译 24MB + 进程启动），
 * 全部压在「问第一句」那一刻 —— 而用户抱怨的「响应慢」恰恰集中在这。
 * 预热把这段与「用户正在打字」重叠起来，首条消息只付模型推理。
 *
 * 三条约束：
 * 1. **只对一对一会话做**。群聊会同时起多个 Agent，替用户决定「先热哪一个」
 *    收益不确定，还会白占内存（每个 ≈24MB）。
 * 2. **fire-and-forget**：不 await、不影响响应，失败在适配器里已静默。
 * 3. **配置只用会话行里的值**（cwd / model / systemPrompt / resumeToken）——
 *    与 /api/chat 的取值口径一致，否则首条消息会判成「结构性不符」而重建，
 *    等于白热。
 */
function prewarmForSession(session: {
  id: string;
  kind?: string | null;
  agent_id?: string | null;
  cwd?: string | null;
  model?: string | null;
  system_prompt?: string | null;
  sdk_session_id?: string | null;
  permission_mode?: string | null;
}): void {
  try {
    if ((session.kind ?? 'direct') !== 'direct') return;
    if (!session.agent_id) return;
    registry.prewarm(session.agent_id, {
      sessionId: session.id,
      // 预热不发送任何内容，prompt 只是结构占位
      prompt: '',
      systemPrompt: session.system_prompt ?? undefined,
      cwd: session.cwd || process.cwd(),
      // 与 /api/chat 一致：记忆作用域不回落，只认会话自己绑的目录
      memoryCwd: session.cwd || undefined,
      model: session.model ?? undefined,
      resumeToken: session.sdk_session_id,
      // 权限模式用会话自己存的那档：claude 的 prewarm 会把权限档冻结进
      // spare，这里若固定写 'default'，非默认档的会话就永远命中不了预热。
      permissionMode: (session.permission_mode as PermissionMode | null) || 'default',
      allowedTools: [],
    });
  } catch {
    /* 预热纯属优化，任何异常都不该影响请求 */
  }
}

/**
 * A123：权限档位的合法值。判据直接取共享表，不在这里再抄一份枚举 ——
 * 前端加一档（或改名）时后端会跟着变，不会出现「前端能选、后端判非法」。
 */
const PERMISSION_MODES = Object.keys(PERMISSION_MODE_LABEL);

/**
 * 校验请求体里的权限档位。
 *
 * 非法值一律 **400，不静默纠正成 default**（与 A119 的 project_tasks.status 同一条规矩）：
 * 静默纠正会把「前端写错了枚举」变成「用户的设置莫名没生效」，
 * 而那正是这一档曾经的状态 —— 芯片显示全放行、发出去的是 default。
 *
 * 返回 `undefined` = 这一项不动；返回 `null` = 清空（回到「没选过」）。
 */
function permissionModeOf(raw: unknown): { error?: string; value?: string | null } {
  if (raw === undefined) return {};
  if (raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string' || !PERMISSION_MODES.includes(raw)) {
    return { error: `权限模式不合法：${JSON.stringify(raw)}（可选：${PERMISSION_MODES.join(' | ')}）` };
  }
  return { value: raw };
}

export function registerSessionRoutes(app: Express): void {
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

      // A98：顺带返回所属项目。前端据此在会话头部显示「当前项目」，
      // 也据此知道「这个会话有没有项目记忆」。取不到就是没绑目录，正常。
      //
      // A100：`dangling` —— 上一轮没有产出回复。
      //
      // 为什么必须在这里算、而且要后端算：
      //   · 运行态（runHub）只活在内存里，进程一重启就没了。用户重开应用后，
      //     那条「发出去了但没有回答」的用户消息还留在库里，界面上却什么都不说，
      //     用户会以为是消息丢了或者自己没发出去。
      //   · 前端算不了：它不知道**别的窗口/别的标签页**是不是正在跑这一轮。
      //     只凭「最后一条是 user」就报中断，会在正常执行中误报。
      //
      // 判定只有一条：最后一条消息是 user，且这个会话当前没有活跃 run。
      // 于是「正常等待回复」不会被误判（有活跃 run），「应用被关掉」必然命中。
      //
      // 措辞上刻意说「没有产出回复」而不是「被中断」：用户手动中止、进程崩溃、
      // 应用被强关，在这里留下的痕迹完全一样，硬要区分就是在编。
      const lastMessage = messages[messages.length - 1];
      const hasActiveRun = runHub.activeRuns().some(r => r.sessionId === sessionId);
      const dangling =
        !hasActiveRun && lastMessage?.role === "user"
          ? { messageId: lastMessage.id, at: lastMessage.created_at }
          : null;

      res.json({
        session,
        project: getSessionProject(sessionId) ?? null,
        messages: parsedMessages,
        dangling,
      });

      // 响应先发出去，再在后台把进程热起来（顺序不能反：预热要几秒）
      prewarmForSession(session);
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
        title = AUTO_SESSION_TITLE,
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
        // A123：会话级权限模式（可选）。新建时就选了要一起落库，
        // 否则「新建页选了全放行、第一条消息却按 default 弹窗问人」。
        permissionMode = null,
      } = req.body;
      const modeCheck = permissionModeOf(permissionMode);
      if (modeCheck.error) return res.status(400).json({ error: modeCheck.error });
      const now = new Date().toISOString();

      // A63：与 PATCH /api/sessions/:id 同一把尺子 —— 确定不存在的目录不落库。
      if (typeof cwd === 'string' && cwd && validateDirectory(cwd) === 'not-found') {
        return res.status(400).json({ error: `工作目录不存在：${cwd}` });
      }

      // 群聊没有单一 Agent，模型按发起时的选择原样落库（成员各自的模型在调用时解析）
      const sessionModel = kind === 'group'
        ? (model || SDK_DEFAULT_MODEL)
        : (resolveModelForAgent(agentId ?? '', model) ?? '');

      // 群聊成员统一以 JSON 字符串落库；传进来的可能是数组，也可能已经是字符串
      const agentIdsJson = Array.isArray(agentIds)
        ? JSON.stringify(agentIds.filter((v: unknown) => typeof v === 'string'))
        : (typeof agentIds === 'string' ? agentIds : null);

      // A98：按工作目录关联项目。同一个目录的多个会话共用一个项目，
      // 记忆也随之共用 —— 这正是「项目记忆」这个概念的落点。
      // 没指定目录的会话（纯问答）保持不绑定：它不属于任何项目，
      // 硬塞一个「进程当前目录」会让它的记忆错误地共享到一个假项目里。
      const project = typeof cwd === 'string' && cwd ? getOrCreateProject(cwd) : undefined;

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
        // A123：新建时就选了档位要随会话落库（`permissionModeOf` 已校验过合法性）
        permission_mode: modeCheck.value ?? null,
        project_id: project?.id ?? null,
        created_at: now,
        updated_at: now
      });

      res.json({ session });

      // 新建会话通常紧接着就要发第一条消息 —— 提前把进程热起来（A109）
      prewarmForSession(session);
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
      const { title, model, orchestration, agentIds, cwd, reasoningEffort, scenarioId, systemPrompt, pinned, agentId, permissionMode } = req.body;
      // A123：权限档位。非法值 400，不静默纠正 —— 见 permissionModeOf 的说明
      const modeCheck = permissionModeOf(permissionMode);
      if (modeCheck.error) return res.status(400).json({ error: modeCheck.error });

      const updates: Parameters<typeof db.updateSession>[1] = { title, model };
      /**
       * A119：空会话换 Agent。
       *
       * 前端只在一个场景下用它：通讯录「发消息」建出来的空壳会话（或清空过
       * 记录、消息数归零的会话）落在新建页，用户改主意点了另一张 Agent 卡片。
       *
       * 这里**不检查消息数** —— 「能不能换」是产品策略，由前端按「会话是否
       * 为空」决定；后端只负责如实执行。真要在这里拦，就得为一个本可以
       * 单向收敛的规则在两层各写一遍，将来只会漂移。
       * 群聊也不会走到这里：前端的新建页对群聊根本不渲染（成员由 agentIds
       * 管，改 agent_id 不改变任何实际行为，只会留下一条对不上的记录）。
       */
      if (typeof agentId === 'string' && agentId) updates.agent_id = agentId;
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
        // A98：换目录 = 换项目。清空目录则解绑（null）。
        // 这里同步更新而不是留给读取时现算，是因为「会话属于哪个项目」
        // 会被列表分组直接用到，每次现算会让分组查询退化成 N 次查找。
        // A220：与新建 / 首条消息落库走同一个推导函数，别在这里抄第二份判据。
        updates.project_id = projectIdForCwd(cwd);
      }
      // A62：思考强度同理。null = 清空档位、回到 CLI 自己的默认
      if (typeof reasoningEffort === 'string') updates.reasoning_effort = reasoningEffort || null;
      if (typeof scenarioId === 'string') updates.scenario_id = scenarioId || null;
      if (typeof systemPrompt === 'string') updates.system_prompt = systemPrompt || null;
      // A123：`undefined` = 这次没带这一项（不动）；`null` = 清空回「没选过」。
      // 用 `in req.body` 而不是真值判断，否则清空档位会被当成「没改」。
      if ('permissionMode' in req.body) updates.permission_mode = modeCheck.value ?? null;
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
      // 顺带带上已忽略几条：面板要用它决定「全部恢复」那一行出不出现。
      // 不另开一个端点，是为了让打开面板只发一次请求。
      res.json({ directories, dismissedCount: dismissedCount() });
    } catch (error: any) {
      console.error("[Recent Directories] Error:", error);
      res.status(500).json({ error: error?.message || "获取最近目录失败" });
    }
  });

  /**
   * A131：点 × 忽略一个最近目录。
   *
   * 落在服务端而不是 localStorage：打包态端口每次都不一样，localStorage 按源隔离，
   * 用户点完下次打开就全忘了（原因写在 `server/dismissed-dirs.ts` 文件头）。
   * 只改忽略清单，**不动任何会话的 cwd** —— 用户不想在快捷列表里看见它，
   * 不等于想把所有会话的工作目录清空。
   */
  app.post("/api/recent-directories/dismiss", (req, res) => {
    const { path: dir } = req.body ?? {};
    if (typeof dir !== "string" || !dir.trim()) {
      res.status(400).json({ error: "path 不能为空" });
      return;
    }
    res.json({ ok: true, dismissed: dismiss(dir) });
  });

  /**
   * 撤销全部忽略。
   *
   * 只做「全部恢复」不做单条恢复：列表里已经没有已忽略项的展示位，
   * 逐条找回要先把它们列出来，那是另一套 UI。清掉重来最诚实，也不会误恢复。
   */
  app.post("/api/recent-directories/restore", (_req, res) => {
    res.json({ ok: true, restored: restoreAllDismissed() });
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

  /**
   * A86：工作区面板的**只读预览**。
   *
   * ## 为什么需要它
   *
   * A77 的取舍是「点文件 = 用系统程序打开」，理由是内嵌编辑器要 monaco +
   * 语言服务 + 保存链路。但用户的实际反馈是：面板叫「工作区」，点一个 md
   * 却跳出应用，观感就是假的。所以这里补的是**只读预览**，不是编辑器 ——
   * 没有保存、没有写回、没有冲突处理，写操作仍然只有 Agent 与外部编辑器两条路。
   *
   * ## 边界
   *
   * - containment 与 `/api/fs/list` 完全一致（`resolveInside`，realpath 后比对）；
   * - 文本上限 1 MB，超限返回 `too-large` 而不是截一半（截断的源码更误导）；
   * - 图片不塞进 JSON，走 `/api/fs/raw` 直出；
   * - 二进制（前 8 KB 有 NUL）返回 `binary`，界面提示改用系统程序打开。
   */
  app.get("/api/fs/read", (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
      const rel = typeof req.query.path === "string" ? req.query.path : "";
      if (!sessionId) {
        return res.status(400).json({ error: "缺少 sessionId" });
      }
      if (!rel) {
        return res.status(400).json({ error: "缺少 path" });
      }

      const session = db.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "会话不存在" });
      }
      if (!session.cwd) {
        return res.status(409).json({ error: "该会话未绑定工作目录", code: "no-cwd" });
      }

      const result = readFileInside(session.cwd, rel);
      if ("error" in result) {
        return res.status(FS_STATUS[result.error]).json({
          error: FS_ERROR_TEXT[result.error],
          code: result.error,
        });
      }

      // 图片只给 URL，正文由 /api/fs/raw 直出：base64 塞进 JSON 会让 1 MB 的图
      // 变成 1.4 MB 的字符串，还要在渲染进程里再解一遍。
      if (result.kind === "image") {
        const qs = new URLSearchParams({ sessionId, path: rel });
        return res.json({ ...result, url: `/api/fs/raw?${qs.toString()}` });
      }
      res.json(result);
    } catch (error: any) {
      console.error("[Fs Read] Error:", error);
      res.status(500).json({ error: error?.message || "读取文件失败" });
    }
  });

  /** A86：图片预览的原始字节。只放行图片 MIME，其余一律 415。 */
  app.get("/api/fs/raw", (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
      const rel = typeof req.query.path === "string" ? req.query.path : "";
      if (!sessionId || !rel) {
        return res.status(400).json({ error: "缺少 sessionId 或 path" });
      }

      const session = db.getSession(sessionId);
      if (!session) return res.status(404).json({ error: "会话不存在" });
      if (!session.cwd) return res.status(409).json({ error: "该会话未绑定工作目录", code: "no-cwd" });

      const result = readFileInside(session.cwd, rel);
      if ("error" in result) {
        return res.status(FS_STATUS[result.error]).json({
          error: FS_ERROR_TEXT[result.error],
          code: result.error,
        });
      }
      if (result.kind !== "image") {
        return res.status(415).json({ error: "只支持图片预览" });
      }

      // sendFile 会按扩展名给 Content-Type；路径已经过 realpath containment 校验
      res.setHeader("Cache-Control", "no-store");
      // SVG 是图片也是文档：直接在地址栏打开时里面的 <script> 会以**应用源**执行。
      // 这里用 CSP 把它按静态图对待（禁脚本、禁外链），预览用 <img> 时行为不变。
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.sendFile(result.abs);
    } catch (error: any) {
      console.error("[Fs Raw] Error:", error);
      res.status(500).json({ error: error?.message || "读取图片失败" });
    }
  });

  /**
   * P3：人机同屏 —— 远程调试端点查询。
   *
   * ## 为什么走「读文件」而不是 import electron
   *
   * 这个服务在浏览器开发态跑在纯 Node 里（`npm run dev` 的 server），
   * import electron 会直接炸。而端点信息本来就必须落地成文件 —— Agent 是
   * 外部 CLI 子进程，看不见主进程的内存，只能从文件或环境变量里发现它。
   * 所以两边共用同一份 `data/cdp.json`，没有第二处真相。
   *
   * ## 为什么不返回 ws 端点给任意调用方
   *
   * 只绑回环 + 端口随机，已经把暴露面收得很小；但既然要开一个 HTTP 查询口，
   * 就把「够用」和「全部」分开：这里给 enabled / port / targetUrl，
   * 完整 ws 端点仍然只从 `data/cdp.json` 与 `OPC_CDP_TARGET` 环境变量取
   * —— 后两者是给 Agent 的，本来就要能驱动页面。
   */
  app.get("/api/browser/cdp", (_req, res) => {
    const file = path.join(dataDirPath, "cdp.json");
    let descriptor: Record<string, unknown> | null = null;
    try {
      descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      descriptor = null;
    }
    if (!descriptor) {
      return res.json({
        enabled: false,
        port: null,
        hasTarget: false,
        targetUrl: "",
        // 应用没跑在 Electron 里（浏览器开发态）或还没写过描述符
        reason: "descriptor-missing",
      });
    }
    res.json({
      enabled: descriptor.enabled === true,
      port: typeof descriptor.port === "number" ? descriptor.port : null,
      hasTarget: !!descriptor.target,
      targetUrl:
        typeof descriptor.target === "object" && descriptor.target
          ? String((descriptor.target as { url?: unknown }).url ?? "")
          : "",
    });
  });

  // 删除会话（迁出前它就是本分区的最后一条 —— 注册顺序保持与拆分前一致）
  app.delete("/api/sessions/:sessionId", (req, res) => {
    try {
      const { sessionId } = req.params;
      const { deleted, trashId } = db.deleteSessionWithTrashId(sessionId);

      if (!deleted) {
        return res.status(404).json({ error: "会话不存在" });
      }

      // B1：删除留了一份快照进回收站 —— 把 id 回给前端，界面才能给「撤销」，
      // 而不是让用户以为数据没了（回收站 30 天后才过期）。
      res.json({ success: true, restorable: !!trashId, trashId });
    } catch (error: any) {
      console.error("[Delete Session] Error:", error);
      res.status(500).json({ error: error?.message || "删除会话失败" });
    }
  });

  // ════════ B1：回收站（删除的后悔药，保留 30 天）════════
  // 只给「能恢复」这一个出口。刻意不做「永久删除」按钮：删都删了，
  // 多一个按钮只多一次误点机会；过期自然清理。
  app.get("/api/trash", (_req, res) => {
    try {
      const items = db.listTrash().map(t => ({
        id: t.id,
        kind: t.kind,
        sessionId: t.session_id,
        label: t.label,
        deletedAt: t.deleted_at,
        expiresAt: t.expires_at,
      }));
      res.json({ items });
    } catch (error: any) {
      console.error("[Trash] List Error:", error);
      res.status(500).json({ error: "读取回收站失败" });
    }
  });

  app.post("/api/trash/:trashId/restore", (req, res) => {
    try {
      const result = db.restoreTrashItem(req.params.trashId);
      if (result === "ok") return res.json({ success: true });
      if (result === "conflict") {
        // 409 而不是 500：这不是服务端故障，是「同名会话已经重新建了」的
        // 业务冲突，界面据此提示「已存在同 id 会话，无法覆盖」。
        return res.status(409).json({
          error: "该会话已被重新创建，恢复会覆盖新数据 —— 已取消",
          code: "trash_conflict",
        });
      }
      if (result === "expired") {
        // 410 Gone：它确实存在过，但保留期已过（30 天/OPC_TRASH_RETENTION_DAYS）。
        // 用 410 而不是 404，界面才能提示「已超过保留期」而不是含糊的「找不到」。
        return res.status(410).json({
          error: "这条记录已超过保留期，无法恢复",
          code: "trash_expired",
        });
      }
      // 404：数据本来就损坏或从未存在
      return res.status(404).json({ error: "回收站里没有这条记录" });
    } catch (error: any) {
      console.error("[Trash] Restore Error:", error);
      res.status(500).json({ error: "恢复失败" });
    }
  });
}
