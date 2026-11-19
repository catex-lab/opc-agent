/**
 * Harness 子进程管理器（M01 / 绞杀者第 1 期，设计 §10.1 方案 A）。
 *
 * main 进程里唯一持有 harness 子进程的地方：拉起、握手、看门狗重启、
 * 优雅停止、token 生命周期。Electron 主进程只管窗口与更新 —— server
 * 的生死在这里，不在主进程体内。
 *
 * 进程树（目标形状）：
 *   electron(main) ──spawn(ELECTRON_RUN_AS_NODE=1)──▶ harness.cjs
 *        └─ IPC 通道（stdio[3]）── 父死亡 / 主动断开 → harness 收口退出
 *   harness ──HTTP 127.0.0.1:<port> + x-opc-token──▶ 渲染端
 *
 * 看门狗口径（S3 实测结论）：非主动停止的 exit → 退避重启
 * （100/200/300ms，最多 3 次，成功运行 60s 后计数归零）；3 次仍起不来
 * 就报 gave-up 让 main 弹窗，绝不无限重启。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  HANDSHAKE_PREFIX,
  HANDSHAKE_TIMEOUT_MS,
  OPC_HARNESS_ENV,
  OPC_LOCAL_TOKEN_ENV,
  OPC_STDIN_PIPE_ENV,
  type HarnessHandshake,
  type HarnessUiEvent,
} from '../shared/harness-protocol.js';
import { generateToken, removeTokenFile, writeTokenFile } from '../harness/token.js';
import { dataDirPath } from '../server/paths.js';

const RESTART_DELAYS_MS = [100, 200, 300];
const STABLE_UPTIME_MS = 60_000;
const GRACEFUL_STOP_MS = 5_000;

export type HarnessState = 'starting' | 'running' | 'restarting' | 'stopped' | 'gave-up';

interface StartOpts {
  /** 首选端口（0 = 系统分配）。重启优先复用上一代端口，origin 不变则窗口免 reload */
  port: number;
  /** 环境变量透传底座（OPC_DATA_DIR 等已由 bootstrap 设好，这里只需继承） */
  extraEnv?: Record<string, string>;
}

/** 三级解析 harness 入口（照 server/kb/tool.ts resolveKbMcpLaunch 的先例） */
function resolveHarnessEntry(): { command: string; args: string[]; env: Record<string, string> } {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const unpacked = resources
    ? path.join(resources, 'app.asar.unpacked', 'dist-electron', 'harness.cjs')
    : null;
  if (unpacked && existsSync(unpacked)) {
    return { command: process.execPath, args: [unpacked], env: {} };
  }
  const built = path.join(process.cwd(), 'dist-electron', 'harness.cjs');
  if (existsSync(built)) {
    return { command: process.execPath, args: [built], env: {} };
  }
  // 开发态未构建：源码 + tsx（devDependency，打包态不会走到这里）
  const source = path.join(process.cwd(), 'harness', 'index.ts');
  return { command: process.execPath, args: ['--import', 'tsx', source], env: {} };
}

class HarnessManager {
  private child: ChildProcess | null = null;
  private state: HarnessState = 'stopped';
  private port: number | null = null;
  private token: string | null = null;
  /** 当前 child 是第几次尝试（看门狗计数，稳定运行后归零） */
  private restartAttempt = 0;
  private runningSince = 0;
  /** 当前 child 是否真正就绪过（没就绪就崩 = 启动期故障，计数器照常累加） */
  private wasReady = false;
  private stopping = false;
  private quitRequested = false;
  private uiSink: ((ev: HarnessUiEvent) => void) | null = null;
  /** 在途的 start：顶层拉起与 resolveAppUrl 等待会指向同一份，不重复 spawn */
  private activeStart: Promise<number> | null = null;
  /** 等握手的外部 resolve（startHarness 的 promise） */
  private handshakeWaiters: Array<{ resolve: (port: number) => void; reject: (e: Error) => void }> = [];

  onUiEvent(sink: ((ev: HarnessUiEvent) => void) | null): void {
    this.uiSink = sink;
  }

  getState(): HarnessState {
    return this.state;
  }

  getOrigin(): string | null {
    return this.port == null ? null : `http://127.0.0.1:${this.port}`;
  }

  getToken(): string | null {
    return this.token;
  }

