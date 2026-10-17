/**
 * 群聊编排引擎。
 *
 * 五种模式共用同一套「让某个 Agent 就某段 prompt 发言」的原语（deps.runAgent），
 * 差别只在**谁发言、发言顺序、以及每人的 prompt 怎么拼**。所以这里不碰
 * SSE、不碰数据库 —— 那些由 index.ts 的 /api/group-chat 提供实现，
 * 本文件只负责「编排决策」，因此可以单独测试。
 *
 * ## 一个重要的取舍：群聊不做上下文续接
 *
 * 一对一里我们用 resumeToken 让 CLI 续接自己的会话。群聊**刻意不用**：
 * 同一个群里有多个 Agent，每个 Agent 的上下文来源不同（接力要上一棒的输出、
 * 辩论要对方的论点），这些依赖都被显式写进了 prompt。再叠加一层各 Agent
 * 自己的隐式上下文，反而会出现「它记得的和它被告知的互相矛盾」。
 * 显式传参更好推理，也更好调试。
 */

export type OrchestrationMode = 'dispatch' | 'broadcast' | 'relay' | 'debate' | 'mention';

/** 某个 turn 在编排里扮演的角色，前端据此做差异化展示（如折叠「路由」过程） */
export type TurnPhase =
  | 'route'      // dispatch：主控判断该谁做
  | 'work'       // dispatch：被选中的 Agent 执行
  | 'summary'    // dispatch：主控汇总
  | 'broadcast'  // broadcast：各自作答
  | 'relay'      // relay：第 N 棒
  | 'debate'     // debate：某一轮发言
  | 'converge'   // debate：最终收敛
  | 'mention';   // mention：被 @ 唤醒

/**
 * 「内部阶段」——这些 turn 的输出是编排的决策管道，不是给用户看的对话内容。
 *
 * 主控在 route 阶段的原文形如 `ROUTE: opencode`，把它当消息渲染出来只会变成噪音
 * （用户想读的是 narration：`主控决定交给 OpenCode`）。所以内部阶段：
 *   - 不发送 turn_start / turn_done（否则前端会为它建一个气泡）
 *   - 不落库（刷新后不该看到一句没头没尾的 ROUTE:）
 *
 * 注意这是**协议契约**：P3-3 群聊 UI 依赖这个约定，不要单方面改某一侧。
 */
export const INTERNAL_PHASES: readonly TurnPhase[] = ['route'];

export function isInternalPhase(phase: TurnPhase): boolean {
  return INTERNAL_PHASES.includes(phase);
}

export interface AgentTurnResult {
  /** 该 Agent 这一轮的正文输出 */
  text: string;
  /** 失败原因。有值时 text 可能为空 */
  error?: string;
}

export interface OrchestratorDeps {
  /**
   * 让某个 Agent 就给定 prompt 发言。
   * 实现方负责：转发 SSE（带上 agentId）、落库、聚合正文并返回。
   */
  runAgent(
    agentId: string,
    prompt: string,
    phase: TurnPhase,
    round?: number
  ): Promise<AgentTurnResult>;

  /** 输出一条编排说明，前端以系统提示样式展示（如「主控决定交给 Codex」） */
  note(text: string): void;

  /** Agent 展示名，用于拼提示文案 */
  displayName(agentId: string): string;

  /** 该 Agent 当前是否可调用；不可用的会被排除在编排之外 */
  isUsable(agentId: string): boolean;
}

/** 辩论默认轮数：正反各说几轮。2 轮足以暴露分歧，再多用户读不动。 */
export const DEBATE_ROUNDS = 2;

