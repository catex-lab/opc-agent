/**
 * L0/L1 Agent 接入验证脚本。
 *
 * 这里守的是两条**改错了也不会报错、但 Agent 直接失效**的链路：
 *
 *   L0  Cursor —— 它的 `cursor-agent` 是 `.cmd → ps1 → node index.js`
 *                三层垫片，解析错一步就从"可用"变成"无法解析垫片"。
 *                另外它的参数必须来自本机实测：`cursor`（IDE 启动器）
 *                和 `cursor-agent`（Agent CLI）是两个东西，取错就只是
 *                一个"能打开 IDE 的按钮"。
 *
 *   L1  HTTP   —— 三种方言的 SSE 行结构各不相同，靠读代码看不出对错。
 *                所以这里起一个本地 HTTP server，喂**逐字抄自真实输出**
 *                的样本，真跑一遍流式解析。
 *
 * 运行：npx tsx scripts/verify-agent-access.ts
 */
// ⚠️ 必须是第一个 import：它把 OPC_DATA_DIR 指到临时目录，否则下面这条链
// （adapters/sdk → server/memory → server/db）一加载就打开用户真实的 data/chat.db。
import './lib/temp-data-dir.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { AGENT_DEFS, findDef, type AgentDefinition } from '../server/agents/definitions.js';
import { createProvider } from '../server/agents/adapters/index.js';
import { HttpAdapter } from '../server/agents/adapters/http.js';
import { CliAdapter } from '../server/agents/adapters/cli.js';
import { canEnforce } from '../server/agents/permissions.js';
import {
  findExecutable,
  resolvePowerShellShim,
  resolveAnyLaunchTarget,
  expandPath,
} from '../server/agents/probe.js';
import type { AgentEvent } from '../server/agents/types.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq<T>(actual: T, expected: T, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

/** 收集 send() 的全部事件 */
async function collect(
  iter: AsyncIterable<AgentEvent>,
  timeoutMs = 15000
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => {
      throw new Error('collect 超时');
    }, timeoutMs);
    for await (const ev of iter) out.push(ev);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return out;
}

// ── 1. L0：定义表层面的不变量 ───────────────────────────────────
{
  const cursor = findDef('cursor');
  ok(!!cursor, 'cursor 定义应存在');
  eq(cursor?.descriptor.kind, 'cli', 'cursor 应为 cli（曾经的 mock 是误判）');
  ok(!!cursor?.cli, 'cursor 应带 cli 调用规格');
  ok(!cursor?.unsupportedReason, 'cursor 不应再有 unsupportedReason（"仅 GUI" 是错的）');
  ok(cursor?.descriptor.vendor === 'Cursor', 'cursor 应声明 vendor');
  eq(cursor?.cli?.bin, 'cursor-agent', 'cursor 的 bin 必须是 cursor-agent，不是 cursor');
  ok(
    !!cursor?.descriptor.capabilities?.includes('code') &&
      !!cursor?.descriptor.capabilities?.includes('tools'),
    'cursor 有完整工具集，应标 code + tools'
  );
  ok(!!cursor?.extraPaths?.length, 'cursor-agent 装在 PATH 之外，需要 extraPaths');
}

