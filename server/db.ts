import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'path';
import fs from 'fs';
import { dataDirPath } from './paths.js';
// A98：项目路径归一与显示名。纯函数模块（只依赖 crypto / path），
// 不会反过来 import db.ts，所以这里引用它是安全的。
import { normalizeProjectPath, defaultProjectName } from './project-key.js';
// A131：「最近目录」的忽略清单。它只依赖 paths.ts 与 project-key.ts（两个都不
// import 本文件），所以这里引它不会绕成环。
import { isDismissed } from './dismissed-dirs.js';
import type {
  CapabilityKey,
  CapabilityProbe,
  CapabilityProfile,
  EventCapability,
} from '../shared/capabilities.js';
import { capabilityKeyString } from '../shared/capabilities.js';

// 路径推导已拆到 `paths.ts`（无副作用），这里只做 re-export：
// 既有 `import { dataDirPath } from './db.js'` 的调用点无需改动，
// 而只想读路径的模块（模型目录缓存等）可以 import `paths.ts`，
// 不会顺带把数据库打开。
export { dataDirPath, imagesDir } from './paths.js';

/** 本地别名：下面建库/建目录仍沿用原来的名字 */
const dataDir = dataDirPath;

const dbPath = path.join(dataDir, 'chat.db');

// 确保数据目录存在
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

console.log(`[DB] 数据库文件: ${dbPath}`);

// 创建数据库连接（Node 22 内置 SQLite，无需原生依赖）
const db = new DatabaseSync(dbPath);

// 启用 WAL 模式以提高性能
db.exec('PRAGMA journal_mode = WAL');
// 开启外键约束（SQLite 默认关闭）
db.exec('PRAGMA foreign_keys = ON');

// 初始化数据库表
db.exec(`
  -- 会话表
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_id TEXT,
    sdk_session_id TEXT,
    -- 'direct' 一对一 | 'group' 群聊
    kind TEXT NOT NULL DEFAULT 'direct',
    -- 群聊成员 Agent id 的 JSON 数组（direct 会话存单个元素的数组或 NULL）
    agent_ids TEXT,
    -- 群聊编排模式：dispatch | broadcast | relay | debate | mention
    orchestration TEXT,
    -- 工作目录（场景/手动指定）。NULL = 用后端进程的 cwd
    cwd TEXT,
    -- A62：推理/思考强度档位值（如 low / xhigh）。NULL = 不显式传，
    -- 用 CLI 自己的默认。合法性由调用方按模型的 reasoning.levels 约束。
    reasoning_effort TEXT,
    -- 场景模板 id（P4 场景包）
    scenario_id TEXT,
    -- 会话级系统提示词（场景注入），发送时优先于 Agent 自带
    system_prompt TEXT,
    -- A123：会话级权限模式（default | acceptEdits | plan | bypassPermissions）。
    -- NULL = 没选过 → 按 'default' 跑。这一档以前**只活在内存里一个 useState**：
    -- 芯片显示「全放行」、发出去的却是 'default'，等于一个假控件。加这列来终结它。
    permission_mode TEXT,
    -- 置顶：1 = 钉在消息列表顶部。右键菜单切换
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 消息表
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    model TEXT,
    -- 群聊里标识「这句话是哪个 Agent 说的」，前端据此渲染成独立气泡
    author_agent_id TEXT,
    created_at TEXT NOT NULL,
    tool_calls TEXT,
    -- 生图消息的图片块 JSON 数组（P4-4）。文本消息为 NULL
    images TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- 为会话 ID 创建索引
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

  -- 验证结果（A97）：一次命令执行 = 一行。
  --
  -- 为什么单独一张表而不是塞进 messages.blocks：验证是**事后**发生的
  -- （Agent 说完话之后用户才点「跑测试」），而 blocks 是流式过程中由
  -- Agent 事件投影出来的。混在一起会让「这条消息是不是还在流」的判断
  -- 变得含糊，也会让 blocks 的迁移逻辑多一种半结构化形态。
  --
  -- message_id 可以为 NULL —— 那是「针对整个会话」的验证（比如用户想
  -- 手动确认当前工作区还能不能编译），不挂在某条回答下面。
  CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    command_id TEXT NOT NULL,
    command TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    -- pass | fail | timeout | error
    status TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    output TEXT,
    output_truncated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_verifications_session
    ON verifications(session_id, created_at);

  -- 项目（A98）：一个「目录」就是一个项目。
  --
  -- 为什么必须补这一层：此前项目这个概念在库里根本不存在，只有
  -- sessions.cwd 一个字符串。于是「项目记忆 / 项目总览 / 任务面板」
  -- 三样东西都没有可挂载的锚点，而记忆只能全局存一份 —— 在两个仓库
  -- 之间切换时，同一份 MEMORY.md 会同时注入到两边，项目规范互相串味。
  --
  -- path 存的是**归一化后**的路径（小写 + 正斜杠 + 去尾斜杠），见
  -- project-key.ts。唯一约束落在它上面，保证「同一目录只有一个项目」。
  -- 展示用的原始路径由归一化函数可逆地还原（除大小写外），不需要另存。
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
  );

  -- 项目任务（A119）：项目详情里那张「任务」面板的落点。
  --
  -- 为什么挂在**项目**上而不是会话上：任务是「这个仓库还要做什么」，
  -- 天然跨会话 —— 一条任务往往横跨好几轮对话。绑到会话上会随会话删除
  -- 一起消失，而且「同一个任务在两轮对话里各记一遍」几乎是必然的。
  --
  -- status 只有三档（todo / doing / done）。任务是「一眼看清还剩什么」，
  -- 档位一多就变成另一个待办 App，维护成本上去了、没人填。
  --
  -- 外键 ON DELETE CASCADE：删项目时任务跟着走（PRAGMA foreign_keys
  -- 在本文件开头已开），不留孤儿行。
  CREATE TABLE IF NOT EXISTS project_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_project_tasks_project
    ON project_tasks(project_id, created_at);

  -- 过程能力档的观测结果（P2）。
  --
  -- 为什么要落库而不是只放内存：这份数据的用途是回答「清单说它有思考，
  -- 那它实际给过吗」——答案必须跨越重启，否则每次开应用都退回「不知道」，
  -- 用户看到的永远只是那份可能撒谎的声明。
  --
  -- cap_key 是 (引擎|模型|网关) 的稳定字符串（见 shared/capabilities.ts）。
  -- 三元组做主键而不是 agent_id：同一个 Codex 接官方模型和接第三方网关
  -- 是两种事件形态，按 Agent 折叠就等于把后者的问题算到前者头上。
  --
  -- 只存最近一次：能力档是"当前事实"，不是审计日志。历史趋势没有第二个
  -- 消费方，存了只会让表无限长。
  CREATE TABLE IF NOT EXISTS agent_capabilities (
    cap_key TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    model TEXT,
    gateway TEXT NOT NULL,
    declared TEXT,
    observed TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- 真实 CLI 标定结果（P3）。
  --
  -- 为什么不复用上面那张表：observed 是「这一轮真的出现过」，probed 是
  -- 「专门跑一条标定任务得到的结论」。两者来源不同、时间点不同，塞进同一行
  -- 就会出现「用一个时间戳同时表示两件事」—— 那正是 P1/P2 一直在拆的假数据。
  -- 分表之后，观测只覆盖观测，标定只覆盖标定，互不擦除。
  CREATE TABLE IF NOT EXISTS agent_capability_probes (
    cap_key TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    model TEXT,
    gateway TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    probed_at INTEGER NOT NULL
  );
`);

