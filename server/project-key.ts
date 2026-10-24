/**
 * 项目路径归一与项目键（A98）。
 *
 * ## 这一层为什么必须存在
 *
 * 项目记忆按目录分区，分区名就是这个文件算出来的**键**。键算错了，两个
 * 不相干的项目会悄悄共用一个记忆目录 —— 而这正是本轮要修的那个 bug
 * （现在全局只有一份 MEMORY.md，跨项目串味），只是换了个位置复发。
 *
 * 所以这里只放纯函数、不碰文件系统、不碰数据库，方便逐条钉死。
 *
 * ## 三个必须算对的地方
 *
 * 1. **大小写**。Windows 的路径不区分大小写：`E:\Proj\App` 与 `e:/proj/app`
 *    是同一个目录。若按原样做键，用户从「最近目录」点进来和从会话设置里
 *    进来会落到两个不同的记忆目录。所以 win32 上一律转小写；POSIX 上保持
 *    原样（那边确实区分大小写，转小写会把两个真实存在的目录合并）。
 * 2. **分隔符与尾斜杠**。`E:\a\b\` / `E:/a/b` / `E:/a/b/` 必须同键。
 * 3. **同名目录**。`~/work/api` 与 `~/side/api` 的 basename 都是 `api`，
 *    只用 basename 做目录名必然冲突。所以键 = 可读名 + 路径哈希后缀：
 *    既能一眼看出是哪个项目，又不会撞。
 */

import crypto from 'node:crypto';
import path from 'node:path';

/**
 * 归一化路径：绝对、分隔符统一为 `/`、去尾斜杠、win32 转小写。
 *
 * 返回值同时用于「键的哈希输入」与「projects.path 的唯一值」——
 * 两者必须同源，否则会出现「键相同但 path 不同」这种自相矛盾的行。
 */
export function normalizeProjectPath(cwd: string): string {
  const raw = String(cwd ?? '').trim();
  if (!raw) return '';

  // resolve 处理 `.` / `..` / 相对路径。注意它会以**进程 cwd** 为基准，
  // 这正是我们要的：用户在会话里填 `./sub` 指的是后端进程所在目录。
  let abs = path.resolve(raw);

  // 统一分隔符。Windows 的 path.resolve 返回反斜杠。
  abs = abs.replace(/\\/g, '/');

  // 去掉尾斜杠，但**绝不能把根剥成相对路径**：Windows 上 `e:/` 剥成 `e:`
  // 之后含义变成「E 盘的当前目录」，同一台机器上换个 cwd 就会指到别处。
  // （这条是写完验证脚本才发现的 —— 注释里警告过，代码却没防住。）
  if (abs.length > 1 && abs.endsWith('/')) {
    const stripped = abs.slice(0, -1);
    if (!/^[a-z]:$/i.test(stripped)) abs = stripped;
  }

  // win32 不区分大小写；POSIX 区分。
  if (process.platform === 'win32') abs = abs.toLowerCase();

  return abs;
}

/** 可读名：取最后一段，清洗成文件系统安全的形式 */
function readableName(normalized: string): string {
  const seg = normalized.split('/').filter(Boolean).pop() ?? '';
  const cleaned = seg
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'root';
}

/**
 * 项目键：`<可读名>-<8 位哈希>`。
 *
 * 哈希取归一化路径的前 8 位十六进制 —— 2^32 空间，对「一个人本机上的
 * 项目数量」这个量级足够，同时目录名还能看清是哪个项目。
 * 不用完整哈希是为了让 `data/memory/projects/` 下面能直接肉眼辨认。
 */
export function projectKey(cwd: string): string {
  const normalized = normalizeProjectPath(cwd);
  if (!normalized) return '';
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${readableName(normalized)}-${hash}`;
}

/**
 * 项目显示名（默认取目录名，用户可改）。
 *
 * ⚠️ 这里**不能用归一化后的路径**：win32 上归一化会把整条路径转小写，
 * 于是 `projA` 会显示成 `proja`。小写只该用于「做键 / 做唯一约束」，
 * 显示名要保留用户原本写的样子。
 */
export function defaultProjectName(cwd: string): string {
  const raw = String(cwd ?? '').trim();
  if (!raw) return '';
  const abs = path.resolve(raw).replace(/\\/g, '/');
  const seg = abs.split('/').filter(Boolean).pop();
  return seg || abs;
}
