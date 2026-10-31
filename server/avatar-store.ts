/**
 * 用户头像 / Agent Logo 的本地图片仓库。
 *
 * ## 为什么落盘而不是塞进 JSON
 *
 * 一份 320×320 的 WebP 约 10~40KB，base64 进 user-profile.json 会再涨 33%，
 * 而且每次读资料都要把整张图解析一遍。图片按内容哈希单独存文件，JSON 里
 * 只留一个 URL —— 两个文件各自干各自的事，改头像时也不用重写整个资料。
 *
 * ## 为什么按内容哈希命名
 *
 * 同一张图重复上传天然去重；文件名只由字节决定，因此内容永不变，
 * 可以放心给 `Cache-Control: immutable`。换头像时旧文件按「还有没有人
 * 引用」决定删除 —— 用户头像和某个 Agent 可能共用同一张图，不能盲目删。
 *
 * ## 为什么校验在服务端做
 *
 * 前端裁剪后发来的 dataUrl 是**用户可控输入**。只信任前端的 mime 等于
 * 让任意字节写进磁盘；这里嗅探文件头，PNG/JPEG/WebP 以外一律拒收
 * （SVG 被明确排除：它内嵌脚本，直接当 <img> 打开都能带 XSS 风险）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { dataDirPath } from './paths.js';
import {
  avatarFileOfUrl,
  avatarFilePath,
  avatarUrlOfFile,
  avatarsDir,
  isSafeAvatarFile,
} from './avatar-file.js';
import { loadUserProfile } from './user-profile.js';

/** 单张图上限 2MB（客户端产出的 320×320 WebP 远小于此） */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  // 少数来源（剪贴板/旧浏览器）会写 image/jpg，它是 image/jpeg 的别名
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};

/** Agent 外观映射文件。**不动**内置定义表与 custom-agents.json */
const appearancePath = path.join(dataDirPath, 'agent-appearance.json');

interface AppearanceEntry {
  /** 文件名（`<sha1>.webp`），URL 由它派生 */
  logo: string;
  updatedAt: string;
}
type AppearanceMap = Record<string, AppearanceEntry>;

let cachedAppearance: AppearanceMap | null = null;

/**
 * 按文件头嗅探真实类型。
 *
 * 不信 dataUrl 里声明的 mime：声明可以写 `image/webp` 而实际是 SVG 脚本。
 */
function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 解析并校验一个 `data:image/...;base64,...`。
 *
 * 失败一律抛 Error（消息直接给人看），由路由转成 400 —— 静默忽略会让
 * 「点了上传但头像没变」变成没法排查的问题。
 */
export function decodeAvatarDataUrl(dataUrl: unknown): { buf: Buffer; ext: string } {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    throw new Error('请选择一张图片');
  }
  const match = /^data:([a-z0-9/+.-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) throw new Error('图片格式无法识别（只支持 PNG / JPEG / WebP）');
  const declared = match[1].toLowerCase();
  if (!EXT_BY_MIME[declared]) {
    throw new Error('只支持 PNG / JPEG / WebP 图片');
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(match[2], 'base64');
  } catch {
    throw new Error('图片数据损坏，请重新选择');
  }
  if (buf.byteLength === 0) throw new Error('图片内容为空');
  if (buf.byteLength > MAX_AVATAR_BYTES) throw new Error('图片不能超过 2MB');

  const sniffed = sniffImageMime(buf);
  if (!sniffed) throw new Error('文件内容不是有效的 PNG / JPEG / WebP');
  // 声明与实况必须一致：不一致说明调用方在拼一条我们没预期的 dataUrl
  if (sniffed !== declared && !(declared === 'image/jpg' && sniffed === 'image/jpeg')) {
    throw new Error('图片类型与内容不符，请重新选择');
  }
  return { buf, ext: EXT_BY_MIME[sniffed] };
}

