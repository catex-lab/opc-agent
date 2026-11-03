/**
 * 知识库的「用户选择」清单：不索引的会话 + 逐 Agent 的 kb.search 开关。
 *
 * 为什么两件事放同一个文件：它们都是**用户对知识库的显式选择**，且都必须
 * 跨「重建索引」保留（重建会清空 kb.sqlite，但不会动这份 JSON）。再建一份
 * 配置只会让「哪份才是用户真实意图」变得说不清。
 *
 * 文件格式向后兼容：
 *   - 老版本写的是字符串数组，只表示「不索引的会话」；
 *   - 新版本写 `{ sessions: string[], toolAgents: Record<string, boolean> }`。
 *
 * 损坏处理保持 fail-closed：读不出/解析不了就抛错，让索引停摆，
 * 而不是把损坏的排除清单当成「没有排除项」——那会把敏感会话重新索引。
 * 工具开关缺失一律视为关闭（默认值就是关闭）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath } from '../paths.js';

export const KB_OPTOUT_FILENAME = 'kb-optout.json';

/** 每个 Agent 每轮对话最多主动检索的次数。 */
export const KB_TOOL_MAX_PER_TURN = 2;

export interface KbOptOutStore {
  sessions: string[];
  /** agentId → 是否允许该 Agent 主动调用 kb.search。缺省 = 关闭。 */
  toolAgents: Record<string, boolean>;
}

export function optOutFilePath(): string {
  return path.join(dataDirPath, KB_OPTOUT_FILENAME);
}

function emptyStore(): KbOptOutStore {
  return { sessions: [], toolAgents: {} };
}

function readToolAgents(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [agentId, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (!agentId || typeof enabled !== 'boolean') continue;
    if (enabled) out[agentId] = true;
  }
  return out;
}

export function readOptOutStore(): KbOptOutStore {
  let raw: string;
  try {
    raw = fs.readFileSync(optOutFilePath(), 'utf8');
  } catch (err) {
    // 首次运行没有清单是正常的；读不到/解析不了则 fail-closed。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw new Error('不索引清单不可读，已停止索引以防误索引');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('不索引清单格式损坏，已停止索引以防误索引');
  }

  if (Array.isArray(parsed)) {
    return {
      sessions: [...new Set(parsed.filter((v): v is string => typeof v === 'string'))],
      toolAgents: {},
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('不索引清单格式损坏，已停止索引以防误索引');
  }

  const record = parsed as Record<string, unknown>;
  const sessions = Array.isArray(record.sessions)
    ? [...new Set(record.sessions.filter((v): v is string => typeof v === 'string'))]
    : [];
  if (record.sessions !== undefined && !Array.isArray(record.sessions)) {
    throw new Error('不索引清单格式损坏，已停止索引以防误索引');
  }

  return { sessions, toolAgents: readToolAgents(record.toolAgents) };
}

export function writeOptOutStore(next: KbOptOutStore): void {
  fs.mkdirSync(dataDirPath, { recursive: true });
  const payload: KbOptOutStore = {
    sessions: [...new Set(next.sessions)].sort(),
    toolAgents: readToolAgents(next.toolAgents),
  };
  const tmp = `${optOutFilePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, optOutFilePath());
}

function updateStore(mutate: (current: KbOptOutStore) => KbOptOutStore): KbOptOutStore {
  const next = mutate(readOptOutStore());
  writeOptOutStore(next);
  return next;
}

/** 该 Agent 是否被允许主动调用 kb.search（缺省关闭）。 */
export function isKbToolEnabled(agentId: string | null | undefined): boolean {
  const id = String(agentId ?? '').trim();
  if (!id) return false;
  return readOptOutStore().toolAgents[id] === true;
}

/** 写入逐 Agent 开关；关闭时从清单删除该键，保持「缺省=关闭」这一单一事实。 */
export function setKbToolEnabled(agentId: string, enabled: boolean): KbOptOutStore {
  const id = String(agentId ?? '').trim();
  if (!id) throw new Error('agentId 不能为空');
  return updateStore(current => {
    const toolAgents = { ...current.toolAgents };
    if (enabled) toolAgents[id] = true;
    else delete toolAgents[id];
    return { ...current, toolAgents };
  });
}

/** 供面板一次性拿到全部已开启的 Agent。 */
export function listKbToolEnabled(): Record<string, boolean> {
  return { ...readOptOutStore().toolAgents };
}
