/**
 * 验证命令执行器（A97）。
 *
 * ## 与终端面板的区别
 *
 * `electron/terminal.ts` 是给**人**用的 PTY（vim/top 能跑）；这里是给
 * **验证流程**用的非交互执行：没有 TTY、没有输入、必须自己退出。
 * 两者不能合并 —— PTY 的输出带控制字符，塞进报告里没法读。
 *
 * ## 三个必须做对的细节
 *
 * 1. **Windows 上必须杀进程树**。`npm run test` 会拉起 node 子进程，
 *    只 kill 父进程的话子进程还在跑，端口被占、文件被锁，用户下次跑直接失败。
 *    这里用 `taskkill /T /F` 按 pid 杀整棵树。
 * 2. **输出要限长但不能只留头部**。测试失败的信息几乎总在**末尾**，
 *    只截前 N 字节等于把最有用的部分扔掉。这里保留「头 8KB + 尾 56KB」。
 * 3. **shell 必须开**。`npm run test` / `make test` 都依赖 shell 解析，
 *    直接 spawn 可执行文件在 Windows 上找不到 npm.cmd。
 */

import { spawn, type ChildProcess } from 'node:child_process';

export type VerifyStatus = 'pass' | 'fail' | 'timeout' | 'error';

export interface VerifyRunResult {
  commandId: string;
  command: string;
  status: VerifyStatus;
  /** 进程退出码；超时/启动失败时为 null */
  exitCode: number | null;
  durationMs: number;
  /** 合并后的 stdout + stderr */
  output: string;
  /** 输出被截断过 */
  truncated: boolean;
  /** 失败时给用户的一句人话 */
  hint?: string;
}

/** 输出总上限 */
const MAX_OUTPUT = 64 * 1024;
/** 截断时保留的头部长度（其余给尾部） */
const HEAD_KEEP = 8 * 1024;
/** 默认超时：5 分钟。够跑完一次完整测试，又不至于让界面一直转 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** 保留头尾、中间省略 */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  const head = text.slice(0, HEAD_KEEP);
  const tail = text.slice(text.length - (MAX_OUTPUT - HEAD_KEEP));
  const omitted = text.length - MAX_OUTPUT;
  return {
    text: `${head}\n\n…（中间省略 ${omitted} 字符）…\n\n${tail}`,
    truncated: true,
  };
}

/** 杀整棵进程树。Windows 用 taskkill /T，其余平台用进程组。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    // 杀不掉也不能让验证流程崩：至少把父进程结束掉
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

export interface RunOptions {
  commandId: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
  /** 用户取消 */
  signal?: AbortSignal;
  /** 增量输出（SSE 推给前端） */
  onChunk?: (chunk: string) => void;
}

/**
 * 执行一条验证命令。**永不抛错** —— 所有失败都变成 status。
 */
export function runVerifyCommand(opts: RunOptions): Promise<VerifyRunResult> {
  const { commandId, command, cwd, signal, onChunk } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const chunks: string[] = [];

    // 先声明后赋值：finish() 在 spawn 同步抛错时会被提前调用，那时 timer
    // 还没赋值。写成 `const timer = ...` 在 finish 后面，就会在 clearTimeout
    // 处踩 TDZ 抛 ReferenceError —— 而本函数的契约是「永不抛错」。
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (status: VerifyStatus, exitCode: number | null, hint?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const raw = chunks.join('');
      const { text, truncated } = clip(raw);
      resolve({
        commandId,
        command,
        status,
        exitCode,
        durationMs: Date.now() - startedAt,
        output: text,
        truncated,
        hint,
      });
    };

    // 传进来的 signal 可能**已经**是 aborted：AbortSignal 不会给后注册的
    // 监听器补发事件，只靠 addEventListener 会漏掉这种情况，命令照跑到底。
    if (signal?.aborted) {
      finish('error', null, '用户已取消');
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: {
          ...process.env,
          // 关掉颜色控制字符：报告要给人读，ANSI 码只会变成乱码
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          CI: '1',
        },
      });
    } catch (err) {
      finish('error', null, `启动失败：${(err as Error).message}`);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 给 taskkill 一点时间，随后强制收尾（避免子进程把 promise 吊住）
      setTimeout(() => finish('timeout', null, `超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`), 800);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree(child);
      setTimeout(() => finish('error', null, '用户已取消'), 800);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const push = (buf: Buffer) => {
      const text = buf.toString('utf8');
      // 内存保护：已经超上限就不再累积（否则日志刷屏会把进程吃爆）
      if (chunks.reduce((n, c) => n + c.length, 0) < MAX_OUTPUT * 2) chunks.push(text);
      onChunk?.(text);
    };

    child.stdout?.on('data', push);
    child.stderr?.on('data', push);

    child.on('error', err => {
      signal?.removeEventListener('abort', onAbort);
      finish('error', null, `无法执行：${err.message}`);
    });

    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (timedOut || aborted) return; // 已由上面的收尾逻辑处理
      const exitCode = typeof code === 'number' ? code : null;
      if (exitCode === 0) finish('pass', 0);
      else finish('fail', exitCode, exitCode == null ? '进程被信号终止' : `退出码 ${exitCode}`);
    });
  });
}
