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
 *   - 「后端依赖」= `npm ls --omit=dev`，即会被 electron-builder 原样打进
 *     `app.asar` 的那棵树。
 *   - 「前端打包依赖」= `src/` 里 import 到的包 + 它们的 dependencies 闭包。
 *     这些包在 `package.json` 里是 devDependencies（由 Vite 在构建时内联进
 *     `dist/assets/*.js`），**但它们确实随安装包分发** —— 只统计 `--omit=dev`
 *     会漏掉 react / react-dom / tdesign-react / lucide-react 这一大块，
 *     而 MIT/Apache-2.0 的署名义务是按「有没有分发」算的，不是按
 *     `package.json` 里写在哪个字段算的。
 *   - 版权行取各包 LICENSE 文件里的第一处 `Copyright ...`；取不到就留空并标注。
 *     不编造版权人 —— 编一个比留空更糟。
 *
 * 用法：
 *   node scripts/gen-third-party.mjs          # 写入 THIRD-PARTY-LICENSES.txt
 *   node scripts/gen-third-party.mjs --check  # 只比对，不写；有差异则退出码 1
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
 * 内嵌子包的判据（两条，缺一不可）：
 *   ① 目录里有自己的 `package.json`，且 `name` 与父包不同；
 *   ② 这个 name 必须是**合法的独立包名** —— 能装进 npm 的那种。
 *
 * 为什么要有 ②：早期 npm 包会用路径当子模块名，`dom-helpers/activeElement`、
 * `react-transition-group/CSSTransition` 都有 `package.json` 且 name 与父包不同，
 * 但它们只是父包的一个文件，不是独立组件。把它们列进来等于**编造组件**，
 * 比漏记更糟（清单的可信度是一次性的）。
 *
 * 另外排除 benchmark / test / dist 这类附属目录：`fast-uri` 里就有个
 * `benchmark/package.json`（name 叫 `benchmark`、ISC），那是包自带的压测脚本，
 * 不随运行时使用。
 *
 * 本项目遇上的第一个实例：`@tencent-ai/agent-sdk` 里塞了整套 CodeBuddy CLI
 * （`cli/`，SDK 运行时会 spawn 它），其 `package.json` 是
 * `@tencent-ai/codebuddy-code`，许可字段 `SEE LICENSE IN README.md`。
 * 跳过 `node_modules`：那里是嵌套依赖，已由 `npm ls --all` 覆盖，重复列出会双计。
 */
const VALID_PKG_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NON_PACKAGE_DIRS = new Set([
  'benchmark', 'benchmarks', 'bench', 'example', 'examples', 'sample', 'samples',
  'test', 'tests', '__tests__', 'spec', 'specs', 'docs', 'doc', 'scripts', 'build',
  'dist', 'coverage', 'demo', 'demos', 'fixture', 'fixtures', 'tools', 'site', 'website',
]);
/** 内嵌子包中不从安装包分发的条目（electron-builder.yml 排除或法律原因） */
const NESTED_EXCLUDE_NAMES = new Set([
  '@tencent-ai/codebuddy-code', // cli/ 已排除打包（许可声明缺失）
]);

function nestedPackages(dir, parentName) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (NON_PACKAGE_DIRS.has(e.name.toLowerCase())) continue;
      const sub = join(d, e.name);
      const pj = join(sub, 'package.json');
      if (existsSync(pj)) {
        let pkg = null;
        try {
          pkg = JSON.parse(readFileSync(pj, 'utf8'));
        } catch {
          pkg = null; // 坏 json 当作不是组件，继续往下找
        }
        if (pkg && pkg.name && pkg.name !== parentName && VALID_PKG_NAME.test(pkg.name) && !NESTED_EXCLUDE_NAMES.has(pkg.name)) {
          out.push({
            dir: sub,
            name: pkg.name,
            version: pkg.version || '?',
            license: licenseOf(pkg),
            note: danglingLicenseNote(sub, pkg),
          });
          continue; // 子包内部不再拆
        }
      }
      walk(sub, depth + 1);
    }
  };
  walk(dir, 1);
  return out;
}

/**
 * `SEE LICENSE IN README.md` 这类声明要验证目标文件真在包里。
 *
 * 不验证就会把「许可见某文件」原样抄进清单，而那个文件根本不存在 —— 清单看起来
 * 齐全，实际拿不到条款。这条不是为某个包写死的：任何包只要许可字段是这种形式
 * 就适用。
 */
