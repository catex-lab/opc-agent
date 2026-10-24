/**
 * 项目验证命令探测（A97）。
 *
 * ## 解决什么问题
 *
 * 「Agent 说完成了」和「项目真的能跑」是两件事。之前这个项目里没有任何东西
 * 去验证后者 —— 用户只能自己开终端敲 `npm test`，然后把结果人工对照回聊天。
 * 这一层负责回答第一个问题：**这个项目有哪些可以自动跑的检查？**
 *
 * ## 为什么按「项目根目录」探测而不是全盘搜索
 *
 * 全盘找 `package.json` 会在 monorepo 里返回几十个结果，用户还得自己挑。
 * 这里只看 cwd 这一层，返回**能直接执行**的命令集合。monorepo 的场景留给
 * 后续版本（需要 workspace 解析），当前不做，也不假装做了。
 *
 * ## 为什么 package.json 优先且只取它
 *
 * 一个前端项目里同时存在 `package.json` 和 `Makefile` 很常见，但 `make test`
 * 通常只是 `npm test` 的包装 —— 两个都列出来会让用户以为有两条独立的验证路径。
 * 所以：**按项目类型取一个主来源**，其余只作为 note 提示「还发现了什么」。
 *
 * ## 不做什么
 *
 * - 不执行任何命令（那是 `verify-runner.ts` 的事，这里只读文件）
 * - 不猜命令（`scripts` 里没有 test 就不给 test，不塞一个 `npm test` 让它必然失败）
 */

import fs from 'node:fs';
import path from 'node:path';

export type VerifyKind = 'test' | 'build' | 'lint' | 'typecheck';

export interface VerifyCommand {
  /** 稳定 id（`<source>:<kind>:<script>`），前端 key 与去重用 */
  id: string;
  kind: VerifyKind;
  /** 人话标签 */
  label: string;
  /** 实际命令行 */
  command: string;
  /** 来源文件 */
  source: string;
  /** 预计耗时档位，UI 用来提示「这个可能要几分钟」 */
  weight: 'fast' | 'medium' | 'slow';
}

export interface DetectResult {
  /** 探测所用的目录（绝对路径） */
  cwd: string;
  /** 识别到的项目类型；空数组 = 什么都没认出来 */
  projectTypes: string[];
  commands: VerifyCommand[];
  /** 无法执行的观察（例如「发现了 Makefile，但它没有 test 目标」） */
  notes: string[];
}

/** 各 kind 的默认标签 */
const KIND_LABEL: Record<VerifyKind, string> = {
  test: '单元测试',
  build: '构建',
  lint: '代码检查',
  typecheck: '类型检查',
};

/** scripts 名 → kind。按顺序匹配，先中先得。 */
const SCRIPT_RULES: Array<{ re: RegExp; kind: VerifyKind }> = [
  { re: /^(test|tests|test:unit|unit|vitest|jest)$/i, kind: 'test' },
  { re: /^(test|tests)(:|$)/i, kind: 'test' },
  { re: /^(typecheck|type-check|tsc|check:types)$/i, kind: 'typecheck' },
  { re: /^(lint|eslint)$/i, kind: 'lint' },
  { re: /^lint(:|$)/i, kind: 'lint' },
  { re: /^build$/i, kind: 'build' },
];

