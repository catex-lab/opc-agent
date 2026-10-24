/**
 * A97 验证闭环的真实服务端 e2e。
 *
 * ## 为什么非要有这一层
 *
 * 前两个脚本都是「夹具」：浏览器那层把 `/api/**` 全拦了，纯函数那层不碰 HTTP。
 * 于是**路由层自己的 bug 两边都看不见**。写这个脚本的当天就抓到两个：
 *
 *   1. `req.on('close')` 在 `express.json()` 读完 body 后就触发（流的
 *      autoDestroy），把 abort 打开 —— 每一次验证都在 0.8 秒内被自己取消，
 *      表现是 `status=error / hint=用户已取消`，夹具永远复现不出来。
 *   2. 落库抛错（session 行不存在 → FOREIGN KEY）直接打断整条 SSE，
 *      用户白等一次构建还看不到结论。
 *
 * 所以这里**真起一个服务端进程**（独立 OPC_DATA_DIR，不碰真实库），
 * 走完整链路：探测 → 执行 → 落库 → 查询 → 重跑替换。
 *
 * 运行：npx tsx scripts/verify-a97-e2e.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = process.cwd();

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

/** 让系统给一个空闲端口：先占 0 拿号，再立刻释放给服务端用 */
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

/** 读一整条 SSE，返回解析后的事件数组 */
async function readSse(res: Response): Promise<Array<Record<string, any>>> {
  const text = await res.text();
  const events: Array<Record<string, any>> = [];
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* 半截报文，跳过 */
    }
  }
  return events;
}

function killTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

