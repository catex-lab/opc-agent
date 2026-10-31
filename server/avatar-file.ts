/**
 * 头像文件名的纯工具（**无副作用**）。
 *
 * 为什么单独拆一层：`user-profile.ts` 要校验 avatarImage，`avatar-store.ts`
 * 要落盘 + 校验，而 `avatar-store.ts` 又要读用户资料判断「这张图还有没有
 * 人在用」。三者互相 import 会形成环：`user-profile → avatar-store →
 * user-profile`。把纯正则/路径规则放到这里，两边都只依赖它，环就断了。
 *
 * 目录穿越是这个模块存在的首要理由：`GET /api/avatars/:file` 把用户可控的
 * 字符串拼进路径，`../../server/index.ts` 这类值必须在进入 fs 之前挡掉。
 */

import path from 'node:path';
import { dataDirPath } from './paths.js';

/** 头像目录。与 images/ 同级，随 OPC_DATA_DIR 一起走 */
export const avatarsDir = path.join(dataDirPath, 'avatars');

/** 允许的扩展名。只收我们自己生成的那三种位图 */
const SAFE_FILE_RE = /^[a-f0-9]{20,64}\.(png|jpg|webp)$/;

export function isSafeAvatarFile(file: string): boolean {
  return SAFE_FILE_RE.test(file);
}

/** 头像 URL 的形状。服务端与前端都靠它判断「这一串是不是我们发的」 */
export const AVATAR_URL_RE = /^\/api\/avatars\/[a-f0-9]{20,64}\.(png|jpg|webp)$/;

export function avatarUrlOfFile(file: string): string {
  return `/api/avatars/${file}`;
}

/** 从 URL 里取回文件名；不是合法头像 URL 时返回 undefined */
export function avatarFileOfUrl(url: string | undefined): string | undefined {
  if (!url || !AVATAR_URL_RE.test(url)) return undefined;
  return url.slice('/api/avatars/'.length);
}

/**
 * 解析出绝对路径。双保险：先过白名单，再断言结果仍在头像目录内
 * （防止将来有人放宽了正则却忘了这条约束）。
 */
export function avatarFilePath(file: string): string {
  if (!isSafeAvatarFile(file)) throw new Error(`非法的头像文件名: ${file}`);
  const base = path.resolve(avatarsDir);
  const resolved = path.resolve(base, file);
  if (resolved !== path.join(base, file)) throw new Error(`头像路径越界: ${file}`);
  return resolved;
}