/** 落盘。内容哈希去重，先写临时文件再 rename（避免半张图） */
function writeAvatarFile(buf: Buffer, ext: string): string {
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 40);
  const file = `${hash}.${ext}`;
  const target = avatarFilePath(file);
  mkdirSync(avatarsDir, { recursive: true });
  if (existsSync(target)) return file;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, target);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* 清理失败不影响主流程 */ }
    throw err;
  }
  return file;
}

function readAppearanceFromDisk(): AppearanceMap {
  try {
    if (!existsSync(appearancePath)) return {};
    const raw = JSON.parse(readFileSync(appearancePath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: AppearanceMap = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = value as Partial<AppearanceEntry> | null;
      // 坏条目直接丢掉：一个手改坏的文件不该让整张表失效
      if (v && typeof v.logo === 'string' && isSafeAvatarFile(v.logo)) {
        out[id] = {
          logo: v.logo,
          updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date(0).toISOString(),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function appearance(): AppearanceMap {
  if (!cachedAppearance) cachedAppearance = readAppearanceFromDisk();
  return cachedAppearance;
}

function saveAppearance(next: AppearanceMap): void {
  cachedAppearance = next;
  try {
    mkdirSync(dataDirPath, { recursive: true });
    // 同样先临时文件再 rename：写到一半断电不会留下一个半截 JSON
    const tmp = `${appearancePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    renameSync(tmp, appearancePath);
  } catch (err) {
    // 写不进去只影响重启后还在不在；本次进程内仍然生效
    console.warn('[AvatarStore] 写入外观映射失败（本次会话仍生效）:', (err as Error).message);
  }
}

/** 供测试/诊断用的只读快照 */
export function agentAppearanceSnapshot(): AppearanceMap {
  return { ...appearance() };
}

/** 这张文件还有没有人在用（用户头像或任意 Agent） */
function isFileReferenced(file: string): boolean {
  const userFile = avatarFileOfUrl(loadUserProfile().avatarImage);
  if (userFile === file) return true;
  return Object.values(appearance()).some(entry => entry.logo === file);
}

/** 只有在没人引用时才删文件。删不掉的失败不影响返回值 */
export function deleteAvatarFileIfUnused(file: string): void {
  if (!isSafeAvatarFile(file) || isFileReferenced(file)) return;
  try {
    unlinkSync(avatarFilePath(file));
  } catch {
    // 文件本来就不在 / 被占用：留着也无害，不要因此让接口失败
  }
}

/** 保存一张新头像，返回可给前端用的 URL。旧文件不在这里删 —— 调用方知道哪个是旧的 */
export function storeAvatar(dataUrl: unknown): { url: string; file: string } {
  const { buf, ext } = decodeAvatarDataUrl(dataUrl);
  const file = writeAvatarFile(buf, ext);
  return { url: avatarUrlOfFile(file), file };
}

/** 某个 Agent 的自定义 Logo（没有就是 undefined，界面退回内置图标） */
export function getAgentLogoUrl(agentId: string): string | undefined {
  const entry = appearance()[agentId];
  return entry ? avatarUrlOfFile(entry.logo) : undefined;
}

export function setAgentLogo(agentId: string, file: string): string {
  if (!isSafeAvatarFile(file)) throw new Error('非法的头像文件');
  const next = { ...appearance(), [agentId]: { logo: file, updatedAt: new Date().toISOString() } };
  saveAppearance(next);
  return avatarUrlOfFile(file);
}

/**
 * 恢复内置 Logo：删掉映射即可，**不改**定义表 / custom-agents.json。
 * 这里只返回被释放的文件名，真正删文件由调用方在「确认无人引用」后做 ——
 * 与用户头像共用同一张图的场景不能让恢复默认把对方的头像也删了。
 */
export function clearAgentLogo(agentId: string): string | undefined {
  const entry = appearance()[agentId];
  if (!entry) return undefined;
  const next = { ...appearance() };
  delete next[agentId];
  saveAppearance(next);
  return entry.logo;
}

/** 清空所有映射（测试用；删自建 Agent 时只清单条） */
export function resetAgentAppearance(): void {
  saveAppearance({});
}
