/**
 * A100「上一轮没有产出回复」的真实服务端 e2e。
 *
 * ## 为什么必须真起服务端
 *
 * 这个判定跨了两处状态：**库里的消息顺序**（持久化）和 **runHub 的活跃 run**
 * （内存）。夹具层把 /api/** 全拦了，等于把这两处都替换成我写的假数据，
 * 测出来的只是「我假装的 dangling」。所以这里真起一个服务端、真往库里写消息。
 *
 * ## 覆盖什么 / 不覆盖什么
 *
 * 覆盖：空会话、有 user 无回答、回答已到、清空历史后。
 * **不覆盖**「有活跃 run 时不报」—— 那需要真跑一个 Agent（要凭据、要网络），
 * 不适合放进验证脚本。这一条的正确性靠的是 `runHub.activeRuns()` 的既有语义，
 * 已在 verify-run-hub 里覆盖。这是本脚本的已知盲区，写在这里而不是装作没有。
 *
 * 运行：npx tsx scripts/verify-a100-e2e.ts
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', 'a100-e2e');
const DATA = path.join(TMP, 'data');

let total = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(base: string, child: ChildProcess, timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) return false;
    try {
      const res = await fetch(`${base}/api/sessions`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function killTree(child: ChildProcess) {
  if (child.exitCode != null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nA100 端到端（服务端 :${port}）`);

  const child = spawn('npx tsx server/index.ts', {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', d => {
    log += String(d);
  });
  child.stderr?.on('data', d => {
    log += String(d);
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    killTree(child);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  const detail = async (sid: string) =>
    (await (await fetch(`${base}/api/sessions/${sid}`)).json()) as {
      messages: Array<{ id: string; role: string }>;
      dangling: { messageId: string; at: string } | null;
    };

  try {
    const ready = await waitReady(base, child);
    ok(ready, '服务端启动并就绪', ready ? '' : log.slice(-400));
    if (!ready) return;

    const created = await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'a100', agentId: 'workbuddy' }),
      })
    ).json();
    const sid: string = created.session?.id;
    ok(!!sid, '会话创建成功', sid);

    // ── 1. 空会话 ────────────────────────────────────────────────
    console.log('\n[1] 空会话');
    const empty = await detail(sid);
    ok(empty.messages.length === 0, '没有消息', String(empty.messages.length));
    ok(empty.dangling === null, '空会话不算「没有产出回复」', JSON.stringify(empty.dangling));

    // ── 2. 只有 user 消息（模拟应用被关闭）──────────────────────
    console.log('\n[2] 有提问、没有回答');
    const dbPath = path.join(DATA, 'chat.db');
    const raw = new DatabaseSync(dbPath);
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, model, author_agent_id, created_at)
         VALUES (?, ?, 'user', ?, NULL, NULL, ?)`
      )
      .run('u1', sid, '帮我改个文件', now);

    const dangling = await detail(sid);
    ok(dangling.dangling !== null, '识别出「上一轮没有产出回复」', JSON.stringify(dangling.dangling));
    ok(dangling.dangling?.messageId === 'u1', '指向那条没有回答的消息', dangling.dangling?.messageId);
    ok(dangling.dangling?.at === now, '带时间（前端要显示「几点的消息」）', dangling.dangling?.at);

    // ── 3. 回答到了 ──────────────────────────────────────────────
    console.log('\n[3] 回答已落库');
    raw
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, model, author_agent_id, created_at)
         VALUES (?, ?, 'assistant', ?, 'm', 'workbuddy', ?)`
      )
      .run('a1', sid, '改好了', new Date(Date.now() + 1000).toISOString());

    const answered = await detail(sid);
    ok(answered.dangling === null, '最后一条是回答 → 不报', JSON.stringify(answered.dangling));
    ok(answered.messages.length === 2, '两条消息都在', String(answered.messages.length));

    // ── 4. 又发了一条、还是没回答 ────────────────────────────────
    console.log('\n[4] 再发一条又没回答');
    raw
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, model, author_agent_id, created_at)
         VALUES (?, ?, 'user', ?, NULL, NULL, ?)`
      )
      .run('u2', sid, '再改一处', new Date(Date.now() + 2000).toISOString());

    const again = await detail(sid);
    ok(again.dangling?.messageId === 'u2', '指向最新那条（不是旧的 u1）', again.dangling?.messageId);

    // ── 5. 清空历史 ──────────────────────────────────────────────
    console.log('\n[5] 清空历史');
    raw.prepare('DELETE FROM messages WHERE session_id = ?').run(sid);
    raw.close();

    const cleared = await detail(sid);
    ok(cleared.messages.length === 0, '消息清空了', String(cleared.messages.length));
    ok(cleared.dangling === null, '清空后不再报', JSON.stringify(cleared.dangling));
  } finally {
    cleanup();
  }
}

main()
  .catch(err => {
    console.error('\n脚本异常：', err);
    failures.push('脚本异常');
  })
  .finally(() => {
    console.log(`\n${total - failures.length}/${total} 通过`);
    if (failures.length) {
      console.log(`失败 ${failures.length} 条：`);
      for (const f of failures) console.log(`  · ${f}`);
      process.exitCode = 1;
    }
  });