{
  const qoder = findDef('qoder');
  ok(!!qoder, 'qoder 定义应存在');
  // A30（2026-10-19）：Qoder CLI 已在本机装上并实测通过，接入方式从 mock 改为 cli。
  //
  // 这条断言的方向与 A28 相反 —— 当时它守的是「没装就别假装能接」，
  // 现在守的是「装了就必须真的接上」。两者是同一条原则的两面：
  // 状态必须与事实一致，不能靠文档说辞。
  eq(qoder?.descriptor.kind, 'cli', 'qoder 已接入 CLI（kind=cli）');
  ok(!qoder?.unsupportedReason, 'qoder 不再有 unsupportedReason（已可用）', `当前: ${qoder?.unsupportedReason}`);
  eq(qoder?.cli?.bin, 'qodercli', 'qoder 的二进制名是 qodercli（`qoder` 只是 IDE 启动器）');
  ok(
    !!qoder?.extraPaths?.some(p => /\.qoder[\\/]bin[\\/]qodercli/i.test(p)),
    'qodercli 装在 PATH 之外，需要 extraPaths 指向 ~/.qoder/bin/qodercli'
  );
  ok(
    !!qoder?.authFiles?.some(f => /\.qoder\/\.auth/.test(f)),
    'qoder 的登录态在 ~/.qoder/.auth 下（probe 据此判已登录）'
  );

  const args = qoder?.cli?.buildArgs('PROMPT', {
    sessionId: 's', prompt: 'PROMPT', cwd: 'C:/tmp', permissionMode: 'plan',
  } as any) ?? [];
  ok(args.includes('-p'), 'qoder buildArgs 带 headless 开关 -p', args.join(' '));
  ok(
    args.join(' ').includes('--permission-mode dont_ask'),
    'qoder 的 plan 档映射为 dont_ask（不询问即拒绝，近似只读）',
    args.join(' ')
  );
  ok(args[args.length - 1] === 'PROMPT', '提示词作为位置参数放在最后（-p 是开关，不是「-p 提示词」）');
}

// ── 1b. Qoder CLI 通道（曾走 SDK，2026-10-30 移除）────────────────
{
  const qoder = findDef('qoder');
  ok(!!qoder, 'qoder 定义应存在');

  // 只走 CLI：没有 sdk 规格，工厂产出 CliAdapter
  ok(!qoder?.sdk, 'qoder 不再声明 SDK 规格');
  ok(!!qoder?.cli, 'qoder 保留 cli 规格');
  eq(qoder?.cli?.bin, 'qodercli', 'CLI 通道指向 qodercli');

  const p = qoder ? createProvider(qoder) : null;
  ok(p instanceof CliAdapter, 'createProvider(qoder) 产出 CliAdapter', p?.constructor.name);
  ok(p?.descriptor.id === 'qoder', '适配器的 descriptor 没被换掉');

  // plan 不再强制：CLI 没有只读沙箱，不能记为可强制
  ok(!canEnforce('qoder', 'plan'), 'qoder 的 plan 档不再记为可强制（CLI 无沙箱）');
  ok(canEnforce('qoder', 'bypassPermissions'), 'qoder 的 bypassPermissions 档仍记为可强制');

  // 国内版：独立条目、独立账号体系、独立 CLI 名
  const cn = findDef('qoder-cn');
  ok(!!cn, 'qoder-cn 条目存在');
  eq(cn?.descriptor.kind, 'cli', 'qoder-cn 也是 cli');
  eq(cn?.cli?.bin, 'qoderclicn', 'qoder-cn 的二进制名是 qoderclicn');
  ok(!cn?.sdk, 'qoder-cn 不再声明 SDK 规格');
  eq(cn?.descriptor.region, 'cn', 'qoder-cn 的 region 是 cn');
  eq(cn?.descriptor.authScope, 'qoder.cn', 'qoder-cn 用独立账号体系');
  ok(
    cn?.descriptor.authScope !== qoder?.descriptor.authScope,
    'qoder 与 qoder-cn 的 authScope 不同（否则界面会以为额度互通）'
  );

  // 两个条目的 CLI 参数**必须同构**：CN 没有账号可测，一旦复制成两份，
  // 「改了国际版忘了国内版」这种偏差永远发现不了。
  const probeCtx = {
    sessionId: 's', prompt: 'P', cwd: 'C:/tmp', permissionMode: 'plan',
  } as any;
  const intlArgs = qoder?.cli?.buildArgs('P', probeCtx) ?? [];
  const cnArgs = cn?.cli?.buildArgs('P', probeCtx) ?? [];
  eq(cnArgs, intlArgs, 'qoder-cn 与 qoder 的 argv 完全一致（同一份 buildArgs）');
}