/** 转义正则元字符，避免 Agent id 里的符号破坏正则 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从用户输入里解析出被 @ 的成员。
 *
 * 同时匹配 Agent id 与展示名（用户更可能写「@小码」而不是「@codex」），忽略大小写。
 *
 * 末尾的负向断言 `(?![\w-])` 是为了避免 `@code` 误命中 `@codex` —— 这是最典型的错配。
 *
 * ★ 这里**刻意不把中日韩字符算进断言**。最初的写法是 `(?![\w\u4e00-\u9fa5])`，
 *   结果 `@codex和@code` 只能识别出 `code`：因为 `@codex` 后面跟着 `和`，
 *   被当成了「标识符还没结束」。但中文里 `和`/`的`/`吗` 都是独立词，
 *   和 ASCII 标识符的延续字符完全不是一回事。JS 的 `\w` 本就只含
 *   `[A-Za-z0-9_]`，不再额外排除 CJK 才是对的。
 */
export function extractMentioned(
  prompt: string,
  members: string[],
  displayName: (id: string) => string
): string[] {
  const hit: string[] = [];
  for (const id of members) {
    const aliases = [id, displayName(id)].filter((v): v is string => !!v && v.trim() !== '');
    for (const alias of aliases) {
      const re = new RegExp(`@\\s*${escapeRegExp(alias)}(?![\\w-])`, 'i');
      if (re.test(prompt)) {
        hit.push(id);
        break;
      }
    }
  }
  return hit;
}

/**
 * 从主控的回复里解析出它选了谁。
 *
 * 三级降级，因为这是在解析 LLM 的自由输出 —— 不能假设它严格守格式：
 *   1. 找显式标记 `ROUTE: <id>`
 *   2. 在候选 id 里找被整体提到的（词边界）
 *   3. 按展示名匹配
 * 都失败返回 null，由调用方决定兜底策略。
 */
export function parseRouting(
  reply: string,
  candidates: string[],
  displayName: (id: string) => string
): string | null {
  const explicit = reply.match(/ROUTE\s*[:：]\s*([\w.-]+)/i);
  if (explicit) {
    const v = explicit[1].toLowerCase();
    const exact = candidates.find(c => c.toLowerCase() === v);
    if (exact) return exact;
  }

  for (const c of candidates) {
    if (new RegExp(`(^|[^\\w-])${escapeRegExp(c)}([^\\w-]|$)`, 'i').test(reply)) return c;
  }

  for (const c of candidates) {
    const name = displayName(c);
    if (name && reply.includes(name)) return c;
  }

  return null;
}

// ============= 各模式的提示词 =============

function memberList(ids: string[], displayName: (id: string) => string): string {
  return ids.map(id => `- ${id}（${displayName(id)}）`).join('\n');
}

function routePrompt(task: string, candidates: string[], displayName: (id: string) => string): string {
  return [
    '你是一个多 Agent 团队的主控，负责判断任务该交给谁。',
    '',
    `用户的任务：「${task}」`,
    '',
    '当前可调度的成员：',
    memberList(candidates, displayName),
    '',
    '请判断这个任务最适合交给谁。只输出一行，格式严格为：',
    'ROUTE: <成员id>',
    '不要输出任何其它内容。',
  ].join('\n');
}

function summaryPrompt(task: string, workerName: string, workText: string): string {
  return [
    `用户的任务是：「${task}」`,
    '',
    `${workerName} 完成后的结果是：`,
    workText || '（无输出）',
    '',
    '请基于以上结果给用户一个简洁的汇总答复：提炼要点与结论，不要重复原文，也不要再补充新任务。',
  ].join('\n');
}

function relayPrompt(
  task: string,
  index: number,
  total: number,
  prevName: string | null,
  prevText: string
): string {
  const head = `这是接力任务的第 ${index + 1}/${total} 棒。原始任务：「${task}」`;
  if (!prevName) return `${head}\n\n请你先完成你这一棒。`;
  return [
    head,
    '',
    `上一棒 ${prevName} 的输出：`,
    prevText || '（无输出）',
    '',
    '请在此基础上继续推进，给出你这一棒的产出。不要重复上一棒已完成的内容。',
  ].join('\n');
}

function debateOpenPrompt(topic: string, side: '正方' | '反方'): string {
  return [
    `你是${side}。辩题：「${topic}」`,
    '',
    `请给出你方的核心论点与论据，控制在 3 点以内。`,
  ].join('\n');
}

