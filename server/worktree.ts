/**
 * 群聊并行任务的 git worktree 隔离（A225，A244 修复汇合与清理的丢数据路径）。
 *
 * ## 它解决什么问题
 *
 * 群聊的 broadcast / mention / leader 模式是**并行**的（orchestrator.ts 的 Promise.all）：
 * 几个成员同时改同一个仓库的同一批文件，后写的覆盖先写的——这不是体验问题，
 * 是群聊形态的硬伤。业界对这个问题的通用答案是 git worktree：每个并行执行体
 * 一个独立检出（共享同一份仓库对象库，不像 clone 那样整份拷贝），跑完把产出
 * **汇合**回主工作区。
 *
 * ## 生命周期
 *
 *   创建（每成员一个）          汇合（串行，按成员顺序）            清理
 *   worktree add -b <分支>  →  worktree 内 add+commit      →  merged/clean 的
 *   基于主区当前提交，检出在    主区 merge --no-ff <分支>           槽位删 worktree+分支
 *   data/worktrees/<群>                                         其余一律保留
 *
 * 汇合策略（写死，防走偏）：
 *   - 无改动 → 什么也不做，note 说「没有文件改动」；
 *   - 干净合并 → --no-ff 留汇合节点，note 报改动文件数；
 *   - **冲突 → 立即停**：主区 `merge --abort` 保持原状，分支与 worktree
 *     **保留**（用户可以自己去 worktree 里解），note 列冲突文件。
 *     绝不自动 rebase / 绝不挑一边——那是在替用户做不可逆的决定。
 *   - **绝不 push**。汇合只发生在本地。
 *
 * ## A244 修了哪些丢数据的路径
 *
 *   1. **failed 槽位不再被删**：提交身份缺失 / pre-commit 拒绝 / 主区脏导致
 *      merge 被拒，以前都会被 `cleanupWorktrees` 连目录带分支清掉——Agent 的
 *      改动就没了。现在清理规则反转：**只有 merged / clean 的槽位清**，
 *      failed / conflict / 中止 / 异常一律保留分支和检出，note 告诉用户在哪。
 *   2. **保留的检出不再被误删**：以前 cleanupWorktrees 最后无条件 rm -rf 整个
 *      根目录，把「保留」的冲突检出也埋了。现在只在没有保留槽位时才删根目录。
 *   3. **检出根目录从 os.tmpdir() 挪到 data/worktrees/<群>**：tmp 的「用完即清」
 *      和「保留现场」天然矛盾（OS 会清 tmp，用户却找不到 tmp 里的东西）。
 *      挪到数据目录后，残留是可发现、可管理的（与 images/、avatars/ 同级）。
 *   4. **提交不再依赖本机 git 配置、不被钩子拦**：身份缺失时注入兜底身份
 *      （探一次，commit 与 merge 两处共用——`merge --no-ff` 自己也要创建
 *      汇合提交），`--no-verify` + `commit.gpgsign=false`——这是机器替用户
 *      做的一次汇合提交，不是用户本人的工作提交，不该被 lint-staged / gpg 卡住。
 *   5. **主区脏不再让 merge 被拒**：`merge --autostash` 先把主区未提交改动
 *      收起、合并完再放回去（中止时也会自动恢复）。
 *   6. **冲突判定不再解析 git 文案**：以前正则匹配 `CONFLICT|Both modified`，
 *      中文 locale 且装了翻译的 Linux 上会失配 → 判成 failed 且不 abort，
 *      主区停在合并一半的状态。现在看 `MERGE_HEAD` 是否存在（locale 无关），
 *      冲突文件清单用 `diff --name-only --diff-filter=U`（输出是路径，不走 i18n）。
 *      所有 git 调用统一带 `LC_ALL=C`，把「输出被翻译」这个变量整个钉死。
 *   7. **检出不再缺 node_modules / .env**：创建后把主区的 node_modules 链接
 *      （Windows 用 junction，免管理员）、`.env*` 白名单复制进来——否则 Agent
 *      在检出里跑测试/构建第一步就失败。水合产物同时写进**检出私有**的
 *      info/exclude：不让它们进 status、不进 add -A，否则汇合必撞车。
 *
 * ## 为什么基线仍是主区「当前提交」（HEAD）
 *
 * worktree add 必须基于一个提交；主区未提交的改动进不了检出。这个缺口用
 * `--autostash` 从汇合侧补（合并时自动收放），而不是在检出侧复制脏改动——
 * 把用户的半成品改动复制进 Agent 的工作区，等于让 Agent 在用户没保存的
 * 状态上继续写，撤回起来说不清。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { dataDirPath } from './paths.js';

/** 单条 git 命令的预算。正常毫秒级；网络完全不参与（绝不 push/pull） */
const GIT_TIMEOUT_MS = 30_000;