{
  // 全局：id 不许重复（重复会让 registry 后一个覆盖前一个，静默丢一个 Agent）
  const ids = AGENT_DEFS.map(d => d.descriptor.id);
  eq(new Set(ids).size, ids.length, `Agent id 不应重复（共 ${ids.length} 条）`);
}

// ── 2. L0：cursor 的参数构造与行解析（全部基于本机实测） ─────────
{
  const def = findDef('cursor')!;
  const spec = def.cli!;
  const build = (prompt: string, ctx: Record<string, unknown> = {}) =>
    spec.buildArgs(prompt, {
      sessionId: 's1',
      prompt,
      ...ctx,
    } as Parameters<typeof spec.buildArgs>[1]);

  // 基本开关
  const base = build('你好');
  ok(base.includes('-p'), '必须带 -p（非交互）');
  ok(base.includes('stream-json'), '输出格式应为 stream-json');
  ok(base.includes('--trust'), '必须带 --trust，否则实测直接拒绝执行');
  eq(base[base.length - 1], '你好', 'prompt 必须是最后一个参数');

  // 权限模式
  ok(build('x', { permissionMode: 'plan' }).includes('plan'), 'plan 模式应映射到 --mode plan');
  ok(
    build('x', { permissionMode: 'bypassPermissions' }).includes('-f'),
    'bypassPermissions 应映射到 -f'
  );
  // --mode 只有 plan/ask 两个取值，default 时不该传，否则 CLI 直接报错退出
  const def0 = build('x', { permissionMode: 'default' });
  ok(!def0.includes('--mode'), 'default 模式不应传 --mode（该开关只有 plan/ask 两个合法值）');

  // 续接令牌
  ok(
    build('x', { resumeToken: 'abc-123' }).includes('abc-123'),
    '有 resumeToken 时应传给 --resume'
  );

  // 工作目录
  ok(build('x', { cwd: 'D:/proj' }).includes('D:/proj'), 'cwd 应映射到 --workspace');

  // 注入：prompt 里的 shell 元字符必须原样待在 argv 里，绝不被拼成命令
  const evil = 'x && calc && "; rm -rf /" `whoami` $ENV:PATH';
  const evilArgs = build(evil);
  eq(
    evilArgs[evilArgs.length - 1],
    evil,
    '含 shell 元字符的 prompt 必须作为单个 argv 元素原样传递'
  );

  // 行解析：下面几行结构逐字抄自 2026-10-18 的真实 CLI 输出，
  // 只把 cwd 换成了中性路径（原文是维护者本机目录）。
  const initLine =
    '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"D:\\\\work\\\\demo","session_id":"8a5090de-4b76-48a0-bedd-e46eb5d9f76a","model":"Auto","permissionMode":"default"}';
  const assistantLine =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"session_id":"8a5090de-4b76-48a0-bedd-e46eb5d9f76a"}';
  const userLine =
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"说OK两个字"}]},"session_id":"8a5090de-4b76-48a0-bedd-e46eb5d9f76a"}';
  const errorResult =
    '{"type":"result","subtype":"error","is_error":true,"result":"模型不可用","session_id":"x"}';

  eq(
    spec.extractResumeToken!(JSON.parse(initLine)),
    '8a5090de-4b76-48a0-bedd-e46eb5d9f76a',
    'extractResumeToken 应从 system/init 行取 session_id'
  );
  // `mapLine` 的返回类型是 `AgentEvent | AgentEvent[] | null`（一行可能拆成多个事件：
  // 文本 + 工具开始 / 工具结果）。适配器统一用 `Array.isArray(mapped) ? mapped : [mapped]`
  // 归一 —— 所以断言也要按「事件序列」比，而不是假定单个对象。
  // 语义没变：assistant 行必须产出且只产出一个 text 事件，内容就是 OK。
  const asEvents = (v: AgentEvent | AgentEvent[] | null | undefined): AgentEvent[] =>
    v == null ? [] : Array.isArray(v) ? v : [v];
  eq(asEvents(spec.mapLine!(JSON.parse(assistantLine))), [{ type: 'text', content: 'OK' }],
    'assistant 行应映射成 text 事件（允许数组形态）');
  eq(asEvents(spec.mapLine!(JSON.parse(userLine))), [], 'user 行应被丢弃（否则输入显示两遍）');
  const errEv = asEvents(spec.mapLine!(JSON.parse(errorResult)))[0];
  ok(errEv?.type === 'error' && 'message' in errEv, 'is_error 的 result 行应转成 error 事件');
  // 归一逻辑本身也要钉住：删掉它，多事件形态（工具行）就会被当成单个对象处理
  ok(
    fs
      .readFileSync('server/agents/adapters/cli.ts', 'utf8')
      .includes('Array.isArray(mapped) ? mapped : [mapped]'),
    'CLI 适配器必须把 mapLine 的单对象/数组两种形态归一'
  );
}

