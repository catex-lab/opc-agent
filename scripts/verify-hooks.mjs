/**
 * 密钥扫描钩子的验收闸门。
 *
 * 判据是「真的会拦住一次提交」，不是「正则写得像那么回事」。所以每个用例都在
 * 临时仓库里**真跑一遍 `git commit`**，看钩子有没有把提交挡下来。
 *
 * 两条同等重要：
 *   - 该拦的必须拦（漏了 = 假保护，比没有保护更危险，因为大家以为有）
 *   - 不该拦的必须放行（误报多了 = 大家习惯性 `--no-verify`，等于没装）
 *
 * 最后一个用例扫本仓库全树，顺便证明**这个脚本自己的夹具没有把假密钥写进仓库**。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SCANNER = path.join(REPO, 'scripts', 'secret-scan.mjs');
const HOOKS_DIR = path.join(REPO, '.githooks');

let pass = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

// ── 夹具：一律用拼接构造，别在源码里留下完整的敏感字面量 ──────────────────
// 否则本文件自己就会被最后一个用例（扫全树）抓出来 —— 这是刻意留的自检。
const FAKE_SK = ['sk', 'proj', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4'].join('-');
const FAKE_AWS = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const FAKE_PEM = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const FAKE_DSN = ['postgres://user:', 's3cretpw@db.local:5432/app'].join('');
const FAKE_HEX = '8c07df50b4cbcbecf55a8f44ddba37d8178d252fb65929d9';
const FAKE_TOML = ['STATS_KEY = "', FAKE_HEX, '"'].join('');

/**
 * 在临时仓库里提交一次，返回 { blocked, out }。
 * blocked 判据是 `git commit` 退出码非 0 —— 钩子失败时 git 就是这么表现的。
 */
function tryCommit(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'opc-hook-'));
  const env = {
    ...process.env,
    // 钩子用 `node` 启动扫描器；把当前 node 的目录放到 PATH 最前面，
    // 否则在托管运行时环境下钩子会「找不到 node」而放行（假绿）。
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  try {
    const g = (args, opts = {}) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, ...opts });

    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.name', 'hook-gate']);
    g(['config', 'user.email', 'hook-gate@example.com']);
    g(['config', 'commit.gpgsign', 'false']);
    // 临时仓库不继承 .gitattributes，全局 autocrlf 会为每个文件刷一行
    // 「LF will be replaced by CRLF」—— 那会把真正的失败信息淹掉。
    g(['config', 'core.autocrlf', 'false']);

    cpSync(HOOKS_DIR, path.join(dir, '.githooks'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    cpSync(SCANNER, path.join(dir, 'scripts', 'secret-scan.mjs'));
    g(['config', 'core.hooksPath', '.githooks']);

    for (const [name, content] of Object.entries(files)) {
      const p = path.join(dir, name);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }

    g(['add', '-A']);
    const r = spawnSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir, encoding: 'utf8', env });
    return { blocked: r.status !== 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

console.log('\n[1] 该拦的必须拦住');
{
  const c = tryCommit({ 'src/leak.ts': `export const k = "${FAKE_SK}";\n` });
  ok(c.blocked, 'sk- 风格密钥被拦下');
  ok(/sk-key|疑似密钥/.test(c.out), '拦截理由说清了是哪条规则', c.out.split('\n')[0]?.slice(0, 40));
}
{
  const c = tryCommit({ 'aws.env': `AWS_ACCESS_KEY_ID=${FAKE_AWS}\n` });
  ok(c.blocked, 'AWS Access Key 被拦下');
}
{
  const c = tryCommit({ 'keys/id_rsa': `${FAKE_PEM}\nMIIEow...\n` });
  ok(c.blocked, '私钥内容被拦下');
}
{
  const c = tryCommit({ 'server/db.ts': `const u = "${FAKE_DSN}";\n` });
  ok(c.blocked, '连接串里带密码被拦下');
}
{
  // 真踩过的形态：没有厂商前缀、48 位十六进制、写死在 toml 里
  const c = tryCommit({ 'site/worker/wrangler.toml': `${FAKE_TOML}\n` });
  ok(c.blocked, '48 位十六进制赋值给 *KEY 被拦下（真实事故形态）');
}

console.log('\n[2] 不该拦的必须放行');
{
  const c = tryCommit({ 'src/plain.ts': 'export const answer = 42;\nexport const name = "opc";\n' });
  ok(!c.blocked, '普通代码放行', c.out.trim().split('\n').pop()?.slice(0, 30));
}
{
  // MEMORY 记过的假阳性：`mask-image` 里含 `sk-` 子串
  const c = tryCommit({ 'src/index.css': '.x { -webkit-mask-image: url(a.png); }\n' });
  ok(!c.blocked, 'mask-image 不误报（已知子串陷阱）');
}
{
  const c = tryCommit({ 'site/worker/wrangler.toml': 'STATS_KEY = "REPLACE_WITH_YOUR_STATS_KEY"\n' });
  ok(!c.blocked, '占位符不误报（这才是正确写法）');
}
{
  const c = tryCommit({ 'src/leak.ts': `export const k = "${FAKE_SK}"; // secret-scan:ignore\n` });
  ok(!c.blocked, 'secret-scan:ignore 标记可放行');
}
{
  // 二进制文件里塞密钥：扫不了文本，跳过而不是误报
  const buf = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from(FAKE_SK)]);
  const c = tryCommit({ 'src/logo.png': buf });
  ok(!c.blocked, '二进制文件跳过（不误报）');
}
{
  // 锁文件整体跳过：里面有大量哈希，逐条扫只会制造噪音
  const c = tryCommit({ 'package-lock.json': `{"x": "${FAKE_TOML}"}\n` });
  ok(!c.blocked, '锁文件跳过（不误报）');
}

console.log('\n[3] 钩子接线');
{
  const hookPath = path.join(HOOKS_DIR, 'pre-commit');
  ok(existsSync(hookPath), '.githooks/pre-commit 存在');
  const src = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
  ok(src.includes('secret-scan.mjs'), '钩子确实调用扫描器（不是空壳）');
  ok(existsSync(path.join(REPO, 'scripts', 'install-git-hooks.mjs')), '有安装脚本');
}

console.log('\n[4] 本仓库自身干净');
{
  // 同时证明两件事：仓库里没有真密钥；本闸门的夹具没有把假密钥写进仓库。
  const r = spawnSync(process.execPath, [SCANNER, '--all'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  ok(r.status === 0, '全树扫描无命中', out.trim().split('\n')[0]?.slice(0, 50));
}

const total = pass + failures.length;
console.log(`\n${failures.length === 0 ? '✓ 全部通过' : '✗ 有失败项'}：${pass} 通过 / ${failures.length} 失败（共 ${total}）`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
