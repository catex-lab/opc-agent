/**
 * 回答内容分级渲染（A174）—— 纯计划层。
 *
 * 这一层**不做 Markdown 解析**：它只按「整行」这种最粗的边界把答案切成
 * `md` / `links` / `evidence` / `table` / `coderef` 五种片段。`md` 片段仍然
 * 原样交给 ChatMarkdown（Cherry），所以语法、代码块这些能力一个都没丢；
 * 新加的四种卡片只是把**本来就自成一块**的内容换成更紧凑的呈现。
 *
 * 表格是唯一的例外 —— 它必须被解析成行列才能做吸顶、对齐与折叠，因此
 * 这里实现了一个**严格受限**的 GFM 表解析（必须有分隔行、至少两列、至少
 * 一行数据）。任何不满足这些条件的 `|` 文本都原样留在 markdown。
 *
 * 之所以坚持行级切分而不是解析 AST：Cherry 的解析结果在 web component 的
 * shadow DOM 里，外部拿不到节点；而卡片必须由 React 渲染（要可展开、要可点）。
 * 行级切分的好处是永远切在段落边界上，不会把一句话拆成两半。
 *
 * 所有判定都是**确定性前缀/整行匹配**，不猜语义：
 *   1. 证据块：```evidence / console / shell / bash / sh 围栏，且首行是 `$ 命令`
 *   2. 链接卡：连续 ≥3 行「整行就是一个链接」（可带 - / * / 1. 前缀）
 *   3. 代码改动卡：整行形如 `path L128–L176 +42 −7`
 *   4. 推测标签：行内 `[推测]`，由装饰层（linkDecor）处理，不在这一层
 *
 * 流式期间只把「已经确定闭合」的块转成卡片（围栏要有收尾、链接组后面要有
 * 非链接行），否则保持 markdown —— 避免流到一半突然从句子变成卡片。
 */

export interface AnswerLinkItem {
  /** 已规范化（URL.toString()）的 http(s) 地址 */
  url: string;
  /** 卡片标题；纯链接行没有标题时退化成 URL 本身 */
  label: string;
  /** 域名（含端口），11px 等宽那一行用 */
  host: string;
}

export type TableAlign = 'left' | 'center' | 'right';

export type AnswerTableSegment = {
  kind: 'table';
  /** 表头单元格（原始行内文本，渲染层再处理强调/链接） */
  header: string[];
  /** 已按表头列数补齐/截断的数据行 */
  rows: string[][];
  /** 最终对齐：显式分隔符优先，未写则数值列右对齐、其余左对齐 */
  align: TableAlign[];
  /** 该列是否为数值列（用于 data 锚点与图表判定，不代表对齐方式） */
  numeric: boolean[];
};

export type AnswerSegment =
  | { kind: 'md'; text: string }
  | { kind: 'links'; items: AnswerLinkItem[] }
  | { kind: 'evidence'; command: string; output: string; lines: number }
  | AnswerTableSegment
  | {
      kind: 'coderef';
      path: string;
      from: number;
      to: number;
      added: number;
      removed: number;
      note?: string;
    };

/** 表格卡折叠阈值：超过这么多行就折起来，由「展开全部 N 行」收盘。 */
export const MAX_TABLE_ROWS = 8;

/** 数值列判定：非空单元格里至少这个比例能被解析成数字 */
const NUMERIC_RATIO = 0.8;

/** 只放行 http/https。`javascript:` / `data:` / `file:` 一律返回 null。 */
export function sanitizeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  // 控制字符 / 换行会让 URL 解析结果和显示文本对不上，直接拒
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** `- [标题](url)` / `1. <url>` / 裸 URL —— 整行必须只有一个链接。 */
const LINE_PREFIX = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;

