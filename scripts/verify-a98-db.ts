/**
 * A98 数据层 + 记忆分区的验证（真实文件系统 + 真实 SQLite，但不启服务）。
 *
 * ## 为什么要动态 import
 *
 * `server/db.ts` 在**模块加载时**就会按 `OPC_DATA_DIR` 打开数据库。
 * 所以必须先设好环境变量再 import，否则会连到真实 `data/chat.db` 上
 * —— 那正是 `paths.ts` 里专门写过一段注释要避免的事。
 *
 * ## 这一层盯的是什么
 *
 * 不是「函数能跑」，而是**隔离与兼容**：
 * - 两个项目写同样的内容，读回来不能串
 *  - 用户画像不许分区（它描述「这个人」，不随仓库变）
 * - 老数据回填要幂等，且不许给「没绑目录」的会话硬塞项目
 * - 项目删掉之后，会话解绑、记忆文件必须留着
 *
 * 运行：npx tsx scripts/verify-a98-db.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a98-'));
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

const db = await import('../server/db.js');
const mem = await import('../server/memory.js');

const A = path.join(TMP, 'projA');
const B = path.join(TMP, 'projB');
const NO_MEM = path.join(TMP, 'projNoMem');
fs.mkdirSync(A, { recursive: true });
fs.mkdirSync(B, { recursive: true });
fs.mkdirSync(NO_MEM, { recursive: true });

const now = new Date().toISOString();
function mkSession(id: string, cwd: string | null) {
  db.createSession({
    id, title: id, model: 'm', agent_id: null, sdk_session_id: null,
    kind: 'direct', agent_ids: null, orchestration: null, cwd,
    reasoning_effort: null, scenario_id: null, system_prompt: null,
    created_at: now, updated_at: now,
  } as never);
}

// ── 1. 项目表 ──────────────────────────────────────────────────────
console.log('\nA98 项目实体');

{
  const p1 = db.getOrCreateProject(A);
  const p2 = db.getOrCreateProject(A);
  ok(!!p1, '按目录取或建项目成功', p1?.name);
  ok(p1?.id === p2?.id, '同一目录重复调用返回同一项目（幂等）');
  ok(db.listProjects().length === 1, '库里只有 1 个项目', String(db.listProjects().length));

  // 不同写法：反斜杠 / 尾斜杠 / 大小写
  const alt = process.platform === 'win32' ? A.replace(/\//g, '\\') + '\\' : A + '/';
  const p3 = db.getOrCreateProject(alt);
  ok(p3?.id === p1?.id, '同一目录的不同写法归到同一个项目', p3?.path);
  ok(db.listProjects().length === 1, '没有因此多出第二个项目');

  const p4 = db.getOrCreateProject(B);
  ok(p4?.id !== p1?.id, '不同目录是两个项目');
  ok(db.listProjects().length === 2, '共 2 个项目');

  ok(db.getOrCreateProject('') === undefined, '空路径不建项目');
  ok(db.getProjectByPath(path.join(TMP, 'nope')) === undefined, '未登记过的目录查不到');

  ok(db.renameProject(p4!.id, '乙项目'), '改名成功');
  ok(db.getProject(p4!.id)?.name === '乙项目', '改名后读回新名字');
  ok(db.renameProject(p4!.id, '   ') === false, '空名字被拒绝');
}

// ── 2. 会话关联与回填 ──────────────────────────────────────────────
console.log('\nA98 会话关联与回填');

{
  mkSession('s-a', A);
  mkSession('s-b', B);
  mkSession('s-none', null);

  // 新建时没传 project_id（模拟改造前的存量数据）
  ok(db.getSession('s-a')?.project_id == null, '存量会话的 project_id 为空');

  const linked = db.backfillSessionProjects();
  ok(linked === 2, '回填了 2 个有目录的会话（没目录的不算）', String(linked));
  ok(!!db.getSession('s-a')?.project_id, 's-a 已关联项目');
  ok(db.getSession('s-none')?.project_id == null, '没绑目录的会话保持 NULL（不硬塞项目）');
  ok(db.backfillSessionProjects() === 0, '回填幂等：再跑一次不再改动');

  const pa = db.getSessionProject('s-a');
  ok(pa?.id === db.getProjectByPath(A)?.id, 'getSessionProject 取到正确项目', pa?.name);
  ok(db.getSessionProject('s-none') === undefined, '没绑目录 → 没有项目（调用方退化成全局记忆）');
  ok(db.getSessionProject('not-exist') === undefined, '不存在的会话不抛错');

  // 换目录 = 换项目
  db.updateSession('s-a', { cwd: B, project_id: db.getOrCreateProject(B)?.id ?? null });
  ok(db.getSessionProject('s-a')?.id === db.getProjectByPath(B)?.id, '改 cwd 后项目跟着换');
  // 清空目录 = 解绑
  db.updateSession('s-b', { cwd: null, project_id: null });
  ok(db.getSession('s-b')?.project_id == null, '清空 cwd 后解绑');
  // 复原，后面要用
  db.updateSession('s-a', { cwd: A, project_id: db.getOrCreateProject(A)?.id ?? null });
  db.updateSession('s-b', { cwd: B, project_id: db.getOrCreateProject(B)?.id ?? null });
}

// ── 3. 记忆分区：读隔离 ────────────────────────────────────────────
console.log('\nA98 记忆分区');

{
  mem.writeCoreMemory('# 全局\n统一 2 空格缩进');
  mem.writeCoreMemory('# A 项目\n用 pnpm，禁止 npm', A);
  mem.writeCoreMemory('# B 项目\n用 cargo，禁止 node', B);

  ok(mem.readCoreMemory().includes('统一 2 空格'), '全局层写入成功');
  ok(mem.readCoreMemory(A).includes('pnpm'), 'A 项目记忆写入成功');
  ok(!mem.readCoreMemory(A).includes('cargo'), 'A 读不到 B 的内容');
  ok(!mem.readCoreMemory(B).includes('pnpm'), 'B 读不到 A 的内容');
  ok(mem.readCoreMemory(NO_MEM) === '', '没有记忆的项目读出空串（不造模板文件）');
  ok(!fs.existsSync(path.join(mem.PROJECTS_DIR, mem.projectScope(NO_MEM)!.key, 'MEMORY.md')), '读操作没有在磁盘上创建文件');

  ok(mem.projectMemoryStats(A)?.exists === true, 'A 的统计标记「有记忆」');
  ok(mem.projectMemoryStats(NO_MEM)?.exists === false, '无记忆项目标记 exists=false');
  ok(mem.projectMemoryStats('') === null, '空路径没有项目统计');
}

// ── 4. 注入装配 ────────────────────────────────────────────────────
console.log('\nA98 注入装配');

{
  const ctxA = mem.assembleMemoryContext({ cwd: A });
  const ctxB = mem.assembleMemoryContext({ cwd: B });
  ok(ctxA.includes('统一 2 空格'), 'A 的上下文包含全局层');
  ok(ctxA.includes('用 pnpm'), 'A 的上下文包含自己的项目层');
  ok(!ctxA.includes('用 cargo'), 'A 的上下文不含 B 的项目层');
  ok(ctxB.includes('用 cargo') && !ctxB.includes('用 pnpm'), 'B 反之亦然');
  ok(ctxA.indexOf('统一 2 空格') < ctxA.indexOf('用 pnpm'), '项目层排在全局层之后（越具体越靠后）');

  const ctxNone = mem.assembleMemoryContext();
  ok(ctxNone.includes('统一 2 空格'), '不传 cwd 仍有全局层');
  ok(!ctxNone.includes('用 pnpm') && !ctxNone.includes('用 cargo'), '不传 cwd 没有任何项目层');
  ok(!ctxNone.includes('当前项目记忆'), '没有项目记忆时不出现该标题');

  const ctxNoMem = mem.assembleMemoryContext({ cwd: NO_MEM });
  ok(!ctxNoMem.includes('当前项目记忆'), '项目记忆为空时整段不出现（不注入空标题）');

  // withMemoryContext：适配器入口
  ok(mem.withMemoryContext('你是助手', A).startsWith('你是助手'), 'withMemoryContext 保留原提示词在最前');
  ok(mem.withMemoryContext('你是助手', A).includes('用 pnpm'), 'withMemoryContext 带上项目层');
  ok(!mem.withMemoryContext('你是助手').includes('用 pnpm'), 'withMemoryContext 不传 cwd 时不带项目层');
  ok(mem.withMemoryContext(undefined, A).includes('用 pnpm'), '原提示词为空时直接用记忆');
}

// ── 5. 用户画像不分区 ──────────────────────────────────────────────
console.log('\nA98 用户画像不分区');

{
  mem.writeUserProfile('# 画像\n偏好中文回答');
  ok(mem.readUserProfile().includes('偏好中文'), '画像写入全局层');
  // 画像没有 cwd 参数 —— 这是刻意的：它描述「这个人」，不随仓库变
  ok(mem.assembleMemoryContext({ cwd: A }).includes('偏好中文'), 'A 的上下文包含画像');
  ok(mem.assembleMemoryContext({ cwd: B }).includes('偏好中文'), 'B 的上下文同样包含画像');
  ok(!fs.existsSync(path.join(mem.PROJECTS_DIR, mem.projectScope(A)!.key, 'USER.md')), '项目目录里没有 USER.md（画像不复制）');
}

// ── 6. 技能分区与覆盖 ──────────────────────────────────────────────
console.log('\nA98 技能分区');

{
  mem.writeSkill('deploy', '# 全局部署\n用 make deploy');
  mem.writeSkill('deploy', '# A 部署\n用 pnpm deploy', A);
  mem.writeSkill('only-global', '# 全局专用\n内容');

  const inA = mem.listSkills(A);
  const deployInA = inA.filter(s => s.name === 'deploy');
  ok(deployInA.length === 1, '同名技能在 A 里只出现一次（项目层覆盖全局）', String(deployInA.length));
  ok(deployInA[0].scope === 'project', '覆盖生效：读到的是项目层那份', deployInA[0].scope);
  ok(deployInA[0].body.includes('pnpm'), '项目层内容正确');
  ok(inA.some(s => s.name === 'only-global' && s.scope === 'global'), '全局独有技能仍然可见');

  const noScope = mem.listSkills();
  ok(noScope.every(s => s.scope === 'global'), '不传 cwd 只列全局技能');
  ok(noScope.find(s => s.name === 'deploy')?.body.includes('make deploy'), '不传 cwd 读到的是全局那份');

  ok(mem.readSkill('deploy', A)?.body.includes('pnpm'), 'readSkill 优先项目层');
  ok(mem.readSkill('deploy')?.body.includes('make deploy'), 'readSkill 不传 cwd 读全局');

  // 删除要按作用域
  ok(mem.deleteSkill('deploy', A) === true, '删除 A 的项目技能');
  ok(mem.readSkill('deploy', A)?.body.includes('make deploy'), 'A 里回落到全局那份（不是消失）');
  ok(mem.deleteSkill('deploy', A) === false, '再删一次返回 false（项目层已没有）');
}

// ── 7. FTS 索引按作用域过滤 ────────────────────────────────────────
console.log('\nA98 检索隔离');

{
  const idx = mem.reindexMemory();
  ok(idx.projects >= 2, '索引了至少 2 个项目', JSON.stringify(idx));

  const hitA = mem.searchMemory('pnpm', 10, A);
  const hitB = mem.searchMemory('pnpm', 10, B);
  const hitGlobal = mem.searchMemory('pnpm', 10);
  ok(hitA.length > 0, 'A 能搜到自己项目里的 pnpm', String(hitA.length));
  ok(hitB.length === 0, 'B 搜不到 A 的 pnpm', String(hitB.length));
  ok(hitGlobal.length === 0, '不带 cwd 的全局检索搜不到项目内容', String(hitGlobal.length));
  ok(hitA.every(h => h.scope === mem.projectScope(A)!.key), 'A 的命中都标着 A 的作用域', hitA.map(h => h.scope).join(','));

  const globalHit = mem.searchMemory('缩进', 10);
  ok(globalHit.length > 0 && globalHit.every(h => h.scope === ''), '全局内容在不带 cwd 时能搜到', String(globalHit.length));
  ok(mem.searchMemory('缩进', 10, A).some(h => h.scope === ''), '带 cwd 时全局内容也在结果里（全局 + 项目）');

  // 删掉项目记忆后索引里也不该再有它
  mem.writeCoreMemory('', A);
  ok(mem.searchMemory('pnpm', 10, A).length === 0, '清空项目记忆后检索不到（空内容不建索引）');
}

// ── 8. 删项目：解绑会话、保留记忆文件 ──────────────────────────────
console.log('\nA98 删项目');

{
  const pa = db.getProjectByPath(A)!;
  const memFile = path.join(mem.PROJECTS_DIR, mem.projectScope(A)!.key, 'MEMORY.md');
  mem.writeCoreMemory('# A 又写回来了', A);
  ok(fs.existsSync(memFile), '删除前记忆文件存在');

  ok(db.deleteProject(pa.id) === true, '删除项目成功');
  // A131 改了这里的期望值：解绑写的是**空串**而不是 NULL。NULL = 「从没算过」，
  // 会被启动回填按 cwd 重新建出项目 —— 那正是「删掉的项目每次打开又出现」的根因。
  // 空串 = 「用户亲手摘过」，回填必须跳过。两者都不是悬空引用。
  ok(db.getSession('s-a')?.project_id === '', '会话标成空串（= 主动摘掉，回填不再动它）',
    JSON.stringify(db.getSession('s-a')?.project_id));
  ok(db.getSessionProject('s-a') === undefined, '解绑后 getSessionProject 返回 undefined');
  ok(fs.existsSync(memFile), '**记忆文件没有被删**（删项目行 ≠ 想扔记忆）');
  ok(db.deleteProject(pa.id) === false, '重复删除返回 false');
}

// ── 汇总 ────────────────────────────────────────────────────────────
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉不影响结论 */
}
console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
