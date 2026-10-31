/**
 * A158：OpenCode SDK 的**不予接入**决策闸门。
 *
 * ## 为什么会有一条「不接入」的闸门
 *
 * 本轮排查的结论不是「没时间做」，而是「装了也用不了」。证据（2026-10-30 实测）：
 *
 *   1. `createOpencodeServer()` 对已装 `opencode v2.0.25` **永远超时**：
 *      SDK（1.19.5）等的是 `"opencode server listening"`，实际输出
 *      `"server listening on http://127.0.0.1:PORT"` + `server password ...`；
 *   2. v2.0.25 的 API 挂在 `/api/*` 且默认要 Basic Auth（裸 `/session` 返回
 *      HTML，无密码 401）；
 *   3. SDK 生成的客户端路由与 2.0.25 不匹配：
 *      `POST /api/session/{id}/message` → 404；
 *      `POST /api/session/{id}/prompt` → 400 `Missing key at ["text"]`；
 *   4. `client.provider.list()` 返回空 `data: []`（本机已配多家 provider Key）。
 *
 * 所以 opencode 继续走 CLI 通道（`kind:'cli'`），直到官方发布与 2.x 匹配的
 * SDK。这条闸门钉住的是「别悄悄接上一个必然坏的通道」，也钉住「将来要切换
 * 时，必须同时更新本闸门」—— 不让半截接线混进来。
 *
 * 运行：npm run verify:a158-opencode-sdk
 */
import fs from 'node:fs';
import path from 'node:path';
import { findDef } from '../server/agents/definitions.js';
import { createProvider, CliAdapter } from '../server/agents/adapters/index.js';

const ROOT = process.cwd();

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/**
 * 去掉注释后的源码行。
 *
 * 为什么必须去：本轮在 definitions.ts 的 opencode 条目里写了「**不接**
 * `@opencode-ai/sdk`」的说明注释 —— 直接按子串搜包名会把注释算成 import，
 * 让「零 import」的断言永远红。
 */
function codeLines(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

// ───────────────────── [1] 定义层：opencode 仍是 CLI ─────────────────────
console.log('\n[1] 定义层：opencode 保持 CLI 通道');
{
  const def = findDef('opencode');
  ok(def?.descriptor.kind === 'cli', 'opencode → kind=cli', String(def?.descriptor.kind));
  ok(def?.sdk === undefined, '★ opencode 没有 sdk 规格（不半接线）');
  ok(def?.cli && typeof def.cli.buildArgs === 'function', 'CLI 规格完整');

  const provider = def ? createProvider(def) : undefined;
  ok(provider instanceof CliAdapter, '工厂返回 CliAdapter');
}

// ───────────────────── [2] 源码契约：没有 OPENCODE SDK 的接线痕迹 ─────────────────────
console.log('\n[2] 源码契约：未接入的 SDK 不留下半截接线');
{
  const defs = read('server/agents/definitions.ts');
  // SdkSpec 的类型联合里保留 'opencode'（将来换 SDK 只需改定义表），
  // 但**任何条目**都不得写成 provider: 'opencode'
  ok(!/provider:\s*'opencode'/.test(defs),
    '★ 定义表中没有任何条目声明 provider=opencode');
  ok(/provider\?:\s*'tencent'.*'opencode'/.test(defs),
    'SdkSpec 类型保留 opencode 取值（将来切换只改定义表）');

  const serverFiles: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        if (name !== 'node_modules' && name !== 'data') walk(p);
        continue;
      }
      if (/\.(ts|tsx)$/.test(name)) serverFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'server'));
  walk(path.join(ROOT, 'src'));

  const importers = serverFiles.filter(f =>
    codeLines(read(path.relative(ROOT, f))).some(l => l.includes('@opencode-ai/sdk'))
  );
  ok(importers.length === 0,
    '★ 前后端没有任何文件 import @opencode-ai/sdk',
    importers.length ? importers.slice(0, 2).join(' | ') : '0 处');

  /* 依赖本身**不在** package.json 里（2026-10-31 开源前清理）。
     原来这条断言是「依赖保留供排查记录」—— 但那个包从未被任何文件 import，
     留着只是让安装包多背 914KB 与一条 cross-spawn 传递依赖。
     排查结论已经完整写在文件头与 definitions.ts 的注释里，不需要靠装一个包来记。
     否定式配肯定式：上面「零 import」+ 这里「零依赖」，两边都成立才算没半截接线。 */
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  ok(!pkg.dependencies?.['@opencode-ai/sdk'] && !pkg.devDependencies?.['@opencode-ai/sdk'],
    '★ 依赖已移除（不再白占安装包；结论记在注释里而不是记在 node_modules 里）',
    pkg.dependencies?.['@opencode-ai/sdk'] ?? '已移除');
}

console.log(`\n${failures.length ? '✗' : '✓'} A158 OpenCode SDK 决策（保持 CLI）：${pass}/${pass + fail} 通过`);
if (failures.length) {
  console.log('失败项：\n' + failures.map(f => `  · ${f}`).join('\n'));
  process.exit(1);
}