// ── 3. L0：PowerShell 垫片解析（本机有 cursor-agent 才可测） ─────
{
  const def = findDef('cursor')!;
  const binPath = findExecutable(def.cli!.bin, (def.extraPaths ?? []).map(expandPath));
  if (!binPath) {
    console.log('  (跳过垫片解析：本机未找到 cursor-agent)');
  } else {
    const target = resolvePowerShellShim(binPath);
    ok(!!target, 'resolvePowerShellShim 应能解析 cursor-agent 的垫片', `binPath=${binPath}`);
    if (target) {
      ok(fs.existsSync(target.command), '解析出的 node.exe 应存在', target.command);
      ok(
        target.prefixArgs.length === 1 && fs.existsSync(target.prefixArgs[0]!),
        '解析出的 index.js 应存在',
        target.prefixArgs[0]
      );
      ok(/node\.exe$/i.test(target.command), 'command 应是 node.exe', target.command);
      ok(/index\.js$/i.test(target.prefixArgs[0] ?? ''), '入口应是 index.js');
      // resolveAnyLaunchTarget 必须给出同一结论，否则 CliAdapter 走的是另一条路
      const any = resolveAnyLaunchTarget(binPath);
      eq(any.command, target.command, 'resolveAnyLaunchTarget 应优先选中 PowerShell 解析结果');
      eq(any.prefixArgs, target.prefixArgs, 'resolveAnyLaunchTarget 的前置参数应与之一致');
    }
  }
}

// ── 4. L0：CliAdapter 能把它当成可用 Agent ──────────────────────
{
  const def = findDef('cursor')!;
  const provider = createProvider(def);
  ok(provider instanceof CliAdapter, 'cursor 应创建出 CliAdapter');
  const st = await provider.probe();
  ok(
    st.availability !== 'unsupported' && st.availability !== 'not-installed',
    'cursor 探测结果不应是"垫片解析失败/未安装"（那说明 L0 白做）',
    `availability=${st.availability} message=${st.message}`
  );
}

// ── 5. L1：HTTP 定义层面的不变量 ────────────────────────────────
{
  for (const d of AGENT_DEFS) {
    if (d.descriptor.kind !== 'http') continue;
    ok(!!d.http, `${d.descriptor.id} 声明了 http 但缺少 http 规格`);
    // HTTP 路径没有工具调用循环，标了就是谎称
    const bad = d.descriptor.capabilities.filter(c => c !== 'chat' && c !== 'write');
    eq(bad, [], `${d.descriptor.id} 是模型直连，capabilities 只能是 chat/write`);
    ok(!!d.authEnvs?.length, `${d.descriptor.id} 必须声明 authEnvs（否则永远 needs-auth）`);
    ok(!!d.http?.host, `${d.descriptor.id} 必须声明 host（可达性探测要用）`);
    ok(!!d.http?.defaultModel, `${d.descriptor.id} 应给一个默认模型（否则每次都得手填）`);
  }

  for (const id of ['doubao', 'kimicode']) {
    const d = findDef(id)!;
    eq(d.descriptor.kind, 'http', `${id} 应为 http 接入`);
    ok(!!d.http, `${id} 应有 http 规格`);
    eq(d.http?.dialect, 'openai', `${id} 应走 OpenAI 兼容方言`);
  }
}

