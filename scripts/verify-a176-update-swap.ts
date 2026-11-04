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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const swapped = await waitFor(() => readFileSync(sb.target, 'utf8') === NEW, 10_000);
  ok(swapped, '占用释放后完成交换（遇到 EBUSY 自动重试）', readFileSync(sb.target, 'utf8'));
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
  await waitFor(() => readFileSync(sb.target, 'utf8') === NEW, 8_000);
  ok(readFileSync(sb.target, 'utf8') === NEW, '先完成交换再等健康文件');
  await waitExit(child, 12_000);

  const marker = readMarker(sb);
  ok(readFileSync(sb.target, 'utf8') === OLD, '健康超时后恢复旧 asar', readFileSync(sb.target, 'utf8'));
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
  ok(readFileSync(sb.target, 'utf8') === OLD, '旧 asar 原封不动（没有半截状态）');
  ok(!existsSync(sb.backup), '失败时没有留下 .bak');
  ok(existsSync(sb.marker), '失败时保留 apply-state.json（下次启动要展示原因）');
  ok(!existsSync(sb.staged), '失败时清掉暂存包（不留可误用的残片）');
  ok(!existsSync(sb.helper) && !existsSync(sb.jobPath), '失败时清理 helper 与 job 临时文件');
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
}

async function main(): Promise<void> {
  console.log('A176 退出时替换 app.asar：交换 / 回滚 / 占用失败');
  staticAsserts();
  await scenarioA();
  await scenarioB();
  await scenarioC();
  scenarioE();
  scenarioF();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
