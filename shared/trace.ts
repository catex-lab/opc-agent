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
 * 「验证类命令」词表：shell 工具的 command 命中其中之一即视为 verify 步骤。
 *
 * 为什么收敛成一份：阶段条（groupPhases）的 verify 归类与 `verbOf` 的
 * 「检查」动词必须**同一口径**——否则会出现「动词写着『执行』、阶段条
 * 却把它染成验证段」的错位。用户的口径：跑测试/lint/构建/类型检查才算
 * 验证；`ls`、启动 dev server 这类普通命令不是验证。
 */
export const VERIFY_CMD_RE = /\b(test|tests|build|lint|tsc|pytest|typecheck|vitest|jest)\b/i;
/** 这是不是一次 shell 调用（bash / shell / execute） */
function isShellTool(name: string): boolean {
  return name === 'bash' || name === 'shell' || name === 'execute';
}

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
    // 词表与阶段条共用（VERIFY_CMD_RE），两处口径不许漂移。
    const cmd = typeof input?.command === 'string' ? input.command : '';
    return VERIFY_CMD_RE.test(cmd) ? '检查' : '执行';
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
  if (name === 'task') {
    // 子代理容器：目标行显示任务描述（参考页「改主题模块」），没有才回退命令
    const desc = typeof input?.description === 'string' ? input.description.trim() : '';
    if (desc) return desc;
    const task = typeof input?.task === 'string' ? input.task.trim() : '';
    if (task) return task;
    return '子任务';
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

  // 其余文件类工具：确实没有 diff 数据，报 ±0（既定口径：显示而不是隐藏）
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

// ============= 阶段条（阶段分组） =============

/**
 * 过程流的四个阶段（参考用户给的单聊过程流设计稿）：
 *   understand 理解（读/搜/看）→ change 修改（编辑/写入）→
 *   verify 验证（跑测试/构建/lint）→ fix 修复（验证失败之后的修改）
 */
export type FlowPhaseKind = 'understand' | 'change' | 'verify' | 'fix';

export interface FlowPhase {
  kind: FlowPhaseKind;
  /** 段内工具步骤数（思考块不占步） */
  steps: number;
  /** 段起点（epoch ms）。缺省 = 老数据没有时间戳（UI 退化为等宽分段） */
  startMs?: number;
  /** 段终点。缺省 = 段仍在进行（运行中）或没有时间戳 */
  endMs?: number;
  /** 段内真实增删行数（只累计 known 的 diff，不编造） */
  added: number;
  removed: number;
  /** 段内是否有失败的工具（verify 段据此染红） */
  failed: boolean;
}

/**
 * 单个轨迹步骤属于哪个阶段。返回 null = 不参与阶段（思考块）。
 *
 * 分类口径（用户定版，顺序即优先级）：
 *   1. 会改文件的工具（EDIT / WRITE）→ change；
 *   2. shell 工具且命令命中验证词表 → verify；其余 shell 命令（ls、启动服务等）
 *      是普通执行 → understand；
 *   3. 其余（读 / 搜 / 看目录 / 网络）→ understand。
 */
export function classifyFlowPhase(item: TraceItem): FlowPhaseKind | null {
  if (item.kind !== 'tool') return null;
  const name = item.toolName;
  if (WRITE_TOOL_NAMES.has(name) || EDIT_TOOL_NAMES.has(name)) return 'change';
  if (isShellTool(name)) {
    const cmd = typeof item.block?.input?.command === 'string' ? item.block.input.command : '';
    return VERIFY_CMD_RE.test(cmd) ? 'verify' : 'understand';
  }
  return 'understand';
}

/**
 * 扁平的轨迹步骤 → 连续阶段段。
 *
 * ## 状态机（fix 的归属）
 *
 * 「verify 失败之后的修改归为 fix」不是看局部，而是看**到目前为止**有没有
 * 一次失败且未被收复的验证：
 *   - verify 步骤报错 → 进入「待修复」状态，此后的 edit/write 都归 fix；
 *   - verify 步骤通过 → 复位，此后的 edit/write 回到 change；
 *   - verify 还在跑 → 不下结论，维持现状（等结果落地）。
 *
 * ## 合并
 *
 * 连续同类合并成一段（思考/旁白不占段，插在两个同段工具之间不打断合并——
 * 阶段条上没有它们的位置，时间上它们本来也落在两步之间的缝隙里）。
 * 段的起止 = 段内最早 startedAt → 最晚 endedAt；段尾还在跑 → endMs 缺省。
 */
export function groupPhases(items: readonly TraceItem[]): FlowPhase[] {
  const phases: FlowPhase[] = [];
  let afterFailedVerify = false;

  for (const item of items) {
    const base = classifyFlowPhase(item);
    if (!base) continue;

    const kind: FlowPhaseKind = base === 'change' && afterFailedVerify ? 'fix' : base;

    if (base === 'verify') {
      if (item.status === 'error') afterFailedVerify = true;
      else if (item.status === 'done') afterFailedVerify = false;
    }

    const startedAt = item.block?.startedAt ?? 0;
    const endedAt = item.block?.endedAt ?? 0;
    // TraceStatus 没有 pending 档（那只是 ToolBlockStatus 的方言），这里统一按 running 处理
    const running = item.status === 'running';
    const last = phases[phases.length - 1];

    if (last && last.kind === kind) {
      last.steps += 1;
      last.failed = last.failed || item.status === 'error';
      if (item.diff?.known) {
        last.added += item.diff.added;
        last.removed += item.diff.removed;
      }
      if (startedAt > 0 && (last.startMs === undefined || startedAt < last.startMs)) {
        last.startMs = startedAt;
      }
      if (endedAt > 0) {
        last.endMs = Math.max(last.endMs ?? 0, endedAt);
      } else if (running) {
        // 段尾还没回结果：段保持「进行中」（endMs 缺省），不能拿旧值冒充终点
        last.endMs = undefined;
      }
    } else {
      phases.push({
        kind,
        steps: 1,
        startMs: startedAt > 0 ? startedAt : undefined,
        endMs: endedAt > 0 ? endedAt : undefined,
        added: item.diff?.known ? item.diff.added : 0,
        removed: item.diff?.known ? item.diff.removed : 0,
        failed: item.status === 'error',
      });
    }
  }
  return phases;
}

// ============= 容器模型（子代理 / 群聊 Agent，2026-11-22） =============

/**
 * 过程流里的**容器**：子代理（ToolBlock name === 'task'，含 Claude 的 Task 工具）
 * 或群聊里某个 Agent 的一次 turn。子步骤 = parentToolId === 容器 toolId 的块。
 * 老数据没有 parentToolId → 没有容器，全部平铺（向后兼容）。
 */
export interface FlowNode {
  /** 容器工具块的 toolId（或群聊 turn 的 id） */
  id: string;
  /** 容器名：子代理 = 任务描述，群聊 = Agent 名 */
  name: string;
  /** 容器下的叶子步骤 */
  children: TraceItem[];
  /** 容器行自身的状态（由孩子推导） */
  status: 'running' | 'done' | 'error' | 'interrupted';
  startedAt?: number;
  endedAt?: number;
  /** 是否有任一孩子在 running */
  running: boolean;
}

/**
 * 从工具步骤推导容器 + 平铺剩余。
 *
 * 规则（2026-11-22 方案）：
 *   · name === 'task' 的 ToolBlock = 容器；
 *   · parentToolId === 该容器 toolId 的块 = 子步骤（叶子，不参与顶层摘要的
 *     失败计数；容器失败不重复计入「重试次数」）；
 *   · 其他块平铺。
 * 并行判断：同一时间（起止时间窗重叠）有多个容器在 running → 并行。
 */
export function deriveFlowNodes(
  items: readonly TraceItem[]
): { nodes: FlowNode[]; leaves: TraceItem[] } {
  const byId = new Map<string, TraceItem>();
  const parents = new Map<string, TraceItem[]>();

  for (const it of items) {
    if (it.kind !== 'tool') continue;
    if (it.toolName === 'task' && it.block) {
      byId.set(it.block.toolId, it);
    }
    const parentId = it.block?.parentToolId;
    if (parentId) {
      const arr = parents.get(parentId) ?? [];
      arr.push(it);
      parents.set(parentId, arr);
    }
  }

  const nodes: FlowNode[] = [];
  const leaves: TraceItem[] = [];
  const seen = new Set<string>();

  for (const [pid, kids] of parents) {
    const container = byId.get(pid);
    if (!container) {
      // 父找不到（老数据/断链）→ 子步骤平铺
      leaves.push(...kids);
      continue;
    }
    seen.add(container.block!.toolId);
    const st = container.block!.startedAt || 0;
    const en = container.block!.endedAt || 0;
    nodes.push({
      id: container.block!.toolId,
      name: container.target || container.block!.name || '子代理',
      children: kids,
      status: kids.some(k => k.status === 'error')
        ? 'error'
        : kids.some(k => k.status === 'running')
          ? 'running'
          : kids.some(k => k.status === 'interrupted')
            ? 'interrupted'
            : 'done',
      startedAt: st > 0 ? st : undefined,
      endedAt: en > 0 ? en : undefined,
      running: kids.some(k => k.status === 'running'),
    });
  }

  // 顶层平铺：非容器的块 + 没有成为任何孩子的容器
  for (const it of items) {
    if (it.kind !== 'tool') {
      leaves.push(it);
      continue;
    }
    const pid = it.block?.parentToolId;
    if (pid && parents.has(pid)) continue; // 已在 children 里
    if (
      it.toolName === 'task' &&
      it.block &&
      byId.has(it.block.toolId) &&
      !seen.has(it.block.toolId)
    ) {
      // 容器没有孩子 → 还是平铺（空容器不值得占一层）
      leaves.push(it);
      continue;
    }
    if (it.toolName === 'task' && seen.has(it.block!.toolId)) continue; // 容器行由 nodes 表达
    leaves.push(it);
  }

  return { nodes, leaves };
}

/** 是否并行：同一时间有 ≥2 个容器的时间窗重叠（不管是否还活着，重叠即并行） */
export function hasParallelContainers(nodes: readonly FlowNode[]): boolean {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (a.startedAt === undefined || b.startedAt === undefined) return true;
      const aEnd = a.endedAt ?? Infinity;
      const bEnd = b.endedAt ?? Infinity;
      if (aEnd >= b.startedAt && bEnd >= a.startedAt) return true;
    }
  }
  return false;
}

