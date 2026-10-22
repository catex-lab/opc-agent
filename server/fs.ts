/**
 * A77：工作区文件面板的**只读**文件系统访问。
 *
 * ## 为什么单独一个文件
 *
 * 它同时服务路由（`/api/fs/list`）与验证脚本。放进 `index.ts` 就等于
 * 「import 一个模块顺带起一整个 Express」，单测跑不动 —— 与
 * `workspaceDir.ts` 当初拆出来的理由相同。
 *
 * ## 三条边界，每条都是刻意的
 *
 * 1. **只读**。没有写、删、重命名、新建目录。面板的定位是「看清项目里
 *    有什么」，写操作交给 Agent 与外部编辑器 —— 我们不在这里做第二个
 *    编辑器（见 PLAN-WORKSPACE-PANEL.md §5）。
 * 2. **只能看会话的 cwd**。会话没绑定目录就不给看，而不是退回
 *    `process.cwd()`：那会把「应用自己的安装目录」当成用户的项目展示出来。
 * 3. **containment 用 realpath 判定，不是字符串 startsWith**。
 *    `path.resolve` 只做字面归一化，一个指向外部的符号链接能轻松通过
 *    字面检查；只有对**真实路径**比对前缀才拦得住。
 *
 * ## 错误码而不是异常
 *
 * 路由要把「目录不存在」和「你没权限」映射成不同的 HTTP 状态与不同的
 * 人话提示。抛异常再由 catch 统一成 500，用户只会看到一句「加载失败」，
 * 而那正是本项目一直在防的那类反馈。
 */

import fs from 'node:fs';
import path from 'node:path';

export type FsErrorCode = 'no-root' | 'not-found' | 'not-dir' | 'escape' | 'denied';

/** 给人看的错误文案。路由与前端共用同一套措辞，避免两处各说各话。 */
export const FS_ERROR_TEXT: Record<FsErrorCode, string> = {
  'no-root': '工作目录不存在或无法访问',
  'not-found': '路径不存在',
  'not-dir': '该路径不是目录',
  escape: '路径超出会话工作目录',
  denied: '没有权限读取该目录',
};

export interface FsEntry {
  name: string;
  /** 相对会话工作目录的路径，用 `/` 分隔；根目录下的条目就是名字本身 */
  path: string;
  /** 绝对路径，供「用系统程序打开」「在文件夹中显示」直接用 */
  abs: string;
  type: 'dir' | 'file';
  /** 仅文件有 */
  size?: number;
  /** 仅文件有，ISO 字符串 */
  mtime?: string;
}

export interface FsListResult {
  /** 会话工作目录（绝对路径） */
  root: string;
  /** 本次列出的相对路径，根目录为空串 */
  path: string;
  entries: FsEntry[];
  /** 单层条目超过上限时为 true，界面据此如实提示「只显示前 N 项」 */
  truncated: boolean;
}

/**
 * 单层最多返回多少条。
 *
 * `node_modules` 这种目录单层就可能上万条，一次性全塞给前端会把
 * 一棵树的渲染卡住。500 条足够覆盖正常项目结构；超出的部分不是
 * 「藏起来」，而是把 `truncated` 置 true 让界面说清楚。
 */
export const MAX_ENTRIES = 500;

interface Resolved {
  abs: string;
  rootReal: string;
}

function isInside(rootReal: string, target: string): boolean {
  if (target === rootReal) return true;
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  // Windows 上盘符大小写可能不同（C:\ vs c:\），比对前统一小写。
  // 只在这一处做大小写折叠：它只影响「是否包含」的判断，不改变返回的路径。
  if (process.platform === 'win32') {
    return target.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return target.startsWith(prefix);
}

/**
 * 把「相对会话目录的路径」解析成绝对路径，并保证结果仍在根目录内。
 *
 * 拒绝的输入（一律 `escape`，不尝试纠正）：
 *   - 绝对路径（`/etc/passwd`、`C:\Windows`、`\\server\share`）
 *   - 盘符相对路径（`C:foo`）—— 它不是绝对路径，但同样能跳到别处
 *   - 含 `..` 段的路径
 *
 * 前两条**不**通过「拼到 root 后面」来消化：`path.resolve(root, 'C:\\x')`
 * 在 Windows 上会直接返回 `C:\x`，看起来像被接住了，其实已经跳出去了。
 */
export function resolveInside(root: string, rel: string): Resolved | { error: FsErrorCode } {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return { error: 'no-root' };
  }

  // 前端统一传 `/` 分隔，但手工输入/粘贴可能带 `\`，两种都接受
  const normalized = rel.replace(/\\/g, '/');

  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return { error: 'escape' };

  const trimmed = normalized.replace(/^\/+/, '');
  if (!trimmed) return { abs: rootReal, rootReal };

  const segments = trimmed.split('/').filter(s => s.length > 0);
  if (segments.some(s => s === '..')) return { error: 'escape' };

  const joined = path.resolve(rootReal, ...segments);

  let real: string;
  try {
    real = fs.realpathSync(joined);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM') return { error: 'denied' };
    return { error: 'not-found' };
  }

  // 符号链接指到根目录外：`real` 已经跳出去了，这里必须拦
  if (!isInside(rootReal, real)) return { error: 'escape' };

  return { abs: real, rootReal };
}

function classify(
  abs: string,
  dirent: fs.Dirent
): { type: 'dir' | 'file'; size?: number; mtime?: string } | null {
  if (dirent.isDirectory()) return { type: 'dir' };
  if (dirent.isFile()) {
    try {
      const st = fs.statSync(abs);
      return { type: 'file', size: st.size, mtime: st.mtime.toISOString() };
    } catch {
      return { type: 'file' };
    }
  }
  if (dirent.isSymbolicLink()) {
    // 链接按「指向的东西」分类；断链或指到根目录外的一律不展示。
    // 断链不展示而不是显示成文件：点它必然失败，给一个点不动的条目
    // 比少一个条目更糟。
    try {
      const real = fs.realpathSync(abs);
      const st = fs.statSync(real);
      if (st.isDirectory()) return { type: 'dir' };
      if (st.isFile()) return { type: 'file', size: st.size, mtime: st.mtime.toISOString() };
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 列出某一层目录。`rel` 为空串即根目录。 */
export function listDir(root: string, rel: string): FsListResult | { error: FsErrorCode } {
  const resolved = resolveInside(root, rel);
  if ('error' in resolved) return resolved;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.abs);
  } catch {
    return { error: 'not-found' };
  }
  if (!stat.isDirectory()) return { error: 'not-dir' };

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolved.abs, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { error: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'not-found' };
  }

  const base = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const entries: FsEntry[] = [];

  for (const dirent of dirents) {
    const abs = path.join(resolved.abs, dirent.name);
    const info = classify(abs, dirent);
    if (!info) continue;
    // 符号链接分类成功但目标在根目录外：同样不展示
    if (dirent.isSymbolicLink()) {
      try {
        if (!isInside(resolved.rootReal, fs.realpathSync(abs))) continue;
      } catch {
        continue;
      }
    }
    entries.push({
      name: dirent.name,
      path: base ? `${base}/${dirent.name}` : dirent.name,
      abs,
      type: info.type,
      ...(info.type === 'file' ? { size: info.size, mtime: info.mtime } : {}),
    });
  }

  // 目录在前、文件在后，各自按名字排。用 numeric 让 `a2` 排在 `a10` 前面 ——
  // 源码目录里这种编号命名很常见，按字典序排会显得很乱。
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });

  return {
    root: resolved.rootReal,
    path: base,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  };
}