/** 同一 kind 只保留一个：优先精确匹配（test 优于 test:e2e） */
function pickByKind(list: VerifyCommand[]): VerifyCommand[] {
  const seen = new Map<VerifyKind, VerifyCommand>();
  for (const c of list) {
    if (!seen.has(c.kind)) seen.set(c.kind, c);
  }
  // 固定顺序：test → typecheck → lint → build
  const order: VerifyKind[] = ['test', 'typecheck', 'lint', 'build'];
  return order.map(k => seen.get(k)).filter((c): c is VerifyCommand => !!c);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 包管理器：看 lock 文件，都没有就用 npm */
function packageManager(cwd: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (exists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

const RUN_PREFIX: Record<string, string> = {
  npm: 'npm run',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun run',
};

/** node 项目：读 package.json 的 scripts */
function detectNode(cwd: string, out: DetectResult): void {
  const file = path.join(cwd, 'package.json');
  const raw = readText(file);
  if (raw == null) return;

  let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    out.notes.push('package.json 解析失败（不是合法 JSON），已跳过');
    return;
  }
  out.projectTypes.push('node');

  const scripts = pkg.scripts ?? {};
  const names = Object.keys(scripts);
  if (names.length === 0) {
    out.notes.push('package.json 里没有 scripts');
    return;
  }

  const pm = packageManager(cwd);
  const prefix = RUN_PREFIX[pm];
  const found: VerifyCommand[] = [];

  for (const name of names) {
    const rule = SCRIPT_RULES.find(r => r.re.test(name));
    if (!rule) continue;
    // 跳过 watch / dev 这类常驻脚本 —— 它们不会自己退出，跑起来就是卡死
    if (/watch|dev|serve|start/i.test(name)) continue;
    found.push({
      id: `node:${rule.kind}:${name}`,
      kind: rule.kind,
      label: `${KIND_LABEL[rule.kind]}（${name}）`,
      command: `${prefix} ${name}`,
      source: 'package.json',
      weight: rule.kind === 'build' ? 'slow' : 'medium',
    });
  }

  out.commands.push(...pickByKind(found));

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  // 有些项目没有独立的 typecheck 脚本，但 build 里已经跑了 `tsc -b`
  // （本仓库自己就是这样：build = "tsc -b && vite build"）。这时候再提示
  // 「加个 typecheck」就是噪音 —— 类型检查其实一直都在跑。
  const anyScriptRunsTsc = Object.values(scripts).some(v => /\btsc\b/.test(v));
  if (!found.some(c => c.kind === 'typecheck') && deps.typescript && !anyScriptRunsTsc) {
    out.notes.push('装了 typescript 但没有 typecheck 脚本（可加 "typecheck": "tsc --noEmit"）');
  }
}

/** python 项目 */
function detectPython(cwd: string, out: DetectResult): void {
  const pyproject = readText(path.join(cwd, 'pyproject.toml'));
  const hasSetup = exists(path.join(cwd, 'setup.py')) || exists(path.join(cwd, 'setup.cfg'));
  const hasReqs = exists(path.join(cwd, 'requirements.txt'));
  if (pyproject == null && !hasSetup && !hasReqs) return;

  out.projectTypes.push('python');
  const text = pyproject ?? '';
  const src = pyproject != null ? 'pyproject.toml' : 'setup.py';

  if (/pytest|\[tool\.pytest/i.test(text) || exists(path.join(cwd, 'pytest.ini')) || exists(path.join(cwd, 'tests'))) {
    out.commands.push({
      id: 'python:test:pytest',
      kind: 'test',
      label: '单元测试（pytest）',
      command: 'python -m pytest -q',
      source: src,
      weight: 'medium',
    });
  }
  if (/\[tool\.mypy|mypy/i.test(text)) {
    out.commands.push({
      id: 'python:typecheck:mypy',
      kind: 'typecheck',
      label: '类型检查（mypy）',
      command: 'python -m mypy .',
      source: src,
      weight: 'slow',
    });
  }
  if (/\[tool\.ruff|ruff/i.test(text)) {
    out.commands.push({
      id: 'python:lint:ruff',
      kind: 'lint',
      label: '代码检查（ruff）',
      command: 'ruff check .',
      source: src,
      weight: 'fast',
    });
  }
}

/** rust 项目 */
function detectRust(cwd: string, out: DetectResult): void {
  if (!exists(path.join(cwd, 'Cargo.toml'))) return;
  out.projectTypes.push('rust');
  out.commands.push(
    { id: 'rust:test', kind: 'test', label: '单元测试（cargo test）', command: 'cargo test', source: 'Cargo.toml', weight: 'slow' },
    { id: 'rust:build', kind: 'build', label: '构建（cargo build）', command: 'cargo build', source: 'Cargo.toml', weight: 'slow' }
  );
}

/** go 项目 */
function detectGo(cwd: string, out: DetectResult): void {
  if (!exists(path.join(cwd, 'go.mod'))) return;
  out.projectTypes.push('go');
  out.commands.push(
    { id: 'go:test', kind: 'test', label: '单元测试（go test）', command: 'go test ./...', source: 'go.mod', weight: 'medium' },
    { id: 'go:build', kind: 'build', label: '构建（go build）', command: 'go build ./...', source: 'go.mod', weight: 'medium' }
  );
}

/** Makefile：只认明确存在的 target，不假设 */
function detectMake(cwd: string, out: DetectResult): void {
  const raw = readText(path.join(cwd, 'Makefile'));
  if (raw == null) return;
  const targets = [...raw.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map(m => m[1]);
  const wanted: Array<[string, VerifyKind]> = [
    ['test', 'test'],
    ['check', 'lint'],
    ['lint', 'lint'],
    ['build', 'build'],
  ];
  const found = wanted.filter(([t]) => targets.includes(t));
  if (found.length === 0) {
    out.notes.push(`发现了 Makefile，但没有 test/check/lint/build 目标（现有：${targets.slice(0, 6).join(', ') || '无'}）`);
    return;
  }
  // 已经有主来源的命令时不重复列 make（它多半只是包装）
  if (out.commands.length > 0) {
    out.notes.push(`还发现了 Makefile（${found.map(f => f[0]).join('/')}），已忽略以免与主来源重复`);
    return;
  }
  out.projectTypes.push('make');
  for (const [target, kind] of found) {
    out.commands.push({
      id: `make:${kind}:${target}`,
      kind,
      label: `${KIND_LABEL[kind]}（make ${target}）`,
      command: `make ${target}`,
      source: 'Makefile',
      weight: 'medium',
    });
  }
}

/**
 * 探测一个目录下可执行的验证命令。
 * 永不抛错：任何读文件失败都退化为「没探测到」。
 */
export function detectVerifyCommands(cwd: string): DetectResult {
  const out: DetectResult = { cwd, projectTypes: [], commands: [], notes: [] };
  if (!cwd || !fs.existsSync(cwd)) {
    out.notes.push('工作目录不存在，无法探测');
    return out;
  }

  // 顺序有意义：node 优先，Make 最后（它常是包装）
  detectNode(cwd, out);
  detectPython(cwd, out);
  detectRust(cwd, out);
  detectGo(cwd, out);
  detectMake(cwd, out);

  if (out.commands.length === 0) {
    out.notes.push('没有识别到可自动执行的检查命令');
  }
  return out;
}