  /** 拉起（或重启）harness，等握手行拿到真实端口 */
  start(opts: StartOpts): Promise<number> {
    if (process.env[OPC_HARNESS_ENV] === '0') {
      return Promise.reject(new Error('OPC_HARNESS=0 —— harness 进程壳已关闭'));
    }
    // 在途去重：顶层拉起与 resolveAppUrl 会先后调 start，同一代进程只 spawn 一次
    if (this.activeStart) return this.activeStart;
    this.stopping = false;
    this.wasReady = false;
    this.state = this.restartAttempt > 0 ? 'restarting' : 'starting';

    // 每次拉起都换新 token：旧一代进程即使残留也拿不到新流量。
    // token 经 env 传给 harness；0600 文件是审计镜像（谁、何时、哪个 pid）。
    this.token = generateToken();

    const launch = resolveHarnessEntry();
    const child = spawn(launch.command, launch.args, {
      // Electron 二进制以 Node 模式跑 harness.cjs（照 kb-mcp 先例）；
      // 普通进程里该变量无副作用
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        [OPC_LOCAL_TOKEN_ENV]: this.token,
        // 声明「stdin 是本进程握着的管道」→ harness 挂 stdin 关闭监听，
        // 与 IPC disconnect 双保险（父死亡两条路都会触发收口）
        [OPC_STDIN_PIPE_ENV]: '1',
        // token 只经 env 传递，绝不进 argv（§7.5：不进命令行/日志）
        PORT: String(opts.port),
        ...launch.env,
        ...opts.extraEnv,
      },
      // stdio[3] = IPC 通道：父死亡 → 子端 'disconnect' → shutdown 收口
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    writeTokenFile(dataDirPath, {
      token: this.token,
      pid: child.pid ?? 0,
      startedAt: new Date().toISOString(),
    });

    let stdoutBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        this.onChildLine(line);
      }
    });
    // stderr 只透传，不参与协议
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[Harness] ${chunk}`);
    });

    child.once('exit', (code, signal) => this.onChildExit(code, signal, opts));

    // 握手超时：走 exit 路径（杀掉重来）比干等更诚实
    const timeout = setTimeout(() => {
      if (this.child === child && this.state !== 'running') {
        console.error('[Harness] 握手超时（30s），杀掉重启');
        this.forceKill(child);
      }
    }, HANDSHAKE_TIMEOUT_MS);
    timeout.unref?.();

    const promise = new Promise<number>((resolve, reject) => {
      this.handshakeWaiters.push({ resolve, reject });
      setTimeout(() => {
        const i = this.handshakeWaiters.findIndex(w => w.resolve === resolve);
        if (i >= 0) {
          this.handshakeWaiters.splice(i, 1);
          reject(new Error(`harness 握手超时（${HANDSHAKE_TIMEOUT_MS}ms）`));
        }
      }, HANDSHAKE_TIMEOUT_MS).unref?.();
    }).finally(() => {
      // 成败都清掉在途标记：失败由 exit→看门狗接手，成功后同代不再 spawn
      this.activeStart = null;
    });
    this.activeStart = promise;
    return promise;
  }

  private onChildLine(line: string): void {
    if (!line.startsWith(HANDSHAKE_PREFIX)) {
      // 非握手行透传到主进程日志：harness 里 server 的横幅与日志保持可见
      console.log(`[Harness] ${line}`);
      return;
    }
    try {
      const payload = JSON.parse(line.slice(HANDSHAKE_PREFIX.length)) as HarnessHandshake;
      if (payload.type === 'ready') {
        const resumed = this.state === 'restarting';
        this.port = payload.port;
        this.state = 'running';
        this.wasReady = true;
        this.runningSince = Date.now();
        this.restartAttempt = 0;
        console.log(`[Harness] 就绪：127.0.0.1:${payload.port}（pid ${payload.pid}）`);
        if (resumed) this.uiSink?.({ type: 'recovered', port: payload.port });
        for (const w of this.handshakeWaiters.splice(0)) w.resolve(payload.port);
      }
    } catch (err) {
      console.error('[Harness] 握手行解析失败:', (err as Error).message);
    }
  }

  private onChildExit(code: number | null, signal: string | null, opts: StartOpts): void {
    this.child = null;
    if (this.quitRequested || this.stopping) {
      this.state = 'stopped';
      return;
    }
    console.error(`[Harness] 异常退出（code=${code} signal=${signal ?? '-'}），看门狗接手`);
    this.port = null;

    // 稳定跑了一段时间后的退出算新一轮故障，从头计数；
    // 没就绪过就崩的启动期故障不算「稳定」——计数器照常累加直到 gave-up
    if (this.wasReady && Date.now() - this.runningSince > STABLE_UPTIME_MS) {
      this.restartAttempt = 0;
    }
    if (this.restartAttempt >= RESTART_DELAYS_MS.length) {
      this.state = 'gave-up';
      this.uiSink?.({ type: 'gave-up' });
      return;
    }
    const delay = RESTART_DELAYS_MS[this.restartAttempt];
    this.restartAttempt += 1;
    this.state = 'restarting';
    this.uiSink?.({ type: 'restarting' });

    setTimeout(() => {
      if (this.quitRequested || this.stopping) return;
      // 重启优先复用上一代端口：origin 不变，窗口不用 reload
      this.start({ ...opts, port: opts.port || this.port || opts.port }).catch(err => {
        console.error('[Harness] 重启失败:', (err as Error).message);
      });
    }, delay).unref?.();
  }

  private forceKill(child: ChildProcess): void {
    try {
      child.kill();
    } catch {
      // 已经死了就算了
    }
  }

  /**
   * 优雅停止：先断 IPC 通道（harness 收到 disconnect → shutdown → 自行
   * 清理 agent 子进程），有界等待后升级 `taskkill /T /F`（S3 实测的
   * Windows 专线）。只承诺尽力而为 —— main 退出不等它，进程生命周期
   * 由 harness 自己收口。
   */
  stop(): void {
    if (this.quitRequested) return;
    this.quitRequested = true;
    this.stopping = true;
    const child = this.child;
    removeTokenFile(dataDirPath);
    if (!child) return;

    const pid = child.pid;
    try {
      if (child.connected) child.disconnect();
    } catch {
      // 通道可能已经断了
    }
    const deadline = Date.now() + GRACEFUL_STOP_MS;
    const poll = setInterval(() => {
      if (!this.child || this.child !== child) {
        clearInterval(poll);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        console.warn('[Harness] 优雅停止超时，升级 taskkill /T /F');
        if (pid) {
          try {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            this.forceKill(child);
          }
        }
      }
    }, 250);
    poll.unref?.();
  }
}

export const harnessManager = new HarnessManager();
