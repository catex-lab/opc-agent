/**
 * 生成图片的本地缓存（P4-4）。
 *
 * 为什么必须落盘：CogView 返回的**不是**永久地址，而是一个带签名的临时 URL
 * （形如 `...ufileos.com/<id>_watermark.png?UCloudPublicKey=...&Signature=...&Expires=1792775735`），
 * 实测 `Expires` 约在 7 天后。若直接把远端 URL 存进消息表，一周后所有历史
 * 图片都会变成裂图 —— 而且是在用户什么都没做的情况下静默坏掉。
 * 所以生成成功后立刻把字节抓回本地，消息里存本地路径。
 *
 * 本模块只负责「下载 + 落盘 + 路径校验」，不碰数据库。
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/** 单张图片的字节上限，防止把磁盘写满（CogView 产物约 1~3MB） */
const MAX_BYTES = 16 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface CachedImage {
  /** 落盘文件名（相对 images 目录），如 `a1b2c3d4e5f6a7b8.png` */
  file: string;
  bytes: number;
}

/**
 * 文件名白名单。
 *
 * 这个函数存在的唯一理由是**目录穿越**：`GET /api/images/:file` 会把用户
 * 可控的字符串拼进路径，`../../server/index.ts` 这类值必须在进入 fs 之前
 * 就被挡掉。只放行「16~64 位十六进制 + 已知图片扩展名」，即我们自己生成的形态。
 */
export function isSafeImageFile(file: string): boolean {
  return /^[a-f0-9]{16,64}\.(png|jpg|jpeg|webp|gif)$/i.test(file);
}

/**
 * 解析出图片的绝对路径。
 *
 * 双保险：先过 `isSafeImageFile` 白名单，再断言解析结果仍在 images 目录内
 * （防止将来有人放宽了正则却忘了这条约束）。
 */
export function imageFilePath(dir: string, file: string): string {
  if (!isSafeImageFile(file)) {
    throw new Error(`非法的图片文件名: ${file}`);
  }
  const base = path.resolve(dir);
  const resolved = path.resolve(base, file);
  if (resolved !== path.join(base, file)) {
    throw new Error(`图片路径越界: ${file}`);
  }
  return resolved;
}

/**
 * 把远端图片下载到本地目录。
 *
 * @returns 成功返回落盘信息；**任何失败都返回 null**（不抛）——
 *          调用方据此降级为「保留远端 URL」，而不是让整次生图失败：
 *          图已经生成出来了，因为缓存写不进去就丢掉它才是真正的浪费。
 */
export async function cacheImage(
  url: string,
  dir: string,
  fetchImpl: typeof fetch = fetch
): Promise<CachedImage | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;

    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_MIME[mime];
    if (!ext) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;

    // 内容哈希命名：同一张图重复缓存不会产生副本，且天然满足文件名白名单
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const file = `${hash}.${ext}`;
    const target = imageFilePath(dir, file);

    await fs.mkdir(dir, { recursive: true });
    // 已存在就跳过写入（内容哈希相同 = 同一张图）
    try {
      await fs.access(target);
      return { file, bytes: buf.byteLength };
    } catch {
      // 不存在，继续写
    }
    // 先写临时文件再 rename：避免进程在写一半时被杀，留下半张图
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);

    return { file, bytes: buf.byteLength };
  } catch {
    return null;
  }
}
