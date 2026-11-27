/**
 * B2：进程级异常兜底（用户拍板「记日志继续跑」）。
 *
 * ## 为什么是「继续跑」而不是「退出」
 *
 * 这个应用是用户桌面上的**唯一窗口**：server 子进程一退，窗口就是白屏，用户
 * 没有任何自救手段（看不到日志、也没有命令行）。一次未捕获异常通常来自某个
 * 单条请求或单个 Agent 的回调，杀掉整个进程的代价远大于收益。所以策略是
 * 「记下来、继续跑」，把「为什么出错」留到日志里，把「界面还能用」留给用户。
 *
 * ## 为什么必须节流
 *
 * `unhandledRejection` 常见于「订阅了但没人消费的异步链」—— 这类错误会在
 * 每一轮对话、每一个事件回调里重复触发。不节流的话，一个坏掉的 Agent 能在
 * 几分钟内把日志刷到几百 MB，反而不利于事后定位。这里按 **stack 首行签名**
 * 去重，一分钟内同一个签名只记一次，并给出「已抑制 N 次」的计数。
 *
 * ## 为什么先脱敏
 *
 * 异常 message 里可能带 API Key、认证 URL 里的一次性 code。日志是要给
 * 用户看、也可能被贴进 issue 的。注意不能复用 `redactSecret()` —— 它的语义
 * 是「把一个敏感值换成指纹」，喂整段正文会让日志失去全部信息（见 renderError）。
 */

/** 同一签名在多长时间内只记一次（毫秒） */
const THROTTLE_MS = 60_000;

interface SeenEntry {
  at: number;
  suppressed: number;
}

/** 签名 → 上次记录时间与抑制计数。模块级：同一进程内跨 handler 共用。 */
const seen = new Map<string, SeenEntry>();

/**
 * 从错误对象取一个稳定的「签名」用于去重。
 *
 * 用 stack 的前两行（`Error: xxx` + 第一帧 `at fn (file:line:col)`）：
 * - 只用 message 不够 —— 同一句 message 可能来自完全不同的代码路径；
 * - 用整个 stack 又太细 —— 同一处循环抛错时行号会随调用深度抖动。
 */
function signatureOf(err: unknown): string {
  if (err instanceof Error) {
    const lines = (err.stack || `${err.name}: ${err.message}`).split('\n');
    return lines.slice(0, 2).join('\n');
  }
  return typeof err === 'string' ? err : String(err);
}

/**
 * 把任意抛出物渲染成可读的日志正文（已脱敏）。
 *
 * ⚠️ 这里**不能**把整段正文丢给 `redactSecret()` —— 那个函数的语义是
 * 「把一个敏感值换成一个指纹」，喂整段文本会得到 `<redacted len=… fp=…>`，
 * 日志就此失去全部信息（第一版就是这么错的）。它和 `redactUrl()` 都是给
 * 「单个内部值」用的（续接令牌、认证 URL），不是通用文本脱敏器。
 *
 * 所以这里做定向替换：只抹掉**看起来是密钥**的片段与 URL 的 query/fragment，
 * 其余正文（错误 message、stack、cause）原样保留 —— 这些是排查时真正要看的。
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // OpenAI/Anthropic/自建 Key 的常见形态
  [/\b(sk|pk|ak|api[_-]?key|token|secret)[-_]?[A-Za-z0-9_-]{16,}/gi, '$1…<redacted>'],
  // Bearer 头
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer <redacted>'],
  // URL 的 query / fragment：OAuth 的 code / state / token 都在这里
  [/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1<query-redacted>'],
  [/(https?:\/\/[^\s#]+)#\S*/gi, '$1<fragment-redacted>'],
];

function renderError(err: unknown): string {
  let body: string;
  if (err instanceof Error) {
    body = `${err.name}: ${err.message}\n${err.stack ?? '(无 stack)'}`;
    // cause 链（`new Error('outer', {cause})`）默认不打印，Node 只在未捕获
    // 崩溃时才展开它；我们继续跑，所以自己展开一层足够定位。
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) body += `\n  [cause] ${String(cause)}`;
  } else {
    body = typeof err === 'object' ? JSON.stringify(err) : String(err);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    body = body.replace(pattern, replacement);
  }
  return body;
}

/**
 * 记录一次未捕获异常。返回 true 表示这条真的写进了日志（未被节流）。
 *
 * 导出是为了让闸门能直接调用它断言节流行为 —— 起真进程测
 * `uncaughtException` 既慢又不可靠（还要故意让子进程崩掉）。
 */
export function recordFatal(kind: 'uncaughtException' | 'unhandledRejection', err: unknown, now = Date.now()): boolean {
  const sig = signatureOf(err);
  const slot = seen.get(sig);
  if (slot && now - slot.at < THROTTLE_MS) {
    slot.suppressed += 1;
    return false;
  }
  const suppressed = slot?.suppressed ?? 0;
  seen.set(sig, { at: now, suppressed: 0 });

  const tail = suppressed > 0 ? `（上次记录后同类错误已抑制 ${suppressed} 次）` : '';
  console.error(
    `[Fatal:${kind}] ${new Date(now).toISOString()} ${tail}\n${renderError(err)}\n` +
      '  ↳ 进程继续运行。若界面出现异常，请重启应用；这行日志可用于定位。'
  );
  return true;
}

/** 测试/闸门用：清空节流状态，避免跨用例互相干扰。 */
export function _resetFatalThrottle(): void {
  seen.clear();
}

/** 节流窗口，闸门断言「窗口内重复不记」时要用同一个值。 */
export const FATAL_THROTTLE_MS = THROTTLE_MS;

/**
 * 装上进程级 handler。幂等：重复调用不会重复注册（否则每条错误记两遍）。
 *
 * ⚠️ 必须**不退出**。`uncaughtException` 的默认行为是打印后 exit(1)，
 * 注册了 handler 之后 Node 不再自动退出 —— 这正是我们要的语义，但也意味着
 * 真遇到「内存耗尽 / 栈溢出」这类不可恢复错误时进程会处于半坏状态。
 * 取舍已在方案里向用户确认：桌面单窗口场景下，半坏 > 白屏。
 */
let installed = false;
export function installCrashGuard(): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', err => {
    recordFatal('uncaughtException', err);
  });
  process.on('unhandledRejection', reason => {
    recordFatal('unhandledRejection', reason);
  });
}

/**
 * Express 统一错误中间件。
 *
 * 放在所有路由之后、SPA fallback 之前。四条约束：
 * 1. **不把 stack 发给客户端** —— 本地应用也会被用户截图分享，stack 里有
 *    绝对路径（含用户名）与内部模块名；
 * 2. **已经发过响应就不动** —— `headersSent` 时只能 `next(err)` 交给
 *    Express 默认处理（关连接），再写一次会抛 ERR_HTTP_HEADERS_SENT；
 * 3. **错误码统一 `internal_error`** —— 前端 `httpErrorText()` 已有 500 分级文案；
 * 4. **必须真的记日志** —— 否则错误被静默吞掉，用户只看到「服务暂时不可用」。
 */
export const errorMiddleware: import('express').ErrorRequestHandler = (err, req, res, next) => {
  recordFatal('uncaughtException', err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({
    error: '服务内部错误',
    code: 'internal_error',
    // 请求标识：用户报障时能对上日志。不用 uuid 依赖，时间戳+随机足够区分。
    requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    path: req.path,
  });
};
