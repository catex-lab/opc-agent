/**
 * worktree 隔离汇合的真实验证（A244）：起**临时 git 仓库**，把创建、水合、
 * 干净合并、冲突、失败、清理反转全链路真跑一遍。
 *
 * 为什么不用 mock：A225 的丢数据路径全是「git 在真实行为下的分支」——
 * 冲突文件清单、MERGE_HEAD、autostash、分支删除的连带效应，mock 一概
 * 证不了。这里的仓库全部建在 os.tmpdir()，跑完即删，不碰任何真实仓库。
 *
 * 覆盖面：
 *   [1] createWorktrees：检出建在数据目录、node_modules/.env 水合；
 *   [2] clean 槽位：无改动 → 分支即删；
 *   [3] merged：主区脏（autostash）也能合并，Agent 文件进主区、脏改动复原；
 *   [4] conflict：MERGE_HEAD 判定、merge --abort、分支与检出保留、
 *       cleanupWorktrees 带 keep 不删现场、主区内容不被污染；
 *   [5] failed（提交失败）：检出与改动原样保留（A244 反转的核心断言）；
 *   [6] 身份兜底：仓库无 user.name/email 也能提交（注入 OPC Agent）；
 *   [7] 清理反转：全部清完时根目录才删。
 *
 * 运行：npx tsx scripts/verify-worktree.ts（本机需有 git，秒级）
 */

// 必须先于所有 server/** import：worktree.ts 在模块加载时读 OPC_DATA_DIR
import './lib/temp-data-dir.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 身份兜底测试要求「全局 git 配置缺席」。把 GIT_CONFIG_GLOBAL 指到空文件
 * （git ≥ 2.32），必须在**动态 import** worktree.ts 之前设置——GIT_ENV 在
 * 模块加载时固化快照，之后改 process.env 不会生效。
 */
const emptyGlobal = path.join(os.tmpdir(), `opc-wt-verify-global-${Date.now()}.cfg`);
fs.writeFileSync(emptyGlobal, '');
process.env.GIT_CONFIG_GLOBAL = emptyGlobal;

// 动态 import：让 GIT_ENV 抓到上面的 GIT_CONFIG_GLOBAL
const { createWorktrees, mergeWorktree, cleanupWorktrees, isGitWorkTree } = await import(
  '../server/worktree.js'
);

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total += 1;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

/** 同步跑一条 git 命令；非零退出会抛错（测试里当作断言失败处理） */
function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** 在 merge 状态判定这类「git 拒绝即期望」的场景里吞掉非零退出 */
function gitSyncSoft(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: gitSync(args, cwd) };
  } catch (e: any) {
    return { ok: false, out: String(e?.stdout ?? e?.message ?? '') };
  }
}

/** 本脚本建过的临时仓库（收尾统一删除） */
const tempRepos: string[] = [];

