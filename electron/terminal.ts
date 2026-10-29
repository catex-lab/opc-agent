/**
 * P4：右侧工作区面板的「终端」标签。
 *
 * ## 两个通道：PTY 优先，管道版兜底
 *
 * A80 落地的是**管道版**（`child_process.spawn` + 三流管道）：能敲命令、能看输出、
 * `cd` 跨命令连续，但**没有终端语义** —— vim / top / less / 交互式提示拿不到 TTY，
 * 行为不可预期。A82 按定稿补上 PTY 版（`node-pty`）。
 *
 * PTY 版给的是真终端：光标寻址、颜色协商、窗口尺寸、回显都由 ConPTY/winpty 负责，
 * 于是 vim 能跑、top 能跑、`python` 交互式 REPL 能跑。
 *
 * **管道版没有删**，它降级成兜底：`node-pty` 是原生模块，万一 `.node` 加载失败
 * （打包时 asarUnpack 漏配、升级 Electron 后 ABI 不兼容、平台没有预编译件），
 * 终端应该退化到「至少能敲命令」，而不是整个标签点不动。界面会**如实显示当前
 * 是哪一版** —— 用户看到「管道版 · 无 TTY」就知道 vim 跑不了，不靠踩。
 *
 * ## node-pty 为什么不需要在本机构建
 *
 * `node-pty` 用的是 **N-API**（`node-addon-api`），N-API 是 ABI 稳定的：为 Node
 * 构建的模块可以直接跑在 Electron 里（只要 N-API 版本不超过 Electron 支持的上限）。
 * 包里自带 `prebuilds/win32-x64/*.node`，`lib/utils.js` 的加载顺序是
 * `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`，所以只要没有
 * 源码构建产物，它就用预编译件。**已实测**：Electron 44 主进程 ABI 下
 * `require('node-pty')` 成功，ConPTY 输出完整 ANSI 序列。
 *
 * 也因此**打包配置不用开原生重建**（`nodeGypRebuild: false` 保持不变）——
 * 开它反而会让 @electron/rebuild 在本机撞上 Spectre 库缺失（见 patches/ 目录）。
 *
 * ## 三条边界（与管道版相同，PTY 版一并继承）
 *
 * 1. **cwd 只能来自会话工作目录**，且必须真的存在。前端传什么就信什么，
 *    等于把「能在哪执行命令」交给被约束方。
 * 2. **同一时刻只有一个 shell**。再点一次「启动」先杀掉旧的 —— 两个 shell 抢
 *    同一个目录，输出交错在一起，用户根本看不出哪行是谁打的。
 * 3. **shell 不能比窗口活得久**。它是一个能执行任意命令的活对象，窗口关了
 *    必须跟着没（`app.on('before-quit')` 与窗口 `closed` 都挂钩子）。
 *
 * ## 输出为什么要留一段历史
 *
 * 用户常常先敲几条命令，再切到文件标签看一眼，回来时不该看到一片空白。
 * 所以这里留一个滚动尾巴，晚来的订阅者先把历史读回去。
 */

import { statSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** 输出历史尾巴上限。再老的内容对「回来看看刚才输了什么」没有意义。 */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/** PTY 初始尺寸。渲染进程挂载后会立刻用真实尺寸 resize 一次。 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalState {
  running: boolean;
  cwd: string | null;
  /** 实际选中的 shell（cmd.exe / /bin/bash），给界面显示用 */
  shell: string;
  /** 进程退出码。null = 还在跑 / 没启动过 */
  exitCode: number | null;
  /**
   * 当前是不是 PTY 通道。界面据此说话：true → 交互式程序可用；
   * false → 「管道版 · 无 TTY」。**不写死 false** —— 这一版已经有 PTY 了，
   * 写死就等于逼着界面说谎。
   */
  pty: boolean;
  /** 当前列数（PTY 才有意义；管道版恒为初始值） */
  cols: number;
  /** 当前行数 */
  rows: number;
}

const IDLE: TerminalState = {
  running: false,
  cwd: null,
  shell: '',
  exitCode: null,
  pty: false,
  cols: DEFAULT_COLS,
  rows: DEFAULT_ROWS,
};

