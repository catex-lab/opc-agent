/**
 * CLI 适配器：把任意「命令行 Agent」包装成统一的 AgentEvent 流。
 *
 * 安全要点（这是本适配器最重要的设计约束）：
 *   用户输入（prompt）会原封不动地作为 argv 的一个元素传给子进程，
 *   **绝不经过 shell**。具体做法是先解析 npm 生成的 `.cmd` 垫片、
 *   拿到真实的 JS 入口，然后直接 `node <entry.js> ...args`。
 *   这样既绕开了 Windows 上 cmd.exe 的引号转义地狱，也从根上
 *   消除了命令注入（`; rm -rf` 之类只会被当成普通文本参数）。
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AsyncQueue, PendingReplies, linkAbort } from '../channel.js';
import { decideToolAccess } from '../toolPolicy.js';
import { evaluateToolCall } from '../permission-gate.js';
import { currentPermissionRules } from '../../permission-rules.js';
import type { AgentDefinition, CliSpec } from '../definitions.js';
import {
  findExecutable,
  resolveAnyLaunchTarget,
  isUnresolvedShim,
  isIdeLauncher,
  probeVersion,
  expandPath,
  shortcutInstallRoot,
  allHostsUnreachable,
  type LaunchTarget,
} from '../probe.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentStatus,
  AgentDescriptor,
  PermissionDecision,
  SendContext,
} from '../types.js';
import {
  buildStdinUserMessage,
  classifyControlMessage,
  buildControlResponse,
  buildControlError,
  buildInterruptRequest,
  type CanUseToolAsk,
  type ControlAsk,
} from './claude-control.js';

/** 去掉终端颜色 / 光标控制序列 */
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** 单次 CLI 调用的默认上限 */
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * A106：优雅中止的宽限窗（毫秒）。
 * 先 SIGTERM 让 CLI 自己收尾，宽限到头仍不退才 SIGKILL。
 */
const TERM_GRACE_MS = 3000;

/**
 * A106：双向模式下权限请求的等待上限。
 * 与 SdkAdapter 保持同值同语义（超时按拒绝计），前端提示文案也一致。
 */
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * A106：优雅终止子进程 —— 先 SIGTERM，宽限到头仍不退再 SIGKILL。
 *
 * 为什么抽成模块级函数：send() 的终止链、generator 的 finally 兜底、
 * abort() 三处都要用。曾经只有 send() 会 kill，abort() 是另一种死法 ——
 * 两份实现必然漂移，所以收成一处。
 *
 * timers 可注入是为了**不起真进程也能测**（见 scripts/verify-a106-*.ts）。
 *
 * ⚠️ Windows 现实（写下来避免以后误判「改了没生效」）：Node 在 Windows 上
 * 把 SIGTERM 也映射到 TerminateProcess，没有真正的优雅窗口 —— 这条只在
 * macOS/Linux 实际生效；Windows 上行为与直接 kill 一致，但升级计时器
 * 保证了不会留下退不掉的进程。
 *
 * @returns 取消升级的函数（进程自己退了就调它，省一次 SIGKILL）
 */
export function terminateGracefully(
  child: ChildProcess,
  graceMs: number,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
    setTimeout,
    clearTimeout,
  }
): () => void {
  if (child.killed) return () => {};
  try {
    child.kill('SIGTERM');
  } catch {
    /* 进程已死，忽略 */
  }
  const t = timers.setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退了，忽略 */
    }
  }, graceMs);
  t.unref?.();
  return () => timers.clearTimeout(t);
}

/** 判断输出里是否像「未登录 / 缺密钥」 */
const AUTH_HINT_RE =
  /(not logged in|please log ?in|login required|authentication required|unauthenticated|unauthorized|invalid api key|api key not|missing api key|no api key|401|403|credential)/i;

/**
 * 子进程环境。
 * 在宿主环境基础上关掉交互与颜色，避免 CLI 以为自己在 TTY 里等输入。
 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    TERM: 'dumb',
    // 部分 CLI 会因 stdin 非 TTY 而进入交互模式，显式关掉
    NODE_NO_WARNINGS: '1',
  };
}

/**
 * 子进程类型：stdio 固定为 ['ignore', 'pipe', 'pipe']，
 * 所以 stdin 是 null，而 stdout / stderr 一定存在 —— 用这个精确类型，
 * 就不必在每处 `child.stdout` 后面加 `!` 断言。
 */
type CliChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * A106：双向模式的子进程类型 —— stdin 是管道。
 * 与 CliChild 分开而不是统一成 pipe：一次性模式的 stdin 语义就是
 * 「立刻 EOF」，混在一起会让「该不该写 stdin」要靠运行时猜。
 */
