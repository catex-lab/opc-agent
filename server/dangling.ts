/**
 * 悬空 CLI 回合（A207）。
 *
 * ## 要防的是什么
 *
 * CLI 型 Agent 的上下文活在它自己的会话里（opencode 的 `session_message`、
 * claude/codex 的会话文件），我们这边的 `sdk_session_id` 只是一个续接令牌。
 * 当一轮「用户发了指令、助手没答完」（额度 429、超时、进程被杀）之后：
 *
 *   1. 令牌不变 —— 下一次请求仍然 `--session <同一个 id>`；
 *   2. CLI 会话里那条 user 指令还在，旁边是一条 `finish: error / content: []`
 *      的 assistant；
 *   3. 新模型恢复这个会话，看到「有指令、没答案」，就把它当成交办的事自己执行了。
 *
 * 所以这里不做「自动清理」也不做「静默续接」，只做**识别**：命中时由
 * /api/chat 返回一个确认请求，让用户明确选「继续那一条」还是「新建会话」。
 *
 * ## 为什么不直接复用 GET 里的 `dangling`
 *
 * 那个标记回答的是「界面这一轮有没有产出回复」，判断依据是 chat.db 的最后
 * 一条消息。CLI 的真相比这更具体：opencode 会先写一条 `finish: error` 的
 * assistant 再写 `idle outcome: failed`，而 chat.db 里可能还有一条空的
 * assistant 记录。按 CLI 自己的结构判断，才不会把「其实已经答完」的会话
 * 也弹一个确认。
 *
 * ## 边界
 *
 * - 只有 opencode 能读到会话库（`~/.local/share/opencode/opencode.db`）。
 *   其他 CLI 退回到「chat.db 最后一条助手消息是否失败」的保守判断 ——
 *   宁可多问一句，也不要让旧指令被悄悄重放。
 * - 读库全程只读，不修改 CLI 的任何数据。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isFailedAssistantRow, type HistorySourceRow } from './history.js';

export interface DanglingTurn {
  /** 没有答完的那条用户指令原文 */
  userText: string;
  /** 给用户看的原因（已整理，不含原始 JSON） */
  reason: string;
  /** 判定依据：opencode 会话库 / 本应用 chat.db */
  source: 'opencode' | 'local';
  /** 命中的提问工具名（说明「问不出去」，不是普通的失败回合） */
  askTool?: string;
}

/**
 * 「上一轮之所以没答完，是因为问不出去」。
 *
 * 这是 opencode `question` 工具在非交互 run 下失败的典型形态：工具报错 →
 * 模型没有等到人回答，就直接按自己的假设继续执行（那次是 npm install）。
 * 这种回合在 chat.db 里**是有正文的**，按「最后一条助手消息是否为空」判断
 * 会漏掉，必须看工具块。
 */
const ASK_TOOL_RE = /question|ask[_ -]?user|askuser|confirm|permission|elicitation/i;

function parseBlocks(raw: string | null | undefined): Array<Record<string, unknown>> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

/** 从 chat.db 的块里找「提问工具失败」；返回工具名 */
function failedAskToolOf(row: HistorySourceRow): string | null {
  const blocks = parseBlocks(row.blocks);
  if (!blocks) return null;
  const hit = blocks.find(b => {
    if (b?.type !== 'tool') return false;
    const failed = b.isError === true || b.status === 'failed' || b.status === 'error';
    const name = String(b.name ?? '');
    return failed && ASK_TOOL_RE.test(name);
  });
  return hit ? String(hit.name ?? '') : null;
}

/** 会话库判定结果：null = 读不到（降级到本地判断）；`answered` = CLI 已答完 */
type OpencodeProbe = DanglingTurn | { answered: true } | null;

