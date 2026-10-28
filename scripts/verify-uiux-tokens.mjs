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

// ── F：状态词色阶（A134）─────────────────────────────────────────────
/**
 * 状态词是 11px 小字，靠「文字 + 颜色」两条线索。颜色若不到 4.5:1，
 * 等于把两条线索都削弱了 —— 而这类失败在任何运行时闸门里都不会红
 * （没人会去量一个 11px 灰字的对比度）。所以在这里从令牌值直接算。
 *
 * 背景取 `--tc-surface-chrome`（通讯录列表所在的面），**从 CSS 里读**，
 * 不写死 #f5f5f5 —— 表面色改了这条断言跟着走，不会变成一条过期的绿。
 */
const relLum = hex => {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = [n >> 16 & 255, n >> 8 & 255, n & 255].map(c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (a, b) => {
  const x = relLum(a);
  const y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const STATUS_TOKENS = ['ok', 'warn', 'danger', 'muted'];
/** 每个令牌应当出现两次：`:root` 一次（浅色）、`:root.dark` 一次（深色） */
const statusDecl = new Map();
for (const m of css.matchAll(/--tc-status-([a-z]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
  if (!statusDecl.has(m[1])) statusDecl.set(m[1], []);
  statusDecl.get(m[1]).push(m[2]);
}
const chromeDecl = [...css.matchAll(/--tc-surface-chrome:\s*(#[0-9a-fA-F]{3,8})/g)].map(m => m[1]);

ok(chromeDecl.length >= 2, '--tc-surface-chrome 浅深两份都在（下面要拿它算对比度）', `找到 ${chromeDecl.length} 份`);

for (const name of STATUS_TOKENS) {
  const vals = statusDecl.get(name) ?? [];
  ok(vals.length === 2, `--tc-status-${name} 浅色与深色各定义一次`, `实际 ${vals.length} 次：${vals.join(',') || '无'}`);
}

if (chromeDecl.length >= 2) {
  STATUS_TOKENS.forEach((name, i) => {
    const vals = statusDecl.get(name) ?? [];
    if (vals.length < 2) return;
    for (const [theme, idx] of [['浅色', 0], ['深色', 1]]) {
      const ratio = contrast(vals[idx], chromeDecl[idx]);
      ok(
        ratio >= 4.5,
        `--tc-status-${name} ${theme}对 chrome 面 ≥4.5:1`,
        `${vals[idx]} on ${chromeDecl[idx]} = ${ratio.toFixed(2)}:1（11px 小字必须达标）`
      );
    }
  });
}

// 状态词必须走令牌：裸 hex 在深色下必挂一条（实测 ready #0E7A5F 只有 3.25:1）
const typesSrc = fs.readFileSync(path.join(SRC, 'types.ts'), 'utf8');
const availBlock = typesSrc.slice(typesSrc.indexOf('AVAILABILITY_META'), typesSrc.indexOf('availabilityLabelOf'));
ok(
  !/color:\s*'#/.test(availBlock),
  'AVAILABILITY_META 的 color 全部走 --tc-status-* 令牌',
  '出现裸 hex：深色主题下会不达标，且改主题时没人会想起来改这里'
);
ok(/color:\s*'var\(--tc-status-/.test(availBlock), 'AVAILABILITY_META 确实引用了 --tc-status-*', '一个都没引用');

// 每一行都要有状态词，不许只写异常行（审查报告 P0-3 的原话：
// 「三个 Agent 只有绿点，没有任何文字」）
const contactsSrc = fs.readFileSync(path.join(SRC, 'components', 'ContactsPanel.tsx'), 'utf8');
ok(
  !/availability !== 'ready'/.test(contactsSrc),
  '通讯录每一行都渲染状态词（不再只写非 ready 行）',
  '又出现了 `availability !== \'ready\'` 的判断 —— 那就退回「两种表达方式并存」'
);
ok(/data-agent-status=/.test(contactsSrc), '状态词带 data-agent-status 锚点（运行时按状态定位）', '缺锚点');

// ── G：可滚动内容区的「还有更多」信号（A134）──────────────────────────
/**
 * 这一节的由来：Windows 的 Chrome 用 overlay 滚动条，静止时不画。获取 Agent
 * 弹窗的内容 890px 装进 712px 的容器，用户看到的不是「可以往下滚」，而是
 * 第 4 组的分组标题被硬切在 16.73/34px 处 —— 读起来像渲染坏了。
 *
 * 三条不许退化的点：
 *   ① 渐隐只在真的溢出时挂（`[data-fade='1']`）—— 装得下时把最后一行淡掉，
 *      等于在没有更多的地方说「还有更多」，是另一种假话；
 *   ② `padding-bottom` 与渐隐同高，且**引用同一个变量** —— 分开写死两处，
 *      改一处就会留下「滚到底时最后一张卡永远半虚」；
 *   ③ 用 mask 而不是盖一层渐变 div —— 弹窗是半透明玻璃面，渐变层要跟它
 *      配平颜色（浅色/深色/玻璃态各一套），mask 只需要把自己淡成透明。
 */
const fadeRule = css.slice(css.indexOf(".tc-scroll-fade[data-fade='1']"));
const fadeBlock = fadeRule.slice(0, fadeRule.indexOf('}'));
/**
 * 按 `;` 切成一条条声明再逐条看。
 *
 * **不能**在整块文本上跑 `/mask-image:.*var\(--tc-fade-h\)/` ——
 * `-webkit-mask-image` 里也含 `mask-image:` 这个子串，只要前缀那条是对的，
 * 标准那条写死成别的值也照样绿。而 Chromium 里**后写的标准属性赢**，
 * 于是「闸门绿、界面却不是你以为的那样」。（本闸门第一版就是这样，
 * 反向探针当场抓出来的。）
 */
const fadeDecls = fadeBlock
  .split(';')
  .map(d => d.trim())
  .filter(Boolean);
const maskDecls = fadeDecls.filter(d => /(^|-)mask-image\s*:/.test(d));
ok(fadeRule.startsWith(".tc-scroll-fade[data-fade='1']"), '存在 .tc-scroll-fade 的溢出态规则', '没找到选择器');
ok(/--tc-fade-h:\s*\d+px/.test(fadeBlock), '渐隐高度是一个变量（--tc-fade-h）', '写死了数字就没人能同步改');
ok(
  /padding-bottom:\s*var\(--tc-fade-h\)/.test(fadeBlock),
  'padding-bottom 引用同一个变量（滚到底时淡掉的是留白，不是内容）',
  '写死成别的值 = 列表末尾永远半虚'
);
ok(maskDecls.length === 2, '两条 mask 声明都在（-webkit- 前缀 + 标准）', `实际 ${maskDecls.length} 条：${maskDecls.join(' | ')}`);
ok(
  maskDecls.length === 2 && maskDecls.every(d => /var\(--tc-fade-h\)/.test(d)),
  '两条 mask 都引用同一个变量',
  '只改一条 = 闸门绿但浏览器用另一条，等于没改'
);
ok(
  !/background[^:]*:\s*linear-gradient/.test(fadeBlock),
  '用 mask 淡出，不盖渐变层',
  '玻璃面上盖不透明渐变层，深色/玻璃态会露馅'
);

const dialogSrc = fs.readFileSync(path.join(SRC, 'components', 'GetAgentsDialog.tsx'), 'utf8');
ok(/useOverflowY/.test(dialogSrc), '获取 Agent 弹窗接了 useOverflowY（真的判断有没有溢出）', '没接 = 遮罩要么不出现要么乱出现');
ok(
  /className="tc-scroll-fade[^"]*overflow-y-auto"/.test(dialogSrc),
  '滚动区挂了 tc-scroll-fade',
  '类没挂上，规则再对也不生效'
);
ok(/data-fade=\{overflowing \? '1' : undefined\}/.test(dialogSrc), '滚动区按溢出状态挂 data-fade', '缺这条，渐隐永远不开');

const traceSrc = fs.readFileSync(path.join(SRC, 'components', 'AgentTrace.tsx'), 'utf8');
ok(
  /className="tc-trace-scroll tc-scroll-fade"/.test(traceSrc),
  '轨迹滚动区复用同一个 tc-scroll-fade（不是第二套写法）',
  '各写一套 = 用户说的「每改一个页面就出现一套新样式」'
);

// 清单页里不许再逐张卡画「重新检测」：它是全局动作（全量 probe），
// 画在每张卡上等于伪装成行级动作，且底栏那颗常驻可见、不需要第二入口。
const installSrc = fs.readFileSync(path.join(SRC, 'components', 'InstallCard.tsx'), 'utf8');
ok(
  /const canReprobe = !!onReprobe && !bare;/.test(installSrc),
  '清单页（bare）不再逐张卡画「重新检测」',
  '同一个全局动作在一屏里出现 5 次，主次被稀释'
);
ok(/const hasActions = canCopy \|\| canOpen \|\| canFillKey \|\| canReprobe;/.test(installSrc), '按钮整行按 hasActions 决定渲不渲染（不留空白行）', '会留下 12px 的幽灵间距');

// ── F：控件尺寸的两套写法（A137 棘轮）──────────────────────────────
/**
 * 为什么要有这一组
 *
 * A124 定了「动作按钮 32 / 内边距 15 / 字号 14」，但那条规范只写在
 * `.tc-btn-brand` / `.tc-btn-secondary` 两个选择器上 —— **没有一条规则作用在
 * `.t-button` 上**。于是全仓实际是两套写法：
 *
 *   · 走令牌 `.tc-btn-*`  16 处 → 几何被 `--tc-btn-height` 强制
 *   · 裸 `<Button>`       46 处 → 几何由 TDesign 的 `size` 决定（默认 32 / small 24）
 *
 * 「全站按钮统一 32」这句话，实际只覆盖 16/62。同理 `.t-input` 根本没定 height，
 * 所以输入框 24 与 32 混用不是「违规」而是「没规定」（同一页里登录配置的 Input
 * 是 24、模型清单的是 32）。
 *
 * 这一组**不判对错，只做棘轮**：把当前数冻成基线，只许减不许增。
 *
 * ⚠️ 基线**不是「待清零的欠账」**。收口三轮之后剩下的 18/1/0 已经全是
 * 「说得清为什么是 24」的地方（清单见 DESIGN-SYSTEM §4「刻意 24 档」）：
 *   · 列表行内动作（圆形图标 / 行尾文字按钮）—— 比行高还高会撑开每一行
 *   · 密集列表工具条、预设芯片、chip 输入框及其伴生键
 *   · `.tc-permission-option` 审批选项 —— 设计常量 24 高 / 12px 字号，
 *     由 `verify-a128-permission-ui` 逐项量着
 * 所以**不要为了把数字压到 0 而去动它们**；目标是「每一处都有理由」。
 *
 * 为什么不干脆一次全改成 32：`a124` 只能量到夹具开出来的那几个弹窗，
 * 改 28 处里大部分**闸门看不见**。大批量改动 + 极低验证覆盖是最差的组合，
 * 所以按文件分批，而这道棘轮保证「不再变多」。
 *
 * Tag / Loading 不计入：Tag 是标签不是控件（24px 合理），Loading 的 size
 * 控制转圈直径，与控件几何无关。
 */
const SIZE_BASELINE = { Button: 18, Input: 1, Select: 0 };
/**
 * 基线变更记录（只许往下调）：
 *   28 / 9 / 2  ← 2026-10-28 A137 首次冻结
 *   27 / 6 / 1  ← 同批收口 ProviderSettings：表单字段 4 处升 32
 *                 （名称 / 上游格式 / 地址 / Key），「添加厂商」主入口升 32；
 *                 列表行内编辑删除、工具条（拉取/全选/清空）、预设芯片、
 *                 手动模型名的 chip 输入框**刻意留 24**，见 DESIGN-SYSTEM §4。
 *   23 / 3 / 0  ← 第二批 SettingsPage 登录配置：3 个 Input + 1 个 Select 升 32
 *                 （它们就是 DESIGN-SYSTEM §4 点名的反例）；
 *                 「保存/取消」跟着输入框升 32（同一行不许混档）；
 *                 「配置环境变量」与「创建 Agent」是分区级入口、A37 明写同规格，
 *                 一起升 32；列表行内圆形「编辑/删除」留 24。
 *                 Select 归零 —— 之后任何新 Select 加 small 都是红灯。
 *   18 / 1 / 0  ← 第三批「逐处定性」：AgentCredentialSettings 展开区的
 *                 2 Input + 保存/清除 升 32（与登录配置表单同形态）、
 *                 ModelCatalogSettings 的「刷新模型清单」升 32（分区级动作）、
 *                 MemoryPanel 编辑器提交档「取消/保存技能」升 32。
 *                 **到此剩下的全是登记在案的 24 档**，不是欠账。
 */
const sizeSmall = { Button: 0, Input: 0, Select: 0 };
const sizeSmallByFile = new Map();

for (const file of files) {
  if (!/\.tsx$/.test(file)) continue;
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const lines = blankComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/size="small"/.test(line)) return;
    // 向上找最近的开标签：JSX 里 `size` 与组件名常常隔好几行
    let kind = null;
    for (let k = i; k >= Math.max(0, i - 8); k--) {
      const m = lines[k].match(/<(Button|Input|Select|Tag|Loading|Link|Textarea)\b/);
      if (m) {
        kind = m[1];
        break;
      }
    }
    if (!kind || !(kind in sizeSmall)) return;
    sizeSmall[kind]++;
    const key = `${kind} @ ${rel}`;
    sizeSmallByFile.set(key, (sizeSmallByFile.get(key) ?? 0) + 1);
  });
}

for (const [kind, base] of Object.entries(SIZE_BASELINE)) {
  const now = sizeSmall[kind];
  /**
   * 变多时把分布一起打出来。
   *
   * 只报「多了 1 处」的话，得自己去翻 8 个文件找是哪一处 —— 上一轮我就是在
   * 这一步靠 `--dump` 反复来回。按 kind 过滤一下就有了。
   */
  const byFile =
    now > base
      ? [...sizeSmallByFile.entries()]
          .filter(([k]) => k.startsWith(`${kind} @ `))
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k.slice(kind.length + 3)}×${n}`)
          .join(' · ')
      : '';
  ok(
    now <= base,
    `[F] 裸 <${kind} size="small"> 只许减不许增（基线 ${base}，当前 ${now}）`,
    now > base
      ? `多了 ${now - base} 处 —— 新控件请走 .tc-btn-* 或默认尺寸，别加第三套；` +
        `现分布：${byFile}`
      : now < base
        ? `已降到 ${now}，可以把 SIZE_BASELINE 下调到 ${now}`
        : undefined
  );
}

if (DUMP) {
  console.log('\nsize="small" 欠账分布（Button / Input / Select）：');
  const rows = [...sizeSmallByFile.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) console.log('  （无）');
  for (const [k, v] of rows) console.log(`  ${String(v).padStart(2)}  ${k}`);
  console.log('');
}

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
