/**
 * 执行轨迹（A36）—— 把一串「工具块 / 思考块」翻译成可读的行。
 *
 * ## 为什么单独一层
 *
 * 渲染层要的是「编辑 SettingsPage.tsx +109 -16」这种**一句话**，而数据层给的是
 * `{ name: 'Edit', input: { file_path, old_string, new_string } }`。这层翻译如果
 * 写在组件里，就会出现三份互相漂移的实现（步骤行、活动摘要、导出 Markdown 各一份），
 * 而且没法单测 —— 所以全部收敛到本文件，组件只负责摆位置。
 *
 * ## 数据从哪来
 *
 * 只有 `ToolBlock.input`。工具是 Agent 子进程执行的，服务端拿不到「写之前的原文」，
 * 所以：
 *   · `edit` 类工具能算**真实**增删（old_string / new_string 都在入参里）
 *   · `write` 只知道写入后的行数（旧文件内容不在入参里），只能报「+N」
 *   · `read` / `delete` 之类压根没有 diff 概念，报 `±0`
 * 三种情况用 `known` 区分，**不编造删除行数**。
 */

import type { Block, ThinkingBlock, ToolBlock } from './blocks';

// ============= 工具语义 =============

/**
 * 轨迹行的三种可见状态 + 一种「说不清」。
 *
 * `interrupted`（结果未回传）与 `error`（失败）必须分开：前者可能还在跑，
 * 后者是确定的坏消息。混成一档之后，界面对「命令挂了」和「命令没回话」
 * 只能给出同一句措辞，用户没法判断该不该重跑。
 */
export type TraceStatus = 'running' | 'done' | 'error' | 'interrupted';

/** 增删行数。`known=false` 表示「没有可靠数据」，UI 据此决定显示 `+N` 还是 `±0` */
export interface TraceDiff {
  added: number;
  removed: number;
  known: boolean;
}

/** 轨迹里的一行：要么是一次工具调用，要么是一段思考 */
export interface TraceItem {
  kind: 'tool' | 'thinking';
  /** React key / DOM 锚点 */
  id: string;
  /** 原始工具名（图标映射用） */
  toolName: string;
  /** 动作词：编辑 / 已读取 / 检查 / 查看 … */
  verb: string;
  /** 主文本：文件名、命令描述、查询词 */
  target: string;
  /** 完整路径（活动摘要按它聚合，也用作 tooltip） */
  path?: string;
  /** 文件类步骤才有 */
  diff?: TraceDiff;
  status: TraceStatus;
  durationMs?: number;
  /** 展开明细用 */
  block?: ToolBlock;
  /** 思考节点原文（`kind='thinking'` 时） */
  thinking?: ThinkingBlock;
  /** 挂在本步骤下面的思考节点（顺序上紧跟在工具之后的那些） */
  nested: TraceItem[];
}

const lower = (name: unknown): string => (typeof name === 'string' ? name.toLowerCase() : '');

/**
 * 「会改动文件」的工具名（小写）。
 *
 * 为什么收敛成一份：这个名字集合原本在 `hasFileEdits` 里写了一份、在
 * `isFileTool` 里写了一份、`diffOf` 里又按名字分支了一遍。A99 的文件核对
 * 还要再用一次 —— 四份副本必然漂移，而漂移的后果是「某个 Agent 的工具
 * 在轨迹里有角标、在核对里被跳过」，用户看到的两个数字对不上。
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write',
  'writefile',
  'create_file',
]);

/** 「按 old/new 替换」类工具（能算出真实增删） */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'edit',
  'editfile',
  'multiedit',
  'str_replace_editor',
]);

/** 只读类：确实没有 diff 概念，但仍属「文件类」步骤（要留 diff 位） */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'readfile', 'delete', 'deletefile']);

/** 取入参里的文件路径（不同 CLI 的字段名不一样） */
export function toolPathOf(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'file', 'target_file']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** 路径 → 文件名（Windows / POSIX 都认） */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * 动作词。
 *
 * 刻意用「已读取」这种完成态措辞：轨迹行绝大多数是**已经发生过**的事，
 * 写成「读取」会让人以为是待执行队列。运行中的状态另有圆点与耗时表达。
 */