export function parseLinkLine(line: string): AnswerLinkItem | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const body = trimmed.replace(LINE_PREFIX, '').trim();
  if (!body || body.length > 2048) return null;

  let label: string | null = null;
  let raw: string | null = null;

  const mdLink = /^\[([^\]]+)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)$/.exec(body);
  if (mdLink) {
    label = mdLink[1];
    raw = mdLink[2].replace(/^<|>$/g, '');
  } else {
    const angle = /^<(https?:\/\/[^>]+)>$/i.exec(body);
    if (angle) {
      raw = angle[1];
    } else if (/^https?:\/\/\S+$/i.test(body)) {
      raw = body;
    }
  }

  if (!raw) return null;
  const url = sanitizeHttpUrl(raw);
  if (!url) return null;
  // 标题里可能带强调符号，卡片标题要干净文本
  const clean = (label ?? '').replace(/\*\*/g, '').replace(/\[|\]/g, '').trim() || url;
  return { url, label: clean, host: hostOf(url) };
}

/** `路径 L128–L176 +42 −7`（路径可带反引号；区间与改动数可选但有就解析） */
const CODE_REF = /^`?([A-Za-z0-9_@./\\:-]+\.[A-Za-z0-9]{1,8})`?\s+L(\d+)\s*[–—–-]\s*L?(\d+)\s*\+\s*(\d+)\s*[−–-]\s*(\d+)(?:\s+(\S.*))?$/;

