/**
 * A133 验证：设计系统写法审计（源码级静态扫描）
 *
 * ## 为什么需要这道闸门
 *
 * 仓库里已有 8 条设计闸门（tokens / surface / overlay / a124-button-spec /
 * responsive / native-theme / window-glass / theme），但它们**全是运行时**的 ——
 * 在浏览器里量渲染值：边线 alpha 有没有超 0.21、浮层够不够不透明、
 * 按钮是不是 32px、全 DOM 里有没有蓝色。
 *
 * 运行时闸门能证明「现在长这样」，但拦不住「下次有人写个 text-[13.5px]」。
 * 而「每改一页就冒出一套新字号」正是这么发生的：不是一次大改，
 * 是一次次看起来无害的小例外 —— 差半像素、临时大一号、这个标签特殊。
 * 攒够三五个，界面上就有两套层级了，而任何一条运行时闸门都不会红。
 *
 * 这道闸门把「例外」本身变成红灯。
 *
 * ## 检查五组
 *
 *   A 字号任意值        text-[13.5px]
 *   B 未映射的档位      text-xl / text-2xl / text-3xl …（tailwind.config 没接令牌的那些）
 *   C 颜色任意值        bg-[#3a3a3a] / text-[#fff] / border-[#000]
 *   D 内联字号裸数字    fontSize: 12（白名单见下）
 *   E 令牌接线          index.css 八档齐全 + 每档都被 tailwind.config 引用 + 值没被偷改
 *
 * E 是反向保护：前四组防「绕过令牌」，E 防「令牌本身被改散」。
 * 改任何一档字号都必须同时改这里 —— 强迫改的人说明为什么八档不够用。
 *
 * ## 白名单为什么是这几个
 *
 * 白名单只收「值必须是数字、且数字由尺寸算出来」的地方：
 *   · AgentAvatar / UserAvatar —— 头像里文字按头像直径缩放（Math.round(size*0.42)），
 *     不是排版层级，套令牌会让大头像的字比小头像还小；
 *   · WorkspaceTerminal —— xterm 的 `fontSize` 选项只接受 number，
 *     传 'var(--text-body)' 会被它当成 NaN 静默吞掉。
 *
 * 白名单是**文件级**的，不是行级 —— 行级白名单等于给自己留后门。
 *
 * 运行：node scripts/verify-uiux-tokens.mjs
 *      node scripts/verify-uiux-tokens.mjs --dump    # 列出全部命中（含白名单放行的）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const DUMP = process.argv.includes('--dump');

const failures = [];
let total = 0;

function ok(cond, label, detail) {
  total++;
  if (!cond) failures.push(detail ? `${label}\n      ${detail}` : label);
  return cond;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 注释不参与审计 —— 文档里举例说明「不要写 text-[15px]」不该被判违规。
 *
 * 为什么不能按行首判断：JSX 的 `{/* … *\/}` 是**跨行**的，
 * 续行不以 `*` 开头（`{/* 标题栏统一…` 换行后是 `  此前这里写 text-2xl…`），
 * 按行首判断会把这种说明文字当成违规。所以先把注释整体抹成等长空白
 * （保留换行），再逐行扫 —— 行号与列位置都不变，报错定位仍然准确。
 */
function blankComments(src) {
  return src
    // 块注释（含 JSX 的 {/* … *\/}，因为里面也含 /* … *\/）
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    // 行注释。`[^:]` 排除 `https://` 里的 `//`
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// ── 白名单：文件 → 允许的规则集 ──────────────────────────────────────
const WHITELIST = new Map([
  ['AgentAvatar.tsx', new Set(['D'])],
  ['UserAvatar.tsx', new Set(['D'])],
  ['WorkspaceTerminal.tsx', new Set(['D'])],
]);

const RULES = [
  {
    id: 'A',
    re: /\btext-\[[0-9.]+px\]/g,
    label: '字号任意值',
    hint: '改用 text-caption / text-secondary / text-body / text-body-lg / text-title / text-title-lg / text-page / text-display',
  },
  {
    id: 'B',
    // tailwind.config.js 只把 xs/sm/base/lg 接到了令牌；xl 以上仍是 Tailwind 默认值
    // （xl=20、2xl=24…），写它们等于绕过整套字号体系。
    re: /\btext-(?:xl|[2-9]xl)\b/g,
    label: '未接入令牌的字号档位',
    hint: 'xl 及以上没有映射到 --text-*，改用 text-page(17) 或 text-display(22)',
  },
  {
    id: 'C',
    re: /\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration)-\[#[0-9a-fA-F]{3,8}\]/g,
    label: '颜色任意值',
    hint: '改用 var(--tc-*) / var(--td-*) 令牌；身份色（头像）走 style 而不是 Tailwind 类',
  },
  {
    id: 'D',
    re: /fontSize:\s*[0-9]+\b/g,
    label: '内联字号裸数字',
    hint: "改用 var(--text-*)；xterm / 头像这类必须是数字的见文件白名单",
  },
];

// ── A/B/C/D：逐文件扫描 ─────────────────────────────────────────────
const files = walk(SRC);
const hits = [];

for (const file of files) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const base = path.basename(file);
  const allowed = WHITELIST.get(base) ?? new Set();
  const lines = blankComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/);

  lines.forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const hit = { rule, rel, line: i + 1, text: m[0], snippet: line.trim().slice(0, 120) };
        hits.push(hit);
        if (!allowed.has(rule.id)) {
          failures.push(`${rel}:${i + 1}  ${rule.label}「${m[0]}」\n      ${rule.hint}`);
        }
      }
    }
  });
}

