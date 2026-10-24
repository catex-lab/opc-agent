/**
 * A106 已接入 CLI 三项升级的验证：
 *   ① 会话续接补全（codex exec resume / claude --resume / opencode --session）
 *   ② 优雅中止（SIGTERM → 宽限 → SIGKILL）
 *   ③ claude 双向 control 协议（权限桥接 / interrupt / stdin 生命周期）
 *
 * 三层制（与项目约定一致）：
 *   L1 纯函数   —— 真 definitions 的 argv 构建 + control 协议消息构造与分类
 *                 + terminateGracefully 的计时器逻辑（假 timers，不起进程）
 *   L2 真子进程 —— SIGTERM 优先与 SIGKILL 升级（真起 node 子进程）
 *   L3 真子进程 —— 桩二进制 + 真 CliAdapter 全链路（探针/argv/stdin/stdout/
 *                 control 应答/事件流，全部走真实管道）
 *
 * 为什么 L3 用桩而不是真 claude：本机 claude 未登录（needs-auth），真实会话
 * 起不来；而 stdin/stdout 环路已用真 claude 2.1.291 实测跑通、control 协议的
 * 信封与字段形状逐字取自本机 claude.exe 内嵌 schema（见 claude-control.ts
 * 顶部注释）。桩验的是**我方**处理逻辑，不是协议形状。
 *
 * 运行：npx tsx scripts/verify-a106-cli-upgrade.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AGENT_DEFS } from '../server/agents/definitions.js';
import { CliAdapter, terminateGracefully } from '../server/agents/adapters/cli.js';
import {
  buildStdinUserMessage,
  classifyControlMessage,
  buildControlResponse,
  buildControlError,
  buildInterruptRequest,
} from '../server/agents/adapters/claude-control.js';
import { isWindows } from '../server/agents/probe.js';
import type { SendContext } from '../server/agents/types.js';
import type { AgentEvent } from '../server/agents/types.js';

let total = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail?: string): void {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    JSON.stringify(actual) === JSON.stringify(expected)
      ? undefined
      : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  );
}

/**
 * 平台性跳过：Windows 没有 POSIX 信号语义（SIGTERM 被映射成
 * TerminateProcess），相关断言在这台机器上无法验。算「跳过」而不是
 * 「通过」—— 把跳过往通过里算是自欺欺人。
 */
function skip(label: string, reason: string): void {
  console.log(`  ⊘ ${label} — 跳过：${reason}`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 夹具目录放项目内 .tmp/（已 gitignore），不放 os.tmpdir() —— 见 A99 的教训 */
const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'a106-'));
const node = process.execPath;

// 看门狗：任何用例把流程挂住（该死等没死等）都要有声地失败，而不是无声挂起
const watchdog = setTimeout(() => {
  console.error('A106 看门狗超时（120s）—— 有链路挂起了');
  process.exit(2);
}, 120_000);
watchdog.unref();

function findDef(id: string) {
  const def = AGENT_DEFS.find(d => d.descriptor.id === id);
  if (!def) throw new Error(`定义表里找不到 ${id}`);
  return def;
}

const codexDef = findDef('codex');
const claudeDef = findDef('claude');
const opencodeDef = findDef('opencode');

/** 最小 SendContext */
function ctx(extra: Partial<SendContext>): SendContext {
  return { sessionId: 'a106', prompt: 'P', ...extra } as SendContext;
}