/**
 * 幂等加列：先 PRAGMA 探测再 ALTER。
 *
 * 之前 sdk_session_id / agent_id 两处各写了一遍 try/catch，这次群聊要再加
 * 4 个列，继续复制粘贴会变成 6 份几乎相同的代码。抽成一个函数，
 * 顺便把「静默吞掉错误」改成打印告警 —— 迁移失败却不出声是最难查的一类问题。
 */
function ensureColumn(table: string, column: string, ddl: string): void {
  try {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.some(col => col.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      console.log(`[DB] 迁移：已为 ${table} 添加列 ${column}`);
    }
  } catch (err) {
    console.warn(`[DB] 迁移 ${table}.${column} 失败（已跳过）:`, err);
  }
}

// 历史库迁移：以下列在老库里都不存在，逐个补齐（可安全重复执行）
ensureColumn('sessions', 'sdk_session_id', 'sdk_session_id TEXT');
ensureColumn('sessions', 'agent_id', 'agent_id TEXT');
// 群聊三列。kind 用 NOT NULL DEFAULT，老会话自动落成 'direct'，语义正确。
ensureColumn('sessions', 'kind', "kind TEXT NOT NULL DEFAULT 'direct'");
ensureColumn('sessions', 'agent_ids', 'agent_ids TEXT');
ensureColumn('sessions', 'orchestration', 'orchestration TEXT');
// P4：工作目录 + 场景绑定。老会话这三列不存在，补齐后为 NULL（= 未指定），语义正确。
ensureColumn('sessions', 'cwd', 'cwd TEXT');
// A62：思考强度档位。老会话为 NULL（= 用 CLI 默认），语义正确。
ensureColumn('sessions', 'reasoning_effort', 'reasoning_effort TEXT');
ensureColumn('sessions', 'scenario_id', 'scenario_id TEXT');
ensureColumn('sessions', 'system_prompt', 'system_prompt TEXT');
/**
 * A123：会话级权限模式。老库里为 NULL = 「没选过」，读取侧按 'default' 处理，
 * 语义与迁移前完全一致（迁移前它本来每条消息都是 'default'）。
 *
 * 刻意用可空而不是 `NOT NULL DEFAULT 'default'`：这一档的「没设置过」和
 * 「显式选了 default」目前行为相同，但真到要区分「跟随 Agent 自带档位」时，
 * NULL 才有地方放。`pinned` 那种布尔位才需要 NOT NULL。
 */
