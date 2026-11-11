/**
 * 验证闸门挂链登记（元闸门）。
 *
 * ## 守的是什么
 *
 * 仓库里有 140+ 条 `verify:*`，但真正会被「整条回归」跑到的只有 `verify:ui`
 * 链内那批 + CI 六步引用的那几条。一个闸门写完后忘了挂链，它既不会红也不会被
 * 任何人跑 —— 是最典型的「静默假绿」：脚本存在、单跑也绿、主链全绿，实际上
 * 从来没进过回归。
 *
 * 所以规则只有一句：**每条 `verify:*` 要么在链里，要么在 `gate-registry.json`
 * 里登记并写明链外原因**。新增链外脚本不登记 → 本闸门判红；把已挂链的脚本
 * 摘下来却没补登记 → 判红；登记项指向不存在的脚本 → 判红。
 *
 * 另外给「纯离线单测但链外」这一类加了棘轮：数量只许减不许增，上限也不许
 * 被偷偷调高。否则登记会变成「把债写下来就完事」的摆设。
 *
 * 全静态、不碰数据库、不需要任何构建产物，放在主链最前面快速失败。
 * 运行：node scripts/verify-gate-registry.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 链外纯离线单测的棘轮基线；下调可以，上调必须先真的把脚本挂进链。 */
const BASELINE_OFFLINE_UNIT = 18;

const failures = [];
let total = 0;

