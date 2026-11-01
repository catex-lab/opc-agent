/**
 * 技能正文的归一化（P1）。
 *
 * ## 为什么归一化对象是「路径」而不是方案里写的「工具名」
 *
 * PLAN-EXTENSIONS.md §8.1 说「`ui-ux-pro-max` 里 `Read` 出现 14 次，这些是
 * Claude 的工具名，换到 qoder 就没有同名工具」。**2026-11-01 实测推翻了这个前提**：
 *
 * | 统计口径（57~65 个 SKILL.md） | 结果 |
 * |---|---|
 * | 精确大小写 `\bRead\b` | **6 次**，全是普通英语：`Read-only state` / `Read the Room` / `Read these signals first` |
 * | `\bTask\b` | 7 次，全是表格列名 `\| Task \| Sub-skill \|` 与 `Task Progress:` |
 * | `\bEdit\b` | 6 次，全是普通动词 `Edit docs/brand-guidelines.md` |
 * | 反引号包裹 `` `Read` `` | **0 次** |
 * | 「`Read` 工具」形态 | **0 次** |
 *
 * 方案里的「14 次」应该是大小写不敏感统计（把 `readable` / `read-only` 都算进去了）。
 * 如果照它做「工具名 → 动作描述」的替换，会把 `Read-only state` 改成
 * `读取-only state`、把表格列名 `Task` 改成 `派生子任务` —— **是在破坏正文**。
 *
 * 真正挡住「一份技能大家用」的是**写死的家目录绝对路径**：
 *
 * | 形态 | 实测命中 |
 * |---|---|
 * | `~/.claude/skills/...` | **121 处** |
 * | `~/.qoder` / `~/.gemini` / `~/.cursor` … | **64 处** |
 *
 * 样本：`python3 ~/.claude/skills/design/scripts/logo/search.py "…"` ——
 * 同一份技能被复制到 15 个目录，每份都写死自己那一份的绝对路径。
 * 这正是「为什么必须存 15 份副本」的根因：路径写死，换个位置就错。
 *
 * 所以本模块做两件事，**顺序与保守程度不同**：
 * 1. 家目录路径 → 占位符（主菜，有 185 处真实命中）
 * 2. 工具名引用 → 通用称谓（`读取工具` 这类；**只认反引号包裹与「X 工具」两种
 *    明确形态**，本机 0 命中；留着是为了将来别的技能真的这么写时能处理，
 *    而不会误伤 `Read-only` 这类普通英语）
 *
 * ## 归一化结果**不自动应用**
 *
 * 本模块只产出 `{ text, hits }`，落库由调用方在用户确认后做（见 store 的
 * `applyNormalized`）。`{{SKILL_DIR}}` 这类占位符**需要分发层替换成目标 Agent
 * 的实际路径**才可用 —— P1 只做「规范形态 + 给人看 diff」，替换是 P3 的事。
 */

/** 自己那份技能目录的占位符（分发时替换成目标 Agent 里该技能的目录） */
export const SKILL_DIR_TOKEN = '{{SKILL_DIR}}';
/** 技能根目录的占位符（引用**别的**技能时用） */
export const SKILLS_ROOT_TOKEN = '{{SKILLS_ROOT}}';

export type NormalizeRule = 'home-path' | 'tool-name';

export interface NormalizeHit {
  rule: NormalizeRule;
  /** 在原文中的字符偏移（含） */
  start: number;
  /** 字符偏移（不含） */
  end: number;
  /** 原文片段 */
  before: string;
  /** 归一化后片段 */
  after: string;
  /** 1-based 行号，给 diff 视图定位用 */
  line: number;
}

export interface NormalizeResult {
  /** 有没有任何变化 */
  changed: boolean;
  /** 归一化后的全文（没变化时等于原文） */
  text: string;
  /** 逐条命中，按位置升序 */
  hits: NormalizeHit[];
  /** 每类命中数，给界面显示「路径 12 处 / 工具名 0 处」 */
  summary: Record<NormalizeRule, number>;
}

/**
 * 工具名 → **通用称谓**（`读取工具` / `命令执行工具` …）。
 *
 * **只用于「明确是工具引用」的形态**（反引号包裹 / 后跟「工具」二字），
 * 不做全局单词替换 —— 理由见文件头：`Read-only`、`Task` 列名会被改坏。
 *
 * 值必须自带「工具」二字，且替换时**连原文的「工具」一起吃掉**（见
 * `TOOL_QUOTED_RE`）。两条合起来才既通顺又幂等：
 * - `` `Read` 工具读取文件 `` → `读取工具读取文件`（吃「工具」+ 值带「工具」= 只留一个）
 * - `` `Read` 读取文件 ``      → `读取工具读取文件`（裸反引号形态也补上「工具」）
 *
 * 只给动作词（`读取`）会得到「用 读取读取文件」这种半截替换 —— 2026-11-01 的
 * A166 首版就是这么错的，闸门两条一起红在「多/少一个空格」上。
 */
