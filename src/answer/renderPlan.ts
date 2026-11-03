/**
 * 回答内容分级渲染（A174）—— 纯计划层。
 *
 * 这一层**不做 Markdown 解析**：它只按「整行」这种最粗的边界把答案切成
 * `md` / `links` / `evidence` / `coderef` 四种片段。`md` 片段仍然原样交给
 * ChatMarkdown（Cherry），所以语法、代码块、表格这些能力一个都没丢；
 * 新加的三种卡片只是把**本来就自成一块**的内容换成更紧凑的呈现。
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

export type AnswerSegment =
  | { kind: 'md'; text: string }
  | { kind: 'links'; items: AnswerLinkItem[] }
  | { kind: 'evidence'; command: string; output: string; lines: number }
  | {
      kind: 'coderef';
      path: string;
      from: number;
      to: number;
      added: number;
      removed: number;
      note?: string;
    };

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

    // ② 连续整行链接
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

    // ③ 代码改动卡
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

/** 只给 UI 用的聚合值：一条答案里有多少个可点的外部链接（闸门断言用） */
export function countHttpLinks(segments: AnswerSegment[]): number {
  let n = 0;
  for (const seg of segments) {
    if (seg.kind === 'links') n += seg.items.length;
    else if (seg.kind === 'md') {
      const re = /\]\(\s*(?:<)?(https?:\/\/[^)\s>]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(seg.text))) if (sanitizeHttpUrl(m[1])) n++;
    }
  }
  return n;
}