ensureColumn('sessions', 'permission_mode', 'permission_mode TEXT');
ensureColumn('sessions', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
/**
 * A98：会话所属项目。
 *
 * 三个值各有含义（A131 起）：**NULL** = 从没算过，交给
 * `backfillSessionProjects()` 按 cwd 回填；**''** = 用户亲手把这个会话从
 * 项目里摘掉了，回填必须跳过；**其它** = 指向 `projects.id`。
 * 刻意**不加外键**：SQLite 不支持给已有表 ALTER 出外键约束，硬加要整表
 * 重建；而这张表是本机唯一的真实对话数据，为了一个可空外键去重建它
 * 风险不对等。代价是读取侧必须容忍「project_id 指向一个不存在的项目」，
 * 这一点在 `getSessionProject()` 里兜住。
 */
ensureColumn('sessions', 'project_id', 'project_id TEXT');
// 群聊消息来源。老消息为 NULL，前端按「无作者」渲染成单气泡，行为不变。
ensureColumn('messages', 'author_agent_id', 'author_agent_id TEXT');
// P4-4：生图消息的图片块。老消息为 NULL（纯文本），语义正确。
ensureColumn('messages', 'images', 'images TEXT');
// P6：成本统计三列。老消息为 NULL —— 前端按「无数据」不渲染，不会显示 0 秒/$0 冒充有数据。
ensureColumn('messages', 'duration_ms', 'duration_ms INTEGER');
ensureColumn('messages', 'cost', 'cost REAL');
ensureColumn('messages', 'tokens', 'tokens INTEGER');
/**
 * 有序块序列（E2）。JSON 数组字符串，形如 [{"type":"thinking",...},{"type":"text",...}]。
 *
 * 为什么单独一列而不是继续拼进 content：content 只能表达「一段连续文本」，
 * 而「思考 → 正文 → 工具 → 正文」这种交错顺序是它装不下的。老消息该列为
 * NULL，读取侧用 legacyToBlocks() 从旧字段还原，不需要数据迁移。
 */
ensureColumn('messages', 'blocks', 'blocks TEXT');

/** node:sqlite 的 changes 在部分版本返回 BigInt，统一转成 number */
function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * 参数归一化。
 *
 * better-sqlite3 会把 undefined / boolean 静默转换成 NULL / 0/1，
 * 而 node:sqlite 会直接抛 ERR_INVALID_ARG_TYPE。
 * 这里补回等价语义，使模板原有调用点无需逐个改造。
 */
type SqlValue = string | number | bigint | null | Uint8Array;

function bind(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return String(value);
}

// 类型定义
export interface DbSession {
  id: string;
  title: string;
  model: string;
  /** 该会话绑定的 Agent id，用于前端反查注册表（头像/状态/能力）。群聊时为 NULL */
  agent_id: string | null;
  sdk_session_id: string | null;
  /** 'direct' 一对一 | 'group' 群聊 */
  kind: string;
  /** 群聊成员 Agent id 的 JSON 数组字符串 */
  agent_ids: string | null;
  /** 群聊编排模式 */
  orchestration: string | null;
  /** 工作目录。NULL = 用后端进程 cwd */
  cwd: string | null;
  /**
   * A62：推理/思考强度档位值（如 `low` / `xhigh`）。NULL = 不显式传参，
   * 用 CLI 自己的默认（等价 config.toml 里那一行）。
   *
   * 存的是**档位值**不是档位名：换语言、官方改译名都不影响已存的数据。
   */
  reasoning_effort: string | null;
  /** 场景模板 id（P4） */
  scenario_id: string | null;
  /** 会话级系统提示词（场景注入） */
  system_prompt: string | null;
  /**
   * A123：会话级权限模式（`'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`）。
   *
   * NULL / undefined = 没选过 → 按 `'default'` 跑。存的是**枚举值本身**，
   * 不存中文标签（换语言不该让已存的数据失效）。
   *
   * 声明成可选是为了 `createSession()` 的调用点：绝大多数新建会话不指定档位，
   * 让每个调用点写一遍 `permission_mode: null` 只是噪音。
   */
  permission_mode?: string | null;
  /**
   * A98：所属项目 id。NULL = 会话没绑定工作目录，或来自回填之前的旧数据。
   *
   * 可选声明是为了 `createSession()` 的调用点：建会话时通常先落库、
   * 再由路由层按 cwd 关联项目。读取侧请走 `getSessionProject()`，
   * 它会同时处理「列为 NULL」和「指向已删除项目」两种情况。
   */
  project_id?: string | null;
  /**
   * 置顶标记。1 = 钉在消息列表顶部；老库迁移后为 0。
   *
   * 声明成可选是为了 `createSession()` 的调用点：新建会话一定是未置顶的，
   * 让每个调用点都写一遍 `pinned: 0` 只是噪音。读取时列上永远有值
   * （NOT NULL DEFAULT 0），所以 `s.pinned === 1` 判断是安全的。
   */
  pinned?: number | null;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  /** 群聊里这条消息出自哪个 Agent */
  author_agent_id: string | null;
  created_at: string;
  tool_calls: string | null;
  /** 生图消息的图片块 JSON 数组字符串（P4-4）。纯文本消息为 NULL */
  images: string | null;
  /** 这一轮回复的耗时（毫秒）。P6 成本统计；老消息为 NULL */
  duration_ms: number | null;
  /** 这一轮的费用（美元）。只有平台真给了账单价才有值 */
  cost: number | null;
  /** 这一轮消耗的 token 数。ACP 只有这个，没有费用 */
  tokens: number | null;
  /**
   * 有序内容块（E2）。JSON 数组字符串；老消息为 NULL。
   * 读取侧优先用它，为空再退回 content / tool_calls / images。
   */
  blocks: string | null;
}

/**
 * 写入用的消息形态。
 *
 * `images` 是 P4-4 才加的列，绝大多数调用点写的是纯文本消息，不该被迫
 * 在每个 INSERT 处补一个 `images: null` —— 那是纯粹的噪音，而且将来再加
 * 一个可选列时会重演一遍。读取侧（`DbMessage`）仍保持严格，因为
 * `SELECT *` 出来的行里这些列一定存在。
 */
/**
 * 写入用的消息形态。
 *
 * `duration_ms` / `cost` / `tokens`（P6 成本统计）是**可选的**：用户消息
 * 和早期消息没有用量数据，缺省即 NULL。让它们必传只会逼着每个调用点
 * 写三个 null，把「没有数据」和「显式写 null」混为一谈。
 */
export type DbMessageInput = Omit<
  DbMessage,
  'images' | 'duration_ms' | 'cost' | 'tokens' | 'blocks'
> & {
  images?: string | null;
  duration_ms?: number | null;
  cost?: number | null;
  tokens?: number | null;
  /** 有序内容块 JSON（E2）。不传 = NULL，读取侧退回旧字段 */
  blocks?: string | null;
};

// ============= 项目操作（A98）=============

export interface DbProject {
  id: string;
  /** 归一化后的绝对路径（小写 + 正斜杠 + 无尾斜杠） */
  path: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

/**
 * 按归一化路径查项目。传进来的 `cwd` 会先归一化，
 * 所以调用方不需要关心 `E:\a\b` 和 `e:/a/b/` 的差异。
 */
export function getProjectByPath(cwd: string): DbProject | undefined {
  const normalized = normalizeProjectPath(cwd);
  if (!normalized) return undefined;
  const stmt = db.prepare('SELECT * FROM projects WHERE path = ?');
  return stmt.get(normalized) as unknown as DbProject | undefined;
}

export function getProject(id: string): DbProject | undefined {
  const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
  return stmt.get(id) as unknown as DbProject | undefined;
}

export function listProjects(): DbProject[] {
  return db
    .prepare('SELECT * FROM projects ORDER BY last_opened_at DESC')
    .all() as unknown as DbProject[];
}

/**
 * 取或建。**同一个目录永远只有一个项目** —— 靠 projects.path 的唯一约束
 * 兜底，而不是靠先查后插（并发下那有窗口期）。
 *
 * 这里用 `INSERT ... ON CONFLICT(path) DO UPDATE` 而不是
 * `INSERT OR IGNORE` + 再查：后者要两次往返，而且 ON CONFLICT 可以在
 * 同一条语句里顺手刷新 last_opened_at。
 */
export function getOrCreateProject(cwd: string, name?: string): DbProject | undefined {
  const normalized = normalizeProjectPath(cwd);
  if (!normalized) return undefined;
  const now = new Date().toISOString();
  // 显示名用**原始** cwd 推导（保留大小写），键和唯一约束才用归一化路径
  const displayName = (name ?? '').trim() || defaultProjectName(cwd) || normalized;

  db.prepare(
    `INSERT INTO projects (id, path, name, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at`
  ).run(crypto.randomUUID(), normalized, displayName, now, now);

  return getProjectByPath(normalized);
}

/** 刷新「最近打开」，用于项目列表排序 */
export function touchProject(id: string): void {
  db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id
  );
}

export function renameProject(id: string, name: string): boolean {
  const clean = String(name ?? '').trim();
  if (!clean) return false;
  const r = db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(clean, id);
  return toNumber(r.changes) > 0;
}

/**
 * 删除项目：先把会话标成「用户主动解除归属」再删行。
 *
 * 为什么手动解绑而不是靠外键级联：project_id 是 ALTER 出来的列，加不了
 * 外键（见上面 ensureColumn 的说明）。这里必须自己收拾干净，
 * 否则会留下指向不存在项目的 session，读取侧就得永远防着。
 *
 * A131：解绑写的是**空串**而不是 NULL，这两个值不是一回事 ——
 * NULL = 「从没算过」（存量数据，交给 `backfillSessionProjects()` 回填），
 * '' = 「算过，而且用户亲手把它从项目里摘掉了」（回填必须跳过）。
 * 以前这里写 NULL，于是启动回填照着还留着的 cwd 把项目**重新建回来**，
 * 用户看到的正是「删掉的项目每次打开又出现」。
 *
 * 读取侧不受影响：`getSessionProject()` 判的是真值，'' 与 NULL 一样会
 * 回落到「按 cwd 现算」，所以记忆分区仍按路径走 —— 摘掉分组不该把
 * 那个目录的记忆一起抹成全局。
 *
 * **不删记忆文件** —— 那是用户的真实内容，删项目行不等于想扔掉记忆。
 */
export function deleteProject(id: string): boolean {
  db.prepare(`UPDATE sessions SET project_id = '' WHERE project_id = ?`).run(id);
  const r = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return toNumber(r.changes) > 0;
}

// ── 项目任务（A119）──────────────────────────────────────────────────────

/** 任务状态三档。与 project_tasks.status 的取值一一对应。 */
export type ProjectTaskStatus = 'todo' | 'doing' | 'done';

export interface DbProjectTask {
  id: string;
  project_id: string;
  title: string;
  status: ProjectTaskStatus;
  created_at: string;
  updated_at: string;
}

/**
 * 列表顺序：未完成在前、完成沉底，同档内按创建时间正序。
 *
 * 为什么在 SQL 里排而不是前端排：`status` 是文本，'doing' < 'done' < 'todo'
 * 的字典序恰好不是业务顺序。用 CASE 显式给出优先级，前端拿到的就是终态 ——
 * 否则「列表栏和详情页各排一次」迟早有一处漏改。
 */
const TASK_ORDER_SQL = `
  ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
           created_at ASC
`;

export function listProjectTasks(projectId: string): DbProjectTask[] {
  return db
    .prepare(`SELECT * FROM project_tasks WHERE project_id = ? ${TASK_ORDER_SQL}`)
    .all(projectId) as unknown as DbProjectTask[];
}

export function getProjectTask(id: string): DbProjectTask | undefined {
  return db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(id) as unknown as
    | DbProjectTask
    | undefined;
}

export function createProjectTask(projectId: string, title: string): DbProjectTask {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_tasks (id, project_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'todo', ?, ?)`
  ).run(id, projectId, title, now, now);
  return getProjectTask(id)!;
}

/**
 * 更新任务。只认 `title` / `status` 两个字段 —— 状态必须是那三档之一。
 *
 * 非法 status 一律**拒绝并返回 undefined**，而不是静默改成 'todo'：
 * 静默纠正会让前端一个写错的按钮看起来「点了有反应」，实际把任务
 * 重置了，最难查的那种。
 */
export function updateProjectTask(
  id: string,
  updates: { title?: string; status?: string }
): DbProjectTask | undefined {
  const fields: string[] = [];
  const values: Array<string> = [];

  if (typeof updates.title === 'string' && updates.title.trim()) {
    fields.push('title = ?');
    values.push(updates.title.trim());
  }
  if (updates.status !== undefined) {
    if (!isProjectTaskStatus(updates.status)) return undefined;
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (fields.length === 0) return getProjectTask(id);

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const r = db.prepare(`UPDATE project_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  if (toNumber(r.changes) === 0) return undefined;
  return getProjectTask(id);
}

export function deleteProjectTask(id: string): boolean {
  const r = db.prepare('DELETE FROM project_tasks WHERE id = ?').run(id);
  return toNumber(r.changes) > 0;
}

export function isProjectTaskStatus(v: unknown): v is ProjectTaskStatus {
  return v === 'todo' || v === 'doing' || v === 'done';
}

/**
 * 取会话所属项目。**容忍三种残缺**：没绑目录、project_id 为空、
 * project_id 指向已删除的项目。三种都返回 undefined，调用方退化成全局记忆。
 */
export function getSessionProject(sessionId: string): DbProject | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  if (session.project_id) {
    const byId = getProject(session.project_id);
    if (byId) return byId;
  }
  // project_id 缺失或已失效：按 cwd 现算一个（不落库，避免读操作写库）
  if (session.cwd) return getProjectByPath(session.cwd);
  return undefined;
}

