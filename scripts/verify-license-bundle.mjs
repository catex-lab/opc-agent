/**
 * 许可清单随包闸门（2026-11-23）。
 *
 * ## 守的是什么
 *
 * 本项目本体是 MIT，但安装包里打了 274 个第三方组件。MIT / Apache-2.0 /
 * BSD 都要求「分发副本时保留版权与许可声明」。electron-builder 为减小包体
 * 在 files 里排除了各依赖的 LICENSE 文件 —— 于是
 * THIRD-PARTY-LICENSES.txt（生成器从 node_modules 提取的 274 组件清单）
 * 就成了安装包形态下**唯一**的署名载体。
 *
 * 这一块删掉没有任何功能症状（应用照跑、界面照显示），只有法务意义上
 * 少了一条声明 —— 正是「删了也不报错」才必须有闸门钉住。
 *
 * ## 三层断言
 *   [1] 打包配置 files 含 THIRD-PARTY-LICENSES.txt（进 asar 随包分发）；
 *   [2] 主进程有 opc:open-license-text 端点，且做了 asar→临时文件→
 *       shell.openPath 的转换（asar 虚拟路径系统程序打不开）；
 *   [3] preload 暴露 openLicenseText，AboutPanel 有按钮与随包文案；
 *   [4] 生成器 --check 仍绿（清单没过期）。
 *   [P] 反向探针：--probe=no-bundle 模拟配置被删，必须判红。
 *
 * 运行：node scripts/verify-license-bundle.mjs [--probe=no-bundle]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = process.argv.includes('--probe=no-bundle');

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const failures = [];
let total = 0;
function ok(cond, label, detail) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// 探针：把打包配置里的清单条目抽掉，模拟「有人为了减少包体删了它」。
const builderRaw = read('electron-builder.yml');
const builder = probe
  ? builderRaw.replace(/^\s*-\s*THIRD-PARTY-LICENSES\.txt\s*$.*$\n?/m, '')
  : builderRaw;

// [1] 打包配置
ok(
  /^\s*-\s*THIRD-PARTY-LICENSES\.txt\s*$/m.test(builder),
  'electron-builder files 含 THIRD-PARTY-LICENSES.txt（随包分发）'
);
ok(
  /!\*\*\/\{[^}]*LICENSE/.test(builder),
  '确认 LICENSE 排除规则仍在（否则清单不是唯一署名载体，断言前提失效）'
);

// [2] 主进程端点
const main = read('electron/main.ts');
ok(/ipcMain\.handle\('opc:open-license-text'/.test(main), '主进程注册 opc:open-license-text');
ok(/rejectUntrustedIpc\(_e, 'opc:open-license-text'\)/.test(main), '端点做了来源校验');
ok(/join\(app\.getAppPath\(\), 'THIRD-PARTY-LICENSES\.txt'\)/.test(main), '端点从 asar 内读清单');
ok(/tmpdir\(\)/.test(main), '端点使用系统临时目录（asar 虚拟路径系统打不开）');
ok(/shell\.openPath\(dest\)/.test(main), '端点把真实临时文件交给系统程序打开');

// [3] preload + UI
const preload = read('electron/preload.cjs');
ok(/openLicenseText\(\)/.test(preload), 'preload 暴露 openLicenseText');
ok(/ipcRenderer\.invoke\('opc:open-license-text'\)/.test(preload), 'preload 调到正确端点');

const about = read('src/components/AboutPanel.tsx');
ok(/data-about-license-open/.test(about), '关于页有许可清单按钮锚点');
ok(/openLicenseText\?:\s*\(\)\s*=>\s*Promise<string>/.test(about), 'AboutBridge 声明了 openLicenseText');
ok(/t\('settings\.about\.licenseOpen'\)/.test(about), '按钮用了 licenseOpen 文案键');

const zh = read('src/i18n/zh.ts');
ok(/settings\.about\.licenseNote.*随安装包附带/.test(zh), '中文文案改指向随包清单');
ok(/THIRD-PARTY-LICENSES\.txt/.test(zh), '中文文案保留清单文件名（a141 也断言此串）');
const en = read('src/i18n/en.ts');
ok(/ships with the installed app/.test(en), '英文文案改指向随包清单');

// [3b] 内嵌 CodeBuddy CLI 的许可口径：清单/文档/关于页必须一致说 MIT
// 2026-11-23 已从「无法查证」更正为 MIT；这里防止文档或 UI 悄悄回退旧说法。
const thirdPartyMd = read('THIRD-PARTY.md');
const sdkRow = thirdPartyMd.split('\n').find(l => l.includes('`@tencent-ai/agent-sdk`')) ?? '';
ok(/MIT/.test(sdkRow) && !/无法查证/.test(sdkRow),
  'THIRD-PARTY.md：内嵌 CodeBuddy CLI 不再被写成「许可无法查证」');
const aboutSource = read('src/components/AboutPanel.tsx');
const codeBuddyEntry = aboutSource.split('\n').find(l => l.includes("'@tencent-ai/codebuddy-code'")) ?? '';
ok(/license:\s*'MIT'/.test(codeBuddyEntry) && !/licenseMissing/.test(codeBuddyEntry),
  '关于页：内嵌 CodeBuddy CLI 标 MIT，不再显示「条款缺失」');

// [4] 生成器一致性（清单没过期）
const gen = spawnSync(process.execPath, ['scripts/gen-third-party.mjs', '--check'], {
  cwd: ROOT,
  encoding: 'utf8',
});
ok(gen.status === 0, '许可清单生成器 --check 通过（清单未过期）', gen.stdout?.trim() || gen.stderr?.trim());

// 清单文件本身存在且组件数合理（防止 --check 与空文件对上）
const list = read('THIRD-PARTY-LICENSES.txt');
ok(/组件数：\d+/.test(list), '清单文件含组件数统计');
const countMatch = list.match(/组件数：(\d+)/);
ok(countMatch && Number(countMatch[1]) >= 200, '清单组件数 ≥200（防止生成器与空清单互相对上）');

if (failures.length) {
  console.error(`✗ verify-license-bundle：${total - failures.length}/${total} 通过，${failures.length} 条失败`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ verify-license-bundle：${total}/${total} 通过（许可清单随包 + 应用内可查看）`);
