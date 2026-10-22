/**
 * Qoder SDK 适配器验证（A76）。
 *
 * 这个脚本守的是**改错了不会报错、但功能静默失效**的那几处：
 *
 *   1. **事件映射**。SDK 的消息形状是我们从真实探针里抄的，一旦字段名写错
 *      （`tool_use_id` 写成 `toolUseId`、`thinking` 写成 `text`），
 *      后果不是崩溃而是「工具卡片永远空白」「思考永远不出来」——
 *      只有真跑一次 90 秒的模型调用才会发现。所以这里用**录下来的真实事件**
 *      逐条喂给映射器。
 *   2. **query options 的字段名**。SDK 对认不出的字段是静默忽略的
 *      （不像 TS 会报错，因为传的是 Record）。`disallowedTools` 写成
 *      `disallowTools` 就会让只读档位失去那一道硬闸。
 *   3. **plan 档的三层强制**是否还在（白名单 / 黑名单 / 档位）。
 *   4. **CN 的诚实性**：没有账号可测，就**必须**在界面上写明「未实测」，
 *      不许悄悄当成和国际版一样已验证。
 *
 * 全离线：不启动 CLI、不连网、不需要任何账号。
 * 运行：npx tsx scripts/verify-qoder-sdk.ts
 */
// ⚠️ 必须是第一个 import：它把 OPC_DATA_DIR 指到临时目录，否则下面这条链
// （adapters/qoder-sdk → server/memory → server/db）一加载就打开用户真实的
// data/chat.db，和正在运行的实例抢文件锁。
import './lib/temp-data-dir.js';
import { findDef } from '../server/agents/definitions.js';
import {
  QODER_FLAVORS,
  QoderSdkAdapter,
  createQoderMapper,
  READ_ONLY_TOOLS,
  PLAN_DENY_TOOLS,
} from '../server/agents/adapters/qoder-sdk.js';
import { canEnforce } from '../server/agents/permissions.js';
import type { AgentEvent } from '../server/agents/types.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function section(title: string) {
  console.log(`\n— ${title}`);
}

const SESSION = 's-verify';

/** 跑一串消息，返回全部事件 */
function run(mapper: (m: unknown) => AgentEvent[], msgs: unknown[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const m of msgs) out.push(...mapper(m));
  return out;
}

const only = <T extends AgentEvent['type']>(evs: AgentEvent[], t: T) =>
  evs.filter(e => e.type === t) as Array<Extract<AgentEvent, { type: T }>>;

// ============= [1] 两个产品系列的事实 =============
section('[1] 两个 flavor 的事实（包名 / PAT 变量 / 显示名各不相同）');
{
  const intl = QODER_FLAVORS['qoder-intl'];
  const cn = QODER_FLAVORS['qoder-cn'];

  ok(!!intl && !!cn, '两个 flavor 都已声明');
  eq(intl?.pkg, '@qoder-ai/qoder-agent-sdk', '国际版包名');
  eq(cn?.pkg, '@qodercn-ai/qodercn-agent-sdk', '国内版包名');
  eq(intl?.patEnv, 'QODER_PERSONAL_ACCESS_TOKEN', '国际版 PAT 变量');
  eq(cn?.patEnv, 'QODERCN_PERSONAL_ACCESS_TOKEN', '国内版 PAT 变量');
  ok(intl?.pkg !== cn?.pkg, '两个包名不同（不能共用一个包冒充两个产品）');
  ok(intl?.patEnv !== cn?.patEnv, '两个 PAT 变量不同（凭据不互通）');

  const qoder = findDef('qoder');
  const qoderCn = findDef('qoder-cn');
  eq(qoder?.sdk?.flavor, 'qoder-intl', 'qoder 指向国际版 flavor');
  eq(qoderCn?.sdk?.flavor, 'qoder-cn', 'qoder-cn 指向国内版 flavor');

  // 兜底通道必须都在：SDK 包缺失时它们还能干活
  ok(!!qoder?.cli && !!qoderCn?.cli, '两个条目都保留了 cli 兜底规格');
}