try {
  // ── L1-1 argv：codex 续接（exec resume 子命令，位置参数 SESSION_ID 在前）──
  console.log('\nA106-1 codex resume argv');
  {
    const fresh = codexDef.cli!.buildArgs('P', ctx({}));
    ok(fresh[0] === 'exec' && !fresh.includes('resume'), '无令牌时仍是 exec 一次性形态');
    ok(fresh[fresh.length - 1] === 'P', 'prompt 收尾');

    const resumed = codexDef.cli!.buildArgs('P', ctx({ resumeToken: 'sess-1', model: 'gpt-5-codex' }));
    eq(resumed, ['exec', 'resume', '--skip-git-repo-check', '--json', '-m', 'gpt-5-codex', 'sess-1', 'P'],
      '有令牌时切到 exec resume 子命令（选项在前、位置参数在后）');

    const resumedNoModel = codexDef.cli!.buildArgs('P', ctx({ resumeToken: 'sess-2' }));
    eq(resumedNoModel, ['exec', 'resume', '--skip-git-repo-check', '--json', 'sess-2', 'P'],
      '无模型时不塞 -m');

    // resume 子命令的 --help 里没有 -s/--sandbox：续接会话沿用原沙箱，
    // 传了只会报错。这条断言钉住「不传」。
    ok(!resumed.some(a => a === '-s' || a === '--sandbox'), 'resume 不传 sandbox（子命令不支持）');
  }

  // ── L1-2 argv：claude 续接 + 双向flag位置 ──────────────────────────────
  console.log('\nA106-2 claude resume / bidi argv');
  {
    const oneShot = claudeDef.cli!.buildArgs('P', ctx({ allowedTools: ['file'] as never }));
    ok(!oneShot.includes('--input-format'), '一次性模式不发 --input-format');
    ok(oneShot.includes('--allowedTools'), '一次性模式仍用 --allowedTools 预授权');

    const resumed = claudeDef.cli!.buildArgs('P', ctx({ resumeToken: 'sess-9', allowedTools: ['file'] as never }));
    const ri = resumed.indexOf('--resume');
    const ai = resumed.indexOf('--allowedTools');
    ok(ri >= 0 && resumed[ri + 1] === 'sess-9', '--resume 带上令牌');
    ok(ri >= 0 && ai >= 0 && ri < ai, '--resume 在 variadic 的 --allowedTools 之前（否则被吃掉）');

    const bidi = claudeDef.cli!.buildArgs('P', ctx({ inputFormat: 'stream-json', allowedTools: ['file'] as never }));
    const ii = bidi.indexOf('--input-format');
    ok(ii >= 0 && bidi[ii + 1] === 'stream-json', '双向模式发 --input-format stream-json');
    ok(!bidi.includes('--allowedTools'), '双向模式不再预授权 --allowedTools（否则绕过权限门禁）');
    ok(bidi.includes('--output-format') && bidi.includes('--verbose'), '输出侧参数保持');
  }

  // ── L1-3 argv：opencode 续接 ───────────────────────────────────────────
  console.log('\nA106-3 opencode resume argv');
  {
    const fresh = opencodeDef.cli!.buildArgs('P', ctx({}));
    ok(!fresh.includes('--session'), '无令牌时不带 --session');

    const resumed = opencodeDef.cli!.buildArgs('P', ctx({ resumeToken: 'sess-3', model: 'zai/glm-4.7' }));
    const si = resumed.indexOf('--session');
    ok(si >= 0 && resumed[si + 1] === 'sess-3', '--session 带上令牌');
    ok(si < resumed.length - 1 && resumed[resumed.length - 1] === 'P', 'prompt 仍在收尾');
    ok(claudeDef.cli!.bidi === true, 'claude 条目已开 bidi（协议开关生效）');
  }

  // ── L1-4 control 协议纯函数 ────────────────────────────────────────────
  console.log('\nA106-4 claude control 协议消息');
  {
    const userMsg = JSON.parse(buildStdinUserMessage('hi'));
    eq(userMsg, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
      session_id: 'default',
    }, 'stdin 用户消息形状（真 claude 实测接受）');

    eq(
      classifyControlMessage({
        type: 'control_request',
        request_id: 'r1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu' },
      }),
      { kind: 'can_use_tool', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu' },
      'can_use_tool 分类'
    );
    eq(
      classifyControlMessage({ type: 'control_request', request_id: 'r2', request: { subtype: 'interrupt' } }),
      { kind: 'interrupt', requestId: 'r2' },
      'interrupt 分类'
    );
    eq(
      classifyControlMessage({ type: 'control_request', request_id: 'r3', request: { subtype: 'request_user_dialog' } }),
      { kind: 'unknown', requestId: 'r3', subtype: 'request_user_dialog' },
      '未实现 subtype 归 unknown（调用方回 error，不挂起）'
    );
    ok(classifyControlMessage({ type: 'assistant', message: {} }) === null, '普通事件不误判为控制消息');
    ok(classifyControlMessage({ type: 'control_request' }) === null, '缺 request_id 的控制消息丢弃');

    eq(JSON.parse(buildControlResponse('r1', { behavior: 'allow' })), {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow' } },
    }, '成功应答信封');
    eq(JSON.parse(buildControlError('r1', 'x')), {
      type: 'control_response',
      response: { subtype: 'error', request_id: 'r1', error: 'x' },
    }, '失败应答信封');
    const ir = JSON.parse(buildInterruptRequest());
    ok(ir.type === 'control_request' && ir.request?.subtype === 'interrupt' && typeof ir.request_id === 'string',
      'interrupt 请求信封');
  }

  // ── L1-5 terminateGracefully（假 timers，不起进程）──────────────────────
  console.log('\nA106-5 terminateGracefully 计时器逻辑');
  {
    type Fake = { calls: string[]; advance: (ms: number) => void };
    const makeFake = (): { timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }; fake: Fake } => {
      const calls: string[] = [];
      let now = 0;
      const scheduled: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
      const timers = {
        setTimeout: ((fn: () => void, ms: number) => {
          scheduled.push({ at: now + ms, fn, cleared: false });
          return (scheduled.length - 1) as unknown as NodeJS.Timeout;
        }) as unknown as typeof setTimeout,
        clearTimeout: ((h: unknown) => {
          const i = h as number;
          if (scheduled[i]) scheduled[i].cleared = true;
        }) as unknown as typeof clearTimeout,
      };
      return {
        timers,
        fake: {
          calls,
          advance: (ms: number) => {
            now += ms;
            for (const s of scheduled) {
              if (!s.cleared && s.at <= now) {
                s.cleared = true;
                s.fn();
              }
            }
          },
        },
      };
    };

    // 场景 1：SIGTERM 先发，宽限到头才升级
    const f1 = makeFake();
    const c1 = { killed: false, kill: (sig?: string) => { f1.fake.calls.push(sig ?? 'SIGTERM'); return true; } };
    const cancel1 = terminateGracefully(c1 as never, 1000, f1.timers);
    eq(f1.fake.calls, ['SIGTERM'], '先发 SIGTERM');
    f1.fake.advance(999);
    eq(f1.fake.calls, ['SIGTERM'], '宽限内不升级');
    f1.fake.advance(1);
    eq(f1.fake.calls, ['SIGTERM', 'SIGKILL'], '宽限到头升级 SIGKILL');
    cancel1();

    // 场景 2：进程自己退了 → cancel 阻止 SIGKILL
    const f2 = makeFake();
    const c2 = { killed: false, kill: (sig?: string) => { f2.fake.calls.push(sig ?? 'SIGTERM'); return true; } };
    const cancel2 = terminateGracefully(c2 as never, 1000, f2.timers);
    cancel2();
    f2.fake.advance(10_000);
    eq(f2.fake.calls, ['SIGTERM'], 'cancel 之后不再补 SIGKILL');

    // 场景 3：已经死了 → 一个信号都不发
    const f3 = makeFake();
    const c3 = { killed: true, kill: (sig?: string) => { f3.fake.calls.push(sig ?? 'SIGTERM'); return true; } };
    terminateGracefully(c3 as never, 1000, f3.timers);
    f3.fake.advance(10_000);
    eq(f3.fake.calls, [], 'killed 进程零信号');
  }

  // ── L2 真子进程：SIGTERM 优先 / SIGKILL 升级 ───────────────────────────
  console.log('\nA106-6 真实子进程终止链');
  {
    // 优雅路径：子进程自己处理 SIGTERM 并以 7 退出
    const graceful = spawn(node, ['-e', "process.on('SIGTERM',()=>process.exit(7));setInterval(()=>{},1000)"]);
    const cancelG = terminateGracefully(graceful, 1500);
    const [codeG] = (await once(graceful, 'exit')) as [number | null, NodeJS.Signals | null];
    cancelG();
    ok(true, '优雅子进程在宽限内退出');
    if (isWindows) skip('POSIX 下子进程收到的是 SIGTERM（exit 7）', 'Windows 无 POSIX 信号语义');
    else ok(codeG === 7, 'POSIX 下子进程收到的是 SIGTERM（exit 7）', `code=${codeG}`);

    // 顽固路径：忽略 SIGTERM，只能被 SIGKILL 抬走
    const stubborn = spawn(node, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
    const t0 = Date.now();
    terminateGracefully(stubborn, 1500);
    const [codeS, sigS] = (await once(stubborn, 'exit')) as [number | null, NodeJS.Signals | null];
    const elapsed = Date.now() - t0;
    ok(elapsed < 1500 + 4000, '顽固子进程在宽限+余量内被抬走', `${elapsed}ms`);
    if (isWindows) skip('POSIX 下最终信号是 SIGKILL', 'Windows 无 POSIX 信号语义');
    else ok(sigS === 'SIGKILL', 'POSIX 下最终信号是 SIGKILL', `signal=${sigS} code=${codeS}`);
  }

  // ── L3 桩二进制 + 真 CliAdapter 全链路 ─────────────────────────────────
  console.log('\nA106-7 桩 claude 双向全链路');
  {
    // 桩的行为：首轮用户消息 → init + can_use_tool 权限请求；
    // 收到 control_response 后按 allow/deny 分流，再补 result 行收尾。
    // 每个收到的 stdin 行都追加进 STUB_LOG，供断言信封形状。
    const STUB_SRC = [
      "'use strict';",
      "const fs = require('fs');",
      "const logPath = process.env.STUB_LOG || '';",
      "const log = (o) => { try { fs.appendFileSync(logPath, JSON.stringify(o) + '\\n'); } catch (e) {} };",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "if (process.argv.includes('--version')) { console.log('9.9.9-stub'); process.exit(0); }",
      "const SESSION = 'stub-session-0001';",
      "let turn = 0;",
      "let pending = null;",
      "process.stdin.setEncoding('utf8');",
      "let buf = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk;",
      "  let i;",
      "  while ((i = buf.indexOf('\\n')) >= 0) {",
      "    const line = buf.slice(0, i).trim();",
      "    buf = buf.slice(i + 1);",
      "    if (!line) continue;",
      "    let msg = null;",
      "    try { msg = JSON.parse(line); } catch (e) { continue; }",
      "    log({ dir: 'in', msg: msg });",
      "    if (msg.type === 'user') onUser();",
      "    else if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'interrupt') {",
      "      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });",
      "    } else if (msg.type === 'control_response' && pending) {",
      "      const fn = pending; pending = null; fn(msg);",
      "    }",
      "  }",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
      "process.on('SIGTERM', () => { log({ dir: 'signal', sig: 'SIGTERM' }); setTimeout(() => process.exit(0), 300); });",
      "function onUser() {",
      "  turn += 1;",
      "  if (turn > 1) {",
      "    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second turn ok' }] }, session_id: SESSION });",
      "    send({ type: 'result', subtype: 'success', is_error: false, result: 'second turn ok', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.001, session_id: SESSION });",
      "    return;",
      "  }",
      "  send({ type: 'system', subtype: 'init', session_id: SESSION, model: 'stub-model', tools: ['Bash'], mcp_servers: [] });",
      "  send({ type: 'control_request', request_id: 'stub-req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: 'stub-tu-1' } });",
      "  pending = (msg) => {",
      "    const r = msg.response || {};",
      "    const behavior = r.subtype === 'success' ? (r.response || {}).behavior : 'error';",
      "    if (behavior === 'allow') {",
      "      send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stub-tu-1', content: 'hi' }] }, session_id: SESSION });",
      "      send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'stub done' }] }, session_id: SESSION });",
      "    } else {",
      "      send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'stub denied' }] }, session_id: SESSION });",
      "    }",
      "    send({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.001, session_id: SESSION });",
      "  };",
      "}",
    ].join('\n');

    // 后缀必须是 .cjs：项目 package.json 是 "type": "module"，
    // .tmp/ 下的 .js 会被 Node 当 ESM 跑，require 直接未定义（实测秒崩）。
    // resolveLaunchTarget 的 /\.(c|m)?js$/ 认识 .cjs，探针链路不受影响。
    const stubPath = path.join(root, 'stub-claude.cjs');
    fs.writeFileSync(stubPath, STUB_SRC, 'utf8');

    /** 真 claude 定义 + 只换 bin —— buildArgs/bidi/解析全部沿用真链路 */
    const stubDef = { ...claudeDef, cli: { ...claudeDef.cli!, bin: stubPath } };

    const readLog = (logPath: string): Array<{ dir: string; msg?: Record<string, unknown>; sig?: string }> => {
      try {
        return fs
          .readFileSync(logPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l) as { dir: string; msg?: Record<string, unknown>; sig?: string });
      } catch {
        return [];
      }
    };

    /**
     * 跑一轮桩会话。onPerm 在收到 permission_request 时被调用
     * （同步调用 resolvePermission，与真实 HTTP 链路同时序）。
     */
    async function drive(
      name: string,
      sendCtx: Partial<SendContext>,
      onPerm?: (adapter: CliAdapter, requestId: string) => void
    ): Promise<{ events: AgentEvent[]; log: Array<{ dir: string; msg?: Record<string, unknown>; sig?: string }> }> {
      const logPath = path.join(root, `log-${name}.jsonl`);
      fs.rmSync(logPath, { force: true });
      process.env.STUB_LOG = logPath; // childEnv 继承 process.env，spawn 时读取
      const adapter = new CliAdapter(stubDef);
      const events: AgentEvent[] = [];
      for await (const ev of adapter.send(ctx(sendCtx))) {
        events.push(ev);
        if (ev.type === 'permission_request' && onPerm) onPerm(adapter, ev.requestId);
      }
      delete process.env.STUB_LOG;
      if (process.env.A106_DEBUG) {
        console.log(`  [debug ${name}] events=${JSON.stringify(events)}`);
        console.log(`  [debug ${name}] log=${JSON.stringify(readLog(logPath))}`);
      }
      return { events, log: readLog(logPath) };
    }

    // 用例 A：用户放行 → 全链路（init/权限弹窗/allow 应答/工具结果/用量）
    {
      const { events, log } = await drive('allow', {}, (adapter, requestId) => {
        adapter.resolvePermission(requestId, { behavior: 'allow' });
      });
      const types = events.map(e => e.type);
      ok(types.includes('init'), 'A: 收到 init');
      ok(events.some(e => e.type === 'init' && (e as { resumeToken?: string }).resumeToken === 'stub-session-0001'),
        'A: init 带上续接令牌');
      ok(types.includes('permission_request'), 'A: 权限请求弹给前端');
      ok(types.includes('tool_result'), 'A: allow 之后工具结果回来');
      ok(events.some(e => e.type === 'text' && (e as { content?: string }).content === 'stub done'), 'A: 文本事件');
      const done = events.find(e => e.type === 'done') as { tokens?: number; cost?: number } | undefined;
      ok(done != null && done.tokens === 5 && done.cost === 0.001, 'A: done 带上用量', JSON.stringify(done));

      const userIn = log.find(l => l.dir === 'in' && (l.msg as { type?: string })?.type === 'user');
      const um = userIn?.msg as { session_id?: string; parent_tool_use_id?: unknown } | undefined;
      ok(um != null && um.session_id === 'default' && um.parent_tool_use_id === null, 'A: stdin 用户消息形状');
      const resp = log.find(l => l.dir === 'in' && (l.msg as { type?: string })?.type === 'control_response');
      const r = (resp?.msg as { response?: { subtype?: string; request_id?: string; response?: Record<string, unknown> } })?.response;
      ok(
        r?.subtype === 'success' &&
          r?.request_id === 'stub-req-1' &&
          (r?.response as { behavior?: string })?.behavior === 'allow' &&
          (r?.response as { toolUseID?: string })?.toolUseID === 'stub-tu-1' &&
          JSON.stringify((r?.response as { updatedInput?: unknown })?.updatedInput) === JSON.stringify({ command: 'echo hi' }),
        'A: control_response 信封逐字段正确',
        JSON.stringify(resp?.msg)
      );
    }

    // 用例 B：用户拒绝 → deny 语义透传到 CLI
    {
      const { events, log } = await drive('deny', {}, (adapter, requestId) => {
        adapter.resolvePermission(requestId, { behavior: 'deny', message: '用户拒绝了此操作' });
      });
      ok(events.some(e => e.type === 'text' && (e as { content?: string }).content === 'stub denied'), 'B: deny 后文本回来');
      const resp = log.find(l => l.dir === 'in' && (l.msg as { type?: string })?.type === 'control_response');
      const r = (resp?.msg as { response?: { subtype?: string; response?: Record<string, unknown> } })?.response;
      ok(
        r?.subtype === 'success' && (r?.response as { behavior?: string })?.behavior === 'deny',
        'B: control_response 为 deny',
        JSON.stringify(resp?.msg)
      );
    }

    // 用例 C：场景白名单为空 → 不弹窗，直接 deny（白名单先于一切判断）
    {
      const { events, log } = await drive('whitelist', { allowedTools: [] as never });
      ok(!events.some(e => e.type === 'permission_request'), 'C: 白名单为空时不打扰用户');
      const resp = log.find(l => l.dir === 'in' && (l.msg as { type?: string })?.type === 'control_response');
      const r = (resp?.msg as { response?: { response?: Record<string, unknown> } })?.response;
      const msg = (r?.response as { message?: string })?.message;
      ok((r?.response as { behavior?: string })?.behavior === 'deny' && typeof msg === 'string' && msg.length > 0,
        'C: 自动 deny 且带原因', JSON.stringify(resp?.msg));
    }

    // 用例 D：bypassPermissions → 不弹窗直接放行
    {
      const { events, log } = await drive('bypass', { permissionMode: 'bypassPermissions' });
      ok(!events.some(e => e.type === 'permission_request'), 'D: bypass 模式不弹窗');
      const resp = log.find(l => l.dir === 'in' && (l.msg as { type?: string })?.type === 'control_response');
      const r = (resp?.msg as { response?: { response?: Record<string, unknown> } })?.response;
      ok((r?.response as { behavior?: string })?.behavior === 'allow', 'D: 自动 allow');
    }

    // 用例 E：中止 → interrupt 控制请求 + 进程终止，不挂起
    {
      const logPath = path.join(root, 'log-abort.jsonl');
      fs.rmSync(logPath, { force: true });
      process.env.STUB_LOG = logPath;
      const ac = new AbortController();
      ac.abort(); // 发送前就中止 —— linkAbort 必须补得上
      const adapter = new CliAdapter(stubDef);
      const events: AgentEvent[] = [];
      for await (const ev of adapter.send(ctx({ signal: ac.signal }))) events.push(ev);
      delete process.env.STUB_LOG;
      ok(events.every(e => e.type === 'init'), 'E: 中止后只回收 init，不挂起', JSON.stringify(events.map(e => e.type)));
      // interrupt 的**写入**在 Windows 上不可观测：SIGTERM 被映射成
      // TerminateProcess，桩进程在 Node 启动完之前就被抬走，stdin 里的行
      // 没有机会被读（信封形状本身已在 L1-4 验过）。POSIX 上桩子有机会
      // 处理完管道内容再退，可以真验。
      await sleep(600); // 桩的 SIGTERM 处理延迟 300ms 退出，等它把日志落盘
      const log = readLog(logPath);
      const irq = log.find(
        l => l.dir === 'in' && (l.msg as { request?: { subtype?: string } })?.request?.subtype === 'interrupt'
      );
      if (isWindows) skip('E: 中止时写出 interrupt 控制请求', 'Windows 上 SIGTERM=TerminateProcess，桩进程来不及读 stdin');
      else ok(irq != null, 'E: 中止时写出 interrupt 控制请求', JSON.stringify(irq?.msg));
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nA106 结果：${total - failures.length}/${total} 通过`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
