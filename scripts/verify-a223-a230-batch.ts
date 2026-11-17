/**
 * A223–A230 本批功能闸门（离线单元 + 源码契约 + 服务端实跑）。
 *
 * 八个功能一批进闸门（单开八个脚本会让 verify:ui 链多八个 npm 进程启动），
 * 分节断言，任何一节失败整体红。三层：
 *
 *   [S] 源码契约 —— 关键接线必须存在；支持 --probe 变体：把关键行**内存变异**后
 *       断言契约变红（同一套判据，改坏了就必须抓到，反向探针不许假跑）
 *   [U] 离线单元 —— 纯函数枚举边界（cron / leader 计划解析 / 自定义 CLI / 通知摘要）
 *   [F] 服务端实跑 —— 临时 data 目录里真拉 CliAdapter（自定义 CLI 端到端）
 *
 * 不含浏览器层：本批 UI 都有稳定 data-* 锚点，由 verify:render / verify:theme
 * 与后续 UI 走查覆盖。
 *
 * 反向探针约定（与 verify-a222 的 --probe=... 同款）：
 *   npx tsx scripts/verify-a223-a230-batch.ts --probe=no-reload
 *   npx tsx scripts/verify-a223-a230-batch.ts --probe=no-once-token
 * 探针模式下：把对应实现**变异成坏形态**，断言契约检查恰好变红；不变红 = 探针失败。
 */

// 必须是第一个 import：把 OPC_DATA_DIR 指到临时目录，db 链不碰真实 data/
import './lib/temp-data-dir.js';

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const probe = (() => {
  // 同时认 `--probe=x` 与 `--probe x` 两种写法（npx 传参两种都会出现）
  const eq = process.argv.find(a => a.startsWith('--probe='));
  if (eq) return eq.slice('--probe='.length);
  const i = process.argv.indexOf('--probe');
  return i >= 0 ? process.argv[i + 1] : null;
})();

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    if (!probe) console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ✗ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    if (!probe) console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ✗ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}

// ═══════════════ 源码契约 ═══════════════

/** 源文件缓存：探针模式下按变异后的文本判，普通模式读原样 */
const sourceCache = new Map<string, string>();
function repoSource(rel: string, mutate?: (src: string) => string): string {
  const key = mutate ? `${rel}::probe` : rel;
  if (!sourceCache.has(key)) {
    let src = fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
    if (mutate) src = mutate(src);
    sourceCache.set(key, src);
  }
  return sourceCache.get(key)!;
}

/** 变异器：把「实现被改坏」落成文本。每个探针对应一个 */
const MUTATIONS: Record<string, { file: string; apply: (src: string) => string; expect: string }> = {
  // 坏形态①：统一重灌入口「丢掉」CLI 自建——HTTP 自建增删一次，CLI 全部消失
  'no-reload': {
    file: 'server/index.ts',
    apply: src => src.replace('...loadCustomCliSpecs().map(customCliSpecToDefinition),', ''),
    expect: 'A223 定义重灌契约',
  },
  // 坏形态②：审批 token 不再先删再用（可重复消费）
  'no-once-token': {
    file: 'server/notify.ts',
    apply: src => src.replace('tokens.delete(token);\n  if (Date.now()', 'if (Date.now()'),
    expect: 'A228 一次性 token 契约',
  },
  // 坏形态③：worktree 冲突不再 abort（把用户主区留在半合并状态）
  'no-merge-abort': {
    file: 'server/worktree.ts',
    apply: src => src.replace("await git(['merge', '--abort'], batch.baseDir);", '/* probe: abort removed */'),
    expect: 'A225 冲突中止契约',
  },
  // 坏形态④：转交摘要读出不清空（每轮重复注入）
  'no-handoff-clear': {
    // F0-02③：摘要消费已迁 routes/chat.ts，变异体跟着改文件
    file: 'server/routes/chat.ts',
    apply: src => src.replace('db.updateSession(session.id, { handoff_context: null });', '/* probe: no clear */'),
    expect: 'A226 一次性摘要契约',
  },
};