/**
 * 存量回填：把「从没算过项目归属」的老会话按 cwd 关联到项目。
 *
 * 只吃 `project_id IS NULL`。**空串是另一回事** —— 它表示用户亲手把这个
 * 会话从项目里摘掉了（见 `deleteProject`），回填必须跳过它，否则删除动作
 * 会在下一次启动时被完整撤销。
 *
 * `cwd` 为空的会话（纯问答、没指定目录）保持 NULL —— 它们本来就不属于任何
 * 项目，硬塞一个「当前进程目录」反而会让它们的记忆错误地共享到一个假项目里。
 *
 * A131：目录在磁盘上已经不存在的一律跳过，与 `POST /api/projects` 用**同一把
 * 尺子**（`validateDirectory`）。此前两条路口径不一致：手动建项目要校验存在，
 * 回填不校验 —— 于是用户删掉的文件夹反而每次启动都被复活成一个项目。
 * 跳过时保持 NULL，所以目录哪天回来（外接盘、重新 clone）还能正常关联上。
 */
export function backfillSessionProjects(): number {
  const rows = db
    .prepare(
      `SELECT id, cwd FROM sessions
       WHERE project_id IS NULL AND cwd IS NOT NULL AND cwd != ''`
    )
    .all() as unknown as Array<{ id: string; cwd: string }>;

  let linked = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.cwd)) {
      skipped++;
      continue;
    }
    const project = getOrCreateProject(row.cwd);
    if (!project) continue;
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(project.id, row.id);
    linked++;
  }
  if (skipped > 0) {
    console.log(`[DB] 项目回填：${linked} 个会话已关联，${skipped} 个因目录已不存在而跳过`);
  }
  return linked;
}