type BidiChild = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * 给一条「映射器不认识的 JSONL 行」起个通道名（A111）。
 *
 * 为什么单独抽成导出函数：这段逻辑埋在 `handleJsonLine` 这个闭包里，
 * 而那个闭包只有在真起子进程、真吐 stdout 时才跑得到 —— 想验证它就得起
 * 一个假 CLI，代价远大于收益。抽成纯函数后，验证脚本能直接喂各种形状的行，
 * 断言「通道名有没有把关键信息带出来」。
 *
 * 取字段的顺序按各 CLI 的实测习惯排：`type` 最常见，`event` 次之
 * （stream_event 这类包了一层），`kind` 兜底。三个都没有就记 `unknown` ——
 * 至少能看出「有这么一条、但它连类型字段都没有」。
 */
export function cliRawChannel(obj: unknown): string {
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    for (const key of ['type', 'event', 'kind'] as const) {
      const v = rec[key];
      if (typeof v === 'string' && v) {
        // subtype 必须带上：`system` 底下有十几种，只报 type 等于没报
        const sub = rec.subtype ?? rec.subType;
        return typeof sub === 'string' && sub ? `${v}/${sub}` : v;
      }
    }
  }
  return Array.isArray(obj) ? 'array' : typeof obj;
}

export class CliAdapter implements AgentProvider {
  readonly descriptor: AgentDescriptor;

  private readonly def: AgentDefinition;
  private readonly spec: CliSpec;
  /** 已解析的启动目标（惰性、带缓存） */
  private target: LaunchTarget | null = null;
  /** 探测结果缓存 */
  private status: AgentStatus | null = null;
  /** 正在运行的子进程：sessionId → child */
  private running = new Map<string, CliChild | BidiChild>();
  /**
   * A106：双向模式下待答复的权限请求（requestId → 决定）。
   * 一次性模式不产生 permission_request 事件，这张表始终是空的。
   */
  private replies = new PendingReplies<PermissionDecision>();

  constructor(def: AgentDefinition) {
    if (!def.cli) throw new Error(`CliAdapter 需要 cli 规格: ${def.descriptor.id}`);
    this.def = def;
    this.descriptor = def.descriptor;
    this.spec = def.cli;
  }

  // ============= 可执行文件定位 =============

  /**
   * 全部搜索目录（A105）。
   *
   * 三部分拼起来：
   *   1. `extraPaths` —— 装在 PATH 之外的工具（Hermes 的 bin 等）
   *   2. `engineCandidates` 的所在目录 —— 引擎是 `.cjs`、且安装目录自选的
   *      Agent（ZCode 桌面版）。`{root}` 占位符先被快捷方式反推的安装根替换
   *   3. 快捷方式（开始菜单 / 桌面）反推的安装根 —— 安装目录由用户自选，
   *      没有任何环境变量记录它，这是唯一稳定的线索
   */
  private searchDirs(): string[] {
    const dirs = (this.def.extraPaths ?? []).map(expandPath);

    const root = (this.def.shortcutNames ?? [])
      .map(name => shortcutInstallRoot(name))
      .find((r): r is string => Boolean(r));

    for (const cand of this.def.engineCandidates ?? []) {
      const filled = root && cand.includes('{root}') ? cand.replace('{root}', root) : cand;
      dirs.push(path.dirname(expandPath(filled)));
    }
    return dirs;
  }

  /** 引擎候选文件展开后的完整路径（供「文件直接命中」兜底） */
  private engineFiles(): string[] {
    const root = (this.def.shortcutNames ?? [])
      .map(name => shortcutInstallRoot(name))
      .find((r): r is string => Boolean(r));
    return (this.def.engineCandidates ?? []).map(cand => {
      const filled = root && cand.includes('{root}') ? cand.replace('{root}', root) : cand;
      return path.resolve(expandPath(filled));
    });
  }