function danglingLicenseNote(dir, pkg) {
  const m = /^SEE LICEN[CS]E IN (\S+)$/i.exec(licenseOf(pkg));
  if (!m) return '';
  const target = join(dir, m[1]);
  if (existsSync(target)) return '';
  return `⚠️ 该子包声明「许可见 ${m[1]}」，但 ${m[1]} 未随包提供 —— 许可条款无法从包内查证`;
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

/* ── 前端打包依赖 ──────────────────────────────────────────────────────
 *
 * 为什么单独算一块：这些包写在 `devDependencies` 里，看起来「不进包」，
 * 但 Vite 构建时把它们的代码**内联进了 `dist/assets/*.js`**，最终随安装包
 * 分发。只跑 `npm ls --omit=dev` 会把 react / react-dom / tdesign-react /
 * lucide-react / xterm 全部漏掉 —— 而 MIT 的署名义务是按「有没有分发」算的。
 */

/** 从 src/ 里扫出直接 import 的第三方包名（相对路径与 node: 内建模块跳过） */
function bundledRoots() {
  const found = new Set();
  const walk = dir => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  };
  walk(join(ROOT, 'src'));
  return [...found];
}

/** 从某个包目录出发按 Node 解析规则找它的依赖（逐级往上找 node_modules） */
function resolveFrom(fromDir, dep) {
  let cur = fromDir;
  for (;;) {
    const cand = join(cur, 'node_modules', dep);
    if (existsSync(join(cand, 'package.json'))) return cand;
    const parent = dirname(cur);
    if (parent === cur || parent.length < ROOT.length) return null;
    cur = parent;
  }
}

/**
 * 前端打包依赖的闭包。
 *
 * 宁多勿少：Vite 会 tree-shake 掉没用到的模块，但「这个包可能进了产物」
 * 与「这个包一定没进产物」之间，前者多列一条的代价是清单长一行，
 * 后者漏列的代价是署名义务落空。所以按 `dependencies` 全量闭包算。
 */
function bundledDirs() {
  const out = new Map();
  const queue = bundledRoots()
    .map(n => join(ROOT, 'node_modules', n))
    .filter(d => existsSync(join(d, 'package.json')));
  while (queue.length) {
    const dir = queue.shift();
    if (out.has(dir)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    out.set(dir, pkg);
    for (const dep of Object.keys(pkg.dependencies || {})) {
      // @types/* 是类型声明，不进产物
      if (dep.startsWith('@types/')) continue;
      const resolved = resolveFrom(dir, dep);
      if (resolved && !out.has(resolved)) queue.push(resolved);
    }
  }
  return out;
}

const seen = new Map();
/** 每一条带上「它凭什么随包分发」：后端原样打包 / 前端构建内联 / 运行时本体 */
function add(dir, pkg, origin) {
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  seen.set(key, {
    name: pkg.name,
    version: pkg.version || '?',
    license: licenseOf(pkg),
    copyright: copyrightOf(dir, pkg),
    origin,
    nested: nestedPackages(dir, pkg.name),
  });
}

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
  add(dir, pkg, '后端依赖（原样进 app.asar）');
}

for (const [dir, pkg] of bundledDirs()) {
  if (!pkg.name) continue;
  add(dir, pkg, '前端打包（Vite 内联进 dist）');
}

const electron = electronEntry();
if (electron) seen.set(`electron@${electron.version}`, { ...electron, origin: 'Electron 运行时本体' });

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
  '',
  '覆盖范围（三块，全部随安装包分发）：',
  '  1. 后端依赖 —— `npm ls --omit=dev` 的完整生产依赖树，原样打进 app.asar；',
  '  2. 前端打包 —— `src/` 里 import 到的包及其 dependencies 闭包，Vite 构建时',
  '     内联进 dist/assets/*.js。它们在 package.json 里写作 devDependencies，',
  '     但**代码确实在安装包里**（react / react-dom / tdesign-react / lucide-react',
  '     / xterm 等），因此同样需要署名；',
  '  3. Electron 运行时本体（内含 Chromium）。',
  '',
  '不在此列的：vite / tailwindcss / electron-builder / tsx / playwright-core 等',
  '纯构建与测试工具 —— 它们只在开发机上运行，产物里没有它们的代码。',
  '',
  '另有一类容易漏的：某个包里自带一整套独立组件（有自己的 package.json 与',
  '许可字段），打包时跟着父包一起进安装包。它们列在各自父包的「内嵌子包」下，',
  '许可与署名按**它自己的**声明算，不能只记父包。',
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
  lines.push(`  来源：${p.origin}`);
  // 内嵌子包是随包分发的一部分，署名义务按它自己的声明算 —— 必须跟着父包一起列。
  if (p.nested && p.nested.length) {
    lines.push('  内嵌子包（随父包一起进安装包，许可按各自的声明）：');
    for (const n of p.nested) {
      lines.push(`    ${n.name} ${n.version} —— 许可：${n.license}`);
      if (n.note) lines.push(`      ${n.note}`);
    }
  }
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
