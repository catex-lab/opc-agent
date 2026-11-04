/**
 * 更新过程在磁盘上留下的中间文件，以及唯一的清理口径。
 *
 * 这里刻意**不 import electron**：`verify:a176-update-swap` 直接用临时目录
 * 调用它，验证「成功 / 失败记录已消解 / 用户忽略」三条路径真的清干净，
 * 而不是只断言源码里有几行字。
 *
 * 分工：
 * - `sweepStagedFiles`：只扫暂存目录里的更新资产（半成品、旧版本残留）；
 * - `clearApplyArtifacts`：在上面基础上，把状态文件、交接脚本、备份一起清掉。
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 暂存目录里算「更新资产」的文件后缀。
 *
 * `.asar` 那一档是**历史遗留**：1.0.2–1.0.4 的客户端把下载完的包直接存成
 * `app-<ver>.asar`，正是它引出了「退出并重启」时的 ENOENT（见 `stagedFile`
 * 的注释）。留着它只为把旧残留一并清掉 —— 现在没有任何逻辑会再读 `.asar`。
 */
export const STAGED_SUFFIXES = ['.download', '.part', '.asar'] as const;

/**
 * 固定文件名的中间产物。
 *
 * `health.json` 只在交接后短暂存在（新版本窗口加载成功即写、helper 读完即删）；
 * `apply-state.json` 是唯一可能「常驻」的一个，生命周期见 DEVELOPMENT.md。
 */
export const APPLY_ARTIFACT_FILES = [
  'apply-state.json',
  'apply-job.json',
  'update-swap.cjs',
  'health.json',
] as const;

export interface ApplyArtifactScope {
  /** 系统 temp 下的 `opc-agent-update/` */
  stagingDir: string;
  /** `<resources>/app.asar.bak` —— 不在暂存目录里，必须显式传 */
  backupPath?: string;
  /** 失败记录仍要留给界面展示时置 true（只保留 `apply-state.json`） */
  keepState?: boolean;
  /** 交接进行中时置 true：helper 还要读健康文件，不能先删 */
  keepHealth?: boolean;
  /** 本次要保留的暂存包绝对路径（下载刚完成、还没交接） */
  keepStaged?: string;
}

export interface ApplyArtifactResult {
  /** 实际删掉的文件 */
  removed: string[];
  /** 删不掉的（被别的进程占用等），留给下次启动再试 */
  failed: string[];
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function removeFile(path: string, result: ApplyArtifactResult): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
    result.removed.push(path);
  } catch {
    result.failed.push(path);
  }
}

/**
 * 清掉暂存目录里的更新资产。
 *
 * `keep` 传本次要保留的绝对路径。删除一律 `force` + 记失败：清残留失败
 * 不该把一次本来可用的更新变成失败。
 */
export function sweepStagedFiles(dir: string, keep?: string): ApplyArtifactResult {
  const result: ApplyArtifactResult = { removed: [], failed: [] };
  for (const name of readdirSafe(dir)) {
    if (!STAGED_SUFFIXES.some(suffix => name.endsWith(suffix))) continue;
    const full = join(dir, name);
    if (keep && full === keep) continue;
    removeFile(full, result);
  }
  return result;
}

/**
 * 清掉一次更新留下的全部痕迹：暂存包、状态文件、交接脚本、`.bak`、健康文件。
 *
 * 默认全删；`keepState` 只给「失败记录仍要展示」的场景用，`keepHealth`
 * 只给「helper 还在等健康文件」的场景用。
 */
export function clearApplyArtifacts(scope: ApplyArtifactScope): ApplyArtifactResult {
  const result = sweepStagedFiles(scope.stagingDir, scope.keepStaged);
  for (const name of APPLY_ARTIFACT_FILES) {
    if (scope.keepState && name === 'apply-state.json') continue;
    if (scope.keepHealth && name === 'health.json') continue;
    removeFile(join(scope.stagingDir, name), result);
  }
  if (scope.backupPath) removeFile(scope.backupPath, result);
  return result;
}
