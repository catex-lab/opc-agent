/**
 * B1：数据库完整性与损坏隔离。
 *
 * ## 为什么必须做「隔离」而不是「修复」
 *
 * `chat.db` 是用户数据的**唯一事实来源**（没有云端、没有副本）。SQLite 自带的
 * `PRAGMA integrity_check` 只能告诉你「坏了」，没有任何修复能力；第三方
 * 「sqlite recover」工具会**重写**文件，修错一次就是二次破坏 —— 原文件连同
 * 可挽救的部分一起没了。所以这里的策略是：
 *
 *   1. **绝不原地修**；
 *   2. 把 `chat.db` 与它的 `-wal` / `-shm` **整体移到** `data/corrupt-<时间戳>/`；
 *   3. 用新库启动，并在日志里明确写出隔离目录，用户可以自己拿工具去救。
 *
 * 代价是「用户打开应用发现聊天记录空了」——所以日志必须足够显眼，
 * 且 `listCorruptArchives()` 供界面/排障查看。这是用户在方案里确认的取舍：
 * 宁可「看起来空、数据还在」，也不要「启动失败、应用打不开」。
 *
 * ## 为什么闸门要能直接 import
 *
 * 起一个真损坏的库再走完整启动流程既慢又不稳（要伪造磁盘错误）。所以把
 * 「判定 + 移动」拆成纯函数模块，闸门用临时目录造一个真损坏文件来验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite 主文件旁的两个附属文件。漏一个就会「新库 + 旧 WAL」= 立刻再坏一次。 */
export const DB_SIDECARS = ['-wal', '-shm'] as const;

export interface IntegrityResult {
  ok: boolean;
  /** `PRAGMA integrity_check` 的原始输出（ok 时通常是 `ok`） */
  detail: string;
}

/**
 * 检查一个数据库文件是否可读且完整。
 *
 * 三种「坏」都要算进来，缺一条都会让损坏库带着残缺数据继续跑：
 *   · 打不开（不是 SQLite 文件 / 头部损坏 / 被独占锁）→ 异常；
 *   · `integrity_check` 返回非 `ok` → 逻辑损坏（页错位、索引损坏）；
 *   · 路径不存在 → 视为「全新」，由调用方正常建库。
 */
export function checkIntegrity(dbFile: string): IntegrityResult {
  if (!fs.existsSync(dbFile)) return { ok: true, detail: '不存在（首次启动）' };
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSync(dbFile, { readOnly: true });
    const rows = conn.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    // 正常返回单行 { integrity_check: 'ok' }；损坏时返回多行描述。
    const detail = rows
      .map(r => String(Object.values(r)[0] ?? ''))
      .join('; ')
      .trim();
    return { ok: detail === 'ok', detail: detail || '(空结果)' };
  } catch (e) {
    return { ok: false, detail: `无法打开：${(e as Error).message}` };
  } finally {
    try {
      conn?.close();
    } catch {
      /* 损坏库 close 也可能抛，忽略 */
    }
  }
}

export interface QuarantineResult {
  /** 隔离目录；失败时为 null */
  dir: string | null;
  /** 实际移动了哪些文件（主文件 + 存在的附属文件） */
  moved: string[];
  error?: string;
}

/**
 * 把损坏的库与它的附属文件整体移到 `data/corrupt-<时间戳>/`。
 *
 * **同目录内 rename**：跨盘 rename 会退化成「复制+删除」，一旦中途失败
 * 就留下半份文件、比不搬更糟。这里刻意把隔离目录建在 `dataDir` 下面
 * （与 `chat.db` 同卷），保证是原子的 rename。
 */
export function quarantineDatabase(dbFile: string, dataDir: string, now = new Date()): QuarantineResult {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(dataDir, `corrupt-${stamp}`);
  const moved: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const targets = [dbFile, ...DB_SIDECARS.map(s => dbFile + s)];
    for (const file of targets) {
      if (!fs.existsSync(file)) continue;
      fs.renameSync(file, path.join(dir, path.basename(file)));
      moved.push(path.basename(file));
    }
    // 主文件必须真的搬走了，否则「新库」会被旧文件占位
    if (!moved.includes(path.basename(dbFile))) {
      return { dir: null, moved, error: '主数据库文件不存在，未执行隔离' };
    }
    return { dir, moved };
  } catch (e) {
    return { dir: null, moved, error: (e as Error).message };
  }
}

/**
 * 列出历史上被隔离的损坏库（供排障查看 / 界面提示）。
 * 新 → 旧排序。不抛错：这个函数本身不该让启动失败。
 */
export function listCorruptArchives(dataDir: string): Array<{ dir: string; at: string; files: string[] }> {
  try {
    return fs
      .readdirSync(dataDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('corrupt-'))
      .map(d => {
        const dir = path.join(dataDir, d.name);
        let files: string[] = [];
        try {
          files = fs.readdirSync(dir);
        } catch {
          /* 目录读不了就只报目录名 */
        }
        return { dir, at: d.name.replace('corrupt-', ''), files };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}
