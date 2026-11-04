/**
 * 退出时替换 app.asar 的**独立小脚本**（源码字符串）。
 *
 * ## 为什么把它写成字符串，而不是仓库里的 .cjs
 *
 * 脚本要被 `spawn(process.execPath, [helper, job])` 执行。打包后
 * `electron/**` 全在 `app.asar` 里，而 Node 无法直接执行 asar 内的脚本；
 * 但把它先写到暂存目录（系统 temp）就能执行。写成源码字符串是为了
 * 保证「写出去的字节」与仓库里的逻辑是同一份，不用额外配置打包复制。
 *
 * ## 它为什么存在
 *
 * Windows 上应用运行期间 `resources/app.asar` 可能仍被打开，退出前直接
 * rename 会撞 sharing violation。所以主进程只负责把「换、试、回滚」的
 * 活交给这个分离进程：它等父进程真正退出后再动文件，然后启动新版本，
 * 45 秒内等不到健康文件就恢复 `.bak` 并重新启动旧版本。
 *
 * 脚本只用 Node 内置模块，不 require 任何业务代码。
 */
export const SWAP_HELPER_SOURCE = String.raw`'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

/* ══════════ 可注入的单调时钟 ══════════
 *
 * 时长**只**用单调时钟算（performance.now / hrtime），绝不用 Date.now：
 * 用户机器可能被 NTP 回拨，墙钟一倒退，重试预算就会被算成负数、文案里的
 * 「已等待」也会变成谎话。墙钟只保留给 ISO 时间戳（取证时看先后顺序）。
 *
 * 闸门用 globalThis.__OPC_SWAP_HOOKS__ 注入假时钟、假 sleep、假 rename，
 * 走的是下面同一段逻辑 —— 生产路径不设置这个全局，拿到的就是真实实现。
 */
const hooks = (globalThis.__OPC_SWAP_HOOKS__ && typeof globalThis.__OPC_SWAP_HOOKS__ === 'object')
  ? globalThis.__OPC_SWAP_HOOKS__
  : {};
const monoNow = typeof hooks.now === 'function'
  ? hooks.now
  : () => {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
      return Number(process.hrtime.bigint()) / 1e6;
    };
const sleep = typeof hooks.sleep === 'function'
  ? hooks.sleep
  : ms => new Promise(resolve => setTimeout(resolve, ms));
const renameFile = typeof hooks.rename === 'function' ? hooks.rename : (from, to) => fs.renameSync(from, to);
const killPid = typeof hooks.kill === 'function' ? hooks.kill : pid => process.kill(pid);
// 持有者查询默认走 Restart Manager；闸门注入假函数，避免每次失败都拉起 PowerShell
const listHoldersFn = typeof hooks.holders === 'function' ? hooks.holders : target => listHolders(target);

const HELPER_T0 = monoNow();
const MAX_MARKER_CHARS = 65536;
const MAX_SAMPLES = 50;
const round1 = n => Math.round(n * 10) / 10;
const sec = ms => round1(ms / 1000).toFixed(1);
/** 预算整秒时不带小数（「预算 60 秒」），非整秒才保留一位 */
const budgetSec = ms => (ms % 1000 === 0 ? String(ms / 1000) : sec(ms));

/** trace 常驻内存；每次落盘都取一份快照，避免把半截状态写出去 */
const traceData = {
  jobAt: typeof job.jobAt === 'string' ? job.jobAt : null,
  precheckMs: Number.isFinite(Number(job.precheckMs)) ? Number(job.precheckMs) : null,
  helperStartedAt: new Date().toISOString(),
  parentWait: null,
  processWait: null,
  lockWait: null,
  // 一次交换可能有两次抢锁（备份旧包 / 放入新包）：最后一次放 lockWait（带采样），
  // 历史只留摘要，避免 marker 被样本撑大
  lockWaitHistory: [],
  events: [],
  totalMs: null,
};

function snapshotTrace() {
  return { ...traceData, totalMs: round1(monoNow() - HELPER_T0) };
}

// 安装目录（= OPC Agent.exe 所在目录）。只按**路径**认「我们自己的进程」，
// 绝不按进程名全局杀 —— 用户机器上可能还开着别的 Electron 应用。
const INSTALL_DIR = typeof job.installDir === 'string' ? job.installDir : '';
const JOB_STARTED_AT = Number.isFinite(Date.parse(job.startedAt || '')) ? Date.parse(job.startedAt) : 0;
const LOCK_TIMEOUT_MS = Number(job.lockTimeoutMs) > 0 ? Number(job.lockTimeoutMs) : 60000;
const PROCESS_WAIT_MS = Number.isFinite(Number(job.processWaitMs)) && job.processWaitMs !== null && job.processWaitMs !== undefined
  ? Math.max(0, Number(job.processWaitMs))
  : 20000;

function rm(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

function writeMarker(patch) {
  try {
    const prev = fs.existsSync(job.markerPath)
      ? JSON.parse(fs.readFileSync(job.markerPath, 'utf8'))
      : {};
    const next = { ...prev, ...patch, at: new Date().toISOString() };
    let text = JSON.stringify(next, null, 2);
    /* 超大时**截断**而不是写坏：先砍 events / 采样，再退化成摘要。
       用户机器上的 state 是事后取证的唯一凭据，绝不能因为 trace 太大而
       写出半截 JSON（下次启动会读不出来）。 */
    if (text.length > MAX_MARKER_CHARS && next.trace) {
      const lock = next.trace.lockWait;
      next.trace = {
        ...next.trace,
        events: Array.isArray(next.trace.events) ? next.trace.events.slice(-5) : [],
        lockWait: lock
          ? { ...lock, samples: Array.isArray(lock.samples) ? lock.samples.slice(0, 12) : [] }
          : null,
        truncated: true,
      };
      text = JSON.stringify(next, null, 2);
    }
    if (text.length > MAX_MARKER_CHARS) {
      next.trace = { truncated: true, jobAt: next.trace && next.trace.jobAt, totalMs: next.trace && next.trace.totalMs };
      text = JSON.stringify(next, null, 2);
    }
    fs.writeFileSync(job.markerPath, text);
  } catch { /* marker 写不进去不该拖垮交换流程 */ }
}

async function waitParentExit(pid, timeoutMs) {
  const started = monoNow();
  while (monoNow() - started < timeoutMs) {
    try {
      killPid(pid);
    } catch (err) {
      // 只有 ESRCH（进程真的没了）才算退出。EPERM 表示进程还在、只是没权限
      // 发信号 —— 1.0.7 把任何异常都当「已退出」，如果旧进程以管理员身份
      // 运行，helper 会在它还没退干净时就开始 rename，撞 EBUSY 白等 20 秒。
      if (err && err.code === 'ESRCH') {
        const elapsedMs = round1(monoNow() - started);
        traceData.parentWait = { stage: '等进程退出', elapsedMs, budgetMs: timeoutMs, exited: true };
        return { exited: true, elapsedMs };
      }
    }
    await sleep(300);
  }
  const elapsedMs = round1(monoNow() - started);
  traceData.parentWait = { stage: '等进程退出', elapsedMs, budgetMs: timeoutMs, exited: false };
  return { exited: false, elapsedMs };
}

/** 采样压缩：首 10 + 每 10 条一条 + 末 10，最多 50 条。
 *  先保首末再保中间 —— 末 10 条是「失败前最后发生了什么」，不能被截掉。 */
function sampleSamples(all) {
  if (all.length <= MAX_SAMPLES) return all.slice();
  const idx = new Set();
  for (let i = 0; i < 10 && i < all.length; i += 1) idx.add(i);
  for (let i = Math.max(0, all.length - 10); i < all.length; i += 1) idx.add(i);
  for (let i = 9; i < all.length && idx.size < MAX_SAMPLES; i += 10) idx.add(i);
  let out = [...idx].sort((a, b) => a - b).map(i => all[i]);
  if (out.length > MAX_SAMPLES) out = [...out.slice(0, 10), ...out.slice(out.length - 10)];
  return out;
}

/* ══════════ 安装目录残留进程：先等、再定向结束 ══════════
 *
 * 真机 1.0.7 → 1.0.8 的失败现场：父进程已退出、20 秒预算耗尽仍在 EBUSY，
 * 说明持有 app.asar 的不是「刚退出的主进程」。Restart Manager 实测表明
 * 渲染 / GPU / 工具子进程并不持有 app.asar（只有主进程持有），所以真正要
 * 防的是**安装目录里残留的 OPC Agent 主进程**（例如上一次崩溃留下的实例、
 * 或用户又点开的第二个窗口）。
 *
 * 口径：只认映像路径位于 job.installDir 下的进程；等待结束后只终止
 * 「在本次更新开始前就已启动」的那些（= 我们的残留），更新开始后才启动的
 * 按「另一个实例」处理，只记录、不杀。绝不按进程名全局 taskkill。
 */
function trace(msg) {
  try {
    traceData.events.push({ t: new Date().toISOString(), msg: msg });
    if (traceData.events.length > 20) traceData.events.shift();
    writeMarker({ trace: snapshotTrace() });
  } catch { /* 取证信息写不进去不该影响交换 */ }
}

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function runPs(script, extraEnv, timeoutMs) {
  try {
    const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs || 15000,
      env: { ...process.env, ...(extraEnv || {}) },
    });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '');
  } catch {
    return null;
  }
}

function labelOf(p) {
  return (p.name || '进程') + '(' + p.pid + ')';
}

/** 安装目录下的进程快照；枚举不可用时返回 null（调用方退回「只靠重试」） */
function listInstallDirProcesses() {
  if (!INSTALL_DIR) return null;
  const ps =
    '$dir = $env:OPC_SWAP_DIR; ' +
    'Get-CimInstance Win32_Process | ' +
    'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($dir.ToLower()) } | ' +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.Name, $_.CreationDate.ToString('o') }";
  const out = runPs(ps, { OPC_SWAP_DIR: INSTALL_DIR }, 15000);
  if (out === null) return null;
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i1 = t.indexOf('|');
    const i2 = t.indexOf('|', i1 + 1);
    if (i1 < 0 || i2 < 0) continue;
    const pid = Number(t.slice(0, i1));
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid: pid, name: t.slice(i1 + 1, i2), started: t.slice(i2 + 1) });
  }
  return rows;
}

function isLeftover(p) {
  if (!JOB_STARTED_AT) return false; // 没有起点时间就不敢杀，只提示
  const t = Date.parse(p.started);
  if (!Number.isFinite(t)) return false;
  return t <= JOB_STARTED_AT;
}

function killTargets(list) {
  const killed = [];
  for (const p of list) {
    try {
      process.kill(p.pid);
      killed.push(p);
    } catch { /* 已经退出 */ }
  }
  return killed;
}

async function guardInstallDir(timeoutMs) {
  const startedAt = new Date().toISOString();
  const startedMono = monoNow();
  const finish = patch => {
    traceData.processWait = {
      stage: '等进程退出',
      startedAt,
      endedAt: new Date().toISOString(),
      elapsedMs: round1(monoNow() - startedMono),
      budgetMs: timeoutMs,
      pids: [],
      killed: [],
      leftover: [],
      ...patch,
    };
  };
  if (!INSTALL_DIR) {
    finish({ skipped: 'no-install-dir' });
    trace('未提供安装目录，跳过残留进程检查');
    return;
  }
  let snapshot = listInstallDirProcesses();
  if (snapshot === null) {
    finish({ skipped: 'enum-unavailable' });
    trace('进程枚举不可用（PowerShell 调用失败），只靠 rename 重试');
    return;
  }
  let others = snapshot.filter(p => p.pid !== process.pid);
  if (!others.length) {
    finish({ pids: [] });
    trace('安装目录内没有其他进程');
    return;
  }
  finish({ pids: others.map(p => p.pid) });
  trace('安装目录内仍有 ' + others.length + ' 个进程：' + others.map(labelOf).join('、'));
  const deadline = startedMono + timeoutMs;
  while (others.length > 0 && monoNow() < deadline) {
    await sleep(1000);
    snapshot = listInstallDirProcesses();
    if (snapshot === null) {
      finish({ pids: others.map(p => p.pid), skipped: 'enum-lost' });
      trace('等待中进程枚举失效，转入 rename 重试');
      return;
    }
    others = snapshot.filter(p => p.pid !== process.pid);
  }
  if (!others.length) {
    finish({ pids: [] });
    trace('残留进程已自行退出');
    return;
  }
  // 更新开始后才启动的进程 = 用户另开的实例 / 其他东西，不碰
  const keep = others.filter(p => !isLeftover(p));
  if (keep.length) {
    trace('以下进程在更新开始后才启动，不终止：' + keep.map(labelOf).join('、'));
  }
  const leftovers = others.filter(isLeftover);
  if (!leftovers.length) {
    finish({ pids: others.map(p => p.pid), killed: [], leftover: [], kept: keep.map(p => p.pid) });
    return;
  }
  const killed = killTargets(leftovers);
  finish({
    pids: others.map(p => p.pid),
    killed: killed.map(p => p.pid),
    leftover: leftovers.map(p => p.pid),
    kept: keep.map(p => p.pid),
  });
  trace(
    '等待 ' + Math.round(timeoutMs / 1000) + ' 秒后定向结束残留进程：' +
      (killed.length ? killed.map(labelOf).join('、') : '无（均已自行退出）')
  );
  await sleep(600);
}

/**
 * 失败时用 Restart Manager 列出**真正持有** app.asar 的进程。
 * 只用于写清失败原因（界面照着名字提示用户关哪个窗口），不做任何终止。
 */
function listHolders(target) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$src = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class RmQ {',
    '  [StructLayout(LayoutKind.Sequential)] public struct FT { public uint lo; public uint hi; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int pid; public FT start; }',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct RM_PROCESS_INFO {',
    '    public RM_UNIQUE_PROCESS Process;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;',
    '    public int AppType; public uint AppStatus; public uint TSSessionId; public bool Restartable;',
    '  }',
    '  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint h, int flags, string key);',
    '  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint h);',
    '  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svc);',
    '  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint h, out uint needed, ref uint count, [In,Out] RM_PROCESS_INFO[] info, out uint reasons);',
    '}',
    "'@",
    'Add-Type -TypeDefinition $src | Out-Null',
    '$h = [uint32]0',
    '$k = [guid]::NewGuid().ToString()',
    'if ([RmQ]::RmStartSession([ref]$h, 0, $k) -ne 0) { Write-Output "RM_UNAVAILABLE"; exit 0 }',
    'try {',
    '  if ([RmQ]::RmRegisterResources($h, 1, @($env:OPC_SWAP_TARGET), 0, $null, 0, $null) -ne 0) { Write-Output "RM_UNAVAILABLE"; exit 0 }',
    '  $need = [uint32]0; $cnt = [uint32]0; $why = [uint32]0',
    '  [RmQ]::RmGetList($h, [ref]$need, [ref]$cnt, $null, [ref]$why) | Out-Null',
    '  if ($need -gt 0) {',
    '    $cnt = $need',
    "    $arr = New-Object 'RmQ+RM_PROCESS_INFO[]' ([int]$need)",
    '    [RmQ]::RmGetList($h, [ref]$need, [ref]$cnt, $arr, [ref]$why) | Out-Null',
    '    for ($i = 0; $i -lt $cnt; $i++) {',
    '      $nm = $arr[$i].AppName',
    "      if (-not $nm) { $nm = $arr[$i].ServiceName }",
    "      if (-not $nm) { $nm = '未知进程' }",
    "      '{0}|{1}' -f $arr[$i].Process.pid, $nm",
    '    }',
    '  }',
    '} catch { Write-Output "RM_UNAVAILABLE" } finally { [RmQ]::RmEndSession($h) | Out-Null }',
  ].join('\n');
  const out = runPs(ps, { OPC_SWAP_TARGET: target }, 20000);
  if (out === null || out.indexOf('RM_UNAVAILABLE') >= 0) return null;
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.indexOf('|') < 0) continue;
    const i = t.indexOf('|');
    const pid = Number(t.slice(0, i));
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid: pid, app: t.slice(i + 1).trim() });
  }
  return rows;
}

// Windows 上 rename 需要 DELETE 权限；只要还有进程持有 app.asar 且没开
// FILE_SHARE_DELETE，就会立刻 EBUSY。Restart Manager 实测表明：渲染 / GPU /
// 工具子进程**不**持有 app.asar，真正持有的只有 OPC Agent 主进程 —— 所以
// 1.0.7 「一退就换」撞的其实是还没退干净的主进程或另一个残留实例。
// 这里对有界重试之外，前置 guardInstallDir 先把安装目录里的残留进程等走 / 结束掉。
async function renameWithRetry(from, to, timeoutMs, label) {
  const started = monoNow();
  const startedAt = new Date().toISOString();
  const failures = [];
  let attempts = 0;
  let lastAt = started;
  let lastDtMs = 0;
  const finish = (ok, code) => {
    const elapsedMs = round1(monoNow() - started);
    traceData.lockWait = {
      stage: '抢锁',
      label: label || null,
      startedAt,
      endedAt: new Date().toISOString(),
      elapsedMs,
      budgetMs: timeoutMs,
      attempts,
      lastDtMs,
      samples: sampleSamples(failures),
      code: code || null,
      ok,
    };
    traceData.lockWaitHistory.push({
      label: label || null,
      elapsedMs,
      attempts,
      lastDtMs,
      sampleCount: traceData.lockWait.samples.length,
      code: code || null,
      ok,
    });
    if (traceData.lockWaitHistory.length > 4) traceData.lockWaitHistory.shift();
    return elapsedMs;
  };
  while (true) {
    if (attempts > 0) lastDtMs = round1(monoNow() - lastAt);
    lastAt = monoNow();
    attempts += 1;
    try {
      renameFile(from, to);
      finish(true, null);
      return;
    } catch (err) {
      const code = err && err.code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
      failures.push({ attempt: attempts, dtMs: attempts === 1 ? 0 : lastDtMs, code });
      const elapsedMs = monoNow() - started;
      if (elapsedMs >= timeoutMs) {
        finish(false, code);
        // 文案：前半是**实测经过**，后半是**预算**，两者分开写。
        const e = new Error(
          '抢锁失败：旧版本 app.asar 仍被占用（' + code + '），已等待 ' +
            sec(elapsedMs) + ' 秒（预算 ' + budgetSec(timeoutMs) + ' 秒）'
        );
        e.code = code;
        e.stage = '抢锁';
        e.elapsedMs = round1(elapsedMs);
        throw e;
      }
      await sleep(250);
    }
  }
}

function launchApp() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(job.appExe, [], { detached: true, stdio: 'ignore', env });
  child.unref();
  return child;
}

function cleanup() {
  rm(job.helperPath);
  rm(job.jobPath);
}

// 失败/回滚路径也不留渣：暂存包、健康文件、备份（旧 asar 还在时才敢删）全清掉。
// 只保留 apply-state.json —— 那是下次启动给用户看的证据，由主进程按
// 「记录版本 vs 当前版本」决定展示还是清理。
function cleanupFailure() {
  try {
    if (fs.existsSync(job.targetAsar)) rm(job.backupPath);
  } catch { /* 备份不在就算了 */ }
  rm(job.stagedAsar);
  rm(job.healthPath);
  cleanup();
}

(async () => {
  const parent = await waitParentExit(job.parentPid, 30000);
  if (!parent.exited) {
    // setup 阶段失败：文案必须点名阶段，并与抢锁失败区分开。
    writeMarker({
      state: 'failed',
      version: job.version,
      error: '等进程退出失败：等待旧进程退出超时，已等待 ' + sec(parent.elapsedMs) + ' 秒（预算 ' + budgetSec(30000) + ' 秒）',
      trace: snapshotTrace(),
    });
    cleanupFailure();
    return;
  }
  trace('旧进程已退出');

  // 0.5) 安装目录里如果还有别的 OPC Agent 进程（残留实例 / 第二窗口），
  //      它会在整个交换期间持有 app.asar。先等它自己退，超时再按路径定向结束。
  await guardInstallDir(PROCESS_WAIT_MS);

  // 1) 交接前最后一道检查：暂存文件必须还在、体积必须与清单一致。
  //    主进程已经算过 sha512；这里防的是「旧的 app.asar 已被改名，暂存包却没了」
  //    —— 那种情况下继续走下去只会把用户装成打不开的状态。
  let stagedSize = -1;
  try { stagedSize = fs.statSync(job.stagedAsar).size; } catch { stagedSize = -1; }
  if (stagedSize !== job.stagedSize) {
    writeMarker({ state: 'failed', version: job.version, error: '暂存的新版本文件缺失或体积不符', trace: snapshotTrace() });
    cleanupFailure();
    return;
  }

  // 2) 备份旧 asar，放入新 asar（同目录临时名再 rename，避免半截文件被加载）
  //    两次 rename 都要等锁；预算耗尽时由 catch 写明「谁还持有」。
  rm(job.backupPath);
  if (fs.existsSync(job.targetAsar)) await renameWithRetry(job.targetAsar, job.backupPath, LOCK_TIMEOUT_MS, '备份旧包');
  const tmp = job.targetAsar + '.new';
  rm(tmp);
  fs.copyFileSync(job.stagedAsar, tmp);
  await renameWithRetry(tmp, job.targetAsar, LOCK_TIMEOUT_MS, '放入新包');
  writeMarker({ state: 'unconfirmed', attempts: 1, version: job.version, trace: snapshotTrace() });
  trace('新 asar 已就位，等待健康文件');

  // 3) 启动新版本，等它写出健康文件
  rm(job.healthPath);
  const child = launchApp();
  const healthStarted = monoNow();
  let healthy = false;
  while (monoNow() - healthStarted < job.healthTimeoutMs) {
    if (fs.existsSync(job.healthPath)) {
      healthy = true;
      break;
    }
    await sleep(500);
  }

  if (healthy) {
    writeMarker({ state: 'confirmed', attempts: 1, version: job.version, trace: snapshotTrace() });
    rm(job.backupPath);
    rm(job.stagedAsar);
    // 成功即清：状态文件不该常驻，下一次启动读不到任何记录就无需展示
    rm(job.markerPath);
    rm(job.healthPath);
    cleanup();
    return;
  }

  // 4) 等不到健康文件 = 新版本没起来（或起来就崩）→ 自动回滚并重启旧版本
  try { killPid(child.pid); } catch { /* 已经退了 */ }
  await sleep(1500);
  rm(job.targetAsar);
  if (fs.existsSync(job.backupPath)) await renameWithRetry(job.backupPath, job.targetAsar, LOCK_TIMEOUT_MS, '恢复旧包');
  writeMarker({ state: 'rolled-back', attempts: 1, version: job.version, trace: snapshotTrace() });
  launchApp();
  cleanupFailure();
})().catch(err => {
  // 走到这里说明「备份/落盘」中途出错：此时旧 asar 可能已经被改名到 .bak，
  // 若不还原，下一次手动启动会因为找不到 app.asar 直接起不来。
  try {
    if (!fs.existsSync(job.targetAsar) && fs.existsSync(job.backupPath)) {
      fs.renameSync(job.backupPath, job.targetAsar);
    }
  } catch { /* 还原失败只能留给人工处理 */ }

  let error = String((err && err.message) || err);
  const code = err && err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    // 只取证、不终止：把真正持有 app.asar 的进程名字写进提示，用户照着关。
    const holders = listHoldersFn(job.targetAsar);
    if (holders === null) {
      trace('Restart Manager 不可用，无法列出持有者（可能是杀毒 / 索引服务的过滤驱动短暂拦截）');
    } else if (!holders.length) {
      trace('Restart Manager 未列出持有者（可能是杀毒 / 索引服务的过滤驱动短暂拦截）');
    } else {
      const names = holders.map(h => (h.app || '未知进程') + '（pid ' + h.pid + '）').join('、');
      error += '；当前持有者：' + names;
      trace('失败时仍持有 app.asar：' + names);
    }
  }
  writeMarker({ state: 'failed', version: job.version, error: error, trace: snapshotTrace() });
  cleanupFailure();
  try { launchApp(); } catch { /* 起不来时用户仍可手动启动 */ }
});
`;
