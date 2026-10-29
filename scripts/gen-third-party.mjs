#!/usr/bin/env node
/**
 * 生成 THIRD-PARTY-LICENSES.txt —— 随安装包分发的第三方组件许可清单。
 *
 * 为什么需要这个文件：
 *   本项目自身是 MIT，但安装包里打进去的是 `dependencies` 的**完整生产依赖树**
 *   （express / node-pty / @tencent-ai/agent-sdk / uuid / typescript 及其传递依赖）。
 *   MIT 与 Apache-2.0 都要求「分发副本时保留版权与许可声明」。electron-builder.yml
 *   把所有 `LICENSE` 文件排除了（那是为了减小包体），于是这条义务就落空了 ——
 *   这个文件把声明补回来：它随仓库公开，并在应用内「关于与隐私」页里被指到。
 *
 * 口径：
 *   - 只统计 `npm ls --omit=dev`，即真正会被 electron-builder 打进包的那棵树；
 *     devDependencies（React / Vite / Electron 本体等）由使用者 npm install 自行获取，
 *     不进安装包，不在此列。
 *   - 版权行取各包 LICENSE 文件里的第一处 `Copyright ...`；取不到就留空并标注。
 *     不编造版权人 —— 编一个比留空更糟。
 *
 * 用法：
 *   node scripts/gen-third-party.mjs          # 写入 THIRD-PARTY-LICENSES.txt
 *   node scripts/gen-third-party.mjs --check  # 只比对，不写；有差异则退出码 1
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'THIRD-PARTY-LICENSES.txt');
const CHECK = process.argv.includes('--check');

/** 这些包**会**被打进安装包 —— 与 electron-builder.yml 的 asarUnpack 呼应 */
function productionDirs() {
  let raw = '';
  try {
    raw = execSync('npm ls --omit=dev --parseable --all', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // npm ls 在有 peer 冲突时退出码非 0，但 stdout 仍是有效树
    raw = e.stdout || '';
  }
  return raw
    .trim()
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    // 第一行是项目自身（opc-agent），不是第三方
    .filter(d => d !== ROOT && !d.endsWith(`opc-agent`));
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]) return pkg.licenses[0].type || 'UNKNOWN';
  return 'UNKNOWN';
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'license', 'NOTICE'];

/**
 * 取版权行。
 *
 * ⚠️ 不能「匹配到 Copyright 就收」。Apache-2.0 正文里至少有三处含 copyright：
 *    §1 定义句、§4(a)「copyright notice that is included in or attached to the work」、
 *    §4(c)「You must retain ... all copyright, patent, trademark ...」。
 *    前两版实现分别把第 1 条和第 2 条当成了版权行写进清单 —— 都是假署名。
 *
 * 现在的判据：**只认行首就是 Copyright 的行**（真实署名都长这样），
 * 且只在文件前 6 行找（署名在文件头，正文定义在很后面）。
 * 找不到就退回 package.json 的 author 并如实标注 —— 不编造版权人。
 */
function copyrightOf(dir, pkg) {
  for (const f of LICENSE_FILES) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).slice(0, 6);
    for (const line of lines) {
      const t = line.trim().replace(/\s+/g, ' ');
      if (!/^copyright\b/i.test(t)) continue;
      if (/shall mean/i.test(t)) continue;
      let s = t;
      const cut = s.search(/Permission is hereby|Licensed under/i);
      if (cut > 0) s = s.slice(0, cut);
      if (s.length > 110) s = s.slice(0, 110).trim();
      return s;
    }
  }
  const author = typeof pkg.author === 'string'
    ? pkg.author
    : (pkg.author && pkg.author.name) || '';
  if (author) return `（该包未随附独立版权行；包元数据 author：${author}）`;
  return '（该包未随附 LICENSE 文件，许可依据其 package.json 元数据）';
}

/**
 * Electron 运行时不在 `npm ls --omit=dev` 里（它是 devDependency），
 * 但它**确实**随安装包分发 —— electron-builder.yml 的 `electronDist` 直接指向
 * node_modules/electron/dist，最终变成 exe 里的 Chromium。
 * 漏掉它等于漏掉包里体积最大的一块第三方代码，所以单独补一条。
 */
function electronEntry() {
  const dir = join(ROOT, 'node_modules/electron');
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, 'utf8'));
  } catch {
    return null;
  }
  return {
    name: 'electron',
    version: pkg.version || '?',
    license: licenseOf(pkg),
    copyright:
      copyrightOf(dir, pkg) +
      '（Electron 运行时内含 Chromium 及其依赖，完整第三方声明见 Electron 发行包内的 LICENSES.chromium.html）',
  };
}

const seen = new Map();
for (const dir of productionDirs()) {
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, 'utf8'));
  } catch {
    continue;
  }
  if (!pkg.name) continue;
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  seen.set(key, {
    name: pkg.name,
    version: pkg.version || '?',
    license: licenseOf(pkg),
    copyright: copyrightOf(dir, pkg),
  });
}

const electron = electronEntry();
if (electron) seen.set(`electron@${electron.version}`, electron);

const list = [...seen.values()].sort((a, b) =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
);

const byLicense = new Map();
for (const p of list) byLicense.set(p.license, (byLicense.get(p.license) || 0) + 1);
const summary = [...byLicense.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([lic, n]) => `${lic} × ${n}`)
  .join(' · ');

const lines = [
  'OPC Agent — 随安装包分发的第三方组件许可清单',
  '',
  '本文件由 `node scripts/gen-third-party.mjs` 从 node_modules 自动生成，请勿手工编辑。',
  '覆盖范围：`npm ls --omit=dev` 的完整生产依赖树（即 electron-builder 会打进安装包的那些包）。',
  'devDependencies（React / Vite / Electron 运行时本体等）由使用者自行 `npm install` 获取，不进安装包。',
  '',
  `组件数：${list.length}　许可分布：${summary}`,
  '',
  '许可全文：各组件在自己的 npm 包里随附 LICENSE 文件，npm 公开源可下载。',
  '本项目不修改这些组件的源码（`patches/node-pty+1.1.0.patch` 仅调整本地构建参数，',
  '不改变其许可条款）。',
  '',
  '─'.repeat(78),
  '',
];

for (const p of list) {
  lines.push(`${p.name} ${p.version}`);
  lines.push(`  许可：${p.license}`);
  lines.push(`  版权：${p.copyright || '（该包未随附 LICENSE 文件，许可依据其 package.json 元数据）'}`);
  lines.push('');
}

const next = lines.join('\n');

if (CHECK) {
  const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (prev !== next) {
    console.error('[gen-third-party] 清单已过期，请运行 node scripts/gen-third-party.mjs');
    process.exit(1);
  }
  console.log(`[gen-third-party] 清单一致（${list.length} 个组件）`);
} else {
  writeFileSync(OUT, next, 'utf8');
  console.log(`[gen-third-party] 已写入 ${OUT}（${list.length} 个组件）`);
}
