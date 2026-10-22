/**
 * A41 动态工作流单元验证。
 *
 * 全离线：用桩 deps（不碰任何真实 Agent），驱动 server/workflow.ts 的
 * 编译、沙箱、原语、超时与安全边界。vm 逃逸不做穷举测试，只验证
 * 「摸不到 Node 全局」这一条可断言的性质。
 *
 * 运行：npx tsx scripts/verify-a41.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'opc-a41-'));
process.env.OPC_DATA_DIR = TMP;

const w = await import('../server/workflow.js');

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(cond: boolean, name: string, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail += 1;
    fails.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

/** 桩：把每次调用记下来，按需返回内容 */
function makeDeps(overrides: Partial<w.WorkflowDeps> = {}) {
  const calls: Array<{ agentId: string; prompt: string; phase: string }> = [];
  const deps: w.WorkflowDeps = {
    members: ['a', 'b', 'c'],
    runAgent: async (agentId, prompt, phase) => {
      calls.push({ agentId, prompt, phase });
      return { text: `${agentId}的答复`, error: undefined };
    },
    note: () => {},
    ...overrides,
  };
  return { deps, calls };
}

// ── [1] 编译 ────────────────────────────────────────────────────────────
console.log('\n[1] 编译：TS → CJS 与错误行号');
{
  const bad = w.compileWorkflow('export default async function run(ctx) { const x: = 1 }');
  ok('error' in bad, '语法错误被捕获', 'error' in bad ? bad.error : '');
  ok(!('code' in bad), '失败时不返回 code');
}
ok('error' in w.compileWorkflow('   '), '空脚本报错');
{
  const good = w.compileWorkflow('export default async function run(ctx: any) { return 1; }');
  ok('code' in good, '正常脚本编译通过');
  if ('code' in good) ok(good.code.includes('async function'), '类型被擦除、函数保留');
  const typed = w.compileWorkflow(`
    interface Ctx { assign(id: string, task: string): Promise<{ text: string }> }
    export default async function run(ctx: Ctx): Promise<number> {
      const r = await ctx.assign('a', 'x');
      return r.text.length;
    }
  `);
  ok('code' in typed, '带类型注解的脚本也编译通过');
}

// ── [2] 入口形态 ────────────────────────────────────────────────────────
console.log('\n[2] 入口：必须有可执行导出');
{
  const r = await w.runWorkflow('const x = 1; export { x };', makeDeps().deps);
  ok(!r.ok, '只导出变量 → 报错（提示要导出函数）', r.error ?? '');
  ok(/export default async function/.test(r.error ?? ''), '错误信息给出正确写法');
}
{
  const r = await w.runWorkflow('export default async function run() { return 42; }', makeDeps().deps);
  ok(r.ok && r.output === 42, 'default 导出的函数被执行');
}
{
  const r = await w.runWorkflow('export async function run(ctx: any) { return "named"; }', makeDeps().deps);
  ok(r.ok && r.output === 'named', '命名 run 导出也认');
}

// ── [3] 原语：assign ────────────────────────────────────────────────────
console.log('\n[3] 原语 · assign');
{
  const { deps, calls } = makeDeps();
  const r = await w.runWorkflow(
    `export default async function run(ctx) {
       const one = await ctx.assign('a', '查一下连接池配置');
       return { text: one.text, agent: one.agentId };
     }`,
    deps
  );
  ok(r.ok, 'assign 跑通');
  ok(r.output && (r.output as any).agent === 'a', '返回 agentId');
  ok((r.output as any).text === 'a的答复', '返回正文');
  ok(calls.length === 1 && calls[0].prompt === '查一下连接池配置', 'prompt 原样下发');
  ok(calls[0].phase === 'work', 'phase=work');
  ok(r.steps.length === 1 && r.steps[0].name === 'assign' && r.steps[0].ok, 'step 被记录');
  ok(r.steps[0].args.includes('a') && r.steps[0].args.includes('连接池'), 'step.args 摘要含 agent 与任务');
}
{
  const r = await w.runWorkflow(
    `export default async function run(ctx) { return await ctx.assign('nope', 'x'); }`,
    makeDeps().deps
  );
  ok(!r.ok, '派给不在名单里的成员 → 报错', r.error ?? '');
  ok(/不在本会话可用名单/.test(r.error ?? ''), '报错列出可用成员');
  ok(r.steps[0].ok === false, '失败的 step 也记录');
}

