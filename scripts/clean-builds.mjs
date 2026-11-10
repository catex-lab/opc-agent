/**
 * 清理构建垃圾，真正释放磁盘。
 *
 * 背景：本机 E 盘只剩个位数 GB，而一次完整打包会产出约 3.5GB：
 *   win-unpacked（2.26GB，中间产物，安装包生成后就没用）
 *   + setup.exe / portable.exe（各约 650MB，交付物，保留）
 * 项目根 .tmp/ 下还会残留历史 release-XXXX 快照（每个约 565MB）。
 * 不在每次打包后清掉，E 盘必然爆满。
 *
 * 用法：
 *   npm run clean                 # 删除构建中间产物（保留安装包 exe）
 *   node scripts/clean-builds.mjs --dry-run   # 只列出将删除的内容
 *   node scripts/clean-builds.mjs --all       # 额外删 dist / dist-electron
 *   node scripts/clean-builds.mjs --hermes    # 额外删 .hermes-runtime（可用 npm run bundle:hermes-runtime 重建）
 *
 * ⚠️ 删除走 scripts/lib/hard-delete.mjs：
 *    本机在**工作区内**删除会被转存回收站（空间不释放），所以它先 rename 到
 *    工作区外的 `<盘符>:\_opc-trash` 暂存目录，再永久删除。
 *    不要改成直接 fs.rmSync / Remove-Item。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { sizeOf, hardDeleteAndReport } from './lib/hard-delete.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ALL = args.includes('--all');
const WITH_HERMES = args.includes('--hermes');

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, 'release-builds');
const TMP_DIR = path.join(ROOT, '.tmp');

const targets = [];

function pushIfExists(p, label) {
  if (fs.existsSync(p)) targets.push({ path: p, label: label ?? path.relative(ROOT, p) });
}

function listDirs(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(parent, e.name));
  } catch {
    return [];
  }
}

// release-builds/<build>/win-unpacked 与 7z 中间包
for (const buildDir of listDirs(RELEASE_DIR)) {
  const name = path.basename(buildDir);
  pushIfExists(path.join(buildDir, 'win-unpacked'), `release-builds/${name}/win-unpacked`);
  for (const f of fs.readdirSync(buildDir)) {
    if (f.endsWith('.nsis.7z') || f === 'builder-debug.yml') {
      pushIfExists(path.join(buildDir, f), `release-builds/${name}/${f}`);
    }
  }
}

// .tmp/release-XXXX 历史快照
for (const tmpDir of listDirs(TMP_DIR)) {
  if (path.basename(tmpDir).startsWith('release-')) {
    pushIfExists(tmpDir, `.tmp/${path.basename(tmpDir)}`);
  }
}

if (ALL) {
  pushIfExists(path.join(ROOT, 'dist'), 'dist');
  pushIfExists(path.join(ROOT, 'dist-electron'), 'dist-electron');
}

if (WITH_HERMES) {
  pushIfExists(path.join(ROOT, '.hermes-runtime'), '.hermes-runtime');
}

if (targets.length === 0) {
  console.log('[clean] 没有需要清理的构建垃圾');
  process.exit(0);
}

let total = 0;
for (const t of targets) total += sizeOf(t.path);

console.log(`[clean] 待清理 ${targets.length} 项，合计 ${(total / 1024 / 1024 / 1024).toFixed(2)} GB`);
for (const t of targets) {
  const mb = (sizeOf(t.path) / 1024 / 1024).toFixed(1);
  console.log(`  - ${t.label}  (${mb} MB)`);
}

if (DRY_RUN) {
  console.log('[clean] --dry-run：未执行删除');
  process.exit(0);
}

let freed = 0;
for (const t of targets) freed += hardDeleteAndReport(t.path, t.label);

const remain = total - freed;
console.log(
  `[clean] 完成：释放 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB` +
    (remain > 1024 * 1024 ? `，未释放 ${(remain / 1024 / 1024).toFixed(1)} MB（文件被占用）` : '')
);
console.log('[clean] 安装包 exe 已保留在 release-builds/ 下');
