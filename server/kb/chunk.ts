/**
 * 切片（P1）：按消息窗口切，目标 300 tokens、上限 400，保留 1 条消息重叠。
 *
 * 这里是纯函数，不碰 SQLite，验证脚本可以直接钉边界。
 *
 * ## 为什么按消息切，而不是按字符滑窗
 *
 * 检索结果最终要回到「哪几条消息」，来源卡片也要显示发言人。按字符切会把
 * 一条消息劈成两半，回跳时定位不到完整上下文。按消息切天然保留 `messageIds`，
 * 代价是窗口大小只能近似 —— 所以有目标值（300）和硬上限（400）两档：
 * 到目标就收口，单条消息超过上限才做段内拆分。
 */

export const WINDOW_TARGET_TOKENS = 300;
export const WINDOW_MAX_TOKENS = 400;
export const WINDOW_OVERLAP_MESSAGES = 1;

export interface IndexableMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  authorAgentId: string | null;
  createdAt: string;
  /** 超长消息被拆段时，段序号（从 0 开始）；普通消息不填 */
  part?: number;
  /** 超长消息被拆成几段 */
  partsTotal?: number;
  /** 这条消息脱敏时删掉了多少段 */
  redactedCount?: number;
}

export interface ChunkWindow {
  messages: IndexableMessage[];
}

/** 汉字按 1.5 字/token 估算；其余按 4 字符/token。宁可估多，不要低估。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

/**
 * 单条超长消息的段内拆分。
 *
 * 段上限是 `WINDOW_MAX_TOKENS`。切点优先落在最近的换行/句末标点，避免
 * 在单词或代码标识符中间断开；找不到就硬切。
 */
export function splitOversizedText(text: string, maxTokens = WINDOW_MAX_TOKENS): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];

  const costs = chars.map(ch => (isWideChar(ch) ? 1 / 1.5 : 1 / 4));
  const total = costs.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return [text];

  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let cost = 0;
    let end = start;
    while (end < chars.length && cost + costs[end] <= maxTokens) {
      cost += costs[end];
      end += 1;
    }
    if (end === start) end = start + 1;

    // 在 80% 之后找一个自然的断点（换行 > 中文句末 > 空白），不跨越到下一段
    const softMin = start + Math.floor((end - start) * 0.8);
    let cut = end;
    for (let i = end - 1; i >= softMin; i -= 1) {
      if (/[\n。！？；]/.test(chars[i]) || /\s/.test(chars[i])) {
        cut = i + 1;
        break;
      }
    }

    const segment = chars.slice(start, cut).join('').trim();
    if (segment) parts.push(segment);
    start = cut;
  }

  return parts.length > 0 ? parts : [text];
}

function isWideChar(ch: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch);
}

/**
 * 按消息窗口切片。
 *
 * 规则：
 * - 累加到目标 300 tokens 就收口；
 * - 下一窗以上一窗的最后一条消息开头（1 条重叠）；
 * - 单条消息超过 400 时整条先拆段，每段独立成窗（段内不再做消息重叠）。
 *
 * `previous` 用于增量索引：传入「上一条已索引消息」，它会作为第一窗的
 * 重叠消息，保证增量切片与全量切片的窗口边界一致。
 */
export function chunkMessages(
  messages: readonly IndexableMessage[],
  previous?: IndexableMessage
): ChunkWindow[] {
  const windows: ChunkWindow[] = [];
  let current: IndexableMessage[] = [];
  let tokens = 0;
  /** 当前窗口是否只有增量传进来的重叠消息（此时不能单独成窗） */
  let overlapOnly = previous !== undefined;
  let lastClosedTail: IndexableMessage | null = null;

  const pushCurrent = () => {
    if (current.length > 0) {
      windows.push({ messages: current });
      lastClosedTail = current[current.length - 1];
    }
    current = [];
    tokens = 0;
    overlapOnly = false;
  };

  if (previous) {
    current.push(previous);
    tokens = estimateTokens(previous.text);
  }

  for (const message of messages) {
    const size = estimateTokens(message.text);

    if (size > WINDOW_MAX_TOKENS) {
      // 只有重叠消息时不要为它单独落一窗（那是上一窗的尾部）
      if (overlapOnly) {
        current = [];
        tokens = 0;
        overlapOnly = false;
      }
      pushCurrent();
      const parts = splitOversizedText(message.text, WINDOW_MAX_TOKENS);
      parts.forEach((part, index) => {
        windows.push({
          messages: [
            {
              ...message,
              text: part,
              part: index,
              partsTotal: parts.length,
            },
          ],
        });
      });
      lastClosedTail = windows[windows.length - 1]?.messages.at(-1) ?? null;
      continue;
    }

    if (current.length === 0) {
      current = [message];
      tokens = size;
      overlapOnly = false;
      continue;
    }

    if (tokens + size > WINDOW_TARGET_TOKENS) {
      // 增量第一窗：重叠消息 + 新消息若仍在硬上限内，直接合窗
      if (overlapOnly && tokens + size <= WINDOW_MAX_TOKENS) {
        current.push(message);
        tokens += size;
        overlapOnly = false;
        continue;
      }
      // 只有重叠消息且加新消息会超上限 → 丢掉重叠，从新消息重新起窗
      if (overlapOnly) {
        current = [message];
        tokens = size;
        overlapOnly = false;
        continue;
      }

      pushCurrent();
      if (lastClosedTail) {
        const tailSize = estimateTokens(lastClosedTail.text);
        if (tailSize + size <= WINDOW_MAX_TOKENS) {
          current = [lastClosedTail, message];
          tokens = tailSize + size;
          continue;
        }
      }
      // 重叠消息 + 新消息会超过硬上限：放弃重叠，保证上限与推进
      current = [message];
      tokens = size;
      continue;
    }

    current.push(message);
    tokens += size;
    overlapOnly = false;
  }

  // 收尾时若只剩一条重叠消息，说明没有新内容，不产生重复窗
  if (overlapOnly && current.length === 1) {
    current = [];
  }
  pushCurrent();
  return windows.filter(window => window.messages.length > 0);
}