// ============= [2] 两个包真的能加载、导出齐全 =============
section('[2] 两个 SDK 包可加载，且导出 query / qodercliAuth / ProcessTransport');
{
  for (const [key, flavor] of Object.entries(QODER_FLAVORS)) {
    let mod: Record<string, unknown> | null = null;
    let err = '';
    try {
      mod = (await import(flavor.pkg)) as unknown as Record<string, unknown>;
    } catch (e) {
      err = (e as Error).message;
    }
    ok(mod !== null, `${key} 的包 ${flavor.pkg} 可加载`, err);
    for (const name of ['query', 'qodercliAuth', 'ProcessTransport']) {
      ok(typeof mod?.[name] === 'function', `${flavor.pkg} 导出 ${name}`);
    }
  }
}

// ============= [3] 事件映射（喂真实录到的事件） =============
section('[3] 事件映射：真实形状 → 统一事件');
{
  // ① system/init：真实字段名是 session_id / model / permissionMode
  const m1 = createQoderMapper({ sessionId: SESSION, model: 'ctx-model' });
  const initEvs = run(m1, [
    {
      type: 'system',
      subtype: 'init',
      session_id: '38d5a08c-97ca-4bde-9fa6-68783140dc85',
      model: 'Qwen3.8-Flash',
      permissionMode: 'default',
      tools: ['Read', 'Write', 'Bash'],
    },
  ]);
  const init = only(initEvs, 'init')[0];
  ok(!!init, 'system/init 产出 init 事件');
  eq(init?.resumeToken, '38d5a08c-97ca-4bde-9fa6-68783140dc85', 'init 的 resumeToken 取 session_id');
  eq(init?.model, 'Qwen3.8-Flash', 'init 的 model 取 CLI 回报的（不是我们传下去的）');
  eq(initEvs.length, 1, 'init 只产出一个事件');

  // 实测（2026-10-22 端到端）：一轮调用里 CLI 会发两次 system/init，
  // 两次的 session_id / model 完全相同。不去的后果是前端收到 3 个 init
  // （含 send() 开头那个合成的），排查时会被误读成「握手了三次」。
  const initTwice = run(createQoderMapper({ sessionId: SESSION }), [
    { type: 'system', subtype: 'init', session_id: 'dup', model: 'M' },
    { type: 'system', subtype: 'init', session_id: 'dup', model: 'M' },
  ]);
  eq(only(initTwice, 'init').length, 1, '重复的 system/init 只发一次（CLI 实测会发两次）');

  // ② 认不出的 system 子类型不许硬塞进 thinking
  const m2 = createQoderMapper({ sessionId: SESSION });
  const noise = run(m2, [
    { type: 'system', subtype: 'hook_started', hook_id: 'h', hook_event: 'PreToolUse' },
    { type: 'system', subtype: 'available_models_update', models: [{}, {}], currentModel: 'qfmodel' },
    { type: 'system', subtype: 'artifacts_update', artifacts: [] },
    { type: 'command_lifecycle', state: 'running' },
  ]);
  eq(noise.length, 0, '无关的 system 子类型与 command_lifecycle 不产生任何事件（不编造过程）');

  // ③ 思考：增量优先
  const m3 = createQoderMapper({ sessionId: SESSION });
  const think = run(m3, [
    { type: 'stream_event', event: { type: 'message_start' } },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'The user is asking' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: ' me to read a file.' },
      },
    },
    // 紧随其后的 assistant 整块：与增量重复，不许再发一遍
    {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'The user is asking me to read a file.', signature: '' }],
      },
    },
  ]);
  eq(only(think, 'thinking').length, 2, '两段 thinking_delta → 两个 thinking 事件');
  eq(
    only(think, 'thinking').map(e => e.content).join(''),
    'The user is asking me to read a file.',
    '思考内容拼接正确'
  );
  eq(think.length, 2, 'assistant 的 thinking 整块被增量覆盖，不重复发');

  // ④ 正文：同理
  const m4 = createQoderMapper({ sessionId: SESSION });
  const text = run(m4, [
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'HELLO' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '-42' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'HELLO-42', citations: null }] } },
  ]);
  eq(only(text, 'text').map(e => e.content).join(''), 'HELLO-42', '增量拼接成完整正文');
  eq(text.length, 2, 'assistant 的 text 整块不重复发');

  // ⑤ 兜底：某些模型/网关不返回增量时，assistant 整块必须补上
  const m5 = createQoderMapper({ sessionId: SESSION });
  const noDelta = run(m5, [
    { type: 'assistant', message: { content: [{ type: 'text', text: '只有整块' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '整块思考' }] } },
  ]);
  eq(only(noDelta, 'text')[0]?.content, '只有整块', '没有增量时 assistant 正文仍要发出（否则整段丢失）');
  eq(only(noDelta, 'thinking')[0]?.content, '整块思考', '没有增量时 assistant 思考仍要发出');

  // ⑥ 工具：tool_use → tool；input_json_delta 不发碎片
  const m6 = createQoderMapper({ sessionId: SESSION });
  const tool = run(m6, [
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path": "E' } },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'call_2ff61f510a1d4ea492f70083',
            name: 'Read',
            input: { file_path: 'D:\\work\\demo\\note.txt' },
          },
        ],
      },
    },
  ]);
  const toolEv = only(tool, 'tool')[0];
  eq(tool.length, 1, 'input_json_delta 不发事件（避免卡片乱跳）');
  eq(toolEv?.id, 'call_2ff61f510a1d4ea492f70083', 'tool 事件的 id 取 tool_use.id');
  eq(toolEv?.name, 'Read', 'tool 事件的 name 取 tool_use.name');
  eq(toolEv?.input, { file_path: 'D:\\work\\demo\\note.txt' }, 'tool 事件的 input 是**解析好的**对象');

  // ⑦ 工具结果：user 消息里的 tool_result 块
  const m7 = createQoderMapper({ sessionId: SESSION });
  const res = run(m7, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1\tHELLO-42\n2\t' }] },
    },
  ]);
  const tr = only(res, 'tool_result')[0];
  eq(tr?.toolId, 'call_1', 'tool_result 的 toolId 取 tool_use_id');
  eq(tr?.content, '1\tHELLO-42\n2\t', 'tool_result 的内容原样透传');
  eq(tr?.isError, false, 'tool_result 默认不是错误');

  // ⑧ 工具结果也可能是 block 数组
  const m8 = createQoderMapper({ sessionId: SESSION });
  const arr = run(m8, [
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'c2', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }],
      },
    },
  ]);
  eq(only(arr, 'tool_result')[0]?.content, 'AB', 'tool_result 是 block 数组时拼成文本');

  // ⑨ CLI 侧拒绝 → 工具结果（否则前端一直转圈）
  const m9 = createQoderMapper({ sessionId: SESSION });
  const denied = run(m9, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c3', name: 'Bash', input: {} }] } },
    {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'c3',
      message: 'Permission to use Bash has been denied.',
    },
  ]);
  const deniedEv = only(denied, 'tool_result')[0];
  eq(deniedEv?.toolId, 'c3', 'permission_denied 映射到对应的工具');
  eq(deniedEv?.isError, true, 'permission_denied 的结果标记为错误');
  ok(/denied/i.test(deniedEv?.content ?? ''), 'permission_denied 的原文透传', deniedEv?.content);

  // ⑩ result：success → done
  const m10 = createQoderMapper({ sessionId: SESSION, startedAt: Date.now() });
  const done = run(m10, [
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 20403,
      num_turns: 2,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, context_usage_ratio: 0.25 },
    },
  ]);
  const doneEv = only(done, 'done')[0];
  ok(!!doneEv, 'result/success → done 事件');
  eq(doneEv?.durationMs, 20403, 'done 的 durationMs 取 duration_ms');
  eq(doneEv?.tokens, undefined, 'token 全 0 时不填（不能把「没报」当成 0）');
  eq(doneEv?.cost, undefined, 'total_cost_usd 为 0 时不填（不能把积分制当成免费）');

  // ⑪ result：有真实用量时照实填
  const m11 = createQoderMapper({ sessionId: SESSION });
  const done2 = run(m11, [
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1000,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 50 },
    },
  ]);
  const doneEv2 = only(done2, 'done')[0];
  eq(doneEv2?.tokens, 200, 'token 数取 input+output+cache 之和');
  eq(doneEv2?.cost, 0.0123, 'cost 取 total_cost_usd');

  // ⑫ result：is_error → error（不是 done）
  const m12 = createQoderMapper({ sessionId: SESSION });
  const err = run(m12, [
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'credit limit reached' },
  ]);
  eq(only(err, 'error')[0]?.message, 'credit limit reached', 'result 带 is_error 时产出 error 事件');
  eq(only(err, 'done').length, 0, '出错的 result 不许同时产出 done');

  // ⑬ 收尾：没拿到结果的工具要补「已完成」，否则前端一直转圈
  const m13 = createQoderMapper({ sessionId: SESSION });
  const orphan = run(m13, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'never-returns', name: 'Read', input: {} }] } },
    { type: 'result', subtype: 'success', is_error: false, duration_ms: 5 },
  ]);
  const closing = only(orphan, 'tool_result')[0];
  eq(closing?.toolId, 'never-returns', '整轮结束时补齐未闭合的工具');
  eq(closing?.content, '已完成', '补齐内容明确写「已完成」');

  // ⑭ 多轮：message_start 重置增量标记，第二轮整块不能被第一轮的标记压掉
  const m14 = createQoderMapper({ sessionId: SESSION });
  const multi = run(m14, [
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '一' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '一' }] } },
    // 第二轮没有增量，只有整块
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '二' }] } },
  ]);
  eq(only(multi, 'text').map(e => e.content).join(''), '一二', '多轮之间增量标记会重置（第二轮整块没被吞掉）');
}

