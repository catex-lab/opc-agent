/**
 * A129 纯函数验收：地址归一化、按方言拼 URL、厂商输入校验。
 *
 * 这三件事是「界面显示的地址」与「真正请求的地址」之间唯一的桥。它们错了
 * 不会抛异常，只会变成一个 404 —— 所以必须单独锁住边界值，而不是只在
 * e2e 里跑一遍 Happy Path。
 *
 * 运行：npx tsx scripts/verify-a129-url.ts
 */

import {
  chatUrlOf,
  dialectLabel,
  modelsUrlOf,
  normalizeBaseUrl,
} from '../shared/providerUrl.js';
import { normalizeCustomInput } from '../server/agents/customAgents.js';

let total = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string, detail?: unknown) {
  total++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

console.log('\nA129 地址与校验纯函数');

// ── normalizeBaseUrl ─────────────────────────────────────────────
ok(normalizeBaseUrl('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1',
  '去掉尾斜杠');
ok(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1',
  '剥掉 OpenAI 完整端点');
ok(normalizeBaseUrl('https://api.anthropic.com/v1/messages') === 'https://api.anthropic.com/v1',
  '剥掉 Anthropic /messages');
ok(
  normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent') ===
    'https://generativelanguage.googleapis.com/v1beta',
  '剥掉 Gemini 的模型路径'
);
ok(normalizeBaseUrl('https://x.com/v1/models') === 'https://x.com/v1', '剥掉 /models');
ok(normalizeBaseUrl('  ') === '', '空白归一化为空串');
ok(normalizeBaseUrl('http://localhost:11434/v1') === 'http://localhost:11434/v1',
  '不带版本段的本地地址原样保留');

// 顺序陷阱：/chat/completions 必须先于 /completions 匹配
ok(normalizeBaseUrl('https://x.com/v1/chat/completions') === 'https://x.com/v1',
  '/chat/completions 不会被剥成 /v1/chat');

// ── modelsUrlOf ──────────────────────────────────────────────────
ok(modelsUrlOf('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1/models',
  '模型清单地址拼一次 /models');

// ── chatUrlOf ────────────────────────────────────────────────────
ok(chatUrlOf('https://api.deepseek.com/v1', 'openai', 'deepseek-chat') ===
  'https://api.deepseek.com/v1/chat/completions', 'OpenAI 对话地址');
ok(chatUrlOf('https://api.anthropic.com/v1', 'anthropic', 'claude-x') ===
  'https://api.anthropic.com/v1/messages', 'Anthropic 对话地址');
ok(chatUrlOf('https://gen/v1beta', 'gemini', 'gemini-2.5-pro') ===
  'https://gen/v1beta/models/gemini-2.5-pro:generateContent', 'Gemini 非流式地址');
ok(chatUrlOf('https://gen/v1beta', 'gemini', 'gemini-2.5-pro', true) ===
  'https://gen/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', 'Gemini 流式地址');
ok(chatUrlOf('https://gen/v1beta', 'gemini', 'a/b') ===
  'https://gen/v1beta/models/a%2Fb:generateContent', 'Gemini 模型名做 URL 编码');
ok(chatUrlOf('https://x/v1', 'openai', '') === 'https://x/v1/chat/completions',
  '空模型不影响 OpenAI 地址');

// ── dialectLabel ─────────────────────────────────────────────────
ok(dialectLabel('openai') === 'OpenAI Chat', 'openai 显示名');
ok(dialectLabel('anthropic') === 'Anthropic Messages', 'anthropic 显示名');
ok(dialectLabel('gemini') === 'Gemini', 'gemini 显示名');

// ── normalizeCustomInput ─────────────────────────────────────────
const good = normalizeCustomInput({
  name: ' 商汤 ',
  baseUrl: 'https://token.sensenova.cn/v1/',
  dialect: 'openai',
  models: ['sensenova-6.8-flash-lite', 'sensenova-6.8-flash-lite', ' deepseek-v4 '],
});
ok(good.ok === true, '合法输入通过');
ok(good.ok && good.value.name === '商汤', '名称去空白');
ok(good.ok && good.value.baseUrl === 'https://token.sensenova.cn/v1', '地址归一化');
ok(good.ok && good.value.models.join() === 'sensenova-6.8-flash-lite,deepseek-v4',
  '模型去重并去空白');

const legacy = normalizeCustomInput({
  name: '旧格式',
  baseUrl: 'https://x/v1',
  model: 'legacy-model',
});
ok(legacy.ok === true && legacy.value.models.join() === 'legacy-model',
  '单数 model 仍然接受（A114 数据兼容）');
ok(legacy.ok && legacy.value.dialect === 'openai', '缺方言时默认 openai');

const multiline = normalizeCustomInput({
  name: '多行',
  baseUrl: 'https://x/v1',
  models: 'a\nb, c',
});
ok(multiline.ok === true && multiline.value.models.join() === 'a,b,c', '换行/逗号字符串拆成清单');

ok(normalizeCustomInput({ name: '', baseUrl: 'https://x/v1', models: ['m'] }).ok === false,
  '空名称拒绝');
ok(
  normalizeCustomInput({ name: '名'.repeat(21), baseUrl: 'https://x/v1', models: ['m'] }).ok === false,
  '超长名称拒绝'
);
ok(normalizeCustomInput({ name: 'n', baseUrl: 'ftp://x/v1', models: ['m'] }).ok === false,
  '非 http(s) 拒绝');
ok(normalizeCustomInput({ name: 'n', baseUrl: '不是-url', models: ['m'] }).ok === false,
  '坏 URL 拒绝');
ok(normalizeCustomInput({ name: 'n', baseUrl: 'https://x/v1', models: [] }).ok === false,
  '空模型清单拒绝');
ok(
  normalizeCustomInput({ name: 'n', baseUrl: 'https://x/v1', models: Array.from({ length: 51 }, (_, i) => `m${i}`) })
    .ok === false,
  '超过 50 个模型拒绝'
);
ok(
  normalizeCustomInput({ name: 'n', baseUrl: 'https://x/v1', models: ['m'.repeat(201)] }).ok === false,
  '超长模型 ID 拒绝'
);

const badDialect = normalizeCustomInput({
  name: 'n',
  baseUrl: 'https://x/v1',
  dialect: 'unknown',
  models: ['m'],
});
ok(badDialect.ok === true && badDialect.value.dialect === 'openai', '未知方言回落到 openai');

console.log(`\n${failures.length ? '❌' : '✓'} A129 纯函数：${total - failures.length}/${total} 通过`);
if (failures.length) process.exitCode = 1;
