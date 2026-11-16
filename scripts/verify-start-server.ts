/**
 * 拆启动闸门（C1 / 绞杀者第 0 期）。
 *
 * 「import 即启动」的坑：
 *   · import 后自启动 → harness 无法独立测试/重启，两个实例抢端口（EADDRINUSE）；
 *   · 改成函数后忘了直接运行时自启动 → dev:server / 打包态起不来；
 *   · 幂等判断用 listening（异步）→ 连续调用两次仍 EADDRINUSE。
 * 用子进程实测三种启动形态，钉到最外层可观测量（HTTP 200 / 实例身份）。
 *
 * 运行：npx tsx scripts/verify-start-server.ts
 */
import './lib/temp-data-dir.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

const root = mkdtempSync(join(tmpdir(), 'opc-start-server-'));
const runner = join(process.cwd(), '.tmp');

/** 用独立的 tsx 子进程跑一段脚本，返回 stdout */
function runTsx(script: string, env: Record<string, string>, timeoutMs = 20_000): string {
  const file = join(root, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, script);
  try {
    return execFileSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), file], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    return (e.stdout ?? '') + '\n__ERR__' + (e.stderr ?? e.message);
  }
}

function main() {
  const portA = 39901, portB = 39902;
  // 父进程算好 file URL（避免模板里多层转义反斜杠）
  const indexUrl = 'file:///' + process.cwd().split('\\').join('/') + '/server/index.ts';
  // [1] import 不自启动：server === null，且导出 startServer
  const r1 = runTsx(`
    process.env.OPC_DATA_DIR = ${JSON.stringify(join(root, 'd1'))};
    process.env.PORT = '${portA}';
    const m = await import('${indexUrl}');
    console.log('NULL=' + (m.server === null));
    console.log('FUNC=' + (typeof m.startServer === 'function'));
    process.exit(0);
  `, {});
  ok(/NULL=true/.test(r1), 'import 后 server 为 null（不自启动）', r1.slice(0, 200));
  ok(/FUNC=true/.test(r1), '导出 startServer() 函数', r1.slice(0, 200));

  // [2] 手动 startServer + 幂等 + HTTP
  const r2 = runTsx(`
    process.env.OPC_DATA_DIR = ${JSON.stringify(join(root, 'd2'))};
    process.env.PORT = '${portB}';
    const m = await import('${indexUrl}');
    const a = m.startServer(), b = m.startServer();
    console.log('SAME=' + (a === b));
    await new Promise(r => setTimeout(r, 1200));
    console.log('LISTEN=' + a.listening);
    const res = await fetch('http://127.0.0.1:${portB}/api/agents');
    console.log('HTTP=' + res.status);
    a.close(); process.exit(0);
  `, {});
  ok(/SAME=true/.test(r2), 'startServer 幂等（连调两次同一实例）', r2.slice(0, 200));
  ok(/LISTEN=true/.test(r2), 'startServer 后开始监听', r2.slice(0, 200));
  ok(/HTTP=200/.test(r2), '启动后 API 可用（HTTP 200）', r2.slice(0, 200));

  // [3] 静态闸门：electron 主进程显式调用；自启动守卫存在
  const main = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');
  ok(/import \{ startServer \}/.test(main), 'electron 显式 import startServer');
  ok(/const server = startServer\(\)/.test(main), 'electron 显式调用 startServer');
  const idx = readFileSync(join(process.cwd(), 'server/index.ts'), 'utf8');
  ok(/export function startServer\(\)/.test(idx), 'index.ts 导出 startServer');
  ok(/export let server/.test(idx), 'server 是 live binding 导出');
  ok(/if \(entry === self\) startServer\(\)/.test(idx), '有直接运行自启动守卫');

  if (failures.length) {
    console.error(`[START] ✗ ${failures.length}/${total} 失败`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`[START] ✓ ${total}/${total} 全部通过`);
}
main();
