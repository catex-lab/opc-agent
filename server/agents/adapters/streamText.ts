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
}

export function createStreamTextState(): StreamTextState {
  return { blocks: new Map(), totalText: '' };
}

function reset(state: StreamTextState): void {
  state.blocks.clear();
  state.totalText = '';
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
  const block = state.blocks.get(index);
  if (!block || block.kind !== 'text') return full;
  return remainder(block.text, full);
}

export function takeStreamedThinking(state: StreamTextState, index: number, full: string): string {
  const block = state.blocks.get(index);
  if (!block || block.kind !== 'thinking') return full;
  return remainder(block.text, full);
}

/** 无 block index 的字符串正文（部分 SDK 会把 content 直接给成字符串）。 */
export function takeStreamedTotalText(state: StreamTextState, full: string): string {
  return remainder(state.totalText, full);
}
