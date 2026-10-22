/**
 * 会话持久化验证（P4-1）。
 *
 * 为什么用独立临时库：`server/db.ts` 在 **import 时**就会打开数据库并跑迁移。
 * 直接 import 会动到 `data/chat.db`（真实用户数据）。这里先把 `OPC_DATA_DIR`
 * 指到一个临时目录，再动态 import —— 迁移、写入、查询全部发生在临时库上，
 * 真实数据零接触。
 *
 * 覆盖：
 *   1. 迁移：老结构（sessions 表没有 cwd/scenario_id/system_prompt）的库能
 *      自动补列，且老行读出为 NULL（语义 = 未指定），不报错。
 *   2. createSession 写入 cwd / scenario_id / system_prompt 并原样读回。
 *   3. 不传这三列时落 NULL。
 *   4. updateSession 能改这三列，且改其中一列不影响其它列。
 *   5. getAllSessions 带出这三列。
 *
 * 运行：npx tsx scripts/verify-session-persist.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const failures: string[] = [];
const checks = { total: 0 };

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-session-'));
  process.env.OPC_DATA_DIR = tmpDir;

  // —— 1. 先造一个「老结构」的库：sessions 表没有 P4 的三列 ——
  {
    const seed = new DatabaseSync(path.join(tmpDir, 'chat.db'));
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        agent_id TEXT,
        sdk_session_id TEXT,
        kind TEXT NOT NULL DEFAULT 'direct',
        agent_ids TEXT,
        orchestration TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        author_agent_id TEXT,
        created_at TEXT NOT NULL,
        tool_calls TEXT
      );
    `);
    const t = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO sessions (id, title, model, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('legacy-1', '老会话', 'm', 'hermes', t, t);
    seed.close();
  }

  // —— 2. 动态 import db：此时会跑迁移（ensureColumn 补三列）——
  const db = await import('../server/db.js');

  // 2a. 老行读出：三列为 null（不炸、语义正确）
  const legacy = db.getSession('legacy-1');
  ok(!!legacy, '迁移后老会话仍可读出');
  eq(legacy?.cwd ?? null, null, '老会话 cwd 迁移后为 NULL');
  eq(legacy?.scenario_id ?? null, null, '老会话 scenario_id 迁移后为 NULL');
  eq(legacy?.system_prompt ?? null, null, '老会话 system_prompt 迁移后为 NULL');

  const t = new Date().toISOString();

  // —— 3. createSession 写入三列并读回 ——
  db.createSession({
    id: 'new-1',
    title: '场景会话',
    model: 'zai/glm-4.7',
    agent_id: 'opencode',
    sdk_session_id: null,
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: 'E:/proj/demo',
    scenario_id: 'dev',
    system_prompt: '你是资深工程师',
    created_at: t,
    updated_at: t,
  });
  const got = db.getSession('new-1');
  eq(got?.cwd, 'E:/proj/demo', 'createSession 落库 cwd');
  eq(got?.scenario_id, 'dev', 'createSession 落库 scenario_id');
  eq(got?.system_prompt, '你是资深工程师', 'createSession 落库 system_prompt');

  // —— 4. 不传三列 → NULL ——
  db.createSession({
    id: 'new-2',
    title: '无场景',
    model: '',
    agent_id: 'hermes',
    sdk_session_id: null,
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: null,
    scenario_id: null,
    system_prompt: null,
    created_at: t,
    updated_at: t,
  });
  const got2 = db.getSession('new-2');
  eq(
    [got2?.cwd ?? null, got2?.scenario_id ?? null, got2?.system_prompt ?? null],
    [null, null, null],
    '未指定三列 → NULL'
  );

  // —— 5. updateSession 改三列，且互不影响 ——
  db.updateSession('new-1', { cwd: 'E:/proj/other' });
  eq(db.getSession('new-1')?.cwd, 'E:/proj/other', 'updateSession 改 cwd');
  eq(db.getSession('new-1')?.scenario_id, 'dev', '改 cwd 不影响 scenario_id');
  eq(db.getSession('new-1')?.system_prompt, '你是资深工程师', '改 cwd 不影响 system_prompt');

  db.updateSession('new-1', { scenario_id: null });
  eq(db.getSession('new-1')?.scenario_id ?? null, null, 'updateSession 可清空 scenario_id');

  db.updateSession('new-1', { system_prompt: '改写' });
  eq(db.getSession('new-1')?.system_prompt, '改写', 'updateSession 改 system_prompt');

  // —— 6. getAllSessions 带出三列 ——
  const row = db.getAllSessions().find(s => s.id === 'new-1');
  ok(
    !!row && 'cwd' in row && 'scenario_id' in row && 'system_prompt' in row,
    'getAllSessions 返回三列'
  );

  // —— 7. blocks 列：整条块序列的落库与读回（E2） ——
  {
    const blocks = [
      { id: 'b1', type: 'thinking', text: '想一想', state: 'done', format: 'raw', startedAt: 1, endedAt: 2 },
      { id: 'b2', type: 'text', text: '答案', state: 'done' },
      { id: 'b3', type: 'tool', toolId: 't1', name: 'Bash', input: { command: 'ls' }, output: 'ok', status: 'completed', startedAt: 3, endedAt: 4 },
      { id: 'b4', type: 'text', text: '补充', state: 'done' },
    ];

    db.createMessage({
      id: 'msg-blocks',
      session_id: 'new-1',
      role: 'assistant',
      content: '答案补充',
      model: 'm',
      author_agent_id: 'codex',
      created_at: new Date().toISOString(),
      tool_calls: null,
      blocks: JSON.stringify(blocks),
    });

    const got = db.getMessagesBySession('new-1').find(m => m.id === 'msg-blocks');
    ok(!!got, 'blocks：消息已写入');
    const parsed = got?.blocks ? JSON.parse(got.blocks) : null;
    eq(parsed?.map((b: any) => b.type), ['thinking', 'text', 'tool', 'text'], 'blocks：顺序原样读回');
    eq(parsed?.[2]?.output, 'ok', 'blocks：工具结果保留');

    // 老消息（没写 blocks）读出为 NULL —— 读取侧据此退回旧字段
    db.createMessage({
      id: 'msg-legacy',
      session_id: 'new-1',
      role: 'assistant',
      content: '老消息',
      model: 'm',
      author_agent_id: null,
      created_at: new Date().toISOString(),
      tool_calls: null,
    });
    const legacy = db.getMessagesBySession('new-1').find(m => m.id === 'msg-legacy');
    eq(legacy?.blocks ?? null, null, 'blocks：老消息读出 NULL');
  }

  // 收尾：尽力删除临时目录（连接仍打开，Windows 上可能删不掉，忽略即可）
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(
        `\n✗ 会话持久化断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`
      );
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log(`\n会话持久化断言：${checks.total}/${checks.total} 通过`);
    console.log('✓ cwd / scenario_id / system_prompt 的落库、读回、迁移与更新均符合预期');
  })
  .catch(err => {
    console.error('验证脚本异常:', err);
    process.exit(1);
  });
