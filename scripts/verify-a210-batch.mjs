/**
 * 闸门：A210 同批（t0–t4 首字埋点 / 「即将接入」占位 / CLI 配置模型平级字段）。
 *
 * 覆盖：
 *  - 纯函数：runTimingMeta 的 begin/note/take 与首字判据、runTiming 的四段汇总、
 *    「t4−t3 单列绝不并入 TTFT」、无正文时 t2=null 不冒充 0ms；
 *  - 端到端模拟：一轮里先来 thinking 再来正文，确认只记第一次正文；
 *  - comingSoon 隔离：占位 id 不在 AGENT_DEFS、不复用 RETIRED、字段完整、
 *    不给日期/版本承诺、UI 行不可点、链路三层都传了独立字段；
 *  - 源码契约（剥注释 + 锚行首）：服务端四处埋点接线、run_end.timing 类型、
 *    projector.finish 第三参、configured 平级字段、只读档 selectable:false 仍在；
 *  - 反向探针 `--probe no-timing`（跳过 noteFirstContent）与 `--probe mix-ui`
 *    （假装 ttft 含 UI 延迟），确认对应断言真的会变红，而不是恒绿摆设。
 *
 * 为什么源码契约要剥注释：本批接线处写了大量解释性注释，里面出现同样的
 * 函数名与字段名。不剥注释，「注释里提了一句」就能让断言变绿 —— 典型假绿。
 *
 * 运行：
 *   node scripts/verify-a210-batch.mjs
 *   node scripts/verify-a210-batch.mjs --probe no-timing
 *   node scripts/verify-a210-batch.mjs --probe mix-ui
 *   node scripts/verify-a210-batch.mjs --probe no-attribution
 *
 * 脚本会用 node --import tsx 自我拉起一次，以便动态 import .ts 模块。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SELF = fileURLToPath(import.meta.url);
const ARGS = process.argv.slice(2);
const PROBE = ARGS.find(a => a.startsWith('--probe='))?.slice(8)
  ?? (ARGS.includes('no-timing') ? 'no-timing'
    : ARGS.includes('mix-ui') ? 'mix-ui'
    : ARGS.includes('no-attribution') ? 'no-attribution'
    : null);

if (!process.env.__A210_TSX_CHILD) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF, ...ARGS], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, __A210_TSX_CHILD: '1' },
  });
  process.exit(r.status == null ? 1 : r.status);
}

const meta = await import('../server/agents/runTimingMeta.ts');
const ui = await import('../src/utils/runTiming.ts');
const soon = await import('../server/agents/comingSoon.ts');

let pass = 0;
let fail = 0;
const redNames = [];
function ok(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    redNames.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}
function eq(actual, expected, name) {
  ok(Object.is(actual, expected), name, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function group(title) { console.log(`\n── ${title} ──`); }

/**
 * 剥掉块注释与行注释，避免「注释里提了一句」造成假绿。
 *
 * 必须按行走状态机，不能用 /\/\*[\s\S]*?\*\//g 跑整块文本：
 * server/index.ts 的行注释里写着 `~/.zcode/v2/*.json`，那个 `/*` 会被
 * 当成块注释起点，一路吞到下一个真正的块注释结束标记，把中间 20 多行真实代码
 * （含 selectable: false 与第一处 configured,）一起删掉 —— 于是
 * 「只读档没被放开」这类否定式断言会没来由地假红。
 * 顺带统一 CRLF → LF，否则行首锚定的 `$` 会被 \r 顶掉。
 */
function stripComments(s) {
  const out = [];
  let inBlock = false;
  for (const rawLine of s.replace(/\r\n/g, '\n').split('\n')) {
    const t = rawLine.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      out.push('');
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      out.push('');
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) {
      out.push('');
      continue;
    }
    // 目标断言行都不含字符串字面量里的 //；行尾注释一律切掉，
    // 避免注释里提到同样的函数名让 hasLine 假绿。
    const cut = rawLine.indexOf('//');
    out.push(cut >= 0 ? rawLine.slice(0, cut) : rawLine);
  }
  return out.join('\n');
}
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function code(rel) { return stripComments(readSrc(rel)); }
/** 按行首锚定匹配，不跑整块文本 */
function hasLine(src, re) {
  return src.split('\n').some(l => re.test(l));
}