function debateRebuttalPrompt(
  topic: string,
  side: '正方' | '反方',
  opponentName: string,
  opponentText: string
): string {
  return [
    `你是${side}。辩题：「${topic}」`,
    '',
    `对方（${opponentName}）刚刚说：`,
    opponentText || '（无输出）',
    '',
    '请针对性反驳，并补充你方的新论据。控制在 3 点以内。',
  ].join('\n');
}

function convergePrompt(topic: string, proText: string, conText: string): string {
  return [
    `辩题：「${topic}」`,
    '',
    '正方观点：',
    proText || '（无输出）',
    '',
    '反方观点：',
    conText || '（无输出）',
    '',
    '请作为中立的裁判给出收敛结论，包含三部分：双方各自成立的部分、关键分歧点、你的判断。',
  ].join('\n');
}

// ============= 各模式实现 =============

export interface OrchestrationInput {
  mode: OrchestrationMode;
  /** 群成员（未过滤） */
  members: string[];
  /** 用户本次输入 */
  prompt: string;
}

/**
 * 执行一次编排。
 *
 * @returns 实际参与的成员列表（已剔除不可用者），供调用方回写会话。
 */
export async function runOrchestration(
  input: OrchestrationInput,
  deps: OrchestratorDeps
): Promise<string[]> {
  const { mode, prompt } = input;

  // 先把不可用的成员剔掉，避免把任务派给一个必然失败的人
  const members = input.members.filter(id => deps.isUsable(id));
  const dropped = input.members.filter(id => !deps.isUsable(id));
  if (dropped.length > 0) {
    deps.note(`以下成员当前不可用，已跳过：${dropped.map(deps.displayName).join('、')}`);
  }

  if (members.length === 0) {
    deps.note('群里没有可用的成员，无法执行。请先在通讯录里让至少一个 Agent 上线。');
    return [];
  }

  switch (mode) {
    case 'broadcast':
      await runBroadcast(members, prompt, deps);
      break;
    case 'relay':
      await runRelay(members, prompt, deps);
      break;
    case 'debate':
      await runDebate(members, prompt, deps);
      break;
    case 'mention':
      await runMention(members, prompt, deps);
      break;
    case 'dispatch':
    default:
      await runDispatch(members, prompt, deps);
      break;
  }

  return members;
}

/** 广播：所有成员各自独立作答，并行跑，便于横向对比 */
async function runBroadcast(
  members: string[],
  prompt: string,
  deps: OrchestratorDeps
): Promise<void> {
  deps.note(`广播给 ${members.length} 位成员，各自独立作答`);
  // 并行：每个 Agent 是独立子进程/连接，互不阻塞，这是群聊相对一对一的真正价值
  await Promise.all(
    members.map(id => deps.runAgent(id, prompt, 'broadcast'))
  );
}

/** 接力：串行流水线，前一棒输出作为后一棒输入 */
async function runRelay(
  members: string[],
  prompt: string,
  deps: OrchestratorDeps
): Promise<void> {
  deps.note(`接力流水线：${members.map(deps.displayName).join(' → ')}`);
  let prevName: string | null = null;
  let prevText = '';

  for (let i = 0; i < members.length; i++) {
    const id = members[i];
    deps.note(`第 ${i + 1}/${members.length} 棒：${deps.displayName(id)}`);
    const r = await deps.runAgent(
      id,
      relayPrompt(prompt, i, members.length, prevName, prevText),
      'relay',
      i
    );
    prevName = deps.displayName(id);
    prevText = r.text;
  }
}

/**
 * 辩论：取前两位作为正反方，多轮交替，最后收敛。
 *
 * 收敛者优先取第三位成员（天然中立）；只有两位时退回让正方做收敛，
 * 但会在提示词里明确要求「中立裁判」，避免它只替自己说话。
 */
