/**
 * A119 纯函数层：IDE 启动器守卫（`isIdeLauncher`）。
 *
 * ## 为什么单独一层
 *
 * 这道守卫是**防御性**的：Trae 那条定义已经改成只认 `traecli`，本机没装，
 * 所以真跑起来 `isIdeLauncher` 根本不会被走到。只靠 e2e 断言「Trae 显示未
 * 安装」证明不了守卫本身有没有用 —— 一个永远返回 false 的空函数也能让那条
 * 断言变绿。
 *
 * 项目里有过这个教训（「优雅跳过的分支必须有红灯证明过它会红」），所以这里
 * 用**真文件、真垫片**造出 IDE 启动器形态，正例反例都断言一遍。
 *
 * 造的不是假对象而是真实目录结构：
 *
 *   <tmp>/App/App.exe                        ← 主程序（内容无所谓，存在即可）
 *   <tmp>/App/resources/app/out/cli.js       ← IDE 的命令行入口
 *   <tmp>/App/bin/ide-cn.cmd                 ← Electron 式垫片
 *
 * 这样走的是与真机完全相同的解析路径（readTextFile → 正则 → isFile），
 * 而不是「我塞一个 LaunchTarget 进去看函数返回什么」。
 *
 * 运行：npx tsx scripts/verify-a119-probe.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAnyLaunchTarget, isIdeLauncher } from '../server/agents/probe.js';

let total = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail?: string): void {
  total++;
  if (cond) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a119-probe-'));

/** 造一个 Electron 系 IDE 的目录 + 垫片，返回 .cmd 路径 */
function makeIdeShim(opts: {
  name: string;
  /** 入口 js 的相对路径（默认 resources/app/out/cli.js） */
  entry?: string;
  /** 是否写 ELECTRON_RUN_AS_NODE=1 */
  electronAsNode?: boolean;
}): string {
  const root = path.join(tmp, opts.name);
  const entryRel = opts.entry ?? 'resources/app/out/cli.js';
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, entryRel)), { recursive: true });
  fs.writeFileSync(path.join(root, 'App.exe'), 'MZ');
  fs.writeFileSync(path.join(root, entryRel), '// entry');

  const lines = ['@echo off', 'setlocal'];
  if (opts.electronAsNode !== false) lines.push('set ELECTRON_RUN_AS_NODE=1');
  lines.push(`"%~dp0..\\App.exe" "%~dp0..\\${entryRel.replace(/\//g, '\\')}" %*`);

  const cmd = path.join(root, 'bin', 'ide-cn.cmd');
  fs.writeFileSync(cmd, lines.join('\r\n'));
  return cmd;
}

console.log('\nA119 纯函数：IDE 启动器守卫');

// ── 正例：Electron 式垫片 ──────────────────────────────────────────
{
  const cmd = makeIdeShim({ name: 'ide-canonical' });
  const target = resolveAnyLaunchTarget(cmd);

  ok(
    target.env?.ELECTRON_RUN_AS_NODE === '1',
    '垫片里的 ELECTRON_RUN_AS_NODE 被解析进启动目标',
    JSON.stringify(target.env ?? null)
  );
  ok(
    /resources[\\/]app[\\/]out[\\/]cli\.js$/i.test(target.prefixArgs[0] ?? ''),
    '入口脚本是 resources/app/out/cli.js',
    target.prefixArgs[0]
  );
  ok(isIdeLauncher(target), 'IDE 启动器被识别（这条必须红过一次才算有效）');
}

// ── 反例 1：同样是 Electron-node 垫片，但入口不在 IDE 布局里 ─────
{
  const cmd = makeIdeShim({ name: 'electron-agent', entry: 'resources/glm/agent.cjs' });
  const target = resolveAnyLaunchTarget(cmd);

  ok(target.env?.ELECTRON_RUN_AS_NODE === '1', '反例 1 仍是 Electron-node 垫片', target.prefixArgs[0]);
  ok(!isIdeLauncher(target), '非 IDE 布局的 Electron 垫片不被误判');
}

// ── 反例 2：入口叫 cli.js 但不在 resources/app/out 下 ─────────────
{
  const cmd = makeIdeShim({ name: 'cli-elsewhere', entry: 'lib/cli.js' });
  const target = resolveAnyLaunchTarget(cmd);
  ok(!isIdeLauncher(target), '只在名字上像（lib/cli.js）不被误判', target.prefixArgs[0]);
}

// ── 反例 3：没有 ELECTRON_RUN_AS_NODE ────────────────────────────
{
  const cmd = makeIdeShim({ name: 'no-electron-env', electronAsNode: false });
  const target = resolveAnyLaunchTarget(cmd);
  // 没有该变量时 resolveElectronNodeShim 直接返回 null，退化成原样执行
  ok(target.env?.ELECTRON_RUN_AS_NODE === undefined, '反例 3 启动目标里没有 ELECTRON_RUN_AS_NODE');
  ok(!isIdeLauncher(target), '缺 ELECTRON_RUN_AS_NODE 的目标不被判成 IDE 启动器');
}

// ── 反例 4：裸 node + 脚本（普通 JS 垫片的解析结果） ──────────────
{
  ok(
    !isIdeLauncher({ command: 'node', prefixArgs: ['C:/x/index.js'], displayPath: 'x' }),
    '裸 node 目标不被误判'
  );
  ok(
    !isIdeLauncher({
      command: 'C:/App/App.exe',
      prefixArgs: ['C:/App/resources/app/out/cli.js'],
      displayPath: 'x',
    }),
    '没有 ELECTRON_RUN_AS_NODE 时，即便入口是 cli.js 也不判'
  );
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论 */
}

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}：${total} 项`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
