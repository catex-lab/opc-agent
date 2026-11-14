/**
 * 登录代管的进程编排（P2，接入架构收敛方案）。
 *
 * ## 它做什么 / 不做什么
 *
 * 做：把**厂商自己的登录命令**拉起在一个用户可见的会话里（PTY 优先，管道
 * 兜底），输出流给界面；进程退出后**自动跑一次 canary 复检**——绿了名册
 * 自己点亮，失败给出诊断分类。全程不解析、不代存任何凭据。
 *
 * 不做：不碰 `~/.<agent>/`、不替用户点浏览器、不在输出里找「是否成功」
 * （成功与否由 canary 说了算，输出只是给人看的）。
 *
 * ## 两个通道
 *
 * 与工作区终端（electron/terminal.ts）同一套取舍：PTY 优先（交互式菜单、
 * 密码输入需要 TTY），node-pty 加载失败降级管道版（交互式菜单不可用，
 * 界面会如实标注）。在 server 进程里直接 import node-pty——它是 N-API
 * 模块，Node/Electron 双 ABI 可用（terminal.ts 顶部已实测论证）。
 *
 * ## 全局单会话
 *
 * 桌面单用户：同一时刻只跑一个登录会话；再点「打开登录」先杀旧的。
 * 登录进程不绑定窗口生命周期——用户关掉对话框=停止登录（明确动作），
 * 不做「后台继续登录」的隐式行为。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { findDef } from './definitions.js';
import { runCanary } from './canary.js';

const OUTPUT_TAIL_BYTES = 64 * 1024;

export interface LoginRunnerState {
  agentId: string | null;
  running: boolean;
  /** true = node-pty（真终端）；false = 管道版（交互菜单不可用，界面如实标注） */
  pty: boolean;
  startedAt: string | null;
  exitCode: number | null;
  /** 输出尾巴（64KB），晚来的订阅者/轮询者读它 */
  output: string;
}

let current: {
  agentId: string;
  kind: 'pty' | 'pipe';
  // pty 进程与管道子进程的并集操作面
  write(data: string): void;
  kill(): void;
} | null = null;

const listeners = new Set<(chunk: string) => void>();
let outputTail = '';
let state: LoginRunnerState = {
  agentId: null,
  running: false,
  pty: false,
  startedAt: null,
  exitCode: null,
  output: '',
};

function pushOutput(text: string): void {
  outputTail = (outputTail + text).slice(-OUTPUT_TAIL_BYTES);
  state = { ...state, output: outputTail };
  for (const cb of listeners) cb(text);
}

function setState(patch: Partial<LoginRunnerState>): void {
  state = { ...state, ...patch };
}

export function getLoginState(): LoginRunnerState {
  return state;
}

export function subscribeLoginOutput(cb: (chunk: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function writeLogin(data: string): void {
  current?.write(data);
}

export function stopLogin(): void {
  current?.kill();
}

/**
 * 拉起某 Agent 的登录命令。def.login 不存在 = 没有已核实的命令，拒绝。
 * 返回 false = 已有会话在跑且就是同一个 Agent（幂等）。
 */
export function startLogin(agentId: string): { started: boolean; pty: boolean } | { error: string } {
  const def = findDef(agentId);
  if (!def?.login) {
    return { error: '该 Agent 没有已核实的登录命令（login 表未收录）' };
  }
  if (current && state.agentId === agentId && state.running) {
    return { started: false, pty: state.pty };
  }
  if (current) stopLogin();

  const { command, args = [] } = def.login;
  outputTail = '';
  setState({
    agentId,
    running: true,
    startedAt: new Date().toISOString(),
    exitCode: null,
    output: '',
  });

  const onExit = (code: number | null) => {
    setState({ running: false, exitCode: code });
    pushOutput(`\r\n[进程已退出（退出码 ${code ?? '未知'}），正在自动复检…]\r\n`);
    // 复检闭环：登录完成（无论成败）立刻跑 canary，名册自己更新
    void runCanary(agentId)
      .then(d => pushOutput(`[复检结论：${d.class}${d.detail ? `（${d.detail.slice(0, 80)}）` : ''}]\r\n`))
      .catch(() => pushOutput('[复检失败：请手动点「真实检测」]\r\n'));
    current = null;
  };

  // PTY 优先
  try {
    // 动态 require：node-pty 是原生模块，加载失败走管道兜底（terminal.ts 同款取舍）。
    // 用 createRequire 而不是静态 import：node-pty 无 ESM 入口；它是 N-API 模块，
    // Node/Electron 双 ABI 可用（terminal.ts 顶部已实测论证）。
    const require2 = createRequire(import.meta.url);
    const pty = require2('node-pty') as {
      spawn(file: string, args: string[], opts: Record<string, unknown>): {
        onData(cb: (chunk: string) => void): void;
        onExit(cb: (e: { exitCode: number }) => void): void;
        write(data: string): void;
        kill(): void;
      };
    };
    const proc = pty.spawn(command, args, {
      name: 'xterm',
      cols: 100,
      rows: 30,
      cwd: os.tmpdir(),
      env: process.env as Record<string, string>,
    });
    proc.onData(chunk => pushOutput(typeof chunk === 'string' ? chunk : String(chunk)));
    proc.onExit(e => onExit(e.exitCode));
    current = {
      agentId,
      kind: 'pty',
      write: d => proc.write(d),
      kill: () => proc.kill(),
    };
    setState({ pty: true });
    return { started: true, pty: true };
  } catch {
    /* 落到管道版 */
  }

  // 管道兜底：交互式菜单不可用（如实标注），但「打印 URL → 回车」类流程可用
  try {
    const child: ChildProcess = spawn(command, args, {
      cwd: os.tmpdir(),
      shell: false,
      windowsHide: false, // 登录要看输出，允许弹独立控制台（PTY 失败时的可见性兜底）
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => pushOutput(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => pushOutput(d.toString('utf8')));
    child.on('error', (err: Error) => {
      pushOutput(`\r\n[拉起失败：${err.message}]\r\n`);
      onExit(-1);
    });
    child.on('close', code => onExit(code ?? -1));
    current = {
      agentId,
      kind: 'pipe',
      write: d => child.stdin?.write(d),
      kill: () => child.kill(),
    };
    setState({ pty: false });
    return { started: true, pty: false };
  } catch (err) {
    setState({ running: false, exitCode: -1 });
    pushOutput(`[拉起失败：${(err as Error).message}]\r\n`);
    current = null;
    return { started: false, pty: false };
  }
}
