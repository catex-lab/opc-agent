/**
 * B1 闸门：数据库损坏隔离 + 删除回收站。
 *
 * 三层验证，都打在最外层可观测量上：
 *
 * **1. 隔离（真文件）** —— 在临时目录造一个**真损坏**的 `chat.db`
 *    （不是合法 SQLite 头），跑 `checkIntegrity` → 必须判坏；再跑
 *    `quarantineDatabase` → 主文件与 `-wal`/`-shm` 必须整体搬到
 *    `corrupt-<时间戳>/`，原位置必须空出来（否则新库会被旧文件占位）。
 *    最后**用真 DatabaseSync 在新位置打开搬走的文件**，证明它是原件而非残片。
 *
 * **2. 回收站（真 DB 往返）** —— 在临时库上真删一个会话 / 真清一次消息，
 *    断言：原数据消失、回收站里能查到、恢复后数据回来、恢复后回收站记录清掉。
 *    再加一条负面用例：同 id 已重建时**必须报 conflict、不覆盖新数据**。
 *
 * **3. 接线（静态）** —— `db.ts` 打开前先 `checkIntegrity`、`clearAllData`
 *    覆盖 runs、删除路径走回收站。
 *
 * 反向探针：见 .tmp/probe-b1.mjs —— 真把隔离与快照摘掉，确认本闸门变红。
 */
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkIntegrity, quarantineDatabase, listCorruptArchives, DB_SIDECARS } from '../server/db-safety.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string, detail?: string): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures.push(label);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const work = mkdtempSync(path.join(tmpdir(), 'opc-b1-'));
const cleanup = () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
};

