/**
 * A218 闸门：自定义模型的「真发一条消息并拿到回复」。
 *
 * ## 为什么「能选」不等于「能用」
 *
 * 官方 Model Configuration 明确写了：保存配置 ≠ 连接成功、Test Connection ≠
 * 能力验证，建议「先 Test Connection 再用简单任务验证能力」。A213 只证明了
 * 桌面端 `models.json` 的自定义模型在界面上可见可选；真机事故恰恰是**选得上、
 * 发不出去**：`custom-local:sensenova-6.8-flash-lite` 在 120 秒内零模型请求、
 * 转录 0 字节。因此必须有一条闸门把「发出去 → 拿到非空正文 → 正常 result」
 * 整条链路真跑一遍，而不是只验清单、验 initialize 或验配置字段。
 *
 * ## 默认跳过，但不许静默跳过
 *
 * 实跑需要本机已登录 WorkBuddy + 可用的自定义模型端点，主回归链不具备这个
 * 条件。默认模式会**显式打印跳过的断言条数**（不是当成通过），并可用
 * `OPC_LIVE_REQUIRE=1` 把跳过判红，供有凭据的机器/CI 强制开启。
 *
 * 运行：
 *   npx tsx scripts/verify-a218-custom-model-live.ts
 *   OPC_LIVE_REQUIRE=1 npx tsx scripts/verify-a218-custom-model-live.ts   # 跳过即判红
 *   OPC_LIVE=1 npx tsx scripts/verify-a218-custom-model-live.ts            # 真连真发
 *   OPC_LIVE=1 OPC_WB_CUSTOM_MODEL=sensenova-6.8-flash-lite npx tsx ...    # 指定模型
 *
 * 隐私：只读 `models.json` 的 id/name/vendor；**绝不打印 url / apiKey**，
 * 也绝不把原始流事件整条写进日志（可能包含 prompt 回显）。
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LIVE = process.env.OPC_LIVE === '1';
const REQUIRE = process.env.OPC_LIVE_REQUIRE === '1';
const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
/** 父进程模式：起两个真实子进程，证明「残留句柄下仍会自行退出」且反向探针有效。 */
const SELFTEST_EXIT = ARGS.includes('--selftest=exit');
/** 子进程模式：故意留一个未 unref 的常驻句柄，模拟 SDK 没收干净的 CLI transport。 */
const CHILD_LINGERING = ARGS.includes('--child-lingering');
/** 反向探针：模拟「只打印汇总、不显式退出」的坏版本。 */
const PROBE_NO_EXIT = ARGS.includes('--probe=no-exit');

let pass = 0;
let fail = 0;
const failures: string[] = [];
const skipped: string[] = [];
function ok(cond: unknown, name: string, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  [${detail}]` : ''}`);
  }
}
function eq<T>(actual: T, expected: T, name: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}
function group(t: string) { console.log(`\n── ${t} ──`); }

/**
 * 宿主环境自净（A218 实跑定位）。
 *
 * 官方 WorkBuddy 桌面端会把自己 prewarm 进程的端口通过 `SERVER__PORT` 注入
 * shell；SDK CLI 继承后也会去 listen 同一个端口，直接
 * `listen EADDRINUSE: address already in use 127.0.0.1:53915`。表现是
 * 「自定义模型第一个流事件就是 error」，很容易误判成模型挂了。
 * 本闸门进程从不启动服务端，这个变量对我们只有害处 —— 无论 LIVE 与否都剔除。
 *
 * 就地删除，返回真的删掉的变量名（只打印变量名，不打印端口值）。
 */
function dropHostPortEnv(env: NodeJS.ProcessEnv): string[] {
  const dropped: string[] = [];
  for (const key of ['SERVER__PORT']) {
    if (env[key] !== undefined) {
      delete env[key];
      dropped.push(key);
    }
  }
  return dropped;
}