// ============= 会话操作 =============

// 获取所有会话
export function getAllSessions(): DbSession[] {
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
  return stmt.all() as unknown as DbSession[];
}

// 获取单个会话
export function getSession(id: string): DbSession | undefined {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(id) as unknown as DbSession | undefined;
}

/**
 * A63：最近用过的目录（工作区面板的「最近目录」列表）。
 *
 * 口径：**用过才算**——只从 sessions.cwd 里取，按这些会话的最后活跃时间倒序。
 * 不另建一张「最近目录表」：那样会出现「选过但从没在会话里用过」的幽灵条目，
 * 两份数据还会各说各话。目录被所有会话放弃（cwd 清空）后自然消失。
 *
 * `MAX(updated_at)` 而不是 `ORDER BY updated_at`：同一个目录可能被多个会话
 * 同时引用，GROUP BY 之后取它**最近一次被用到**的时间，才符合「最近」的语义。
 *
 * ## A131：分组键必须是归一化路径，不是原始字符串
 *
 * `sessions.cwd` 存的是用户当初怎么写就怎么落的原样字符串，所以同一个目录会有
 * 好几种写法。实测：`c:/users/me/downloads/ack-v1` 与
 * `C:\Users\me\Downloads\ACK-v1` 并存 —— 列表里于是出现「ack-v1 / ACK-v1」
 * 两条，点掉一条另一条照旧。这里按 `normalizeProjectPath` 归一之后再去重，
 * **代表值取该目录最近一次被使用时的那条原样写法**：显示成 `ack-v1` 还是
 * `ACK-v1` 由用户决定，不由小写化替他决定。
 *
 * 点过 × 的在这里剔除，清单见 `server/dismissed-dirs.ts`。
 */