// ============= [4] plan 档的三层强制 =============
section('[4] plan（只读）档的三道闸');
{
  // 白名单：只放只读工具
  for (const t of ['Read', 'Glob', 'Grep']) {
    ok(READ_ONLY_TOOLS.has(t), `plan 白名单包含只读工具 ${t}`);
  }
  for (const t of ['Bash', 'Write', 'Edit', 'Agent', 'Skill', 'ImageGen']) {
    ok(!READ_ONLY_TOOLS.has(t), `plan 白名单**不含** ${t}`);
  }

  // 黑名单：写盘 / 执行 / 拉子代理的必须在这里（这是唯一不经过回调的硬闸）
  for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Skill', 'ImageGen']) {
    ok(PLAN_DENY_TOOLS.includes(t), `plan 黑名单包含 ${t}（硬拒绝，不依赖回调）`);
  }
  // 两个名单不许交叉：交叉等于「一边允许一边拒绝」，行为取决于谁先命中
  const overlap = [...READ_ONLY_TOOLS].filter(t => PLAN_DENY_TOOLS.includes(t));
  eq(overlap, [], '白名单与黑名单没有交集');

  // 权限矩阵：plan 必须记为已强制（A76 之前是「不声称支持」）
  ok(canEnforce('qoder', 'plan'), 'permissions 矩阵里 qoder 的 plan 记为已强制');
  ok(canEnforce('qoder-cn', 'plan'), 'permissions 矩阵里 qoder-cn 的 plan 记为已强制');
}

