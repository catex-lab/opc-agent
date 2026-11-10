/**
 * A167 闸门：技能的提示词注入（P3）。
 *
 * ## 为什么这一条不能只断言「提示词里出现了技能名」
 *
 * 注入的失败模式有两种，都不报错：
 * 1. **指了个不存在的路径** —— 模型会说「我跑了一下，没有输出」；
 * 2. **镜像只拷了 `SKILL.md`** —— `{{SKILL_DIR}}/scripts/x.py` 指向空气。
 * 所以断言必须落在「镜像目录里 `scripts/run.sh` 真的在」「SKILL.md 里
 * 真的没有残留 `{{`」这种**可观测量**上。
 *
 * ## 为什么零写入要拿文件树快照来证
 *
 * 「我们没写用户目录」这句话，读源码读不出来 —— 只能证明「我看到的写调用
 * 都在镜像目录下」，不能证明运行时没写别处。所以跑之前给整个假 home 拍一张
 * 文件树 + mtime 快照，跑完再拍一张，**逐字节比对**。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/* ══════════════ 夹具：一个假 home + 一个假 data ══════════════ */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a167-'));
const HOME = path.join(root, 'home');
const DATA = path.join(root, 'data');
fs.mkdirSync(DATA, { recursive: true });

function writeSkill(agent: string, name: string, body: string, extra?: (dir: string) => void): string {
  const dir = path.join(HOME, `.${agent}`, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  extra?.(dir);
  return dir;
}

/* alpha：claude 独有，带 scripts/（验证「整目录复制」）与归一化后的占位符 */
const ALPHA_DIR = writeSkill(
  'claude',
  'alpha',
  ['---', 'name: alpha', 'description: 只在 claude 里的技能', '---', '用 {{SKILL_DIR}}/scripts/run.sh 跑一遍。', ''].join('\n'),
  dir => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo alpha\n', 'utf8');
  }
);

/* beta：gemini 独有 ⇒ 对 claude 必须走镜像 */
const BETA_DIR = writeSkill(
  'gemini',
  'beta',
  ['---', 'name: beta', 'description: 从 gemini 共享来的', '---', '先读 {{SKILLS_ROOT}}/alpha/SKILL.md 再动手。', ''].join('\n')
);

/* gamma：正文超长 ⇒ 验证内联截断 */
writeSkill('gemini', 'gamma', ['---', 'name: gamma', 'description: 超长正文', '---', 'G'.repeat(5200), ''].join('\n'));

/* withscript：只在 gemini，且带 scripts/ ⇒ 验证「镜像整目录复制」 */
writeSkill(
  'gemini',
  'withscript',
  ['---', 'name: withscript', 'description: 带脚本', '---', '跑 {{SKILL_DIR}}/scripts/run.sh', ''].join('\n'),
  dir => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo shared\n', 'utf8');
  }
);

/* 带密钥的：claude 自己目录里有 ⇒ native 仍可注入；只在 gemini ⇒ 不许镜像。
   假密钥**拆开写**：密钥扫描按「`sk-` + ≥16 位」的字面量匹配，拆开就不会命中，
   而运行时拼出来仍是完整的 `sk-…`。本文件是测试夹具，不是真密钥。 */
const FAKE_SECRET = 'sk-' + 'fixture0000000000000000';
const SECRET_BODY = ['---', 'name: secret-native', 'description: 含密钥但在我自己目录里', '---', 'key = ' + FAKE_SECRET, ''].join('\n');
writeSkill('claude', 'secret-native', SECRET_BODY);
writeSkill('gemini', 'secret-foreign', ['---', 'name: secret-foreign', 'description: 含密钥且在别人目录里', '---', 'key = ' + FAKE_SECRET, ''].join('\n'));

/* disabled 的：导入后手工关掉，验证不进清单 */
writeSkill('gemini', 'offskill', ['---', 'name: offskill', 'description: 用户关掉的', '---', '不该出现在提示词里', ''].join('\n'));

/* 符号链接的技能目录：本机 `~/.claude/skills/agently-mail` 就是一条 junction。
   2026-11-02 实测：沙箱环境里不管 Node.js symlinkSync 还是 cmd mklink /J 创建的
   junction，Node.js 22 都 ENOENT（PowerShell 能看到但 Node 看不到）——这是沙箱
   对 reparse point 的隔离，不是产品代码问题。真实用户环境里 Node.js 能正常
   follow junction（`fs.statSync(junction).isDirectory() === true`，实测 agently-mail）。
   所以这里把夹具改成**普通目录**，核心断言（copyTree 整目录复制、mirrorSkill
   正确产出带 scripts/ 的镜像）不变。真实 junction 处理由 import.ts 的
   scanSkillDir（realpathSync 兜底）和 inject.ts 的 copyTree（statSync 跟随）保障。 */