export function getRecentDirectories(limit = 8): string[] {
  const rows = db
    .prepare(`
      SELECT cwd, MAX(updated_at) AS last_used
      FROM sessions
      WHERE cwd IS NOT NULL AND cwd != ''
      GROUP BY cwd
      ORDER BY last_used DESC
    `)
    .all() as unknown as Array<{ cwd: string }>;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const key = normalizeProjectPath(row.cwd);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (isDismissed(row.cwd)) continue;
    out.push(row.cwd);
    if (out.length >= limit) break;
  }
  return out;
}

// 创建会话
export function createSession(session: DbSession): DbSession {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, title, model, agent_id, sdk_session_id,
      kind, agent_ids, orchestration,
      cwd, reasoning_effort, scenario_id, system_prompt, permission_mode, pinned, project_id,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    bind(session.id),
    bind(session.title),
    bind(session.model),
    bind(session.agent_id),
    bind(session.sdk_session_id),
    bind(session.kind ?? 'direct'),
    bind(session.agent_ids),
    bind(session.orchestration),
    bind(session.cwd),
    bind(session.reasoning_effort),
    bind(session.scenario_id),
    bind(session.system_prompt),
    bind(session.permission_mode ?? null),
    bind(session.pinned ?? 0),
    bind(session.project_id),
    bind(session.created_at),
    bind(session.updated_at)
  );
  return session;
}

// 更新会话
export function updateSession(
  id: string,
  updates: Partial<
    Pick<
      DbSession,
      | 'title'
      | 'model'
      | 'sdk_session_id'
      | 'agent_id'
      | 'kind'
      | 'agent_ids'
      | 'orchestration'
      | 'cwd'
      | 'reasoning_effort'
      | 'scenario_id'
      | 'system_prompt'
      | 'permission_mode'
      | 'pinned'
      | 'project_id'
    >
  >
): boolean {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.sdk_session_id !== undefined) {
    fields.push('sdk_session_id = ?');
    values.push(updates.sdk_session_id);
  }
  if (updates.agent_id !== undefined) {
    fields.push('agent_id = ?');
    values.push(updates.agent_id);
  }
  if (updates.kind !== undefined) {
    fields.push('kind = ?');
    values.push(updates.kind);
  }
  if (updates.agent_ids !== undefined) {
    fields.push('agent_ids = ?');
    values.push(updates.agent_ids);
  }
  if (updates.orchestration !== undefined) {
    fields.push('orchestration = ?');
    values.push(updates.orchestration);
  }
  if (updates.cwd !== undefined) {
    fields.push('cwd = ?');
    values.push(updates.cwd);
  }
  // A62：与 cwd 同构 —— 传 null 是「清空档位回到 CLI 默认」，
  // 不能和 undefined（这一项不更新）混为一个语义。
  if (updates.reasoning_effort !== undefined) {
    fields.push('reasoning_effort = ?');
    values.push(updates.reasoning_effort);
  }
  if (updates.scenario_id !== undefined) {
    fields.push('scenario_id = ?');
    values.push(updates.scenario_id);
  }
  if (updates.system_prompt !== undefined) {
    fields.push('system_prompt = ?');
    values.push(updates.system_prompt);
  }
  // A123：与 reasoning_effort 同构 —— null = 清空（回到「没选过」），
  // undefined = 这一项不动。合法性由路由层校验，这里不认值只认列。
  if (updates.permission_mode !== undefined) {
    fields.push('permission_mode = ?');
    values.push(updates.permission_mode);
  }
  if (updates.pinned !== undefined) {
    fields.push('pinned = ?');
    values.push(updates.pinned ? 1 : 0);
  }
  // A98：换工作目录时项目跟着换。传 null = 解除项目绑定（cwd 被清空）。
  if (updates.project_id !== undefined) {
    fields.push('project_id = ?');
    values.push(updates.project_id);
  }

  if (fields.length === 0) return false;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const stmt = db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values.map(bind));
  return toNumber(result.changes) > 0;
}