  /**
   * 定位可执行文件。
   *
   * 先按「命令名 + 扩展名」在 PATH / extraPaths / 引擎目录里找（常规形态），
   * 再兜底逐个检查引擎候选文件本身（目录在、但文件名与 bin 名不完全对应时）。
   */
  private findBin(): string | null {
    const hit = findExecutable(this.spec.bin, this.searchDirs(), this.spec.binExts ?? []);
    if (hit) return hit;
    for (const file of this.engineFiles()) {
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* 不存在就试下一个 */
      }
    }
    return null;
  }

  // ============= 探测 =============

  async probe(): Promise<AgentStatus> {
    const now = new Date().toISOString();

    if (this.def.unsupportedReason) {
      this.status = {
        availability: 'unsupported',
        installed: false,
        message: this.def.unsupportedReason,
        probedAt: now,
      };
      return this.status;
    }

    const binPath = this.findBin();
    if (!binPath) {
      const label = Array.isArray(this.spec.bin) ? this.spec.bin.join('` / `') : this.spec.bin;
      this.status = {
        availability: 'not-installed',
        installed: false,
        message: `PATH 中未找到命令 \`${label}\``,
        probedAt: now,
      };
      return this.status;
    }

    this.target = resolveAnyLaunchTarget(binPath);

    // 垫片解析失败：宁可标记不可用，也不退回 shell（会引入注入风险）
    if (isUnresolvedShim(this.target, binPath)) {
      this.status = {
        availability: 'unsupported',
        installed: true,
        binaryPath: binPath,
        message: '无法解析该命令的启动垫片，已跳过（不退回 shell 执行以保证安全）',
        probedAt: now,
      };
      return this.status;
    }

    // 目标文件存在但根本不是可执行程序（npm 占位脚本的典型症状）
    if (this.target.problem) {
      this.status = {
        availability: 'needs-setup',
        installed: true,
        binaryPath: binPath,
        message: `${this.target.problem}。${this.def.descriptor.installHint ?? ''}`.trim(),
        probedAt: now,
      };
      return this.status;
    }

    /**
     * A119：把 IDE 启动器当 agent CLI 的守卫 —— 判据与理由见 isIdeLauncher()。
     *
     * 必须在 `probeVersion` **之前**拦：这类目标能起来、也能正常吐出 IDE 的
     * 版本号，跑完版本探测只会得到「就绪」这个错误结论。等真发消息时才发现，
     * 代价是用户看着界面转圈 8 分钟、桌面上凭空多出一个 IDE 窗口。
     *
     * 状态给 `unsupported`（语义就是「本机形态无法无头调用」），而不是
     * not-installed —— 文件确实在，只是它不是我们要的东西；把它报成
     * 「未安装」会让用户去重装一个已经装好的程序。
     */
    if (isIdeLauncher(this.target)) {
      this.status = {
        availability: 'unsupported',
        installed: true,
        binaryPath: binPath,
        message:
          `找到的是 ${this.def.descriptor.name} 的 IDE 命令行入口（${this.target.displayPath}），` +
          `不是 agent CLI：它把参数当成「要打开的路径」，调用时会直接拉起 IDE 窗口。` +
          `${this.def.descriptor.installHint ?? ''}`.trim(),
        probedAt: now,
      };
      return this.status;
    }

    const { version, raw } = await probeVersion(binPath);

    // 凭据启发式检查：只做低成本判断，不发起真实调用
    // （提前到可达性检查之前：两条信息要在同一条 message 里一起给出，
    //   否则用户只看到「网络不通」，填完 Key 才发现还有另一道门）
    const auth = this.checkAuth();

    // 后端可达性检查：放在凭据判定**之前**给出结论。
    //
    // 网络不通是比「没登录」更前置的阻塞 —— 一个凭据齐全、版本正常的
    // Agent 也可能一次都调不通（codex 就是活例：auth.json 有效、
    // 版本 0.161.0 探测通过，但唯一后端 chatgpt.com 被代理 502 拒绝）。
    // 先判网络，用户才不会拿着「未登录」的提示去反复登录一个永远连不上的服务。
    if (this.def.backendHosts?.length) {
      const blocked = await allHostsUnreachable(this.effectiveBackendHosts());
      if (blocked) {
        // 缺凭据时把两件事一起说清：这个 Agent 现在有**两道**门要过。
        const authPart = auth.ok ? '' : ` 另外：${auth.hint}`;
        this.status = {
          availability: 'unreachable',
          installed: true,
          binaryPath: binPath,
          version,
          message: `后端网络不可达：${blocked.join('、')}（本机与代理均连不上）。该 Agent 无法发起调用，请检查网络或代理设置。${authPart}`,
          probedAt: now,
        };
        return this.status;
      }
    }

    let availability: AgentStatus['availability'] = 'ready';
    let message: string | undefined;

    if (!auth.ok) {
      availability = 'needs-auth';
      message = auth.hint;
    } else if (!version && raw) {
      // 能起来但输出里没有可识别的版本 —— 多半是原生二进制缺失
      // （Claude Code 的典型症状），或者是首次运行需要初始化
      availability = 'needs-setup';
      message = `命令存在但无法正常获取版本：${raw.slice(0, 160)}`;
    } else {
      // 有版本，或者命令静默退出（部分 CLI 不支持 --version）——都算就绪
      message = version ? '就绪' : '就绪（该命令不支持版本探测）';
    }

    this.status = {
      availability,
      installed: true,
      binaryPath: binPath,
      version,
      message,
      probedAt: now,
    };
    return this.status;
  }

  /** 低成本凭据检查：看环境变量或常见凭据文件是否存在 */
  private checkAuth(): { ok: boolean; hint: string } {
    const d = this.def;

    if (d.authEnvs?.length) {
      const hit = d.authEnvs.find(name => {
        const v = process.env[name];
        return typeof v === 'string' && v.trim().length > 0;
      });
      if (hit) return { ok: true, hint: `已通过环境变量 ${hit} 配置凭据` };
    }

    if (d.authFiles?.length) {
      const home = os.homedir();
      const hit = d.authFiles.find(rel => {
        try {
          return fs.statSync(path.join(home, rel)).isFile();
        } catch {
          return false;
        }
      });
      if (hit) return { ok: true, hint: `已找到凭据文件 ~/${hit}` };
    }

    // 没配任何可检测的凭据：不算失败（有些 CLI 用系统钥匙串，检测不到），
    // 但把提示挂上去，第一次调用失败时前端能显示原因。
    //
    // A30：声明了 `credential` 的 Agent 直接把「去哪儿填」写进提示 ——
    // 之前这里只重复 installHint（「设置 GEMINI_API_KEY」），而打包版用户
    // 根本没有「设置环境变量」这个动作可用，等于告诉他一条走不通的路。
    const hint = d.credential
      ? `未配置凭据：请在「设置 → 登录配置 → Agent API Key」填入 ${d.credential.keyEnv.join(' 或 ')}（也支持环境变量）`
      : d.descriptor.installHint || '未检测到登录凭据，首次调用可能需要先登录';

    return {
      ok: !d.authEnvs?.length && !d.authFiles?.length,
      hint,
    };
  }

  /**
   * 实际用于可达性检查的后端主机。
   *
   * 声明了 `backendHostOverrideEnv` 且该变量有值时，按**它**判可达性：
   * 那是用户自己指定的接入地址（例如 Gemini 兼容网关）。官方端点被网络层
   * 阻断，并不代表用户配的这条链路也不通 —— 拿官方主机去判，会让「填了网关
   * 却仍显示不可达」成为必然。
   */
  private effectiveBackendHosts(): string[] {
    const envName = this.def.backendHostOverrideEnv;
    const raw = envName ? (process.env[envName] ?? '').trim() : '';
    if (raw) {
      try {
        const host = new URL(raw).host;
        if (host) return [host];
      } catch {
        // 非法 URL：退回官方主机（宁可判不通，也不因为一个坏地址而报「就绪」）
      }
    }
    return this.def.backendHosts ?? [];
  }

  // ============= 调用 =============

  async *send(ctx: SendContext): AsyncIterable<AgentEvent> {
    // 未探测过就先探测，顺便拿到 launch target
    if (!this.status) await this.probe();

    if (!this.target) {
      yield {
        type: 'error',
        message:
          this.status?.message ||
          `Agent ${this.descriptor.id} 当前不可用（${this.status?.availability ?? 'unknown'}）`,
      };
      return;
    }

    const started = Date.now();
    // A106：双向模式（spec.bidi）—— 把 stdin 打开并让 buildArgs 切到
    // `--input-format stream-json`。flag 位置只有 buildArgs 知道
    // （与 variadic 的 --allowedTools 有冲突），适配器只做「要不要双向」的决定。
    const bidi = this.spec.bidi === true;
    const args = this.spec.buildArgs(
      ctx.prompt,
      bidi ? { ...ctx, inputFormat: 'stream-json' as const } : ctx
    );

    // A100：把自己的输出方式告诉下游。纯文本解析出来的工具事件与结构化
    // 输出在界面上长得一样，但可信度差一档 —— 不标就等于把两者画成同一个样子。
    yield {
      type: 'init',
      sessionId: ctx.sessionId,
      model: ctx.model,
      source: this.spec.parse === 'text' ? 'parsed_text' : 'structured_cli',
    };

    const queue = new AsyncQueue<AgentEvent>();
    const target = this.target;

    let child: CliChild | BidiChild;
    try {
      // 类型说明：三元表达式把 stdio 的字面量类型 widen 成了 string[]，
      // spawn 的返回值随之退化成 ChildProcess。两条分支的实际形状分别就是
      // CliChild / BidiChild，这里按事实收窄，别让后面每个调用点都写 `as`。
      child = spawn(target.command, [...target.prefixArgs, ...args], {
        cwd: ctx.cwd || process.cwd(),
        // target.env 是启动目标的一部分（如 Trae 的 ELECTRON_RUN_AS_NODE=1），
        // 必须垫在子进程环境之上 —— 少了它 Electron 会以 GUI 模式启动，
        // 挂一个看不见的窗口，stdout 永远不出东西。
        env: { ...childEnv(), ...(target.env ?? {}) },
        shell: false,           // ★ 关键：不经过 shell
        windowsHide: true,
        // A106：双向模式 stdin 走管道（写用户消息 / 收尾时 EOF）；
        // 一次性模式仍是 'ignore' —— 部分 CLI 见 stdin 是 TTY 会进交互模式。
        stdio: bidi ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      }) as CliChild | BidiChild;
    } catch (err) {
      yield { type: 'error', message: `启动失败：${(err as Error).message}` };
      return;
    }

    this.running.set(ctx.sessionId, child);

    // A106：双向模式的 stdin 收尾。关掉 = 告诉 CLI「没有更多输入了」，
    // 它自己走完退出路径（比信号干净，有机会把会话状态写盘）。
    // 关不上也有超时与 SIGTERM→SIGKILL 终止链兜底。
    const endStdin = () => {
      if (!bidi) return;
      const stdin = (child as BidiChild).stdin;
      if (!stdin || stdin.destroyed) return;
      try {
        stdin.end();
      } catch {
        /* 已经断了，忽略 */
      }
    };

    if (bidi) {
      // stdin 的 EPIPE 是**异步**事件（进程死了之后一次迟到的 write 才会触发），
      // try/catch 拦不住。不挂监听的话它会以 unhandled 'error' 把整个服务端
      // 炸掉（A106 实测踩到：abort 之后补写 interrupt，桩进程已退）。
      (child as BidiChild).stdin.on('error', () => {
        /* 对端没了，忽略 —— 终止链会收尸 */
      });
      try {
        (child as BidiChild).stdin.write(buildStdinUserMessage(ctx.prompt) + '\n');
      } catch (err) {
        yield { type: 'error', message: `写入 stdin 失败：${(err as Error).message}` };
        return;
      }
    }

    // ---- 超时与快速失败 ----
    // CLI 在遇到网络故障时会无限重连而不是退出，没有这两道闸门，
    // 一次对话就能把 HTTP 请求永久挂住（codex 实测如此）。
    let killed: 'abort' | 'timeout' | 'fatal' | null = null;
    let fatalDetail = '';
    /** A106：取消 SIGKILL 升级的函数；进程退出时调用 */
    let cancelKill: (() => void) | null = null;

    const timeoutMs = this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      stopAll('timeout');
    }, timeoutMs);
    timer.unref?.();

    /**
     * 终止子进程。
     * 注意：这里**不**关闭队列 —— 交给 close 处理器统一收尾，
     * 否则「超时/致命错误」的原因就来不及写进事件流了（push 到已关闭队列会被丢弃）。
     *
     * A106：终止走 terminateGracefully（先 SIGTERM，宽限后 SIGKILL）。
     * 宽限期内 stdout 照常解析（队列没关），已产出的增量不会丢。
     */
    const stopAll = (reason: NonNullable<typeof killed>, detail = '') => {
      // 先到先得：超时之后 stderr 又命中判死模式时，原因保持第一次的那个
      if (killed) return;
      killed = reason;
      fatalDetail = detail;
      clearTimeout(timer);
      cancelKill?.();
      cancelKill = null;
      if (child.killed) return;
      cancelKill = terminateGracefully(child, TERM_GRACE_MS);
    };

    // 中止信号 → 杀子进程（linkAbort 会处理「信号已中止」的情况）
    const unlinkAbort = linkAbort(ctx.signal, () => {
      // A106：双向模式先按 control 协议礼貌中断（CLI 有机会停在这一轮，
      // 不留下半截工具调用），再走 SIGTERM→SIGKILL 终止链兜底。
      // 两者不冲突：interrupt 是「这轮别跑了」，SIGTERM 是「进程退不退」。
      if (bidi) {
        try {
          (child as BidiChild).stdin.write(buildInterruptRequest() + '\n');
        } catch {
          /* 进程已死，忽略 */
        }
      }
      stopAll('abort');
    });

    let stderrBuf = '';
    let lineBuf = '';
    /** 'json-object' 模式的 stdout 累积区（进程结束时整体解析） */
    let jsonBuf = '';
    let sawText = false;
    /** 是否已经由行映射给出过 error 事件（避免再补一条「没有任何输出」的废话） */
    let sawError = false;
    /** 适配器是否已自行给出 done（带用量）；给了就不再由 close 兜底重复发 */
    let sawDone = false;
    /** 中途上报的用量（每步一次的那种），收尾时并进 done */
    let lastUsage: { cost?: number; tokens?: number } = {};

    // 有状态的映射器（每个会话一份，避免并发串味）；没有就用无状态的 mapLine
    const mapLine = this.spec.createMapper?.() ?? this.spec.mapLine;

    // ---- A106：双向模式的 control 协议处理 ----

    /**
     * 判定并应答一次 can_use_tool。
     *
     * 判定顺序与 SdkAdapter.canUseTool **逐条一致**（顺序即安全）：
     *   ① 场景白名单（排他语义，最先判 —— bypass 只是「不弹窗」，
     *      不是「白名单作废」；反过来的话「问答」场景配全放行就等于没限制）
     *   ② 权限门禁（规则匹配 + Bash 分类器 + 路径越界；deny 任何模式都拦）
     *   ③ bypassPermissions 直接放行（用户已经表态）
     *   ④ 用户规则明示允许（auto）
     *   ⑤ 其余 → 弹给用户，超时按拒绝计
     */
    const decideAndRespond = async (ask: CanUseToolAsk): Promise<void> => {
      const toolUseEcho = ask.toolUseId ? { toolUseID: ask.toolUseId } : {};
      const respond = (payload: Record<string, unknown>) => {
        try {
          (child as BidiChild).stdin.write(
            buildControlResponse(ask.requestId, { ...payload, ...toolUseEcho }) + '\n'
          );
        } catch {
          /* 进程已死，忽略 —— CLI 不在了，回复没有接收方 */
        }
      };

      const gate = decideToolAccess(ctx.allowedTools, ask.toolName);
      if (!gate.allowed) {
        console.log(
          `[CLI:bidi] 工具被场景白名单拦截: ${ask.toolName} (category=${gate.category ?? 'unlisted'})`
        );
        respond({ behavior: 'deny', message: gate.reason ?? '场景未授权该工具' });
        return;
      }

      const verdict = evaluateToolCall({
        toolName: ask.toolName,
        input: ask.input,
        cwd: ctx.cwd,
        rules: currentPermissionRules(),
      });
      if (verdict.decision === 'deny') {
        console.log(`[CLI:bidi] 门禁拦截 ${ask.toolName}: ${verdict.rule} — ${verdict.reason ?? ''}`);
        respond({
          behavior: 'deny',
          message: `[权限门禁] ${verdict.reason ?? verdict.rule ?? '高危操作'}`,
        });
        return;
      }

      if (ctx.permissionMode === 'bypassPermissions' || verdict.auto) {
        respond({ behavior: 'allow', updatedInput: ask.input });
        return;
      }

      const requestId = randomUUID();
      queue.push({
        type: 'permission_request',
        requestId,
        toolUseId: ask.toolUseId,
        toolName: ask.toolName,
        input: ask.input,
        // 弹窗上要显示「为什么问这一句」，否则用户只看到一堵墙
        risk: verdict.risk,
        rule: verdict.rule,
      });

      // 挂起，直到前端 POST /api/permission-response（或超时按拒绝）
      const decision = await this.replies.register(
        requestId,
        () => ({ behavior: 'deny', message: '权限请求超时' }),
        PERMISSION_TIMEOUT,
        ctx.sessionId
      );
      if (decision.behavior === 'allow') {
        respond({ behavior: 'allow', updatedInput: ask.input });
      } else {
        respond({ behavior: 'deny', message: decision.message || '用户拒绝了此操作' });
      }
    };

    const handleControlAsk = (ask: ControlAsk): void => {
      const write = (line: string) => {
        try {
          (child as BidiChild).stdin.write(line + '\n');
        } catch {
          /* 进程已死，忽略 */
        }
      };
      if (ask.kind === 'can_use_tool') {
        void decideAndRespond(ask).catch(err => {
          // 判定本身抛错（不该发生）也必须应答 —— 否则 CLI 挂到 8 分钟超时
          write(buildControlError(ask.requestId, `权限判定失败：${(err as Error).message}`));
        });
        return;
      }
      if (ask.kind === 'interrupt') {
        // 本端没发起过中断；空载荷即「已受理」
        write(buildControlResponse(ask.requestId, {}));
        return;
      }
      // 认识但没实现：明确回错，不装聋
      write(buildControlError(ask.requestId, `未实现的控制请求：${ask.subtype}`));
    };

    // ---- 输出解析 ----

    const handleText = (chunk: string) => {
      const clean = stripAnsi(chunk);
      if (!clean) return;
      sawText = true;
      queue.push({ type: 'text', content: clean });
    };

    const handleJsonLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        // 不是 JSON 就按纯文本处理（很多 CLI 会混印进度信息）
        handleText(trimmed + '\n');
        return;
      }
      // A106：双向模式下控制消息优先分流。它不是普通事件 —— 喂给 mapLine
      // 只会被当成无价值行丢掉，而那个请求就永远挂着（等它的是 8 分钟超时）。
      if (bidi) {
        const ask = classifyControlMessage(obj);
        if (ask) {
          handleControlAsk(ask);
          return;
        }
        // result 行 = 整轮结束：关 stdin 让 CLI 自己退。
        // 不关的话它会等下一个用户消息直到我们的超时点火。
        if ((obj as { type?: unknown }).type === 'result') endStdin();
      }
      const token = this.spec.extractResumeToken?.(obj);
      if (token) {
        queue.push({
          type: 'init',
          sessionId: ctx.sessionId,
          resumeToken: token,
          source: this.spec.parse === 'text' ? 'parsed_text' : 'structured_cli',
        });
      }
      const mapped = mapLine?.(obj);
      if (!mapped) {
        // A111：**CLI 层的旁路**。
        //
        // 原来这里是一句 `return` —— 这一行的内容就此消失。而这一层恰恰是
        // 12 个 Agent 里 12 个都走的路（sdk / acp 各只有一个），所以「不认识
        // 就丢掉」在这里的杀伤面最大：CLI 一升级，新增的行类型静默蒸发，
        // 界面上只表现为「它好像少做了什么」，没有任何报错。
        //
        // 代价是会有噪音：有些映射器是**故意**返回 null 的（比如流式增量之后
        // 又来的整段兜底，接了就会重复）。这些行现在也会进旁路。接受这个代价，
        // 因为投影器把整个 run 的 raw 聚成**一块**、最多留 20 条、其余只计数，
        // 且 UI 默认折叠 —— 噪音被关在抽屉里，而丢失是找不回来的。
        queue.push({
          type: 'raw',
          channel: `cli:${cliRawChannel(obj)}`,
          payload: obj,
        });
        return;
      }
      // 一行可能拆成多个事件（如「工具开始 + 工具结果」）
      for (const ev of Array.isArray(mapped) ? mapped : [mapped]) {
        if (ev.type === 'usage') {
          // 用量不是可渲染事件：攒起来，收尾时并进 done
          if (typeof ev.cost === 'number') lastUsage.cost = ev.cost;
          if (typeof ev.tokens === 'number') lastUsage.tokens = ev.tokens;
          continue;
        }
        if (ev.type === 'text') sawText = true;
        if (ev.type === 'error') sawError = true;
        if (ev.type === 'done') sawDone = true;
        queue.push(ev);
      }
    };

    // setEncoding 使用 StringDecoder，能正确处理被切断的多字节 UTF-8
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      if (this.spec.parse === 'jsonl') {
        lineBuf += chunk;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() ?? '';   // 最后一段可能是半行，留着
        for (const line of lines) handleJsonLine(line);
      } else if (this.spec.parse === 'json-object') {
        // 只累积不解析：整体是不是合法 JSON 要等进程结束才知道
        // （半截 JSON 逐行 parse 必然失败，然后按纯文本显示出来 —— 那就全毁了）
        jsonBuf += stripAnsi(chunk);
      } else {
        handleText(chunk);
      }
    });

    child.stderr.on('data', (chunk: string) => {
      stderrBuf += stripAnsi(chunk);
      // 保留尾部，避免无限增长
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);

      // 命中「不可恢复」模式就立刻判死，不必等到超时
      const fatal = this.spec.fatalStderrPattern;
      if (fatal && !killed && fatal.test(stderrBuf)) {
        const tail = stderrBuf.trim().split(/\r?\n/).slice(-3).join('\n');
        stopAll('fatal', tail);
      }
    });

    child.on('error', (err: Error) => {
      queue.fail(new Error(`子进程错误：${err.message}`));
    });

    child.on('close', (code: number | null) => {
      unlinkAbort();
      clearTimeout(timer);
      // A106：进程已经退了，SIGKILL 升级没必要再执行
      cancelKill?.();
      this.running.delete(ctx.sessionId);

      // 冲刷 jsonl 残留
      if (this.spec.parse === 'jsonl' && lineBuf.trim()) handleJsonLine(lineBuf);
      // json-object：把整个累积区当一个 JSON 走同一条管线（续接令牌 / 映射 / 用量）
      if (this.spec.parse === 'json-object' && jsonBuf.trim()) handleJsonLine(jsonBuf);

      const elapsed = Date.now() - started;

      // ---- 被我们主动终止的三种情况，原因必须如实写进事件流 ----
      if (killed === 'abort') {
        // 客户端已经走了，没人听；直接收尾即可
        queue.close();
        return;
      }
      if (killed === 'timeout') {
        queue.push({
          type: 'error',
          message: `${this.descriptor.name} 超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成，已终止。`,
        });
        queue.push({ type: 'done', durationMs: elapsed });
        queue.close();
        return;
      }
      if (killed === 'fatal') {
        // 同样的判死路径有两种原因，文案不能混：
        //   - 登录态缺失（agy 未登录时会打印授权 URL 然后干等 60 秒）
        //   - 真正的不可恢复错误（kimi 的 No model configured、codex 的重连）
        const isAuth = AUTH_HINT_RE.test(stderrBuf);
        queue.push({
          type: 'error',
          message: isAuth
            ? `需要先登录 ${this.descriptor.name}：\n${fatalDetail || '未提供详细信息'}`
            : `${this.descriptor.name} 遇到不可恢复的错误，已终止：\n${fatalDetail || '未提供详细信息'}`,
        });
        queue.push({ type: 'done', durationMs: elapsed });
        queue.close();
        return;
      }

      if (code !== 0) {
        const tail = stderrBuf.trim().split(/\r?\n/).slice(-6).join('\n');
        const isAuth = AUTH_HINT_RE.test(stderrBuf);
        queue.push({
          type: 'error',
          message: isAuth
            ? `需要先登录 ${this.descriptor.name}：${tail || '未提供详细信息'}`
            : `${this.descriptor.name} 退出码 ${code}${tail ? `：\n${tail}` : ''}`,
        });
      } else if (!sawText && !sawError) {
        // 一个字都没输出 —— 明确告诉用户，而不是静默成功。
        // stderr 里往往有真正的原因（网络失败、需要初始化等），一并带出来。
        // ⚠️ 已经给过 error 的不要再来一条：pi 的请求级失败就是这样，
        //    真实原因在 JSON 流里，再补一句「没有任何输出」只会把真因盖住。
        const tail = stderrBuf.trim().split(/\r?\n/).slice(-6).join('\n');
        queue.push({
          type: 'error',
          message: tail
            ? `${this.descriptor.name} 没有产生任何输出，stderr：\n${tail}`
            : `${this.descriptor.name} 没有产生任何输出（退出码 0）。可能需要在终端先完成一次初始化或登录。`,
        });
      }

      // 适配器自己发过 done（带 token 用量）就不再补：重复的 done 会让
      // 投影器收到两次终局，用量也可能被后一个空载荷覆盖掉
      if (!sawDone) {
        queue.push({ type: 'done', durationMs: elapsed, ...lastUsage });
      }
      queue.close();
    });

    try {
      for await (const ev of queue) yield ev;
    } finally {
      unlinkAbort();
      // A106：消费方提前收尾（客户端断开）时进程可能还活着 ——
      // 走同一条优雅终止链，不让 CLI 成为没人管的孤儿。
      if (!child.killed && this.running.has(ctx.sessionId)) {
        terminateGracefully(child, TERM_GRACE_MS);
      }
      this.running.delete(ctx.sessionId);
      // A106：双向模式的待答复权限请求随之作废（前端不等了）。
      // A108：只作废本会话的 —— 同一 Agent 可能同时在别的会话里等答复
      this.replies.clear(ctx.sessionId);
    }
  }

  abort(sessionId: string): void {
    const child = this.running.get(sessionId);
    if (child && !child.killed) {
      // A106：与 send() 内同一条终止链（先 SIGTERM 再 SIGKILL）——
      // 不各写一份，两份必然漂移。
      terminateGracefully(child, TERM_GRACE_MS);
      this.running.delete(sessionId);
    }
  }

  /**
   * A106：双向模式的权限答复入口（与 SdkAdapter 同形状）。
   * 一次性模式永远返回 false —— 它们不产生 permission_request 事件。
   */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.replies.settle(requestId, decision);
  }
}