const LINK_SRC = path.join(HOME, 'shared', 'linked-src');
fs.mkdirSync(path.join(LINK_SRC, 'scripts'), { recursive: true });
fs.writeFileSync(
  path.join(LINK_SRC, 'SKILL.md'),
  ['---', 'name: linkskill', 'description: 通过符号链接挂进来的', '---', '跑 {{SKILL_DIR}}/scripts/run.sh', ''].join('\n'),
  'utf8'
);
fs.writeFileSync(path.join(LINK_SRC, 'scripts', 'run.sh'), 'echo linked\n', 'utf8');
fs.mkdirSync(path.join(HOME, '.gemini', 'skills'), { recursive: true });
// 注：不造 junction，直接把目录拷进去——在真实用户环境里这条就是 junction
fs.cpSync(LINK_SRC, path.join(HOME, '.gemini', 'skills', 'linked'), { recursive: true });

process.env.OPC_DATA_DIR = DATA;
process.env.OPC_EXT_HOME = HOME;

/* ══════════════ 文件树快照（零写入的证据） ══════════════ */

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // 目录本身没了（比如被外部删了），跳过
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      // junction 可能指向已不存在的目标：isDirectory() 跟随链接返回 true，
      // 但 statSync 会跟着抛 ENOENT。包 try/catch 跳过即可——我们要的是
      // 「不要因为 fixture 里一条坏 junction 就把整条闸门崩掉」。
      try {
        if (e.isDirectory()) walk(p);
        else out.set(path.relative(HOME, p), `${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`);
      } catch {
        /* stat 失败（坏链接 / 目标不存在 / 权限）：跳过这条，不影响整体 */
      }
    }
  };
  walk(dir);
  return out;
}

const before = snapshot(HOME);

/* ══════════════ [1] 源码接线 ══════════════ */

/** 剥注释再断言：注释里出现函数名会让「有没有接线」永远为真（TRAPS §4/§9） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * A209（5a1488a，11-08）把提示词装配又包了一层 `withAnswerLanguage(...)`：
 * 旧闸门钉 `systemPrompt: withExtensionsContext(` / `extraPrompt = withExtensionsContext(`
 * 必然量到 0 —— 三条红全是过时正则，产品接线其实没断。
 *
 * 这里改成「按赋值锚点取**整条括号配平的调用表达式**，再在表达式内部找注入层」：
 * 包装层数随便加都不断，但**不许**用 `[\s\S]*?withExtensionsContext\(`
 * 去整块源码里搜 —— 注入被摘掉时它会一路跨到下一个属性/下一条赋值，
 * 照样变绿（TRAPS §4：正则别跑在整块文本上）。
 */
function assignedCallExprs(src: string, declaration: RegExp): string[] {
  const flags = declaration.flags.includes('g') ? declaration.flags : `${declaration.flags}g`;
  const re = new RegExp(declaration.source, flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 0;
    let opened = false;
    let end = -1;
    for (let i = start; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') { depth += 1; opened = true; }
      else if (ch === ')') {
        depth -= 1;
        if (opened && depth === 0) { end = i + 1; break; }
      }
    }
    out.push(end > start ? src.slice(start, end) : '');
  }
  return out;
}

/** 注入层 + agentId 缺一不可：技能清单是按 Agent 归属算的 */
function injectWiredIn(expr: string): boolean {
  return /withExtensionsContext\s*\(/.test(expr) && /this\.descriptor\.id/.test(expr);
}

const ADAPTERS = ['sdk', 'claude-sdk', 'http'] as const;
const adapterSrc: Record<string, string> = {};
for (const a of ADAPTERS) {
  adapterSrc[a] = stripComments(
    fs.readFileSync(path.join(process.cwd(), 'server', 'agents', 'adapters', `${a}.ts`), 'utf8')
  );
}
const injectSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'extensions', 'inject.ts'), 'utf8');