function verbOf(name: string, input?: Record<string, unknown>): string {
  if (name === 'write' || name === 'writefile' || name === 'create_file') return '写入';
  if (name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'str_replace_editor') {
    return '编辑';
  }
  if (name === 'read' || name === 'readfile' || name === 'read_file') return '已读取';
  if (name === 'delete' || name === 'deletefile') return '删除';
  if (name === 'bash' || name === 'shell' || name === 'execute') {
    // 跑测试 / 构建 / 类型检查是「检查」，其余是「执行」——
    // 参考图里「检查」这个词专指这类验证动作，混进普通命令会失焦。
    const cmd = typeof input?.command === 'string' ? input.command : '';
    return /\b(test|build|lint|tsc|pytest|typecheck|vitest|jest)\b/i.test(cmd) ? '检查' : '执行';
  }
  if (name === 'websearch') return '搜索';
  if (name === 'webfetch') return '获取';
  if (name === 'search' || name === 'grep' || name === 'glob') return '搜索';
  if (name === 'listdir' || name === 'ls') return '查看';
  if (name === 'skill') return '使用技能';
  if (name === 'imagegen') return '生成图像';
  if (name === 'task') return '执行';
  return '调用';
}

/** 主文本：这一行到底在说「哪个东西」 */
function targetOf(name: string, input?: Record<string, unknown>): string {
  const p = toolPathOf(input);
  if (p) return baseName(p);

  if (name === 'bash' || name === 'shell' || name === 'execute') {
    const desc = typeof input?.description === 'string' ? input.description.trim() : '';
    if (desc) return desc;
    const cmd = typeof input?.command === 'string' ? input.command : '';
    return cmd.split('\n')[0].slice(0, 80) || '命令';
  }
  if (name === 'websearch') {
    return typeof input?.query === 'string' ? input.query.slice(0, 60) : '网页';
  }
  if (name === 'webfetch') {
    const url = typeof input?.url === 'string' ? input.url : '';
    return url.replace(/^https?:\/\//, '').split('?')[0].slice(0, 60) || '网页';
  }
  if (name === 'skill') {
    return typeof input?.skill === 'string' ? input.skill : '技能';
  }
  if (name === 'search' || name === 'grep' || name === 'glob') {
    const q = input?.pattern ?? input?.query;
    return typeof q === 'string' ? q.slice(0, 60) : '内容';
  }
  return '';
}

// ============= diff =============

/**
 * 行级增删统计。
 *
 * 不引 diff 库：这里要的不是补丁本身，只是「几增几删」。掐掉公共前后缀之后
 * 中间那段就是变化区，行数差就是答案 —— 与真正 diff 的统计口径一致，
 * 而代价是 O(n)。
 */
export function lineDiff(oldText: string, newText: string): TraceDiff {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return { added: b.length - head - tail, removed: a.length - head - tail, known: true };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 从入参里推算增删；`undefined` 表示这类工具没有 diff 概念 */
function diffOf(name: string, input?: Record<string, unknown>): TraceDiff | undefined {
  if (!input) return undefined;

  // 编辑类：新旧文本都在入参里 → 真实统计
  if (name === 'edit' || name === 'editfile' || name === 'str_replace_editor') {
    const oldText = str(input.old_string ?? input.old_str ?? input.oldText);
    const newText = str(input.new_string ?? input.new_str ?? input.newText);
    if (oldText || newText) return lineDiff(oldText, newText);
    return { added: 0, removed: 0, known: false };
  }
  if (name === 'multiedit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (edits.length === 0) return { added: 0, removed: 0, known: false };
    return edits.reduce<TraceDiff>(
      (acc, e) => {
        const d = lineDiff(
          str((e as Record<string, unknown>)?.old_string),
          str((e as Record<string, unknown>)?.new_string)
        );
        return { added: acc.added + d.added, removed: acc.removed + d.removed, known: true };
      },
      { added: 0, removed: 0, known: true }
    );
  }

  // 写入：只知道写进去多少行，旧内容不在入参里 → known=false（UI 只显示 +N）
  if (name === 'write' || name === 'writefile' || name === 'create_file') {
    const content = str(input.content ?? input.text ?? input.file_text);
    if (!content) return { added: 0, removed: 0, known: false };
    return { added: content.split('\n').length, removed: 0, known: false };
  }

  // 其余文件类工具：确实没有 diff 数据，报 ±0（用户口径：显示而不是隐藏）
  if (name === 'read' || name === 'readfile' || name === 'delete' || name === 'deletefile') {
    return { added: 0, removed: 0, known: false };
  }

  return undefined;
}

/** 是不是「文件类」步骤（决定要不要留 diff 位） */
function isFileTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name) || EDIT_TOOL_NAMES.has(name) || READ_TOOL_NAMES.has(name);
}