// ── 5b. Logo 契约：icon 必须在 AGENT_LOGOS 里有对应条目 ──────────
//
// 为什么守这条：`getAgentLogo()` 取不到就静默退回「首字母色块」，
// 不会报错、不会警告 —— 新增 Agent 时漏了 logo，只有人眼能发现。
// 这里直接读前端源码里的 key 表（不能 import：那个文件 import 了 png 资源，
// Node 侧解析不了），把「定义表的 icon」与「logo 表的 key」对上。
{
  const src = fs.readFileSync(new URL('../src/agentLogos.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('AGENT_LOGOS'), src.indexOf('/** 按 key 取 logo'));
  const keys = new Set([...body.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)].map(m => m[1]));
  ok(keys.size >= 10, 'AGENT_LOGOS 解析出条目', `${keys.size} 个`);

  for (const d of AGENT_DEFS) {
    const icon = d.descriptor.icon;
    if (!icon) continue;
    ok(keys.has(icon), `${d.descriptor.id} 的 icon「${icon}」在 AGENT_LOGOS 里存在`);
  }

  // 新引入的位图资源必须真的落到磁盘上（空文件/坏下载只有浏览器会暴露）
  for (const f of ['pi.png', 'antigravity.png']) {
    const p = new URL(`../src/assets/agent-logos/${f}`, import.meta.url);
    const exists = fs.existsSync(p) && fs.statSync(p).size > 500;
    ok(exists, `logo 资源 ${f} 存在且非空`);
  }
}

// ── 6. L1：三种方言的 SSE 流式解析（本地 server 真跑） ──────────
{
  const samples = {
    openai:
      'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}\n\n' +
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n\n',
    anthropic:
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Kimi"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" 回复"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    gemini:
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"豆"}]},"index":0}]}\n\n' +
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"包"}]},"index":0}]}\n\n' +
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"在此"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":8}}\n\n',
  } as const;

  const expected = {
    openai: ['你', '好'],
    anthropic: ['Kimi', ' 回复'],
    gemini: ['豆', '包', '在此'],
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/err500')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '内部错误详情' } }));
      return;
    }
    if (url.startsWith('/err401')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }
    if (url.startsWith('/streamerr')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"error":{"message":"模型不存在","type":"invalid_request_error"}}\n\n');
      res.end();
      return;
    }
    const dialect = url.slice(1).split('/')[0] as keyof typeof samples;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    // 分两段写，顺便验证「半行被切断」的缓冲逻辑
    const s = samples[dialect];
    const mid = Math.floor(s.length / 2);
    res.write(s.slice(0, mid));
    setTimeout(() => res.end(s.slice(mid)), 10);
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const savedKey = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = 'test-key-not-real';

  try {
    for (const dialect of ['openai', 'anthropic', 'gemini'] as const) {
      const def: AgentDefinition = {
        descriptor: {
          id: `local-${dialect}`,
          name: `Local ${dialect}`,
          kind: 'http',
          capabilities: ['chat', 'write'],
        },
        http: {
          dialect,
          url: `http://127.0.0.1:${port}/${dialect}/chat`,
          host: `127.0.0.1:${port}`,
          defaultModel: 'test-model',
        },
        authEnvs: ['ARK_API_KEY'],
      };
      const adapter = new HttpAdapter(def);
      const events = await collect(adapter.send({ sessionId: 's', prompt: 'hi' }));
      const texts = events
        .filter(e => e.type === 'text')
        .map(e => (e as { content: string }).content);
      eq(texts, expected[dialect], `${dialect} 方言应按序解出全部文本增量`);
      ok(
        events.some(e => e.type === 'init' && (e as { model?: string }).model === 'test-model'),
        `${dialect} 应先 yield init 事件并带上模型名`
      );
      ok(
        events.filter(e => e.type === 'done').length === 1,
        `${dialect} 应有且仅有一个 done 事件（多一个会让前端误判两轮）`
      );
      ok(
        events.filter(e => e.type === 'error').length === 0,
        `${dialect} 正常流不应有 error 事件`
      );
    }

    // SSE 内嵌 error 行 → error 事件
    {
      const def: AgentDefinition = {
        descriptor: { id: 'local-e1', name: 'e1', kind: 'http', capabilities: ['chat'] },
        http: {
          dialect: 'openai',
          url: `http://127.0.0.1:${port}/streamerr/chat`,
          host: `127.0.0.1:${port}`,
        },
        authEnvs: ['ARK_API_KEY'],
      };
      const events = await collect(new HttpAdapter(def).send({ sessionId: 's', prompt: 'hi' }));
      const err = events.find(e => e.type === 'error') as { message?: string } | undefined;
      ok(!!err, 'SSE 里的 error 行应转成 error 事件');
      ok(/模型不存在/.test(err?.message ?? ''), 'error 事件应带上原因文本', err?.message);
    }

    // HTTP 500：必须把 body 带出来（只看状态码等于浪费一次排查）
    {
      const def: AgentDefinition = {
        descriptor: { id: 'local-e2', name: 'e2', kind: 'http', capabilities: ['chat'] },
        http: {
          dialect: 'openai',
          url: `http://127.0.0.1:${port}/err500/chat`,
          host: `127.0.0.1:${port}`,
        },
        authEnvs: ['ARK_API_KEY'],
      };
      const events = await collect(new HttpAdapter(def).send({ sessionId: 's', prompt: 'hi' }));
      const err = events.find(e => e.type === 'error') as { message?: string } | undefined;
      ok(!!err, 'HTTP 500 应产出 error 事件');
      ok(/HTTP 500/.test(err?.message ?? ''), '错误信息应带状态码', err?.message);
      ok(
        /内部错误详情/.test(err?.message ?? ''),
        '错误信息应带 body（各家把真因放在 body 里）',
        err?.message
      );
    }

    // HTTP 401：应把可用性改成 needs-auth，否则名册页一直显示"在线"
    {
      const def: AgentDefinition = {
        descriptor: { id: 'local-e3', name: 'e3', kind: 'http', capabilities: ['chat'] },
        http: {
          dialect: 'openai',
          url: `http://127.0.0.1:${port}/err401/chat`,
          host: `127.0.0.1:${port}`,
        },
        authEnvs: ['ARK_API_KEY'],
      };
      const adapter = new HttpAdapter(def);
      const events = await collect(adapter.send({ sessionId: 's', prompt: 'hi' }));
      ok(events.some(e => e.type === 'error'), '401 应产出 error 事件');
      eq(adapter['status']?.availability, 'needs-auth', '401 后可用性应为 needs-auth');
    }

    // 没有 key：probe 与 send 都要明确说缺 key，而不是等到超时
    {
      delete process.env.ARK_API_KEY;
      const def: AgentDefinition = {
        descriptor: { id: 'local-e4', name: 'e4', kind: 'http', capabilities: ['chat'] },
        http: {
          dialect: 'openai',
          url: `http://127.0.0.1:${port}/openai/chat`,
          host: `127.0.0.1:${port}`,
        },
        authEnvs: ['ARK_API_KEY'],
      };
      const adapter = new HttpAdapter(def);
      const st = await adapter.probe();
      eq(st.availability, 'needs-auth', '未配置 key 时 probe 应返回 needs-auth');
      const events = await collect(adapter.send({ sessionId: 's', prompt: 'hi' }));
      const err = events.find(e => e.type === 'error') as { message?: string } | undefined;
      ok(
        /ARK_API_KEY/.test(err?.message ?? ''),
        'send 的错误信息应点名要设哪个环境变量',
        err?.message
      );
    }
  } finally {
    if (savedKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = savedKey;
    server.close();
  }
}

// ── 汇总 ───────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ verify:agent-access 失败 ${failures.length}/${checks.total}`);
  for (const f of failures) console.error('  · ' + f.replace(/\n/g, '\n    '));
  process.exit(1);
}
console.log(`✓ verify:agent-access 全绿（${checks.total} 项）`);
