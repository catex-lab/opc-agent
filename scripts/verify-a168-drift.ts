/**
 * A168 闸门：扩展的差异检测（P4）。
 *
 * ## 这一层守的是什么
 *
 * 不是「有个接口返回了东西」，而是三件容易做错、做错了也不报错的事：
 *
 * 1. **扫描必须是纯读**。`scanDrift()` 一旦顺手写了库，「只是看一眼」就会
 *    改变状态 —— 那种 bug 在界面上表现为「打开扩展栏之后，冲突自己没了」。
 * 2. **`conflict` 与 `updated` 不能混**。前者应用后会丢掉用户的编辑，
 *    后者不会。混成一个「有更新」的提示，用户点「全部应用」就静默毁掉自己的改动。
 * 3. **指纹口径必须与导入一致**。各写一份 `hashOf(...)` 的后果不是报错，
 *    而是「差异列表说变了、点了应用却说没变」这种没法排查的现象。
 *
 * ## 假环境
 *
 * `OPC_EXT_HOME` 指向自建假主目录、`OPC_DATA_DIR` 指向临时库，
 * 全程不碰真实 `~/.claude` 等目录（跑完拿文件树快照证明这一点）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;

function ok(cond: unknown, msg: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log('  ✓', msg);
  } else {
    fail += 1;
    console.log('  ✗', msg, detail === undefined ? '' : `[${String(detail)}]`);
  }
}

function section(title: string): void {
  console.log(`\n[${title}]`);
}

/* ══════════════ 夹具 ══════════════ */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a168-'));
const HOME = path.join(root, 'home');
const DATA = path.join(root, 'data');
fs.mkdirSync(DATA, { recursive: true });

function skillText(name: string, desc: string, body: string): string {
  return ['---', `name: ${name}`, `description: ${desc}`, '---', '', body, ''].join('\n');
}

function writeSkill(agent: string, name: string, body: string): string {
  const dir = path.join(HOME, `.${agent}`, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillText(name, `${name} 的描述`, body), 'utf8');
  return dir;
}

const ALPHA_DIR = writeSkill('claude', 'alpha', '# alpha v1');
const BETA_DIR = writeSkill('gemini', 'beta', '# beta v1');

