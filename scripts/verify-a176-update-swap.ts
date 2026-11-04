/**
 * A176 闸门：退出时替换 app.asar 的**真实行为**（不再是「源码里有这行字」）。
 *
 * ## 为什么要有这道闸门
 *
 * 1.0.5 真机更新失败，不是没下载、不是校验不过，而是 helper 在主进程退出的
 * 那一瞬间就去 rename 旧 asar，撞上还没退干净的 Electron 子进程 → `EBUSY`，
 * 一次失败直接写 failed 标记，用户重启后还是旧版本，界面还把错误清掉。
 *
 * 所以这里用**临时目录 + 假 asar + 假 helper + 假 app** 跑三遍真流程：
 *
 *   A 交换：目标文件被另一个进程短时独占（2.5 秒）→ 必须重试后成功
 *   B 回滚：新版本不写健康文件 → 必须恢复旧 asar 并记 rolled-back
 *   C 失败：占用超过重试预算 → 必须显式 failed（旧 asar 原封不动）
 *   E 消解：失败记录版本 ≤ 当前版本 → 判定为已消解，状态文件与残留被清理
 *   F 忽略：只有 apply-failed / rollback 能忽略，且走同一套清理
 *   G 长占用：持有者超过旧的 20 秒预算 → 60 秒内必须等到并换成功
 *   H 残留进程：安装目录里的旧实例 → 先等、超时按路径结束，再交换
 *   I 外部持有：不在安装目录的进程 → 只把持有者名字写进失败文案，不杀
 *
 *   J1–J6 假时钟：预算边界（59.9 秒成功 / 60.1 秒失败）、文案秒数≈实测、
 *           系统时间回拨不影响、240 次重试的 attempts / 末次 dtMs、
 *           采样上限与首末采样、setup 与抢锁阶段文案可区分。
 *           helper 通过 `globalThis.__OPC_SWAP_HOOKS__` 注入假 now / sleep /
 *           rename / kill / holders，走的是与生产完全同一段逻辑，**不真等**。
 *
 *   K1–K3 假时钟 + 假进程表，覆盖 1.0.9 真机漏判的三条分支：
 *           主进程 PID 取错时不得静默通过；持有者启动晚于更新开始也要处理；
 *           进程已退但文件仍被占用（持有者是 helper 自身）必须记 selfHold 并说明。
 *
 * 另外 A/C 还顺带钉住「成功与失败都不留残渣」：成功后状态文件不常驻，
 * 失败后暂存包/健康文件/job/helper 都被清掉，只留 apply-state.json 当证据。
 *
 * 「假 app」用当前 node：不带参数启动会立即退回 REPL 并因 stdin 关闭而退出，
 * 正好模拟「新版本没起来」；场景 A 由本脚本在观察到交换后写健康文件。
 *
 * 目录名故意带空格与中文，顺带覆盖「路径含空格」这一档。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SWAP_HELPER_SOURCE } from '../electron/updater/swap-helper-source';
import { clearApplyArtifacts } from '../electron/updater/apply-artifacts';
import { compareVersions, decideBootOutcome, isDismissableError } from '../electron/updater/boot-outcome';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail: unknown = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  [${String(detail)}]` : ''}`);
  }
}

const NODE = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

interface Sandbox {
  base: string;
  target: string;
  staged: string;
  backup: string;
  marker: string;
  health: string;
  helper: string;
  jobPath: string;
}

const OLD = 'OLD-ASAR-1.0.5';
const NEW = 'NEW-ASAR-1.0.9';

function makeSandbox(label: string, healthTimeoutMs: number, lockTimeoutMs: number): Sandbox {
  const base = mkdtempSync(join(tmpdir(), `opc a176 ${label} 空格 `));
  mkdirSync(join(base, 'resources'), { recursive: true });
  mkdirSync(join(base, 'staging'), { recursive: true });
  const target = join(base, 'resources', 'app.asar');
  const staged = join(base, 'staging', 'app-1.0.9.asar.download');
  const helper = join(base, 'staging', 'update-swap.cjs');
  const jobPath = join(base, 'staging', 'apply-job.json');
  const backup = target + '.bak';
  const marker = join(base, 'staging', 'apply-state.json');
  const health = join(base, 'staging', 'health.json');
  writeFileSync(target, OLD);
  writeFileSync(staged, NEW);
  writeFileSync(helper, SWAP_HELPER_SOURCE);
  writeFileSync(
    jobPath,
    JSON.stringify(
      {
        parentPid: 0,
        version: '1.0.9',
        targetAsar: target,
        stagedAsar: staged,
        stagedSize: Buffer.byteLength(NEW),
        backupPath: backup,
        markerPath: marker,
        healthPath: health,
        helperPath: helper,
        jobPath,
        appExe: NODE,
        // 安装目录故意指到一个空目录：本条闸门的「我们自己」只按路径认
        installDir: join(base, 'install'),
        startedAt: new Date().toISOString(),
        processWaitMs: 0,
        healthTimeoutMs,
        lockTimeoutMs,
      },
      null,
      2
    )
  );
  return { base, target, staged, backup, marker, health, helper, jobPath };
}

/**
 * 短时独占目标文件：用 .NET FileStream 以「只共享读」打开，等价于 Electron
 * 打开 asar 的方式 —— rename 会 EBUSY。拿到句柄后写 sentinel，保证脚本在
 * 真正的锁生效后才继续，避免把「没锁上」误判成「重试成功」。
 */