// ── 1. runTimingMeta 纯函数 ──────────────────────────────────────────────
group('1. 服务端首字旁路 runTimingMeta');
meta.beginRunTiming('r1', 1000, 1010);
const m1 = meta.peekRunTiming('r1');
ok(!!m1 && m1.t0 === 1000 && m1.t1 === 1010 && m1.t2 === null, 'begin 记下 t0/t1，t2 初始为 null');
meta.noteFirstContent('r1', 1250);
meta.noteFirstContent('r1', 9999);
eq(meta.peekRunTiming('r1').t2, 1250, 'noteFirstContent 幂等，只记第一次');
const taken = meta.takeRunTiming('r1');
ok(!!taken && taken.t2 === 1250, 'take 能取走完整三个点');
eq(meta.peekRunTiming('r1'), null, 'take 之后不留残骸');

meta.beginRunTiming('r2', undefined, 2000);
eq(meta.peekRunTiming('r2').t0, 2000, 'clientSentAt 缺席时 t0 回落 t1，不编时间基准');
meta.beginRunTiming('r3', -5, 3000);
eq(meta.peekRunTiming('r3').t0, 3000, 'clientSentAt 为负数时回落 t1');
meta.beginRunTiming('r4', 'not-a-number', 4000);
eq(meta.peekRunTiming('r4').t0, 4000, 'clientSentAt 类型不对时回落 t1');

eq(meta.isFirstContentEvent({ type: 'block_delta', channel: 'thinking', delta: 'x' }), false, 'thinking 增量不算首字');
eq(meta.isFirstContentEvent({ type: 'block_delta', channel: 'text', delta: 'x' }), true, '正文增量算首字');
eq(meta.isFirstContentEvent({ type: 'block_open', block: { type: 'text' } }), true, 'text 块打开算首字');
eq(meta.isFirstContentEvent({ type: 'block_open', block: { type: 'tool' } }), false, '工具块打开不算首字');
eq(meta.isFirstContentEvent({ type: 'block_patch', blockId: 'b' }), false, '块补丁不算首字');
eq(meta.isFirstContentEvent({ type: 'run_start' }), false, 'run_start 不算首字');

// ── 2. 端到端模拟一轮 ────────────────────────────────────────────────────
group('2. 一轮事件序列（thinking 先行）');
meta.beginRunTiming('e2e', 1000, 1010);
const events = [
  { type: 'run_start' },
  { type: 'block_open', block: { type: 'thinking' } },
  { type: 'block_delta', channel: 'thinking', delta: '想' },
  { type: 'block_open', block: { type: 'text' } },
  { type: 'block_delta', channel: 'text', delta: '你' },
];
const noteAt = PROBE === 'no-timing' ? null : 1250;
for (const ev of events) {
  // 探针：故意一个正文都不记，验证下游断言真会红
  if (noteAt !== null && meta.isFirstContentEvent(ev)) meta.noteFirstContent('e2e', noteAt);
}
const e2e = meta.takeRunTiming('e2e');
// 探针只改「行为」，期望值保持产品判据不变 —— 否则断言会跟着探针一起改绿
eq(e2e.t2, 1250, '首个正文事件被记为 t2（thinking 不抢）');
const summary = ui.buildTimingSummary(e2e, 1260, 40);
eq(summary.serverPreMs, 10, 'serverPreMs = t1 - t0');
eq(summary.serverFirstTokenMs, 240, 'serverFirstTokenMs = t2 - t1');
eq(summary.ttftMs, 260, 'ttftMs = t3 - t0');
eq(summary.uiSmoothMs, 40, 'uiSmoothMs 单列 40ms');

// 归因字段：传入 attribution 后 summary 带上 agentId + model
// 探针 no-attribution：故意不传归因，验证归因断言真会红
const probeAttr = PROBE === 'no-attribution' ? null : { agentId: 'codex', model: 'gpt-4o' };
const withAttr = ui.buildTimingSummary(e2e, 1260, 40, probeAttr);
if (PROBE === 'no-attribution') {
  // 探针模式下 withAttr.agentId 应为 null，断言「等于 codex」会红
  eq(withAttr.agentId, 'codex', '归因 agentId 被记下');
  eq(withAttr.model, 'gpt-4o', '归因 model 被记下');
} else {
  eq(withAttr.agentId, 'codex', '归因 agentId 被记下');
  eq(withAttr.model, 'gpt-4o', '归因 model 被记下');
}
const noAttr = ui.buildTimingSummary(e2e, 1260, 40, null);
eq(noAttr.agentId, null, '不传归因 ⇒ agentId 为 null（兼容旧样本）');
eq(noAttr.model, null, '不传归因 ⇒ model 为 null');

// 核心不变量：UI 平滑延迟绝不混进 TTFT
const mixedExpectation = PROBE === 'mix-ui' ? 300 : 260;
eq(summary.ttftMs, mixedExpectation, 'ttftMs 不含 uiSmoothMs（单列，不并入 TTFT）');
ok(summary.uiSmoothMs !== null && summary.ttftMs !== summary.uiSmoothMs, '两段数值各自独立，不是同一个量');

