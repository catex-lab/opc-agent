/**
 * A97 验证闭环的单元验证（纯函数 + 真实子进程，不启浏览器）。
 *
 * ## 这一层最容易出的错
 *
 * 不是「探测不到」，而是**探测到一条永远不返回的命令**：`test:watch` 被当成
 * 单元测试选中，界面转圈到用户放弃。所以本脚本里专门有一组断言：只有
 * watch/dev 类脚本时，必须一条都不给。
 *
 * 第二类错是**截断截错边**：测试失败的结论几乎总在输出末尾，只留头部等于把
 * 最有用的信息扔掉。big.js 那组断言就是在钉「尾部标记必须还在」。
 *
 * 运行：npx tsx scripts/verify-a97-verify.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectVerifyCommands } from '../server/verify-commands.js';
import { runVerifyCommand, DEFAULT_TIMEOUT_MS } from '../server/verify-runner.js';
import { hasFileEdits } from '../shared/trace.js';
import type { Block } from '../shared/blocks.js';

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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a97-'));

function fixture(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return dir;
}

const kinds = (r: ReturnType<typeof detectVerifyCommands>) => r.commands.map(c => c.kind).join(',');

const NODE = `"${process.execPath}"`;
function js(name: string, code: string): string {
  const p = path.join(ROOT, name);
  fs.writeFileSync(p, code, 'utf8');
  return p;
}

async function main() {
  console.log('\nA97 验证闭环 — 命令探测');

  // ── 1. node 项目：脚本名 → kind 映射 ──────────────────────────────
  const nodeFull = fixture('node-full', {
    'package.json': JSON.stringify(
      {
        scripts: {
          test: 'vitest run',
          'test:e2e': 'playwright test',
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          build: 'vite build',
          dev: 'vite',
        },
        devDependencies: { typescript: '^5.6.0' },
      },
      null,
      2
    ),
    'pnpm-lock.yaml': '',
  });
  {
    const r = detectVerifyCommands(nodeFull);
    ok(r.projectTypes.includes('node'), '识别出 node 项目', r.projectTypes.join('/'));
    ok(kinds(r) === 'test,typecheck,lint,build', '四种 kind 按 test→typecheck→lint→build 排序', kinds(r));
    // 同一 kind 只留一个，且精确匹配优先：test 赢过 test:e2e
    ok(r.commands[0]?.id === 'node:test:test', 'test 精确匹配优先于 test:e2e', r.commands[0]?.id);
    ok(!r.commands.some(c => c.command.includes('playwright')), 'test:e2e 没有被重复列出');
    // pnpm-lock.yaml 存在 → 用 pnpm，不加 run
    ok(r.commands[0]?.command === 'pnpm test', '包管理器取自 lock 文件（pnpm 不带 run）', r.commands[0]?.command);
    const build = r.commands.find(c => c.kind === 'build');
    ok(build?.weight === 'slow', 'build 标为 slow（前端默认不勾）', build?.weight);
    ok(r.commands.filter(c => c.kind !== 'build').every(c => c.weight === 'medium'), '非 build 标为 medium');
    // 有 typecheck 脚本时不该再提示「装了 typescript 却没脚本」
    ok(!r.notes.some(n => n.includes('没有 typecheck 脚本')), '已有 typecheck 时不产生噪音提示');
    ok(r.commands.every(c => c.source === 'package.json'), '来源标为 package.json');
    ok(new Set(r.commands.map(c => c.id)).size === r.commands.length, '命令 id 互不重复');
  }

  // ── 2. 只有 watch 脚本时必须一条都不给 ────────────────────────────
  {
    const r = detectVerifyCommands(
      fixture('node-watch-only', {
        'package.json': JSON.stringify({ scripts: { 'test:watch': 'vitest --watch', 'build': 'vite build' } }),
      })
    );
    ok(!r.commands.some(c => c.kind === 'test'), 'test:watch 不被当成可跑的测试', kinds(r));
    ok(kinds(r) === 'build', '同一份 package.json 里正常的 build 仍然保留', kinds(r));
    ok(!r.commands.some(c => /watch|dev|serve|start/i.test(c.command.split(' ').pop() ?? '')), '常驻脚本全部被过滤');
  }

  // ── 3. package.json 异常输入 ─────────────────────────────────────
  {
    const bad = detectVerifyCommands(fixture('node-bad-json', { 'package.json': '{ this is not json' }));
    ok(bad.commands.length === 0, '非法 JSON 不产出命令');
    ok(bad.notes.some(n => n.includes('解析失败')), '非法 JSON 给出解析失败提示', bad.notes[0]);

    const noScripts = detectVerifyCommands(fixture('node-no-scripts', { 'package.json': JSON.stringify({ name: 'x' }) }));
    ok(noScripts.notes.some(n => n.includes('没有 scripts')), '没有 scripts 时明确说明', noScripts.notes[0]);

    const tsOnly = detectVerifyCommands(
      fixture('node-ts-no-typecheck', {
        'package.json': JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { typescript: '^5' } }),
      })
    );
    ok(tsOnly.notes.some(n => n.includes('没有 typecheck 脚本')), '装了 TS 但没 typecheck 脚本时给出建议');
    ok(tsOnly.commands[0]?.command === 'npm run test', '无 lock 文件时回退 npm run', tsOnly.commands[0]?.command);

    // build 里已经跑了 tsc（本仓库自己的形态：build = "tsc -b && vite build"）
    // 这时再提示「加个 typecheck」就是噪音
    const tscInBuild = detectVerifyCommands(
      fixture('node-tsc-in-build', {
        'package.json': JSON.stringify({
          scripts: { build: 'tsc -b && vite build' },
          devDependencies: { typescript: '^5' },
        }),
      })
    );
    ok(
      !tscInBuild.notes.some(n => n.includes('没有 typecheck 脚本')),
      'build 里已跑 tsc 时不再提示补 typecheck（不制造噪音）',
      tscInBuild.notes.join('；') || '(无提示)'
    );
    ok(kinds(tscInBuild) === 'build', '仍然只列出 build 一条', kinds(tscInBuild));
  }

  // ── 4. 空目录 / 不存在的目录 / 传了个文件 ─────────────────────────
  {
    const empty = detectVerifyCommands(fixture('empty'));
    ok(empty.commands.length === 0 && empty.projectTypes.length === 0, '空目录：什么都认不出来');
    ok(empty.notes.some(n => n.includes('没有识别到')), '空目录给出「没识别到」而不是静默', empty.notes.at(-1));

    const missing = detectVerifyCommands(path.join(ROOT, 'definitely-not-here'));
    ok(missing.commands.length === 0, '目录不存在不抛错');
    ok(missing.notes.some(n => n.includes('工作目录不存在')), '目录不存在给出明确原因', missing.notes[0]);

    ok(detectVerifyCommands('').commands.length === 0, '空字符串 cwd 不抛错');
    // 传文件而不是目录：读 join(file,'package.json') 会 ENOTDIR
    const asFile = detectVerifyCommands(path.join(nodeFull, 'package.json'));
    ok(asFile.commands.length === 0, '把文件当目录传入不抛错');
  }

  // ── 5. python / rust / go ────────────────────────────────────────
  {
    const py = detectVerifyCommands(
      fixture('py', {
        'pyproject.toml': ['[tool.pytest.ini_options]', 'testpaths = ["tests"]', '[tool.mypy]', 'strict = true', '[tool.ruff]', 'line-length = 100'].join('\n'),
      })
    );
    ok(py.projectTypes.includes('python'), '识别出 python 项目');
    ok(kinds(py) === 'test,typecheck,lint', 'pytest / mypy / ruff 都被认出来', kinds(py));
    ok(py.commands[0]?.command === 'python -m pytest -q', 'pytest 用 -q 减少噪音', py.commands[0]?.command);

    const rust = detectVerifyCommands(fixture('rust', { 'Cargo.toml': '[package]\nname = "x"\n' }));
    ok(kinds(rust) === 'test,build', 'Cargo.toml → cargo test + cargo build', kinds(rust));

    const go = detectVerifyCommands(fixture('go', { 'go.mod': 'module x\n' }));
    ok(kinds(go) === 'test,build', 'go.mod → go test + go build', kinds(go));
  }

  // ── 6. Makefile：只认存在的 target，且不与主来源重复 ──────────────
  {
    const makeOnly = detectVerifyCommands(
      fixture('make-only', { Makefile: '.PHONY: test build\ntest:\n\techo t\nbuild:\n\techo b\n' })
    );
    ok(makeOnly.projectTypes.includes('make'), '只有 Makefile 时识别为 make 项目', makeOnly.projectTypes.join('/'));
    ok(kinds(makeOnly) === 'test,build', '只列出真实存在的 target', kinds(makeOnly));
    ok(makeOnly.commands.every(c => c.command.startsWith('make ')), '命令形如 make <target>');

    const makeNone = detectVerifyCommands(fixture('make-none', { Makefile: 'all:\n\techo hi\n' }));
    ok(makeNone.commands.length === 0, '没有目标时不给命令');
    ok(makeNone.notes.some(n => n.includes('没有 test/check/lint/build')), '说明「发现了 Makefile 但没有可用目标」');

    const both = detectVerifyCommands(
      fixture('node-plus-make', {
        'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        Makefile: 'test:\n\techo t\n',
      })
    );
    ok(!both.commands.some(c => c.command.startsWith('make ')), 'node 与 Makefile 并存时不重复列 make');
    ok(both.notes.some(n => n.includes('还发现了 Makefile')), '但会提示「Makefile 已忽略」', both.notes.at(-1));
  }

  // ── 7. 执行器：真实子进程 ────────────────────────────────────────
  console.log('\nA97 验证闭环 — 命令执行');

  const passJs = js('pass.js', 'process.exit(0)');
  const failJs = js('fail.js', "console.log('before-fail'); process.exit(3)");
  const outJs = js('out.js', "console.log('hello-verify')");
  const errJs = js('err.js', "console.error('err-line'); process.exit(1)");
  const envJs = js(
    'env.js',
    'process.stdout.write(`NO_COLOR=${process.env.NO_COLOR};CI=${process.env.CI};FORCE_COLOR=${process.env.FORCE_COLOR}`)'
  );
  const bigJs = js('big.js', "process.stdout.write('H'.repeat(1000) + 'x'.repeat(70000) + 'TAILMARK')");
  const sleepJs = js('sleep.js', 'setTimeout(() => {}, 10000)');

  {
    const r = await runVerifyCommand({ commandId: 'p', command: `${NODE} "${passJs}"`, cwd: ROOT });
    ok(r.status === 'pass', '退出码 0 → pass', r.status);
    ok(r.exitCode === 0, 'exitCode 记录为 0', String(r.exitCode));
    ok(r.commandId === 'p', '结果回带 commandId');
    ok(r.durationMs >= 0, 'durationMs 非负', `${r.durationMs}ms`);
    ok(r.truncated === false, '短输出不标截断');
  }

  {
    const r = await runVerifyCommand({ commandId: 'f', command: `${NODE} "${failJs}"`, cwd: ROOT });
    ok(r.status === 'fail', '退出码非 0 → fail', r.status);
    ok(r.exitCode === 3, '真实退出码被保留（不是笼统的 1）', String(r.exitCode));
    ok(r.hint?.includes('退出码 3') === true, 'hint 指明退出码', r.hint);
    ok(r.output.includes('before-fail'), '失败前已输出的内容被保留');
  }

  {
    const r = await runVerifyCommand({ commandId: 'e', command: `${NODE} "${errJs}"`, cwd: ROOT });
    ok(r.output.includes('err-line'), 'stderr 与 stdout 合并采集', r.output.trim());
  }

  {
    const r = await runVerifyCommand({ commandId: 'v', command: `${NODE} "${envJs}"`, cwd: ROOT });
    ok(r.output.includes('NO_COLOR=1'), '注入 NO_COLOR=1（报告里不留 ANSI 码）', r.output);
    ok(r.output.includes('FORCE_COLOR=0'), '注入 FORCE_COLOR=0');
    ok(r.output.includes('CI=1'), '注入 CI=1（避免交互式提问）');
  }

  {
    const r = await runVerifyCommand({ commandId: 'b', command: `${NODE} "${bigJs}"`, cwd: ROOT });
    ok(r.truncated === true, '超长输出标记 truncated', `${r.output.length} 字符`);
    ok(r.output.includes('中间省略'), '截断处有明确说明');
    ok(r.output.startsWith('H'), '头部被保留');
    // 这一条是整组的关键：失败结论在尾部，截掉尾巴等于扔掉答案
    ok(r.output.trimEnd().endsWith('TAILMARK'), '尾部标记仍在（失败结论不会被截掉）');
    ok(r.output.length < 72000, '总长度确实被压下来了', `${r.output.length} 字符`);
  }

  {
    const r = await runVerifyCommand({ commandId: 't', command: `${NODE} "${sleepJs}"`, cwd: ROOT, timeoutMs: 1200 });
    ok(r.status === 'timeout', '超时 → timeout', r.status);
    ok(r.exitCode === null, '超时无退出码');
    ok(r.hint?.includes('已终止') === true, 'hint 说明已终止', r.hint);
    ok(r.durationMs >= 1200, '超时等待时间符合设定', `${r.durationMs}ms`);
  }

  {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runVerifyCommand({ commandId: 'a', command: `${NODE} "${sleepJs}"`, cwd: ROOT, signal: ac.signal });
    ok(r.status === 'error', '用户取消 → error', r.status);
    ok(r.hint === '用户已取消', 'hint 区分「取消」与「失败」', r.hint);
  }

  {
    // AbortSignal 不会给后注册的监听器补发事件：只靠 addEventListener
    // 会让「传进来就已经取消」的情况照跑到底（实测过）。
    const ac = new AbortController();
    ac.abort();
    const r = await runVerifyCommand({ commandId: 'a2', command: `${NODE} "${passJs}"`, cwd: ROOT, signal: ac.signal });
    ok(r.status === 'error', '已 abort 的 signal 直接取消（不会照跑到底）', r.status);
    ok(r.hint === '用户已取消', '已 abort 时 hint 同样是取消', r.hint);
  }

  {
    const r = await runVerifyCommand({ commandId: 'x', command: 'definitely-not-a-real-command-xyz', cwd: ROOT });
    ok(r.status === 'fail' || r.status === 'error', '不存在的命令退化为 fail/error，不抛错', r.status);
    ok(typeof r.output === 'string', '无论如何都有字符串 output');
  }

  ok(DEFAULT_TIMEOUT_MS === 5 * 60 * 1000, '默认超时 5 分钟', String(DEFAULT_TIMEOUT_MS));

  // ── 8. hasFileEdits：决定要不要挂验证条 ──────────────────────────
  console.log('\nA97 验证闭环 — 是否挂载');

  const tool = (name: string): Block => ({
    id: `t-${name}`,
    type: 'tool',
    toolId: `tid-${name}`,
    name,
    status: 'completed',
    startedAt: 0,
  });
  const text = (s: string): Block => ({ id: `x-${s}`, type: 'text', text: s, state: 'done' });

  ok(hasFileEdits(undefined) === false, 'undefined → false');
  ok(hasFileEdits(null) === false, 'null → false');
  ok(hasFileEdits([]) === false, '空数组 → false');
  ok(hasFileEdits([text('只是说了句话')]) === false, '纯文本 → false（不制造噪音）');
  ok(hasFileEdits([tool('read'), tool('ReadFile')]) === false, '只读文件 → false');
  ok(hasFileEdits([tool('delete'), tool('deletefile')]) === false, '删除不算「改动需要验证」');
  ok(hasFileEdits([tool('bash')]) === false, 'bash 不在白名单内');
  ok(hasFileEdits([tool('edit')]) === true, 'edit → true');
  ok(hasFileEdits([tool('Write')]) === true, '大小写不敏感（Write → true）');
  ok(hasFileEdits([tool('multiedit')]) === true, 'multiedit → true');
  ok(hasFileEdits([tool('str_replace_editor')]) === true, 'str_replace_editor → true');
  ok(hasFileEdits([tool('create_file')]) === true, 'create_file → true');
  ok(hasFileEdits([text('先想'), tool('read'), text('再看'), tool('edit'), text('改完了')]) === true, '混杂序列里只要有一次写就为 true');

  // ── 汇总 ────────────────────────────────────────────────────────
  console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
  if (failures.length) process.exit(1);
}

main().catch(err => {
  console.error('脚本自身异常：', err);
  process.exit(1);
});
