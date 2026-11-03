/**
 * A175 / A176 验收闸门：知识库自动注入 + kb.search 工具面。
 *
 * 覆盖：
 *   1. 首轮注入片段含 citationId，且 citation 与会话标题可追溯；
 *   2. 零命中只注入一行状态，不出现任何 `[KB:` 标记；
 *   3. 索引层/会话异常时不抛出（调用方按原 prompt 继续）；
 *   4. 注入固定 workspace：project/all 即使已开启也不会被注入吃掉；
 *      P3 起群聊内容对同工作区可见，但跨工作区仍不可见；
 *   5. 工具入参拒绝 sessionId / 路径；scope 越权被 service 层拒绝；
 *   6. CLI 参数生成含 `--mcp-config` 与 `mcp__kb__search`；
 *   7. P3：向量混合检索（无向量自动降级 BM25）、近似去重、体积治理。
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

/** 断言抛错并返回错误文案，供「拒绝理由」类断言复用。 */
function expectThrow(fn: () => unknown, name: string): string {
  let raised = false;
  let message = '';
  try {
    fn();
  } catch (err) {
    raised = true;
    message = err instanceof Error ? err.message : String(err);
  }
  ok(name, raised, message);
  return message;
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
  const optout = await import('../server/kb/optout.js');
  const search = await import('../server/kb/search.js');
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

  /* ═══════════ 3. 工具开关：默认关闭 / 逐 Agent 开启 ═══════════ */
  section('工具开关：默认关闭 / 逐 Agent 开启');
  ok('默认策略下 claude 的工具开关为关', optout.isKbToolEnabled('claude') === false);
  ok('默认策略下 qoder 的工具开关为关', optout.isKbToolEnabled('qoder') === false);
  const defaultDenied = expectThrow(
    () => tool.executeKbSearchTool({ query: '并发写冲突' }, sA.id, 'claude'),
    '默认关闭时工具调用被拒'
  );
  ok('拒绝文案说明「默认关闭」与开启入口', defaultDenied.includes('默认关闭'), defaultDenied);

  // 开关与自动注入是两回事：工具关着，首轮注入照常发生。
  const injectWhileClosed = inject.buildKbInjection(sA.id, '并发写冲突');
  ok('工具关闭不影响首轮自动注入', Boolean(injectWhileClosed && injectWhileClosed.count > 0));

  optout.setKbToolEnabled('claude', true);
  optout.setKbToolEnabled('qoder', true);
  ok('写入开关后 claude 为开', optout.isKbToolEnabled('claude') === true);
  const enabledCall = tool.executeKbSearchTool({ query: '并发写冲突', topK: 2 }, sA.id, 'claude');
  ok(
    '开启后工具可调用且返回 citationId',
    enabledCall.citations.length > 0 && Boolean(enabledCall.citations[0]!.citationId)
  );

  /* ═══════════ 4. 范围收口与 source_only ═══════════ */
  section('范围收口与 source_only');
  const crossWorkspace = inject.buildKbInjection(sA.id, '向量检索预算');
  ok('workspace 注入不跨工作区', Boolean(crossWorkspace && crossWorkspace.count === 0));

  const groupOnlyFromA = inject.buildKbInjection(sA.id, '群组秘钥XYZ');
  ok('P3：群聊内容对同工作区的会话可见', Boolean(groupOnlyFromA && groupOnlyFromA.count > 0));
  ok(
    '命中的群聊切片标记 sourceType=group',
    groupOnlyFromA?.citations[0]?.sourceType === 'group',
    JSON.stringify(groupOnlyFromA?.citations[0])
  );

  // 跨工作区仍是硬边界：群聊在 workspace B 不可见。
  const groupCrossWorkspace = inject.buildKbInjection(sB.id, '群组秘钥XYZ');
  ok(
    '群聊内容不跨工作区',
    Boolean(groupCrossWorkspace && groupCrossWorkspace.count === 0),
    JSON.stringify(
      groupCrossWorkspace?.citations.map(c => ({
        sessionId: c.sessionId,
        workspaceKey: c.workspaceKey,
      }))
    )
  );

  // session 范围只看本会话：单聊不能借 session 读到群聊内容。
  const directSession = search.searchKnowledge({
    sessionId: sA.id,
    query: '群组秘钥XYZ',
    scope: 'session',
  });
  ok('单聊 session 范围看不到群聊消息', directSession.hits.length === 0);

  // 群聊自己的首轮注入（workspace）同样能看到自己。
  const groupOwn = inject.buildKbInjection(sGroup.id, '群组秘钥XYZ');
  ok('群聊首轮注入（workspace）可见自己的内容', Boolean(groupOwn && groupOwn.count > 0));
  const groupToolSession = tool.executeKbSearchTool(
    { query: '群组秘钥XYZ', scope: 'session' },
    sGroup.id,
    'qoder'
  );
  ok('工具显式 scope=session 才可检索本群 source_only', groupToolSession.citations.length > 0);
  ok('显式 session 命中的切片标记 sourceType=group', groupToolSession.citations[0]?.sourceType === 'group');

  // 即使策略已放行 project/all，注入也只能是 workspace
  store.setScopePolicy({ allowProject: true, allowAll: true });
  const stillWorkspace = inject.buildKbInjection(sA.id, '向量检索预算');
  ok('project/all 已开启时注入仍固定 workspace', Boolean(stillWorkspace && stillWorkspace.count === 0));

  /* ═══════════ 5. 工具入参与越权 ═══════════ */
  section('kb.search 工具');
  ok('工具返回范围标记为 workspace', enabledCall.scopeApplied === 'workspace');
  ok('工具 topK 被收口到 4 以内', enabledCall.citations.length <= 4);

  expectThrow(
    () => tool.executeKbSearchTool({ query: 'x', sessionId: 's-b' }, sA.id, 'claude'),
    '工具拒绝客户端传 sessionId'
  );
  expectThrow(
    () => tool.executeKbSearchTool({ query: 'x', path: 'E:/secret' }, sA.id, 'claude'),
    '工具拒绝客户端传路径'
  );
  expectThrow(
    () => tool.executeKbSearchTool({ query: '' }, sA.id, 'claude'),
    '工具拒绝空 query'
  );
  expectThrow(
    () => tool.executeKbSearchTool({ query: 'x' }, undefined, 'claude'),
    '缺少宿主 sessionId 时拒绝执行'
  );
  expectThrow(
    () => tool.executeKbSearchTool({ query: 'x' }, sA.id, undefined),
    '缺少宿主 agentId 时拒绝执行'
  );

  // 开关打开也不能绕过范围：project/all 仍受 policy.allow_* 约束
  store.setScopePolicy({ allowProject: false, allowAll: false });
  const scopeDenied = expectThrow(
    () => tool.executeKbSearchTool({ query: '向量检索预算', scope: 'all' }, sA.id, 'claude'),
    '开关已打开但 scope=all 未放行时仍被拒绝'
  );
  ok('越权拒绝由服务端范围策略给出', scopeDenied.includes('未开启'), scopeDenied);

  /* ═══════════ 6. 每轮上限 2 次 ═══════════ */
  section('每轮上限与轮次重置');
  // 上面 enabledCall 已成功 1 次，这是本轮第 2 次
  const second = tool.executeKbSearchTool({ query: '并发写冲突' }, sA.id, 'claude');
  ok('本轮第 2 次仍可用', second.citations.length > 0);
  const thirdDenied = expectThrow(
    () => tool.executeKbSearchTool({ query: '并发写冲突' }, sA.id, 'claude'),
    '本轮第 3 次被拒'
  );
  ok('上限拒绝文案含「2 次」', thirdDenied.includes(`${optout.KB_TOOL_MAX_PER_TURN} 次`), thirdDenied);
  ok('上限拒绝文案说明下一轮重置', thirdDenied.includes('下一轮'), thirdDenied);

  // 同一会话的新一轮：最新 user 消息变了，计数应重置
  msg('a-3', sA.id, 'user', '新一轮提问：还有别的冲突场景吗？');
  const newTurn = tool.executeKbSearchTool({ query: '并发写冲突' }, sA.id, 'claude');
  ok('新的一轮计数重置后可继续检索', newTurn.citations.length > 0);

  // 关闭即时生效：不需要重启进程，下一次调用立刻被拒
  optout.setKbToolEnabled('claude', false);
  const closedAgain = expectThrow(
    () => tool.executeKbSearchTool({ query: '并发写冲突' }, sA.id, 'claude'),
    '关闭后下一次调用立即被拒'
  );
  ok('关闭后的拒绝仍是「未开启」口径', closedAgain.includes('未开启'), closedAgain);
  const injectWhileClosedAgain = inject.buildKbInjection(sA.id, '并发写冲突');
  ok(
    '关闭工具后自动注入仍然生效',
    Boolean(injectWhileClosedAgain && injectWhileClosedAgain.count > 0)
  );

  /* ═══════════ 7. CLI 参数生成 ═══════════ */
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
  ok(
    'mcp 配置把 Agent 标识注入子进程',
    Boolean(
      configPath &&
        fs.existsSync(configPath!) &&
        JSON.parse(fs.readFileSync(configPath!, 'utf8')).mcpServers.kb.env.OPC_KB_AGENT_ID ===
          'qoder'
    ),
    String(configPath)
  );

  const sdkSpec = tool.kbMcpServerSpec(sA.id, 'claude');
  ok('SDK spec 注入 OPC_KB_AGENT_ID', sdkSpec.env.OPC_KB_AGENT_ID === 'claude', JSON.stringify(sdkSpec.env));
  ok('SDK spec 注入 OPC_KB_SESSION_ID', sdkSpec.env.OPC_KB_SESSION_ID === sA.id);

  /* ═══════════ 8. P3：混合检索 / 降级 / 去重 / 治理 ═══════════ */
  section('P3 混合检索与降级');
  const hybrid = search.searchKnowledge({
    sessionId: sA.id,
    query: '并发写冲突',
    scope: 'workspace',
  });
  ok('索引后默认走向量混合检索', hybrid.retrieval === 'hybrid', hybrid.retrieval);
  ok('向量候选参与融合', hybrid.vectorCandidates > 0, String(hybrid.vectorCandidates));
  ok('混合检索仍返回原有 hits 结构', hybrid.hits.length > 0 && Boolean(hybrid.hits[0]!.citationId));

  process.env.OPC_KB_VECTOR = 'off';
  const vectorOff = search.searchKnowledge({
    sessionId: sA.id,
    query: '并发写冲突',
    scope: 'workspace',
  });
  ok('关闭向量层自动降级为纯 BM25', vectorOff.retrieval === 'bm25', vectorOff.retrieval);
  ok('降级后仍有 BM25 命中', vectorOff.hits.length > 0);
  delete process.env.OPC_KB_VECTOR;

  // 无向量（老库/回填未完成）也必须能查：这是契约里的自动降级。
  store.deleteAllChunkVectors();
  const noVectors = search.searchKnowledge({
    sessionId: sA.id,
    query: '并发写冲突',
    scope: 'workspace',
  });
  ok('无向量时自动降级为纯 BM25', noVectors.retrieval === 'bm25', noVectors.retrieval);
  ok('无向量时 BM25 结果不受影响', noVectors.hits.length > 0);
  const restoredVectors = kb.backfillMissingVectors();
  ok(
    '缺失向量可增量回填',
    restoredVectors > 0 && store.countChunkVectors() >= restoredVectors,
    `${restoredVectors} / ${store.countChunkVectors()}`
  );

  section('P3 近似去重');
  const sDupA = makeSession({
    id: 's-dup-a',
    cwd: 'E:/tmp/opc-kb-inject-ws-a',
    projectId: projectA.id,
  });
  const sDupB = makeSession({
    id: 's-dup-b',
    cwd: 'E:/tmp/opc-kb-inject-ws-a',
    projectId: projectA.id,
  });
  const dupText =
    '缓存击穿会导致大量请求同时回源数据库，需要加互斥锁与短期空值缓存，避免把数据库打垮。';
  msg('dup-a', sDupA.id, 'user', dupText);
  msg('dup-b', sDupB.id, 'user', dupText);
  kb.indexSession(sDupA.id, { force: true });
  kb.indexSession(sDupB.id, { force: true });

  const dedup = search.searchKnowledge({
    sessionId: sA.id,
    query: '缓存击穿',
    scope: 'workspace',
    topK: 4,
  });
  const dupHits = dedup.hits.filter(h => h.sessionId === sDupA.id || h.sessionId === sDupB.id);
  ok('近似重复在结果里合并为一条', dupHits.length === 1, String(dupHits.length));
  ok('合并计数大于 0', dedup.dedupedCount >= 1, String(dedup.dedupedCount));
  ok(
    '被合并的来源仍可追溯',
    Boolean(dupHits[0]?.mergedCitationIds && dupHits[0].mergedCitationIds.length >= 1),
    JSON.stringify(dupHits[0]?.mergedCitationIds)
  );

  section('P3 体积治理与可观测指标');
  const stats = store.getStats();
  console.log(
    `[metrics] db=${(stats.sizeBytes / 1024).toFixed(1)}KB chunks=${stats.chunkCount} ` +
      `vectors=${stats.vectorCount} sessions=${stats.sessionCount} failed=${stats.failedSessionCount}`
  );
  ok('状态暴露体积与 chunk 数', stats.sizeBytes > 0 && stats.chunkCount > 0);
  ok('状态暴露向量条数', stats.vectorCount > 0);
  ok('状态暴露失败会话数', typeof stats.failedSessionCount === 'number');
  ok(
    '状态暴露治理阈值',
    stats.limits.maxBytes > 0 && stats.limits.maxChunks > 0,
    JSON.stringify(stats.limits)
  );

  const beforeChunks = store.countChunks();
  const dry = store.pruneKnowledgeBase({
    maxChunks: Math.max(1, beforeChunks - 2),
    dryRun: true,
  });
  ok('dryRun 只估算不删除', dry.deletedChunks > 0 && store.countChunks() === beforeChunks);

  const bySession = store.pruneKnowledgeBase({ sessionIds: [sDupB.id] });
  ok('按会话清理删除该会话切片', bySession.deletedChunks > 0, String(bySession.deletedChunks));
  ok('按会话清理同时移除会话状态', bySession.deletedSessions === 1, String(bySession.deletedSessions));

  const beforeSizePrune = store.countChunks();
  const bySize = store.pruneKnowledgeBase({ maxChunks: Math.max(1, beforeSizePrune - 2) });
  ok('按大小上限从最旧切片开始删除', bySize.deletedChunks > 0, String(bySize.deletedChunks));
  ok('清理后 chunk 数下降', bySize.chunkCount < beforeSizePrune, `${beforeSizePrune} → ${bySize.chunkCount}`);
  ok(
    '清理后向量随切片一起减少',
    bySize.vectorCount <= stats.vectorCount,
    `${stats.vectorCount} → ${bySize.vectorCount}`
  );

  // 检索延迟实测（混合检索 + 去重，20 次平均，仅打印供回报）。
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) {
    search.searchKnowledge({ sessionId: sA.id, query: '并发写冲突', scope: 'workspace' });
  }
  const avgMs = (performance.now() - t0) / 20;
  console.log(`[metrics] 混合检索平均 ${avgMs.toFixed(2)}ms/次（含去重，20 次平均）`);

  /* ═══════════ 9. 前端接线与诚实边界 ═══════════ */
  section('前端提示与能力边界');
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  ok('回答区渲染知识库引用', read('src/components/ChatMessages.tsx').includes('data-kb-refs'));
  ok('知识库面板提供逐 Agent 开关', read('src/components/kb/KnowledgeBasePanel.tsx').includes('data-kb-tool-toggle'));
  ok('前端调用工具策略接口', read('src/components/kb/kbApi.ts').includes('/api/kb/tool-policy'));
  ok('服务端注册工具策略接口', read('server/kb/routes.ts').includes('/api/kb/tool-policy'));
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
