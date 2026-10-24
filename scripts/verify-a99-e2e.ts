/**
 * A99 文件核对的真实服务端 e2e。
 *
 * ## 为什么单测不够
 *
 * `verify-a99-evidence.ts` 只测了判定函数。但这条链路上还有三处只有真服务端
 * 才能暴露的东西：
 *
 *   1. **路由的参数校验**（缺 messageId → 400、消息不存在 → 404、
 *      消息不属于该会话 → 403）—— 最后一条尤其重要：不校验归属的话，
 *      任意 messageId 都能被枚举出本机文件路径。
 *   2. **blocks 的解析路径**：`blocks` 列存的是 JSON 字符串，它可能为空、
 *      可能是半截、也可能是老格式的 tool_calls 列。判定函数拿到的是块数组，
 *      拿不到说明解析错了。
 *   3. **cwd 的来源**：相对路径靠 `sessions.cwd` 解析，而 cwd 允许为 NULL。
 *      「没绑目录」必须变成 skipped 而不是静默给个空列表。
 *
 * ## 数据怎么来
 *
 * 没有可用的 Agent 就无法通过 /api/chat 造出真实回答，所以这里**直接往库里
 * 种一条消息**。这是有意的：本脚本验的是「读」的那一端（路由 + 判定），
 * 不是「写」的那一端。种子数据写进独立的 OPC_DATA_DIR，真实库全程不碰。
 *
 * 运行：npx tsx scripts/verify-a99-e2e.ts
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
/** 夹具放项目内 `.tmp/`：放系统临时目录的话，「文件不存在」会被判成 ephemeral */
const TMP = path.join(ROOT, '.tmp', 'a99-e2e');
const DATA = path.join(TMP, 'data');
const PROJ = path.join(TMP, 'proj');

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

