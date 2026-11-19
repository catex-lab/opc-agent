/**
 * Harness 进程壳闸门（M01 / 绞杀者第 1 期）。
 *
 * 用真实子进程实测 harness 的对外契约（设计 §10.1 方案 A、§7.5）：
 *   · stdout 握手行（带前缀，裸 JSON 会被启动横幅淹没）
 *   · 本机 token 鉴权：无 token 401 / 带 token 200 / health 豁免
 *   · token 不出现在子进程 stdout（不进日志红线）
 *   · runs 台账启动清算：上一代 running → interrupted（不假装完成）
 *   · 父进程死亡（IPC 通道断开）→ harness 自行收口退出，不留孤儿
 *   · token 文件 0600 往返（main 侧写的审计镜像）
 *
 * 老路（OPC_HARNESS=0）的回归由 verify:start-server 覆盖，这里不重复。
 *
 * 运行：npx tsx scripts/verify-harness.ts
 */
import './lib/temp-data-dir.js';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

const root = mkdtempSync(join(tmpdir(), 'opc-harness-'));
const dataDir = join(root, 'd1');
const PORT = 39777;
const TOKEN = 'vt-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

/** 独立 tsx 子进程跑一段脚本（照 verify-start-server 的 runTsx 惯例） */
function runTsx(script: string, env: Record<string, string>, timeoutMs = 20_000): string {
  const file = join(root, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, script);
  try {
    return execFileSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), file], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    return (e.stdout ?? '') + '\n__ERR__' + (e.stderr ?? e.message);
  }
}

const harnessUrl = 'file:///' + process.cwd().split('\\').join('/') + '/harness/index.ts';
const dbUrl = 'file:///' + process.cwd().split('\\').join('/') + '/server/db.ts';
const tokenUrl = 'file:///' + process.cwd().split('\\').join('/') + '/harness/token.ts';
const harnessEnv = {
  OPC_DATA_DIR: dataDir,
  PORT: String(PORT),
  OPC_LOCAL_TOKEN: TOKEN,
};