// 删除会话
export function deleteSession(id: string): boolean {
  const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const result = stmt.run(bind(id));
  return toNumber(result.changes) > 0;
}

/**
 * 清空一个会话的所有消息，**保留会话本身**（P7「删除聊天记录」）。
 *
 * 与 `deleteSession` 的区别是意图：退出群聊/删除会话走 deleteSession
 * （整条记录消失，列表里再也看不到）；删除聊天记录走这里 ——
 * 群还在、成员还在、绑定场景还在，只是消息从头开始。
 * 外键是 ON DELETE CASCADE，所以别用 deleteSession 的 SQL 顺手做这件事。
 */
export function deleteMessagesBySession(sessionId: string): number {
  const stmt = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const result = stmt.run(bind(sessionId));
  return toNumber(result.changes);
}

// ============= 消息操作 =============

// 获取会话的所有消息
export function getMessagesBySession(sessionId: string): DbMessage[] {
  const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
  return stmt.all(sessionId) as unknown as DbMessage[];
}

/**
 * 按 id 取单条消息（A99）。
 *
 * 文件核对要拿的是**落库的那份 blocks**，不是前端传来的块 —— 前端那份
 * 可能还在流式、也可能被本地补丁改过。核对结论必须基于持久化的记录，
 * 否则「核对」本身就成了另一个不可信的来源。
 */
export function getMessage(id: string): DbMessage | undefined {
  const stmt = db.prepare('SELECT * FROM messages WHERE id = ?');
  return stmt.get(bind(id)) as unknown as DbMessage | undefined;
}

// 创建消息
export function createMessage(message: DbMessageInput): DbMessage {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, author_agent_id, created_at, tool_calls, images, duration_ms, cost, tokens, blocks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    bind(message.id),
    bind(message.session_id),
    bind(message.role),
    bind(message.content),
    bind(message.model),
    bind(message.author_agent_id),
    bind(message.created_at),
    bind(message.tool_calls),
    bind(message.images),
    bind(message.duration_ms),
    bind(message.cost),
    bind(message.tokens),
    bind(message.blocks)
  );

  // 更新会话的 updated_at
  const updateStmt = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
  updateStmt.run(bind(new Date().toISOString()), bind(message.session_id));

  // 返回值对齐 DbMessage：三个可选列没传就是 NULL，不是 undefined
  return {
    ...message,
    images: message.images ?? null,
    duration_ms: message.duration_ms ?? null,
    cost: message.cost ?? null,
    tokens: message.tokens ?? null,
    blocks: message.blocks ?? null,
  };
}

// 更新消息内容
export function updateMessage(
  id: string,
  updates: Partial<Pick<DbMessage, 'content' | 'tool_calls' | 'images' | 'blocks'>>
): boolean {
  const fields: string[] = [];
  const values: Array<string | null> = [];

  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }
  if (updates.tool_calls !== undefined) {
    fields.push('tool_calls = ?');
    values.push(updates.tool_calls);
  }
  if (updates.images !== undefined) {
    fields.push('images = ?');
    values.push(updates.images);
  }
  if (updates.blocks !== undefined) {
    fields.push('blocks = ?');
    values.push(updates.blocks);
  }

  if (fields.length === 0) return false;

  values.push(id);

  const stmt = db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values.map(bind));
  return toNumber(result.changes) > 0;
}

// 删除消息
export function deleteMessage(id: string): boolean {
  const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
  const result = stmt.run(bind(id));
  return toNumber(result.changes) > 0;
}

