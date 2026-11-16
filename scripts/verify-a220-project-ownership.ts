/**
 * A220 闸门：项目入口新建会话的首条消息，落库时必须属于那个项目。
 *
 * ## 背景
 *
 * 左侧栏项目 → 新建会话，`App.tsx` 只建一个 `isLocal: true` 的前端空壳
 * （带 `projectId` / `cwd`）。首条消息走 `POST /api/chat` 才真正写库。
 * 这个分支以前**忘了写 `project_id`**，而项目视图按
 * `s.projectId === selectedProject.id` 过滤，于是刚发的那条会话要等下次
 * 启动 `backfillSessionProjects()` 才回到项目里。真机库里
 * `ea016388…` 的 `project_id` 就是 NULL。
 *
 * ## 三层可观测量
 *
 *   [1] 生产函数 + 真实临时 SQLite：直接调 `/api/chat` 实际用的
 *       `projectIdForCwd()`，验同源、去重、空 cwd / 假路径保持 NULL；
 *   [2] 真服务端 e2e：独立 `OPC_DATA_DIR` + 随机端口 + 快速退出的桩 CLI，
 *       真的 `POST /api/chat` 一次（用一个**库里不存在**的 sessionId 模拟
 *       本地空壳），再从 `chat.db` 读回 `project_id`。夹具层看不见路由层 bug，
 *       这一层必须真起服务；
 *   [3] 源码契约：三条写入路径（POST /api/sessions、PATCH、/api/chat）
 *       是否收敛到同一把尺子；
 *   [4] 反向探针：把 `/api/chat` 的归属赋值删掉，契约必须判红。
 *
 * 运行：
 *   npx tsx scripts/verify-a220-project-ownership.ts
 *   npx tsx scripts/verify-a220-project-ownership.ts --probe=no-chat-ownership
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a220-'));
const UNIT_DATA = path.join(TMP, 'unit-data');
const E2E_DATA = path.join(TMP, 'e2e-data');
fs.mkdirSync(UNIT_DATA, { recursive: true });
fs.mkdirSync(E2E_DATA, { recursive: true });
// db.ts 在**模块加载时**就按 OPC_DATA_DIR 开库，必须先设再动态 import
process.env.OPC_DATA_DIR = UNIT_DATA;

const ARGS = process.argv.slice(2);
const PROBE = ARGS.find(a => a.startsWith('--probe='))?.slice(8) ?? null;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  [${detail}]` : ''}`);
  }
}
function eq<T>(actual: T, expected: T, name: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}
function group(t: string) { console.log(`\n── ${t} ──`); }

function stripComments(s: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of s.replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; out.push(''); continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; out.push(''); continue; }
    if (t.startsWith('//') || t.startsWith('*')) { out.push(''); continue; }
    const cut = raw.indexOf('//');
    out.push(cut >= 0 ? raw.slice(0, cut) : raw);
  }
  return out.join('\n');
}
const code = (rel: string) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const hasLine = (src: string, re: RegExp) => src.split('\n').some(l => re.test(l));

// ═══════════════════════ [1] 生产函数 + 真实 SQLite ═══════════════════════
group('1. projectIdForCwd（真实临时 SQLite）');
const { projectIdForCwd } = await import('../server/project-ownership.js');
const db = await import('../server/db.js');
{
  const dirA = fs.mkdtempSync(path.join(TMP, 'projA-'));
  const dirB = fs.mkdtempSync(path.join(TMP, 'projB-'));

  const a1 = projectIdForCwd(dirA);
  const a2 = projectIdForCwd(dirA);
  ok(typeof a1 === 'string' && a1.length > 0, '★ 真目录能推导出项目 id', String(a1));
  eq(a2, a1, '★ 同一目录重复调用返回同一个项目（path 唯一约束）');
  eq(db.getProjectByPath(dirA)?.id, a1, '与 getProjectByPath 同一把尺子');
  const b1 = projectIdForCwd(dirB);
  ok(b1 && b1 !== a1, '不同目录 → 不同项目');

  // 归一化：同一目录换一种写法（尾部分隔符）不能凭空多出一个项目
  const withSlash = dirA + path.sep;
  eq(projectIdForCwd(withSlash), a1, '★ 路径归一化：尾部分隔符不算新项目');

  const before = db.listProjects().length;
  eq(projectIdForCwd(''), null, '★ cwd 空串 → NULL（纯问答不属于任何项目）');
  eq(projectIdForCwd(null), null, 'cwd null → NULL');
  eq(projectIdForCwd(undefined), null, 'cwd undefined → NULL');
  eq(projectIdForCwd(42), null, 'cwd 非字符串 → NULL');
  eq(db.listProjects().length, before, '否定式配对：上面四种空值都没有新建项目');
  // 存在性由**路由层**统一挡，不在这个推导函数里：`getOrCreateProject` 只做
  // 路径归一化 + upsert。把两种职责混在一起，反而会让 PATCH 与回填对同一个
  // 已删除目录给出不同答案。下面这条把「数据层是宽进的」这个事实钉住，
  // 再由源码契约断言三处路由都有 not-found 前置校验。
  const fake = projectIdForCwd(path.join(TMP, 'does-not-exist-xyz'));
  ok(typeof fake === 'string' && fake.length > 0,
    '数据层不查存在性（宽进）：假路径也能拿到 id，由路由层挡在前面');
  eq(db.listProjects().length, before + 1, '肯定式：假路径确实建了一行（不是恒 null 假绿）');

  // 会话真的带上这个 id 后，回填不该再动它
  const sid = 'a220-unit-session';
  db.createSession({
    id: sid, title: 'A220', model: '', agent_id: 'workbuddy', sdk_session_id: null,
    kind: 'direct', agent_ids: null, orchestration: null, cwd: dirA,
    reasoning_effort: null, scenario_id: null, system_prompt: null,
    permission_mode: null, pinned: 0, project_id: a1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as never);
  eq(db.getSession(sid)?.project_id, a1, '★ 首条消息落库后 project_id 指向该项目');
  eq(db.backfillSessionProjects(), 0, '★ 无需等启动回填：已归属的会话不会被重复处理');
}

// ═══════════════════════ [2] 真服务端 e2e ═══════════════════════
group('2. 真服务端 e2e：POST /api/chat 的首条消息');
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
  });
}
function killTree(child: ChildProcess): void {
  if (child.exitCode != null || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else child.kill('SIGTERM');
}
/** 快速退出的桩 CLI：这一层不需要真回复，只需要让 /api/chat 走完落库。 */
const stub = path.join(TMP, 'stub-cli.cjs');
fs.writeFileSync(stub, 'process.stdin.resume(); setTimeout(() => process.exit(0), 150);\n');