/**
 * 汇总后显式退出。
 *
 * `query()` 会 spawn CLI 子进程；即便 iterator.return() 已收口，transport /
 * session lock / stdio 也可能留下未 unref 的句柄，事件循环不空。旧版本只在
 * **失败**时 exit(1)，于是 LIVE 19/19 全绿却一直不退出，被外层 timeout 杀成
 * 124（成功路径假超时）。把汇总作为 stdout 最后一次写入，在回调里退出，
 * 既保住输出不丢，也让成功路径有确定的退出码。
 */
function finish(exitCode: number, summary: string): void {
  process.exitCode = exitCode;
  process.stdout.write(summary, () => {
    if (PROBE_NO_EXIT) return; // 反向探针：只写不退，模拟旧版本
    process.exit(exitCode);
  });
}

interface ChildResult { exited: boolean; code: number | null; out: string }

function runChild(extra: string[]): Promise<ChildResult> {
  const script = path.join(ROOT, 'scripts/verify-a218-custom-model-live.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', script, '--child-lingering', ...extra], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  });
  let out = '';
  child.stdout?.on('data', d => { out += String(d); });
  child.stderr?.on('data', d => { out += String(d); });
  // 好版本给足 tsx 冷启动时间；坏版本只要等到「显然该退没退」即可。
  const budget = extra.includes('--probe=no-exit') ? 3000 : 12_000;
  return new Promise<ChildResult>(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (exited: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!exited) {
        try { child.kill(); } catch { /* 已退出 */ }
      }
      resolve({ exited, code, out });
    };
    timer = setTimeout(() => done(false, null), budget);
    child.once('exit', code => done(true, code));
    child.once('error', () => done(false, null));
  });
}

/** 行为级反向探针：不依赖 LIVE 凭据，默认链里就能证明退出判据不是恒绿。 */
async function runExitSelftest(): Promise<never> {
  group('A218 退出自检（真实子进程 + 常驻句柄）');
  const good = await runChild([]);
  const bad = await runChild(['--probe=no-exit']);

  ok(good.exited && good.code === 0,
    '★ 残留句柄下 LIVE 成功路径仍自行退出且 exit 0',
    `exited=${good.exited}, code=${good.code}`);
  ok(good.out.includes('A218 自定义模型真发消息'),
    '肯定式：好版本真的跑完汇总，不是被提前杀掉',
    `stdout ${good.out.length} 字节`);
  ok(!bad.exited,
    '★ 反向探针：去掉显式退出后，同一份常驻句柄会让进程卡住（判据有效）',
    `exited=${bad.exited}, code=${bad.code}`);
  ok(bad.out.includes('A218 自定义模型真发消息'),
    '肯定式：坏版本也打印了汇总，卡的是「退出」而不是「跑挂了」',
    `stdout ${bad.out.length} 字节`);

  finish(failures.length ? 1 : 0,
    `\n${failures.length ? '✗' : '✓'} A218 退出自检：${pass}/${pass + fail} 通过\n` +
      (failures.length ? failures.map(f => `  - ${f}\n`).join('') : ''));
  // 父进程不继续跑正式断言：由 finish 的 stdout 回调退出；这里兜底防 stdout 回调丢失。
  setTimeout(() => process.exit(failures.length ? 1 : 0), 3000);
  return new Promise<never>(() => {});
}

if (SELFTEST_EXIT) await runExitSelftest();
if (CHILD_LINGERING) {
  // 故意不 unref：模拟 SDK CLI transport / stdio 没收干净时事件循环不空。
  setInterval(() => {}, 1000);
}
const DROPPED_HOST_ENV = dropHostPortEnv(process.env);

const { readWorkbuddyCustomModels } = await import('../server/agents/wbProductProfile.js');
const { SDK_DEFAULT_MODEL } = await import('../server/model-routing.js');
const { resolveFallbackModel, isCustomModelId } = await import(
  '../server/agents/adapters/turnRecovery.js'
);