// 批量创建消息（用于保存对话）
export function createMessages(messages: DbMessageInput[]): void {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, author_agent_id, created_at, tool_calls, images, duration_ms, cost, tokens, blocks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    for (const msg of messages) {
      stmt.run(
        bind(msg.id),
        bind(msg.session_id),
        bind(msg.role),
        bind(msg.content),
        bind(msg.model),
        bind(msg.author_agent_id),
        bind(msg.created_at),
        bind(msg.tool_calls),
        bind(msg.images),
        bind(msg.duration_ms),
        bind(msg.cost),
        bind(msg.tokens),
        bind(msg.blocks)
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 清空所有数据
export function clearAllData(): void {
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
}

// ============= 验证结果（A97）=============

export interface DbVerification {
  id: string;
  session_id: string;
  /** 挂在哪条回答下面；NULL = 会话级验证 */
  message_id: string | null;
  command_id: string;
  command: string;
  kind: string;
  label: string | null;
  /** pass | fail | timeout | error */
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  output: string | null;
  output_truncated: number;
  created_at: string;
}

/**
 * 写入一条验证结果。
 *
 * 同一 (session, message, command) 的旧结果会被**覆盖**而不是追加：
 * 用户改完代码重跑测试时，看到应该是「当前这次的结果」，而不是一串
 * 历史记录按时间排下来 —— 那样反而要自己判断哪条才是最新的。
 */
export function createVerification(v: DbVerification): DbVerification {
  db.prepare(
    'DELETE FROM verifications WHERE session_id = ? AND command_id = ? AND message_id IS ?'
  ).run(bind(v.session_id), bind(v.command_id), bind(v.message_id ?? null));

  db.prepare(`
    INSERT INTO verifications (
      id, session_id, message_id, command_id, command, kind, label,
      status, exit_code, duration_ms, output, output_truncated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bind(v.id),
    bind(v.session_id),
    bind(v.message_id ?? null),
    bind(v.command_id),
    bind(v.command),
    bind(v.kind),
    bind(v.label),
    bind(v.status),
    bind(v.exit_code),
    bind(v.duration_ms),
    bind(v.output),
    bind(v.output_truncated),
    bind(v.created_at)
  );

  return v;
}

/** 一个会话下的全部验证结果（按时间升序，前端自行按消息分组） */
export function getVerificationsBySession(sessionId: string): DbVerification[] {
  return db
    .prepare('SELECT * FROM verifications WHERE session_id = ? ORDER BY created_at ASC')
    .all(bind(sessionId)) as unknown as DbVerification[];
}

/** 删掉某条消息的验证结果（消息被删/重生成时用） */
export function deleteVerificationsByMessage(messageId: string): void {
  db.prepare('DELETE FROM verifications WHERE message_id = ?').run(bind(messageId));
}

// ============= 过程能力档（P2） =============

export interface StoredCapabilityProfile extends CapabilityProfile {
  /** run_end 一定给；这里显式收窄，消费方不必再判 undefined */
  observed: EventCapability[];
  updatedAt: number;
}

/**
 * 记下一次 run 的观测结果（按三元组覆盖）。
 *
 * 没有 `observed` 的档不写：那说明调用方在 run_start 阶段就调了，
 * 写进去等于把"声明"记成"事实"——正是这张表要防的事。
 */
export function saveCapabilityProfile(profile: CapabilityProfile): void {
  if (!profile.observed) return;
  const key = capabilityKeyString(profile.key);
  db.prepare(`
    INSERT INTO agent_capabilities (cap_key, engine, model, gateway, declared, observed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cap_key) DO UPDATE SET
      declared = excluded.declared,
      observed = excluded.observed,
      updated_at = excluded.updated_at
  `).run(
    bind(key),
    bind(profile.key.engine),
    bind(profile.key.model ?? null),
    bind(profile.key.gateway),
    bind(profile.declared ? JSON.stringify(profile.declared) : null),
    bind(JSON.stringify(profile.observed)),
    Date.now()
  );
}

/** 一个引擎最近一次被观测到的档（按 updatedAt 取最新） */
export function latestCapabilityProfileFor(engine: string): StoredCapabilityProfile | undefined {
  const row = db
    .prepare('SELECT * FROM agent_capabilities WHERE engine = ? ORDER BY updated_at DESC LIMIT 1')
    .get(bind(engine)) as Record<string, unknown> | undefined;
  return row ? parseCapabilityRow(row) : undefined;
}

function parseCapabilityRow(row: Record<string, unknown>): StoredCapabilityProfile {
  const parseList = (v: unknown): EventCapability[] | undefined => {
    if (typeof v !== 'string' || !v) return undefined;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as EventCapability[]) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    key: {
      engine: String(row.engine ?? ''),
      ...(row.model ? { model: String(row.model) } : {}),
      gateway: String(row.gateway ?? ''),
    },
    ...(parseList(row.declared) ? { declared: parseList(row.declared) } : {}),
    observed: parseList(row.observed) ?? [],
    updatedAt: Number(row.updated_at) || 0,
  };
}

// ============= 真实标定结果（P3） =============

/**
 * 记下一次真实标定（按三元组覆盖）。
 *
 * 空能力清单也要写：标定跑成功了、一条过程事件都没给，这是一个**结论**，
 * 和「没标定过」（表里没有这一行）必须能分开。所以这里没有 `if (!length) return`。
 */
export function saveCapabilityProbe(key: CapabilityKey, probe: CapabilityProbe): void {
  db.prepare(`
    INSERT INTO agent_capability_probes
      (cap_key, engine, model, gateway, capabilities, probed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(cap_key) DO UPDATE SET
      capabilities = excluded.capabilities,
      probed_at = excluded.probed_at
  `).run(
    bind(capabilityKeyString(key)),
    bind(key.engine),
    bind(key.model ?? null),
    bind(key.gateway),
    bind(JSON.stringify(probe.capabilities)),
    probe.at
  );
}

/** 某个三元组最近一次标定结果；没有就是 undefined（= 从没标定过） */
export function loadCapabilityProbe(key: CapabilityKey): CapabilityProbe | undefined {
  const row = db
    .prepare('SELECT capabilities, probed_at FROM agent_capability_probes WHERE cap_key = ?')
    .get(bind(capabilityKeyString(key))) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  let capabilities: EventCapability[];
  try {
    const parsed = JSON.parse(String(row.capabilities ?? ''));
    if (!Array.isArray(parsed)) return undefined;
    capabilities = parsed as EventCapability[];
  } catch {
    return undefined;
  }
  return { capabilities, at: Number(row.probed_at) || 0 };
}

export default db;