function startLocker(target: string, holdMs: number, sentinel: string): ChildProcess {
  const q = target.replace(/'/g, "''");
  const s = sentinel.replace(/'/g, "''");
  const ps =
    `$fs=[IO.File]::Open('${q}','Open','ReadWrite','Read');` +
    `[IO.File]::WriteAllText('${s}','1');` +
    `Start-Sleep -Milliseconds ${holdMs};` +
    `$fs.Dispose()`;
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}

function startHelper(sb: Sandbox): { child: ChildProcess; dummy: ChildProcess } {
  // 假父进程：helper 会等它退出。800ms 后杀掉，等价于「应用退出了」。
  const dummy = spawn(NODE, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  const job = JSON.parse(readFileSync(sb.jobPath, 'utf8'));
  job.parentPid = dummy.pid;
  writeFileSync(sb.jobPath, JSON.stringify(job, null, 2));
  const child = spawn(NODE, [sb.helper, sb.jobPath], { stdio: 'ignore' });
  setTimeout(() => {
    try {
      dummy.kill();
    } catch {
      /* 已退出 */
    }
  }, 800);
  return { child, dummy };
}

function readMarker(sb: Sandbox): { state?: string; version?: string; error?: string } {
  try {
    return JSON.parse(readFileSync(sb.marker, 'utf8'));
  } catch {
    return {};
  }
}

function patchJob(sb: Sandbox, patch: Record<string, unknown>): void {
  const job = JSON.parse(readFileSync(sb.jobPath, 'utf8'));
  writeFileSync(sb.jobPath, JSON.stringify({ ...job, ...patch }, null, 2));
}

/** 交换过程中 target 会短暂不存在（先改名成 .bak），轮询时读不到属正常现象 */
function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitDead(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isAlive(child)) return true;
  return waitExit(child, timeoutMs);
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function cleanup(sb: Sandbox): void {
  try {
    rmSync(sb.base, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}

async function scenarioA(): Promise<void> {
  console.log('\n[A] 目标文件被短时占用 → 重试后必须换成功');
  const sb = makeSandbox('A', 8_000, 6_000);
  const sentinel = join(sb.base, 'locker.ready');
  const locker = startLocker(sb.target, 2_500, sentinel);
  await waitFor(() => existsSync(sentinel), 8_000);

  const { child } = startHelper(sb);
  const swapped = await waitFor(() => readText(sb.target) === NEW, 10_000);
  ok(swapped, '占用释放后完成交换（遇到 EBUSY 自动重试）', readText(sb.target));
  writeFileSync(sb.health, JSON.stringify({ version: '1.0.9' }));
  await waitExit(child, 10_000);
  try {
    locker.kill();
  } catch {
    /* 已退出 */
  }

  const marker = readMarker(sb);
  ok(!existsSync(sb.marker), '成功确认后状态文件不常驻（apply-state.json 已清理）', JSON.stringify(marker));
  ok(!existsSync(sb.health), '成功确认后健康文件也已清理');
  ok(!existsSync(sb.backup), '确认后删除 .bak 备份');
  ok(!existsSync(sb.staged), '确认后清掉暂存包');
  ok(!existsSync(sb.helper) && !existsSync(sb.jobPath), '确认后清理 helper 与 job 临时文件');
  cleanup(sb);
}

async function scenarioB(): Promise<void> {
  console.log('\n[B] 新版本不写健康文件 → 必须自动回滚');
  const sb = makeSandbox('B', 2_500, 6_000);
  const { child } = startHelper(sb);
  await waitFor(() => readText(sb.target) === NEW, 8_000);
  ok(readText(sb.target) === NEW, '先完成交换再等健康文件');
  await waitExit(child, 12_000);

  const marker = readMarker(sb);
  ok(readText(sb.target) === OLD, '健康超时后恢复旧 asar', readText(sb.target));
  ok(marker.state === 'rolled-back', '标记为 rolled-back', JSON.stringify(marker));
  ok(marker.version === '1.0.9', '回滚标记里带版本号（界面要用它解释）', marker.version);
  ok(!existsSync(sb.backup), '回滚后 .bak 已被消费');
  cleanup(sb);
}

async function scenarioC(): Promise<void> {
  console.log('\n[C] 占用超过重试预算 → 必须显式失败，旧 asar 原封不动');
  const sb = makeSandbox('C', 4_000, 1_500);
  const sentinel = join(sb.base, 'locker.ready');
  const locker = startLocker(sb.target, 9_000, sentinel);
  await waitFor(() => existsSync(sentinel), 8_000);

  const { child } = startHelper(sb);
  await waitExit(child, 15_000);
  try {
    locker.kill();
  } catch {
    /* 已退出 */
  }

  const marker = readMarker(sb);
  ok(marker.state === 'failed', '写 failed 标记，不伪装成成功', JSON.stringify(marker));
  ok(!!marker.error && marker.error.includes('占用'), '失败原因写清「被占用」', marker.error);
  ok(!!marker.error && marker.error.includes('等待'), '失败原因带等待时长（便于判断是残留进程）', marker.error);
  ok(marker.version === '1.0.9', '失败标记里带版本号', marker.version);
  ok(readText(sb.target) === OLD, '旧 asar 原封不动（没有半截状态）');
  ok(!existsSync(sb.backup), '失败时没有留下 .bak');
  ok(existsSync(sb.marker), '失败时保留 apply-state.json（下次启动要展示原因）');
  ok(!existsSync(sb.staged), '失败时清掉暂存包（不留可误用的残片）');
  ok(!existsSync(sb.helper) && !existsSync(sb.jobPath), '失败时清理 helper 与 job 临时文件');
  cleanup(sb);
}

/* ══════════════ 真机 1.0.7→1.0.8 失败的两类持有者 ══════════════ */

async function scenarioG(): Promise<void> {
  console.log('\n[G] 占用超过旧的 20 秒预算 → 新预算（60 秒）内必须换成功');
  const sb = makeSandbox('G', 8_000, 60_000);
  const sentinel = join(sb.base, 'locker.ready');
  const locker = startLocker(sb.target, 22_000, sentinel);
  await waitFor(() => existsSync(sentinel), 8_000);

  const t0 = Date.now();
  const { child } = startHelper(sb);
  const swapped = await waitFor(() => readText(sb.target) === NEW, 30_000);
  const elapsed = Date.now() - t0;
  ok(swapped, '20 秒后仍被占用，但在 60 秒预算内等到锁释放并完成交换', readText(sb.target));
  ok(elapsed > 20_000, '确认真的等了 20 秒以上（不是侥幸提前成功）', `${elapsed}ms`);
  writeFileSync(sb.health, JSON.stringify({ version: '1.0.9' }));
  await waitExit(child, 10_000);
  try {
    locker.kill();
  } catch {
    /* 已退出 */
  }
  ok(!existsSync(sb.marker) && !existsSync(sb.backup), '成功后仍不留状态文件与 .bak');
  cleanup(sb);
}

async function scenarioH(): Promise<void> {
  console.log('\n[H] 安装目录里的残留进程 → 先等、超时按路径定向结束');
  const sb = makeSandbox('H', 8_000, 6_000);
  const install = join(sb.base, 'install');
  mkdirSync(install, { recursive: true });
  const stubExe = join(install, 'opc-stub.exe');
  copyFileSync(NODE, stubExe);
  const stub = spawn(stubExe, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await sleep(300);
  patchJob(sb, {
    installDir: install,
    startedAt: new Date(Date.now() + 500).toISOString(),
    processWaitMs: 2_000,
  });

  const t0 = Date.now();
  const { child } = startHelper(sb);
  const swapped = await waitFor(() => readText(sb.target) === NEW, 15_000);
  const elapsed = Date.now() - t0;
  ok(swapped, '残留进程被结束、锁释放后完成交换', readText(sb.target));
  ok(elapsed >= 1_500, '先等一段时间再动手，不是发现就杀', `${elapsed}ms`);
  ok(await waitDead(stub, 2_000), '安装目录内的残留进程被定向结束', `exit=${stub.exitCode}`);
  writeFileSync(sb.health, JSON.stringify({ version: '1.0.9' }));
  await waitExit(child, 10_000);
  ok(!existsSync(sb.marker), '成功确认后状态文件不常驻');
  cleanup(sb);
}

async function scenarioI(): Promise<void> {
  console.log('\n[I] 外部进程持有 → 只提示持有者名字，绝不终止');
  const sb = makeSandbox('I', 8_000, 3_000);
  const sentinel = join(sb.base, 'locker.ready');
  const locker = startLocker(sb.target, 30_000, sentinel);
  await waitFor(() => existsSync(sentinel), 8_000);

  const { child } = startHelper(sb);
  await waitExit(child, 20_000);
  const marker = readMarker(sb);
  ok(marker.state === 'failed', '外部占用时显式失败，不伪装成功', JSON.stringify(marker));
  ok(!!marker.error && marker.error.includes('持有者'), '失败文案列出「谁持有」', marker.error);
  ok(!!marker.error && /pid \d+/.test(marker.error), '持有者带 pid，用户能定位进程', marker.error);
  ok(isAlive(locker), '外部进程没有被终止', `exit=${locker.exitCode}`);
  ok(readText(sb.target) === OLD, '旧 asar 原封不动');
  ok(existsSync(sb.marker), '失败时保留 apply-state.json 供界面展示');
  try {
    locker.kill();
  } catch {
    /* 已退出 */
  }
  cleanup(sb);
}

/* ══════════════ 假时钟（注入 hooks，走生产同一段逻辑，不真等） ══════════════ */

interface LockSample {
  attempt: number;
  dtMs: number;
  code: string;
}

interface MarkerTrace {
  jobAt?: string | null;
  precheckMs?: number | null;
  helperStartedAt?: string;
  parentWait?: { stage?: string; elapsedMs?: number; budgetMs?: number; exited?: boolean } | null;
  processWait?: {
    stage?: string;
    elapsedMs?: number;
    budgetMs?: number;
    skipped?: string;
    pids?: number[];
    killed?: number[];
    leftover?: number[];
    kept?: number[];
    holders?: number[] | null;
    selfHold?: boolean;
  } | null;
  selfHold?: boolean;
  holdersAtGuard?: Array<{ pid: number; app?: string }> | null;
  holderRecheck?: Array<{
    atMs?: number;
    reason?: string | null;
    holders?: number[] | null;
    killed?: number[];
    selfInHolders?: boolean;
    enum?: string;
  }>;
  lockWait?: {
    stage?: string;
    label?: string | null;
    startedAt?: string;
    endedAt?: string;
    elapsedMs: number;
    budgetMs: number;
    attempts: number;
    lastDtMs: number;
    samples: LockSample[];
    code?: string | null;
    ok: boolean;
  } | null;
  lockWaitHistory?: Array<{ label?: string | null; elapsedMs: number; attempts: number; ok?: boolean }>;
  totalMs?: number | null;
  truncated?: boolean;
}

interface FakeMarker {
  state?: string;
  version?: string;
  error?: string;
  trace?: MarkerTrace;
}

interface FakeSandbox extends Sandbox {
  harness: string;
  cfgPath: string;
}

interface FakeOptions {
  /** rename 前 N 次抛 EBUSY，之后真实交换（0 = 一次就成功） */
  failCount: number;
  /** 每次 sleep 推进多少假毫秒（helper 传的是 250/300/1000，这里可独立设定） */
  stepMs: number;
  killMode?: 'esrch' | 'alive';
  rollbackWall?: boolean;
  lockTimeoutMs?: number;
  healthTimeoutMs?: number;
  /** 安装目录（非空才走进程枚举守卫）；空串 = 跳过 */
  installDir?: string;
  /** guardInstallDir 的等待预算 */
  processWaitMs?: number;
  /** 安装目录内的进程快照：started 决定「更新前残留」还是「更新后启动」 */
  processes?: Array<{ pid: number; name?: string; started?: string }>;
  /** Restart Manager 视角的持有者；pid 写 'self' 表示交接进程自身 */
  holders?: Array<{ pid: number | 'self'; app?: string }>;
}

/**
 * 造一个「目标 asar 不存在」的假现场：helper 只会走**一次** rename（tmp → target），
 * 这样 attempts / 采样条数完全由 fake 配置决定，不会被备份那一次搅乱。
 * installDir 默认置空 → 跳过 PowerShell 进程枚举；K 组显式给快照，走真实判据。
 */
function makeFakeSandbox(label: string, opts: FakeOptions): FakeSandbox {
  const base = mkdtempSync(join(tmpdir(), `opc a176 fake ${label} 空格 `));
  // 目录要有（copyFileSync 往这里写 .new），但 target 文件**不造**：
  // 这样 helper 只走一次 rename（tmp → target），attempts 完全由假配置决定
  mkdirSync(join(base, 'resources'), { recursive: true });
  mkdirSync(join(base, 'staging'), { recursive: true });
  const target = join(base, 'resources', 'app.asar');
  const staged = join(base, 'staging', 'app-1.0.10.asar.download');
  const helper = join(base, 'staging', 'update-swap.cjs');
  const jobPath = join(base, 'staging', 'apply-job.json');
  const cfgPath = join(base, 'staging', 'fake-clock.json');
  const harness = join(base, 'staging', 'harness.cjs');
  const backup = target + '.bak';
  const marker = join(base, 'staging', 'apply-state.json');
  const health = join(base, 'staging', 'health.json');
  writeFileSync(staged, NEW);
  writeFileSync(helper, SWAP_HELPER_SOURCE);
  writeFileSync(cfgPath, JSON.stringify(opts));
  writeFileSync(
    jobPath,
    JSON.stringify(
      {
        parentPid: 1,
        version: '1.0.10',
        targetAsar: target,
        stagedAsar: staged,
        stagedSize: Buffer.byteLength(NEW),
        backupPath: backup,
        markerPath: marker,
        healthPath: health,
        helperPath: helper,
        jobPath,
        appExe: NODE,
        installDir: opts.installDir ?? '',
        startedAt: '2026-11-04T12:00:00.000Z',
        jobAt: '2026-11-04T12:00:00.500Z',
        precheckMs: 250,
        processWaitMs: opts.processWaitMs ?? 0,
        healthTimeoutMs: opts.healthTimeoutMs ?? 1,
        lockTimeoutMs: opts.lockTimeoutMs ?? 60_000,
      },
      null,
      2
    )
  );
  // argv 布局必须与生产一致：argv[2] = job（helper 直接读），argv[3] = 假时钟配置
  writeFileSync(
    harness,
    `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let fakeNow = 1000000;
let renames = 0;
if (cfg.rollbackWall) {
  // NTP 回拨：墙钟每次读取都倒退 5 秒；单调时钟（hooks.now）不受影响
  let wall = Date.UTC(2026, 10, 4, 12, 0, 0);
  const RealDate = Date;
  globalThis.Date = class FakeDate extends RealDate {
    constructor(...args) { const t = wall; wall -= 5000; super(...(args.length ? args : [t])); }
    static now() { const t = wall; wall -= 5000; return t; }
  };
}
globalThis.__OPC_SWAP_HOOKS__ = {
  now: () => fakeNow,
  sleep: () => { fakeNow += cfg.stepMs; return Promise.resolve(); },
  rename: (from, to) => {
    renames += 1;
    if (renames <= cfg.failCount) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
    fs.renameSync(from, to);
  },
  // 假父进程按 killMode 决定「已退出」，安装目录里的假 pid 一律视为定向结束成功；
  // 其余 pid（例如回滚时结束新版本）按「已退出」处理，不去动真实进程。
  kill: pid => {
    if (pid === job.parentPid) {
      if (cfg.killMode !== 'alive') { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
      return;
    }
    const known = (cfg.processes || []).some(p => p.pid === pid);
    if (known) return;
    const e = new Error('gone'); e.code = 'ESRCH'; throw e;
  },
  holders: () => {
    const rows = cfg.holders || [];
    return rows.map(h => ({ pid: h.pid === 'self' ? process.pid : h.pid, app: h.app || 'OPC Agent' }));
  },
  processes: () => (cfg.processes || []).map(p => ({
    pid: p.pid,
    name: p.name || 'OPC Agent.exe',
    started: p.started || '2026-11-04T11:59:00.000Z',
  })),
};
require(path.join(__dirname, 'update-swap.cjs'));
`,
    'utf8'
  );
  return { base, target, staged, backup, marker, health, helper, jobPath, harness, cfgPath };
}

function readFakeMarker(sb: FakeSandbox): FakeMarker {
  try {
    return JSON.parse(readFileSync(sb.marker, 'utf8')) as FakeMarker;
  } catch {
    return {};
  }
}

async function runFake(sb: FakeSandbox): Promise<FakeMarker> {
  const child = spawn(NODE, [sb.harness, sb.jobPath, sb.cfgPath], { stdio: 'ignore' });
  const exited = await waitExit(child, 10_000);
  ok(exited, 'helper 在假时钟下秒级退出（不真等预算）', `exit=${child.exitCode}`);
  return readFakeMarker(sb);
}

const msgSeconds = (error: string | undefined): number | null => {
  const m = /已等待\s+([0-9]+(?:\.[0-9])?)\s+秒/.exec(error ?? '');
  return m ? Number(m[1]) : null;
};

async function scenarioJ1(): Promise<void> {
  console.log('\n[J1] 预算边界：59.9 秒成功 / 60.1 秒失败（假时钟）');

  // step=101ms：第 594 次尝试发生在 593×101 = 59,893ms（59.9 秒）→ 成功
  const t0 = Date.now();
  const success = makeFakeSandbox('J1-ok', { failCount: 593, stepMs: 101 });
  const okMarker = await runFake(success);
  const okTrace = okMarker.trace?.lockWait;
  ok(okMarker.state === 'rolled-back', '交换成功后因健康超时进入 rolled-back（证明真的换过）', JSON.stringify(okMarker.state));
  ok(!!okTrace && okTrace.ok === true, '成功路径的 trace 记录抢锁成功', JSON.stringify(okTrace && okTrace.ok));
  ok(!!okTrace && okTrace.attempts === 594, '59.9 秒边界：第 594 次尝试拿到锁', okTrace?.attempts);
  ok(!!okTrace && okTrace.elapsedMs === 59_893, '实测耗时 59,893ms（≈59.9 秒）', okTrace?.elapsedMs);
  ok(!!okTrace && okTrace.elapsedMs < 60_000, '未越过 60 秒预算', okTrace?.elapsedMs);
  cleanup(success);

  // 同一步长下一直 EBUSY：第 596 次尝试发生在 60,095ms（60.1 秒）→ 失败
  const fail = makeFakeSandbox('J1-fail', { failCount: 1_000_000, stepMs: 101 });
  const failMarker = await runFake(fail);
  const failTrace = failMarker.trace?.lockWait;
  ok(failMarker.state === 'failed', '越过预算后显式 failed', JSON.stringify(failMarker.state));
  ok(
    !!failMarker.error && failMarker.error.includes('已等待 60.1 秒（预算 60 秒）'),
    '文案是实测口径：已等待 60.1 秒（预算 60 秒）',
    failMarker.error
  );
  ok(!!failTrace && failTrace.ok === false && failTrace.attempts === 596, '第 596 次尝试被判超预算', failTrace?.attempts);
  cleanup(fail);
  ok(Date.now() - t0 < 5_000, '两个边界场景合计 5 秒内完成（未真等 60 秒）', `${Date.now() - t0}ms`);
}

async function scenarioJ2(): Promise<void> {
  console.log('\n[J2] 文案里的秒数 ≈ trace 里的实测经过（容差 ±0.2 秒）');
  const sb = makeFakeSandbox('J2', { failCount: 1_000_000, stepMs: 101 });
  const marker = await runFake(sb);
  const shown = msgSeconds(marker.error);
  const measured = (marker.trace?.lockWait?.elapsedMs ?? NaN) / 1000;
  ok(shown !== null, '失败文案能解析出秒数', marker.error);
  ok(!!shown && Math.abs(shown - measured) <= 0.2, '文案秒数与 trace 实测耗时相差 ≤0.2 秒', `${shown} vs ${measured}`);
  ok(
    !!marker.trace?.lockWait && marker.trace.lockWait.elapsedMs > 60_000,
    'trace 里的实测耗时确实超过预算（不是把 60 当成结果）',
    marker.trace?.lockWait?.elapsedMs
  );
  ok(!!marker.trace?.lockWait?.budgetMs && marker.trace.lockWait.budgetMs === 60_000, 'trace 同时记录预算 60,000ms');
  cleanup(sb);
}

async function scenarioJ3(): Promise<void> {
  console.log('\n[J3] 系统时间倒退（NTP 回拨）不影响结果与文案');
  const normal = makeFakeSandbox('J3-base', { failCount: 1_000_000, stepMs: 101 });
  const normalMarker = await runFake(normal);
  cleanup(normal);

  const skewed = makeFakeSandbox('J3-skew', { failCount: 1_000_000, stepMs: 101, rollbackWall: true });
  const skewedMarker = await runFake(skewed);
  ok(skewedMarker.state === normalMarker.state, '回拨后状态不变', `${skewedMarker.state} vs ${normalMarker.state}`);
  ok(skewedMarker.error === normalMarker.error, '回拨后失败文案逐字一致（时长只认单调时钟）', skewedMarker.error);
  ok(
    skewedMarker.trace?.lockWait?.elapsedMs === normalMarker.trace?.lockWait?.elapsedMs,
    '回拨后实测耗时一致',
    `${skewedMarker.trace?.lockWait?.elapsedMs} vs ${normalMarker.trace?.lockWait?.elapsedMs}`
  );
  ok(
    skewedMarker.trace?.lockWait?.attempts === normalMarker.trace?.lockWait?.attempts,
    '回拨后重试次数一致',
    `${skewedMarker.trace?.lockWait?.attempts} vs ${normalMarker.trace?.lockWait?.attempts}`
  );
  ok(
    typeof skewedMarker.trace?.lockWait?.startedAt !== 'undefined' ||
      typeof skewedMarker.trace?.helperStartedAt === 'string',
    'trace 仍保留 ISO 时间戳（墙钟只用于取证，不参与计时）'
  );
  cleanup(skewed);
}

async function scenarioJ4(): Promise<void> {
  console.log('\n[J4] 240 次重试才拿到锁：attempts 与末次 dtMs 正确');
  const sb = makeFakeSandbox('J4', { failCount: 239, stepMs: 100 });
  const marker = await runFake(sb);
  const lock = marker.trace?.lockWait;
  ok(!!lock && lock.ok === true, '第 240 次重试成功', JSON.stringify(lock && lock.ok));
  ok(!!lock && lock.attempts === 240, 'attempts 总数 = 240', lock?.attempts);
  ok(!!lock && lock.lastDtMs === 100, '末次重试间隔 dtMs = 100ms', lock?.lastDtMs);
  ok(!!lock && lock.elapsedMs === 23_900, '实测总耗时 = 239×100ms', lock?.elapsedMs);
  ok(
    !!lock && Array.isArray(lock.samples) && lock.samples.length > 0 && lock.samples[0].attempt === 1 && lock.samples[0].code === 'EBUSY',
    '首次采样是第 1 次 EBUSY',
    JSON.stringify(lock?.samples && lock.samples[0])
  );
  cleanup(sb);
}

async function scenarioJ5(): Promise<void> {
  console.log('\n[J5] 采样上限：61 次重试的样本 ≤50 条，首末采样正确');
  const sb = makeFakeSandbox('J5', { failCount: 60, stepMs: 100 });
  const marker = await runFake(sb);
  const lock = marker.trace?.lockWait;
  const samples = lock?.samples ?? [];
  ok(!!lock && lock.attempts === 61, 'attempts = 61', lock?.attempts);
  ok(samples.length <= 50, '样本条数不超过上限 50', samples.length);
  ok(samples.length > 10, '样本没有被砍成只有首尾（中段每 10 条留 1 条）', samples.length);
  ok(samples[0]?.attempt === 1, '首条采样 = 第 1 次', samples[0]?.attempt);
  // 第 61 次是成功那次，失败采样止于第 60 次 —— 末条必须是它，不能被截掉
  ok(samples[samples.length - 1]?.attempt === 60, '末条采样 = 第 60 次（成功前最后一次失败一定保留）', samples[samples.length - 1]?.attempt);
  ok(samples.some(s => s.attempt === 10) && samples.some(s => s.attempt === 52), '首 10 与末 10 都在', samples.map(s => s.attempt).join(','));
  ok(
    samples.every((s, i) => i === 0 || s.attempt > samples[i - 1].attempt),
    '采样按尝试次数递增（没有重复/乱序）'
  );
  cleanup(sb);
}

async function scenarioJ6(): Promise<void> {
  console.log('\n[J6] setup 阶段失败与抢锁阶段失败的文案可区分');
  // 父进程一直不退（kill 不抛 ESRCH），每次 sleep 推进 300ms → 100 次后 30,000ms 超时
  const setup = makeFakeSandbox('J6-setup', { failCount: 0, stepMs: 300, killMode: 'alive' });
  const setupMarker = await runFake(setup);
  ok(setupMarker.state === 'failed', 'setup 阶段超时也写 failed', JSON.stringify(setupMarker.state));
  ok(
    !!setupMarker.error && setupMarker.error.startsWith('等进程退出失败'),
    '文案点名阶段「等进程退出失败」',
    setupMarker.error
  );
  ok(
    !!setupMarker.error && setupMarker.error.includes('已等待 30.0 秒（预算 30 秒）'),
    'setup 文案同样是实测经过 + 预算',
    setupMarker.error
  );
  ok(
    setupMarker.trace?.parentWait?.exited === false && setupMarker.trace.parentWait.elapsedMs === 30_000,
    'trace.parentWait 记录了 30,000ms 未退出',
    JSON.stringify(setupMarker.trace?.parentWait)
  );
  cleanup(setup);

  const lockSb = makeFakeSandbox('J6-lock', { failCount: 1_000_000, stepMs: 101 });
  const lockMarker = await runFake(lockSb);
  ok(
    !!lockMarker.error && lockMarker.error.startsWith('抢锁失败'),
    '抢锁阶段文案以「抢锁失败」开头，与 setup 可区分',
    lockMarker.error
  );
  ok(
    !!lockMarker.trace?.lockWait && lockMarker.trace.lockWait.stage === '抢锁',
    'trace 里阶段名是「抢锁」',
    lockMarker.trace?.lockWait?.stage
  );
  ok(
    !!setupMarker.error && !!lockMarker.error && setupMarker.error !== lockMarker.error &&
      !lockMarker.error.includes('等进程退出失败'),
    '两阶段文案不是同一句（阶段名出现在错误里）',
    lockMarker.error
  );
  cleanup(lockSb);
}

/* ══════════════ 1.0.10 真机漏判的三条分支（假时钟 + 假进程表） ══════════════ */

/**
 * K1：waitParentExit 等错了 PID。
 * 真机上 helper 的 parentPid 只代表「启动它的那个主进程」，若持有者其实是
 * 另一个实例，父进程会秒退、旧锁却还在。这里让 parentPid=1（假 kill 立刻
 * ESRCH），真实持有者 9001 在安装目录里 —— guardInstallDir 必须按持有者把它
 * 结束，不能因为「父进程已退出」就静默往下 rename。
 */
async function scenarioK1(): Promise<void> {
  console.log('\n[K1] 主进程 PID 取错 → 按持有者定向结束，不静默通过');
  const install = join(tmpdir(), 'opc a176 fake install K1');
  const sb = makeFakeSandbox('K1', {
    failCount: 0,
    stepMs: 100,
    installDir: install,
    processWaitMs: 0,
    processes: [{ pid: 9001, name: 'OPC Agent.exe', started: '2026-11-04T11:59:00.000Z' }],
    holders: [{ pid: 9001, app: 'OPC Agent' }],
  });
  const marker = await runFake(sb);
  const pw = marker.trace?.processWait;
  ok(marker.trace?.parentWait?.exited === true, '父进程（错误的 PID）确实秒退 —— 单看它会被骗过去', JSON.stringify(marker.trace?.parentWait));
  ok(!!pw && Array.isArray(pw.pids) && pw.pids.includes(9001), 'guard 仍看到了安装目录里的真实持有者 9001', JSON.stringify(pw?.pids));
  ok(!!pw && Array.isArray(pw.killed) && pw.killed.includes(9001), '按「持有目标文件」定向结束 9001（不是只记录）', JSON.stringify(pw?.killed));
  ok(!!pw && Array.isArray(pw.holders) && pw.holders.includes(9001), 'trace 记下 Restart Manager 的持有者', JSON.stringify(pw?.holders));
  ok(marker.trace?.lockWait?.ok === true, '结束持有者后完成交换（没有把 PID 取错当成功路径）', JSON.stringify(marker.trace?.lockWait));
  cleanup(sb);
}

/**
 * K2：持有者启动时间晚于 job.startedAt。
 * 1.0.9 的判据是「更新前启动的才杀」，于是用户在等待期间又点开的实例
 * （同样锁着 app.asar）被 keep 放过，60 秒预算必然耗尽。9002 是更新后启动
 * 的持有者 → 必须结束；9003 同样晚启动但不持有 → 仍然只记录、不杀。
 */
async function scenarioK2(): Promise<void> {
  console.log('\n[K2] 持有者启动晚于更新开始 → 也要处理；不持有的晚启动实例保留');
  const install = join(tmpdir(), 'opc a176 fake install K2');
  const sb = makeFakeSandbox('K2', {
    failCount: 0,
    stepMs: 100,
    installDir: install,
    processWaitMs: 0,
    processes: [
      { pid: 9002, name: 'OPC Agent.exe', started: '2026-11-04T12:00:05.000Z' },
      { pid: 9003, name: 'OPC Agent.exe', started: '2026-11-04T12:00:07.000Z' },
    ],
    holders: [{ pid: 9002, app: 'OPC Agent' }],
  });
  const marker = await runFake(sb);
  const pw = marker.trace?.processWait;
  ok(!!pw && Array.isArray(pw.killed) && pw.killed.includes(9002), '晚启动但持有 app.asar 的 9002 被定向结束', JSON.stringify(pw?.killed));
  ok(!!pw && Array.isArray(pw.kept) && pw.kept.includes(9003), '晚启动且不持有的 9003 只记录、不杀', JSON.stringify(pw?.kept));
  ok(!!pw && Array.isArray(pw.killed) && !pw.killed.includes(9003), '9003 不在 killed 列表里', JSON.stringify(pw?.killed));
  ok(marker.trace?.lockWait?.ok === true, '结束真实持有者后完成交换', JSON.stringify(marker.trace?.lockWait));
  cleanup(sb);
}

/**
 * K3：进程都退了，但文件仍被占用（持有者 = 交接进程自身）。
 * 1.0.10 真机就是这条：helper 用 Electron 的 asar fs stat 了一次 app.asar，
 * 自己成了持有者；guard 把 process.pid 排除后得出「没有其他进程」，静默通过。
 * 修复里 noAsar 关掉了这条路径；万一仍出现，trace 必须记 selfHold，文案必须
 * 说明「不是用户窗口没关」，不能让用户白关窗口。
 */
async function scenarioK3(): Promise<void> {
  console.log('\n[K3] 无其它进程但持有者是自己 → trace.selfHold + 文案点名自身');
  const install = join(tmpdir(), 'opc a176 fake install K3');
  const sb = makeFakeSandbox('K3', {
    failCount: 1_000_000,
    stepMs: 250,
    lockTimeoutMs: 5_000,
    installDir: install,
    processWaitMs: 0,
    processes: [],
    holders: [{ pid: 'self', app: 'OPC Agent' }],
  });
  const marker = await runFake(sb);
  const pw = marker.trace?.processWait;
  ok(marker.state === 'failed', '文件始终占着 → 显式 failed', JSON.stringify(marker.state));
  ok(marker.trace?.selfHold === true, 'trace.selfHold 标出「持有者是交接进程自身」', JSON.stringify(marker.trace?.selfHold));
  ok(!!pw && pw.selfHold === true, 'processWait 也记下 selfHold（不是静默通过）', JSON.stringify(pw?.selfHold));
  ok(!!pw && Array.isArray(pw.holders) && pw.holders.length === 1, 'trace 记录了唯一持有者（helper 自己）', JSON.stringify(pw?.holders));
  ok(
    !!marker.error && marker.error.includes('交接进程自身') && marker.error.includes('不是用户窗口没关'),
    '文案明确「不是用户窗口没关」，并给出重试路径',
    marker.error
  );
  ok(!!marker.error && marker.error.includes('已等待') && marker.error.includes('预算 5 秒'), '失败文案保持实测口径（已等待 / 预算）', marker.error);
  ok(!!marker.trace?.lockWait && marker.trace.lockWait.ok === false && marker.trace.lockWait.code === 'EBUSY', '抢锁阶段记录 EBUSY 与失败', JSON.stringify(marker.trace?.lockWait && { ok: marker.trace.lockWait.ok, code: marker.trace.lockWait.code }));
  cleanup(sb);
}

/* ══════════════ 启动结论 / 忽略（纯函数 + 真实清理） ══════════════ */

/** 造一个「上次更新失败后留下的现场」：失败记录 + 暂存包 + job + helper + .bak */
function makeBootSandbox(label: string): Sandbox {
  const sb = makeSandbox(label, 8_000, 6_000);
  writeFileSync(sb.marker, JSON.stringify({ state: 'failed', version: '1.0.7', error: 'EBUSY' }));
  writeFileSync(sb.health, JSON.stringify({ version: '1.0.9' }));
  writeFileSync(sb.backup, OLD);
  return sb;
}

function scopeOf(sb: Sandbox): { stagingDir: string; backupPath: string } {
  return { stagingDir: join(sb.base, 'staging'), backupPath: sb.backup };
}

function scenarioE(): void {
  console.log('\n[E] 失败记录版本 ≤ 当前版本 → 不展示且状态文件被清理');
  ok(compareVersions('1.0.10', '1.0.9') > 0, '版本按数字段比较（1.0.10 > 1.0.9）');
  ok(compareVersions('1.0.7', '1.0.7') === 0, '同版本比较为 0');

  ok(
    decideBootOutcome({ state: 'failed', version: '1.0.7', error: 'EBUSY' }, '1.0.7').kind === 'resolved',
    '同版本（用户已手动装上）→ 已消解，不展示'
  );
  ok(
    decideBootOutcome({ state: 'failed', version: '1.0.9' }, '1.0.10').kind === 'resolved',
    '当前版本更高 → 已消解，不展示'
  );
  ok(
    decideBootOutcome({ state: 'rolled-back', version: '1.0.9' }, '1.0.7').kind === 'rolled-back',
    '当前版本更低 → 仍需展示回滚'
  );
  ok(
    decideBootOutcome({ state: 'failed', version: '1.0.9' }, '1.0.7').kind === 'apply-failed',
    '当前版本更低 → 仍需展示交接失败'
  );
  ok(
    decideBootOutcome({ state: 'failed' }, '1.0.7').kind === 'apply-failed',
    '记录里没有版本号时不敢判已消解'
  );
  ok(
    decideBootOutcome({ state: 'pending' }, '1.0.7').kind === 'in-progress',
    '交接进行中（pending / unconfirmed）不动任何文件'
  );
  ok(decideBootOutcome(null, '1.0.7').kind === 'none', '没有记录 → 什么都不做');
  ok(
    decideBootOutcome({ state: 'idle' }, '1.0.7').kind === 'resolved',
    '陈旧 / 未知状态（如人工复位的 idle）→ 静默清理'
  );

  const sb = makeBootSandbox('E');
  const res = clearApplyArtifacts(scopeOf(sb));
  ok(!existsSync(sb.marker), '已消解时清掉 apply-state.json');
  ok(!existsSync(sb.staged), '已消解时清掉 .download 暂存包');
  ok(!existsSync(sb.jobPath) && !existsSync(sb.helper), '已消解时清掉 apply-job.json 与 update-swap.cjs');
  ok(!existsSync(sb.backup), '已消解时清掉 .bak');
  ok(!existsSync(sb.health), '已消解时清掉 health.json');
  ok(res.failed.length === 0, '清理过程没有失败项', res.failed.join(', '));
  cleanup(sb);
}

function scenarioF(): void {
  console.log('\n[F] 「忽略」入口能清除，且只对交接失败开放');
  ok(isDismissableError('apply-failed') && isDismissableError('rollback'), 'apply-failed / rollback 允许忽略');
  ok(!isDismissableError('network') && !isDismissableError('digest'), '网络 / 摘要错误不给忽略入口');
  ok(!isDismissableError('signature') && !isDismissableError(undefined), '验签错误与空错误不给忽略入口');

  // 忽略复用的就是这套清理：清完后红字的来源（状态文件）已不存在
  const sb = makeBootSandbox('F');
  clearApplyArtifacts(scopeOf(sb));
  ok(
    !existsSync(sb.marker) && !existsSync(sb.staged) && !existsSync(sb.backup),
    '忽略后状态文件与残留被清空'
  );

  const updaterSrc = readFileSync(join('electron', 'updater', 'index.ts'), 'utf8');
  const mainSrc = readFileSync(join('electron', 'main.ts'), 'utf8');
  const preloadSrc = readFileSync(join('electron', 'preload.cjs'), 'utf8');
  const card = readFileSync(join('src', 'components', 'UpdateCard.tsx'), 'utf8');
  ok(updaterSrc.includes('dismissError') && updaterSrc.includes('isDismissableError'), '控制器用同一判定实现忽略');
  ok(mainSrc.includes("'opc:update-dismiss'"), '主进程注册忽略 IPC');
  ok(preloadSrc.includes("'opc:update-dismiss'"), 'preload 暴露忽略入口');
  ok(card.includes('data-update-dismiss'), '卡片渲染忽略按钮（可被闸门定位）');
  ok(card.includes("error.code === 'apply-failed' || error.code === 'rollback'"), '忽略按钮只对交接类错误出现');
}

/* ══════════════ 接线组（静态断言） ══════════════ */

function staticAsserts(): void {
  console.log('\n[D] 失败提示不再被启动后的自动检查清掉');
  const updater = readFileSync(join('electron', 'updater', 'index.ts'), 'utf8');
  ok(updater.includes('stickyApplyError'), '自动检查保留 apply-failed / rollback 提示');
  ok(updater.includes('上次更新没有装好'), '启动后汇报上一次交接失败');
  ok(/code: 'apply-failed'[\s\S]{0,400}可以重新下载并重试/.test(updater), '失败文案给出重试路径');
  ok(updater.includes('decideBootOutcome'), '启动结论先做版本比较（不再无条件展示旧记录）');
  ok(updater.includes('clearApplyArtifacts'), '启动 / 忽略时调用统一清理函数');

  const card = readFileSync(join('src', 'components', 'UpdateCard.tsx'), 'utf8');
  ok(card.includes('{error && ('), '关于页只要存在 error 就渲染（不跟 phase 走）');

  const helperSrc = readFileSync(join('electron', 'updater', 'swap-helper-source.ts'), 'utf8');
  ok(helperSrc.includes('guardInstallDir') && helperSrc.includes('listInstallDirProcesses'), 'helper 交换前检查安装目录里的残留进程');
  ok(helperSrc.includes('listHolders'), '失败时用 Restart Manager 列出真正持有者');
  ok(helperSrc.includes("err.code === 'ESRCH'"), '只把 ESRCH 当「旧进程已退出」，EPERM 继续等');
  ok(updater.includes('installDir: dirname(process.execPath)'), '控制器把安装目录写进 job');
  ok(updater.includes('lockTimeoutMs: 60_000') && updater.includes('processWaitMs: 20_000'), 'job 显式带 60 秒锁预算与 20 秒进程等待');
  ok(updater.includes('createElapsed') && updater.includes('jobAt: new Date().toISOString()'), '主进程用单调时钟量 precheck，并把 job 写出时刻传给 helper');
  ok(updater.includes('precheckMs: roundMs(elapsed())'), 'job 里带主进程准备阶段耗时');

  // 计时口径：时长只认单调时钟，helper 里不允许用 Date.now 算时长
  ok(!helperSrc.includes('Date.now('), 'helper 不用 Date.now（墙钟只用于 ISO 时间戳）');
  ok(helperSrc.includes('__OPC_SWAP_HOOKS__'), 'helper 提供可注入钩子（生产路径不设置该全局）');
  ok(helperSrc.includes('performance.now') && helperSrc.includes('process.hrtime.bigint'), '生产路径用单调时钟（performance.now / hrtime）');
  ok(helperSrc.includes("stage: '等进程退出'") && helperSrc.includes("stage: '抢锁'"), 'trace 分阶段记录「等进程退出」与「抢锁」');
  ok(helperSrc.includes('lockWait') && helperSrc.includes('processWait') && helperSrc.includes('parentWait'), 'trace 覆盖父进程 / 安装目录 / 抢锁三段');
  ok(helperSrc.includes('samples') && helperSrc.includes('MAX_SAMPLES') && helperSrc.includes('attempts'), '每次重试落采样并记 attempts');
  ok(helperSrc.includes('budgetSec(') && helperSrc.includes('已等待 '), '失败文案把实测经过与预算分开写');
  ok(helperSrc.includes('truncated'), 'marker 过大时截断而不是写坏');

  // 1.0.10 真机漏判：helper 自己被 asar fs 锁住目标文件
  ok(helperSrc.includes('process.noAsar = true'), 'helper 关闭 Electron asar fs（否则 stat 一次 app.asar 就自锁）');
  ok(!helperSrc.includes('fs.existsSync(job.targetAsar)'), '不直接用 asar 感知的 existsSync 判断目标文件');
  ok(helperSrc.includes('function fileExists(') && helperSrc.includes('fileExists(job.targetAsar)'), '目标文件存在性走 fileExists（stat 不打开归档）');
  ok(helperSrc.includes('reclaimTargetHolders') && helperSrc.includes('holderRecheck'), '重试期间按「是否持有」复查并记录');
  ok(helperSrc.includes('holderPids.has(p.pid)') && helperSrc.includes('isLeftover(p)'), '结束判据 = 更新前残留 或 持有目标文件');
  ok(
    /function killTargets\(list\)[\s\S]{0,260}killPid\(p\.pid\)/.test(helperSrc),
    '定向结束走可注入的 killPid（闸门能验证「真的杀了」）'
  );
  ok(helperSrc.includes('selfHold'), 'trace 显式记录 selfHold（不再静默通过）');
}

async function main(): Promise<void> {
  console.log('A176 退出时替换 app.asar：交换 / 回滚 / 占用失败');
  staticAsserts();
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioG();
  await scenarioH();
  await scenarioI();
  const fakeT0 = Date.now();
  await scenarioJ1();
  await scenarioJ2();
  await scenarioJ3();
  await scenarioJ4();
  await scenarioJ5();
  await scenarioJ6();
  console.log(`\n[J] 假时钟六例总耗时 ${Date.now() - fakeT0}ms（全部走注入时钟，未真等）`);
  const kT0 = Date.now();
  await scenarioK1();
  await scenarioK2();
  await scenarioK3();
  console.log(`\n[K] 三条漏判分支总耗时 ${Date.now() - kT0}ms（假时钟 + 假进程表）`);
  scenarioE();
  scenarioF();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
