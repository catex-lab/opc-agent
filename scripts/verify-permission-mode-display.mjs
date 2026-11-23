/**
 * 权限模式选项呈现闸门（UI 审查 P1）。
 *
 * 守的是什么：设置页「Agent 权限模式」下拉里，危险档 bypassPermissions
 * 曾显示成英文原词 + 绿色字——绿色暗示「安全」，把「全放行」显示成绿色
 * 是会让人放松警惕的误导。诊断指出后修法：
 *   ① 选项名走 i18n key（ChatInput 同一组文案，中英一致），不再显示英文原词；
 *   ② 危险档 label + desc 都用危险色 --tc-status-danger，不再用 success 绿；
 *   ③ 每个选项带 data-permission-mode 标记，便于运行时定位。
 *
 * 为什么用静态源码契约：这是纯渲染呈现，真浏览器截图要起 dist，成本高且
 * 颜色值在 CSS 变量层；用剥注释 + 锚行首的静态判据即可钉住「实现没退回」。
 * 反向探针 --probe=revert 把选项退回英文 label + 绿色，判据必须变红。
 *
 * 运行：node scripts/verify-permission-mode-display.mjs
 *       node scripts/verify-permission-mode-display.mjs --probe=revert
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src/components/SettingsPage.tsx');

const PROBE = process.argv.includes('--probe=revert');

/** 剥掉 /* *\/ 块注释与 // 行注释，避免注释里的示例字串造成假绿。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
const line = (s, re) => s.split('\n').some(l => re.test(l));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`); }
}

let src = stripComments(fs.readFileSync(FILE, 'utf8'));
if (PROBE) {
  // 把实现退回坏版本：labelKey → 英文原词 label、danger → 普通色
  src = src
    .replace(/labelKey: 'chat\.permission\.default', descKey: 'chat\.permission\.defaultDesc'/, "label: 'default', descKey: 'chat.permission.defaultDesc'")
    .replace(/labelKey: 'chat\.permission\.bypass',\n\s*descKey: 'chat\.permission\.bypassDesc',\n\s*danger: true,/, "label: 'bypassPermissions', descKey: 'chat.permission.bypassDesc',")
    .replace(/label=\{t\(mode\.labelKey\)\}/g, 'label={mode.label}')
    .replace(/\{t\(mode\.labelKey\)\}/g, '{mode.label}')
    .replace(/mode\.danger\s*\?\s*'var\(--tc-status-danger\)'\s*:\s*'var\(--td-text-color-(?:primary|placeholder)\)'/g, "'var(--td-success-color)'");
}

/** 只取「权限模式下拉」这一段渲染代码，避免别处的 success 绿造成假红。 */
function dropdownBody(s) {
  const start = s.indexOf('PERMISSION_MODES.map');
  if (start < 0) return '';
  const end = s.indexOf('</Select>', start);
  return s.slice(start, end > start ? end : start + 1200);
}

function contract(s) {
  const dd = dropdownBody(s);
  return {
    // 常量用 labelKey（i18n）而非英文原词 label
    labelKeyUsed: /labelKey:\s*'chat\.permission\.default'/.test(s) &&
      /labelKey:\s*'chat\.permission\.bypass'/.test(s),
    noRawEnglishLabel:
      !/label:\s*'bypassPermissions'/.test(s) &&
      !/label:\s*'default'/.test(s),
    bypassMarkedDanger: /value:\s*'bypassPermissions'[\s\S]{0,160}danger:\s*true/.test(s),
    // 渲染用 t(labelKey) 出中文，而非 mode.label 英文
    renderUsesI18n: /label=\{t\(mode\.labelKey\)\}/.test(s) &&
      /\{t\(mode\.labelKey\)\}/.test(s),
    noSuccessGreen: dd.length > 0 && !/var\(--td-success-color\)/.test(dd),
    dangerColorApplied: (dd.match(/var\(--tc-status-danger\)/g) ?? []).length >= 2,
    dataMarker: /data-permission-mode=\{mode\.value\}/.test(s),
  };
}

console.log('— 权限模式选项呈现（设置页下拉）—');
const c = contract(src);
for (const [k, v] of Object.entries(c)) ok(v, `契约：${k}`);

if (PROBE) {
  const red = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  ok(red.length > 0 && !c.labelKeyUsed && !c.renderUsesI18n,
    `[probe=revert] 退回英文 label + 绿色后，labelKeyUsed/renderUsesI18n 判红`, `红=${red.join(',')}`);
}

console.log(`\n=== 权限模式选项呈现：${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