export function parseCodeRefLine(line: string):
  | (Omit<Extract<AnswerSegment, { kind: 'coderef' }>, 'kind'> & { kind: 'coderef' })
  | null {
  const m = CODE_REF.exec(line.trim());
  if (!m) return null;
  const from = Number(m[2]);
  const to = Number(m[3]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return {
    kind: 'coderef',
    path: m[1],
    from,
    to,
    added: Number(m[4]),
    removed: Number(m[5]),
    note: m[6]?.trim() || undefined,
  };
}

/* ══════════════ 表格（GFM） ══════════════
 *
 * 只认「表头行 + 分隔行 + 至少一行数据」的标准 GFM 表；其它带 `|` 的普通
 * 段落一律留在 markdown（误判会把用户的句子吞进表格）。分隔行是硬闸门：
 * 它必须**整行**都是 `:?-+:?` 形态，普通文本极难撞上。
 */

const DELIM_CELL = /^:?-{1,}:?$/;

/** 按 GFM 规则切单元格：支持 `\|` 转义，首尾竖线可有可无。 */
export function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  let body = trimmed;
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let buf = '';
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (ch === '\\' && body[k + 1] === '|') {
      buf += '|';
      k += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

/** 只接受「纯数字」形态：千分位、百分号、货币前缀、正负号、小数。
 *  带单位（`12ms`）不算 —— 单位不同无法比较，右对齐意义也就没了。 */
export function parseNumericCell(raw: string): number | null {
  const t = raw.replace(/`/g, '').trim();
  if (!t) return null;
  const m = /^(?:[¥$€]\s*)?([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)(?:\s*%)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 渲染层用的纯文本：去掉行内强调/反引号，保留可见字符 */
export function plainCellText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*?)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

function isNumericColumn(rows: string[][], col: number): boolean {
  let filled = 0;
  let numeric = 0;
  for (const row of rows) {
    const cell = row[col] ?? '';
    if (!cell.trim()) continue;
    filled += 1;
    if (parseNumericCell(cell) !== null) numeric += 1;
  }
  return filled > 0 && numeric / filled >= NUMERIC_RATIO;
}

export interface ParsedTable {
  header: string[];
  rows: string[][];
  align: TableAlign[];
  numeric: boolean[];
  /** 表格结束后的下一行下标（不含空行） */
  next: number;
  /** 表格是否已经确定结束（后面还有别的内容）。流式末尾未结束就不转卡。 */
  terminated: boolean;
}

export function parseTableBlock(lines: string[], start: number): ParsedTable | null {
  const headLine = lines[start];
  const delimLine = lines[start + 1];
  if (headLine === undefined || delimLine === undefined) return null;
  const header = splitTableRow(headLine);
  const delim = splitTableRow(delimLine);
  if (!header || !delim) return null;
  // 单列表格不认：那是「带竖线的段落」，不是表格
  if (header.length < 2 || delim.length !== header.length) return null;
  if (!delim.every(cell => DELIM_CELL.test(cell))) return null;

  const explicit = delim.map<TableAlign | null>(cell =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null,
  );

  const rows: string[][] = [];
  let j = start + 2;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim()) break;
    const cells = splitTableRow(line);
    if (!cells || cells.length < 2) break;
    // 按表头列数补齐/截断，渲染层不用再关心列数不一致
    const normalized = cells.slice(0, header.length);
    while (normalized.length < header.length) normalized.push('');
    rows.push(normalized);
  }
  // 只有表头没有数据行 → 不当表格卡（渲染出来是一块空壳）
  if (rows.length === 0) return null;

  const numeric = header.map((_, col) => isNumericColumn(rows, col));
  const align = explicit.map<TableAlign>((a, col) => a ?? (numeric[col] ? 'right' : 'left'));
  return { header, rows, align, numeric, next: j, terminated: j < lines.length };
}

export interface AnswerChartData {
  labelHeader: string;
  valueHeader: string;
  max: number;
  rows: Array<{ label: string; value: number; text: string }>;
}

/**
 * 表格驱动的图表候选：**只有**「两列、第二列全是非负数值、至少 3 行」才画。
 *
 * 这是 A174 图表的收敛口径 —— 不引入 mermaid（那是 1.5 MB+ 的渲染器依赖，
 * 还要拖 d3 与联网加载），而是把「标签 + 数值」这种最常见的对比表直接画成
 * 横向条形。任何一条不满足就返回 null，渲染层回退到普通表格卡。
 */
export function chartOf(table: AnswerTableSegment): AnswerChartData | null {
  if (table.header.length !== 2 || table.rows.length < 3) return null;
  if (!table.numeric[1]) return null;
  const rows: AnswerChartData['rows'] = [];
  for (const row of table.rows) {
    const value = parseNumericCell(row[1] ?? '');
    if (value === null || value < 0) return null;
    rows.push({ label: plainCellText(row[0] ?? ''), value, text: plainCellText(row[1] ?? '') });
  }
  const max = Math.max(...rows.map(r => r.value));
  if (max <= 0) return null;
  return {
    labelHeader: plainCellText(table.header[0]),
    valueHeader: plainCellText(table.header[1]),
    max,
    rows,
  };
}

const EVIDENCE_INFO = new Set(['evidence', 'console', 'shell', 'bash', 'sh']);

function isFenceLine(line: string): { marker: string; size: number; info: string } | null {
  const m = /^\s*(`{3,}|~{3,})([^\s`]*)\s*$/.exec(line);
  if (!m) return null;
  return { marker: m[1][0].repeat(m[1].length), size: m[1].length, info: m[2].toLowerCase() };
}

function isClosingFence(line: string, marker: string, size: number): boolean {
  // 收尾围栏至少与开头等长（CommonMark），且不能带 info
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  if (!m) return false;
  return m[1][0] === marker[0] && m[1].length >= size;
}

function countLines(body: string): number {
  if (!body) return 0;
  return body.split('\n').length;
}

export function planAnswer(text: string, opts: { streaming?: boolean } = {}): AnswerSegment[] {
  const streaming = !!opts.streaming;
  const lines = text.split('\n');
  const out: AnswerSegment[] = [];
  let md: string[] = [];

  const flushMd = () => {
    if (!md.length) return;
    const joined = md.join('\n');
    md = [];
    if (!joined.trim()) return;
    // 合并到上一个 md 片段，减少 ChatMarkdown 实例（否则每个空行都会切一刀）
    const last = out[out.length - 1];
    if (last && last.kind === 'md') last.text = `${last.text}\n${joined}`;
    else out.push({ kind: 'md', text: joined });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ① 围栏块：只有「命令 + 输出」形态才转证据，其它一律留给 markdown
    const fence = isFenceLine(line);
    if (fence) {
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (isClosingFence(lines[j], fence.marker, fence.size)) {
          closed = true;
          break;
        }
      }
      const body = lines.slice(i + 1, closed ? j : lines.length);
      const isEvidence =
        closed &&
        EVIDENCE_INFO.has(fence.info) &&
        body.length > 1 &&
        /^\s*\$ /.test(body[0] ?? '');
      if (isEvidence) {
        flushMd();
        const output = body
          .slice(1)
          .join('\n')
          .replace(/[ \t\n]+$/, '');
        out.push({
          kind: 'evidence',
          command: body[0].replace(/^\s*\$ /, '').trim(),
          output,
          lines: countLines(output),
        });
        i = j + 1;
        continue;
      }
      if (!closed && streaming) {
        // 还没收尾：整段留在 markdown，等闭合再说
        md.push(...lines.slice(i));
        i = lines.length;
        continue;
      }
      md.push(...lines.slice(i, closed ? j + 1 : lines.length));
      i = closed ? j + 1 : lines.length;
      continue;
    }

    // ② GFM 表格 → 表格卡（或表格驱动的图表卡）
    const table = parseTableBlock(lines, i);
    if (table) {
      // 流式期间表格还在往下长：先留 markdown，等它确定结束再换卡，
      // 否则每来一行都会「表格卡 → markdown → 表格卡」闪一次。
      if (!table.terminated && streaming) {
        md.push(...lines.slice(i));
        i = lines.length;
        continue;
      }
      flushMd();
      out.push({ kind: 'table', header: table.header, rows: table.rows, align: table.align, numeric: table.numeric });
      i = table.next;
      continue;
    }

    // ③ 连续整行链接
    const head = parseLinkLine(line);
    if (head) {
      let j = i;
      const items: AnswerLinkItem[] = [];
      while (j < lines.length) {
        const parsed = parseLinkLine(lines[j]);
        if (!parsed) break;
        items.push(parsed);
        j++;
      }
      const terminated = j < lines.length;
      if (items.length >= 3 && (terminated || !streaming)) {
        flushMd();
        out.push({ kind: 'links', items });
        i = j;
        continue;
      }
      // 少于 3 条：保持行内链接（markdown 原样）
      md.push(...lines.slice(i, j));
      i = j;
      continue;
    }

    // ④ 代码改动卡
    const ref = parseCodeRefLine(line);
    if (ref) {
      flushMd();
      out.push(ref);
      i++;
      continue;
    }

    md.push(line);
    i++;
  }

  flushMd();
  return out;
}

/** 单元格里的可用链接数：`[标题](http…)` 与裸 URL 都算，伪协议不计。
 *  与渲染层 `renderCell` 的识别口径一致（那边同样把裸 http(s) 变成可点面）。 */
function countCellLinks(cell: string): number {
  const re = /\[[^\]]+\]\(\s*(<[^>]+>|https?:\/\/[^)\s>]+)\s*\)|https?:\/\/[^\s`|<>()]+/gi;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell))) {
    const raw = (m[1] ?? m[0]).replace(/^<|>$/g, '').replace(/[.,;:!?，。；：！？]+$/, '');
    if (sanitizeHttpUrl(raw)) n += 1;
  }
  return n;
}

/** 只给 UI 用的聚合值：一条答案里有多少个可点的外部链接（闸门断言用） */
export function countHttpLinks(segments: AnswerSegment[]): number {
  let n = 0;
  for (const seg of segments) {
    if (seg.kind === 'links') n += seg.items.length;
    else if (seg.kind === 'table') {
      for (const cell of [...seg.header, ...seg.rows.flat()]) n += countCellLinks(cell);
    } else if (seg.kind === 'md') {
      const re = /\]\(\s*(?:<)?(https?:\/\/[^)\s>]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(seg.text))) if (sanitizeHttpUrl(m[1])) n++;
    }
  }
  return n;
}