let child: ChildProcess | null = null;
async function e2e(): Promise<void> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const node = process.execPath;
  child = spawn(node, [
    '--require', path.join(ROOT, 'node_modules/tsx/dist/preflight.cjs'),
    '--import', 'file:///' + path.join(ROOT, 'node_modules/tsx/dist/loader.mjs').replace(/\\/g, '/'),
    path.join(ROOT, 'server/index.ts'),
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      OPC_DATA_DIR: E2E_DATA,
      OPC_CODEBUDDY_CLI: stub,
      // one-shot 路径 + 短护栏：桩退得很快，别让任何等待拖住这条 e2e
      OPC_SDK_SESSION_POOL: '0',
      OPC_SDK_FIRST_TOKEN_TIMEOUT_MS: '15000',
      NODE_ENV: 'test',
      NODE_OPTIONS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errLog = '';
  child.stderr?.on('data', d => { errLog += String(d); });
  child.stdout?.on('data', () => { /* 只保留 stderr 供失败诊断 */ });

  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      if ((await fetch(`${base}/api/sessions`)).ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  ok(ready, '★ 服务端真的起来了（HTTP 探活，不认日志文案）',
    ready ? `:${port}` : errLog.slice(-220));
  if (!ready) return;

  const projDir = fs.mkdtempSync(path.join(TMP, 'proj-e2e-'));
  const localShellId = 'a220-local-shell-' + Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: localShellId,   // 库里不存在 = 项目入口的本地空壳
      message: 'A220 首条消息',
      cwd: projDir,              // 项目目录
      agentId: 'workbuddy',
    }),
  });
  ok(res.ok, '★ POST /api/chat 应答 200', String(res.status));
  // 读完整个 SSE：桩会很快退出，/api/chat 会正常收尾；这一步确保落库已完成
  const body = await res.text();
  ok(body.includes('run_start'), '★ SSE 真的发了 run_start（不是 404/早退）');

  const conn = new DatabaseSync(path.join(E2E_DATA, 'chat.db'), { readOnly: true });
  const row = conn.prepare('SELECT project_id, cwd FROM sessions WHERE id = ?').get(localShellId) as
    | { project_id: string | null; cwd: string | null } | undefined;
  const project = conn.prepare('SELECT id, path FROM projects').all() as Array<{ id: string; path: string }>;
  conn.close();

  ok(!!row, '★ 本地空壳会话真的由 /api/chat 落库了', JSON.stringify(row));
  ok(typeof row?.project_id === 'string' && row.project_id.length > 0,
    '★★ 首条消息落库时 project_id 不是 NULL（A220 的真机红灯）',
    `project_id=${String(row?.project_id)}`);
  const { normalizeProjectPath } = await import('../server/project-key.js');
  const match = project.find(p => p.id === row?.project_id);
  ok(!!match && match.path === normalizeProjectPath(projDir),
    '★ project_id 指向的正是请求里的 cwd 项目', JSON.stringify(match));

  // 对照组：不带 cwd 的纯问答会话，必须保持 NULL
  const qaId = 'a220-qa-' + Date.now();
  const res2 = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: qaId, message: 'A220 纯问答', agentId: 'workbuddy' }),
  });
  await res2.text();
  const conn2 = new DatabaseSync(path.join(E2E_DATA, 'chat.db'), { readOnly: true });
  const qa = conn2.prepare('SELECT project_id FROM sessions WHERE id = ?').get(qaId) as
    | { project_id: string | null } | undefined;
  conn2.close();
  ok(!!qa && qa.project_id === null,
    '★ 对照：不带 cwd 的纯问答仍为 NULL（没有硬塞一个假项目）',
    JSON.stringify(qa));
  // 否定式配肯定式：如果「所有会话都没归属」也会让上一条绿，下面这条必须也绿
  ok(typeof row?.project_id === 'string' && row.project_id !== null,
    '肯定式：两条会话不是「都没归属」');
}

