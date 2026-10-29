/**
 * Agent CLI 探测工具。
 *
 * 两个核心问题：
 *
 * 1. **找到可执行文件**。不能依赖 shell 的 `which`，因为服务进程的 PATH
 *    未必与用户终端一致。这里自己扫 PATH。
 *
 * 2. **正确 spawn**。Windows 上这些 CLI 是 npm 生成的 `.cmd` 垫片，
 *    而 Node 20+ 出于安全考虑（CVE-2024-27980）禁止直接 spawn `.cmd`。
 *    解法是解析垫片内容、提取真实的 JS 入口，然后直接 `node <entry.js>`
 *    —— 既绕开了 cmd.exe 的引号转义地狱，也消除了命令注入风险
 *    （prompt 是用户输入，绝不能拼进 shell 命令行）。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';

/** 一次实际可执行的启动目标 */
export interface LaunchTarget {
  /** 要 spawn 的可执行文件（node 或真实二进制） */
  command: string;
  /** 前置参数（如被垫片包装的 JS 脚本路径） */
  prefixArgs: string[];
  /** 供展示的原始路径 */
  displayPath: string;
  /**
   * 启动前必须注入的环境变量。
   *
   * 这类垫片的典型形态（本机实读 Trae CN 的 `trae-cn.cmd`）：
   *
   *   set ELECTRON_RUN_AS_NODE=1
   *   "%~dp0..\Trae CN.exe" "%~dp0..\resources\app\out\cli.js" %*
   *
   * 即用 **Electron 主程序**当 node 解释器去跑一个 cli.js。少了这个变量它
   * 就以 GUI 模式启动，一个窗口挂在后台，stdout 永远不出东西。
   * 这类「垫片里 set 的环境变量」属于启动目标的一部分，不能丢。
   *
   * ⚠️ 但能解析出这种目标 ≠ 该接它：`resources/app/out/cli.js` 是 VS Code
   * 系 **IDE 的** 命令行入口，不是 agent CLI。见 `isIdeLauncher()`。
   */
  env?: Record<string, string>;
  /**
   * 已知的问题：目标文件存在但根本执行不了。
   * 典型场景是 npm 的 native optional dependency 没装上，
   * 包只留了一个同名占位脚本（Claude Code 的 `.exe` 实际是 500 字节的文本）。
   */
  problem?: string;
}

/**
 * 校验原生二进制是否真的是可执行文件（按魔数判断）。
 *
 * 为什么需要这一步：npm 在 optional dependency 缺失时，会留下一个
 * **同名但内容是报错文本的占位文件**（扩展名还是 .exe）。它「存在」，
 * 所以任何基于文件是否存在的探测都会误判为可用；只有 spawn 之后才会
 * 以一个含糊的错误失败。这里提前按魔数识破，把错误变成可诊断的结论。
 */