/** 建一个带基线提交的临时仓库（本地配置了身份，供初始化提交用） */
function makeRepo(name: string): string {
  const dir = path.join(os.tmpdir(), `opc-wt-verify-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  tempRepos.push(dir);
  gitSync(['init', '-q'], dir);
  gitSync(['config', 'user.email', 'tester@t.local'], dir);
  gitSync(['config', 'user.name', 'tester'], dir);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  gitSync(['add', '.'], dir);
  gitSync(['commit', '-q', '-m', 'base'], dir);
  return dir;
}

// ── [1] 创建与水合 ───────────────────────────────────────────────
const repo = makeRepo('main');
ok(await isGitWorkTree(repo), '创建：临时仓库是 git 工作树');
fs.mkdirSync(path.join(repo, 'node_modules'));
fs.writeFileSync(path.join(repo, 'node_modules', 'lib.js'), 'dep\n');
fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
const batch = await createWorktrees(repo, ['alpha', 'beta'], 'session-12345678');
ok(batch.slots.size === 2 && batch.failures.length === 0, '创建：两位成员各得一个检出');
ok(batch.root.includes('worktrees'), '创建：根目录在数据目录的 worktrees/ 下', batch.root);
const alpha = batch.slots.get('alpha')!;
const beta = batch.slots.get('beta')!;
ok(fs.existsSync(path.join(alpha.dir, 'base.txt')), '检出：基线文件已检出');
ok(fs.existsSync(path.join(alpha.dir, '.env')), '水合：.env 复制进检出');
ok(fs.existsSync(path.join(alpha.dir, 'node_modules')), '水合：node_modules 进检出（链接）');

// ── [2] clean 槽位：无改动即清 ───────────────────────────────────
{
  const out = await mergeWorktree(batch, alpha, 'Alpha');
  ok(out.kind === 'clean', 'clean：没有文件改动 → clean', JSON.stringify(out));
  ok(
    gitSync(['branch', '--list', alpha.branch], repo).trim() === '',
    'clean：分支随即删除，不留残骸'
  );
}

// ── [3] merged：主区脏也能合并（autostash），Agent 文件进主区 ─────
{
  fs.writeFileSync(path.join(beta.dir, 'feature.txt'), 'feature work\n');
  // 主区先弄脏：以前 merge 会被拒绝（"local changes would be overwritten"），
  // 现在走 --autostash 先收后放
  fs.appendFileSync(path.join(repo, 'base.txt'), 'uncommitted local edit\n');
  const out = await mergeWorktree(batch, beta, 'Beta');
  ok(out.kind === 'merged', 'merged：主区脏不再阻断汇合', JSON.stringify(out));
  if (out.kind === 'merged') {
    ok(out.files === 1, 'merged：改动文件数如实上报', String(out.files));
    ok(
      fs.existsSync(path.join(repo, 'feature.txt')) &&
        // 行尾随 autocrlf 归一（Windows checkout 会放回 CRLF）
        fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n') === 'feature work\n',
      'merged：Agent 的文件已进主工作区'
    );
  }
  ok(
    fs.readFileSync(path.join(repo, 'base.txt'), 'utf8').includes('uncommitted local edit'),
    'autostash：主区未提交改动原样放回'
  );
  ok(
    gitSync(['branch', '--list', beta.branch], repo).trim() === '',
    'merged：分支随即删除'
  );
}

// ── [4] conflict：MERGE_HEAD 判定 + abort + 现场保留 ──────────────
const repo2 = makeRepo('conflict');
{
  const batch2 = await createWorktrees(repo2, ['agent'], 'conflict-87654321');
  const slot = batch2.slots.get('agent')!;
  // 双方改同一文件：检出改完不提交（mergeWorktree 内部会提交），主区提交
  fs.writeFileSync(path.join(slot.dir, 'base.txt'), 'agent version\n');
  fs.writeFileSync(path.join(repo2, 'base.txt'), 'main version\n');
  gitSync(['commit', '-a', '-q', '-m', 'main change'], repo2);

  const out = await mergeWorktree(batch2, slot, 'Agent');
  ok(out.kind === 'conflict', 'conflict：同文件双方改动判为冲突', JSON.stringify(out));
  if (out.kind === 'conflict') {
    ok(out.files.includes('base.txt'), 'conflict：冲突文件清单来自 diff-filter=U');
  }
  const mh = gitSyncSoft(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repo2);
  ok(!mh.ok, 'conflict：主区已 merge --abort，不再处于合并状态');
  ok(
    // 行尾随 autocrlf 归一：Windows 上 merge --abort 后的 checkout 会把 LF 放回成 CRLF
    fs.readFileSync(path.join(repo2, 'base.txt'), 'utf8').replace(/\r\n/g, '\n') === 'main version\n',
    'conflict：主区内容不被污染（停在提交过的版本）'
  );
  ok(fs.existsSync(slot.dir), 'conflict：检出保留（用户自己去解）');
  ok(gitSync(['branch', '--list', slot.branch], repo2).trim() !== '', 'conflict：分支保留');

  // 清理反转：keep 集合里的槽位与根目录都不删
  await cleanupWorktrees(batch2, new Set(['agent']));
  ok(fs.existsSync(slot.dir), '清理反转：keep 的检出不被删（A225 会把保留现场整个 rm -rf）');
  ok(fs.existsSync(batch2.root), '清理反转：有保留槽位时根目录不删');
}

// ── [5] failed：提交失败 → 检出与改动原样保留（A244 核心） ────────
{
  const batch3 = await createWorktrees(repo2, 'ghost'.split(' '), 'conflict-87654321');
  const slot3 = batch3.slots.get('ghost')!;
  fs.writeFileSync(path.join(slot3.dir, 'w.txt'), 'precious work\n');
  // 删掉分支引用让 commit 失败（worktree 的 HEAD 指向已不存在的分支）——
  // 模拟「提交因环境问题失败」这一类 failed 槽位。以前这类槽位会被
  // cleanupWorktrees 连成果一起清掉。
  gitSync(['update-ref', '-d', `refs/heads/${slot3.branch}`], repo2);
  const out = await mergeWorktree(batch3, slot3, 'Ghost');
  ok(out.kind === 'failed', 'failed：提交失败如实报 failed', JSON.stringify(out));
  ok(fs.existsSync(slot3.dir), 'failed：检出不删（A244：成果不许丢）');
  ok(
    fs.readFileSync(path.join(slot3.dir, 'w.txt'), 'utf8') === 'precious work\n',
    'failed：Agent 的改动还在检出里，可取回'
  );
  await cleanupWorktrees(batch3, new Set(['ghost']));
  ok(fs.existsSync(slot3.dir), 'failed：cleanup 带 keep 同样保留');
}

// ── [6] 身份兜底：仓库完全没配身份也能提交 ────────────────────────
{
  const repo3 = makeRepo('noident');
  gitSync(['config', '--unset', 'user.name'], repo3);
  gitSync(['config', '--unset', 'user.email'], repo3);
  const batch4 = await createWorktrees(repo3, ['writer'], 'noident-11111111');
  const slot4 = batch4.slots.get('writer')!;
  fs.writeFileSync(path.join(slot4.dir, 'code.txt'), 'code\n');
  const out = await mergeWorktree(batch4, slot4, 'Writer');
  ok(out.kind === 'merged', '身份兜底：无 user.name/email 不再让提交失败', JSON.stringify(out));
  ok(
    gitSync(['log', '-1', '--format=%an'], repo3).trim() === 'OPC Agent',
    '身份兜底：汇合提交署名是注入的兜底身份（不覆盖用户配好的身份）'
  );
}

// ── [7] 清理反转：全部槽位清完时根目录才删 ────────────────────────
{
  await cleanupWorktrees(batch, new Set());
  ok(!fs.existsSync(batch.root), '清理：无保留时根目录一并清掉');
}

// ── 收尾：删临时仓库与残留数据 ───────────────────────────────────
for (const dir of tempRepos) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上 git 可能还没放干净句柄，留给系统清理 */
  }
}
try {
  fs.rmSync(emptyGlobal, { force: true });
} catch {
  /* 非关键 */
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`worktree 汇合断言：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 创建/水合、clean/merged/conflict/failed、身份兜底、清理反转全部符合预期');
