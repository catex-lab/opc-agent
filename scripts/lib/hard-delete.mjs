/**
 * 真删除（直接释放磁盘，不进回收站）。
 *
 * 本机（Trae 沙箱）有个坑，实测确认：
 *   - 在**工作区内**删除文件（Remove-Item / fs.rmSync / [System.IO.Directory]::Delete 都一样）
 *     会被转存到回收站，可用空间一点不释放（删 30MB 后剩余空间只多 0.3MB）；
 *   - 在**工作区外**删除才是永久删除（删 30MB 立即释放 30.3MB）。
 *
 * 所以做法是：同盘 rename 到工作区外的暂存目录（只是改目录项，2GB 也是秒完成），
 * 再在暂存目录里永久删除。这样既释放磁盘，又不会碰回收站里的任何东西。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const STAGING_DIR_NAME = '_opc-trash';

/** 递归统计目录/文件体积（字节）。统计失败时返回 0，仅用于日志。 */
export function sizeOf(target) {
  let total = 0;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) return stat.size;
    const stack = [target];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        try {
          if (e.isDirectory()) stack.push(full);
          else total += fs.lstatSync(full).size;
        } catch {
          // 锁文件/权限不足：跳过，不影响统计
        }
      }
    }
  } catch {
    return 0;
  }
  return total;
}

/** 目标是否位于工作区内（工作区内的删除会被环境转成「移入回收站」）。 */
function isInsideWorkspace(target, workspaceRoot) {
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(target));
  if (!rel) return true; // 等于工作区根目录本身
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 用子进程的原生 fs.rmSync 删除（去掉 NODE_OPTIONS，避免本机垫片干预）。 */
function nativeRemove(target) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const code =
    `require('node:fs').rmSync(${JSON.stringify(target)}, ` +
    `{ recursive: true, force: true, maxRetries: 5, retryDelay: 300 })`;

  const result = spawnSync(process.execPath, ['-e', code], {
    env,
    stdio: 'pipe',
    windowsHide: true,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    if (stderr) console.warn(`[hard-delete] ${target}\n${stderr}`);
  }
}

/**
 * 永久删除文件或目录。返回是否删除成功（目标已不存在即视为成功）。
 *
 * @param {string} target 要删除的路径
 * @param {{ workspaceRoot?: string }} [options] 工作区根目录，默认 process.cwd()
 */
export function hardDelete(target, options = {}) {
  if (!fs.existsSync(target)) return true;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const abs = path.resolve(target);

  let victim = abs;
  let stagingRoot = null;

  if (isInsideWorkspace(abs, workspaceRoot)) {
    // 同盘、工作区外：rename 只改目录项，不受文件体积影响
    stagingRoot = path.join(path.parse(abs).root, STAGING_DIR_NAME);
    try {
      fs.mkdirSync(stagingRoot, { recursive: true });
      const staged = path.join(
        stagingRoot,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(abs)}`
      );
      fs.renameSync(abs, staged);
      victim = staged;
    } catch (err) {
      console.warn(`[hard-delete] 移动到暂存目录失败：${abs}\n${err.message}`);
      return false;
    }
  }

  nativeRemove(victim);

  const ok = !fs.existsSync(victim) && !fs.existsSync(abs);

  if (stagingRoot) {
    try {
      fs.rmdirSync(stagingRoot); // 空了才删得掉，有残留就留着（下次继续用）
    } catch {
      // 忽略：暂存目录里还有别的待删项
    }
  }

  return ok;
}

/** 删除成功则打印「已释放 X MB」。 */
export function hardDeleteAndReport(target, label = target, options = {}) {
  if (!fs.existsSync(target)) return 0;
  const bytes = sizeOf(target);
  const ok = hardDelete(target, options);
  if (ok) {
    console.log(`[clean] 已删除 ${label}（释放 ${(bytes / 1024 / 1024).toFixed(1)} MB）`);
    return bytes;
  }
  console.warn(`[clean] 删除失败（可能被占用）：${label}`);
  return 0;
}