async function runDebate(
  members: string[],
  prompt: string,
  deps: OrchestratorDeps
): Promise<void> {
  if (members.length < 2) {
    deps.note('辩论至少需要 2 位成员，当前只有 1 位，已退化为单独作答。');
    await deps.runAgent(members[0], prompt, 'broadcast');
    return;
  }

  const [pro, con] = members;
  const judge = members[2] ?? pro;
  const judgeIsNeutral = members.length >= 3;

  deps.note(
    `辩论：正方 ${deps.displayName(pro)} vs 反方 ${deps.displayName(con)}，共 ${DEBATE_ROUNDS} 轮` +
      (judgeIsNeutral ? `，由 ${deps.displayName(judge)} 收敛` : '')
  );

  let proText = '';
  let conText = '';

  for (let round = 1; round <= DEBATE_ROUNDS; round++) {
    proText = (
      await deps.runAgent(
        pro,
        round === 1
          ? debateOpenPrompt(prompt, '正方')
          : debateRebuttalPrompt(prompt, '正方', deps.displayName(con), conText),
        'debate',
        round
      )
    ).text;

    conText = (
      await deps.runAgent(
        con,
        round === 1
          ? debateOpenPrompt(prompt, '反方')
          : debateRebuttalPrompt(prompt, '反方', deps.displayName(pro), proText),
        'debate',
        round
      )
    ).text;
  }

  await deps.runAgent(judge, convergePrompt(prompt, proText, conText), 'converge');
}

/** @指定：只唤醒被 @ 的成员，并行跑；没人被 @ 时给出提示而不是瞎猜 */
async function runMention(
  members: string[],
  prompt: string,
  deps: OrchestratorDeps
): Promise<void> {
  const targets = extractMentioned(prompt, members, deps.displayName);

  if (targets.length === 0) {
    deps.note(
      `没有识别到 @ 的成员。请在消息里写明要唤醒谁，例如 @${members[0]}；` +
        '或在群聊头部把模式切换为「广播」「分派」。'
    );
    return;
  }

  deps.note(`只唤醒：${targets.map(deps.displayName).join('、')}`);
  await Promise.all(targets.map(id => deps.runAgent(id, prompt, 'mention')));
}

/**
 * 分派（默认）：主控判断该谁做 → 派发 → 汇总。
 *
 * 路由这一步本身也是一次 LLM 调用，成本上不便宜，但它是「分派」这个模式的
 * 全部意义所在。它的输出会以 phase='route' 流给前端，用户能看到主控的判断过程，
 * 而不是只看到一个突然出现的结果。
 */
async function runDispatch(
  members: string[],
  prompt: string,
  deps: OrchestratorDeps
): Promise<void> {
  const controller = members[0];

  // 群里只有一个人时，路由毫无意义，直接让它做
  if (members.length === 1) {
    deps.note(`群里只有 ${deps.displayName(controller)}，直接作答`);
    await deps.runAgent(controller, prompt, 'work');
    return;
  }

  const candidates = members.slice(1);
  deps.note(`主控 ${deps.displayName(controller)} 正在判断该交给谁`);

  const route = await deps.runAgent(
    controller,
    routePrompt(prompt, candidates, deps.displayName),
    'route'
  );

  const chosen = parseRouting(route.text, candidates, deps.displayName);

  // 解析失败时不要瞎猜：退回广播，让所有候选人都答一遍，用户自己挑。
  // 这比「猜一个错的然后整轮结果都跑偏」要好得多。
  if (!chosen) {
    deps.note('主控没有给出可识别的指派，已退化为广播（所有候选成员各自作答）');
    await runBroadcast(candidates, prompt, deps);
    return;
  }

  deps.note(`主控决定交给 ${deps.displayName(chosen)}`);

  const work = await deps.runAgent(chosen, prompt, 'work');
  if (work.error) {
    deps.note(`${deps.displayName(chosen)} 执行失败：${work.error}`);
    return;
  }

  deps.note(`由 ${deps.displayName(controller)} 汇总结果`);
  await deps.runAgent(
    controller,
    summaryPrompt(prompt, deps.displayName(chosen), work.text),
    'summary'
  );
}