/**
 * 选 shell。Windows 用 cmd.exe（任何机器上都有），其余平台优先 bash。
 *
 * ## cmd 为什么带 `/q`
 *
 * 实测（`spawn('cmd.exe', [], {stdio:['pipe',...]})` 写一行 `echo X`）：
 * **管道下的 cmd.exe 自己会把 stdin 的命令行回显出来，还会打提示符**。
 * 而渲染进程为了「bash 不回显」的问题本来就自己回显了一遍 —— 两边一叠，
 * 用户看到每条命令打两次，像坏了。
 *
 * `/q` 关掉 cmd 的命令回显（提示符与命令输出都还在，实测三种参数组合确认），
 * 于是回显由我们统一负责，cmd / bash 两条路行为一致。`/d`（禁 AutoRun）
 * **不传**：用户 AutoRun 里设的环境变量是他们的环境，不该被我们悄悄关掉。
 *
 * **PTY 版不受这个影响**：ConPTY 的回显是真的终端回显，`/q` 只对管道版必要。
 * 但两个通道用同一个 pickShell()，多带一个 `/q` 在 PTY 下无害（PTY 里的 cmd
 * 一样认这个参数），所以不分开写 —— 少一处会分叉的真相。
 */
export function pickShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: 'cmd.exe', args: ['/q'] };
  return { command: '/bin/bash', args: [] };
}

/* ── node-pty 懒加载 ─────────────────────────────────────────────────────── */

type NodePty = typeof import('node-pty');

let ptyModule: NodePty | null | undefined;

/**
 * 强制走管道版的开关：`OPC_TERMINAL_NO_PTY=1`。
 *
 * 为什么值得留一个「主动变笨」的开关：PTY 成了默认通道之后，管道版就只剩
 * 「node-pty 加载失败」这一条路能到达 —— 而那条路恰恰是**最难复现**的
 * （.node 损坏、被杀毒软件拦、asarUnpack 漏配）。没有开关，管道版就是一个
 * 「写好了但再也跑不到」的分支：A80 那套断言（cwd / 单实例 / 生命周期 /
 * 无双重回显）会永远空转，真出问题时也没有任何测试能发现。
 *
 * 只在启动时读一次，与 `OPC_SAFE_GRAPHICS` 同一类用法。
 */
function ptyDisabledByEnv(): boolean {
  return process.env.OPC_TERMINAL_NO_PTY === '1';
}

function loadPty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  if (ptyDisabledByEnv()) {
    console.warn('[Terminal] OPC_TERMINAL_NO_PTY=1 —— 按要求走管道版');
    ptyModule = null;
    return ptyModule;
  }
  try {
    // 产物是 CJS（esbuild bundle），require 原样保留，运行时从
    // app.asar.unpacked/node_modules/node-pty 解析（见 electron-builder.yml
    // 的 asarUnpack —— 原生 .node 与它要 spawn 的 exe 都不能留在 asar 里）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require('node-pty') as NodePty;
  } catch (e) {
    console.warn(`[Terminal] node-pty 加载失败，降级为管道版：${(e as Error).message}`);
    ptyModule = null;
  }
  return ptyModule;
}

