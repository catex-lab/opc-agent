/**
 * P1 知识库索引层验证。
 *
 * 覆盖：切片边界与重叠、脱敏（含 .env / token 不残留）、群聊 source_only、
 * 工具与验证输出不入库、范围越权被 SQL 层拦截、中文 <3 字 LIKE 兜底、
 * 90 天回填窗口、整库重建幂等。
 *
 * 用临时 OPC_DATA_DIR，不碰真实 data/。
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

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-kb-verify-'));
  process.env.OPC_DATA_DIR = dataDir;
  console.log(`临时数据目录: ${dataDir}`);

  // env 必须在 import 前设置；全部动态导入
  const chat = await import('../server/db.js');
  const chunkMod = await import('../server/kb/chunk.js');
  const redact = await import('../server/kb/redact.js');
  const kb = await import('../server/kb/indexer.js');
  const store = await import('../server/kb/store.js');
  const searchMod = await import('../server/kb/search.js');

  const nowIso = new Date().toISOString();
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

  /* ═══════════ 1. 纯切片边界 ═══════════ */
  section('切片边界与重叠');

  const makeMsg = (id: string, size: number, role: 'user' | 'assistant' = 'user') => ({
    id,
    role,
    text: '字'.repeat(Math.round(size * 1.5)), // 1.5 字 ≈ 1 token
    authorAgentId: null,
    createdAt: nowIso,
  });

  const normal = Array.from({ length: 9 }, (_, i) => makeMsg(`m${i}`, 100));
  const windows = chunkMod.chunkMessages(normal);
  const allSizes = windows.map(w =>
    w.messages.reduce((sum, m) => sum + chunkMod.estimateTokens(m.text), 0)
  );
  ok('窗口 token 不超过硬上限 400', allSizes.every(n => n <= 400), JSON.stringify(allSizes));
  ok('窗口按目标 300 收口（3×100）', allSizes.every(n => n <= 300), JSON.stringify(allSizes));
  ok('每个窗口非空', windows.every(w => w.messages.length > 0));
  ok(
    '相邻窗口保留 1 条消息重叠',
    windows.slice(1).every((w, i) => w.messages[0].id === windows[i].messages.at(-1)!.id),
    JSON.stringify(windows.map(w => w.messages.map(m => m.id)))
  );
  const seen = new Set(windows.flatMap(w => w.messages.map(m => m.id)));
  ok('所有消息都被覆盖', normal.every(m => seen.has(m.id)));

  const huge = makeMsg('huge', 500);
  const hugeWindows = chunkMod.chunkMessages([huge]);
  ok('超长消息被拆段', hugeWindows.length >= 2, `${hugeWindows.length} 段`);
  ok(
    '拆段后每段仍不超过 400',
    hugeWindows.every(w => chunkMod.estimateTokens(w.messages[0].text) <= 400)
  );
  ok(
    '拆段保留同一条 messageId 与段序号',
    hugeWindows.every((w, i) => w.messages[0].id === 'huge' && w.messages[0].part === i && w.messages[0].partsTotal === hugeWindows.length)
  );

  const incr = chunkMod.chunkMessages([makeMsg('m3', 80)], normal[1]);
  ok(
    '增量切片把上一条已索引消息作为重叠',
    incr.length === 1 && incr[0].messages[0].id === 'm1' && incr[0].messages.some(m => m.id === 'm3'),
    JSON.stringify(incr.map(w => w.messages.map(m => m.id)))
  );

  /* ═══════════ 2. 脱敏纯函数 ═══════════ */
  section('脱敏');

  // 闸门夹具：故意构造的假密钥，不是真凭据
  const secret = 'sk-proj-ABCDEF1234567890'; // secret-scan:ignore
  const envValue = 'hunter2-secret-value';
  const raw = [
    `apiKey: "${secret}"`,
    `OPENAI_API_KEY=${secret}`,
    `DB_PASSWORD=${envValue}`,
    'Authorization: Bearer abcdef1234567890',
    'https://user:pass@example.com/api',
  ].join('\n');
  const redacted = redact.redactOrFail(raw);
  ok('已删除已知 token 形态', !contains(redacted.text, secret));
  ok('已删除 .env 值', !contains(redacted.text, envValue));
  ok('已删除 Bearer 凭据', !contains(redacted.text, 'abcdef1234567890'));
  ok('已删除 URL userinfo', !contains(redacted.text, 'user:pass'));
  ok('删除计数大于 0', redacted.redactedCount > 0, String(redacted.redactedCount));
  ok('清洗后残留扫描通过', redact.findRedactionResidue(redacted.text).length === 0);
  ok(
    '未清洗文本会被残留扫描拦下',
    redact.findRedactionResidue(raw).length > 0
  );

  // 脱敏收窄：只有「敏感键名 + 典型 .env 形态」两个条件同时成立才删值
  const configLike = [
    'PORT=8080',
    'FEATURE_FLAG=true',
    'const x = 1',
    'MONKEY=animal',
    'GITHUB_TOKEN=plainvalue1234567890',
  ].join('\n');
  const kept = redact.redactOrFail(configLike);
  ok('非敏感配置值保留（PORT=8080）', contains(kept.text, 'PORT=8080'), kept.text);
  ok('非敏感开关值保留（FEATURE_FLAG=true）', contains(kept.text, 'FEATURE_FLAG=true'), kept.text);
  ok('代码 const x = 1 不被误删', contains(kept.text, 'const x = 1'), kept.text);
  ok('接近普通单词的键名不误判（MONKEY）', contains(kept.text, 'MONKEY=animal'), kept.text);
  ok(
    '敏感键名仍整段删除（GITHUB_TOKEN）',
    !contains(kept.text, 'ghp_NOTAREALTOKEN1234567890') && contains(kept.text, 'GITHUB_TOKEN='),
    kept.text
  );

  /* ═══════════ 3. 造会话（boot 前） ═══════════ */
  section('建立会话与消息');

  const projectA = chat.getOrCreateProject('E:/tmp/opc-kb-ws-a')!;
  const projectB = chat.getOrCreateProject('E:/tmp/opc-kb-ws-b')!;

  function makeSession(opts: {
    id: string;
    cwd: string | null;
    kind?: 'direct' | 'group';
    agentId?: string | null;
    projectId?: string | null;
  }) {
    return chat.createSession({
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
  }

  const sA = makeSession({ id: 's-a', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  const sB = makeSession({ id: 's-b', cwd: 'E:/tmp/opc-kb-ws-b', projectId: projectB.id });
  const sGroup = makeSession({
    id: 's-group',
    cwd: 'E:/tmp/opc-kb-ws-a',
    kind: 'group',
    agentId: null,
    projectId: projectA.id,
  });
  const sTool = makeSession({ id: 's-tool', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  const sOld = makeSession({ id: 's-old', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  // 无工作目录的会话：默认范围（本会话 + 本工作区）不应把它漏掉。
  const sNocwd = makeSession({ id: 's-nocwd', cwd: null });

  const msg = (
    id: string,
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    extra: { createdAt?: string; authorAgentId?: string; blocks?: string; toolCalls?: string } = {}
  ) =>
    chat.createMessage({
      id,
      session_id: sessionId,
      role,
      content,
      model: 'test-model',
      author_agent_id: extra.authorAgentId ?? null,
      created_at: extra.createdAt ?? nowIso,
      tool_calls: extra.toolCalls ?? null,
      blocks: extra.blocks ?? null,
    });

  msg('a-1', sA.id, 'user', '我们在项目甲里讨论并发写冲突，E1024 报错。');
  msg('a-2', sA.id, 'assistant', '并发写冲突通常来自两个会话同时改写同一个文件。');
  msg('b-1', sB.id, 'user', '项目乙的独有主题：向量检索预算评估。');
  msg('g-1', sGroup.id, 'assistant', '群聊里的独有暗号：群组秘钥XYZ。', { authorAgentId: 'qoder' });
  msg('t-1', sTool.id, 'assistant', '工具测试的最终答案。', {
    blocks: JSON.stringify([
      { type: 'text', text: '工具测试的最终答案。' },
      { type: 'tool', text: 'TOOL_ONLY_MARKER' },
    ]),
    toolCalls: JSON.stringify([{ output: 'TOOL_ONLY_MARKER' }]),
  });
  msg('v-1', sTool.id, 'assistant', '验证输出不会进索引。');
  chat.createVerification({
    id: 'verify-1',
    session_id: sTool.id,
    message_id: null,
    command_id: 'c1',
    command: 'npm test',
    kind: 'test',
    label: null,
    status: 'pass',
    exit_code: 0,
    duration_ms: 10,
    output: 'VERIFY_ONLY_MARKER 全部通过',
    output_truncated: 0,
    created_at: nowIso,
  });

  msg('old-1', sOld.id, 'user', '这是一百二十天前的历史归档词记录。', { createdAt: daysAgo(120) });
  msg('old-2', sOld.id, 'user', '这是最近九十天内的近期记录。', { createdAt: daysAgo(10) });
  msg('n-1', sNocwd.id, 'user', '没有工作目录的会话也要能检索到自己的记录。');

  /* ═══════════ 4. 启动 + 90 天回填 ═══════════ */
  section('启动与 90 天回填');

  const boot = kb.bootKnowledgeBase({ backfill: false });
  ok('索引库已建立', fs.existsSync(store.kbDbPath()));
  ok('状态接口可读', boot.chunkCount === 0 && boot.dbPath.endsWith('kb.sqlite'));

  const recent = kb.backfillRecent(90);
  ok('回填只统计窗口内的会话消息', recent.messages > 0, JSON.stringify(recent));

  const ctxA = searchMod.resolveScopeContext(sA.id);

  const oldTermRecent = searchMod.searchKnowledge({
    query: '历史归档词',
    sessionId: sOld.id,
    scope: 'session',
  });
  ok('90 天窗口外的旧消息未被回填', oldTermRecent.hits.length === 0);

  const newTermRecent = searchMod.searchKnowledge({
    query: '近期记录',
    sessionId: sOld.id,
    scope: 'session',
  });
  ok('90 天窗口内的消息已回填', newTermRecent.hits.length > 0);

  const nocwdDefault = searchMod.searchKnowledge({
    query: '没有工作目录',
    sessionId: sNocwd.id,
  });
  ok(
    '默认范围包含本会话（无 cwd 的会话不会 0 命中）',
    nocwdDefault.hits.length > 0,
    JSON.stringify({ scope: nocwdDefault.scope, hits: nocwdDefault.hits.length })
  );

  /* ═══════════ 5. 检索 / 范围 / 兜底 ═══════════ */
  section('检索与范围强制');

  const ftsHit = searchMod.searchKnowledge({
    query: '并发写冲突',
    sessionId: sA.id,
    scope: 'workspace',
  });
  ok('FTS5 trigram 命中中文', ftsHit.hits.length > 0 && ftsHit.mode === 'fts', JSON.stringify(ftsHit));

  const likeHit = searchMod.searchKnowledge({
    query: '冲突',
    sessionId: sA.id,
    scope: 'workspace',
  });
  ok('中文 <3 字符走 LIKE 兜底并命中', likeHit.mode === 'like' && likeHit.hits.length > 0);

  const crossSession = searchMod.searchKnowledge({
    query: '并发写冲突',
    sessionId: sB.id,
    scope: 'session',
  });
  ok('本会话范围不串到别的会话', crossSession.hits.length === 0);

  const crossWorkspace = searchMod.searchKnowledge({
    query: '向量检索预算',
    sessionId: sA.id,
    scope: 'workspace',
  });
  ok('本工作区范围不串到别的工作区', crossWorkspace.hits.length === 0);

  let deniedProject = false;
  try {
    searchMod.searchKnowledge({ query: '向量检索预算', sessionId: sA.id, scope: 'project' });
  } catch (err) {
    deniedProject = err instanceof searchMod.KbScopeDeniedError;
  }
  ok('本项目范围默认被拒绝', deniedProject);

  let deniedAllSql = false;
  try {
    searchMod.buildScopeWhere('all', ctxA, { allowProject: false, allowAll: false });
  } catch (err) {
    deniedAllSql = err instanceof searchMod.KbScopeDeniedError;
  }
  ok('SQL 层直接拒绝未开启的全部范围', deniedAllSql);

  store.setScopePolicy({ allowProject: true, allowAll: true });

  const projectHit = searchMod.searchKnowledge({
    query: '向量检索预算',
    sessionId: sB.id,
    scope: 'project',
  });
  ok('开启后本项目范围命中同项目', projectHit.hits.length > 0);

  const projectMiss = searchMod.searchKnowledge({
    query: '向量检索预算',
    sessionId: sA.id,
    scope: 'project',
  });
  ok('本项目范围不包含其他项目', projectMiss.hits.length === 0);

  const allHit = searchMod.searchKnowledge({
    query: '向量检索预算',
    sessionId: sA.id,
    scope: 'all',
  });
  ok('开启后全部范围跨工作区命中', allHit.hits.length > 0);

  /* ═══════════ 6. 群聊 / 工具 / 验证 ═══════════ */
  section('群聊与工具输出');

  const groupSearch = searchMod.searchKnowledge({
    query: '群组秘钥XYZ',
    sessionId: sGroup.id,
    scope: 'session',
  });
  ok('群聊在「查自己」时参与检索', groupSearch.hits.length > 0);
  ok(
    '群聊查自己的命中来源标记为群聊',
    groupSearch.hits.every(h => h.sourceType === 'group' && h.visibility === 'source_only'),
    JSON.stringify(groupSearch.hits.map(h => ({ sourceType: h.sourceType, visibility: h.visibility })))
  );

  // 跨会话范围仍不可见：同上项目/工作区也不能把群聊内容带出去
  for (const [label, opts] of [
    ['本会话（别的会话）', { sessionId: sA.id, scope: 'session' as const }],
    ['本工作区', { sessionId: sA.id, scope: 'workspace' as const }],
    ['本项目', { sessionId: sA.id, scope: 'project' as const }],
    ['全部', { sessionId: sA.id, scope: 'all' as const }],
  ] as const) {
    const outside = searchMod.searchKnowledge({ query: '群组秘钥XYZ', ...opts });
    ok(`群聊内容不进入${label}范围`, outside.hits.length === 0, JSON.stringify(outside.hits.map(h => h.sessionId)));
  }

  const groupRows = store
    .getKbDb()
    .prepare('SELECT agent_id, author_agent_id, visibility FROM kb_chunks WHERE session_id = ?')
    .all(sGroup.id) as unknown as Array<{ agent_id: string | null; author_agent_id: string | null; visibility: string }>;
  ok('群聊切片存在但 visibility=source_only', groupRows.length > 0 && groupRows.every(r => r.visibility === 'source_only'));
  ok('群聊 agent_id 置空', groupRows.every(r => r.agent_id === null));
  ok('群聊发言人写 authorAgentId', groupRows.every(r => r.author_agent_id === 'qoder'));

  const toolSearch = searchMod.searchKnowledge({
    query: 'TOOL_ONLY_MARKER',
    sessionId: sTool.id,
    scope: 'session',
  });
  ok('工具输出不入库', toolSearch.hits.length === 0);

  const verifySearch = searchMod.searchKnowledge({
    query: 'VERIFY_ONLY_MARKER',
    sessionId: sTool.id,
    scope: 'session',
  });
  ok('验证输出不入库', verifySearch.hits.length === 0);

  const finalAnswer = searchMod.searchKnowledge({
    query: '最终答案',
    sessionId: sTool.id,
    scope: 'session',
  });
  ok('工具消息的正文仍可检索', finalAnswer.hits.length > 0);

  /* ═══════════ 7. 脱敏落库与出库闸门 ═══════════ */
  section('脱敏落库与出库闸门');

  const sRedact = makeSession({ id: 's-redact', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  msg('r-1', sRedact.id, 'user', '配置如下：\nOPENAI_API_KEY=sk-proj-LEAK9876543210\n请勿外传。');

  const leak = 'sk-proj-LEAK9876543210';
  const leakSearch = searchMod.searchKnowledge({
    query: leak,
    sessionId: sRedact.id,
    scope: 'session',
  });
  ok('秘密值检索不到', leakSearch.hits.length === 0);

  const dbPath = store.kbDbPath();
  store.getKbDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const file of [dbPath, `${dbPath}-wal`]) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    ok(`秘密值不残留在 ${path.basename(file)}`, !contains(bytes.toString('latin1'), leak));
  }

  // 手工把一条切片改成含秘密值，验证出库 fail-closed
  const tampered = store
    .getKbDb()
    .prepare("SELECT id FROM kb_chunks WHERE content LIKE '%并发写冲突%' LIMIT 1")
    .get() as { id: string } | undefined;
  if (tampered) {
    store
      .getKbDb()
      .prepare('UPDATE kb_chunks SET content = ? WHERE id = ?')
      .run('apiKey=sk-proj-TAMPER1234567890', tampered.id); // 夹具：假密钥（secret-scan:ignore）
    const tamperSearch = searchMod.searchKnowledge({
      query: 'sk-proj-TAMPER1234567890', // 夹具：假密钥（secret-scan:ignore）
      sessionId: sA.id,
      scope: 'workspace',
    });
    ok(
      '出库二次扫描拦下被篡改的秘密',
      tamperSearch.hits.length === 0 && tamperSearch.filteredOut > 0,
      JSON.stringify({ hits: tamperSearch.hits.length, filteredOut: tamperSearch.filteredOut })
    );
  } else {
    ok('找到用于篡改的切片', false);
  }

  /* ═══════════ 8. 增量写入 ═══════════ */
  section('增量写入接线');

  const beforeIncremental = kb.debugChunkCount(sA.id);
  msg('a-3', sA.id, 'user', '新增一条增量写入验证消息。');
  const afterIncremental = kb.debugChunkCount(sA.id);
  ok('消息落库后自动增量写切片', afterIncremental > beforeIncremental, `${beforeIncremental} -> ${afterIncremental}`);

  const incrementalSearch = searchMod.searchKnowledge({
    query: '增量写入验证',
    sessionId: sA.id,
    scope: 'session',
  });
  ok('增量切片立即可检索', incrementalSearch.hits.length > 0);

  /* ═══════════ 9. 不索引 + 全量回填 + 重建幂等 ═══════════ */
  section('不索引与重建');

  const sOpt = makeSession({ id: 's-opt', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  msg('opt-1', sOpt.id, 'user', '绝密会话内容 ABCDEF。');

  const optBefore = searchMod.searchKnowledge({
    query: '绝密会话内容',
    sessionId: sOpt.id,
    scope: 'session',
  });
  ok('标记前可检索', optBefore.hits.length > 0);

  kb.setSessionIndexed(sOpt.id, false);
  const optAfter = searchMod.searchKnowledge({
    query: '绝密会话内容',
    sessionId: sOpt.id,
    scope: 'session',
  });
  ok('标记不索引后检索不到', optAfter.hits.length === 0);
  ok('不索引选择持久化到 JSON', (kb.optedOutSessionIds() ?? []).includes(sOpt.id));

  const full = kb.backfillAll();
  const oldTermFull = searchMod.searchKnowledge({
    query: '历史归档词',
    sessionId: sOld.id,
    scope: 'session',
  });
  ok('全量回填包含 90 天前消息', full.messages > 0 && oldTermFull.hits.length > 0);

  const countBefore = store.countChunks();
  const rebuild1 = kb.rebuildKnowledgeBase();
  const countAfter1 = store.countChunks();
  ok('重建后切片数稳定（第 1 次）', countAfter1 === countBefore, `${countBefore} -> ${countAfter1}`);
  ok('重建后仍遵守不索引', searchMod.searchKnowledge({ query: '绝密会话内容', sessionId: sOpt.id, scope: 'session' }).hits.length === 0);
  ok('重建修复被篡改的切片', searchMod.searchKnowledge({ query: '并发写冲突', sessionId: sA.id, scope: 'workspace' }).hits.length > 0);

  const rebuild2 = kb.rebuildKnowledgeBase();
  const countAfter2 = store.countChunks();
  ok('重建幂等（第 2 次）', countAfter2 === countAfter1 && rebuild1.errors === 0 && rebuild2.errors === 0, `${countAfter1} -> ${countAfter2}`);

  const chatMessagesBefore = chat.getMessagesBySession(sA.id).length;
  ok('重建不影响 chat.db 用户消息', chatMessagesBefore === 3, String(chatMessagesBefore));

  kb.setSessionIndexed(sOpt.id, true);
  const optReenabled = searchMod.searchKnowledge({
    query: '绝密会话内容',
    sessionId: sOpt.id,
    scope: 'session',
  });
  ok('重新开启后恢复检索', optReenabled.hits.length > 0);

  /* ═══════════ 10. 连续失败自动停索引 ═══════════ */
  section('连续失败自动停索引');

  // 用「切片里的 message_ids 不是合法 JSON」制造真实的索引失败：
  // 走 getLastChunk → JSON.parse 抛错 → 与线上写失败同一条 catch 路径。
  const sFail = makeSession({ id: 's-fail', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  msg('fail-1', sFail.id, 'user', '连续失败恢复词：索引失败达到阈值后要自动停。');
  ok('失败用例的切片已建立', store.countChunks(sFail.id) > 0);
  store
    .getKbDb()
    .prepare('UPDATE kb_chunks SET message_ids = ? WHERE session_id = ?')
    .run('{broken-json', sFail.id);

  for (let i = 0; i < store.KB_MAX_CONSECUTIVE_FAILURES; i += 1) {
    try {
      kb.indexSession(sFail.id);
    } catch {
      /* 预期失败 */
    }
  }
  const failState = store.getSessionState(sFail.id);
  ok(
    '连续失败达到阈值后自动停索引',
    Boolean(failState) &&
      failState!.index_enabled === 0 &&
      failState!.consecutive_failures >= store.KB_MAX_CONSECUTIVE_FAILURES &&
      failState!.disabled_reason === 'auto_failure' &&
      Boolean(failState!.last_error),
    JSON.stringify(failState)
  );
  const stopped = kb.indexSession(sFail.id);
  ok('停索引后不再重复尝试', stopped.skipped && stopped.reason === 'disabled', JSON.stringify(stopped));

  const autoStatus = kb.knowledgeBaseStatus();
  ok(
    'status 暴露自动停索引原因与失败次数',
    autoStatus.disabledByReason.autoFailure >= 1 &&
      autoStatus.disabledSessions.some(
        s => s.sessionId === sFail.id && s.reason === 'auto_failure' && s.consecutiveFailures >= store.KB_MAX_CONSECUTIVE_FAILURES
      ),
    JSON.stringify(autoStatus.disabledSessions)
  );

  const recovered = kb.setSessionIndexed(sFail.id, true);
  const recoveredState = store.getSessionState(sFail.id);
  ok(
    '恢复入口（indexed=true）清零计数并清空停用原因',
    recoveredState?.index_enabled === 1 &&
      recoveredState?.consecutive_failures === 0 &&
      recoveredState?.last_error === null &&
      recoveredState?.disabled_reason === null,
    JSON.stringify({ recovered, state: recoveredState })
  );
  ok(
    '恢复后立即可检索',
    searchMod.searchKnowledge({ query: '连续失败恢复词', sessionId: sFail.id, scope: 'session' }).hits.length > 0
  );

  // 成功一次即清零：先制造 1 次失败，再强制重建成功
  const sReset = makeSession({ id: 's-reset', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  msg('reset-1', sReset.id, 'user', '成功清零词：一次失败后重建成功。');
  store
    .getKbDb()
    .prepare('UPDATE kb_chunks SET message_ids = ? WHERE session_id = ?')
    .run('{broken-json', sReset.id);
  try {
    kb.indexSession(sReset.id);
  } catch {
    /* 预期失败一次 */
  }
  const afterOneFailure = store.getSessionState(sReset.id);
  ok(
    '单次失败只累加计数、不停索引',
    afterOneFailure?.consecutive_failures === 1 && afterOneFailure?.index_enabled === 1,
    JSON.stringify(afterOneFailure)
  );
  kb.indexSession(sReset.id, { force: true });
  const afterSuccess = store.getSessionState(sReset.id);
  ok(
    '成功一次后失败计数归零',
    afterSuccess?.consecutive_failures === 0 && afterSuccess?.last_error === null,
    JSON.stringify(afterSuccess)
  );

  // 手动关闭：PATCH indexed=false → disabled_reason=user
  const sUser = makeSession({ id: 's-user-close', cwd: 'E:/tmp/opc-kb-ws-a', projectId: projectA.id });
  msg('userclose-1', sUser.id, 'user', '手动关闭原因词：用户主动停止索引。');
  kb.setSessionIndexed(sUser.id, false);
  const userState = store.getSessionState(sUser.id);
  ok(
    '手动关闭写入 disabled_reason=user',
    userState?.index_enabled === 0 && userState?.disabled_reason === 'user',
    JSON.stringify(userState)
  );
  const userStatus = kb.knowledgeBaseStatus();
  ok(
    'status 暴露手动关闭原因',
    userStatus.disabledByReason.user >= 1 &&
      userStatus.disabledSessions.some(s => s.sessionId === sUser.id && s.reason === 'user'),
    JSON.stringify(userStatus.disabledSessions)
  );

  // 重建：用户手动关闭的原因跨重建保留
  kb.rebuildKnowledgeBase();
  const afterRebuild = store.getSessionState(sUser.id);
  ok(
    '重建后手动关闭原因保留',
    afterRebuild?.index_enabled === 0 && afterRebuild?.disabled_reason === 'user',
    JSON.stringify(afterRebuild)
  );
  const rebuiltStatus = kb.knowledgeBaseStatus();
  ok(
    '重建后接口仍能读出停用原因',
    rebuiltStatus.disabledByReason.user >= 1 &&
      rebuiltStatus.disabledSessions.some(s => s.sessionId === sUser.id && s.reason === 'user'),
    JSON.stringify(rebuiltStatus.disabledSessions)
  );

  /* ═══════════ 汇总 ═══════════ */
  console.log(`\n──────── 结果 ────────`);
  console.log(`检查项: ${checks}  失败: ${failures.length}`);
  if (failures.length > 0) {
    console.log(`失败项:\n${failures.map(name => `  - ${name}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }

  store.closeKbDb();
  // 临时目录留在 /tmp，便于失败时排查；不删除真实数据
  console.log(`数据目录: ${dataDir}`);
}

main().catch(err => {
  console.error('\n验证脚本异常退出:', err);
  process.exitCode = 1;
});
