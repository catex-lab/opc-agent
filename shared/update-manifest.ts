/**
 * 更新清单的纯逻辑：版本比较、规范化、验签、字段/路径/URL 校验、摘要校验。
 *
 * ## 为什么单独一层
 *
 * 这些函数**不碰 Electron、不碰网络、不碰磁盘**，所以能被
 * `scripts/verify-a171-update.ts` 直接穷举：版本比较的预发布边界、
 * 签名被改一个字节、哈希不匹配、路径穿越、运行时版本不一致，
 * 都能在没有真实发布资产的情况下验证。主进程里剩下的只有「下载、落盘、
 * 退出时替换」这些副作用。
 *
 * ## fail closed
 *
 * 任何一个环节不对都返回「错误原因」，**没有「跳过校验继续装」的分支**。
 * 清单里出现绝对路径、`..`、盘符、非 HTTPS、非白名单域名，一律拒绝。
 */

import { createHash, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import type { UpdateAsset, UpdateManifest } from './update.js';
import { UPDATE_SCHEMA_VERSION } from './update.js';

/** 允许的发布资产域名（GitHub release 下载会 302 到 objects.githubusercontent.com） */
export const UPDATE_URL_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const;

/** 默认允许域名，测试可传自己的白名单 */
export type UrlHosts = readonly string[];

/* ══════════════ 版本 ══════════════ */

const SEMVER_RE =
  /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[] | null;
}

export function parseVersion(v: string): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ? m[4].split('.') : null,
  };
}

export function isValidVersion(v: string): boolean {
  return parseVersion(v) != null;
}

/**
 * 按 SemVer 2.0 比较。
 *
 * 预发布规则是这道题最容易写错的地方：
 *   · 有预发布 < 无预发布（1.0.0-beta < 1.0.0）；
 *   · 点分段逐个比较，数字段按数值、字母段按字典序；
 *   · 数字段 < 字母段（1.0.0-1 < 1.0.0-alpha）；
 *   · 前缀相同则段数少的更小（1.0.0-alpha < 1.0.0-alpha.1）。
 * 构建元数据（+xxx）不参与比较。
 *
 * @returns 负数 = a 更旧，0 = 相等，正数 = a 更新；任一方非法抛错（调用方先校验）
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`版本号不合法：${!pa ? a : b}`);

  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }

  const ra = pa.prerelease;
  const rb = pb.prerelease;
  // 没有预发布 = 正式版，比任何预发布都新
  if (!ra && !rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;

  const len = Math.min(ra.length, rb.length);
  for (let i = 0; i < len; i++) {
    const x = ra[i];
    const y = rb[i];
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      // 数字标识符优先级低于字母标识符
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ra.length - rb.length;
}

/* ══════════════ 规范化与签名 ══════════════ */

/**
 * 键递归排序、无空白的 JSON。
 *
 * 签名与验签必须用**同一份**函数。注意 JSON.stringify 的键顺序依赖对象
 * 字面量的插入顺序 —— 发布脚本与客户端哪怕字段顺序不同，签名都会对不上。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('规范化 JSON 不接受非有限数字');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** 签名覆盖的正文 = 清单去掉 signature 后的规范化 JSON */
