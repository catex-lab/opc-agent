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
 */
function pathExts(): string[] {
  if (!isWindows) return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return [...raw.split(';').filter(Boolean), ''];
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
 * @param cmd 命令名或路径
 * @param extraDirs 额外搜索目录（部分工具装在 PATH 之外，如 Hermes 的 bin）
 * @returns 绝对路径，未找到返回 null
 */
export function findExecutable(cmd: string, extraDirs: string[] = []): string | null {
  // 已带路径分隔符，直接检查
  if (cmd.includes('/') || cmd.includes('\\')) {
    for (const ext of pathExts()) {
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
    for (const ext of pathExts()) {
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
      const localNode = path.join(dir, 'node.exe');
      const command = isFile(localNode) ? localNode : process.execPath;
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
 * 统一的启动目标解析：依次尝试 JS 垫片、Python 启动器，最后退回原样执行。
 */
export function resolveAnyLaunchTarget(binPath: string): LaunchTarget {
  const js = resolveLaunchTarget(binPath);
  if (js.command !== binPath) return js;

  const py = resolvePythonLauncher(binPath);
  if (py) return py;

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
        env: env ?? process.env,
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
