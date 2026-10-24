/**
 * 文件变更核对（A99）—— 把「Agent 说它改了什么」和「磁盘上现在是什么」对一遍。
 *
 * ## 为什么需要这一层
 *
 * 轨迹里的 `+109 -16` 不是从磁盘算出来的：`shared/trace.ts` 的 `buildDiffHunks()`
 * 读的是工具入参里的 `old_string` / `new_string`。也就是说它展示的是
 * **Agent 的声明**，不是**文件的现状**。两者在多数情况下一致，但没有任何机制
 * 保证一致 —— 适配器可能漏发 isError、路径可能写偏、写完之后又可能被改回去。
 *
 * 所以这里补一层**独立的、可验证的**证据：读一遍磁盘，回答「这段内容到底在不在」。
 *
 * ## 与 A97 验证的分工
 *
 * | | 回答的问题 | 手段 |
 * |---|---|---|
 * | A97 验证 | 这轮改动**能不能跑** | 执行 test / build / lint |
 * | A99 核对 | 这轮改动**到底有没有落地** | 读文件比对 |
 *
 * 两件事互相不能替代：测试全绿也可能文件根本没改（改的是别的文件），
 * 文件落地了也可能测试是红的。
 *
 * ## 判定口径（刻意保守）
 *
 * 只认「内容是否真的出现在文件里」这一个可验证的事实，**不推测意图**：
 *
 *   landed          new 在文件里、old 不在 → 这次替换确实落地了
 *   landed_then_modified  文件以写入内容开头，但之后又被改过
 *   not_landed     new 不在文件里 → **声明了但磁盘上没有**
 *   ambiguous      old / new 都在，或都不在 → 无法归因（可能是后续编辑造成的）
 *   missing        文件不存在（非临时目录）
 *   ephemeral      文件不存在，但路径在临时目录下 —— 被清理是预期行为
 *   skipped        缺路径 / 文件太大 / 读不了
 *
 * ⚠️ 时间因素：一轮跑完之后文件被继续修改是很正常的。所以额外给出
 *    `laterModified`（mtime 晚于消息时间），UI 据此把结论降级表述 ——
 *    「之后又被改过」不等于「当时没落地」。
 *
 * ⚠️ 本模块**只读**，不写文件、不碰数据库。它同时被运行时（API）和
 *    审计脚本（scripts/audit-diff-truth.ts）使用，两边口径必须同源。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Block, ToolBlock } from '../shared/blocks.js';
import { EDIT_TOOL_NAMES, WRITE_TOOL_NAMES, toolPathOf } from '../shared/trace.js';

/** 单文件读取上限：超过就不判了，避免把整个仓库读进内存 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type FileVerdict =
  | 'landed'
  | 'landed_then_modified'
  | 'not_landed'
  | 'ambiguous'
  | 'missing'
  | 'ephemeral'
  | 'skipped';

export interface FileEvidence {
  /** 对应 ToolBlock 的 id（前端用来把结论挂回那一步） */
  blockId: string;
  toolName: string;
  /** 绝对路径；缺路径时为空串 */
  file: string;
  /** 相对 cwd 的展示路径；不在 cwd 下时退回绝对路径 */
  display: string;
  verdict: FileVerdict;
  /** 文件 mtime 晚于消息时间 → 结论只能当参考 */
  laterModified: boolean;
  /** 文件当前行数（读到才有） */
  lines?: number;
  /** skipped 的原因，给用户看的一句话 */
  reason?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 是不是临时目录下的路径。
 *
 * 单独判的理由：Agent 经常在 `%TEMP%\opencode\` 里写脚本再执行，那些文件
 * 被系统清掉是**预期行为**。把它们算进「磁盘上没有」会让统计彻底失真 ——
 * 第一版审计里 76.9% 的「找不到」绝大部分就是这么来的。
 */
const TMP_ROOT = path.resolve(os.tmpdir()).toLowerCase().replace(/\\/g, '/');
export function isEphemeralPath(p: string): boolean {
  const n = path.resolve(p).toLowerCase().replace(/\\/g, '/');
  return n.startsWith(TMP_ROOT) || /\/(temp|tmp)\//.test(n);
}

/** 相对路径按会话 cwd 解析；没有 cwd 就解析不了 */
export function resolveTargetPath(raw: string, cwd: string | null): string | null {
  if (path.isAbsolute(raw)) return path.resolve(raw);
  if (!cwd) return null;
  return path.resolve(cwd, raw);
}

/** 展示路径：在 cwd 下就用相对路径，否则用绝对路径 */
function displayPath(abs: string, cwd: string | null): string {
  if (!cwd) return abs;
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.replace(/\\/g, '/');
}

/** 取前几行做指纹 —— 整段大文本比对没必要，前几行足够区分 */
function fingerprint(content: string): string {
  return content
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('\n');
}

/**
 * 单对 old/new 的判定。
 *
 * `old` 为空是合法的（纯插入），这时只能看 new 在不在。
 */
function judgeReplace(fileText: string, oldStr: string, newStr: string): FileVerdict {
  const hasNew = newStr.length > 0 && fileText.includes(newStr);
  const hasOld = oldStr.length > 0 && fileText.includes(oldStr);
  if (hasNew && !hasOld) return 'landed';
  if (!hasNew && hasOld) return 'not_landed';
  // 都在 / 都不在：分不清是「只替换了第一处」还是「后来又被改回去」
  return 'ambiguous';
}

function judgeWrite(fileText: string, content: string): FileVerdict {
  const norm = (s: string) => s.replace(/\r\n/g, '\n');
  const a = norm(fileText);
  const b = norm(content);
  if (a === b) return 'landed';
  const fp = fingerprint(b);
  // 指纹太短就没有区分度（比如只写了一行 `}`），宁可不判
  if (fp.length < 20) return 'ambiguous';
  return a.includes(fp) ? 'landed_then_modified' : 'not_landed';
}

/** 从工具入参里取出 (old, new) 对；multiedit 有多对 */
function replacePairsOf(name: string, input: Record<string, unknown>): Array<[string, string]> {
  if (name === 'multiedit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.map(e => {
      const r = (e ?? {}) as Record<string, unknown>;
      return [str(r.old_string ?? r.old_str), str(r.new_string ?? r.new_str)] as [string, string];
    });
  }
  return [
    [
      str(input.old_string ?? input.old_str ?? input.oldText),
      str(input.new_string ?? input.new_str ?? input.newText),
    ],
  ];
}

/** 只有「会改动文件」的块才值得核对；其余（read / bash）不进来 */
export function isWriteBlock(block: Block): block is ToolBlock {
  if (block.type !== 'tool') return false;
  const n = str(block.name).toLowerCase();
  return WRITE_TOOL_NAMES.has(n) || EDIT_TOOL_NAMES.has(n);
}

/**
 * 核对一条消息里所有写类工具块。
 *
 * @param blocks 消息的块序列（落库的那份）
 * @param cwd    会话工作目录；相对路径靠它解析
 * @param now    消息产生时间（毫秒），用于判断「之后又被改过」
 */
export function verifyFileChanges(
  blocks: readonly Block[],
  cwd: string | null,
  now?: number
): FileEvidence[] {
  const out: FileEvidence[] = [];

  for (const block of blocks) {
    if (!isWriteBlock(block)) continue;

    const name = str(block.name).toLowerCase();
    const raw = toolPathOf(block.input);
    const base = { blockId: block.id, toolName: name, laterModified: false };

    if (!raw) {
      out.push({ ...base, file: '', display: '', verdict: 'skipped', reason: '工具入参里没有文件路径' });
      continue;
    }

    const abs = resolveTargetPath(raw, cwd);
    if (!abs) {
      out.push({
        ...base,
        file: raw,
        display: raw,
        verdict: 'skipped',
        reason: '会话未绑定工作目录，无法解析相对路径',
      });
      continue;
    }

    const display = displayPath(abs, cwd);

    if (!fs.existsSync(abs)) {
      out.push({
        ...base,
        file: abs,
        display,
        verdict: isEphemeralPath(abs) ? 'ephemeral' : 'missing',
      });
      continue;
    }

    let fileText: string;
    let mtimeMs: number;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        out.push({ ...base, file: abs, display, verdict: 'skipped', reason: '目标不是普通文件' });
        continue;
      }
      if (st.size > MAX_FILE_BYTES) {
        out.push({ ...base, file: abs, display, verdict: 'skipped', reason: '文件过大，未读取' });
        continue;
      }
      mtimeMs = st.mtimeMs;
      fileText = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      out.push({
        ...base,
        file: abs,
        display,
        verdict: 'skipped',
        reason: `读取失败：${(err as Error).message}`,
      });
      continue;
    }

    const laterModified = typeof now === 'number' && mtimeMs > now;
    const lines = fileText.length === 0 ? 0 : fileText.split('\n').length;

    let verdict: FileVerdict;
    if (WRITE_TOOL_NAMES.has(name)) {
      const content = str(block.input?.content ?? block.input?.text ?? block.input?.file_text);
      verdict = content ? judgeWrite(fileText, content) : 'ambiguous';
    } else {
      const pairs = replacePairsOf(name, block.input ?? {});
      if (pairs.length === 0) verdict = 'ambiguous';
      else {
        // multiedit 有多对：全部落地才算落地；有一对明确没落地就算没落地
        const vs = pairs.map(([o, n]) => judgeReplace(fileText, o, n));
        verdict = vs.includes('not_landed')
          ? 'not_landed'
          : vs.every(v => v === 'landed')
            ? 'landed'
            : 'ambiguous';
      }
    }

    out.push({ ...base, file: abs, display, verdict, laterModified, lines });
  }

  return out;
}

/** 汇总：给 UI 一行话用的计数 */
export function summarizeEvidence(items: readonly FileEvidence[]): {
  total: number;
  landed: number;
  notLanded: number;
  other: number;
  /** 最该被用户看见的那一句；没有需要提示的返回 null */
  alarm: string | null;
} {
  const landed = items.filter(i => i.verdict === 'landed' || i.verdict === 'landed_then_modified').length;
  const notLanded = items.filter(i => i.verdict === 'not_landed' || i.verdict === 'missing').length;
  const other = items.length - landed - notLanded;
  return {
    total: items.length,
    landed,
    notLanded,
    other,
    alarm: notLanded > 0 ? `${notLanded} 个文件声明已写入，但磁盘上找不到对应内容` : null,
  };
}
