/**
 * 更新说明的极简 Markdown 解析（只覆盖 Release 说明实际会用到的语法）。
 *
 * 为什么需要它：GitHub Release 正文是 Markdown，更新清单里的 `notes` 也是
 * 同一份原文。旧实现把整段文本直接塞进 `<p>` + `white-space: pre-wrap`，
 * 结果 `## 修复`、`- **加粗**`、行内代码全按字面显示，连从别处带进来的
 * 转义反斜杠（`\*`、`\#`）也原样露出来。
 *
 * 这里只做三件事：去掉转义反斜杠、按块（标题 / 列表 / 段落）切分、按行内
 * （加粗 / 行内代码）切分。不引入任何依赖，也不做 HTML 注入 —— 输出是结构化
 * 数据，由 React 生成元素，链接与图片一律当纯文本。
 */

export type NotesInlineKind = 'text' | 'bold' | 'code';

export interface NotesInline {
  kind: NotesInlineKind;
  text: string;
}

export type NotesBlock =
  | { kind: 'heading'; level: number; inlines: NotesInline[] }
  | { kind: 'bullet'; inlines: NotesInline[] }
  | { kind: 'paragraph'; inlines: NotesInline[] };

/** Markdown 里「反斜杠 + 标点」是转义写法：`\*\*加粗\*\*` 其实想写 `**加粗**` */
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!|>~])/g;

export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPED, '$1');
}

function isCjk(ch: string): boolean {
  return /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
}

/** 中文排版习惯：手动折行的两段中文拼回去时不能塞空格 */
function joinLines(parts: string[]): string {
  return parts.reduce((acc, cur) => {
    if (!acc) return cur;
    const a = acc[acc.length - 1];
    const b = cur[0] || '';
    return acc + (isCjk(a) || isCjk(b) ? '' : ' ') + cur;
  }, '');
}

export function parseInline(text: string): NotesInline[] {
  const out: NotesInline[] = [];
  let buf = '';
  const flush = (): void => {
    if (!buf) return;
    const last = out[out.length - 1];
    if (last && last.kind === 'text') last.text += buf;
    else out.push({ kind: 'text', text: buf });
    buf = '';
  };
  const push = (kind: NotesInlineKind, value: string): void => {
    flush();
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += value;
    else out.push({ kind, text: value });
  };

  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        push('code', text.slice(i + 1, end).trim());
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        const inner = text.slice(i + 2, end).trim();
        if (inner) {
          push('bold', inner);
          i = end + 2;
          continue;
        }
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out.filter(t => t.text.length > 0);
}

export function parseUpdateNotes(markdown: string): NotesBlock[] {
  const lines = unescapeMarkdown(markdown.replace(/\r\n?/g, '\n')).split('\n');
  const blocks: NotesBlock[] = [];
  // 每个列表项保留原始 Markdown 行：续行要拼回去重新解析，不能拿已去掉
  // `**` / 反引号的纯文本再拼（那样会把加粗与代码降级成普通文字）。
  const rawByBlock = new Map<NotesBlock, string[]>();
  let paragraph: string[] = [];
  const closeParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', inlines: parseInline(joinLines(paragraph)) });
    paragraph = [];
  };
  const appendToLast = (text: string): void => {
    const last = blocks[blocks.length - 1];
    const raw = last ? rawByBlock.get(last) : undefined;
    if (!last || last.kind === 'heading' || !raw) {
      paragraph.push(text);
      return;
    }
    raw.push(text);
    last.inlines = parseInline(joinLines(raw));
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      closeParagraph();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInline(heading[2].trim()) });
      continue;
    }
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      closeParagraph();
      const text = bullet[1].trim();
      const block: NotesBlock = { kind: 'bullet', inlines: parseInline(text) };
      blocks.push(block);
      rawByBlock.set(block, [text]);
      continue;
    }
    // 续行：Release 说明里折行的段落 / 列表项都带缩进，拼回上一条，别拆成新段
    if (/^\s{2,}\S/.test(line) && blocks.length) {
      appendToLast(line.trim());
      continue;
    }
    paragraph.push(line.trim());
  }
  closeParagraph();
  return blocks;
}
