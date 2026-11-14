/**
 * UI 文案治理闸门（AGENTS.md §10，2026-11-14）。
 *
 * 三层：
 *   [C1] 禁词扫描 —— zh/en i18n 值 + 组件可见文本，禁词零命中
 *   [C2] 长度棘轮 —— i18n 值超过 60 字的条数只许减不许增（基线见 BASELINE）
 *   [P] 反向探针 —— 把禁词表删掉一个词，自检样本必须变红（--probe=no-blacklist）
 *
 * 范围与口径：
 *   - i18n（zh/en）是文案的权威来源，逐条扫值；
 *   - 组件 tsx 只扫「字符串字面量中的禁词」（剥掉行注释与块注释）；
 *   - InfoHint/Tooltip 内的长文本不受 30 字限制（渐进披露合规），
 *     但 60 字棘轮对 i18n 全量生效（InfoHint 文案也在 i18n 里）。
 *
 * 运行：npx tsx scripts/verify-copy-governance.ts [--probe=no-blacklist]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const probe = (() => {
  const eq = process.argv.find(a => a.startsWith('--probe='));
  if (eq) return eq.slice('--probe='.length);
  const i = process.argv.indexOf('--probe');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** B6 禁词清单（AGENTS.md §10.4）。探针会试图删词——删了必须红。 */
const BANNED_WORDS = [
  '点击此按钮',
  '该按钮用于',
  '此功能',
  '本页面',
  '该页面',
  '将会',
  '用于帮助',
  '请注意',
  '温馨提示',
  '可以实现',
  '该操作会',
  '点击后',
  '您可以在此',
];

/** 纯函数：一段文本里命中的禁词（去重、按表顺序）。自检与扫描共用 */
export function findBanned(text: string, banned: string[] = BANNED_WORDS): string[] {
  return banned.filter(w => text.includes(w));
}

/**
 * 长度棘轮基线：i18n 值 > 60 字的条数（治理后实测 93 条，只许减不许增）。
 *
 * 为什么是 93 而不是 0：其中大部分是 InfoHint/Tooltip 的**渐进披露**文本
 * （AGENTS.md §10.3 允许的位置），30 字预算只约束常驻 helper——闸门无法
 * 从 i18n 键名区分渲染位置，所以按「总量只减不增」棘轮：新增长文案必须
 * 同时消化等量旧文案。
 */
const LONG_VALUE_BASELINE = 93;
/** 长度豁免前缀：关于页法务文案是特例 */
const LENGTH_EXEMPT_PREFIXES = ['settings.about.'];

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

/** 读取 i18n 文件的全部键值对（单引号字符串，与 i18n 文件格式一致） */
function readI18nValues(rel: string): Array<{ key: string; value: string }> {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out: Array<{ key: string; value: string }> = [];
  const re = /'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push({ key: m[1], value: m[2] });
  }
  return out;
}

/** 组件文件的禁词扫描：剥掉注释行后按禁词表查 */
function scanComponents(banned: string[]): Array<{ file: string; line: number; word: string }> {
  const dir = path.join(ROOT, 'src', 'components');
  const hits: Array<{ file: string; line: number; word: string }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.tsx') && !f.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!;
      if (line.trim().startsWith('//')) continue;
      line = line.replace(/\/\*[\s\S]*?\*\//g, ''); // 块注释
      for (const w of banned) {
        if (line.includes(w)) {
          hits.push({ file: f, line: i + 1, word: w });
          break;
        }
      }
    }
  }
  return hits;
}

function contracts(mutatedBanned?: string[]): void {
  const banned = mutatedBanned ?? BANNED_WORDS;

  const zh = readI18nValues('src/i18n/zh.ts');
  const en = readI18nValues('src/i18n/en.ts');

  check('禁词扫描：i18n（zh+en）零命中', () => {
    for (const { key, value } of [...zh, ...en]) {
      const hits = findBanned(value, banned);
      assert.equal(hits.length, 0, `${key} 命中禁词：${hits.join('、')}`);
    }
  });

  check('禁词扫描：组件 tsx 零命中', () => {
    const hits = scanComponents(banned);
    assert.equal(hits.length, 0, hits.slice(0, 3).map(h => `${h.file}:${h.line} ${h.word}`).join(' / '));
  });

  check('自检：样本含禁词必须被抓到', () => {
    const sample = '保存 保存后本页面将刷新。';
    const hits = findBanned(sample, banned);
    assert.ok(hits.includes('本页面'), '样本禁词未被抓到');
  });

  if (!probe) {
    check('长度棘轮：i18n 超过 60 字的条数 ≤ 基线', () => {
      const exempt = (key: string) => LENGTH_EXEMPT_PREFIXES.some(p => key.startsWith(p));
      const longZh = zh.filter(v => v.value.length > 60 && !exempt(v.key));
      const longEn = en.filter(v => v.value.length > 60 && !exempt(v.key));
      const total = longZh.length + longEn.length;
      assert.ok(
        total <= LONG_VALUE_BASELINE,
        `超长文案 ${total} 条 > 基线 ${LONG_VALUE_BASELINE}：${[...longZh, ...longEn]
          .slice(0, 5)
          .map(v => v.key)
          .join('、')}…（每条应 ≤60 字；更长请移入 InfoHint/帮助中心）`
      );
    });
  }
}

async function run(): Promise<void> {
  console.log(probe ? `UI 文案治理闸门（探针模式：${probe}）` : 'UI 文案治理闸门（AGENTS.md §10）');
  const mutation = probe === 'no-blacklist' ? (list: string[]) => list.filter(w => w !== '本页面') : undefined;
  contracts(mutation);
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

// assert 供 check 使用（保持与其它闸门同构）
import assert from 'node:assert';

void run();
