/**
 * B2 闸门：全局异常兜底的「记日志继续跑」是否真的成立。
 *
 * 断言分两层：
 *
 * **行为层（真调用，不碰进程）** —— 直接 import `crash-guard.ts` 调
 * `recordFatal()`，量四件事：
 *   1. 首次记录返回 true（真的写了）；
 *   2. 窗口内同签名重复返回 false（节流生效）—— 不节流的话一个坏掉的
 *      Agent 能在几分钟内把日志刷到几百 MB；
 *   3. 窗口过后同一签名又能记（节流不是永久屏蔽）；
 *   4. Error / 非 Error / 带 cause 都能渲染出可读正文，且输出里**不含**
 *      token 与认证 URL 的敏感部分（日志会被用户贴进 issue）。
 *
 * **接线层（静态，剥注释后锚定）** —— 三处必须挂上：
 *   · `server/index.ts` 调 `installCrashGuard()` 且 `app.use(errorMiddleware)`；
 *   · `electron/main.ts` 也调（主进程崩了窗口直接消失，比白屏更糟）；
 *   · 错误中间件的响应体不含 stack / message（只给稳定错误码）。
 *
 * 反向探针：见 .tmp/probe-b2.mjs —— 真把 `installCrashGuard()` 与
 * `app.use(errorMiddleware)` 从源码摘掉，确认本闸门变红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FATAL_THROTTLE_MS,
  _resetFatalThrottle,
  errorMiddleware,
  recordFatal,
} from '../server/crash-guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string, detail?: string): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures.push(label);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 剥注释：避免历史描述里的 `installCrashGuard()` 造成假绿 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ── 抓取 console.error：recordFatal 的唯一输出通道 ──────────────────────
const logged: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(' '));
};
const takeLog = () => logged.splice(0, logged.length).join('\n');

console.log('\n[1] 节流行为：同签名窗口内只记一次');
{
  _resetFatalThrottle();
  const boom = new Error('同一个错误');
  const t0 = 1_000_000;
  ok(recordFatal('uncaughtException', boom, t0) === true, '首次记录写进日志');
  const first = takeLog();
  ok(first.includes('[Fatal:uncaughtException]'), '带统一前缀（便于 grep 定位）', first.split('\n')[0]);
  ok(first.includes('同一个错误'), '日志里有原始 message（脱敏不能抹掉正文）');

  ok(recordFatal('uncaughtException', boom, t0 + 1000) === false, '窗口内重复被节流（不写日志）');
  ok(takeLog() === '', '被节流时确实没有任何输出');

  // 窗口过后再命中：必须重新记，且带上「已抑制 N 次」
  ok(recordFatal('uncaughtException', boom, t0 + FATAL_THROTTLE_MS + 1) === true,
    '窗口过后同一签名重新记录（不是永久屏蔽）');
  const after = takeLog();
  ok(/已抑制 1 次/.test(after), '补报抑制计数（知道期间还发生过几次）', after.match(/已抑制 \d+ 次/)?.[0] ?? '(缺)');
}

console.log('\n[2] 不同签名互不节流');
{
  _resetFatalThrottle();
  const t = 2_000_000;
  ok(recordFatal('uncaughtException', new Error('A'), t) === true, '错误 A 首记');
  ok(recordFatal('uncaughtException', new Error('B'), t) === true, '错误 B 同窗口内仍记录（签名不同）');
  takeLog();
}

console.log('\n[3] 各种抛出物都能渲染，且不泄露敏感信息');
{
  _resetFatalThrottle();
  const t = 3_000_000;

  recordFatal('unhandledRejection', '纯字符串原因', t);
  ok(takeLog().includes('纯字符串原因'), '字符串 rejection 也能记');

  recordFatal('unhandledRejection', { code: 42, why: '对象原因' }, t + 1);
  const objLog = takeLog();
  ok(objLog.includes('对象原因'), '对象 rejection 序列化成可读正文', objLog.split('\n')[1]);

  const withCause = new Error('外层', { cause: new Error('内层根因') });
  recordFatal('uncaughtException', withCause, t + 2);
  const causeLog = takeLog();
  ok(causeLog.includes('内层根因'), 'cause 链被展开（否则定位不到根因）');

  // 脱敏：日志里常出现的两类敏感串
  // 下面这串是**构造的测试值**，不是真密钥：它专门用来验证 SECRET_PATTERNS 确实会把它
  // 从日志里抹掉（下一条断言就是「日志里找不到它」）。删了它，脱敏就没人测了。
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'; // secret-scan:ignore
  recordFatal('uncaughtException', new Error(`请求失败 key=${secret}`), t + 3);
  const secretLog = takeLog();
  ok(!secretLog.includes(secret), '日志里的 key 被脱敏', secretLog.split('\n')[1]?.slice(0, 80));

  const authUrl = 'https://example.com/oauth?code=ONE_TIME_CODE_ABC123&state=xyz';
  recordFatal('uncaughtException', new Error(`认证地址 ${authUrl}`), t + 4);
  const urlLog = takeLog();
  ok(!urlLog.includes('ONE_TIME_CODE_ABC123'), '认证 URL 里的一次性 code 被脱敏');

  ok(/进程继续运行/.test(secretLog) || /进程继续运行/.test(causeLog), '日志明确写出「进程继续运行」');
}

console.log('\n[4] 错误中间件：500 JSON，不带 stack');
{
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    headersSent: false,
    status(s: number) {
      status = s;
      return this;
    },
    json(b: Record<string, unknown>) {
      body = b;
      return this;
    },
  };
  _resetFatalThrottle();
  errorMiddleware(new Error('内部实现细节：/Users/someone/secret.ts:12'), { path: '/api/whatever' } as never, res as never, (() => {}) as never);
  takeLog();
  ok(status === 500, '状态码 500', String(status));
  ok(body.code === 'internal_error', '机器可读错误码 internal_error', String(body.code));
  ok(typeof body.error === 'string' && !/内部实现细节|secret\.ts|Users/.test(String(body.error)),
    '给客户端的是稳定文案，不含 stack / 绝对路径', String(body.error));
  ok(!JSON.stringify(body).includes('secret.ts') && !JSON.stringify(body).includes('Users'),
    '整个响应体都不含 stack 痕迹');
  ok(typeof body.requestId === 'string' && String(body.requestId).length > 0,
    '带 requestId（用户报障时能对上日志）', String(body.requestId));

  let nextCalled = false;
  errorMiddleware(new Error('已发过响应'), { path: '/x' } as never,
    { headersSent: true } as never, (() => { nextCalled = true; }) as never);
  takeLog();
  ok(nextCalled, '响应已发出时交给 next（不二次写头，否则 ERR_HTTP_HEADERS_SENT）');
}

console.log('\n[5] 接线：三处必须真的挂上');
{
  const index = stripComments(read('server/index.ts'));
  ok(/installCrashGuard\(\)/.test(index), 'server/index.ts 装了进程级 handler');
  ok(/app\.use\(errorMiddleware\)/.test(index), 'server/index.ts 注册了统一错误中间件');

  // 顺序：错误中间件必须在所有 register*Routes 之后
  const lastRoute = Math.max(
    ...['registerAgentRosterRoutes', 'registerChatRoutes', 'registerScheduleRoutes', 'registerKbRoutes']
      .map(n => index.indexOf(n))
  );
  ok(index.indexOf('app.use(errorMiddleware)') > lastRoute,
    '错误中间件在所有路由之后注册（否则接不住前面路由抛的错）');

  const main = stripComments(read('electron/main.ts'));
  ok(/installCrashGuard\(\)/.test(main), 'electron/main.ts 也装了（主进程崩了窗口直接消失）');

  const guard = stripComments(read('server/crash-guard.ts'));
  ok(!/process\.exit/.test(guard), '兜底里没有 process.exit（「继续跑」策略的硬约束）');
  ok(/uncaughtException/.test(guard) && /unhandledRejection/.test(guard), '两类异常都挂');
}

console.error = realError;
console.log(`\n=== ${checks - failures.length}/${checks} 通过 ===`);
if (failures.length > 0) {
  console.log(`失败项：\n${failures.map(f => `  · ${f}`).join('\n')}`);
  process.exit(1);
}
