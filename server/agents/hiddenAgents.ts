/**
 * 内置 Agent 的「从列表移除」状态。
 *
 * ## 为什么需要它
 *
 * 内置 Agent 的定义编译在安装包里，用户不能真的删除它；但通讯录里十几条
 * 条目里，用户常用可能只有两三条。这里提供一个**只影响名册展示**的隐藏
 * 开关：移除后条目从 Agent 列表消失，并出现在「+ → 获取 Agent」的
 * 「已从列表移除」分组里，可随时重新添加。
 *
 * ## 边界（写死）
 *
 * - 只存 id，不动定义、凭据、Logo、会话记录；
 * - 不从 `registry` 注销、不停探测 —— 恢复后状态仍是热的；
 * - 自建 Agent（`custom-*` / `customcli-*`）有自己的删除链路，不允许进这里。
 *
 * ## 存储
 *
 * `data/hidden-agents.json`，内容是一个字符串数组。写盘用「临时文件 + rename」，
 * 写到一半断电不会留下半截 JSON（与 avatar-store.ts 同一模式）。
 * 读取每次都走磁盘：这个文件只有几十字节，而 `/api/agents` 本身也不是热路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath } from '../paths.js';

const STORE_PATH = path.join(dataDirPath, 'hidden-agents.json');

/** 与 registry 的 agentId 校验同一套字符集，额外排除自建前缀 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isHideableId(value: unknown): value is string {
  if (typeof value !== 'string' || !ID_RE.test(value)) return false;
  return !value.startsWith('custom-') && !value.startsWith('customcli-');
}

function readFromDisk(): string[] {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      // 手改坏的文件不该让整张表失效：坏条目直接丢掉
      if (isHideableId(item) && !out.includes(item)) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

/** 原子写。返回是否真的落盘（写失败时调用方据此决定要不要报错） */
function writeToDisk(next: string[]): boolean {
  try {
    fs.mkdirSync(dataDirPath, { recursive: true });
    const tmp = `${STORE_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, STORE_PATH);
    return true;
  } catch (err) {
    console.warn('[HiddenAgents] 写入隐藏列表失败:', (err as Error).message);
    return false;
  }
}

/** 当前被隐藏的内置 Agent id 列表（副本，调用方随便改） */
export function loadHiddenAgentIds(): string[] {
  return readFromDisk();
}

/** 某个内置 Agent 是否已被移出列表 */
export function isBuiltinAgentHidden(id: string): boolean {
  return readFromDisk().includes(id);
}

/**
 * 把一个内置 Agent 移出列表。
 *
 * 返回 `false` 只发生在两种情况下：id 不是合法内置 id（含自建前缀），
 * 或写盘失败。写盘失败必须报给用户 —— 否则界面先隐藏、重启又冒出来，
 * 用户会以为是「删除没生效」的随机 bug。
 */
export function hideBuiltinAgent(id: string): boolean {
  if (!isHideableId(id)) return false;
  const current = readFromDisk();
  if (current.includes(id)) return true;
  return writeToDisk([...current, id]);
}

/** 把已移除的内置 Agent 放回列表（幂等） */
export function showBuiltinAgent(id: string): boolean {
  const current = readFromDisk();
  if (!current.includes(id)) return true;
  return writeToDisk(current.filter(item => item !== id));
}
