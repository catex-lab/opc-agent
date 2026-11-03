/**
 * A174：回答正文里的三种「块级」呈现。
 *
 * 这三种块的判定在 `src/answer/renderPlan.ts`（纯逻辑），这里只管画：
 *   · 链接卡网格 —— 连续 ≥3 条同类链接，2×2 等宽网格，整卡可点
 *   · 证据块 —— 命令输出折成单行摘要，可展开
 *   · 代码改动卡 —— 路径 + 行区间 + 增删行数，整卡可点
 *
 * 全部只用 `index.css` 里已有的令牌（`--tc-layer-*` / `--tc-edge` /
 * `--text-*` / `--font-mono`），浅深两套主题同一份样式，不写彩色。
 */
import { useState } from 'react';
import { ArrowUpRight, ChevronDown, FileText, Link2 } from 'lucide-react';
import type { AnswerLinkItem } from '../answer/renderPlan';
import { openAnswerLink } from '../answer/linkRouter';

/** preload 桥（浏览器开发态是 undefined） */
interface WindowBridge {
  openPath?: (path: string) => Promise<string>;
}

function openPathBridge(): WindowBridge['openPath'] {
  return (window as unknown as { opc?: WindowBridge }).opc?.openPath;
}

/** 卡片里的路径是「相对会话 cwd」的，主进程只接受绝对路径 */
function toAbsolutePath(filePath: string, cwd?: string | null): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) return normalized;
  if (!cwd) return null;
  return `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${normalized}`;
}

/* ── 链接卡网格 ──────────────────────────────────────────────────────── */

export function AnswerLinkCards({ items }: { items: AnswerLinkItem[] }) {
  return (
    <div className="tc-answer-links" data-answer-links={items.length}>
      {items.map((item, idx) => (
        <a
          key={`${item.url}#${idx}`}
          className="tc-answer-linkcard"
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          data-answer-link-card
          data-opc-url={item.url}
          onClick={ev => {
            ev.preventDefault();
            ev.stopPropagation();
            void openAnswerLink(item.url);
          }}
        >
          <span className="tc-answer-linkcard-host">
            <Link2 size={11} aria-hidden="true" />
            {item.host}
          </span>
          <span className="tc-answer-linkcard-title">{item.label}</span>
          <span className="tc-answer-linkcard-action">
            打开
            <ArrowUpRight size={11} aria-hidden="true" />
          </span>
        </a>
      ))}
    </div>
  );
}

/* ── 证据块 ──────────────────────────────────────────────────────────── */

export function AnswerEvidence({
  command,
  output,
  lines,
  at,
}: {
  command: string;
  output: string;
  lines: number;
  at?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tc-answer-evidence" data-answer-evidence data-open={open ? '1' : '0'}>
      <button
        type="button"
        className="tc-answer-evidence-head"
        data-answer-evidence-toggle
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <ChevronDown size={13} className="tc-answer-evidence-caret" aria-hidden="true" />
        <span className="tc-answer-evidence-kicker">命令输出</span>
        <span className="tc-answer-evidence-cmd">{command}</span>
        <span className="tc-answer-evidence-meta">
          {at ? `${at} · ` : ''}
          {lines} 行
        </span>
      </button>
      {open ? (
        <pre className="tc-answer-evidence-pre" data-answer-evidence-body>
          {output}
        </pre>
      ) : null}
    </div>
  );
}

/* ── 代码改动卡 ──────────────────────────────────────────────────────── */

export function AnswerCodeCard({
  path: filePath,
  from,
  to,
  added,
  removed,
  note,
  cwd,
}: {
  path: string;
  from: number;
  to: number;
  added: number;
  removed: number;
  note?: string;
  cwd?: string | null;
}) {
  const absolute = toAbsolutePath(filePath, cwd);
  const body = (
    <>
      <FileText size={15} aria-hidden="true" className="tc-answer-codecard-icon" />
      <span className="tc-answer-codecard-main">
        <span className="tc-answer-codecard-path">{filePath}</span>
        <span className="tc-answer-codecard-sub">
          <span className="tc-answer-codecard-range">
            L{from}–L{to}
          </span>
          <span className="tc-answer-codecard-diff">
            <span className="tc-answer-diff-add">+{added}</span>
            <span className="tc-answer-diff-del">−{removed}</span>
          </span>
          {note ? <span className="tc-answer-codecard-note">{note}</span> : null}
        </span>
      </span>
      <ArrowUpRight size={13} aria-hidden="true" className="tc-answer-codecard-arrow" />
    </>
  );

  const shared = {
    className: 'tc-answer-codecard',
    'data-answer-code-card': '1',
    'data-code-path': filePath,
    'data-code-range': `L${from}–L${to}`,
  } as const;

  // 拿不到绝对路径时不做假按钮：样式一致，但没有点击面
  if (!absolute) {
    return (
      <div {...shared} data-code-inert="1">
        {body}
      </div>
    );
  }
  return (
    <button
      {...shared}
      type="button"
      onClick={() => {
        void openPathBridge()?.(absolute);
      }}
    >
      {body}
    </button>
  );
}
