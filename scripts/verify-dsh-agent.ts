/**
 * DSH（DeepSeek Harness）正式接入闸门（2026-11-24）。
 *
 * 覆盖三层：
 *   [A] 定义层：DSH 已从 comingSoon 占位转正进 AGENT_DEFS，kind/surface/acp
 *       规格完整（--profile acp、{exeDir} 模板、ELECTRON_RUN_AS_NODE、
 *       deleteEnv NODE_OPTIONS）。
 *   [B] 适配器层：AcpAdapter 真消费这些规格 —— 安装目录发现（快捷方式反推
 *       + 引擎候选兜底）、{exeDir} 展开、env 叠加与 deleteEnv 剔除。
 *       静态断言钉行为结构，不钉字面量行号。
 *   [C] 隔离层：转正不留尾巴 —— comingSoon 清单不再含 DSH，占位与真定义
 *       无撞车（复用 a210 的口径，数量随转正联动）。
 *
 * 反向探针（硬要求）：拆掉 AcpAdapter 的 {exeDir} 展开 / env 叠加 /
 * deleteEnv 任一段，对应断言必须变红。
 *
 * 运行：`npm run verify:dsh-agent`（已挂 verify:ui 链尾）。
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 隐私红线：definitions.ts 的 import 链会拉起 DB 模块。必须在任何 import
// 之前把数据目录指到临时夹具，绝不触碰真实 data/chat.db。
process.env.OPC_DATA_DIR = os.tmpdir() + path.sep + `opc-dsh-gate-${Date.now()}`;
let passed = 0;
const failures = [];

function ok(cond, desc, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${desc}${detail ? `（${detail}）` : ''}`);
  } else {
    failures.push(desc);
    console.log(`  ✗ ${desc}${detail ? ` —— ${detail}` : ''}`);
  }
}

function eq(actual, expected, desc) {
  ok(actual === expected, desc, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

/** 剥注释：静态断言先去掉 /* *\/ 块注释与 // 行注释，避免注释里的字面量假绿 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function code(rel) {
  return stripComments(readFileSync(path.join(ROOT, rel), 'utf8'));
}

console.log('\n[A] DSH 定义层（AGENT_DEFS 转正）');
{
  const defsSrc = readFileSync(path.join(ROOT, 'server/agents/definitions.ts'), 'utf8');
  const stripped = code('server/agents/definitions.ts');

  // DSH 块的提取：以 id: 'deepseek-harness' 为锚，向后截到下一个顶层 id:
  const anchor = stripped.indexOf("id: 'deepseek-harness'");
  ok(anchor > 0, 'DSH 已进 AGENT_DEFS（id: deepseek-harness 存在且不在注释里）');
  if (anchor > 0) {
    const rest = stripped.slice(anchor);
    const nextId = rest.indexOf("id: '", 5);
    const block = nextId > 0 ? rest.slice(0, nextId) : rest;

    ok(/kind:\s*'acp'/.test(block), 'kind: acp（走 AcpAdapter）');
    ok(/surface:\s*'acp'/.test(block), 'surface: acp（≠ 接入方式，产品形态口径）');
    ok(/command:\s*'DeepSeek Harness\.exe'/.test(block), 'command 指向桌面版 exe');
    ok(block.includes('--profile') && block.includes("'acp'"), 'acp.args 带 --profile acp');
    ok(block.includes('--expose-internals'), 'acp.args 带 --expose-internals（exe-as-node 入口旗标）');
    ok(block.includes('{exeDir}'), 'cli.js 路径用 {exeDir} 占位（安装目录自选，不许写死盘符）');
    ok(
      block.includes('dsh-desktop-host') && block.includes('cli.js'),
      'cli.js 路径指向 dsh-desktop-host 的 ACP 入口'
    );
    ok(/ELECTRON_RUN_AS_NODE:\s*'1'/.test(block), 'acp.env 置 ELECTRON_RUN_AS_NODE=1');
    ok(block.includes("deleteEnv") && block.includes('NODE_OPTIONS'), 'acp.deleteEnv 剔除 NODE_OPTIONS');
    ok(/shortcutNames:\s*\['DeepSeek Harness\.lnk'\]/.test(block), 'shortcutNames 用桌面快捷方式反推安装根');
    ok(block.includes('engineCandidates') && block.includes('{root}'), 'engineCandidates 带 {root} 占位');
    ok(block.includes("authEnvs"), 'authEnvs 声明（凭据检查有据可查）');
    ok(/eventCapabilities:[^\n]*'tool'/.test(block), 'eventCapabilities 声明 tool（开发能力）');
    ok(/eventCapabilities:[^\n]*'thinking'/.test(block), 'eventCapabilities 声明 thinking');
    // 与本文件顶部注释一致：转正条目不再出现在 comingSoon
    const soonSrc = code('server/agents/comingSoon.ts');
    ok(!soonSrc.includes("'deepseek-harness'"), 'comingSoon 占位清单已移除 DSH id');
  }
}

console.log('\n[B] AcpAdapter 消费行为（发现 / 模板 / 环境）');
{
  const acpSrc = code('server/agents/adapters/acp.ts');

  // 安装目录发现：快捷方式根 + 引擎候选目录并入搜索 + 文件兜底
  ok(acpSrc.includes('shortcutInstallRoot'), 'resolveBin 消费 shortcutInstallRoot（安装根反推）');
  ok(acpSrc.includes('engineCandidates'), 'resolveBin 把 engineCandidates 目录并入搜索');
  ok(/engineFiles|isFile\(\)/.test(acpSrc), '引擎候选文件直接命中兜底（目录在但 exe 名不对应时）');

  // {exeDir} 展开：从已解析 binPath 取目录
  ok(/dirname\(binPath\)/.test(acpSrc), '{exeDir} 模板用已解析 binPath 的目录展开');
  ok(acpSrc.includes("'{exeDir}'") || acpSrc.includes('{exeDir}'), '存在 {exeDir} 占位替换逻辑');
  ok(/replace\('\{exeDir\}'/.test(acpSrc), '替换的是 {exeDir} 字面占位符');

  // env 叠加：target.env → acp.env → deleteEnv
  ok(/target\.env \?\? \{\}/.test(acpSrc), 'spawn env 并入启动垫片 target.env');
  ok(/acp\?\.env \?\? \{\}/.test(acpSrc), 'spawn env 并入定义表 acp.env');
  ok(/deleteEnv/.test(acpSrc) && /delete spawnEnv\[/.test(acpSrc), 'deleteEnv 在 spawn 前剔除继承变量');
}

console.log('\n[C] 隔离与联动（转正不留尾巴）');
{
  const soon = await import('../server/agents/comingSoon.ts');
  const defsMod = await import('../server/agents/definitions.ts');

  const def = defsMod.AGENT_DEFS.find(d => d.descriptor.id === 'deepseek-harness');
  ok(def, 'import 级：AGENT_DEFS 能取到 DSH 定义');
  if (def) {
    eq(def.descriptor.kind, 'acp', 'import 级：kind === acp');
    ok(Array.isArray(def.acp?.args) && def.acp.args.length > 0, 'import 级：acp.args 非空');
    eq(def.acp?.env?.ELECTRON_RUN_AS_NODE, '1', 'import 级：ELECTRON_RUN_AS_NODE=1');
    ok(def.acp?.deleteEnv?.includes('NODE_OPTIONS') === true, 'import 级：deleteEnv 含 NODE_OPTIONS');
    // findDef 直连（模型路由 API 的归属闸用它）
    eq(defsMod.findDef('deepseek-harness')?.descriptor.id, 'deepseek-harness', 'findDef(dsh) 命中（路由归属闸放行）');
  }

  const soonIds = soon.comingSoonIds();
  ok(!soonIds.includes('deepseek-harness'), 'import 级：comingSoonIds() 不再含 DSH');
  ok(!soonIds.some(id => defsMod.AGENT_DEFS.some(d => d.descriptor.id === id)), '占位 id 与真定义零撞车');
}

console.log(`\nDSH 接入断言：${passed + failures.length} 项，通过 ${passed}，失败 ${failures.length}`);
if (failures.length > 0) {
  console.log('✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
