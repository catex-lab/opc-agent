/**
 * 反向探针：证明 verify-agent-status-copy 的断言真的会变红（2026-11-25）。
 *
 * 做法不是「在脚本里假装退回旧行为」，而是**真的把实现退回坏版本**再跑闸门：
 *   [P1] agentStatusCopy 退回改造前（主行直接吐 message）→ 分层断言必须红
 *   [P2] 详情页重新挂上 installHint 灰色散文 → 详情页断言必须红
 * 每次退还后自动恢复原文件，最后再跑一遍闸门确认又是绿的（否则说明恢复没做好）。
 *
 * 运行：`npm run verify:agent-status-copy-probe`（不进 verify:ui 链，耗时靠跑闸门 ×3）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = path.join(ROOT, 'src/agentStatusCopy.ts');
const DETAIL = path.join(ROOT, 'src/components/AgentDetailSections.tsx');

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, desc: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${desc}${detail ? `（${detail}）` : ''}`);
  } else {
    failures.push(desc);
    console.log(`  ✗ ${desc}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 跑闸门，返回失败条数（0 = 全绿）。 */
function runGate(): number {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-agent-status-copy.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/(\d+) 通过 \/ (\d+) 失败/);
  return m ? Number(m[2]) : -1;
}

/** 用「标记区间替换」退坏，恢复时把原文写回 —— 不依赖 sed/正则改写整文件。 */
function withTemporaryEdit(file: string, find: string, replace: string, body: () => void) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(find)) {
    ok(false, `反向探针的锚点在 ${path.basename(file)} 里找不到（实现变了？）`);
    return;
  }
  writeFileSync(file, original.replace(find, replace), 'utf8');
  try {
    body();
  } finally {
    writeFileSync(file, original, 'utf8');
  }
}

console.log('[P0] 改造后基线：闸门应全绿');
ok(runGate() === 0, '基线 0 失败');

console.log('\n[P1] 反向探针：状态文案退回「主行直接吐 message」');
withTemporaryEdit(
  COPY,
  'const legacy = splitLegacy(status.message);',
  'return { primary: status.message ?? "", detail: undefined }; // PROBE\n  const legacy = splitLegacy(status.message);',
  () => {
    const n = runGate();
    ok(n > 0, '退回旧行为后闸门必须变红', `失败 ${n} 条`);
  }
);

console.log('\n[P2] 反向探针：接入方式重新挂回 installHint 灰色散文');
withTemporaryEdit(
  DETAIL,
  '<DetailRow label="接入方式" value={kindLabel(agent.kind)} />',
  '<DetailRow label="接入方式" value={kindLabel(agent.kind)} />\n          {agent.installHint && !showInstallCard && <div>{agent.installHint}</div>}',
  () => {
    const n = runGate();
    ok(n > 0, '退回灰色散文后闸门必须变红', `失败 ${n} 条`);
  }
);

console.log('\n[P3] 恢复后：闸门必须重新变绿（证明探针没把文件改坏）');
ok(runGate() === 0, '恢复后 0 失败');

console.log(
  `\n${failures.length === 0 ? '全部通过' : '存在失败'}：${passed} 通过 / ${failures.length} 失败`
);
if (failures.length) {
  console.log(failures.map(f => ` - ${f}`).join('\n'));
  process.exit(1);
}
