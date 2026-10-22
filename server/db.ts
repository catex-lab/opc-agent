import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { dataDirPath } from './paths.js';

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
ensureColumn('sessions', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
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
 */
export function getRecentDirectories(limit = 8): string[] {
  const stmt = db.prepare(`
    SELECT cwd, MAX(updated_at) AS last_used
    FROM sessions
    WHERE cwd IS NOT NULL AND cwd != ''
    GROUP BY cwd
    ORDER BY last_used DESC
    LIMIT ?
  `);
  const rows = stmt.all(limit) as unknown as Array<{ cwd: string }>;
  return rows.map(r => r.cwd).filter(Boolean);
}

// 创建会话
export function createSession(session: DbSession): DbSession {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, title, model, agent_id, sdk_session_id,
      kind, agent_ids, orchestration,
      cwd, reasoning_effort, scenario_id, system_prompt, pinned,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    bind(session.pinned ?? 0),
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
      | 'pinned'
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
  if (updates.pinned !== undefined) {
    fields.push('pinned = ?');
    values.push(updates.pinned ? 1 : 0);
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

export default db;