// ── 3. runTiming 边界 ────────────────────────────────────────────────────
group('3. 汇总边界：缺失数据不补 0');
const noText = ui.buildTimingSummary({ t0: 1000, t1: 1010, t2: null }, 1260, 0);
eq(noText.serverFirstTokenMs, null, '本轮无正文 ⇒ serverFirstTokenMs 为 null，不是 0');
ok(ui.formatTimingTitle(noText).includes('—'), '无正文时文案显示「—」而不是 0ms');
eq(ui.buildTimingSummary(null, 1260, 0), null, '服务端没给 timing ⇒ 整份汇总为 null');
eq(ui.buildTimingSummary({ t0: NaN, t1: 1010, t2: 1250 }, 1260, 0), null, 't0 非有限数 ⇒ 整组不信任');
eq(ui.buildTimingSummary({ t0: 1000, t1: 1010, t2: 1250 }, null, 40).ttftMs, null, 't3 缺席 ⇒ ttftMs 为 null');
ok(ui.formatTimingTitle(summary).includes('UI 平滑') && ui.formatTimingTitle(summary).includes('单列'), 'hover 文案把 UI 平滑标成单列');

ui.noteReveal(33);
const r1 = ui.takeReveal();
eq(r1.delayMs, 33, 'noteReveal / takeReveal 能配对');
eq(ui.takeReveal(), null, '取走后清空，不串到下一轮');
let threw = false;
try { ui.publishTiming(summary); } catch { threw = true; }
eq(threw, false, '非浏览器环境 publishTiming 不抛（观测出口有降级）');

// 分组统计出口
ui.publishTiming(withAttr);
ui.publishTiming(ui.buildTimingSummary(e2e, 1270, 50, { agentId: 'codex', model: 'gpt-4o' }));
ui.publishTiming(ui.buildTimingSummary({ t0: 2000, t1: 2010, t2: null }, 2100, 0, { agentId: 'gemini', model: 'gemini-pro' }));
const stats = ui.getTimingStats();
ok(stats.totalSamples >= 3, '分组统计：总样本数 ≥ 3');
ok(stats.groups.length >= 2, '按 agentId+model 分出 ≥ 2 组');
const codexGroup = stats.groups.find(g => g.agentId === 'codex');
ok(!!codexGroup && codexGroup.sampleCount >= 2, 'codex 组样本数 ≥ 2');
ok(codexGroup.serverFirstTokenMs.p50 !== null, 'codex 组 serverFirstTokenMs p50 有值');
ok(typeof codexGroup.ttftMs.p50 === 'number', 'codex 组 ttftMs p50 有值');
const geminiGroup = stats.groups.find(g => g.agentId === 'gemini');
ok(!!geminiGroup && geminiGroup.noContentCount === 1, 'gemini 组有一轮无正文（t2=null）');

// ── 3b. 投影器运行时 ────────────────────────────────────────────────────
// 源码契约只能证明「写在那儿」，证明不了函数真把字段挂到了事件上。
// finish() 无前置状态，直接构造最小夹具就能把这条链路钉到运行时。
group('3b. RunProjector.finish 运行时产出');
const projector = await import('../server/agents/projector.ts');
const mkProjector = () => new projector.RunProjector(
  { runId: 'rt', sessionId: 's', messageId: 'm', agentId: 'a' },
  () => 5000
);
const withTiming = mkProjector().finish('ok', undefined, { t0: 1000, t1: 1010, t2: 1250 }).end;
eq(withTiming.type, 'run_end', '肯定式：finish 真的产出了 run_end');
ok(!!withTiming.timing && withTiming.timing.t2 === 1250, 'run_end.timing 带着服务端首字时间戳');
const noTiming = mkProjector().finish('ok').end;
ok(!('timing' in noTiming), '否定式：没传 timing 时 run_end 不带这个字段（不塞 0）');
const nullTiming = mkProjector().finish('ok', undefined, { t0: 1000, t1: 1010, t2: null }).end;
ok(nullTiming.timing?.t2 === null, '本轮无正文时 t2=null 原样下发，不冒充 0ms');

