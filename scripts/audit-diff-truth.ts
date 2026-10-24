/**
 * 只读审计：`server/file-evidence.ts` 在**真实对话数据**上的表现。
 *
 * ## 它和单测的分工
 *
 * `verify-a99-evidence.ts` 用临时文件把每个判定分支钉死，那是「代码对不对」。
 * 本脚本回答的是另一个问题：**这套判定在真实数据上会给出什么结论** ——
 * 有多少写类工具、多少能核对、多少是真的对不上。
 *
 * 之所以必须分开：单测里的夹具是我自己造的，永远比我造的干净。真实数据里
 * 有临时文件、有被后续编辑改回去的、有路径写在别的盘上的 —— 这些才是
 * 判断「要不要把结论显示给用户」的依据。
 *
 * ## 只读保证
 *
 * 把 `chat.db`（含 -wal / -shm）复制到临时目录再打开。真实对话库全程
 * 不被本脚本连接 —— 这类脚本一旦误写，代价是本机唯一的真实历史。
 *
 * 运行：
 *   npx tsx scripts/audit-diff-truth.ts [--db <path>] [--verbose]
 *
 * 打包版的真实数据在 %APPDATA%\<app>\chat.db，例如：
 *   npx tsx scripts/audit-diff-truth.ts --db "$APPDATA/opc-agent/chat.db"
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyToBlocks, type Block } from '../shared/blocks.js';
import {
  summarizeEvidence,
  verifyFileChanges,
  type FileEvidence,
  type FileVerdict,
} from '../server/file-evidence.js';

// ============= 参数 =============

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DB_PATH = path.resolve(argOf('--db', path.join('data', 'chat.db')));
const VERBOSE = argv.includes('--verbose');

// ============= 数据库（复制后再打开） =============

/**
 * 复制主库 + WAL + SHM。
 *
 * 必须连 -wal 一起拷：本机那份开发库的 WAL 有 260KB，比主库（94KB）还大 ——
 * 只拷主库会漏掉最近的全部写入，审计结果会莫名其妙地「全是老消息」。
 */
function copyDbToTemp(dbPath: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-audit-'));
  let copied = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = dbPath + suffix;
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dir, `chat.db${suffix}`));
    copied++;
  }
  if (copied === 0) throw new Error(`找不到数据库：${dbPath}`);
  return path.join(dir, 'chat.db');
}

interface Row {
  id: string;
  created_at: string;
  blocks: string | null;
  tool_calls: string | null;
  cwd: string | null;
}

/**
 * 一行消息 → 块序列。
 *
 * 优先用 blocks 列；只有在它**一个工具块都没有**时才回退到老列 tool_calls。
 * 两列同时有值的老消息会把同一批调用计两遍 —— 第一版就是这么把 15 个
 * 写类工具数成 30 个的。
 */
function blocksOf(row: Row): Block[] {
  if (row.blocks) {
    try {
      const parsed: unknown = JSON.parse(row.blocks);
      if (Array.isArray(parsed)) {
        const blocks = parsed as Block[];
        if (blocks.some(b => b?.type === 'tool')) return blocks;
      }
    } catch {
      // 半截 JSON（流式中被打断）解析不了 —— 这类消息本来也没有可信数据
    }
  }
  if (row.tool_calls) {
    try {
      const calls: unknown = JSON.parse(row.tool_calls);
      if (Array.isArray(calls) && calls.length > 0) {
        return legacyToBlocks({
          toolCalls: calls as Parameters<typeof legacyToBlocks>[0]['toolCalls'],
        });
      }
    } catch {
      /* 同上 */
    }
  }
  return [];
}

// ============= 主流程 =============

console.log('\n只读审计：声明的文件修改 vs 磁盘真实内容');
console.log(`数据源：${DB_PATH}`);

const tmpDb = copyDbToTemp(DB_PATH);
const db = new DatabaseSync(tmpDb);

const rows = db
  .prepare(
    `SELECT m.id, m.created_at, m.blocks, m.tool_calls, s.cwd
       FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
      WHERE m.role = 'assistant' AND (m.blocks IS NOT NULL OR m.tool_calls IS NOT NULL)
      ORDER BY m.created_at`
  )
  .all() as unknown as Row[];

db.close();

let totalToolBlocks = 0;
const all: FileEvidence[] = [];
for (const row of rows) {
  const blocks = blocksOf(row);
  totalToolBlocks += blocks.filter(b => b.type === 'tool').length;
  all.push(...verifyFileChanges(blocks, row.cwd, Date.parse(row.created_at)));
}

// ============= 报告 =============

const byVerdict = new Map<FileVerdict, FileEvidence[]>();
for (const e of all) {
  const list = byVerdict.get(e.verdict) ?? [];
  list.push(e);
  byVerdict.set(e.verdict, list);
}
const count = (v: FileVerdict) => byVerdict.get(v)?.length ?? 0;

const s = summarizeEvidence(all);
const ephemeral = count('ephemeral');
const skipped = count('skipped');
const checkable = s.total - ephemeral - skipped;
const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

console.log(`\n消息 ${rows.length} 条 / 工具块 ${totalToolBlocks} 个 / 写类工具 ${all.length} 个`);
console.log(
  `可核对 ${checkable} 个 · 临时文件已清理 ${ephemeral} 个 · 跳过 ${skipped} 个\n`
);

const line = (label: string, n: number) =>
  console.log(`  ${label.padEnd(18)}${String(n).padStart(4)}   ${pct(n, checkable)}`);

line('落地', count('landed'));
line('落地后被改过', count('landed_then_modified'));
line('无法判定', count('ambiguous'));
line('声明了但没落地', count('not_landed'));
line('文件已不存在', count('missing'));

const later = all.filter(e => e.laterModified).length;
if (later > 0) {
  console.log(`\n  其中 ${later} 个目标文件的 mtime 晚于消息时间 —— 只能当参考`);
}

if (s.alarm) console.log(`\n  ⚠ ${s.alarm}`);

// 问题清单
const problems = all.filter(e => e.verdict === 'not_landed' || e.verdict === 'missing');
if (problems.length) {
  console.log('\n问题清单（最多 20 条）：');
  for (const e of problems.slice(0, 20)) {
    console.log(`  · ${e.toolName.padEnd(10)} ${e.verdict.padEnd(11)} ${e.display}`);
  }
  if (problems.length > 20) console.log(`  … 另有 ${problems.length - 20} 条`);
}

if (VERBOSE) {
  console.log('\n全部判定：');
  for (const e of all) console.log(`  ${e.verdict.padEnd(20)} ${e.toolName.padEnd(10)} ${e.display}`);
}

console.log(`\n（临时副本 ${path.dirname(tmpDb)} 可直接删除）\n`);