// ============= 活动摘要 =============

/** F1：会写盘的动词 —— 摘要里算作「改了 N 个文件」的那一档 */
const EDIT_VERBS = ['编辑', '写入', '删除'];

export interface TraceSummary {
  /** 「改了 1 个文件 · 成功」 */
  text: string;
  /** 去重后的动作词，按出现顺序 */
  verbs: string[];
  /** 去重后的文件名，按出现顺序 */
  files: string[];
  /** 摘要里「改了 N 个文件」那部分用到的文件（界面按语言重排这句话） */
  editedFiles: string[];
  /** 结果档位：界面层用它与 `text` 等价的 i18n 文案 */
  outcome: 'running' | 'error' | 'interrupted' | 'ok';
  /**
   * 重试口径（2026-11-21）：最后一次失败之后有通过的验证时 > 0，
   * 值 = 被收复的失败步数。界面据此把「成功」升级成「成功 · 重试 N 次」。
   */
  retries: number;
  diff: { added: number; removed: number };
}

/**
 * 把整条轨迹压成一句话。
 *
 * F1 之前的写法是**动作清单**（`编辑、已读取、检查：SettingsPage.tsx`）：
 * 用户要读完这句、再在脑子里做一次推理，才能得出「这轮到底成没成」。
 * 现在改成**结果语义**：`改了 1 个文件 · 成功` / `读完 2 个文件 · 成功` ——
 * 动词退到「改 / 读」两档，宾语换成数量，句尾直接给结论；
 * 具体改了哪个文件、跑了什么命令，都在下一层的步骤列表里（没有丢）。
 *
 * 结果词的口径（2026-11-21 重试口径修订）：
 *   · 还在跑 → 「进行中」，绝不提前说成功；
 *   · **中间失败、但最后一次失败之后有一次通过的验证 → 「成功 · 重试 N 次」**。
 *     以前按最坏情况报「失败」——修好了却顶着红字，和事实不符；
 *     N = 被后续验证收复的失败步骤数。
 *   · 收复之后又有没回传结果的步骤 → 落回「结果未回传」，不谎称成功；
 *   · 确实没修好（最后一次失败之后没有通过的验证）→ 「失败」。
 */