function ok(cond, label, detail) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq(actual, expected, label) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}\n      实际: ${JSON.stringify(actual)}\n      期望: ${JSON.stringify(expected)}`);
  }
}

/** 从一条 npm 命令里抽出它引用的所有 verify:* 脚本名。 */
function chainOf(text) {
  return [...String(text ?? '').matchAll(/npm run (verify:[A-Za-z0-9:_-]+)/g)].map(m => m[1]);
}

/**
 * 登记契约（纯函数，反向探针直接复用）。
 * 传进来的都是内存副本，函数不读盘、不产生副作用。
 */
function registryContract(pkg, ciText, reg, baseline) {
  const scripts = pkg?.scripts ?? {};
  const all = Object.keys(scripts).filter(k => k.startsWith('verify:') && k !== 'verify:ui');
  const ui = chainOf(scripts['verify:ui']);
  const ci = chainOf(ciText);
  const hooked = new Set([...ui, ...ci]);
  const entries = reg?.entries ?? {};
  const categories = new Set(Object.keys(reg?.categories ?? {}));
  const keys = Object.keys(entries);

  // 链里 / CI 里引用的脚本名必须真实存在：拼错一个名字，那一段永远跑不到还看不出来
  if (![...ui, ...ci].every(k => Object.prototype.hasOwnProperty.call(scripts, k))) return false;

  const unhooked = all.filter(k => !hooked.has(k));
  // 集合完全相等：少登记一条 = 有脚本失管；多登记一条 = 幽灵/双份真相
  if (unhooked.length !== keys.length) return false;
  if (!unhooked.every(k => Object.prototype.hasOwnProperty.call(entries, k))) return false;
  if (!keys.every(k => all.includes(k))) return false;

  // 分类必须取自登记文件里的枚举，理由不能是占位空话
  if (!keys.every(k =>
    categories.has(entries[k]?.category) &&
    typeof entries[k]?.reason === 'string' &&
    entries[k].reason.trim().length >= 8
  )) return false;

  // 棘轮：链外纯离线单测只许减不许增，且上限不许被调高
  const offline = keys.filter(k => entries[k].category === 'offline-unit').length;
  if (!Number.isInteger(reg?.maxOfflineUnit)) return false;
  if (offline > reg.maxOfflineUnit) return false;
  if (reg.maxOfflineUnit > baseline) return false;

  // 组合命令引用的子闸门必须真实存在（否则「子脚本各自可跑」这句理由是假的）
  for (const k of keys.filter(k => entries[k].category === 'composite')) {
    if (!chainOf(scripts[k]).every(sub => Object.prototype.hasOwnProperty.call(scripts, sub))) return false;
  }

  return true;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/gate-registry.json'), 'utf8'));
const ciText = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

const scripts = pkg.scripts;
const all = Object.keys(scripts).filter(k => k.startsWith('verify:') && k !== 'verify:ui');
const ui = chainOf(scripts['verify:ui']);
const ci = chainOf(ciText);
const hooked = new Set([...ui, ...ci]);
const unhooked = all.filter(k => !hooked.has(k));
const keys = Object.keys(reg.entries);

console.log('— 挂链登记体检');
console.log(`  verify:* 共 ${all.length} 条；verify:ui 链内 ${ui.length} 段；CI 引用 ${ci.length} 条；链外 ${unhooked.length} 条；已登记 ${keys.length} 条`);

ok(registryContract(pkg, ciText, reg, BASELINE_OFFLINE_UNIT),
  '登记契约成立（链内引用有效 / 链外全覆盖 / 分类合法 / 棘轮未破）',
  '任一环断了都要红，下面有拆细报');

// ── 拆细报：红了要能一眼看出断在哪 ──────────────────────────────────
ok(ui.length > 0 && ci.length > 0, 'verify:ui 与 CI 两条链都解析出了脚本（防止读错文件还判绿）');
for (const k of [...ui, ...ci]) {
  ok(Object.prototype.hasOwnProperty.call(scripts, k), `链内引用 ${k} 真实存在`);
}
const missing = unhooked.filter(k => !keys.includes(k));
const ghosts = keys.filter(k => !unhooked.includes(k));
eq(missing, [], '每条链外脚本都有登记（新增脚本忘登记会红）');
eq(ghosts, [], '登记里没有幽灵条目 / 已挂链脚本没被重复登记');
for (const k of keys) {
  ok(Object.keys(reg.categories).includes(reg.entries[k]?.category), `${k} 的分类取自登记枚举`);
  ok(typeof reg.entries[k]?.reason === 'string' && reg.entries[k].reason.trim().length >= 8,
    `${k} 写明了链外原因（不是占位空话）`);
}
const offline = keys.filter(k => reg.entries[k].category === 'offline-unit');
eq(reg.maxOfflineUnit, BASELINE_OFFLINE_UNIT, '链外纯离线单测棘轮基线未被上调');
ok(offline.length <= reg.maxOfflineUnit,
  `链外纯离线单测 ${offline.length} 条 ≤ 棘轮上限 ${reg.maxOfflineUnit}`,
  '要加新的离线单测，请直接挂进 verify:ui');
for (const k of keys.filter(k => reg.entries[k].category === 'composite')) {
  const subs = chainOf(scripts[k]);
  ok(subs.length > 0 || /&&/.test(scripts[k]), `${k} 确实是组合命令`);
  ok(subs.every(sub => Object.prototype.hasOwnProperty.call(scripts, sub)), `${k} 引用的子闸门都存在`);
}

// ── 反向探针：把登记/链逐项改坏，契约必须变红 ──────────────────────
const clone = o => JSON.parse(JSON.stringify(o));
const probes = [
  ['新增一条未登记的 verify:* 脚本', () => {
    const p = clone(pkg); p.scripts['verify:zz-new'] = 'node scripts/zz.mjs';
    return [p, ciText, reg];
  }],
  ['删掉一条登记', () => {
    const r = clone(reg); delete r.entries['verify:scenarios'];
    return [pkg, ciText, r];
  }],
  ['登记里多一条幽灵条目', () => {
    const r = clone(reg); r.entries['verify:zz-ghost'] = { category: 'offline-unit', reason: '凭空捏造的一条登记' };
    return [pkg, ciText, r];
  }],
  ['一条已挂链脚本被重复登记', () => {
    const r = clone(reg); r.entries['verify:permission'] = { category: 'offline-unit', reason: '重复登记同一条脚本' };
    return [pkg, ciText, r];
  }],
  ['把主链里一段改成不存在的脚本名', () => {
    const p = clone(pkg); p.scripts['verify:ui'] = p.scripts['verify:ui'].replace('npm run verify:runhub', 'npm run verify:runhb');
    return [p, ciText, reg];
  }],
  ['把一条脚本从主链摘掉却没补登记', () => {
    const p = clone(pkg); p.scripts['verify:ui'] = p.scripts['verify:ui'].replace('npm run verify:permission && ', '');
    return [p, ciText, reg];
  }],
  ['某条分类改成枚举外的值', () => {
    const r = clone(reg); r.entries['verify:scenarios'].category = 'whatever';
    return [pkg, ciText, r];
  }],
  ['某条理由被清空', () => {
    const r = clone(reg); r.entries['verify:scenarios'].reason = '   ';
    return [pkg, ciText, r];
  }],
  ['棘轮上限被偷偷调高', () => {
    const r = clone(reg); r.maxOfflineUnit = 999;
    return [pkg, ciText, r];
  }],
  ['把一条链外脚本伪装成纯离线单测（突破棘轮）', () => {
    const r = clone(reg); r.entries['verify:a85'].category = 'offline-unit';
    return [pkg, ciText, r];
  }],
  ['composite 子闸门指向不存在的名字', () => {
    const p = clone(pkg); p.scripts['verify:a115'] = 'npm run verify:a115-typo && npm run verify:a115-ui';
    return [p, ciText, reg];
  }],
  ['CI 里引用了不存在的脚本名', () => {
    return [pkg, ciText.replace('npm run verify:runhub', 'npm run verify:runhb'), reg];
  }],
];
console.log('\n— 反向探针');
for (const [label, build] of probes) {
  const [p, c, r] = build();
  ok(!registryContract(p, c, r, BASELINE_OFFLINE_UNIT), `反向探针：${label} → 契约必须变红`);
}

console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败（共 ${total} 项）：\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✓ ${total}/${total} 全部通过`);
