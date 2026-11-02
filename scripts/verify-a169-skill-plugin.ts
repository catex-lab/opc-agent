/**
 * A169 闸门：OPC 共享技能的分发（P5-D）。
 *
 * ## 这一层守的是什么
 *
 * P5-D 把 OPC 库里「目标 Agent 自己没有的」技能拷进一个 plugin 壳，用
 * `--plugin-dir` 指给 qoder。真机已经验证过（`qodercli plugin validate` +
 * 一次 `-p` 会话里模型能列出 `opc-skill-plugin:shared-one`），但这个链路有
 * 三件**做错了也不报错**的事，必须由自动化闸门守住：
 *
 * 1. **必须真的可读**。之前用 junction，本机受限文件系统会让链接静默失效
 *    （`symlinkSync` 不报错、`lstat` 却 ENOENT），表现是技能在客户端里消失。
 *    现在改为拷贝，闸门直接读 `SKILL.md` 证明内容在。
 * 2. **必须幂等**。拷贝是每轮启动参数都要走的路径，不快照 mtime 就会每次重拷。
 * 3. **必须零写入**。壳只能建在 `data/extensions/` 下；全程不碰假主目录里的
 *    任何文件（末尾拿文件树快照证明）。
 *
 * ## 假环境
 *
 * `OPC_EXT_HOME` 指向自建假主目录、`OPC_DATA_DIR` 指向临时库，
 * 全程不碰真实 `~/.qoder` 等目录。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a169-'));
const HOME = path.join(root, 'home');
const DATA = path.join(root, 'data');
fs.mkdirSync(DATA, { recursive: true });

function skillText(name: string, body: string): string {
  return ['---', `name: ${name}`, `description: ${name} 的描述`, '---', '', body, ''].join('\n');
}

/** 写一条技能（带 `scripts/`，用来证明整目录都搬过去了）。 */
function writeSkill(agent: string, name: string, body: string): string {
  const dir = path.join(HOME, `.${agent}`, 'skills', name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillText(name, body), 'utf8');
  fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n', 'utf8');
  return dir;
}

const SHARED_DIR = writeSkill('claude', 'shared-one', '第一版正文');
// qoder 自己已经有的：不许再塞进壳里（差集）
writeSkill('qoder', 'own-two', 'qoder 自己的');
// gemini 有目录但没有零写入通道：它的技能不该出现在 qoder 的壳里
writeSkill('gemini', 'gemini-own', 'gemini 自己的');

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

const importer = await import('../server/extensions/import.js');
const distribute = await import('../server/extensions/distribute.js');
const store = await import('../server/extensions/store.js');

importer.runImport();

const PLUGIN_ROOT = path.join(DATA, 'extensions', 'opc-skill-plugin');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const entry = (name: string): string => path.join(SKILLS_DIR, name);

/* ══════════════ [1] 源码接线 ══════════════ */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

section('1 源码接线');
const distSrc = fs.readFileSync(
  path.join(process.cwd(), 'server', 'extensions', 'distribute.ts'),
  'utf8'
);
const defsSrc = stripComments(
  fs.readFileSync(path.join(process.cwd(), 'server', 'agents', 'definitions.ts'), 'utf8')
);

ok(/export function skillArgsFor/.test(distSrc), 'distribute.ts 导出 skillArgsFor');
ok(/skillArgsFor\(agentId\)/.test(defsSrc), 'qoder 的 buildArgs 真的拼了技能参数');
/* 拷贝口径的硬证据：剥掉注释后不该有 symlink/junction 的建链代码。
   注释里可以留着「为什么不用 junction」的说明 —— 所以必须先剥注释再判。 */
ok(
  !/symlinkSync|createJunction|linkUsable/.test(stripComments(distSrc)),
  'distribute.ts 不再建链接（只有拷贝）'
);
ok(
  /PLUGIN_DIR_AGENTS\s*=\s*new Set\(\['qoder',\s*'qoder-cn'\]\)/.test(distSrc),
  '只对 qoder / qoder-cn 传 --plugin-dir（gemini 不在里面）'
);

/* ══════════════ [2] 参数与壳形状 ══════════════ */

section('2 参数与壳形状');
const args = distribute.skillArgsFor('qoder');
ok(args[0] === '--plugin-dir' && args.length === 2, '参数是 --plugin-dir <壳>', args.join(' '));
ok(
  args[1] === PLUGIN_ROOT,
  '壳落在 OPC 数据目录里（不是用户目录）',
  String(args[1])
);
ok(fs.existsSync(path.join(PLUGIN_ROOT, '.qoder-plugin', 'plugin.json')), '有 qoder 认识的 manifest');
const manifest = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.qoder-plugin', 'plugin.json'), 'utf8')
) as { name?: string; version?: string };
ok(manifest.name === 'opc-skill-plugin', 'manifest 名字是 opc-skill-plugin', manifest.name);
ok(typeof manifest.version === 'string' && manifest.version.length > 0, 'manifest 有 version', manifest.version);

