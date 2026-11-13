/**
 * 群聊并行任务的 git worktree 隔离（A225）。
 *
 * ## 它解决什么问题
 *
 * 群聊的 broadcast / mention 模式是**并行**的（orchestrator.ts 的 Promise.all）：
 * 几个成员同时改同一个仓库的同一批文件，后写的覆盖先写的——这不是体验问题，
 * 是群聊形态的硬伤。业界对这个问题的通用答案是 git worktree：每个并行执行体
 * 一个独立检出（共享同一份仓库对象库，不像 clone 那样整份拷贝），跑完把产出
 * **汇合**回主工作区。
 *
 * ## 生命周期
 *
 *   创建（每成员一个）          汇合（串行，按成员顺序）            清理
 *   worktree add -b <分支>  →  worktree 内 add+commit      →  worktree remove
 *   基于 HEAD，检出在临时目录    主区 merge --no-ff <分支>          + branch -D
 *
 * 汇合策略（写死，防走偏）：
 *   - 无改动 → 什么也不做，note 说「没有文件改动」；
 *   - 干净合并 → --no-ff 留汇合节点，note 报改动文件数；
 *   - **冲突 → 立即停**：主区 `merge --abort` 保持原状，分支与 worktree
 *     **保留**（用户可以自己去 worktree 里解），note 列冲突文件。
 *     绝不自动 rebase / 绝不挑一边——那是在替用户做不可逆的决定。
 *   - **绝不 push**。汇合只发生在本地。
 *
 * ## 为什么检出在 os.tmpdir() 而不是仓库旁边
 *
 * 放仓库内（`.opc-wt/`）会让 `git status` 常驻一条 untracked；放旁边
 * （`../.opc-wt/`）是在用户没有授权的位置写目录。tmp 目录两者都不沾，
 * 用完即清；分支本身留在仓库里（残留的分支是可发现的，残留的目录不是）。
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';

/** 单条 git 命令的预算。正常毫秒级；网络完全不参与（绝不 push/pull） */
const GIT_TIMEOUT_MS = 30_000;

export function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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

export interface WorktreeSlot {
  agentId: string;
  /** 检出目录（os.tmpdir() 下） */
  dir: string;
  /** 专用分支名，汇合后删除；冲突时保留 */
  branch: string;
}

export interface WorktreeBatch {
  sessionId: string;
  baseDir: string;
  slots: Map<string, WorktreeSlot>;
  /** 创建失败的成员（含原因）——它们退回共享目录跑，note 要如实说明 */
  failures: Array<{ agentId: string; reason: string }>;
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
  const batch: WorktreeBatch = {
    sessionId,
    baseDir,
    slots: new Map(),
    failures: [],
  };

  // 冲突的分支名是「成员名 + 随机」：同群同名成员重跑也不撞旧分支
  const shortId = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || randomUUID().slice(0, 8);
  const root = path.join(os.tmpdir(), 'opc-worktrees', shortId);
  await fsPromises.mkdir(root, { recursive: true });

  for (const agentId of agentIds) {
    const key = `${agentId}-${randomUUID().slice(0, 6)}`.replace(/[^a-zA-Z0-9-]/g, '');
    const dir = path.join(root, key);
    const branch = `opc/wt/${key}`;
    const r = await git(['worktree', 'add', '-b', branch, dir, 'HEAD'], baseDir);
    if (r.ok) {
      batch.slots.set(agentId, { agentId, dir, branch });
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
 *  2. 有改动 → add -A + commit（提交信息如实标注来源成员）；
 *  3. 主区 merge --no-ff；冲突 → merge --abort + 保留分支与目录，列冲突文件；
 *  4. 成功 → remove worktree + 删分支。
 */
export async function mergeWorktree(batch: WorktreeBatch, slot: WorktreeSlot, memberName: string): Promise<MergeOutcome> {
  // 1. 有没有改动
  const st = await git(['status', '--porcelain'], slot.dir);
  if (!st.ok) {
    return { kind: 'failed', reason: (st.stderr || '读取 worktree 状态失败').trim() };
  }
  if (!st.stdout.trim()) {
    await cleanupSlot(batch.baseDir, slot);
    return { kind: 'clean', files: 0 };
  }

  // 2. 提交（改动属于 Agent 的执行过程，不评判内容）
  await git(['add', '-A'], slot.dir);
  const commit = await git(
    ['commit', '-m', `群聊汇合：${memberName}（${slot.branch}）`],
    slot.dir
  );
  if (!commit.ok) {
    return { kind: 'failed', reason: (commit.stderr || '提交改动失败').trim() };
  }

  // 3. 主区合并。--no-ff：汇合是「一次群聊的产出」这个事实，值得留一个节点
  const merge = await git(
    ['merge', '--no-ff', slot.branch, '-m', `群聊汇合：${memberName}`],
    batch.baseDir
  );
  if (!merge.ok) {
    // 区分「真冲突」与「没资格合并」（主区脏 / 不是 git 仓库）
    const conflictFiles = merge.stdout
      .split('\n')
      .filter(l => /^(CONFLICT|Both modified)/i.test(l.trim()))
      .map(l => l.trim());
    if (conflictFiles.length > 0) {
      await git(['merge', '--abort'], batch.baseDir);
      return { kind: 'conflict', files: conflictFiles, branch: slot.branch, dir: slot.dir };
    }
    return { kind: 'failed', reason: (merge.stderr || merge.stdout || '合并失败').trim() };
  }

  const files = await git(['diff', '--name-only', `${slot.branch}^1`, slot.branch], batch.baseDir);
  const count = files.ok ? files.stdout.split('\n').filter(Boolean).length : 0;

  // 4. 成功即清（分支与检出都不留残骸）
  await cleanupSlot(batch.baseDir, slot);
  return { kind: 'merged', files: count };
}

/** 删 worktree（目录一并删除）与分支。幂等：失败静默，反正在 tmp 里 */
async function cleanupSlot(baseDir: string, slot: WorktreeSlot): Promise<void> {
  await git(['worktree', 'remove', '--force', slot.dir], baseDir);
  await git(['branch', '-D', slot.branch], baseDir);
}

/** 整批清理（编排被中止 / 出错时兜底）。保留**有冲突**的槽位——那是用户要处理的现场 */
export async function cleanupWorktrees(batch: WorktreeBatch, keep: Set<string> = new Set()): Promise<void> {
  for (const slot of batch.slots.values()) {
    if (keep.has(slot.agentId)) continue;
    await cleanupSlot(batch.baseDir, slot);
  }
  // tmp 根目录顺手清掉（里面可能还剩失败成员的空壳）
  try {
    const shortId = batch.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
    await fsPromises.rm(path.join(os.tmpdir(), 'opc-worktrees', shortId), { recursive: true, force: true });
  } catch {
    /* 非关键路径 */
  }
}
