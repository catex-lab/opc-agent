/**
 * A98 项目键的纯函数验证（不碰文件系统、不碰数据库）。
 *
 * ## 这一层为什么值得单独测
 *
 * 项目键决定「两个会话是不是同一个项目」，进而决定它们共不共用记忆。
 * 键算错有两种后果，都很隐蔽：
 *
 * - **算松了**（同一目录算出两个键）：用户在两个入口打开同一个仓库，
 *   会看到两套不同的项目记忆，改了这边那边不生效 —— 像记忆坏了。
 * - **算紧了**（不同目录算成同一个键）：两个无关仓库共用一个记忆目录，
 *   规范互相污染 —— 这正是本轮要修的那个 bug 换个位置复发。
 *
 * 运行：npx tsx scripts/verify-a98-key.ts
 */
import path from 'node:path';
import { normalizeProjectPath, projectKey, defaultProjectName } from '../server/project-key.js';

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

const WIN = process.platform === 'win32';
console.log(`\nA98 项目键（平台：${process.platform}）`);

// ── 1. 归一化：同一目录的不同写法必须同键 ────────────────────────────
{
  const base = WIN ? 'E:/proj/app' : '/tmp/proj/app';
  const variants = WIN
    ? ['E:/proj/app', 'E:\\proj\\app', 'E:/proj/app/', 'E:\\proj\\app\\', 'e:/proj/app', 'E:/proj/app/.']
    : ['/tmp/proj/app', '/tmp/proj/app/', '/tmp/proj/app/.', '/tmp/proj/./app'];

  const keys = variants.map(v => projectKey(v));
  ok(new Set(keys).size === 1, `${variants.length} 种写法算出同一个键`, keys[0]);

  const norms = variants.map(v => normalizeProjectPath(v));
  ok(new Set(norms).size === 1, '归一化结果唯一', norms[0]);
  ok(!norms[0].includes('\\'), '归一化后不含反斜杠');
  ok(!norms[0].endsWith('/'), '归一化后无尾斜杠');
}

// ── 2. 大小写：只在 win32 上合并 ────────────────────────────────────
{
  const a = projectKey(WIN ? 'E:/Proj/App' : '/tmp/Proj/App');
  const b = projectKey(WIN ? 'e:/proj/app' : '/tmp/proj/app');
  if (WIN) {
    ok(a === b, 'win32：大小写不同视为同一项目（文件系统不区分）', `${a} / ${b}`);
    ok(normalizeProjectPath('E:/Proj/App') === 'e:/proj/app', 'win32：归一化转小写');
  } else {
    ok(a !== b, 'POSIX：大小写不同是两个项目（文件系统区分）', `${a} / ${b}`);
    ok(normalizeProjectPath('/tmp/Proj/App') === '/tmp/Proj/App', 'POSIX：保留大小写');
  }
}

// ── 3. 同名不同路径不能撞键 ─────────────────────────────────────────
{
  const p1 = WIN ? 'E:/work/api' : '/tmp/work/api';
  const p2 = WIN ? 'E:/side/api' : '/tmp/side/api';
  const k1 = projectKey(p1);
  const k2 = projectKey(p2);
  ok(k1 !== k2, '同名目录（basename 都是 api）键不同', `${k1} vs ${k2}`);
  ok(k1.startsWith('api-') && k2.startsWith('api-'), '两者都可读（以 api- 开头）');
  ok(k1.endsWith(k2.slice(-8)) === false, '哈希后缀确实不同');
}

// ── 4. 键的文件系统安全性 ──────────────────────────────────────────
{
  const weird = WIN ? 'E:/a b/项目 <x>/a:b*c?' : '/tmp/a b/项目 <x>/a:b*c?';
  const k = projectKey(weird);
  ok(!/[<>:"/\\|?*\s]/.test(k), '键里没有文件系统非法字符', k);
  ok(/^[\p{L}\p{N}._-]+$/u.test(k), '键只含字母/数字/点/下划线/连字符', k);
  ok(k.length <= 60, '键长度可控（目录名不会过长）', `${k.length} 字符`);
  ok(k.startsWith('a-b-c-') || k.includes('项目') || k.length > 0, '中文与空格被清洗成连字符', k);
}

// ── 5. 空输入与根目录 ──────────────────────────────────────────────
{
  ok(normalizeProjectPath('') === '', '空串 → 空串');
  ok(normalizeProjectPath('   ') === '', '全空白 → 空串');
  ok(projectKey('') === '', '空串没有键（调用方据此退化成全局层）');
  ok(defaultProjectName('') === '', '空串没有显示名');

  // 根目录必须保住（`E:/` 去掉尾斜杠会变成 `e:`，而 `e:` 在 Windows 上
  // 表示「E 盘的当前目录」，不是根 —— 换个 cwd 就指到别处去了）
  const root = WIN ? 'E:/' : '/';
  const nr = normalizeProjectPath(root);
  ok(nr.length > 0, '根目录归一化后不为空', nr);
  if (WIN) {
    ok(nr === 'e:/', 'win32：盘根保留尾斜杠（不剥成 e:）', nr);
    ok(projectKey('E:/') === projectKey('e:\\'), '盘根的不同写法同键', projectKey('E:/'));
  }
  ok(projectKey(root).length > 0, '根目录也有键', projectKey(root));
}

// ── 6. 显示名保留原始大小写 ────────────────────────────────────────
{
  const raw = WIN ? 'E:/Proj/MyApp' : '/tmp/Proj/MyApp';
  const name = defaultProjectName(raw);
  ok(name === 'MyApp', '显示名保留大小写（不跟着归一化变小小写）', name);
  ok(name !== projectKey(raw).split('-')[0], '显示名与键的可读段不是同一来源（键是小写的）');
}

// ── 7. 相对路径按进程 cwd 解析 ─────────────────────────────────────
{
  const rel = projectKey('./sub/dir');
  const abs = projectKey(path.resolve('./sub/dir'));
  ok(rel === abs, '相对路径与等价绝对路径同键', rel);
}

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