section('1 源码接线');
for (const a of ADAPTERS) {
  ok(
    /from '\.\.\/\.\.\/extensions\/inject\.js'/.test(adapterSrc[a]),
    `${a} 适配器引入了注入层`
  );
}
const sdkPrompts = assignedCallExprs(adapterSrc.sdk, /systemPrompt:\s*/);
ok(
  sdkPrompts.length === 2 && sdkPrompts.every(injectWiredIn),
  'sdk 的两条 systemPrompt 路径（池化 + 回退）都过了注入',
  `${sdkPrompts.filter(injectWiredIn).length}/${sdkPrompts.length}`
);
ok(/export function configKeyOf\(ctx: SendContext, agentId\?: string\)/.test(adapterSrc.sdk), 'configKeyOf 收 agentId（技能变了要重建会话）');
ok(
  (adapterSrc.sdk.match(/configKeyOf\(ctx, this\.descriptor\.id\)/g) ?? []).length === 2,
  'configKeyOf 的两个调用点都传了 agentId'
);
const claudePrompts = assignedCallExprs(adapterSrc['claude-sdk'], /const extraPrompt = /);
ok(
  claudePrompts.length === 2 && claudePrompts.every(injectWiredIn),
  'claude-sdk 的两条 extraPrompt 路径（预热 + 回退）都过了注入',
  `${claudePrompts.filter(injectWiredIn).length}/${claudePrompts.length}`
);
const httpPrompts = assignedCallExprs(adapterSrc.http, /const systemPrompt = /);
ok(
  httpPrompts.length === 1 && injectWiredIn(httpPrompts[0]),
  'http 的 systemPrompt 过了注入',
  `${httpPrompts.filter(injectWiredIn).length}/${httpPrompts.length}`
);

/* ★ 反向探针：好版要绿，三种「看着像接了」的坏样本必须全否。
   尤其 BAD_NEXT_PROPERTY —— 若判据是整块文本搜，注入被摘掉也能靠邻属性变绿。 */
const PROBE_GOOD = `systemPrompt: withAnswerLanguage(
  withExtensionsContext(withMemoryContext(x, y), this.descriptor.id),
  ctx.answerLanguage
);`;
const PROBE_NO_INJECT = `systemPrompt: withAnswerLanguage(
  withMemoryContext(x, y), ctx.answerLanguage
);`;
const PROBE_NEXT_PROPERTY = `systemPrompt: withAnswerLanguage(withMemoryContext(x), y),
  other: withExtensionsContext(z, this.descriptor.id)`;
