/**
 * 黄金样本回放闸门（P3，接入架构收敛方案）。
 *
 * 对 fixtures/golden/*.jsonl 的每份样本：用**当前解析代码**重放原始输出行，
 * 事件序列与续接令牌必须与录制时的期望一致。CLI 升级破坏解析 → 这里红灯，
 * 先于用户。
 *
 * 诚实边界：
 *   - 0 份真实样本 = 回放网未生效（闸门仍绿但会大声说出来）——样本靠
 *     `npm run golden:record -- <agentId>` 在开发机逐家采集；
 *   - argv/flags 漂移不在此网内（canary 的真实调用覆盖那一类）。
 *
 * 反向探针：--probe=no-compare 把比对函数短路成恒真，本闸门必须变红
 * （自检的正反两例 + 源码契约都会红）。
 */

import './lib/temp-data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const probe = (() => {
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = path.join(ROOT, 'fixtures', 'golden');

const sourceCache = new Map<string, string>();
function repoSource(rel: string, mutate?: (src: string) => string): string {
  const key = mutate ? `${rel}::probe` : rel;
  if (!sourceCache.has(key)) {
    let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (mutate) src = mutate(src);
    sourceCache.set(key, src);
  }
  return sourceCache.get(key)!;
}

/** 比对函数。探针（no-compare）会把它短路成恒真——下面的源码契约必须红。 */
function sequencesMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

const MUTATIONS: Record<string, { file: string; apply: (src: string) => string }> = {
  // 坏形态：比对被短路成恒真——回放网形同虚设。
  // 目标串在文件里出现 3 次（真函数 / 本表 / 断言），必须**全量**替换——
  // replace 只换第一处会让探针永远打不红（本闸门实测踩过）。
  'no-compare': {
    file: 'scripts/verify-golden-replay.ts',
    apply: src =>
      src
        .split('return a.length === b.length && a.every((t, i) => t === b[i]);')
        .join('return true;'),
  },
};

function contracts(mutate?: (src: string, file: string) => string): void {
  const S = (rel: string) => repoSource(rel, mutate ? (src) => mutate(src, rel) : undefined);
  if (!probe || probe === 'no-compare') {
    check('比对函数必须真的比对（恒真短路 = 回放网虚设）', () => {
      const src = S('scripts/verify-golden-replay.ts');
      assert.ok(
        src.includes('return a.length === b.length && a.every((t, i) => t === b[i]);'),
        '比对实现缺失、被改或被短路'
      );
    });
  }
}

async function selfTest(): Promise<void> {
  const { feedLines } = await import('./golden-lib.js');
  const echoMapper = () => (obj: unknown) => {
    const o = obj as { type?: string };
    if (o.type === 'text') return { type: 'text', content: String(o.content ?? '') };
    return null;
  };
  const fakeDef = {
    cli: {
      parse: 'jsonl' as const,
      createMapper: echoMapper,
      extractResumeToken: (obj: unknown) => {
        const o = obj as { sessionId?: string };
        return typeof o.sessionId === 'string' ? o.sessionId : null;
      },
    },
  };
  check('自检：喂行 → 事件序列 + 续接令牌', () => {
    const fed = feedLines(fakeDef, [
      { dir: 'stdout', line: JSON.stringify({ sessionId: 's1' }) },
      { dir: 'stdout', line: JSON.stringify({ type: 'text', content: 'a' }) },
      { dir: 'stdout', line: JSON.stringify({ type: 'text', content: 'b' }) },
      { dir: 'stderr', line: 'noise' },
      { dir: 'stdout', line: 'not json' },
    ]);
    assert.ok(fed);
    assert.deepEqual(fed.eventTypes, ['text', 'text']);
    assert.equal(fed.resumeToken, true);
    assert.equal(fed.stderrLines, 1);
  });
  check('自检：比对函数正反两例（探针变异时这里必须红）', () => {
    assert.equal(sequencesMatch(['text', 'done'], ['text', 'done']), true);
    assert.equal(sequencesMatch(['text'], ['text', 'done']), false);
    assert.equal(sequencesMatch(['text'], ['tool']), false);
  });
  check('自检：json-object 整段喂入', () => {
    const objDef = {
      cli: {
        parse: 'json-object' as const,
        mapLine: (obj: unknown) => ({ type: 'text', content: (obj as { response: string }).response }),
        extractResumeToken: (obj: unknown) => {
          const o = obj as { sessionId?: string };
          return typeof o.sessionId === 'string' ? o.sessionId : null;
        },
      },
    };
    const fed = feedLines(objDef, [
      { dir: 'stdout', line: '{"response":"ok",' },
      { dir: 'stdout', line: '"sessionId":"z1"}' },
    ]);
    assert.ok(fed && fed.eventTypes[0] === 'text' && fed.resumeToken);
  });
}

