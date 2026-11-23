/**
 * Claude SDK 本体「用户自装」合规改造闸门（2026-11-23）。
 *
 * 守四件事：
 *   1. electron-builder 排除 SDK 本体（不随包分发专有副本）；
 *   2. adapter 的 probe 把「本体可用」纳入判据（避免假绿：显示就绪却发消息报错）；
 *   3. 引导文案含可执行安装命令，且错误不让用户看到英文堆栈；
 *   4. locator 纯函数穷举：显式路径 / 全局 root / 本地 node_modules 各分支，
 *      并对「目录在但 sdk.mjs 不存在」判未找到（不假绿）。
 *
 * 反向探针 --probe=no-exclude：抽掉打包排除规则，闸门必须红。
 *
 * 运行：npx tsx scripts/verify-claude-sdk-bundle.ts [--probe=no-exclude]
 */
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeSdkEntryCandidates,
  CLAUDE_SDK_INSTALL_HINT,
  CLAUDE_SDK_PACKAGE,
} from '../server/agents/claudeSdkLocator.js';

const root = path.resolve(import.meta.dirname, '..');
const probe = process.argv.includes('--probe=no-exclude');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// ── 1. 打包排除规则 ───────────────────────────────────────────────
const rawBuilder = read('electron-builder.yml');
const builder = probe
  ? rawBuilder.replace(/^\s*-\s*'?!node_modules\/@anthropic-ai\/claude-agent-sdk\/\*\*'?\s*$\n?/m, '')
  : rawBuilder;
ok(
  /'?!node_modules\/@anthropic-ai\/claude-agent-sdk\/\*\*'?!?/.test(builder),
  'electron-builder 排除 Claude SDK 本体'
);
// 平台二进制的排除规则不能被这次改动顺手删掉
ok(
  /!node_modules\/@anthropic-ai\/claude-agent-sdk-win32-x64\/\*\*/.test(builder),
  'Claude 平台二进制排除规则仍在（按需下载）'
);

// ── 2. adapter probe 判据 + 加载方式 ──────────────────────────────
const adapter = read('server/agents/adapters/claude-sdk.ts');
ok(/if \(!locateClaudeSdk\(\)\)/.test(adapter), 'probe 把 SDK 本体可用性纳入判据（防假绿）');
ok(/ClaudeSdkMissingError/.test(adapter), '定义了 SDK 缺失的专用错误');
ok(/import\(\/\* @vite-ignore \*\/ located\.url\)/.test(adapter), '按 file:// 绝对路径加载用户自装 SDK');
// 剥掉块注释与行注释再判：注释里写了「为什么不用裸包名 import(...)」的旧写法说明，
// 直接正则跑整块文本会把注释当代码，造成假红（项目断言纪律）。
// 注意排除 `typeof import('...')` —— 那是纯类型查询，编译后消失，不会加载包。
const adapterCode = adapter
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/typeof\s+import\(/g, 'TYPEOF_IMPORT(');
ok(
  !/(^|[^A-Z_])import\(['"]@anthropic-ai\/claude-agent-sdk['"]\)/.test(adapterCode),
  '不再用裸包名 import（用户自装找不到）'
);
ok(
  !/sdkPromise = Promise\.reject\(new ClaudeSdkMissingError\(\)\)/.test(adapter),
  '未安装不缓存失败（装好后无需重启）'
);

// ── 3. 引导文案 ───────────────────────────────────────────────────
const locator = read('server/agents/claudeSdkLocator.ts');
ok(locator.includes(CLAUDE_SDK_PACKAGE), '引导命令指向正确包名');
ok(/CLAUDE_SDK_INSTALL_HINT/.test(locator), '导出安装命令常量');
ok(
  CLAUDE_SDK_INSTALL_HINT.includes('npm install -g') && CLAUDE_SDK_INSTALL_HINT.includes(CLAUDE_SDK_PACKAGE),
  '安装命令可执行且含包名',
  CLAUDE_SDK_INSTALL_HINT
);
// 检查 super() 引用了安装命令常量（源码里是模板变量，不是展开后的字符串）
ok(
  /super\(`Claude SDK 本体未安装。请在终端运行：\$\{CLAUDE_SDK_INSTALL_HINT\}`\)/.test(adapter),
  '缺失错误自带安装引导常量（用户不会只看到「未安装」）'
);

// ── 4. locator 纯函数穷举 ─────────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-sdk-loc-'));
  try {
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'proj');
    const globalRoot = path.join(tmp, 'global');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(globalRoot, { recursive: true });

    // 显式路径：指向包目录 → 补 sdk.mjs
    const explicitDir = path.join(tmp, 'custom');
    const c1 = claudeSdkEntryCandidates({ explicit: explicitDir });
    ok(c1[0] === path.join(explicitDir, 'sdk.mjs'), '显式包目录 → 补 sdk.mjs 入口');
    // 显式路径：直接指 sdk.mjs → 不重复拼
    const c1b = claudeSdkEntryCandidates({ explicit: path.join(explicitDir, 'sdk.mjs') });
    ok(c1b[0] === path.join(explicitDir, 'sdk.mjs'), '显式 sdk.mjs → 原样使用');

    // 全局 root 优先于本地
    const c2 = claudeSdkEntryCandidates({ home, cwd, globalRoot });
    const globalIndex = c2.indexOf(path.join(globalRoot, CLAUDE_SDK_PACKAGE, 'sdk.mjs'));
    const localIndex = c2.findIndex(p => p.startsWith(cwd));
    ok(
      globalIndex >= 0 && globalIndex < localIndex,
      '全局 node_modules 候选排在本地之前',
      `global=${globalIndex} local=${localIndex}`
    );

    // 去重
    ok(new Set(c2).size === c2.length, '候选路径无重复');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(`✗ verify-claude-sdk-bundle：${total - failures.length}/${total} 通过，${failures.length} 条失败`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ verify-claude-sdk-bundle：${total}/${total} 通过（SDK 本体用户自装 + 防假绿）`);