function contractChecks(mutate?: (src: string, file: string) => string): void {
  const S = (rel: string) => repoSource(rel, mutate ? (src) => mutate(src, rel) : undefined);

  if (!probe || probe === 'no-reload') {
    check('A223 定义重灌契约：统一重灌入口必须同时灌 HTTP 与 CLI 两类自建', () => {
      const src = S('server/index.ts');
      assert.ok(src.includes('function reloadCustomDefs()'), '缺少统一重灌入口');
      assert.ok(
        !src.includes('registerCustomDefs(loadCustomSpecs().map(customSpecToDefinition))'),
        'HTTP 自建路由仍在单独整表重灌（会清掉 CLI 定义）'
      );
      // 重灌函数体内必须带上 CLI 自建（探针把它删掉时这里变红）
      const body = src.slice(src.indexOf('function reloadCustomDefs()'), src.indexOf('function reloadCustomDefs()') + 400);
      assert.ok(body.includes('loadCustomCliSpecs'), 'reloadCustomDefs 丢掉了 CLI 自建');
    });
  }
  if (!probe || probe === 'no-merge-abort') {
    check('A225 冲突中止契约：冲突路径必须 merge --abort 保住主区', () => {
      const src = S('server/worktree.ts');
      const codeOnly = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(!/['"]push['"]/.test(codeOnly), 'git 参数里不得出现 push');
      assert.match(src, /merge',\s*'--abort/, '缺少 merge --abort');
    });
  }
  if (!probe || probe === 'no-handoff-clear') {
    check('A226 一次性摘要契约：交接摘要消费后必须清空', () => {
      // F0-02③：/api/chat 摘要消费已迁 routes/chat.ts
      assert.match(S('server/routes/chat.ts'), /handoff_context: null/, '读出后必须置 null');
    });
  }
  if (!probe || probe === 'no-once-token') {
    check('A228 一次性 token 契约：消费即焚', () => {
      const src = S('server/notify.ts');
      const idxDelete = src.indexOf('tokens.delete(token);');
      const idxUse = src.indexOf('if (Date.now() - t.createdAt');
      assert.ok(idxDelete >= 0 && idxUse > idxDelete, 'token 必须先删再校验（单次有效）');
    });
  }
  if (!probe) {
    check('A224 调度器：错过窗口不补跑 + 同任务不重叠', () => {
      const src = S('server/scheduler.ts');
      assert.ok(src.includes("'missed'") && src.includes('running.has(task.id)'));
    });
    check('A225 群聊路由：汇合在 finally（编排抛错也要收检出）', () => {
      // F0-02③：群聊路由已迁 routes/chat.ts
      assert.match(S('server/routes/chat.ts'), /finally \{\n[\s\S]*?mergeWorktree/);
    });
    check('A227 打断追加：旧轮 finally 不得无条件摘掉新轮的把手', () => {
      assert.match(S('src/hooks/useChat.ts'), /turnsRef\.current\.get\(turn\.sessionId\) === turn/);
    });
    check('A228 卡片内容：输入摘要必须过敏感扫描', () => {
      assert.ok(S('server/agents/projector.ts').includes('scanSensitive'));
    });
    check('A230 leader：解析失败退化广播，不瞎猜', () => {
      assert.ok(S('server/orchestrator.ts').includes('parseLeaderPlan'));
      assert.ok(S('server/orchestrator.ts').includes('已退化为广播'));
    });
  }
}

// ═══════════════ 离线单元 ═══════════════

async function unitTests(): Promise<void> {
  if (probe) return; // 探针模式只跑源码契约
  console.log('\n[U] 离线单元');

  const { parseCron, cronNextRun, cronPreview, cronIntervalWarning } = await import('../server/cron.js');

  check('cron：五段校验与错误信息', () => {
    assert.equal(parseCron('* * * *').ok, false);
    assert.equal(parseCron('bad').ok, false);
    const ok = parseCron('0 9 * * 1-5');
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.fields.dow, [1, 2, 3, 4, 5]);
  });

  check('cron：星期 0 与 7 等价（周日）', () => {
    const a = parseCron('0 9 * * 0');
    const b = parseCron('0 9 * * 7');
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.deepEqual(a.fields.dow, b.fields.dow);
  });

  check('cron：下一次触发（周六 → 下周一）', () => {
    const next = cronNextRun('0 9 * * 1-5', new Date('2026-11-14T10:30:00'));
    assert.ok(next);
    assert.equal(next.toISOString().slice(0, 10), '2026-11-16');
  });

  check('cron：不可能日期返回 null（2 月 31 日）', () => {
    assert.equal(cronNextRun('0 9 31 2 *', new Date('2026-11-14T00:00:00')), null);
  });

  check('cron：预览次数', () => {
    assert.equal(cronPreview('0 9 * * *', 3, new Date('2026-11-14T10:30:00')).length, 3);
  });

  check('cron：高频表达式在创建边界被拒', () => {
    assert.ok(cronIntervalWarning('*/15 * * * *'));
    assert.equal(cronIntervalWarning('0 9,18 * * *'), null);
  });

  const { parseLeaderPlan } = await import('../server/orchestrator.js');

  check('leader：标准 JSON 计划解析（含围栏）', () => {
    const plan = parseLeaderPlan(
      '```json\n{"assignments":[{"agentId":"codex","subtask":"改 A"},{"agentId":"gemini","subtask":"写 B"}]}\n```',
      ['codex', 'gemini'],
      id => id.toUpperCase()
    );
    assert.ok(plan && plan.assignments.length === 2 && plan.assignments[0]!.agentId === 'codex');
  });

  check('leader：展示名也认 + 去重 + 未知成员剔除', () => {
    const plan = parseLeaderPlan(
      '{"assignments":[{"agentId":"Codex","subtask":"a"},{"agentId":"Codex","subtask":"b"},{"agentId":"ghost","subtask":"c"},{"agentId":"gemini","subtask":""}]}',
      ['codex', 'gemini'],
      id => (id === 'codex' ? 'Codex' : id)
    );
    assert.ok(plan && plan.assignments.length === 1 && plan.assignments[0]!.agentId === 'codex');
  });

  check('leader：纯文本 / 空计划 → null（退化广播）', () => {
    assert.equal(parseLeaderPlan('我觉得交给 codex 就好', ['codex'], id => id), null);
    assert.equal(parseLeaderPlan('{"assignments":[]}', ['codex'], id => id), null);
  });

  const { mapCustomCliLine, buildCustomCliArgs, normalizeCustomCliInput, customCliSpecToDefinition } = await import(
    '../server/agents/customCliAgents.js'
  );

  check('A223 normalize：边界（空命令 / 换行 / 名称超长 / 空行参数）', () => {
    assert.equal(normalizeCustomCliInput({ name: 'x', command: '' }).ok, false);
    assert.equal(normalizeCustomCliInput({ name: 'x', command: 'a\nb' }).ok, false);
    assert.equal(normalizeCustomCliInput({ name: 'x'.repeat(21), command: 'ok' }).ok, false);
    const ok = normalizeCustomCliInput({ name: '工具', command: 'my-cli', args: ['--run\n'], stdin: true, protocol: 'text' });
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual(ok.value.args, ['--run']);
  });

  check('A223 buildArgs：占位符替换与末位追加', () => {
    const argv = buildCustomCliArgs(
      { args: ['--cwd', '{cwd}', '--model', '{model}', '{prompt}'], stdin: false },
      '你好',
      { cwd: 'E:/work', model: 'gpt-x' }
    );
    assert.deepEqual(argv, ['--cwd', 'E:/work', '--model', 'gpt-x', '你好']);
    assert.deepEqual(buildCustomCliArgs({ args: ['-p'], stdin: false }, 'hi', {}), ['-p', 'hi']);
    assert.deepEqual(buildCustomCliArgs({ args: ['-p'], stdin: true }, 'hi', {}), ['-p']);
  });

  check('A223 mapLine：约定字段映射 + session 行返回 null（令牌由适配器提取）', () => {
    const seq = { toolCount: 0 };
    assert.deepEqual(mapCustomCliLine({ type: 'text', content: 'hi' }, seq), { type: 'text', content: 'hi' });
    const tool = mapCustomCliLine({ type: 'tool', name: 'bash' }, seq);
    assert.ok(tool && !Array.isArray(tool) && tool.type === 'tool');
    assert.equal(mapCustomCliLine({ type: 'session', id: 's1' }, seq), null);
    assert.equal(mapCustomCliLine({ type: 'unknown-thing' }, seq), null);
  });

  check('A223 合成定义：协议与自定义语义如实标注', () => {
    const def = customCliSpecToDefinition({
      id: 'customcli-test',
      name: '测试',
      command: 'node',
      args: ['-e', '1'],
      stdin: false,
      protocol: 'jsonl',
      capabilities: ['chat'],
      createdAt: 0,
    });
    assert.equal(def.descriptor.kind, 'cli');
    assert.equal(def.descriptor.custom, true);
    assert.equal(def.cli!.parse, 'jsonl');
    assert.equal(typeof def.cli!.createMapper, 'function');
  });

  const { createSchedule, deleteSchedule, listSchedules } = await import('../server/scheduler.js');

  check('A224 调度存储：建 / 列 / 删（临时 data 目录）', () => {
    const created = createSchedule(
      { sessionId: 's1', prompt: '巡检', cron: '0 9 * * 1-5' },
      { kind: 'direct', agent_id: 'codex' }
    );
    assert.ok(!('error' in created));
    assert.equal(listSchedules('s1').length, 1);
    assert.ok(deleteSchedule(created.id));
    assert.equal(listSchedules('s1').length, 0);
  });

  check('A224 调度存储：高频创建被拒', () => {
    assert.ok('error' in createSchedule(
      { sessionId: 's1', prompt: 'x', cron: '*/10 * * * *' },
      { kind: 'direct', agent_id: 'codex' }
    ));
  });

  const { summarizePermissionInput } = await import('../server/agents/projector.js');

  check('A228 输入摘要：截断 + 敏感内容整段隐去', () => {
    assert.equal(summarizePermissionInput({ command: 'ls' }), '{"command":"ls"}');
    assert.equal(summarizePermissionInput({ secret: 'sk-abcdefghijklmnopqrst' }), '（含敏感内容：API Key（sk- 开头），已隐去）'); // secret-scan:ignore（构造的假密钥，测命中路径）
    const long = summarizePermissionInput({ x: 'a'.repeat(500) });
    assert.ok(long.length <= 210 && long.endsWith('…'));
  });
}

// ═══════════════ 服务端实跑 ═══════════════

async function serverRoundTrip(): Promise<void> {
  if (probe) return;
  console.log('\n[F] 服务端实跑（临时 data 目录 + 真实 CliAdapter）');

  const { registry } = await import('../server/agents/registry.js');
  const { registerCustomDefs } = await import('../server/agents/definitions.js');
  const { createCustomCliSpec, deleteCustomCliSpec, customCliSpecToDefinition } = await import(
    '../server/agents/customCliAgents.js'
  );

  // 用 node 自身当「被接入的 CLI」：回显一行 JSONL，端到端走 CliAdapter 全链
  const spec = createCustomCliSpec({
    name: '回声测试',
    command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({type:"text", content:"echo:" + process.argv[1]}))', '{prompt}'],
    stdin: false,
    protocol: 'jsonl',
    capabilities: ['chat'],
  });
  const def = customCliSpecToDefinition(spec);
  registerCustomDefs([def]);
  registry.registerCustom(def);

  await checkAsync('A223 端到端：自定义 CLI 经 CliAdapter 产出 text 事件', async () => {
    const provider = registry.getProvider(spec.id);
    assert.ok(provider, '注册后必须能取到 Provider');
    const events: Array<{ type: string; content?: string }> = [];
    for await (const ev of provider.send({ sessionId: 'verify-a223', prompt: '你好', cwd: os.tmpdir() })) {
      events.push(ev as never);
      if (events.length > 20) break;
    }
    const text = events.filter(e => e.type === 'text').map(e => (e as { content: string }).content).join('');
    assert.ok(text.includes('echo:你好'), `应回显 prompt，实际：${text.slice(0, 80)}`);
  });

  check('A223 清理：删除后 Provider 注销', () => {
    assert.ok(deleteCustomCliSpec(spec.id));
    registry.unregisterCustom(spec.id);
    assert.equal(registry.getProvider(spec.id), undefined);
  });
}

// ═══════════════ 入口 ═══════════════

async function run(): Promise<void> {
  console.log(probe ? `A223–A230 闸门（探针模式：${probe}）` : 'A223–A230 本批功能闸门');

  const mutation = probe ? MUTATIONS[probe] : undefined;
  if (probe && !mutation) {
    console.error(`未知探针：${probe}（可用：${Object.keys(MUTATIONS).join(' / ')}）`);
    process.exit(2);
  }
  contractChecks(mutation ? (src, file) => (file === mutation.file ? mutation.apply(src) : src) : undefined);

  if (!probe) {
    await unitTests();
    await serverRoundTrip();
  }

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (probe) {
    // 探针模式：必须恰好变红（把坏实现抓到才算探针有效）
    if (fail === 0) {
      console.error(`探针失败：变异（${probe}）后闸门仍然全绿——探针无效`);
      process.exit(1);
    }
    console.log(`探针有效：变异后 ${fail} 条契约变红（按预期）`);
    process.exit(0);
  }
  if (fail > 0) process.exit(1);
}

void run();
