/**
 * A98 的真实服务端 e2e（真起进程、走 HTTP）。
 *
 * ## 为什么还要这一层
 *
 * 前两个脚本证明了「键算得对」「记忆不串」。但**路由层自己的接线**两边
 * 都看不见：会话建好之后 project_id 到底有没有落、PATCH 换目录之后项目
 * 跟不跟着走、`/api/memory` 的顶层字段是不是仍然是全局层（老设置页靠它）。
 * A97 就是在这层抓到过「SSE 一启动就被自己取消」的 bug。
 *
 * 运行：npx tsx scripts/verify-a98-e2e.ts
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
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a98e2e-'));
  const A = path.join(TMP, 'ProjA');
  const B = path.join(TMP, 'ProjB');
  const DATA = path.join(TMP, 'data');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nA98 端到端（服务端 :${port}）`);

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

  const get = async (p: string) => (await fetch(`${base}${p}`)).json();
  const send = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* 空响应 */
    }
    return { status: res.status, json };
  };

  try {
    const ready = await waitReady(base, child);
    ok(ready, '服务端启动并就绪', ready ? '' : log.slice(-400));
    if (!ready) return;

    // ── 1. 项目由会话自动产生 ────────────────────────────────────
    console.log('\n[1] 会话 → 项目');
    ok((await get('/api/projects')).projects.length === 0, '初始没有项目');

    const sA1 = (await send('POST', '/api/sessions', { title: 'A1', cwd: A })).json.session;
    const sA2 = (await send('POST', '/api/sessions', { title: 'A2', cwd: A })).json.session;
    const sB = (await send('POST', '/api/sessions', { title: 'B1', cwd: B })).json.session;
    const sNone = (await send('POST', '/api/sessions', { title: 'no-cwd' })).json.session;

    ok(!!sA1.project_id, '建会话时自动关联项目', sA1.project_id?.slice(0, 8));
    ok(sA1.project_id === sA2.project_id, '同一目录的两个会话共用一个项目');
    ok(sA1.project_id !== sB.project_id, '不同目录是两个项目');
    ok(sNone.project_id === null, '没绑目录的会话 project_id 为 null');

    const projList = (await get('/api/projects')).projects;
    ok(projList.length === 2, '项目列表有 2 个', String(projList.length));
    ok(projList.some(p => p.sessionCount === 2), '按项目统计会话数（A 有 2 个）');
    ok(projList.some(p => p.name === 'ProjA'), '项目名保留原始大小写', projList.map(p => p.name).join(','));

    const detail = await get(`/api/sessions/${sA1.id}`);
    ok(detail.project?.id === sA1.project_id, '会话详情返回所属项目');

    // ── 2. 记忆接口：顶层仍是全局，新增 project 段 ────────────────
    console.log('\n[2] 记忆接口');
    const m0 = await get(`/api/memory?cwd=${encodeURIComponent(A)}`);
    ok(typeof m0.core === 'string' && typeof m0.user === 'string', '顶层 core / user 仍在（老设置页不用改）');
    ok(Array.isArray(m0.skills) && m0.stats, '顶层 skills / stats 仍在');
    ok(m0.project?.key, '带 cwd 时多出 project 段', m0.project?.key);
    ok(m0.project?.stats?.exists === false, '新项目还没有记忆');

    const mNoCwd = await get('/api/memory');
    ok(mNoCwd.project === null, '不带 cwd 时 project 为 null');

    // ── 3. 写项目记忆与隔离 ──────────────────────────────────────
    console.log('\n[3] 项目记忆写入与隔离');
    const w1 = await send('PUT', '/api/memory', { core: '# A 约定\n用 pnpm', scope: 'project', cwd: A });
    ok(w1.status === 200 && w1.json.ok, '写项目记忆成功');
    ok(w1.json.projectStats?.coreTokens > 0, '返回项目层统计', String(w1.json.projectStats?.coreTokens));

    const mA = await get(`/api/memory?cwd=${encodeURIComponent(A)}`);
    const mB = await get(`/api/memory?cwd=${encodeURIComponent(B)}`);
    ok(mA.project.core.includes('pnpm'), 'A 读到自己写的项目记忆');
    ok(mB.project.core === '', 'B 读不到 A 的项目记忆');
    ok(mA.core === mB.core, '两边的全局层完全相同（画像/全局记忆不分区）');

    // 向后兼容：不传 scope 仍写全局
    const wGlobal = await send('PUT', '/api/memory', { core: '# 全局约定\n2 空格', cwd: A });
    ok(wGlobal.json.projectStats === null, '不传 scope 时不写项目层');
    const afterGlobal = await get(`/api/memory?cwd=${encodeURIComponent(A)}`);
    ok(afterGlobal.core.includes('2 空格'), '全局层被更新');
    ok(afterGlobal.project.core.includes('pnpm'), '项目层不受影响（没被全局覆盖）');

    const bad = await send('PUT', '/api/memory', { core: 'x', scope: 'project' });
    ok(bad.status === 400, 'scope=project 但缺 cwd → 400', String(bad.status));

    // ── 4. 检索隔离 ──────────────────────────────────────────────
    console.log('\n[4] 检索隔离');
    const hitA = (await send('POST', '/api/memory/search', { query: 'pnpm', cwd: A })).json.hits;
    const hitB = (await send('POST', '/api/memory/search', { query: 'pnpm', cwd: B })).json.hits;
    const hitNone = (await send('POST', '/api/memory/search', { query: 'pnpm' })).json.hits;
    ok(hitA.length > 0, 'A 搜到自己项目的内容', String(hitA.length));
    ok(hitB.length === 0, 'B 搜不到 A 的内容', String(hitB.length));
    ok(hitNone.length === 0, '不带 cwd 搜不到任何项目内容', String(hitNone.length));
    ok(hitA.every((h: any) => h.scope !== ''), '命中项带作用域标记', hitA[0]?.scope);

    // ── 5. 换目录 = 换项目 ──────────────────────────────────────
    console.log('\n[5] 换目录');
    const patch = await send('PATCH', `/api/sessions/${sA2.id}`, { cwd: B });
    ok(patch.status === 200, 'PATCH cwd 成功');
    const moved = await get(`/api/sessions/${sA2.id}`);
    ok(moved.session.project_id === sB.project_id, '项目跟着目录换过去了');
    ok(moved.project?.name === 'ProjB', '详情里返回新项目', moved.project?.name);

    const cleared = await send('PATCH', `/api/sessions/${sA2.id}`, { cwd: '' });
    ok(cleared.status === 200, '清空 cwd 成功');
    ok((await get(`/api/sessions/${sA2.id}`)).session.project_id === null, '清空目录后解绑项目');
    ok((await get(`/api/sessions/${sA2.id}`)).project === null, '解绑后详情 project 为 null');

    // ── 6. 项目改名与删除 ──────────────────────────────────────
    console.log('\n[6] 项目改名与删除');
    const renamed = await send('PATCH', `/api/projects/${sB.project_id}`, { name: '乙项目' });
    ok(renamed.status === 200 && renamed.json.project.name === '乙项目', '改名成功', renamed.json?.project?.name);
    ok((await send('PATCH', `/api/projects/${sB.project_id}`, { name: '  ' })).status === 400, '空名字被拒绝');

    const del = await send('DELETE', `/api/projects/${sB.project_id}`);
    ok(del.status === 200, '删除项目成功');
    ok(!(await get('/api/projects')).projects.some((p: any) => p.id === sB.project_id), '列表里不再有它');
    // A131：解绑落的是**空串**不是 null —— null 会被启动回填当成「从没算过」，
    // 照着还留着的 cwd 把项目重新建回来（就是用户报的「删了又出现」）。
    ok((await get(`/api/sessions/${sB.id}`)).session.project_id === '',
      '会话标成空串（= 主动摘掉，回填不再动它）',
      JSON.stringify((await get(`/api/sessions/${sB.id}`)).session.project_id));
    ok((await get(`/api/sessions/${sB.id}`)).project === null, '解绑后详情不再指向已删项目');

    // ── 7. 非法路径 ────────────────────────────────────────────
    console.log('\n[7] 非法输入');
    const ghost = await send('POST', '/api/projects', { cwd: path.join(TMP, 'definitely-not-here') });
    ok(ghost.status === 400, '不存在的目录不建项目', String(ghost.status));
    ok((await send('POST', '/api/projects', {})).status === 400, '缺 cwd → 400');
    ok((await send('POST', '/api/sessions', { cwd: path.join(TMP, 'nope') })).status === 400, '会话也不能绑不存在的目录');
  } finally {
    cleanup();
  }

  console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('脚本自身异常：', err);
  process.exit(1);
});
