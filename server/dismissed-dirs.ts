/**
 * 「最近目录」里被用户点 × 忽略掉的目录（A131）。
 *
 * ## 为什么必须在服务端，不能留在 localStorage
 *
 * 打包态传的是 `PORT=0`（`electron/bootstrap.cjs`），系统每次分配一个空闲端口，
 * 而页面地址是 `http://127.0.0.1:<端口>`（`electron/main.ts`）。**换一个端口就是
 * 换一个源，localStorage 从零开始** —— 用户点了 × 当场生效，下次打开全部作废。
 * 本机实测：Chromium 的 Local Storage 里出现过 43 个不同的端口源，
 * 而 `opc_ignored_dirs` 这一个键同时躺在其中 3 个源里（三次启动各点过一轮）。
 *
 * ## 为什么是 JSON 单文件而不是建表
 *
 * 与 `user-profile.json` / `custom-agents.json` 同一套路：这是一份**全局小清单**，
 * 不按会话、不按项目变，建表要迁移而这里不用。存的是归一化后的路径键
 * （`normalizeProjectPath`），所以 `C:\Users\X\A` 与 `c:/users/x/a` 是同一个忽略项 ——
 * 此前按原始字符串比，同一目录的两种写法会各算各的，点掉一条另一条照旧挂着。
 *
 * ## 删掉不掉的目录去哪了
 *
 * 只影响「最近目录」这一处快捷列表。会话的 `cwd` 一个字都不改：用户可能只是
 * 不想在快捷列表里看见它，不是想把所有会话的工作目录清空。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDirPath } from './paths.js';
import { normalizeProjectPath } from './project-key.js';

let cached: Set<string> | null = null;

function filePath(): string {
  return path.join(dataDirPath, 'dismissed-directories.json');
}

function readFromDisk(): Set<string> {
  try {
    if (!existsSync(filePath())) return new Set();
    const parsed = JSON.parse(readFileSync(filePath(), 'utf-8'));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((v: unknown): v is string => typeof v === 'string')
        .map(v => normalizeProjectPath(v))
        .filter(Boolean)
    );
  } catch {
    // 文件损坏：当没有忽略过任何目录，不要让整个服务端起不来
    return new Set();
  }
}

function persist(next: Set<string>): void {
  cached = next;
  try {
    mkdirSync(dataDirPath, { recursive: true });
    writeFileSync(filePath(), JSON.stringify([...next], null, 2), 'utf-8');
  } catch (e) {
    // 写不进去只影响「下次启动还认不认得」；本次进程内仍然生效
    console.warn('[DismissedDirs] 写入失败（本次进程内仍生效）:', (e as Error).message);
  }
}

/** 全部忽略项的归一化键。给闸门与「已忽略 N 个」那一行用 */
export function listDismissed(): string[] {
  if (!cached) cached = readFromDisk();
  return [...cached];
}

export function dismissedCount(): number {
  return listDismissed().length;
}

/** 这个目录（任意写法）是否已被忽略 */
export function isDismissed(cwd: string): boolean {
  const key = normalizeProjectPath(cwd);
  if (!key) return false;
  if (!cached) cached = readFromDisk();
  return cached.has(key);
}

/**
 * 忽略一个目录。路径算不出键（空串等）时返回当前总数而不改动 ——
 * 调用方拿到的数字不变就说明这次没生效，不必额外造一个错误码。
 */
export function dismiss(cwd: string): number {
  const key = normalizeProjectPath(cwd);
  if (!key) return dismissedCount();
  const next = new Set(listDismissed());
  next.add(key);
  persist(next);
  return next.size;
}

/** 撤销全部忽略，返回清掉的条数 */
export function restoreAllDismissed(): number {
  const n = dismissedCount();
  persist(new Set());
  return n;
}

/** 只给闸门用：清掉进程内缓存，逼下一次读盘（模拟重启） */
export function resetDismissedCacheForTests(): void {
  cached = null;
}