// ── [4] 原语：broadcast / relay / debate ───────────────────────────────
console.log('\n[4] 原语 · broadcast / relay / debate');
{
  const { deps, calls } = makeDeps();
  const r = await w.runWorkflow(
    `export default async function run(ctx) {
       const all = await ctx.broadcast('评审这个方案');
       return all.map(x => x.agentId);
     }`,
    deps
  );
  ok(r.ok, 'broadcast 跑通');
  ok(JSON.stringify(r.output) === '["a","b","c"]', '全员并行', JSON.stringify(r.output));
  ok(calls.every(c => c.phase === 'broadcast'), 'phase=broadcast');
  ok(r.steps[0].name === 'broadcast', '记为一个 step（而不是三个）');
}
{
  const { deps, calls } = makeDeps();
  const r = await w.runWorkflow(
    `export default async function run(ctx) {
       const chain = await ctx.relay('起草需求文档');
       return chain.map(x => x.agentId);
     }`,
    deps
  );
  ok(r.ok, 'relay 跑通');
  ok(JSON.stringify(r.output) === '["a","b","c"]', '按成员顺序传递', JSON.stringify(r.output));
  ok(calls[1].prompt.includes('上一棒'), '第二棒的输入里带上第一棒结论');
  ok(calls[1].phase === 'relay', 'phase=relay');
}
{
  const { deps, calls } = makeDeps();
  const r = await w.runWorkflow(`export default async function run(ctx) { return await ctx.debate('该不该上微服务'); }`, deps);
  ok(r.ok, 'debate 跑通（复用编排层）', r.error ?? '');
  // 编排层：2 轮 × 2 方 + 1 次收敛
  ok(calls.length === 5, '按编排层协议发起 5 次发言', `实得 ${calls.length}`);
  ok((r.output as any).agentId === 'debate', '返回收敛后的正文');
}
{
  // 只有 1 位成员时编排层会退化为单独作答 —— 这是编排层的既定行为，工作流不该改
  const { deps, calls } = makeDeps({ members: ['solo'] });
  const r = await w.runWorkflow(`export default async function run(ctx) { await ctx.debate('x'); return null; }`, deps);
  ok(r.ok && calls.length === 1, '单成员 debate 退化为单独作答');
}

// ── [5] memory / log / note / members ──────────────────────────────────
console.log('\n[5] 原语 · memory / log / note / members');
{
  const { deps } = makeDeps({
    memorySearch: q => [{ key: 'k1', title: `${q} 的档案`, snippet: '片段' }],
  });
  const r = await w.runWorkflow(
    `export default async function run(ctx) {
       ctx.log('开始', 1, { a: 2 });
       const hits = ctx.memorySearch('登录');
       ctx.note('给用户看的一句话');
       return { count: hits.length, first: hits[0].title, members: ctx.members() };
     }`,
    deps
  );
  ok(r.ok, 'memorySearch/log/note/members 跑通');
  ok((r.output as any).count === 1, '命中 1 条');
  ok((r.output as any).first === '登录 的档案', '检索词透传');
  ok(JSON.stringify((r.output as any).members) === '["a","b","c"]', 'members() 返回副本');
  ok(r.logs.length === 1 && r.logs[0].startsWith('开始 1'), 'log 串接多参数', r.logs[0]);
}
{
  // 没给 memorySearch 实现时返回空数组，而不是抛错或假装有结果
  const r = await w.runWorkflow(
    `export default async function run(ctx) { return ctx.memorySearch('x').length; }`,
    makeDeps().deps
  );
  ok(r.ok && r.output === 0, '缺 memorySearch 实现 → 空结果，不假装');
}
{
  let noted = '';
  const r = await w.runWorkflow(
    `export default async function run(ctx) { ctx.note('看见我'); return 1; }`,
    makeDeps({ note: t => { noted = t; } }).deps
  );
  ok(r.ok && noted === '看见我', 'note 送达调用方');
}

// ── [6] 错误与超时 ─────────────────────────────────────────────────────
console.log('\n[6] 错误处理与超时');
{
  const r = await w.runWorkflow(
    `export default async function run(ctx) {
       try { await ctx.assign('a', 'x'); } catch (e) { ctx.log('捕获到', (e as Error).message); }
       return '继续跑';
     }`,
    makeDeps({
      runAgent: async () => { throw new Error('agent 炸了'); },
    }).deps
  );
  ok(r.ok && r.output === '继续跑', '原语抛错脚本可以 try/catch 兜住');
  ok(r.logs.some(l => l.includes('agent 炸了')), '错误信息进了日志');
  ok(r.steps[0].ok === false, '失败的 step 标记为失败');
}
{
  // 原语自身的截止时间刻意短于总超时：卡在原语里时不该等总超时
  const r = await w.runWorkflow(
    `export default async function run(ctx) { await ctx.assign('a', 'x'); return 1; }`,
    makeDeps({
      runAgent: () => new Promise(() => {}), // 永远不返回
    }).deps,
    { timeoutMs: 2000 }
  );
  ok(!r.ok, '原语不返回 → 原语级超时先炸', r.error ?? '');
  ok(/超过 \d+ms 未返回/.test(r.error ?? ''), '错误信息写明是哪个原语超时', r.error ?? '');
  ok(r.steps[0].ok === false, '超时的 step 记为失败');
}
{
  // 总超时（看门狗）路径：脚本卡在不经过原语的 await 上，
  // 只有总 deadline 能救场 —— 这时 timedOut 必须是真的
  const r = await w.runWorkflow(
    `export default async function run(ctx) { await new Promise(() => {}); return 1; }`,
    makeDeps().deps,
    { timeoutMs: 500 }
  );
  ok(!r.ok && r.timedOut, 'await 挂死 → 总超时兜底', r.error ?? '');
  ok(/工作流超过/.test(r.error ?? ''), '错误信息写明总超时', r.error ?? '');
}
{
  // 纯计算死循环由 vm 的 timeout 杀掉（不挑语言，就是杀不掉 await 空转的那个）
  const r = await w.runWorkflow(`export default async function run(ctx) { while (true) {} }`, makeDeps().deps, {
    timeoutMs: 1000,
  });
  ok(!r.ok, 'CPU 死循环被杀', r.error ?? '');
}

