import type { AgentEvent } from '../types.js';

/**
 * Anthropic 风格的流式增量归一化（Tencent SDK / Claude SDK 共用）。
 *
 * 两家 CLI 的 `--include-partial-messages` 都会产出同一套
 * `content_block_delta`。这里只做两件事：
 *   1. 把 text_delta / thinking_delta 变成 text / thinking 事件；
 *   2. 记录每个 content block 已推出的文本，供随后到达的整条 assistant
 *      消息做去重——否则同一段正文会先增量推一遍、再整段推一遍，直接翻倍。
 *
 * 不认识的流事件返回 null，由适配器走 raw 旁路，避免「新 subtype 被吞」。
 */

export interface StreamTextState {
  /** 当前 assistant 消息的 content block 增量缓存（key = block index） */
  blocks: Map<number, { kind: 'text' | 'thinking'; text: string }>;
  /** 当前消息已推出的正文总量（assistant content 为字符串时用于去重） */
  totalText: string;
  /**
   * 本轮每个块最近一次整条下发的正文（key = `${kind}:${index}`），
   * 以及字符串正文的最近一次整条下发（settledTotal）。
   *
   * 为什么需要：增量去重只对「先增量、后整条」这一种顺序有效。实测
   * WorkBuddy 会把**同一条 assistant 消息下发两次**（CLI 侧会话记录里
   * 只有一份 87 字的回答，界面上却拼成了 174 字），中间还可能夹一条
   * message_start 把增量缓存清空。于是第二次到达时既没有增量可减、也
   * 没有缓存可比，整段又被追加一遍。
   *
   * 这两个字段跨 message_start 保留（生命周期 = 一轮），只用于识别
   * 「同一块、同一段文字再次下发」，不参与任何内容裁剪。
   */
  settled: Map<string, string>;
  settledTotal: string;
  /**
   * 本轮已下发过的「整条 assistant 消息」正文签名（生命周期 = 一轮）。
   *
   * 为什么还要这一层：`settled` 的 key 带 block index，`settledTotal` 只认
   * 字符串正文。实测 WorkBuddy 会把同一条消息先按字符串、后按数组下发，
   * 或两次的 text block index 不一样 —— 两种情况下旧去重都认不出来，
   * 整段正文又被追加一遍。这里把两种形状归一化成同一个签名，跨
   * `message_start` 保留；只拦「整条完全相同的消息再次到达」。
   */
  wholeMessages: Set<string>;
}

export function createStreamTextState(): StreamTextState {
  return {
    blocks: new Map(),
    totalText: '',
    settled: new Map(),
    settledTotal: '',
    wholeMessages: new Set(),
  };
}

function reset(state: StreamTextState): void {
  state.blocks.clear();
  state.totalText = '';
  // settled / wholeMessages 刻意不清：它们挡的正是「重置之后同一条再来一次」
}

function append(
  state: StreamTextState,
  index: number,
  kind: 'text' | 'thinking',
  text: string
): AgentEvent | null {
  if (!text) return null;
  let block = state.blocks.get(index);
  if (!block || block.kind !== kind) {
    block = { kind, text: '' };
    state.blocks.set(index, block);
  }
  block.text += text;
  if (kind === 'text') state.totalText += text;
  return kind === 'text' ? { type: 'text', content: text } : { type: 'thinking', content: text, format: 'raw' };
}

/**
 * 处理一条原生 `stream_event`（或裸流事件），返回应该继续下发的事件。
 * `null` = 不认识，交给调用方走 raw 旁路；`[]` = 已消费（生命周期事件）。
 */
