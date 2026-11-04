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
import { useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, FileText, Link2 } from 'lucide-react';
import type { AnswerChartData, AnswerLinkItem, AnswerTableSegment, TableAlign } from '../answer/renderPlan';
import { MAX_TABLE_ROWS, sanitizeHttpUrl } from '../answer/renderPlan';
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

/* ── 表格卡 ──────────────────────────────────────────────────────────── */
/*
 * 单元格里的行内语法只做三件事：链接 / 反引号 / 粗体。这不是「再造一个
 * markdown 解析器」—— 表格本来就只由这几种行内元素构成，其余字符一律按
 * 纯文本交给 React 转义，因此**不存在 HTML 注入面**（没有 innerHTML）。
 * 单元格里的链接与正文行内链接走同一个 `openAnswerLink`（含协议白名单）。
 */

function renderCell(raw: string): ReactNode[] {
  // 末尾的裸 URL 也要给可点面：表格里贴文档地址很常见，退化成纯文本等于
  // 比正文少一种能力。伪协议没有对应的分支，因此不会出现可点面。
  const token = /\[([^\]]+)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s`|<>()]+)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(raw))) {
    if (m.index > last) nodes.push(raw.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      // 只放行 http/https；伪协议退化成纯文本，不给可点面
      const url = sanitizeHttpUrl(m[2].replace(/^<|>$/g, ''));
      nodes.push(
        url ? (
          <a
            key={key++}
            className="tc-answer-table-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-opc-url={url}
            onClick={ev => {
              ev.preventDefault();
              ev.stopPropagation();
              void openAnswerLink(url);
            }}
          >
            {m[1]}
          </a>
        ) : (
          m[1]
        ),
      );
    } else if (m[3] !== undefined) {
      nodes.push(
        <code key={key++} className="tc-answer-table-code">
          {m[3]}
        </code>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(<strong key={key++}>{m[4]}</strong>);
    } else if (m[5] !== undefined) {
      const trail = /[.,;:!?，。；：！？]+$/.exec(m[5])?.[0] ?? '';
      const visible = trail ? m[5].slice(0, -trail.length) : m[5];
      const url = sanitizeHttpUrl(visible);
      if (url) {
        nodes.push(
          <a
            key={key++}
            className="tc-answer-table-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-opc-url={url}
            onClick={ev => {
              ev.preventDefault();
              ev.stopPropagation();
              void openAnswerLink(url);
            }}
          >
            {visible}
          </a>,
        );
        if (trail) nodes.push(trail);
      } else {
        nodes.push(m[5]);
      }
    } else {
      nodes.push(m[0]);
    }
  }
  if (last < raw.length) nodes.push(raw.slice(last));
  return nodes;
}

function alignOf(align: TableAlign): TableAlign {
  return align === 'right' || align === 'center' ? align : 'left';
}

export function AnswerTableCard({ table }: { table: AnswerTableSegment }) {
  const [expanded, setExpanded] = useState(false);
  const foldable = table.rows.length > MAX_TABLE_ROWS;
  const folded = foldable && !expanded;
  const visible = folded ? table.rows.slice(0, MAX_TABLE_ROWS) : table.rows;

  return (
    <div
      className="tc-answer-table"
      data-answer-table
      data-table-rows={table.rows.length}
      data-table-visible={visible.length}
      data-table-folded={folded ? '1' : '0'}
    >
      <div className="tc-answer-table-scroll" data-answer-table-scroll>
        <table>
          <thead data-answer-table-head>
            <tr>
              {table.header.map((cell, ci) => (
                <th key={ci} data-align={alignOf(table.align[ci])} data-numeric={table.numeric[ci] ? '1' : '0'}>
                  {renderCell(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    data-align={alignOf(table.align[ci])}
                    data-numeric={table.numeric[ci] ? '1' : '0'}
                    data-first-col={ci === 0 ? '1' : undefined}
                  >
                    {renderCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {foldable ? (
        <button
          type="button"
          className="tc-answer-table-fold"
          data-answer-table-fold
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
        >
          <ChevronDown size={13} aria-hidden="true" className="tc-answer-table-fold-caret" />
          {expanded ? '收起' : `展开全部 ${table.rows.length} 行`}
        </button>
      ) : null}
    </div>
  );
}

/* ── 图表卡（表格驱动的横条对比） ────────────────────────────────────── */

export function AnswerChartCard({ table, chart }: { table: AnswerTableSegment; chart: AnswerChartData }) {
  const [showData, setShowData] = useState(false);
  return (
    <div className="tc-answer-chart" data-answer-chart data-chart-rows={chart.rows.length}>
      <div className="tc-answer-chart-head">
        <span className="tc-answer-chart-head-label" data-chart-label-header>
          {chart.labelHeader}
        </span>
        <span className="tc-answer-chart-head-value" data-chart-value-header>
          {chart.valueHeader}
        </span>
      </div>
      <div className="tc-answer-chart-body">
        {chart.rows.map((row, idx) => (
          <div className="tc-answer-chart-row" key={idx} data-chart-row>
            <span className="tc-answer-chart-label" title={row.label}>
              {row.label}
            </span>
            <span className="tc-answer-chart-track">
              <span
                className="tc-answer-chart-bar"
                data-chart-bar
                data-chart-value={row.value}
                style={{ width: `${(row.value / chart.max) * 100}%` }}
              />
            </span>
            <span className="tc-answer-chart-value">{row.text}</span>
          </div>
        ))}
      </div>
      {/* 图表不是「唯一形态」：随时能看回原始表格（回退路径） */}
      <button
        type="button"
        className="tc-answer-chart-toggle"
        data-answer-chart-toggle
        aria-expanded={showData}
        onClick={() => setShowData(v => !v)}
      >
        <ChevronDown size={13} aria-hidden="true" className="tc-answer-chart-caret" />
        {showData ? '收起表格' : `查看表格（${table.rows.length} 行）`}
      </button>
      {showData ? <AnswerTableCard table={table} /> : null}
    </div>
  );
}
