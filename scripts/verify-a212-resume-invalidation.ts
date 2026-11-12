/**
 * A212 闸门：WorkBuddy 续接令牌纪元对账（数据根水位线 + 批量作废）。
 *
 * ## 为什么必须有一套独立闸门
 *
 * 2026-11-12 晚真机复盘：A211 换根后，旧根时代发的 `sdk_session_id` 在
 * 新根下读不到 CLI 会话，续接 0.6s 报 `No conversation found with session
 * ID: …`。这类「跨纪元令牌」bug 单点冒烟测不出来 —— 必须把换根序列、
 * 首次建水位线、以及「令牌与根同代时不清」全部用夹具摆到台面上。
 *
 * ## 可观测量（按项目验证纪律）
 *
 *   [1]-[7] 状态序列：临时 home 造官方数据根夹具 + 临时 OPC_DATA_DIR 真
 *       开库，断言水位线存取、生效根推导、四条对账分支、db 层打击面；
 *   [8] 源码契约（锚整行）：index.ts 三个调用点与发送路径的取令牌顺序；
 *   [9] 反向探针：模拟「退回坏版本」，确认对应断言真会变红
 *       （探针只在 `--probe=` 指定时执行，平时不占断言数）。
 *
 * 运行：
 *   npx tsx scripts/verify-a212-resume-invalidation.ts
 *   npx tsx scripts/verify-a212-resume-invalidation.ts --probe=no-epoch
 *   npx tsx scripts/verify-a212-resume-invalidation.ts --probe=no-batch
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  effectiveWorkbuddyConfigRoot,
  invalidateWorkbuddyProfile,
  legacyWorkbuddyRoot,
  legacyWorkbuddyRootExists,
  readWorkbuddyRootWatermark,
  writeWorkbuddyRootWatermark,
} from '../server/agents/wbProductProfile.js';
import {
  reconcileWorkbuddyResumeTokens,
  resetWorkbuddyRootMemoForTest,
} from '../server/agents/wbRootEpoch.js';
import { createSession, getSession, invalidateAgentResumeTokens } from '../server/db.js';

const ARGS = process.argv.slice(2);
const PROBE = ARGS.find(a => a.startsWith('--probe='))?.slice(8) ?? null;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}
/** 反向探针专用：断言「坏版本下这个条件不成立」（即正常断言真会变红） */
function okRed(cond: unknown, name: string) {
  if (!cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}
function eq<T>(actual: T, expected: T, name: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}
function group(title: string) {
  console.log(`\n── ${title} ──`);
}

/** 按 mtime 落盘（wbProductProfile 用 mtime 排活跃度，必须可控） */
function writeAt(p: string, content: string, at: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  fs.utimesSync(p, new Date(at), new Date(at));
}

/** 造一个官方数据根（快照文件齐全，自证 dataFolderName） */
function makeRoot(home: string, folder: string, at: number): string {
  const root = path.join(home, folder);
  const cfg = {
    dataFolderName: folder,
    productName: folder === '.workbuddy-ai' ? 'WorkBuddy AI' : 'WorkBuddy',
    applicationName: folder,
    endpoint:
      folder === '.workbuddy-ai' ? 'https://www.workbuddy.ai' : 'https://www.workbuddy.cn',
    networkEnvironment: 'external',
    date: new Date(at).toISOString(),
    authentication: { type: 'account-scoped-external-link' },
  };
  writeAt(path.join(root, 'cache', 'acc-product-config-v3.json'), JSON.stringify(cfg), at);
  return root;
}

let sessionSeq = 0;
function seedSession(agentId: string | null, token: string | null): string {
  const id = `a212-${++sessionSeq}-${agentId ?? 'none'}`;
  createSession({
    id,
    title: `A212 夹具 ${id}`,
    model: '',
    agent_id: agentId,
    sdk_session_id: token,
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: null,
    reasoning_effort: null,
    scenario_id: null,
    system_prompt: null,
    permission_mode: null,
    sdk_thread_permission: null,
    pinned: 0,
    project_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}
function tokenOf(id: string): string | null {
  return getSession(id)?.sdk_session_id ?? null;
}
/** 切换「官方世界的状态」后必须做的两件事：换 home + 清发现层缓存 */
function switchHome(home: string): void {
  process.env.OPC_WB_HOME = home;
  invalidateWorkbuddyProfile();
}
function rmWatermark(): void {
  const p = path.join(process.env.OPC_DATA_DIR ?? '', 'workbuddy-root-watermark.json');
  fs.rmSync(p, { force: true });
}

// ════════════════════════════ 夹具准备 ════════════════════════════

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a212-home-'));
switchHome(HOME);
const DATA = process.env.OPC_DATA_DIR ?? '';
if (!DATA || !DATA.includes('opc-verify-')) {
  throw new Error(`OPC_DATA_DIR 未被 temp-data-dir 正确接管：${DATA}`);
}

const T0 = 1_794_000_000_000; // 夹具基准时间（远早于现在，保证可控排序）

// ════════════════════════════ 断言 ════════════════════════════

// [1] 水位线存取
group('[1] 水位线存取');
ok(readWorkbuddyRootWatermark() === null, '缺文件时读出 null');
writeWorkbuddyRootWatermark('/tmp/fake-root-a');
eq(readWorkbuddyRootWatermark(), '/tmp/fake-root-a', '写入后原样读回');
writeAt(path.join(DATA, 'workbuddy-root-watermark.json'), '{broken json', T0);
ok(readWorkbuddyRootWatermark() === null, '损坏 JSON 读出 null（不抛）');

// [2] 生效根推导
group('[2] 生效根推导');
const LEGACY = legacyWorkbuddyRoot();
ok(LEGACY.endsWith('.workbuddy'), '旧根 = 定义表写死的 ~/.workbuddy 形态');
ok(!legacyWorkbuddyRootExists(), '夹具初始无旧根目录');
eq(effectiveWorkbuddyConfigRoot(), LEGACY, '无任何 profile → 回落定义表旧根');
const rootA = makeRoot(HOME, '.workbuddy-ai', T0);
invalidateWorkbuddyProfile();
eq(effectiveWorkbuddyConfigRoot(), rootA, '有官方快照 → 生效根 = 快照所在数据根');

// [3] 对账：首次建水位线，旧根不存在 → 只记录不清
group('[3] 首次对账（无水位线、无旧根）');
rmWatermark();
resetWorkbuddyRootMemoForTest();
const r1 = reconcileWorkbuddyResumeTokens();
eq(r1.invalidated, 0, '无存量纪元证据 → 不作废任何令牌');
eq(r1.rootChanged, false, '不谎报「换过柜」');
eq(readWorkbuddyRootWatermark(), rootA, '水位线已记录当前根');
const r1b = reconcileWorkbuddyResumeTokens();
eq(r1b.invalidated, 0, '同根重跑 → memo 短路，零作废');

// [4] 对账：水位线存在 + 换根 → 批量作废（核心分支）
group('[4] 换根 → 旧纪元令牌批量作废');
const wbA = seedSession('workbuddy', 'wb-token-A');
const wbB = seedSession('workbuddy', 'wb-token-B');
const oc = seedSession('opencode', 'oc-token');
const wbNoTok = seedSession('workbuddy', null);
const rootB = makeRoot(HOME, '.workbuddy-intl', T0 + 60_000);
invalidateWorkbuddyProfile();
ok(effectiveWorkbuddyConfigRoot() === rootB, '活跃度排序后生效根切到新数据根');
if (PROBE === 'no-epoch') {
  // 探针：模拟退回坏版本（没有对账机制，旧令牌照用）—— 核心断言必须变红
  okRed(
    tokenOf(wbA) === null && tokenOf(wbB) === null,
    '反向探针(no-epoch)：不跑对账时旧令牌原样保留，「换根后旧令牌置空」应判红'
  );
  // 探针状态收尾：把真实对账跑掉，推进水位线，后续分组继续在真实实现上断言
  reconcileWorkbuddyResumeTokens();
} else {
  const r2 = reconcileWorkbuddyResumeTokens();
  eq(r2.rootChanged, true, '判定纪元已换代');
  eq(r2.invalidated, 2, '只作废 workbuddy 的两个带令牌会话');
  ok(tokenOf(wbA) === null && tokenOf(wbB) === null, '换根后旧令牌已被置空');
  eq(tokenOf(oc), 'oc-token', '其它 Agent 的令牌不受打击');
  eq(tokenOf(wbNoTok), null, '本来就无令牌的会话保持无令牌');
  eq(readWorkbuddyRootWatermark(), rootB, '水位线已推进到新根');
  const r2b = reconcileWorkbuddyResumeTokens();
  eq(r2b.invalidated, 0, '同根重跑 → 不重复作废');
}

// [5] 对账：水位线缺失 + 旧根目录还在 + 生效根 ≠ 旧根 → 推断换过柜，一并作废
group('[5] 首次对账（无水位线、旧根目录真实存在）');
fs.mkdirSync(LEGACY, { recursive: true });
ok(legacyWorkbuddyRootExists(), '旧根目录已造出');
rmWatermark();
resetWorkbuddyRootMemoForTest();
const r3 = reconcileWorkbuddyResumeTokens();
eq(r3.rootChanged, true, '推断纪元已换代');
eq(r3.invalidated, 0, '上一棒已把旧令牌清完 → 本次 0 行（幂等不减记）');
const wbC = seedSession('workbuddy', 'wb-token-C');
rmWatermark();
resetWorkbuddyRootMemoForTest();
const r3b = reconcileWorkbuddyResumeTokens();
eq(r3b.invalidated, 1, '存量令牌（wbC）在首次建水位线时被作废');
ok(tokenOf(wbC) === null, 'wbC 令牌已置空');
eq(readWorkbuddyRootWatermark(), rootB, '水位线落定');

// [6] 对账负例：水位线缺失，但「旧根不存在」或「生效根就是旧根」→ 只记录不清
group('[6] 负例：没有换柜证据时不清令牌');
const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a212-home2-'));
switchHome(HOME2);
rmWatermark();
resetWorkbuddyRootMemoForTest();
const r4 = reconcileWorkbuddyResumeTokens();
eq(r4.invalidated, 0, '旧根目录不存在 → 令牌与根同代，不作废');
eq(readWorkbuddyRootWatermark(), legacyWorkbuddyRoot(), '水位线只记录');
const HOME3 = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a212-home3-'));
fs.mkdirSync(path.join(HOME3, '.workbuddy'), { recursive: true });
switchHome(HOME3);
rmWatermark();
resetWorkbuddyRootMemoForTest();
const r5 = reconcileWorkbuddyResumeTokens();
eq(r5.invalidated, 0, '生效根就是旧根 → 同代，不作废');

// [7] db 层打击面
group('[7] invalidateAgentResumeTokens 打击面');
eq(invalidateAgentResumeTokens('opencode'), 1, '只命中 opencode 的那一条');
eq(tokenOf(oc), null, 'oc 令牌被定向作废');
eq(invalidateAgentResumeTokens('opencode'), 0, '重复执行幂等（0 行）');
eq(invalidateAgentResumeTokens('nonexistent-agent'), 0, '不存在的 Agent → 0 行');

// [8] 源码契约：三个调用点 + 发送路径先对账再取令牌
group('[8] 源码契约（index.ts 调用点）');
const indexSrc = fs.readFileSync(
  fileURLToPath(new URL('../server/index.ts', import.meta.url)),
  'utf8'
);
ok(
  indexSrc.includes(
    "const wbEpoch = agentId === 'workbuddy' ? reconcileWorkbuddyResumeTokens() : null;"
  ),
  '发送路径：workbuddy 轮次先对账'
);
ok(
  indexSrc.includes(
    'let resumeToken = wbEpoch && wbEpoch.invalidated > 0 ? null : session.sdk_session_id;'
  ),
  '发送路径：作废发生时本轮直接新建 CLI 会话'
);
ok(
  (indexSrc.match(/reconcileWorkbuddyResumeTokens\(\)/g) ?? []).length >= 3,
  '启动 / rebind / 发送路径 三处调用齐备'
);
ok(
  indexSrc.includes('A212：此刻 profile 缓存已刷新，立即对账一次'),
  'rebind 在 profile 缓存刷新后对账'
);

// [9] 反向探针：no-batch（模拟 WHERE 丢了 agent 过滤 → 打击面失控）
group('[9] 反向探针');
if (PROBE === 'no-batch') {
  // 直接对夹具库跑「坏版本」的 UPDATE（没有 agent_id 过滤），展示闸门为何要钉打击面
  const db2 = new DatabaseSync(path.join(DATA, 'chat.db'));
  const oc2 = seedSession('opencode', 'oc-token-probe');
  db2.prepare('UPDATE sessions SET sdk_session_id = NULL WHERE sdk_session_id IS NOT NULL').run();
  db2.close();
  okRed(
    tokenOf(oc2) === 'oc-token-probe',
    '反向探针(no-batch)：无过滤 UPDATE 误伤 opencode，「其它 Agent 令牌不受打击」应判红'
  );
} else {
  console.log('  （no-batch 探针未启用，跳过）');
}

// ════════════════════════════ 汇总 ════════════════════════════
console.log(
  `\n${failures.length ? '✗' : '✓'} A212 续接令牌纪元对账：${pass}/${pass + fail} 通过` +
    `${PROBE ? `（探针 ${PROBE}）` : ''}`
);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