try {
  await e2e();
} catch (err) {
  ok(false, '★ 真服务端 e2e 未抛异常', err instanceof Error ? err.message : String(err));
} finally {
  if (child) killTree(child);
}

// ═══════════════════════ [3] 源码契约 ═══════════════════════
group('3. 源码契约：三条写入路径收敛到同一把尺子');
function srcContract(chat: string, sessions: string, helper: string) {
  // F0-02②：PATCH/POST /api/sessions 已迁 server/routes/sessions.ts——三条写入
  // 路径的契约跨两个文件：/api/chat 在 index.ts，另两条在 routes/sessions.ts。
  return {
    helperImportsDb: hasLine(helper, /import \{ getOrCreateProject \} from '\.\/db\.js';/),
    helperGetOrCreate: hasLine(helper, /getOrCreateProject\(cwd\)/),
    helperGuardsEmpty: hasLine(helper, /typeof cwd === 'string' && cwd \?/),
    chatCall: hasLine(chat, /project_id: projectIdForCwd\(cwd\),/),
    chatImport: hasLine(chat, /import \{ projectIdForCwd \} from "\.\/project-ownership\.js";/),
    patchCall: (sessions.match(/updates\.project_id = projectIdForCwd\(cwd\);/g) ?? []).length === 1,
    sessionsCall: hasLine(sessions, /getOrCreateProject\(cwd\) : undefined/),
    routeGuards:
      (chat.match(/validateDirectory\(cwd\) === 'not-found'/g) ?? []).length +
        (sessions.match(/validateDirectory\(cwd\) === 'not-found'/g) ?? []).length >=
      3,
    backfillSameSource: hasLine(code('server/db.ts'), /const project = getOrCreateProject\(row\.cwd\);/),
  };
}
type Contract = ReturnType<typeof srcContract>;
const CHAT = code('server/index.ts');
const SESSIONS = code('server/routes/sessions.ts');
const HELPER = code('server/project-ownership.ts');
const good = srcContract(CHAT, SESSIONS, HELPER);
{
  const labels: Record<keyof Contract, string> = {
    helperImportsDb: '唯一入口复用 db.getOrCreateProject',
    helperGetOrCreate: '入口真的按 cwd 推导项目',
    helperGuardsEmpty: '入口自带「空 cwd 保持 NULL」判据',
    chatCall: '★ /api/chat 首条消息落库时带 project_id',
    chatImport: '/api/chat 引入的是同一个入口（不是本地另写）',
    patchCall: 'PATCH 换目录时走同一个入口',
    sessionsCall: 'POST /api/sessions 用同一个 getOrCreateProject',
    routeGuards: '★ 三条路由都在推导前做「目录不存在 → 400」校验',
    backfillSameSource: '★ 与启动回填共用同一个归一化/去重函数',
  };
  for (const k of Object.keys(good) as Array<keyof Contract>) ok(good[k], labels[k]);
  ok(Object.values(good).every(Boolean) && !srcContract('', '', '').chatCall,
    '肯定式：空源码下判据会红（不是恒绿摆设）');
}

// ═══════════════════════ [4] 反向探针 ═══════════════════════
group('4. 反向探针');
if (PROBE === 'no-chat-ownership') {
  // 退回 A220 之前的坏版本：/api/chat 建会话时干脆不写 project_id
  const bad = srcContract(
    CHAT.replace(/project_id: projectIdForCwd\(cwd\),/g, 'project_id: null,'),
    SESSIONS,
    HELPER
  );
  ok(!bad.chatCall, '反向探针(no-chat-ownership)：「首条消息带 project_id」判据真的变红');
  const others = (Object.keys(good) as Array<keyof Contract>).filter(k => k !== 'chatCall');
  ok(others.every(k => bad[k] === good[k]), '反向探针：其余判据仍为原值');
  ok(Object.values(bad).some(v => !v), '反向探针：坏版本整体不是全绿');
} else if (PROBE) {
  ok(false, `未知探针 ${PROBE}`, PROBE);
} else {
  console.log('  （未启用探针；可用 --probe=no-chat-ownership）');
}

// ═══════════════════════ 汇总 ═══════════════════════
console.log(
  `\n${failures.length ? '✗' : '✓'} A220 项目会话归属：${pass}/${pass + fail} 通过` +
    `${PROBE ? `（探针 ${PROBE}）` : ''}`
);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 文件锁，忽略 */ }
if (failures.length) process.exit(1);