// ═══════════════════════ [1] 脱敏边界（离线，永远跑） ═══════════════════════
group('1. 自定义模型读取：端点与密钥不许离开本机');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a218-'));
  fs.writeFileSync(path.join(TMP, 'models.json'), JSON.stringify([
    {
      id: 'probe-model', name: '探针模型', vendor: 'Custom',
      url: 'https://secret.example.invalid/v1', apiKey: 'SUPER_SECRET_SHOULD_NOT_LEAK',
      supportsToolCall: true,
    },
  ]));
  const models = readWorkbuddyCustomModels(TMP);
  eq(models.length, 1, '读到一条自定义模型');
  eq(models[0].id, 'probe-model', 'id 原样保留');
  eq(models[0].label, '探针模型', '显示名原样保留');
  const keys = Object.keys(models[0]).sort();
  ok(!keys.includes('url') && !keys.includes('apiKey'),
    '★ 返回对象里没有 url / apiKey 字段', keys.join(','));
  ok(!JSON.stringify(models).includes('SUPER_SECRET_SHOULD_NOT_LEAK'),
    '★ 序列化后不含密钥原文');
  ok(!JSON.stringify(models).includes('secret.example.invalid'),
    '★ 序列化后不含自定义端点');
  ok(models[0].agentIds.includes('workbuddy'), '归属 workbuddy（用于前端芯片回显）');
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ═══════════════════════ [2] SDK 兜底能力（离线，永远跑） ═══════════════════════
group('2. SDK 真的支持 fallbackModel');
{
  const transport = path.join(ROOT, 'node_modules/@tencent-ai/agent-sdk/lib/transport/process-transport.js');
  const q = path.join(ROOT, 'node_modules/@tencent-ai/agent-sdk/lib/query.js');
  const tSrc = fs.existsSync(transport) ? fs.readFileSync(transport, 'utf8') : '';
  const qSrc = fs.existsSync(q) ? fs.readFileSync(q, 'utf8') : '';
  ok(/opts\.fallbackModel/.test(tSrc) && /--fallback-model/.test(tSrc),
    '★ process-transport 把 fallbackModel 转成 --fallback-model');
  ok(/Fallback model cannot be the same as the main model\./.test(tSrc),
    '★ SDK 在兜底 === 主模型时会抛错（所以 resolveFallbackModel 必须去重）');
  ok(/fallbackModel:\s*options\?\.fallbackModel/.test(qSrc), 'query() 透传 fallbackModel');
  const custom = 'custom-local:probe-model';
  ok(isCustomModelId(custom), '真机形态的 custom-local: 前缀被认出');
  eq(resolveFallbackModel(custom), SDK_DEFAULT_MODEL, '兜底解析为 SDK 的 Auto 别名');
  eq(resolveFallbackModel(SDK_DEFAULT_MODEL), undefined, '兜底与主模型相同时不给值');
  ok(SDK_DEFAULT_MODEL !== custom, '肯定式：兜底与主模型确实不同');
}

// ═══════════════════════ [3] 宿主环境自净（离线，永远跑） ═══════════════════════
group('3. LIVE 环境自净：官方客户端注入的端口不得传给 SDK CLI');
{
  const fake: NodeJS.ProcessEnv = { SERVER__PORT: '53915', HOME: '/tmp' };
  eq(dropHostPortEnv(fake), ['SERVER__PORT'], '★ 识别并剔除宿主 prewarm 端口变量');
  eq(fake.SERVER__PORT, undefined, '★ 就地删除（不是只返回一份名单）');
  eq(fake.HOME, '/tmp', '肯定式：不误删其它环境变量');
  eq(dropHostPortEnv({ HOME: '/tmp' }), [], '肯定式：无污染时不动作');
  eq(process.env.SERVER__PORT, undefined,
    '★ 本闸门进程内已无 SERVER__PORT（SDK CLI 不会继承）');
  ok(DROPPED_HOST_ENV.every(k => k === 'SERVER__PORT'),
    '对外只打印变量名，不打印端口值', DROPPED_HOST_ENV.join(',') || '无');
  if (DROPPED_HOST_ENV.length) {
    console.log(`  · 已剔除宿主注入的：${DROPPED_HOST_ENV.join(',')}`);
  }
}

