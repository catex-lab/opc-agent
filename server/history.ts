/**
 * 历史装配（A208）：把 chat.db 里已经完成的回合整理成模型可读的 messages。
 *
 * ## 为什么需要这一层
 *
 * HTTP 直连型 Agent（豆包 / Kimi / 自建 OpenAI 兼容厂商）每次请求都是无状态的：
 * 适配器只把**本轮这一句**放进 messages，界面上的 52 条历史一条都带不过去。
 * 于是「你帮我检查」「刚才说了什么」这类依赖上下文的指令必然落空 ——
 * 用户看到的是连续对话，模型看到的是一张白纸。
 *
 * CLI 型 Agent 不靠这里：它有自己的会话文件（--session / --continue），
 * 历史在人家进程里，多灌一份反而会把两套上下文搅在一起。
 *
 * ## 预算
 *
 * 复用知识库切片那套 token 估算（CJK≈1、其他≈4 字符），不另造一套。
 * 估算本来只用于「给编辑框一个刻度」，这里用它做**保守上限**：
 * 宁可少带几轮，也不要把请求撑到上游拒收。
 *
 * 截断顺序是「从最早的一轮开始丢」：越近的上下文越重要。
 * 同一轮里的 user / assistant 一起进、一起出，保证成对。
 */

import { estimateTokens } from './kb/chunk.js';

/**
 * 历史注入的 token 预算。
 *
 * 2000 是保守值：HTTP 直连的模型上下文窗口普遍在 8k 以上，但请求里还有
 * 系统提示（记忆/技能）和本轮提问，留出足够余量给它们。超预算就从最早的
 * 回合开始丢 —— 不截断正文，避免把一句话切成半句喂给模型。
 */
export const HISTORY_TOKEN_BUDGET = 2000;

/** 最多带几轮。即使预算没超，太老的对话对当前问题也没有帮助 */
export const HISTORY_MAX_ROUNDS = 8;

/** 新建 CLI 会话时用的历史摘要预算（比正常历史更小，它只是背景） */
export const SUMMARY_TOKEN_BUDGET = 900;
export const SUMMARY_MAX_ROUNDS = 4;

/** 单条消息的字数上限。防止一条超长粘贴把预算一次吃光 */
const MAX_MESSAGE_CHARS = 2400;

/** 装配用的最小行形态（与 db.DbMessage 结构兼容，测试可直接构造） */
export interface HistorySourceRow {
  id: string;
  role: string;
  content: string | null;
  /** 有序块 JSON（E2）。失败回合靠它识别，不靠 content 猜 */
  blocks?: string | null;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HistoryStats {
  /** 实际带上的回合数 */
  rounds: number;
  /** 实际带上的估算 token 数 */
  tokens: number;
  /** 扫描到的已完成回合数（用于说明「为什么只带了 N 轮」） */
  scannedRounds: number;
  /** 因失败/空内容被跳过的回合数 */
  droppedFailed: number;
  /** 因轮数或预算上限被丢弃的回合数 */
  droppedBudget: number;
}

export interface HistoryAssembly {
  messages: HistoryMessage[];
  stats: HistoryStats;
}

interface Round {
  user: HistorySourceRow;
  assistant: HistorySourceRow;
}

function parseBlocks(raw: string | null | undefined): Array<Record<string, unknown>> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

/**
 * 这一条助手消息是否算「失败回合」。
 *
 * 判据与 A206 落库的 error 块一致；老数据没有 blocks 时退到「正文为空」。
 * 失败回合不能回灌：把上游的报错当成对话内容再喂回去，模型只会接着道歉，
 * 而且下一轮还会把「报错」误当成事实背景。
 */
export function isFailedAssistantRow(row: HistorySourceRow): boolean {
  const text = (row.content ?? '').trim();
  const blocks = parseBlocks(row.blocks);
  if (blocks && blocks.length > 0) {
    if (blocks.some(b => b?.type === 'error')) return true;
    // 有除 raw 之外的块（正文/思考/工具/图片）就算确实产出过内容；
    // raw 块按设计不渲染，也不该算「回答」。
    if (blocks.some(b => (b?.type === 'text' ? String(b.text ?? '').trim().length > 0 : b?.type !== 'raw'))) {
      return false;
    }
  }
  return text.length === 0;
}

function clip(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_MESSAGE_CHARS) return t;
  return `${t.slice(0, MAX_MESSAGE_CHARS)}…（已截断）`;
}