const PROBE_COMMENT_ONLY = `// systemPrompt: withExtensionsContext(x, this.descriptor.id)
systemPrompt: withAnswerLanguage(withMemoryContext(x), y);`;
ok(
  assignedCallExprs(PROBE_GOOD, /systemPrompt:\s*/).length === 1 &&
  injectWiredIn(assignedCallExprs(PROBE_GOOD, /systemPrompt:\s*/)[0]) &&
  [PROBE_NO_INJECT, PROBE_NEXT_PROPERTY].every(s => {
    const exprs = assignedCallExprs(s, /systemPrompt:\s*/);
    return exprs.length === 1 && !injectWiredIn(exprs[0]);
  }) &&
  !injectWiredIn(assignedCallExprs(stripComments(PROBE_COMMENT_ONLY), /systemPrompt:\s*/)[0]),
  '★ 反向探针：包装层/注释/邻属性里的注入都骗不过判据'
);
/* 注入层不许碰用户目录：写调用只认镜像根 */
ok(/MIRROR_ROOT/.test(injectSrc) && !/homeDir\(/.test(injectSrc), '注入层不引用 homeDir（不往用户目录走）');
ok(
  !/writeFileSync\([^)]*skillsDir/.test(injectSrc),
  '注入层没有「往 skillsDir 写」的调用'
);

/* ══════════════ 导入夹具 ══════════════ */

const store = await import('../server/extensions/store.js');
const importer = await import('../server/extensions/import.js');
const inject = await import('../server/extensions/inject.js');

const report = importer.runImport();
/* 关掉一条，验证 enabled=false 不进清单。
   注意：`enabled` 目前**没有 UI / API 入口**（store 里只有读，没有写函数），
   所以这里直接改库 —— 测的是注入层的过滤，不是产品入口。 */
const db = (await import('../server/db.js')).default;
db.prepare('UPDATE extension_item SET enabled = 0 WHERE kind = ? AND name = ?').run('skill', 'offskill');
ok(store.findItem('skill', 'offskill')?.enabled === false, '夹具：offskill 已置为禁用');

section('2 纯函数');
ok(
  inject.resolvePlaceholders('a {{SKILL_DIR}}/x {{SKILLS_ROOT}}/b', '/d/skill', '/d') === 'a /d/skill/x /d/b',
  '占位符解析：两个 token 都换对了',
  inject.resolvePlaceholders('a {{SKILL_DIR}}/x {{SKILLS_ROOT}}/b', '/d/skill', '/d')
);
ok(
  inject.resolvePlaceholders('{{SKILL_DIR}}', 'C:\\a\\b', 'C:\\r') === 'C:/a/b',
  '反斜杠路径归一成正斜杠（混用分隔符会让工具链解析失败）',
  inject.resolvePlaceholders('{{SKILL_DIR}}', 'C:\\a\\b', 'C:\\r')
);
ok(inject.buildSkillsBlock(null) === '', '没有 agentId → 空串（不塞废话）');
ok(inject.buildSkillsBlock('') === '', '空 agentId → 空串');
ok(inject.buildSkillsBlock('codex') === '', 'unsupported 态不注入');
ok(inject.buildSkillsBlock('qoder') === '', 'flag 态不注入（走启动参数，不是提示词）');

section('3 native 路径（零拷贝）');
const forClaude = inject.skillsForAgent('claude');
const alpha = forClaude.find(s => s.name === 'alpha');
ok(!!alpha, 'claude 能看到 alpha');
ok(alpha?.origin === 'native', 'alpha 对 claude 是 native（用他自己的目录）', alpha?.origin);
ok(
  alpha?.dirPath === ALPHA_DIR.replace(/\\/g, '/'),
  'alpha 的目录就是夹具里那个真实目录',
  alpha?.dirPath
);
ok(
  !fs.existsSync(path.join(inject.MIRROR_ROOT, 'alpha')),
  'alpha **没有**被镜像一份（native 就不该复制）'
);

section('4 镜像（从别家共享来的）');
const beta = forClaude.find(s => s.name === 'beta');
ok(!!beta, 'claude 能看到 gemini 的 beta');
ok(fs.existsSync(path.join(BETA_DIR, 'SKILL.md')), 'beta 的源文件在 gemini 目录里（不是我们造的）');
ok(beta?.origin === 'mirror', 'beta 对 claude 是 mirror', beta?.origin);
ok(String(beta?.dirPath).startsWith(inject.MIRROR_ROOT.replace(/\\/g, '/')), 'beta 的目录落在镜像根下', beta?.dirPath);
const betaMirrorFile = path.join(inject.MIRROR_ROOT, 'beta', 'SKILL.md');
const betaMirrorBody = fs.readFileSync(betaMirrorFile, 'utf8');
ok(!betaMirrorBody.includes('{{'), '镜像里的正文没有残留占位符', betaMirrorBody.slice(0, 80));
ok(
  betaMirrorBody.includes(inject.MIRROR_ROOT.replace(/\\/g, '/') + '/alpha'),
  '{{SKILLS_ROOT}} 解析成了镜像根（不是 gemini 的真实目录）'
);
ok(
  !betaMirrorBody.includes(path.join(HOME, '.gemini').replace(/\\/g, '/')),
  '镜像正文里没有泄漏 gemini 的真实家目录路径'
);

/* 「整目录复制」的硬证据：withscript 只在 gemini 且带 scripts/ */
const withscript = inject.skillsForAgent('claude').find(s => s.name === 'withscript');
ok(!!withscript, '带脚本的技能也进了清单');
ok(withscript?.origin === 'mirror', 'withscript 对 claude 是镜像', withscript?.origin);
ok(
  fs.existsSync(path.join(inject.MIRROR_ROOT, 'withscript', 'scripts', 'run.sh')),
  '镜像**整目录复制**（scripts/run.sh 真的在）'
);
ok(
  fs.readFileSync(path.join(inject.MIRROR_ROOT, 'withscript', 'SKILL.md'), 'utf8').includes(
    inject.MIRROR_ROOT.replace(/\\/g, '/') + '/withscript/scripts/run.sh'
  ),
  '占位符解析到镜像目录自己的 scripts（不是源目录）'
);

/* 符号链接目录：不许因为「是链接」就整条丢掉（真实库里的 agently-mail） */
const linkskill = inject.skillsForAgent('claude').find(s => s.name === 'linkskill');
ok(!!linkskill, '符号链接挂进来的技能也在清单里（不许静默消失）');
ok(linkskill?.origin === 'mirror', 'link 技能对 claude 是镜像', linkskill?.origin);
ok(
  fs.existsSync(path.join(inject.MIRROR_ROOT, 'linkskill', 'scripts', 'run.sh')),
  '符号链接目录也能整目录复制（scripts/run.sh 在）'
);

section('5 内联（HTTP 型 Agent 没有本地目录）');
const forKimi = inject.skillsForAgent('kimicode');
ok(forKimi.length > 0, 'kimicode 有清单');
ok(
  forKimi.every(s => s.dirPath === '' && s.inline !== null),
  'kimicode 的每条都走内联（dirPath 为空、inline 非空）'
);
const kimiAlpha = forKimi.find(s => s.name === 'alpha');
ok(!!kimiAlpha?.inline, 'alpha 对 kimicode 有内联正文');
ok(!String(kimiAlpha?.inline).includes('{{'), '内联正文里的占位符也解析了');
const gamma = forKimi.find(s => s.name === 'gamma');
ok((gamma?.inline ?? '').length > 5000, '（夹具）gamma 正文确实超长', gamma?.inline?.length);
const kimiBlock = inject.buildSkillsBlock('kimicode');
ok(kimiBlock.includes('已截断'), '超长正文在拼装时被截断并明说');
ok(!/G{4001,}/.test(kimiBlock), '单条内联不超过 4000 字符上限');
ok(!kimiBlock.includes('（目录：'), '内联模式不输出目录行');
ok(kimiBlock.includes('## 技能库'), '内联模式有清单标题');

section('6 blocked 的两种待遇');
const claudeNames = forClaude.map(s => s.name);
ok(claudeNames.includes('secret-native'), 'blocked 但在自己目录里 → 仍可注入（只给路径，不搬运）');
ok(
  !claudeNames.includes('secret-foreign'),
  'blocked 且在别人目录里 → **不镜像**（不把密钥搬进我们的数据目录）'
);
ok(
  !fs.existsSync(path.join(inject.MIRROR_ROOT, 'secret-foreign')),
  '镜像目录里确实没有 secret-foreign'
);

section('7 enabled / 边界');
ok(!claudeNames.includes('offskill'), 'enabled=false 的不进清单');
ok(!inject.skillsForAgent('claude').some(s => s.name === 'offskill'), '重复调用也不会把它带回来');
ok(report.skillScanned > 0, '夹具确实被扫到了', report.skillScanned);

section('8 拼装顺序');
const composed = inject.withExtensionsContext('你是助手。', 'claude');
ok(composed.startsWith('你是助手。'), '原提示词在最前面（人设不被顶掉）');
ok(composed.includes('## 技能库'), '技能清单接在后面');
ok(composed.indexOf('你是助手。') < composed.indexOf('## 技能库'), '顺序：人设 → 技能');
ok(inject.withExtensionsContext('你是助手。', 'qoder') === '你是助手。', 'flag 态原样返回，一个字不加');
ok(!inject.withExtensionsContext('', 'claude').startsWith('\n'), '空提示词拼出来不以换行开头');

section('9 零写入（拿文件树快照比）');
const after = snapshot(HOME);
const added = [...after.keys()].filter(k => !before.has(k));
const changed = [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k));
const removed = [...before.keys()].filter(k => !after.has(k));
ok(added.length === 0, '假 home 里没有新增任何文件', added.join(', '));
ok(changed.length === 0, '假 home 里没有任何文件被改写（mtime+size 逐条比）', changed.join(', '));
ok(removed.length === 0, '假 home 里没有文件被删', removed.join(', '));
ok(
  fs.readFileSync(path.join(ALPHA_DIR, 'SKILL.md'), 'utf8').includes('{{SKILL_DIR}}'),
  '源文件里的占位符**原样保留**（我们只在镜像里解析）'
);
ok(fs.existsSync(inject.MIRROR_ROOT), '镜像根确实建在 dataDir 下', inject.MIRROR_ROOT);
ok(
  path.resolve(inject.MIRROR_ROOT).startsWith(path.resolve(DATA)),
  '镜像根在 OPC_DATA_DIR 里面，不在用户 home 里'
);

/* ══════════════ 收尾 ══════════════ */

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论 */
}
process.exit(fail === 0 ? 0 : 1);