// ============= [5] query options 的字段名与取值 =============
section('[5] query options：字段名写错不会报错，只会静默失效');
{
  const def = findDef('qoder');
  ok(!!def, 'qoder 定义存在');
  if (!def) {
    // 没有定义就没什么可测的了，直接收尾
  } else {
    // 假 SDK 模块：只要三个导出，用来截获 options
    let captured: Record<string, unknown> = {};
    const fakeMod = {
      query: () => (async function* () {})(),
      qodercliAuth: () => ({ kind: 'fake-auth' }),
      ProcessTransport: class {
        constructor(o: Record<string, unknown>) {
          captured = o;
        }
      },
    } as unknown as Parameters<QoderSdkAdapter['buildOptions']>[4];

    const adapter = new QoderSdkAdapter(def);
    const ac = new AbortController();
    const baseCtx = {
      sessionId: 's',
      prompt: 'P',
      cwd: 'C:/tmp',
      model: 'Qwen3.8-Flash',
      resumeToken: 'sess-1',
    };

    // ---- 普通档 ----
    const normal = adapter.buildOptions(
      { ...baseCtx, permissionMode: 'default' },
      'C:/qodercli.exe',
      ac,
      [],
      fakeMod,
      () => {}
    );
    eq(normal.permissionMode, 'default', 'permissionMode 直传（SDK 的取值域与我们同名）');
    eq(normal.model, 'Qwen3.8-Flash', 'model 透传');
    eq(normal.resume, 'sess-1', 'resume 用 resumeToken');
    eq(normal.cwd, 'C:/tmp', 'cwd 透传');
    eq(normal.maxTurns, 10, 'maxTurns = 10（与 SdkAdapter 对齐）');
    eq(normal.includePartialMessages, true, 'includePartialMessages 必须开（否则正文整块到达）');
    eq(normal.disallowedTools, undefined, '普通档不下发工具黑名单（那是 plan 档的闸）');
    eq(normal.allowDangerouslySkipPermissions, undefined, '普通档不开「危险跳过」');
    eq(captured.pathToQoderCLIExecutable, 'C:/qodercli.exe', 'ProcessTransport 拿到 CLI 绝对路径');
    ok(typeof normal.canUseTool === 'function', 'canUseTool 已挂上（权限桥）');
    ok(typeof normal.stderr === 'function', 'stderr 已接管（失败时能给出 CLI 原文）');

    // ---- 系统提示词：必须是 preset + append，不能是裸字符串 ----
    const withSys = adapter.buildOptions(
      { ...baseCtx, permissionMode: 'default', systemPrompt: '你是助手' },
      'C:/qodercli.exe',
      ac,
      [],
      fakeMod,
      () => {}
    );
    const sp = withSys.systemPrompt as { type?: string; preset?: string; append?: string };
    eq(sp?.type, 'preset', 'systemPrompt 用 preset（裸字符串会整段替换掉 qodercli 的工具规则）');
    eq(sp?.preset, 'qodercli', 'preset 名是 qodercli');
    ok((sp?.append ?? '').includes('你是助手'), '用户提示词追加在 append 里', sp?.append);

    // ---- 思考强度：只能靠 extraArgs ----
    const withEffort = adapter.buildOptions(
      { ...baseCtx, permissionMode: 'default', reasoningEffort: 'xhigh' },
      'C:/qodercli.exe',
      ac,
      [],
      fakeMod,
      () => {}
    );
    eq(
      withEffort.extraArgs,
      { 'reasoning-effort': 'xhigh' },
      '思考强度经 extraArgs 透传（SDK 的 Options 里没有 reasoning 字段）'
    );

    // ---- plan 档：三道闸都要在 ----
    const plan = adapter.buildOptions(
      { ...baseCtx, permissionMode: 'plan' },
      'C:/qodercli.exe',
      ac,
      [],
      fakeMod,
      () => {}
    );
    eq(plan.permissionMode, 'plan', 'plan 档直传 permissionMode=plan');
    eq(plan.disallowedTools, PLAN_DENY_TOOLS, 'plan 档下发 disallowedTools 硬黑名单');

    // ---- bypass 档：必须与 allowDangerouslySkipPermissions 成对 ----
    const bypass = adapter.buildOptions(
      { ...baseCtx, permissionMode: 'bypassPermissions' },
      'C:/qodercli.exe',
      ac,
      [],
      fakeMod,
      () => {}
    );
    eq(bypass.permissionMode, 'bypassPermissions', 'bypass 档直传');
    eq(bypass.allowDangerouslySkipPermissions, true, 'bypass 档同时打开 allowDangerouslySkipPermissions');

    // ---- 中文档名不落进 options（那是 CLI 的取值，不是 SDK 的） ----
    eq(normal.permissionMode === 'accept_edits', false, 'SDK 的档位不是 CLI 的下划线写法');
  }
}

// ============= [6] CN 的诚实性 =============
section('[6] 国内版：未实测就必须写在界面上');
{
  const cn = findDef('qoder-cn');
  ok(/未实测/.test(cn?.descriptor.description ?? ''), 'qoder-cn 的描述里写明「未实测」', cn?.descriptor.description);
  ok(
    /未实测/.test(cn?.descriptor.installHint ?? ''),
    'qoder-cn 的安装提示里写明「未实测」',
    cn?.descriptor.installHint
  );
  // 国内版不许声明「已实测通过」的模型清单（modelCatalog 里没给它挂 verified extras）
  eq(cn?.models, undefined, 'qoder-cn 不写死模型清单（CN 账号的可用模型未知）');
}

// ============= 结果 =============
console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败（共 ${checks.total} 项）：\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks.total}/${checks.total} 全部通过`);
