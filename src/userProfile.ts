/**
 * 用户资料（昵称 + 头像）的**前端**部分。
 *
 * 事实来源在服务端（`server/user-profile.ts`）—— 因为「昵称要被 Agent 认识」
 * 要求它是一个服务端拼 systemPrompt 时能读到的值。这里只做三件事：
 *   1. 拉取 / 保存（`loadUserProfile` / `saveUserProfile`）；
 *   2. 订阅（`useUserProfile`，与 sessionFlags 同一套 useSyncExternalStore）；
 *   3. 头像预设清单与渲染（`AVATAR_PRESETS` / `UserAvatar`）。
 *
 * ## 为什么要一个模块级 store 而不是 App state
 *
 * 头像出现在会话列表、群设置、设置页三个地方，昵称还要给输入框的 @ 提示用。
 * 一层层传 props 会漏；用 useSyncExternalStore 订阅一个模块快照，
 * 任何一处改了另外两处立刻跟上（sessionFlags / agentRemarks 同一套路）。
 */

import { useSyncExternalStore } from 'react';

export interface UserProfile {
  nickname: string;
  avatar: string;
}

const EMPTY: UserProfile = { nickname: '', avatar: '' };

/** 头像预设。id 会原样存进服务端的 user-profile.json，**不要改已发不动的 id** */
export interface AvatarPreset {
  id: string;
  /** 直接渲染的字符。用 emoji 而不是图标库：不引依赖、跨主题都是同一张脸 */
  glyph: string;
  /** 底色。中性灰阶为主，两个品牌色只作点缀 —— 头像越小越不能靠颜色区分 */
  color: string;
  label: string;
}

/**
 * 12 个预设。
 *
 * 取 emoji 而不是「图标 + 颜色」的组合，原因有三个：
 *   1. 系统渲染，任何 DPI 下都不糊，不需要 @2x/@3x 位图；
 *   2. 表情本身带语义（猫 = 喜欢猫），比一颗色块更好认；
 *   3. 不需要为「用户上传图片」先做一套文件选择 + 裁剪 + 存储。
 *
 * ⚠️ 底色全部走 `color-mix(... var(--tc-*) ...)` 而不是写死 hex ——
 *    否则深色主题下这些圆底会变成一圈刺眼的亮斑。
 */
export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'cat', glyph: '🐱', color: 'color-mix(in srgb, var(--td-brand-color) 14%, transparent)', label: '小猫' },
  { id: 'dog', glyph: '🐶', color: 'color-mix(in srgb, var(--td-brand-color) 14%, transparent)', label: '小狗' },
  { id: 'fox', glyph: '🦊', color: 'color-mix(in srgb, var(--td-warning-color) 16%, transparent)', label: '狐狸' },
  { id: 'panda', glyph: '🐼', color: 'color-mix(in srgb, var(--td-text-color-primary) 10%, transparent)', label: '熊猫' },
  { id: 'koala', glyph: '🐨', color: 'color-mix(in srgb, var(--td-text-color-primary) 10%, transparent)', label: '考拉' },
  { id: 'rabbit', glyph: '🐰', color: 'color-mix(in srgb, var(--td-success-color) 16%, transparent)', label: '兔子' },
  { id: 'rocket', glyph: '🚀', color: 'color-mix(in srgb, var(--td-brand-color) 14%, transparent)', label: '火箭' },
  { id: 'star', glyph: '⭐', color: 'color-mix(in srgb, var(--td-warning-color) 16%, transparent)', label: '星星' },
  { id: 'moon', glyph: '🌙', color: 'color-mix(in srgb, var(--td-text-color-primary) 10%, transparent)', label: '月亮' },
  { id: 'coffee', glyph: '☕', color: 'color-mix(in srgb, var(--td-text-color-primary) 10%, transparent)', label: '咖啡' },
  { id: 'leaf', glyph: '🍀', color: 'color-mix(in srgb, var(--td-success-color) 16%, transparent)', label: '四叶草' },
  { id: 'flame', glyph: '🔥', color: 'color-mix(in srgb, var(--td-error-color) 14%, transparent)', label: '火焰' },
];

export function avatarPresetOf(id: string | undefined): AvatarPreset | undefined {
  if (!id) return undefined;
  return AVATAR_PRESETS.find(p => p.id === id);
}

/** 取昵称首字符。全角/半角都只取一个 —— 用一个码元就够，别切出半个 emoji */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // 用 Array.from 而不是 [0]：代理对（emoji）会被 [0] 切出半个代理
  return Array.from(trimmed)[0];
}

// ── 模块级快照（useSyncExternalStore 要求「每次写入换新对象」）─────────────

let snapshot: UserProfile = { ...EMPTY };
let inflight: Promise<UserProfile> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // 第一次有人订阅时拉一次。放在这里而不是模块顶层，是为了让
  // 「只渲染不读资料」的页面（例如纯静态的关于页）不打这个请求。
  if (listeners.size === 1) void loadUserProfile();
  return () => {
    listeners.delete(fn);
  };
}

const getSnapshot = (): UserProfile => snapshot;

/** 从服务端拉一次。并发调用共用同一次请求 */
export async function loadUserProfile(): Promise<UserProfile> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/user-profile');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      snapshot = {
        nickname: typeof data?.nickname === 'string' ? data.nickname : '',
        avatar: typeof data?.avatar === 'string' ? data.avatar : '',
      };
    } catch {
      // 拉不到就当没有资料：不给默认昵称，也不阻塞界面
      snapshot = { ...EMPTY };
    } finally {
      inflight = null;
    }
    emit();
    return snapshot;
  })();
  return inflight;
}

/** 改昵称 / 头像。乐观更新（界面立刻变），失败时回滚并抛出 */
export async function saveUserProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
  const prev = snapshot;
  snapshot = { ...snapshot, ...patch };
  emit();
  try {
    const res = await fetch('/api/user-profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    snapshot = {
      nickname: typeof data?.nickname === 'string' ? data.nickname : '',
      avatar: typeof data?.avatar === 'string' ? data.avatar : '',
    };
    emit();
    return snapshot;
  } catch (err) {
    snapshot = prev;
    emit();
    throw err;
  }
}

/** 组件订阅用 */
export function useUserProfile(): UserProfile {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 只拿昵称的便捷读法（很多地方只需要这一个值） */
export function useUserNickname(): string {
  return useUserProfile().nickname;
}

/** 命令式读取当前昵称（非 Hook 场景，比如拼 @ 提示） */
export function userNicknameNow(): string {
  return snapshot.nickname;
}
