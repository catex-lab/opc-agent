/**
 * 打包产物的内嵌图标核对（真包 e2e 的最后一层）。
 *
 * 前面几层验的是「资产正确、界面正确」，这一层验的是**用户真正拿到手的
 * exe 里嵌的就是同一枚图标**：桌面快捷方式、开始菜单、任务栏固定项、
 * Alt+Tab、安装包图标，全部取自 exe 的 PE 图标资源，不是 build/ 目录。
 *
 * 做法：解析 PE 的 .rsrc，取出全部 RT_ICON（类型 3）位图，按 **PNG IHDR
 * 的真实尺寸**与 build/icon.ico 的条目一一配对，逐字节比对。
 *
 * ⚠️ 两个踩过的坑，改这个脚本前必读：
 *   1. **不能按 RT_GROUP_ICON 目录的 width/id 字段配对**。实测 rcedit
 *      （electron-builder 的图标写入器）写出的目录字段是错的：第一条
 *      w=16 h=1，id 与 RT_ICON 的真实尺寸也对不上。按它配会产生一堆
 *      假失败。目录只能用来数个数，配对必须看位图自己的 IHDR。
 *   2. **不能递归扫 release-pNN 快照目录**。那些是历史 snapshots，
 *      同名 exe 会被反复报七八遍。只认当前构建：release-builds 里最新
 *      的时间戳目录 + release/win-unpacked。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

/** 从 PE 里解析出全部 RT_ICON 位图（按资源 id）与 RT_GROUP_ICON 目录 */
function extractPeIcons(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') return null;
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const secTable = peOff + 24 + optSize;
  let rsrc = null;
  for (let i = 0; i < numSections; i++) {
    const off = secTable + i * 40;
    const name = buf.toString('latin1', off, off + 8).replace(/\0/g, '');
    if (name === '.rsrc') {
      rsrc = { va: buf.readUInt32LE(off + 12), raw: buf.readUInt32LE(off + 20) };
    }
  }
  if (!rsrc) return null;
  const rvaToRaw = va => rsrc.raw + (va - rsrc.va);

  const icons = new Map(); // 资源 id -> PNG 字节
  const groups = [];

  function walk(dirVa, typeId, resId, depth) {
    const base = rvaToRaw(dirVa);
    const named = buf.readUInt16LE(base + 12);
    const ids = buf.readUInt16LE(base + 14);
    for (let i = 0; i < named + ids; i++) {
      const ent = base + 16 + i * 8;
      const entryName = buf.readUInt32LE(ent);
      const entryOff = buf.readUInt32LE(ent + 4);
      const isDir = (entryOff & 0x80000000) !== 0;
      const childVa = rsrc.va + (entryOff & 0x7fffffff);
      if (depth === 0) {
        // 第一层是类型：3 = RT_ICON，14 = RT_GROUP_ICON
        walk(childVa, entryName, resId, 1);
      } else if (depth === 1) {
        walk(childVa, typeId, entryName, 2);
      } else {
        // 叶子：资源数据入口（RVA + 尺寸）
        const dataRaw = rvaToRaw(childVa);
        const dataAddr = rvaToRaw(buf.readUInt32LE(dataRaw));
        const size = buf.readUInt32LE(dataRaw + 4);
        const blob = buf.subarray(dataAddr, dataAddr + size);
        if (typeId === 3) icons.set(resId, blob);
        else if (typeId === 14) groups.push(blob);
      }
    }
  }
  walk(rsrc.va, 0, 0, 0);
  return { icons, groups };
}

/** PNG 的真实像素尺寸（IHDR）—— 配对的唯一依据 */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** build/icon.ico 的条目 → [{ size, data }] */
function readSourceIco(path) {
  const buf = readFileSync(path);
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const declared = buf.readUInt8(e) || 256;
    const len = buf.readUInt32LE(e + 8);
    const start = buf.readUInt32LE(e + 12);
    const data = buf.subarray(start, start + len);
    // 以 IHDR 为准：目录里的字节对 256 记 0，且不做四舍五入
    const real = pngSize(data);
    out.push({ size: real ? real.width : declared, data });
  }
  return out;
}

/** 只找**当前构建**的 exe：release-builds 最新时间戳目录 + release/win-unpacked */
function findCurrentExes() {
  const out = [];
  const newestTimestampDir = () => {
    const base = join(ROOT, 'release-builds');
    if (!existsSync(base)) return null;
    let best = null;
    for (const name of readdirSync(base)) {
      const p = join(base, name);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      const st = statSync(p);
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    }
    return best?.p ?? null;
  };
  const tsDir = newestTimestampDir();
  if (tsDir) {
    for (const f of readdirSync(tsDir)) {
      if (/\.exe$/i.test(f) && /-setup\.exe|-portable\.exe$/i.test(f)) out.push(join(tsDir, f));
    }
    const unpacked = join(tsDir, 'win-unpacked', 'OPC Agent.exe');
    if (existsSync(unpacked)) out.push(unpacked);
  }
  const releaseUnpacked = join(ROOT, 'release', 'win-unpacked', 'OPC Agent.exe');
  if (existsSync(releaseUnpacked)) out.push(releaseUnpacked);
  // 去重（同一个文件可能从两条路径都够到）
  return [...new Set(out.map(p => join(p)))].filter(existsSync);
}

const srcIco = readSourceIco(join(ROOT, 'build/icon.ico'));
const srcBySize = new Map(srcIco.map(e => [e.size, e.data]));

const exes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : findCurrentExes();
if (exes.length === 0) {
  console.log('⚠ 没找到当前构建的 exe（release-builds/最新目录 或 release/win-unpacked），跳过 —— 这个脚本不阻塞没打包的环境');
  process.exit(0);
}

let fail = 0;
let total = 0;
for (const exe of exes) {
  const buf = readFileSync(exe);
  const parsed = extractPeIcons(buf);
  if (!parsed || parsed.icons.size === 0) {
    console.log(`✗ ${basename(exe)}：没有解析到图标资源`);
    fail++;
    continue;
  }
  // 按 IHDR 真实尺寸配对
  const bySize = new Map();
  for (const blob of parsed.icons.values()) {
    const s = pngSize(blob);
    if (s) bySize.set(s.width, blob);
  }
  const sizes = [...bySize.keys()].sort((a, b) => a - b);
  console.log(`• ${basename(exe)}：内嵌 ${sizes.length} 个尺寸 [${sizes.join('/')}]（RT_GROUP_ICON 目录 ${parsed.groups.length} 份）`);
  for (const size of sizes) {
    total++;
    const blob = bySize.get(size);
    const src = srcBySize.get(size);
    if (!src) {
      console.log(`  ✗ ${size}px：build/icon.ico 里没有这个尺寸`);
      fail++;
    } else if (Buffer.compare(blob, src) !== 0) {
      console.log(`  ✗ ${size}px：与 build/icon.ico 不一致（exe ${blob.length}B vs 源 ${src.length}B）`);
      fail++;
    } else {
      console.log(`  ✓ ${size}px：与 build/icon.ico 逐字节一致（${blob.length}B）`);
    }
  }
}

if (fail > 0) {
  console.error(`\n✗ ${fail}/${total} 个尺寸不符 —— exe 里的图标不是当前设计，需要重新打包`);
  process.exit(1);
}
console.log(`\n✓ ${total}/${total} 全部一致：打包产物内嵌的就是当前同人卦图标`);