/**
 * git 子进程的环境。LC_ALL/LANGUAGE 钉成 C：让输出**确定是英文**。
 * 不钉的话，Linux 部署 + 中文 locale + 带翻译的 git（apt/dnf 版自带 l10n）
 * 会把部分消息翻成中文——虽然 A244 之后判定不再依赖文案，但日志一致性
 * 仍值得钉死，成本为零。Git for Windows 不带 .mo，此项对它无感。
 */
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' };

export function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: GIT_ENV },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
      }
    );
  });
}

/** 目录是不是 git 工作树（不是「属于某个仓库」——必须是可直接检出的工作树） */
export async function isGitWorkTree(dir: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], dir);
  return r.ok && r.stdout.trim() === 'true';
}

/** 检出根目录：数据目录下的 worktrees/<群短 id>。残留可发现、可手动管理 */
function worktreeRootOf(sessionId: string): string {
  const shortId = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || randomUUID().slice(0, 8);
  return path.join(dataDirPath, 'worktrees', shortId);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsPromises.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 水合产物（hydrateWorktree 放进检出里的东西）在 git 层面的 pathspec 排除。
 *
 * 为什么不能写 info/exclude：实测（git 2.54）`git rev-parse --git-path
 * info/exclude` 在链接检出里返回的是**主仓库共享**的那份——写它等于改
 * 用户仓库的忽略表，不能碰；检出私有目录下的 info/exclude 则根本不生效。
 * 所以改在 status / add 两处显式排除，与水合白名单一一对应。
 *
 * 附带一个安全属性：Agent 即便故意写 .env，也不会被汇合提交进主仓库
 * （秘密不该走群聊汇合这条机器通道）。
 */
const HYDRATE_EXCLUDES = [
  ':(exclude,top)node_modules',
  ':(exclude,top).env',
  ':(exclude,top).env.*',
];

/**
 * 把主区里「不进 git 的运行材料」带进检出：node_modules（链接）与 .env*（复制）。
 * 失败一律静默——缺了它们 Agent 顶多重装依赖，不该让它阻断隔离创建。
 * 对 git 不可见靠 mergeWorktree 里的 HYDRATE_EXCLUDES（见其注释）。
 */
async function hydrateWorktree(baseDir: string, dir: string): Promise<void> {
  // node_modules：构建/测试的依赖。链接而不是复制——几万个小文件复制既慢又占盘。
  // Windows 用 junction（不需要管理员权限）；POSIX 用目录符号链接。
  try {
    const nm = path.join(baseDir, 'node_modules');
    if ((await fsPromises.stat(nm)).isDirectory() && !(await pathExists(path.join(dir, 'node_modules')))) {
      await fsPromises.symlink(nm, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch {
    /* 链接失败不致命 */
  }
  // .env*：未跟踪的本地配置。检出里没有它，Agent 起服务/跑脚本直接缺配置。
  // 只认这一族文件名，不碰其他未跟踪文件——那可能是用户不想被复制的东西。
  try {
    const entries = await fsPromises.readdir(baseDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/^\.env(\..+)?$/.test(e.name)) continue;
      const dst = path.join(dir, e.name);
      if (!(await pathExists(dst))) await fsPromises.copyFile(path.join(baseDir, e.name), dst);
    }
  } catch {
    /* 复制失败不致命 */
  }
}

export interface WorktreeSlot {
  agentId: string;
  /** 检出目录（data/worktrees/<群> 下） */
  dir: string;
  /** 专用分支名，汇合后删除；冲突/失败/中止时保留 */
  branch: string;
}

export interface WorktreeBatch {
  sessionId: string;
  /** 主工作区（仓库）目录 */
  baseDir: string;
  /** 本批检出的根目录（note 要把保留现场的位置告诉用户） */
  root: string;
  slots: Map<string, WorktreeSlot>;
  /** 创建失败的成员（含原因）——它们退回共享目录跑，note 要如实说明 */
  failures: Array<{ agentId: string; reason: string }>;
  /** 本次创建前根目录已存在（上次运行保留了现场）——note 提醒用户别忘清理 */
  hadLeftovers: boolean;
}

/**
 * 为一批成员各建一个 worktree。部分失败不整体失败：
 * 建不出来的成员退回共享目录（note 说明），别人照常隔离。
 */
export async function createWorktrees(
  baseDir: string,
  agentIds: string[],
  sessionId: string
): Promise<WorktreeBatch> {
  const root = worktreeRootOf(sessionId);
  const hadLeftovers = await pathExists(root);
  await fsPromises.mkdir(root, { recursive: true });

  const batch: WorktreeBatch = {
    sessionId,
    baseDir,
    root,
    slots: new Map(),
    failures: [],
    hadLeftovers,
  };

  for (const agentId of agentIds) {
    // 冲突的分支名是「成员名 + 随机」：同群同名成员重跑也不撞旧分支
    const key = `${agentId}-${randomUUID().slice(0, 6)}`.replace(/[^a-zA-Z0-9-]/g, '');
    const dir = path.join(root, key);
    const branch = `opc/wt/${key}`;
    const r = await git(['worktree', 'add', '-b', branch, dir, 'HEAD'], baseDir);
    if (r.ok) {
      batch.slots.set(agentId, { agentId, dir, branch });
      await hydrateWorktree(baseDir, dir);
    } else {
      batch.failures.push({
        agentId,
        reason: (r.stderr || r.stdout || 'worktree add 失败').trim().split('\n').pop() || '未知原因',
      });
    }
  }
  return batch;
}

export type MergeOutcome =
  | { kind: 'merged'; files: number }
  | { kind: 'clean'; files: 0 }
  | { kind: 'conflict'; files: string[]; branch: string; dir: string }
  | { kind: 'failed'; reason: string };

/**
 * 汇合一个成员的产出。必须**串行**调用（同一主区并发 merge 会互相踩 index）。
 *
 * 步骤：
 *  1. worktree 内 `status --porcelain` 判有无改动；无改动 → clean；
 *  2. 有改动 → add -A + commit（身份缺失注入兜底；--no-verify / 不 gpg 签）；
 *  3. 主区 merge --no-ff --autostash；失败时按 MERGE_HEAD 分流：
 *     存在 = 冲突状态 → 列 unmerged 文件 + merge --abort + 保留现场；
 *     不存在 = 没资格合并（其余 git 报错）→ failed，现场同样保留；
 *  4. 成功 → remove worktree + 删分支。
 */
export async function mergeWorktree(batch: WorktreeBatch, slot: WorktreeSlot, memberName: string): Promise<MergeOutcome> {
  // 1. 有没有改动（水合产物不算——它们是本产品的搬运，不是 Agent 的产出）
  const st = await git(['status', '--porcelain', '--', ...HYDRATE_EXCLUDES], slot.dir);
  if (!st.ok) {
    return { kind: 'failed', reason: (st.stderr || '读取 worktree 状态失败').trim() };
  }
  if (!st.stdout.trim()) {
    await cleanupSlot(batch.baseDir, slot);
    return { kind: 'clean', files: 0 };
  }

  // 2. 提交（改动属于 Agent 的执行过程，不评判内容）。
  //    这是机器代做的汇合提交：身份缺了就注入兜底（不覆盖用户配好的身份），
  //    钩子与 gpg 一律跳过——它们拦的是「人要提交的工作」，不该拦汇合。
  //    身份探一次、commit 与 merge 共用：merge --no-ff 自己也要创建汇合提交，
  //    只给 commit 注入的话，merge 阶段照样会死在「Committer identity unknown」。
  await git(['add', '-A', '--', ...HYDRATE_EXCLUDES], slot.dir);
  const identityArgs: string[] = [];
  const who = await git(['config', 'user.name'], batch.baseDir);
  if (!who.ok || !who.stdout.trim()) identityArgs.push('-c', 'user.name=OPC Agent');
  const mail = await git(['config', 'user.email'], batch.baseDir);
  if (!mail.ok || !mail.stdout.trim()) identityArgs.push('-c', 'user.email=opc@localhost');
  const commit = await git(
    [...identityArgs, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', `群聊汇合：${memberName}（${slot.branch}）`],
    slot.dir
  );
  if (!commit.ok) {
    return { kind: 'failed', reason: (commit.stderr || '提交改动失败').trim() };
  }

  // 3. 主区合并。--no-ff：汇合是「一次群聊的产出」这个事实，值得留一个节点。
  //    --autostash：主区有未提交改动时先收起、合并完放回——以前这里直接被
  //    git 拒绝（"local changes would be overwritten"），Agent 的成果被当成失败。
  const merge = await git(
    [...identityArgs, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--autostash', slot.branch, '-m', `群聊汇合：${memberName}`],
    batch.baseDir
  );
  if (!merge.ok) {
    // 冲突与否不再解析文案（i18n 会把 "CONFLICT" 翻走）：MERGE_HEAD 存在
    // = 这次 merge 真的落在了冲突状态，这在任何 locale、任何 git 版本下成立。
    const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], batch.baseDir);
    if (mergeHead.ok) {
      const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], batch.baseDir);
      const files = unmerged.ok
        ? unmerged.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        : [];
      // 先让主区恢复原状（MERGE_AUTOSTASH 由 --abort 一并恢复），再保留现场
      await git(['merge', '--abort'], batch.baseDir);
      return { kind: 'conflict', files, branch: slot.branch, dir: slot.dir };
    }
    return { kind: 'failed', reason: (merge.stderr || merge.stdout || '合并失败').trim() };
  }

  const files = await git(['diff', '--name-only', `${slot.branch}^1`, slot.branch], batch.baseDir);
  const count = files.ok ? files.stdout.split('\n').filter(Boolean).length : 0;

  // 4. 成功即清（这一条槽位的分支与检出都不留残骸；failed/conflict 由调用方保留）
  await cleanupSlot(batch.baseDir, slot);
  return { kind: 'merged', files: count };
}

/** 删 worktree（目录一并删除）与分支。幂等：失败静默，检出在数据目录里 */
async function cleanupSlot(baseDir: string, slot: WorktreeSlot): Promise<void> {
  await git(['worktree', 'remove', '--force', slot.dir], baseDir);
  await git(['branch', '-D', slot.branch], baseDir);
}

/**
 * 清理一批里**没被保留**的槽位。
 *
 * A244 语义反转：这个函数现在只应该收到「merged / clean 之外的槽位也要保留」
 * 的 keep 集合（failed / conflict / 中止 / 异常一律保留现场）。它绝不删除
 * keep 里的东西；也只在没有任何保留时才删根目录——否则保留的检出会跟着
 * 根目录一起被埋（A225 的真 bug）。
 *
 * 中止 / 异常路径**不应调用本函数**：一个槽位都别删，让路由层 note 告诉
 * 用户现场在哪。
 */
export async function cleanupWorktrees(batch: WorktreeBatch, keep: Set<string> = new Set()): Promise<void> {
  for (const slot of batch.slots.values()) {
    if (keep.has(slot.agentId)) continue;
    await cleanupSlot(batch.baseDir, slot);
  }
  if (keep.size === 0) {
    try {
      await fsPromises.rm(batch.root, { recursive: true, force: true });
    } catch {
      /* 非关键路径：留着也只是个空目录 */
    }
  }
}