const TOOL_TERMS: Record<string, string> = {
  Read: '读取工具',
  Write: '写入工具',
  Edit: '编辑工具',
  MultiEdit: '批量编辑工具',
  NotebookEdit: '笔记本编辑工具',
  Bash: '命令执行工具',
  Grep: '搜索工具',
  Glob: '文件查找工具',
  WebFetch: '网页抓取工具',
  WebSearch: '网页搜索工具',
  Task: '子任务工具',
  TodoWrite: '任务清单工具',
  LS: '目录列举工具',
};

const TOOL_NAMES = Object.keys(TOOL_TERMS).join('|');

/**
 * 各家 Agent 的技能根目录前缀。
 *
 * 一条正则覆盖全部（PLAN §8.2 的「不维护 15 张对照表」—— 这里真的做到了一张）。
 * 路径分隔符同时认 `\` 与 `/`：Windows 上的技能正文两种写法都出现过。
 */
const HOME_SKILLS_RE = new RegExp(
  `~[\\\\/]\\.(${[
    'claude',
    'agents',
    'qoder',
    'qoder-cn',
    'gemini',
    'cursor',
    'codex',
    'kilocode',
    'workbuddy',
    'zcode',
    'hermes',
    'pi',
    'antigravity',
  ].join('|')})[\\\\/]skills[\\\\/]([A-Za-z0-9._-]+)[\\\\/]`,
  'g'
);

/** 反引号包裹的工具名：`` `Read` `` / `` `Read` 工具 ``（**连「工具」一起吃掉**，
 *  否则会得到「用 读取工具 工具读取文件」这种叠字） */
const TOOL_QUOTED_RE = new RegExp('`(' + TOOL_NAMES + ')`(?:\\s*工具)?', 'g');
/** 裸写 + 「工具」二字：`Read 工具`（**不匹配**单独的 `Read`） */
const TOOL_WORD_RE = new RegExp('\\b(' + TOOL_NAMES + ')\\s+工具', 'g');

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * 归一化一段技能正文。
 *
 * `skillName` 是这条技能自己的名字（目录名 / frontmatter.name）。
 * 它决定路径命中替换成 `{{SKILL_DIR}}`（自己的目录）还是
 * `{{SKILLS_ROOT}}/<别的技能名>`（引用别人的技能）—— 这两者分发时的
 * 替换规则不同，不能混成一个。
 */
export function normalizeSkillBody(body: string, skillName: string): NormalizeResult {
  const hits: NormalizeHit[] = [];

  // ① 家目录路径（主菜）
  HOME_SKILLS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HOME_SKILLS_RE.exec(body)) !== null) {
    const raw = m[0];
    const otherName = m[2];
    const after =
      otherName === skillName ? SKILL_DIR_TOKEN + '/' : `${SKILLS_ROOT_TOKEN}/${otherName}/`;
    hits.push({
      rule: 'home-path',
      start: m.index,
      end: m.index + raw.length,
      before: raw,
      after,
      line: lineOf(body, m.index),
    });
    // 零宽匹配保护（本正则不可能零宽，留着防以后改坏）
    if (m.index === HOME_SKILLS_RE.lastIndex) HOME_SKILLS_RE.lastIndex += 1;
  }

  // ② 反引号包裹的工具名
  TOOL_QUOTED_RE.lastIndex = 0;
  while ((m = TOOL_QUOTED_RE.exec(body)) !== null) {
    const raw = m[0];
    hits.push({
      rule: 'tool-name',
      start: m.index,
      end: m.index + raw.length,
      before: raw,
      after: TOOL_TERMS[m[1]] ?? m[1],
      line: lineOf(body, m.index),
    });
  }

  // ③ 裸写 + 「工具」
  TOOL_WORD_RE.lastIndex = 0;
  while ((m = TOOL_WORD_RE.exec(body)) !== null) {
    const raw = m[0];
    hits.push({
      rule: 'tool-name',
      start: m.index,
      end: m.index + raw.length,
      before: raw,
      after: TOOL_TERMS[m[1]] ?? m[1],
      line: lineOf(body, m.index),
    });
  }

  hits.sort((a, b) => a.start - b.start);

  const summary: Record<NormalizeRule, number> = { 'home-path': 0, 'tool-name': 0 };
  for (const h of hits) summary[h.rule] += 1;

  if (hits.length === 0) {
    return { changed: false, text: body, hits, summary };
  }

  return { changed: true, text: applyHits(body, hits), hits, summary };
}

/**
 * 按命中替换。`selected` 为空表示全部。
 *
 * **从后往前替换**：先替换前面的会把后面命中的偏移全部推后，
 * 那样 `start/end` 就失效了（这类 bug 表现为「只有第一处对，后面错位」）。
 */
export function applyHits(
  body: string,
  hits: readonly NormalizeHit[],
  selected?: readonly number[]
): string {
  const keep = selected ? new Set(selected) : null;
  const list = hits
    .map((h, i) => ({ h, i }))
    .filter(x => (keep ? keep.has(x.i) : true))
    .sort((a, b) => b.h.start - a.h.start);
  let out = body;
  for (const { h } of list) {
    out = out.slice(0, h.start) + h.after + out.slice(h.end);
  }
  return out;
}
