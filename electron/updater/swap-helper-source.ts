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
const { spawn } = require('node:child_process');

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rm(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

function writeMarker(patch) {
  try {
    const prev = fs.existsSync(job.markerPath)
      ? JSON.parse(fs.readFileSync(job.markerPath, 'utf8'))
      : {};
    fs.writeFileSync(job.markerPath, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2));
  } catch { /* marker 写不进去不该拖垮交换流程 */ }
}

async function waitParentExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(300);
  }
  return false;
}

// 主进程退出 ≠ 它的子进程立刻退出。Windows 上只要还有一个 Electron 子进程
// 打开着 resources/app.asar（Electron 打开时不带 FILE_SHARE_DELETE），
// rename 就立刻 EBUSY。1.0.5 真机就是卡在这：主进程一退就 rename，撞上还没
// 退干净的 GPU / 渲染进程，一次失败直接进回滚分支，用户重启后还是旧版本。
// 所以这里对 EBUSY/EPERM/EACCES 做有界重试，等锁自然释放。
async function renameWithRetry(from, to, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = err && err.code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
      if (Date.now() >= deadline) {
        const e = new Error('旧版本 app.asar 仍被占用（' + code + '），可能还有 OPC Agent 进程没有退干净（已等待 ' + Math.round(timeoutMs / 1000) + ' 秒）');
        e.code = code;
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

(async () => {
  if (!(await waitParentExit(job.parentPid, 30000))) {
    writeMarker({ state: 'failed', error: '等待旧进程退出超时' });
    return;
  }

  // 0) 交接前最后一道检查：暂存文件必须还在、体积必须与清单一致。
  //    主进程已经算过 sha512；这里防的是「旧的 app.asar 已被改名，暂存包却没了」
  //    —— 那种情况下继续走下去只会把用户装成打不开的状态。
  let stagedSize = -1;
  try { stagedSize = fs.statSync(job.stagedAsar).size; } catch { stagedSize = -1; }
  if (stagedSize !== job.stagedSize) {
    writeMarker({ state: 'failed', error: '暂存的新版本文件缺失或体积不符' });
    cleanup();
    return;
  }

  // 1) 备份旧 asar，放入新 asar（同目录临时名再 rename，避免半截文件被加载）
  //    两次 rename 都要等锁：子进程退出比主进程慢，一次 EBUSY 不该判失败。
  const lockTimeoutMs = Number(job.lockTimeoutMs) > 0 ? Number(job.lockTimeoutMs) : 20000;
  rm(job.backupPath);
  if (fs.existsSync(job.targetAsar)) await renameWithRetry(job.targetAsar, job.backupPath, lockTimeoutMs);
  const tmp = job.targetAsar + '.new';
  rm(tmp);
  fs.copyFileSync(job.stagedAsar, tmp);
  await renameWithRetry(tmp, job.targetAsar, lockTimeoutMs);
  writeMarker({ state: 'unconfirmed', attempts: 1, version: job.version });

  // 2) 启动新版本，等它写出健康文件
  rm(job.healthPath);
  const child = launchApp();
  const deadline = Date.now() + job.healthTimeoutMs;
  let healthy = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(job.healthPath)) {
      healthy = true;
      break;
    }
    await sleep(500);
  }

  if (healthy) {
    writeMarker({ state: 'confirmed', attempts: 1, version: job.version });
    rm(job.backupPath);
    rm(job.stagedAsar);
    cleanup();
    return;
  }

  // 3) 等不到健康文件 = 新版本没起来（或起来就崩）→ 自动回滚并重启旧版本
  try { process.kill(child.pid); } catch { /* 已经退了 */ }
  await sleep(1500);
  rm(job.targetAsar);
  if (fs.existsSync(job.backupPath)) await renameWithRetry(job.backupPath, job.targetAsar, lockTimeoutMs);
  writeMarker({ state: 'rolled-back', attempts: 1, version: job.version });
  launchApp();
  cleanup();
})().catch(err => {
  // 走到这里说明「备份/落盘」中途出错：此时旧 asar 可能已经被改名到 .bak，
  // 若不还原，下一次手动启动会因为找不到 app.asar 直接起不来。
  try {
    if (!fs.existsSync(job.targetAsar) && fs.existsSync(job.backupPath)) {
      fs.renameSync(job.backupPath, job.targetAsar);
    }
  } catch { /* 还原失败只能留给人工处理 */ }
  writeMarker({ state: 'failed', version: job.version, error: String((err && err.message) || err) });
  try { launchApp(); } catch { /* 起不来时用户仍可手动启动 */ }
});
`;