// ── 4. comingSoon 数据隔离 ───────────────────────────────────────────────
group('4. 「即将接入」占位清单隔离');
const list = soon.COMING_SOON_AGENTS;
eq(list.length, 10, '精选 10 家（肯定式：清单不是空的）');
eq(new Set(list.map(a => a.id)).size, list.length, 'id 无重复');
ok(list.every(a => a.id && a.name && a.vendor && a.reason && a.color), '每家字段完整');
ok(list.every(a => ['acp', 'stream-json', 'evaluating'].includes(a.tier)), 'tier 取值合法');
ok(list.every(a => ['soon', 'planned'].includes(a.status)), 'status 取值合法');
ok(list.every(a => !/20\d\d|v\d+\.\d+|Q[1-4]/i.test(a.reason)), 'reason 不给日期 / 版本 / 季度承诺');
eq(soon.COMING_SOON_STATUS_LABEL.soon, '即将接入', '状态文案口径');
eq(soon.COMING_SOON_STATUS_LABEL.planned, '规划中', '规划中文案口径');
eq(soon.comingSoonIds().length, 10, 'comingSoonIds() 可用于闸门比对');

// 否定式：占位 id 绝不能出现在真 Agent 定义里
const defsSrc = code('server/agents/definitions.ts');
const definedIds = new Set([...defsSrc.matchAll(/^\s*id:\s*'([^']+)'/gm)].map(m => m[1]));
ok(definedIds.size > 0, '肯定式：确实从 definitions.ts 解析到了真 Agent id');
ok(list.every(a => !definedIds.has(a.id)), '否定式：占位 id 全部不在 AGENT_DEFS');
const retiredLine = defsSrc.split('\n').find(l => l.includes('RETIRED_AGENT_IDS'));
ok(!!retiredLine, '下架机制仍存在');
ok(list.every(a => !retiredLine.includes(a.id)), '占位清单不复用 RETIRED_AGENT_IDS 的条目');

// ── 5. 源码契约：接线与隔离 ──────────────────────────────────────────────
group('5. 源码契约（剥注释、锚行首）');
const idx = code('server/index.ts');
const blocks = code('shared/blocks.ts');
const proj = code('server/agents/projector.ts');
const routing = code('server/model-routing.ts');
const chat = code('src/hooks/useChat.ts');
const smooth = code('src/hooks/useSmoothText.ts');
const messages = code('src/components/ChatMessages.tsx');
const registryHook = code('src/hooks/useAgentRegistry.ts');
const app = code('src/App.tsx');
const contacts = code('src/components/ContactsPanel.tsx');
const dialog = code('src/components/GetAgentsDialog.tsx');

ok(hasLine(idx, /clientSentAt,/), '/api/chat 解构了 clientSentAt');
ok(hasLine(idx, /beginRunTiming\(runId, clientSentAt\)/), 'runId 之后起一轮计时');
ok(hasLine(idx, /if \(isFirstContentEvent\(event\)\) noteFirstContent\(runId\)/), 'writeEvent 记首个正文事件');
ok((idx.match(/takeRunTiming\(runId\)/g) ?? []).length >= 2, '两个 finish 分支都取走时间戳（含早退）');
ok(hasLine(blocks, /timing\?: \{ t0: number; t1: number; t2: number \| null \}/), 'run_end 有 timing 可选字段');
ok(hasLine(proj, /timing\?: \{ t0: number; t1: number; t2: number \| null \}/), 'projector.finish 第三参收 timing');
ok(hasLine(proj, /\.\.\.\(timing \? \{ timing \} : \{\}\)/), 'timing 只在有值时挂到 run_end');
ok(hasLine(chat, /clientSentAt: Date\.now\(\)/), '前端 fetch 带 t0');
ok(hasLine(chat, /firstContentAt = Date\.now\(\)/), '前端记 t3');
ok(hasLine(chat, /publishTiming\(timingSummary\)/), 'run_end 汇总进观测出口');
// 归因接线
ok(hasLine(chat, /runAttribution/), 'useChat 声明了归因变量');
ok(hasLine(chat, /agentId: typeof data\.agentId === 'string'/), 'run_start 时从事件取 agentId');
ok(hasLine(chat, /buildTimingSummary\(marks, firstContentAt, reveal\?\.delayMs \?\? null, runAttribution\)/), 'run_end 传归因给 buildTimingSummary');
ok(hasLine(chat, /__OPC_TIMING_STATS__/) || hasLine(code('src/utils/runTiming.ts'), /__OPC_TIMING_STATS__/), '观测出口注册了分组统计函数');
ok(hasLine(code('src/utils/runTiming.ts'), /function getTimingStats/), 'getTimingStats 函数已定义');
ok(hasLine(code('src/utils/runTiming.ts'), /interface TimingGroupStats/), 'TimingGroupStats 类型已定义');
ok(hasLine(code('src/utils/runTiming.ts'), /noContentCount/), '分组统计含无正文计数');
ok(hasLine(code('src/utils/runTiming.ts'), /p50: number \| null/), 'p50 字段类型正确');
ok(hasLine(smooth, /noteReveal\(Date\.now\(\) - firstTargetAtRef\.current\)/), 'useSmoothText 上报揭示延迟');
ok(hasLine(messages, /data-msg-timing/), '消息头有首字分段出口');
ok(hasLine(messages, /formatTimingTitle\(message\.timing\)/), 'hover 展示四段分解');

// configured / comingSoon 都是平级字段，不能挤进 models / agents 数组
ok(hasLine(idx, /function comingSoonList\(\)/), 'comingSoonList 过滤已转正的 id');
ok((idx.match(/comingSoon: comingSoonList\(\)/g) ?? []).length >= 2, '/api/agents 与 /probe 都下发平级 comingSoon');
ok(hasLine(idx, /const configured = agentAcceptsModel\(agentId\)/), 'configured 归属二次过滤');
ok((idx.match(/^\s+configured,$/gm) ?? []).length >= 3, 'models 路由三个返回分支都带平级 configured');
ok(hasLine(idx, /selectable: false,/), '否定式：agent-config 只读档 selectable:false 未被放开');
ok(hasLine(routing, /configuredLookup\?\.\(agentId, requested\)/), '白名单分支放行本机配置模型');
ok(hasLine(routing, /setConfiguredModelLookup/), '查表是可注入的纯判定，不带文件系统副作用');
// A213：App 层的选中归一化 effect 也必须放行 configured —— 否则弹窗层
// 放行、下一帧又被弹回内置默认，真机表现是「菜单里点不动」（2026-11-13
// WorkBuddy 自定义模型两条全中）。两处放行必须同源，少一处就是假控件。
ok(
  hasLine(app, /if \(configuredModels\.some\(m => m\.id === selectedModel\)\) return;/),
  'A213：App 归一化 effect 放行 configured 选中'
);
ok(
  /configuredModels,\n  \]\);/.test(stripComments(app)),
  'A213：effect 依赖数组带上 configuredModels（放行随清单刷新生效）'
);
ok(hasLine(registryHook, /data\.comingSoon/), '前端读平级字段');
ok(hasLine(registryHook, /const \[comingSoon, setComingSoon\]/), '占位清单是独立 state，不并入 agents');
ok(hasLine(app, /comingSoon=\{registry\.comingSoon\}/), 'App → ContactsPanel 转发');
ok(hasLine(contacts, /comingSoon=\{comingSoon\}/), 'ContactsPanel → GetAgentsDialog 转发');
ok(hasLine(dialog, /data-coming-soon-selectable="0"/), '占位行标记为不可选');
ok(hasLine(dialog, /data-coming-soon-group/), '占位清单是独立分组');