/**
 * 这条回答有没有**改动过文件**（A97）。
 *
 * 只认「写」类工具，不认 read / delete —— 用户要的是「这轮改动能不能跑」，
 * 读过文件不代表动了代码，给它挂一个「未验证」反而会制造噪音。
 */
export function hasFileEdits(blocks: readonly Block[] | undefined | null): boolean {
  if (!blocks) return false;
  // 「写」和「替换」都算改过文件；read / delete 不算（见上方注释）。
  return blocks.some(b => {
    if (b.type !== 'tool') return false;
    const n = lower(b.name);
    return WRITE_TOOL_NAMES.has(n) || EDIT_TOOL_NAMES.has(n);
  });
}

// ============= 块 → 轨迹 =============

function statusOf(b: ToolBlock): TraceStatus {
  if (b.status === 'running' || b.status === 'pending') return 'running';
  if (b.status === 'interrupted') return 'interrupted';
  if (b.status === 'failed' || b.isError) return 'error';
  return 'done';
}

/** 工具块 → 一行 */
export function toolItem(block: ToolBlock): TraceItem {
  const name = lower(block.name);
  return {
    kind: 'tool',
    id: block.toolId || block.id,
    toolName: name,
    verb: verbOf(name, block.input),
    target: targetOf(name, block.input),
    path: toolPathOf(block.input),
    diff: isFileTool(name) ? diffOf(name, block.input) : undefined,
    status: statusOf(block),
    durationMs:
      block.startedAt && block.endedAt ? Math.max(0, block.endedAt - block.startedAt) : undefined,
    block,
    nested: [],
  };
}

/** 思考块 → 一行 */
export function thinkingItem(block: ThinkingBlock): TraceItem {
  return {
    kind: 'thinking',
    id: block.id,
    toolName: 'thinking',
    verb: '深度思考',
    target: '',
    status: block.state === 'streaming' ? 'running' : 'done',
    durationMs:
      block.startedAt && block.endedAt ? Math.max(0, block.endedAt - block.startedAt) : undefined,
    thinking: block,
    nested: [],
  };
}

/**
 * 连续的「工具 / 思考」块 → 一条轨迹。
 *
 * 思考块紧跟在某个工具后面时**挂到那个工具下面**（参考图里的缩进节点），
 * 开头的思考块没有可挂的父级，就自己占一行。这样既保住了顺序，
 * 又不会让「思考」和「编辑」在同一层抢位置。
 */
export function buildTrace(blocks: readonly Block[]): TraceItem[] {
  const items: TraceItem[] = [];
  for (const b of blocks) {
    if (b.type === 'thinking') {
      const node = thinkingItem(b);
      const last = items[items.length - 1];
      if (last && last.kind === 'tool') last.nested.push(node);
      else items.push(node);
    } else if (b.type === 'tool') {
      items.push(toolItem(b));
    }
  }
  return items;
}

// ============= 活动摘要 =============

export interface TraceSummary {
  /** 「查看文件、修改：SettingsPage.tsx」 */
  text: string;
  /** 去重后的动作词，按出现顺序 */
  verbs: string[];
  /** 去重后的文件名，按出现顺序 */
  files: string[];
  diff: { added: number; removed: number };
}

/**
 * 把整条轨迹压成一句话。
 *
 * 参考图那行 `查看文件、修改：SettingsPage.tsx` 的信息密度很高：动词说「干了什么」，
 * 冒号后说「动在哪」。这里保持同一结构，文件多于 2 个时折成「等 N 个文件」——
 * 一行放不下五个文件名，硬塞会把行高撑成两行，反而比折叠更难扫。
 */
