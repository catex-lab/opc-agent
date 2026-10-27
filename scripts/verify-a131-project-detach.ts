/**
 * A131：删掉的项目不再复活 + 「最近目录」的忽略清单落到服务端。
 *
 * ## 用户报的两件事
 *
 * 1. 「我已经删掉的工作区和目录，每次打开又会出现」—— 根因是启动回填：
 *    `deleteProject()` 把会话解绑成 NULL，而回填的筛选条件正是
 *    `project_id IS NULL AND cwd != ''`，于是照着还留着的 cwd 把项目**重新建回来**。
 *    删除动作在下一次启动时被完整撤销。
 * 2. 「最近目录点了 × 又回来」—— 根因是打包态 `PORT=0`，每次启动换一个
 *    系统分配的空闲端口，而 localStorage 按源隔离，换源等于清单清空。
 *
 * ## 这一层盯的是什么
 *
 * 不是「函数能跑」，而是**三个值不能被混成两个**：NULL = 从没算过（要回填）、
 * '' = 用户亲手摘过（绝不回填）、其它 = 指向某个项目。以及忽略清单必须
 * **按归一化路径记**，否则同一目录的两种写法各说各话。
 *
 * ## 为什么全离线
 *
 * 真实临时目录 + 真实 SQLite（`node:sqlite`），不启服务、不碰用户库。
 * 「换进程还认得」这条靠 `resetCacheForTests()` 逼一次重新读盘来验，
 * 而不是真 spawn 一个子进程 —— 端口漂移这件事在数据层就已经被绕开了。
 *
 * 运行：npx tsx scripts/verify-a131-project-detach.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a131-'));
process.env.OPC_DATA_DIR = path.join(TMP, 'data');

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

// db.ts 在**模块加载时**就按 OPC_DATA_DIR 开库，所以必须先设环境变量再动态 import
const db = await import('../server/db.js');
const dd = await import('../server/dismissed-dirs.js');
const { normalizeProjectPath } = await import('../server/project-key.js');

const now = new Date().toISOString();
function mkSession(id: string, cwd: string | null, updatedAt = now) {
  db.createSession({
    id, title: id, model: 'm', agent_id: null, sdk_session_id: null,
    kind: 'direct', agent_ids: null, orchestration: null, cwd,
    reasoning_effort: null, scenario_id: null, system_prompt: null,
    permission_mode: null, pinned: 0,
    created_at: updatedAt, updated_at: updatedAt,
  } as never);
}

/** 建一个真目录（回填与 POST /api/projects 用同一把尺子：不存在就不建项目） */
function realDir(name: string): string {
  const p = path.join(TMP, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ── 1. A：删除项目 = 标记，不是留给回填去重建 ──────────────────────────
console.log('\n[1] 删除项目之后不许复活');

{
  const A = realDir('projA');
  mkSession('s-keep', A);
  const created = db.getOrCreateProject(A);
  db.updateSession('s-keep', { cwd: A, project_id: created?.id ?? null });
  ok(!!created, '先建出一个项目', created?.path);

  ok(db.deleteProject(created!.id) === true, '删除项目返回成功');
  const row = db.getSession('s-keep');
  ok(row?.project_id === '', '会话被标成空串（= 用户亲手摘过），不是 NULL', JSON.stringify(row?.project_id));
  ok(db.getProjectByPath(A) === undefined, '项目行确实没了');

  const linked = db.backfillSessionProjects();
  ok(linked === 0, '回填一条都没做（以前就是这一步把项目建回来的）', String(linked));
  ok(db.getProjectByPath(A) === undefined, '删掉的项目没有被重建');
  ok(db.getSession('s-keep')?.project_id === '', '标记没被回填覆盖成项目 id');
}

// ── 2. A：回填仍要服务真正的存量数据（反向对照）──────────────────────
console.log('\n[2] 回填该做的还做');

{
  const B = realDir('projB');
  mkSession('s-legacy', B); // project_id 保持 NULL = 模拟改造前的存量会话
  const linked = db.backfillSessionProjects();
  ok(linked === 1, '存量会话（NULL）仍会被回填', String(linked));
  ok(!!db.getProjectByPath(B), '存量会话的目录建出了项目');
  ok(typeof db.getSession('s-legacy')?.project_id === 'string' &&
     db.getSession('s-legacy')!.project_id !== '', '会话指向该项目');
  ok(db.backfillSessionProjects() === 0, '幂等：再跑一次不再改动');
}

// ── 3. A：目录已不存在 → 不建项目（与 POST /api/projects 同一把尺子）──
console.log('\n[3] 磁盘上已经没有这个目录了');

{
  const GONE = path.join(TMP, 'gone-dir'); // 刻意不 mkdir
  mkSession('s-gone', GONE);
  const linked = db.backfillSessionProjects();
  ok(linked === 0, '不存在的目录不参与回填', String(linked));
  ok(db.getProjectByPath(GONE) === undefined, '没有为已删除的目录建出项目');
  ok(db.getSession('s-gone')?.project_id == null, '保持 NULL：目录哪天回来还能认上');

  // 目录重新出现（外接盘、重新 clone）→ 下一次启动正常关联
  fs.mkdirSync(GONE, { recursive: true });
  ok(db.backfillSessionProjects() === 1, '目录回来后能正常补上关联');
}

// ── 4. A：重新归属会清掉标记；记忆分区不受影响 ────────────────────────
console.log('\n[4] 用户改主意的时候');

{
  const A = path.join(TMP, 'projA');
  const before = db.getSession('s-keep')?.project_id;
  // PATCH /api/sessions/:id 换目录走的正是这条：getOrCreateProject(cwd)?.id
  const p = db.getOrCreateProject(A);
  db.updateSession('s-keep', { cwd: A, project_id: p?.id ?? null });
  ok(before === '' && !!p, '从「已摘掉」重新建项目并绑回去', `标记 ${JSON.stringify(before)} → ${p?.id?.slice(0, 8)}`);
  ok(db.getSessionProject('s-keep')?.id === p?.id, 'getSessionProject 认得新归属');

  // 只删项目行、不改 cwd：读取侧要还能按路径找回（记忆不许因此掉进全局）
  db.deleteProject(p!.id);
  const again = db.getOrCreateProject(A);
  ok(db.getSessionProject('s-keep')?.id === again?.id,
    'project_id 是空串时仍按 cwd 回落，记忆分区不变成全局', `路径键 ${again?.path}`);
  db.deleteProject(again!.id); // 收尾：留 [1] 那条断言的语义
}

// ── 5. B：同一目录的多种写法在「最近目录」里只算一条 ──────────────────
console.log('\n[5] 最近目录按归一化路径去重');

{
  const D = realDir('dup');
  const slash = D.replace(/\\/g, '/');
  const backslash = D;
  const trailing = slash + '/';
  // 时间直接在建的时候拉开：`updateSession` 没有 updated_at 这一项，
  // 靠它改不了排序，只能验出个「碰巧的顺序」。
  const t0 = '2026-10-20T00:00:00.000Z';
  const t1 = '2026-10-25T00:00:00.000Z';
  const t2 = '2026-10-27T00:00:00.000Z';

  mkSession('s-dup-1', slash, t0);
  mkSession('s-dup-2', trailing, t1);
  mkSession('s-dup-3', backslash, t2);

  const recents = db.getRecentDirectories(20);
  const hits = recents.filter(d => normalizeProjectPath(d) === normalizeProjectPath(D));
  ok(hits.length === 1, '三种写法只出一条', recents.join(' | '));
  ok(hits[0] === backslash, '代表值取最近一次使用的那条原样写法（未被小写化改写）', hits[0]);
}

// ── 6. B：忽略清单按归一化路径记，且换进程还认得 ──────────────────────
console.log('\n[6] 点 × 之后');

{
  const D = path.join(TMP, 'dup');
  const before = db.getRecentDirectories(20).length;
  const n = dd.dismiss(D.replace(/\\/g, '/'));
  ok(n === 1, '忽略成功，清单里 1 条', String(n));
  ok(dd.dismissedCount() === 1, '计数读得出来');

  const after = db.getRecentDirectories(20);
  ok(after.length === before - 1, '列表里少了一条', `${before} → ${after.length}`);
  ok(!after.some(d => normalizeProjectPath(d) === normalizeProjectPath(D)), '那个目录不再出现');

  // 换一种写法去忽略同一个目录：不该再加第二条
  dd.dismiss(D);
  ok(dd.dismissedCount() === 1, '同一目录的另一种写法不会重复入册', String(dd.dismissedCount()));

  // 模拟重启：清掉进程内缓存，逼它重新读盘
  dd.resetDismissedCacheForTests();
  ok(dd.dismissedCount() === 1, '换个进程读同一份文件，忽略项仍在');
  ok(!db.getRecentDirectories(20).some(d => normalizeProjectPath(d) === normalizeProjectPath(D)),
    '重启后该目录依然不在列表里');

  const restored = dd.restoreAllDismissed();
  ok(restored === 1, '全部恢复清掉 1 条', String(restored));
  dd.resetDismissedCacheForTests();
  ok(dd.dismissedCount() === 0, '恢复也落了盘');
  ok(db.getRecentDirectories(20).some(d => normalizeProjectPath(d) === normalizeProjectPath(D)),
    '恢复之后它回到列表里（点错了有出口）');
}

// ── 7. B：win32 大小写不敏感这条要单独钉 ──────────────────────────────
console.log('\n[7] 大小写');

{
  // 分两段传：写成 'case\\probe' 才对 —— `'\p'` 在 JS 字符串里就是 'p'，会粘成 'caseprobe'
  const lower = path.join(TMP, 'case', 'probe').replace(/\\/g, '/');
  const upper = path.join(TMP, 'case', 'PROBE').replace(/\\/g, '/');
  if (process.platform === 'win32') {
    ok(normalizeProjectPath(lower) === normalizeProjectPath(upper),
      'win32 上两种大小写同键', normalizeProjectPath(lower));
  } else {
    ok(normalizeProjectPath(lower) !== normalizeProjectPath(upper),
      'POSIX 上大小写是两个真实不同的目录，不许合并');
  }
}

// ── 8. 源码契约：别再退回那两个坏实现 ─────────────────────────────────
console.log('\n[8] 源码契约');

{
  const ROOT = process.cwd();
  const dbSrc = fs.readFileSync(path.join(ROOT, 'server/db.ts'), 'utf8');
  const deleteBody = dbSrc.slice(
    dbSrc.indexOf('export function deleteProject'),
    dbSrc.indexOf('export function deleteProject') + 400
  );
  ok(
    /SET project_id = ''/.test(deleteBody) && !/SET project_id = NULL/.test(deleteBody),
    '[契约] deleteProject 写空串而不是 NULL（写回 NULL 就等于把删除撤销）',
    deleteBody.split('\n').filter(l => /project_id/.test(l)).join(' ⏎ ')
  );
  const backfillBody = dbSrc.slice(
    dbSrc.indexOf('export function backfillSessionProjects'),
    dbSrc.indexOf('export function backfillSessionProjects') + 900
  );
  ok(/existsSync\(row\.cwd\)/.test(backfillBody), '[契约] 回填带目录存在性校验');
  ok(/project_id IS NULL/.test(backfillBody), '[契约] 回填只吃 NULL，不吃空串');

  const badge = fs.readFileSync(path.join(ROOT, 'src/components/WorkspaceBadge.tsx'), 'utf8');
  // 只禁**调用**，不禁提到这个词 —— 文件里那段「原先存 localStorage」的注释
  // 正是要留着解释为什么换掉，按字面匹配会把解释当成违规。
  ok(!/localStorage\s*\./.test(badge), '[契约] 工作区徽标不再调 localStorage 存忽略项');
  ok(!/opc_ignored_dirs/.test(badge), '[契约] 那个按端口分源的键已彻底移除');

  const idx = fs.readFileSync(path.join(ROOT, 'server/index.ts'), 'utf8');
  ok(
    /recent-directories\/dismiss/.test(idx) && /recent-directories\/restore/.test(idx),
    '[契约] 忽略与恢复两个端点都接在服务端上'
  );
}

// 库连接在本进程内没有关闭的口子（db.ts 只在模块加载时开），Windows 上
// SQLite 文件会被锁住 —— 与 verify-a98-db.ts 同一处理：删不掉不影响结论。
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录留在 %TEMP% 里，不报错 */
}

console.log(`\n${failures.length ? '❌' : '✅'} A131 项目摘除标记 + 最近目录忽略落盘：${total - failures.length}/${total} 通过`);
for (const f of failures) console.log(`   · ${f}`);
process.exit(failures.length ? 1 : 0);