/** 单行化 + 截断，避免把上游的长 URL / JSON 塞进弹窗 */
function clipOneLine(text: unknown, max = 140): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function opencodeDbPath(): string | null {
  const xdg = (process.env.XDG_DATA_HOME ?? '').trim();
  const base = xdg || path.join(os.homedir(), '.local', 'share');
  const candidate = path.join(base, 'opencode', 'opencode.db');
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function withOpencodeDb<T>(fn: (db: DatabaseSync) => T): T | null {
  const p = opencodeDbPath();
  if (!p) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    return fn(db);
  } catch {
    // 库被占用/版本不兼容/表结构变了：一律降级，不影响正常对话
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关闭失败不该覆盖真正的返回值 */
    }
  }
}

interface OpencodeMessageRow {
  type: string;
  data: string;
}

function parseData(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 从 opencode 的 assistant content 里找「提问工具失败」 */
function failedAskToolInData(data: Record<string, unknown>): string | null {
  const content = data.content;
  if (!Array.isArray(content)) return null;
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const state = item.state && typeof item.state === 'object'
      ? (item.state as Record<string, unknown>)
      : null;
    const name = String(item.tool ?? item.name ?? '');
    const status = String(state?.status ?? item.status ?? '');
    const errored = !!state?.error || !!item.error || status === 'error' || status === 'failed';
    if (errored && ASK_TOOL_RE.test(name)) return name;
  }
  return null;
}

function assistantFailureReason(data: Record<string, unknown>): string {
  const err = data.error;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const type = typeof e.type === 'string' ? e.type : 'error';
    const status = typeof e.status === 'number' ? ` (${e.status})` : '';
    const message = e.message ? `：${clipOneLine(e.message)}` : '';
    return `CLI 会话里最后一轮失败：${type}${status}${message}`;
  }
  if (data.finish === 'error') return 'CLI 会话里最后一轮以错误结束';
  return 'CLI 会话里最后一轮没有产出内容';
}

/**
 * 直接按 opencode 自己的会话结构判断。
 *
 * 只看会话库里最新的 `user` / `assistant` 两种消息（`idle`、`model-switched`
 * 一类控制行跳过）。
 */
function probeOpencode(resumeToken: string): OpencodeProbe {
  return withOpencodeDb(db => {
    let rows: OpencodeMessageRow[];
    try {
      rows = db
        .prepare(
          `SELECT type, data FROM session_message
           WHERE session_id = ? AND type IN ('user','assistant')
           ORDER BY seq DESC LIMIT 16`
        )
        .all(resumeToken) as unknown as OpencodeMessageRow[];
    } catch {
      return null;
    }
    if (rows.length === 0) return null;

    const last = rows[0];
    const lastData = parseData(last.data);

    if (last.type === 'user') {
      const text = lastData && typeof lastData.text === 'string' ? lastData.text.trim() : '';
      return {
        userText: text,
        reason: 'CLI 会话里这条指令还没有得到回复',
        source: 'opencode',
      };
    }

    if (!lastData) return null;

    // 先看「问不出去」：这种回合可能有正文（模型自行继续执行了），
    // 按「content 是否为空」判断会漏掉。
    const askTool = failedAskToolInData(lastData);
    if (askTool) {
      const prevUser = rows.slice(1).find(r => r.type === 'user');
      const prevData = prevUser ? parseData(prevUser.data) : null;
      const userText = prevData && typeof prevData.text === 'string' ? prevData.text.trim() : '';
      return {
        userText,
        reason: `CLI 会话里 ${askTool} 没能把问题送到你面前（非交互运行），模型随后可能按自己的假设继续了`,
        source: 'opencode',
        askTool,
      };
    }

    const content = lastData.content;
    const hasAnyPart = Array.isArray(content) && content.length > 0;
    const failed =
      !!lastData.error
      || lastData.finish === 'error'
      // content 为空数组 = opencode 记的「什么都没产出」（如 429 那一轮）
      || !hasAnyPart;
    if (!failed) return { answered: true };

    const prevUser = rows.slice(1).find(r => r.type === 'user');
    const prevData = prevUser ? parseData(prevUser.data) : null;
    const userText = prevData && typeof prevData.text === 'string' ? prevData.text.trim() : '';
    return { userText, reason: assistantFailureReason(lastData), source: 'opencode' };
  });
}