// ═══════════════════════ [4] 真发一条消息（OPC_LIVE=1） ═══════════════════════
/** 实跑层的五条判据。默认模式把它们逐条登记为「跳过」，不冒充通过。 */
const LIVE_ASSERTIONS = [
  '实跑：自定义模型 id 可从官方 models.json 读到',
  '实跑：SDK 会话初始化成功（拿到 session id / 流事件）',
  '★ 实跑：助手返回了非空正文（不是只有 init / 模型清单）',
  '★ 实跑：本轮以 result 正常收尾且 is_error 不为真',
  '★ 实跑：整条链路在护栏时间内完成（没有零产出挂起）',
];

/**
 * LIVE 失败时只带出「类别 + 短文本」，绝不整条打印流事件：
 * 流里可能有 prompt 回显、自定义端点或密钥原文。先脱敏再截断。
 */
function redactSdkError(m: Record<string, unknown>): string {
  const pick = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const cat = typeof o.category === 'string' ? `category=${o.category} ` : '';
      const msg = typeof o.message === 'string' ? o.message
        : typeof o.error === 'string' ? o.error : '';
      return cat + msg;
    }
    return '';
  };
  const raw = [pick(m.error), pick(m.errors_info), pick(m.message)].join(' | ');
  return raw
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '<redacted-key>')
    .replace(/https?:\/\/[^\s"'|,)}\]]+/g, '<redacted-url>')
    .replace(/\s+/g, ' ')
    .replace(/^[|\s]+|[|\s]+$/g, '')
    .slice(0, 240) || '（CLI 未给出可读错误文本）';
}

async function liveRun(): Promise<void> {
  const { query } = await import('@tencent-ai/agent-sdk');
  const { findDef } = await import('../server/agents/definitions.js');
  const { applyWorkbuddyProfile, activeWorkbuddyProfile } = await import(
    '../server/agents/wbProductProfile.js'
  );
  const { resolveSdkRuntime } = await import('../server/agents/sdkRuntime.js');

  // 官方数据根 = 与桌面端同一份 models.json / 产品配置快照
  const active = activeWorkbuddyProfile();
  const root = active?.detected ? active.root : path.join(os.homedir(), '.workbuddy-ai');
  const available = readWorkbuddyCustomModels(root);
  const wanted = (process.env.OPC_WB_CUSTOM_MODEL ?? '').trim();
  const picked = wanted ? available.find(m => m.id === wanted) : available[0];
  ok(Boolean(picked), LIVE_ASSERTIONS[0],
    picked ? `model=${picked.id}（共 ${available.length} 条，不打印端点/密钥）` : 'models.json 无可用条目');
  if (!picked) {
    for (const s of LIVE_ASSERTIONS.slice(1)) { skipped.push(s); }
    return;
  }

  const modelId = `custom-local:${picked.id}`;
  const spec = applyWorkbuddyProfile(findDef('workbuddy')?.sdk, 'workbuddy');
  const rt = resolveSdkRuntime(spec);
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a218-live-'));
  const budgetMs = Number(process.env.OPC_LIVE_TIMEOUT_MS || '') > 0
    ? Number(process.env.OPC_LIVE_TIMEOUT_MS)
    : 150_000;

  let text = '';
  let sawInit = false;
  let sawResult = false;
  let isError = false;
  let timedOut = false;
  let fatal = '';
  const seenTypes: string[] = [];
  let iterator: AsyncIterator<Record<string, unknown>> | null = null;

  const consume = async () => {
    const stream = query({
      prompt: '只回复两个字：收到。不要调用任何工具，不要解释。',
      options: {
        ...rt,
        cwd: TMP,
        model: modelId,
        fallbackModel: SDK_DEFAULT_MODEL,
        maxTurns: 1,
        includePartialMessages: true,
        permissionMode: 'default',
      },
    } as never);
    // 取 SDK 的**内部 generator**（不是 Query 对象）：它的 return() 才会走
    // createIterator 的 finally { cleanup() }，关掉 transport 与 CLI stdio。
    iterator = (stream as unknown as AsyncIterable<Record<string, unknown>>)[
      Symbol.asyncIterator
    ]();
    const it = iterator;
    for (;;) {
      const { value: m, done } = await it.next();
      if (done) break;
      seenTypes.push(`${String(m?.type ?? '?')}${m?.subtype ? ':' + String(m.subtype) : ''}`);
      if (m?.type === 'system' && m.subtype === 'init') sawInit = true;
      if (m?.type === 'stream_event') {
        const ev = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += String(ev.delta.text ?? '');
        }
      }
      if (m?.type === 'assistant') {
        const content = (m.message as { content?: unknown } | undefined)?.content;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          for (const b of content) {
            if ((b as { type?: string })?.type === 'text') {
              text += String((b as { text?: string }).text ?? '');
            }
          }
        }
      }
      if (m?.type === 'result') {
        sawResult = true;
        isError = Boolean((m as { is_error?: boolean }).is_error);
        if (isError) fatal = `result is_error：${redactSdkError(m)}`;
        break;
      }
      if (m?.type === 'error') {
        fatal = `CLI 返回 error 消息：${redactSdkError(m)}`;
        break;
      }
    }
  };

  const started = Date.now();
  try {
    await Promise.race([
      consume(),
      new Promise<never>((_, rej) => {
        const t = setTimeout(() => { timedOut = true; rej(new Error(`LIVE 超时 ${budgetMs}ms`)); }, budgetMs);
        t.unref?.();
      }),
    ]);
  } catch (err) {
    if (!timedOut) fatal = err instanceof Error ? err.message : String(err);
  } finally {
    // 旧版 `session?.close?.()` 是空操作：Query 根本没有 close() 方法，
    // 而手写 next() 循环 break 后不会自动 return generator，于是 CLI transport
    // 与子进程 stdio 一直挂着 —— LIVE 全绿却永不退出（被外层 timeout 杀成 124）。
    if (iterator?.return) {
      try {
        await Promise.race([
          Promise.resolve(iterator.return()).catch(() => undefined),
          new Promise<void>(resolve => {
            const t = setTimeout(resolve, 1500);
            t.unref?.();
          }),
        ]);
      } catch { /* 收口失败由汇总后的显式退出兜底 */ }
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 文件锁 */ }
  }
  const elapsed = Date.now() - started;

  ok(sawInit, LIVE_ASSERTIONS[1],
    `session init=${sawInit}, ${elapsed}ms, 事件=${seenTypes.slice(0, 8).join('>') || '无'}`);
  const clean = text.replace(/\s/g, '');
  ok(clean.length > 0, LIVE_ASSERTIONS[2],
    `正文长度=${clean.length}${clean ? ', 首16字=' + clean.slice(0, 16) : ''}`);
  ok(sawResult && !isError, LIVE_ASSERTIONS[3], `result=${sawResult}, is_error=${isError}`);
  ok(!timedOut && !fatal && elapsed < budgetMs, LIVE_ASSERTIONS[4],
    `${elapsed}ms, timeout=${timedOut}${fatal ? ', ' + fatal : ''}`);
}