function checkNativeBinary(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    if (read < 2) return '目标文件为空或不可读';

    // MZ = Windows PE
    if (buf[0] === 0x4d && buf[1] === 0x5a) return null;
    // ELF
    if (buf[0] === 0x7f && buf[1] === 0x45) return null;
    // Mach-O (32/64, 大小端)
    if ([0xfe, 0xce, 0xcf].includes(buf[0]!) && [0xed, 0xfa].includes(buf[1]!)) return null;
    // shebang 脚本
    if (buf[0] === 0x23 && buf[1] === 0x21) return null;

    const size = fs.statSync(filePath).size;
    return `目标文件不是可执行程序（仅 ${size} 字节，魔数 ${buf.toString('hex')}），可能是依赖未安装时留下的占位脚本`;
  } catch (err) {
    return `无法读取目标文件：${(err as Error).message}`;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

const isWindows = process.platform === 'win32';

/**
 * Windows 可执行扩展名。
 *
 * 注意顺序：`''`（无扩展名）必须放在**最后**。
 * npm 的 bin 目录里同时存在三份同名文件：`codex`（POSIX shell 脚本）、
 * `codex.cmd`、`codex.ps1`。如果先试无扩展名的那份，会拿到 bash 脚本，
 * spawn 直接 ENOENT —— 实测踩过这个坑。
 *
 * `extraExts` 给「引擎是 `.cjs`」这类 Agent 用（ZCode 桌面版的引擎就是
 * `resources/glm/zcode.cjs`，没有任何可执行扩展名）。放在 `''` 之前：
 * 有扩展名的真实文件优先于无扩展名的同名脚本。
 */
function pathExts(extraExts: string[] = []): string[] {
  const raw = isWindows
    ? process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
    : '';
  return [...raw.split(';').filter(Boolean), ...extraExts, ''];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 在 PATH 中查找可执行文件。
 * @param cmd 命令名或路径（传数组时按顺序找，第一个命中的用）
 * @param extraDirs 额外搜索目录（部分工具装在 PATH 之外，如 Hermes 的 bin）
 * @param extraExts 追加的扩展名（如 `['.cjs']`，给引擎不是可执行文件的 Agent 用）
 * @returns 绝对路径，未找到返回 null
 */
export function findExecutable(
  cmd: string | string[],
  extraDirs: string[] = [],
  extraExts: string[] = []
): string | null {
  const names = Array.isArray(cmd) ? cmd : [cmd];
  for (const name of names) {
    const hit = findOneExecutable(name, extraDirs, extraExts);
    if (hit) return hit;
  }
  return null;
}

function findOneExecutable(cmd: string, extraDirs: string[], extraExts: string[]): string | null {
  // 已带路径分隔符，直接检查
  if (cmd.includes('/') || cmd.includes('\\')) {
    for (const ext of pathExts(extraExts)) {
      const candidate = cmd + ext;
      if (isFile(candidate)) return path.resolve(candidate);
    }
    return null;
  }

  const pathEnv = process.env.PATH || '';
  const dirs = [
    ...pathEnv.split(isWindows ? ';' : ':'),
    ...extraDirs,
  ].filter(Boolean);

  for (const dir of dirs) {
    for (const ext of pathExts(extraExts)) {
      const candidate = path.join(dir, cmd + ext);
      if (isFile(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

/** 展开形如 `%LOCALAPPDATA%\\hermes\\bin` 的路径模板 */
export function expandPath(template: string): string {
  if (!isWindows) {
    return template.replace(/^~/, process.env.HOME || '');
  }
  return template.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(process.env).find(
      k => k.toLowerCase() === name.toLowerCase()
    );
    return key ? process.env[key]! : whole;
  });
}

/**
 * 从 Windows 快捷方式（.lnk）里挖出它指向的可执行文件。
 *
 * 为什么需要：ZCode 这类工具**只通过桌面版分发**（官方指引就是「装桌面版后
 * 把引擎软链到 PATH」），安装目录由用户在安装时自选（常见装在 `D:\Apps\ZCode`，
 * 默认则在 `%LOCALAPPDATA%\Programs\ZCode`），没有任何环境变量记录它。
 * 而开始菜单 / 桌面的快捷方式**一定**指向真实路径 —— 这是唯一稳定的线索。
 *
 * 做法是「解码后搜」而不是按二进制结构逐字段解析：.lnk 的
 * LinkInfo.LocalBasePath 是 UTF-16LE 以 NUL 结尾的字符串，直接整块解码成
 * utf16le 再正则抓 `X:\...\*.exe` 比按偏移量解析耐版本差异得多
 * （实测本机 `ZCode.lnk` 一把命中）。ASCII 兜底是给老式写入器留的余量。
 */
export function resolveWindowsShortcut(lnkPath: string): string | null {
  if (!isWindows) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(lnkPath);
  } catch {
    return null;
  }

  // 只认「盘符:\」开头的绝对路径，避免把命令行参数或图标路径当目标
  const RE = /([A-Za-z]:\\[^\u0000"'|<>]*?\.exe)/;
  for (const decoded of [buf.toString('utf16le'), buf.toString('latin1')]) {
    const m = decoded.match(RE);
    if (m) {
      const target = m[1]!.trim();
      if (isFile(target)) return target;
    }
  }
  return null;
}

/**
 * 在开始菜单与桌面找指定名字的快捷方式，返回它指向的**安装根目录**。
 * 找不到返回 null（不猜）。
 */
export function shortcutInstallRoot(shortcutName: string): string | null {
  if (!isWindows) return null;
  const roots = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.USERPROFILE || '', 'Desktop'),
    path.join(process.env.PUBLIC || '', 'Desktop'),
    // 开始菜单里也可能是「一个目录 + 里面的同名快捷方式」
  ];
  for (const root of roots) {
    if (!root) continue;
    const direct = path.join(root, shortcutName);
    if (isFile(direct)) {
      const target = resolveWindowsShortcut(direct);
      if (target) return path.dirname(target);
    }
    const nested = path.join(root, shortcutName, shortcutName);
    if (isFile(nested)) {
      const target = resolveWindowsShortcut(nested);
      if (target) return path.dirname(target);
    }
  }
  return null;
}

/** 垫片里指向 JS 入口的引用 */
const SHIM_JS_RE = /%dp0%[\\/]([^"%]+?\.(?:js|mjs|cjs))/i;
/** 垫片里指向原生二进制的引用（可能有多处，需逐个甄别） */
const SHIM_BIN_RE = /%dp0%[\\/]([^"%]+?\.(?:exe|com))/gi;
/** 垫片自带的 node 解释器引用，不是真正的入口 */
const SHIM_NODE_RE = /(^|[\\/])node\.exe$/i;

/**
 * 解析 npm `.cmd` / `.bat` 垫片，提取真实的启动目标。
 *
 * 顺序很关键：**必须先找 JS 入口，再考虑原生二进制**。
 *
 * 因为 npm 的 shim 里会先出现它自己的解释器，例如 codex.cmd：
 *
 *   IF EXIST "%dp0%\node.exe" (
 *     SET "_prog=%dp0%\node.exe"        ← 这是垫片自带的 node，不是入口
 *   ) ELSE ( ... )
 *   ...
 *   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*   ← 这才是入口
 *
 * 如果按「找第一个像可执行文件的东西」去解析，会命中 node.exe，
 * 结果变成执行 `node --version` 并把它当成 codex 的版本号（实测踩过）。
 *
 * 两类垫片的形态：
 *   A) JS 入口 —— codex
 *   B) 原生二进制 —— opencode / claude
 */
export function resolveLaunchTarget(binPath: string): LaunchTarget {
  const ext = path.extname(binPath).toLowerCase();
  const isShim = ext === '.cmd' || ext === '.bat';

  // JS 引擎本体（`.cjs` / `.mjs` / `.js`）：直接用 node 跑。
  // ZCode 桌面版的引擎就是 `resources/glm/zcode.cjs` —— 它没有任何可执行
  // 扩展名，spawn 它只会 ENOENT；而它本来就是个 Node 脚本。
  if (!isShim && /\.(c|m)?js$/i.test(binPath)) {
    const command = nodeExecutable();
    // 只有 node 也找不到、只能拿 Electron 主程序兜底时，才需要声明
    // 「以 node 身份跑」—— 否则它会起一个看不见的 GUI 窗口。
    const needNodeMode = command === process.execPath && isElectronRuntime();
    return {
      command,
      prefixArgs: [binPath],
      displayPath: binPath,
      ...(needNodeMode ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    };
  }

  if (!isShim) {
    const problem = /\.(exe|com)$/i.test(binPath)
      ? (checkNativeBinary(binPath) ?? undefined)
      : undefined;
    return { command: binPath, prefixArgs: [], displayPath: binPath, problem };
  }

  let content = '';
  try {
    content = fs.readFileSync(binPath, 'utf8');
  } catch {
    // 读不到就退回原样（由调用方判定为不可解析）
    return { command: binPath, prefixArgs: [], displayPath: binPath };
  }

  const dir = path.dirname(binPath);
  const toAbs = (rel: string) => path.join(dir, rel.replace(/[\\/]/g, path.sep));

  // ---- A) 优先找 JS 入口 ----
  const jsMatch = content.match(SHIM_JS_RE);
  if (jsMatch) {
    const scriptPath = toAbs(jsMatch[1]);
    if (isFile(scriptPath)) {
      // 垫片同目录自带 node.exe 就用它；否则退回 PATH 里的 node
      // （**不能**直接用 process.execPath：打包后它是 Electron 主程序，
      //  见 nodeExecutable 的说明）
      const localNode = path.join(dir, 'node.exe');
      const command = isFile(localNode) ? localNode : nodeExecutable();
      return { command, prefixArgs: [scriptPath], displayPath: binPath };
    }
  }

  // ---- B) 没有 JS 入口，找原生二进制（跳过垫片自带的 node.exe）----
  SHIM_BIN_RE.lastIndex = 0;
  let binMatch: RegExpExecArray | null;
  while ((binMatch = SHIM_BIN_RE.exec(content)) !== null) {
    const rel = binMatch[1];
    if (SHIM_NODE_RE.test(rel)) continue; // 垫片自己的解释器，跳过

    const binPathAbs = toAbs(rel);
    if (!isFile(binPathAbs)) continue;

    const problem = checkNativeBinary(binPathAbs) ?? undefined;
    return { command: binPathAbs, prefixArgs: [], displayPath: binPath, problem };
  }

  return { command: binPath, prefixArgs: [], displayPath: binPath };
}

/**
 * 是否跑在 Electron 运行时里（主进程）。
 *
 * 打包后 `process.execPath` 指向的是 **Electron 主程序**而不是 node ——
 * 拿它 spawn 一个 `.cjs` 会以 GUI 模式启动，stdout 永远不出东西。
 */
function isElectronRuntime(): boolean {
  return Boolean((process.versions as { electron?: string }).electron);
}

/**
 * 跑 JS 引擎时用的 node 解释器。
 *
 * 优先找 PATH 里的真 node；找不到才退回 `process.execPath` ——
 * 开发态（tsx / node 直跑）它就是 node，打包态它是 Electron，
 * 那种情况由调用方补 `ELECTRON_RUN_AS_NODE=1`（Electron 认这个变量，
 * 会退化成纯 node 进程）。
 */
export function nodeExecutable(): string {
  return findExecutable('node') ?? process.execPath;
}

/**
 * 解析「Python 启动器」型垫片。
 *
 * Hermes 这类工具用 Python 生成启动器，形态是：
 *   "<python.exe>" -I -c "import base64; exec(base64.b64decode('<B64>'))" %*
 *
 * 注意不能简单按空格切分参数 —— .cmd 是 CRLF 且 base64 里可能含 `+` `/` `=`，
 * 按空白切分会把载荷切碎（实测踩过）。这里改为精确匹配 base64 字符集，
 * 再按原样重建 `-c` 参数，保证字节级一致。
 */
export function resolvePythonLauncher(binPath: string): LaunchTarget | null {
  const ext = path.extname(binPath).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return null;

  let content = '';
  try {
    content = fs.readFileSync(binPath, 'utf8');
  } catch {
    return null;
  }

  const exe = content.match(/"([^"]*python[^"]*\.exe)"/i)?.[1];
  const b64 = content.match(/b64decode\(\s*'([A-Za-z0-9+/=]+)'\s*\)/)?.[1];
  if (!exe || !b64) return null;
  if (!isFile(exe)) return null;

  const prefixArgs: string[] = [];
  if (/(^|\s)(-I|--isolated)(\s|$)/.test(content)) prefixArgs.push('-I');
  prefixArgs.push('-c', `import base64; exec(base64.b64decode('${b64}'))`);

  return { command: exe, prefixArgs, displayPath: binPath };
}

/**
 * 版本的「可排序数字」形式：`YYYY.MM.DD[-HH-MM-SS]-hash` → `YYYYMMDD`。
 * 与 cursor-agent.ps1 里的 `Parse-VersionString` 保持一致（按月/日补零后拼整数），
 * 否则 `2026.9.8` 会排在 `2026.10.16` 后面（字符串序/MD 拼接序的经典陷阱）。
 */
function versionSortKey(name: string): number | null {
  const datePart = name.split('-')[0];
  const parts = datePart.split('.');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts;
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null;
  return Number(y + m.padStart(2, '0') + d.padStart(2, '0'));
}

/**
 * 解析「PowerShell 包装」型垫片。
 *
 * 有一类安装器**不用 npm 的 bin 垫片**，而是自己写两层包装：
 *
 *   agent.cmd            → powershell -NoProfile -File "...\cursor-agent.ps1" %*
 *   cursor-agent.ps1     → & "$nodePath" "...\versions\<最新版本>\index.js" $args
 *
 * 这种形态下 `resolveLaunchTarget` 一条都匹配不上（没有 `node_modules/xxx.js`，
 * 也没有原生二进制），只能标成"无法解析垫片"—— Cursor Agent 就是如此，
 * 明明装好了却被判不可用。
 *
 * 这里的做法是把 .ps1 的逻辑**读出来再按其结构解析**，最终仍归结为
 * `node <index.js>`，与 JS 垫片解析的结果同构，于是 spawn 侧完全不用改，
 * 也**不会退回到 shell 执行**（解析不成功就返回 null，交给调用方判不可用）。
 *
 * 三件事要从 .ps1 里挖出来：node 与 js 的路径模板、版本目录名、版本筛选正则。
 * 挖不全就返回 null —— 宁可不可用，也不猜。
 */
export function resolvePowerShellShim(binPath: string): LaunchTarget | null {
  const ext = path.extname(binPath).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return null;

  // .cmd 里定位那一句 `-File "...ps1"`
  const cmd = readTextFile(binPath);
  if (!cmd) return null;

  // 先把垫片里的路径变量归一成 baseDir，否则匹配到的会是
  // `%SCRIPT_DIR%\xxx.ps1` 这种无法解析的占位串（第一次写就栽在这）。
  // cmd 的两种写法：`%~dp0`（去尾杠）与自定义变量 `%SCRIPT_DIR%`（已含杠）。
  const baseDir = path.dirname(binPath);
  const normCmd = cmd
    .replace(/%~dp0/gi, baseDir + path.sep)
    .replace(/%[A-Za-z_][A-Za-z0-9_]*%/g, m =>
      m.toUpperCase() === '%SCRIPT_DIR%' ? baseDir : m
    );

  const ps1Rel = normCmd.match(/-File\s+"([^"]+\.ps1)"/i)?.[1];
  if (!ps1Rel) return null;

  const ps1Path = path.isAbsolute(ps1Rel)
    ? ps1Rel
    : path.resolve(baseDir, ps1Rel.replace(/[\\/]/g, path.sep));
  const ps1 = readTextFile(ps1Path);
  if (!ps1) return null;

  // 1) 同目录自带 node.exe 的形态（开发态）
  const localNode = path.join(baseDir, 'node.exe');
  const localJs = path.join(baseDir, 'index.js');
  if (isFile(localNode) && isFile(localJs)) {
    return { command: localNode, prefixArgs: [localJs], displayPath: binPath };
  }

  // 2) versions\<版本> 形态。.ps1 里关键三行是：
  //      $nodePath = "$scriptPath\versions\$versionName\node.exe"
  //      & "$nodePath" "$scriptPath\versions\$versionName\index.js" $args
  //    分别取「赋值行」与「调用行第二个参数」当作路径模板。
  const nodeTemplate = ps1.match(/\$nodePath\s*=\s*"([^"]+)"/)?.[1];
  const scriptTemplate = ps1.match(/&\s+"\$nodePath"\s+"([^"]+)"/)?.[1];
  if (!nodeTemplate || !scriptTemplate) return null;

  // 版本目录名。
  // **不要**用 `-Path "$scriptPath\versions"` 去提 —— 那个正则很容易被 .ps1
  // 里别的 -Path 行抢先匹配（实测匹配到了 node.exe）。直接从上面已经拿到
  // 的路径模板里切第二段：`$scriptPath\versions\$versionName\node.exe`
  // → ['$scriptPath','versions','$versionName','node.exe'] → 'versions'。
  const tplParts = nodeTemplate.split(/[\\/]+/).filter(Boolean);
  const versionsIdx = tplParts.indexOf('$scriptPath') + 1;
  const versionsDirName = tplParts[versionsIdx];
  if (!versionsDirName || versionsDirName.startsWith('$')) return null;
  const versionsDir = path.join(baseDir, versionsDirName);
  if (!isDirectory(versionsDir)) return null;

  // 版本筛选正则：.ps1 里 `$name -match '^\d{4}\....$'` 那一条
  const versionRe = ps1.match(/-match\s+'([^']+)'/)?.[1];
  const pick = (name: string) => {
    if (versionRe) {
      try { if (!new RegExp(versionRe).test(name)) return false; } catch { return false; }
    }
    return versionSortKey(name) !== null;
  };

  let best: { dir: string; key: number } | null = null;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!pick(name)) continue;
    const key = versionSortKey(name)!;
    if (!best || key > best.key) best = { dir: path.join(versionsDir, name), key };
  }
  if (!best) return null;

  const jsPath = scriptTemplate
    .replace(/\$scriptPath/g, baseDir)
    .replace(/\$versionName/g, path.basename(best.dir));
  const nodePath = nodeTemplate
    .replace(/\$scriptPath/g, baseDir)
    .replace(/\$versionName/g, path.basename(best.dir));

  const absJs = path.resolve(jsPath);
  const absNode = path.resolve(nodePath);
  if (!isFile(absNode) || !isFile(absJs)) return null;

  return { command: absNode, prefixArgs: [absJs], displayPath: binPath };
}

/**
 * 读文本文件，兼容 UTF-8 BOM 与 UTF-16LE（PowerShell 的 `Out-File` 默认
 * 会写成 UTF-16LE，直接 toString('utf8') 会得到一串 `\0`）。
 */
function readTextFile(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
    return buf.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析「Electron 以 node 模式跑 cli.js」型垫片。
 *
 * Trae CN 的 `bin/trae-cn.cmd` 是这种形态（2026-10-24 本机实读）：
 *
 *   @echo off
 *   setlocal
 *   set ELECTRON_RUN_AS_NODE=1
 *   "%~dp0..\Trae CN.exe" "%~dp0..\resources\app\out\cli.js" %*
 *
 * 即：把 **Electron 主程序**当 node 解释器，去跑自带的 cli.js。
 * 三种已有解析都覆盖不到它（没有 npm 的 node_modules 引用、不是 Python
 * 启动器、也不是 PowerShell 包装），不认它就会把明明装好的 Trae 判成
 * 「无法解析垫片」。
 *
 * 两个必须一起挖出来的东西：
 *   1. `ELECTRON_RUN_AS_NODE=1` —— 少了它 Electron 以 GUI 模式启动，
 *      挂一个看不见的窗口，stdout 永远不出东西（探测会假超时）。
 *   2. exe 与 js 的**顺序** —— 先出现的是主程序，后出现的是入口脚本。
 *      按「第一个 .exe + 第一个 .js」去匹配会把别处的 .js 抢先命中，
 *      所以 js 只在 exe 引用**之后**的文本里找。
 */
export function resolveElectronNodeShim(binPath: string): LaunchTarget | null {
  const ext = path.extname(binPath).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return null;

  const content = readTextFile(binPath);
  if (!content) return null;
  if (!/ELECTRON_RUN_AS_NODE\s*=\s*1/i.test(content)) return null;

  const baseDir = path.dirname(binPath);
  const norm = content.replace(/%~dp0/gi, baseDir + path.sep);

  const exeMatch = norm.match(/"([^"]+\.exe)"/i);
  if (!exeMatch || exeMatch.index === undefined) return null;

  // js 入口只在 exe 引用之后找，且排除垫片自带的 node.exe 当主程序
  const exeRel = exeMatch[1]!;
  if (SHIM_NODE_RE.test(exeRel)) return null;
  const rest = norm.slice(exeMatch.index + exeMatch[0].length);
  const jsMatch = rest.match(/"([^"]+\.(?:c|m)?js)"/i);
  if (!jsMatch) return null;

  const exe = path.resolve(exeRel.replace(/[\\/]/g, path.sep));
  const js = path.resolve(jsMatch[1]!.replace(/[\\/]/g, path.sep));
  if (!isFile(exe) || !isFile(js)) return null;

  return {
    command: exe,
    prefixArgs: [js],
    displayPath: binPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * 判断一个启动目标是不是「Electron 应用自带的 IDE 启动器」（A119）。
 *
 * ## 为什么需要这道守卫
 *
 * Trae CN 的 `bin/trae-cn.cmd` 是 VS Code 的官方垫片，跑的是
 * `resources/app/out/cli.js` —— 那是 **IDE 的命令行入口**（即 `code` 命令），
 * 只认 version / status / tunnel / serve-web / install-extension /
 * locate-extension / open-url，**没有任何 agent 子命令**。它的参数语义是
 * 「要打开的路径」（`--help` 里写着 `Usage: trae-cn.exe [options] [paths...]`）。
 *
 * 于是 `xxx exec --json "hi"` 不报错，而是把 `exec` 当成文件夹路径
 * **拉起 IDE 窗口**：子进程变成 GUI，stdout 永不产出，界面一直转圈到
 * 8 分钟超时。用户看到的现象是「跟某个 Agent 对话会弹出它自己的应用」。
 *
 * 这类目标最坑的地方是**它能起来、也能报版本号** —— 任何只看「命令在不在、
 * `--version` 有没有输出」的探测都会判成就绪，直到真调用才暴露。
 *
 * ## 判据（两条同时命中）
 *
 *   ① 启动目标带 `ELECTRON_RUN_AS_NODE=1`（Electron 被当 node 解释器用）
 *   ② 入口脚本落在 `<任意目录>/resources/app/out/cli.js`
 *
 * 这两条合起来只有 VS Code 系（含 Trae / Cursor / Antigravity 等 fork）的
 * IDE 自带 CLI 满足。真正的 agent CLI 即使是 Electron 壳，入口也不会是
 * `resources/app/out/cli.js` 这个位置。
 *
 * ## 为什么不用「跑 `--help` 看有没有 `[paths...]`」
 *
 * 那要给**每个** Agent 多起一个子进程，而 `--help` 在个别 CLI 上可能进交互
 * 模式一直挂着（只能等超时）。这里的判据是纯静态的：零成本、零副作用，
 * 也不需要把「帮用户判断这是什么东西」这件事交给对方程序自己回答。
 */
export function isIdeLauncher(target: LaunchTarget): boolean {
  if (target.env?.ELECTRON_RUN_AS_NODE !== '1') return false;
  const entry = target.prefixArgs[0];
  if (!entry) return false;
  const norm = entry.replace(/\\/g, '/').toLowerCase();
  return /\/resources\/app\/out\/cli\.(?:c|m)?js$/.test(norm);
}

/**
 * 统一的启动目标解析：依次尝试 JS 垫片、Python 启动器、PowerShell 包装、
 * Electron-node 垫片，最后退回原样执行。
 */
export function resolveAnyLaunchTarget(binPath: string): LaunchTarget {
  const js = resolveLaunchTarget(binPath);
  if (js.command !== binPath) return js;

  const py = resolvePythonLauncher(binPath);
  if (py) return py;

  const ps = resolvePowerShellShim(binPath);
  if (ps) return ps;

  const en = resolveElectronNodeShim(binPath);
  if (en) return en;

  return { command: binPath, prefixArgs: [], displayPath: binPath };
}

/** 是否是需要 shell 才能跑的垫片（即解析失败的 .cmd/.bat） */
export function isUnresolvedShim(target: LaunchTarget, binPath: string): boolean {
  return target.command === binPath && /\.(cmd|bat)$/i.test(binPath);
}

/** 命令执行结果 */
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 执行命令并捕获输出（用于版本探测等短任务）。
 * 使用 shell:false，参数以数组传递，不做任何字符串拼接。
 */
export function runCapture(
  target: LaunchTarget,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ExecResult> {
  const { timeoutMs = 8000, cwd, env } = opts;

  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    let child: ReturnType<typeof spawn>;
    let timer: NodeJS.Timeout;

    try {
      child = spawn(target.command, [...target.prefixArgs, ...args], {
        cwd,
        // target.env 是启动目标的一部分（如 Trae 的 ELECTRON_RUN_AS_NODE=1），
        // 必须垫在 process.env 之上；显式传入的 env 优先级最高。
        env: { ...process.env, ...(target.env ?? {}), ...(env ?? {}) },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // spawn 对「存在但不可执行」的文件会**同步抛错**（如 Windows 上的
      // spawn UNKNOWN）。必须在这里兜住，否则一次探测就能打挂整个进程。
      resolve({
        code: null,
        stdout: '',
        stderr: String((err as Error)?.message || err),
        timedOut: false,
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', d => {
      stdout += d.toString();
    });
    child.stderr?.on('data', d => {
      stderr += d.toString();
    });
    child.on('error', err => {
      stderr += String(err?.message || err);
      finish(null);
    });
    child.on('close', code => finish(code));
  });
}

/** 看起来像报错而不是版本号的文本 */
const ERROR_LIKE_RE =
  /(enoent|eacces|eprem|not recognized|is not defined|command not found|no such file|cannot find|traceback|syntaxerror|error:)/i;

/**
 * 从版本输出里抽出干净的版本号。
 * 明确拒绝把报错文本当成版本号 —— 否则「spawn xxx ENOENT」会被
 * 当成版本显示在名册页上（实测踩过）。
 */
function extractVersion(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (ERROR_LIKE_RE.test(text)) return undefined;

  // 优先匹配语义化版本
  const semver = text.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
  if (semver) return semver[0];

  // 退回第一行非空内容
  const firstLine = text.split(/\r?\n/).find(l => l.trim());
  const line = firstLine?.trim();
  if (!line || line.length > 60) return undefined;
  return line;
}

/**
 * 探测某个命令的版本。
 * 依次尝试 `--version` / `-v` / `version`，任一成功即返回。
 *
 * 只有退出码为 0 才采信输出：进程起不来（ENOENT）时 code 为 null，
 * 此时 stdout/stderr 里是报错信息，绝不能当版本用。
 */
export async function probeVersion(
  binPath: string,
  timeoutMs = 8000
): Promise<{ version?: string; raw?: string }> {
  const target = resolveAnyLaunchTarget(binPath);
  // 已知不是可执行程序就别去试了 —— 徒增一次失败和一段误导性的输出
  if (target.problem) return { raw: target.problem };

  let lastRaw = '';

  for (const args of [['--version'], ['-v'], ['version']]) {
    const res = await runCapture(target, args, { timeoutMs });
    if (res.timedOut) continue;

    const combined = `${res.stdout}\n${res.stderr}`.trim();
    if (combined) lastRaw = combined.slice(0, 400);

    // 起不来（code === null）或非零退出 → 不采信
    if (res.code !== 0) continue;

    const version = extractVersion(res.stdout) || extractVersion(res.stderr);
    if (version) return { version, raw: combined.slice(0, 400) };
  }

  return { raw: lastRaw || undefined };
}

export { isWindows };

// ============= 后端可达性 =============

/**
 * 读取当前生效的 HTTP 代理。
 *
 * 为什么探测必须关心代理：CLI 子进程继承 process.env，会走代理出网。
 * 如果探测自己直连，就会出现「探测说通、真调用不通」的偏差
 * （实测 chatgpt.com 直连超时、走代理是 502，两条路都不通；
 * 但别的环境里完全可能只有代理这一条路通）。
 */
function proxyUrl(): URL | null {
  const raw =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** 经代理建立 CONNECT 隧道 */
function reachViaProxy(
  proxy: URL,
  host: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let req: http.ClientRequest;
    try {
      req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 80,
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: { Host: `${host}:${port}` },
        timeout: timeoutMs,
      });
    } catch {
      done(false);
      return;
    }

    req.on('connect', (res, socket) => {
      socket.destroy();
      done(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

/** 直连（TCP 握手即可判定可达） */
function reachDirect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** 判断单个主机是否可达（与 CLI 子进程走同一条链路） */
export function checkHostReachable(host: string, timeoutMs = 2500): Promise<boolean> {
  const [name, portRaw] = host.split(':');
  const port = Number(portRaw) || 443;
  const proxy = proxyUrl();
  return proxy
    ? reachViaProxy(proxy, name!, port, timeoutMs)
    : reachDirect(name!, port, timeoutMs);
}

/**
 * 判断这批后端主机是否**全部**不可达。
 *
 * @returns 全部不可达时返回这些主机名；否则返回 null。
 *
 * 取「全部不可达」而不是「任一不可达」：只要有一条路通，就说明网络层
 * 没有被整体切断，不该替 Agent 下「用不了」的结论 —— 宁可漏报，不可误报。
 */
export async function allHostsUnreachable(
  hosts: string[],
  timeoutMs = 2500
): Promise<string[] | null> {
  if (hosts.length === 0) return null;
  const results = await Promise.all(
    hosts.map(async h => ({ host: h, ok: await checkHostReachable(h, timeoutMs) }))
  );
  return results.every(r => !r.ok) ? results.map(r => r.host) : null;
}