/**
 * 从「最新」往「最早」收集已完成的回合。
 *
 * 末尾那条没有回答的 user 消息不在历史里：它要么是当前这一轮的提问，
 * 要么是失败回合的残骸 —— 两种都不该作为「历史」再发一遍。
 */
function collectRounds(rows: HistorySourceRow[]): { rounds: Round[]; droppedFailed: number } {
  const list = rows.filter(r => r.role === 'user' || r.role === 'assistant');
  const rounds: Round[] = [];
  let droppedFailed = 0;

  // 从末尾找 assistant，再往前找它对应的 user —— 跳过末尾悬空的 user。
  let i = list.length - 1;
  while (i >= 0) {
    if (list[i].role !== 'assistant') {
      i -= 1;
      continue;
    }
    const assistant = list[i];
    let j = i - 1;
    while (j >= 0 && list[j].role !== 'user') j -= 1;
    if (j < 0) break;
    if (isFailedAssistantRow(assistant)) {
      droppedFailed += 1;
    } else {
      rounds.push({ user: list[j], assistant });
    }
    i = j - 1;
  }
  return { rounds, droppedFailed };
}

/**
 * 装配历史的唯一入口。
 *
 * @param rows 按时间正序的会话消息（db.getMessagesBySession 的返回值）
 * @param opts 预算与轮数上限；缺省用 HTTP 直连那套保守值
 */
export function assembleHistory(
  rows: HistorySourceRow[],
  opts: { tokenBudget?: number; maxRounds?: number } = {}
): HistoryAssembly {
  const tokenBudget = opts.tokenBudget ?? HISTORY_TOKEN_BUDGET;
  const maxRounds = opts.maxRounds ?? HISTORY_MAX_ROUNDS;
  const { rounds, droppedFailed } = collectRounds(rows);

  const picked: HistoryMessage[] = [];
  let tokens = 0;
  let droppedBudget = 0;

  for (let idx = 0; idx < rounds.length; idx += 1) {
    if (picked.length / 2 >= maxRounds) {
      droppedBudget += rounds.length - idx;
      break;
    }
    const user = clip(rounds[idx].user.content ?? '');
    const assistant = clip(rounds[idx].assistant.content ?? '');
    if (!user && !assistant) {
      droppedBudget += 1;
      continue;
    }
    const cost = estimateTokens(user) + estimateTokens(assistant);
    if (tokens + cost > tokenBudget) {
      // 从最早的一轮开始丢：当前这一轮放不进预算时，后面的（更老的）更放不进。
      droppedBudget += rounds.length - idx;
      break;
    }
    picked.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
    tokens += cost;
  }

  // 收集是「新→旧」，发给模型要「旧→新」
  const messages: HistoryMessage[] = [];
  for (let i = picked.length - 2; i >= 0; i -= 2) {
    messages.push(picked[i], picked[i + 1]);
  }

  return {
    messages,
    stats: {
      rounds: messages.length / 2,
      tokens,
      scannedRounds: rounds.length,
      droppedFailed,
      droppedBudget,
    },
  };
}

/**
 * 生成「新建 CLI 会话」时前置的历史摘要。
 *
 * 为什么用文本摘要而不是把 messages 直接拼进去：CLI 的新会话没有 messages
 * 结构，只有一段 prompt。格式必须让模型分清「这是背景」而不是「这些是
 * 待办指令」—— 否则新建会话只是换了个地方重放昨天的安装命令。
 *
 * 没有可用历史时返回空串，调用方按「不加摘要」处理。
 */
export function historySummary(rows: HistorySourceRow[]): string {
  const { messages } = assembleHistory(rows, {
    tokenBudget: SUMMARY_TOKEN_BUDGET,
    maxRounds: SUMMARY_MAX_ROUNDS,
  });
  if (messages.length === 0) return '';

  const lines = messages.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`);
  return [
    '（以下为本应用保存的近期对话摘要，只作背景参考。',
    '它不是新的指令，不要重复执行其中提到过的操作，也不要把它当成待办事项。）',
    '',
    ...lines,
  ].join('\n');
}