export function mapStreamTextEvent(message: unknown, state: StreamTextState): AgentEvent[] | null {
  if (!message || typeof message !== 'object') return null;
  const outer = message as { type?: unknown; event?: unknown };
  const raw = outer.type === 'stream_event' ? outer.event : message;
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as {
    type?: unknown;
    index?: unknown;
    delta?: { type?: unknown; text?: unknown; thinking?: unknown };
    content_block?: { type?: unknown; text?: unknown; thinking?: unknown };
  };
  const type = typeof ev.type === 'string' ? ev.type : '';

  if (type === 'message_start') {
    reset(state);
    return [];
  }
  if (type === 'message_stop' || type === 'message_delta' || type === 'content_block_stop') {
    return [];
  }

  const index = typeof ev.index === 'number' && Number.isInteger(ev.index) ? ev.index : 0;

  if (type === 'content_block_start') {
    const block = ev.content_block;
    if (block && (block.type === 'text' || block.type === 'thinking')) {
      const initial = block.type === 'text' ? block.text : block.thinking;
      const text = typeof initial === 'string' ? initial : '';
      const event = append(state, index, block.type, text);
      return event ? [event] : [];
    }
    return [];
  }

  if (type === 'content_block_delta') {
    const delta = ev.delta;
    if (!delta || typeof delta.type !== 'string') return null;
    if (delta.type === 'text_delta') {
      const event = append(state, index, 'text', typeof delta.text === 'string' ? delta.text : '');
      return event ? [event] : [];
    }
    if (delta.type === 'thinking_delta') {
      const event = append(state, index, 'thinking', typeof delta.thinking === 'string' ? delta.thinking : '');
      return event ? [event] : [];
    }
    // input_json_delta / signature_delta 不渲染成正文；tool_use 由整条
    // assistant 消息统一产出，避免半个 JSON 被当成工具参数。
    if (delta.type === 'input_json_delta' || delta.type === 'signature_delta') return [];
    return null;
  }

  return null;
}

function remainder(streamed: string, full: string): string {
  if (!streamed) return full;
  if (full === streamed) return '';
  if (full.startsWith(streamed)) return full.slice(streamed.length);
  if (streamed.startsWith(full)) return '';
  // 前缀不一致时也不能整段重发：宁可少补，不能翻倍。
  return full.slice(Math.min(streamed.length, full.length));
}

/** 整条 assistant 消息到达时，取「增量还没推出去的部分」。 */
export function takeStreamedText(state: StreamTextState, index: number, full: string): string {
  const key = `text:${index}`;
  if (full && state.settled.get(key) === full) return '';
  state.settled.set(key, full);
  const block = state.blocks.get(index);
  if (!block || block.kind !== 'text') return full;
  return remainder(block.text, full);
}

export function takeStreamedThinking(state: StreamTextState, index: number, full: string): string {
  const key = `thinking:${index}`;
  if (full && state.settled.get(key) === full) return '';
  state.settled.set(key, full);
  const block = state.blocks.get(index);
  if (!block || block.kind !== 'thinking') return full;
  return remainder(block.text, full);
}

/** 无 block index 的字符串正文（部分 SDK 会把 content 直接给成字符串）。 */
export function takeStreamedTotalText(state: StreamTextState, full: string): string {
  if (full && state.settledTotal === full) return '';
  state.settledTotal = full;
  return remainder(state.totalText, full);
}

/**
 * 把 assistant.content 的两种形状归一化成一个正文签名：
 * 字符串正文与 `[{type:'text',text:'…'}]` 只要文字相同就是同一个签名，
 * 因此「先字符串后数组」「块索引变了」的重复下发也能认出来。
 * 没有正文（纯工具 / 空消息）返回 null，不参与去重。
 */
export function wholeMessageTextKey(content: unknown): string | null {
  let parts: string[];
  if (typeof content === 'string') {
    parts = [content];
  } else if (Array.isArray(content)) {
    parts = content
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && b.type === 'text')
      .map(b => (typeof b.text === 'string' ? b.text : ''));
  } else {
    return null;
  }
  const text = parts.join('');
  return text ? `text:${text}` : null;
}

/**
 * 整条消息是否本轮已下发过。首次调用会记录签名；重复调用返回 true，
 * 调用方应整条跳过，而不是逐块走 remainder —— 后者在形状/索引变化时
 * 会误判成「新内容」。
 */
export function isDuplicateWholeMessage(state: StreamTextState, content: unknown): boolean {
  const key = wholeMessageTextKey(content);
  if (!key) return false;
  if (state.wholeMessages.has(key)) return true;
  state.wholeMessages.add(key);
  return false;
}