export function summarizeTrace(items: readonly TraceItem[]): TraceSummary {
  const verbs: string[] = [];
  const files: string[] = [];
  let added = 0;
  let removed = 0;

  const walk = (list: readonly TraceItem[]) => {
    for (const it of list) {
      if (it.kind === 'tool') {
        if (!verbs.includes(it.verb)) verbs.push(it.verb);
        if (it.path) {
          const name = baseName(it.path);
          if (!files.includes(name)) files.push(name);
        }
        if (it.diff) {
          added += it.diff.added;
          removed += it.diff.removed;
        }
      }
      if (it.nested.length) walk(it.nested);
    }
  };
  walk(items);

  const verbsText = verbs.slice(0, 3).join('、') + (verbs.length > 3 ? ' 等' : '');
  const filesText = files.length
    ? files.slice(0, 2).join('、') + (files.length > 2 ? ` 等 ${files.length} 个文件` : '')
    : '';

  return {
    text: filesText ? `${verbsText}：${filesText}` : verbsText,
    verbs,
    files,
    diff: { added, removed },
  };
}

// ============= 时长文案 =============

/** 单步耗时：<1s 用毫秒，其余一位小数 */
export function formatStepDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 本轮总耗时（头部「已处理 47m42s」）。
 *
 * 与单步不同，这里要**进位到分钟**：47 分钟写成 2862.4s 没人读得下去。
 * 超过一分钟省掉秒的小数（47m42s），超过一小时再进位到小时（1h02m）。
 */
export function formatHandledDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${(ms / 1000).toFixed(1)}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}m${s}s` : `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/**
 * 后台任务：本轮已经结束，但工具调用没有拿到结果的那些。
 *
 * 这不是「造一个概念」——它就是真实存在的一种状态：CLI 在工具还没回结果时
 * 就结束了这一轮（用户中止、进程退出、适配器漏发 tool_result）。这些调用
 * 确实还在（或已经卡在）后台，界面上必须说清楚，否则用户看到的是一个
 * 永远转圈的圆点。判定只依赖块数据，刷新后仍然成立。
 *
 * A125 起 `RunProjector.finish()` 会把这类工具标成 `interrupted` 而不是
 * 伪造 `completed`，所以这里必须把 `interrupted` 一并算进来 —— 否则
 * 「修好了终态」的代价是「胶囊永远消失」，等于用一个假数据换掉另一个。
 * 仍在 running/pending 的也算（老数据、以及还没经过 finish 的实时快照）。
 */
export function lingeringToolBlocks(blocks: readonly Block[], runFinished: boolean): ToolBlock[] {
  if (!runFinished) return [];
  return blocks.filter(
    (b): b is ToolBlock =>
      b.type === 'tool' &&
      (b.status === 'running' || b.status === 'pending' || b.status === 'interrupted') &&
      // 老数据（legacyToBlocks / contentBlocks）的 startedAt 是 0 —— 那些块根本
      // 没有时间戳，`running` 只说明「当年没记完成状态」，不代表现在还在跑。
      // 不排掉的话，用户历史上任何一条被中止的老消息都会变成一颗
      // 永远消不掉的后台任务胶囊。
      b.startedAt > 0
  );
}

// ============= 行级 diff（A96） =============

/**
 * 把工具入参还原成**可渲染的**行级 diff。
 *
 * ## 与 `lineDiff` 的关系（必须保持一致）
 *
 * 角标上那个 `+109 -16` 由 `lineDiff()` 算出，展开后的内容由本函数生成 ——
 * 两者**必须用同一套口径**，否则用户会看到「角标写 +3，展开却有 20 行绿色」。
 * 所以这里复用完全相同的 head/tail 裁剪算法：相同的行算上下文，中间的
 * 旧行算删除、新行算新增。`+N` 就是新增段的长度，`-M` 就是删除段的长度。
 *
 * ## 为什么不做真正的 LCS
 *
 * LCS 会在改动段内部再对齐相同的行（Git 的行为），对「审查 Agent 改了什么」
 * 收益有限，代价是 O(n²) 且要处理大量边界。当前 Agent 的 Edit 基本是
 * 「替换一小段」，head/tail 裁剪已经能准确圈出变化区。
 * 真正需要逐行对齐的场景是「整个文件重写」，而那种情况走的是 `write`，
 * 入参里根本没有旧内容 —— 再怎么算也只能是「全部新增」。
 *
 * ## 三种工具的差异
 *
 * | 工具 | 入参里有旧内容 | 能给出 |
 * |---|---|---|
 * | `edit` / `multiedit` | 有（old_string） | 完整的 +/- |
 * | `write` | 没有 | 只有 +（`mode='create'`，UI 要如实标注） |
 * | 其余 | 无 | `null`，退回原来的 JSON 展示 |
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 旧文件行号；`add` 行没有 */
  oldLine?: number;
  /** 新文件行号；`del` 行没有 */
  newLine?: number;
}

