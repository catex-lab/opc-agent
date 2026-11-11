/**
 * 头像 / Logo 的上传接口（A160）。
 *
 * 三处入口（我的资料、Agent 详情页）都走这里，保证「裁剪出来的图怎么发、
 * 成功后本地快照怎么刷新」只有一份实现。服务端负责落盘与校验，
 * 见 `server/avatar-store.ts`；这里只发 dataUrl、拿到 URL。
 */

import { loadUserProfile } from './userProfile';

async function postAvatar(body: {
  kind: 'user' | 'agent' | 'group';
  agentId?: string;
  sessionId?: string;
  dataUrl: string;
}) {
  const res = await fetch('/api/avatars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `上传失败（HTTP ${res.status}）`);
  }
  return (data ?? {}) as { url?: string; profile?: { avatarImage?: string } };
}

/** 上传用户头像。成功后立刻刷新本地快照，三个展示点一起变 */
export async function uploadUserAvatar(dataUrl: string): Promise<string> {
  const { url } = await postAvatar({ kind: 'user', dataUrl });
  await loadUserProfile();
  return url ?? '';
}

/** 移除用户头像：图片层清空，界面回到之前选的预设 */
export async function removeUserAvatar(): Promise<void> {
  const res = await fetch('/api/avatars', { method: 'DELETE' });
  if (!res.ok) throw new Error(`移除头像失败（HTTP ${res.status}）`);
  await loadUserProfile();
}

/** 上传 Agent Logo。返回新 URL；调用方负责刷新注册表（让列表一起变） */
export async function uploadAgentLogo(agentId: string, dataUrl: string): Promise<string> {
  const { url } = await postAvatar({ kind: 'agent', agentId, dataUrl });
  return url ?? '';
}

/**
 * 上传群自定义头像（2026-11-12）。与用户头像 / Agent Logo 走同一套
 * 内容哈希仓库；服务端按 sessionId 登记引用，移除 / 更换时自动回收
 * 无人引用的文件。返回的 URL 由调用方写进 sessionFlags.avatarImage。
 */
export async function uploadGroupAvatar(sessionId: string, dataUrl: string): Promise<string> {
  const { url } = await postAvatar({ kind: 'group', sessionId, dataUrl });
  return url ?? '';
}

/** 移除群自定义头像：服务端解除引用登记并回收无人引用的文件 */
export async function removeGroupAvatar(sessionId: string): Promise<void> {
  const res = await fetch(`/api/avatars/group/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`移除头像失败（HTTP ${res.status}）`);
}

/** 恢复默认 Logo（只删映射，不动定义表） */
export async function removeAgentLogo(agentId: string): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/logo`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`恢复默认 Logo 失败（HTTP ${res.status}）`);
}
