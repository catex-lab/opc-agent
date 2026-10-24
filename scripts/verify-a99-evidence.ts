/**
 * A99 文件核对的单元验证（纯函数 + 真实临时文件，不起浏览器）。
 *
 * ## 这一层最容易出的错
 *
 * 不是「读不到文件」，而是**把不确定说成确定**：
 *   · 把「无法判定」算成「已落地」→ 用户以为改好了
 *   · 把「临时文件被清理」算成「没落地」→ 满屏假警报，用户学会无视它
 *   · 把 read / bash 也算进来 → 没改文件的步骤也进核对列表
 *
 * 三种都是「看着挺正常」的错，只能靠断言钉住。
 *
 * ## 为什么用真实文件而不是 mock fs
 *
 * 判定的核心是 `fs.existsSync` / `statSync` / `readFileSync` 三者的**组合语义**
 * （文件不存在、存在但读不了、mtime 比消息新）。mock 掉它们就等于把要验的
 * 东西替换掉了，测出来的是我自己写的假 fs。
 *
 * 运行：npx tsx scripts/verify-a99-evidence.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isEphemeralPath,
  resolveTargetPath,
  summarizeEvidence,
  verifyFileChanges,
} from '../server/file-evidence.js';
import { hasFileEdits } from '../shared/trace.js';
import type { Block } from '../shared/blocks.js';

let total = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

/** 造一个写类工具块 */
function tool(name: string, input: Record<string, unknown>): Block {
  return {
    id: `blk-${name}`,
    type: 'tool',
    toolId: `tid-${name}`,
    name,
    input,
    status: 'completed',
    startedAt: 0,
    endedAt: 1,
  };
}

/**
 * 夹具目录刻意放在**项目内的 `.tmp/`**，不放 `os.tmpdir()`。
 *
 * 第一版放在系统临时目录里，于是「文件不存在 → missing」这条断言永远得到
 * `ephemeral` —— 判定本身是对的（临时目录里的文件消失是预期行为），
 * 是夹具选错了地方。要测「项目内文件不见了」，夹具就必须在项目里。
 * `.tmp/` 已在 .gitignore 第 13 行。
 */
fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'a99-'));
const write = (name: string, text: string) => {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
};