export function canonicalManifestBody(manifest: UpdateManifest | Record<string, unknown>): string {
  const { signature: _ignored, ...body } = manifest as UpdateManifest;
  return canonicalJson(body);
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * ed25519 验签。
 *
 * `publicKeyBase64` 是 SPKI DER 的 base64（`update-keygen` 脚本输出的就是它）。
 * 签名同样是 base64。任何解析/验签异常都收敛成 `ok:false`，
 * 不让异常穿透到调用方 —— 调用方只需要处理「过 / 不过」。
 */
export function verifyManifestSignature(
  manifest: UpdateManifest,
  publicKeyBase64: string
): VerifyResult {
  if (typeof manifest?.signature !== 'string' || !manifest.signature) {
    return { ok: false, error: '清单缺少签名' };
  }
  if (typeof publicKeyBase64 !== 'string' || !publicKeyBase64) {
    return { ok: false, error: '没有内置公钥' };
  }
  try {
    const pem = `-----BEGIN PUBLIC KEY-----\n${wrapBase64(publicKeyBase64)}-----END PUBLIC KEY-----\n`;
    const body = canonicalManifestBody(manifest);
    const ok = cryptoVerify(null, Buffer.from(body, 'utf8'), pem, Buffer.from(manifest.signature, 'base64'));
    return ok ? { ok: true } : { ok: false, error: '签名不匹配（清单可能被篡改）' };
  } catch (e) {
    return { ok: false, error: `验签失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

function wrapBase64(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  // 每 64 字符一行，且**必须以换行收尾** —— 否则最后一行会和
  // `-----END PUBLIC KEY-----` 拼在同一行，OpenSSL 直接报 DECODER unsupported。
  const lines = clean.match(/.{1,64}/g) ?? [];
  return `${lines.join('\n')}\n`;
}

/* ══════════════ 字段 / 路径 / URL ══════════════ */

export interface ParseManifestResult {
  ok: boolean;
  manifest?: UpdateManifest;
  code?: string;
  error?: string;
}

function fail(code: string, error: string): ParseManifestResult {
  return { ok: false, code, error };
}

/**
 * 资产文件名必须是**单段安全文件名**。
 *
 * 拒绝：绝对路径、`..`、盘符、正反斜杠、空名。
 * 允许：字母数字开头，后续只许字母数字、点、下划线、连字符。
 * 客户端落盘时用这个名字拼路径 —— 这里放行一个 `../x` 就等于允许写任意位置。
 */
export function checkAssetName(name: unknown, kind: 'asar' | 'full'): string | null {
  if (typeof name !== 'string' || !name) return '资产名缺失';
  if (name.length > 200) return '资产名过长';
  if (/[\\/]/.test(name)) return `资产名不允许包含路径分隔符：${name}`;
  if (name.includes('..')) return `资产名不允许包含 ".."：${name}`;
  if (/^[A-Za-z]:/.test(name)) return `资产名不允许包含盘符：${name}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return `资产名含非法字符：${name}`;
  const ext = kind === 'asar' ? '.asar' : '.zip';
  if (!name.toLowerCase().endsWith(ext)) return `${kind} 资产必须以 ${ext} 结尾：${name}`;
  return null;
}

/** HTTPS + 域名白名单。非 HTTPS、非白名单域名一律拒绝（fail closed） */
export function checkAssetUrl(url: unknown, allowedHosts: UrlHosts = UPDATE_URL_HOSTS): string | null {
  if (typeof url !== 'string' || !url) return '资产地址缺失';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `资产地址不是合法 URL：${url}`;
  }
  if (parsed.protocol !== 'https:') return `资产地址必须是 HTTPS：${url}`;
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) return `资产地址域名不在白名单：${host}`;
  return null;
}

function parseAsset(raw: unknown, kind: 'asar' | 'full', hosts: UrlHosts): UpdateAsset | string {
  if (!raw || typeof raw !== 'object') return `assets.${kind} 缺失`;
  const a = raw as Partial<UpdateAsset>;
  const nameErr = checkAssetName(a.name, kind);
  if (nameErr) return nameErr;
  const urlErr = checkAssetUrl(a.url, hosts);
  if (urlErr) return urlErr;
  if (typeof a.sha512 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(a.sha512)) {
    return `assets.${kind}.sha512 必须是 base64`;
  }
  if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0) {
    return `assets.${kind}.size 必须是正整数`;
  }
  return { name: a.name as string, url: a.url as string, sha512: a.sha512, size: a.size };
}

/**
 * 解析并校验清单字段。**不验签**（验签单独调用，因为测试要能只测字段）。
 */
