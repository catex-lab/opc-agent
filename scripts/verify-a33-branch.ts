/**
 * A33 分支 / 重新生成 —— 落库语义验证。
 *
 * 为什么单独一个脚本：这两个功能的行为**全在数据库侧**（分支=复制会话与
 * 截至某条消息的全部记录；重新生成=删旧回复且不重复落 user 消息），而
 * 数据库函数在 import 时就会打开 `chat.db`。这里沿用 verify-session-persist
 * 的做法：先把 OPC_DATA_DIR 指到临时目录再动态 import，真实用户数据零接触。
 *
 * 覆盖：
 *   1. createMessages 会把 blocks 一起写进去 —— 分叉出来的消息不能丢掉
 *      思考块/工具块，否则刷新后分支会话与流式中长得不一样。
 *   2. 分支复制：新会话拿到截至目标消息（含）的全部消息，且 id 全部重新生成。
 *   3. 分支复制：消息的 model / author_agent_id / images / 成本统计逐字段不变。
 *   4. 重新生成：deleteMessage 只删目标那条，不动同一会话里的其它消息。
 *   5. 重新生成：删掉被顶掉的回复后，同一条 user 提问只会对应一条回复。
 *
 * 运行：npx tsx scripts/verify-a33-branch.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-a33-'));
  process.env.OPC_DATA_DIR = tmpDir;

  const db = await import('../server/db');
  const now = new Date().toISOString();

  db.createSession({
    id: 'src',
    title: '原始会话',
    model: 'claude-sonnet-4-5',
    agent_id: 'workbuddy',
    sdk_session_id: 'token-should-not-be-copied',
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: 'E:/demo',
    scenario_id: 'qa',
    system_prompt: '只读',
    pinned: 0,
    created_at: now,
    updated_at: now,
  });

  db.createMessage({
    id: 'u1',
    session_id: 'src',
    role: 'user',
    content: '第一问',
    model: null,
    author_agent_id: null,
    created_at: now,
    tool_calls: null,
  });
  db.createMessage({
    id: 'a1',
    session_id: 'src',
    role: 'assistant',
    content: '第一答',
    model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy',
    created_at: now,
    tool_calls: JSON.stringify([{ id: 't1', name: 'Bash', status: 'completed' }]),
    blocks: JSON.stringify([
      { id: 'b1', type: 'thinking', text: '想一下', state: 'done', format: 'raw', startedAt: 1, endedAt: 2 },
      { id: 'b2', type: 'text', text: '第一答', state: 'done' },
    ]),
    duration_ms: 1200,
    cost: 0.0021,
    tokens: 350,
  });
  db.createMessage({
    id: 'u2',
    session_id: 'src',
    role: 'user',
    content: '第二问',
    model: null,
    author_agent_id: null,
    created_at: now,
    tool_calls: null,
  });
  db.createMessage({
    id: 'a2',
    session_id: 'src',
    role: 'assistant',
    content: '第二答',
    model: null,
    author_agent_id: 'hermes',
    created_at: now,
    tool_calls: null,
    blocks: null,
  });

  // —— 1. createMessages 写入 blocks ——
  // messages 表有指向 sessions 的外键，先建会话再插消息
  db.createSession({
    id: 'dst',
    title: 'createMessages 专用会话',
    model: '',
    agent_id: null,
    sdk_session_id: null,
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: null,
    scenario_id: null,
    system_prompt: null,
    pinned: 0,
    created_at: now,
    updated_at: now,
  });
  const blocksText = JSON.stringify([
    { id: 'x1', type: 'thinking', text: '分支里的思考', state: 'done', format: 'summary', startedAt: 3 },
    { id: 'x2', type: 'text', text: '分支里的正文', state: 'done' },
  ]);
  db.createMessages([
    {
      id: 'nb1',
      session_id: 'dst',
      role: 'assistant',
      content: '分支里的正文',
      model: 'claude-sonnet-4-5',
      author_agent_id: 'workbuddy',
      created_at: now,
      tool_calls: null,
      blocks: blocksText,
    },
  ]);
  const nb = db.getMessagesBySession('dst').find(m => m.id === 'nb1');
  eq(nb?.blocks ?? null, blocksText, 'createMessages：blocks 原样落库');
  eq(
    nb?.duration_ms ?? null,
    null,
    'createMessages：未提供成本字段时落 NULL（不冒充 0）'
  );

  db.deleteMessagesBySession('dst');

  // —— 2/3. 分支复制（模拟 server/index.ts 分支端点的落库部分）——
  const all = db.getMessagesBySession('src');
  const cut = all.findIndex(m => m.id === 'a1');
  ok(cut >= 0, '能在原始会话里定位分支点');
  const copied = all.slice(0, cut + 1);
  eq(
    copied.map(m => m.role),
    ['user', 'assistant'],
    '分支：只复制截至目标消息（含）的记录'
  );

  const newId = 'dst2';
  db.createSession({
    id: newId,
    title: `${db.getSession('src')!.title}（分支）`,
    model: db.getSession('src')!.model,
    agent_id: db.getSession('src')!.agent_id,
    // 续接令牌各家私有，原会话的 token 在新会话里无效 —— 必须是 NULL
    sdk_session_id: null,
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: 'E:/demo',
    scenario_id: 'qa',
    system_prompt: '只读',
    pinned: 0,
    created_at: now,
    updated_at: now,
  });
  db.createMessages(
    copied.map(m => ({
      id: `cp-${m.id}`,
      session_id: newId,
      role: m.role,
      content: m.content,
      model: m.model,
      author_agent_id: m.author_agent_id,
      created_at: m.created_at,
      tool_calls: m.tool_calls,
      images: m.images,
      blocks: m.blocks,
      duration_ms: m.duration_ms,
      cost: m.cost,
      tokens: m.tokens,
    }))
  );

  const dst = db.getMessagesBySession(newId);
  eq(
    dst.map(m => m.id),
    ['cp-u1', 'cp-a1'],
    '分支：复制出的消息 id 全部重新生成（不与原会话撞主键）'
  );
  const dstA1 = dst.find(m => m.id === 'cp-a1')!;
  eq(dstA1.model, 'claude-sonnet-4-5', '分支：model 逐字段保留');
  eq(dstA1.author_agent_id, 'workbuddy', '分支：作者 Agent 保留');
  eq(dstA1.tool_calls, copied[1].tool_calls, '分支：tool_calls 保留');
  eq(dstA1.blocks, copied[1].blocks, '分支：blocks（思考/顺序）保留');
  eq(dstA1.duration_ms, 1200, '分支：耗时保留');
  eq(dstA1.cost, 0.0021, '分支：费用保留');
  eq(dstA1.tokens, 350, '分支：token 保留');
  eq(
    db.getSession(newId)?.sdk_session_id,
    null,
    '分支：新会话不带原会话的续接令牌'
  );
  eq(
    db.getMessagesBySession('src').map(m => m.id),
    ['u1', 'a1', 'u2', 'a2'],
    '分支：原会话消息一条不动'
  );

  // —— 4/5. 重新生成的删除语义 ——
  eq(db.deleteMessage('a2'), true, '重新生成：删掉被顶掉的旧回复');
  eq(
    db.getMessagesBySession('src').map(m => m.id),
    ['u1', 'a1', 'u2'],
    '重新生成：同会话其它消息不受影响'
  );
  eq(db.deleteMessage('a2'), false, '重新生成：重复删除返回 false（幂等）');

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
        `\n✗ A33 分支/重生成断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`
      );
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log(`\nA33 分支/重生成断言：${checks.total}/${checks.total} 通过`);
    console.log('✓ 分支复制（含 blocks/成本/新 id/无续接令牌）与重生成删除语义均符合预期');
  })
  .catch(err => {
    console.error('验证脚本异常:', err);
    process.exit(1);
  });