export interface DiffHunk {
  /** 改动块在旧文件中的起始行（1 基）；`mode='create'` 时为 0 */
  oldStart: number;
  /** 改动块在新文件中的起始行（1 基） */
  newStart: number;
  lines: DiffLine[];
  /** 因超长被截掉的行数（0 / 未定义 = 完整展示） */
  hidden?: number;
  /**
   * `replace` = 新旧都在，能看出改了什么；
   * `create` = 只有新内容（旧内容不在入参里），**不能假装知道删了什么**
   */
  mode: 'replace' | 'create';
}

/** 改动块前后各保留几行上下文 */
const DIFF_CONTEXT = 3;
/** 单个块最多渲染多少行，超出截断（防整文件重写把对话撑爆） */
const DIFF_MAX_LINES = 240;

/** 单块的裁剪 + 组装。算法与 `lineDiff()` 逐字一致。 */
function hunkOf(oldText: string, newText: string): DiffHunk {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const ctxHead = Math.min(head, DIFF_CONTEXT);
  const ctxTail = Math.min(tail, DIFF_CONTEXT);
  const delEnd = a.length - tail;
  const addEnd = b.length - tail;

  const lines: DiffLine[] = [];
  for (let i = head - ctxHead; i < head; i += 1) {
    lines.push({ kind: 'context', text: a[i], oldLine: i + 1, newLine: i + 1 });
  }
  for (let i = head; i < delEnd; i += 1) {
    lines.push({ kind: 'del', text: a[i], oldLine: i + 1 });
  }
  for (let i = head; i < addEnd; i += 1) {
    lines.push({ kind: 'add', text: b[i], newLine: i + 1 });
  }
  for (let i = 0; i < ctxTail; i += 1) {
    const oi = a.length - tail + i;
    const ni = b.length - tail + i;
    lines.push({ kind: 'context', text: a[oi], oldLine: oi + 1, newLine: ni + 1 });
  }

  let hidden = 0;
  if (lines.length > DIFF_MAX_LINES) {
    hidden = lines.length - DIFF_MAX_LINES;
    lines.length = DIFF_MAX_LINES;
  }

  return {
    oldStart: Math.max(1, head - ctxHead + 1),
    newStart: Math.max(1, head - ctxHead + 1),
    lines,
    hidden: hidden || undefined,
    mode: 'replace',
  };
}

/** `write` 类：只有写入后的内容，全部算新增 */
function createHunk(content: string): DiffHunk {
  const all = content.split('\n');
  const lines: DiffLine[] = all.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 }));
  let hidden = 0;
  if (lines.length > DIFF_MAX_LINES) {
    hidden = lines.length - DIFF_MAX_LINES;
    lines.length = DIFF_MAX_LINES;
  }
  return { oldStart: 0, newStart: 1, lines, hidden: hidden || undefined, mode: 'create' };
}

/**
 * 从工具名与入参构建 diff 块。
 * 返回 `null` 表示「这个工具没有可展示的 diff」，调用方应退回原来的明细渲染。
 */
export function buildDiffHunks(
  toolName: string,
  input?: Record<string, unknown>
): DiffHunk[] | null {
  if (!input) return null;
  const name = lower(toolName);

  if (name === 'edit' || name === 'editfile' || name === 'str_replace_editor') {
    const oldText = str(input.old_string ?? input.old_str ?? input.oldText);
    const newText = str(input.new_string ?? input.new_str ?? input.newText);
    if (!oldText && !newText) return null;
    return [hunkOf(oldText, newText)];
  }

  if (name === 'multiedit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const hunks = edits
      .map(e => {
        const r = (e ?? {}) as Record<string, unknown>;
        return hunkOf(str(r.old_string), str(r.new_string));
      })
      .filter(h => h.lines.length > 0);
    return hunks.length ? hunks : null;
  }

  if (name === 'write' || name === 'writefile' || name === 'create_file') {
    const content = str(input.content ?? input.text ?? input.file_text);
    if (!content) return null;
    return [createHunk(content)];
  }

  return null;
}