// ── [7] 沙箱边界 ───────────────────────────────────────────────────────
console.log('\n[7] 沙箱：摸不到 Node 全局');
{
  const attempts: Array<[string, string]> = [
    ['取 process', `typeof process`],
    ['取 Buffer', `typeof Buffer`],
    ['取 fetch', `typeof fetch`],
    ['从全局上摸 process', `(() => { try { return typeof (globalThis as any).process } catch { return 'blocked' } })()`],
  ];
  for (const [label, expr] of attempts) {
    const r = await w.runWorkflow(`export default async function run(ctx) { return ${expr}; }`, makeDeps().deps);
    ok(r.ok, `${label} → 脚本能跑完`);
    const val = String(r.output);
    ok(val === 'undefined' || val === 'blocked', `${label} 拿不到东西`, `得到 ${val}`);
  }
}
{
  // require 确实存在于沙箱里 —— 但它的全部作用就是抛一句人话
  // （不暴露它反而会让脚本报一个更难懂的 ReferenceError）
  const r = await w.runWorkflow(
    `export default async function run(ctx) { try { (require as any)('fs') } catch (e) { return 'threw' } return 'no-throw' }`,
    makeDeps().deps
  );
  ok(r.ok && r.output === 'threw', 'require 存在但只为抛人话');
}
{
  const r = await w.runWorkflow(
    `export default async function run(ctx) { const long = 'x'.repeat(400); ctx.log(long); return 1; }`,
    makeDeps().deps
  );
  ok(r.ok && r.logs[0].length <= 301, '超长内容在摘要处截断', `实得 ${r.logs[0].length} 字（上限 300 + 省略号）`);
}

// ── [8] 内置模板可用 ───────────────────────────────────────────────────
console.log('\n[8] 内置模板可用');
{
  const c = w.compileWorkflow(w.WORKFLOW_TEMPLATE);
  ok('code' in c, '模板能编译');
  // 模板里点名的成员要和桩对上，否则测的是「名单校验」而不是「模板」
  const r = await w.runWorkflow(
    w.WORKFLOW_TEMPLATE,
    makeDeps({ members: ['workbuddy', 'opencode'], memorySearch: () => [{ key: 'k', title: '当前迭代：登录改造', snippet: '' }] }).deps
  );
  ok(r.ok, '模板在桩上跑通', r.error ?? '');
  ok(r.steps.length >= 3, '模板确实调了多个原语', `${r.steps.length} 个 step`);
}

// ── [9] 打包依赖审计（A42 打包时踩出来的真事故）────────────────────────
console.log('\n[9] 运行时依赖审计：server 的裸引入必须都在 dependencies 里');
{
  // 事故回放：workflow.ts `import ts from 'typescript'`，而 typescript 当时在
  // devDependencies；electron 主进程打包用 `packages: 'external'`，运行时才
  // require —— 于是**开发态全绿、打包版一启动就崩**（卡在「注册完 Agent 后、
  // Web 就绪前」， verify:package 启动超时）。审计把这类事故变成确定性失败。
  const { execSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const repo = process.cwd(); // 仓库根：脚本总是从 opc-agent 目录跑
  const bare = new Set(
    execSync(
      `grep -rhoE "from '[a-z@][^'.][^']*'" server shared electron --include=*.ts || true`,
      { cwd: repo, encoding: 'utf8' }
    )
      .split('\n')
      .map(s => s.trim().replace(/^from '/, '').replace(/'$/, ''))
      .filter(Boolean)
      // `node:` 前缀是 Node 内置模块，走的是内置解析，不需要进 dependencies
      .filter(m => !m.startsWith('node:'))
  );
  const nodeBuiltins = new Set([
    'child_process', 'crypto', 'fs', 'fs/promises', 'http', 'https', 'tls', 'net',
    'os', 'path', 'stream', 'electron', 'url', 'events', 'util', 'buffer', 'zlib',
    'sqlite', 'vm', 'readline', 'string_decoder',
  ]);
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}));
  const missing = [...bare].filter(m => !nodeBuiltins.has(m) && !runtimeDeps.has(m));
  ok(missing.length === 0, 'server/shared/electron 的裸引入都在 dependencies 中', missing.length ? missing.join(', ') : '无缺失');
  ok(runtimeDeps.has('typescript'), 'typescript 在 dependencies（workflow.ts 编译要用）');
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✓' : '✗'} A41 动态工作流：${pass}/${pass + fail} 通过${fail ? `，失败：${fails.join('、')}` : ''}\n`);
process.exit(fail === 0 ? 0 : 1);
