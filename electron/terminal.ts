/**
 * P4：右侧工作区面板的「终端」标签 —— **管道版**。
 *
 * ## 为什么先做管道版，而不是直接上 PTY
 *
 * 完整终端要 `node-pty`：一个原生模块，Windows 上要装 Visual Studio 生成工具、
 * 要跟着 Electron 的 ABI 重新编译、升级 Electron 就得重编一遍。而在「用户到底
 * 要不要在面板里敲命令」这个问题有答案之前，那笔成本是不该付的。
 *
 * 管道版用 `child_process.spawn` 起一个**持久的 shell**（Windows 上是 cmd.exe，
 * 其他平台是 bash），stdin/stdout 全是管道。它能覆盖大多数真实用法：
 * `git status`、`npm run build`、`ls`、`cat`、跑测试。而且 cmd/bash 自己记得
 * cwd，所以 `cd` 在同一个会话里是连续的。
 *
 * ## 它不能做什么（必须在界面上说清楚）
 *
 * 没有 PTY 就没有终端语义：交互式程序（vim、top、less、带 Y/n 提示的安装器）
 * 拿不到 TTY，行为不可预期；也没有窗口尺寸、没有光标寻址、没有颜色协商。
 * 所以 UI 上常驻一句「管道版：无 TTY」。**不摆一个看起来像终端、实际跑不了
 * vim 的东西还不说** —— 那正是本项目一直在防的假控件。
 *
 * ## 三条边界
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

export interface TerminalState {
  running: boolean;
  cwd: string | null;
  /** 实际选中的 shell（cmd.exe / /bin/bash），给界面显示用 */
  shell: string;
  /** 进程退出码。null = 还在跑 / 没启动过 */
  exitCode: number | null;
  /** 恒为 false：这一版没有 PTY。留着这个字段是为了让界面能据此说话，
   *  而不是靠「我记得这版没有」这种会在下次改动时过期的注释。 */
  pty: false;
}

const IDLE: TerminalState = {
  running: false,
  cwd: null,
  shell: '',
  exitCode: null,
  pty: false,
};

/** 选 shell。Windows 用 cmd.exe（任何机器上都有），其余平台优先 bash。 */
export function pickShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: 'cmd.exe', args: [] };
  return { command: '/bin/bash', args: [] };
}

export class TerminalSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: TerminalState = { ...IDLE };
  private tail = '';
  private dataListeners = new Set<(chunk: string) => void>();
  private stateListeners = new Set<(s: TerminalState) => void>();

  /**
   * 启动（或重启）shell。
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

    const { command } = pickShell();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows 上不弹控制台窗口（会闪一下黑框，像出了 bug）
        windowsHide: true,
        env: process.env,
      });
    } catch (e) {
      return { ok: false, error: `启动 ${command} 失败：${e instanceof Error ? e.message : String(e)}` };
    }

    this.child = child;
    this.tail = '';
    this.state = { running: true, cwd, shell: command, exitCode: null, pty: false };
    this.pushState();

    const onChunk = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.tail = (this.tail + text).slice(-OUTPUT_TAIL_BYTES);
      for (const cb of this.dataListeners) cb(text);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', err => {
      this.emit(`\r\n[终端] 进程出错：${err.message}\r\n`);
      this.finish(null);
    });

    child.on('close', code => {
      this.finish(typeof code === 'number' ? code : null);
    });

    // 开场白：说清楚这是什么、在哪跑。没有它，用户面对一个空面板不知道
    // 该不该输入，也不确定 cwd 对不对。
    this.emit(`[终端] ${command} · cwd=${cwd}\r\n[终端] 管道版：无 TTY —— vim / top / 交互式提示不可用\r\n\r\n`);
    return { ok: true };
  }

  /** 送一行命令进去。shell 没起来就当没发生（界面上按钮是禁用的）。 */
  write(line: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${line}\r\n`);
    } catch {
      /* shell 刚退出的瞬间写会抛：那时输出已经到了，不必再报一次错 */
    }
  }

  /** 结束 shell。重复调用是安全的。 */
  kill(): void {
    const child = this.child;
    this.child = null;
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
    if (!this.child) return;
    this.child = null;
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
