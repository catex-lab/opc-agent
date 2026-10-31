/**
 * 用户资料（昵称 + 头像）。
 *
 * ## 为什么放服务端而不是 localStorage
 *
 * 原话是「昵称可以被 agent 识别」。Agent 跑在**服务端**（CLI 子进程、
 * SDK、HTTP 适配器），前端存什么都不够 —— 必须有一个服务端认得的值，
 * 在拼 systemPrompt 时注入进去。所以这里是唯一事实来源，
 * 前端只通过 `GET/PUT /api/user-profile` 读写。
 *
 * ## 为什么单独一个文件而不是塞进 sessions 表
 *
 * 资料是**全局单例**（这台机器上就一个用户），不是按会话变的。
 * 塞进 sessions 要决定「哪一条会话说了算」，而群聊里每个成员都会说话，
 * 更说不清。JSON 单文件与 `custom-agents.json` / `agent-credentials.json`
 * 同一套路，改起来不用迁移。
 *
 * ## 注入点
 *
 * `registry.stream()` / `registry.prewarm()` 在把 `systemPrompt` 交给适配器
 * 之前过一次 `withUserIdentity()`。选这两个位置而不是逐个适配器里加，
 * 是因为适配器有五个（sdk / http / acp / qoder-sdk / …），漏一个就
 * 「有的 Agent 认得我、有的不认得」—— 而那种不一致没有任何报错。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { dataDirPath } from './paths.js';
import { AVATAR_URL_RE } from './avatar-file.js';

/** 头像预设的 id。与前端 `src/userProfile.ts` 的 AVATAR_PRESETS 同一份清单 */
export type UserAvatarId = string;

export interface UserProfile {
  /** 昵称。空串 = 不注入（不编一个默认名塞给 Agent） */
  nickname: string;
  /** 头像预设 id。空串 = 用昵称首字兜底 */
  avatar: UserAvatarId;
  /**
   * 用户自己上传的图片头像（`/api/avatars/<file>`）。空串 = 没上传。
   *
   * 与 `avatar`（预设）并存而不是改写成同一个字段：图片是覆盖层，
   * 移除图片后要能**回到之前选的预设**，而不是把预设一起忘了。
   */
  avatarImage: string;
}

const EMPTY: UserProfile = { nickname: '', avatar: '', avatarImage: '' };

let cached: UserProfile | null = null;

function filePath(): string {
  return path.join(dataDirPath, 'user-profile.json');
}

function readFromDisk(): UserProfile {
  try {
    if (!existsSync(filePath())) return { ...EMPTY };
    const raw = readFileSync(filePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return normalize(parsed);
  } catch {
    // 文件损坏/不可读：当没有资料，不要让整个服务端起不来
    return { ...EMPTY };
  }
}

/** 把任意来路的数据收敛成合法形状。坏字段一律当没有，不抛错 */
export function normalize(input: unknown): UserProfile {
  const o = (input ?? {}) as Partial<UserProfile>;
  const nickname = typeof o.nickname === 'string' ? o.nickname.trim().slice(0, 24) : '';
  const avatar = typeof o.avatar === 'string' ? o.avatar.trim().slice(0, 40) : '';
  // 只认服务端自己发的头像 URL：手改文件塞一个外链或 ../ 进来都不能落盘，
  // 否则界面会从本地路径加载任意文件（或把请求打到外部主机）。
  const avatarImage =
    typeof o.avatarImage === 'string' && AVATAR_URL_RE.test(o.avatarImage.trim())
      ? o.avatarImage.trim()
      : '';
  return { nickname, avatar, avatarImage };
}

export function loadUserProfile(): UserProfile {
  if (!cached) cached = readFromDisk();
  return { ...cached };
}

export function saveUserProfile(patch: Partial<UserProfile>): UserProfile {
  const next = normalize({ ...loadUserProfile(), ...patch });
  cached = next;
  try {
    mkdirSync(dataDirPath, { recursive: true });
    writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (e) {
    // 写不进去只影响重启后还在不在；本次进程内仍然生效
    console.warn('[UserProfile] 写入失败（本次会话仍生效）:', (e as Error).message);
  }
  return { ...next };
}

/**
 * 给 systemPrompt 追加一行「你在和谁说话」。
 *
 * ## 为什么是追加而不是替换
 *
 * systemPrompt 可能来自场景模板（P4）或 Agent 自己的人设，它们都是
 * **用户显式选过的**。我们这一行是补充信息，不该盖掉任何一句 ——
 * 所以只追加，且用空行隔开，读起来是独立的一段。
 *
 * ## 为什么只有昵称，没有头像
 *
 * 头像是本机界面上的显示偏好，对 Agent 的推理没有任何意义。
 * 把它写进 prompt 只会白占 token，还可能让模型去描述一个它看不见的东西。
 *
 * ## 空昵称时原样返回
 *
 * 不编一个「用户」占位 —— 那等于告诉 Agent「这个人叫用户」，
 * 之后它就会一直这么叫。没有就是没有。
 */
export function withUserIdentity(systemPrompt: string | undefined): string | undefined {
  const { nickname } = loadUserProfile();
  if (!nickname) return systemPrompt;
  const line = `用户信息：与你对话的人叫「${nickname}」。可以直接用这个称呼，不必每次确认。`;
  const base = (systemPrompt ?? '').trimEnd();
  // 没有原文时（Agent 没有人设）不留两个空行开头 —— systemPrompt 的
  // 前导空白没有任何语义，而「第一眼看到的是空行」在读 prompt 时很碍眼。
  return base ? `${base}\n\n---\n${line}` : `---\n${line}`;
}