const QODER_DIR = path.join(HOME, '.qoder');
fs.mkdirSync(QODER_DIR, { recursive: true });
const QODER_MCP = path.join(QODER_DIR, 'mcp.json');
function writeQoderMcp(servers: Record<string, unknown>): void {
  fs.writeFileSync(QODER_MCP, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
}
writeQoderMcp({ filesystem: { command: 'npx', args: ['-y', 'server-filesystem', '.'] } });

process.env.OPC_DATA_DIR = DATA;
process.env.OPC_EXT_HOME = HOME;

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(HOME, p), `${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

const before = snapshot(HOME);

/* ══════════════ [1] 源码接线 ══════════════ */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

section('1 源码接线');
const driftSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'extensions', 'drift.ts'), 'utf8');
const importSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'extensions', 'import.ts'), 'utf8');
const indexSrc = stripComments(fs.readFileSync(path.join(process.cwd(), 'server', 'index.ts'), 'utf8'));
const panelSrc = stripComments(
  fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'ExtensionPanel.tsx'), 'utf8')
);

ok(/export function scanDrift/.test(driftSrc), 'drift.ts 导出 scanDrift');
ok(/export function applyDrift/.test(driftSrc), 'drift.ts 导出 applyDrift');
/* 纯读的硬证据：扫描模块里不该出现任何写库语句。
   **先剥注释**再判 —— 否则一段写着「这里不要 UPDATE」的注释会让断言假绿。 */
ok(
  !/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM|extension_item)/i.test(stripComments(driftSrc)),
  'scanDrift 所在的模块没有任何写库语句（只报告，不应用）'
);
ok(
  /from '\.\/import\.js'/.test(driftSrc) && /skillContentHash/.test(driftSrc) && /mcpContentHash/.test(driftSrc),
  '指纹复用 import.ts 的实现（不自己再写一份 hashOf）'
);
ok(
  !/hashOf\s*\(/.test(driftSrc),
  'drift.ts 里没有裸 hashOf 调用（口径只能有一个来源）'
);
ok(/export function skillContentHash/.test(importSrc), 'import.ts 导出 skillContentHash');
ok(/export function mcpContentHash/.test(importSrc), 'import.ts 导出 mcpContentHash');

/* 路由顺序：drift 必须注册在 :kind/:name 之前，否则会被当成 kind='drift' 匹配走 */
const driftRouteAt = indexSrc.indexOf('"/api/extensions/drift"');
const kindRouteAt = indexSrc.indexOf('"/api/extensions/:kind/:name"');
ok(driftRouteAt > 0 && kindRouteAt > 0, '两条路由都在');
ok(
  driftRouteAt < kindRouteAt,
  'drift 路由注册在 :kind/:name 之前（否则永远 400）',
  `drift@${driftRouteAt} kind@${kindRouteAt}`
);
ok(/useExtensionDrift/.test(panelSrc), '扩展栏用了差异 hook');
ok(/data-ext-drift/.test(panelSrc), '差异提示有可断言的挂点');

/* 应用差异后必须**先作废在飞的轮询**再替换报告。
   60s 轮询与「点应用」是两个独立触发点，某次轮询可能在应用之前发出、之后才落地，
   手里那份是应用前的快照 —— 直接 setReport 会把刚刷新的报告盖回去，
   表现正是「应用成功了，徽章还挂着」。同 A162「两个触发点 GET 乱序落地」。 */
const hookSrc = stripComments(
  fs.readFileSync(path.join(process.cwd(), 'src', 'hooks', 'useExtensions.ts'), 'utf8')
);
const driftHookAt = hookSrc.indexOf('export function useExtensionDrift');
const driftHookBody = driftHookAt >= 0 ? hookSrc.slice(driftHookAt) : '';
const bumpAt = driftHookBody.indexOf('seqRef.current += 1');
const applySetAt = driftHookBody.indexOf('setReport(body.report)');
ok(driftHookAt >= 0, 'useExtensions.ts 里有 useExtensionDrift');
ok(
  bumpAt > 0 && applySetAt > 0 && bumpAt < applySetAt,
  '应用差异后先作废在飞的轮询、再替换报告（否则轮询把它盖回旧快照）',
  `bump@${bumpAt} setReport@${applySetAt}`
);

/* ══════════════ 导入基线 ══════════════ */

const store = await import('../server/extensions/store.js');
const importer = await import('../server/extensions/import.js');
const drift = await import('../server/extensions/drift.js');

const r0 = importer.runImport();

section('2 基线：刚导入完，差异必须是空的');
const base = drift.scanDrift();
ok(r0.added === 3, '夹具导入 3 条（alpha / beta / filesystem）', r0.added);
ok(base.counts.total === 0, '刚导入完没有任何差异', JSON.stringify(base.counts));
ok(base.entries.length === 0, 'entries 为空');
ok(typeof base.scannedAt === 'string' && base.scannedAt.includes('T'), 'scannedAt 是 ISO 时间');

section('3 new：外部新装');
const GAMMA_DIR = writeSkill('cursor', 'gamma', '# gamma');
const d3 = drift.scanDrift();
ok(d3.counts.new === 1, '发现 1 条新装', d3.counts.new);
const gamma = d3.entries.find(e => e.name === 'gamma');
ok(gamma?.state === 'new', 'gamma 是 new', gamma?.state);
ok(gamma?.agentId === 'cursor', '来源记的是 cursor', gamma?.agentId);
ok(String(gamma?.detail).includes('cursor'), 'detail 说清了「在哪装的」', gamma?.detail);
ok(
  store.listItems('skill').length === 2,
  '**扫描没有顺手写库**（库里还是 2 条技能）',
  store.listItems('skill').length
);

section('4 updated：源变了、本地没改过');
fs.writeFileSync(path.join(ALPHA_DIR, 'SKILL.md'), skillText('alpha', 'alpha 的描述', '# alpha v2'), 'utf8');
const d4 = drift.scanDrift();
const alphaUpd = d4.entries.find(e => e.name === 'alpha');
ok(alphaUpd?.state === 'updated', 'alpha 是 updated', alphaUpd?.state);
ok(
  store.findItem('skill', 'alpha')?.body?.includes('v1') === true,
  '库里还是旧正文（差异只是报告，没有自动跟）',
  store.findItem('skill', 'alpha')?.body?.slice(0, 20)
);

section('5 conflict：源变了 + 本地改过');
store.updateLocal('skill', 'alpha', { body: '# 我自己改的' });
fs.writeFileSync(path.join(ALPHA_DIR, 'SKILL.md'), skillText('alpha', 'alpha 的描述', '# alpha v3'), 'utf8');
const d5 = drift.scanDrift();
const alphaConf = d5.entries.find(e => e.name === 'alpha');
ok(alphaConf?.state === 'conflict', 'alpha 变成 conflict', alphaConf?.state);
ok(String(alphaConf?.detail).includes('改过'), 'detail 点明了「你改过这条」', alphaConf?.detail);

const applied5 = drift.applyDrift([{ kind: 'skill', name: 'alpha' }]);
ok(applied5.results[0]?.outcome === 'conflict', '应用冲突项 → 结论是 conflict（不是成功）', applied5.results[0]?.outcome);
ok(
  store.findItem('skill', 'alpha')?.body === '# 我自己改的',
  '**本地修改没有被覆盖**（这是 conflict 的全部意义）',
  store.findItem('skill', 'alpha')?.body
);
ok(
  applied5.report.entries.some(e => e.name === 'alpha' && e.state === 'conflict'),
  '应用之后冲突仍在（没有被「假装解决」）'
);

section('6 冲突的正确解法：以源为准');
store.acceptSource('skill', 'alpha');
const resolved = importer.importByName('skill', 'alpha');
ok(resolved.outcome === 'updated', '接受来源后按源刷新 → updated', resolved.outcome);
ok(
  store.findItem('skill', 'alpha')?.body?.includes('v3') === true,
  '正文换成了源的样子',
  store.findItem('skill', 'alpha')?.body?.slice(0, 20)
);
ok(
  !drift.scanDrift().entries.some(e => e.name === 'alpha'),
  'alpha 从差异里消失'
);

section('7 gone：源文件没了');
fs.rmSync(BETA_DIR, { recursive: true, force: true });
const d7 = drift.scanDrift();
const betaGone = d7.entries.find(e => e.name === 'beta');
ok(betaGone?.state === 'gone', 'beta 是 gone', betaGone?.state);
ok(betaGone?.agentId === null, 'gone 没有来源 agentId', betaGone?.agentId);
const applied7 = drift.applyDrift([{ kind: 'skill', name: 'beta' }]);
ok(applied7.results[0]?.outcome === 'missing', '对 gone 应用 → missing（不假装成功）', applied7.results[0]?.outcome);
ok(
  !!store.findItem('skill', 'beta'),
  '**不会自动删掉库里的条目**（删不删由用户决定）'
);

section('8 应用 new：真写进库，且差异消失');
const applied8 = drift.applyDrift([{ kind: 'skill', name: 'gamma' }]);
ok(applied8.results[0]?.outcome === 'added', 'gamma → added', applied8.results[0]?.outcome);
ok(!!store.findItem('skill', 'gamma'), '库里真的有 gamma 了');
ok(
  !applied8.report.entries.some(e => e.name === 'gamma'),
  '响应里带的新报告已经不含 gamma（指纹口径两边一致）'
);
ok(
  store.findItem('skill', 'gamma')?.body?.includes('# gamma') === true,
  '正文是源里的内容',
  store.findItem('skill', 'gamma')?.body
);

section('9 MCP 差异');
writeQoderMcp({
  filesystem: { command: 'npx', args: ['-y', 'server-filesystem', '/tmp'] },
  memory: { command: 'npx', args: ['-y', 'server-memory'] },
});
const d9 = drift.scanDrift();
const fsMcp = d9.entries.find(e => e.kind === 'mcp' && e.name === 'filesystem');
const memMcp = d9.entries.find(e => e.kind === 'mcp' && e.name === 'memory');
ok(fsMcp?.state === 'updated', 'filesystem 的配置变了 → updated', fsMcp?.state);
ok(memMcp?.state === 'new', 'memory 是新出现的服务 → new', memMcp?.state);
const applied9 = drift.applyDrift([
  { kind: 'mcp', name: 'filesystem' },
  { kind: 'mcp', name: 'memory' },
]);
ok(applied9.results[0]?.outcome === 'updated', 'filesystem → updated', applied9.results[0]?.outcome);
ok(applied9.results[1]?.outcome === 'added', 'memory → added', applied9.results[1]?.outcome);
ok(
  store.findItem('mcp', 'filesystem')?.configJson?.includes('/tmp') === true,
  'MCP 配置跟上了新值',
  store.findItem('mcp', 'filesystem')?.configJson?.replace(/\s+/g, ' ').slice(0, 80)
);
ok(!applied9.report.entries.some(e => e.kind === 'mcp'), 'MCP 差异清空');

section('10 排序：会丢东西的排最前');
/* 现在造齐三态：conflict（alpha 再改一次）+ new + gone */
store.updateLocal('skill', 'alpha', { body: '# 又改了一次' });
fs.writeFileSync(path.join(ALPHA_DIR, 'SKILL.md'), skillText('alpha', 'alpha 的描述', '# alpha v4'), 'utf8');
const d10 = drift.scanDrift();
ok(d10.entries[0]?.state === 'conflict', '第一条是 conflict', d10.entries[0]?.state);
ok(
  d10.entries.findIndex(e => e.state === 'conflict') < d10.entries.findIndex(e => e.state === 'gone'),
  'conflict 排在 gone 前面'
);
ok(d10.counts.total === d10.entries.length, 'counts.total 与 entries 长度一致');

section('11 副本（非主来源）变了也要报');
/* 同一条技能在两个 Agent 里各有一份副本，内容不同（更接近真实：各自演化了）。
   主来源 = 字典序第一个 = claude。改**gemini** 那份，差异检测必须发现。 */
writeSkill('claude', 'delta', '# delta v1');
const DELTA_GEMINI = writeSkill('gemini', 'delta', '# delta gemini');
const deltaApplied = drift.applyDrift([{ kind: 'skill', name: 'delta' }]);
ok(deltaApplied.results[0]?.outcome === 'added', 'delta 首次导入 → added', deltaApplied.results[0]?.outcome);
const deltaItem = store.findItem('skill', 'delta');
ok(deltaItem?.body?.includes('# delta v1') === true, '正文取的是主来源（claude）', deltaItem?.body);
/* 关键：副本行的指纹必须是**它自己的**，不是主来源的。
   以前这里靠 `{ ...payload }` 把主来源指纹套在副本上，这条断言就会红。 */
const deltaGeminiSource = store.listSources(deltaItem!.id).find(s => s.agentId === 'gemini');
ok(
  deltaGeminiSource != null && deltaGeminiSource.contentHash !== deltaItem!.contentHash,
  '副本来源存的是自己的指纹（不是主来源的）',
  deltaGeminiSource?.contentHash?.slice(0, 12)
);
ok(
  !drift.scanDrift().entries.some(e => e.name === 'delta'),
  '刚导入完 delta 没有差异（逐来源口径下也一致）'
);

fs.writeFileSync(path.join(DELTA_GEMINI, 'SKILL.md'), skillText('delta', 'delta 的描述', '# delta gemini v2'), 'utf8');
const d11 = drift.scanDrift();
const deltaDrift = d11.entries.find(e => e.name === 'delta');
ok(deltaDrift?.state === 'updated', '副本变了 → updated', deltaDrift?.state);
ok(deltaDrift?.agentId === 'gemini', '报的是真正变了的那个来源（gemini）', deltaDrift?.agentId);
ok(String(deltaDrift?.detail).includes('gemini'), 'detail 指明了哪个来源变了', deltaDrift?.detail);
ok(
  store.findItem('skill', 'delta')?.body?.includes('# delta v1') === true,
  '扫描没有改正文（副本变不影响正文）',
  store.findItem('skill', 'delta')?.body
);
/* 副本变化应用后应当只是「重新登记」，不改正文、也不再报差异。
   `updated` 是可能的（若 importOne 认为需更新），但正文必须还是主来源那份。 */
const applied11 = drift.applyDrift([{ kind: 'skill', name: 'delta' }]);
ok(
  !applied11.report.entries.some(e => e.name === 'delta'),
  '应用副本差异后 delta 的差异清空'
);
ok(
  store.findItem('skill', 'delta')?.body?.includes('# delta v1') === true,
  '**正文仍然以主来源为准**（副本不会覆盖它）',
  store.findItem('skill', 'delta')?.body
);

section('12 零写入（拿文件树快照比）');
const after = snapshot(HOME);
const added = [...after.keys()].filter(k => !before.has(k));
const changed = [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k));
const removed = [...before.keys()].filter(k => !after.has(k));
/* 我们自己在夹具里增删过文件，所以这里只断言「扫描/应用没有碰**别的**文件」：
   gamma / delta 是我们新写的、beta 是我们删的，除此之外不该有任何变化。 */
const unexpectedAdded = added.filter(k => !k.includes('gamma') && !k.includes('delta'));
const unexpectedRemoved = removed.filter(k => !k.includes('beta'));
const unexpectedChanged = changed.filter(
  k => !k.includes('alpha') && !k.includes('mcp.json') && !k.includes('delta')
);
ok(unexpectedAdded.length === 0, '除了我们自己的夹具，没有新增文件', unexpectedAdded.join(', '));
ok(unexpectedRemoved.length === 0, '除了我们删的 beta，没有文件消失', unexpectedRemoved.join(', '));
ok(unexpectedChanged.length === 0, '除了我们改的 alpha / mcp.json，没有文件被改写', unexpectedChanged.join(', '));
ok(
  fs.readFileSync(path.join(ALPHA_DIR, 'SKILL.md'), 'utf8').includes('# alpha v4'),
  '源文件内容就是最后一次写的那份（我们从不写回源文件）'
);

/* ══════════════ 收尾 ══════════════ */

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论（Windows 上 db 还开着会 EBUSY） */
}
process.exit(fail === 0 ? 0 : 1);