try {
  console.log('\n[1] 完整性检查：真损坏文件必须判坏');
  {
    // 正常库：先建一个真的
    const goodDir = path.join(work, 'good');
    mkdirSync(goodDir, { recursive: true });
    const good = path.join(goodDir, 'chat.db');
    const g = new DatabaseSync(good);
    g.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)');
    g.exec("INSERT INTO t VALUES ('1', 'hello')");
    g.close();
    const goodRes = checkIntegrity(good);
    ok(goodRes.ok === true, '健康库判定通过', goodRes.detail);

    // 损坏库：16KB 垃圾字节 + 合法 SQLite 头之外的东西
    const badDir = path.join(work, 'bad');
    mkdirSync(badDir, { recursive: true });
    const bad = path.join(badDir, 'chat.db');
    const junk = Buffer.alloc(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) % 251;
    writeFileSync(bad, junk);
    const badRes = checkIntegrity(bad);
    ok(badRes.ok === false, '垃圾字节文件判定为损坏', badRes.detail.slice(0, 60));

    // 不存在 = 首次启动，不该算坏
    ok(checkIntegrity(path.join(work, 'nope', 'chat.db')).ok === true, '不存在的文件视为首次启动（ok）');
  }

  console.log('\n[2] 隔离：主文件 + 附属文件整体搬走，原位清空');
  {
    const dir = path.join(work, 'quarantine');
    mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, 'chat.db');
    writeFileSync(dbFile, Buffer.from('not a real sqlite file, just bytes'));
    // 两个附属文件都要在，才能验证「漏一个就会新库+旧 WAL」
    writeFileSync(dbFile + '-wal', Buffer.from('wal-bytes'));
    writeFileSync(dbFile + '-shm', Buffer.from('shm-bytes'));

    const now = new Date('2026-11-26T12:00:00.000Z');
    const q = quarantineDatabase(dbFile, dir, now);
    ok(!!q.dir, '隔离目录已创建', q.dir ?? q.error ?? '');
    ok(q.moved.includes('chat.db'), '主文件被移动');
    ok(q.moved.includes('chat.db-wal'), 'WAL 被一并移动（漏了会「新库+旧 WAL」立刻再坏）');
    ok(q.moved.includes('chat.db-shm'), 'SHM 被一并移动');
    ok(!existsSync(dbFile), '原位置的主文件已清空（新库才能建起来）');
    for (const s of DB_SIDECARS) ok(!existsSync(dbFile + s), `原位置的 ${s} 已清空`);

    // 搬过去的必须是原件：逐字节比对
    if (q.dir) {
      const movedBytes = readFileSync(path.join(q.dir, 'chat.db'));
      ok(movedBytes.toString() === 'not a real sqlite file, just bytes',
        '搬走的是原件（逐字节一致），不是残片');
      const archived = listCorruptArchives(dir);
      ok(archived.length === 1 && archived[0].dir === q.dir, 'listCorruptArchives 能查到这次隔离');
    }

    // 隔离目录必须在数据目录下（跨盘 rename 会退化成复制+删除，半途失败更糟）
    ok(!!q.dir && path.dirname(q.dir) === dir, '隔离目录与数据库同目录（保证 rename 是原子的）');
  }

  console.log('\n[3] 回收站：真删真恢复（往返）');
  {
    // 用真 db 模块：必须先把 OPC_DATA_DIR 指到临时目录，否则会动真实用户库
    const dataDir = path.join(work, 'live');
    mkdirSync(dataDir, { recursive: true });
    process.env.OPC_DATA_DIR = dataDir;
    process.env.OPC_TRASH_RETENTION_DAYS = '30';
    const db = await import('../server/db.js');
    const conn = (db as unknown as { default: DatabaseSync }).default;

    // 直接 SQL 造数据：DbSession/DbMessageInput 要求全字段，闸门里没必凑齐，
    // 而回收站关心的是「行能原样写回」，用真表真行最能证明这一点。
    const now = new Date().toISOString();
    const insertSession = (id: string, title: string) =>
      conn
        .prepare(
          `INSERT INTO sessions (id, title, model, kind, pinned, created_at, updated_at)
           VALUES (?, ?, 'm1', 'direct', 0, ?, ?)`
        )
        .run(id, title, now, now);
    const insertMsg = (id: string, sid: string, content: string) =>
      conn
        .prepare(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`)
        .run(id, sid, content, now);

    insertSession('S1', '要被删的会话');
    insertMsg('M1', 'S1', '第一条');
    insertMsg('M2', 'S1', '第二条');
    ok(db.getMessagesBySession('S1').length === 2, '前置：会话里有 2 条消息');

    // 顺带验证「孤儿台账」被一起清掉
    conn
      .prepare(`INSERT INTO runs (id, session_id, status, started_at) VALUES ('R1', 'S1', 'interrupted', ?)`)
      .run(now);

    const deleted = db.deleteSession('S1');
    ok(deleted === true, 'deleteSession 返回 true');
    ok(db.getSession('S1') === undefined, '原会话已消失（读路径零侵入，不需要改它）');
    const orphan = conn.prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = 'S1'").get() as { n: number };
    ok(Number(orphan.n) === 0, 'runs 里的孤儿台账被一并删除（否则「清空了还说有后台任务」）');

    const trashAfterDelete = db.listTrash();
    ok(trashAfterDelete.length === 1, '回收站里有一条记录', String(trashAfterDelete.length));
    // 未判空会让后续每条断言直接抛（探针跑「没有快照」的版本时就是如此），
    // 那样只看得到一条红，看不到「整体已经坏了」——所以先兜底再断言。
    const firstTrash = trashAfterDelete[0];
    ok(firstTrash?.kind === 'session', 'kind = session', firstTrash?.kind);
    ok(firstTrash?.label === '要被删的会话', 'label 带原会话标题', firstTrash?.label);

    // 恢复 → 数据回来，回收站记录清掉
    const restored = firstTrash ? db.restoreTrashItem(firstTrash.id) : 'not-found';
    ok(restored === 'ok', '恢复返回 ok', restored);
    ok(db.getSession('S1')?.title === '要被删的会话', '会话标题恢复');
    ok(db.getMessagesBySession('S1').length === 2, '两条消息一并恢复');
    ok(db.listTrash().length === 0, '恢复后回收站记录被消费掉');

    // 负面用例：删了又重建同 id → 必须 conflict，不能冲掉新数据
    db.deleteSession('S1');
    insertSession('S1', '新建的同 id 会话');
    const conflictTrash = db.listTrash()[0];
    const conflict = conflictTrash ? db.restoreTrashItem(conflictTrash.id) : 'not-found';
    ok(conflict === 'conflict', '同 id 已存在时返回 conflict（不静默覆盖）', conflict);
    ok(db.getSession('S1')?.title === '新建的同 id 会话', '新数据没有被旧快照冲掉');

    // 负面用例：过期的条目**不能**恢复成功。
    // 之前 get() 不过滤 expires_at、恢复却不判，会出现「恢复成功但列表里永远看不到」——
    // 用户拿到成功提示、却哪里都找不到。这里把它钉死。
    {
      const expiredId = conflictTrash?.id;
      ok(!!expiredId, '上一条 conflict 用例留下了可用的回收站记录');
      if (expiredId) {
        conn
          .prepare('UPDATE trash SET expires_at = ? WHERE id = ?')
          .run(new Date(Date.now() - 86_400_000).toISOString(), expiredId);
        ok(
          db.listTrash().every(t => t.id !== expiredId),
          '过期条目不出现在列表里（list 按 expires_at 过滤）'
        );
        const expiredResult = db.restoreTrashItem(expiredId);
        ok(expiredResult === 'expired', '过期条目返回 expired 而不是 ok', expiredResult);
        ok(db.getSession('S1')?.title === '新建的同 id 会话', '过期恢复没有动到任何数据');
        // 清掉，免得影响后面 clearAllData 仍保留回收站的断言
        conn.prepare('DELETE FROM trash WHERE id = ?').run(expiredId);
      }
    }

    // 清空消息也走回收（label 带条数）
    insertMsg('M3', 'S1', 'x');
    insertMsg('M4', 'S1', 'y');
    const cleared = db.deleteMessagesBySession('S1');
    ok(cleared === 2, '清空会话消息返回 2', String(cleared));
    const msgTrash = db.listTrash().find(t => t.kind === 'messages');
    ok(!!msgTrash, '消息清空也进了回收站');
    ok(!!msgTrash && /2 条消息/.test(msgTrash.label), 'label 写明条数（一眼看出恢复的是什么）', msgTrash?.label);
    if (msgTrash) {
      ok(db.restoreTrashItem(msgTrash.id) === 'ok', '消息快照能恢复');
      ok(db.getMessagesBySession('S1').length === 2, '恢复后消息回到 2 条');
    }

    // clearAllData 必须清 runs，但保留回收站
    conn
      .prepare(`INSERT INTO runs (id, session_id, status, started_at) VALUES ('R2', 'S1', 'running', ?)`)
      .run(now);
    const trashBeforeClear = db.listTrash().length;
    db.clearAllData();
    const runsLeft = conn.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
    ok(Number(runsLeft.n) === 0, 'clearAllData 清空 runs（以前它没有外键，会残留）');
    ok(db.listTrash().length === trashBeforeClear, 'clearAllData 不动回收站（不连后悔药一起扔）');
  }

  console.log('\n[4] 接线：三个动作都必须在正确位置');
  {
    const src = stripComments(read('server/db.ts'));
    ok(/checkIntegrity\(dbPath\)/.test(src), '打开前先做完整性检查');
    ok(/quarantineDatabase\(dbPath/.test(src), '判坏后隔离（不是原地修）');
    const openAt = src.indexOf('new DatabaseSync(dbPath)');
    const checkAt = src.indexOf('checkIntegrity(dbPath)');
    ok(checkAt > 0 && openAt > checkAt, '检查在打开之前（打开坏库会直接抛）');
    // 只认「真的去修」的调用形态，不认字符串里提到的工具名 ——
    // 隔离日志里就写着「可自行用 sqlite3 .recover」，那是给用户的操作指引，
    // 不是我们自己的修复动作。早期用 /\.recover/ 一跑就假红。
    ok(!/VACUUM\s+INTO\s+/i.test(src) && !/db\.(exec|prepare)\(\s*['"`]\s*REINDEX/i.test(src) &&
       !/recoverDatabase|attemptRepair/i.test(src),
      '没有「尝试修复」的代码路径（修错一次就是二次破坏）');

    const clear = src.slice(src.indexOf('export function clearAllData'), src.indexOf('export function clearAllData') + 400);
    ok(/DELETE FROM runs/.test(clear), 'clearAllData 显式清 runs（它的 session_id 没有外键）');
    ok(/DELETE FROM sessions/.test(clear) && /DELETE FROM messages/.test(clear), 'clearAllData 仍清 sessions/messages');
    ok(!/DELETE FROM trash/.test(clear), '清空数据不连后悔药一起扔（回收站保留到过期）');

    ok(/trashStore\.put\(/.test(src), '删除路径走回收站快照');
    ok(/DELETE FROM runs WHERE session_id/.test(src), 'deleteSession 也清 runs（避免孤儿台账）');
  }
} finally {
  cleanup();
}

console.log(`\n=== ${checks - failures.length}/${checks} 通过 ===`);
if (failures.length > 0) {
  console.log(`失败项：\n${failures.map(f => `  · ${f}`).join('\n')}`);
  process.exit(1);
}