async function main() {
  // ── [0] 用 esbuild 现打 harness 产物，按**生产形态**拉起 ────────────────
  //
  // 为什么不用 tsx：实测（2026-11-20）tsx CLI 会把脚本包进孙进程，IPC
  // disconnect 与 stdin close 都到不了脚本 —— 父死亡检测在生产产物（纯
  // Node / ELECTRON_RUN_AS_NODE）上才真实。闸门必须测真实契约，所以照
  // build-electron.mjs 的同一套 esbuild 口径现打一份（<1s），再以
  // `process.execPath + ELECTRON_RUN_AS_NODE=1` spawn。
  //
  // 为什么打进 .tmp/ 而不是 gate 的临时目录：`packages: 'external'` 保留
  // 运行时 require，产物必须能沿目录树解析到仓库 node_modules —— 临时目录
  // 里解析不到 express（实测 MODULE_NOT_FOUND）。.tmp 是既有闸门产物区。
  const harnessCjs = join(process.cwd(), '.tmp', 'harness-gate.cjs');
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  await build({
    entryPoints: [join(process.cwd(), 'harness', 'index.ts')],
    outfile: harnessCjs,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    packages: 'external',
    logLevel: 'silent',
  });

  // ── [1] 先在临时库里插一条 running 台账（等 harness 启动清算它）─────────
  const r1 = runTsx(`
    process.env.OPC_DATA_DIR = ${JSON.stringify(dataDir)};
    const db = await import(${JSON.stringify(dbUrl)});
    db.markRunStarted('run-gate-1', 'sess-gate-1', 'fake-agent');
    db.markRunStarted('run-gate-2', 'sess-gate-2', 'fake-agent');
    db.markRunFinished('run-gate-2', 'finished');   // 已收尾的不能被清算
    console.log('SEEDED=ok');
  `, {});
  ok(/SEEDED=ok/.test(r1), '预插 runs 台账（running + finished）', r1.slice(0, 300));

  // ── [2] 拉 harness 子进程，等握手行 ────────────────────────────────────
  const child = spawn(process.execPath, [harnessCjs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...harnessEnv,
      ELECTRON_RUN_AS_NODE: '1',
      OPC_HARNESS_STDIN_PIPE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let handshake: { port: number; pid: number } | null = null;
  child.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
    for (const line of stdout.split('\n')) {
      if (line.startsWith('@@OPC-HARNESS@@ ') && !handshake) {
        try {
          const p = JSON.parse(line.slice('@@OPC-HARNESS@@ '.length));
          if (p.type === 'ready') handshake = { port: p.port, pid: p.pid };
        } catch { /* 半行，忽略 */ }
      }
    }
  });
  const gotHandshake = await new Promise<boolean>(resolve => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (handshake || Date.now() - t0 > 30_000) {
        clearInterval(timer);
        resolve(!!handshake);
      }
    }, 200);
  });
  ok(gotHandshake, 'stdout 握手行（@@OPC-HARNESS@@ ready）', stdout.slice(-500));
  ok(handshake ? handshake.port === PORT : false, `握手端口 = ${PORT}`, String(handshake?.port));

  // ── [3] token 不进日志 ────────────────────────────────────────────────
  // 等 1 秒让启动横幅全部落完再断言
  await new Promise(r => setTimeout(r, 1500));
  ok(!stdout.includes(TOKEN), 'token 不出现在 harness stdout', stdout.includes(TOKEN) ? 'token 泄漏' : undefined);

  // ── [4] health 豁免：无 token 200 ─────────────────────────────────────
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).catch(() => null);
  ok(health?.status === 200, '无 token 探 /api/health → 200（豁免）', String(health?.status));

  // ── [5] 无 token 的 API → 401 ─────────────────────────────────────────
  const naked = await fetch(`http://127.0.0.1:${PORT}/api/runs/active`).catch(() => null);
  ok(naked?.status === 401, '无 token 探 /api/runs/active → 401', String(naked?.status));

  // ── [6] 带 token 的 API → 200，且 SSE 类头不带也不会误放 ──────────────
  const authed = await fetch(`http://127.0.0.1:${PORT}/api/runs/active`, {
    headers: { 'x-opc-token': TOKEN },
  }).catch(() => null);
  ok(authed?.status === 200, '带 token 探 /api/runs/active → 200', String(authed?.status));
  const badToken = await fetch(`http://127.0.0.1:${PORT}/api/runs/active`, {
    headers: { 'x-opc-token': TOKEN + 'x' },
  }).catch(() => null);
  ok(badToken?.status === 401, '错误 token → 401（不误放）', String(badToken?.status));

  // ── [7] runs 台账启动清算：running → interrupted，finished 不动 ────────
  const r7 = runTsx(`
    process.env.OPC_DATA_DIR = ${JSON.stringify(dataDir)};
    const db = await import(${JSON.stringify(dbUrl)});
    const rows = db.listRuns(10);
    const g1 = rows.find(r => r.id === 'run-gate-1');
    const g2 = rows.find(r => r.id === 'run-gate-2');
    console.log('G1=' + (g1?.status ?? 'missing'));
    console.log('G2=' + (g2?.status ?? 'missing'));
    console.log('FIN=' + (g1?.finished_at ? 'yes' : 'no'));
  `, {});
  ok(/G1=interrupted/.test(r7), '上一代 running 清算为 interrupted', r7.slice(0, 300));
  ok(/G2=finished/.test(r7), '已收尾的 run 不被清算', r7.slice(0, 300));
  ok(/FIN=yes/.test(r7), 'interrupted 行补了 finished_at', r7.slice(0, 300));

  // ── [8] 父进程死亡（IPC 通道断开）→ harness 自行收口退出 ───────────────
  const exitInfo = await new Promise<{ code: number | null; signal: string | null } | 'timeout'>(
    resolve => {
      const t = setTimeout(() => resolve('timeout'), 8_000);
      child.once('exit', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
      // 模拟 main 优雅停止：断 IPC 通道 → harness 'disconnect' → shutdown
      child.disconnect();
    }
  );
  ok(exitInfo !== 'timeout', '断 IPC 通道后 harness 8s 内自行退出（不留孤儿）', String(exitInfo));

  // ── [9] token 文件 0600 往返（main 侧审计镜像的契约）──────────────────
  // Windows 不支持 POSIX mode（NTFS 走 ACL，stat mode 恒 0666），0600 断言
  // 只在 POSIX 平台跑；Windows 上断言「文件存在 + 往返一致」即可 —— 打包态
  // 该目录本来就是用户私有 profile（%APPDATA%），与 SQLite 同级信任。
  const r9 = runTsx(`
    import { statSync, existsSync } from 'node:fs';
    process.env.OPC_DATA_DIR = ${JSON.stringify(dataDir)};
    const { generateToken, writeTokenFile, readTokenFile, removeTokenFile, tokenFilePath } = await import(${JSON.stringify(tokenUrl)});
    const tk = generateToken();
    writeTokenFile(${JSON.stringify(dataDir)}, { token: tk, pid: 1234, startedAt: '2026-01-01T00:00:00.000Z' });
    const back = readTokenFile(${JSON.stringify(dataDir)});
    const mode = statSync(tokenFilePath(${JSON.stringify(dataDir)})).mode & 0o777;
    const removed = (removeTokenFile(${JSON.stringify(dataDir)}), !existsSync(tokenFilePath(${JSON.stringify(dataDir)})));
    console.log('ROUNDTRIP=' + (back?.token === tk));
    console.log('MODE0600=' + ((mode & 0o077) === 0));
    console.log('REMOVED=' + removed);
  `, { OPC_DATA_DIR: dataDir });
  ok(/ROUNDTRIP=true/.test(r9), 'token 文件写读往返一致', r9.slice(0, 300));
  if (process.platform === 'win32') {
    ok(/REMOVED=true/.test(r9), 'token 文件可删除（优雅退出清理）', r9.slice(0, 300));
    console.log('  （Windows：0600 断言跳过 —— NTFS 无 POSIX mode，信任边界 = 用户私有 profile）');
  } else {
    ok(/MODE0600=true/.test(r9), 'token 文件权限 0600（POSIX 口径）', r9.slice(0, 300));
    ok(/REMOVED=true/.test(r9), 'token 文件可删除（优雅退出清理）', r9.slice(0, 300));
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log(`\n结果：${total - failures.length}/${total} 通过`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
}

void main().then(() => process.exit(0));
