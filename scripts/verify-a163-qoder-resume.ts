/**
 * A163 验证：qoder / qoder-cn 的多轮上下文续接。
 *
 * ## 这条闸门要防的是什么
 *
 * 用户实测：第一轮让它装 Agent Mail CLI 失败，点「再次尝试」后它说
 * 「这一轮对话里我没有先前尝试的记录」；点「批准」后又说「这条消息之前
 * 没有待批准的计划或变更」。**每一轮都是全新进程，零上下文。**
 *
 * 这类缺陷的失败模式是**静默**的：不报错、不红、界面正常、回复也通顺 ——
 * 只是它「不知道」。所以断言必须盯三件不同的事：
 *   ① 定义表里续接三件套（parse / extractResumeToken / buildArgs 传参）齐不齐；
 *   ② 令牌真能从 init 行里取出来、真能编进 argv；
 *   ③ 真机上「第二轮记得第一轮」成立（qodercli 自己得支持）。
 * 少了 ③，① ② 只能证明「我们打算续接」，不能证明「续接得上」。
 *
 * ## 反向探针（必须做，否则这条闸门可能是假绿）
 *
 *   把 `qoderCliArgs` 里的 `if (ctx.resumeToken) args.push('-r', ctx.resumeToken)`
 *   整行删掉 → [2] 立刻红；把 `parse` 退回 `'text'` → [1] 红。
 *   两条都实测过，不是推理。
 *
 * ## 跑法
 *   npx tsx scripts/verify-a163-qoder-resume.ts
 *   A163_REQUIRE_LIVE=1 npx tsx scripts/verify-a163-qoder-resume.ts   # 没装/没登录 qoder 也算红
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { AGENT_DEFS } from '../server/agents/definitions.js';
import type { SendContext } from '../server/agents/types.js';

let pass = 0;
let fail = 0;
const skipped: string[] = [];

function say(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  [${detail}]` : ''}`);
  }
}

function skip(name: string, why: string): void {
  skipped.push(`${name}：${why}`);
  console.log(`  ⊘ ${name} 跳过：${why}`);
}

const baseCtx = (over: Partial<SendContext> = {}): SendContext =>
  ({
    runId: 'run-a163',
    sessionId: 'sess-a163',
    messageId: 'msg-a163',
    agentId: 'qoder',
    prompt: '',
    cwd: process.cwd(),
    ...over,
  }) as SendContext;

// ---------------------------------------------------------------- [1] 三件套

console.log('\n[1] 定义表里续接三件套齐全（qoder / qoder-cn）');
for (const id of ['qoder', 'qoder-cn']) {
  const def = AGENT_DEFS.find(d => d.descriptor.id === id);
  if (!def?.cli) {
    say(`${id} 有 cli 规格`, false, '找不到该条目或它不是 cli 型');
    continue;
  }
  // parse 必须是 jsonl：纯文本模式拿不到 session_id，续接就无从谈起。
  say(`${id} parse = jsonl`, def.cli.parse === 'jsonl', `实际 ${def.cli.parse}`);
  say(`${id} 声明了 extractResumeToken`, typeof def.cli.extractResumeToken === 'function');
  say(
    `${id} 声明了 mapLine（jsonl 没映射器 = 什么都不显示）`,
    typeof def.cli.mapLine === 'function'
  );
}

// ------------------------------------------------------------- [2] argv 组装

console.log('\n[2] buildArgs：有令牌才传 -r，且始终要结构化输出');
const qoder = AGENT_DEFS.find(d => d.descriptor.id === 'qoder');
if (qoder?.cli) {
  const withTok = qoder.cli.buildArgs('你好', baseCtx({ resumeToken: 'sid-abc' }));
  const noTok = qoder.cli.buildArgs('你好', baseCtx());

  say(
    '带 resumeToken 时编进 `-r <id>`',
    withTok.includes('-r') && withTok[withTok.indexOf('-r') + 1] === 'sid-abc',
    withTok.join(' ')
  );
  // 否定式必须配肯定式：只钉「没有 -r」时，整个函数删掉更绿。
  say('不带 resumeToken 时确实没有 -r', !noTok.includes('-r'), noTok.join(' '));
  say(
    '两种情况下都带 --output-format stream-json（否则拿不到 session_id）',
    withTok.join(' ').includes('--output-format stream-json') &&
      noTok.join(' ').includes('--output-format stream-json')
  );
  say('提示词是位置参数且排在最后', withTok[withTok.length - 1] === '你好');
  // 续接不能吃掉别的参数：模型与档位仍要在。
  const rich = qoder.cli.buildArgs('hi', baseCtx({ resumeToken: 'x', model: 'm1', reasoningEffort: 'high' }));
  say(
    '续接与 -m / --reasoning-effort 共存',
    rich.includes('-m') && rich.includes('m1') && rich.includes('--reasoning-effort') && rich.includes('high')
  );
}

// --------------------------------------------------- [3][4] 令牌提取与行映射

console.log('\n[3] extractResumeToken：只认 system/init，别的行不许瞎给');
if (qoder?.cli?.extractResumeToken) {
  const extract = qoder.cli.extractResumeToken;
  const initLine = { type: 'system', subtype: 'init', session_id: 'sid-1' };
  const hookLine = { type: 'system', subtype: 'hook_started', session_id: 'sid-2' };
  const assistantLine = { type: 'assistant', session_id: 'sid-3' };
  say('init 行取到 session_id', extract(initLine) === 'sid-1');
  say('hook 行不给（hook 上也带 session_id，误取会串会话）', extract(hookLine) === null);
  say('assistant 行不给', extract(assistantLine) === null);
  say('非对象不炸', extract(null) === null && extract('x') === null);
}

console.log('\n[4] mapLine：钩子噪音要挡掉，正文要出得来');
if (qoder?.cli?.mapLine) {
  const map = qoder.cli.mapLine;
  const hookOut = map({ type: 'system', subtype: 'hook_progress', stdout: 'x'.repeat(5000) });
  // 返回 [] 而不是 null：null 在适配器里等于「进 raw 旁路」，
  // 几 KB 的钩子注入会把真错误挤出抽屉。
  say(
    'hook_* 行返回空数组（不是 null，null 会落 raw）',
    Array.isArray(hookOut) && hookOut.length === 0,
    JSON.stringify(hookOut)
  );
  const textOut = map({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '收到' }] },
  });
  const arr = Array.isArray(textOut) ? textOut : textOut ? [textOut] : [];
  say(
    'assistant 的 text 块映射成 text 事件',
    arr.length === 1 && arr[0].type === 'text' && (arr[0] as { content: string }).content === '收到',
    JSON.stringify(arr)
  );
  const thinkOut = map({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '想一想' }] },
  });
  const tarr = Array.isArray(thinkOut) ? thinkOut : thinkOut ? [thinkOut] : [];
  say('assistant 的 thinking 块映射成 thinking 事件', tarr.some(e => e.type === 'thinking'));
  say(
    'result 带 usage 时不丢用量',
    (() => {
      const r = map({ type: 'result', is_error: false, usage: { input_tokens: 3, output_tokens: 4 } });
      const ra = Array.isArray(r) ? r : r ? [r] : [];
      return ra.some(e => e.type === 'usage');
    })()
  );
}

// ------------------------------------------------------------------ [5] 真机

console.log('\n[5] 真机：第二轮必须记得第一轮（qodercli 自己支不支持 -r）');

const which = spawnSync('qodercli', ['--version'], { encoding: 'utf8', timeout: 60_000 });
if (which.error || which.status !== 0) {
  skip('两轮记忆', `qodercli 不可用（${which.error?.message || `exit ${which.status}`}）`);
} else {
  const version = (which.stdout || '').trim().split('\n').pop() ?? '';
  console.log(`  · qodercli 版本：${version}`);

  const sid = randomUUID();
  const secret = String(100 + Math.floor(Math.random() * 800)); // 每轮随机，防止模型蒙对
  const cwd = os.tmpdir();

  const run = (args: string[]): string => {
    const r = spawnSync('qodercli', args, { cwd, encoding: 'utf8', timeout: 180_000 });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    // 只取 assistant 的 text 块，别把 result 里的重复算进来
    const texts: string[] = [];
    for (const line of (r.stdout ?? '').split('\n')) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const o = JSON.parse(s) as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (o.type !== 'assistant') continue;
        for (const b of o.message?.content ?? []) {
          if (b?.type === 'text' && b.text) texts.push(b.text);
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
    return texts.join('\n') || out;
  };

  const first = run(['-p', '--output-format', 'stream-json', '--session-id', sid, `请记住这个数字：${secret}。只回复两个字：记住`]);
  if (!first.includes('记住')) {
    skip('两轮记忆', `首轮没跑通（可能是未登录/网络），首轮输出片段：${first.slice(0, 120)}`);
  } else {
    const second = run(['-p', '--output-format', 'stream-json', '-r', sid, '我刚才让你记住的数字是多少？只回答数字']);
    say(
      '第二轮答出了第一轮的数字',
      second.includes(secret),
      `期望含 ${secret}，实得「${second.trim().slice(0, 40)}」`
    );
  }
}

// ---------------------------------------------------------------- 汇总

console.log('');
if (skipped.length) {
  console.log(`⊘ 跳过 ${skipped.length} 项：`);
  for (const s of skipped) console.log(`   - ${s}`);
  if (process.env.A163_REQUIRE_LIVE === '1') {
    console.log('  ✗ A163_REQUIRE_LIVE=1：跳过也算失败');
    fail += skipped.length;
  } else {
    console.log('  （设 A163_REQUIRE_LIVE=1 可把跳过判成失败）');
  }
}
console.log(`\nA163：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