export function parseManifest(
  raw: unknown,
  allowedHosts: UrlHosts = UPDATE_URL_HOSTS
): ParseManifestResult {
  if (!raw || typeof raw !== 'object') return fail('manifest-invalid', '清单不是对象');
  const m = raw as Partial<UpdateManifest>;

  if (m.schemaVersion !== UPDATE_SCHEMA_VERSION) {
    return fail('manifest-invalid', `清单格式版本不支持：${String(m.schemaVersion)}`);
  }
  if (!isValidVersion(m.version ?? '')) {
    return fail('manifest-invalid', `版本号不合法：${String(m.version)}`);
  }
  if (typeof m.releasedAt !== 'string' || !Number.isFinite(Date.parse(m.releasedAt))) {
    return fail('manifest-invalid', 'releasedAt 不是合法时间');
  }
  if (typeof m.notes !== 'string') return fail('manifest-invalid', 'notes 缺失');
  if (typeof m.runtimeVersion !== 'string' || !m.runtimeVersion.trim()) {
    return fail('manifest-invalid', 'runtimeVersion 缺失');
  }
  if (typeof m.channel !== 'string' || !/^[a-z][a-z0-9-]*$/.test(m.channel)) {
    return fail('manifest-invalid', 'channel 不合法');
  }
  if (typeof m.signature !== 'string' || !m.signature.trim()) {
    return fail('manifest-invalid', 'signature 缺失');
  }
  if (!m.assets || typeof m.assets !== 'object') {
    return fail('manifest-invalid', 'assets 缺失');
  }

  const asar = parseAsset((m.assets as Record<string, unknown>).asar, 'asar', allowedHosts);
  if (typeof asar === 'string') return fail('manifest-invalid', asar);
  const full = parseAsset((m.assets as Record<string, unknown>).full, 'full', allowedHosts);
  if (typeof full === 'string') return fail('manifest-invalid', full);

  return {
    ok: true,
    manifest: {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      version: m.version!,
      releasedAt: m.releasedAt,
      notes: m.notes,
      runtimeVersion: m.runtimeVersion,
      channel: m.channel,
      assets: { asar, full },
      signature: m.signature,
    },
  };
}

/* ══════════════ 摘要 ══════════════ */

/** 下载内容的 sha512（base64），与清单里的 `sha512` 同口径 */
export function sha512Base64(data: Buffer | Uint8Array): string {
  return createHash('sha512').update(data).digest('base64');
}

/**
 * 校验已下载文件：**先比字节数，再比摘要**。
 *
 * 只比摘要不比大小会放过「内容恰好哈希相同但长度不同」的理论构造；
 * 大小是清单里独立给出的第二道证据，而且能提前拒绝被截断的下载。
 */
export function verifyAssetDigest(
  data: Buffer | Uint8Array,
  asset: Pick<UpdateAsset, 'sha512' | 'size'>
): string | null {
  if (data.length !== asset.size) {
    return `体积不符：期望 ${asset.size} 字节，实际 ${data.length} 字节`;
  }
  const actual = sha512Base64(data);
  const a = Buffer.from(actual, 'base64');
  const b = Buffer.from(asset.sha512, 'base64');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return '摘要不符（下载内容与清单不一致）';
  }
  return null;
}

/* ══════════════ 综合判定 ══════════════ */

export interface EvaluateOptions {
  currentVersion: string;
  /** 本机 Electron 运行时版本（process.versions.electron） */
  runtimeVersion: string;
  publicKeyBase64: string;
  allowedHosts?: UrlHosts;
}

export type UpdateDecision =
  | { status: 'latest'; version: string }
  | { status: 'available'; version: string; requiresFull: boolean }
  | { status: 'invalid'; code: string; message: string };

/**
 * 一次检查的完整判定：字段 → 验签 → 版本 → 运行时。
 *
 * 顺序刻意是「先验签再比版本」：一个被篡改的清单哪怕版本号看起来更新，
 * 也不能进入下载分支。运行时版本不一致只在**确实有新版本**时才判为
 * `requiresFull`，否则「已是最新」不该被一条无关的版本差异搅乱。
 */
export function evaluateManifest(raw: unknown, opts: EvaluateOptions): UpdateDecision {
  const parsed = parseManifest(raw, opts.allowedHosts);
  if (!parsed.ok || !parsed.manifest) {
    return { status: 'invalid', code: parsed.code ?? 'manifest-invalid', message: parsed.error ?? '清单不合法' };
  }
  const manifest = parsed.manifest;

  const sig = verifyManifestSignature(manifest, opts.publicKeyBase64);
  if (!sig.ok) {
    return { status: 'invalid', code: 'signature', message: sig.error ?? '验签失败' };
  }

  if (!isValidVersion(opts.currentVersion)) {
    return { status: 'invalid', code: 'version', message: `本机版本号不合法：${opts.currentVersion}` };
  }
  if (compareVersions(manifest.version, opts.currentVersion) <= 0) {
    return { status: 'latest', version: manifest.version };
  }

  const runtimeMismatch = manifest.runtimeVersion !== opts.runtimeVersion;
  return { status: 'available', version: manifest.version, requiresFull: runtimeMismatch };
}
