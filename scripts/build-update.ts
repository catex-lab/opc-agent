/**
 * 生成一份可以直接上传到 GitHub Release 的更新资产（本地与 CI 同一套脚本）。
 *
 * 产物（默认写到 `release/update/`）：
 *   · `app-<version>.asar`         —— 从 `release/win-unpacked/resources/app.asar` 拷出
 *   · `OPC-Agent-<version>-x64-full.zip` —— 完整包（win-unpacked 整目录）
 *   · `latest.json`                —— 已签名的清单
 *
 * 前置：先跑 `npm run electron:build`（或 CI 里 `node scripts/build-installer.mjs --dir`）
 * 让 `release/win-unpacked/` 存在。
 *
 * 用法：
 *   npx tsx scripts/build-update.ts \
 *     --version 1.1.0 --notes "修复了…" \
 *     --key .tmp/update-signing-key.json
 *
 * 私钥优先级：`--key <文件>` > 环境变量 `OPC_UPDATE_PRIVATE_KEY`（base64 PKCS#8）。
 * CI 只用后者，私钥不进仓库。
 *
 * ## 与客户端的一致性
 *
 * 清单签名覆盖「去掉 signature 后的全部字段」的规范化 JSON，
 * 规范化实现直接 import `shared/update-manifest.ts` —— 发布侧与客户端
 * 共用同一份代码，避免各写一份导致签出来的东西自己验不过。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  canonicalManifestBody,
  isValidVersion,
} from '../shared/update-manifest.js';
import {
  UPDATE_REPO_SLUG,
  UPDATE_SCHEMA_VERSION,
  type UpdateAsset,
  type UpdateManifest,
} from '../shared/update.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function fail(message: string): never {
  console.error(`[build-update] ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  version: string;
  repository?: { url?: string };
};

const version = arg('version', pkg.version)!;
if (!isValidVersion(version)) fail(`版本号不合法：${version}（必须形如 1.2.3 或 1.2.3-beta.1）`);

const runtimeVersion = arg('runtime-version') ?? (() => {
  const electronPkg = JSON.parse(
    fs.readFileSync(path.join('node_modules', 'electron', 'package.json'), 'utf8')
  ) as { version: string };
  return electronPkg.version;
})();

const asarSource = path.resolve(arg('asar', path.join('release', 'win-unpacked', 'resources', 'app.asar'))!);
if (!fs.existsSync(asarSource)) {
  fail(
    `找不到 ${asarSource}。请先构建打包目录：\n` +
      '  npm run build && npm run build:electron && node scripts/build-installer.mjs --dir'
  );
}

const outDir = path.resolve(arg('out', path.join('release', 'update'))!);
fs.mkdirSync(outDir, { recursive: true });

const channel = arg('channel', 'stable')!;
if (!/^[a-z][a-z0-9-]*$/.test(channel)) fail(`channel 不合法：${channel}`);

const notes = (() => {
  const file = arg('notes-file');
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return arg('notes', '')!.trim() || `OPC Agent v${version}`;
})();

/* ── 资产准备 ─────────────────────────────────────────────── */

const asarName = `app-${version}.asar`;
const fullName = `OPC-Agent-${version}-x64-full.zip`;
const asarOut = path.join(outDir, asarName);
const fullOut = path.join(outDir, fullName);

fs.copyFileSync(asarSource, asarOut);

const zipArg = arg('zip');
if (zipArg) {
  const src = path.resolve(zipArg);
  if (!fs.existsSync(src)) fail(`--zip 指向的文件不存在：${src}`);
  fs.copyFileSync(src, fullOut);
} else if (!fs.existsSync(fullOut)) {
  // win-unpacked 的父目录是 resources，再上一层就是完整应用目录
  const appDir = path.dirname(path.dirname(asarSource));
  if (!fs.existsSync(appDir)) fail(`推不出完整包目录：${appDir}`);
  const r = spawnSync('tar', ['-a', '-c', '-f', fullOut, '-C', appDir, '.'], { stdio: 'inherit' });
  if (r.status !== 0) {
    fail('打完整包失败（Windows 需要系统自带 tar；或改用 --zip 指定已有 zip）');
  }
}

/* ── 摘要 ─────────────────────────────────────────────────── */

function digest(file: string): Promise<{ size: number; sha512: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    let size = 0;
    fs.createReadStream(file)
      .on('data', chunk => {
        size += chunk.length;
        hash.update(chunk);
      })
      .on('end', () => resolve({ size, sha512: hash.digest('base64') }))
      .on('error', reject);
  });
}

const asarDigest = await digest(asarOut);
const fullDigest = await digest(fullOut);

const repo =
  arg('repo') ??
  (pkg.repository?.url?.match(/github\.com[/:]([^/]+)\/([^./]+)/)?.slice(1).join('/') ?? UPDATE_REPO_SLUG);
const repoUrl = `https://github.com/${repo}`;
const assetUrl = (name: string): string => `${repoUrl}/releases/download/v${version}/${name}`;

const asarAsset: UpdateAsset = {
  name: asarName,
  url: assetUrl(asarName),
  sha512: asarDigest.sha512,
  size: asarDigest.size,
};
const fullAsset: UpdateAsset = {
  name: fullName,
  url: assetUrl(fullName),
  sha512: fullDigest.sha512,
  size: fullDigest.size,
};

/* ── 签名 ─────────────────────────────────────────────────── */

function loadPrivateKey(): string {
  const keyArg = arg('key');
  if (keyArg) {
    const raw = fs.readFileSync(path.resolve(keyArg), 'utf8').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { privateKey?: string };
      if (parsed.privateKey) return parsed.privateKey;
    }
    return raw;
  }
  const env = process.env.OPC_UPDATE_PRIVATE_KEY?.trim();
  if (env) return env;
  fail(
    '没有签名私钥。设置环境变量 OPC_UPDATE_PRIVATE_KEY（base64 PKCS#8），或用 --key 指定密钥文件'
  );
  return '';
}

const privateKey = createPrivateKey({
  key: Buffer.from(loadPrivateKey(), 'base64'),
  format: 'der',
  type: 'pkcs8',
});

const manifest: UpdateManifest = {
  schemaVersion: UPDATE_SCHEMA_VERSION,
  version,
  releasedAt: new Date().toISOString(),
  notes,
  runtimeVersion,
  channel,
  assets: { asar: asarAsset, full: fullAsset },
  signature: '',
};
manifest.signature = sign(null, Buffer.from(canonicalManifestBody(manifest), 'utf8'), privateKey).toString('base64');

const manifestPath = path.join(outDir, 'latest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

/* ── 汇报 ─────────────────────────────────────────────────── */

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;
console.log('\n[build-update] 产物已生成：');
console.log(`  版本           v${version}（runtime Electron ${runtimeVersion} / ${channel}）`);
console.log(`  代码层 asar    ${asarOut}（${mb(asarDigest.size)}）`);
console.log(`  完整包 zip     ${fullOut}（${mb(fullDigest.size)}）`);
console.log(`  清单           ${manifestPath}`);
console.log('\n上传到同一 Release（tag v' + version + '）：');
console.log(`  gh release create v${version} --title "OPC Agent v${version}" --notes-file <说明文件> \\`);
console.log(`    "${asarOut}" "${fullOut}" "${manifestPath}"`);
console.log('\n本地验证整条链路：npm run verify:a171-update\n');
