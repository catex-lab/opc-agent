/**
 * A175 / A176 验收闸门：知识库自动注入 + kb.search 工具面。
 *
 * 覆盖：
 *   1. 首轮注入片段含 citationId，且 citation 与会话标题可追溯；
 *   2. 零命中只注入一行状态，不出现任何 `[KB:` 标记；
 *   3. 索引层/会话异常时不抛出（调用方按原 prompt 继续）；
 *   4. 注入固定 workspace：project/all 即使已开启也不会被注入吃掉；
 *      群聊 source_only 不会进入 workspace 注入；
 *   5. 工具入参拒绝 sessionId / 路径；scope 越权被 service 层拒绝；
 *   6. CLI 参数生成含 `--mcp-config` 与 `mcp__kb__search`。
 *
 * 全部在临时 OPC_DATA_DIR 里跑，不碰真实 data/。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failures: string[] = [];
let checks = 0;

function ok(name: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

function section(title: string): void {
  console.log(`\n[${title}]`);
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-kb-inject-'));
  process.env.OPC_DATA_DIR = dataDir;
  console.log(`临时数据目录: ${dataDir}`);

  // env 必须在 import 前设置；全部动态导入
  const chat = await import('../server/db.js');
  const kb = await import('../server/kb/indexer.js');
  const store = await import('../server/kb/store.js');
  const inject = await import('../server/kb/inject.js');
  const tool = await import('../server/kb/tool.js');
  const definitions = await import('../server/agents/definitions.js');

  const nowIso = new Date().toISOString();
  const projectA = chat.getOrCreateProject('E:/tmp/opc-kb-inject-ws-a')!;
  const projectB = chat.getOrCreateProject('E:/tmp/opc-kb-inject-ws-b')!;

  const makeSession = (opts: {
    id: string;
    cwd: string | null;
    kind?: 'direct' | 'group';
    agentId?: string | null;
    projectId?: string | null;
  }) =>
    chat.createSession({
      id: opts.id,
      title: opts.id,
      model: 'test-model',
      agent_id: opts.agentId ?? 'claude',
      sdk_session_id: null,
      kind: opts.kind ?? 'direct',
      agent_ids: opts.kind === 'group' ? JSON.stringify(['claude', 'qoder']) : null,
      orchestration: opts.kind === 'group' ? 'broadcast' : null,
      cwd: opts.cwd,
      reasoning_effort: null,
      scenario_id: null,
      system_prompt: null,
      permission_mode: null,
      project_id: opts.projectId ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    });

  const sA = makeSession({ id: 's-a', cwd: 'E:/tmp/opc-kb-inject-ws-a', projectId: projectA.id });
  const sB = makeSession({ id: 's-b', cwd: 'E:/tmp/opc-kb-inject-ws-b', projectId: projectB.id });
  const sGroup = makeSession({
    id: 's-group',
    cwd: 'E:/tmp/opc-kb-inject-ws-a',
    kind: 'group',
    agentId: null,
    projectId: projectA.id,
  });

  const msg = (id: string, sessionId: string, role: 'user' | 'assistant', content: string, authorAgentId?: string) =>
    chat.createMessage({
      id,
      session_id: sessionId,
      role,
      content,
      model: 'test-model',
      author_agent_id: authorAgentId ?? null,
      created_at: nowIso,
      tool_calls: null,
      blocks: null,
    });

  msg('a-1', sA.id, 'user', '项目甲：并发写冲突，E1024 报错。');
  msg('a-2', sA.id, 'assistant', '并发写冲突通常来自两个会话同时改写同一个文件。');
  msg('b-1', sB.id, 'user', '项目乙独有主题：向量检索预算评估。');
  msg('g-1', sGroup.id, 'assistant', '群聊独有暗号：群组秘钥XYZ。', 'qoder');

  /* ═══════════ 1. 建索引 ═══════════ */
  section('索引与首轮注入');
  kb.bootKnowledgeBase({ backfill: false });
  kb.backfillRecent(90);

  const hit = inject.buildKbInjection(sA.id, '并发写冲突');
  ok('首轮有命中时返回注入', Boolean(hit), JSON.stringify(hit?.count));
  ok('注入片段含 citationId 标记', Boolean(hit?.promptPrefix.match(/\[KB:[^\]]+\]/)), hit?.promptPrefix?.slice(0, 80));
  ok(
    '注入的 citationId 与 citations 一致',
    Boolean(hit && hit.count > 0 && hit.promptPrefix.includes(hit.citations[0]!.citationId))
  );
  ok('首轮注入条数不超过 top-4', Boolean(hit && hit.count <= inject.KB_INJECT_TOP_K), String(hit?.count));
  ok('注入元信息带来源会话标题/时间', Boolean(hit?.citations[0]?.sessionTitle && hit.citations[0].timeEnd));

  /* ═══════════ 2. 零命中与失败 ═══════════ */
  section('零命中与失败降级');
  const empty = inject.buildKbInjection(sA.id, 'qqqqvvvvxxxx');
  ok('零命中仍返回一行状态', Boolean(empty && empty.count === 0));
  ok('零命中只注入状态行', Boolean(empty && empty.promptPrefix.includes(inject.KB_EMPTY_STATUS_LINE)));
  ok('零命中不出现 citation 标记', Boolean(empty && !empty.promptPrefix.includes('[KB:')));
  ok('零命中 tokensUsed 为 0', Boolean(empty && empty.tokensUsed === 0));

  let threw = false;
  let missing: unknown = undefined;
  try {
    missing = inject.buildKbInjection('missing-session', '并发写冲突');
  } catch {
    threw = true;
  }
  ok('会话不存在时不抛出（失败不阻断）', !threw && missing === null);

  /* ═══════════ 3. 范围收口 ═══════════ */
  section('范围收口与 source_only');
  const crossWorkspace = inject.buildKbInjection(sA.id, '向量检索预算');
  ok('workspace 注入不跨工作区', Boolean(crossWorkspace && crossWorkspace.count === 0));

  const groupOnlyFromA = inject.buildKbInjection(sA.id, '群组秘钥XYZ');
  ok('群聊 source_only 不进入工作区注入', Boolean(groupOnlyFromA && groupOnlyFromA.count === 0));

  // 群聊首轮注入同样走 workspace：source_only 只在「显式 session 范围」可见，
  // 所以这里连本群自己的内容也不该被注入 —— 隐私口径优先于召回率。
  const groupOwn = inject.buildKbInjection(sGroup.id, '群组秘钥XYZ');
  ok('群聊首轮注入（workspace）不注入 source_only', Boolean(groupOwn && groupOwn.count === 0));
  const groupToolSession = tool.executeKbSearchTool({ query: '群组秘钥XYZ', scope: 'session' }, sGroup.id);
  ok('工具显式 scope=session 才可检索本群 source_only', groupToolSession.citations.length > 0);
  ok('显式 session 命中的切片标记 sourceType=group', groupToolSession.citations[0]?.sourceType === 'group');

  // 即使策略已放行 project/all，注入也只能是 workspace
  store.setScopePolicy({ allowProject: true, allowAll: true });
  const stillWorkspace = inject.buildKbInjection(sA.id, '向量检索预算');
  ok('project/all 已开启时注入仍固定 workspace', Boolean(stillWorkspace && stillWorkspace.count === 0));

  /* ═══════════ 4. 工具入参与越权 ═══════════ */
  section('kb.search 工具');
  const valid = tool.executeKbSearchTool({ query: '并发写冲突', topK: 2 }, sA.id);
  ok('合法入参返回 citationId', valid.citations.length > 0 && Boolean(valid.citations[0]!.citationId));
  ok('工具返回范围标记为 workspace', valid.scopeApplied === 'workspace');
  ok('工具 topK 被收口到 4 以内', valid.citations.length <= 4);

  const expectThrow = (fn: () => unknown, name: string) => {
    let raised = false;
    let message = '';
    try {
      fn();
    } catch (err) {
      raised = true;
      message = err instanceof Error ? err.message : String(err);
    }
    ok(name, raised, message);
  };

  expectThrow(
    () => tool.executeKbSearchTool({ query: 'x', sessionId: 's-b' }, sA.id),
    '工具拒绝客户端传 sessionId'
  );
  expectThrow(
    () => tool.executeKbSearchTool({ query: 'x', path: 'E:/secret' }, sA.id),
    '工具拒绝客户端传路径'
  );
  expectThrow(
    () => tool.executeKbSearchTool({ query: '' }, sA.id),
    '工具拒绝空 query'
  );
  expectThrow(
    () => tool.executeKbSearchTool({ query: 'x' }, undefined),
    '缺少宿主 sessionId 时拒绝执行'
  );

  // 先把策略收回，验证越权 scope 被 service 层拒绝
  store.setScopePolicy({ allowProject: false, allowAll: false });
  expectThrow(
    () => tool.executeKbSearchTool({ query: '向量检索预算', scope: 'all' }, sA.id),
    '未开启全部范围时 scope=all 被拒绝'
  );

  /* ═══════════ 5. CLI 参数生成 ═══════════ */
  section('CLI 参数生成');
  const ctx = {
    sessionId: sA.id,
    prompt: 'hi',
    model: 'test-model',
    permissionMode: 'default' as const,
    // 场景白名单用的是 ScenarioTool（file/shell/search/tools），不是工具全名
    allowedTools: ['file'],
  };
  const claude = definitions.findDef('claude');
  const claudeArgs = claude?.cli?.buildArgs('hi', ctx as never) ?? [];
  ok('claude 参数含 --mcp-config', claudeArgs.includes('--mcp-config'), claudeArgs.join(' '));
  ok('claude 参数含 mcp__kb__search', claudeArgs.includes('mcp__kb__search'), claudeArgs.join(' '));

  const qoder = definitions.findDef('qoder');
  const qoderArgs = qoder?.cli?.buildArgs('hi', ctx as never) ?? [];
  ok('qoder 参数含 --mcp-config', qoderArgs.includes('--mcp-config'), qoderArgs.join(' '));
  const idx = qoderArgs.indexOf('--mcp-config');
  const configPath = idx >= 0 ? qoderArgs[idx + 1] : undefined;
  ok('mcp 配置文件落在 data/extensions', Boolean(configPath && configPath.includes(`${path.sep}extensions${path.sep}`)), String(configPath));
  ok(
    'mcp 配置声明 kb server',
    Boolean(configPath && fs.existsSync(configPath!) && fs.readFileSync(configPath!, 'utf8').includes('"kb"')),
    String(configPath)
  );

  /* ═══════════ 6. 前端接线与诚实边界 ═══════════ */
  section('前端提示与能力边界');
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  ok('回答区渲染知识库引用', read('src/components/ChatMessages.tsx').includes('data-kb-refs'));
  ok('单聊消费 kb_refs 事件', read('src/hooks/useChat.ts').includes("case 'kb_refs'"));
  ok('群聊消费 kb_refs 事件', read('src/hooks/useGroupChat.ts').includes("case 'kb_refs'"));
  ok('HTTP 型不声明 MCP 工具', !read('server/agents/adapters/http.ts').includes('mcpServers:'));
  ok('Codex SDK 不声明 MCP 工具', !read('server/agents/adapters/codex-sdk.ts').includes('mcpServers:'));

  /* ═══════════ 汇总 ═══════════ */
  console.log(`\n结果: ${checks - failures.length}/${checks} 通过`);
  if (failures.length > 0) {
    console.error(`失败项: ${failures.join('; ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