async function replayFixtures(): Promise<void> {
  const files = fs.existsSync(GOLDEN_DIR)
    ? fs.readdirSync(GOLDEN_DIR).filter(f => f.endsWith('.jsonl'))
    : [];
  if (files.length === 0) {
    console.log('  ⚠️ 0 份真实样本——回放网未生效。在开发机对每家 CLI 运行：');
    console.log('     npm run golden:record -- <agentId>   （一次真实调用，花一点额度）');
    return;
  }

  const { feedLines } = await import('./golden-lib.js');
  const { findDef } = await import('../server/agents/definitions.js');

  for (const file of files) {
    const raw = fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8').split('\n').filter(Boolean);
    let header!: { agent: string; cliVersion: string; parse: string };
    let expect!: { eventTypes: string[]; resumeToken: boolean; stderrLines: number };
    const lines: Array<{ dir: 'stdout' | 'stderr'; line: string }> = [];
    for (const line of raw) {
      const obj = JSON.parse(line);
      if ((obj as { golden?: number }).golden === 1) header = obj as typeof header;
      else if ((obj as { expect?: unknown }).expect) expect = (obj as { expect: typeof expect }).expect;
      else lines.push(obj as { dir: 'stdout' | 'stderr'; line: string });
    }

    check(`样本 ${file}：定义表仍能解析（agent/parse 未漂）`, () => {
      const def = findDef(header.agent);
      assert.ok(def?.cli, '定义表已无此 Agent 的 CLI 通道');
      assert.equal(def.cli.parse, header.parse, '解析方式已变（jsonl/json-object）——样本需要重新采集');
    });

    check(`样本 ${file}：当前解析重放 = 录制期望`, () => {
      const def = findDef(header.agent)!;
      const fed = feedLines(def, lines);
      assert.ok(fed, '解析层不可用');
      const mismatch = !sequencesMatch(fed.eventTypes, expect.eventTypes);
      assert.equal(mismatch, false, `事件序列漂移：期望 [${expect.eventTypes.join(',')}] 实际 [${fed.eventTypes.join(', ')}]`);
      assert.equal(fed.resumeToken, expect.resumeToken, '续接令牌出现与否漂移');
      assert.equal(fed.stderrLines, expect.stderrLines, 'stderr 行数漂移（CLI 可能把事件打去了 stderr）');
    });
  }
}

async function run(): Promise<void> {
  console.log(probe ? `P3 黄金回放闸门（探针模式：${probe}）` : 'P3 黄金样本回放闸门');
  const mutation = probe ? MUTATIONS[probe] : undefined;
  if (probe && !mutation) {
    console.error(`未知探针：${probe}（可用：${Object.keys(MUTATIONS).join(' / ')}）`);
    process.exit(2);
  }
  contracts(
    mutation ? (src, file) => (file === mutation.file ? mutation.apply(src) : src) : undefined
  );
  await selfTest();
  await replayFixtures();
  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (probe) {
    if (fail === 0) {
      console.error(`探针失败：变异（${probe}）后闸门仍然全绿——探针无效`);
      process.exit(1);
    }
    console.log(`探针有效：变异后 ${fail} 条变红（按预期）`);
    process.exit(0);
  }
  if (fail > 0) process.exit(1);
}

void run();