export function summarizeTrace(items: readonly TraceItem[]): TraceSummary {
  const verbs: string[] = [];
  const files: string[] = [];
  const editedFiles: string[] = [];
  let added = 0;
  let removed = 0;
  let hasError = false;
  let hasRunning = false;
  let hasInterrupted = false;
  /** 按出现顺序收集的工具步骤（重试口径要的是顺序，不是有无） */
  const toolSeq: TraceItem[] = [];

  const walk = (list: readonly TraceItem[]) => {
    for (const it of list) {
      if (it.kind === 'tool') {
        if (!verbs.includes(it.verb)) verbs.push(it.verb);
        if (it.status === 'error') hasError = true;
        if (it.status === 'running') hasRunning = true;
        if (it.status === 'interrupted') hasInterrupted = true;
        toolSeq.push(it);
        if (it.path) {
          const name = baseName(it.path);
          if (!files.includes(name)) files.push(name);
          // 「改了」只算真的会写盘的动作；读了同一个文件不算改了它。
          if (EDIT_VERBS.includes(it.verb) && !editedFiles.includes(name)) {
            editedFiles.push(name);
          }
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

  // ── 重试口径：失败 → 修复 → 验证通过 ─────────────────────────────
  let lastErrorIdx = -1;
  let lastPassVerifyIdx = -1;
  toolSeq.forEach((t, i) => {
    if (t.status === 'error') {
      lastErrorIdx = i;
      return;
    }
    if (
      t.status === 'done' &&
      isShellTool(t.toolName) &&
      VERIFY_CMD_RE.test(typeof t.block?.input?.command === 'string' ? t.block.input.command : '')
    ) {
      lastPassVerifyIdx = i;
    }
  });
  /** 最后一次失败之后有通过的验证 = 失败已被收复 */
  const recovered = lastErrorIdx >= 0 && lastPassVerifyIdx > lastErrorIdx;
  /** 收复之后又出现没回传结果的步骤：结尾状态是「未回传」，不是成功 */
  const unreturnedAfterRecovery =
    recovered && toolSeq.some((t, i) => t.status === 'interrupted' && i > lastPassVerifyIdx);
  /** 被收复的失败次数 = 最后那次通过的验证之前的失败步数 */
  const retries = recovered
    ? toolSeq.filter((t, i) => t.status === 'error' && i < lastPassVerifyIdx).length
    : 0;
  const outcomeOkRetried = recovered && !unreturnedAfterRecovery && !hasRunning;

  const verbsText = verbs.slice(0, 3).join('、') + (verbs.length > 3 ? ' 等' : '');
  const outcomeText = hasRunning
    ? '进行中'
    : outcomeOkRetried
      ? `成功${retries > 0 ? ` · 重试 ${retries} 次` : ''}`
      : // 收复之后又出现未回传步骤：结尾状态是「未回传」，不能拿更早的失败盖成「失败」，
        // 也不能谎称成功——这一档必须排在 hasError 之前
        unreturnedAfterRecovery
        ? '结果未回传'
        : hasError
          ? '失败'
          : hasInterrupted
            ? '结果未回传'
            : '成功';

  // 有了「改」就不再提「读」：改文件前必然读过它，两个数一起说反而要用户自己减。
  const head = editedFiles.length
    ? `改了 ${editedFiles.length} 个文件`
    : files.length
      ? `读完 ${files.length} 个文件`
      : verbsText;

  return {
    text: head ? `${head} · ${outcomeText}` : outcomeText,
    verbs,
    files,
    editedFiles,
    outcome: hasRunning
      ? 'running'
      : outcomeOkRetried
        ? 'ok'
        : unreturnedAfterRecovery
          ? 'interrupted'
          : hasError
            ? 'error'
            : hasInterrupted
              ? 'interrupted'
              : 'ok',
    retries,
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
 * 本轮总耗时（头部「已处理 47m42s」），**en/中性口径**。
 *
 * 与单步不同，这里要**进位到分钟**：47 分钟写成 2862.4s 没人读得下去。
 * 超过一分钟省掉秒的小数（47m42s），超过一小时再进位到小时（1h02m）。
 * 2026-11-20：分钟以内不再带小数（63.7s → 64s）—— 用户口径「不满 1 分钟
 * 按秒计」；一位小数是另一个口径，留着会让人以为是两种数据。
 */
export function formatHandledDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
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
 * 本轮总耗时，**按语言出文案**（2026-11-20 统一口径，用户拍板）：
 *
 *   zh：<1 分钟 → 「N 秒」；≥1 分钟 → 「M 分 S 秒」（整分 → 「M 分钟」）；
 *       ≥1 小时 → 「H 小时 M 分钟」（整点 → 「H 小时」）。
 *   en：走 formatHandledDuration（32s / 47m42s / 1h02m）。
 *
 * 全站唯一的回合耗时文案出口 —— 消息头部、状态行定格、用量小字都必须走
 * 这里，不许再各自手搓（之前「63.7s」「已处理 8 分钟」「用时 480 秒」
 * 三种口径并存，就是三处各写各的后果）。
 */
export function formatHandledDurationText(ms: number | undefined, locale: 'zh' | 'en'): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  if (locale !== 'zh') return formatHandledDuration(ms);
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
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
