/**
 * P6 用量统计与会话导出验证。
 *
 * ## 为什么不用真实 Agent 跑端到端
 *
 * 本环境所有 Agent 都不可用（Codex 网络不通、Gemini/WorkBuddy 未登录、
 * Claude 二进制缺失），起真服务器发真消息只能证明「失败路径」。
 * 本脚本按层验证，每层都确定：
 *
 *   A. formatUsage：显示层纯函数（没有数据 → null，不是 0）
 *   B. buildSessionMarkdown：导出纯函数（吃接口原始行，吐 Markdown）
 *   C. DB 层：老库迁移、三列读写、列类型（用临时库，不碰真实数据）
 *   D. 源码契约：把「done 事件 → 落库 → 接口 → 前端」四段 glue 用
 *      readFileSync 逐条钉死 —— glue 断了测试必须红，而不是等用户发现
 *
 * 运行：npx tsx scripts/verify-usage-stats.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function src(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function has(file: string, needle: string, label: string) {
  ok(src(file).includes(needle), label, `${file} 中找不到: ${needle}`);
}

function absent(file: string, needle: string, label: string) {
  ok(!src(file).includes(needle), label, `${file} 中仍存在: ${needle}`);
}

async function main() {
  // ============================================================ A. formatUsage
  const { formatUsage } = await import('../src/utils/formatUsage.js');

  eq(formatUsage({}), null, '三个字段全无 → null（不渲染，而不是显示 0）');
  eq(formatUsage({ durationMs: 0, cost: 0, tokens: 0 }), null, '全 0 → null（0 不代表没有数据，但 usage 里 0 无信息量）');
  eq(formatUsage({ durationMs: 830 }), '830ms', '毫秒 < 1000 显示 ms');
  eq(formatUsage({ durationMs: 2340 }), '2.3s', '毫秒 ≥ 1000 显示秒');
  eq(formatUsage({ cost: 0.0123 }), '$0.01', '费用按分显示');
  eq(formatUsage({ cost: 5 }), '$5.00', '整数费用补两位小数');
  eq(formatUsage({ cost: 0.004 }), '<$0.01', '极小费用显示 <$0.01（不与「没花钱」混淆）');
  eq(formatUsage({ tokens: 850 }), '850 tokens', 'token < 1000 原样');
  eq(formatUsage({ tokens: 12345 }), '12.3k tokens', 'token ≥ 1000 显示 k');
  eq(
    formatUsage({ durationMs: 2340, cost: 0.05, tokens: 12345 }),
    '2.3s · $0.05 · 12.3k tokens',
    '三项齐全时按 耗时 · 费用 · token 顺序、以 · 连接'
  );
  // 顺序必须固定：三项随机排列会让用户对不上哪个数是哪个
  eq(
    formatUsage({ tokens: 500, cost: 0.02, durationMs: 1200 }),
    '1.2s · $0.02 · 500 tokens',
    '字段传入顺序不影响输出顺序（固定为 耗时→费用→token）'
  );
  eq(formatUsage({ tokens: 300 }), '300 tokens', '只有 token（ACP 场景）也能渲染');

  // ==================================================== B. buildSessionMarkdown
  const { buildSessionMarkdown, safeFileName } = await import('../src/utils/exportSession.js');
  const resolve = (id: string) => ({ hermes: 'Hermes', codex: 'Codex' }[id] ?? id);

  // B1. 空会话要有话说，不能输出空文件
  const emptyMd = buildSessionMarkdown(
    { id: 's1', title: '空会话', model: '', created_at: '2026-10-17T10:00:00.000Z' },
    [],
    resolve
  );
  ok(emptyMd.includes('# 空会话'), '导出：标题是一级标题');
  ok(emptyMd.includes('（这个会话没有消息）'), '导出：空会话有明确说明');

  // B2. 元信息：Agent / 场景 / 工作目录 / 创建时间
  const metaMd = buildSessionMarkdown(
    {
      id: 's2',
      title: '开发会话',
      model: 'zai/glm-4.7',
      agent_id: 'codex',
      cwd: 'E:/proj/demo',
      scenario_id: 'dev',
      created_at: '2026-10-17T10:00:00.000Z',
    },
    [],
    resolve
  );
  ok(metaMd.includes('- Agent：Codex'), '导出：Agent id 译成显示名', metaMd);
  ok(metaMd.includes('- 场景：开发'), '导出：场景 id 译成中文标签', metaMd);
  ok(metaMd.includes('- 工作目录：E:/proj/demo'), '导出：工作目录进元信息', metaMd);
  ok(/^- 创建时间：2026-10-17 \d{2}:\d{2}$/m.test(metaMd), '导出：创建时间格式化', metaMd);

  // B3. 消息体：角色、作者、时间、正文
  // 时间不硬编码小时：formatTime 用**本地时区**渲染（导出文件是给本人看的），
  // 换时区的机器上硬编码 10:01 会假红。这里只钉日期与结构。
  const bodyMd = buildSessionMarkdown(
    { id: 's3', title: 'T', model: 'm', agent_id: 'hermes', created_at: '2026-10-17T10:00:00.000Z' },
    [
      {
        id: 'm1',
        role: 'user',
        content: '帮我看看这个 bug',
        created_at: '2026-10-17T10:01:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '问题在第三行',
        author_agent_id: 'hermes',
        created_at: '2026-10-17T10:02:00.000Z',
        duration_ms: 2340,
        cost: 0.05,
        tokens: 12345,
      },
    ],
    resolve
  );
  ok(/^## 🧑 我 · 2026-10-17 \d{2}:\d{2}$/m.test(bodyMd), '导出：用户消息带头部', bodyMd);
  ok(
    /^## 🤖 Hermes · 2026-10-17 \d{2}:\d{2}（2\.3s · \$0\.05 · 12\.3k tokens）$/m.test(bodyMd),
    '导出：助手消息带作者与用量',
    bodyMd
  );
  ok(bodyMd.includes('帮我看看这个 bug'), '导出：用户正文');
  ok(bodyMd.includes('问题在第三行'), '导出：助手正文');

  // B4. 工具调用折叠成摘要行，完整 input/result 不外泄
  const toolMd = buildSessionMarkdown(
    { id: 's4', title: 'T', model: 'm', agent_id: 'codex', created_at: '2026-10-17T10:00:00.000Z' },
    [
      {
        id: 'm3',
        role: 'assistant',
        content: '改好了',
        author_agent_id: 'codex',
        created_at: '2026-10-17T10:03:00.000Z',
        tool_calls: [
          {
            name: 'Edit',
            input: { file_path: 'E:/proj/demo/src/a.ts' },
            status: 'completed',
            result: 'The file has been updated successfully.（一大段完整结果不应出现）',
          },
          { name: 'Bash', input: { command: 'npm test' }, isError: true, result: 'FAILED xyz' },
        ],
      },
    ],
    resolve
  );
  ok(toolMd.includes('✅ `Edit` E:/proj/demo/src/a.ts'), '导出：工具调用一行摘要（名字 + 目标）', toolMd);
  ok(toolMd.includes('❌ `Bash` npm test'), '导出：失败工具有 ❌ 标记', toolMd);
  ok(!toolMd.includes('The file has been updated'), '导出：不导出工具完整 result', toolMd);
  ok(!toolMd.includes('FAILED xyz'), '导出：失败 result 也不导出', toolMd);

  // B5. 图片
  const imgMd = buildSessionMarkdown(
    { id: 's5', title: 'T', model: 'm', agent_id: 'hermes', created_at: '2026-10-17T10:00:00.000Z' },
    [
      {
        id: 'm4',
        role: 'assistant',
        content: '画好了',
        author_agent_id: 'hermes',
        created_at: '2026-10-17T10:04:00.000Z',
        images: [{ url: '/api/images/abc.png', prompt: '一只猫' }, { prompt: '一只狗' }],
      },
    ],
    resolve
  );
  ok(imgMd.includes('![一只猫](/api/images/abc.png)'), '导出：有 url 的图片写成 Markdown 图片', imgMd);
  ok(imgMd.includes('> 🖼 一只狗'), '导出：无 url 的图片留文字说明（保留「这里有过图」）', imgMd);

  // B6. 下载文件名清洗：Windows 保留字符 + 空标题兜底 + 超长截断
  eq(safeFileName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i', 'safeFileName 替换 Windows 保留字符');
  eq(safeFileName(''), '会话导出', 'safeFileName 空标题有兜底');
  eq(safeFileName('   '), '会话导出', 'safeFileName 纯空白有兜底');
  eq(safeFileName('x'.repeat(80)).length, 40, 'safeFileName 超长截断到 40');

  // ============================================================ C. DB 层
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-usage-'));
  process.env.OPC_DATA_DIR = tmpDir;

  // C1. 老结构库：messages 没有三个新列
  {
    const seed = new DatabaseSync(path.join(tmpDir, 'chat.db'));
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
        agent_id TEXT, kind TEXT NOT NULL DEFAULT 'direct',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, model TEXT, author_agent_id TEXT,
        created_at TEXT NOT NULL, tool_calls TEXT
      );
      INSERT INTO sessions (id, title, model, agent_id, created_at, updated_at)
        VALUES ('legacy', '老会话', 'm', 'hermes', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      INSERT INTO messages (id, session_id, role, content, model, author_agent_id, created_at, tool_calls)
        VALUES ('lm1', 'legacy', 'assistant', '老回复', 'm', 'hermes', '2026-10-01T00:00:01.000Z', NULL);
    `);
    seed.close();
  }

  const db = await import('../server/db.js');

  // C2. 迁移后老消息三列读出为 NULL —— 不是 0、不是字段缺失
  //
  // ⚠️ 判「列在不在」不能用 `value ?? fallback`：`??` 把 null 也当空值，
  // 会把「列存在、值为 NULL」误判成「列缺失」。必须先 `in` 判存在，再判值。
  const legacyRows = db.getMessagesBySession('legacy');
  ok(legacyRows.length === 1, '老会话消息仍可读出');
  ok(
    !!legacyRows[0] && 'duration_ms' in legacyRows[0] && 'cost' in legacyRows[0] && 'tokens' in legacyRows[0],
    'SELECT * 带出三个新列（读路径不挑字段）'
  );
  eq(
    [legacyRows[0]?.duration_ms, legacyRows[0]?.cost, legacyRows[0]?.tokens],
    [null, null, null],
    '老消息三列迁移后为 NULL（前端据此不渲染统计行，而不是显示 0 秒 / $0）'
  );

  // C3. 列类型：duration/tokens 整数、cost 浮点
  {
    const probe = new DatabaseSync(path.join(tmpDir, 'chat.db'));
    const cols = probe.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; type: string }>;
    eq(cols.find(c => c.name === 'duration_ms')?.type, 'INTEGER', 'duration_ms 列为 INTEGER');
    eq(cols.find(c => c.name === 'cost')?.type, 'REAL', 'cost 列为 REAL（费用是小数）');
    eq(cols.find(c => c.name === 'tokens')?.type, 'INTEGER', 'tokens 列为 INTEGER');
    probe.close();
  }

  // C4. createMessage 带三列 → 原样读回
  db.createSession({
    id: 'u1',
    title: '用量会话',
    model: 'm',
    agent_id: 'hermes',
    sdk_session_id: null,
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: null,
    scenario_id: null,
    system_prompt: null,
    created_at: '2026-10-17T10:00:00.000Z',
    updated_at: '2026-10-17T10:00:00.000Z',
  });
  db.createMessage({
    id: 'um1',
    session_id: 'u1',
    role: 'assistant',
    content: '回复',
    model: 'm',
    author_agent_id: 'hermes',
    created_at: '2026-10-17T10:01:00.000Z',
    tool_calls: null,
    images: null,
    duration_ms: 2340,
    cost: 0.0123,
    tokens: 12345,
  });
  const withUsage = db.getMessagesBySession('u1')[0];
  eq(withUsage?.duration_ms, 2340, 'duration_ms 落库读回');
  eq(withUsage?.cost, 0.0123, 'cost 落库读回（小数不丢精度）');
  eq(withUsage?.tokens, 12345, 'tokens 落库读回');

  // C5. 不传三列（用户消息）→ 落库为 NULL
  db.createMessage({
    id: 'um2',
    session_id: 'u1',
    role: 'user',
    content: '提问',
    model: null,
    author_agent_id: null,
    created_at: '2026-10-17T10:00:30.000Z',
    tool_calls: null,
    images: null,
  });
  const userRow = db.getMessagesBySession('u1').find(m => m.id === 'um2');
  ok(
    !!userRow && 'duration_ms' in userRow && 'cost' in userRow && 'tokens' in userRow,
    '用户消息也带出三列（INSERT 不显式写也有列）'
  );
  eq(
    [userRow?.duration_ms, userRow?.cost, userRow?.tokens],
    [null, null, null],
    '不传三列 → NULL（用户消息没有用量；不是 0，也不是 undefined）'
  );

  // ============================================================ D. 源码契约
  section();
  // D1. done 事件契约：cost 是钱、tokens 是 token 数，不许互相冒充
  has('server/agents/types.ts', "type: 'done'; durationMs?: number; cost?: number; tokens?: number",
    'done 事件类型含 tokens');
  absent('server/agents/adapters/acp.ts', 'cost: typeof usage?.totalTokens',
    'ACP 不再把 totalTokens 塞进 cost（曾经的假数据来源）');
  has('server/agents/adapters/acp.ts', 'tokens: typeof usage?.totalTokens',
    'ACP 的 totalTokens 走 tokens 字段');
  has('server/agents/adapters/sdk.ts', "cost: typeof m.cost === 'number' ? m.cost : undefined",
    'SDK 仍从平台拿真费用');

  // D2. 落库 glue：一对一与群聊两条路径都要带三列
  has('server/index.ts', 'donePayload = { durationMs: ev.durationMs, cost: ev.cost, tokens: ev.tokens };',
    '一对一 SSE 处理器捕获 tokens');
  has('server/index.ts', 'donePayload?.durationMs ?? null', '一对一 createMessage 落 duration_ms');
  has('server/index.ts', 'donePayload?.cost ?? null', '一对一 createMessage 落 cost');
  has('server/index.ts', 'donePayload?.tokens ?? null', '一对一 createMessage 落 tokens');

  // 群聊那一棒的落库 glue 在 A41 搬到了 `server/turn-runner.ts`（index.ts 只留
  // 「谁来发言」的编排）。断言必须跟着实现走 —— 但**不能删**：
  // 这几条守的是「turn_done 的 duration/tokens 真的从 done 事件一路带到落库与下发」，
  // 删了就再也没人看着这条链。所以改成钉新文件，并额外钉一条「index 真的在用它」，
  // 防止出现「代码在 turn-runner 里，但没人调用」。
  has('server/turn-runner.ts', 'turnDone = { durationMs: ev.durationMs, cost: ev.cost, tokens: ev.tokens };',
    '群聊 turn 循环捕获 tokens');
  has('server/turn-runner.ts', 'duration_ms: turnDone?.durationMs ?? null', '群聊 createMessage 落 duration_ms');
  has('server/turn-runner.ts', 'cost: turnDone?.cost ?? null', '群聊 createMessage 落 cost');
  has('server/turn-runner.ts', 'tokens: turnDone?.tokens ?? null', '群聊 createMessage 落 tokens');
  has('server/turn-runner.ts', "type: 'turn_done',", '群聊 turn_done 下发事件');
  has('server/turn-runner.ts', 'duration: turnDone?.durationMs,', '群聊 turn_done 下发 duration');
  has('server/turn-runner.ts', 'tokens: turnDone?.tokens,', '群聊 turn_done 下发 tokens');
  has('server/index.ts', 'createTurnRunner({', '群聊真的在调 turn-runner（不是「代码在、没人用」）');

  // D3. 接口透传：/api/sessions/:id 必须是整行 spread，不能挑字段
  has('server/index.ts', '...msg,', 'GET /api/sessions/:id 整行返回（新列自动透传）');

  // D4. 前端 glue：刷新还原 + 流式挂载 + 渲染
  has('src/hooks/useSessions.ts', 'durationMs: typeof m.duration_ms === \'number\' ? m.duration_ms : undefined',
    '刷新还原 duration_ms（NULL → undefined，不显示 0）');
  has('src/hooks/useSessions.ts', 'tokens: typeof m.tokens === \'number\' ? m.tokens : undefined',
    '刷新还原 tokens');
  // 一对一流式：A34 之后走统一的 `run_end`（字段是 durationMs），
  // 不再是旧协议的 `done` + `data.duration`。断言跟着实现走，但语义不变：
  // 「流结束帧里的用量必须挂到消息上」。
  has('src/hooks/useChat.ts', "case 'run_end':", '一对一流式收尾走 run_end 帧');
  has('src/hooks/useChat.ts', 'durationMs: typeof data.durationMs === \'number\' ? data.durationMs : undefined',
    '一对一流式 run_end 挂载耗时');
  has('src/hooks/useChat.ts', 'tokens: typeof data.tokens === \'number\' ? data.tokens : undefined',
    '一对一流式 run_end 挂载 tokens');
  has('src/hooks/useGroupChat.ts', 'durationMs: typeof data.duration === \'number\' ? data.duration : undefined',
    '群聊 turn_done 挂载用量');
  has('src/components/ChatMessages.tsx', "import { formatUsage } from '../utils/formatUsage';",
    'ChatMessages 引入 formatUsage');
  has('src/components/ChatMessages.tsx', 'data-usage={usageText}', '用量行带 data-usage 属性（可打靶）');

  // D5. 会话导出接线
  has('src/App.tsx', "import { exportSessionToMarkdown } from './utils/exportSession';",
    'App 引入导出函数');
  has('src/App.tsx', 'onExport={handleExportSession}', 'ConversationList 接上导出');
  has('src/components/ConversationList.tsx', 'label: \'导出为 Markdown\'', '右键菜单有导出项');

  // D6. 错误兜底接线
  has('src/main.tsx', "import { ErrorBoundary } from './components/ErrorBoundary';",
    'main.tsx 引入 ErrorBoundary');
  has('src/main.tsx', '<ErrorBoundary>', 'App 被 ErrorBoundary 包裹');
  ok(
    // BrowserRouter 在 A115 起带了 `useTransitions={false}`，写死 `<BrowserRouter>`
    // 会把它判成「没包住」—— 守的是嵌套顺序，不是标签字面量，所以属性要放过。
    /<ErrorBoundary>[\s\S]*<BrowserRouter[^>]*>[\s\S]*<App \/>[\s\S]*<\/BrowserRouter>[\s\S]*<\/ErrorBoundary>/.test(
      src('src/main.tsx')
    ),
    'ErrorBoundary 包在 Router/App 外层（崩了才兜得住）'
  );
  has('src/components/ErrorBoundary.tsx', 'componentDidCatch', 'ErrorBoundary 记录组件栈');

  // D7. 错误兜底：真渲染兜底 UI
  //
  // ⚠️ 不能用 renderToStaticMarkup(<ErrorBoundary><Boom/></ErrorBoundary>) 验证：
  // React 18 的 **SSR 不支持错误边界**（renderToString/legacy 渲染器会在服务端
  // 把错误原样抛出来），那样测到的是 React 的限制，不是我们的组件。
  // 所以拆成两半各测一半的契约：
  //   ① getDerivedStateFromError：错误 → state（React 崩溃时的入口）
  //   ② 手动把实例置成错误态，渲染它真正 render() 出来的 UI
  {
    const { ErrorBoundary } = await import('../src/components/ErrorBoundary.js');
    const { renderToStaticMarkup } = await import('react-dom/server');

    const derived = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
    ok(derived.error instanceof Error && derived.error.message === 'boom',
      'getDerivedStateFromError 把错误写进 state（React 崩溃时的入口）');

    const inst = new ErrorBoundary({ children: null });
    inst.state = { error: new Error('render blew up') };
    const html = renderToStaticMarkup(inst.render());
    ok(html.includes('界面出错了'), '错误态渲染兜底标题（而不是白屏）', html.slice(0, 80));
    ok(html.includes('重新加载'), '兜底 UI 有可点的重载按钮');
    ok(html.includes('render blew up'), '兜底 UI 展示错误详情（报问题用得上）');
    ok(html.includes('不会因此丢失'), '兜底 UI 安抚「数据丢了」的担忧');
    ok(!html.includes('undefined'), '兜底 UI 没有渲染出 undefined（字段拼写检查）');

    // 正常态必须原样透传 children，不能被边界破坏
    const React = (await import('react')).default;
    const fine = new ErrorBoundary({ children: React.createElement('span', null, '正常内容') });
    ok(fine.state.error === null, '正常态 error 为 null');
    ok(fine.render() === fine.props.children, '正常态 render 直接透传 children');
  }

  // 收尾
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上连接可能未释放，忽略 */
  }
}

function section() {
  // 分节只影响可读性，没有断言语义
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(
        `\n✗ P6 用量/导出断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`
      );
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log(`\nP6 用量/导出断言：${checks.total}/${checks.total} 通过`);
    console.log('✓ 用量三项（耗时/费用/token）各就各位、落库读回一致、无数据不渲染');
    console.log('✓ 会话导出为 Markdown：元信息/正文/工具摘要/图片/文件名安全');
    console.log('✓ done→落库→接口→前端四段 glue 由源码契约钉死');
  })
  .catch(err => {
    console.error('验证脚本异常:', err);
    process.exit(1);
  });
