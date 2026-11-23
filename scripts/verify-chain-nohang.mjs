/**
 * 整链卡死根治闸门（2026-11-23）。
 *
 * ## 守的是什么
 *
 * 2026-11-23 15:10 那次 `verify:ui` 整链跑到第 86 段 `verify:a135-prefs`
 * 卡死 2 小时 —— 断言 53/53 全绿，卡在脚本收尾的**清理逻辑**：
 *
 *   旧 startServer 用 `spawn('npx tsx ...', { shell:true })` ⇒ child.pid 是
 *   cmd.exe，真正 listen 的是孙进程；旧 stopServer 只能靠 `spawnSync(
 *   'taskkill', /T /F)` 杀树。本沙箱拦截 taskkill 间接调用的 reg.exe/sc.exe，
 *   某些时序下 taskkill 挂住不退出 ⇒ **spawnSync 永久阻塞事件循环** ⇒ 进程
 *   打完 53/53 也不退出，整链再无日志。
 *
 * 根治（两层）：
 *   A. startServer 直接 `spawn(process.execPath, tsx-cli)` —— pid 就是真 node，
 *      kill() 直接生效，不再需要 taskkill。
 *   B. stopServer 用 kill() + 等 exit（15s 上限）+ waitPortClosed 端口自证。
 *
 * ## 为什么必须有闸门
 *
 * 「把 startServer 改回 shell:true / stopServer 改回 spawnSync」是**不报错的
 * 回退**：断言照样绿，只是整链偶发卡死。这类删了没症状的东西最需要静态闸门。
 *
 * ## 断言（钉不变量，非实现字面量）
 *   [1] startServer 不 shell:true 起测试 server；
 *   [2] 用 process.execPath 直接 spawn（pid 写真 node）；
 *   [3] stopServer 用 child.kill()，且没有 spawnSync('taskkill')（剥注释后）；
 *   [4] 有 waitPortClosed 端口自证 + 两处调用都 await；
 *   [P] 反向探针 --probe=revert：把源码退回旧写法，断言必须变红。
 *
 * 运行：node scripts/verify-chain-nohang.mjs [--probe=revert]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = process.argv.includes('--probe=revert');

let src = fs.readFileSync(path.join(ROOT, 'scripts/verify-a135-prefs.mjs'), 'utf8');

// 反向探针：模拟「有人把根因改回去」——恢复 shell:true + npx、spawnSync(taskkill)、
// 同步 stopServer 调用。这些正是导致整链卡死的坏写法。
if (probe) {
  src = src.replace(
    /spawn\(process\.execPath, \[path\.join\(ROOT, 'node_modules\/tsx\/dist\/cli\.mjs'\), 'server\/index\.ts'\]/,
    "spawn('npx tsx server/index.ts'"
  );
  src = src.replace(/\n    windowsHide: true,/, '\n    shell: true,\n    windowsHide: true,');
  src = src.replace('try { child.kill(\'SIGTERM\'); } catch { /* 已经退了 */ }',
    "spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });");
  src = src.replace(/await stopServer\(child, base\)/g, 'stopServer(child)');
}

// 剥掉块注释 + 行注释，避免注释里描述旧写法导致假绿/假红（§4 纪律）
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/\/\/.*$/, ''))
  .join('\n');

const failures = [];
let total = 0;
function ok(cond, label, detail) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// [1] 不再 shell:true 起测试 server（shell:true 是 cmd.exe pid 的根因）
ok(!/shell:\s*true/.test(code), 'startServer 不用 shell:true（pid 必须是真 node）');

// [2] 直接 spawn process.execPath（pid 写真 node，kill() 才生效）
ok(
  /spawn\(process\.execPath,/.test(code),
  'startServer 用 process.execPath 直接 spawn（不用 npx/cmd 中转）'
);
ok(/node_modules\/tsx\/dist\/cli\.mjs/.test(code), '直接指向 tsx cli.mjs 入口');

// [3] stopServer 用 kill()，且无 spawnSync(taskkill)
ok(/child\.kill\(['"]SIGTERM['"]\)/.test(code), 'stopServer 用 child.kill() 发信号');
ok(
  !/spawnSync\s*\(\s*['"]taskkill['"]/.test(code),
  'stopServer 不用 spawnSync(taskkill)（会阻塞事件循环）'
);
ok(!/\bspawnSync\s*\(/.test(code), '整个 a135 不出现 spawnSync（剥注释后）');

// [4] 端口自证 + 两处 await
ok(/async function waitPortClosed/.test(code), '有 waitPortClosed 端口自证函数');
ok(/await waitPortClosed\(base\)/.test(code), 'stopServer 调用 waitPortClosed');
const awaitCalls = (code.match(/await stopServer\(child, base\)/g) || []).length;
ok(awaitCalls === 2, '两处 stopServer 调用都 await（换进程前 + finally）', `got ${awaitCalls}`);

const passed = total - failures.length;
console.log(`verify-chain-nohang：${passed}/${total} 通过${probe ? '（反向探针模式）' : ''}`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