/** 造一个工具块（字段与 shared/blocks.ts 的 ToolBlock 一致） */
function toolBlock(id: string, name: string, input: Record<string, unknown>) {
  return {
    id,
    type: 'tool' as const,
    toolId: `tid-${id}`,
    name,
    input,
    status: 'completed' as const,
    startedAt: 1,
    endedAt: 2,
  };
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });

  // 夹具文件：一个已落地的、一个不存在的
  const landedFile = path.join(PROJ, 'landed.ts');
  fs.writeFileSync(landedFile, 'export const A = 1;\nexport const B = 2;\n', 'utf8');
  const ambiguousFile = path.join(PROJ, 'both.ts');
  fs.writeFileSync(ambiguousFile, 'const k = 1;\nconst k = 2;\n', 'utf8');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nA99 端到端（服务端 :${port}）`);

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

  try {
    const ready = await waitReady(base, child);
    ok(ready, '服务端启动并就绪', ready ? '' : log.slice(-400));
    if (!ready) return;

    // ── 1. 建会话（一个绑了 cwd，一个没绑）────────────────────────
    console.log('\n[1] 建会话');
    const withCwd = await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'a99-with-cwd', cwd: PROJ }),
      })
    ).json();
    const sid1: string = withCwd.session?.id;
    ok(!!sid1, '绑定了工作目录的会话创建成功', sid1);

    const noCwd = await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'a99-no-cwd' }),
      })
    ).json();
    const sid2: string = noCwd.session?.id;
    ok(!!sid2, '未绑定工作目录的会话创建成功', sid2);

    // ── 2. 直接种消息（服务端建表已完成）──────────────────────────
    console.log('\n[2] 种消息');
    const dbPath = path.join(DATA, 'chat.db');
    const raw = new DatabaseSync(dbPath);
    const insert = raw.prepare(
      `INSERT INTO messages (id, session_id, role, content, model, author_agent_id, created_at, blocks)
       VALUES (?, ?, 'assistant', ?, NULL, 'test-agent', ?, ?)`
    );
    const now = new Date().toISOString();

    const blocksMixed = [
      toolBlock('b1', 'write', { file_path: landedFile, content: 'export const A = 1;\nexport const B = 2;\n' }),
      toolBlock('b2', 'write', { file_path: path.join(PROJ, 'never-written.ts'), content: 'x\ny\n' }),
      toolBlock('b3', 'edit', { file_path: ambiguousFile, old_string: 'const k = 1;', new_string: 'const k = 2;' }),
      toolBlock('b4', 'read', { file_path: landedFile }),
      toolBlock('b5', 'bash', { command: 'echo hi' }),
    ];
    insert.run('m-mixed', sid1, '改了三个文件', now, JSON.stringify(blocksMixed));

    // 相对路径 + 有 cwd → 能解析
    insert.run(
      'm-relative',
      sid1,
      '相对路径',
      now,
      JSON.stringify([toolBlock('r1', 'write', { file_path: 'landed.ts', content: 'export const A = 1;\nexport const B = 2;\n' })])
    );

    // 相对路径 + 无 cwd → skipped
    insert.run(
      'm-no-cwd',
      sid2,
      '无目录',
      now,
      JSON.stringify([toolBlock('n1', 'edit', { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' })])
    );
    raw.close();

    // ── 3. 核对：混合块 ──────────────────────────────────────────
    console.log('\n[3] GET /api/files/evidence');
    const res1 = await fetch(`${base}/api/files/evidence?sessionId=${sid1}&messageId=m-mixed`);
    ok(res1.status === 200, '正常请求返回 200', String(res1.status));
    const body1 = (await res1.json()) as {
      cwd: string | null;
      items: Array<{ blockId: string; verdict: string; display: string; reason?: string }>;
      summary: { total: number; landed: number; notLanded: number; alarm: string | null };
    };
    ok(body1.cwd === PROJ, '返回会话的 cwd（前端要显示相对哪个目录）', String(body1.cwd));
    ok(body1.items.length === 3, 'read / bash 不进核对列表（5 块只核 3 个）', String(body1.items.length));

    const byId = new Map(body1.items.map(i => [i.blockId, i]));
    ok(byId.get('b1')?.verdict === 'landed', '已落地的 write → landed', byId.get('b1')?.verdict);
    ok(byId.get('b2')?.verdict === 'missing', '不存在的文件 → missing', byId.get('b2')?.verdict);
    ok(byId.get('b3')?.verdict === 'ambiguous', 'old/new 都在 → ambiguous', byId.get('b3')?.verdict);
    ok(byId.get('b1')?.display === 'landed.ts', '展示路径是相对 cwd 的', byId.get('b1')?.display);

    ok(body1.summary.landed === 1 && body1.summary.notLanded === 1, '汇总计数正确', JSON.stringify(body1.summary));
    ok(!!body1.summary.alarm, '有对不上的文件时给告警', body1.summary.alarm ?? 'null');

    // ── 4. 相对路径解析 ──────────────────────────────────────────
    console.log('\n[4] 相对路径');
    const res2 = await (await fetch(`${base}/api/files/evidence?messageId=m-relative`)).json();
    ok(res2.items?.[0]?.verdict === 'landed', '有 cwd 时相对路径能解析并核对', res2.items?.[0]?.verdict);

    const res3 = await (await fetch(`${base}/api/files/evidence?messageId=m-no-cwd`)).json();
    ok(res3.items?.[0]?.verdict === 'skipped', '无 cwd 时相对路径 → skipped', res3.items?.[0]?.verdict);
    ok(!!res3.items?.[0]?.reason, 'skipped 带原因（用户要知道为什么没核对）', res3.items?.[0]?.reason);
    ok(res3.cwd === null, 'cwd 为 null 如实返回', String(res3.cwd));

    // ── 5. 参数与归属校验 ────────────────────────────────────────
    console.log('\n[5] 校验');
    ok((await fetch(`${base}/api/files/evidence`)).status === 400, '缺 messageId → 400');
    ok((await fetch(`${base}/api/files/evidence?messageId=not-exist`)).status === 404, '消息不存在 → 404');

    // ★ 归属校验：拿 sid2 去查 sid1 的消息，必须拒 ——
    //   否则任意 messageId 都能被枚举出本机文件路径
    const forbidden = await fetch(`${base}/api/files/evidence?sessionId=${sid2}&messageId=m-mixed`);
    ok(forbidden.status === 403, '消息不属于该会话 → 403（防路径枚举）', String(forbidden.status));
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