group('4. 真发消息（OPC_LIVE=1）');
if (LIVE) {
  try {
    await liveRun();
  } catch (err) {
    ok(false, '★ LIVE 实跑未抛异常', err instanceof Error ? err.message : String(err));
  }
} else {
  for (const s of LIVE_ASSERTIONS) {
    skipped.push(s);
    console.log(`  ⏭ 跳过：${s}`);
  }
}

// ═══════════════════════ 汇总 + 显式退出 ═══════════════════════
const summary: string[] = [
  `\n${failures.length ? '✗' : '✓'} A218 自定义模型真发消息：${pass}/${pass + fail} 通过` +
    `，实跑跳过 ${skipped.length} 条${LIVE ? '（OPC_LIVE=1）' : '（设 OPC_LIVE=1 开启）'}`,
];
if (REQUIRE && skipped.length) {
  summary.push(`✗ OPC_LIVE_REQUIRE=1：不允许跳过 ${skipped.length} 条实跑断言`);
}
if (failures.length) {
  summary.push('失败项：', ...failures.map(f => `  - ${f}`));
}
// 成功路径也必须显式退出；否则 CLI transport 残留句柄会让进程挂着不结束。
finish(failures.length || (REQUIRE && skipped.length) ? 1 : 0, summary.join('\n') + '\n');
