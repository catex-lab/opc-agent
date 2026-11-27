/**
 * L4 闸门：`HTTP ${status}` 错误文案分级是否真实落地。
 *
 * 断言四件事（都打到最外层可观测量，不钉实现字面量）：
 *   1. 分级函数对每段状态码给出「中文结论 + 恢复动作」，未知状态保留状态码作补充；
 *   2. 9 个文案键中英双写（MessageKey 从 zh 派生，漏一份英文界面就出中文）；
 *   3. A 类 19 处裸抛清零（剥注释后按行首锚定，注释里的历史描述不算）；
 *   4. 状态码绝不作为唯一内容（不能退化成 `HTTP 500` 一个数字）。
 *
 * 反向探针：见 .tmp/probe-l4.mjs —— 真把源码退回裸抛版本，确认本闸门变红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

/** 剥掉 // 行注释与 /* *\/ 块注释，避免注释里的历史代码片段造成假绿/假红 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const HTTP_KEYS = [
  'http.networkError',
  'http.unauthorized',
  'http.forbidden',
  'http.notFound',
  'http.conflict',
  'http.rateLimited',
  'http.serverError',
  'http.badRequest',
  'http.unknown',
];

const A_CLASS_FILES = [
  'src/App.tsx',
  'src/components/AgentCredentialEditor.tsx',
  'src/components/AgentCredentialSettings.tsx',
  'src/components/ModelCatalogSettings.tsx',
  'src/components/ModelRouteSettings.tsx',
  'src/components/ProviderSettings.tsx',
  'src/components/WorkbuddyProfileSettings.tsx',
  'src/hooks/useAgentRegistry.ts',
  'src/hooks/useGroupChat.ts',
  'src/hooks/useSessions.ts',
  'src/userProfile.ts',
];

async function run(): Promise<void> {
  const { httpErrorText } = await import('../src/lib/http-error.js');

  // [1] 动态分级：每段都给人话与可执行动作（Node 环境 locale 回落中文）
  const cases: Array<[number, string[], string]> = [
    [0, ['服务', '重试'], '网络失败 → 检查服务并重试'],
    [400, ['参数', '重试'], '400 → 检查参数'],
    [401, ['登录'], '401 → 重新登录'],
    [403, ['权限'], '403 → 无权限说明'],
    [404, ['刷新'], '404 → 刷新列表'],
    [409, ['刷新'], '409 → 冲突后刷新'],
    [429, ['稍后'], '429 → 稍后重试'],
    [500, ['服务', '重试'], '5xx → 服务暂不可用'],
    [503, ['服务', '重试'], '5xx 边界 503 同样分级'],
    [418, ['418', '失败'], '未知状态保留状态码作补充'],
  ];
  for (const [status, needles, label] of cases) {
    const text = httpErrorText(status);
    ok(needles.every(n => text.includes(n)), `${label}：${text}`);
    ok(!/^\s*HTTP\s+\d+\s*$/.test(text), `status ${status} 文案不是裸状态码`);
  }

  // [2] i18n 双写：两份文件都要有全部 9 个键
  const zh = read('src/i18n/zh.ts');
  const en = read('src/i18n/en.ts');
  for (const key of HTTP_KEYS) {
    ok(zh.includes(`'${key}':`), `zh 有键 ${key}`);
    ok(en.includes(`'${key}':`), `en 有键 ${key}`);
  }

  // [3] A 类裸抛清零（剥注释、按 throw new Error(`HTTP 锚定；不碰 B/C 类）
  const barePattern = /throw\s+new\s+Error\(\s*`HTTP\s*\$\{/;
  for (const file of A_CLASS_FILES) {
    const src = stripComments(read(file));
    ok(!barePattern.test(src), `${file} 无裸抛 HTTP 状态码`);
  }

  // [4] 全仓 A′ 正文拼接清零：响应正文不得拼进抛给用户的错误
  const leak = /throw\s+new\s+Error\(\s*`HTTP\s*\$\{[^}]*\}\s*\$\{/;
  const allTs = [
    ...A_CLASS_FILES,
    'src/components/AgentCredentialEditor.tsx',
  ].map(f => stripComments(read(f))).join('\n');
  ok(!leak.test(allTs), '无 HTTP 状态码 + 响应正文拼接的裸抛');
}

void run().then(() => {
  console.log(`\nHTTP 错误文案分级：${checks - failures.length}/${checks} 通过`);
  if (failures.length) {
    console.error(`失败 ${failures.length} 项：${failures.join('；')}`);
    process.exitCode = 1;
  }
}).catch(err => {
  console.error('闸门执行异常：', err);
  process.exitCode = 1;
});
