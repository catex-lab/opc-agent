/**
 * P4：终端（管道版）的前端共享件。
 *
 * 与 `browserPanel.ts` / `workspace.ts` 同一个理由：这颗桥会被多个组件用，
 * 各写一份 `window.opc?.terminalStart(...)` 就会出现多份签名，改一次 preload
 * 要同步改多处，漏一处就是「打包态点了没反应」—— 而那在浏览器开发态看不出来。
 *
 * ## 浏览器开发态
 *
 * `window.opc` 整个是 undefined，于是 `hasTerminal()` 为 false，界面显示
 * 「只在桌面端可用」。**不摆一个输了命令没反应的输入框**。
 */

export interface TerminalState {
  running: boolean;
  cwd: string | null;
  shell: string;
  exitCode: number | null;
  /** 恒为 false：这一版没有 PTY，交互式程序不可用 */
  pty: false;
}

export interface TerminalStartResult {
  ok: boolean;
  error?: string;
}

interface OpcBridge {
  terminalStart?(cwd: string): Promise<TerminalStartResult>;
  terminalInput?(line: string): void;
  terminalKill?(): Promise<void>;
  terminalState?(): Promise<TerminalState>;
  terminalOutput?(): Promise<string>;
  onTerminalData?(cb: (chunk: string) => void): () => void;
  onTerminalState?(cb: (state: TerminalState) => void): () => void;
}

function bridge(): OpcBridge | undefined {
  return (window as unknown as { opc?: OpcBridge }).opc;
}

/** 当前环境有没有终端能力（即是否跑在 Electron 里）。 */
export function hasTerminal(): boolean {
  return typeof bridge()?.terminalStart === 'function';
}

/** 启动 shell。失败时返回人话，界面直接显示，不让用户猜。 */
export async function startTerminal(cwd: string): Promise<TerminalStartResult> {
  const fn = bridge()?.terminalStart;
  if (!fn) return { ok: false, error: '当前环境不支持终端' };
  try {
    return (await fn(cwd)) ?? { ok: false, error: '启动失败' };
  } catch {
    return { ok: false, error: '启动失败' };
  }
}

export function sendLine(line: string): void {
  try {
    bridge()?.terminalInput?.(line);
  } catch {
    /* shell 刚退出：主进程自己会判，这里不重复报错 */
  }
}

export async function killTerminal(): Promise<void> {
  try {
    await bridge()?.terminalKill?.();
  } catch {
    /* 已经没了 */
  }
}

export async function getTerminalState(): Promise<TerminalState | null> {
  const fn = bridge()?.terminalState;
  if (!fn) return null;
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

/** 输出历史（晚来的订阅者先把这段读回去，再收增量）。 */
export async function getTerminalOutput(): Promise<string> {
  const fn = bridge()?.terminalOutput;
  if (!fn) return '';
  try {
    return (await fn()) ?? '';
  } catch {
    return '';
  }
}

/** 订阅输出增量。返回取消订阅函数（React effect 清理用）。 */
export function subscribeTerminalData(cb: (chunk: string) => void): () => void {
  const fn = bridge()?.onTerminalData;
  if (!fn) return () => {};
  try {
    return fn(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}

/** 订阅状态变化（跑着没有 / 退出码）。 */
export function subscribeTerminalState(cb: (state: TerminalState) => void): () => void {
  const fn = bridge()?.onTerminalState;
  if (!fn) return () => {};
  try {
    return fn(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}