/* ══════════════ [3] 技能目录真的可读 ══════════════ */

section('3 技能目录真的可读');
ok(fs.existsSync(entry('shared-one')), '壳里出现了共享技能目录');
const skillFile = path.join(entry('shared-one'), 'SKILL.md');
let body = '';
try {
  body = fs.readFileSync(skillFile, 'utf8');
} catch {
  /* 读不到就是红 —— 见下面断言 */
}
ok(body.includes('第一版正文'), 'SKILL.md 读得到，且是镜像里的正文', body.slice(0, 20));
ok(
  fs.existsSync(path.join(entry('shared-one'), 'scripts', 'run.sh')),
  '整目录都搬过去了（scripts/ 一起）'
);
ok(
  !fs.existsSync(entry('own-two')),
  'qoder 自己已有的技能没有被重复塞进壳（差集生效）'
);
/* 反向的差集：gemini 自己的技能对 qoder 来说是「别家共享来的」，
   应该进壳（gemini 没通道只影响「送进 gemini」，不影响「从 gemini 共享出来」）。 */
ok(
  fs.existsSync(entry('gemini-own')),
  '别家目录里的技能照样共享给 qoder（gemini-own 在壳里）'
);

/* ══════════════ [4] 幂等：第二次不重拷 ══════════════ */

section('4 幂等：第二次不重拷');
const birth1 = fs.statSync(entry('shared-one')).birthtimeMs;
distribute.skillArgsFor('qoder');
const birth2 = fs.statSync(entry('shared-one')).birthtimeMs;
ok(
  birth1 === birth2,
  '第二次调用没有重建目录（size + mtime 一致就跳过）',
  `${birth1} vs ${birth2}`
);

/* ══════════════ [5] 源更新后跟上 ══════════════ */

section('5 源更新后跟上');
fs.writeFileSync(
  path.join(SHARED_DIR, 'SKILL.md'),
  skillText('shared-one', '第二版正文变长了'),
  'utf8'
);
importer.runImport();
distribute.skillArgsFor('qoder');
const body2 = fs.readFileSync(skillFile, 'utf8');
ok(body2.includes('第二版正文'), '源更新后壳里跟着更新（不是永远不动的旧拷贝）', body2.slice(-20));

/* ══════════════ [6] 禁用后从壳里撤掉 ══════════════ */

section('6 禁用后从壳里撤掉');
store.toggleEnabled('skill', 'shared-one', false);
// 壳的同步发生在「取启动参数」那一刻（与真实链路一致：每次启动才扫一遍）
distribute.skillArgsFor('qoder');
ok(!fs.existsSync(entry('shared-one')), '禁用的技能已从壳里删除');
store.toggleEnabled('skill', 'gemini-own', false);
const argsOff = distribute.skillArgsFor('qoder');
ok(argsOff.length === 0, '没有可分发技能时返回空数组（不加空参数）', argsOff.join(' '));
ok(!fs.existsSync(entry('gemini-own')), '第二条禁用后壳里也清空了');
store.toggleEnabled('skill', 'shared-one', true);
store.toggleEnabled('skill', 'gemini-own', true);
distribute.skillArgsFor('qoder');
ok(fs.existsSync(skillFile), '重新启用后又会回到壳里');

/* ══════════════ [7] 边界 ══════════════ */

section('7 边界');
ok(distribute.skillArgsFor('gemini').length === 0, 'gemini 拿不到 --plugin-dir（如实承认没通道）');
ok(distribute.skillArgsFor('not-an-agent').length === 0, '非法 agentId 返回空数组');
ok(distribute.skillArgsFor('../evil').length === 0, '路径样式的 agentId 被拒绝');

/* ══════════════ [8] 零写入（拿文件树快照比） ══════════════ */

section('8 零写入（拿文件树快照比）');
const after = snapshot(HOME);
const added = [...after.keys()].filter(k => !before.has(k));
const removed = [...before.keys()].filter(k => !after.has(k));
const changed = [...before.keys()].filter(k => after.has(k) && before.get(k) !== after.get(k));
// 唯一允许的变化是我们自己写的第二版正文
ok(added.length === 0, '假 home 里没有新增任何文件', added.join(', '));
ok(removed.length === 0, '假 home 里没有文件被删', removed.join(', '));
const unexpectedChanged = changed.filter(k => !k.includes('shared-one'));
ok(unexpectedChanged.length === 0, '除了我们改的那条源文件，没有文件被改写', unexpectedChanged.join(', '));
ok(
  PLUGIN_ROOT.startsWith(DATA),
  '壳在 OPC_DATA_DIR 里面，不在用户 home 里',
  PLUGIN_ROOT
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
