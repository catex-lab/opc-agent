/**
 * 黄金样本采集工具（P3，手工在开发机上运行）。
 *
 * 用法：npx tsx scripts/record-golden.ts <agentId> [--prompt "…"] [--timeout 秒]
 *
 * 它做四件事：
 *   1. 用定义表的 buildArgs 拉起**真实 CLI**（一次真实调用，花一点额度）；
 *   2. 逐行捕获原始 stdout / stderr；
 *   3. 用当前解析代码产出事件序列，作为**期望**写进样本；
 *   4. 落盘 fixtures/golden/<agentId>-<cliVersion>.jsonl。
 *
 * 安全边界：prompt 默认明示「不要调用任何工具」，permissionMode 用 default
 * （不 bypass——权限请求会挂住，采集工具用超时兜底并如实报错）。
 * 需要 Agent 已安装且已登录（它就是一次真实调用）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../server/agents/probe.js';
import { findDef } from '../server/agents/definitions.js';
import { feedLines, type GoldenLine } from './golden-lib.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'fixtures', 'golden');

const agentId = process.argv[2];
if (!agentId) {
  console.error('用法：npx tsx scripts/record-golden.ts <agentId> [--prompt "…"] [--timeout 60]');
  process.exit(2);
}
const promptIdx = process.argv.indexOf('--prompt');
const prompt = promptIdx >= 0 ? process.argv[promptIdx + 1]! : '用一句中文介绍你自己。不要调用任何工具。';
const timeoutIdx = process.argv.indexOf('--timeout');
const budgetMs = (timeoutIdx >= 0 ? Number(process.argv[timeoutIdx + 1]) : 60) * 1000;

const def = findDef(agentId);
if (!def?.cli) {
  console.error(`未找到 ${agentId} 的 CLI 通道（只有 CLI 类 Agent 需要解析回放）`);
  process.exit(2);
}
if (def.cli.parse === 'text') {
  console.error('text 通道没有结构化解析，无需回放（它的失败形态由 canary 覆盖）');
  process.exit(2);
}

const bin = findExecutable(def.cli.bin, [], def.cli.binExts ?? []);
if (!bin) {
  console.error(`本机找不到 ${JSON.stringify(def.cli.bin)}——先安装再采集`);
  process.exit(2);
}

// 最小 ctx：会话 id 固定为 golden（CLI 侧会产生它自己的会话文件，量级可忽略）
const ctx = {
  sessionId: 'golden',
  prompt,
  cwd: process.cwd(),
  permissionMode: 'default' as const,
};
const args = def.cli.buildArgs(prompt, ctx);

console.log(`[record] ${agentId}: ${bin} ${args.join(' ').slice(0, 120)}…`);

const lines: GoldenLine[] = [];
let stdoutBuf = '';
let stderrBuf = '';
let timedOut = false;

const child = spawn(bin, args, { cwd: process.cwd(), shell: false, windowsHide: true });
const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, budgetMs);

child.stdout!.on('data', (chunk: Buffer) => {
  stdoutBuf += chunk.toString('utf8');
  const parts = stdoutBuf.split(/\r?\n/);
  stdoutBuf = parts.pop() ?? '';
  for (const line of parts) lines.push({ dir: 'stdout', line });
});
child.stderr!.on('data', (chunk: Buffer) => {
  stderrBuf += chunk.toString('utf8');
  const parts = stderrBuf.split(/\r?\n/);
  stderrBuf = parts.pop() ?? '';
  for (const line of parts) lines.push({ dir: 'stderr', line });
});

const version = await new Promise<string>(resolve => {
  const v = spawn(bin, ['--version'], { shell: false, windowsHide: true });
  let out = '';
  const t = setTimeout(() => {
    v.kill();
    resolve('');
  }, 8000);
  v.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
  v.on('close', () => {
    clearTimeout(t);
    resolve(out.trim().split(/\r?\n/)[0] ?? '');
  });
  v.on('error', () => {
    clearTimeout(t);
    resolve('');
  });
});

child.on('close', code => {
  clearTimeout(timer);
  if (stdoutBuf) lines.push({ dir: 'stdout', line: stdoutBuf });
  if (stderrBuf) lines.push({ dir: 'stderr', line: stderrBuf });

  const fed = feedLines(def, lines);
  if (!fed) {
    console.error('解析层不可用（非 jsonl/json-object）');
    process.exit(2);
  }

  const cliVersion = version || 'unknown';
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${agentId}-${cliVersion}.jsonl`);

  const out: string[] = [];
  out.push(
    JSON.stringify({
      golden: 1,
      agent: agentId,
      cliVersion,
      recordedAt: new Date().toISOString(),
      prompt,
      parse: def.cli!.parse,
      ...(timedOut ? { note: `采集超时（${Math.round(budgetMs / 1000)}s）被截断` } : {}),
    })
  );
  for (const l of lines) out.push(JSON.stringify(l));
  out.push(
    JSON.stringify({
      expect: { eventTypes: fed.eventTypes, resumeToken: fed.resumeToken, stderrLines: fed.stderrLines },
    })
  );
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');

  console.log(`[record] 退出码 ${code}${timedOut ? '（超时截断）' : ''}`);
  console.log(`[record] 原始行 ${lines.length} 条，事件序列 [${fed.eventTypes.join(', ')}]，续接令牌 ${fed.resumeToken}`);
  console.log(`[record] 已写入 ${file}`);
  if (fed.eventTypes.length === 0) {
    console.error('[record] 警告：没有解析出任何事件——检查 CLI 是否真的登录/可用');
    process.exit(1);
  }
});
