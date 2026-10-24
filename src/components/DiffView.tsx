/**
 * 行级 diff 视图（A96）—— 点开轨迹里的 `+109 -16` 看具体改了哪几行。
 *
 * ## 为什么单独一个组件
 *
 * `AgentTrace` 的展开区原先对文件类工具只显示「路径 + 原始 JSON」，用户能看到
 * `{file_path, old_string, new_string}` 但读不出「到底改了什么」。这一层只做渲染，
 * 数据结构与裁剪算法全在 `shared/trace.ts` 的 `buildDiffHunks()` —— 那边可单测，
 * 这边只管摆位置。两边分开的另一个原因：导出 Markdown 将来也要用同一份 hunk，
 * 不该为了复用去 import 一个 .tsx。
 *
 * ## 为什么用折行而不是横向滚动
 *
 * GitHub 那种横向滚动是为了**精确对齐**同一行代码；这里的场景是「审查 Agent
 * 改了什么」，长行折行更好读，而且省掉了行号列的 sticky 定位（两列 sticky
 * 要分别算 left 偏移，暗色下还要各自补背景，容易出错）。
 * `pre-wrap` 保留缩进与换行，只把超宽行折下来。
 *
 * ## 三种 kind 的视觉
 *
 * - `add` 绿底 + `+`，`del` 红底 + `-`，`context` 无底色（只有行号）
 * - 行号列分「旧 / 新」两栏，`add` 行旧栏留空、`del` 行新栏留空 —— 这是 unified
 *   diff 的通行做法，一眼看出这行在原文件里存不存在
 */

import type { DiffHunk } from '../../shared/trace';

export interface DiffViewProps {
  hunks: readonly DiffHunk[];
}

export function DiffView({ hunks }: DiffViewProps) {
  if (!hunks.length) return null;

  // 全部是 create（write 类工具）：必须如实说明「旧内容不可知」，
  // 否则用户会以为这是一个「只加了没删」的改动。
  const createOnly = hunks.every(h => h.mode === 'create');

  return (
    <div className="tc-diffview" data-diffview={createOnly ? 'create' : 'replace'}>
      {createOnly && (
        <div className="tc-diffview-note" data-diffview-note>
          新建 / 整文件写入 · 工具入参里没有旧内容，只能显示新增
        </div>
      )}
      {hunks.map((hunk, hi) => (
        <div className="tc-diffhunk" key={hi} data-hunk={hi}>
          {hunks.length > 1 && (
            <div className="tc-diffhunk-head" data-hunk-head>
              @@ -{hunk.oldStart} +{hunk.newStart} @@
            </div>
          )}
          {hunk.lines.map((line, li) => (
            <div className={`tc-diffline is-${line.kind}`} key={li} data-kind={line.kind}>
              <span className="tc-diffline-no">{line.oldLine ?? ''}</span>
              <span className="tc-diffline-no">{line.newLine ?? ''}</span>
              <span className="tc-diffline-sign">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
              </span>
              <span className="tc-diffline-text">{line.text || '\u00a0'}</span>
            </div>
          ))}
          {hunk.hidden ? (
            <div className="tc-diffhunk-more" data-hunk-more>
              还有 {hunk.hidden} 行未显示
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