async function main() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a97e2e-'));
  const PROJ = path.join(TMP, 'proj');
  const DATA = path.join(TMP, 'data');
  fs.mkdirSync(PROJ, { recursive: true });
  // 一条必过、一条必失败 —— 两种结论都要能如实上报
  fs.writeFileSync(
    path.join(PROJ, 'package.json'),
    JSON.stringify(
      {
        name: 'e2e-proj',
        scripts: {
          test: "node -e \"console.log('e2e-test-ok')\"",
          lint: "node -e \"console.error('e2e-lint-bad'); process.exit(1)\"",
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nA97 端到端（服务端 :${port}）`);

  const child = spawn('npx tsx server/index.ts', {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', d => { log += String(d); });
  child.stderr?.on('data', d => { log += String(d); });

  let cleanupDone = false;
  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
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

    // ── 1. 探测 ──────────────────────────────────────────────────
    console.log('\n[1] 探测');
    const det = await (await fetch(`${base}/api/verify/commands?cwd=${encodeURIComponent(PROJ)}`)).json();
    const cmds: Array<{ id: string; kind: string; command: string }> = det.commands ?? [];
    ok(cmds.length === 2, '探测到 2 条命令', String(cmds.length));
    ok(cmds.map(c => c.kind).join(',') === 'test,lint', 'kind 顺序 test→lint', cmds.map(c => c.kind).join(','));
    ok(cmds[0]?.command === 'npm run test', '无 lock 文件时用 npm run', cmds[0]?.command);

    const badCwd = await fetch(`${base}/api/verify/commands`);
    ok(badCwd.status === 400, '缺 cwd 参数返回 400', String(badCwd.status));

    // ── 2. 真实会话 ──────────────────────────────────────────────
    console.log('\n[2] 建会话并执行');
    const created = await (await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'e2e', cwd: PROJ }),
    })).json();
    const sid: string = created.session?.id;
    ok(!!sid, '会话创建成功', sid);

    const runOnce = async (sessionId: string, commandIds: string[]) => {
      const res = await fetch(`${base}/api/verify/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, messageId: 'm-e2e', cwd: PROJ, commandIds }),
      });
      return { status: res.status, events: await readSse(res) };
    };

    const run1 = await runOnce(sid, ['node:test:test', 'node:lint:lint']);
    ok(run1.status === 200, 'POST /api/verify/run 返回 200', String(run1.status));
    ok(run1.events.some(e => e.type === 'start'), '先发 start');
    ok(run1.events.some(e => e.type === 'done'), '最后发 done（流正常收尾）');

    const results = run1.events.filter(e => e.type === 'result');
    ok(results.length === 2, '两条命令各有一个 result', String(results.length));

    // ★ 这一条钉的正是 req.on('close') 那个 bug：
    //   挂了 req 的 close，第一条就会变成 error / 用户已取消，且只剩一条 result
    const testRes = results.find(r => r.commandId === 'node:test:test');
    ok(testRes?.result.status === 'pass', '必过的命令真的 pass（没被提前取消）', `${testRes?.result.status} / hint=${testRes?.result.hint ?? '无'}`);
    ok(testRes?.result.exitCode === 0, '退出码 0', String(testRes?.result.exitCode));
    ok((testRes?.result.output ?? '').includes('e2e-test-ok'), '真实 stdout 被采集到');
    ok((testRes?.result.durationMs ?? 0) > 0, '耗时被记录', `${testRes?.result.durationMs}ms`);

    const lintRes = results.find(r => r.commandId === 'node:lint:lint');
    ok(lintRes?.result.status === 'fail', '必失败的命令真的 fail', lintRes?.result.status);
    ok(lintRes?.result.exitCode === 1, '退出码 1 被保留', String(lintRes?.result.exitCode));
    ok((lintRes?.result.output ?? '').includes('e2e-lint-bad'), 'stderr 也被采集到');
    ok(results.every(r => r.persisted === true), '两条都落库成功', results.map(r => r.persisted).join(','));

    // ── 3. 落库与查询 ────────────────────────────────────────────
    console.log('\n[3] 落库与查询');
    const q1 = await (await fetch(`${base}/api/verify/results?sessionId=${encodeURIComponent(sid)}`)).json();
    const rows = q1.verifications ?? [];
    ok(rows.length === 2, '按会话查出 2 行', String(rows.length));
    ok(rows.every((r: any) => r.message_id === 'm-e2e'), 'message_id 归属正确');
    ok(rows.some((r: any) => r.command_id === 'node:test:test' && r.status === 'pass'), '通过的结论已持久化');
    ok(rows.some((r: any) => r.command_id === 'node:lint:lint' && r.status === 'fail' && r.exit_code === 1), '失败的结论与退出码已持久化');

    const noSid = await fetch(`${base}/api/verify/results`);
    ok(noSid.status === 400, '缺 sessionId 返回 400', String(noSid.status));

    // ── 4. 重跑替换而不是累积 ────────────────────────────────────
    console.log('\n[4] 重跑替换');
    await runOnce(sid, ['node:test:test']);
    await runOnce(sid, ['node:test:test']);
    const q2 = await (await fetch(`${base}/api/verify/results?sessionId=${encodeURIComponent(sid)}`)).json();
    ok((q2.verifications ?? []).length === 2, '重跑两次后仍是 2 行（同一命令只留最新）', String((q2.verifications ?? []).length));

    // ── 5. 落库失败不能吃掉结论 ──────────────────────────────────
    console.log('\n[5] 落库失败时的降级');
    const runBad = await runOnce('no-such-session-id', ['node:test:test']);
    const badRes = runBad.events.filter(e => e.type === 'result');
    ok(badRes.length === 1, '结论照常返回', String(badRes.length));
    ok(badRes[0]?.result.status === 'pass', '结论内容不受落库失败影响', badRes[0]?.result.status);
    ok(badRes[0]?.persisted === false, '如实标记未落库');
    ok(runBad.events.some(e => e.type === 'done'), '流仍然正常收尾（不是中途 error）');
    ok(!runBad.events.some(e => e.type === 'error'), '没有把落库错误当成本次验证的错误');

    // ── 6. 只接受探测认可的 commandId ────────────────────────────
    console.log('\n[6] 不接受任意命令');
    const forged = await fetch(`${base}/api/verify/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, cwd: PROJ, commandIds: ['rm -rf /'], command: 'rm -rf /' }),
    });
    ok(forged.status === 400, '伪造 commandId 被拒绝（400）', String(forged.status));
    const forgedBody = await forged.json();
    ok(Array.isArray(forgedBody.available), '拒绝时告知可用的 id', JSON.stringify(forgedBody.available));
  } finally {
    cleanup();
  }

  console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('脚本自身异常：', err);
  process.exit(1);
});