// 规则本身的自证：每条规则都要能在夹具上命中，否则「0 处命中」可能只是正则写错了。
const FIXTURES = [
  ['A', 'className="text-[13.5px]"'],
  ['B', 'className="text-2xl font-semibold"'],
  ['C', 'className="bg-[#3a3a3a] p-2"'],
  ['D', 'style={{ fontSize: 12 }}'],
];
for (const [id, sample] of FIXTURES) {
  const rule = RULES.find(r => r.id === id);
  rule.re.lastIndex = 0;
  ok(rule.re.test(sample), `[自检] 规则 ${id} 能命中夹具「${sample}」`, '正则写错了，下面的 0 处命中不可信');
}

// 反向自检：正常写法不该被误伤。
const CLEAN = ['className="text-body"', 'className="text-secondary"', 'className="rounded-lg"', 'className="bg-white"'];
for (const sample of CLEAN) {
  const bad = RULES.filter(r => {
    r.re.lastIndex = 0;
    return r.re.test(sample);
  });
  ok(bad.length === 0, `[自检] 合规写法「${sample}」不该被误伤`, `被规则 ${bad.map(b => b.id).join(',')} 命中`);
}

const violations = hits.filter(h => !(WHITELIST.get(path.basename(h.rel)) ?? new Set()).has(h.rule.id));
ok(violations.length === 0, `源码里没有绕过令牌的写法（扫了 ${files.length} 个文件）`,
  violations.length ? `共 ${violations.length} 处` : undefined);

// ── E：令牌接线 ─────────────────────────────────────────────────────
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
const tw = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf8');

const EXPECTED = {
  'caption': 11,
  'secondary': 12,
  'body': 13,
  'body-lg': 14,
  'title': 15,
  'title-lg': 16,
  'page': 17,
  'display': 22,
};

const declared = new Map();
for (const m of css.matchAll(/--text-([a-z-]+):\s*([0-9.]+)px/g)) {
  declared.set(m[1], Number(m[2]));
}

for (const [name, px] of Object.entries(EXPECTED)) {
  ok(declared.has(name), `index.css 定义了 --text-${name}`, '缺档');
  if (declared.has(name)) {
    ok(declared.get(name) === px, `--text-${name} = ${px}px（没被偷改）`, `实际 ${declared.get(name)}px`);
  }
}

const mapped = new Set();
for (const m of tw.matchAll(/'([a-z-]+)':\s*\['var\(--text-([a-z-]+)\)'/g)) {
  mapped.add(m[2]);
}
for (const name of Object.keys(EXPECTED)) {
  ok(mapped.has(name), `tailwind.config 的 fontSize 引用了 --text-${name}`, '令牌存在但没有任何 Tailwind 类指向它（死令牌）');
}

// fontSize 块里不许出现字面量 px —— 一旦有人写 'huge': ['19px']，整套映射就漏了。
const fontSizeBlock = tw.slice(tw.indexOf('fontSize:'), tw.indexOf('spacing:'));
const literalPx = [...fontSizeBlock.matchAll(/\[[^,\]]*?([0-9.]+px)/g)].map(m => m[0]);
ok(literalPx.length === 0, 'tailwind.config 的 fontSize 块里没有字面量 px', literalPx.join(' | '));

// ── 输出 ────────────────────────────────────────────────────────────
if (DUMP) {
  console.log(`\n命中明细（含白名单放行，共 ${hits.length} 处）：`);
  if (hits.length === 0) console.log('  （无）');
  for (const h of hits) {
    const base = path.basename(h.rel);
    const passed = (WHITELIST.get(base) ?? new Set()).has(h.rule.id);
    console.log(`  ${passed ? '⊘ 白名单' : '✗ 违规'}  ${h.rel}:${h.line}  [${h.rule.id}] ${h.text}`);
    console.log(`           ${h.snippet}`);
  }
  console.log('');
}

console.log(`\n设计系统写法审计：${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✓ 全部通过\n');
