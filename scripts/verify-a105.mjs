/**
 * A105「装好了却显示未安装」的探测链路修复验证。
 *
 * 背景（2026-10-24 本机实测）：
 *   - trae：应用找 `traecli`，国内版装出来的命令是 `trae-cn`（在 PATH 里），
 *     且它的垫片是「Electron 以 node 模式跑 cli.js」，三种既有垫片解析都覆盖不到
 *   - zcode：引擎是 `zcode.cjs`（无任何可执行扩展名），且按官方设计不进 PATH，
 *     安装目录由用户自选，没有任何环境变量记录
 * 修复前两者都报 `not-installed`；修复后应为 `ready`。
 *
 * 断言分三组：
 *   [1] findExecutable 的 extraExts / 数组候选（自造夹具目录，纯函数）
 *   [2] resolveLaunchTarget 对 .cjs 的启动目标（纯函数）
 *   [3] resolveElectronNodeShim 对**真实** trae-cn.cmd 的解析 + runCapture 实跑
 *       （没有 ELECTRON_RUN_AS_NODE=1 它会以 GUI 模式启动然后假超时，必须真跑）
 *   [4] shortcutInstallRoot 从开始菜单 ZCode.lnk 反推安装根
 *   [5] definitions 契约（bin 数组 / binExts / engineCandidates / shortcutNames）
 *   [6] 真探测：trae 与 zcode 的 availability 必须是 ready
 *
 * 运行：npx tsx scripts/verify-a105.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findExecutable,
  resolveLaunchTarget,
  resolveAnyLaunchTarget,
  resolveElectronNodeShim,
  runCapture,
  shortcutInstallRoot,
} from '../server/agents/probe.ts';
import { AGENT_DEFS } from '../server/agents/definitions.ts';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 文件存在（不猜、不递归） */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const TRAE_CMD = 'E:\\AI\\Trae CN\\bin\\trae-cn.cmd';
const ZCODE_ENGINE = 'E:\\AI\\ZCode\\resources\\glm\\zcode.cjs';

