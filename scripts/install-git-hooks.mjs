#!/usr/bin/env node
/**
 * 把仓库的 git 钩子指向 `.githooks/`。
 *
 * 为什么不用 `.git/hooks/`：那个目录不进版本库，每台机器、每次重新 clone
 * 都得手动拷一遍 —— 拷贝这件事一定会被忘掉，然后大家以为自己有扫描保护。
 * 用 `core.hooksPath` 指向版本化的目录，钩子本身随代码一起走。
 *
 * 幂等：重复跑没有副作用。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HOOKS_DIR = '.githooks';
const HOOKS = ['pre-commit'];

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function main() {
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']);
  } catch {
    console.error('✗ 当前目录不是 git 仓库，无法安装钩子');
    return 1;
  }

  const missing = HOOKS.filter(h => !existsSync(path.join(root, HOOKS_DIR, h)));
  if (missing.length) {
    console.error(`✗ ${HOOKS_DIR}/ 里缺少钩子文件：${missing.join(', ')}`);
    return 1;
  }

  git(['config', 'core.hooksPath', HOOKS_DIR], { cwd: root });

  const current = git(['config', '--get', 'core.hooksPath'], { cwd: root });
  if (current !== HOOKS_DIR) {
    console.error(`✗ 设置后读回不一致：期望 ${HOOKS_DIR}，实际 ${current}`);
    return 1;
  }

  console.log(`✓ core.hooksPath = ${current}`);
  console.log(`  已启用：${HOOKS.join(', ')}（提交前扫描密钥）`);
  console.log('  跳过单次扫描：git commit --no-verify');
  return 0;
}

process.exit(main());