/** 退路：按 chat.db 里最后一条助手消息是否失败来判断（保守，宁多问一句） */
function probeLocal(rows: HistorySourceRow[]): DanglingTurn | null {
  const list = rows.filter(r => r.role === 'user' || r.role === 'assistant');
  if (list.length === 0) return null;

  const last = list[list.length - 1];
  if (last.role === 'user') {
    return {
      userText: (last.content ?? '').trim(),
      reason: '最后一条指令还没有得到回复',
      source: 'local',
    };
  }

  let prev = list.length - 2;
  while (prev >= 0 && list[prev].role !== 'user') prev -= 1;
  const prevText = prev >= 0 ? (list[prev].content ?? '').trim() : '';

  // 「提问工具失败」优先：这一轮可能有正文，但它是在没等到人回答的情况下
  // 自己继续的，正是必须拦下来让用户确认的形态。
  const askTool = failedAskToolOf(last);
  if (askTool) {
    return {
      userText: prevText,
      reason: `上一轮通过 ${askTool} 想向你确认，但非交互运行下工具失败；模型随后可能按自己的假设继续了`,
      source: 'local',
      askTool,
    };
  }

  if (!isFailedAssistantRow(last)) return null;
  return {
    userText: prevText,
    reason: '最后一轮以错误结束，没有产出可用的回复',
    source: 'local',
  };
}

/**
 * 识别「CLI 会话里存在未应答的用户指令」。
 *
 * @param agentId 当前会话的 Agent
 * @param resumeToken 会话的 sdk_session_id；为空 = 没有可续接的 CLI 会话
 * @param rows 当前会话的 chat.db 消息（时间正序）
 */
export function findDanglingTurn(
  agentId: string,
  resumeToken: string | null | undefined,
  rows: HistorySourceRow[]
): DanglingTurn | null {
  if (!resumeToken) return null;

  // 先看本地：失败回合 / 提问工具失败都能在块里直接看出来。
  // 但**本地「看起来健康」不等于答完了** —— opencode 的 question 工具在
  // 非交互 run 下失败时，那一轮往往有正文，块里也不一定留痕；
  // 真相只在 CLI 自己的会话库里。所以本地为空时也要继续往下问 CLI。
  const local = probeLocal(rows);

  // 「问不出去」的证据在块里，比 CLI 会话库的 answered 更硬：
  // 即使 CLI 最后写了正文，那一轮也是模型在没等到人回答的情况下自己继续的。
  if (local?.askTool) return local;

  if (agentId === 'opencode') {
    const precise = probeOpencode(resumeToken);
    // 能读到 CLI 结构就以 CLI 为准：它说答完了，就不打扰用户
    if (precise && 'answered' in precise) return null;
    if (precise) return precise;
  }
  return local;
}

/**
 * 令牌指向的 CLI 会话属于哪个工作目录（目前只有 opencode 能回答）。
 *
 * 返回 null = 读不到（库不存在 / 表结构变了 / 别的 CLI）。
 */
export function opencodeSessionDirectory(resumeToken: string): string | null {
  return withOpencodeDb(db => {
    for (const table of ['session_v2', 'session']) {
      try {
        const row = db.prepare(`SELECT directory FROM ${table} WHERE id = ? LIMIT 1`).get(resumeToken) as
          | { directory?: string | null }
          | undefined;
        if (row?.directory) return String(row.directory);
      } catch {
        /* 该表不存在就试下一张 */
      }
    }
    return null;
  });
}

/**
 * 两个目录是否指向同一个位置。
 *
 * Windows 下大小写不敏感、斜杠混用是常态（`C:/Users/...` vs `C:\Users\...`），
 * 直接字符串比较会把同一个目录判成两个。
 */
export function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string) =>
    path
      .resolve(p)
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}