// ---------- [1] findExecutable：extraExts + 数组候选 ----------
console.log('\n[1] findExecutable 扩展名与候选数组');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'a105-'));
  try {
    // 只有 .cjs，没有任何可执行扩展名
    writeFileSync(path.join(dir, 'foo.cjs'), '// engine\n');
    writeFileSync(path.join(dir, 'bar.cjs'), '// engine\n');

    check('不带 extraExts 找不到 .cjs（旧行为，回归保护）', findExecutable('foo', [dir]) === null);
    check('带 [".cjs"] 能找到', findExecutable('foo', [dir], ['.cjs'])?.endsWith('foo.cjs') === true);

    // 数组候选：按顺序找第一个命中的
    check(
      '数组候选跳过不存在的、命中后面的',
      findExecutable(['nope', 'foo'], [dir], ['.cjs'])?.endsWith('foo.cjs') === true
    );
    check(
      '数组候选保持声明顺序（foo 在 bar 前）',
      findExecutable(['foo', 'bar'], [dir], ['.cjs'])?.endsWith('foo.cjs') === true
    );
    check(
      '数组候选全不中返回 null',
      findExecutable(['nope', 'nada'], [dir], ['.cjs']) === null
    );

    // 候选数组顺序敏感：bar 在前就命中 bar
    check(
      '数组顺序敏感（bar 在前时命中 bar）',
      findExecutable(['bar', 'foo'], [dir], ['.cjs'])?.endsWith('bar.cjs') === true
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- [2] resolveLaunchTarget 对 .cjs ----------
console.log('\n[2] .cjs 引擎的启动目标');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'a105-'));
  try {
    const engine = path.join(dir, 'zcode.cjs');
    writeFileSync(engine, '// engine\n');
    const t = resolveLaunchTarget(engine);
    check('command 不是 .cjs 本身（不会被当可执行文件 spawn）', t.command !== engine);
    check('prefixArgs 指向引擎文件', t.prefixArgs[0] === engine);
    check('command 是 node 解释器', /node(\.exe)?$/i.test(t.command));
    check('displayPath 保留原始路径（供展示）', t.displayPath === engine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- [3] Electron-node 垫片解析 + 实跑 ----------
console.log('\n[3] trae-cn.cmd 的 Electron-node 垫片解析');
{
  const t = resolveElectronNodeShim(TRAE_CMD);
  check('解析成功（旧代码三种解析都覆盖不到它）', t !== null);
  if (t) {
    check('command 是 Trae CN.exe（Electron 主程序）', t.command.endsWith('Trae CN.exe'), t.command);
    check('prefixArgs 指向 cli.js', /cli\.js$/.test(t.prefixArgs[0] ?? ''), t.prefixArgs[0]);
    check(
      'env 带上 ELECTRON_RUN_AS_NODE=1（少了它会起 GUI、stdout 永远不出东西）',
      t.env?.ELECTRON_RUN_AS_NODE === '1'
    );
    check('exe 与 js 都真实存在', isFile(t.command) && isFile(t.prefixArgs[0] ?? ''));

    // 统一入口也要认它
    const any = resolveAnyLaunchTarget(TRAE_CMD);
    check('resolveAnyLaunchTarget 同样解析为 node 模式', any.env?.ELECTRON_RUN_AS_NODE === '1');

    // 实跑：--version 应返回语义化版本号。这一条同时证明 env 注入真的生效 ——
    // 没有 ELECTRON_RUN_AS_NODE=1，Electron 会以 GUI 模式启动并在超时后无输出。
    const res = await runCapture(any, ['--version'], { timeoutMs: 20000 });
    const out = `${res.stdout}\n${res.stderr}`;
    check('实跑 --version 退出码为 0', res.code === 0, out.slice(0, 200));
    check('实跑输出含版本号', /\d+\.\d+\.\d+/.test(out), out.trim().slice(0, 120));
  }

  // 反证：一个不含 ELECTRON_RUN_AS_NODE 的普通 .cmd 不该被误判
  const dir = mkdtempSync(path.join(tmpdir(), 'a105-'));
  try {
    const plain = path.join(dir, 'plain.cmd');
    writeFileSync(plain, '@echo off\r\n"%~dp0..\\node.exe" "%~dp0index.js" %*\r\n');
    check('普通 npm 形态 .cmd 返回 null（不误判）', resolveElectronNodeShim(plain) === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- [4] 快捷方式反推安装根 ----------
console.log('\n[4] ZCode.lnk 反推安装根');
{
  const root = shortcutInstallRoot('ZCode.lnk');
  check('找到安装根', typeof root === 'string' && root.length > 0, String(root));
  if (root) {
    const engine = path.join(root, 'resources', 'glm', 'zcode.cjs');
    check('安装根下存在引擎 resources/glm/zcode.cjs', isFile(engine), engine);
  }
  check('不存在的快捷方式返回 null（不猜）', shortcutInstallRoot('definitely-not-installed-xyz.lnk') === null);
}

// ---------- [5] definitions 契约 ----------
console.log('\n[5] definitions 契约');
{
  const trae = AGENT_DEFS.find(d => d.descriptor.id === 'trae');
  const zcode = AGENT_DEFS.find(d => d.descriptor.id === 'zcode');

  check('trae 的 bin 是数组（多命令名候选）', Array.isArray(trae?.cli?.bin));
  check(
    "trae 的 bin 首选 'trae-cn'（本机实际命令名，文档名 traecli 在后）",
    Array.isArray(trae?.cli?.bin) && trae.cli.bin[0] === 'trae-cn'
  );

  check("zcode 的 binExts 含 '.cjs'（引擎无可执行扩展名）", zcode?.cli?.binExts?.includes('.cjs') === true);
  check(
    "zcode 的 engineCandidates 含 '{root}' 占位（安装目录自选，不写死盘符）",
    zcode?.engineCandidates?.some(c => c.includes('{root}')) === true
  );
  check(
    "zcode 声明了 shortcutNames（从快捷方式反推安装根）",
    zcode?.shortcutNames?.includes('ZCode.lnk') === true
  );
  check(
    'zcode 的 authFiles 仍是凭据判据（登录态在 ~/.zcode/cli/config.json）',
    zcode?.authFiles?.includes('.zcode/cli/config.json') === true
  );
}

// ---------- [6] 真探测 ----------
console.log('\n[6] 真探测（起子进程，几秒内完成）');
{
  // 探测只读 PATH / 文件系统，不写库；仍按约定把数据目录指向临时位置，
  // 避免任何情况下碰真实 data/chat.db
  const dataDir = mkdtempSync(path.join(tmpdir(), 'a105-data-'));
  mkdirSync(dataDir, { recursive: true });
  process.env.OPC_DATA_DIR = dataDir;
  const { registry: reg } = await import('../server/agents/registry.ts');

  const trae = await reg.probeOne('trae', true);
  check('trae 探测为 ready（修复前是 not-installed）', trae?.status.availability === 'ready', trae?.status.message);
  check('trae 拿到真实版本号', /\d+\.\d+/.test(trae?.status.version ?? ''), trae?.status.version);

  const zcode = await reg.probeOne('zcode', true);
  check('zcode 探测为 ready（修复前是 not-installed）', zcode?.status.availability === 'ready', zcode?.status.message);
  check('zcode 拿到真实版本号', /\d+\.\d+/.test(zcode?.status.version ?? ''), zcode?.status.version);

  reg.disposeAll();
  // Windows 上 sqlite 连接仍持着 chat.db，强删会 EBUSY（node-safe-delete-shim
  // 还会把它转成一次超时回收站操作）。临时目录交给系统清理，不值得为它赌 30 秒。
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 删不掉就留下，%TEMP% 自己会收 */
  }
}

// ---------- 汇总 ----------
console.log(`\nA105 结果：${pass}/${pass + fail}${fail ? `，失败项：${failures.join('；')}` : ''}`);
process.exit(fail ? 1 : 0);