export class TerminalSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pty: import('node-pty').IPty | null = null;
  private state: TerminalState = { ...IDLE };
  /**
   * 代次计数（A86）。
   *
   * ## 为什么必须有它
   *
   * `start()` 先 `kill()` 旧 shell 再起新的，但**旧进程的退出事件是异步的**，
   * 而 `kill()` 只把 `this.pty` / `this.child` 置 null —— 摘不掉已经注册的
   * `onExit` / `on('close')` 回调。旧进程真正退出的那一刻，回调落在**新** shell
   * 上：`finish()` 把 `running` 改成 false、`exitCode` 写成旧进程的退出码，
   * 并把 `this.pty` 置空 —— 新 shell 变成孤儿进程，之后的输入全部落空。
   *
   * 用户看到的就是「点一下重启，终端就死了」，而且报的还是上一个进程的退出码。
   * 实测：`start()` → `{ok:true}`，1.5s 后 `{running:false, exitCode:-1073741510}`。
   *
   * 修法是给每次启动一个代次：回调里比对，不是当前代次的直接丢弃。
   * 这样不必依赖「回调能不能被注销」（node-pty 的 onExit 返回值在各版本行为不一）。
   */
  private generation = 0;
  private tail = '';
  private dataListeners = new Set<(chunk: string) => void>();
  private stateListeners = new Set<(s: TerminalState) => void>();

  /**
   * 启动（或重启）shell。优先 PTY，加载不了就退到管道版。
   *
   * @returns 失败时返回一句人话 —— 调用方（前端）要能显示「为什么没起来」，
   *          而不是看到一个点了没反应的按钮。
   */
  start(cwd: string): { ok: true } | { ok: false; error: string } {
    if (typeof cwd !== 'string' || !cwd) {
      return { ok: false, error: '没有指定工作目录' };
    }
    // 只接受绝对路径：相对路径会按**主进程**的 cwd 解析，那多半是应用的
    // 安装目录，用户以为在自己的项目里敲命令，其实在 resources 里。
    if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(cwd)) {
      return { ok: false, error: '工作目录必须是绝对路径' };
    }
    try {
      if (!statSync(cwd).isDirectory()) {
        return { ok: false, error: `工作目录不存在或不是目录：${cwd}` };
      }
    } catch {
      return { ok: false, error: `工作目录不存在或不是目录：${cwd}` };
    }

    // 先杀旧的：两个 shell 交错输出，用户分不清哪行是谁打的
    this.kill();

    // 杀掉之后立刻换代：旧进程的退出回调随后到达时会被这条代次挡住
    const gen = ++this.generation;

    const pty = loadPty();
    if (pty) return this.startPty(pty, cwd, gen);
    return this.startPipe(cwd, gen);
  }

  private startPty(
    pty: NodePty,
    cwd: string,
    gen: number
  ): { ok: true } | { ok: false; error: string } {
    const { command, args } = pickShell();
    let proc: import('node-pty').IPty;
    try {
      proc = pty.spawn(command, args, {
        // 'xterm-color' 让程序知道可以发颜色；不设的话很多 CLI 会退成单色
        name: 'xterm-color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: { ...process.env, PROMPT: '$S' },
        // Windows 10+ 上 ConPTY 是默认；显式写出来，换平台时不靠隐式判断
        useConpty: process.platform === 'win32' ? true : undefined,
      });
    } catch (e) {
      // PTY 起不来（比如 ConPTY 被安全软件拦）就退管道版，别让标签点不动
      console.warn(`[Terminal] PTY 启动失败，降级为管道版：${(e as Error).message}`);
      return this.startPipe(cwd, gen);
    }

    this.pty = proc;
    this.child = null;
    this.tail = '';
    this.state = {
      running: true,
      cwd,
      shell: command,
      exitCode: null,
      pty: true,
      cols: proc.cols || DEFAULT_COLS,
      rows: proc.rows || DEFAULT_ROWS,
    };
    this.pushState();

    proc.onData(data => {
      // 上一代的残留输出不能混进新会话的 tail
      if (gen !== this.generation) return;
      // 类型上 data 是 string（没设 encoding，默认 utf8）；运行时仍可能是
      // Buffer（升级 node-pty 或改了 encoding 时），所以不直接信类型。
      const text = typeof data === 'string' ? data : String(data);
      this.tail = (this.tail + text).slice(-OUTPUT_TAIL_BYTES);
      for (const cb of this.dataListeners) cb(text);
    });
    // 代次比对：旧进程的退出事件晚于新进程启动时，绝不能打到新进程头上
    proc.onExit(({ exitCode }) => {
      if (gen !== this.generation) return;
      this.finish(typeof exitCode === 'number' ? exitCode : null);
    });

    // 开场白：说清楚这是什么、在哪跑。没有它，用户面对一个空面板不知道
    // 该不该输入，也不确定 cwd 对不对。
    this.emit(`\x1b[2m[终端] PTY · ${command} · cwd=${cwd}\x1b[0m\r\n`);
    return { ok: true };
  }

  private startPipe(cwd: string, gen: number): { ok: true } | { ok: false; error: string } {
    // args 必须真的传下去：pickShell() 算了半天，spawn 收一个 [] 就全废了
    //（这个 bug 在 A80 首发版里真实存在过 —— cmd 因此一直在双重回显）
    const { command, args } = pickShell();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows 上不弹控制台窗口（会闪一下黑框，像出了 bug）
        windowsHide: true,
        // cmd 每次读命令前都会把自己的提示符（`C:\路径>`）写到 stdout，且**不带
        // 换行** —— 于是它和紧随的命令输出粘成一行：`C:\...>PKG-23168`，
        // 看着像 shell 串行了。提示符由渲染进程的自回显负责显示，cmd 这边压成
        // 一个空格即可（实测 PROMPT='' 会回退默认值，$S 才有效）。
        // 只影响这个子进程的环境，不动用户自己终端的 PROMPT。
        env: { ...process.env, PROMPT: '$S' },
      });
    } catch (e) {
      return { ok: false, error: `启动 ${command} 失败：${e instanceof Error ? e.message : String(e)}` };
    }

    this.child = child;
    this.pty = null;
    this.tail = '';
    this.state = {
      running: true,
      cwd,
      shell: command,
      exitCode: null,
      pty: false,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
    this.pushState();

    const onChunk = (chunk: Buffer | string) => {
      if (gen !== this.generation) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.tail = (this.tail + text).slice(-OUTPUT_TAIL_BYTES);
      for (const cb of this.dataListeners) cb(text);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', err => {
      if (gen !== this.generation) return;
      this.emit(`\r\n[终端] 进程出错：${err.message}\r\n`);
      this.finish(null);
    });

    child.on('close', code => {
      // 同 PTY：旧进程的 close 不能把新 shell 打成已退出
      if (gen !== this.generation) return;
      this.finish(typeof code === 'number' ? code : null);
    });

    this.emit(`[终端] ${command} · cwd=${cwd}\r\n[终端] 管道版：无 TTY —— vim / top / 交互式提示不可用\r\n\r\n`);
    return { ok: true };
  }

  /**
   * 送输入进去。
   *
   * - **PTY**：`data` 是**原始键流**（含方向键转义、Ctrl+C 的 `\x03`、回车 `\r`），
   *   原样写给 pty —— 终端语义（回显、行编辑、信号）全在 ConPTY 那边。
   * - **管道版**：`data` 是一整行命令文本，补 `\r\n` 写进 stdin。
   *
   * 两个模式共用一条 IPC，由这里分派：渲染进程按 `state.pty` 决定送什么。
   */
  write(data: string): void {
    if (this.pty) {
      try {
        this.pty.write(data);
      } catch {
        /* shell 刚退出的瞬间写会抛：那时输出已经到了，不必再报一次错 */
      }
      return;
    }
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${data}\r\n`);
    } catch {
      /* 同上 */
    }
  }

  /** 改终端尺寸。只有 PTY 在意这个 —— 管道版没有窗口可言。 */
  resize(cols: number, rows: number): void {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    if (this.state.cols === c && this.state.rows === r) return;
    this.state = { ...this.state, cols: c, rows: r };
    this.pushState();
    if (!this.pty) return;
    try {
      this.pty.resize(c, r);
    } catch {
      /* shell 退了就白 resize 一次，无所谓 */
    }
  }

  /** 结束 shell。重复调用是安全的。 */
  kill(): void {
    const pty = this.pty;
    const child = this.child;
    this.pty = null;
    this.child = null;
    if (pty) {
      try {
        pty.kill();
      } catch {
        /* 已经退了 */
      }
      return;
    }
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* 已经关了 */
    }
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }

  getState(): TerminalState {
    return this.state;
  }

  /** 输出历史（晚来的订阅者先把这段读回去，再收增量）。 */
  getOutput(): string {
    return this.tail;
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onState(cb: (s: TerminalState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private emit(text: string): void {
    this.tail = (this.tail + text).slice(-OUTPUT_TAIL_BYTES);
    for (const cb of this.dataListeners) cb(text);
  }

  private finish(code: number | null): void {
    if (!this.child && !this.pty) return;
    this.child = null;
    this.pty = null;
    this.state = { ...this.state, running: false, exitCode: code };
    this.pushState();
    this.emit(`\r\n[终端] 已退出${code === null ? '' : `（code ${code}）`}\r\n`);
  }

  private pushState(): void {
    const snapshot = this.state;
    for (const cb of this.stateListeners) cb(snapshot);
  }
}

export const terminal = new TerminalSession();