try {
  console.log('\nA99 文件核对');

  // ── 1. 路径解析 ────────────────────────────────────────────────────
  {
    const abs = path.join(root, 'a.txt');
    ok(resolveTargetPath(abs, null) === path.resolve(abs), '绝对路径不需要 cwd');
    ok(resolveTargetPath('a.txt', root) === path.resolve(root, 'a.txt'), '相对路径按 cwd 解析');
    ok(resolveTargetPath('a.txt', null) === null, '相对路径 + 无 cwd → 解析不了（返回 null）');
  }

  // ── 2. 临时目录识别 ────────────────────────────────────────────────
  {
    ok(isEphemeralPath(path.join(os.tmpdir(), 'x', 'y.py')), '系统临时目录下的路径算临时');
    ok(isEphemeralPath('C:/Users/a/AppData/Local/Temp/opencode/q.py'), 'Windows Temp 段也能认出');
    ok(!isEphemeralPath(path.join(root, 'src', 'app.ts')), '项目目录里的不算临时');
  }

  // ── 3. edit：三种基本结论 ──────────────────────────────────────────
  {
    // 夹具必须是**改动之后**的磁盘状态 —— 核对读的是现状，不是历史。
    // 第一版把改动前的内容写进文件却断言「已落地」，四条断言全红，
    // 而错的是夹具不是判定。
    const p = write('edit-basic.ts', 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
    const r = verifyFileChanges(
      [tool('edit', { file_path: p, old_string: 'const b = 2;', new_string: 'const b = 20;' })],
      null
    );
    ok(r.length === 1 && r[0].verdict === 'landed', 'new 在文件里、old 已消失 → landed', r[0]?.verdict);

    // 文件仍是改动前：old 在、new 不在 → 声明了但没落地
    const p2 = write('edit-not-landed.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const r2 = verifyFileChanges(
      [tool('edit', { file_path: p2, old_string: 'const b = 2;', new_string: 'const b = 20;' })],
      null
    );
    ok(r2[0]?.verdict === 'not_landed', 'old 还在、new 不在 → not_landed', r2[0]?.verdict);

    // 两边都在：文件里既有旧行又有新行 —— 只替换了第一处，或后来又被改回
    const p3 = write('edit-both.ts', 'const b = 2;\nconst b = 20;\n');
    const r3 = verifyFileChanges(
      [tool('edit', { file_path: p3, old_string: 'const b = 2;', new_string: 'const b = 20;' })],
      null
    );
    ok(r3[0]?.verdict === 'ambiguous', 'old 和 new 都在 → ambiguous（不猜）', r3[0]?.verdict);
  }

  // ── 4. multiedit：多对里有一对没落地就算没落地 ─────────────────────
  {
    const p = write('multi.ts', 'x1\ny2\nz3\n');
    const allOk = verifyFileChanges(
      [
        tool('multiedit', {
          file_path: p,
          edits: [
            { old_string: 'x1', new_string: 'X1' },
            { old_string: 'y2', new_string: 'Y2' },
          ],
        }),
      ],
      null
    );
    ok(allOk[0]?.verdict === 'not_landed', '两对都没落地 → not_landed', allOk[0]?.verdict);

    const p2 = write('multi2.ts', 'X1\nY2\n');
    const r = verifyFileChanges(
      [
        tool('multiedit', {
          file_path: p2,
          edits: [
            { old_string: 'x1', new_string: 'X1' },
            { old_string: 'y2', new_string: 'Y2' },
          ],
        }),
      ],
      null
    );
    ok(r[0]?.verdict === 'landed', '两对都落地 → landed', r[0]?.verdict);
  }

  // ── 5. write：三种结论 ─────────────────────────────────────────────
  {
    const p = write('w1.ts', 'line1\nline2\nline3\n');
    const exact = verifyFileChanges(
      [tool('write', { file_path: p, content: 'line1\nline2\nline3\n' })],
      null
    );
    ok(exact[0]?.verdict === 'landed', '文件内容与写入内容完全一致 → landed', exact[0]?.verdict);

    const p2 = write('w2.ts', 'header-a\nheader-b\nheader-c\ntail-edited-later\n');
    const later = verifyFileChanges(
      [tool('write', { file_path: p2, content: 'header-a\nheader-b\nheader-c\n' })],
      null
    );
    ok(later[0]?.verdict === 'landed_then_modified', '前几行对得上、后面被改过 → landed_then_modified', later[0]?.verdict);

    const p3 = write('w3.ts', '完全不相干的内容，长度足够长以避免指纹过短\n');
    const no = verifyFileChanges(
      [tool('write', { file_path: p3, content: 'AAA-begin\nBBB-middle\nCCC-end\n' })],
      null
    );
    ok(no[0]?.verdict === 'not_landed', '找不到写入痕迹 → not_landed', no[0]?.verdict);
  }

  // ── 6. 文件不存在：项目内 vs 临时目录 ──────────────────────────────
  {
    const gone = path.join(root, 'never-existed.ts');
    const r = verifyFileChanges([tool('write', { file_path: gone, content: 'x' })], null);
    ok(r[0]?.verdict === 'missing', '项目内文件不存在 → missing', r[0]?.verdict);

    const tmp = path.join(os.tmpdir(), 'a99-ephemeral-never', 'q.py');
    const r2 = verifyFileChanges([tool('write', { file_path: tmp, content: 'x' })], null);
    ok(r2[0]?.verdict === 'ephemeral', '临时目录文件不存在 → ephemeral（不算问题）', r2[0]?.verdict);
  }

  // ── 7. 跳过：缺路径 / 无 cwd 的相对路径 ────────────────────────────
  {
    const r = verifyFileChanges([tool('edit', { old_string: 'a', new_string: 'b' })], null);
    ok(r.length === 1 && r[0].verdict === 'skipped', '入参里没有文件路径 → skipped', r[0]?.verdict);
    ok(!!r[0]?.reason, 'skipped 必须带原因（否则用户不知道为什么不核对）', r[0]?.reason);

    const r2 = verifyFileChanges([tool('edit', { file_path: 'rel/x.ts', old_string: 'a', new_string: 'b' })], null);
    ok(r2[0]?.verdict === 'skipped', '相对路径 + 无 cwd → skipped', r2[0]?.verdict);
  }

  // ── 8. 只核对写类工具 ──────────────────────────────────────────────
  {
    const p = write('ignore.ts', 'hello\n');
    const r = verifyFileChanges(
      [
        tool('read', { file_path: p }),
        tool('bash', { command: 'echo hi' }),
        tool('grep', { pattern: 'x' }),
      ],
      null
    );
    ok(r.length === 0, 'read / bash / grep 不进核对列表', `${r.length} 条`);
  }

  // ── 9. 不同厂商的路径字段名 ────────────────────────────────────────
  {
    const p = write('alias.ts', 'k1\nk2\n');
    for (const key of ['file_path', 'filePath', 'path', 'target_file']) {
      const r = verifyFileChanges([tool('write', { [key]: p, content: 'k1\nk2\n' })], null);
      ok(r[0]?.verdict === 'landed', `路径字段 ${key} 能认出来`, r[0]?.verdict);
    }
  }

  // ── 10. laterModified：mtime 晚于消息时间 ──────────────────────────
  {
    const p = write('mtime.ts', 'a\nb\n');
    const future = Date.now() - 60_000; // 消息时间设在一分钟前 → 文件更新
    const r = verifyFileChanges([tool('write', { file_path: p, content: 'a\nb\n' })], null, future);
    ok(r[0]?.laterModified === true, 'mtime 晚于消息时间 → laterModified', String(r[0]?.laterModified));

    const r2 = verifyFileChanges([tool('write', { file_path: p, content: 'a\nb\n' })], null, Date.now() + 60_000);
    ok(r2[0]?.laterModified === false, 'mtime 早于消息时间 → 不标记', String(r2[0]?.laterModified));
  }

  // ── 11. 汇总与告警 ─────────────────────────────────────────────────
  {
    const p = write('sum-ok.ts', 'v1\nv2\n');
    const good = verifyFileChanges([tool('write', { file_path: p, content: 'v1\nv2\n' })], null);
    ok(summarizeEvidence(good).alarm === null, '全部落地时不出告警', String(summarizeEvidence(good).alarm));

    const gone = path.join(root, 'sum-gone.ts');
    const bad = verifyFileChanges([tool('write', { file_path: gone, content: 'v1\n' })], null);
    ok(!!summarizeEvidence(bad).alarm, '有文件对不上时给出告警', summarizeEvidence(bad).alarm ?? 'null');

    const mixed = summarizeEvidence([...good, ...bad]);
    ok(mixed.landed === 1 && mixed.notLanded === 1 && mixed.total === 2, '混合计数正确', JSON.stringify(mixed));
  }

  // ── 12. 回归：hasFileEdits 必须认 edit 类 ──────────────────────────
  {
    // 这条是写本次改动时真的踩到的：把 WRITE_TOOL_NAMES 收敛成一份时，
    // 顺手把 hasFileEdits 改成只查 write 集合，于是「只做替换」的消息
    // 不再显示验证/核对入口 —— 而 Edit 恰恰是最常见的改文件方式。
    const onlyEdit: Block[] = [tool('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })];
    ok(hasFileEdits(onlyEdit), 'hasFileEdits 认 edit（只做替换也算改过文件）');
    ok(hasFileEdits([tool('multiedit', { edits: [] })]), 'hasFileEdits 认 multiedit');
    ok(hasFileEdits([tool('write', { file_path: 'a.ts', content: 'x' })]), 'hasFileEdits 认 write');
    ok(!hasFileEdits([tool('read', { file_path: 'a.ts' })]), 'hasFileEdits 不认 read');
  }
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`失败 ${failures.length} 条：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