// section 切片内不许出现可点元素（否定式配肯定式）
const rawDialog = readSrc('src/components/GetAgentsDialog.tsx');
const secAt = rawDialog.indexOf('data-coming-soon-group');
const secEnd = secAt >= 0 ? rawDialog.indexOf('</section>', secAt) : -1;
// 精确切到本分组结束：不能按固定长度截，否则会把下面 footer 的
// 「重新检测」按钮切进来，让「分组内没有按钮」这条否定式断言假红。
const section = secAt >= 0 && secEnd > secAt ? rawDialog.slice(secAt, secEnd) : '';
ok(secAt >= 0 && secEnd > secAt, '肯定式：占位分组确实渲染在组件里');
ok(!/<button|<a\s|onClick=|InstallCard/.test(stripComments(section)), '否定式：占位分组内没有按钮 / 链接 / onClick / 安装卡');

// ── 收口 ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
if (PROBE) {
  // no-timing：t2 为 null ⇒ serverFirstTokenMs 也变 null ⇒ p50 也变 null（串味合理）
  // no-attribution：归因为 null ⇒ codex 组找不到 ⇒ 样本数断言也红（串味合理）
  const expected = PROBE === 'no-timing' ? 3 : PROBE === 'mix-ui' ? 1 : PROBE === 'no-attribution' ? 3 : 0;
  const worked = fail === expected && redNames.length === expected;
  console.log(worked
    ? `探针生效：${PROBE} → ${fail} 条断言如期变红`
    : `探针失效：期望 ${expected} 条变红，实际 ${fail} 条（${redNames.join(' / ')}）`);
  process.exit(worked ? 0 : 1);
}
if (fail) {
  console.log(`失败项：${redNames.join(' / ')}`);
  process.exit(1);
}
console.log('A210 同批闸门全绿');
